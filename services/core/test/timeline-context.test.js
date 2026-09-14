// 喂给 agent 的"刚才说到哪了"必须是**按时间的流水**，不是补出来的对话。
//
// 主人 2026-09-14 的原话：「不能补齐，反馈完全按时间来说话。」
// 之前这里是折成一问一答的摘要，而且只留快答那半句 —— 结论被丢掉，
// agent 看到自己说过"收到，我去查…"却没看到答案，就会把话往回补。
// 这个测试把两条钉住：① 按时间顺序、带时间戳；② 深答（结论）不能被丢掉。

import test from 'node:test';
import assert from 'node:assert/strict';

import { timelineContext } from '../src/conversation.js';
import { recapPrompt } from '../src/dispatcher.js';

const t = (h, m, s) => new Date(2026, 8, 14, h, m, s).getTime();

function log() {
  return [
    { type: 'user/echo', seq: 1, text: '杭州今天天气怎么样', at: t(15, 5, 44) },
    { type: 'message/start', seq: 2, messageId: 'm1', at: t(15, 5, 46) },
    { type: 'message/text', seq: 3, messageId: 'm1', block: 'quick', text: '收到，我查一下杭州今天的天气。', at: t(15, 5, 46) },
    { type: 'message/text', seq: 4, messageId: 'm1', block: 'deep', text: '杭州今天小雨转晴，22 到 30 度。', at: t(15, 5, 56) },
    { type: 'message/end', seq: 5, messageId: 'm1', at: t(15, 5, 56) },
    { type: 'user/echo', seq: 6, text: '谢谢', at: t(15, 6, 10) },
    { type: 'message/text', seq: 7, messageId: 'm2', block: 'quick', text: '不客气。', at: t(15, 6, 12) },
    { type: 'user/echo', seq: 8, text: '那明天呢', at: t(15, 7, 0) },
  ];
}

test('按时间顺序原样列出，每条带自己的时间戳', () => {
  const out = timelineContext(log());
  const lines = out.split('\n');
  assert.deepEqual(
    lines.map((l) => l.slice(0, 8)),
    ['15:05:44', '15:05:46', '15:05:56', '15:06:10', '15:06:12'],
  );
  assert.match(lines[0], /^15:05:44 {2}主人：杭州今天天气怎么样$/);
  assert.match(lines[2], /^15:05:56 {2}你：杭州今天小雨转晴/);
});

test('深答（结论）不会被丢掉 —— 否则 agent 只能往回补', () => {
  const out = timelineContext(log());
  assert.match(out, /收到，我查一下杭州今天的天气。/);
  assert.match(out, /杭州今天小雨转晴，22 到 30 度。/);
});

test('不配对、不归纳：用户的话和助手的话都各自成行', () => {
  const out = timelineContext(log());
  const users = out.split('\n').filter((l) => l.includes('主人：'));
  assert.deepEqual(users.map((l) => l.split('主人：')[1]), ['杭州今天天气怎么样', '谢谢']);
});

test('当前这句输入不算背景，它由调用方单独接在后面', () => {
  const out = timelineContext(log());
  assert.doesNotMatch(out, /那明天呢/);
});

test('回溯上限按"用户说了几句"算', () => {
  const out = timelineContext(log(), 1);
  assert.doesNotMatch(out, /杭州今天天气怎么样/);
  assert.match(out, /谢谢/);
});

test('没有历史时给空串（全新会话不必硬凑背景）', () => {
  assert.equal(timelineContext([{ type: 'user/echo', seq: 1, text: '你好', at: t(9, 0, 0) }]), '');
  assert.equal(timelineContext([]), '');
});

test('接记忆的那一段：流水在前，这一句输入在后，且明说不许补', () => {
  const p = recapPrompt('15:05:44  主人：杭州今天天气怎么样', '那明天呢');
  assert.ok(p.indexOf('15:05:44') < p.indexOf('主人现在说：那明天呢'));
  assert.match(p, /不要替它补没说过的话/);
  assert.match(p, /按时间/);
});
