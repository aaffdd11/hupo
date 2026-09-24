// **甲：把租户盒子里那台 DSH 自己的原始会话流原样送到主人屏幕上**
// （契约 `docs/dev/81-HARNESS-ENTRY.md` §五 · 2026-09-24）。
//
// 一句话：**一个 WS 连接 = 一个 DSH 进程**。它起 `dsh --profile sdk --patch <模型那条>`，
// 把 stdin 喂进去、把 stdout 的每一条 JSON-RPC 消息**原样**丢给客户端。
// 这一侧**不做任何投影** —— "这是什么意思"全部在客户端解（契约 §5.2）。
//
// ── 三条不许破的 ─────────────────────────────────────────────
//   ① 🔴 **不挂人格、不挂能力层**（判据 H5）：挂了它就变成"琥珀"，
//      而主人要的是"**那台 DSH 本人**"。⇒ 参数只由 `harnessArgs()` 造，
//      那个函数**只认 profile 与模型那条 patch**，不认 `personaPath` / `capabilitiesPath`。
//   ② 🔴 **与琥珀自己那条路完全隔离**（判据 H7）：另一个进程；**不 import `AgentRuntime`、
//      不碰它的实例与 LRU**（只借 `childEnv()` 那一个纯函数 —— 契约点名要它，因为
//      密钥必须在那里被摘掉）。会话 id 用 `crypto.randomUUID()`，与琥珀那套
//      `main.<bootId>.<n>` 不会撞。
//   ③ 🔴 **只在 `trusted === true` 时接得上**（判据 H1）：闸门在 `server.js` 的
//      `handleUpgrade` 里 —— 公网口（`trusted === false`）一律拒。
//      ⚠️ 宿主那一侧的公开口**只把别人的升级转进他自己那台盒子**（`proxyUpgrade`），
//      走到容器里那条 UDS 时才是 `trusted === true`（选项甲）。
//
// "放弃一轮" = **关掉那个进程**（SDK 协议没有 cancel / session-close，见契约 §四·4）。
// ⇒ `stop` 与"连接断开"都走 `killProc()`，而且带 SIGKILL 兜底 —— **不许留孤儿**（判据 H6）。

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// ⚠️ 只借这一个**纯函数**（摘密钥 + 给 `DSH_HOME`）。**绝不 import `AgentRuntime`**：
//    复用了它的实例就等于把"琥珀那一份"和"那台 DSH 本人"绑在一起（判据 H7）。
import { childEnv } from './agent-runtime.js';

/** 这条 WS 的路径（和 `asr.js` 的 `ASR_PATH` 同一个形状）。 */
export const HARNESS_PATH = '/api/harness';

/**
 * 杀进程的宽限：先 `SIGTERM`（顺手发一条 `shutdown`），到点还活着就 `SIGKILL`。
 * ⚠️ 和 `agent-runtime.js` 的 `dispose()` 用同一个量级 —— 不是"新调的一个数"，
 *    而是同一件事（"收干净"）在两处的同一种做法。
 */
export const HARNESS_KILL_GRACE_MS = 2000;

/**
 * `initialize` 的兜底上限。
 * ⚠️ 真正用的是 `cfg.agentBootTimeoutMs`（`config.js` 里那个旋钮）；
 *    这一条只在"调用方连 cfg 都没给"时兜底，**不是**第二个阈值。
 */
const FALLBACK_BOOT_TIMEOUT_MS = 90_000;

/**
 * **给那个进程的参数** —— 这是判据 H5 的落点，别改。
 *
 * 🔴 **只有两样**：`--profile <cfg.agentProfile>`（默认 `sdk`）与模型那条 patch。
 *    **绝不出现在这里**的东西：`cfg.personaPath`、`cfg.capabilitiesPath`
 *    —— 挂了人格就变成"琥珀"，挂了能力层就多出账本/小程序那几样工具。
 *
 * @param {object} cfg `config.js` 那份
 * @returns {string[]}
 */
export function harnessArgs(cfg = {}) {
  const args = ['--profile', String(cfg.agentProfile || 'sdk')];
  // ⚠️ 模型那条**必须有**（契约 §四·1）：不挂它，盒里那个进程没有模型 ——
  //    真 key 在盒内 8787 那个小代理手上，这条 patch 只是把请求指过去 + 给个占位符。
  if (cfg.modelPatchPath) args.push('--patch', cfg.modelPatchPath);
  return args;
}

