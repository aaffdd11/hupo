// 开机对账：**把上一次没说完的话收干净，并告诉用户"可能没做完"。**
//
// 手册 `08-SPEC.md` §15.3（对账续做规则）· §事故一（「还有件事在处理」永远挂着）·
// `04-ROADMAP.md` D5.9（被打断的活会自己接着做）· 不变量 N19（挂起必有收尾）·
// N7（不拿不真实的状态污染记录）· N11（拒绝要给人话 + 可重试）
//
// ── 它修的是哪一起事故 ──────────────────────────────────────
//
// **事故一**：页面上那行灰字从 15:31 挂到 16:39，用户半小时后还在看它。
// 根因是**没人补那个"结束"**：进程连同那件活一起被杀，记录里就永远缺一半。
//
// 手册给的修法一字不差就是这个文件：
//   > 启动时**对账**：扫记录，有"开始"没有配对的"结束" ⇒ 一定是被打断的
//   > ⇒ **一定收口**。但**只对最近 6 小时内**的说话；更早的旧账悄悄清掉
//
// ── ⚠️ 为什么判据是"磁盘上那条气泡没收口"，而不是别的 ──────────
//
// 别的判据都很容易变成**假话**（事故二的教训：7 句一模一样的
// 「我已经升级好了。」每次重启说一句，因为判据里缺了"他确实被打断"这一条）：
//
//   · "上次启动是不是干净"    ⇒ 说得出来，但和"有没有活没干完"是两回事
//   · "这次启动比上次晚"      ⇒ 同上
//   · **磁盘上有一条没收口的气泡** ⇒ **这就是"被打断"本身**，是同一个事实
//
// ⇒ 它天生幂等：**收干净之后，下一次开机就找不到未收口的了**。
//    所以不会出现事故二那种"每次重启说一句"。
//
// ── ⚠️ 措辞：只能说「可能没做完」 ──────────────────────────
//
// 手册 §15.3 点名了：系统只知道"**我被断了**"，**不知道**那件活到底做完没有
// （它可能改完了、只是没来得及回话）。说"没做完"就是编（N7）。
//
// ── ⚠️ 而且**不能承诺"接着做"** ─────────────────────────────
//
// 我们**不知道它做到哪儿了**：工具结果根本不进时间线（见 `docs/dev/07-TIMEOUT.md` §六）。
// 所以只能说"**重新来一遍**"。说"接着做"是假话。
//
// ── ⚠️ 「续做」那两种情形**走通知，不走气泡**（批 3 第三件）────────
//
// 契约 `docs/dev/29-NOTICE.md` §5.1 把这两句的**通道**也定了：
//
//   自动重来 ⇒ `notice {kind:"resumed"}`
//   只通知不重来（动过东西）⇒ `notice {kind:"not-resumed"}`
//
// 理由是手册 R1.2 点名的"通知疲劳"：**同一件事只走一条通道**。
// 加通知之前，这两句是**一条气泡**；加通知之后，如果气泡和通知都发，
// 就是"一次失败两条通道各报一次"——那正是批 3 要合并掉的东西。
// ⇒ 给了 `notice` 参数 ⇒ 走通知，**不再另起气泡**；不给 ⇒ 照旧走气泡
//   （离线调用方与既有测试不受影响）。
//
// ── 纯函数，没有 IO ────────────────────────────────────────
// 输入是日志里的事件，输出是一份"该收哪些口"的清单。
// 谁去落盘、谁去通知，是调用方的事（`serve.js` 开机那一步）。
// （本文件末尾那个 `reconcileOnBoot` 是**唯一**碰 IO 的，而且它只做"照单执行"。）

import { MessageWriter } from './message-writer.js';
import { planResume } from './resume-plan.js';

/**
 * 默认回看窗口：**6 小时**（手册 §15.3）。
 *
 * 比它更旧的**照样收口，但对用户不出声**（"悄悄清掉"）——
 * 因为那种时候他多半已经不在等这件事了，再提一句只是噪音。
 */
