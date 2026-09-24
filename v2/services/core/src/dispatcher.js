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
import { TurnTranslator, isAuthFailure } from './session-translate.js';

/**
 * 这几句是**用户能看到的**（落盘、上时间线）。所以它们必须是人话，
 * 而且要**说清怎么办**（N11）。
 *
 * ⚠️ 它们以前是**瞬态** `error`（客户端**今天不渲染** ⇒ 用户什么都看不到）。
 *    现在改成落盘的消息：**看得见才算数**。
 *    瞬态那条留着，是给"盘满了、落不下盘"的场合兜底的。
 */
const AGENT_LOST_LINE = '刚才我断了，这条没做完。再说一次吧。';

// ★ **"被挤掉的"那一句从 `notice.js` 来**（账 #33 · 一处出处，别抄第二份字）。
//   ⚠️ 它只在**有证据**时才用：`exit` 那一帧里 `oom === true`（内核 cgroup 计数真涨过）。
//      拿 `SIGKILL` 当 OOM 是猜 —— 而"猜"在这个项目里等于说假话（N10）。
import { FAILED_LINES as _FAILED_LINES } from './notice.js';
const AGENT_UNAVAILABLE_LINE = '我现在接不上活。你这句话我记下了，等我缓过来再说。';

/**
 * 单轮硬收口（手册 `08-SPEC.md` §10.2 给的阈值就是它）。
 *
 * 为什么需要：agent 卡住就是**永远卡住**——用户等一条不会来的回答。
 * 手册事故一里那行"还有件事在处理"挂了 **68 分钟**。
 */
export const TURN_DEADLINE_MS = 180_000;

/**
 * **一条会话**（一个 scope/房间）的调度状态。
 *
 * ⚠️ 它是**私有的**：外面拿到的是 `Dispatcher`（每个用户一个，内部持有多条会话）。
 *    分成两层是 E 期（契约 84 §七）那一条的落点：
 *
 *      改前：`roomFor()` 每间 `new Dispatcher(...)` ⇒ **每间一个调度器**
 *      改后：`worlds.js` 一个用户建**一个** `Dispatcher`，
 *            每间用 `dispatcher.addSession({scope, timeline, agentKey})` 挂上去
 *
 *    为什么这不是"换个名字"：轮的起讫、超时计时器、排队那本账、`turnInput`
 *    （P1-22 那条"他明说才许写"的闸）**都是按会话各算一份**的 ——
 *    共用一个会互相顶掉（甲房间的一轮会把乙房间的计时器顶掉）。
 *    ⇒ 收的是"**谁持有**"，每一间的账**照样各记一份**。
 */
class Session {
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
  /** 见构造参数 `onAuthFailure`。 */
  #onAuthFailure = null;
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
   * **这一轮他说了什么**（P1-22，2026-09-24）。
   *
   * 🔴 为什么要有它：小程序那条"**他明说才许写**"的闸原来是**软的** ——
   *    工具那边只看得到"调用了哪个工具"，**看不到"这一轮他说了什么"**
   *    ⇒ 助手越权的唯一挡板是它**自己的自觉**（`59-USER-APPS.md` §八 第 1 条）。
   *    这里把**当轮输入**记下来并暴露出去；**"什么算明说"是产品规则**，
   *    由上层定（见 `77-BLOCKERS.md` B8 —— 那一条要主人拍）。
   *
   * ⚠️ 它只活**一轮**：`turn-start` 时从那一轮的票上认领（**不是"最后投递的那句"** ——
   *    他可能在一轮半路又补一句，那不该算到正在跑的轮上），
   *    `turn-end` / 超时 / 失败三处都清（下一句投递**不会**直接覆盖它）。
   */
  #turnInput = '';

