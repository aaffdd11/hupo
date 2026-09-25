// agent 运行时：一个会话一个真 `dsh` 子进程，stdio JSON-RPC。
//
// 手册 `08-SPEC.md` §2.3（L2⇄L3）、§4（进程上限与 LRU、DSH_HOME、env）。
//
// ⚠️ 协议事实来自**实测**（`dsh --profile sdk` 探过），不是猜的：
//   · `initialize` → `{serverInfo}`，约 1.1 秒
//   · `session/prompt` → **立刻**回 `{messageId}`（~35ms），答案异步流回
//   · 通知走 `session.event`，另有 `session.status`
//   · **没有 token 级增量**——一条 assistant 消息整段到达
//
// 三条从事故里学来的：
//
//   ① **spawn 失败是异步事件**。不接 `error` 会把整个服务带崩，
//      然后 systemd 反复重启，用户看到的是"整个应用没反应"。
//   ② ⚠️ **`spawn` 的 ENOENT 是二义的**：二进制找不到、和 **cwd 不存在**，
//      报的是**同一句话**（`spawn xxx ENOENT`）。
//      我就被它骗过一次——去查 PATH，其实是 `~/hupo-workspace` 没建。
//      ⇒ 这里失败时**把两种可能都报出来**，不让下一个人重踩。
//   ③ 换进程要**代号**（generation）：旧进程的 stdout 一律丢弃，
//      否则两个进程的输出会串在一起。

import { spawn as nodeSpawn } from 'node:child_process';
import nodeFs from 'node:fs';
import { EventEmitter } from 'node:events';

// ★ **"它是不是被挤掉的"要有证据**（账 #33 的后半）：拿内核那个 cgroup 计数当证据，
//   而不是拿 `SIGKILL` 当 OOM（那是猜）。见 `oom.js` 顶上那三条纪律。
import { createOomWatcher } from './oom.js';

/** 默认的 dsh 可执行文件。 */
export function resolveDshBin() {
  return process.env.HUPO_DSH_BIN ?? 'dsh';
}

/**
 * 该给子进程哪些环境变量。
 *
 * 手册 §4.4：**先做减法**——先传全部，只删密钥类。
 * 为什么不能直接列白名单：`dsh` 是 node CLI，
 * **丢 `PATH` 就回到 ENOENT**（而那个 ENOENT 还和二义的 cwd 混在一起，很难查）。
 * 严格白名单要先把生产机上的变量盘一遍再做。
 */
export function childEnv({ home, extra = {} } = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/(_API_KEY|_TOKEN|_SECRET)$/i.test(k)) delete env[k];
  }
  if (home) env.DSH_HOME = home;
  return { ...env, ...extra };
}

export class AgentRuntime extends EventEmitter {
  #cfg;
  /**
   * **按会话取一份 cfg**（多租户）。
   * ⚠️ 不给的话就是"所有人共用一份 cfg" —— 单租户时正确，多租户时是串号。
   * 见 `agent()` 里的注释与 `docs/dev/38-ISOLATION-SPLIT.md` §二（`DSH_HOME` 必须切）。
   */
  #cfgFor;
  #spawnFn;
  #agents = new Map(); // 我们的 sessionId → DshAgent
  /** 这个 runtime 已经起过**几个 agent 实例**。只用来造 DSH 会话 id，见下。 */
  #incarnation = 0;
  #access = []; // 访问序（**真的是 LRU**：每次取用把它挪到队尾）
  #onEvict;
  #bootId;

  constructor({ cfg, cfgFor = null, spawnFn = nodeSpawn, onEvict = null, bootId = null }) {
    super();
    this.#cfg = cfg;
    this.#cfgFor = cfgFor ?? (() => cfg);
    this.#spawnFn = spawnFn;
    this.#onEvict = onEvict;
    /**
     * ⚠️ **每次启动换一个 DSH 会话 id。**
     *
     * 实测：`session/prompt` 对**已存在**的会话 id 会直接报
     * `session "main" already exists` —— **SDK 只能 create，不能 resume**。
     * 不换 id 的话，服务重启后**第一句话就投不出去**，
     * 而现象只是"它不理我了"（我第一次跑就撞上了）。
     *
     * ⚠️ 光有 `bootId` **不够**——见 `#nextDshSessionId()`：
     *    同一个进程里换一个 agent 实例，也必须换 id。
     *
     * ⚠️ **连带后果（要记住）**：换了 id ⇒ **agent 重启后不记得之前**。
     *    所以"跨重启接记忆"必须靠**喂上下文**（recap），不能指望会话自己还在。
     */
    this.#bootId = bootId ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  get bootId() {
    return this.#bootId;
  }

