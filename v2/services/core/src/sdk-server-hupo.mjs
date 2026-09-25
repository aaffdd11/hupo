// **我们自己的 SDK server**（DSH 插件）：官方那份只能 create，这一份**能 resume**。
//
// 契约：`docs/dev/110-ONE-SESSION-PER-ROOM.md`。
// 用法（`agentPatchArgs()` 里那一层，`hupo-sdk-server.yml`）：
//   ① 把官方的 `sdk-jsonrpc-server` **关掉**（`disabled: true`）——
//      两个 server 都读 stdin 会**互相抢帧**（真机验过）；
//   ② `insert` 我们这一个 —— 那份 patch 里写的是**相对它自己**的
//      `./src/sdk-server-hupo.mjs`（DSH 会把 insert 里的相对路径按 patch 所在目录
//      锚成绝对 URL）⇒ 本机与盒里同一条 patch 都对。**不用 env 递路径**：
//      实测 loader **不对 `name` 求值 `!!js`**（真机读数见那份 yml 顶上）。
//
// ── 为什么是"一个自足的文件"（没有任何 `@deepseek-ai/...` import）──────
//
// 插件是**按绝对路径**被 DSH 的 loader 加载的，而 node 的裸标识符
// 是**按插件文件所在目录**解析的 —— 我们的文件住在 `src/`，
// 那里没有 `node_modules/@deepseek-ai/*`（本机与盒里都没有）。
// ⇒ 官方那份用到的四样（NDJSON 传输 / `createUserMessage` / `brandString` /
//   `carrierKeyOf`）这里都**照它自己的实现重写一遍**（都是十几行；
//   而且 `brandString` 就是恒等函数、`createUserMessage` 就是打个 id 再冻）；
// ⇒ 好处：这份文件**能被 `node --test` 直接 import**（判据 S2 要拿假 ctx 断言
//   "到底走了 create 还是 resume"），不必把整个 DSH 拖进判据。
//
// ── 与官方那份逐条对齐的地方（**客户端一个字都不用改**）──────────
//
//   · 方法：`initialize` / `session/prompt` / `shutdown`（＋我们多一条 `session/resume`）；
//   · 通知：`session.event` · `session.status` · `subagent.started` · `subagent.finished`；
//   · `stopReason === 'max-tokens'` 且 `maxTokensAsSuccess === true` ⇒ `ok`；
//   · 协议帧只走 stdout，**日志/诊断一律 stderr**；
//   · `initialize` 之前先 `await ctx.get('loader').await()` —— 官方那句。
//
// 🔴 新增的那条语义（这就是"一个房间一个对话"的机关）：
//   `session/prompt` 每次都给**同一个**会话 id ⇒ 我们**先看它在不在**：
//     · 在（持久化里有 / 内存里活着） ⇒ `ctx.agents.resume(...)`
//     · 不在                          ⇒ `ctx.agents.create(...)`
//   官方那份只有 create ⇒ 同一个 id 第二次进来报 `already exists`。
//
// ⚠️ **agent factory 是稍后才注册上来的**（真机读数：插件加载那一刻就调
//    create/resume 会报 `no agent factory registered (load an agent-loop plugin)`）。
//    ⇒ ① 帧只有在 `initialize` 之后才处理；② `initialize` 里先 `loader.await()`；
//      ③ 万一还是撞上（时序留了口子），只有**那一句话**会触发一小段有上限的重试
//       （见 `#withFactory`），到点还不行就**如实**把 DSH 的原话抛出去。
//
// 🔴 **2026-09-26 真机事故（产品层发布之后"任何一句话都没有答复"）** ——
//    根因就在下面那条 id 形状判据里（原话照抄）：
//
//      sessionId 形状不认（只收 [A-Za-z0-9._~-]、最长 200）：
//      "owner/aoshu-bank.muh709vsibnh.1"
//      ⇒ 不猜、也不替它换一个 —— 请用映射（dsh-sessions.mjs）产出的那个 id
//
//    映射里钉的是 **DSH 自己的 id** —— `owner/aoshu-bank.muh709vsibnh.1`（带一个 `/`）：
//    **注册表 / 会话头里的 `id` 是原始形式**，**目录名才是转义形式**
//    （DSH 的 `encodeSegment` 把 `/` ⇒ `~002F`）。上一版的形状不收 `/`
//    ⇒ 把 DSH 自己的 id 判成非法 ⇒ 那一句话**根本投不出去**、用户永远等不到答复
//    （盘上像没发生过）⇒ 只好回滚。
//    ⇒ 判据已挪到 `src/session-id.mjs`（**一处出处**，`dsh-sessions.mjs` 也 import 它）：
//      "DSH 收什么就收什么" —— **收 `/`**，只拒 空 / 超长 / 控制字符 / `.`、`..` 整段。