  /// 见 [#turnInput]。
  get turnInput() {
    return this.#turnInput;
  }
  /**
   * turn 号 → **是主人哪句话引起来的**（我们这边的 `messageId`）。
   *
   * ⚠️ 为什么要它：产品事件里**没有轮号**（`message/start` 只带 messageId）。
   *    而"对账"要在重启之后回答"**那件活动过东西没有**"——
   *    它手里的东西是"未收口的气泡"和"没人答的那句话"，**都不是轮号**。
   *    ⇒ 落盘时就得把它翻译成**某条主人消息**，否则那条记录永远对不上。
   */
  #turnOwner = new Map();
  /**
   * 通知那本账（批 3 第三件 · 契约 `docs/dev/29-NOTICE.md` §二 §三②）。
   *
   * ⚠️ 为什么要把它接进调度器：`message/status`（就是"它正在做…"那行提示）
   *    是**过程通道**的发声处，而契约的判据是**同一件事只走一条通道**。
   *    闸要打**在真的东西上**（凡是我们自己算出来的东西，闸必须在产生它的这一侧）。
   *    见 `#announceTurn()`。
   */
  #notice;

  /**
   * ★ **A1·「发现就报」**（契约 `83-APP-WORKSPACE.md` §四 · 主人 2026-09-25）：
   *   造 app 的那一轮，主目录**多了文件** ⇒ 必须报出来（不许静默）。
   *
   * 🔴 为什么挂在**调度器**上：轮的起讫只有它知道，而"正常结束 / 失败 / 超时"
   *    是**三条不同的路**——只在"正常结束"那条路上比，等于漏掉最可能出事的两条。
   *    三处都在这儿收口（`turn-end` / `turn-deadline` / `force-close`）。
   *
   * ⚠️ 只有**主线那个调度器**拿到它（房间里的 cwd 就是它自己的工作区，
   *    相对路径写在那儿本来就是对的）。没拿到 ⇒ 这条判据整个不存在。
   * ⚠️ 逻辑住在 `main-leak.js`（纯函数 + 那个 watcher），这里只负责**在正确的时刻叫它**。
   */
  #mainLeak;

  /**
   * agent 那个**进程池的键**。
   *
   * ⚠️ 为什么它**不是** `scopeId`（2026-09-21，多租户接线时定的）：
   *   `scopeId` 是**写到事件里的字段**（`session-translate.js` 把它塞进 `message/start`），
   *   盘上已有的事件里是 `'main'` —— 动它 = **动历史字节**（协议字段一旦上线就冻结）。
   *   而这一条是**进程池的内部键**：只用来回答"这句话该进哪个 agent 的窗口"。
   *   两件事混用，就会为了修串号去改协议。⇒ 分开。
   *
   * 🔴 多租户下它**必须按人不同**（`u1/main`）：所有人共用 `'main'` 时，
   *   `runtime.get('main')` 对谁都是**同一个 agent** ⇒ **甲说的话进乙的窗口**
   *   （静默串号，两边日志都"正常"）。见 `docs/dev/38-ISOLATION-SPLIT.md` §三①。
   */
  #agentKey;