  /**
   * 给**某一个 agent 实例**造一个 DSH 会话 id。
   *
   * ⚠️⚠️ **每个实例都要不同——不只是"每次启动不同"。**
   *
   * 为什么：DSH 的会话记录**落在 `$DSH_HOME/sessions/` 里，跨进程活着**
   * （实测：那个目录下已经躺着 19 个 `main.<bootId>`）。
   * 所以"同一个 runtime 里把 agent 卸掉再起一个"这条路上，
   * 沿用同一个 id 会直接报：
   *
   * ```
   * session "main.mu9rmdgzijr2" already exists
   * ```
   *
   * ⇒ **用户接下来每一句都发不出去**，而看起来只是"它不理我了"。
   *
   * ⚠️ 这条路的触发者是**超时硬收口**：它 `stop()` 掉卡住的 agent，
   *    而 `bootId` 是整个 runtime 一份、**永不改变** ⇒ 下一句必撞。
   *    （这个是端到端测试抓出来的：卡住→收口→恢复那一步过不去。）
   *
   * ⇒ 所以 id 里再加**第几个实例**。三级：`会话名.bootId.第几个`。
   */
  #nextDshSessionId(sessionId) {
    this.#incarnation += 1;
    return `${sessionId}.${this.#bootId}.${this.#incarnation}`;
  }

  get maxProcesses() {
    return this.#cfg.agentMaxProcesses;
  }

  get count() {
    return this.#agents.size;
  }

  /** 当前活着几个、分别什么状态。给健康检查用（**不含用户内容**）。 */
  snapshot() {
    return [...this.#agents.entries()].map(([id, a]) => ({
      sessionId: id,
      running: a.running,
      ready: a.ready,
      idleMs: Date.now() - a.lastUsedAt,
    }));
  }

  /** 取（或惰性建）一个会话的 agent。**每次取用都更新 LRU 序**。 */
  agent(sessionId) {
    let a = this.#agents.get(sessionId);
    if (!a) {
      a = new DshAgent({
        sessionId,
        // ★ 传给 agent 的是**带 bootId 的那个**（见 constructor 的注释）
        dshSessionId: this.#nextDshSessionId(sessionId),
        // ⚠️ **按会话取 cfg**（多租户）：`DSH_HOME` 与 `agentCwd` 都长在里面，
        //    给它一份全局 cfg，甲和乙就会共用一个 DSH_HOME
        //    ⇒ 会话记录互相看得见（N21：键是绝对路径，换个 home 就是换个账号）。
        cfg: this.#cfgFor(sessionId),
        spawnFn: this.#spawnFn,
      });
      a.on('exit', (info) => {
        // 进程没了：从表里摘掉，让下一次取用时重建
        this.#agents.delete(sessionId);
        this.#access = this.#access.filter((x) => x !== sessionId);
        this.emit('agent-exit', sessionId, info);
      });
      this.#agents.set(sessionId, a);
      // ★ P1-20（2026-09-24）：**取用这一刻就是该淘汰的时机**。
      //
      // 为什么：池子只可能**从这儿**被突破（`maxProcesses` 就是给它设的），
      // 而在此之前**产品代码一处都没调过** `evictIfNeeded()` ——
      // 只有 `test/` 在调 ⇒ 那个上限**从来没生效过**（代理会一直攒）。
      //
      // ⚠️ 三条安全边界（都是它自己保证的，这里不改）：
      //   · 只淘汰**空闲**的（`running` 的绝不卸）；
      //   · **先收口再卸**（`onEvict` 回调，由 dispatcher 把话说圆）；
      //   · **不 await**：`agent()` 是同步的（调用方一大片），淘汰在后台跑；
      //     抛错也不影响这次取用（`evictIfNeeded` 自己会 emit `evict-error`）。
      void this.evictIfNeeded().catch((err) => this.emit('evict-error', sessionId, err));
    }
    this.#touch(sessionId);
    return a;
  }

  #touch(sessionId) {
    this.#access = this.#access.filter((x) => x !== sessionId);
    this.#access.push(sessionId);
  }

  /**
   * 淘汰。**只淘汰空闲的**，而且**先收口再卸**。
   *
   * ⚠️ "先收口"这件事 runtime 自己做不了——它没有翻译层，
   *    不知道哪条消息还没收口。⇒ **必须回调出去**（手册 §5.5：「谁回调谁」）。
   *    回调由 dispatcher 提供，它负责把没说完的话收掉，然后才让这里卸。
   */
  async evictIfNeeded() {
    const limit = this.maxProcesses;
    if (this.#agents.size <= limit) return [];
    const evicted = [];
    // 从**最久没用**的那头开始（`#access[0]`）
    for (const id of [...this.#access]) {
      if (this.#agents.size <= limit) break;
      const a = this.#agents.get(id);
      if (!a) continue;
      if (a.running) continue; // ★ 跑着的绝不卸。**跳过不等于放弃**——下一轮还会看它
      // ⚠️ **先从表里摘掉，再去收口。** 反过来的话，`await` 收口的这段时间里
      //    表里还留着那个**正在死的**实例；而这期间来一条新消息，
      //    `agent()` 会把它又发回给调用方（实测踩到：用户拿到一个已经 dispose 的 agent，
      //    投递直接失败）。摘表管的是"**别再把它派出去**"，
      //    收口管的是"**把话说圆**"——两件事，不冲突。
      this.#agents.delete(id);
      this.#access = this.#access.filter((x) => x !== id);
      if (this.#onEvict) {
        // 给调用方一个"把话收干净"的机会；它抛错也不该挡住卸载
        try {
          await this.#onEvict(id);
        } catch (err) {
          this.emit('evict-error', id, err);
        }
      }
      await a.dispose();
      evicted.push(id);
    }
    return evicted;
  }

  /**
   * **硬收口**一个会话的 agent：**收口 + 回收**。
   *
   * 和 `evictIfNeeded` 的区别只是"为什么要它走"：那是为了腾位置，这是**超时**。
   *
   * ⚠️ 手册 **N10：「超时必须伴随资源回收（收气泡 ≠ 停 agent）」**——
   *    两件事都要做，这句话就是为这条写的。只收气泡的话：
   *    · 卡住的进程一直占着一个位置（`running` 永远是真的，
   *      而 `evictIfNeeded` 又"跑着的不许卸"）⇒ **永远不会被淘汰**；
   *    · 用户之后说的话会被 DSH **排进一个永远不会来的下一轮**
   *      （实测：`agent/inbox/spliced {target:"next-turn"}`）⇒ 跟着一起没。
   *
   * ⚠️ 顺序仍然是"**先收口再卸**"：先回调 `onEvict`（调用方在那里把话收干净），
   *    再 dispose。但**摘表要在这两步之前**——见 `evictIfNeeded` 里那段注释：
   *    摘表是"别再把它派出去"，收口是"把话说圆"，两件事。
   *
   * @returns {Promise<boolean>} 真有这个 agent 才 true
   */
  async stop(sessionId, { reason = 'stop' } = {}) {
    const a = this.#agents.get(sessionId);
    if (!a) return false;
    this.#agents.delete(sessionId);
    this.#access = this.#access.filter((x) => x !== sessionId);
    if (this.#onEvict) {
      try {
        await this.#onEvict(sessionId);
      } catch (err) {
        this.emit('evict-error', sessionId, err);
      }
    }
    await a.dispose();
    this.emit('agent-stopped', sessionId, reason);
    return true;
  }

  async shutdown() {
    for (const a of this.#agents.values()) await a.dispose();
    this.#agents.clear();
    this.#access = [];
  }
}

/**
 * 一个 `dsh` 子进程。
 *
 * ⚠️ 它不是"一个请求一个响应"的工具，而是**一条会话**：
 *    `prompt` 立刻返回，答案从 `session-event` 里流回来。
 */
export class DshAgent extends EventEmitter {
  #sessionId;
  #dshSessionId;
  #cfg;
  #spawnFn;
  #child = null;
  #buf = '';
  #gen = 0;
  #pending = new Map();
  #nextId = 0;
  #starting = null;
  ready = false;
  running = false;
  lastUsedAt = Date.now();
  lastError = null;
  stderrTail = '';

  constructor({ sessionId, dshSessionId = null, cfg, spawnFn = nodeSpawn }) {
    super();
    this.#sessionId = sessionId;
    this.#dshSessionId = dshSessionId ?? sessionId;
    this.#cfg = cfg;
    this.#spawnFn = spawnFn;
  }

  /** 我们这边的会话 id（时间线用它）。 */
  get sessionId() {
    return this.#sessionId;
  }

  /** 传给 DSH 的会话 id（**带 bootId**，见 `AgentRuntime` 的注释）。 */
  get dshSessionId() {
    return this.#dshSessionId;
  }

  async start() {
    if (this.ready) return;
    if (this.#starting) return this.#starting;
    this.#starting = this.#spawnAndInit().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #spawnAndInit() {
    const cfg = this.#cfg;
    const args = ['--profile', cfg.agentProfile];
    if (cfg.personaPath) args.push('--patch', cfg.personaPath);
    // ★ **能力层**（批 4 · 契约 `docs/dev/31-LEDGER.md` v2 §7.1）：
    //   `--patch` 是**可重复**的（`dsh --help` 原文），人格一层、能力一层。
    //   ⚠️ 顺序：能力层挂在人格**之后** ⇒ 它改不了人格那一条
    //      （`system-prompt` 只有人格那份 patch 会碰）。
    if (cfg.capabilitiesPath) args.push('--patch', cfg.capabilitiesPath);
    // ★ **模型那条路**（多租户 ②-3）：让 dsh 把请求发给盒内的 root 小代理
    //   （它持有真 key，而 agent 那一侧只有一个占位符）。
    //   ⚠️ 挂在**最后**：它只改 `llm-deepseek` 那一条，不碰上面两层。
    if (cfg.modelPatchPath) args.push('--patch', cfg.modelPatchPath);

    const gen = (this.#gen += 1);

    // ② cwd 先自己检查一遍——因为 spawn 的 ENOENT 分不清是它还是二进制
    if (!nodeFs.existsSync(cfg.agentCwd)) {
      throw new Error(
        `agent 的工作目录不存在：${cfg.agentCwd}\n` +
          `（⚠️ spawn 的 ENOENT 分不清"目录不存在"和"程序找不到"，所以这里先自己查一遍）`,
      );
    }

    // ★ 起它之前先记一笔 cgroup 的 OOM 计数（它没了之后再看涨没涨 —— 见 `oom.js`）
    const oom = createOomWatcher();
    oom.markStart();

    const child = this.#spawnFn(cfg.dshBin, args, {      cwd: cfg.agentCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // ★ **换手**（多租户 ②-2 · `39-PERMISSIONS.md` §5.2/§7.1）：
      //   容器里的服务是 root，而 root 带着 `CAP_DAC_OVERRIDE`
      //   ⇒ **agent 是 root 时任何权限位都拦不住它读 key**（决策 ① 说的就是这件事）。
      //   ⚠️ `null` = 不换手（**宿主上就该不换**：服务跑在 `deploy` 下，没有特权也不该有）。
      //   ⚠️ 换不过去时 `spawn` 会 **EPERM**（异步 error）⇒ 走上面那条 `child.on('error')`
      //      ⇒ 那条路会**大声失败**，不会静默退回 root。**这正是要的。**
      ...(cfg.agentUid !== null && cfg.agentUid !== undefined ? { uid: cfg.agentUid } : {}),
      ...(cfg.agentGid !== null && cfg.agentGid !== undefined ? { gid: cfg.agentGid } : {}),
      env: childEnv({
        home: cfg.dshHome,
        // ★ 能力层那三个变量（`hupo-capabilities.yml` 用 `!!js process.env.…` 读它们）。
        //   ⚠️ 它们**都不是秘密**：node 的绝对路径、一支脚本的绝对路径、
        //      一个域套接字的路径。准入靠套接字文件的权限（0600），不靠令牌。
        extra: {
          HUPO_NODE_BIN: process.execPath,
          // ⚠️ 只放**有值**的：把 `undefined` 塞进 env 会变成字符串 "undefined"，
          //    那比"没设"更难查（能力层会拿到一个字面量 "undefined" 的路径）。
          ...(cfg.ledgerServerPath ? { HUPO_LEDGER_SERVER: cfg.ledgerServerPath } : {}),
          ...(cfg.ledgerSocketPath ? { HUPO_LEDGER_SOCKET: cfg.ledgerSocketPath } : {}),
          // ★ 小程序那几条工具（乙-2）：脚本路径 + 那条域套接字。**都不是秘密**。
          ...(cfg.appsServerPath ? { HUPO_APPS_SERVER: cfg.appsServerPath } : {}),
          ...(cfg.appsSocketPath ? { HUPO_APPS_SOCKET: cfg.appsSocketPath } : {}),
          // ★ **画图那一支**（P1-27 后半）：它自己那个文件 ＋ **同一条**通道
          ...(cfg.imageServerPath ? { HUPO_IMAGE_SERVER: cfg.imageServerPath } : {}),
          // ★ **这一间是哪一间**（`scope`）：那几条工具把它原样带回来 ⇒ 用量账
          //   才知道"这一张图是哪个 app 叫的"（P2-3 一个账本三个计数器）。
          //   ⚠️ 它**不是秘密**（就是房间名，客户端也看得到）⇒ 走 env 不破纪律。
          // ★ **`HUPO_SCOPE` 是同一件事的通用名字**（2026-09-25 加）：账本那支工具
          //   也要知道"我这一轮是在哪一间里跑的" —— 因为"他随时能问哪几件还挂着"
          //   那一条**必须把"正在问的那一轮"自己排除掉**（否则答案永远是
          //   "那件还在做"，而那件就是这句提问本身）。主线也要给（`main`）。
          ...(cfg.scope ? { HUPO_APPS_SCOPE: String(cfg.scope) } : {}),
          HUPO_SCOPE: String(cfg.scope ?? 'main'),
        },
      }),
    });
    this.#child = child;
    this.#buf = '';
    this.ready = false;
    this.stderrTail = '';

    // ① spawn 失败是**异步事件**
    child.on('error', (err) => {
      this.lastError = err;
      this.#failAll(err);
      this.emit('exit', {
        code: null,
        signal: null,
        wasReady: false,
        // ③ 把两种可能都报出来
        reason:
          err?.code === 'ENOENT'
            ? `起不来：可能是【找不到 dsh 程序】(${cfg.dshBin}) 或【工作目录不存在】(${cfg.agentCwd})——` +
              `这两件事在 spawn 里报的是同一句话`
            : String(err?.message ?? err),
      });
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (gen !== this.#gen) return; // 旧进程的输出，丢
      this.#onStdout(chunk);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + d).slice(-2000);
    });

    child.on('exit', (code, signal) => {
      if (gen !== this.#gen) return;
      const wasReady = this.ready;
      this.ready = false;
      this.running = false;
      this.#failAll(new Error('agent 进程退出了'));
      // 🔴 **把它最后说的话带上**（2026-09-21 修）。
      //    原来这里只写 `进程退出 code=1` —— 而"为什么退"**一个字都没有**，
      //    于是排查只能靠猜（这次真机上就这么耗掉了好几轮：
      //    真实原因是 `EACCES` 读不到 patch、`ERR_DLOPEN_FAILED` 缺库、
      //    以及 `/tmp` 不可写，**三条都只出现在 stderr 里**）。
      // ⚠️ 长度封顶：它是**别人的一句话**，不是日志正文。
      // ⚠️ 不含秘密：`childEnv()` 已经把 `*_API_KEY|_TOKEN|_SECRET` 摘掉了，
      //    而真 key 从来不在这个进程的环境里（它在盒内那个小代理手上）。
      const tail = String(this.stderrTail ?? '').trim().slice(-400);
      this.emit('exit', {
        code,
        signal,
        wasReady,
        // 🔴 **"被挤掉的"只在这一种情况下才敢说**（账 #33）：这个 cgroup 在那段时间里
        //    **真的 OOM 过**（内核计数涨了）。读不到 / 没涨 ⇒ `false` ⇒ 上层用那句含糊的。
        //    ⚠️ 本机这条 scope `memory.max` 是 `max` ⇒ 它在这儿**永远不会**是 `true`；
        //       带 `--memory=768m` 的租户容器里才会。
        oom: oom.changed(),
        reason: `进程退出 code=${code}${tail ? `；它最后说的话：${tail}` : ''}`,
      });
    });

    await withTimeout(
      this.#request('initialize', {
        cwd: cfg.agentCwd,
        provider: cfg.agentProvider,
        model: cfg.agentModel,
        reasoningEffort: cfg.agentEffort,
        maxTokens: cfg.agentMaxTokens,
      }),
      cfg.agentBootTimeoutMs,
      'agent 启动（initialize）',
    );
    this.ready = true;
  }

  /**
   * 说一句。**立刻返回**，答案从 `session-event` 流回来。
   *
   * @param {string|{type:'text',text:string}[]} input
   *        一个字符串，或**一组内容块**。
   *        ⚠️ 内容块这条路是给"跨重启接记忆"用的：背景**单独一块**，
   *        主人现在这句**另一块**——拼成一个字符串的话，模型分不清
   *        哪句是背景、哪句是现在这句。
   */
  async prompt(input) {
    await this.start();
    this.lastUsedAt = Date.now();
    const contentBlocks = Array.isArray(input)
      ? input.map((b) => ({ type: 'text', text: String(b?.text ?? '') }))
      : [{ type: 'text', text: String(input ?? '') }];
    return this.#request('session/prompt', {
      // ★ 用带 bootId 的那个 id，否则重启后第一句就报 already exists
      sessionId: this.#dshSessionId,
      contentBlocks,
    });
  }

  async dispose() {
    this.#gen += 1; // 让旧进程的输出失效
    const child = this.#child;
    this.#child = null;
    this.ready = false;
    this.running = false;
    this.#failAll(new Error('agent 被卸下了'));
    if (!child) return;
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++this.#nextId, method: 'shutdown' })}\n`);
    } catch {
      /* 已经死了 */
    }
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
  }

  #request(method, params) {
    return new Promise((resolve, reject) => {
      const child = this.#child;
      if (!child) return reject(new Error('agent 没起来'));
      const id = ++this.#nextId;
      this.#pending.set(id, { resolve, reject });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (err) {
        this.#pending.delete(id);
        reject(err);
      }
    });
  }

  #failAll(err) {
    for (const [, p] of this.#pending) p.reject(err);
    this.#pending.clear();
  }

  #onStdout(chunk) {
    this.#buf += chunk;
    let nl;
    while ((nl = this.#buf.indexOf('\n')) !== -1) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit('garbage', line.slice(0, 200));
        continue;
      }
      // 诊断用：每一帧都报一次（**只报形状，不报正文**）。
      // 出问题时要能看见"到底收到了什么"，否则只能猜。
      this.emit('frame', {
        hasId: msg.id !== undefined,
        method: msg.method ?? null,
        type: msg.params?.event?.type ?? null,
      });
      if (msg.id !== undefined && this.#pending.has(msg.id)) {
        const p = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.error) p.reject(new Error(String(msg.error.message ?? JSON.stringify(msg.error))));
        else p.resolve(msg.result);
        continue;
      }
      // ⚠️ **通知的方法名用「点」，请求的用「斜杠」**：
      //    我们发出去的是 `session/prompt`（斜杠），
      //    它发过来的是 `session.event` / `session.status`（**点**）。
      //    我一开始按斜杠比，于是**所有事件都被静默丢掉**——
      //    现象是"agent 起来了、prompt 也成功、但一个事件都收不到"。
      //    ⇒ 两种都认，免得再踩。
      if (msg.method === 'session.event' || msg.method === 'session/event') {
        this.emit('session-event', msg.params);
        continue;
      }
      if (msg.method === 'session.status' || msg.method === 'session/status') {
        const status = msg.params?.status;
        this.running = status === 'running';
        this.emit('status', { status });
        continue;
      }
      // 其它通知（含服务端反向请求）：认得就认，不认得就安静放着
      if (msg.id !== undefined && msg.method) {
        try {
          this.#child?.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`,
          );
        } catch {}
      }
    }
  }
}

export function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`${what} 超时（${ms}ms）`)), ms);
    }),
  ]);
}
