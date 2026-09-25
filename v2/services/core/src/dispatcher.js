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
import { newMessageId } from './message-writer.js';
// ★ **D 期（契约 `docs/dev/100-DISPATCHER-D.md`）**：转交（N16）、焦点告知（D-9）、
//   未读那半（D-6）。裁决本体与那本落盘的账在 `handoff.js`，这里只做**调度**。
import { HandoffBook, HandoffError, decideHandoff } from './handoff.js';
import { resolveFocus } from './focus-book.js';
// ★ **派活**（契约 `docs/dev/102-APP-BIRTH-SCOPE.md` · 主人 2026-09-25 拍「乙」）：
//   与**转交**（交给**已有**的一间 · N16）分开的**另一条路** —— 派活是**新建**一间，
//   把它做完的**总结**扔回主进程，主进程侧只留一份**简登记**（索引，不是日志副本）。
//   ⚠️ `handoff.js` 那套一个字都没动。
import { JOB_ASK_TIMEOUT_MS, JOB_LINES, JOB_NUDGE_LINE, JOB_NUDGE_MAX, JOB_REPORT, JOB_START, appOpenEvent, decideJobStart, jobAskEvent, jobAskExpiredEvent, jobPacketText, jobSummaryText, scopeOpenEvent } from './job.js';
// ★ P1 时间分级（契约 `docs/dev/88-P1-TIME-WAIT.md`）：
//   **逐件落盘**的活账（T2）、后台四句（T4）、承诺行与再报（T5）。
import { WORK_STATES, isOpen, pairKey } from './worklog.js';
// ⚠️ 这四句是**我们自己说的话** ⇒ 一律走 `message/*`（不新造通道、不动冻结的 notice kind），
//    并且出门之前过**时间词闸**（`assertBackedText`）。
import {
  WORK_FAILED_LINE,
  WORK_STARTED_LINE,
  WORK_LATE_LINE,
  workAnswerLine,
  workDoneLine,
  workResultLine,
  workWhereWords,
} from './work-words.js';
import { assertBackedText, hasTimeClaim } from './time-words.js';

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
 * ★ P1：**多久还没做完 ⇒ 当成"长活"**（契约 `88` §三：长活默认进后台，但**必须告诉用户**）。
 *
 * ⚠️ 为什么是"等一段"而不是"投递那一刻按他怎么说猜"：
 *   投递那一刻**没有任何可靠信号**说这活要多久（`86` §四.4：难度/t0 不可观测）。
 *   拿他一句"帮我做…"就当长活预告，实测会**给一件两秒就完的活加噪音**，
 *   而且会撞坏既有的"这一轮说完了没有"判据（预告也是一条消息）。
 *   ⇒ 用**可观察的信号**：**它到现在还没做完**。到点还在跑 ⇒ 说一句"我去做，做完叫你"。
 *   这既满足"宁可提前说"（一知道是长活就说），也不会冤枉短活。
 *
 * ⚠️ **阈值住代码，不写文档**（手册纪律 1）。`88` §五.4 明说：文档只说"分级存在"。
 */
export const BACKGROUND_AFTER_MS = 6000;

/**
 * ★ **D 期：交接包里最多带主人几句话**（上下文摘要 · 契约 `100` §7 第 4 条）。
 *
 * ⚠️ **阈值住代码，不写文档**（手册纪律 1）。文档只说"要带摘要"。
 */
