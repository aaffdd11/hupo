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
  #spawnFn;
  #agents = new Map(); // 我们的 sessionId → DshAgent
  #access = []; // 访问序（**真的是 LRU**：每次取用把它挪到队尾）
  #onEvict;
  #bootId;

  constructor({ cfg, spawnFn = nodeSpawn, onEvict = null, bootId = null }) {
    super();
    this.#cfg = cfg;
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
     * ⚠️ **连带后果（要记住）**：换了 id ⇒ **agent 重启后不记得之前**。
     *    所以"跨重启接记忆"必须靠**喂上下文**（recap），不能指望会话自己还在。
     */
    this.#bootId = bootId ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  get bootId() {
    return this.#bootId;
  }

  /** 我们这边的会话 id → DSH 那边的会话 id。 */
  dshSessionId(sessionId) {
    return `${sessionId}.${this.#bootId}`;
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
        dshSessionId: this.dshSessionId(sessionId),
        cfg: this.#cfg,
        spawnFn: this.#spawnFn,
      });
      a.on('exit', (info) => {
        // 进程没了：从表里摘掉，让下一次取用时重建
        this.#agents.delete(sessionId);
        this.#access = this.#access.filter((x) => x !== sessionId);
        this.emit('agent-exit', sessionId, info);
      });
      this.#agents.set(sessionId, a);
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
      if (this.#onEvict) {
        // 给调用方一个"把话收干净"的机会；它抛错也不该挡住卸载
        try {
          await this.#onEvict(id);
        } catch (err) {
          this.emit('evict-error', id, err);
        }
      }
      await a.dispose();
      this.#agents.delete(id);
      this.#access = this.#access.filter((x) => x !== id);
      evicted.push(id);
    }
    return evicted;
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

    const gen = (this.#gen += 1);

    // ② cwd 先自己检查一遍——因为 spawn 的 ENOENT 分不清是它还是二进制
    if (!nodeFs.existsSync(cfg.agentCwd)) {
      throw new Error(
        `agent 的工作目录不存在：${cfg.agentCwd}\n` +
          `（⚠️ spawn 的 ENOENT 分不清"目录不存在"和"程序找不到"，所以这里先自己查一遍）`,
      );
    }

    const child = this.#spawnFn(cfg.dshBin, args, {
      cwd: cfg.agentCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv({ home: cfg.dshHome }),
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
      this.emit('exit', { code, signal, wasReady, reason: `进程退出 code=${code}` });
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