export const RECONCILE_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * 对用户说的那句话。
 *
 * ⚠️ 三个"必须"都在里面：
 *   1. **说清是"可能"**，不是"没做完"（我们不知道）
 *   2. **说清"我不知道做到哪儿了"** —— 这解释了为什么只能重来（不能接着做）
 *   3. **给出下一步**（N11：可重试），而且**不追问**（人格硬规则 2）
 *
 * ⚠️ 不许出现内部词（工作区 / 连接 / 客户端 / 工具 / 会话…）——
 *    `apps/mobile/lib/models/forbidden_words.dart` 那道闸管的是界面文案，
 *    这一句**就是**界面文案，所以同样受它管。
 */
/**
 * 对用户说的那句话（**这一件马上要自动重做**那一版）。
 *
 * ⚠️ 它和 `INTERRUPTED_LINE` 的区别是**承诺**：那一版说"你说一声我重新来一遍"
 *    （等主人开口），这一版说"我重新做一遍"（已经在做）。
 * ⚠️ 人格硬规则第 3 条「**不许说了不做**」—— 说这句的**同一个开机流程**
 *    必须真的把活派出去（`serve.js` 紧接着就 `deliver`）。
 */
export const INTERRUPTED_RESUMING_LINE =
  '你刚才让我做的那件事，可能没做完 —— 中间我被打断了。我重新做一遍，做完了告诉你。';

export const INTERRUPTED_TOUCHED_LINE =
  '你刚才让我做的那件事，可能没做完 —— 中间我被打断了。' +
  '它可能已经改过东西了（写过文件、或者跑过命令），所以我没有自己重来。' +
  '你看一眼，要不要再做一遍。';

/**
 * 对用户说的那句话（**只读过东西**那一版）。
 *
 * ⚠️ 两个"必须"都在里面：**说清是"可能"**（我们不知道）、**给出下一步**（N11）。
 */
export const INTERRUPTED_LINE =
  '你刚才让我做的那件事，可能没做完 —— 中间我被打断了，做到哪儿我也不知道。' +
  '你说一声，我重新来一遍。';

/**
 * 扫日志，找出**没说完的话**。两种形状，都要抓：
 *
 *   ① **未收口的气泡**（`message/start` 没有配对的 `message/end`）
 *      —— 进程死在"已经开口、还没说完"的时候
 *   ② **问了没人答**（最后一条 `message/end` 之后还有 `user/echo`）
 *      —— 进程死在**还没出第一个字**的时候
 *
 * ⚠️ ② 是补上的一个洞，而且它很容易漏：气泡是**它说第一句话的时候**才建的
 *    （见 `session-translate.js`：writer 懒建）。所以"进程死在开口之前"这条路上
 *    **盘上只有主人自己那句话**——只查①的话，对账什么都发现不了，
 *    而主人就在那儿一直等一条不会来的回答。**那正是事故一。**
 *
 * @param {Array<object>} events  日志里的事件（顺序：seq 升序）
 * @param {object} [o]
 * @param {number} [o.now]     现在（毫秒）。注入是为了可测。
 * @param {number} [o.windowMs] 回看窗口；比这更旧的只收口、不出声
 * @returns {{orphans: Array<object>, unanswered: Array<object>, tell: boolean, total: number}}
 */
