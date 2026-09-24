// 系统通知：**"替你做的决定 / 出事了 / 你不在时发生的事"唯一的出口**
// （批 3 第三件 · 契约 `docs/dev/29-NOTICE.md`）。
//
// ── 这一件真正难的**不是"发一条通知"** ────────────────────────
//
// 手册 `04-ROADMAP.md` §4.4 **R1.2** 点名：批 3 建系统通知时**必须合并双通道**
// ——"应声走一条通道、系统通知又建一条，**一次失败两条通道各报一次**"（通知疲劳）。
// 契约 §二 / §三② 的裁决是**分工**，不是事后去重：
//
//   **过程**（正在做 / 做到第几步） ⇒ **只走 `message/status` / `step/*`**（⑰ 已建）
//   **替你做的决定 / 出事了 / 你不在时发生的事** ⇒ **只走通知**（本模块）
//
// ⇒ 两条通道的**触发条件构造上不重叠**。本模块那个 `(turn, kind)` 账本
//    （`processSaid()` + `notice()`）就是"构造上"三个字的落点：
//    同一个 `(turn, kind)` 两条通道都说了 ⇒ **抛**（契约 §三②）。
//
// ── 为什么有**两种**通知（契约 §三① 已拍板，别再改）────────────
//
// P-k 说进程级兜底那条人话**必须走不落盘的通道**——因为**盘满正是它要报的那件事**，
// 落盘就发不出去。而主人那句"时间线里必须有那一条"在盘满时**物理上做不到**
// ⇒ 契约把它放宽成"**默认**必须有"，**例外必须自己说清**：
//
//   持久通知（`notice()`，落盘、取号）   ⇒ **默认**；时间线里那一条**就是它**
//   瞬态通知（`noticeUrgent()`）        ⇒ **只有一种情形：写盘本身失败**
//
// ⚠️ 所以 `noticeUrgent()` **要一个写盘失败的 `cause`**：不给、或者给的不是
//    写盘失败 ⇒ **抛**。它看起来像"省事的快捷通道"，其实**不是**——
//    它是 P-k 那条"盘满时唯一还能出去的路"，用错地方就把它变成了偷懒。
//
// ── 文案住在这儿（两半的接口）──────────────────────────────
//
// 契约 §5.1 那张表是**两半的接口**：`kind`、人话文案、有没有 `undo`。
// ⚠️ `text` **一律由服务端给、客户端照抄**（和 `28-DELETE.md` 那张清单同一条规矩）
// ⇒ 文案必须住在一个**能被测试扫到**的地方，就是下面这张表。
// 有一条闸（`test/notice.test.js`）逐条扫它有没有内部词（工作区 / 客户端 /
// 云端 / 口令 / 连接 / 工具名…）——那是**缺陷，不是文风问题**（`AGENTS.md` §六.4）。

/** 持久通知（落盘、取号）。名字冻结：客户端按 `type` 认。 */
export const NOTICE = 'notice';
/** 瞬态通知（不落盘）。⚠️ **只准用于写盘失败**——见文件头。 */
export const NOTICE_URGENT = 'notice/urgent';

/**
 * 契约 §5.1 的五个 `kind`（**这是两半的接口**）。
 *
 * ⚠️ 加一个就要**两半一起动**（客户端那份表 + 服务端这份表），
 *    所以它是白名单而不是自由字符串。
 * ⚠️ 契约 §五 那段 jsonc 注释里写的是 `resume`，而 §5.1 那张表写的是
 *    `resumed` / `not-resumed`。**以 §5.1 为准**（§5.1 才是"两半的接口"那张表）——
 *    这一处偏离记在 `docs/dev/` 的落地报告里。
 */
export const NOTICE_KINDS = Object.freeze([
  'resumed',
  'not-resumed',
  'expiring',
  'crash',
  'failed',
]);

/** 瞬态通知的 `kind` **只有这一个**（契约 §五）。 */
export const URGENT_KIND = 'disk-full';

