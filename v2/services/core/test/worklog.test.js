// **P1 地基：逐件落盘的活账**（契约 `docs/dev/88-P1-TIME-WAIT.md` §一.1 / §二 / §四 T1 T2）。
//
// 这一份钉四件事，每条都带**反例的正身**：
//   T2① 挂 2 件 → 逐件落盘（盘上真有两件，字段齐：scope / 票 / 状态 / 起止）。
//   T2② **硬杀 → 重启**：从盘上重建之后，逐件答得出"已停 / 还在 / 做完了"。
//   T2③ **反例：只有全局 busy 布尔 ⇒ 红**（那种账答不出"是哪几件"）。
//   T1   **票＝欠条**：每条 `user/echo` 有配对终态；**删掉收口行 ⇒ 有票无收口**；
//        删掉开口行 ⇒ 查无此件；**无票自发轮**的归属是 `null`（不许算给别人）。
//
// ⚠️ 风格照仓库现有测试：真 `Store`（真文件）+ 纯函数；调度器那一段走**真派发器**
//    （假 runtime，不 spawn —— 这一份考的是账，不是进程）。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';

import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';
import { Dispatcher } from '../src/dispatcher.js';
import { WORK_LOG, WorkLog, auditWork, replayWork } from '../src/worklog.js';
import { PromiseBook } from '../src/time-words.js';

const tmp = () => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-worklog-'));
const readWork = (store) => store.readAll(WORK_LOG);

/** 一条假 agent（派发器只要它 `.on` 与 `.prompt`）。 */
function fakeAgent() {
  const handlers = new Map();
  return {
    on(type, fn) { handlers.set(type, fn); },
    async prompt() { return { messageId: 'a_1' }; },
    emit(type, params) { handlers.get(type)?.(params); },
  };
}

/** 真派发器 + 可换的 runtime 替身（**不 spawn**）。 */
function dispatcherOver({ store, timeline, work, promises }) {
  const rt = {
    current: fakeAgent(),
    agent() { return this.current; },
    stop: async () => {},
  };
  const d = new Dispatcher({
    timeline,
    runtime: rt,
    store,
    scopeId: 'main',
    agentKey: 'u1/main',
    work,
    promises,
    turnDeadlineMs: 0,
  });
  return { d, rt };
}

test('T2① 挂 2 件：**逐件**落盘（scope / 票 / 轮 / 状态 / 起止）', () => {
  const store = new Store({ dataDir: tmp(), fsync: false });
  const work = new WorkLog({ store, now: () => 1000 });
  work.declare({ scopeId: 'main', ref: 'u_1' });
  work.bind({ scopeId: 'main', ref: 'u_1', generation: 1, turn: 1 });
  work.declare({ scopeId: 'alpha', ref: 'u_2' });
  work.bind({ scopeId: 'alpha', ref: 'u_2', generation: 1, turn: 1 });

  const onDisk = store.readAll(WORK_LOG);
  assert.equal(onDisk.length, 4, `两件活各两次开口：${JSON.stringify(onDisk)}`);
  // ⚠️ **不许只有一个全局 busy 布尔** —— 盘上真有两件、字段齐。
  const live = new WorkLog({ store }).live();
  assert.equal(live.length, 2);
  for (const r of live) {
    assert.ok(typeof r.scopeId === 'string', 'scopeId');
    assert.equal(typeof r.ref, 'string', '票');
    assert.equal(r.state, 'running', '状态');
    assert.equal(typeof r.startedAt, 'number', '起始时间');
    assert.equal(r.closedAt, null, '还没收口 ⇒ 没有止');
  }
  assert.deepEqual(live.map((r) => `${r.scopeId}:${r.turn}`).sort(), ['alpha:1', 'main:1']);
});