export function findInterrupted(events, { now = Date.now(), windowMs = RECONCILE_WINDOW_MS } = {}) {
  const opened = new Map(); // messageId → { at, ref }
  let lastEndSeq = 0;
  let seqOf = 0;
  const echoes = []; // { messageId, text, at, seq }
  /** 主人哪句话引起来的活里**动过东西**（决策 D10.1）。`null` = 归属不明（保守当"动过"） */
  const mutatedRefs = new Set();
  let lastEchoRef = null;
  /** 主人最后说的那句话的**原文**（续做要拿它去重来，所以必须带上） */
  let lastEchoText = null;

  for (const e of events) {
    if (!e || typeof e.type !== 'string') continue;
    if (typeof e.seq === 'number') seqOf = e.seq;
    switch (e.type) {
      case 'user/echo':
        lastEchoRef = typeof e.messageId === 'string' ? e.messageId : null;
        lastEchoText = typeof e.text === 'string' ? e.text : null;
        echoes.push({
          messageId: lastEchoRef,
          text: typeof e.text === 'string' ? e.text : null,
          at: typeof e.at === 'number' ? e.at : now,
          seq: seqOf,
        });
        break;
      case 'task/mutated':
        // ⚠️ 归属是 `null` 时**照样记**（记成"有一条归属不明的"）——
        //    算成"没动过"就是往危险的方向猜。
        mutatedRefs.add(typeof e.ref === 'string' ? e.ref : null);
        break;
      case 'message/start':
        if (typeof e.messageId === 'string') {
          // 同一条 id 再次开口 ⇒ 重新计时（那不是"上一次没收口"）
          opened.set(e.messageId, {
            at: typeof e.at === 'number' ? e.at : now,
            // 这一轮是主人哪句话引起来的（用来对上"动过东西"那份记录）
            ref: lastEchoRef,
            // ⚠️ **原话也要带上** —— 续做要拿它去重来。
            //    早先只给 `unanswered` 带了 text、没给 `orphans` 带，
            //    结果**最常见的那种打断**（它应了一声、然后被杀）**永远重来不了**
            //    （没有原话就不知道重来什么）。这个洞是测试逼出来的。
            text: lastEchoText,
          });
        }
        break;
      case 'message/end':
        opened.delete(e.messageId);
        lastEndSeq = seqOf;
        break;
      default:
        break;
    }
  }

  // 归属不明的那一条：保守起见，**任何**没被明确记为"没动过"的都算动过。
  const unattributedMutation = mutatedRefs.has(null);
  const touched = (ref) =>
    unattributedMutation || (ref !== null && mutatedRefs.has(ref)) || (ref === null && mutatedRefs.size > 0);

  const orphans = [...opened.entries()]
    .map(([messageId, info]) => ({
      messageId,
      ref: info.ref ?? null,
      text: info.text ?? null,
      at: info.at,
      ageMs: Math.max(0, now - info.at),
      tell: now - info.at <= windowMs, // ⚠️ 只对最近 6 小时内的说话
      // ⚠️ **动过东西的，不许自动重来**（D10.1）。这个字段现在只用来说话，
      //    等"续做"落地时它就是那道闸的判据。
      mutated: touched(info.ref ?? null),
    }))
    .sort((a, b) => a.at - b.at); // 老的先收，日志读起来顺着时间

  const unanswered = echoes
    .filter((e) => e.seq > lastEndSeq)
    .map((e) => ({
      messageId: e.messageId,
      ref: e.messageId,
      text: e.text,
      at: e.at,
      ageMs: Math.max(0, now - e.at),
      tell: now - e.at <= windowMs,
      mutated: touched(e.messageId),
    }))
    .sort((a, b) => a.at - b.at);

  // 只要有一条动过东西，就说"动过东西"那一版 —— 那是**风险更高的信息**
  const anyMutated = orphans.some((o) => o.mutated) || unanswered.some((u) => u.mutated);

  // ⚠️ **同一次打断常常两种形状都命中**（它先应了一声、然后被杀）：
  //    一个未收口的气泡 + 一句没人答的话，说的是**同一件事**。
  //    按形状加总数会报成"2 处"，而排障的人会以为出了两次事。
  //    ⇒ 按**归属**去重（`ref` = 主人那句话；认不出归属的就按它自己算一条）。
  const distinct = new Map();
  for (const f of [...orphans, ...unanswered]) {
    const k = f.ref ?? `!${f.messageId ?? f.at}`;
    distinct.set(k, (distinct.get(k) ?? false) || f.mutated);
  }

  return {
    orphans,
    unanswered,
    anyMutated,
    // ⚠️ 只要**有任何一条**在窗口里就出声，而且**只出一声** ——
    //    ① 和 ② 常常是同一件事的两面（它开口说了半句、就被杀了），
    //    分别出声就是对着同一次打断说两遍。
    tell: orphans.some((o) => o.tell) || unanswered.some((u) => u.tell),
    /** **出了几回事**（按归属去重）—— 这才是排障时该报的数 */
    incidents: distinct.size,
    /** 其中**动过东西**的有几处（那些不许自动重来，D10.1） */
    mutatedIncidents: [...distinct.values()].filter(Boolean).length,
  };
}

