// 翻译层：agent 事件 → 产品事件（`message/*`）。
//
// 手册 `03-DEVELOPMENT.md` §5.3（轮的稳定键）、`08-SPEC.md` §4.4（D7 泄露风险）。
//
// 三条从**实测 + 事故**里来的硬约束：
//
//   ① ⚠️ **`content[].type === 'reasoning'` 绝不许变成用户能看到的话。**
//      实测：`assistant/message` 的 `message.content` 里，
//      **推理原文和正文躺在同一个数组里**：
//        [{type:'reasoning', text:'…'}, {type:'text', text:'你好。'}]
//      不按 type 过滤，**就等于把模型的思维链当正文发给用户**——
//      而它可能含系统提示片段。手册 §4.4 把这条列为"唯一有泄露风险的字段"。
//
//   ② ⚠️ **`turns` 的键是「轮」的编号，不是「当前气泡」的 id。**
//      实测：agent 直接给了 `data.turn`。
//      为什么不能用气泡 id：`handoff()` 会**原地换掉 writer**，
//      而 dispatcher 手里的 `info` 和 `translator.current` **是同一个对象**——
//      于是 `info.writer.messageId` **在它不知情的情况下变了**，
//      收口守卫从此永不匹配（手册 §5.3「收口失效」）。
//      **`turn` 号在一轮内构造上不会变**，所以拿它当键。
//
//   ③ ⚠️ **`turn/end.reason.kind !== 'completed'` ⇒ 这是半句。**
//      实测 reason 有 `kind`。手册附十一记录过一次真实事故：
//      回答被长度上限截断（`max-tokens`），而翻译层**一律写 completed**，
//      用户拿到一个"看起来说完了"的残篇。
//      ⇒ 必须补一句说明，并把它标成**失败收尾**。
//
//   ④ ⚠️ **过程事件（`step/*` · `reasoning/*`）一律走 `emitTransient()`。**
//      这一条是**泄露闸的地基**（决策 D7.4 / `08-SPEC.md` §4.4 /
//      契约 `docs/dev/26-PROCESS-LEVELS.md` §二）：
//        * `emit()` 会落盘，而**新连接 `sinceSeq=0` 会 replay 全部历史**
//          ⇒ 一条走了 `emit()` 的推理原文，**以后每一个连上来的人都能拿到**；
//        * 而推理原文**可能含系统提示词片段** ⇒ 那是 D7.4 说的核心资产。
//      ⇒ 铁律：**`reasoning/delta` 绝对不许走 `emit()`**；`step/*` 同理。
//      ⚠️ 这不是"顺手写对"的事，`test/process-level.test.js` 有两条 🔴 闸
//         钉着它（一条读盘上的日志、一条读 `sinceSeq=0` 的重放帧）。
//      ⚠️ **档位过滤不在这里做。** 翻译层把过程事件**原样推上时间线**
//         （瞬态），"发给哪条连接"由 `server.js` 按**连接级 `level`** 决定。
//         分开的理由：如果由这里看档位，档位就会影响"盘上有没有"——
//         而档位是**每条连接**的东西（契约 §二·2），不是全局开关。
//         代价要先认：过程事件会广播给所有订阅者再过闸，
//         它不占号、不落盘，量也只在"正在做"的那几秒——可以接受。
//
//   ⑤ ⚠️ **步骤的"类别"由随后的 `tool/call` 补上，而且只补不发名字。**
//      `step/start` 里没有工具名（实测），所以只靠它，第③档会是一串
//      一模一样的兜底句。契约 `26-PROCESS-LEVELS.md` §6.1 的裁决是
//      "收到 `tool/call` ⇒ 给同一个 `(turn, step)` 补一次带类别的瞬态状态"。
//      ⚠️ **工具名绝不出去**（界面上不许出现内部词）：它只是
//      `process_words.dart` 那张人话表的输入。见 `stepStateForTool()`。
//
//   ⑥ ⚠️ **一轮出事了 ⇒ 在"这件事走过哪条通道"那本账上记一笔**（批 3 第三件）。
//      契约 `docs/dev/29-NOTICE.md` §二 / §三② 的判据是**同一件事只走一条通道**：
//      过程（正在做 / 做到哪步）只走 `message/status` / `step/*`；
//      替你做的决定 / 出事了只走通知。这一层是**过程通道那一侧**的产生处
//      ⇒ 它报出去的每一件"这一轮出事了"，都要在 `Notice` 的账本上登记。
//      于是**同一个 `(turn, kind)` 两条通道都说了 ⇒ 通知那一侧会抛**。
//      ⚠️ 记账**不许挡住收口**（N19 比记账重要）：登记失败只记进
//        `#claimErrors`，见 `#claimProcess()`。真正的闸在 `notice.js` 那一边。

import { EventEmitter } from 'node:events';

import { MessageWriter } from './message-writer.js';
// ★ **P2-8：出网留痕**（主人 2026-09-25）—— 从 `tool/result` 里只取"域名/量"，
//   交给上层（`worlds.js` 那本 `EgressLog`）。**不记正文**，见 `egress-log.js`。
import { egressFromToolResult } from './egress-log.js';
import { MAX_SOURCES, sourcesFromToolResult } from './sources.js';
import { isReadOnlyTool } from './tools.js';
// ★ **失败五类那几句人话只有一处出处**（`notice.js` 的 `FAILED_LINES`）——
//   这一层要用"外面那条路不通"那一句（账 #33），但**不许在这儿再抄一份字**。
import { FAILED_LINES } from './notice.js';
// ★ **计划条**（主人 2026-09-23 要的「目标 / 任务列表」）：把 harness 自己的
//   `todo/write` 快照与 `goal/change` 翻成**人话**再发出去。**工具名 / 内部 id 不发**。
import { PLAN_EVENT, goalFromChange, planIsEmpty, todosFromWrite } from './plan.js';

/**
 * 被截断时补的那句话。
 *
 * ⚠️ **必须是人话**，而且要说清"我没说完"。
 *
 * 🔴 **2026-09-22 补第二句**（主人真机试出来的事故：让它"做一个小程序"，结果挂掉了）：
 *    原来这句话**只说"我没说完"**，然后就没了 —— 用户**既没拿到东西、也不知道该说什么**，
 *    体感就是"挂掉了"。⇒ 现在多一句**能照着做的下一步**（"回复『接着说』"）。
 *    ⚠️ 这一句**必须真的能接上**：下一轮 agent 从摘要里看得到自己那句被截断的话，
 *      "接着说"是它接得住的指令。**不许写一句照着做也没用的话**（那又是假话）。
 */
export const TRUNCATED_LINE =
  '这条我说太长了，没说完。你回一句「接着说」，我就接着上面往下讲。';
