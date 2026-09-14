// Agent 运行时：**一个会话 = 一个真 DSH agent 进程**。
//
// 这是 2026-09-14 架构转向的落点。之前处理层是"手搓的四次模型调用"
// （receiver / classify / expert / feedback），等于把一个人劈成四个分身
// 还让它们互相复述。现在改成：**一个 agent 会话，它自己就是那四层**。
//
// 协议（`@deepseek-ai/dsh-sdk-protocol`，stdio 换行分隔 JSON-RPC 2.0）：
//   客户端 → 服务端：initialize / session/prompt / shutdown
//   服务端 → 客户端：session.event（完整会话日志事件）/ session.status
//                   / subagent.started / subagent.finished
//
// 关键性质（都实测过）：
//   · `sessionId` 未知时会**惰性新建**一个 agent+session 对
//   · 事件按 **step 整段**到达，没有 token 级 delta
//   · `tool/result.data.meta.sources[]` 直接带 `{url,title}`，不用解析 HTML
//   · 一个空闲进程约 195MB RSS，所以**每会话一个、常驻**，别反复冷启（冷启 2.7s）

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';

/**
 * 读一个进程的常驻内存（RSS，字节）。读不到返回 null。
 *
 * 为什么直接读 /proc 而不用别的：agent 是**子进程**，Node 拿不到它的内存统计。
 * /proc/<pid>/status 里的 VmRSS 是唯一现成的、够准的数。
 * 非 Linux（或进程刚没了）就返回 null —— 开发卡片会显示"—"，不是 0。
 */