/**
 * ★ P1（契约 `docs/dev/88-P1-TIME-WAIT.md` §三）：**后台那几句**的 `kind`。
 *
 * 🔴 为什么它们**不并进 `NOTICE_KINDS`**：
 *   `NOTICE_KINDS` 那五个是"**替你做的决定 / 出事了 / 你不在时发生的事**"，
 *   是**冻结的两半接口**（服务端那份表 + 客户端那份表，逐条对得上；
 *   `test/notice.test.js` 逐字钉着那五个）。后台那几句是**助手在说话**
 *   （有主体、有下文、可追问），是**另一族**。
 * ⇒ 单开一族，走**同一个 `notice` 事件形状与同一条出口**（客户端对认不出的 `kind`
 *   有 `unknown` 兜底：**那句话照旧显示**，`notice.dart` 顶上写着这条）。
 *   ⇒ 旧客户端不炸、协议字段一个都不动。
 */
export const WORK_NOTICE_KINDS = Object.freeze(['work-started', 'work-done', 'work-failed', 'work-late']);

/** 撤销：现在**只有回收站那一条**有（契约 §5.1）。动作名与客户端对齐。 */
export const UNDO_RESTORE = Object.freeze({ action: 'trash/restore', label: '拿回来' });

/**
 * 文案表（契约 §5.1，**照它抄，别自己改口气**）。
 *
 * ⚠️ 三条纪律都落在这几句上：
 *   ① **不许出现内部词**（工作区 / 客户端 / 云端 / 口令 / 连接 / 工具名…）；
 *   ② **不承诺时间**（D7.1 / D7.2 同一条纪律）——所以是"过几天"，不是"7 天后"；
 *   ③ `disk-full` 那句**必须自己说清"我没能记下来"**（契约 §三① 的**实质**）：
 *      它是**例外**，而例外不许伪装成正常。
 */
export const NOTICE_TEXTS = Object.freeze({
  // 续做：自动重来那一半。
  // ⚠️ **时态不许写成「重新做了一遍」**：这条是在**决定重做那一刻**发的
  //    （和 `task/resumed` 同时机）——投递失败时它根本没做过，那就成了盘上的假话。
  //    照仓库里既有的那句气泡（`reconcile.js` 的 `INTERRUPTED_RESUMING_LINE`
  //    写的是「我重新做一遍，做完了告诉你」）：**只说正在做的那一步**。
  resumed: '你被打断的那件事，我重新做一遍',
  // 续做：只通知不重来那一半（D10.1 保守的那一半）。
  // ⚠️ **后半句「你看一眼」不许丢**：D10.1"只通知、不自动重来"的**全部意义**
  //    就是让主人自己决定要不要再做一遍。丢了它，这条通知就只剩一句免责声明。
  'not-resumed': '那件事可能改过东西，我没有自己做 —— 你看一眼，要不要再做一遍',
  // 回收站到期前一周（`Trash.expiringSoon()`，带撤销）
  expiring: '有一条过几天会彻底删掉',
  // 崩溃 / 报警（P-k · 欠账 #22）
  crash: '刚才出了点事，我已经重来了',
  // 失败五类里"只通知"那一类：
  // ⚠️ 契约 §5.1 说 `failed` 的文案"**按那一类给**"⇒ 逐类的那几句在
  //    `FAILED_LINES`。这一句是**认不出属于哪一类**时的兜底（N10：宁可少说，
  //    不许猜）。今天分类器还不存在 —— 见文件末尾那段"接不上"的说明。
  failed: '这件事我没敢自己重来',
  // ⚠️ 瞬态那一句（唯一允许的瞬态情形）。它**自己说清**自己是个例外。
  // ⚠️ 契约 §三① 举的例句是"盘满了，这条我没能写进时间线"，而**"时间线"是
  //    禁用词**（客户端那份表里有：它是我们的模型，不是用户的话 + §一.4 要求
  //    通知文案过禁用词闸）。⇒ 取它的**实质**（盘满 + 这条没留下来）、不用它的字面：
  //    这一处偏离记在落地报告里。
  'disk-full': '盘满了，这条我没能记下来',
});