/** 起不来时**把两种可能都报出来**（照 `agent-runtime.js` 那条踩过的坑：ENOENT 是二义的）。 */
export function harnessSpawnWhy(err, cfg = {}) {
  if (err?.code === 'ENOENT') {
    return (
      `起不来：可能是【找不到 dsh 程序】(${cfg.dshBin ?? 'dsh'})` +
      `或【工作目录不存在】(${cfg.agentCwd ?? '（没配）'})——` +
      `这两件事在 spawn 里报的是同一句话`
    );
  }
  return `起不来：${String(err?.message ?? err).slice(0, 300)}`;
}

/**
 * 进程退出的**人话原因**（判据 H3 要的那一句）。
 * ⚠️ 长度封顶：stderr 是**别人的一句话**，不是日志正文。
 * ⚠️ 里面不会有模型密钥：`childEnv()` 已经把 `*_API_KEY|_TOKEN|_SECRET` 摘掉了，
 *    而真 key 从来不在这个进程的环境里（它在盒内那个小代理手上）。
 */
export function harnessExitWhy({ code = null, signal = null, stderrTail = '' } = {}) {
  const tail = String(stderrTail ?? '').trim().slice(-400);
  const how = `code=${code ?? '—'}${signal ? `，signal=${signal}` : ''}`;
  return `那台 DSH 退出了（${how}）${tail ? `；它最后说的话：${tail}` : ''}`;
}

/** `Promise` 超时（**本模块自己一份**：不去 import `agent-runtime` 的运行时代码）。 */
function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`${what} 超时（${ms}ms）`)), ms);
    }),
  ]);
}

/**
 * 建一条"盒子那台 DSH"的中继。`attach(ws)` 把**已经由内核验过身份**的那条连接接上。
 *
 * @param {object} o
 * @param {object} o.cfg `config.js` 那份（`dshBin` / `agentProfile` / `agentCwd` /
 *   `dshHome` / `modelPatchPath` / `agentUid` / `agentGid` / `agentBootTimeoutMs`…）
 * @param {Function} [o.spawnFn] 注入用（判据里换成一个假子进程；默认真 spawn）
 * @param {() => string} [o.uuid] 会话 id 的来源（判据里可以钉死）
 * @param {(m: string) => void} [o.log]
 * @param {number} [o.killGraceMs]
 */