export const INTERRUPTED_LINE = '这条我没说完就断了。';
/**
 * 🔴 **钥匙不对**（上游回 401）。
 *
 * 为什么单独一句（主人 2026-09-21："apikey 是否完成也需要测试才行"那一次挖出来的）：
 * dsh 在 `turn/end` 里**把原因说得很清楚** ——
 *
 *     reason: { kind: 'error', error: { message: 'Authentication Fails, …',
 *                                      code: 'AUTH', status: 401 } }
 *
 * 而翻译层原来**一律**说 `INTERRUPTED_LINE`（"这条我没说完就断了"）。
 * ⇒ 用户看到的是一句**他没法行动**的话：听着像"我们这边抽风了，再试一次"，
 *   于是他会一遍遍重试 —— 而真正该做的是**回去把那串钥匙重新填一次**。
 *
 * ⚠️ 这是欠账里"失败分类器"最要紧的那一档：**用户自己能修的那种失败，
 *    必须说成他能修的样子。**
 * ⚠️ 用词：不许出现内部词（尤其 `模型`）。所以这里说"**钥匙**"。
 */
export const AUTH_LINE = '你填的那串钥匙它说用不了。刷新一下这一页，就能重新填。';


/**
   * 上游那一条失败，是不是"钥匙不对"。
 *
 * ⚠️ **认不出来就返回 `false`**（退回原来那句含糊的话）——
 *    宁可含糊，也不许把别的失败**说成**"钥匙不对"（那会让人白改一遍钥匙）。
 * @param {object} data `turn/end` 的 `data`
 */
export function isAuthFailure(data) {
  const err = data?.reason?.error ?? data?.reason?.failure ?? null;
  if (!err || typeof err !== 'object') return false;
  if (String(err.code ?? '').toUpperCase() === 'AUTH') return true;
  return Number(err.status) === 401;
}

/**
 * 🔴 **外面那条路不通**（账 #33 的前半 · 2026-09-23）。
 *
 * 为什么它是第二要紧的一档：用户**最可能撞上的就是它**（上游连不上 / 被限流 / 人家那边 5xx），
 * 而原来它跟"我们这边出毛病"、"你话说一半断了"**长得一模一样** ——
 * 都是一句"这条我没说完就断了"，于是用户只能一遍遍重试。
 *
 * ⚠️ **用词从 `notice.js` 来**（`FAILED_LINES.upstream`）—— 一处出处，别在这儿抄第二份。
 * ⚠️ **判据必须保守**：只认下面这些**明确表示"对面不通"**的标记；认不出 ⇒ `false`
 *    （退回那句含糊的话）。把"我们自己的错"说成"外面不通"同样是假话，只是方向相反。
 */
export const UPSTREAM_LINE = FAILED_LINES.upstream;

/** 网络 / 上游那几种**明确**的错（大小写都算）。 */
const UPSTREAM_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UPSTREAM',
  'UPSTREAM_UNAVAILABLE',
  'UPSTREAM_ERROR',
  'PROVIDER_ERROR',
]);

/** 上游那边"现在没法给你干活"的状态码。 */
const UPSTREAM_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

/**
 * 这一轮失败，是不是"外面那条路不通"。
 * @param {object} data `turn/end` 的 `data`
 */
export function isUpstreamFailure(data) {
  const err = data?.reason?.error ?? data?.reason?.failure ?? null;
  if (!err || typeof err !== 'object') return false;
  // ⚠️ **钥匙不对是另一档**（那一档要用户回去改钥匙）⇒ 先让位给它，别抢。
  if (isAuthFailure(data)) return false;
  if (UPSTREAM_CODES.has(String(err.code ?? '').toUpperCase())) return true;
  return UPSTREAM_STATUS.has(Number(err.status));
}
export const EMPTY_LINE = '这次我没能给出结论，你再说一次。';

/**
 * 卡住时补的那两句话（超时硬收口）。
 *
 * ⚠️ **必须说清"怎么办"**——手册 N11：拒绝要给人话 + **可重试**，不是静默。
 * ⚠️ **不许出现内部词**（工具 / 超时 / 服务 / 连接 / 卡死这些都不是人话）。
 */
const DEADLINE_EMPTY_LINE = '这件事我卡住了，没能给你答复。你可以再说一次。';
const DEADLINE_PARTIAL_LINE = '这条我卡住了，后面没说完。你可以让我接着说。';
/**
 * 第三种：**用户说了，但那一轮根本没轮到**。
 *
 * 实测（`/tmp/probe-queue.mjs`）：一轮还没结束时再发一句，DSH **接受并排队**
 * （`agent/inbox/spliced {target:"next-turn"}`），等这一轮结束它才变成下一轮。
 * ⇒ 超时踢掉进程时，**排队那句会跟着一起没**，而用户还在等。
 *    所以必须**逐条**给它一个交代（N19）。
 */
const DEADLINE_QUEUED_LINE = '你刚才那句我没来得及做，就卡住了。再说一次吧。';

/** 给测试用：这三句是**用户能看到的话**，所以文案本身也是验收对象。 */
export const DEADLINE_LINES = Object.freeze({
  empty: DEADLINE_EMPTY_LINE,
  partial: DEADLINE_PARTIAL_LINE,
  queued: DEADLINE_QUEUED_LINE,
});

/**
 * 工具名 → **步骤类别**（契约 `26-PROCESS-LEVELS.md` §6.1 的裁决）。
 *
 * 为什么需要它：DSH 的 `step/start` 里**没有工具名**（工具名在随后的
 * `tool/call` 上，实测）⇒ 只靠 `step/start`，第③档「步骤流水」会是
 * **一串一模一样的兜底句**，等于把这一档做成噪音。
 *
 * ⚠️ 三条不许破：
 *   ① **工具名本身绝不许出去**（界面上不许出现内部词）——这里出来的是
 *      客户端 `process_words.dart` 那张人话表的**输入**，不是名字；
 *   ② 走**瞬态**（`emitTransient`），和 `step/start` 同一条通道；
 *   ③ **认不出来就不补**（N10）：名字不是非空字符串 ⇒ `null`。
 *      名字认得出、但不在表里 ⇒ `thinking`（"在琢磨"）——那是**知道**它
 *      在干一件没归类的事，不是猜。
 */
const TOOL_STEP_STATE = Object.freeze({
  web_search: 'searching',
  web_fetch: 'searching',
  read: 'reading',
  glob: 'reading',
  grep: 'reading',
  read_image: 'reading',
  write: 'writing',
  edit: 'writing',
  bash: 'running',
});

/** 给测试用：这一步是什么类别的活。认不出来 ⇒ `null`（**不许猜**）。 */
export function stepStateForTool(name) {
  if (typeof name !== 'string' || name === '') return null;
  // `job_*`（后台作业那几个）都是"在动手做"
  if (name.startsWith('job_')) return 'running';
  return TOOL_STEP_STATE[name] ?? 'thinking';
}