/**
 * 失败**五类**（决策 **D10.3**：上游不通 / OOM / 我们自己的错 / 它做不完 /
 * 等确认没等到），每一类一句人话（契约 §5.1「按那一类给」）。
 *
 * 🔴 **分类器的现状（2026-09-23 · 账 #33）—— 五类里**两**类已经有判据了**：
 *   ✅ **上游不通**：`session-translate.js` 的 `isUpstreamFailure`（只认明确的
 *      网络错码与"对面现在没法干活"的状态码）⇒ 那句话已经在**屏幕上**了。
 *   ✅ **OOM**：`oom.js` 拿**内核的 cgroup 计数**当证据（`SIGKILL` 不算证据 —— 那是猜）；
 *      只在"这一轮前后真的涨过"时 `dispatcher.js` 才用 `oom` 那一句。
 *   ⏳ **我们自己的错 / 它做不完 / 等确认没等到**：**仍然没有分类器**，理由是
 *      **拿不到能把它们分开的信号**（认不出就说，是 N10 的要求）。
 *      ⇒ 这三句今天只服务"将来有输入时直接用"，不是已经接上了。
 * ⚠️ 改动这一张表前先读 `test/auth-failure.test.js` 与 `test/oom.test.js`：
 *    那两句人话的正向判据与**负向对照**都在那儿。
 */
export const FAILED_LINES = Object.freeze({
  upstream: '外面那条路暂时不通，这件事我没能接着做',
  oom: '刚才它自己被挤掉了，这件事没做完',
  ours: '这边出了点毛病，这件事没做完',
  unfinished: '这件事它没做完',
  waiting: '有个确认一直没等到，这件事就停在那儿了',
  /** 认不出来是哪一类（**不许猜**——N10） */
  unknown: NOTICE_TEXTS.failed,
});

/** 失败原因 → 那一句人话。认不出来 ⇒ 兜底那句（**不编**）。 */
export function failedLine(reason) {
  return FAILED_LINES[reason] ?? FAILED_LINES.unknown;
}

/**
 * 限频窗口（R1.2 的"通知疲劳"：同一个 `kind` + 同一个主体，短时间内只喊一次）。
 *
 * ⚠️ **它必须比回收站那次扫描长**（`serve.js` 里是每小时一次）：
 *    短了的话，同一条过期提醒会**每小时重复一次**——那正是"通知疲劳"。
 *    6 小时是几个小时级扫描周期的余量。
 */
export const NOTICE_DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000;

export class NoticeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoticeError';
  }
}

/**
 * 这个错**看着像**写盘失败吗？
 *
 * ⚠️ 为什么把它单独拎出来：`noticeUrgent()` 只准用于这一种情形
 * （契约 §三①），所以"怎么认"必须是一个**能被测试钉住**的纯函数。
 * 认不出来 ⇒ **不许**走瞬态（宁可当普通错误上抛，也不许拿瞬态当偷懒通道）。
 *
 * 先看 `StoreError` 那句固定的话（`落盘失败（main）：…`），再看底层的
 * `code`（ENOSPC 等盘满/配额/IO 的错）。**顺 cause 链看**：`store.append`
 * 会把真正的原因放在 `cause` 上。
 */
export function isWriteFailure(err) {
  let text = '';
  let cur = err;
  for (let depth = 0; cur && depth < 8; depth += 1) {
    text += `${cur?.name ?? ''} ${cur?.message ?? String(cur)} ${cur?.code ?? ''} `;
    if (cur?.cause === cur) break;
    cur = cur?.cause;
  }
  return /ENOSPC|落盘失败|no space|EDQUOT|EFBIG|EIO/i.test(text);
}

/** 一组 id 的稳定键（顺序无关：同一件事传成两种顺序要认成同一件）。 */
const idsKey = (ids) => [...ids].sort().join('\u0000');

export class Notice {
  #timeline;
  #now;
  #windowMs;
  #log;
  /** key → 这条通知**上一次**是什么时候说的（限频用） */
  #recent = new Map();
  /**
   * `(turn, kind)` → 这件事**走过哪条通道**（`process` / `notice`）。
   *
   * 契约 §二 / §三②：**同一件事只走一条通道**。"同一件事"的键是
   * `(轮, 这是什么)` —— 过程通道（`message/status` / `step/*`）与通知通道
   * 各自报一次自己的那一份；两边都报同一个键 ⇒ **抛**。
   *
   * ⚠️ 它在内存里（进程内）。这是**判断**，不是**记录**：
   *    盘上的权威是事件流本身（`notice` 事件里没有 `turn`，见 §五 的形状冻结）。
   */
  #channel = new Map();

