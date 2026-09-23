// **计划条**：把 harness 自己的"目标 / 任务清单"翻成**人话**，再发给客户端
// （欠账之外的一次功能：主人 2026-09-23 要"进行中的目标，任务列表显示在窗口上方"）。
//
// ── 信号从哪来（都是**实测**的形状，不是猜的）────────────────
//   · `todo_write` 工具每次调用 ⇒ `session.append('todo/write', { todos })`
//     （`@deepseek-ai/dsh-tool-todo` 里那一行；**整表快照、last-write-wins**，
//      状态只有 `pending|in_progress|completed` 三种）
//   · 目标那一边 ⇒ `session.append('goal/change', change)`，`change.operation` 是
//     `create`（带 `goal:{id, revision, objective, phase, maxGoalRounds}`）或 `clear`
//     （`@deepseek-ai/dsh-goal`；`phase` 是个封闭集合，见下面 `PHASES`）
//   · ⚠️ **`turn/start` 会把 todo 清空**（dsh 的投影里就是这么写的：
//     `if (event.type === 'turn/start') return null`）⇒ 计划是**每轮**的，
//     新的一轮开始就该把旧计划收掉（旧计划留着 = 一句过期的话）。
//
// ── 这一层的三条纪律 ────────────────────────────────────────
//   ① 🔴 **工具名 / callId / goalId 一个字节都不许发**（`26-PROCESS-LEVELS.md:180`：
//      "工具名与 callId 一律不发（有闸）"）。这里只放**内容**：objective 与 todo 的正文。
//   ② **认不出就什么都不做**（不认识的 event / 坏载荷 ⇒ 返回 `null`，不许编一个空计划出来）。
//   ③ **不许长成无限大**：todo 条数与每条字数都封顶（上限住代码里，见下面两个常量），
//      超出的**如实报数**（`total` / `more`），不静默截断。

/** 发给客户端的那条事件名（持久事件：有 `seq`、会补发）。 */
export const PLAN_EVENT = 'plan/updated';

/** 目标/任务的阶段（封闭集合；给客户端做文案映射用，**不是**给人看的词）。 */
export const PHASES = Object.freeze(['active', 'paused', 'complete', 'blocked']);

/** 最多带几条任务（住代码里；超出的如实报 `more`）。 */
const MAX_TODOS = 20;
/** 每条任务/目标最多多少字（同上）。 */
const MAX_CHARS = 200;

const clip = (s, n = MAX_CHARS) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * 一条 `todo/write` 快照 ⇒ 给客户端看的清单。
 * @returns {{todos:Array<{text:string,now:boolean,done:boolean}>, doneCount:number, total:number, more:number}|null}
 */
export function todosFromWrite(data) {
  const raw = data?.todos;
  if (!Array.isArray(raw)) return null; // 认不出 ⇒ null（不许编）
  const all = raw
    .filter((t) => t && typeof t.content === 'string' && t.content.trim() !== '')
    .map((t) => ({
      text: clip(t.content),
      now: t.status === 'in_progress',
      done: t.status === 'completed',
    }));
  const kept = all.slice(0, MAX_TODOS);
  return {
    todos: kept,
    doneCount: all.filter((t) => t.done).length,
    total: all.length,
    more: Math.max(0, all.length - kept.length),
  };
}

/**
 * 一条 `goal/change` ⇒ 现在这个目标（`clear` ⇒ `null`）。
 *
 * ⚠️ **只留 objective 与 phase**：`id` 是内部的，`revision` / `maxGoalRounds` 是记账用的
 *    —— 它们对用户没有任何用（而且 id 属于"不许发"的那一类）。
 * @param {object} data `goal/change` 的 `data`
 */
export function goalFromChange(data) {
  if (data?.kind !== 'goal/change' || data?.version !== 1) return null;
  if (data.operation === 'clear') return { cleared: true };
  const g = data?.goal;
  if (!g || typeof g.objective !== 'string' || g.objective.trim() === '') return null;
  const phase = PHASES.includes(g.phase) ? g.phase : 'active';
  return { cleared: false, goal: { text: clip(g.objective), phase } };
}

/**
 * 当前计划 ⇒ **要发给客户端的那一版**（一个纯函数，判据直接喂它）。
 *
 * @param {{goal?:object|null, todos?:Array<object>}} state
 * @returns {{goal:{text:string,phase:string}|null, todos:Array<object>, doneCount:number, total:number, more:number}}
 */
export function planPayload(state = {}) {
  const todos = Array.isArray(state.todos) ? state.todos : [];
  return {
    goal: state.goal ?? null,
    todos,
    doneCount: todos.filter((t) => t.done).length,
    total: todos.length,
    more: 0,
  };
}

/**
 * **这份计划是不是空的**（没目标、没任务）。翻译层用它决定「要不要发这一条」：
 * 本来就没有、现在也没有 ⇒ 一条都不发（别在时间线上留一堆空事件）。
 */
export function planIsEmpty(state) {
  const hasGoal = Boolean(state?.goal);
  const hasTodos = Array.isArray(state?.todos) && state.todos.length > 0;
  return !hasGoal && !hasTodos;
}