export function createHarnessRelay({
  cfg,
  spawnFn = nodeSpawn,
  uuid = randomUUID,
  log = () => {},
  killGraceMs = HARNESS_KILL_GRACE_MS,
} = {}) {
  /** 开着的连接（`shutdown()` 时一起放掉）。 */
  const attached = new Set();
  /** 活着的进程（判据 H6 的"没有孤儿"要能数出来）。 */
  const live = new Set();

  const killGrace = Number.isFinite(killGraceMs) && killGraceMs >= 0 ? killGraceMs : HARNESS_KILL_GRACE_MS;
  const bootMs =
    Number.isFinite(cfg?.agentBootTimeoutMs) && cfg.agentBootTimeoutMs > 0
      ? cfg.agentBootTimeoutMs
      : FALLBACK_BOOT_TIMEOUT_MS;

  /**
   * 把还挂着的请求全部拒掉（进程没了，它们不会再有回答）。
   * ⚠️ 放在 relay 这一层：`shutdown()` 用得到它（不只 `attach` 里面那一个连接）。
   */
  function failPending(proc, err) {
    for (const [, p] of proc.pending) p.reject(err);
    proc.pending.clear();
  }

  /**
   * **收干净一个进程**：先请它自己走（`shutdown` + `SIGTERM`），到点还在就 `SIGKILL`。
   * 🔴 **不许留孤儿**（判据 H6）。
   */
  function killProc(proc) {
    proc.killing = true;
    proc.ready = false;
    const child = proc.child;
    proc.dead = true;
    failPending(proc, new Error('这一轮结束了'));
    if (!child) return;
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++proc.nextId, method: 'shutdown' })}\n`);
    } catch {
      /* 已经死了 */
    }
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经没了 */
      }
    }, killGrace);
    t.unref?.();
    child.once('exit', () => clearTimeout(t));
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(t);
    }
  }

  /**
   * @param {import('ws').WebSocket} ws 面向客户端那条（身份已由**内核**保证）
   */
  function attach(ws) {
    attached.add(ws);

    /** 这一条连接**自己那一个** DSH 进程（一个 WS 连接 = 一个进程）。 */
    let cur = null;
    /** 代号：换过进程之后，旧进程的 stdout / 退出事件一律丢掉。 */
    let gen = 0;
    let closed = false;

    const send = (o) => {
      if (closed) return;
      try {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o));
      } catch {
        /* 已经没了 */
      }
    };

    /** `state` 那条：`why` 只在 `gone` 时给（契约 §5.2 字段冻结）。 */
    const setState = (s, why) => {
      const m = { t: 'state', s };
      if (why) m.why = String(why).slice(0, 600);
      send(m);
    };

    /** **原样**转发一条 stdout 消息（不裁剪、不改名、不丢字段）。 */
    const sendRaw = (m) => send({ t: 'raw', m });

    const isCurrent = (proc) => proc.gen === gen && !proc.dead;

    /** 进程**真的没了**时说一句人话（同一进程只说一次）。 */
    function gone(proc, why) {
      if (proc.goneSent) return;
      proc.goneSent = true;
      log(`harness：进程结束 · ${String(why).slice(0, 200)}`);
      setState('gone', why);
    }

    /** 发一条 JSON-RPC 请求（`initialize` / `session/prompt`）。 */
    function request(proc, method, params) {
      return new Promise((resolve, reject) => {
        const child = proc.child;
        if (!child || proc.dead) {
          reject(new Error('没有可用的 DSH 进程'));
          return;
        }
        const id = ++proc.nextId;
        proc.pending.set(id, { resolve, reject });
        try {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        } catch (err) {
          proc.pending.delete(id);
          reject(err);
        }
      });
    }

    /** 起一个新进程，并把它的 stdout **逐行原样**丢出去。 */
    function spawnProc() {
      gen += 1;
      const proc = {
        gen,
        child: null,
        buf: '',
        // ★ **每次进程一个新 UUID**（契约 §5.3）：DSH 的会话记录跨进程活着，
        //   沿用旧 id 会撞 `session "…" already exists`（这坑 `agent-runtime` 踩过）。
        sessionId: uuid(),
        ready: false,
        dead: false,
        killing: false,
        goneSent: false,
        pending: new Map(),
        stderrTail: '',
        nextId: 0,
        starting: null,
      };
      cur = proc;
      // ★ 连接一建立就先说 `booting`（判据 H3 的第一半）
      setState('booting');

      const args = harnessArgs(cfg);
      let child;
      try {
        child = spawnFn(cfg.dshBin, args, {
          cwd: cfg.agentCwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          // ★ **换手**（多租户 ②-2）：盒里的服务是 root，而 root 带 CAP_DAC_OVERRIDE
          //   ⇒ 不换手的话那台 DSH 能读钥匙。⚠️ 换不过去会异步 EPERM ⇒ 下面 `error` 那条
          //   **大声失败**，不会静默退回 root。
          ...(cfg.agentUid !== null && cfg.agentUid !== undefined ? { uid: cfg.agentUid } : {}),
          ...(cfg.agentGid !== null && cfg.agentGid !== undefined ? { gid: cfg.agentGid } : {}),
          // ★ env 走 `childEnv()`（**摘掉密钥**）——契约 §5.3 点名要它。
          //   ⚠️ `HUPO_MODEL_TICKET` 是镜像烘死的**占位符**（不是秘密），
          //     而它不匹配 `_API_KEY|_TOKEN|_SECRET` ⇒ 会原样留着，模型那条 patch 靠它。
          env: childEnv({ home: cfg.dshHome }),
        });
      } catch (err) {
        proc.dead = true;
        gone(proc, harnessSpawnWhy(err, cfg));
        return proc;
      }
      proc.child = child;
      live.add(proc);

      // ① spawn 失败是**异步事件**（不接 `error` 会把整个服务带崩）
      child.on('error', (err) => {
        proc.dead = true;
        proc.ready = false;
        live.delete(proc);
        failPending(proc, err);
        if (proc.gen !== gen || proc.killing || closed) return;
        gone(proc, harnessSpawnWhy(err, cfg));
      });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (proc.gen !== gen) return; // 旧进程的输出，丢
        proc.buf += chunk;
        let nl;
        while ((nl = proc.buf.indexOf('\n')) !== -1) {
          const line = proc.buf.slice(0, nl);
          proc.buf = proc.buf.slice(nl + 1);
          if (!line.trim()) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            // ⚠️ 不是 JSON-RPC 消息（裸日志之类）⇒ 线上没有它的位置（`raw.m` 必须是**对象**），
            //    只记一行日志，**不猜、不包装**。
            log(`harness：stdout 上有一条不是 JSON 的行（丢掉）：${line.slice(0, 80)}`);
            continue;
          }
          if (!msg || typeof msg !== 'object') continue;
          // 🔴 **原样转发**：内部处理之前先丢出去 —— 一条都不许丢、一个字段都不许改。
          //    （`initialize` 的响应、`session.event`、`session.status`、服务端返回的错，
          //      全都是同一条路：客户端自己解。）
          sendRaw(msg);
          // 内部只认自己发出去的那些 id（认出来也是**另算**，不影响上面那条转发）
          if (msg.id !== undefined && proc.pending.has(msg.id)) {
            const p = proc.pending.get(msg.id);
            proc.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(String(msg.error.message ?? JSON.stringify(msg.error))));
            else p.resolve(msg.result);
          }
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => {
        proc.stderrTail = (proc.stderrTail + d).slice(-2000);
      });
      // stdin 上出错（EPIPE）别把进程带崩
      child.stdin?.on?.('error', () => {});

      child.on('exit', (code, signal) => {
        proc.dead = true;
        proc.ready = false;
        live.delete(proc);
        failPending(proc, new Error('那台 DSH 退出了'));
        if (proc.gen !== gen) return;
        if (proc.killing || closed) return; // 是我们收的（stop / 断线）—— 原因已经说过了
        gone(proc, harnessExitWhy({ code, signal, stderrTail: proc.stderrTail }));
      });

      return proc;
    }

    /** `initialize`（参数照 `agent-runtime.js:432-439`）。 */
    function initProc(proc) {
      return withTimeout(
        request(proc, 'initialize', {
          cwd: cfg.agentCwd,
          provider: cfg.agentProvider,
          model: cfg.agentModel,
          reasoningEffort: cfg.agentEffort,
          maxTokens: cfg.agentMaxTokens,
        }),
        bootMs,
        'harness 启动（initialize）',
      ).then(
        () => {
          proc.ready = true;
          if (isCurrent(proc)) setState('ready');
          return true;
        },
        (err) => {
          // 起不来 ⇒ **老实说一句人话**，并把进程收干净（半条命的进程比没有更坏）
          if (isCurrent(proc)) {
            killProc(proc);
            gone(proc, `那台 DSH 起不来：${String(err?.message ?? err).slice(0, 300)}`);
          }
          return false;
        },
      );
    }

    /** 起（或复用）那一个进程。 */
    async function start() {
      const proc = cur && !cur.dead ? cur : spawnProc();
      if (proc.dead) return false;
      if (!proc.starting) proc.starting = initProc(proc);
      return proc.starting;
    }

    /** 说一句 ⇒ `session/prompt`（`sessionId` = 这个进程的 UUID，照契约 §5.3）。 */
    async function say(text) {
      const ok = await start();
      if (!ok) return; // 起不来/挂了 ⇒ `gone` 已经说过了，不猜
      const proc = cur;
      if (!proc || proc.dead) return;
      request(proc, 'session/prompt', {
        sessionId: proc.sessionId,
        contentBlocks: [{ type: 'text', text: String(text ?? '') }],
      }).catch((err) => {
        // 投不出去：进程可能已经死了 ⇒ 那条 `exit` 会说 `gone`；这里只记一行
        log(`harness：这一句没投出去（${String(err?.message ?? err).slice(0, 160)}）`);
      });
    }

    /** 放弃这一轮（**= 关掉那个进程**，协议没别的办法）。 */
    function stop() {
      const proc = cur;
      if (!proc || proc.dead) {
        setState('gone', '这一轮已经停了。');
        return;
      }
      killProc(proc);
      gone(proc, '你说停 —— 这一轮就到这儿（这台 DSH 的协议里，"放弃一轮"就是关掉进程）。');
    }

    /** 连接没了 ⇒ **进程收干净**（判据 H6）。 */
    const bye = () => {
      if (closed) return;
      closed = true;
      attached.delete(ws);
      if (cur && !cur.dead) killProc(cur);
    };

    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // 这条线上只有文本帧（契约 §5.2）
      let j = null;
      try {
        j = JSON.parse(String(data));
      } catch {
        return; // 不认识的文本帧一律丢
      }
      if (!j || typeof j !== 'object') return;
      if (j.t === 'say') {
        void say(j.text);
        return;
      }
      if (j.t === 'stop') {
        stop();
        return;
      }
      // ⚠️ 线上只有那三种消息（字段冻结）⇒ 不认识的**不猜、也不回话**。
    });
    ws.on('close', bye);
    ws.on('error', bye);

    // ★ **连接建立 ⇒ 起进程**（判据 H3：先 `booting`，`initialize` 成 ⇒ `ready`）
    void start();
  }

  return {
    path: HARNESS_PATH,
    attach,
    /** 现在几条连接、几个活进程（判据与健康检查用；**不含用户内容**）。 */
    stats() {
      return { connections: attached.size, processes: live.size };
    },
    /** 把所有进程收干净（`server.close()` 之后兜底）。 */
    shutdown() {
      for (const proc of [...live]) killProc(proc);
      for (const ws of [...attached]) {
        try {
          ws.close(1001);
        } catch {
          /* 已经没了 */
        }
      }
      attached.clear();
    },
  };
}
