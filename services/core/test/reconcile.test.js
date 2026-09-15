// 重启对账：**被打断的活要接着做完**（不是宣布失败）。
//
// ⚠ 2026-09-15 纠偏。主人原话：「接收到系统修改任务，并没有修改系统。」
//
// 真实事故：15:02 主人让 App 端 agent 做一个天气小程序（能加城市、未来 7 天），
// 15:02:42 agent 说"我单独拿去做"，15:08 服务重启（为部署别的改动）——
// 那件活随处理层进程一起蒸发，主人只收到一句"之前那件事我断了，可能没做完"。
// **他要的东西一样没做出来。**
//
// 根因：活的命挂在处理层进程上。分配器（永续）只在事件记录里写了"有这么一件事"，
// 没有任何"接着做"的机制。
//
// 所以这里守三条不变量：
//   1. 重启后，**没做完的活会被重新派给处理层**，并且把主人的**原话**给它
//   2. 处理层那一轮结束 ⇒ 活交回分配器 ⇒ 收口（界面上"还有件事在处理"必须消掉）
//   3. 只有太久/试太多次才真放弃，放弃也要收口 —— created/completed 必须配对
//
// 跑：node --test "test/*.test.js"

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { Dispatcher } from '../src/dispatcher.js';
import { Store } from '../src/store.js';

function cfg(dataDir) {
  return { dataDir, agentProvider: 'p', agentModel: 'm', personaPath: '', agentCwd: os.tmpdir(),
    agentProfile: 'sdk', agentEffort: 'low', agentMaxTokens: 100, agentBootTimeoutMs: 1000,
    agentIdleEvictMs: 0, escalateAfterMs: 15000, turnDeadlineMs: 180000 };
}

/** 假的处理层：只记下"分配器派了什么活给它"，不真起 dsh 进程。 */
class FakeAgent extends EventEmitter {
  constructor() {
    super();
    this.prompts = [];
    this.running = false;
    this.ready = false;
  }
  async start() {
    this.ready = true;
  }
  async prompt(text) {
    this.prompts.push(text);
    return { ok: true };
  }
  async dispose() {}
}

function fakeRuntime() {
  const agents = new Map();
  return {
    agents,
    agent(id) {
      if (!agents.has(id)) agents.set(id, new FakeAgent());
      return agents.get(id);
    },
    async shutdown() {},
    stats: () => ({ sessions: agents.size, ready: 0, running: 0, agents: [], totalRssBytes: 0, uptimeMs: 0 }),
  };
}

/** 造一份"任务建了但没完成"的落盘记录，然后重新起一个 Dispatcher（模拟重启）。 */
function seedOrphan(dataDir, { ageMs = 60 * 1000, text = '帮我改一下浮窗', taskId = 't1' } = {}) {
  const store = new Store(dataDir);
  const at = Date.now() - ageMs;
  store.append('c1', { type: 'user/echo', seq: 1, messageId: `u_${taskId}`, text, at });
  store.append('c1', {
    type: 'message/start', seq: 2, messageId: `m_${taskId}`, origin: 'reactive', at,
  });
  store.append('c1', {
    type: 'message/text', seq: 3, messageId: `m_${taskId}`, block: 'quick',
    text: '这件事比我想的久，我单独拿去做，完了跟你说。', at,
  });
  store.append('c1', { type: 'message/end', seq: 4, messageId: `m_${taskId}`, reason: 'completed', at });
  store.append('c1', { type: 'task/created', seq: 5, taskId, title: text.slice(0, 24), at });
  return store;
}

/** 起一个 Dispatcher（注入假运行时），返回它和那个假的处理层。 */
function boot(dir) {
  const runtime = fakeRuntime();
  const d = new Dispatcher(cfg(dir), new Store(dir), { runtime });
  return { d, runtime, agent: runtime.agent('c1') };
}

/** 驱动一轮 agent 输出（模拟处理层把活做完、回来说结果）。 */
function runTurn(agent, text = '改好了，已经部署上线。') {
  agent.emit('session-event', { event: { type: 'turn/start', data: { turn: 1 } } });
  agent.emit('session-event', {
    event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } },
  });
  agent.emit('session-event', { event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } });
}