export const HANDOFF_BRIEF_SAYS = 6;


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
  /** ★ 用量账（见构造参数 `onUsage`）。不接 ⇒ 老行为。 */
  #onUsage = null;
  /** ★ P2-8 出网留痕（见构造参数 `onEgress`）。不接 ⇒ 老行为。 */
  #onEgress = null;
  /** turn → 计时器。一轮一个，所以"后一轮开始把前一轮的计时器顶掉"不会丢东西。 */
  #deadlines = new Map();

  /**
   * ★ **D 期：这一间发出的转交**（`handoff.js` 那本账的引用 · 一个人一本）。
   * `null` = 没接（离线测试 / 老调用方）⇒ 转交那条工具口**如实回"没接上"**。
   */
  #handoffs = null;

  /**
   * ★ **D 期：转交的投递排着**（一笔一笔来）。
   * ⚠️ 不排队的话，"目标那间同时被两处投递"会让翻译层那个 FIFO 与
   *    `turn/start` 的顺序**对不上**（两个 await 交错了 ⇒ 另一半写进别人的气泡）。
   */
  #handoffChain = Promise.resolve();

  /**
   * ★ **D 期：最近一次接下的那份交接包原文**（诊断 / 判据用）。
   * ⚠️ 它是**服务端拼的**那一段（不是主人说的那句）—— 所以"带了什么"看它。
   */
  #lastHandoffPacket = null;

  /** ★ **D 期**：见 `#lastHandoffPacket`。 */
  get lastHandoffPacket() {
    return this.#lastHandoffPacket;
  }

  /**
   * ★ **派活**（契约 102）：这一间上次收到的那份**任务书**原文
   * （"他让我做 X"＋他说的那句原话）。
   *
   * ⚠️ 它是**诊断/判据**用的（P1：任务与由来真交到它手上了）——
   *    它**不进**时间线：那一间的对话里，主人看不到"我们给他下了什么命令"这种内部话。
   */
  #lastJobPacket = null;

  /** ★ **派活**：见 `#lastJobPacket`。 */
  get lastJobPacket() {
    return this.#lastJobPacket;
  }

  /** ★ **派活**：这一份任务书是哪一处的（B39 收口时要用它找登记里那一行）。 */
  #lastJobWhere = null;

  /**
   * ★ **派活**：哪几轮是**派来的活**（收口时那条总结由 `job/report` 那条路发，
   * 别在两条通道上各说一遍 —— R1.2 的通知疲劳）。
   *
   * ⚠️ **`turn` → 那一处的短名**（契约 108 起从 `Set` 改成 `Map`）：
   *    B39 的兜底要在收口时知道"是哪一件活停了"（登记里那一行 ＋ 这一件接了几次）。
   */
  #jobTurns = new Map();

  /** ★ **派活**：这一间刚把总结交回去了（`Dispatcher.finishJob` 记的）。 */
  #jobReported = false;

  /** ★ **B39：这件活我替它接过几次**（`where` → 次数）。**有上限**（`JOB_NUDGE_MAX`）。 */
  #jobNudges = new Map();

  /** ★ **D 期：怎么算"这一间存在"**（构造参数 `scopeExists`；缺省一律 false）。 */
  #scopeExists = () => false;
  /**
   * **投出去了、还没变成一轮**的那些话。
   *
   * 为什么要记：实测一轮没结束时再发一句，DSH 会**排队**
   * （`agent/inbox/spliced {target:"next-turn"}`）。所以超时踢进程时，
   * 排队里的话**会跟着一起没**——不逐条收口，用户就永远在等（N19）。
   *
   * 一轮开始 = 认领一条投递（今天的轮**全部**由投递引起）。
   *
   * ⚠️ **P1 改法**（契约 `88` §二.1）：这里**不再用 `shift()` 当配对依据**。
   *    每条投递带一个自增 `seq`；轮开始时按 `seq` **显式认领**最早那条，
   *    并把配对键 `(agentGeneration, turn)` **落到活账上**（`#work.bind`）。
   *    为什么：改前归属只在内存的一个 `Map` 里，重启就丢；而"按数组顺序弹"
   *    一旦哪里少弹/多弹一条，票就会**整条串位**，且事后查不出来。
   *    ⚠️ 认领仍然是"最早那条"（FIFO）——这是 DSH 事件里**唯一**给得出的关联
   *      （`turn/start` 不带 prompt id）。变的不是 FIFO，变的是**它现在是落盘的、
   *      可复算的键**，而不是一个隐式的数组顺序。
   */
  #delivered = [];

  /** 投递的自增号（认领按它选，不靠数组位置）。 */
  #deliverSeq = 0;

  /**
   * **轮是从哪一代 agent 开的**（`turn` → 进程代号）。
   * ⚠️ 一轮跑到一半换了进程时，收口要用**开轮那一代**，不是"现在这一代"。
   */
  #turnGeneration = new Map();

  /**
   * **逐件落盘的活账**（P1 地基 · 契约 §一.1）。`null` = 老调用方没接（离线测试）。
   */
  #work = null;

  /** **承诺账**（T5）：说了时间就落一行，到点没完必须再报一次。 */
  #promises = null;

  /**
   * **agent 进程代号**（契约 §二.1 的配对键那一半）。
   *
   * ⚠️ 为什么必须有：轮号在**每个进程里都从 1 重新开始**（`session-translate.reset()`）。
   *    单靠 `turn` 配对，新进程的第 1 轮会认到旧进程的第 1 轮上。
   *    它是"换了一个 agent 实例"就 +1，**不等同于**重启（一次重启里可能换好几代）。
   */
  #generation = 0;

  /** 这一代里被预告过"我去做"的轮（只有这些轮做完/失败才**另发一条提醒**）。 */
  #backgroundTurns = new Set();

  /** 轮 → "还没做完就说一声"那个计时器。 */
  #backgroundTimers = new Map();

  /** 阈值（构造可注入；默认住 `BACKGROUND_AFTER_MS`）。 */
  #backgroundAfterMs = BACKGROUND_AFTER_MS;

  /** 承诺 id → 那个到期计时器。 */
  #promiseTimers = new Map();

  /** 这一轮它最后说了什么（完成提醒里"结果一句"用；**不落新盘**，只是转述）。 */
  #lastSpokenText = '';

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

  /** P1：这一间的名字（"去哪看"用它；没有 ⇒ 那句里不带"在哪"）。 */
  #whereTitle = null;

  /**
   * P1：**后台通知的出入口**（`Notice`）。房间也接它（同一个人的一本账）。
   * ⚠️ 与 `#notice`（`(turn,kind)` 通道账）不是同一件事：那个只挂主线
   *    （轮号跨 scope 会顶掉），这个按**一个人一本**。
   */
  #workNotice = null;

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
    /** ★ P1：**逐件落盘的活账**（`WorkLog`）。不接 ⇒ 老行为（不记逐件）。 */
    work = null,
    /** ★ P1：承诺账（`PromiseBook`）。不接 ⇒ 说了时间也不落承诺（那就别说时间）。 */
    promises = null,
    /** ★ P1：这一间的名字（"去哪看"那半句用它；没有 ⇒ 不带那半句）。 */
    whereTitle = null,
    /** ★ P1：后台那几句的出入口（`Notice`；房间也接 —— 一个人一本账）。 */
    workNotice = null,
    /** ★ P1：多久还没做完 ⇒ 当成"长活"，先交代一句（阈值住代码，不写文档）。 */
    backgroundAfterMs = BACKGROUND_AFTER_MS,
    /**
     * ★ **用量账**（契约 `docs/dev/93-OUTBOUND-USAGE.md` §5.2·A）：
     *   上游回来的 `usage` 到了翻译层（`session-translate.js`）就被**丢在这里**。
     *   现在**不再丢**：连同**这一轮的 `scopeId`** 交给它。
     *   ⚠️ 回调失败**不许挡这一轮**（记账是旁路，93 §4.5.5）。
     *   不接 ⇒ 老行为（与改前逐字一致）。
     */
    onUsage = null,
    /**
     * ★ **P2-8 出网留痕**（主人 2026-09-25「② 先只做留痕」）：
     *   翻译层从 `tool/result` 里取出"域名/量"，从这里交给上层（`worlds.js` 那本
     *   `EgressLog`）。🔴 **只记量、不记正文**；**不改网络**；回调失败不挡这一轮。
     *   不接 ⇒ 老行为（与改前逐字一致）。
     */
    onEgress = null,
    /**
     * ★ **D 期：转交那本账**（`HandoffBook` · 一个人一本）。
     * 不接 ⇒ 转交那条工具口如实回"这一台还没接上"（**fail-closed**，绝不假装转了）。
     */
    handoffs = null,
    /**
     * ★ **D 期：怎么算"这一间存在"**（`(scope) => boolean`；由 `Worlds` 给）。
     * ⚠️ **不接 ⇒ 一律当作不存在**（D-3：宁可拒，也**不许顺手建一个**）。
     */
    scopeExists = null,
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
    this.#work = work;
    this.#promises = promises;
    this.#whereTitle = whereTitle;
    this.#workNotice = workNotice ?? notice;
    this.#backgroundAfterMs = backgroundAfterMs;
    this.#onAuthFailure = onAuthFailure;
    this.#onUsage = onUsage;
    this.#onEgress = onEgress;
    // ★ D 期：转交（一个人一本账 ＋ "这一间存不存在"那个判据）
    this.#handoffs = handoffs;
    this.#scopeExists = typeof scopeExists === 'function' ? scopeExists : () => false;
    this.#translator = new TurnTranslator({ timeline, scopeId, notice, onEgress });

    // ★ P1：记下这一轮最后说出口的正文 —— 完成提醒里那句"结果一句"就是它
    //   （**转述**，不是新落一条；模型原文本身已经在时间线上了）。
    // ★ **93 §5.2·A：`usage` 不再当场丢掉** —— 交给 `#noteUsage()`（按这一间的 scope 记账）。
    this.#translator.on('text', ({ turn, text, usage }) => {
      if (typeof text === 'string' && text !== '') this.#lastSpokenText = text;
      this.#noteUsage(turn, usage);
    });

    // 超时硬收口：轮的起讫从翻译层来（它才知道"这一轮开始了没有"）
    this.#translator.on('turn-start', (turn) => {
      this.#lastSpokenText = '';
      // 一轮开始 = **认领**一条投递（按自增号选，不靠数组顺序 —— 契约 §二.1）。
      const generation = this.#generation;
      this.#turnGeneration.set(turn, generation);
      const owner = this.#claimDelivery();
      this.#turnOwner.set(pairKey(generation, turn), owner?.messageId ?? null);
      // ★ **派活**：这一轮是派来的活 ⇒ 记下来（收口时那条总结走回报那条路；
      //   B39 兜底还要知道"是哪一处"）
      if (owner?.job === true) this.#jobTurns.set(turn, this.#lastJobWhere ?? '');
      // ★ P1-22：**这一轮他说了什么** = 引起来的那句话（没有票 ⇒ 空 ⇒ 不许造东西）
      this.#turnInput = owner?.text ?? '';
      // ★ P1：**逐件落盘**（契约 T2）。有票 ⇒ 绑到 `(generation, turn)`；
      //   无票（助手自己发起的一轮）⇒ 也记一件，但**归属是 `null`**（T1 的反例正身）。
      this.#openWork({ turn, generation, owner });
      this.#armDeadline(turn);
      this.#announceTurn(turn);
      // ★ A1·「发现就报」：这一轮开始 ⇒ 记一份主目录的清单（**只记路径**）
      this.#mainLeak?.start();
      // ★ P1 后台四句 ①：**到点还在跑才说**（见 `BACKGROUND_AFTER_MS` 那段：
      //   长活是"它还没做完"这个可观察信号，不是拿他一句话猜出来的）。
      this.#armBackgroundNotice(turn);
    });

    // ★ 这一轮动过东西 ⇒ **落一条盘**。重启之后只有盘上这份能告诉对账：
    //   "这件事**不能**自己重来"（决策 D10.1）。
    //   ⚠️ 事件里**没有工具名、没有参数** —— 只一个归属，见 `#turnOwner`。
    this.#translator.on('mutated', ({ turn }) => {
      try {
        const gen = this.#turnGeneration.get(turn) ?? this.#generation;
        this.#timeline.emit({
          type: 'task/mutated',
          ref: this.#turnOwner.get(pairKey(gen, turn)) ?? null,
          turn,
        });
      } catch (err) {
        // 落不下去不能让 agent 死；但**必须报出来**
        this.#lastError = `动过东西这件事没记下来：${err?.message ?? err}`;
      }
    });
    this.#translator.on('turn-end', ({ turn, kind, handedOff }) => {
      this.#clearDeadline(turn);
      this.#clearBackgroundNotice(turn);
      // ★ P1-22：**这一轮结束了 ⇒ 当轮输入立刻作废。**
      //   ⚠️ 这条不是"顺手清理"：一轮结束到下一句之间，**助手自己发起的那一轮**
      //      （定时 / 重做 / 别人代投）用的是**同一个派发器**。
      //      不清的话它看到的是**上一句他说过的话** ⇒ 造东西那条闸会拿旧话当"他明说了"。
      this.#turnInput = '';
      // ★ P1：**逐件收口**（T2）。做完 ⇒ `done`；别的原因收场 ⇒ `stopped`（"已停"）。
      // ★ **D 期**：这一轮把话**交出去**了 ⇒ 收成 `stopped`（理由明写 `handoff`）
      //   —— 那件活**没有**做完，它换了一间接着做（`handoffDelivery` 会给
      //   接活那间再记一件）。**不许**记成 `done`（那是"说完了"的意思）。
      const done = kind === 'completed' && handedOff !== true;
      this.#closeWork({
        turn,
        outcome: done ? WORK_STATES.done : WORK_STATES.stopped,
        reason: handedOff === true ? 'handoff' : kind,
      });
      this.#turnGeneration.delete(turn);
      // ★ P1 后台四句 ②③：**只对预告过的那件**发提醒（短活不许重复说）。
      //   ★ **派活**（契约 102）：这一轮如果是派来的活、而且它**真把总结交回去了**，
      //     那条"做完了"由 `job/report` 那条路发（带它自己起的名字、"在哪看"）——
      //     这里**不再重复说一遍**（同一件事两条通道 = R1.2 的通知疲劳）。
      // ⚠️ `Map.delete()` 返回的是**布尔**（拿不到值）⇒ 先 `get` 再 `delete`
      //   （这条当初写错过一次：布尔被当成"哪一处"，兜底那一层整个错位）。
      const isJobWhere = this.#jobTurns.get(turn);
      const isJob = this.#jobTurns.has(turn);
      if (isJob) this.#jobTurns.delete(turn);
      if (this.#backgroundTurns.delete(turn)) {
        if (!(isJob && done && this.#jobReported)) {
          this.#announceWorkFinished({ turn, kind, done });
        }
      }
      if (isJob) {
        // ★ **B39 兜底**（`77-BLOCKERS.md`）：它是派来的活、这一轮收了口、
        //   而总结**没交回来** ⇒ 它多半停在那儿等一个永远不会来的回答
        //   （真机实测那句话是"你回一句「接着说」"）⇒ **替它接一句**（有上限）。
        //   ⚠️ 顺序：先按老规矩把"这一轮完了"那几件事做完，再兜这一层。
        if (!this.#jobReported) this.#nudgeStalledJob({ where: isJobWhere, kind });
        this.#jobReported = false;
      }
      // ★ A1·「发现就报」：**正常结束**这条路也要比（三条路缺一不可）
      this.#mainLeak?.finish({ turn, reason: kind });
    });

    // ★ A1·「发现就报」：**失败 / 超时**那两条路同样要比 ——
    //   只在"正常结束"那条路上比，等于漏掉最可能出事的两条。
    //   ⚠️ `force-close` 不带轮号（它一次收掉**所有**开着的轮，见 `forceClose`），
    //      所以这里 `turn` 给 `null`；判据要的是"这一轮前后比过"。
    this.#translator.on('turn-deadline', ({ turn }) => {
      // ★ P1：超时 = **删失样本**（被超时那一轮也要算进分位），收成"已停"。
      this.#clearBackgroundNotice(turn);
      this.#closeWork({ turn, outcome: WORK_STATES.stopped, reason: 'timeout' });
      this.#turnGeneration.delete(turn);
      // ★ **派活**：超时收口的这一轮没把总结交回来 ⇒ 那件仍挂在登记上（"还在做"，如实）
      this.#jobTurns.delete(turn);
      this.#jobReported = false;
      if (this.#backgroundTurns.delete(turn)) {
        this.#announceWorkFinished({ turn, kind: 'timeout', done: false });
      }
      this.#mainLeak?.finish({ turn, reason: 'timeout' });
    });
    this.#translator.on('force-close', ({ reason }) => {
      // ⚠️ 这条路不带轮号 ⇒ 本代**所有还开着的**活一律收成"已停"（没有"消失"）。
      // ★ P1：失败也要提醒 —— 先看有没有预告过（有 ⇒ 收完再补一条失败提醒）。
      const wasBackground = this.#backgroundTurns.size > 0;
      this.#jobTurns.clear();
      this.#jobReported = false;
      this.#closeAllWorkInScope(reason ?? 'failed');
      if (wasBackground) this.#announceWorkFinished({ turn: null, kind: reason ?? 'failed', done: false });
      this.#mainLeak?.finish({ turn: null, reason: reason ?? 'failed' });
    });
  }

  get translator() {
    return this.#translator;
  }

  /**
   * ★ **93 §5.2·A：把这一轮的 `usage` 交出去**（按**这一间**的 `scopeId`）。
   *
   * 🔴 为什么按 scope：主人第 8 条"**都算到这个 app（含它触发的子任务）**"——
   *    这一间房里的轮（含它自己拉起来的子任务）都带这个 `scopeId`。
   * ⚠️ **回调失败不许挡这一轮**（93 §4.5.5：盘满时那一轮照旧收口）。
   * ⚠️ `usage` 为空 / 认不出 ⇒ **不记**（不许拿 0 充一笔）。
   */
  #noteUsage(turn, usage) {
    if (!this.#onUsage || !usage || typeof usage !== 'object') return;
    try {
      this.#onUsage({
        scopeId: this.#scopeId ?? 'main',
        turn: Number.isInteger(turn) ? turn : null,
        usage,
      });
    } catch {
      /* 记账是旁路：它出事不许把用户那一轮弄失败 */
    }
  }

  get lastError() {
    return this.#lastError;
  }

  /** ★ **D 期：从同一个调度器里的别处**（例如转交那条投递路）如实记一笔错误。 */
  noteError(msg) {
    this.#lastError = String(msg);
  }

  /** 上一次喂回去的那段背景（诊断用；`null` = 还没喂过）。 */
  get lastRecap() {
    return this.#lastRecap;
  }

  /** 现在还没变成轮的那些话（诊断 / 验收用）。 */
  get pendingDeliveries() {
    return this.#delivered.filter((t) => !t.claimed).length;
  }

  /** ★ P1：这一代 agent 的代号（配对键那一半 · 契约 §二.1）。 */
  get generation() {
    return this.#generation;
  }

  /**
   * ★ P1：**这一间现在开着的活，逐件**（契约 §二.3）。
   * ⚠️ 这就是"逐件可查"的落点：改前只有一个全局 busy 布尔。
   */
  get workItems() {
    return this.#liveWorkOfScope().map((r) => ({
      scopeId: r.scopeId,
      generation: r.generation,
      turn: r.turn,
      ref: r.ref,
      state: r.state,
      startedAt: r.startedAt,
    }));
  }

  /** 现在挂着几个超时计时器（诊断用）。 */
  get armedDeadlines() {
    return this.#deadlines.size;
  }

  /**
   * **这一轮现在是不是"正在跑的那一轮"**（`(generation, turn)` 对得上就是）。
   *
   * 用处只有一个，但很要紧：★ P1 §三④ 那条出口**要把"正在问的那一轮"排除掉**
   * ——他问"那件怎么样了"的时候，**这句提问自己**也在这本账上（状态 `running`），
   * 不排掉的话答案永远是"那件还在做"，而那件就是这句话本身（**看着像在说假话**）。
   * ⚠️ 轮的起讫由翻译层给（`turn-start` 记、`turn/end` 删）⇒ 这条判据跟它同一处出处。
   */
  isTurnOpen(generation, turn) {
    if (!Number.isInteger(turn)) return false;
    if (!this.#turnGeneration.has(turn)) return false;
    return generation === undefined || generation === null || this.#turnGeneration.get(turn) === generation;
  }

  /**
   * ★ **正在跑的那几轮分别是哪句话引起来的**（票 / `ref` 那一串）。
   *
   * 为什么还要这个（`isTurnOpen` 不够）：一件活**刚投出去还没轮到它跑**时
   * （状态 `waiting`）**还没有 `(generation, turn)`**（那两个字段是 `null`），
   * 可它**照样是"正在问的那一轮"**（用户刚说完、正在等）。只按 `(gen,turn)` 排
   * 会把这一档漏掉 —— 判据当场抓到了（T4④c ②）。
   */
  get openTurnRefs() {
    const out = new Set();
    for (const [turn, gen] of this.#turnGeneration.entries()) {
      const ref = this.#turnOwner.get(pairKey(gen, turn));
      if (typeof ref === 'string' && ref !== '') out.add(ref);
    }
    return out;
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
   * ★ **D 期：这一间现在跑到第几轮**（末了一条；没有 ⇒ `null`）。
   * 只用于转交那条记录上的审计字段（"谁在哪一轮转的"）。
   */
  get turn() {
    let last = null;
    for (const t of this.#translator.turnRecords().keys()) {
      if (last === null || t > last) last = t;
    }
    return last;
  }

  /** ★ **D 期**：见 `turn`。 */
  get generation() {
    return this.#generation;
  }

  /**
   * ★ **D 期：这一轮正在写的那条消息**（转交的锚点就是它 —— 客户端那个气泡）。
   * 认不出 ⇒ `null`（不许猜）。
   */
  get liveWriter() {
    const turn = this.#translator.liveTurn;
    if (turn === null) return null;
    const rec = this.#translator.turnRecords().get(turn);
    const w = rec?.writer ?? rec?.adopted ?? null;
    return w && !w.ended ? w : null;
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

  // ── P1：逐件落盘的活账（契约 88 §一.1 / §二.2 / §二.3）────────────

  /**
   * **认领一条投递**（一轮开始 = 一张票被用掉）。
   *
   * ⚠️ **不靠 `shift()`**：按自增 `seq` 选**最早还没认领**的那条。
   *    为什么 FIFO 是唯一能给的关联：DSH 的 `turn/start` 里**没有 prompt id**
   *    （`07-TIMEOUT.md` §1.1 实测：排队的第二句下一轮才变成轮，顺序是 DSH 给的）。
   *    所以"选哪条"仍是 FIFO；变的是**配对现在是落盘的、按 `(generation, turn)`
   *    可查的键**，而且认领动作不依赖数组位置（少弹/多弹不会整条串位）。
   */
  #claimDelivery() {
    let pick = null;
    let at = -1;
    for (const [i, t] of this.#delivered.entries()) {
      if (t.claimed) continue;
      if (pick === null || t.seq < pick.seq) {
        pick = t;
        at = i;
      }
    }
    if (pick) {
      this.#delivered.splice(at, 1); // 用掉了就拿走（不然这个数组会一直长）
      pick.claimed = true;
    }
    return pick;
  }

  /** 这一代里现在还开着的活（诊断 / 聚合用）。 */
  #liveWorkOfScope() {
    if (!this.#work) return [];
    return this.#work.live().filter((r) => (r.scopeId ?? 'main') === (this.#scopeId ?? 'main'));
  }

  /** 开一件活：有票 ⇒ 绑到 `(generation, turn)`；无票 ⇒ 记一件但**归属 `null`**。 */
  #openWork({ turn, generation, owner }) {
    if (!this.#work) return;
    const scopeId = this.#scopeId ?? 'main';
    try {
      if (owner?.messageId) {
        this.#work.bind({ scopeId, ref: owner.messageId, generation, turn });
      } else {
        // ⚠️ T1 的反例正身：无票自发轮的归属是 `null` —— 它**不许**去认领谁的票。
        this.#work.spontaneous({ scopeId, generation, turn });
      }
    } catch (err) {
      this.#lastError = `这件活没记上账：${err?.message ?? err}`;
    }
  }

  /** 按 `(generation, turn)` 收口一件活。**幂等**；那一代没记过 ⇒ 安静跳过。 */
  #closeWork({ turn, outcome, reason }) {
    if (!this.#work) return null;
    const scopeId = this.#scopeId ?? 'main';
    const gen = this.#turnGeneration.get(turn) ?? this.#generation;
    try {
      let rec = this.#work.byTurn(scopeId, gen, turn);
      // 兜底：绑轮那次可能没写成（盘满）⇒ 按票找。
      if (!rec) {
        const ownerRef = this.#turnOwner.get(pairKey(gen, turn));
        if (ownerRef) rec = this.#work.byRef(scopeId, ownerRef);
      }
      if (!rec || !isOpen(rec.state)) return null;
      const r = this.#work.close({ id: rec.id, outcome, reason });
      return r.record;
    } catch (err) {
      this.#lastError = `这件活没收住口：${err?.message ?? err}`;
      return null;
    } finally {
      this.#turnGeneration.delete(turn);
      this.#turnOwner.delete(pairKey(gen, turn));
    }
  }

  /** 本代**所有**还开着的活一律收口（`force-close` / 进程退了两条路都走它）。 */
  #closeAllWorkInScope(reason) {
    for (const rec of this.#liveWorkOfScope()) {
      try {
        this.#work.close({ id: rec.id, outcome: WORK_STATES.stopped, reason });
      } catch (err) {
        this.#lastError = `停下来的那件没收住口：${err?.message ?? err}`;
      }
    }
    this.#turnGeneration.clear();
    this.#turnOwner.clear();
    this.#backgroundTurns.clear();
  }

  /**
   * ★ P1 后台四句 —— **走 `notice` 那条唯一出口**（同一个事件形状、落盘取号），
   * 出门之前过**时间词闸**。没有依据的时间词 ⇒ 这句话**不发**（宁可不发，也不许说假话）。
   *
   * ⚠️ **不用气泡**（`message/*`）：那会让"盘上有一条 `message/end`"不再等于
   *    "这一轮说完了"——实测立刻撞红一条既有判据（造 app 那一轮的对账等的是
   *    `message/end`，开场那句会**提前**把它满足掉）。通知这条出口本来就是给
   *    "主动开口 / 你不在时发生的事"用的，形状也正好。
   */
  #sayProactive(text, { evidence = null, kind = 'work-started' } = {}) {
    if (typeof text !== 'string' || text.trim() === '') return null;
    if (!this.#workNotice) return null;
    try {
      assertBackedText(text, { evidence });
    } catch (err) {
      this.#lastError = `这句话没说出口（时间词没依据）：${err?.message ?? err}`;
      return null;
    }
    try {
      return this.#workNotice.work({ kind, text });
    } catch (err) {
      this.#lastError = `这条提醒没发出去：${err?.message ?? err}`;
      return null;
    }
  }

  /** ① 开跑："我去做，做完叫你"（**不带时间承诺**）。 */
  #announceWorkStarted() {
    this.#sayProactive(WORK_STARTED_LINE, { kind: 'work-started' });
  }

  /** ② 完成 / ③ 失败："做完了（+结果一句+去哪看）" / "这件事我没做完"。 */
  #announceWorkFinished({ turn, kind, done }) {
    if (done) {
      const result = workResultLine(this.#lastSpokenText, { hasTimeClaim });
      return this.#sayProactive(
        workDoneLine({ result, scopeId: this.#scopeId ?? 'main', title: this.#whereTitle }),
        { kind: 'work-done' },
      );
    }
    // ⚠️ 失败也要提醒（契约 §三.③）—— 不许静默。
    return this.#sayProactive(WORK_FAILED_LINE, { kind: 'work-failed' });
  }

  /**
   * **他随时能问"那件怎么样了"**（契约 §三.④）：逐件答案。
   * @returns {string} 那句话（查无此件 ⇒ 也有一句，不许空着）
   */
  workReport({ scopeId = null, ref = null, turn = null, generation = null } = {}) {
    if (!this.#work) return workAnswerLine('unknown');
    const scope = scopeId ?? this.#scopeId ?? 'main';
    const rec = this.#work.answer({ scopeId: scope, ref, turn, generation });
    if (!rec) return workAnswerLine('unknown');
    const base = workAnswerLine(rec.answer);
    const where = workWhereWords({ scopeId: rec.scopeId, title: this.#whereTitle });
    return `${base}${where}`;
  }

  /**
   * **说一句带时间承诺的话**（T5）：先落承诺行 + 挂到活上，再发那句话。
   * 到点没做完 ⇒ 计时器触发**再报一次**。
   *
   * @param {object} o
   * @param {string} [o.ref]   哪张票（哪件活）
   * @param {string} o.text    承诺的原话
   * @param {string} o.basis   **依据 id**（`elapsed:` / `duration:`）—— 给不出来就不许承诺
   * @param {number} o.dueAt   说到什么时候
   */
  notePromise({ ref = null, text, basis = null, dueAt = null } = {}) {
    if (!this.#promises || !this.#work) return null;
    if (!basis || !Number.isFinite(dueAt)) {
      // ⚠️ 没有依据 / 没有到期时刻 ⇒ **不许说**（契约 §二.4）。
      this.#lastError = '想承诺一个时间，但给不出依据（那就不许说）';
      return null;
    }
    const scopeId = this.#scopeId ?? 'main';
    const rec = ref ? this.#work.byRef(scopeId, ref) : null;
    const id = `p:${scopeId}:${ref ?? 'anon'}:${dueAt}`;
    this.#promises.make({ id, scopeId, ref, workId: rec?.id ?? null, text, basis, dueAt });
    if (rec) this.#work.attachPromise({ id: rec.id, promiseId: id });
    const timer = setTimeout(() => this.#onPromiseDue(id), Math.max(0, dueAt - Date.now()));
    timer.unref?.();
    this.#promiseTimers.set(id, timer);
    // 承诺的那句话本身也要过时间词闸（它就是那句时间话）。
    return { id, event: this.#sayProactive(text, { evidence: basis }) };
  }

  #onPromiseDue(id) {
    this.#promiseTimers.delete(id);
    try {
      const fate = this.#promises.fate({ works: this.#work.all() });
      const p = [...fate.pending, ...fate.unfulfilled].find((x) => x.id === id);
      if (!p) return; // 已经兑现 / 已经不在了
      this.#promises.reReport({ id, text: WORK_LATE_LINE });
      this.#sayProactive(WORK_LATE_LINE, { evidence: `promise:${id}`, kind: 'work-late' });
    } catch (err) {
      this.#lastError = `承诺到点没报成：${err?.message ?? err}`;
    }
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
    // ★ P1：那一代没了 ⇒ "还没做完就说一声"的计时器也一起撤（不然会说一句没主的话）。
    this.#clearAllBackgroundNotices();
  }

  /**
   * ★ P1：**到点还在跑 ⇒ 说一句"我去做，做完叫你"**（后台四句 ①）。
   * 一句话都不含时间承诺 —— 我们**不知道**还要多久（契约 §二.4）。
   */
  #armBackgroundNotice(turn) {
    if (!(this.#backgroundAfterMs > 0)) return;
    this.#clearBackgroundNotice(turn);
    const timer = setTimeout(() => {
      this.#backgroundTimers.delete(turn);
      // 那一轮已经收口了（计时器可能晚一拍）⇒ 什么都不说。
      if (!this.#turnGeneration.has(turn)) return;
      this.#backgroundTurns.add(turn);
      this.#announceWorkStarted();
    }, this.#backgroundAfterMs);
    timer.unref?.();
    this.#backgroundTimers.set(turn, timer);
  }

  #clearBackgroundNotice(turn) {
    const t = this.#backgroundTimers.get(turn);
    if (t) {
      clearTimeout(t);
      this.#backgroundTimers.delete(turn);
    }
  }

  #clearAllBackgroundNotices() {
    for (const t of this.#backgroundTimers.values()) clearTimeout(t);
    this.#backgroundTimers.clear();
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
    const tickets = this.#delivered.filter((t) => !t.claimed);
    this.#delivered.length = 0;
    for (const t of tickets) {
      try {
        this.#translator.turnUndelivered({ reason });
      } catch (err) {
        this.#lastError = `排队那句没收住：${err?.message ?? err}`;
      }
      // ★ P1：排队那句也**逐件收口**（不许留一张永远不配对的欠条 · T1/T2）。
      try {
        if (t.messageId) {
          this.#work?.closeByRef({
            scopeId: this.#scopeId ?? 'main',
            ref: t.messageId,
            outcome: WORK_STATES.stopped,
            reason: `undelivered:${reason}`,
          });
        }
      } catch (err) {
        this.#lastError = `排队那张票没收住：${err?.message ?? err}`;
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

    // ★ P1：**换代**（契约 §二.1 的配对键那一半）。轮号在新进程里从 1 重来，
    //   所以配对键必须带这一代号；不带就会"新进程第 1 轮认到旧进程第 1 轮"。
    this.#generation += 1;
    const generation = this.#generation;
    // ⚠️ 旧代还开着的活，这一刻**诚实收口成"已停"**（不许留在半空里 —— 契约 §二.2）。
    try {
      this.#work?.settleDead({ aliveGenerations: [generation] });
    } catch (err) {
      this.#lastError = `换进程时旧账没收住：${err?.message ?? err}`;
    }
    this.#turnGeneration.clear();
    this.#backgroundTurns.clear();

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
  async deliver(text, { messageId = null, job = false } = {}) {
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
    const ticket = {
      messageId,
      at: Date.now(),
      text: typeof text === 'string' ? text : '',
      // ★ P1：自增号 —— 认领按它选（**不靠数组顺序**，契约 §二.1）。
      seq: (this.#deliverSeq += 1),
      claimed: false,
      // ★ **派活**（契约 102）：这一票是派来的活 ⇒ 认领它的那一轮要被记下来。
      job: job === true,
    };
    this.#delivered.push(ticket);
    // ★ P1：**票先落盘**（T1/T2）。票就是欠条：这张票一定有个配对终态。
    //   写不进去不许把回答带走（那句话已经落盘了）——但**必须报出来**。
    try {
      this.#work?.declare({ scopeId: this.#scopeId ?? 'main', ref: messageId, ticket: messageId });
    } catch (err) {
      this.#lastError = `这张票没记进活账：${err?.message ?? err}`;
    }
    if (needsRecap) this.#recapFedTo = agent;

    try {
      const r = await agent.prompt(blocks);
      this.#lastError = null;
      return { delivered: true, messageId: r?.messageId, recapped: needsRecap };
    } catch (err) {
      // 没进去的就从队列里摘掉（摘不掉也只是多收一条，不会漏收）
      const i = this.#delivered.findIndex((t) => t === ticket);
      if (i !== -1) this.#delivered.splice(i, 1);
      // ★ P1：投不出去 ⇒ 这张票也有终态（不许留一张永远不配对的欠条）。
      try {
        this.#work?.closeByRef({
          scopeId: this.#scopeId ?? 'main',
          ref: messageId,
          outcome: WORK_STATES.stopped,
          reason: 'deliver-failed',
        });
      } catch (werr) {
        this.#lastError = `票没收住：${werr?.message ?? werr}`;
      }
      if (needsRecap) this.#recapFedTo = null; // 没喂成 ⇒ 下次补
      this.#lastError = String(err?.message ?? err);
      // 起不来的时候**也要有个交代**——静默失败等于"它不理我"
      //
      // 🔴 **2026-09-26 真机读数（这一处原来是个真缺陷）**：`prompt` 被拒时
      //    （服务端回 error 帧，例如 id 形状那条），DSH **一轮都没开**
      //    （`turn/start` 永远不来）⇒ 原来那句 `forceClose` 收的是 `#turns` 里
      //    **已经开过的轮**，这里收 **0** 轮 ⇒ **一个字都没写**。
      //    现场：`/api/say` 200，之后**五分钟里一个新事件都没有** ——
      //    用户那一句永远没有答复、盘上像没发生过。
      //    （下面那条瞬态 `error` 客户端今天**不渲染** ⇒ 不算"看得见"。）
      //    ⇒ 换成 `deliveryFailed`：先走既有的失败收口，**一轮都没开**时
      //      再主动落一条给用户的话（`AGENT_UNAVAILABLE_LINE`，**落盘**）。
      try {
        this.#translator.deliveryFailed('failed', { line: AGENT_UNAVAILABLE_LINE });
      } catch (terr) {
        this.#lastError = `投递失败的话没写出去：${terr?.message ?? terr}`;
      }
      this.#timeline.emitTransient({
        type: 'error',
        kind: 'agent-unavailable',
        text: AGENT_UNAVAILABLE_LINE,
      });
      return { delivered: false, error: this.#lastError };
    }
  }

  // ── ★ **派活**（契约 `docs/dev/102-APP-BIRTH-SCOPE.md`）────────────────

  /**
   * ★ **把派来的活投给这一间**（P1 要的"任务与由来真交到它手上"）。
   *
   * ⚠️ 走的**就是** `deliver` 那条投递/认领路（真 spawn、真 prompt）——
   *    不是"只在盘上写一句话"。
   * 比 `deliver` 只多两件：
   *   · 记下任务书原文（`lastJobPacket`，诊断/判据用）＋ **是哪一处的**（B39 要用）；
   *   · 这一票标记成**派来的活** ⇒ 认领它的那一轮收口时，那条总结走回报那条路。
   */
  deliverJob(packet, { where = null } = {}) {
    this.#lastJobPacket = typeof packet === 'string' ? packet : String(packet ?? '');
    if (typeof where === 'string' && where !== '') this.#lastJobWhere = where;
    return this.deliver(this.#lastJobPacket, { job: true });
  }

  /**
   * ★ **B39 兜底：它停在那儿等回话 ⇒ 替它接一句**（`77-BLOCKERS.md` 的 B39）。
   *
   * 🔴 **有上限**（`JOB_NUDGE_MAX`）：接满还是没交回 ⇒ **如实报"没做完"**（上面那条）。
   * 🔴 这一票**仍然标记成派来的活**（`job:true`）⇒ 接下来那一轮照旧算"派来的活"，
   *    于是"再接一次"和"再接满了"这两条路都还走得通（不然接一次就断了）。
   */
  deliverJobNudge(text) {
    return this.deliver(typeof text === 'string' ? text : JOB_NUDGE_LINE, { job: true });
  }

  /** ★ **B39 兜底：它停在那儿等回话 ⇒ 替它接一句**（`77-BLOCKERS.md` 的 B39）。 */
  #nudgeStalledJob({ where = '', kind = null } = {}) {
    // ⚠️ 只兜"它自己收的口"（说完了 / 说不下了）。
    //    `timeout` / 进程没了那两条路**不接** —— 那边没有"接着说"可言，
    //    硬接会变成"它死了我还催它"（而且 `deliver` 会再起一个进程，代价白花）。
    if (kind !== 'completed' && kind !== 'max-tokens') return;
    const key = String(where ?? '');
    if (key === '') return; // 不知道是哪一处 ⇒ 接不了（**不猜**）
    const given = this.#jobNudges.get(key) ?? 0;
    if (given >= JOB_NUDGE_MAX) {
      if (this.#jobNudges.get(`${key}:told`) === true) return; // 只如实说一次
      this.#jobNudges.set(`${key}:told`, true);
      this.#sayProactive(JOB_LINES.nudgeGaveUp, { kind: 'work-nudge' });
      return;
    }
    const n = given + 1;
    this.#jobNudges.set(key, n);
    // **留痕**（B39-c）：主进程那一侧看得见"它停过、我替它接了一句"
    //   ⚠️ 每次换一句（同一句话在窗口内只会说一次 ⇒ 不换就看不到第 2 次）。
    this.#sayProactive(n <= 1 ? JOB_LINES.nudged : JOB_LINES.nudgedAgain(n), { kind: 'work-nudge' });
    // ★ **真接一句**：这一票照旧标记成派来的活 ⇒ 接下来那一轮还算"派来的活"
    //   （于是"再接一次"和"再接满了"这两条路都还走得通）。
    this.deliverJobNudge(JOB_NUDGE_LINE).catch((err) => {
      this.#lastError = `替它接的那一句没送出去：${err?.message ?? err}`;
    });
  }

  /** ★ **派活**：这一间刚把总结交回去了（`Dispatcher.finishJob` 记的）。 */
  noteJobReported() {
    this.#jobReported = true;
  }

  /** ★ **B39**：这一件交回来了 ⇒ 那本"接了几次"的账跟着销掉。 */
  clearJobNudges(where) {
    if (typeof where !== 'string' || where === '') return;
    this.#jobNudges.delete(where);
    this.#jobNudges.delete(`${where}:told`);
  }

  /**
   * ★ **派活**：把**扔回主进程**的那条人话总结说出去（走 P1 那本 `work-*` 出口，
   * 同一个 `Notice` —— 主进程那一份，**不另造通道**）。
   */
  announceJobDone(text) {
    return this.#sayProactive(text, { kind: 'work-done' });
  }

  /**
   * ★ **把一条产品事件记在**这一间**那条日志上**（派活那两帧用；见 `job.js`）。
   * ⚠️ 在**主进程那一间**上调 ⇒ 事件没有房间标签 ⇒ 主进程看得到（那正是 P3/P4 要的），
   *    而子进程那一间的视图**挑不到它**（P2 的反面也靠它）。
   */
  noteProduct(event) {
    return this.#timeline.emit(event);
  }

  /**
   * ★ **⑤：把一条瞬态帧推给这一间的订阅者**（不落盘、不占号 —— 见 `job.js` 的
   * `SCOPE_OPEN`）。派活成功那一帧用它：**补发里永远没有它**，
   * 所以"重连时误切房间"结构上不可能。
   */
  noteTransient(event) {
    return this.#timeline.emitTransient(event);
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

  // ── ★ D 期：转交（§二① · D-1…D-4 · D-8）────────────────────────

  /**
   * **这条消息转出去了**：只打状态，**不收口**（D-4 前半 · D-8）。
   *
   * 🔴 它与"**挪走**"语义相反（决策 D10.4）：
   *    挪走 = 先收口、后面的话另起一条；转交 = 不收口、**同一条继续写**。
   *    ⇒ 所以这里**只**发一条 `message/handoff`，绝不 `end()`。
   */
  announceHandoff({ messageId, reason = null, to = null, scopeId = null } = {}) {
    // ⚠️ 哪一轮开的这条消息（新开的口要挂到那一轮上，否则那一轮收口时会
    //   **另开一条**空消息 —— 那就成了"两条气泡"）。
    const turn = this.#openTurnOfMessage(messageId);
    // 🔴 **可见标签**：发起那一间（§6.2）—— 一条消息的 writer 认不出自己是
    //    哪一间（主线那一间在盘上**没有**这个字段），所以这里**明确传进去**。
    const tag = scopeId ?? this.#scopeId ?? null;
    let w = null;
    try {
      // 光调工具、一个字都没说 ⇒ 那条消息还不存在 —— 先给它开个口（**不编正文**）
      w = this.#translator.openMessageForHandoff(messageId, turn);
    } catch (err) {
      this.#lastError = `转交那条消息没开成口：${err?.message ?? err}`;
      return false;
    }
    if (!w) return false;
    try {
      const ok = w.handoff({ reason, to, scopeId: tag });
      // ★ **这条消息从此刻起交给别人了**（D-4 / D-8）：
      //   · 收口**不在本间**做（谁接过去谁收）；
      //   · 本间的超时 / 失败兜底还认它（`N19`：不许留"永远马上说完"的气泡）。
      if (ok) this.#translator.noteHandedOff(turn, messageId);
      return ok;
    } catch (err) {
      this.#lastError = `转交的状态没打上：${err?.message ?? err}`;
      return false;
    }
    // ⚠️ **这里不 `end()`**：收口由接活那一轮做（D-4 / D-8）。
    //    发起者那一轮**照常结束**（它只是不再往那条里写）—— 轮的账该怎么收怎么收。
  }

  /**
   * 这条已开口的消息是哪一轮开的。
   * ⚠️ 认不出 ⇒ `null`：**不猜**。
   */
  #openTurnOfMessage(messageId) {
    for (const [turn, rec] of this.#translator.turnRecords()) {
      const w = rec?.writer ?? rec?.adopted ?? null;
      if (w && w.messageId === messageId && !w.ended) return turn;
    }
    // ★ 光调了工具、一个字都没说 ⇒ 还没有 writer，但这一轮是**在的**
    //   （`liveTurn`）—— 开出来的那个口要挂到它上面，否则它收口时会**另开一条**。
    return this.#translator.liveTurn;
  }

  /**
   * ★ **接活**：目标那一轮**接着往同一条消息里写**（D-4 后半）。
   *
   * 做四件、顺序不许反：
   *   ① 告诉翻译层"下一轮来接这条消息"（`expectHandoff`）——
   *      🔴 **事件的 `scopeId` 不变**（发起那一间 · §6.2）；
   *   ② 把**发起者那条 writer** 一起交过去（N22 的登记在它身上：另建一个会当场撞上）；
   *   ③ 投递交接包（**新起一轮**，不是用户那句话）；
   *   ④ 那件活记到**这一间**头上（审计/用量），`ref` 仍是**那一条消息**。
   */
  async handoffDelivery(rec, { openWriterOf = null, brief = '' } = {}) {
    const packet = this.#packetText(rec, brief);
    // ★ 发起者那条 writer（**同一个对象**）—— 见 ②
    let writer = null;
    try {
      writer = typeof openWriterOf === 'function' ? openWriterOf(rec.messageId) : null;
    } catch {
      writer = null;
    }
    // ⚠️ **顺序不许反**：`#ensureAgent()` 会 `reset()` 翻译层（换了进程 ⇒ 轮账、
    //   排队、`#adoptions` 一起清）—— 所以它必须**在**登记接活那一条**之前**跑，
    //    否则刚登记的那一条会被它当场清掉（D-4 的续写就丢了）。
    const agent = this.#ensureAgent();
    this.#translator.expectHandoff(rec.messageId, this.scopeId, writer);
    // ★ **留一份交接包原文**（诊断 / 判据用）：它是**这一侧拼的**，不是主人说的那句。
    this.#lastHandoffPacket = packet;
    // ★ 换人 ⇒ 背景照样要喂（否则它不知道前面说了什么）
    let blocks = [{ type: 'text', text: packet }];
    if (this.#recapFedTo !== agent) {
      try {
        const recap = this.#recapText(null);
        if (recap !== '') blocks = [{ type: 'text', text: recap }, ...blocks];
      } catch (err) {
        this.#lastError = `背景没读出来：${err?.message ?? err}`;
      }
    }
    const t = {
      messageId: rec.messageId,
      at: Date.now(),
      text: packet,
      seq: (this.#deliverSeq += 1),
      claimed: false,
    };
    this.#delivered.push(t);
    try {
      // ★ **这一件活记在接活那一间头上**（审计/用量）：`ref` 仍是**那一条消息**
      //   （所以"他问的那件事怎么样了"照样答得出同一条）。
      this.#work?.declare({
        scopeId: this.scopeId,
        ref: rec.messageId,
        ticket: `handoff:${rec.id}:${this.scopeId}`,
      });
    } catch (err) {
      this.#lastError = `接下的这件没记上账：${err?.message ?? err}`;
    }
    try {
      await agent.prompt(blocks);
      this.#recapFedTo = agent;
      this.#lastError = null;
    } catch (err) {
      const i = this.#delivered.indexOf(t);
      if (i !== -1) this.#delivered.splice(i, 1);
      this.#lastError = `交接包没送出去：${err?.message ?? err}`;
      // ⚠️ **不许静默**：这一轮没能接上 ⇒ 那条消息必须收口（N19），
      //    而且要说清"我这边没接上"（与别处起不来时同一句）。
      //    🔴 同 `deliver` 那一处：交接包被拒时这一间**可能一轮都没开**
      //    （`forceClose` 收 0 轮 ⇒ 一个字都不写）⇒ 用 `deliveryFailed`
      //    保证落一条用户看得见的话。
      try {
        this.#translator.deliveryFailed('failed', { line: AGENT_UNAVAILABLE_LINE });
      } catch (terr) {
        this.#lastError = `交接失败的话没写出去：${terr?.message ?? terr}`;
      }
    }
  }

  /**
   * 这条已开口的消息的 writer（**给接活那一间拿去续写** ·
   * N22 的登记在它身上，另建一个会当场撞上）。
   * ⚠️ 认不出 ⇒ `null`（那一轮会自己按 `messageId` 新开一条 —— 至少名字是对的）。
   */
  openWriterFor(messageId) {
    for (const rec of this.#translator.turnRecords().values()) {
      const w = rec?.writer ?? rec?.adopted ?? null;
      if (w && w.messageId === messageId && !w.ended) return w;
    }
    return null;
  }

  /**
   * 交接包那句人话（**不带内部 id**：目标那一间的模型不该看到我们的内部名字）。
   * @param {object} rec 那条转交记录
   * @param {string} [brief] **发起那一间**最近说过的话（在**那一侧**读，见调用方）
   */
  #packetText(rec, brief = '') {
    return [
      '【另一半】有一件事转到我这儿来了，是发起这件事的那一间转过来的。',
      rec.reason ? `他给的理由：${rec.reason}` : '',
      '同一件事、同一条回复，接着往下做，做好了照样回他。',
      brief ? `他刚才说过的话：\n${brief}` : '',
    ]
      .filter((s) => s !== '')
      .join('\n');
  }

  /**
   * ★ **D 期：这一间最近说过的话**（交接包里的**上下文摘要** · `100` §7 第 4 条：
   * "带多少"住代码，文档只说"要带上摘要"）。
   *
   * 🔴 **在发起那一间读**（`Dispatcher.#handoffDelivery` 调它）：交接包要让
   *    目标那一间知道"**他刚才说了什么**"，而那是**发起那一间**视图里的话
   *    —— 目标那一间自己的视图里没有它。
   * ⚠️ 读不到 ⇒ **不带那半句**（绝不编），不是"报错"。
   * ⚠️ 摘的是**主人说过的话**（`user/echo`）：那是"这件事是什么"最靠得住的来源；
   *    agent 自己说过什么由 DSH 那边的背景接着管。
   */
  brief() {
    let events = [];
    try {
      events = this.#timeline?.readAll?.() ?? [];
    } catch {
      return '';
    }
    const says = events
      .filter((e) => e?.type === 'user/echo' && typeof e.text === 'string' && e.text.trim() !== '')
      .slice(-HANDOFF_BRIEF_SAYS);
    if (says.length === 0) return '';
    return says.map((e) => `- ${e.text.trim()}`).join('\n');
  }

  /** 诊断/判据：这一间有没有接下活的轮（`turn` → 记录）。 */
  get adoptionTurns() {
    return this.#translator.turnRecords();
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
  /** ★ P1：后台那几句的出入口（`Notice`，一个人一本）。 */
  #workNotice;
  /** ★ P1：每个用户**一份**的活账 / 承诺账（所有会话共用）。 */
  #work;
  #promises;
  /** `scopeId` → 那一间的名字（"去哪看"用）。 */
  #titles;
  /** ★ P1：长活判定的阈值（房间也要同一份）。 */
  #backgroundAfterMs;
  /** ★ 用量账（见 `Session` 的 `onUsage`）——每个用户一份，所有会话共用。 */
  #onUsage;

  /** ★ P2-8 出网留痕（见 `Session` 的 `onEgress`）——每个用户一份，所有会话共用。 */
  #onEgress;

  /** ★ **D 期：转交那本账**（一个人一本；见 `Session` 的 `handoffs`）。 */
  #handoffs;
  /** ★ **D 期：怎么算"这一间存在"**（`(scope) => boolean`；见 `Session` 的 `scopeExists`）。 */
  #scopeExists;
  /** ★ **D 期：焦点那本账**（`设备 → 焦点` · 判据 D-9）。 */
  #focusBook;
  /** ★ **D 期：未读那本账**（判据 D-6）。 */
  #unread;
  /** ★ **D 期：转交的投递排着**（一笔一笔来；见 `handoffTo`）。 */
  #handoffChain = Promise.resolve();

  /**
   * ★ **派活那本简登记**（`JobBook` · 一个人一本 · 见 `job.js`）。
   * 不接 ⇒ 派活那条口如实回"这一台还没接上"（**fail-closed**，绝不假装派了）。
   */
  #jobs = null;

  /**
   * ★ **派活要建的那一间**（`(where) => Session|null`；由 `Worlds` 给）。
   * 里面是"服务端那一刀"：建工作区（目录／清单）＋ 把它挂成这个用户的一条会话。
   * ⚠️ **不接 ⇒ 派活一律失败**（`JOB_LINES.failed`）——那是"如实说"那半（P6）。
   */
  #startScope = null;

  /**
   * ★ **待确认的那一笔派活**（契约 `docs/dev/108-JOB-ASK-FLOW.md` §一 第①步）。
   *
   * 🔴 **只在内存里**：谁在哪一间发起的 · `where` · `why` · 号 · 计时器。
   *    **盘上一个字都没有**（S1/S5）：没答之前什么都不建，连一份待确认记录都不落。
   * 🔴 **一次一件**（契约 §四.2）：再来一笔就**顶掉**前一笔（前一笔按 `expired` 记）。
   */
  #ask = null;
  /** 待确认那个号的自增段（`j_…`；与登记那个号同一族，诊断用）。 */
  #askSeq = 0;
  /**
   * ★ **那一笔最近的下场**（诊断/判据用）：`{id, where, why, status}`，
   * `status` ∈ `pending` / `yes` / `no` / `expired`。**不落盘**。
   */
  #lastAsk = null;
  /**
   * ★ **那一帧问话等他多久**（阈值住 `job.js`；`Worlds` 能调小 —— 判据要它小）。
   */
  #jobAskTimeoutMs = JOB_ASK_TIMEOUT_MS;

  /** ★ **派活的投递排着**（与转交同一条理由：两笔交错会把轮的账弄乱）。 */
  #jobChain = Promise.resolve();
  /**
   * ★ **D 期：目标那一间不存在会话时把它挂上来**（`Worlds.roomFor`；可选）。
   * ⚠️ 不接 ⇒ 目标必须**已经开着**才送得出去（如实记一句"没有这一间的会话"）。
   */
  #loadSession = null;

  /**
   * ★ **C 期：他最近一次看着哪一间**（契约 `84-DISPATCHER-FOCUS.md` §三·3）。
   *
   * 它住的这一层是刻意的：**每个用户一个调度器**（§三·1）⇒ "他的焦点"是
   * 这个用户身上的一件事，不是宿主上一个全局（`37-MULTITENANT.md`：
   * 调度器不许有"当前用户"全局，身份只能靠参数传）。
   *
   * ⚠️ 它**不参与实时路由**：那条路由是**每条连接各自**的（`server.js` 的
   *    `onStream` 按自己那条连接的焦点挑事件）。这里这一份只为**第 16 条**服务
   *    （`96-OWNER-DECISIONS.md`：指称与焦点不一致 ⇒ 先反问）：
   *    `/api/say` 是**另一条路**（HTTP），它看不到那条连接，只能问这一份。
   * ⚠️ 多台设备同时连时它是**最后被告知的那一个**（C 期如实如此，
   *    D 期的"焦点告知"再细分）；不一致时按第 16 条**反问**，不猜。
   * `null` = **从来没被告知过**（老客户端 / 还没连流）⇒ 不做比较，老行为不动。
   */
  #focusScope = null;

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
    // ★ P1：**后台通知**——房间也接同一个（一个人一本账），
    //   与 `#notice`（只挂主线）分开，理由见 `Session.#workNotice`。
    this.#workNotice = args.workNotice ?? args.notice ?? null;
    // ★ P1：**一个人一本活账 / 一本承诺账**（房间与主线共用 —— P-l 是"一条日志"，
    //   逐件账也一样：多 scope 只是记录上的 `scopeId` 标签）。
    this.#work = args.work ?? null;
    this.#promises = args.promises ?? null;
    this.#titles = new Map();
    if (args.whereTitle) this.#titles.set(this.#mainScope, args.whereTitle);
    this.#backgroundAfterMs = args.backgroundAfterMs ?? BACKGROUND_AFTER_MS;
    // ★ 93 §5.2·A：用量账（一个人一份）。主线与会话都从这里拿同一个回调。
    this.#onUsage = args.onUsage ?? null;
    // ★ P2-8：出网留痕同理（一个人一份，房间里的出网也记到同一个人头上）。
    this.#onEgress = args.onEgress ?? null;
    // ★ **D 期：转交 / 焦点 / 未读**（一个人各一份；见各字段的说明）。
    this.#handoffs = args.handoffs ?? null;
    // ★ **派活**（契约 102）：那本简登记 ＋ "建一间"那一刀（都由 `Worlds` 给）。
    this.#jobs = args.jobs ?? null;
    this.#startScope = typeof args.startScope === 'function' ? args.startScope : null;
    // ★ **契约 108**：那帧问话等他多久（判据要能把它调小）。
    this.#jobAskTimeoutMs =
      Number.isFinite(args.jobAskTimeoutMs) && args.jobAskTimeoutMs > 0
        ? args.jobAskTimeoutMs
        : JOB_ASK_TIMEOUT_MS;
    this.#scopeExists = typeof args.scopeExists === 'function' ? args.scopeExists : () => false;
    // ★ **D 期**：目标那一间"存在但还没挂上来"时，由宿主把它挂上来（见字段说明）。
    this.#loadSession = typeof args.loadSession === 'function' ? args.loadSession : null;
    this.#focusBook = args.focusBook ?? null;
    this.#unread = args.unread ?? null;
    const main = new Session({ ...args, work: this.#work, promises: this.#promises });
    this.#sessions.set(main.scopeId, main);
  }

  /** 这个用户手上有几条会话（主线 ＋ 每个房间）。 */
  get sessionCount() {
    return this.#sessions.size;
  }

  /**
   * ★ **C 期：这个用户最近一次被告知的焦点**（`null` = 从来没告知过）。
   *
   * 判据：`/api/say` 的"归处提示"和它不一致时就**先反问**（第 16 条）。
   *
   * ⚠️ **D 期之后它仍然只回答"最后被告知的那一个"**（C 期原样）——
   *    要按**设备**答准，用 `focusFor(device)`（判据 D-9）。两条并存是刻意的：
   *    老客户端不带设备标识 ⇒ 走这一条，行为一个字不变。
   */
  get focusScope() {
    return this.#focusScope;
  }

  /**
   * ★ **告知焦点**（`server.js` 的 `onStream` 调：连上时按 `?scope=`，之后按 `focus` 帧）。
   *
   * ⚠️ 缺省 / 空 ⇒ 主线（老客户端不带 scope 就是主线）。
   * ⚠️ 这里**不校验**"这个房间存不存在"：那是 `worlds.roomFor()` 的事，
   *    焦点帧那条路已经先过了它（不存在的房间回 `ok:false`、焦点不动）。
   *
   * ★ **D 期（§6.1·补）**：多一个**可选**的 `device`。
   *   · 给了 ⇒ **按设备各记一份**（`FocusBook` 落盘）；
   *   · 没给 ⇒ 照旧只更新 C 期那一份（**老行为一个字不变**）。
   */
  setFocus(scope, device = null) {
    const s = scope === null || scope === undefined || scope === '' ? this.#mainScope : String(scope);
    const d = typeof device === 'string' ? device.trim() : '';
    if (d !== '') {
      try {
        this.#focusBook?.set?.(d, s);
      } catch {
        /* 焦点是旁路：记不下也不许把这条连接/这句话带走 */
      }
    } else {
      // ⚠️ **只有不带设备标识才动 C 期那一份** —— 让"按设备记"与
      //    "最后被告知的那一个"互不污染（D-9：不许拿最新那台顶替）。
      this.#focusScope = s;
    }
    return s;
  }

  /** ★ **D 期：未读那本账**（判据/诊断用；没有 ⇒ `null`）。 */
  get unread() {
    return this.#unread;
  }

  /**
   * ★ **D 期：哪些图标该带点**（判据 D-6 的正面 · 服务端答得出"有未读"）。
   * @returns {Array<{scopeId: string, lastSeq: number, lastReadSeq: number}>}
   */
  unreadScopes() {
    try {
      return this.#unread?.list?.() ?? [];
    } catch {
      return [];
    }
  }

  /**
   * ★ **D 期：他打开过那一间** ⇒ 点没了（判据 D-6 的反面）。
   * @param {string} scope
   * @returns {boolean}
   */
  markRead(scope) {
    if (!this.#unread) return false;
    try {
      this.#unread.markRead(scope);
      return true;
    } catch {
      return false;
    }
  }

  /** ★ **D 期：这一间还有没有没看过的**（单间查询的出口）。 */
  unreadOf(scope) {
    try {
      return this.#unread?.unreadOf?.(scope) ?? null;
    } catch {
      return null;
    }
  }

  /** ★ **D 期：转交那本账**（判据/诊断用；没有 ⇒ `null`）。 */
  get handoffs() {
    return this.#handoffs;
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
  addSession({ scope, timeline, agentKey, notice = null, mainLeak = null, onAuthFailure = null, whereTitle = null }) {
    const id = scope === null || scope === undefined || scope === '' ? this.#mainScope : String(scope);
    const had = this.#sessions.get(id);
    if (had) return had;
    if (whereTitle) this.#titles.set(id, whereTitle);
    const s = new Session({
      timeline,
      runtime: this.#runtime,
      store: this.#store,
      scopeId: id,
      agentKey,
      // ⚠️ 房间**不接**通知那本账 / 「发现就报」：那两样只挂主线（与改前一致）
      notice: id === this.#mainScope ? (notice ?? this.#notice) : null,
      // ★ P1：**后台那几句房间也接**（一个人一本账；它不占 `(turn,kind)` 那本通道账）。
      workNotice: this.#workNotice,
      mainLeak: id === this.#mainScope ? (mainLeak ?? this.#mainLeak) : null,
      onAuthFailure: onAuthFailure ?? this.#onAuthFailure,
      // ⚠️ recap / 超时**跟着这个世界**走（`Worlds` 建调度器时已经算好了）。
      recap: this.#recapOptions,
      turnDeadlineMs: this.#turnDeadlineMs,
      // ★ P1：活账 / 承诺账是**一个人一本**（房间共用）；标题只影响"去哪看"那半句。
      work: this.#work,
      promises: this.#promises,
      whereTitle: this.#titles.get(id) ?? null,
      backgroundAfterMs: this.#backgroundAfterMs,
      // ★ 93 §5.2·A：**每一个房间**的用量都记到它自己的 scope 头上。
      onUsage: this.#onUsage,
      // ★ P2-8：**每一个房间**的出网痕迹都记到同一个人头上（留痕只分人，不分房间）。
      onEgress: this.#onEgress,
    });
    this.#sessions.set(id, s);
    return s;
  }

  /**
   * ★ P1：**他随时能问"那件怎么样了"**（契约 §三.④）——按 scope ＋ 票/轮逐件答。
   * 认不出 scope ⇒ `null`（不许悄悄落到主线）。
   */
  workReport({ scope = null, ref = null, turn = null, generation = null } = {}) {
    const s = this.sessionFor(scope);
    if (!s) return null;
    return s.workReport({ scopeId: s.scopeId, ref, turn, generation });
  }

  /** ★ P1：**逐件**列出还开着的活（判据与聚合状态都用它）。 */
  workItems() {
    const out = [];
    for (const s of this.#sessions.values()) out.push(...s.workItems);
    return out;
  }

  /**
   * ★ P1 §三④：**一次把挂着的每一件都答成人话**（"那件怎么样了"那条出口用）。
   *
   * 与 `workReport()` 的关系：那个**按票/轮答一件**（而且认不出就 `null`）；
   * 这个**逐件都答**，每件一条 —— 给模型的是**人话**（`workAnswerLine` ＋
   * "在哪一间"那半句用的是**那一间的名字**），所以它转述给用户时**不会**
   * 把内部 id 抄出去（`06` 禁用词那条）。
   *
   * 🔴 **`excludeScope` 那一条不能省**：账本那支工具是在**某一轮里**被调的
   * ⇒"正在问的那一轮"自己也在账上（`running`）⇒ 不排掉就永远是
   * "那件还在做"，而那件**就是这句提问**（真机第一次就是这么答的）。
   * 只排**问话那一间**的正在跑的那一轮：别的房间挂着的活**照报**（那正是他要问的）。
   *
   * ⚠️ **一件都没有 ⇒ 空数组**（不是空话）：调用方自己决定怎么说"没有"。
   * ⚠️ 认不出 scope 的那些件（会话已经卸了）**照样列出来**，答案用 `unknown`
   * —— 它们**确实**在这本账上，不许因为"说不清"就当没有。
   *
   * @param {object} [o]
   * @param {string|null} [o.excludeScope] 问话那一间（`null` = 不排任何一件）
   */
  workList({ excludeScope = null } = {}) {
    const out = [];
    for (const it of this.workItems()) {
      const scopeOfIt = it.scopeId ?? 'main';
      if (excludeScope !== null && scopeOfIt === excludeScope) {
        const s = this.sessionFor(excludeScope);
        // ★ 正在问的那一轮：**两种形态都要排** ——
        //   ① 还没轮到跑的（`waiting`，`(gen,turn)` 还是 null）⇒ 按"哪句话引起来的"排；
        //   ② 正在跑的 ⇒ 按 `(generation, turn)` 排。
        if (it.ref && s?.openTurnRefs?.has(it.ref)) continue;
        if (s?.isTurnOpen?.(it.generation, it.turn)) continue;
      }
      const s = this.sessionFor(scopeOfIt);
      const text = s
        ? s.workReport({ scopeId: scopeOfIt, ref: it.ref ?? null, turn: it.turn ?? null })
        : workAnswerLine('unknown');
      out.push({ ...it, text: text ?? workAnswerLine('unknown') });
    }
    return out;
  }

  /** ★ P1：承诺账（诊断 / 判据）。 */
  get promises() {
    return this.#promises;
  }

  /** ★ P1：活账（诊断 / 判据）。 */
  get work() {
    return this.#work;
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

  /**
   * ★ **某一间这一轮他说了什么**（`null` = 认不出那一间）。
   *
   * 🔴 为什么要有它：P1-22"他明说才许写"那条闸原来只从 `turnInput`（**主线那一间**）
   *    取 ⇒ 他在**某个小程序的房间里**说"帮我做一个…"时，那条闸读到的是**主线**
   *    那份（多半是空的）⇒ **误拒**。造东西那条工具口现在按 `req.scope` 问这一句
   *    （`apps-socket.js` 的 `ctx.turnInputFor`），源头就是这里。
   * ⚠️ `turnInput` 那个老接口**一个字没动**（它照旧只答主线 —— `scope-single-log`
   *    那条判据钉着它）。
   */
  turnInputOf(scope = null) {
    const s = this.sessionFor(scope);
    return s ? s.turnInput : null;
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
    /** ★ P1：**逐件**那本账（不只一个布尔 · 契约 §一.1）。 */
    const items = [];
    for (const s of this.#sessions.values()) {
      pending += s.pendingDeliveries;
      turns += s.armedDeadlines;
      openMessageId ??= s.openMessageId;
      items.push(...s.workItems);
    }
    return { openMessageId, pending, turns, items };
  }

  // ── ★ D 期：转交（契约 `100` §二① / 判据 D-1…D-4）────────────────

  /**
   * **发起转交**（只有工具调用会走到这儿 —— 这就是 D-1 的结构性落点）。
   *
   * 顺序是死的，别调：
   *   ① 目标**已存在**（D-3：**不建**）；
   *   ② 这条消息上**已经有一条转交记录** ⇒ 拒（D-2 前半：一轮最多一次）；
   *   ③ 目标**已经在链上出现过** ⇒ 拒（D-2 后半：禁回环，手册点名 `A→B→A`）；
   *   ④ 发起那条消息 **不收口**，只打 `message/handoff`（D-4 前半 · D-8）；
   *   ⑤ 组装交接包 → 投给目标（D-4 后半：**同一个 `messageId`**）。
   *
   * ⚠️ **发起者那条消息由谁收口**：由**接活的那一轮**（`handoffDelivery` 里
   *    投递之前先 `adoptHandoff()`）。所以这里**绝不** `end()` —— `end()` 就是
   *    "挪走"那个反例（D-8）。
   *
   * @param {object} o
   * @param {string} o.by        发起那一间（**用户看得见的那一间**）
   * @param {string} o.target    想转给哪一间
   * @param {string} [o.messageId] 这次转交挂在哪条消息上（**必须有**）
   * @param {string} [o.reason]  为什么转（模型给的；可以没有）
   * @returns {{ok: boolean, error?: string, text?: string, id?: string, target?: string, duplicate?: boolean}}
   */
  handoffTo({ by, target, messageId = null, reason = null } = {}) {
    const from = this.sessionFor(by);
    if (!from) return { ok: false, error: 'no-such-scope', text: '认不出是哪一间要转。' };
    if (!this.#handoffs) {
      return { ok: false, error: 'no-handoff-book', text: '这一台还没接上转交那本账，转不了。' };
    }
    const t = typeof target === 'string' ? target.trim() : '';
    // ★ **哪条消息**（D-4 要的是"同一个 messageId"）：以**服务端手上那条**为准。
    //   `N22` 保证"同一时刻最多一条未收口" ⇒ 它就是用户正在看的那一个气泡。
    //   ⚠️ 模型那边**一个字都还没说**时（光调工具）⇒ 现开一个口（**只开口、不编正文**）：
    //      不这么做就没有"同一条消息"可谈，B 的续写会变成另起一条（D-4 的反例）。
    //   ⚠️ 调用方给的那个 `messageId` 只当**兜底**（老调用方兼容）；模型**给不出**
    //      我们的气泡 id，那条工具口传的也是 `null`。
    //
    // ★ **锚点优先级**（D-4 要的是"同一条气泡"，所以顺序不许随手动）：
    //   ① 这一轮**已经在写**的那条（`liveTurn`）—— **就是客户端那个气泡**；
    //   ② 已经在链上 ⇒ 用链的锚（"我接着写的那条"，第二跳从这里才查得出环）；
    //   ③ 手上那条开口的（`openMessageId`）；
    //   ④ 都认不出 ⇒ 现造一个（`announceHandoff` 会给它开口，只开口不编正文）。
    const chain = this.#activeChainOf(from.scopeId);
    const live = from.liveWriter;
    let msgId = live?.messageId ?? chain?.messageId ?? from.openMessageId ?? null;
    if (msgId === null && typeof messageId === 'string' && messageId !== '') msgId = messageId;
    if (msgId === null) msgId = newMessageId();
    // ① 目标存在吗（**不建** —— D-3）
    let exists = false;
    try {
      exists = this.#scopeExists(t) === true;
    } catch {
      exists = false;
    }
    // ★ **链上到过哪些间**（不只看这条消息上的记录，还要**顺着链走**
    //   —— 手册点名的 `A→B→A` 就是第二跳）。
    const records = this.#chainHistory(msgId);
    // ★ **重复调用先认**（**同一间**把这条链又转一次）：如实回"已经转出去了"——
    //   与别处的幂等回执同形，不制造第二个副作用。
    //   ⚠️ 顺序有意：它要排在"一轮最多一次"（`twice`）**前面** —— 同一条链上
    //      "我又转了一次"和"这条已经转出去过了"是同一件事，前者是**幂等回执**，
    //      后者是**拒**；先判后一个会把幂等回执变成报错（判据 D-2 抓到了这个）。
    //   ⚠️ 认的是"**我**转出去的"（`r.scopeId === from.scopeId`），不是"目标一样"：
    //      同一条链上换个人转给同一间是**另一件事**（它走下面的裁决）。
    const mine = records.find((r) => r.scopeId === from.scopeId);
    if (mine) {
      return { ok: true, duplicate: true, id: mine.id, target: mine.target };
    }
    const verdict = decideHandoff({ by: from.scopeId, target: t, targetExists: exists, messageId: msgId, records });
    if (!verdict.ok) {
      return { ok: false, error: verdict.reason, text: verdict.text };
    }
    const rec = this.#handoffs.record({
      scopeId: from.scopeId,
      target: t,
      messageId: msgId,
      reason,
      turn: from.turn,
      generation: from.generation,
    });
    // ④ 那条消息**不收口**，只打一个状态（客户端显示"马上说完"）+ 交给 B
    from.announceHandoff({ messageId: msgId, reason, to: t, scopeId: from.scopeId });
    // ⑤ 目标那一轮排上（**排着**：同一个用户同时只能有一笔在飞）
    this.#handoffChain = this.#handoffChain
      .then(() => this.#handoffDelivery(rec))
      .catch(() => {});
    return { ok: true, duplicate: false, id: rec.id, target: t };
  }

  /**
   * ★ **这条转交链上到过哪些间**（判据 D-2 要的那份凭据）。
   *
   * 🔴 为什么不能只看"这条消息上的记录"：一条链跨好几间，而**每一跳的发起处
   *    都可能换人**（甲转给乙、乙又转给丙）—— 从**发起那条消息**出发走一遍，
   *    才看得见整条链。手册点名的 `A→B→A` 正是"走第二跳时才看得见"的那个环。
   *
   * ⚠️ 认不出 ⇒ 空数组（那是**一条新链**：谁都没转过）。
   */
  #chainHistory(messageId) {
    if (!this.#handoffs || typeof messageId !== 'string' || messageId === '') return [];
    // ① 从这条消息**往上**找到链的锚（它可能是**半路**那条：这一间只记得
    //    "我接过的那条"，而链的起点在**前面**那一跳手上）。
    const anchor = this.#handoffAnchorOf(messageId);
    const out = [];
    const seen = new Set();
    let at = anchor;
    // 链最长有限（每一跳都要求"发起处还没转过"），所以这个循环一定收敛；
    // 仍加一道保险：认不出的记录一律停住（不许转圈）。
    for (let i = 0; i < 64; i += 1) {
      const here = this.#handoffs.byMessage(at);
      if (here.length === 0) break;
      const last = here[here.length - 1];
      if (!last || typeof last.id !== 'string' || seen.has(last.id)) break;
      seen.add(last.id);
      for (const r of here) out.push(r);
      if (typeof last.target !== 'string' || last.target === '') break;
      at = last.target;
    }
    return out;
  }

  /**
   * 这条链的**锚**（= 发起那一间那条消息）。
   *
   * ⚠️ 为什么它可能不是"手上这条"：**第二跳**的发起者手里是**自己的**一条消息，
   *    而这条链的锚在**发起处**那条记录上 —— 从"我接过的那条"倒着找回去。
   * 认不出 ⇒ 这条消息自己就是锚。
   */
  #handoffAnchorOf(messageId) {
    if (typeof messageId !== 'string' || messageId === '') return messageId;
    const asTarget = this.#handoffs
      .all()
      .filter((r) => r.target === messageId && typeof r.messageId === 'string' && r.messageId !== '')
      .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    if (asTarget.length === 0) return messageId;
    const first = asTarget[0];
    if (first.messageId === messageId) return messageId; // 自指：不许转圈
    return this.#handoffAnchorOf(first.messageId);
  }

  /**
   * ★ **这一间现在挂在哪条转交链上**（它是发起处、还没收口的那一条）。
   *
   * 为什么需要：一条转交链跨好几间，而**每一间手里那条消息不是同一条**
   * （甲那条是"他问的那件事"，乙那边接着写的也是甲那条）——
   * 第二跳要从**发起处**那条记录去查"这条链上还有谁"
   * （否则回环与"一轮最多一次"在第二跳上失效）。
   * ⚠️ 认不出 ⇒ `null`（那就是一条**新**链，锚点用自己手上那条消息）。
   */
  /**
   * ★ **这一间挂在哪条转交链上**（发起处或接活的下一跳 —— 两边都要认）。
   *
   * 🔴 为什么**不看状态**：链一旦建立，历史就留在盘上了 —— 第二跳
   *    （手册点名的 `A→B→A`）来的时候，第一跳那条记录早已 `completed`
   *    （目标早接过去了）。拿状态过滤 ⇒ **回环与"一轮最多一次"在第二跳上
   *    当场失效**（判据 D-2 就是这么抓到的）。
   * ⚠️ 认不出 ⇒ `null`（那就是**一条新链**，锚点用自己手上那条消息）。
   */
  #activeChainOf(scope) {
    if (!this.#handoffs) return null;
    const all = this.#handoffs.all();
    // 我发起的 / 我接过的，都算"我在链上"（取**最后**一条：链是往前的）
    const mine = all.filter((r) => r.scopeId === scope || r.target === scope);
    return mine.length > 0 ? mine[mine.length - 1] : null;
  }

  /** 把一次转交**真的投给目标那一间**。 */
  async #handoffDelivery(rec) {
    const from = this.sessionFor(rec.scopeId) ?? this.#main;
    // ★ **目标那一间可能"存在、但还没挂上来"**（他还没点开过那个图标 ⇒
    //   会话还没建）。那也算已存在（`scopeExists` 已经过了 —— 它在工作区/制品库里）
    //   ⇒ 叫宿主把它**挂上来**（`Worlds.roomFor`：只认**本来就该在**的那一间；
    //     **不存在**的那些在上面那一步就被拒了 —— D-3 拒的正是它们）。
    let to = this.sessionFor(rec.target);
    if (!to && typeof this.#loadSession === 'function') {
      try {
        to = this.#loadSession(rec.target);
      } catch (err) {
        from?.noteError(`转交那一间没挂上来：${err?.message ?? err}`);
      }
    }
    if (!to) {
      // 真认不出（宿主没接这条口 / 那一间就是不在）⇒ **不建**，如实记一笔。
      if (from) from.noteError(`转交没送出去：没有这一间的会话（${rec.target}）`);
      return;
    }
    // ★ **上下文摘要在发起那一间读**（"他刚说过的话"在**那一间**的视图里 ——
    //   目标那一间自己的视图里没有它）。读不到 ⇒ 不带那半句（**不编**）。
    let brief = '';
    try {
      brief = from?.brief?.() ?? '';
    } catch {
      brief = '';
    }
    await to.handoffDelivery(rec, {
      openWriterOf: (id) => from?.openWriterFor?.(id) ?? null,
      brief,
    });
    // ★ **谁在干活落盘**（审计/用量 · §6.2）：`scopeId` **不动**（可见那一间），
    //   `byScope` 记的是**真接过这件活的**那一间。
    this.#handoffs?.adopt({ id: rec.id, byScope: rec.target });
    this.#handoffs?.complete({ id: rec.id });
  }

  // ── ★ **派活**（契约 `docs/dev/102-APP-BIRTH-SCOPE.md` · 主人 2026-09-25 拍「乙」）──
  //
  // 与**转交**的分界（契约 §三）：**转交**交给**已有**的一间（目标必须已存在）；
  // **派活**让调度器**新建**一间，把那件活交过去。两条路各自可判，互不干扰。
  //
  // ★ **契约 108 起：先问一句，答了才建**（主人 2026-09-25 拍的三条推荐项）——
  //   · `job_start` **不再同步建**：只记一笔待确认 ＋ 推一帧问话（瞬态），
  //     回给模型"已经问他了，等他答" ⇒ 那一轮就此收口（§一 第①步）；
  //   · 他点【另开一处做】⇒ `answerJobAsk({yes:true})` **这时才建**
  //     （工作区＋会话＋登记＋`job/start`）＋ 推 `scope/open`（§一 第②步）；
  //   · 他点【就在这儿做】⇒ **什么都不建**，回给他"就在这儿做"（§一 第③步）；
  //   · 超时 / 不答 ⇒ 那一笔记 `expired`、如实说一句、**不建**（§一 第④步）。

  /** ★ **派活那本简登记**（判据/诊断用；没有 ⇒ `null`）。 */
  get jobs() {
    return this.#jobs;
  }

  /** ★ **现在等着他答的那一笔**（诊断/判据用；没有 ⇒ `null`）。 */
  get pendingJobAsk() {
    return this.#ask ? { ...this.#ask, timer: undefined } : null;
  }

  /** ★ **最近一笔的下场**（`{id, where, why, status}`；`status` ∈ pending/yes/no/expired）。 */
  get lastJobAsk() {
    return this.#lastAsk ? { ...this.#lastAsk } : null;
  }

  /**
   * ★ **派活**：只**问一句**（契约 `docs/dev/108-JOB-ASK-FLOW.md` §一 第①步）。
   *
   * 顺序是死的：
   *   ① 裁决（`decideJobStart`：只有主进程能派 · 短名合法 · 不是保留名 · 那一处还没主）；
   *   ② 把这笔**记在内存里**（谁在哪一间发起的 · `where` · `why`）——**盘上一个字都不写**；
   *   ③ 推**一帧问话**（瞬态：不落盘、不占号、不重放）；
   *   ④ 回给模型"已经问他了，等他答" ⇒ 这一轮就此收口。
   *
   * 🔴 **没答之前不许建**（§一 不许破的第 1 条）：这里**没有**任何 `#startScope` 调用，
   *    也没有 `recordStart` / `job/start` —— 建那一刀全在 `answerJobAsk` 里。
   *
   * @returns {{ok:boolean, id?:string, where?:string, asked?:boolean, error?:string, reason?:string, text?:string}}
   */
  startJob({ by = null, where = null, why = null } = {}) {
    const from = this.sessionFor(by);
    if (!from) return { ok: false, error: 'no-such-scope', text: JOB_LINES.nested };
    if (!this.#jobs) return { ok: false, error: 'no-job-book', text: JOB_LINES.noBook };
    // ★ "那一处有主了吗"：裁决要它（**已存在 ⇒ 拒** —— 交给已有那一间是**转交**那件事）。
    //   认不出 / 查不动 ⇒ 当作"没有"（随后建那一刀会如实失败，见 P6）。
    let exists = false;
    try {
      exists = this.#scopeExists(where) === true;
    } catch {
      exists = false;
    }
    const verdict = decideJobStart({ by: from.scopeId, where, targetExists: exists });
    if (!verdict.ok) {
      return { ok: false, error: verdict.reason, reason: verdict.reason, text: verdict.text };
    }
    // ② **一次一件**：再来一笔就顶掉前一笔（前一笔按 `expired` 记 —— 它没有被回答）
    if (this.#ask) this.#expireAsk({ quiet: true });
    const at = Date.now();
    this.#askSeq += 1;
    const id = `j_ask_${at.toString(36)}_${this.#askSeq.toString(36)}`;
    const timer = setTimeout(() => this.#expireAsk(), this.#jobAskTimeoutMs);
    timer.unref?.();
    this.#ask = { id, where: verdict.where, why: typeof why === 'string' ? why : null, by: from.scopeId, at, timer };
    this.#lastAsk = { id, where: verdict.where, why: this.#ask.why, status: 'pending' };
    // ③ 那帧问话：**瞬态**（不落盘、不占号 ⇒ `sinceSeq=0` 的补发里永远没有它）。
    //   ⚠️ 推失败也**不许**把这笔待确认丢掉（他那一侧收不到就是收不到，
    //      到点会按 `expired` 如实收场）—— 但必须报出来。
    try {
      this.#main?.noteTransient(jobAskEvent({ id, where: verdict.where, why: this.#ask.why, at }));
    } catch (err) {
      from.noteError(`那帧问话没推出去：${err?.message ?? err}`);
    }
    return { ok: true, id, where: verdict.where, asked: true, text: JOB_LINES.asked };
  }

  /**
   * ★ **他答了**（契约 §一 第②/③步）：答"是"⇒ 这时才建；答"否"⇒ **什么都不建**。
   *
   * 🔴 **一次一件**：号对不上（超时作废 / 已经答过）⇒ 如实回一句"那件事我还没动手"，
   *    **什么都不做**（绝不猜、绝不补建）。
   *
   * @param {object} o
   * @param {string} o.id  那一笔的号（问话那帧带回来的）
   * @param {boolean} o.yes
   * @returns {{ok:boolean, yes?:boolean, where?:string, error?:string, reason?:string, text?:string}}
   */
  answerJobAsk({ id = null, yes = false } = {}) {
    const ask = this.#ask;
    if (!ask || String(id ?? '') !== ask.id) {
      return { ok: false, error: 'ask-gone', reason: 'ask-gone', text: JOB_LINES.notYet };
    }
    clearTimeout(ask.timer);
    this.#ask = null;
    const from = this.sessionFor(ask.by) ?? this.#main;
    if (yes !== true) {
      // ③ **什么都不建**；回给他"就在这儿做" ⇒ 它就在主对话里把这件事做完。
      this.#lastAsk = { id: ask.id, where: ask.where, why: ask.why, status: 'no' };
      this.#tellAgent(from, JOB_LINES.noToAgent);
      return { ok: true, yes: false, where: ask.where, text: JOB_LINES.noToAgent };
    }
    this.#lastAsk = { id: ask.id, where: ask.where, why: ask.why, status: 'yes' };
    const built = this.#buildJob(ask, from);
    if (!built.ok) {
      // 🔴 **建不成 ⇒ 如实说一句，活留在主进程**（P6 那半照旧）：
      //    告诉他"没成，我就在这儿接着做" ⇒ 主对话里那句请求**不会被吞掉**。
      this.#tellAgent(from, built.text ?? JOB_LINES.failed);
      return built;
    }
    // ② 回给主进程那位："他说另开一处做" ⇒ 它知道事已经交出去了（别自己再动一遍）。
    this.#tellAgent(from, JOB_LINES.yesToAgent);
    return { ok: true, yes: true, where: ask.where, id: built.id, text: JOB_LINES.yesToAgent };
  }

  /**
   * ★ **答【是】之后真正建那一间**（契约 §一 第②步）——**只有这一处会建**。
   *
   * 四件、顺序是死的：
   *   ① **建那一间**（工作区＋会话）——**真建**，失败了如实说（P6）；
   *   ② 由来落账（登记一行 · `JobBook.recordStart`）＋ `job/start` 落在**主进程那一间**；
   *   ③ 推 `scope/open`（**瞬态**：窗口自己跟过去 —— 既有那条路）；
   *   ④ 把**任务与由来**投给子进程（真投递、真 spawn —— P1）。
   */
  #buildJob(ask, from) {
    const where = ask.where;
    // ① **建那一间**（工作区 ＋ 会话）。建不成 ⇒ **如实说一句**，活留在主进程（P6）。
    let created = null;
    try {
      created = this.#startScope ? this.#startScope(where) : null;
    } catch (err) {
      from?.noteError(`派活那一间没建起来：${err?.message ?? err}`);
      return { ok: false, error: 'create-failed', reason: 'create-failed', text: JOB_LINES.failed };
    }
    const to = this.sessionFor(where) ?? created ?? null;
    if (!to) {
      from?.noteError(`派活那一间没挂上来（${where}）`);
      return { ok: false, error: 'create-failed', reason: 'create-failed', text: JOB_LINES.failed };
    }
    // ② 由来落账 ＋ 那一帧落在**主进程那一间**（登记由它重建 · P5）
    const at = Date.now();
    let rec;
    try {
      rec = this.#jobs.recordStart({ where, why: ask.why, at });
    } catch (err) {
      from?.noteError(`派活那件没记上账：${err?.message ?? err}`);
      // ⚠️ 登记写不下去 ⇒ **不派**（派了却查不到 = 那本账在说假话）。
      return { ok: false, error: 'record-failed', reason: 'record-failed', text: JOB_LINES.failed };
    }
    try {
      this.#main?.noteProduct({ type: JOB_START, id: rec.id, where, at });
    } catch (err) {
      // 那一帧是**登记重建**的依据：落不下去就如实记一笔（不假装它在盘上）
      from?.noteError(`派活那一帧没落盘：${err?.message ?? err}`);
    }
    // ③ **⑤：告诉他"现在看这一间"**（契约 `102` 追加）：**瞬态**，只走实时。
    //   🔴 不落盘、不占号 ⇒ `sinceSeq=0` 的补发里永远没有它（重连不会乱切房间）。
    //   ⚠️ 这一帧失败**不许**把派活本身带走（他自己点图标也照样看得到那一间）。
    try {
      this.#main?.noteTransient(scopeOpenEvent({ scope: where, at }));
    } catch (err) {
      from?.noteError(`"该看哪一间"那一帧没推出去：${err?.message ?? err}`);
    }
    // ④ 投给子进程（**排着**：同一个用户同时只有一笔派活在飞）
    this.#jobChain = this.#jobChain
      .then(() => this.#jobDelivery(to, { id: rec.id, where, why: rec.why }))
      .catch(() => {});
    return { ok: true, id: rec.id, where, text: JOB_LINES.started };
  }

  /**
   * ★ **超时 / 不答 ⇒ 那一笔作废**（契约 §一 第④步 · 判据 S4）。
   *
   * 🔴 **不许猜**：**什么都不建**、那一笔记 `expired`、如实说一句
   *    （推一帧 `job/ask-expired` 让屏上那层收掉 ＋ 一句人话）。
   */
  #expireAsk({ quiet = false } = {}) {
    const ask = this.#ask;
    if (!ask) return;
    clearTimeout(ask.timer);
    this.#ask = null;
    this.#lastAsk = { id: ask.id, where: ask.where, why: ask.why, status: 'expired' };
    if (quiet) return; // 被下一笔顶掉：不用再喊一声（他正看着新那一笔）
    try {
      this.#main?.noteTransient(jobAskExpiredEvent({ id: ask.id }));
    } catch {
      /* 推不出去也不影响"没建"这个事实 */
    }
  }

  /**
   * ★ **把一句话交回主进程那位**（答"是"/"否"之后各一句 —— 契约 §一 第②/③步）。
   *
   * ⚠️ 走的是**投递那条老路**（`Session.deliver`：真 spawn、真 prompt）——
   *    不是"在盘上写一句话"。它进去之后那一轮的回话落在**主进程那一间**。
   */
  #tellAgent(from, text) {
    const target = from ?? this.#main;
    if (!target) return;
    target.deliver(text).catch((err) => {
      target.noteError(`回给它的那句话没送出去：${err?.message ?? err}`);
    });
  }

  /**
   * ★ **子进程交回总结**（契约 §一 第③步）：把它扔回主进程。
   *
   * 三件、顺序不许反：
   *   ① **事实**落在**那一条日志**上（主进程那一间那一帧 `job/report`）——
   *      它是登记的**唯一真相**（P5：删掉登记，重扫它又对得上）；
   *   ② 登记推进（`JobBook.recordReport`：谁·什么·最后一条总结）；
   *   ③ 讲给主进程听（P1 那本 `work-*` 出口 · **不另造通道**）。
   *
   * ★ **契约 108 第④步**：他**正开着那一间** ⇒ **自动把那个东西打开**（C5）＋
   *   旁边留一句总结；**他不在那一间 ⇒ 一帧都不推**（C6：不许抢屏）。
   *
   * 🔴 **"叫什么"用 `name`（它自己交的）**，不用宿主侧的 `whereTitle`（B20）。
   * 🔴 **只回报总结**，绝不把子进程那段对话抄进来（P3）。
   *
   * @returns {{ok:boolean, where?:string, name?:string, error?:string, text?:string}}
   */
  finishJob({ by = null, name = null, summary = null } = {}) {
    const s = this.sessionFor(by);
    if (!s || s.scopeId === this.#mainScope) {
      return { ok: false, error: 'no-such-scope', text: JOB_LINES.noOpen };
    }
    if (!this.#jobs) return { ok: false, error: 'no-job-book', text: JOB_LINES.noBook };
    const open = this.#jobs.openFor(s.scopeId);
    if (!open) return { ok: false, error: 'no-open-job', text: JOB_LINES.noOpen };
    const n = typeof name === 'string' ? name.trim() : '';
    const m = typeof summary === 'string' ? summary.trim() : '';
    if (n === '' || m === '') return { ok: false, error: 'no-words', text: JOB_LINES.noWords };
    const at = Date.now();
    // ① 事实先落**那一条日志**（主进程那一间）。落不下去 ⇒ **不登记、不回报**
    //    （宁可让它重来一次，也不许主进程那本账与日志对不上）。
    try {
      this.#main?.noteProduct({ type: JOB_REPORT, id: open.id, where: s.scopeId, name: n, summary: m, at });
    } catch (err) {
      s.noteError(`交回来的那件没落盘：${err?.message ?? err}`);
      return { ok: false, error: 'write-failed', text: JOB_LINES.failed };
    }
    // ② 登记（索引）：写不下去也不影响①那条事实（重扫时会补上）
    try {
      this.#jobs.recordReport({ id: open.id, where: s.scopeId, name: n, summary: m, at });
    } catch (err) {
      s.noteError(`派活那本登记没写上：${err?.message ?? err}`);
    }
    // ③ 那条人话总结扔回主进程（它在**主进程那一间**里说话）
    s.noteJobReported();
    // ★ **B39**：这件交回来了 ⇒ 那本"我替它接了几次"的账销掉（重来一件时从零算）。
    s.clearJobNudges(s.scopeId);
    // ⚠️ 时间词：带没依据的时间词的那半句**不重复**（`jobSummaryText` 里已经滤过），
    //    所以这里不该再被闸挡下来；真被挡了也只是那句话不发，事实仍在①。
    const line = jobSummaryText({ name: n, summary: m }, { hasTimeClaim });
    this.#main?.announceJobDone(line);
    // ④ ★ **他正开着那一间 ⇒ 自动把那个东西打开**（契约 §一 第④步 · C5/C6）。
    this.#autoOpenFinished(s, line);
    return { ok: true, where: s.scopeId, name: n, text: JOB_LINES.done };
  }

  /**
   * ★ **做完自动给他看**（契约 §一 第④步 · 判据 C5/C6）。
   *
   * 🔴 **只有他正开着那一间才推**（`#focusScope` 就是他最近一次被告知在看哪一间）——
   *    他在看别处时**一帧都不许推**（抢屏 = 把他正在看的东西顶掉）。
   * 🔴 **瞬态**（`Session.noteTransient` ⇒ 帧上带 `scopeId = 那一间`）：
   *    · 只发给**正开着那一间**的那条连接（路由那一层就是按它筛的）；
   *    · **不落盘** ⇒ 那一间里**不会多出第二份总结**（一条事实一个家：
   *      那句总结的家是主进程那条 `job/report`）。
   */
  #autoOpenFinished(s, line) {
    if (typeof line !== 'string' || line.trim() === '') return;
    // 🔴 **他不在那一间 ⇒ 一帧都不推**（抢屏 = 把他正在看的东西顶掉）。
    if (this.#focusScope !== s.scopeId) return;
    try {
      s.noteTransient(appOpenEvent({ app: s.scopeId, text: line }));
    } catch (err) {
      s.noteError(`"做完给你看"那一帧没推出去：${err?.message ?? err}`);
    }
  }

  /** 把那份任务书**真投给**子进程那一间（`deliverJob` ⇒ 真 spawn、真 prompt）。 */
  async #jobDelivery(to, rec) {
    const packet = jobPacketText({ where: rec.where, why: rec.why });
    try {
      await to.deliverJob(packet, { where: rec.where });
    } catch (err) {
      to.noteError(`派过去的活没送出去：${err?.message ?? err}`);
    }
  }

  /**
   * ★ **他问"我有哪些小程序／工作区、各做到哪儿了"**（P4/P5 那条出口）。
   *
   * ⚠️ 人话**在这一侧拼**（`JobBook.humanLines()`：能用名字就用名字，
   *    **绝不**把内部短名写上屏 · `06` 禁用词那条）。
   * ⚠️ 一条都没有 ⇒ **如实说"还没有"**，不许编。
   */
  jobList() {
    if (!this.#jobs) return { ok: false, error: 'no-job-book', text: JOB_LINES.noBook };
    try {
      const r = this.#jobs.humanLines();
      return { ok: true, count: r.count, items: r.items, text: r.text };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err), text: JOB_LINES.empty };
    }
  }

  /**
   * ★ **D 期：这一间现在是谁在看**（判据 D-9）。
   *
   * 与 `focusScope`（C 期那份"最后被告知的那一个"）的区别：
   *   · 带**设备标识** ⇒ 按那台设备的说法答；那台没说 / 多台矛盾 ⇒ `known:false`；
   *   · **不带** ⇒ 老行为（`focusScope`，协议只加可选字段）。
   *
   * ⚠️ 用到它的地方**必须**在 `known:false` 时按"不知道"处理（该问就问）——
   *    那正是"拿最新那台的顶替"要修掉的病（`100` §6.1·补 最后一段）。
   *
   * @param {string|null} [device]
   * @returns {{scope: string|null, known: boolean}}
   */
  focusFor(device = null) {
    const r = resolveFocus({
      device,
      byDevice: this.#focusBook?.devices?.() ?? {},
      fallback: this.#focusScope,
    });
    return r;
  }

  /** 收工：**每一条会话**都要把话说圆（漏一条 = 那条被切断）。 */
  async shutdown() {
    // ★ **那一笔待确认不再等了**（契约 108）：进程要收了 ⇒ 计时器收掉，
    //   **什么都不建**（下次开机他再问一次就是新的一笔 —— 待确认本来就不落盘）。
    if (this.#ask) {
      clearTimeout(this.#ask.timer);
      this.#ask = null;
    }
    for (const s of this.#sessions.values()) {
      try {
        await s.shutdown();
      } catch {
        /* 一条收不干净不许影响别的 */
      }
    }
  }
}