function readRssBytes(pid) {
  if (!pid) return null;
  try {
    const text = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = text.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

/** 一个 agent 会话（= 一个用户窗口）。事件通过 EventEmitter 出来。 */
export class AgentSession extends EventEmitter {
  /**
   * @param {object} cfg 见 config.js
   * @param {string} sessionId 会话 id（也用作 DSH 的 sessionId）
   */
  constructor(cfg, sessionId) {
    super();
    this.cfg = cfg;
    this.sessionId = sessionId;
    this.child = null;
    this.ready = false;
    this.running = false;
    this.disposed = false;
    this._nextId = 1;
    this._pending = new Map();
    this._buf = '';
    /** 上一次真正的失败原因（给健康检查与开发卡片看）。 */
    this.lastError = null;
    /** 正在跑的这一轮的起始时间（调度器判"要不要变成独立的事"要用）。 */
    this.turnStartedAt = 0;
    /** 这个进程是什么时候起的（开发卡片要显示它活了多久）。 */
    this.spawnedAt = 0;
    /** 起过几次（崩溃重启会累加；开发卡片一眼看出"这个一直在挂"）。 */
    this.restarts = 0;
  }

  // ── 生命周期 ────────────────────────────────────────────────

  /** 确保进程起来了、握手完成了。重复调用安全。 */
  async start() {
    if (this.disposed) throw new Error('会话已释放');
    if (this.ready && this.child && !this.child.killed) return;
    // ⚠ 必须**合并并发调用**（踩过）：预热（WS 一连上就起）和用户第一句话
    // 几乎同时到达，不挡的话 `_spawn()` 会跑两次 —— 两个进程的 stdout 灌进
    // 同一个缓冲区、帧互相穿插、协议全乱，用户看到"这条我没能给出结论"。
    // 症状是**偶发**的，正是竞态的典型样子。
    if (!this._starting) {
      this._starting = this._spawn().finally(() => {
        this._starting = null;
      });
    }
    return this._starting;
  }

  async _spawn() {
    const cfg = this.cfg;
    const args = ['--profile', cfg.agentProfile];
    if (cfg.personaPath) args.push('--patch', cfg.personaPath);

    // 每次 spawn 一个代号：属于旧进程的 stdout 一律丢弃
    const gen = (this._gen = (this._gen ?? 0) + 1);

    const child = spawn(cfg.dshBin, args, {
      cwd: cfg.agentCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.child = child;
    this._buf = '';
    this.ready = false;
    this.spawnedAt = Date.now();
    this.restarts += 1;

    // ⚠ spawn 失败是**异步**事件，不接它会把整个服务带崩
    //（踩过：systemd 的 PATH 里没有 nvm 的 bin，一次 ENOENT 就把服务打挂，
    //  然后 systemd 反复重启，用户看到的是"整个应用没反应"）
    child.on('error', (err) => {
      this.lastError = err;
      this.ready = false;
      this.running = false;
      for (const [, p] of this._pending) p.reject(err);
      this._pending.clear();
      this.emit('exit', { code: null, signal: null, stderrTail: String(err?.message ?? err), wasReady: false });
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (gen !== this._gen) return; // 这是被替换掉的旧进程，丢弃
      this._onStdout(chunk);
    });

    let stderrTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d).slice(-2000);
      this.emit('stderr', String(d));
    });

    child.on('exit', (code, signal) => {
      if (gen !== this._gen) return; // 旧进程退出，不影响当前这个
      const wasReady = this.ready;
      this.ready = false;
      this.running = false;
      // 未完成的请求全部拒绝 —— 不能让调用方永远挂着
      for (const [, p] of this._pending) p.reject(new Error('agent 进程退出'));
      this._pending.clear();
      this._starting = null;
      this.emit('exit', { code, signal, stderrTail, wasReady });
    });

    // 握手：带超时，起不来就如实失败（不留白）
    await withTimeout(
      this._request('initialize', {
        cwd: this.cfg.agentCwd,
        provider: this.cfg.agentProvider,
        model: this.cfg.agentModel,
        reasoningEffort: this.cfg.agentEffort,
        maxTokens: this.cfg.agentMaxTokens,
      }),
      this.cfg.agentBootTimeoutMs,
      `agent 启动超时（${this.cfg.agentBootTimeoutMs}ms）`,
    );

    this.ready = true;
    this.lastError = null;
    this.emit('ready');
  }

  /** 发一句话给 agent。返回入队回执，不等它跑完。 */
  async prompt(text) {
    await this.start();
    const result = await this._request('session/prompt', {
      sessionId: this.sessionId,
      contentBlocks: [{ type: 'text', text }],
    });
    return result;
  }

  /**
   * 问一句并**等它答完**（收齐这一轮的所有文本）。
   *
   * 给"监控层"用：读记录做总结这种活，需要拿到完整答案而不是流式事件。
   * 产品对话路径**不要**用这个 —— 那条路必须流式。
   */
  async ask(text, { timeoutMs = 120000 } = {}) {
    await this.start();
    const parts = [];
    const onEvent = ({ event }) => {
      if (event?.type !== 'assistant/message') return;
      for (const b of event.data?.message?.content ?? []) {
        if (b?.type === 'text' && String(b.text ?? '').trim()) parts.push(b.text);
      }
    };
    this.on('session-event', onEvent);
    try {
      const finished = new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        this.once('idle', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await this.prompt(text);
      await finished;
      return parts.join('\n');
    } finally {
      this.off('session-event', onEvent);
    }
  }

  /**
   * 给开发卡片看的**活体状态快照**。
   *
   * 注意这里只描述"进程怎么样"，不含任何用户内容 —— 开发卡片是给人看进程的，
   * 不是给人看聊天的。
   */
  describe() {
    return {
      sessionId: this.sessionId,
      pid: this.child?.pid ?? null,
      ready: this.ready,
      running: this.running,
      /** 状态：起不来 / 起着的 / 正在干活 / 空闲待命 */
      state: !this.ready
        ? (this._starting ? 'starting' : 'down')
        : this.running
          ? 'running'
          : 'idle',
      rssBytes: readRssBytes(this.child?.pid),
      spawnedAt: this.spawnedAt || null,
      turnStartedAt: this.running && this.turnStartedAt ? this.turnStartedAt : null,
      restarts: this.restarts,
      lastError: this.lastError ? String(this.lastError.message ?? this.lastError).slice(0, 120) : null,
    };
  }

  /** 主动关掉（进程回收时用）。 */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await withTimeout(this._request('shutdown', undefined), 3000, 'shutdown 超时');
    } catch {
      /* 已经没了也无所谓 */
    }
    try {
      this.child?.kill('SIGTERM');
    } catch {
      /* 忽略 */
    }
  }

  // ── JSON-RPC ───────────────────────────────────────────────

  _request(method, params) {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.killed || !this.child.stdin.writable) {
        reject(new Error('agent 进程不可用'));
        return;
      }
      this._pending.set(id, { resolve, reject });
      const frame = { jsonrpc: '2.0', id, method };
      if (params !== undefined) frame.params = params;
      this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    });
  }

  _onStdout(chunk) {
    this._buf += chunk;
    let nl;
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit('protocol-error', { reason: 'bad-frame', line: line.slice(0, 200) });
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // 响应
    if (msg.id != null && !msg.method) {
      const p = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (!p) return;
      if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    // 服务端反向请求：SDK 运行时不该这么做，但真发生也别把它挂死
    if (msg.id != null && msg.method) {
      this.emit('protocol-error', { reason: 'server-request', method: msg.method });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`);
      } catch {
        /* 忽略 */
      }
      return;
    }
    // 通知
    switch (msg.method) {
      case 'session.event':
        this.emit('session-event', msg.params);
        break;
      case 'session.status': {
        this.running = msg.params?.status === 'running';
        if (this.running) this.turnStartedAt = Date.now();
        else this.emit('idle', msg.params);
        this.emit('status', msg.params);
        break;
      }
      case 'subagent.started':
      case 'subagent.finished':
        this.emit('subagent', msg);
        break;
      default:
        this.emit('unknown', msg);
    }
  }
}

/** 进程池：按会话 id 复用，并提供整体回收。 */
export class AgentRuntime {
  constructor(cfg) {
    this.cfg = cfg;
    /** @type {Map<string, AgentSession>} */
    this.sessions = new Map();
    /**
     * 本次进程启动的标记。
     *
     * 为什么要它：SDK 的 `session/prompt` 对已存在的会话 id 会**报错**（不能 resume），
     * 所以每次服务启动都换一个 DSH 会话 id，避免撞上上次留下的日志。
     */
    this.bootId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    /** 运行时长（开发卡片上一眼看它跑了多久） */
    this.bootIdStart = Date.now();
  }

  /** 我们这边的会话 id → DSH 那边的会话 id。 */
  dshSessionId(sessionId) {
    return `${sessionId}.${this.bootId}`;
  }

  /** 拿到（必要时创建）某个会话的 agent。 */
  agent(sessionId) {
    let a = this.sessions.get(sessionId);
    if (!a) {
      a = new AgentSession(this.cfg, this.dshSessionId(sessionId));
      a.on('exit', () => {
        // 进程没了就把它从池子里摘掉，下次访问会重新起
        if (this.sessions.get(sessionId) === a) this.sessions.delete(sessionId);
      });
      this._armEviction(sessionId, a);
      this.sessions.set(sessionId, a);
    }
    return a;
  }

  /**
   * 空闲回收。
   *
   * 为什么要它：一个常驻 agent 实测 **195MB RSS**，而服务有 `MemoryMax=1G` ——
   * 会话一多（每次测试都新建一个 `c_watch_*`）就会把服务撑死。
   * 空闲够久就主动关掉，下次说话再起（冷启动 2.7–5.1s，可接受）。
   */
  _armEviction(sessionId, agent) {
    const idleMs = this.cfg.agentIdleEvictMs;
    if (!idleMs || idleMs <= 0) return;

    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (agent.running) return; // 还在干活，别动它
        if (this.sessions.get(sessionId) !== agent) return;
        this.sessions.delete(sessionId);
        agent.dispose().catch(() => {});
      }, idleMs);
      timer.unref?.();
    };
    agent.on('status', (s) => {
      if (s?.status === 'running') clearTimeout(timer);
      else arm();
    });
    agent.on('exit', () => clearTimeout(timer));
    arm();
  }

  /** 关掉全部 agent 进程（服务退出时）。 */
  async shutdown() {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(all.map((a) => a.dispose()));
  }

  /**
   * 健康快照（不含任何用户数据）。
   *
   * 开发卡片靠它显示"现在有哪些 agent 进程、各自什么状态、占多少内存"——
   * 一个会话一个进程，常驻 150–200MB，**看不见就会失控**（内存、僵尸、反复重启）。
   */
  stats() {
    const agents = [...this.sessions.entries()].map(([key, a]) => ({
      key,
      ...a.describe(),
    }));
    return {
      sessions: agents.length,
      ready: agents.filter((a) => a.ready).length,
      running: agents.filter((a) => a.running).length,
      totalRssBytes: agents.reduce((sum, a) => sum + (a.rssBytes ?? 0), 0),
      agents,
      uptimeMs: Date.now() - this.bootIdStart,
    };
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}