test('★被打断的活会重新派给处理层，并且把主人的**原话**给它（不宣布失败）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
  seedOrphan(dir, { text: '帮我改一下浮窗，要能拖动' });

  const { d, agent } = boot(dir);
  const log = d.conversation('c1').log;

  assert.equal(log.filter((e) => e.type === 'task/resumed').length, 1, '应该续做一次');
  assert.equal(
    log.filter((e) => e.type === 'task/completed').length,
    0,
    '活还在做，不能收口（收口了界面就显示"做完了"，是假话）',
  );

  assert.equal(agent.prompts.length, 1, '处理层应该收到一件活');
  assert.match(agent.prompts[0], /帮我改一下浮窗，要能拖动/, '必须带主人的原话（旧记录没有 prompt 字段，要从 user/echo 兜底）');
  assert.match(agent.prompts[0], /接着做完/);

  const said = log.filter((e) => e.type === 'message/text').map((e) => e.text).join('');
  assert.match(said, /接着做完/, '要跟主人说一句"我接着做完"');
  d.shutdown();
});

test('★续做那一轮结束 ⇒ 活交回分配器 ⇒ 收口（"还有件事在处理"要消掉）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-done-'));
  seedOrphan(dir);
  const { d, agent } = boot(dir);

  runTurn(agent, '天气小程序做好了，能加城市、看未来 7 天。');

  const log = d.conversation('c1').log;
  const done = log.filter((e) => e.type === 'task/completed');
  assert.equal(done.length, 1, '活做完了必须收口');
  assert.equal(done[0].taskId, 't1');
  assert.equal(done[0].reason, 'completed');
  d.shutdown();
});

test('太久的活（48 小时前）悄悄收口，不续做、也不突然说一句', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-old-'));
  seedOrphan(dir, { ageMs: 48 * 60 * 60 * 1000 });

  const { d, agent } = boot(dir);
  const log = d.conversation('c1').log;

  assert.equal(log.filter((e) => e.type === 'task/resumed').length, 0, '陈年旧账不续做');
  assert.equal(log.filter((e) => e.type === 'task/completed').length, 1, '但还是要收口');
  assert.equal(agent.prompts.length, 0, '不能为它起处理层');
  assert.equal(
    log.filter((e) => e.type === 'message/text' && /断了|接着做/.test(e.text)).length,
    0,
    '两天前的事不该突然冒出来说',
  );
  d.shutdown();
});

test('试太多次（3 次）就认了：收口，不再重派', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-attempts-'));
  const store = seedOrphan(dir);
  for (let i = 1; i <= 3; i++) {
    store.append('c1', { type: 'task/resumed', seq: 5 + i, taskId: 't1', attempts: i, at: Date.now() - 1000 * i });
  }

  const { d, agent } = boot(dir);
  const log = d.conversation('c1').log;

  assert.equal(log.filter((e) => e.type === 'task/resumed').length, 3, '不该有第 4 次');
  assert.equal(log.filter((e) => e.type === 'task/completed').length, 1, '收口');
  assert.equal(agent.prompts.length, 0);
  const said = log.filter((e) => e.type === 'message/text').map((e) => e.text).join('');
  assert.match(said, /可能没做完/, '最近的失败要如实说');
  d.shutdown();
});

test('已经完成过的活不会在重启时被重复开工/重复说话', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-already-'));
  const store = seedOrphan(dir);
  store.append('c1', { type: 'task/completed', seq: 6, taskId: 't1', at: Date.now() - 30 * 1000 });

  const { d, agent } = boot(dir);
  const log = d.conversation('c1').log;
  assert.equal(log.filter((e) => e.type === 'task/resumed').length, 0);
  assert.equal(log.filter((e) => e.type === 'task/completed').length, 1, '不该多出一条');
  assert.equal(agent.prompts.length, 0);
  d.shutdown();
});

test('手动收口：正在续做的活能收；收过的不行；不存在的返回 false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-manual-'));
  seedOrphan(dir);
  const { d } = boot(dir);
  assert.equal(d.completeTask('c1', 't1'), true, '续做中的活可以被手动收口');
  assert.equal(d.completeTask('c1', 't1'), false, '收过就不能再收');
  assert.equal(d.completeTask('c1', 'nope'), false);
  d.shutdown();
});

