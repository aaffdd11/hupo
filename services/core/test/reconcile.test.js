// 重启对账：**被打断的任务不能永远挂着**。
//
// 真实事故（2026-09-14）：agent 改客户端改到一半重启了服务，任务没收口，
// 页面上"还有件事在处理"就永远挂着 —— 主人半小时后还在看那句话，
// 只好来问"现在在发生什么"。
//
// 界面上那句话是客户端**从事件记录重建**的（task/created 建、task/completed 消），
// 所以服务端必须保证：这两个一定是配对的。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Dispatcher } from '../src/dispatcher.js';
import { Store } from '../src/store.js';

function cfg(dataDir) {
  return { dataDir, agentProvider: 'p', agentModel: 'm', personaPath: '', agentCwd: os.tmpdir(),
    agentProfile: 'sdk', agentEffort: 'low', agentMaxTokens: 100, agentBootTimeoutMs: 1000,
    agentIdleEvictMs: 0, escalateAfterMs: 15000, turnDeadlineMs: 180000 };
}

/** 造一份"任务建了但没完成"的落盘记录，然后重新起一个 Dispatcher（模拟重启）。 */
function seedOrphan(dataDir, { ageMs = 60 * 1000 } = {}) {
  const store = new Store(dataDir);
  const at = Date.now() - ageMs;
  store.append('c1', { type: 'user/echo', seq: 1, messageId: 'u1', text: '帮我改一下浮窗', at });
  store.append('c1', {
    type: 'message/start', seq: 2, messageId: 'm1', origin: 'reactive', at,
  });
  store.append('c1', {
    type: 'message/text', seq: 3, messageId: 'm1', block: 'quick',
    text: '这件事比我想的久，我单独拿去做，完了跟你说。', at,
  });
  store.append('c1', { type: 'message/end', seq: 4, messageId: 'm1', reason: 'completed', at });
  store.append('c1', { type: 'task/created', seq: 5, taskId: 't1', title: '帮我改一下浮窗', at });
  return store;
}

test('重启时被打断的任务会被收口，并且说一句（不会永远挂着）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
  seedOrphan(dir);

  const d = new Dispatcher(cfg(dir), new Store(dir));
  const log = d.conversation('c1').log;

  const created = log.filter((e) => e.type === 'task/created').map((e) => e.taskId);
  const completed = log.filter((e) => e.type === 'task/completed').map((e) => e.taskId);
  assert.deepEqual(created, ['t1']);
  assert.deepEqual(completed, ['t1'], 'each created task must be closed');

  const last = log.find((e) => e.type === 'task/completed');
  assert.equal(last.reason, 'interrupted');

  // 说话措辞不能断言"没做完" —— 系统只知道"被断了"
  const said = log.filter((e) => e.type === 'message/text').map((e) => e.text).join('');
  assert.match(said, /可能没做完/);

  d.shutdown();
});

test('陈年旧账悄悄清掉，不突然说一句', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-old-'));
  seedOrphan(dir, { ageMs: 48 * 60 * 60 * 1000 }); // 两天前

  const d = new Dispatcher(cfg(dir), new Store(dir));
  const log = d.conversation('c1').log;
  assert.equal(log.filter((e) => e.type === 'task/completed').length, 1, '还是要收口');
  assert.equal(
    log.filter((e) => e.type === 'message/text' && /断了/.test(e.text)).length,
    0,
    '但两天前的事不该突然冒出来说',
  );
  d.shutdown();
});

test('已经完成过的任务不会在重启时被重复收口/重复说话', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-done-'));
  const store = seedOrphan(dir);
  store.append('c1', { type: 'task/completed', seq: 6, taskId: 't1', at: Date.now() - 30 * 1000 });

  const d = new Dispatcher(cfg(dir), new Store(dir));
  const log = d.conversation('c1').log;
  assert.equal(log.filter((e) => e.type === 'task/completed').length, 1, '不该多出一条');
  assert.equal(log.filter((e) => e.type === 'message/text' && /断了/.test(e.text)).length, 0);
  d.shutdown();
});

test('同一件事重启两次只收口一次', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-twice-'));
  seedOrphan(dir);
  new Dispatcher(cfg(dir), new Store(dir)).shutdown();
  const d2 = new Dispatcher(cfg(dir), new Store(dir));
  const log = d2.conversation('c1').log;
  assert.equal(log.filter((e) => e.type === 'task/completed').length, 1);
  assert.equal(log.filter((e) => e.type === 'message/text' && /断了/.test(e.text)).length, 1);
  d2.shutdown();
});

test('手动收口：不存在或已完成的返回 false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-manual-'));
  seedOrphan(dir);
  const d = new Dispatcher(cfg(dir), new Store(dir));
  // 启动时已经自动收口了，再手动收一次应该 false
  assert.equal(d.completeTask('c1', 't1'), false);
  assert.equal(d.completeTask('c1', 'nope'), false);
  d.shutdown();
});
