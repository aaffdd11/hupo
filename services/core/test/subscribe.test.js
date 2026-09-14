// 会话订阅语义的回归测试。
//
// 这里守的是一条**踩过的坑**：开发者模式的连接必须**照样收到产品事件**。
// 曾经 subscribe(dev=true) 只把连接加进 devSubscribers，
// 于是开了开发者模式就再也收不到任何回复 —— 而开发者模式是默认开的，
// 等于整个应用对所有人都是哑的。（线上真实事故，2026-09-14）
//
// 跑：node --test "test/*.test.js"

import test from 'node:test';
import assert from 'node:assert/strict';

import { Conversation, MessageWriter } from '../src/conversation.js';

/** 收集一个订阅者收到的所有事件。 */
function collector() {
  const got = [];
  return { got, send: (e) => got.push(e) };
}

test('开发者模式的订阅者：产品事件和开发事件都要收到', () => {
  const conv = new Conversation('c1');
  const dev = collector();

  const unsub = conv.subscribe(dev.send, { dev: true });

  // 产品事件
  const w = new MessageWriter(conv, { messageId: 'm1', agent: 'receiver' });
  w.chunk('quick', '收到。', true);
  w.end();

  // 开发事件
  conv.emitDev({ type: 'dev/step', phase: 'expert', status: 'start', detail: '专家判断' });

  const types = dev.got.map((e) => e.type);
  assert.ok(types.includes('message/start'), '产品事件 message/start 必须收到');
  assert.ok(types.includes('message/text'), '产品事件 message/text 必须收到');
  assert.ok(types.includes('message/end'), '产品事件 message/end 必须收到');
  assert.ok(types.includes('dev/step'), '开发事件 dev/step 必须收到');

  unsub();
  // 退订后两边都不再收到
  const before = dev.got.length;
  w.chunk('deep', '不该收到。', true);
  conv.emitDev({ type: 'dev/step', phase: 'turn', status: 'end' });
  assert.equal(dev.got.length, before, '退订后不应再收到任何事件');
});

test('普通订阅者：只收产品事件，不收开发事件', () => {
  const conv = new Conversation('c2');
  const plain = collector();

  conv.subscribe(plain.send);

  const w = new MessageWriter(conv, { messageId: 'm1', agent: 'feedback' });
  w.chunk('quick', '好的。', true);
  conv.emitDev({ type: 'dev/step', phase: 'expert', status: 'start' });

  const types = plain.got.map((e) => e.type);
  assert.ok(types.includes('message/text'));
  assert.ok(!types.includes('dev/step'), '没开开发者模式就不该收到开发事件');
});

test('续传（replay）不受订阅影响：产品事件按 sinceSeq 补齐', () => {
  const conv = new Conversation('c3');
  const w = new MessageWriter(conv, { messageId: 'm1', agent: 'receiver' });
  w.chunk('quick', '一。', true);
  w.chunk('quick', '二。', true);
  w.chunk('quick', '三。', true);

  const got = [];
  conv.replay(1, (e) => got.push(e));
  assert.deepEqual(got.map((e) => e.seq), [2, 3, 4]);
});
