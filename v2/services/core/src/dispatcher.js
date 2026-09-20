// 调度器的粘合层：用户说了话 → 交给 agent → 把它的话翻成产品事件。
//
// 手册 `02-ARCHITECTURE.md` §四（调度器职责）、`08-SPEC.md` §5.5（淘汰谁回调谁）。
//
// 一头一尾两件事最要紧：
//
//   **投递**：`session/prompt` 是**立刻返回**的（实测 ~35ms），
//   答案从 `session-event` 异步流回来。所以"发出去"和"答出来"是两件事，
//   **不能等 prompt 的返回值当答案**。
//
//   **收尾**：agent 进程死掉 / 被淘汰 / 超时——**都必须收口**。
//   不收的话，用户会永远等一条不会来的回答
//   （手册事故一：那行"还有件事在处理"挂了 68 分钟）。

import { RECAP_DEFAULTS, buildRecap } from './recap.js';
import { TurnTranslator } from './session-translate.js';

/**
 * 这几句是**用户能看到的**（落盘、上时间线）。所以它们必须是人话，
 * 而且要**说清怎么办**（N11）。
 *
 * ⚠️ 它们以前是**瞬态** `error`（客户端**今天不渲染** ⇒ 用户什么都看不到）。
 *    现在改成落盘的消息：**看得见才算数**。
 *    瞬态那条留着，是给"盘满了、落不下盘"的场合兜底的。
 */
const AGENT_LOST_LINE = '刚才我断了，这条没做完。再说一次吧。';
const AGENT_UNAVAILABLE_LINE = '我现在接不上活。你这句话我记下了，等我缓过来再说。';

/**
 * 单轮硬收口（手册 `08-SPEC.md` §10.2 给的阈值就是它）。
 *
 * 为什么需要：agent 卡住就是**永远卡住**——用户等一条不会来的回答。
 * 手册事故一里那行"还有件事在处理"挂了 **68 分钟**。
 */
export const TURN_DEADLINE_MS = 180_000;

export class Dispatcher {
  #timeline;
  #runtime;
  #scopeId;
  #translator;
  #store;
  #recapOptions;
  #turnDeadlineMs;
  /** 已经挂过监听的那个实例。**永不清空**——见 `#ensureAgent()`。 */
  #wiredAgent = null;
  #lastError = null;
  #recapFedTo = null;
  #lastRecap = null;
  /** turn → 计时器。一轮一个，所以"后一轮开始把前一轮的计时器顶掉"不会丢东西。 */
  #deadlines = new Map();
  /**
   * **投出去了、还没变成一轮**的那些话（先进先出）。
   *
   * 为什么要记：实测一轮没结束时再发一句，DSH 会**排队**
   * （`agent/inbox/spliced {target:"next-turn"}`）。所以超时踢进程时，
   * 排队里的话**会跟着一起没**——不逐条收口，用户就永远在等（N19）。
   *
   * 一轮开始 = 消费一条投递（今天的轮**全部**由投递引起）。
   */
  #delivered = [];
  /**
   * turn 号 → **是主人哪句话引起来的**（我们这边的 `messageId`）。
   *
   * ⚠️ 为什么要它：产品事件里**没有轮号**（`message/start` 只带 messageId）。
   *    而"对账"要在重启之后回答"**那件活动过东西没有**"——
   *    它手里的东西是"未收口的气泡"和"没人答的那句话"，**都不是轮号**。
   *    ⇒ 落盘时就得把它翻译成**某条主人消息**，否则那条记录永远对不上。
   */
  #turnOwner = new Map();