  /**
   * @param {object} o
   * @param {import('./timeline.js').Timeline} o.timeline 通知的唯一出口
   * @param {import('./store.js').Store} [o.store] 给了它就能**从盘上恢复限频账**
   *        （不给 ⇒ 重启之后同一件事可能再喊一次；给了才叫"重启还记得"）
   * @param {string} [o.timelineId]
   * @param {() => number} [o.now]
   * @param {number} [o.windowMs]
   * @param {(...a: any[]) => void} [o.log]
   */
  constructor({ timeline, store = null, timelineId = 'main', now = Date.now, windowMs = NOTICE_DEDUP_WINDOW_MS, log = () => {} }) {
    if (!timeline) throw new NoticeError('notice 需要 timeline（通知只有这一个出口）');
    this.#timeline = timeline;
    this.#now = now;
    this.#windowMs = windowMs;
    this.#log = log;
    if (store) this.seed(store, timelineId);
  }

  get windowMs() {
    return this.#windowMs;
  }

  /**
   * **从盘上恢复限频账**：重启不该把同一件事再喊一遍（那是通知疲劳）。
   *
   * ⚠️ 主体的键**只能从落盘的字段推**：契约 §五 的形状是冻结的
   *    （`{type, kind, text, at, undo}`，**没有** subject 字段），
   *    所以这里用"撤销那一组 id"（有的话）或者"那句话本身"当主体。
   *    这也是为什么 `notice()` 不接受调用方自定的 subject ——
   *    两处算法必须**同一个**，不然"重启前记的"和"重启后查的"对不上。
   */
  seed(store, timelineId = 'main') {
    this.#recent.clear();
    let events;
    try {
      events = store.readAll(timelineId);
    } catch (err) {
      // 读不出来 ⇒ 限频账是空的（宁可多喊一次，也不能因为读不到就不出声）
      this.#log(`[notice] 限频账没读出来：${err?.message ?? err}`);
      return this;
    }
    for (const e of events) {
      if (e?.type !== NOTICE) continue;
      const key = this.#keyOf(e.kind, subjectOf(e));
      const at = typeof e.at === 'number' ? e.at : 0;
      if ((this.#recent.get(key) ?? 0) < at) this.#recent.set(key, at);
    }
    return this;
  }

  /** 这件事**上一次**是什么时候在通知通道上说的（`null` = 没说过）。 */
  lastSaidAt(kind, subject) {
    return this.#recent.get(this.#keyOf(kind, subject)) ?? null;
  }

  /**
   * **过程通道就这件事说过了** ⇒ 记一笔（契约 §三②）。
   *
   * ⚠️ 调用点是**产生 `message/status` / `step/*` 的那两处**
   *    （`dispatcher.#announceTurn` 与 `session-translate` 的收口）——
   *    闸要打**在真的东西上**，不是只在测试里摆一个账本。
   *    它**只记账、不发事件**：发事件是调用方的事（它才知道字段长什么样）。
   *
   * @param {object} o
   * @param {number} o.turn
   * @param {string} o.kind 这件事是什么（过程通道那边用它自己的名字，如 `started` / `failed`）
   */
  processSaid({ turn, kind }) {
    this.#claim(turn, kind, 'process');
  }

  /** 这件事走过哪条通道（`process` / `notice` / `null`）。给闸与排障看。 */
  channelOf(turn, kind) {
    return this.#channel.get(this.#key(turn, kind)) ?? null;
  }

  /**
   * ★ P1：**后台那几句**（契约 `88` §三）—— 与 `notice()` 同一条出口、同一个形状，
   * 只是 `kind` 换成了 `WORK_NOTICE_KINDS` 那一族。
   *
   * ⚠️ **不做限频**：一条活**构造上**只发一条开场 / 一条收尾（它自己那本活账兜着，
   *    见 `dispatcher.js` 的 `#backgroundTurns`）——再用"6 小时内同一句话只说一次"
   *    去压它，就会出现"这件做完了却没提醒"（那正是 T4 要挡的静默）。
   * ⚠️ **不占 `(turn, kind)` 那本通道账**：那本账的键是**轮号**，而轮号在每个
   *    scope 里各从 1 起 —— 拿它当跨 scope 的键会互相顶掉。
   *
   * @param {object} o
   * @param {string} o.kind `WORK_NOTICE_KINDS` 里的一个
   * @param {string} o.text 人话（**已经过时间词闸**，见 `dispatcher.#sayProactive`）
   * @returns {object} 落盘成功的事件
   */
  work({ kind, text } = {}) {
    if (!WORK_NOTICE_KINDS.includes(kind)) {
      throw new NoticeError(
        `认不出的后台通知种类：${kind}（这一族只有 ${WORK_NOTICE_KINDS.join(' / ')}）`,
      );
    }
    if (typeof text !== 'string' || text === '') throw new NoticeError('通知必须有话说');
    const at = this.#now();
    return this.#timeline.emit({ type: NOTICE, kind, text, at });
  }

  /**
   * **持久通知**（落盘、取号）——时间线里那一条**就是它**。
   *
   * ⚠️ **落盘失败照抛**（`store.append` 的契约：写失败绝不吞）。
   *    调用方**不许逐处 try**（手册 §5.2）——它要上到进程级兜底，
   *    由那儿发一条瞬态通知再有序退出。
   *    唯一的例外是"报平安"那条崩溃通知：写盘失败时**它自己**知道
   *    该退回瞬态（见 `noticeOrUrgent()`）。
   *
   * ⚠️ **没有 `turn` 这个字段**（契约 §五 的形状冻结）：`turn` 只是**内部**的
   *    账本键，用来和过程通道对账，**不进事件**。
   *
   * @param {object} o
   * @param {string} o.kind    `NOTICE_KINDS` 里的一个
   * @param {string} o.text    人话（不传就用表里那一句）
   * @param {object} [o.undo]  `{label, action, messageIds}`（可以没有）
   * @param {number} [o.turn]  内部对账用（不落盘）
   * @returns {object|null} 落盘成功的事件；被限频挡掉 ⇒ `null`
   */
  notice({ kind, text = NOTICE_TEXTS[kind], undo, turn = null } = {}) {
    if (!NOTICE_KINDS.includes(kind)) {
      throw new NoticeError(`认不出的通知种类：${kind}（两半的接口是冻结的，加一个要两半一起动）`);
    }
    if (typeof text !== 'string' || text === '') throw new NoticeError('通知必须有话说');
    if (undo !== undefined) validateUndo(undo, kind);

    const at = this.#now();
    const subject = subjectOf({ kind, text, undo });
    if (this.#suppressed(kind, subject, at)) return null;

    // ★ **先对账再开口**：同一个 `(turn, kind)` 已经在过程通道上说过 ⇒ 这里抛，
    //   一个字都不落盘（契约 §三②：同一件事只走一条通道）。
    if (turn !== null) this.#claim(turn, kind, 'notice');

    // ⚠️ `at` **由这里给**（而不是让 `Timeline` 自己取时钟）：限频账是按
    //    "我上一次是什么时候说的"算的，两处必须是**同一个刻度**——
    //    否则重启之后从盘上恢复的 `at` 和内存里的 `now` 对不上，限频就废了。
    const event = { type: NOTICE, kind, text, at, ...(undo ? { undo } : {}) };
    let full;
    try {
      full = this.#timeline.emit(event);
    } catch (err) {
      // 没落盘 ⇒ 账也要退回去（号由 `Timeline.emit` 退）：下一个事件
      // 不能因为这条"说过但没落盘"的通知而以为它说过了。
      if (turn !== null) this.#channel.delete(this.#key(turn, kind));
      throw err;
    }
    this.#recent.set(this.#keyOf(kind, subject), at);
    return full;
  }

  /**
   * **落盘优先，写盘失败才退回瞬态**（契约 §三① 的默认路径）。
   *
   * ⚠️ **别的错照抛**：它只是"盘满时那条通知还得出得去"这一个便利，
   *    **不是**"什么都兜住"。把别的错也吞进瞬态 = 拿例外当常规。
   */
  noticeOrUrgent(args) {
    try {
      return this.notice(args);
    } catch (err) {
      if (!isWriteFailure(err)) throw err;
      return this.noticeUrgent({ cause: err });
    }
  }

  /**
   * **瞬态通知**——不取号、不落盘、只推。
   *
   * ⚠️⚠️ **只准用于一种情形：写盘本身失败**（契约 §三①，主人 2026-09-21 认可）。
   *    所以这里**必须**给 `cause`（那次 `append` 抛出来的错），而且它得
   *    **看着像**写盘失败；给别的东西就抛。
   *    理由：① 拿它当省事的快捷通道就是破那条裁决；② 它存在的**唯一**理由
   *    是"盘满了"这句话**用普通通道发不出去**（那条消息自己就写不进去）。
   *
   * ⚠️ 它**不落盘** ⇒ 时间线里**没有**这一条。这正是契约说的那个例外，
   *    所以文案（`disk-full`）**自己说清**了"我没能记下来"。
   */
  noticeUrgent({ cause, kind = URGENT_KIND, text = NOTICE_TEXTS[URGENT_KIND] } = {}) {
    if (!isWriteFailure(cause)) {
      throw new NoticeError(
        'notice/urgent 只准用于**写盘失败**（契约 §三①）——必须给一个写盘失败的 cause',
      );
    }
    if (kind !== URGENT_KIND) {
      throw new NoticeError(`notice/urgent 的 kind 只有 ${URGENT_KIND} 一种（契约 §五）`);
    }
    return this.#timeline.emitTransient({ type: NOTICE_URGENT, kind, text });
  }

  // ── 内部 ──────────────────────────────────────────────────

  #key(turn, kind) {
    return `${turn}\u0000${kind}`;
  }

  #keyOf(kind, subject) {
    return `${kind}\u0000${subject}`;
  }

  /** 同一个 `(turn, kind)` 两条通道都说了 ⇒ **抛**（契约 §三②）。 */
  #claim(turn, kind, who) {
    if (typeof turn !== 'number' || typeof kind !== 'string' || kind === '') {
      throw new NoticeError('对账要有轮号与"这是什么"（两个都得给）');
    }
    const key = this.#key(turn, kind);
    const prev = this.#channel.get(key);
    if (prev !== undefined && prev !== who) {
      throw new NoticeError(
        `同一件事不许走两条通道：第 ${turn} 轮的「${kind}」已经走过「${prev}」` +
          '（契约 §二 §三②：过程只走 message/status，决定/事故只走通知）',
      );
    }
    this.#channel.set(key, who);
    return who;
  }