/**
 * 开机时执行一次对账：把未收口的气泡收掉，该出声的出一声。
 *
 * ⚠️ 手册 §15.3 把这条写死了：**任何异常不得阻断启动**。
 *    所以整个函数包在 try 里，失败只回报一条错误，不抛。
 *    理由：对账是"补救"，它自己坏掉不该让**整套服务**起不来——
 *    那样用户面对的不是"一句没说的话"，而是"什么都用不了"。
 *
 * ⚠️ 顺序是死的：**先把旧的收口，再另起一条说这句话**。
 *    反了就是手册 §7.3 点名的"**消息交叉**"（后续文本写回更早的那条消息，
 *    用户看到时间倒流）。而且 `Timeline` 本身也不容许**同一时刻两条未收口**（N22）。
 *
 * @param {object} o
 * @param {import('./timeline.js').Timeline} o.timeline
 * @param {import('./store.js').Store} o.store
 * @param {string} [o.timelineId]
 * @param {number} [o.now]
 * @param {number} [o.windowMs]
 * @param {import('./notice.js').Notice} [o.notice]
 *        ★ **系统通知那半边的口**（批 3 第三件 · 契约 `29-NOTICE.md` §5.1）。
 *        ⚠️ 给了它 ⇒ 「续做」那两种情形**改走通知通道**，而且**不再另起一条气泡**——
 *        契约 §二/§三② 的判据是**同一件事只走一条通道**（R1.2 的通知疲劳），
 *        气泡 + 通知同时说同一件事，正是那一批要合并掉的东西。
 *        不给 ⇒ 行为与加通知之前**一模一样**（那两类仍走气泡）：
 *        离线调用方与既有测试走的都是这条路。
 * @param {(m: string) => void} [o.log]
 * @returns {{ok: boolean, closed: number, told: number, noticed: string|null, ...}}
 *          `noticed` = 走通知通道的那个 `kind`（没走 ⇒ `null`）。
 */
