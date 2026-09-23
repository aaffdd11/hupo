// **计划条**（主人 2026-09-23 要的「进行中的目标 / 任务列表」· `docs/dev/64-CHAT-REDESIGN.md` §四）。
//
// 这一份钉四件：
//   ① **翻成人话**：`todo/write` 快照与 `goal/change` ⇒ 客户端要的那一版（顺序、状态、封顶）
//   ② 🔴 **工具名 / goalId / callId 一个字节都不许发**（`26-PROCESS-LEVELS.md:180` 那条规矩）
//   ③ **发出的是一条持久事件**（有 `seq`、会补发）—— 刷新一下计划条不许变空
//   ④ 负向对照：坏载荷 / 一直空 ⇒ **一条都不发**（不许编一个空计划出来）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PLAN_EVENT, goalFromChange, planIsEmpty, todosFromWrite } from '../src/plan.js';
import { TurnTranslator } from '../src/session-translate.js';
import { collector, tempTimeline } from './helpers.js';

// ══ ① 纯函数 ═══════════════════════════════════════════════

test('★ `todo/write` 快照 ⇒ 清单（顺序照旧 · 三种状态各归各位）', () => {
  const got = todosFromWrite({
    todos: [
      { content: '读现有代码', status: 'completed' },
      { content: '改那一处', status: 'in_progress' },
      { content: '跑闸', status: 'pending' },
    ],
  });
  assert.deepEqual(got.todos, [
    { text: '读现有代码', now: false, done: true },
    { text: '改那一处', now: true, done: false },
    { text: '跑闸', now: false, done: false },
  ]);
  assert.equal(got.doneCount, 1);
  assert.equal(got.total, 3);
  assert.equal(got.more, 0);
});

test('🔴 坏载荷 ⇒ `null`（**不许**编一个空计划出来）', () => {
  for (const bad of [undefined, {}, { todos: 'x' }, { todos: null }, 42]) {
    assert.equal(todosFromWrite(bad), null, JSON.stringify(bad));
  }
});

test('★ 空内容的条目丢掉；条数**封顶但如实报**（不静默截断）', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ content: `第 ${i} 件`, status: 'pending' }));
  const got = todosFromWrite({ todos: [{ content: '   ', status: 'pending' }, ...many] });
  assert.equal(got.todos.length, 20, '封顶 20 条（上限住代码里）');
  assert.equal(got.total, 25, '**总数照实报**');
  assert.equal(got.more, 5, '**超出的那几条也要说出来**');
});

test('★ 单条太长要截断（别让一条任务把整帧撑爆）', () => {
  const got = todosFromWrite({ todos: [{ content: 'x'.repeat(500), status: 'pending' }] });
  assert.ok(got.todos[0].text.length <= 200, `实际 ${got.todos[0].text.length}`);
  assert.ok(got.todos[0].text.endsWith('…'));
});

test('★ `goal/change`：`create` ⇒ objective + phase；`clear` ⇒ 清掉', () => {
  const made = goalFromChange({
    kind: 'goal/change',
    version: 1,
    operation: 'create',
    goal: { id: 'goal-1', revision: 3, objective: '把聊天窗口重设计做完', phase: 'active' },
    roundsStarted: 1,
  });
  assert.deepEqual(made, { cleared: false, goal: { text: '把聊天窗口重设计做完', phase: 'active' } });

  const cleared = goalFromChange({ kind: 'goal/change', version: 1, operation: 'clear' });
  assert.deepEqual(cleared, { cleared: true });
});

test('🔴 目标那一条：认不出就不认（版本/形状/空 objective），phase 认不出时给 `active`', () => {
  assert.equal(goalFromChange(undefined), null);
  assert.equal(goalFromChange({ kind: 'goal/change', version: 2, operation: 'create' }), null, '版本不对');
  assert.equal(goalFromChange({ kind: '别的', version: 1, operation: 'create' }), null);
  assert.equal(
    goalFromChange({ kind: 'goal/change', version: 1, operation: 'create', goal: { objective: '  ' } }),
    null,
    '空 objective',
  );
  const weird = goalFromChange({
    kind: 'goal/change',
    version: 1,
    operation: 'create',
    goal: { objective: '干这件事', phase: '未来才会有的阶段' },
  });
  assert.equal(weird.goal.phase, 'active', '认不出的阶段 ⇒ 当成 active（**不许**原样漏出去）');
});

test('🔴 载荷里**不许**出现工具名 / goalId / callId（拿序列化后的串扫）', () => {
  const payload = {
    goal: goalFromChange({
      kind: 'goal/change',
      version: 1,
      operation: 'create',
      goal: { id: 'goal-abc', revision: 2, objective: '把计划条做出来', phase: 'active' },
    }).goal,
    ...todosFromWrite({ todos: [{ content: '写服务端', status: 'in_progress' }] }),
  };
  const text = JSON.stringify(payload);
  for (const bad of ['todo_write', 'goalId', 'goal-abc', 'callId', 'create_goal', 'update_goal']) {
    assert.ok(!text.includes(bad), `载荷里漏出了「${bad}」：${text}`);
  }
  assert.ok(text.includes('把计划条做出来') && text.includes('写服务端'), '但**内容**必须在');
});

