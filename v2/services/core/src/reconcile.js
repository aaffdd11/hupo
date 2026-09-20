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
// ── 纯函数，没有 IO ────────────────────────────────────────
// 输入是日志里的事件，输出是一份"该收哪些口"的清单。
// 谁去落盘、谁去通知，是调用方的事（`serve.js` 开机那一步）。
// （本文件末尾那个 `reconcileOnBoot` 是**唯一**碰 IO 的，而且它只做"照单执行"。）

import { MessageWriter } from './message-writer.js';

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
export const INTERRUPTED_LINE =
  '你刚才让我做的那件事，可能没做完 —— 中间我被打断了，做到哪儿我也不知道。' +
  '你说一声，我重新来一遍。';

/**
 * 扫日志，找出**开始了但没有结束**的那些气泡。
 *
 * @param {Array<object>} events  日志里的事件（顺序：seq 升序）
 * @param {object} [o]
 * @param {number} [o.now]     现在（毫秒）。注入是为了可测。
 * @param {number} [o.windowMs] 回看窗口；比这更旧的只收口、不出声
 * @returns {{open: Array<{messageId: string, at: number, ageMs: number, tell: boolean, userText: string|null}>,
 *            closedIds: Set<string>}}
 *          `tell` = 要不要对用户说话
 */
export function findInterrupted(events, { now = Date.now(), windowMs = RECONCILE_WINDOW_MS } = {}) {
  const opened = new Map(); // messageId → { at, seq }
  const closedIds = new Set();
  /** 每条未收口气泡之前，**主人最后说的那句话**（用来对他说"你刚才让我做的那件事"） */
  const lastUserTextBefore = new Map();
  let lastUserText = null;

  for (const e of events) {
    // 瞬态事件不落盘，但仍然认一下（调用方可能把内存里的事件也一起传进来）
    if (!e || typeof e.type !== 'string') continue;
    switch (e.type) {
      case 'user/echo':
        lastUserText = typeof e.text === 'string' ? e.text : null;
        break;
      case 'user/message':
        lastUserText = (e.data?.content ?? [])
          .map((b) => b.text ?? '')
          .join('')
          .trim() || lastUserText;
        break;
      case 'message/start': {
        if (typeof e.messageId !== 'string') break;
        // 重新开口要重新计时 —— 同一条 id 再次 start 是"又说话了"，不是"上一次没收口"
        opened.set(e.messageId, { at: typeof e.at === 'number' ? e.at : now, seq: e.seq });
        lastUserTextBefore.set(e.messageId, lastUserText);
        break;
      }
      case 'message/end': {
        if (typeof e.messageId !== 'string') break;
        opened.delete(e.messageId);
        closedIds.add(e.messageId);
        break;
      }
      default:
        break;
    }
  }

  const open = [];
  for (const [messageId, info] of opened) {
    const ageMs = Math.max(0, now - info.at);
    open.push({
      messageId,
      at: info.at,
      ageMs,
      // ⚠️ **只对最近 6 小时内的说话**；更早的悄悄清掉
      tell: ageMs <= windowMs,
      userText: lastUserTextBefore.get(messageId) ?? null,
    });
  }
  // 先收拾旧账（老的在前），让日志读起来是顺着时间的
  open.sort((a, b) => a.at - b.at);

  return { open, closedIds };
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
 * @returns {{ok: boolean, closed: number, told: number, error?: string}}
 */
export function reconcileOnBoot({
  timeline,
  store,
  timelineId = null,
  now = Date.now(),
  windowMs = RECONCILE_WINDOW_MS,
  log = () => {},
}) {
  const id = timelineId ?? timeline.id;
  let found;
  try {
    found = findInterrupted(store.readAll(id), { now, windowMs });
  } catch (err) {
    return { ok: false, closed: 0, told: 0, error: `读日志失败：${err?.message ?? err}` };
  }
  if (found.open.length === 0) return { ok: true, closed: 0, told: 0 };

  let closed = 0;
  let told = 0;
  for (const item of found.open) {
    try {
      // ① **先收口**：那一条是上一个进程开的，它不会自己收尾了。
      //    `reason: 'failed'` 是**实话**（它确实没善终），
      //    而界面据此给它"没说完"的长相 + 重发入口（手册 §03 §5 那张表）。
      timeline.emit({
        type: 'message/end',
        messageId: item.messageId,
        reason: 'failed',
        sources: [],
      });
      closed += 1;

      // ② **再另起一条**告诉用户（只对最近 6 小时内的）
      if (item.tell) {
        const w = new MessageWriter({
          timeline,
          agent: 'agent',
          // 它是系统替他说的，但**说话的是这个助手** —— 所以还是 agent 说的
          origin: 'proactive',
        });
        w.chunk('deep', INTERRUPTED_LINE);
        w.end('completed');
        told += 1;
      }
    } catch (err) {
      // 一条收不住不该让剩下的也收不住
      log(`[对账] 收口失败（${item.messageId}）：${err?.message ?? err}`);
    }
  }
  return { ok: true, closed, told };
}