export class TurnTranslator extends EventEmitter {
  #timeline;
  #scopeId;
  #turns = new Map(); // **turn 号** → 这一轮的账
  #lastTitle = null;
  /** **当前这一轮的计划**（目标 + 任务清单）：`todo/write` 是整表快照，`turn/start` 清空。 */
  #plan = { goal: null, todos: [], doneCount: 0, total: 0, more: 0 };
  #reasoningSeen = 0;
  /** 已经报过"动过东西"的轮号（一轮只报一次） */
  #mutatedTurns = new Set();
  /** `turn:step` → 工具名（`tool/result` 上没有名字，见 `#onToolCall`）。 */
  #stepTools = new Map();
  /**
   * ★ **D 期：等着被接过去的那些"半条消息"**（FIFO）。
   *
   * 🔴 为什么要**排队**而不是"投递时就绑轮号"：`turn/start` 是**目标那一侧**
   *    给的（`07-TIMEOUT.md` §一：DSH 的 `turn/start` 里没有 prompt id），
   *    而"哪一轮接哪条消息"必须**一一对上**——绑错了就是"另一半答案写进
   *    别人的气泡"（D-4 的反例）。⇒ 顺序由**投递顺序**保证（投递是排着的，
   *    见 `Dispatcher.#handoffChain`），认领发生在 `turn/start` ——
   *    那时才真的知道"来了一轮"。
   *
   * ⚠️ 只认**最早那条还没被认领的**（FIFO），与 `#delivered` 同一套纪律。
   * ⚠️ 它**不落盘**：账在 `HandoffBook` 上（那个落盘）；这里只是"这一轮接哪条"。
   */
  #adoptions = [];

  /**
   * ★ **D 期：交出去之后那条消息**（`messageId` → 一条**不收口的挂账**）。
   *
   * 用途只有一个：模型调 `handoff_to` 的那一帧**可能比 `turn/end` 慢一步**
   * （域套接字那一跳）——那时轮账已经收了，可那条消息还开着 ⇒ 谁要收它
   * （`turnDeadline` / `forceClose`）得先在账上找得到它，否则就成了
   * "永远马上说完"的气泡（N19）。**挂账的旗子是"交出去了"**（照常不收口）。
   */
  #openHandoffs = new Map();

  /**
   * 已经由 `step/start` 报过的步（键 `turn:step`）。
   *
   * 用途只有一个：`tool/call` 的**类别补发**只认这一步已经报过——
   * 否则我们会凭空造一个客户端没见过的步骤号，而它等不到 `step/end`，
   * 屏幕上就挂成"永远在查资料"（H4 不许的形状）。见 `#emitStepCategory()`。
   */
  #seenSteps = new Set();
  /**
   * 通知那本账（批 3 第三件）——**过程通道就"这一轮出事了"登记用**。
   * `null` = 没接通知那一路（离线测试、老调用方都走这条）。
   */
  #notice;
  /** 登记失败（同一个 `(turn, kind)` 两条通道都说了）——只记不抛，见 ⑥。 */
  #claimErrors = [];
  /**
   * ★ **P2-8：出网留痕的出入口**（可选）。`null` = 没接（离线测试、老调用方）。
   * 🔴 回调失败**不许挡这一轮**（留痕是旁路，F10 同款）。
   */
  #onEgress;

  constructor({ timeline, scopeId = null, notice = null, onEgress = null }) {
    super();
    this.#timeline = timeline;
    this.#scopeId = scopeId;
    this.#notice = notice;
    this.#onEgress = typeof onEgress === 'function' ? onEgress : null;
  }

  /**
   * ★ **D 期：排一条"等着被接过去的半条消息"**（由 `Dispatcher.handoffDelivery` 调）。
   *
   * 🔴 它**不改这一间的 `scopeId`** —— 续写事件的**可见标签**永远是
   *    **发起那一间**（契约 §6.2）；`byScope` 只是审计字段。
   *
   * @param {string} messageId 要接着写的那条消息（A 那条）
   * @param {string} byScope 真正干活的那一间（审计/用量）
   * @param {object|null} [writer] **发起者那条 writer**（**同一个对象** ——
   *        N22"同一时刻最多一条未收口"的登记在它身上，另建一个会当场撞上）
   * @returns {boolean}
   */
  expectHandoff(messageId, byScope, writer = null) {
    if (typeof messageId !== 'string' || messageId === '') return false;
    this.#adoptions.push({ messageId, byScope: byScope ?? null, writer: writer ?? null });
    return true;
  }

  /** 这一轮是不是**转交续写**（判据/诊断用）：给那条消息 id，没有 ⇒ `null`。 */
  handoffTurn(messageId) {
    if (typeof messageId !== 'string' || messageId === '') return null;
    for (const [turn, rec] of this.#turns) {
      const w = rec?.adopted ?? rec?.writer ?? null;
      if (w && w.messageId === messageId) return turn;
    }
    return null;
  }

  /** ★ **D 期**：见 `turn`。 */
  get liveTurn() {
    let last = null;
    for (const t of this.#turns.keys()) {
      if (last === null || t > last) last = t;
    }
    return last;
  }

  /** 这一轮的**干活者**（没有 ⇒ `null` = 就是这一间自己）。 */
  byScopeOfTurn(turn) {
    return this.#turns.get(turn)?.byScope ?? null;
  }

  /**
   * ★ **D 期：这一轮把话交出去了**（`Dispatcher.announceHandoff` 成功之后叫）。
   *
   * 后果有两个，第二个是致命的：
   *   ① 这一轮收口时**不许**再往那条消息里补一句（它不是失败，是"换人接着做"）；
   *   ② 🔴 **那条消息不许在本间收口** —— `end()` 了就成"挪走"（另起一条）
   *      ＝ D-8 的反例。收口由**接活那一间**做。
   *
   * ⚠️ **两种时机都要能接住**：模型可能在 `turn/end` **之前**调工具
   *    （那时轮账还在），也可能在**之后**（域套接字那一帧慢一步）——
   *    所以忙时在轮账上打旗子，闲时开一条**不收口的挂账**（供 `turnDeadline`
   *    兜底收口用：`N19` 挂起必有收尾）。
   */
  noteHandedOff(turn, messageId = null) {
    if (Number.isInteger(turn)) {
      const rec = this.#turns.get(turn);
      if (rec) {
        rec.handedOff = true;
        if (typeof messageId === 'string' && messageId !== '') rec.handoffMessageId = messageId;
        return true;
      }
    }
    if (typeof messageId === 'string' && messageId !== '') {
      this.#openHandoffs.set(messageId, { writer: null, startedAt: Date.now(), texts: 0, sources: [], handedOff: true });
      return true;
    }
    return false;
  }

  /**
   * **这一轮把话交出去了吗** —— 收口那条路要看它（见 `noteHandedOff`）。
   * ⚠️ 认不出来 ⇒ `false`（老行为：照常收口）。
   */
  handedOffTurn(turn) {
    const rec = this.#turns.get(turn);
    if (rec?.handedOff) return true;
    // 闲时那条挂账（工具慢一步）也要认
    for (const r of this.#openHandoffs.values()) {
      if (r.handedOff) return true;
    }
    return false;
  }