test('`planIsEmpty`：没目标没任务 ⇒ true', () => {
  assert.equal(planIsEmpty({ goal: null, todos: [] }), true);
  assert.equal(planIsEmpty({ goal: { text: 'x', phase: 'active' }, todos: [] }), false);
  assert.equal(planIsEmpty({ goal: null, todos: [{ text: 'x' }] }), false);
});

// ══ ② 真跑一遍翻译层（屏幕上/补发里到底有没有那一条）══════════

/** 喂一串会话事件，返回**落盘的那些 `plan/updated`**（持久事件：有 seq）。 */
function feed(events) {
  const { store, timeline } = tempTimeline();
  const c = collector();
  timeline.subscribe(c.fn);
  const t = new TurnTranslator({ timeline });
  for (const e of events) t.handle({ event: e });
  const onDisk = store.readAll('main').filter((e) => e.type === PLAN_EVENT);
  return { onDisk, got: c.got.filter((e) => e.type === PLAN_EVENT) };
}

test('🔴 计划是**持久事件**（有 `seq`、会补发）—— 刷新一下不许变空', () => {
  const { onDisk } = feed([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'todo/write', data: { todos: [{ content: '写服务端', status: 'in_progress' }] } },
  ]);
  assert.equal(onDisk.length, 1, '正好一条（turn/start 时本来就没有东西 ⇒ 不发）');
  assert.equal(typeof onDisk[0].seq, 'number', '带号 ⇒ 能补发');
  assert.deepEqual(onDisk[0].todos, [{ text: '写服务端', now: true, done: false }]);
  assert.equal(onDisk[0].total, 1);
});

test('🔴 整表快照 = **last-write-wins**（第二次把第一次整个替掉）', () => {
  const { onDisk } = feed([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'todo/write', data: { todos: [{ content: '第一版', status: 'pending' }] } },
    { type: 'todo/write', data: { todos: [{ content: '第二版', status: 'done-ish' }] } },
  ]);
  assert.equal(onDisk.length, 2);
  assert.equal(onDisk[1].todos.length, 1);
  assert.equal(onDisk[1].todos[0].text, '第二版', '第二版把第一版替掉了');
  assert.equal(onDisk[1].todos[0].done, false, '认不出的状态不当成做完');
});

test('🔴 新的一轮 ⇒ 把旧计划**收掉**（dsh 的投影就是这么清的）', () => {
  const { onDisk } = feed([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'todo/write', data: { todos: [{ content: '一件事', status: 'pending' }] } },
    { type: 'turn/start', data: { turn: 2 } }, // ← 第二轮开始
  ]);
  assert.equal(onDisk.length, 2, '收到清空那一条');
  assert.deepEqual(onDisk[1].todos, [], '清单空了');
  assert.equal(onDisk[1].goal, null);
});

test('★ 目标 + 任务同时在 ⇒ 一条事件里都带上', () => {
  const { onDisk } = feed([
    { type: 'goal/change', data: { kind: 'goal/change', version: 1, operation: 'create', goal: { objective: '把重设计做完', phase: 'active' } } },
    { type: 'todo/write', data: { todos: [{ content: '做计划条', status: 'in_progress' }] } },
  ]);
  assert.equal(onDisk.length, 2);
  const last = onDisk[1];
  assert.deepEqual(last.goal, { text: '把重设计做完', phase: 'active' });
  assert.equal(last.todos[0].text, '做计划条');
});

test('🔴 负向对照：坏载荷 / 一直空 ⇒ **一条都不发**', () => {
  const bad = feed([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'todo/write', data: { todos: '不是数组' } },
    { type: 'goal/change', data: { kind: 'goal/change', version: 1, operation: 'create' } },
    { type: 'turn/start', data: { turn: 2 } },
  ]);
  assert.equal(bad.onDisk.length, 0, '认不出的载荷不许变成一条空计划');
  assert.equal(bad.got.length, 0);
});

test('★ 目标被清掉 ⇒ 也发一条（客户端靠它把那条收起来）', () => {
  const { onDisk } = feed([
    { type: 'goal/change', data: { kind: 'goal/change', version: 1, operation: 'create', goal: { objective: '干这件事', phase: 'active' } } },
    { type: 'goal/change', data: { kind: 'goal/change', version: 1, operation: 'clear' } },
  ]);
  assert.equal(onDisk.length, 2);
  assert.equal(onDisk[1].goal, null, '清掉之后目标为空 —— **发出去**，不许让界面留着旧的');
});