test('T2② **硬杀 → 重启**：逐件答得出"已停"，而且一件都不许消失', () => {
  const store = new Store({ dataDir: tmp(), fsync: false });
  // 第一次开机：开两件、**一件都没收**（模拟"做到一半被硬杀"）
  const before = new WorkLog({ store, now: () => 1000 });
  before.declare({ scopeId: 'main', ref: 'u_1' });
  before.bind({ scopeId: 'main', ref: 'u_1', generation: 3, turn: 7 });
  before.declare({ scopeId: 'beta', ref: 'u_2' });

  // ★ **重启**：新进程，从盘上重建（没有任何内存状态传过来）
  const after = new WorkLog({ store, now: () => 2000 });
  assert.equal(after.live().length, 2, '重启后仍逐件查得到');
  // 开机那一步：没有 agent 活着 ⇒ 逐件诚实收成"已停"
  const settled = after.settleDead({ aliveGenerations: [] });
  assert.equal(settled.length, 2, '两件都收了口（没有一件"消失"）');
  assert.deepEqual(settled.map((r) => r.outcome).sort(), ['stopped', 'stopped']);
  // 逐件答"那件怎么样了"
  assert.equal(after.answer({ scopeId: 'main', ref: 'u_1' }).answer, 'stopped');
  assert.equal(after.answer({ scopeId: 'beta', ref: 'u_2' }).answer, 'stopped');
  assert.equal(after.live().length, 0);
  // 反例的正身：**重启前**盘上那两件是开着的（否则上面什么都没证明）
  assert.equal(replayWork(readWork(store)).size, 2);
});

test('T2③ 反例：**只有全局 busy 布尔** ⇒ 答不出"是哪几件"（红）', () => {
  // 没有逐件记录 ⇒ 对着一个 busy:true 问"那件怎么样了"，答案只能是"查无此件"。
  const work = new WorkLog({ store: new Store({ dataDir: tmp(), fsync: false }) });
  assert.equal(work.answer({ scopeId: 'main', ref: 'u_1' }), null);
  assert.equal(work.live().length, 0);
  // 正对照：记了一件之后，同一句问得出答案
  work.declare({ scopeId: 'main', ref: 'u_1' });
  work.bind({ scopeId: 'main', ref: 'u_1', generation: 1, turn: 1 });
  assert.equal(work.answer({ scopeId: 'main', ref: 'u_1' }).answer, 'running');
});

test('T1 票＝欠条：两本账回基线 · 删收口行 ⇒ 有票无收口 · 删开口行 ⇒ 查无此件', () => {
  const store = new Store({ dataDir: tmp(), fsync: false });
  const work = new WorkLog({ store });
  const echoes = [
    { type: 'user/echo', messageId: 'u_1', scopeId: 'main' },
    { type: 'user/echo', messageId: 'u_2', scopeId: 'alpha' },
  ];
  work.declare({ scopeId: 'main', ref: 'u_1' });
  work.bind({ scopeId: 'main', ref: 'u_1', generation: 1, turn: 1 });
  work.closeByRef({ scopeId: 'main', ref: 'u_1', outcome: 'done' });
  work.declare({ scopeId: 'alpha', ref: 'u_2' });
  work.bind({ scopeId: 'alpha', ref: 'u_2', generation: 1, turn: 1 });
  work.closeByRef({ scopeId: 'alpha', ref: 'u_2', outcome: 'done' });

  const ok = auditWork({ timelineEvents: echoes, workEvents: readWork(store) });
  assert.deepEqual([ok.unclosed.length, ok.noRecord.length, ok.orphan.length], [0, 0, 0]);
  assert.equal(ok.paired, 2, '两本账回基线');
  assert.equal(ok.open, 0);

  // 🔴 反例：**删掉一族收口行**（比如盘上那条 `work/close` 被抹了）⇒ 有票无收口
  const noClose = readWork(store).filter((e) => !(e.type === 'work/close' && e.id.includes('u_1')));
  const bad1 = auditWork({ timelineEvents: echoes, workEvents: noClose });
  assert.equal(bad1.unclosed.length, 1, JSON.stringify(bad1));
  assert.equal(bad1.unclosed[0].ref, 'u_1');
  assert.equal(bad1.unclosed[0].why, '有票无收口');

  // 🔴 反例：**删掉开口行**（这件活一个字的账都没有）⇒ 查无此件
  const noOpen = readWork(store).filter((e) => !(e.type === 'work/open' && e.id.includes('u_2')));
  const bad2 = auditWork({ timelineEvents: echoes, workEvents: noOpen });
  assert.equal(bad2.noRecord.length, 1, JSON.stringify(bad2));
  assert.equal(bad2.noRecord[0].ref, 'u_2');
});

