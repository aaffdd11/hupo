// 一条消息的生命周期 —— 对应手册 `08-SPEC.md` §5.1：
//   `start → text* → end`；**`chunk()` 必须先查 `ended`**；
//   **`end()` 幂等**；**end 带最终来源**；**同一时刻最多一条未收口**。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MessageWriter, newMessageId } from '../src/message-writer.js';
import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';
import { collector, failingFs, tempTimeline } from './helpers.js';

function setup() {
  const { timeline, store } = tempTimeline();
  const c = collector();
  timeline.subscribe(c.fn);
  return { timeline, store, c };
}

test('顺序：start → text* → end', () => {
  const { timeline, c } = setup();
  const w = new MessageWriter({ timeline, agent: 'agent', origin: 'reactive' });
  w.start();
  w.chunk('quick', '收到。');
  w.chunk('deep', '结论是 42。');
  w.end();

  assert.deepEqual(c.types(), ['message/start', 'message/text', 'message/text', 'message/end']);
  assert.equal(w.text, '收到。结论是 42。');
  assert.equal(w.ended, true);
});

test('没有 start 就 chunk：自动补 start（不留半截气泡）', () => {
  const { timeline, c } = setup();
  const w = new MessageWriter({ timeline, agent: 'agent', origin: 'reactive' });
  w.chunk('quick', '直接说');
  assert.deepEqual(c.types(), ['message/start', 'message/text']);
});

test('一句话没说就 end：也要有 start（否则界面留白）', () => {
  const { timeline, c } = setup();
  const w = new MessageWriter({ timeline, agent: 'agent', origin: 'reactive' });
  w.end('failed');
  assert.deepEqual(c.types(), ['message/start', 'message/end']);
});

test('★ 收口之后不许再写 —— 这正是事故"消息不许交叉"的成因', () => {
  const { timeline } = setup();
  const w = new MessageWriter({ timeline, agent: 'agent', origin: 'reactive' });
  w.start();
  w.chunk('quick', '说完了');
  w.end();

  assert.throws(() => w.chunk('deep', '这句不该写进去'), /已收口/);
});

test('★ end 幂等：重复收口不产生第二条收尾事件', () => {
  const { timeline, c } = setup();
  const w = new MessageWriter({ timeline, agent: 'agent', origin: 'reactive' });
  w.start();
  assert.equal(w.end(), true);
  assert.equal(w.end(), false);
  assert.equal(w.end(), false);
  assert.equal(c.types().filter((t) => t === 'message/end').length, 1);
});

test('★ 同一时刻最多一条未收口（N22）', () => {
  const { timeline } = setup();
  const a = new MessageWriter({ timeline, agent: 'agent', origin: 'reactive' });
  const b = new MessageWriter({ timeline, agent: 'agent', origin: 'reactive' });
  a.start();
  assert.throws(() => b.start(), /同一时刻最多一条未收口/);

  a.end();
  b.start(); // 收口之后就能开了
  assert.equal(timeline.openMessageId, b.messageId);
  b.end();
  assert.equal(timeline.openMessageId, null);
});

test('★ end 带最终来源（协议 R8：end.sources 覆盖 start）', () => {
  const { timeline, c } = setup();
  const w = new MessageWriter({ timeline, agent: 'agent', origin: 'reactive' });
  w.start();
  w.chunk('deep', '查到三条。');
  w.sources = [{ title: '来源一' }];
  w.end();

  const end = c.got.find((e) => e.type === 'message/end');
  assert.deepEqual(end.sources, [{ title: '来源一' }]);
});

test('换手（handoff）的正确姿势：先收口旧的那条，再开新的', () => {
  const { timeline, c } = setup();
  const first = new MessageWriter({ timeline, agent: 'agent', origin: 'reactive' });
  first.start();
  first.chunk('quick', '我去查一下。');
  first.end(); // ← 必须先收口

  const second = new MessageWriter({ timeline, agent: 'agent', origin: 'proactive' });
  second.start();
  second.chunk('deep', '查到了。');
  second.end();

  assert.equal(c.types().filter((t) => t === 'message/end').length, 2);
  assert.notEqual(first.messageId, second.messageId);
});

test('agent / origin 必填，origin 只许两个值', () => {
  const { timeline } = setup();
  assert.throws(() => new MessageWriter({ timeline, origin: 'reactive' }), /agent 必填/);
  assert.throws(() => new MessageWriter({ timeline, agent: 'a', origin: '随便' }), /origin 只能/);
});

test('messageId 前缀是 m_（服务端生成的身份字段约定）', () => {
  assert.match(newMessageId(), /^m_/);
});

test('★ 落盘失败：chunk 抛错，且订阅者一条都没收到', () => {
  const store = new Store({ dataDir: '/nowhere', fs: failingFs(), fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const c = collector();
  timeline.subscribe(c.fn);

  const w = new MessageWriter({ timeline, agent: 'agent', origin: 'reactive' });
  assert.throws(() => w.start(), /落盘失败/);
  assert.deepEqual(c.got, []);
  assert.equal(timeline.seq, 0);
  assert.equal(timeline.openMessageId, null, '失败的开场不该留下"未收口"状态');
});
