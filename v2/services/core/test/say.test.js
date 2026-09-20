// `/api/say` 的验收 —— 幂等（手册 §2.1，评审 E2：旧实现没有去重）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SayError, SayService } from '../src/say.js';
import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';
import { collector, failingFs, tempStore } from './helpers.js';

function setup() {
  const { dataDir, store } = tempStore();
  const timeline = new Timeline({ id: 'main', store });
  const say = new SayService({ timeline, store, timelineId: 'main' });
  const c = collector();
  timeline.subscribe(c.fn);
  return { dataDir, store, timeline, say, c };
}

test('说一句：落一条 user/echo', () => {
  const { say, c } = setup();
  const r = say.say({ messageId: 'u_1', text: '帮我把这周工时记一下' });
  assert.equal(r.duplicate, false);
  assert.equal(r.event.seq, 1);
  assert.deepEqual(c.types(), ['user/echo']);
});

test('★ 同一个 messageId 重发 ⇒ 幂等，不再落一次', () => {
  const { say, c } = setup();
  say.say({ messageId: 'u_1', text: '第一遍' });
  const again = say.say({ messageId: 'u_1', text: '第一遍' });
  assert.equal(again.duplicate, true);
  assert.equal(again.event, undefined);
  assert.equal(c.types().filter((t) => t === 'user/echo').length, 1, '只该落一次');
});

test('★ 幂等跨重启有效（客户端重发往往正好发生在服务端刚重启时）', () => {
  const { dataDir, store, say } = setup();
  say.say({ messageId: 'u_1', text: '发一次' });

  const store2 = new Store({ dataDir, fsync: false });
  const timeline2 = new Timeline({ id: 'main', store: store2 });
  const say2 = new SayService({ timeline: timeline2, store: store2, timelineId: 'main' });

  assert.equal(say2.seenCount, 1, '重启后应能从日志重建');
  const again = say2.say({ messageId: 'u_1', text: '发一次' });
  assert.equal(again.duplicate, true, '重启后同 id 仍不许重复落盘');
});

test('不同的 messageId 各自落一条', () => {
  const { say, c } = setup();
  say.say({ messageId: 'u_1', text: 'A' });
  say.say({ messageId: 'u_2', text: 'B' });
  assert.equal(c.types().filter((t) => t === 'user/echo').length, 2);
});

test('空文本要拒', () => {
  const { say } = setup();
  assert.throws(() => say.say({ messageId: 'u_1', text: '' }), SayError);
  assert.throws(() => say.say({ messageId: 'u_1', text: '   ' }), /空话/);
});

test('缺 messageId 要拒（没有它就没法幂等）', () => {
  const { say } = setup();
  assert.throws(() => say.say({ text: '说了话' }), /缺 messageId/);
});

test('超长要拒，且给 413', () => {
  const { say } = setup();
  try {
    say.say({ messageId: 'u_1', text: 'x'.repeat(8001) });
    assert.fail('应该抛');
  } catch (err) {
    assert.equal(err.status, 413);
  }
});

test('clientAt 只记录，排序仍用服务端 at（不许混钟）', () => {
  const { say } = setup();
  const r = say.say({ messageId: 'u_1', text: 'A', clientAt: 999999999999 });
  assert.equal(r.event.clientAt, 999999999999);
  assert.notEqual(r.event.at, 999999999999, '★ at 必须是服务端的钟');
});

test('★ 落盘失败时：say 抛，且**不能**把 messageId 记成"见过"', () => {
  const store = new Store({ dataDir: '/nowhere', fs: failingFs(), fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const say = new SayService({ timeline, store, timelineId: 'main' });

  assert.throws(() => say.say({ messageId: 'u_1', text: '会失败' }), /落盘失败/);
  assert.equal(say.seenCount, 0, '★ 没落盘就不算说过——否则重发会被当重复而永久丢掉');
});