test('T1 无票自发轮：归属必须是 `null`（**不许**认领别人的票）', async () => {
  const store = new Store({ dataDir: tmp(), fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const work = new WorkLog({ store });
  const promises = new PromiseBook({ store });
  const { d, rt } = dispatcherOver({ store, timeline, work, promises });
  const agent = rt.current;

  // ① 他说第一句 ⇒ 那一轮配到 u_1
  await d.deliver('帮我看一下这个', { messageId: 'u_1' });
  agent.emit('session-event', { event: { type: 'turn/start', data: { turn: 1 }, time: 1 } });
  assert.equal(work.byTurn('main', 1, 1).ref, 'u_1');
  agent.emit('session-event', { event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } });

  // ② **助手自己发起一轮**（此刻队列是空的 —— 这正是最危险的那一刻）⇒ 归属 `null`
  agent.emit('session-event', { event: { type: 'turn/start', data: { turn: 2 }, time: 2 } });
  const spontaneous = work.byTurn('main', 1, 2);
  assert.ok(spontaneous, '自发轮也要逐件落盘');
  assert.equal(spontaneous.ref, null, '🔴 无票自发轮的归属必须是 null');

  // ③ 他第二句进来、变成一轮（turn=3）⇒ 票配对到 **u_2**，没有被自发轮吃掉
  await d.deliver('第二句', { messageId: 'u_2' });
  agent.emit('session-event', { event: { type: 'turn/start', data: { turn: 3 }, time: 3 } });
  assert.equal(work.byTurn('main', 1, 3).ref, 'u_2', '🔴 票必须配对到它引起来的那一轮（不许串给别人）');

  // ④ 全部收口 ⇒ 两本账回基线
  agent.emit('session-event', { event: { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } } });
  agent.emit('session-event', { event: { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } } });
  assert.equal(work.live().length, 0, '两本账每轮回基线');
  const audit = auditWork({
    timelineEvents: [
      { type: 'user/echo', messageId: 'u_1', scopeId: 'main' },
      { type: 'user/echo', messageId: 'u_2', scopeId: 'main' },
    ],
    workEvents: readWork(store),
  });
  assert.equal(audit.paired, 2);
  assert.deepEqual([audit.unclosed.length, audit.noRecord.length, audit.orphan.length], [0, 0, 0]);
});

test('T1 配对键是 `(agentGeneration, turn)`：**换进程后第 1 轮不许接到旧账上**', async () => {
  const store = new Store({ dataDir: tmp(), fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const work = new WorkLog({ store });
  const { d, rt } = dispatcherOver({ store, timeline, work, promises: null });

  await d.deliver('第一句', { messageId: 'u_1' });
  rt.current.emit('session-event', { event: { type: 'turn/start', data: { turn: 1 }, time: 1 } });
  assert.equal(work.byTurn('main', 1, 1).ref, 'u_1');

  // ★ **换一代**（runtime 给出另一个实例）⇒ 代号 +1
  rt.current = fakeAgent();
  await d.deliver('第二句', { messageId: 'u_2' });
  rt.current.emit('session-event', { event: { type: 'turn/start', data: { turn: 1 }, time: 2 } });
  // 同样是 turn=1，但代号不同 ⇒ 两件不同的活，各自配到自己的票
  assert.equal(work.byTurn('main', 1, 1).ref, 'u_1', '旧代第 1 轮还是旧账');
  assert.equal(work.byTurn('main', 2, 1).ref, 'u_2', '🔴 新代第 1 轮配到新票（没有接到旧账上）');
  assert.notEqual(work.byTurn('main', 1, 1).id, work.byTurn('main', 2, 1).id);
});