import nodePath from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { assertSessionId, isSessionIdShape } from './session-id.mjs';

// ── 一、NDJSON 传输（照 `@deepseek-ai/dsh-sdk-protocol` 的语义重写）────

/**
 * 一行一帧的 JSON-RPC 2.0：带 `id` + `method` 是请求，只有 `id` 是响应，
 * 只有 `method` 是通知。**坏行忽略**；处理函数抛错 ⇒ `-32603` 错误帧。
 */
export class LineTransport {
  #dataListener = null;
  #errorListener = null;
  #endListener = null;

  constructor(input, output) {
    this.input = input;
    this.output = output;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.started = false;
    this.requestHandler = null;
    this.notificationHandler = null;
    this.pending = new Map();
  }

  /** 接上输入流。幂等。 */
  start() {
    if (this.started) return;
    this.started = true;
    this.#dataListener = (chunk) => this.#onData(chunk);
    this.#errorListener = () => this.#failPending(new Error('JSON-RPC transport input error'));
    this.#endListener = () => this.#failPending(new Error('JSON-RPC transport closed'));
    this.input.on('data', this.#dataListener);
    this.input.on('error', this.#errorListener);
    this.input.on('end', this.#endListener);
  }

  /** 摘掉监听（**不销毁流** —— 官方那句注释也是这个意思）。 */
  close() {
    if (!this.started) return;
    this.started = false;
    this.input.off?.('data', this.#dataListener);
    this.input.off?.('error', this.#errorListener);
    this.input.off?.('end', this.#endListener);
    this.#failPending(new Error('JSON-RPC transport closed'));
  }

  onRequest(handler) {
    this.requestHandler = handler;
  }

  onNotification(handler) {
    this.notificationHandler = handler;
  }

  /** 发一条通知（**不占号**）。 */
  notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  /** 把已经写出去的东西冲干净（进程要退之前用）。 */
  flush() {
    return new Promise((resolve) => {
      try {
        if (typeof this.output.write === 'function') {
          // 空串 + 回调：排在它前面的那些写完才回调
          this.output.write('', () => resolve());
          return;
        }
      } catch {
        /* 冲不动也要让它退 —— 那是最后一步 */
      }
      resolve();
    });
  }

  #onData(chunk) {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 坏行忽略（官方那句注释：Malformed lines are ignored）
      }
      this.#onMessage(msg);
    }
  }

  #onMessage(msg) {
    if (msg === null || typeof msg !== 'object') return;
    // 响应（只有 id）
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(String(msg.error.message ?? JSON.stringify(msg.error))));
      else p.resolve(msg.result);
      return;
    }
    // 通知（只有 method）
    if (msg.method !== undefined && msg.id === undefined) {
      try {
        this.notificationHandler?.(msg.method, msg.params ?? {});
      } catch {
        /* 通知的处理出错不外传 */
      }
      return;
    }
    // 请求（id + method）
    if (msg.method !== undefined && msg.id !== undefined) {
      const handler = this.requestHandler;
      if (!handler) {
        this.#write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no handler for ${msg.method}` } });
        return;
      }
      Promise.resolve()
        .then(() => handler(msg.method, msg.params ?? {}))
        .then(
          (result) => this.#write({ jsonrpc: '2.0', id: msg.id, result: result ?? {} }),
          (err) => this.#write({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32603, message: String(err?.message ?? err) },
          }),
        );
    }
  }

  #write(frame) {
    try {
      this.output.write(`${JSON.stringify(frame)}\n`);
    } catch {
      /* 对端没了 —— 上层会从 EOF/退出那条路收场 */
    }
  }

  #failPending(err) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}