export function reconcileOnBoot({
  timeline,
  store,
  timelineId = null,
  now = Date.now(),
  windowMs = RECONCILE_WINDOW_MS,
  /** 续做的开关。**不给 ⇒ 不自动重来**（保守默认：宁可只通知） */
  resume = null,
  notice = null,
  log = () => {},
}) {
  const id = timelineId ?? timeline.id;
  let events;
  let found;
  try {
    // ★ **读这条时间线自己的那些事件**（契约 84 §三·2）：一条日志现在装着
    //   所有房间，`ScopeView.readAll()` 会按 `scopeId` 标签挑出属于这一间的。
    //   少了这一步，"主线的对账"会去收别人房间里未收口的气泡。
    //   ⚠️ 裸 `Timeline`（离线测试、老调用方）走**传进来的 `store`** ——
    //      "读日志坏掉"这条判据正是打在它上面（`reconcile.test.js`）。
    const scoped = timeline?.isScopeView === true;
    events = scoped ? timeline.readAll() : store.readAll(id);
    found = findInterrupted(events, { now, windowMs });
  } catch (err) {
    return {
      ok: false, closed: 0, told: 0, noticed: null, total: 0, mutated: 0,
      resume: null, resumeReason: 'read-failed',
      error: `读日志失败：${err?.message ?? err}`,
    };
  }
  if (found.incidents === 0) {
    return { ok: true, closed: 0, told: 0, noticed: null, total: 0, mutated: 0, resume: null, resumeReason: 'nothing-interrupted' };
  }

  // ★ **先决定要不要自动重来，再决定说什么话** —— 顺序反了就会撒谎：
  //   一边说"你说一声我重新来一遍"、一边自己已经派了出去，那句话就是假的。
  //   （人格硬规则 3 禁的是"说了不做"；"做了却说没做"一样坏。）
  const plan = resume
    ? planResume({ findings: found, events, now, ...resume })
    : { pick: null, reason: 'off' };

  let closed = 0;
  const failures = [];
  // ① **先把所有没收口的都收掉**。那几条是上一个进程开的，它不会自己收尾了。
  //    `reason: 'failed'` 是**实话**（它确实没善终），界面据此给它"没说完"的长相 + 重发入口。
  for (const item of found.orphans) {
    try {
      timeline.emit({
        type: 'message/end',
        messageId: item.messageId,
        reason: 'failed',
        sources: [],
      });
      closed += 1;
    } catch (err) {
      // 一条收不住不该让剩下的也收不住
      failures.push(err?.message ?? String(err));
      log(`[对账] 收口失败（${item.messageId}）：${err?.message ?? err}`);
    }
  }

  // ② **再另起一条**，而且**只说一声**（哪怕上面收了两条、或者 ① ② 同时命中）。
  //    反了就是手册 §7.3 点名的"消息交叉"；说两遍就是把同一次打断讲两次。
  let told = 0;
  let noticed = null;
  if (found.tell) {
    // ★ **这两类走通知通道**（契约 `29-NOTICE.md` §5.1 那张表）：
    //   续做（自动重来）⇒ `resumed`；只通知不重来（动过东西）⇒ `not-resumed`。
    //   ⚠️ 它们**不再另起一条气泡** —— 同一件事只走一条通道（契约 §二/§三②）。
    //   其余那几种（太旧 / 超额度 / 降级 / 连原话都没有）**契约没给 kind**，
    //   照旧走气泡：那时候"告诉他一句 + 给下一步"比换通道重要（N11）。
    const kind = plan.pick ? 'resumed' : found.anyMutated ? 'not-resumed' : null;
    if (kind !== null && notice) {
      try {
        // ⚠️ 落盘失败照抛（`store.append` 的契约）⇒ 这里接住、只回报一条错误，
        //    因为对账**不许阻断启动**（手册 §15.3）。盘满那条路另有出口：
        //    `serve.js` 的"报平安"那条走 `noticeOrUrgent()`，而进程级兜底也有瞬态那一路。
        const full = notice.notice({ kind });
        noticed = full === null ? null : kind; // 被限频挡掉 ⇒ 这一轮没出声
        if (noticed !== null) told = 1;
      } catch (err) {
        failures.push(err?.message ?? String(err));
        log(`[对账] 那条通知没发出去：${err?.message ?? err}`);
      }
    } else {
      try {
        const w = new MessageWriter({ timeline, agent: 'agent', origin: 'proactive' });
        // ★ **动过东西的要说清"我没敢自己重来"** —— 那是主人该知道的事
        //   （他得去看一眼那些文件）。只说"我重新来一遍"会让他以为没什么要紧。
        const line = plan.pick
          ? INTERRUPTED_RESUMING_LINE
          : found.anyMutated
            ? INTERRUPTED_TOUCHED_LINE
            : INTERRUPTED_LINE;
        w.chunk('deep', line);
        w.end('completed');
        told = 1;
      } catch (err) {
        failures.push(err?.message ?? String(err));
        log(`[对账] 那句话没说出来：${err?.message ?? err}`);
      }
    }
  }

  return {
    ok: failures.length === 0,
    closed,
    told,
    /** 这一轮走的是通知通道的哪个 `kind`（`null` = 走的不是通知，或者被限频挡掉了） */
    noticed,
    /** **出了几回事**（按归属去重 —— 同一次打断的两种形状只算一处） */
    total: found.incidents,
    /** 未收口的气泡**找到了几条**（`closed` 是**收成功了几条**——收失败会不一样） */
    orphans: found.orphans.length,
    unanswered: found.unanswered.length,
    /** 其中动过东西的有几处（那些**不许自动重来**，见 D10.1） */
    mutated: found.mutatedIncidents,
    /** 这一轮打算自动重来的那一件（`null` = 不重来）。
     *  ⚠️ 调用方**必须真的把它派出去** —— 话已经说出去了。 */
    resume: plan.pick,
    /** 为什么不重来（给排障看，不是给用户的文案） */
    resumeReason: plan.reason,
    ...(failures.length > 0 ? { error: failures.join('；') } : {}),
  };
}