  /** 限频：同一个 `kind` + 同一个主体，窗口内只喊一次（R1.2 的通知疲劳）。 */
  #suppressed(kind, subject, at) {
    const last = this.#recent.get(this.#keyOf(kind, subject));
    if (last === undefined) return false;
    return at - last < this.#windowMs;
  }
}

/**
 * 一条通知的**主体**是什么（限频的键）。
 *
 * ⚠️ 只用**会落盘**的字段推：契约 §五 的形状里没有 subject，
 *    所以"撤销那一组 id"（回收站那一条）优先，没有就用那句话本身。
 *    自定义 subject 会让"重启前记的"和"重启后查的"用两套算法 ⇒ 限频失效。
 */
export function subjectOf(event) {
  const ids = event?.undo?.messageIds;
  if (Array.isArray(ids) && ids.length > 0) return idsKey(ids);
  return typeof event?.text === 'string' ? event.text : '';
}

/**
 * 撤销那一块只允许这三种形状（契约 §五）：
 * `{label, action, messageIds}`。动作名是**两半的接口**，不许自由发挥。
 */
function validateUndo(undo, kind) {
  if (!undo || typeof undo !== 'object') throw new NoticeError(`undo 得是个对象（${kind}）`);
  const { label, action, messageIds } = undo;
  if (typeof label !== 'string' || label === '') throw new NoticeError('undo 要有 label（人话）');
  if (action !== UNDO_RESTORE.action) {
    throw new NoticeError(`认不出的撤销动作：${action}（现在只有 ${UNDO_RESTORE.action}）`);
  }
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    throw new NoticeError('撤销得说清是哪一条（messageIds）');
  }
}

/**
 * 给排障用：一条事件的"这是哪一类通知"。
 * （`notice` / `notice/urgent` 以外的类型 ⇒ `null`。）
 */
export function noticeKindOf(event) {
  if (event?.type !== NOTICE && event?.type !== NOTICE_URGENT) return null;
  return event.kind ?? null;
}