  constructor({ timeline, runtime, scopeId = null, store, recap = {}, turnDeadlineMs = TURN_DEADLINE_MS }) {
    if (!store) {
      // ⚠️ **不许默认没有 recap 就悄悄开工。**
      //    没有 store ⇒ 每次重启的用户体验都是"它失忆了"，
      //    而那种故障**看起来只是"它有点笨"**，没人会去查配置。
      throw new Error('Dispatcher 需要 store（跨重启接记忆靠它读日志）');
    }
    this.#timeline = timeline;
    this.#runtime = runtime;
    this.#scopeId = scopeId;
    this.#store = store;
    this.#recapOptions = { ...RECAP_DEFAULTS, ...recap };
    this.#turnDeadlineMs = turnDeadlineMs;
    this.#translator = new TurnTranslator({ timeline, scopeId });

    // 超时硬收口：轮的起讫从翻译层来（它才知道"这一轮开始了没有"）
    this.#translator.on('turn-start', (turn) => {
      // 一轮开始 = 消化掉一条投递。**顺手记住是哪句话引起来的**（见 `#turnOwner`）
      const owner = this.#delivered.shift();
      this.#turnOwner.set(turn, owner?.messageId ?? null);
      this.#armDeadline(turn);
      this.#announceTurn(turn);
    });

    // ★ 这一轮动过东西 ⇒ **落一条盘**。重启之后只有盘上这份能告诉对账：
    //   "这件事**不能**自己重来"（决策 D10.1）。
    //   ⚠️ 事件里**没有工具名、没有参数** —— 只一个归属，见 `#turnOwner`。
    this.#translator.on('mutated', ({ turn }) => {
      try {
        this.#timeline.emit({
          type: 'task/mutated',
          ref: this.#turnOwner.get(turn) ?? null,
          turn,
        });
      } catch (err) {
        // 落不下去不能让 agent 死；但**必须报出来**
        this.#lastError = `动过东西这件事没记下来：${err?.message ?? err}`;
      }
    });
    this.#translator.on('turn-end', ({ turn }) => this.#clearDeadline(turn));
  }

  get translator() {
    return this.#translator;
  }

  get lastError() {
    return this.#lastError;
  }

  /** 上一次喂回去的那段背景（诊断用；`null` = 还没喂过）。 */
  get lastRecap() {
    return this.#lastRecap;
  }

  /** 现在还没变成轮的那些话（诊断 / 验收用）。 */
  get pendingDeliveries() {
    return this.#delivered.length;
  }

  /** 现在挂着几个超时计时器（诊断用）。 */
  get armedDeadlines() {
    return this.#deadlines.size;
  }

  /**
   * 造**这一轮要喂的背景**。
   *
   * ⚠️ 读的是**日志**，不是内存（不变量 N6：事件流才是权威）。
   *    内存里那份会在重启时归零，而那正是需要它的时刻。
   *
   * ⚠️ 这里用**全量读**，不做"只读尾部多少字节"的优化。理由是刻意的：
   *    按字节开窗口**会静默地把记忆截短**——而那种故障看起来只是
   *    "它有点笨"，没人会去查。宁可慢一点、可测量。
   *    代价实测：起 agent 本来就要 ~1.1 秒（`initialize`），
   *    解析几万行 JSON 是几十毫秒。**等日志真的长到有影响时，
   *    它必须和写路径一起改**（`store.js` 文件头记着：改 append 为异步
   *    就必须同时改取号方式，不能只改一半）。
   */
  #recapText(excludeMessageId) {
    const events = this.#store.readAll(this.#timeline.id);
    const built = buildRecap(events, { ...this.#recapOptions, excludeMessageId });
    this.#lastRecap = built.text === '' ? null : built.text;
    return built.text;
  }

  // ── 过程可见性（S2：状态**按轮**寻址）──────────────────────────

  /**
   * 告诉界面"这一轮开始了"——屏幕上那行「它正在做…」就挂在这上面。
   *
   * ⚠️⚠️ **寻址用的是「轮」（`turn`），不是「气泡」（`messageId`）。**
   *    这是**实测决定的**，不是审美：
   *
   *      DSH 的 `session.status`（`running` / `idle`）**都落在消息生命周期之外**——
   *      实测（`/tmp/probe-tools.log`、`/tmp/probe-queue.log`）：
   *
   *        session.status running   ← 比 turn/start **早约 1ms**
   *        turn/start  turn=1
   *        …assistant/message…
   *        turn/end    turn=1
   *        session.status idle      ← 比 turn/end **晚**
   *
   *      ⇒ 收到 `running` 时**还没有轮**，收到 `idle` 时**轮已经收了**：
   *        "按 `messageId` 找那条气泡"这个形状**根本填不出值**。
   *
   *    旧实现的 `messageId: ''` 就是这么来的（`07-APPENDIX.md` §1.5）——
   *    它不是"忘了填"，是**那个字段没有可能的值**。
   *    而后果被记成了"界面没做状态"，害得人往错的方向查。
   *
   * ⚠️ 它是**瞬态**（决策 P-g：UI 状态不上时间线、不落盘）。
   *    代价要说清：断线重连时它不会被补发 ⇒ **重连后那一小段可能没有这行提示**。
   *    那正是 P-g 的取舍（UI 状态不该被持久化），不是 bug。
   */
  #announceTurn(turn) {
    if (typeof turn !== 'number') return;
    this.#timeline.emitTransient({
      type: 'message/status',
      turn,
      // 内部状态名。**它不是给用户看的**——界面那一层有一张人话表
      // （`apps/mobile/lib/models/process_words.dart`），认不出来的就**不说**。
      state: 'started',
    });
  }

  // ── 超时硬收口（N19 挂起必有收尾 + N10 收气泡 ≠ 停 agent）────────

  #armDeadline(turn) {
    if (!(this.#turnDeadlineMs > 0)) return;
    this.#clearDeadline(turn);
    const timer = setTimeout(() => {
      this.#deadlines.delete(turn);
      this.#onTurnDeadline(turn);
    }, this.#turnDeadlineMs);
    // ⚠️ **不许让这个计时器把进程钉住。** 忘了 `unref` 的话：
    //    `npm test` 跑完不退出，SIGTERM 收工也要多等半分钟。
    timer.unref?.();
    this.#deadlines.set(turn, timer);
  }

  #clearDeadline(turn) {
    const t = this.#deadlines.get(turn);
    if (t) {
      clearTimeout(t);
      this.#deadlines.delete(turn);
    }
  }

  #clearAllDeadlines() {
    for (const t of this.#deadlines.values()) clearTimeout(t);
    this.#deadlines.clear();
  }

  /**
   * 一轮到点了还挂着 ⇒ 收口 + **回收**。
   *
   * 顺序是死的：
   *   ① **收气泡**（N19）——包括"一句都没说"那种，**必须有交代**；
   *   ② **把排队的那些也收掉**——它们再也没有下一轮了（见 `#delivered`）；
   *   ③ **停 agent**（N10）——只收气泡不算数。
   *
   * ⚠️ ③ 只做一半的话有个很阴的后果：卡住的进程 `running` 一直是真的，
   *    而 LRU 的规矩是"**跑着的不许卸**"⇒ **它永远不会被淘汰**，
   *    永久占着 4 个位置里的一个。**收气泡 ≠ 停 agent** 这句话就是为它写的。
   */
  /**
   * 把"投出去了、还没变成一轮"的那些话**逐条**收掉。
   *
   * 它们不会再有下一轮了（投递它的那个进程要么被踢、要么已经死了），
   * 不收的话用户看到的是**一个永远等不到回答的气泡**——N19 就是禁这个。
   */
  #closeUndelivered(reason) {
    const n = this.#delivered.length;
    this.#delivered.length = 0;
    for (let i = 0; i < n; i += 1) {
      try {
        this.#translator.turnUndelivered({ reason });
      } catch (err) {
        this.#lastError = `排队那句没收住：${err?.message ?? err}`;
      }
    }
  }

  #onTurnDeadline(turn) {
    let closed;
    try {
      closed = this.#translator.turnDeadline(turn);
    } catch (err) {
      this.#lastError = `超时收口失败：${err?.message ?? err}`;
      return;
    }
    // 那一轮早就收口了（只是慢）——不是超时，别乱动
    if (!closed) return;

    this.#lastError = `第 ${turn} 轮超过 ${this.#turnDeadlineMs}ms 没收口`;
    console.error(`[dispatcher] ${this.#lastError} —— 收口并卸下 agent`);

    // ② 排队里那些话：agent 一走，它们就再也没有下一轮了
    this.#closeUndelivered('timeout');

    // ③ 回收资源。下一个实例要重新喂背景（它同样什么都不记得）
    this.#recapFedTo = null;
    this.#runtime.stop(this.#timeline.id, { reason: 'turn-deadline' }).catch((err) => {
      this.#lastError = `卸 agent 失败：${err?.message ?? err}`;
    });
  }

  /** 取 agent，并在**换了实例**时把它的三类事件接到翻译层上。 */
  /**
   * 取 agent，并在**换了实例**时把它的三类事件接到翻译层上。
   *
   * ⚠️ **每次都问 runtime，自己不留缓存。**
   *    早先是"第一次取到就攥住不放"，于是有一条很阴的路：
   *    实例被 `dispose()` 之后，如果没人回调 `onEvict`，
   *    这里手里那个**已经死掉的**对象会一直被当成"还是它"——
   *    连"背景喂过没有"都会判错（新进程其实什么都不记得）。
   *    runtime 的表才是权威：它删了，这里下一次就拿到**新的**。
   *
   * ⚠️ 但**监听只能挂一次**——同一个实例重复挂就会重复翻译，
   *    用户看到两条一样的回答。所以按**实例身份**比一下再挂。
   */
  #ensureAgent() {
    const id = this.#timeline.id;
    const agent = this.#runtime.agent(id);
    if (agent === this.#wiredAgent) return agent;
    this.#wiredAgent = agent;

    // ★ **换了进程 ⇒ 轮账清空。** 轮号在每个进程里都从 1 重新开始；
    //   不清的话，新进程的第 1 轮会接到上一个进程的陈账上（见 `TurnTranslator.reset()`）。
    this.#translator.reset();
    this.#clearAllDeadlines();

    agent.on('session-event', (params) => {
      try {
        this.#translator.handle(params);
      } catch (err) {
        // 翻译层抛错不该把 agent 打死；但**必须报出来**（不许静默吞）
        this.#lastError = `翻译出错：${err?.message ?? err}`;
      }
    });

    // ⚠️ **`session.status` 不再翻译成 `message/status`。**
    //    见 `#announceTurn()` 那段实测：`running` / `idle` **都落在消息生命周期之外**，
    //    所以"按 messageId 找气泡"填不出值——旧代码在这里发 `messageId: ''`，
    //    结果是**状态永远挂不上**（`07-APPENDIX.md` §1.5）。
    //    它的信息量（这一轮在不在跑）已经被**轮的起讫**完整覆盖，
    //    所以这里不是"少了一个功能"，是**换了一个正确的地址**。

    agent.on('exit', (info) => {
      // 那个实例没了 ⇒ 下一个实例要重新喂背景。
      // ⚠️ `#wiredAgent` **不动**：它是"挂过监听的那个"，不是"活着的那个"。
      //    动了它，同一个实例就会被**挂两遍**监听，用户看到两条一样的回答。
      this.#recapFedTo = null;
      // ★ **进程死了必须收口**——不能让用户等一个不会再来的回答。
      //   ⚠️ `line` 是"这一轮一个字都还没说"时说的那句：**它落盘**，
      //      所以用户**看得见**。（`emitTransient` 那条 `error` 客户端今天不渲染，
      //      它留着是给盘满那种"落不了盘"的场合兜底的。）
      this.#translator.forceClose('failed', { line: AGENT_LOST_LINE });
      this.#clearAllDeadlines();
      // 排队里那些话也跟着这个进程一起没了 —— 逐条收口（和超时那条路同一个道理）
      this.#closeUndelivered('failed');
      this.#lastError = info?.reason ?? 'agent 退出了';
      this.#timeline.emitTransient({ type: 'error', kind: 'agent-exit', text: AGENT_LOST_LINE });
    });

    return agent;
  }

  /**
   * 用户说了一句话，把它交给 agent。
   *
   * ★ **跨重启接记忆就在这儿**：agent 是**每次重启新起的**（SDK 只能 create，
   *   不能 resume），所以**对每一个 agent 实例，第一次投递时**把时间线尾部
   *   那一段按来源分节喂回去。此后不再喂——这个进程自己记得。
   *
   * ⚠️ **背景是单独一个内容块**，不和主人的话拼成一个字符串。
   *    拼在一起的话，模型分不清"哪句是背景、哪句是现在这句"——
   *    而分得清正是分节的全部意义。
   *
   * @param {string} text
   * @param {object} [o]
   * @param {string} [o.messageId]
   *        这句话在日志里的 id。**必须给**——`/api/say` 是先落盘再投递的，
   *        所以此刻它已经在日志里了；不排掉它会**出现两遍**。
   * @returns {Promise<{delivered: boolean, messageId?: string, error?: string, recapped?: boolean}>}
   */
  async deliver(text, { messageId = null } = {}) {
    const agent = this.#ensureAgent();

    // 只对"还没喂过的那个实例"喂一次。按**实例**记，不按"启动过没有"记——
    // 进程死掉 / 被淘汰之后 `#ensureAgent()` 会给出**新的**实例，
    // 那时它同样什么都不记得，同样需要背景。
    const needsRecap = this.#recapFedTo !== agent;
    let blocks = [{ type: 'text', text }];
    if (needsRecap) {
      try {
        const recap = this.#recapText(messageId);
        if (recap !== '') blocks = [{ type: 'text', text: recap }, ...blocks];
      } catch (err) {
        // 读日志失败**不该拦着人说话**——但必须说出来（不许静默）
        this.#lastError = `背景没读出来：${err?.message ?? err}`;
        this.#recapFedTo = null;
      }
    }

    // ★ **先记账再投**。两个原因，都是实测出来的：
    //   ① 并发的两次投递不许各喂一遍背景；
    //   ② 帧序上 `turn/start` **可能早于 `prompt()` 返回**
    //      （实测：`turn/start` 在 +1116ms，`prompt` 的结果在 +1122ms）。
    //      等返回了才记账的话，那一刻 `turn-start` 已经来过了，
    //      这一条会被"消费"掉、而队列里少了一条 ⇒ 超时时漏收一句。
    const ticket = { messageId, at: Date.now() };
    this.#delivered.push(ticket);
    if (needsRecap) this.#recapFedTo = agent;

    try {
      const r = await agent.prompt(blocks);
      this.#lastError = null;
      return { delivered: true, messageId: r?.messageId, recapped: needsRecap };
    } catch (err) {
      // 没进去的就从队列里摘掉（摘不掉也只是多收一条，不会漏收）
      const i = this.#delivered.indexOf(ticket);
      if (i !== -1) this.#delivered.splice(i, 1);
      if (needsRecap) this.#recapFedTo = null; // 没喂成 ⇒ 下次补
      this.#lastError = String(err?.message ?? err);
      // 起不来的时候**也要有个交代**——静默失败等于"它不理我"
      try {
        this.#translator.forceClose('failed', { line: AGENT_UNAVAILABLE_LINE });
      } catch {
        /* 没有未收口的，正常 */
      }
      this.#timeline.emitTransient({
        type: 'error',
        kind: 'agent-unavailable',
        text: AGENT_UNAVAILABLE_LINE,
      });
      return { delivered: false, error: this.#lastError };
    }
  }

  /**
   * 淘汰回调（手册 §5.5「谁回调谁」）。
   *
   * runtime **没有翻译层**，它不知道哪条消息还没收口 ⇒ 只能回调这里。
   * 顺序是死的：**先收口，再让它卸**。反了的话用户永远等不到收尾。
   */
  async onEvict(sessionId) {
    if (sessionId !== this.#timeline.id) return;
    this.#translator.forceClose('failed');
    this.#closeUndelivered('failed');
    this.#clearAllDeadlines(); // 这一轮已经收口了，计时器不该再响
    this.#recapFedTo = null;
  }

  /** 收工：先把话说圆，再放 agent 走。 */
  async shutdown() {
    this.#translator.forceClose('failed');
    this.#clearAllDeadlines();
    this.#recapFedTo = null;
  }
}