// ── 二、几件官方那边 import 进来的小事（这里照实现重写）────────────

/**
 * 造一条**用户消息**（官方用 `@deepseek-ai/dsh-llm` 的 `createUserMessage`，
 * 它做的事就是打个 `randomUUID` 的 id 再深冻一下 —— `brandString` 是恒等函数）。
 */
export function createUserMessage({ content, source = { kind: 'user' } } = {}) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([...(content ?? [])]),
    source,
  });
}

/** `stopReason` ⇒ 状态（官方 `successStatus`：只有 completed / max-tokens-as-success 算 ok）。 */
export function successStatus(reason, { maxTokensAsSuccess = false } = {}) {
  if (reason === 'completed') return 'ok';
  return reason === 'max-tokens' && maxTokensAsSuccess === true ? 'ok' : 'error';
}

/**
 * 会话 id 的**形状**：判据在 `src/session-id.mjs`（**一处出处** —— `dsh-sessions.mjs`
 * 读映射时也调它，所以"映射里钉的值"与"服务端收的值"不可能两套口径）。
 *
 * 这里**只 re-export**（不在这里再写一份）：上一版那个 `SESSION_ID_SHAPE`
 * 正则（不收 `/`）就是把 DSH 自己的 id 判成非法、导致真机全程静默的那个根因。
 *
 * 收什么、拒什么、为什么 `/` 必须收：见 `session-id.mjs` 顶上那段（真机读数照抄）。
 */
export { assertSessionId, isSessionIdShape };