  /**
   * **这一轮的账**（`turn` → 那条记录）——只给同一层的诊断/判据用。
   * ⚠️ 返回的是**浅拷贝的表**：外面拿不到 `#turns` 本身。
   */
  turnRecords() {
    return new Map(this.#turns);
  }

  /**
   * ★ **先给这条消息开个口**（D-4：A 那条"不收口"的那半）。
   *
   * 用的场合只有一个：模型在一轮里**光调了工具、一个字都还没说**就把活转出去了 ——
   * 那时还没有 `writer`，而"B 接着往**同一条消息**里写"要求那条消息**存在**。
   * ⚠️ 所以这里**只开口、不写正文**（一个字都不编）。
   * ⚠️ 开出来的那条会**挂到当前这一轮**的账上：那一轮收口时它照样收（N19）——
   *    它只是**不收在转交那一刻**（`MessageWriter.handoff()` 不 end）。
   *
   * @param {string} messageId
   * @returns {import('./message-writer.js').MessageWriter|null}
   */
  ensureOpenMessage(messageId, turn = null) {
    if (typeof messageId !== 'string' || messageId === '') return null;
    for (const rec of this.#turns.values()) {
      const w = rec?.writer;
      if (w && w.messageId === messageId && !w.ended) return w;
    }
    const w = new MessageWriter({
      timeline: this.#timeline,
      messageId,
      agent: 'agent',
      origin: 'reactive',
      scopeId: this.#scopeId,
    });
    w.start();
    const rec = Number.isInteger(turn) ? this.#turns.get(turn) : null;
    if (rec && !rec.writer) rec.writer = w;
    return w;
  }

  /** 当前有没有一轮还没收口。给淘汰回调判断用。 */
  get openTurn() {
    for (const [turn, t] of this.#turns) if (t.writer && !t.writer.ended) return turn;
    return null;
  }

  get lastTitle() {
    return this.#lastTitle;
  }

  /** 看到过几段推理原文（**只计数，内容一律不落、不推**）。 */
  get reasoningSeen() {
    return this.#reasoningSeen;
  }

  /** 登记"这一轮出事了"时撞上的冲突（契约 §三② 的两条通道；给闸与排障看）。 */
  get claimErrors() {
    return [...this.#claimErrors];
  }

  /**
   * 过程通道就"这一轮的这件事"登记一笔（文件头 ⑥）。
   *
   * ⚠️ **登记失败只记不抛**：这一层正在做的是**收口**（N19 挂起必有收尾），
   *    而收口比记账重要 —— 让记账把收口挡掉，用户拿到的是一个永远不收口的气泡。
   *    真正的闸**在通知那一侧**（`Notice.notice()` 撞上了会抛）：那样
   *    「同一件事只走一条通道」仍然成立，只是"后说的那个"闭嘴。
   */
  #claimProcess(turn, kind) {
    if (!this.#notice || typeof turn !== 'number') return;
    try {
      this.#notice.processSaid({ turn, kind });
    } catch (err) {
      this.#claimErrors.push(err?.message ?? String(err));
    }
  }

  /**
   * 吃一个 `session.event` 通知。
   * @param {object} params  agent 发来的 params（形如 `{event: {...}}`）
   */
  handle(params) {
    const ev = params?.event ?? params;
    const type = ev?.type;
    if (typeof type !== 'string') return;
    const data = ev.data ?? {};

    switch (type) {
      case 'turn/start':
        // ⚠️ dsh 的 todo 投影**每轮开头清空**（`turn/start` ⇒ null）⇒ 这里跟着清，
        //    不然新的一轮上还挂着上一轮的计划（**一句过期的话**）。
        //    ⚠️ **必须挂在原来这条 case 上**：`switch` 里两个 `case 'turn/start'`
        //    只有**第一个**会执行，第二个是死代码（判据当场抓到了这个 bug）。
        this.#onPlanEvent('clear');
        this.#onTurnStart(data, ev);
        break;
      case 'assistant/message':
        this.#onAssistantMessage(data, ev);
        break;
      case 'turn/end':
        this.#onTurnEnd(data, ev);
        break;
      case 'session/title':
        // 标题**永不进模型输入**（DSH 保证的）。这里只存着给界面用。
        this.#lastTitle = data.title ?? null;
        this.emit('title', this.#lastTitle);
        break;
      case 'tool/call':
        this.#onToolCall(data);
        break;
      case 'tool/result':
        // ★ **出处**就在这条上（`meta.sources`）—— 见 `src/sources.js` 顶上那三条规矩。
        //   ⚠️ 它上面**没有工具名**（实测）⇒ 名字去 `tool/call` 那一侧配（`#stepTools`）。
        this.#onToolResult(data);
        break;
      case 'todo/write':
        // 整表快照（last-write-wins）—— **不是**增量
        this.#onPlanEvent('todos', data);
        break;
      case 'goal/change':
        this.#onPlanEvent('goal', data);
        break;
      case 'step/start':
      case 'step/end':
        // ★ D7 的"步骤流水"就是从这里来的（契约 §三的事件形状）。
        //   ⚠️ 走**瞬态**：不占号、不落盘 —— 见文件头 ④。
        this.#emitStep(type, data);
        break;
      default:
        // 其它（request/*、permission/*、sandbox/*、agent/inbox/*…）安静忽略
        break;
    }
  }

  /**
   * 一次工具调用。
   *
   * ⚠️ 我们**只关心"它会不会改东西"这一个布尔**（决策 D10.1/D10.2），
   *    不关心工具叫什么、更不关心参数是什么。
   *    ⇒ 报出去的事件里**没有工具名、没有参数**——那些是内部词，
   *      而事件是**要落盘、会被 replay 给客户端**的（D7 的边界在这儿）。
   *
   * ⚠️ **一轮只报一次**：第一次碰上"会改东西"的工具就报，之后不再报。
   *    判据是"整轮**有没有**碰过写类工具"，不是"碰了几次"。
   */
  /**
   * **计划变了** ⇒ 记下来，并**发一条持久事件**（主人 2026-09-23 要的「目标 / 任务列表」）。
   *
   * ⚠️ 三条：
   *   ① 发的是**内容**（objective / todo 正文），**工具名、goalId、callId 一个字节都不发**
   *      （`26-PROCESS-LEVELS.md:180`：工具名与 callId 一律不发）；
   *   ② **只在「变了」的时候发**（本来就没有、现在也没有 ⇒ 一条都不发）——
   *      但**清空也要发**：客户端靠它把那条收起来（不发就成了「界面上留着旧计划」）；
   *   ③ 载荷里的 `todos` 已经按上限裁过，`more` 是**如实报的**条数（不静默截断）。
   */
  #onPlanEvent(what, data) {
    const prev = this.#plan;
    let next = prev;
    if (what === 'clear') {
      next = { goal: null, todos: [], doneCount: 0, total: 0, more: 0 };
    } else if (what === 'todos') {
      const snap = todosFromWrite(data);
      if (!snap) return; // 认不出 ⇒ **什么都不做**（不许编一个空计划出来）
      next = { ...prev, ...snap };
    } else if (what === 'goal') {
      const g = goalFromChange(data);
      if (!g) return;
      next = { ...prev, goal: g.cleared ? null : g.goal };
    } else {
      return;
    }
    this.#plan = next;
    if (planIsEmpty(next) && planIsEmpty(prev)) return; // 一直都没有东西 ⇒ 别刷一条空事件
    this.#timeline.emit({ type: PLAN_EVENT, ...next, at: Date.now() });
  }

  /**
   * **工具结果 ⇒ 出处**（`src/sources.js` 是判据所在）。
   *
   * ⚠️ 只在**这一轮还在账上**时收（`#turns` 里有它）——轮已经收了，
   *    这条结果就属于"已经说完的那句话"，晚了（不许倒着往旧气泡上贴出处）。
   */
  #onToolResult(data) {
    const turn = data?.turn;
    if (typeof turn !== 'number') return;
    const name = typeof data?.step === 'number' ? this.#stepTools.get(`${turn}:${data.step}`) : undefined;
    // ★ **P2-8：出网留痕**（主人 2026-09-25）。⚠️ 放在"这一轮还在账上"那道判断
    //   **之前**：留痕记的是**已经发生过的**那次出网，与"出处要不要贴到气泡上"无关。
    //   ⚠️ 配不上工具名（`#stepTools` 在收口时清了）⇒ **不记**（认不出就不猜）——
    //      实际序列里 `web_*` 的结果都在轮内回来，不会漏。
    //   🔴 只记域名/量；正文一个字节都不进来（判据在 `test/egress-log.test.js`）。
    this.#noteEgress(turn, egressFromToolResult(name, data?.meta));
    const rec = this.#turns.get(turn);
    if (!rec) return;
    const found = sourcesFromToolResult(name, data?.meta);
    if (found.length === 0) return;
    for (const one of found) {
      if (rec.sources.length >= MAX_SOURCES) break;
      if (rec.sources.some((x) => x.url === one.url)) continue;
      rec.sources.push(one);
    }
  }

  /**
   * ★ **P2-8：把这一条出网痕迹交出去**（`worlds.js` 那本 `EgressLog` 落盘）。
   *
   * ⚠️ **留痕是旁路**：回调出事**不许挡这一轮**（F10 同款，同 `#noteUsage` 的取舍）。
   * ⚠️ 认不出（空数组）⇒ 什么都不做（**不拿 0 充一条**）。
   */
  #noteEgress(turn, entries) {
    if (!this.#onEgress || !Array.isArray(entries) || entries.length === 0) return;
    try {
      this.#onEgress({ scopeId: this.#scopeId ?? 'main', turn, entries });
    } catch {
      /* 旁路：出网留痕出事不许把用户那一轮弄失败 */
    }
  }

  /**
   * **收口**：把这一轮攒下的出处写进 `message/end`，再 `end()`。
   *
   * ⚠️ 为什么统一在这一处写：`message/end` 是**权威那一版**（协议 R8），
   *    而出处是在一轮里**陆续**攒起来的 ⇒ 前面每一条 `chunk()` 都不该操心它。
   * ⚠️ 没有出处时**什么都不用做**：`message/end.sources` 是 `MessageWriter.end()` 本来就带的字段
   *    （空数组 = 没有出处）—— 这里只负责把攒到的那几条写进去。
   *
   * @param {import('./message-writer.js').MessageWriter} writer
   * @param {{sources?: {title: string, url: string}[]}|undefined} rec
   * @param {string} reason
   */
  #endWriter(writer, rec, reason) {
    if (rec && Array.isArray(rec.sources) && rec.sources.length > 0) writer.sources = rec.sources;
    // ★ **转交续写：把"谁在干活"记上**（§6.2 · 审计/用量）。
    //   ⚠️ 只在**真有别的 scope 在干活**时才加这个字段 —— 老行为的字节一个都不动。
    if (rec?.byScope) writer.byScope = rec.byScope;
    writer.end(reason);
  }

  #onToolCall(data) {
    const turn = data?.turn;
    if (typeof turn !== 'number') return;
    // ★ **这一步用的是哪件工具**：`tool/result` 上**没有工具名**（实测），
    //   而"出处"只认 `web_search` / `web_fetch` ⇒ 名字只能在这一侧配上去。
    //   ⚠️ 键与 `#seenSteps` 同款（`turn:step`）⇒ 收尾时一起清。
    if (typeof data?.step === 'number' && typeof data?.name === 'string') {
      this.#stepTools.set(`${turn}:${data.step}`, data.name);
    }
    // ★ 契约 §6.1：顺带给**这一步**补上"是什么类别的活"（人话表在客户端）。
    //   ⚠️ 它和下面那个布尔是**两件事**：这一步读文件也要说"在读东西"，
    //      哪怕整轮一次都没改过东西（只读白名单那条路）。
    this.#emitStepCategory(turn, data?.step, data?.name);
    if (this.#mutatedTurns.has(turn)) return;
    if (isReadOnlyTool(data?.name)) return;
    this.#mutatedTurns.add(turn);
    // 派给外面（dispatcher 知道这一轮是主人哪句话引起来的，它去落盘）
    this.emit('mutated', { turn });
  }

  /**
   * 契约 §6.1：`tool/call` 到了 ⇒ 给**同一个 `(turn, step)`** 补一次
   * 带类别的瞬态步骤状态（事件形状不变：还是 `step/start`，只是 `state`
   * 从兜底的 `started` 换成 `searching` 这一类）。
   *
   * ⚠️ **只在"这一步已经报过"时才补**（`#seenSteps`）：否则会凭空造出
   *    一个客户端没见过的步骤号，而它等不到 `step/end` ⇒ 屏幕上挂成
   *    "永远在查资料"（H4 明确不许的形状）。
   *
   * ⚠️ 仍然**瞬态**（`emitTransient`）：不占号、不落盘、新连接 replay 拿不到。
   */
  #emitStepCategory(turn, step, name) {
    if (typeof step !== 'number') return;
    if (!this.#seenSteps.has(`${turn}:${step}`)) return;
    const state = stepStateForTool(name);
    if (state === null) return;
    this.#timeline.emitTransient({ type: 'step/start', turn, step, state });
  }

  /**
   * **一步一步的过程**（D7 的"步骤流水"档）——瞬态，永不落盘。
   *
   * 形状照契约 §三（新增事件，**不动既有字段的语义**）：
   *
   *   {"type":"step/start","turn":3,"step":1,"state":"started"}
   *   {"type":"step/end",  "turn":3,"step":1,"reason":"completed"}
   *
   * ⚠️ `turn` / `step` **必须带**（契约 §三的乱序保护）：客户端拿 `turn`
   *    丢掉"已收口那一轮"的迟到步骤（H4：迟到的旧轮不许把提示点回来）；
   *    收到 `message/end` / 轮收口即清掉该轮的步骤（不许留成"永远在查资料"）。
   *
   * ⚠️ `state` 是**内部名**（界面那一层有 `process_words.dart` 翻人话，
   *    认不出来的就不说 —— N10）。这里**不发明**新名字：DSH 的 `step/start`
   *    数据里**没有**工具名（工具名在随后的 `tool/call` 上，实测），
   *    所以此刻能诚实说出的只有"这一步开始了"（复用既有的 `started`）。
   *    硬编一个"searching"之类就得先猜工具 —— 那是编造。
   *    ⇒ 类别由随后的 `tool/call` 补（契约 §6.1，见 `#emitStepCategory()`）。
   */
  #emitStep(type, data) {
    const turn = data?.turn;
    const step = data?.step;
    // 没有轮/步号 ⇒ 发出去客户端也没法做乱序保护，不如不发（沉默优于编造）
    if (typeof turn !== 'number' || typeof step !== 'number') return;
    // ★ 记下"这一步开始过"：`tool/call` 的类别补发只认这里报过的步
    if (type === 'step/start') this.#seenSteps.add(`${turn}:${step}`);
    const event =
      type === 'step/start'
        ? { type, turn, step, state: 'started' }
        : { type, turn, step, reason: 'completed' };
    // ⚠️ **`emitTransient`，不是 `emit`** —— 文件头 ④。
    //    换成 `emit` 会让 `test/process-level.test.js` 的泄露闸变红。
    this.#timeline.emitTransient(event);
  }