test('开机不让一堆活同时开工（**全进程合计** 1 件，不是每会话 2 件）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-cap-'));
  seedOrphan(dir, { taskId: 't1', text: '第一件事' });
  const store = new Store(dir);
  const at = Date.now() - 60 * 1000;
  store.append('c1', { type: 'task/created', seq: 20, taskId: 't2', title: '第二件事', prompt: '第二件事', at });
  store.append('c1', { type: 'task/created', seq: 21, taskId: 't3', title: '第三件事', prompt: '第三件事', at });

  const { d, agent } = boot(dir);
  const log = d.conversation('c1').log;
  // ⚠ 旧实现是"每会话 2 件"（`#reconcileTasks` 按会话调 + slice(0,2)），
  //   10 个会话有残留任务时开机就起 20 个 agent（每个 ~172MB）⇒ 1G 顶爆。
  assert.equal(log.filter((e) => e.type === 'task/resumed').length, 1, '全进程合计只接手 1 件');
  assert.equal(agent.prompts.length, 1);
  // 没轮到的**不能收口**（收口就等于放弃），也不能假装在做 —— 等下次（或闸门重试）
  assert.equal(
    log.filter((e) => e.type === 'task/completed').length,
    0,
    '没轮到的不能收口（收口就等于放弃）',
  );
  assert.equal(log.filter((e) => e.type === 'task/resume-excused').length, 0, '还没失败，不该有豁免');
  d.shutdown();
});

test('★内存/预算闸拦下时不烧活：既不续做、也不收口，等一会儿再看', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-gated-'));
  seedOrphan(dir);

  const runtime = fakeRuntime();
  // 把预算压成 0 ⇒ 必然被闸拦下（等价于"内存占用过高"那条分支）
  const d = new Dispatcher({ ...cfg(dir), maxResumeTotal: 0 }, new Store(dir), { runtime });
  const log = d.conversation('c1').log;

  assert.equal(log.filter((e) => e.type === 'task/resumed').length, 0, '被闸拦下，不续做');
  assert.equal(
    log.filter((e) => e.type === 'task/completed').length,
    0,
    '⚠ 也不能收口 —— 收口就等于把主人的活丢掉（这正是"内存一紧张就丢活"的坑）',
  );
  assert.equal(runtime.agent('c1').prompts.length, 0, '不该起处理层');
  d.shutdown();
});

test('★被机器杀掉不算活的问题：resume-excused 不消耗重试额度', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-excused-'));
  const store = seedOrphan(dir);
  // 续做过 3 次（本该"试太多次就认了"），但其中 3 次都是**被机器杀掉**（OOM/上游）
  for (let i = 1; i <= 3; i++) {
    store.append('c1', { type: 'task/resumed', seq: 5 + i, taskId: 't1', attempts: i, at: Date.now() - 1000 * i });
    store.append('c1', { type: 'task/resume-excused', seq: 10 + i, taskId: 't1', reason: 'agent-exit:null', at: Date.now() - 900 * i });
  }

  const { d, agent } = boot(dir);
  const log = d.conversation('c1').log;
  assert.equal(
    log.filter((e) => e.type === 'task/resumed').length,
    4,
    '三次都是机器打断的 ⇒ 不该认输，应该再试一次（否则主人收到的是假话）',
  );
  assert.equal(agent.prompts.length, 1);
  assert.equal(log.filter((e) => e.type === 'task/completed').length, 0);
  d.shutdown();
});

test('降级启动（CONCIERGE_SKIP_RESUME=1）不续做，但要收口、不能挂着', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-degraded-'));
  seedOrphan(dir);

  process.env.CONCIERGE_SKIP_RESUME = '1';
  try {
    const { d, agent } = boot(dir);
    const log = d.conversation('c1').log;
    assert.equal(log.filter((e) => e.type === 'task/resumed').length, 0, '降级启动不续做');
    assert.equal(agent.prompts.length, 0, '不起了处理层');
    const done = log.filter((e) => e.type === 'task/completed');
    assert.equal(done.length, 1, '但必须收口 —— 否则界面一直显示"还有件事在处理"');
    assert.equal(done[0].reason, 'degraded-start');
    d.shutdown();
  } finally {
    delete process.env.CONCIERGE_SKIP_RESUME;
  }
});