/** 内容块 ⇒ 官方那条路要的形状。**只收文本**（我们客户端只发文本）。 */
export function normalizeContentBlocks(blocks) {
  if (!Array.isArray(blocks)) throw new Error('session/prompt 的 contentBlocks 必须是数组');
  if (blocks.length === 0) throw new Error('session/prompt 的 contentBlocks 是空的 —— 没有说话的内容');
  return blocks.map((b) => {
    const type = b?.type;
    if (type !== 'text') {
      throw new Error(`这一份 SDK server 只收文本内容块（收到 ${JSON.stringify(type)}）—— 如实拒绝，不猜`);
    }
    if (typeof b.text !== 'string') throw new Error('文本内容块的 text 必须是字符串');
    return { type: 'text', text: b.text };
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 那句话只可能是"factory 还没注册上来"（真机读数；见文件头那段）。 */
const FACTORY_NOT_READY = /no agent factory registered/i;

// ── 三、server 本体 ─────────────────────────────────────────────

/**
 * 一次 `initialize` 之后，守着**同一份 `ctx`** 的 SDK server。
 *
 * 所有外部依赖都从 `ctx` 拿（`agents` / `sessions` / `sessionPersistence` /
 * `on` / `get`），所以判据可以给一个**假 ctx**把两条路都走一遍。
 */
export class HupoSdkServer {
  constructor(ctx, transport, options = {}) {
    this.ctx = ctx;
    this.transport = transport;
    this.options = options;
    this.cwd = process.cwd();
    this.provider = 'deepseek-official';
    this.model = 'deepseek-official';
    this.reasoningEffort = undefined;
    this.maxTokens = undefined;
    this.initialized = false;
    this.shuttingDown = false;
    /** 这个 server 自己开着的那些会话（会话 id → `{handle}`）。 */
    this.sessions = new Map();
    this.creations = new Map();
    this.disposers = [];
    /** 子会话 id → 它的父会话 id（`session/created` 那一条给的）。 */
    this.parentOf = new Map();
    /** factory 还没上来时最多等多久（**上限**，到点如实抛 DSH 的原话）。 */
    this.factoryWaitMs = Number.isFinite(options.factoryWaitMs) ? options.factoryWaitMs : 8000;
    this.shutdownTask = undefined;
    /**
     * "这条会话在不在"的判据。**可注入**（判据 S2 拿它选 create / resume）。
     * 默认：内存里有 ⇒ 在；否则问 `sessionPersistence`（持久化里有没有这条）。
     */
    this.exists = typeof options.exists === 'function' ? options.exists : (id) => this.#persistedExists(id);

    const notify = (method, params) => this.transport.notify(method, params);
    const on = this.ctx?.on?.bind(this.ctx);
    if (on) {
      // 照官方那四条（客户端认的是"点"那套方法名）
      this.disposers.push(on('session/event', (session, event) => {
        notify('session.event', { sessionId: String(session.id), event });
      }));
      this.disposers.push(on('agent/status', ({ agent, status }) => {
        notify('session.status', { sessionId: String(agent.session.id), status });
      }));
      this.disposers.push(on('session/created', (session) => {
        const parentSession = session?.header?.parentSession;
        if (parentSession === undefined) return;
        this.parentOf.set(String(session.id), String(parentSession));
        notify('subagent.started', {
          parentSessionId: String(parentSession),
          childSessionId: String(session.id),
        });
      }));
      // ⚠️ 官方那份是用 `this`（作用域 carrier）反查父会话的 —— 那要
      //    `@deepseek-ai/dsh-scope` 的私有 WeakMap。这里换成**自己记的那份**
      //    （`session/created` 的 `header.parentSession`，与官方同源）。
      //    查不到 ⇒ stderr 如实记一句、**跳过**这条通知（宁可少一条通知，
      //    也不许把父会话 id 编一个出来）。
      this.disposers.push(on('subagent/end', (info) => {
        if (!info?.local) return;
        const child = String(info.id);
        const parent = this.parentOf.get(child);
        if (parent === undefined) {
          this.#log(`subagent/end：认不出 ${child} 的父会话（没在 session/created 里见过它）—— 这一条不转发`);
          return;
        }
        notify('subagent.finished', {
          provider: info.provider,
          agentId: child,
          parentSessionId: parent,
          childSessionId: child,
          status: successStatus(info.stopReason, this.options),
          stopReason: info.stopReason,
          ...(info.lastAssistantMessage === undefined ? {} : { lastAssistantMessage: info.lastAssistantMessage }),
        });
      }));
    }
  }

  /** 诊断一律走 **stderr**（stdout 只许放协议帧）。 */
  #log(text) {
    try {
      process.stderr.write(`[hupo-sdk-server] ${text}\n`);
    } catch {
      /* 写不出去也不能影响协议 */
    }
  }

  /** agentOptions（照官方：只放有值的）。 */
  #agentOptions() {
    return {
      provider: this.provider,
      model: this.model,
      ...(this.reasoningEffort === undefined ? {} : { reasoningEffort: this.reasoningEffort }),
      ...(this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens }),
    };
  }

  /**
   * 握手。照官方那份：校验参数 → `resolve(cwd)` → 确认 provider 有适配器
   * → `llm.resolveCallConfig`（它就是"这把 provider/model 认不认"的闸）。
   *
   * ⚠️ 官方在没有适配器时会**自己挂** `dsh-llm-deepseek`（`ctx.plugin(...)`）——
   *    我们这一份 import 不了那个包（见文件头）⇒ **如实报错**。
   *    实测：`--profile sdk` 的配置树里**本来就有** `llm-deepseek`
   *    （`dsh --profile sdk --dump-config` 点名看得到）⇒ 这条路不该被走到。
   */
  async initialize(params = {}) {
    if (params.reasoningEffort !== undefined && (typeof params.reasoningEffort !== 'string' || params.reasoningEffort.length === 0)) {
      throw new TypeError('initialize reasoningEffort must be a non-empty string');
    }
    if (params.maxTokens !== undefined && (!Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0)) {
      throw new TypeError('initialize maxTokens must be a positive safe integer');
    }
    if (typeof params.cwd !== 'string' || params.cwd === '') {
      throw new TypeError('initialize cwd must be a non-empty string');
    }
    if (typeof params.provider !== 'string' || params.provider === '') {
      throw new TypeError('initialize provider must be a non-empty string');
    }
    if (typeof params.model !== 'string' || params.model === '') {
      throw new TypeError('initialize model must be a non-empty string');
    }
    const cwd = nodePath.resolve(params.cwd);
    const llm = this.ctx?.get?.('llm');
    if (!llm?.resolveCallConfig) throw new Error('这一份 ctx 里没有 llm 服务 —— 起不来（不静默退化）');
    const providers = llm.listProviders?.() ?? [];
    if (providers.length > 0 && !providers.some((entry) => entry?.id === params.provider)) {
      throw new Error(
        `这一份 profile 里没有 provider "${params.provider}" 的适配器（现有：${providers.map((p) => p?.id).join(', ')}）\n` +
          '    ⇒ 官方那份会自己挂一个 dsh-llm-deepseek，我们这份是自足的（import 不了它）⇒ 如实报错，不静默退化',
      );
    }
    await llm.resolveCallConfig({
      provider: params.provider,
      model: params.model,
      ...(params.reasoningEffort === undefined ? {} : { reasoningEffort: params.reasoningEffort }),
      ...(params.maxTokens === undefined ? {} : { maxTokens: params.maxTokens }),
    });

    this.cwd = cwd;
    this.provider = params.provider;
    this.model = params.model;
    this.reasoningEffort = params.reasoningEffort;
    this.maxTokens = params.maxTokens;
    this.initialized = true;
    return { serverInfo: { name: 'hupo-sdk-runtime', version: '0.0.1' } };
  }

  /** 说一句。**立刻返回** `{messageId}`，答案从 `session.event` 流回来。 */
  async prompt(params = {}) {
    if (!this.initialized) throw new Error('SDK server is not initialized');
    const sessionId = assertSessionId(params.sessionId);
    const content = normalizeContentBlocks(params.contentBlocks);
    const rec = await this.getOrCreate(sessionId);
    this.#assertLiveAgent(rec, sessionId);
    const message = createUserMessage({ content, source: { kind: 'user' } });
    rec.handle.agent.followup(message);
    return { messageId: message.id };
  }

  /**
   * **显式 resume**（只 resume、不 create）：给排障/真机读数用
   * （客户端走 `session/prompt`，那条路**会** create）。
   *
   * 契约里那两条：
   *   · 这条会话**不在** ⇒ 如实报"这条会话不在"（**不许**顺手建一条）；
   *   · 给了 `cwd` 而它与持久化里那条不一致 ⇒ 如实报错，**不硬来**
   *     （DSH 的会话是按 cwd 分组的；cwd 不同就是另一间）。
   */
  async resume(params = {}) {
    if (!this.initialized) throw new Error('SDK server is not initialized');
    const sessionId = assertSessionId(params.sessionId);
    const wantCwd = params.cwd === undefined ? undefined : nodePath.resolve(String(params.cwd));

    const live = this.sessions.get(sessionId);
    if (live) {
      this.#assertLiveAgent(live, sessionId);
      this.#assertCwd(sessionId, this.#liveCwd(sessionId), wantCwd);
      return { sessionId, resumed: true, live: true };
    }
    if (!(await this.exists(sessionId))) {
      throw new Error(
        `这条会话不在：${sessionId}\n` +
          `    ⇒ 它在 DSH_HOME 里没有会话记录（cwd=${wantCwd ?? this.cwd}）—— 这一条路**只 resume、不 create**`,
      );
    }
    await this.getOrCreate(sessionId, { cwdForCheck: wantCwd });
    return { sessionId, resumed: true, live: false };
  }

  /** 取（或开）一条会话。官方 `getOrCreateSession` 的加强版：先看"在不在"。 */
  async getOrCreate(sessionId, { cwdForCheck } = {}) {
    assertSessionId(sessionId);
    if (this.shuttingDown) throw new Error('SDK server is shutting down');
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const pending = this.creations.get(sessionId);
    if (pending) return pending;
    const creation = this.#openSession(sessionId, { cwdForCheck });
    this.creations.set(sessionId, creation);
    creation.then(
      () => this.creations.delete(sessionId),
      () => this.creations.delete(sessionId),
    );
    return creation;
  }

  /**
   * **create 还是 resume** —— 这个契约的全部机关就在这十几行里。
   *
   * 判据（`exists`）说"在" ⇒ `resume`；说"不在" ⇒ `create`。
   * ⚠️ 顺序不许反：先 create 会撞 `session "…" already exists`（官方那份的病）。
   */
  async #openSession(sessionId, { cwdForCheck } = {}) {
    const exists = await this.exists(sessionId);
    if (exists) {
      const rec = { handle: await this.#resumeById(sessionId, cwdForCheck) };
      this.sessions.set(sessionId, rec);
      return rec;
    }
    const rec = {
      handle: await this.#withFactory(() => this.ctx.agents.create({
        sessionId,
        meta: { cwd: this.cwd },
        agentOptions: this.#agentOptions(),
      })),
    };
    this.sessions.set(sessionId, rec);
    return rec;
  }

  async #resumeById(sessionId, cwdForCheck) {
    const persistedCwd = await this.#persistedCwd(sessionId);
    this.#assertCwd(sessionId, persistedCwd, cwdForCheck);
    const handle = await this.#withFactory(() => this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: this.#agentOptions(),
    }));
    // 起来之后再核一次（持久化那份读不到时，这一句是**唯一的** cwd 校验）
    const liveCwd = this.#liveCwd(sessionId);
    if (persistedCwd === undefined && liveCwd !== undefined && cwdForCheck !== undefined
      && nodePath.resolve(liveCwd) !== nodePath.resolve(cwdForCheck)) {
      try {
        await handle.dispose();
      } catch {
        /* 收不掉也要把这条真话说出去 */
      }
      throw new Error(
        `会话 "${sessionId}" 属于另一个工作目录（持久化里是 ${liveCwd}，这次要的是 ${cwdForCheck}）—— 不硬来`,
      );
    }
    return handle;
  }

  /** 内存里那条会话的 cwd（拿不到 ⇒ `undefined`，不猜）。 */
  #liveCwd(sessionId) {
    const session = this.ctx?.sessions?.get?.(sessionId);
    const cwd = session?.header?.cwd;
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
  }

  #assertCwd(sessionId, persistedCwd, wantCwd) {
    if (wantCwd === undefined || persistedCwd === undefined) return;
    if (nodePath.resolve(persistedCwd) === nodePath.resolve(wantCwd)) return;
    throw new Error(
      `会话 "${sessionId}" 与这次要的工作目录对不上：持久化里是 ${persistedCwd}，这次是 ${wantCwd}\n` +
        '    ⇒ 不硬来（DSH 的会话按 cwd 分组；硬换会把那一间的记录指到别处）',
    );
  }

  /** 持久化里那条会话在不在（`sessionPersistence` 没挂 ⇒ "不在"，且**不猜**）。 */
  async #persistedExists(sessionId) {
    if (this.ctx?.sessions?.get?.(sessionId) !== undefined) return true;
    const persistence = this.ctx?.get?.('sessionPersistence');
    if (!persistence?.open) return false;
    try {
      const handle = await persistence.open(sessionId, 'read');
      try {
        await handle?.close?.();
      } catch {
        /* 关不掉不影响"它在" */
      }
      return true;
    } catch (err) {
      if (err?.name === 'SessionPersistenceNotFoundError') return false;
      throw err; // 读不出来 ≠ 不在（**不许**把"不知道"当成"没有"）
    }
  }

  /** 持久化那条会话的 cwd（读不到 ⇒ `undefined`，不猜）。 */
  async #persistedCwd(sessionId) {
    const persistence = this.ctx?.get?.('sessionPersistence');
    if (!persistence?.open) return undefined;
    try {
      const handle = await persistence.open(sessionId, 'read');
      const cwd = handle?.header?.cwd;
      try {
        await handle?.close?.();
      } catch {
        /* 同上 */
      }
      return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
    } catch (err) {
      if (err?.name === 'SessionPersistenceNotFoundError') return undefined;
      return undefined; // 读不动就交给后面那道（resume 自己会失败得很大声）
    }
  }

  /**
   * factory 还没上来时**有上限地**等一小会儿 —— 只认那一句话（见文件头那段）。
   * 到点还不行 ⇒ 把 DSH 的原话抛出去（如实，不包装成别的意思）。
   */
  async #withFactory(fn) {
    const deadline = Date.now() + this.factoryWaitMs;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (Date.now() >= deadline || !FACTORY_NOT_READY.test(String(err?.message ?? ''))) throw err;
        await delay(50);
      }
    }
  }

  #assertLiveAgent(rec, sessionId) {
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`session agent was disposed outside the server: ${sessionId}`);
    }
  }

  /** 收摊：先等那些还没开完的，再逐条 dispose，然后摘订阅。 */
  shutdown() {
    this.shutdownTask ??= this.performShutdown();
    return this.shutdownTask;
  }

  async performShutdown() {
    this.shuttingDown = true;
    await Promise.allSettled([...this.creations.values()]);
    this.creations.clear();
    const records = [...this.sessions.values()];
    this.sessions.clear();
    const failures = [];
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.();
      } catch (error) {
        failures.push(error);
      }
    }
    const results = await Promise.allSettled(
      records.map((rec) => Promise.resolve().then(() => rec.handle.dispose())),
    );
    failures.push(...results.filter((r) => r.status === 'rejected').map((r) => r.reason));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'SDK server teardown failed');
    return {};
  }

  /** 帧 ⇒ 方法。**认不出就如实拒**（不猜一个相近的）。 */
  async handleRequest(method, params) {
    switch (method) {
      case 'initialize': return this.initialize(params);
      case 'session/prompt': return this.prompt(params);
      case 'session/resume': return this.resume(params);
      case 'shutdown': return this.shutdown();
      default: throw new Error(`unknown DeepSeek Harness SDK runtime method: ${method}`);
    }
  }
}

