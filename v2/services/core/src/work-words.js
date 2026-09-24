// **后台那四句话**（契约 `docs/dev/88-P1-TIME-WAIT.md` §三 · 主人 2026-09-25 拍的那个形状）。
//
//   ```
//   长活 ⇒ 默认进后台（不阻塞用户）
//        ① 开跑：一句"我去做，做完叫你"
//        ② 跑完：主动提醒（+ 结果一句 + 去哪看）
//        ③ 失败/被取消：**也要提醒**（不许静默）
//        ④ 他随时能问"那件怎么样了" ⇒ 逐件答案
//   ```
//
// ── 走哪条出口（**这一条要想清楚，别拍脑袋**）────────────────
// 契约 §三 写的是"走 `Notice`"，而 §五.3 说的是"**不新造**对用户说话的通道
// （走 `Notice`/翻译层那一条出口）"。**走的是"翻译层"那半边**，理由是可核的：
//   · `notice.js` 的五个 `kind` 是**冻结的两半接口**，加一个就要两半一起动；
//     而服务端 `test/notice.test.js` 逐字钉着那五个（`NOTICE_KINDS` deepEqual）；
//   · 这四句是**助手在说话**（有主体、有气泡、有结果），不是"替你做的决定 /
//     出事了 / 你不在时发生的事"那三类；
//   · `87` §③.8 也明说：进度与等待期的话**不走 Notice**，走
//     `message/status` / `step/*` / `message/text`（落盘的）。
// ⇒ 四句都走**落盘、取号的 `message/*`**（`MessageWriter`），
//    一条新通道都不造，一个冻结的 `kind` 都不动。
//
// ── 时间纪律（契约 §二.4）────────────────────────────────
// 这四句**一个没有依据的时间词都不许有**：说"我去做，做完叫你"，不说"很快就好"。
// 唯一允许的比较级是**有承诺行垫底**的那句 `workLateLine()`（依据 = `promise:<id>`）。
// `test/time-words.test.js` 逐条扫这张表（正反例都在那儿）。

/** ① 开跑那句（**不带时间承诺** —— 没有依据就不说）。 */
export const WORK_STARTED_LINE = '我去做，做完叫你。';

/** ② 完成那句的**前半**（结果一句接在后面）。 */
export const WORK_DONE_PREFIX = '做完了。';

/** ③ 失败 / 被取消那句（失败也要提醒 —— 不许静默）。 */
export const WORK_FAILED_LINE = '那件事我没做完，你回头看一眼。';
export const WORK_CANCELLED_LINE = '那件事你让停的，我已经停了。';

/** ④ 逐件答案（按状态给一句）。 */
export const WORK_ANSWER_LINES = Object.freeze({
  running: '那件还在做。',
  waiting: '那件还排着，没轮到。',
  done: '那件已经做完了。',
  stopped: '那件已经停了，没做完。',
  cancelled: '那件你让停的，已经停了。',
  unknown: '我没找到那件事。',
});

/**
 * 再报一次那句（**只在有承诺行的时候说**）。
 *
 * ⚠️ 它是唯一带比较级的句子：`比我说久了点` 里的"我说过"**就是那行承诺**，
 *    所以调用方必须给 `promise:<id>` 当依据；给不出来 ⇒ 换 `WORK_ANSWER_LINES.running`。
 */
export const WORK_LATE_LINE = '这件事比我说久了点，还在做。';

/**
 * "去哪看"那半句（**用他的词**，不用内部 id）。
 *
 * ⚠️ 认不出那个房间叫什么（没有 `title`）⇒ **不带这半句**，
 *    绝不许把 `scopeId` 这种内部名写上屏（`AGENTS.md` §六.4）。
 */
export function workWhereWords({ scopeId = 'main', title = null } = {}) {
  if (title && String(title).trim() !== '') return `（在「${String(title).trim()}」里）`;
  if (scopeId === 'main' || scopeId === null || scopeId === undefined || scopeId === '') {
    return '（就在这儿）';
  }
  return '';
}

/** 结果一句：只取**最后一段正文**的头部，并**丢掉带时间词的部分**（见文件头那段边界）。 */
export function workResultLine(text, { max = 60, hasTimeClaim = () => false } = {}) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  if (hasTimeClaim(flat)) return ''; // 我们**不替模型重复**一句没依据的时间话
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** ② 完成那句的整句。 */
export function workDoneLine({ result = '', scopeId = 'main', title = null } = {}) {
  const head = result ? `${WORK_DONE_PREFIX}${result}` : WORK_DONE_PREFIX;
  return `${head}${workWhereWords({ scopeId, title })}`;
}

/**
 * 这张表就是"我们自己的文案表"（T3 扫的就是它 + `notice.js` 那几张）。
 * `evidence` 只声明**这一条命中时间词时用哪一种依据**；具体 id 在调用点给。
 */
export const WORK_COPY = Object.freeze([
  { id: 'work-started', text: WORK_STARTED_LINE, evidence: null },
  { id: 'work-done', text: WORK_DONE_PREFIX, evidence: null },
  { id: 'work-failed', text: WORK_FAILED_LINE, evidence: null },
  { id: 'work-cancelled', text: WORK_CANCELLED_LINE, evidence: null },
  { id: 'work-answer-running', text: WORK_ANSWER_LINES.running, evidence: null },
  { id: 'work-answer-waiting', text: WORK_ANSWER_LINES.waiting, evidence: null },
  { id: 'work-answer-done', text: WORK_ANSWER_LINES.done, evidence: null },
  { id: 'work-answer-stopped', text: WORK_ANSWER_LINES.stopped, evidence: null },
  { id: 'work-answer-cancelled', text: WORK_ANSWER_LINES.cancelled, evidence: null },
  // ⚠️ 这一条**只在有承诺行时**才说 —— 依据是那行落盘的承诺。
  { id: 'work-late', text: WORK_LATE_LINE, evidence: 'promise' },
  // 有数的时间：实测计时器量出来的（`elapsed:<ms>`）。
  { id: 'elapsed-waited', text: '已经等了 {n} 秒', evidence: 'elapsed' },
]);

/** 逐件答案：状态 → 那句话。 */
export function workAnswerLine(state) {
  return WORK_ANSWER_LINES[state] ?? WORK_ANSWER_LINES.unknown;
}