  /**
   * **推理原文**（D7 的"推理原文"档，⚠️ 只有主人、默认关）——瞬态，永不落盘。
   *
   * 实测（`docs/dev/05-AGENT.md` §一）：**没有 token 级增量**，
   * 推理原文是**整段**跟着 `assistant/message` 一起到的。
   * ⇒ 事件名沿用契约的 `reasoning/delta`（名字冻结），
   *    但**一段一到**：一次 `assistant/message` 里的每段 reasoning 发一条。
   *    （"delta" 在这里是"增量地给"，不是"token 级流"。）
   *
   * ⚠️ 只有 `level=reasoning` 的连接会收到它（`server.js` 的档位闸）；
   *    翻译层不判断档位——见文件头 ④ 最后一段。
   */
  #emitReasoning(turn, text) {
    if (typeof turn !== 'number') return;
    if (typeof text !== 'string' || text === '') return;
    // ⚠️⚠️ **绝不许写成 `emit()`**：那会落盘，而新连接 `sinceSeq=0`
    //      会 replay 全部历史 ⇒ 以后每一个人都能拿到这段原文（可能含系统提示片段）。
    this.#timeline.emitTransient({ type: 'reasoning/delta', turn, text });
  }

  /** 这一轮动过东西吗？（给测试与诊断用） */
  turnTouchedSomething(turn) {
    return this.#mutatedTurns.has(turn);
  }

  #onTurnStart(data, ev) {
    const turn = data.turn;
    if (typeof turn !== 'number') return;
    // ★ 键是 turn —— 见文件头 ②
    if (!this.#turns.has(turn)) {
      // ★ **D 期：这一轮是不是来接那半条消息的**（FIFO · 见 `#adoptions`）。
      //   认领发生在这里（`turn/start`）—— 这是唯一知道"来了一轮"的时刻。
      const job = this.#adoptions.shift() ?? null;
      this.#turns.set(turn, {
        writer: null,
        startedAt: ev.time ?? Date.now(),
        texts: 0,
        sources: [],
        // ★ `adopted` = 被接过去的那条 writer（**同一个对象** —— 见 `expectHandoff`）
        adopted: job?.writer ?? null,
        // ★ 这一轮要接着写的那条消息（`null` = 不是续写）
        handoffMessageId: job?.messageId ?? null,
        // ★ **谁在干活**（**只**用于审计/用量 —— 可见标签还是本间 · §6.2）
        byScope: job?.byScope ?? null,
        // ★ **D 期：这一轮把话交出去了**（`MessageWriter.handoff()` 成功 ⇒ true）。
        //   收口那条路要看它：交出去的那条消息**不许在本间收口**（D-4 / D-8）。
        handedOff: false,
      });
    }
    this.emit('turn-start', turn);
  }

  /**
   * ★ **D 期：给这一轮拿一条 writer**（转交续写时**用 A 那条** · D-4）。
   *
   * 🔴 两条不许走样：
   *   ① 续写时**沿用同一个 `messageId`**（客户端才是一个气泡）；
   *   ② **可见标签永远是这一间**（`scopeId: this.#scopeId`）——
   *      `byScope` 只是审计字段（§6.2）。
   * @param {object} rec 这一轮的账（`#turns` 里那条）
   * @param {number} turn
   */
  #writerFor(rec, turn) {
    if (rec.writer && !rec.writer.ended) return rec.writer;
    // ★ **交出去那条**：同一条消息的挂账（工具慢一步那种）。
    const hung = rec.handoffMessageId ? this.#openHandoffs.get(rec.handoffMessageId) : null;
    if (hung?.writer && !hung.writer.ended) {
      rec.writer = hung.writer;
      if (rec.byScope) rec.writer.byScope = rec.byScope;
      return rec.writer;
    }
    // ★ **转交续写：用 A 那条**（D-4）——写的是**同一个 `messageId`**，
    //   所以客户端那一个气泡前后半段连在一起。
    const reused = rec.adopted && !rec.adopted.ended ? rec.adopted : null;
    const w = reused
      ? reused
      : new MessageWriter({
        timeline: this.#timeline,
        // ⚠️ 续写时沿用那条消息 id（**同一个**）；否则照旧服务端生成
        ...(rec.handoffMessageId ? { messageId: rec.handoffMessageId } : {}),
        agent: 'agent',
        origin: 'reactive',
        // 🔴 **可见标签永远是这一间（发起那一间）** —— §6.2 定死。
        scopeId: this.#scopeId,
      });
    // 🔴 **谁在干活**（只用于审计/用量）
    if (rec.byScope) w.byScope = rec.byScope;
    rec.writer = w;
    if (hung) hung.writer = w;
    return w;
  }

  /**
   * ★ **D 期：先把那条"要交出去的消息"开着**（`Dispatcher.announceHandoff` 叫）。
   *
   * 模型光调工具、一个字都还没说时就得开这一个口：不开的话，"B 接着往**同一条
   * 消息**里写"就没有"同一条"可谈（D-4 的反例）。⚠️ **只开口、不编正文**。
   * @returns {import('./message-writer.js').MessageWriter|null}
   */
  openMessageForHandoff(messageId, turn = null) {
    if (typeof messageId !== 'string' || messageId === '') return null;
    for (const rec of this.#turns.values()) {
      const w = rec?.writer;
      if (w && w.messageId === messageId && !w.ended) return w;
    }
    const hung = this.#openHandoffs.get(messageId);
    if (hung?.writer && !hung.writer.ended) return hung.writer;
    const w = this.#writerFor(
      { writer: null, adopted: null, handoffMessageId: messageId, byScope: null },
      turn,
    );
    if (hung) hung.writer = w;
    return w;
  }

  #onAssistantMessage(data, ev) {
    const turn = data.turn;
    const rec = this.#turns.get(turn);
    if (typeof turn !== 'number') return;

    const content = data?.message?.content;
    if (!Array.isArray(content)) return;

    // ① **只取 type === 'text'** —— 推理原文(count)一律不走这条路
    const texts = [];
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') {
        texts.push(block.text);
      } else if (block?.type === 'reasoning') {
        // ⚠️ 只计数。**内容绝不落盘、绝不走持久通道。**
        //    （手册 §4.4：它可能含系统提示片段，一旦进日志，
        //      之后任何新连接 replay 都会拿到。）
        this.#reasoningSeen += 1;
        // ★ 但 `level=reasoning` 那条连接**要看到它** ——
        //   走瞬态（发出去就不存在了）。见 `#emitReasoning()`。
        this.#emitReasoning(turn, block.text);
      }
    }
    if (texts.length === 0) return;

    const text = texts.join('');
    if (!rec) return;

    // 一轮里第一段文本 = 快答，后面的 = 深答（协议 R2：同一个气泡）
    for (const piece of texts) {
      const w = this.#writerFor(rec, turn);
      const block = rec.texts === 0 ? 'quick' : 'deep';
      w.chunk(block, piece);
      rec.texts += 1;
    }
    this.emit('text', { turn, text, usage: data.usage ?? null });
  }

  #onTurnEnd(data, ev) {
    const turn = data.turn;
    // ★ 这一轮的步骤账跟着轮一起清（键里带 `turn:`，所以不会串到别的轮）。
    //   ⚠️ 放在 `rec` 判空**之前**：步骤可能在 `turn/start` 之前就报过，
    //      那种轮没有 `rec`，早退会把账留在这儿。
    if (typeof turn === 'number') {
      for (const key of this.#seenSteps) {
        if (key.startsWith(`${turn}:`)) this.#seenSteps.delete(key);
      }
      for (const key of this.#stepTools.keys()) {
        if (key.startsWith(`${turn}:`)) this.#stepTools.delete(key);
      }
      // ★ 转交续写**不在这里清**：那是 `#adoptions` 的活（见 `expectHandoff`）；
      //   这一轮绑的是 `adopted` / `byScope`，随 `rec` 一起被删掉。
    }
    const rec = this.#turns.get(turn);
    if (!rec) return;
    this.#turns.delete(turn); // ★ 用 turn 删 —— 键和存的时候一致

    const kind = data?.reason?.kind ?? 'completed';
    // ★ **D 期：这一轮把话交出去了**（`handoff()` 成功 ⇒ `rec.handedOff`）。
    //   🔴 **绝不许收口**：那条消息是留给**接活那一间**接着写的（D-4 / D-8），
    //      在这儿 `end()` 就等于"挪走"（另起一条）—— 正是反例。
    //   发起者这一轮照样**结束**（轮的账、过程提示照收），只是那条消息不收。
    if (rec.handedOff) {
      // ★ **把那条消息落实成"开着"**（工具慢一步那种），但**不收口**
      //   —— 收口由接活那一间做（D-4 / D-8）。它在轮账上留一条**不收口的挂账**
      //   （`#openHandoffs`），`turnDeadline` / `forceClose` 兜底收（N19）。
      if (rec.handoffMessageId) {
        const w = this.#writerFor(rec, turn);
        const hung = this.#openHandoffs.get(rec.handoffMessageId);
        if (hung) hung.writer = w;
      }
      this.emit('turn-end', { turn, kind, empty: true, handedOff: true });
      return;
    }
    // 🔴 **"钥匙不对"要说成"钥匙不对"**（见 `AUTH_LINE` 顶上那段）。
    //    它在两种情形下都要用：一句话都没说、以及只说了半句。
    // ★ 同样地，**"外面那条路不通"要说成"外面那条路不通"**（账 #33 · 2026-09-23）：
    //   那是用户**最可能撞上**的一档，而它原来和"我们这边出毛病"长得一模一样。
    //   ⚠️ 顺序有意：**先问钥匙**（那一档要用户回去改钥匙，改完就好），再问上游。
    //   ⚠️ 两个都认不出 ⇒ 还是那句含糊的 `INTERRUPTED_LINE`（N10：宁可少说，不许猜）。
    const stuckLine = isAuthFailure(data)
      ? AUTH_LINE
      : isUpstreamFailure(data)
        ? UPSTREAM_LINE
        : INTERRUPTED_LINE;
    const writer = rec.writer;

    if (!writer) {
      // 一句话都没说。**不许留白**（手册：宁可说一句"没结论"，也不能空着）。
      // ★ 用 `#writerFor`：转交续写的那一轮**也**要接着写 A 那条（D-4）。
      const w = this.#writerFor(rec, turn);
      w.chunk('deep', kind === 'completed' ? EMPTY_LINE : stuckLine);
      this.#endWriter(w, rec, 'failed');
      // ★ 「这一轮出事了」已经在这条通道上说过了（文件头 ⑥）
      this.#claimProcess(turn, 'failed');
      this.emit('turn-end', { turn, kind, empty: true });
      return;
    }

    if (kind !== 'completed') {
      // ③ **半句**：补一句说明，并**标成失败收尾**。
      //    绝不许把半句当完整回答（事故三）。
      writer.chunk('deep', kind === 'max-tokens' ? TRUNCATED_LINE : stuckLine);
      this.#endWriter(writer, rec, 'failed');
      this.#claimProcess(turn, 'failed');
    } else {
      this.#endWriter(writer, rec, 'completed');
    }
    this.emit('turn-end', { turn, kind, empty: false });
  }

  /**
   * **换了一个 agent 进程** ⇒ 把轮账清空。
   *
   * ⚠️ 为什么必须有：**轮号在每个进程里都从 1 重新开始。**
   *    上一个进程的第 1 轮如果因为什么原因没被收干净（收了尾但漏删、
   *    或者将来多轮并行），新进程的第 1 轮就会**接到那条陈账上**——
   *    于是新的一轮被当成旧的那轮，收口收错地方。
   *    进程换了，轮账就该是空的——这是构造上成立的，不靠"记得清理"。
   */
  reset() {
    this.#turns.clear();
    this.#mutatedTurns.clear(); // 轮号在新进程里从 1 重来 ⇒ 这份账也是新的
    this.#stepTools.clear(); // 同上：轮号重来了，`turn:step` 那本账也是旧的
    // ★ 那些"等着被接过去的半条消息"跟着这一代一起作废：轮号重来了，
    //   再认领就会接到**别的轮**上（那正是 D-4 的反例形状）。
    //   ⚠️ 作废**不等于**那条转交不作数了：账在落盘的 `HandoffBook` 上。
    this.#adoptions.length = 0;
    // ★ **交出去那条的挂账**也一起清：新进程接手之后它已经不在我们手里了
    //   （`forceClose` 收过的那条已经收了口；没收过的由接活那一间收）。
    this.#openHandoffs.clear();
  }

  /**
   * **一轮超时**：收掉这一轮，而且**保证留下话**。
   *
   * 手册 N19「挂起必有收尾」——不许留下永远"马上说完"的气泡。
   *
   * ⚠️ 两种情形**都必须有交代**，第二种最容易漏：
   *   ① **已经说了一半** ⇒ 补一句"卡住了"、标失败收尾。气泡要收口。
   *   ② **一句都没说** ⇒ **主动说一句**。
   *      早先这里（`forceClose`）是"没有 writer 就删掉、什么都不说"——
   *      于是用户等到天荒地老（手册事故一：那行"还有件事在处理"挂了 **68 分钟**）。
   *
   * ⚠️ 收尾理由是 **`timeout`**，不是 `failed`——
   *    `message/end.reason` 是时间线上"为什么结束"的**记录**（N4 记忆有出处、
   *    N7 不拿不真实的状态污染记录）。卡住和断线是两件事，记成一样就查不出来了。
   *    客户端对这一档是安全的：它按 `reason !== 'completed'` 判失败
   *    （`bubbles.dart:121`），**不认识的新值自然落到"失败"那一档**。
   *
   * @param {number} turn
   * @returns {boolean} 真的收了口才 true；那一轮早已收口（只是慢）⇒ false
   */
  turnDeadline(turn) {
    const rec = this.#turns.get(turn);
    if (!rec) return false;
    this.#turns.delete(turn);

    if (rec.handedOff) {
      // ★ **D 期：交出去那一轮卡住了**：它在**这一间**是"没做完"，
      //   所以那条消息**必须在盘上收个口**（N19：不许留"永远马上说完"的气泡）。
      //   🔴 它**不是**"做完了"：`timeout` 那一档就写明了。谁真做完了由接活的
      //      那一间说（它收口时是 `completed`，而且 `byScope` 记得住）。
      const w = this.#writerFor(rec, turn);
      const hung = rec.handoffMessageId ? this.#openHandoffs.get(rec.handoffMessageId) : null;
      if (hung) hung.writer = w;
      w.chunk('deep', DEADLINE_PARTIAL_LINE);
      this.#endWriter(w, rec, 'timeout');
      this.#claimProcess(turn, 'timeout');
      this.emit('turn-deadline', { turn });
      return true;
    }

    if (!rec.writer && !rec.adopted) {
      // 一句都没说 —— **不许留白**
      const w = this.#writerFor(rec, turn);
      w.chunk('deep', DEADLINE_EMPTY_LINE);
      this.#endWriter(w, rec, 'timeout');
    } else {
      // ① 说了一半（转交续写也算"已经开了口"）
      const w = this.#writerFor(rec, turn);
      w.chunk('deep', DEADLINE_PARTIAL_LINE);
      this.#endWriter(w, rec, 'timeout');
    }
    // ★ 「这一轮卡住、收了口」在过程通道上说过了（文件头 ⑥）
    this.#claimProcess(turn, 'timeout');
    this.emit('turn-deadline', { turn });
    return true;
  }

  /**
   * **一条没轮到的话**：用户说了，但那一轮压根没开始。
   *
   * 用在超时硬收口上：我们把 agent 卸了，排队里那些话就再也没有下一轮了。
   * **不许让它们静默消失**——用户看到的会是一个永远等不到回答的气泡。
   */
  turnUndelivered({ reason = 'timeout', line = DEADLINE_QUEUED_LINE } = {}) {
    const w = new MessageWriter({
      timeline: this.#timeline,
      agent: 'agent',
      origin: 'reactive',
      scopeId: this.#scopeId,
    });
    w.chunk('deep', line);
    w.end(reason);
    return true;
  }

  /**
   * **这一句话投不出去**（`session/prompt` / 交接包被对端拒了）——
   * 既有的失败收口 ＋ **保证**给用户留下一条看得见的话。
   *
   * ── 为什么不能只调 `forceClose`（2026-09-26 真机读数）──────────────
   *
   * `forceClose` 收的是**已经开过的轮**（`#turns` 里那些 —— 由 `turn/start` 建账）。
   * 而 `session/prompt` 被拒时，DSH 那边**一轮都没开**（`turn/start` 永远不来）
   * ⇒ `forceClose` 收 **0** 轮、**一个字都不写**。
   * 真机现场：`/api/say` 200，之后**五分钟里一个新事件都没有** ——
   * 盘上像那句话没发生过，用户永远等不到答复（N19 要挡的形状）。
   * （调度器还会发一条瞬态 `error`，但客户端今天**不渲染**它 —— 见
   *  `dispatcher.js` 里那句注释 ⇒ 它**不算**"看得见"。）
   *
   * ⇒ 这里：先走既有的失败收口（有半截的轮照旧补"没说完"）；
   *   **一轮都没开**时，才**主动**落一条给用户的话（`line`，走 `MessageWriter`，
   *   **落盘** ⇒ 用户看得见）。
   *
   * @param {string} reason 收尾理由（`message/end.reason`）
   * @param {object} [o]
   * @param {string} [o.line] **一轮都没开**时说的那句（默认"没说完"那句）
   * @returns {number} 收掉了／写了几个（0 不可能：至少写一条）
   */
  deliveryFailed(reason = 'failed', { line = INTERRUPTED_LINE } = {}) {
    const closed = this.forceClose(reason, { line });
    if (closed > 0) return closed;
    // 一轮都没开过（这正是"prompt 被拒"的形状）⇒ 主动交代，**落盘**
    this.turnUndelivered({ reason, line });
    return 1;
  }

  /**
   * 强制收口：把**所有**还没收尾的轮都收掉。
   *
   * ⚠️ 早先它只找"**有 writer 的那一轮**"（`openTurn`）。于是有这么一类轮
   *    **永远不会被清掉、也永远不会说话**：
   *
   *      一轮开了 → 一个字都还没说 → 进程没了 / 被卸了
   *
   *    它在 `#turns` 里留着（**泄漏**），而屏幕上**什么都没有**——
   *    用户就一直等一条不会来的回答。**这正是 N19 要挡的形状**，
   *    只是它藏在"没有 writer"这条路上，`openTurn` 找不到它。
   *
   * ⚠️ 而且它是**界面那个"它正在做…"的收尾条件**：不清掉，
   *    那行提示会永远挂在那儿（手册 H4：卡住时永久停在"在查资料"，比空白更坏）。
   *
   * @param {string} reason
   * @param {object} [o]
   * @param {string} [o.line] **一句话都没说**时说的那句（有 writer 时补的是
   *        `INTERRUPTED_LINE`，因为用户已经看到半句了）。
   * @returns {number} 收掉了几轮
   */
  forceClose(reason = 'failed', { line = INTERRUPTED_LINE } = {}) {
    let closed = 0;
    // ★ **D 期：闲时那条挂账**（已经交出去、轮已经收了）——它照样是"挂着的气泡"，
    //   收尾必须收它（N19），否则界面上永远"马上说完"。
    for (const [messageId, hung] of [...this.#openHandoffs]) {
      this.#openHandoffs.delete(messageId);
      const w = hung.writer && !hung.writer.ended
        ? hung.writer
        : new MessageWriter({ timeline: this.#timeline, messageId, agent: 'agent', origin: 'reactive', scopeId: this.#scopeId });
      if (!w.ended) {
        w.chunk('deep', line);
        w.end(reason);
        closed += 1;
      }
    }
    for (const [turn, rec] of [...this.#turns]) {
      this.#turns.delete(turn);
      if ((rec.writer && !rec.writer.ended) || rec.adopted) {
        // 用户已经看到半句（或这条消息已经被转交出去、有人接着写）⇒
        // 补一句"没说完"，别重复它的开头
        const w = this.#writerFor(rec, turn);
        w.chunk('deep', INTERRUPTED_LINE);
        this.#endWriter(w, rec, reason);
      } else if (!rec.writer) {
        // 一句话都没说 ⇒ **主动交代**（不许留白）
        const w = new MessageWriter({
          timeline: this.#timeline,
          agent: 'agent',
          origin: 'reactive',
          scopeId: this.#scopeId,
        });
        w.chunk('deep', line);
        this.#endWriter(w, rec, reason);
      }
      // ★ 这一轮"以失败收场"在过程通道上说了（文件头 ⑥）
      this.#claimProcess(turn, reason);
      closed += 1;
    }
    if (closed > 0) this.emit('force-close', { reason, closed });
    return closed;
  }
}