// ── 四、DSH 插件那一层（形状照官方那份的 index）───────────────────

export const name = 'hupo-sdk-server';
/**
 * ⚠️ `sessions` **必须**在这一串里（真机读数）：`ctx.sessions` 是 cordis 的
 *    服务访问器，**没 inject 就抛** `cannot get property "sessions" without inject`
 *    （`initialize` 会成功，然后**每一条 `session/prompt` / `session/resume` 都失败**）。
 *    官方那份只用 `ctx.agents`，所以它没声明 `sessions` —— 我们比它多用一个。
 */
export const inject = ['agents', 'sessions'];

/**
 * 挂在 DSH 的 plugin tree 上：stdio 上服务 SDK 请求。
 *
 * ⚠️ **stdout 只许放协议帧**（所以这份文件一行 `console.log` 都不许有）。
 */
export function apply(ctx, config) {
  const resolvedConfig = config ?? {};
  const rootFiber = ctx.root.fiber;
  const input = resolvedConfig.input ?? process.stdin;
  const output = resolvedConfig.output ?? process.stdout;
  const exit = resolvedConfig.exit ?? ((code) => {
    process.exit(code);
  });
  const transport = new LineTransport(input, output);
  const server = new HupoSdkServer(ctx, transport, {
    maxTokensAsSuccess: resolvedConfig.maxTokensAsSuccess,
    ...(resolvedConfig.exists === undefined ? {} : { exists: resolvedConfig.exists }),
    ...(resolvedConfig.factoryWaitMs === undefined ? {} : { factoryWaitMs: resolvedConfig.factoryWaitMs }),
  });
  let exitTask;
  const disposeAndExit = () => {
    exitTask ??= (async () => {
      await Promise.allSettled([Promise.resolve().then(() => transport.flush())]);
      await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())]);
      exit(0);
    })();
    return exitTask;
  };
  transport.onRequest(async (method, params) => {
    // ★ 官方那句：**第一次握手前先等整棵树加载完**
    //   （agent factory 是稍后才注册上来的 —— 真机读数见文件头）
    if (method === 'initialize') await ctx.get('loader')?.await();
    const result = await server.handleRequest(method, params);
    if (method === 'shutdown') {
      setImmediate(() => {
        disposeAndExit();
      });
    }
    return result;
  });
  ctx.effect(() => {
    transport.start();
    return async () => {
      await server.shutdown();
      transport.close();
    };
  }, 'hupo-sdk-server.serve');
}