  /**
   * agent 那个进程池的键：**多租户下按人不同**。
   * ⚠️ 三个用处必须走这里（超时收口 / 投递 / `onEvict` 比对），
   *    少一处就会出现"某一头认的是 `main`、另一头认的是 `u1/main`"⇒ 收口失效。
   */
  get #agentSessionKey() {
    return this.#agentKey ?? this.#timeline.id;
  }

  constructor({
    timeline,
    runtime,
    /**
     * 🔴 **上游说"钥匙不对"时叫一声**（可选）。
     *
     * ⚠️ 为什么需要它：钥匙**填错了**的用户，得**能重新填** ——
     *    而客户端只有在"这台没有钥匙"时才进得去那一屏。
     *    ⇒ 宿主收到这一声就把那一把标成"用不了"，`hasKey` 随之变回 `false`。
     */
    onAuthFailure = null,
    scopeId = null,
    /** agent 进程池的键。默认退回 `timeline.id`（单租户时就是 `'main'`）。多租户**必须传**。 */
    agentKey = null,
    store,
    recap = {},
    turnDeadlineMs = TURN_DEADLINE_MS,
    notice = null,
    /** 见 [#mainLeak]（`MainLeakWatch`；只挂在主线那个调度器上）。 */
    mainLeak = null,
  }) {
    if (!store) {
      // ⚠️ **不许默认没有 recap 就悄悄开工。**
      //    没有 store ⇒ 每次重启的用户体验都是"它失忆了"，
      //    而那种故障**看起来只是"它有点笨"**，没人会去查配置。
      throw new Error('Dispatcher 需要 store（跨重启接记忆靠它读日志）');
    }
    this.#timeline = timeline;
    this.#runtime = runtime;
    this.#scopeId = scopeId;
    this.#agentKey = agentKey;
    this.#store = store;
    this.#recapOptions = { ...RECAP_DEFAULTS, ...recap };
    this.#turnDeadlineMs = turnDeadlineMs;
    this.#notice = notice;
    this.#mainLeak = mainLeak;
    this.#onAuthFailure = onAuthFailure;
    this.#translator = new TurnTranslator({ timeline, scopeId, notice });

    // 超时硬收口：轮的起讫从翻译层来（它才知道"这一轮开始了没有"）
    this.#translator.on('turn-start', (turn) => {
      // 一轮开始 = 消化掉一条投递。**顺手记住是哪句话引起来的**（见 `#turnOwner`）
      const owner = this.#delivered.shift();
      this.#turnOwner.set(turn, owner?.messageId ?? null);
      // ★ P1-22：**这一轮他说了什么** = 引起来的那句话（没有票 ⇒ 空 ⇒ 不许造东西）
      this.#turnInput = owner?.text ?? '';
      this.#armDeadline(turn);
      this.#announceTurn(turn);
      // ★ A1·「发现就报」：这一轮开始 ⇒ 记一份主目录的清单（**只记路径**）
      this.#mainLeak?.start();
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
    this.#translator.on('turn-end', ({ turn, kind }) => {
      this.#clearDeadline(turn);
      // ★ P1-22：**这一轮结束了 ⇒ 当轮输入立刻作废。**
      //   ⚠️ 这条不是"顺手清理"：一轮结束到下一句之间，**助手自己发起的那一轮**
      //      （定时 / 重做 / 别人代投）用的是**同一个派发器**。
      //      不清的话它看到的是**上一句他说过的话** ⇒ 造东西那条闸会拿旧话当"他明说了"。
      this.#turnInput = '';
      // ★ A1·「发现就报」：**正常结束**这条路也要比（三条路缺一不可）
      this.#mainLeak?.finish({ turn, reason: kind });
    });

    // ★ A1·「发现就报」：**失败 / 超时**那两条路同样要比 ——
    //   只在"正常结束"那条路上比，等于漏掉最可能出事的两条。
    //   ⚠️ `force-close` 不带轮号（它一次收掉**所有**开着的轮，见 `forceClose`），
    //      所以这里 `turn` 给 `null`；判据要的是"这一轮前后比过"。
    this.#translator.on('turn-deadline', ({ turn }) => {
      this.#mainLeak?.finish({ turn, reason: 'timeout' });
    });
    this.#translator.on('force-close', ({ reason }) => {
      this.#mainLeak?.finish({ turn: null, reason: reason ?? 'failed' });
    });
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

  /** 这一间叫什么（事件上的标签）。 */
  get scopeId() {
    return this.#scopeId;
  }

  /** agent 进程池里这一间的键（`u1/main`、`u1/alpha`…）。 */
  get agentKey() {
    return this.#agentSessionKey;
  }

  /** **这一间**未收口的气泡（别的房间正说着不影响它）。 */
  get openMessageId() {
    return this.#timeline.openMessageId ?? null;
  }

  /**
   * ★ **这一轮里造了一个 app**（A1·「发现就报」）。
   *
   * ⚠️ 叫它的是**造东西那条路**（`apps-socket.js` 的 `create` / `install`
   *    成功之后，`worlds.js` 把回调接过来）——**不是**模型自己报的：
   *    模型说"我造了"不作数，工具真写下去了才作数。
   * ⚠️ 没接 `mainLeak` / 现在不在某一轮里 ⇒ **什么都不做**（老行为不变）。
   */
  noteAppBuilt(info) {
    return this.#mainLeak?.noteBuilt(info) ?? false;
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
    // ★ **读这一间自己的**（一条日志里的这一段）：`ScopeView.readAll()` 按
    //   `scopeId` 标签挑出来。少了这一步，乙房间的 agent 会把甲房间的话
    //   当自己的背景读进去（一条日志之后新冒出来的病，契约 84 §三·2）。
    const events = this.#timeline.readAll();
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
    // ★ **先对账再开口**（契约 §三②）：同一个 `(turn, kind)` 不许两条通道都说。
    //   ⚠️ 这一句**故意**让冲突抛出去：撞上就意味着"这件事"已经在通知通道上说过了
    //      ⇒ 宁可**不发**这行状态，也不许两条通道各说一遍（R1.2 的通知疲劳）。
    //      抛出去会被上面 `session-event` 那圈 try 接住（记进 `#lastError`），
    //      不会把 agent 打死。
    this.#notice?.processSaid({ turn, kind: 'started' });
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
    // ★ P1-22：这条路是"这一轮不会再有下文了"（超时 / 失败）⇒ 当轮输入同样作废
    this.#turnInput = '';
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
    this.#runtime.stop(this.#agentSessionKey, { reason: 'turn-deadline' }).catch((err) => {
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
    const id = this.#agentSessionKey;
    const agent = this.#runtime.agent(id);
    if (agent === this.#wiredAgent) return agent;
    this.#wiredAgent = agent;

    // ★ **换了进程 ⇒ 轮账清空。** 轮号在每个进程里都从 1 重新开始；
    //   不清的话，新进程的第 1 轮会接到上一个进程的陈账上（见 `TurnTranslator.reset()`）。
    this.#translator.reset();
    this.#clearAllDeadlines();

    agent.on('session-event', (params) => {
      try {
        // ★ **上游说"钥匙不对"**（`44-CONTAINER-MODEL-KEY.md` §六）：
        //   这件事**只有这一层看得见**（`turn/end.reason.error.code === 'AUTH'`），
        //   而"把那一把标成用不了、让用户能重新填"要宿主去做 ⇒ 回调一次。
        //   ⚠️ 回调**不许**把这一轮带走（它只是记账），所以吞掉它的异常。
        if (isAuthFailure(params?.event?.data)) {
          try {
            this.#onAuthFailure?.();
          } catch {
            /* 回调失败不影响收口 */
          }
        }
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
      this.#translator.forceClose('failed', {
        // ⚠️ 有证据才换说法：`info.oom === true` 是"内核说这个 cgroup 真的 OOM 过"。
        //    没证据 ⇒ 还是原来那句（"刚才我断了"）—— 宁可含糊，不许猜。
        line: info?.oom === true ? _FAILED_LINES.oom : AGENT_LOST_LINE,
      });
      this.#clearAllDeadlines();
      // 排队里那些话也跟着这个进程一起没了 —— 逐条收口（和超时那条路同一个道理）
      this.#closeUndelivered('failed');
      this.#lastError = info?.reason ?? 'agent 退出了';
      // 🔴 **要有人看得见**（2026-09-21 修）：`#lastError` 原来只是**存着**，
      //    没有任何地方打印 ⇒ 盒子里"agent 死了"这件事在日志上**完全静默**，
      //    而用户那一侧只看到一句"这条我没说完就断了"。
      //    ⇒ 排查的人（今天的我）在容器日志里**一行线索都没有**。
      console.error(`[dispatcher] agent 退了：${this.#lastError}`);
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
    // ★ P1-22：**这句话跟着这一轮的票走**（而不是"最后投递的那句"）。
    //   为什么要这样：他可能在一轮**还没说完**时又补一句（投递排队、`target=next-turn`）。
    //   读"最后投递的那句"的话，**正在跑的这一轮**会拿**新那句话**去判"他有没有明说" ——
    //   于是"帮我做一个小程序" + "快点" 会被判成"没说"（误拒）。
    //   ⚠️ 只挂在票上、**不在这里写 `#turnInput`**：真正认领的是 `turn-start`
    //     （那时才知道"这一轮是哪句话引起来的"）。
    const ticket = { messageId, at: Date.now(), text: typeof text === 'string' ? text : '' };
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
    if (sessionId !== this.#agentSessionKey) return;
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

/**
 * **一个用户的调度器**（E 期 · 契约 84 §三·1 / 判据 F5）。
 *
 * 手册 `02-ARCHITECTURE.md` §四原文是「调度器（永续，**同时持有 A、B、C… 每条会话**）」。
 * 改前是 `roomFor()` 每间 `new Dispatcher(...)` —— **每间一个调度器**，
 * 那是 `83-APP-WORKSPACE.md` 走偏的三处之一。
 *
 * ⇒ 现在：**每个用户一个 `Dispatcher`**，内部 `#sessions` 持有 N 条 `Session`。
 *   外面的老接口（`deliver` / `shutdown` / `translator` / `pendingDeliveries`…）
 *   **一律指向主线那条会话** —— 单房间的老调用方与老测试一个字都不用改。
 *
 * ⚠️ 每条会话的账**各算一份**（轮、计时器、排队、`turnInput`）——
 *    见 `Session` 顶上那段：共用一个会互相顶掉。
 * ⚠️ 宿主那层**只转发字节**（`37-MULTITENANT.md`）：这里没有"当前用户"全局，
 *    身份与 scope 只能靠参数传进来。
 */
export class Dispatcher {
  /** `scopeId` → `Session`。**主线那条一定在**（构造时就建好）。 */
  #sessions = new Map();
  #mainScope;
  #runtime;
  #store;
  /** 新挂上来的会话共用这三样（与主线那条一致）。 */
  #recapOptions;
  #turnDeadlineMs;
  #onAuthFailure;
  #notice;
  #mainLeak;

  /**
   * @param {object} o
   *        与 `Session` 同一组参数（`timeline` 是**主线那一间**的视图）。
   *        另加 `runtime` / `store`（新挂上来的会话要共用它们）。
   */
  constructor(args) {
    this.#runtime = args.runtime;
    this.#store = args.store;
    this.#mainScope = args.scopeId ?? null;
    this.#recapOptions = args.recap ?? {};
    this.#turnDeadlineMs = args.turnDeadlineMs ?? TURN_DEADLINE_MS;
    this.#onAuthFailure = args.onAuthFailure ?? null;
    // ⚠️ 通知那本账 / 「发现就报」**只挂主线那一间**（与改前逐字一致）：
    //    通知的互斥是"一个人一份"的账，一间一个会让同一件事在几处各记一次。
    this.#notice = args.notice ?? null;
    this.#mainLeak = args.mainLeak ?? null;
    const main = new Session(args);
    this.#sessions.set(main.scopeId, main);
  }

  /** 这个用户手上有几条会话（主线 ＋ 每个房间）。 */
  get sessionCount() {
    return this.#sessions.size;
  }

  /** 已挂上来的那些 scope（诊断 / 判据用）。 */
  scopes() {
    return [...this.#sessions.keys()];
  }

  /** 主线那条会话（老接口都指向它）。 */
  get #main() {
    return this.#sessions.get(this.#mainScope);
  }

  /** 按 scope 取会话；**认不出 ⇒ `null`**（不许悄悄退回主线）。 */
  sessionFor(scope) {
    const s = scope === null || scope === undefined || scope === '' ? this.#mainScope : String(scope);
    return this.#sessions.get(s) ?? null;
  }

  /**
   * **把一条会话挂上来**（`worlds.roomFor()` 调它 —— 这是"收回每间一个调度器"
   * 之后，房间拿到调度能力的唯一入口）。
   *
   * ⚠️ 同一个 scope 重复挂 ⇒ **原样返回已有的那条**（幂等：
   *    `roomFor` 每次都用同一把视图，重复挂不该把轮账清掉）。
   * @returns {Session}
   */
  addSession({ scope, timeline, agentKey, notice = null, mainLeak = null, onAuthFailure = null }) {
    const id = scope === null || scope === undefined || scope === '' ? this.#mainScope : String(scope);
    const had = this.#sessions.get(id);
    if (had) return had;
    const s = new Session({
      timeline,
      runtime: this.#runtime,
      store: this.#store,
      scopeId: id,
      agentKey,
      // ⚠️ 房间**不接**通知那本账 / 「发现就报」：那两样只挂主线（与改前一致）
      notice: id === this.#mainScope ? (notice ?? this.#notice) : null,
      mainLeak: id === this.#mainScope ? (mainLeak ?? this.#mainLeak) : null,
      onAuthFailure: onAuthFailure ?? this.#onAuthFailure,
      // ⚠️ recap / 超时**跟着这个世界**走（`Worlds` 建调度器时已经算好了）。
      recap: this.#recapOptions,
      turnDeadlineMs: this.#turnDeadlineMs,
    });
    this.#sessions.set(id, s);
    return s;
  }

  get translator() {
    return this.#main.translator;
  }

  get lastError() {
    return this.#main.lastError;
  }

  get lastRecap() {
    return this.#main.lastRecap;
  }

  get pendingDeliveries() {
    return this.#main.pendingDeliveries;
  }

  get armedDeadlines() {
    return this.#main.armedDeadlines;
  }

  get turnInput() {
    return this.#main.turnInput;
  }

  /** 主线那间未收口的气泡（老接口）。 */
  get openMessageId() {
    return this.#main.openMessageId;
  }

  /** 主线那条会话（判据要看"每条会话各有各的账"时用）。 */
  get mainSession() {
    return this.#main;
  }

  noteAppBuilt(info) {
    return this.#main.noteAppBuilt(info);
  }

  /**
   * 用户说了一句话 —— 交给**它那个 scope**的会话。
   *
   * ★ 新增可选参数 `scope`（契约 84 §四：协议**只加不改**）：
   *   不给 ⇒ 主线（老调用方一字不改）。
   */
  async deliver(text, { messageId = null, scope = null } = {}) {
    const s = this.sessionFor(scope);
    if (!s) {
      // ⚠️ **不许悄悄落到主线**：那会让"某一间的话"出现在主线上（而且看不出来）。
      //    调用方（server.js）会把这句话翻成 404/人话，这里只如实回。
      return { delivered: false, error: `没有这个 scope 的会话：${String(scope)}` };
    }
    return s.deliver(text, { messageId });
  }

  /**
   * 淘汰回调：按 **agentKey** 找到它属于哪一间，让那一间收口。
   * ⚠️ 少了它，超时/淘汰时的"先收口再卸"会落到主线那一间上。
   */
  async onEvict(sessionId) {
    for (const s of this.#sessions.values()) {
      if (s.agentKey === sessionId) {
        await s.onEvict(sessionId);
        return;
      }
    }
  }

  /** 聚合"手上还有没有没说完的话"（`worlds.busySnapshot()` 用）。 */
  busy() {
    let pending = 0;
    let turns = 0;
    let openMessageId = null;
    for (const s of this.#sessions.values()) {
      pending += s.pendingDeliveries;
      turns += s.armedDeadlines;
      openMessageId ??= s.openMessageId;
    }
    return { openMessageId, pending, turns };
  }

  /** 收工：**每一条会话**都要把话说圆（漏一条 = 那条被切断）。 */
  async shutdown() {
    for (const s of this.#sessions.values()) {
      try {
        await s.shutdown();
      } catch {
        /* 一条收不干净不许影响别的 */
      }
    }
  }
}
