// 监控层（debug agent）的测试。
//
// 守四件事：
//   1. **每一个事件都必须有时间戳** —— 没有它就看不出"时效性对不对"
//   2. 把事件流正确折成"一轮一轮"，且能算出感知延迟（用户等多久才看到）
//   3. 规则能抓出真问题（久等、空窗、留客式追问、没结论）
//   4. 同一个毛病**不重复登记任务**（否则任务簿没法看）
//
// 跑：node --test "test/*.test.js"

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Conversation } from '../src/conversation.js';
import {
  TaskBook,
  computeTimeliness,
  computeTurns,
  extractJsonObject,
  ruleFindings,
  stuckTasks,
} from '../src/debug-agent.js';

const T0 = 1700000000000;

/** 造一段"用户说一句 → 助手答一句"的事件流。 */
function makeLog({ firstLineMs = 1400, turnEndMs = 4000, text = '收到了。', seen = true, userText = '测试' } = {}) {
  const log = [
    { type: 'user/echo', seq: 1, messageId: 'u1', text: userText, at: T0, clientAt: T0 },
    { type: 'message/start', seq: 2, messageId: 'm1', origin: 'reactive', at: T0 + 100 },
    { type: 'message/text', seq: 3, messageId: 'm1', block: 'quick', text, at: T0 + firstLineMs },
    { type: 'message/end', seq: 4, messageId: 'm1', reason: 'completed', at: T0 + turnEndMs },
  ];
  if (seen) {
    log.push({
      type: 'message/seen',
      seq: 5,
      messageId: 'm1',
      clientFirstSeenAt: T0 + firstLineMs + 120, // 网络 + 渲染
      clientEndedSeenAt: T0 + turnEndMs + 150,
    });
  }
  return log;
}

test('每个事件都带时间戳（未来新加的事件也不可能漏）', () => {
  const conv = new Conversation('c1');
  conv.emit({ type: 'message/status', messageId: 'm', state: 'working' });
  conv.emit({ type: 'message/text', messageId: 'm', block: 'quick', text: 'x' });
  conv.emit({ type: '某种将来才会有的事件', foo: 1 });
  conv.emitTransient({ type: 'client/reload', buildId: 'x' });

  assert.equal(conv.log.length, 3, 'transient 不进日志');
  for (const e of conv.log) {
    assert.equal(typeof e.at, 'number', `${e.type} 缺时间戳`);
    assert.ok(e.at > 0);
  }
});

test('调用方自带的时间戳优先（客户端时钟要能带进来）', () => {
  const conv = new Conversation('c1');
  conv.emit({ type: 'user/echo', messageId: 'u', text: 'x', at: 12345 });
  assert.equal(conv.log[0].at, 12345);
});

test('折算：一轮 = 用户说一句 → 到它引发的最后一条 message/end', () => {
  const turns = computeTurns(makeLog().concat(makeLog({ userText: '第二句' }).map((e) => ({ ...e, seq: e.seq + 10 }))));
  assert.equal(turns.length, 2);
  assert.equal(turns[0].userText, '测试');
  assert.equal(turns[0].messages.length, 1);
});

test('主动开口：没有用户输入也自成一 轮', () => {
  const turns = computeTurns([
    { type: 'message/start', seq: 1, messageId: 'm1', origin: 'proactive', at: T0 },
    { type: 'message/text', seq: 2, messageId: 'm1', block: 'deep', text: '那件事做完了。', at: T0 + 200 },
    { type: 'message/end', seq: 3, messageId: 'm1', reason: 'completed', at: T0 + 300 },
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].origin, 'proactive');
  assert.equal(turns[0].userText, '');
});

test('时效性：算得出"用户等了多久才看到第一句"', () => {
  const tl = computeTimeliness(computeTurns(makeLog()));
  const r = tl.turns[0];
  assert.equal(r.firstLineMs, 1400);
  assert.equal(r.firstLineSeenMs, 1520, '客户端口径 = 服务端口径 + 网络/渲染');
  assert.equal(r.turnEndMs, 4000);
  assert.equal(r.endedSeenMs, 4150);
  assert.equal(tl.summary.turns, 1);
});

test('感知延迟的可信度过滤：刷新后补发算出来的假数不采', () => {
  // 服务端只用了 1.8 秒，客户端却说 16 秒才看到 —— 参照点不对，丢掉
  const tl = computeTimeliness(computeTurns(makeLog({ firstLineMs: 1800, seen: false })));
  assert.equal(tl.turns[0].firstLineSeenMs, null, '没有回报就是 null');

  const skewed = makeLog({ firstLineMs: 1800 });
  skewed[4].clientFirstSeenAt = T0 + 16000;
  const r = computeTimeliness(computeTurns(skewed)).turns[0];
  assert.equal(r.firstLineMs, 1800);
  assert.equal(r.firstLineSeenMs, null, '差得离谱的客户端读数不能采信');
});

test('规则抓真问题：等太久 / 空窗太长 / 留客追问 / 没结论 / 一句话不说', () => {
  const slow = ruleFindings(computeTimeliness(computeTurns(makeLog({ firstLineMs: 9000 }))));
  assert.ok(slow.some((f) => f.kind === 'timeliness' && f.what.includes('第一句话')));

  const gap = ruleFindings(
    computeTimeliness(
      computeTurns([
        { type: 'user/echo', seq: 1, messageId: 'u1', text: 'x', at: T0, clientAt: T0 },
        { type: 'message/start', seq: 2, messageId: 'm1', at: T0 + 100 },
        { type: 'message/text', seq: 3, messageId: 'm1', block: 'quick', text: '收到。', at: T0 + 500 },
        { type: 'message/text', seq: 4, messageId: 'm1', block: 'deep', text: '结论。', at: T0 + 12000 },
        { type: 'message/end', seq: 5, messageId: 'm1', reason: 'completed', at: T0 + 12100 },
      ]),
    ),
  );
  assert.ok(gap.some((f) => f.what.includes('完全没有输出')), '空窗要被抓出来');

  const pushy = ruleFindings(computeTimeliness(computeTurns(makeLog({ text: '要不要我接着查？' }))));
  assert.ok(pushy.some((f) => f.severity === 'high' && f.what.includes('留客')), '留客式追问必须报');

  const failed = ruleFindings(
    computeTimeliness(
      computeTurns([
        { type: 'user/echo', seq: 1, messageId: 'u1', text: 'x', at: T0, clientAt: T0 },
        { type: 'message/start', seq: 2, messageId: 'm1', at: T0 + 100 },
        { type: 'message/end', seq: 3, messageId: 'm1', reason: 'failed', at: T0 + 200 },
      ]),
    ),
  );
  assert.ok(failed.some((f) => f.what.includes('没给出结论')), '失败轮必须报');

  const healthy = ruleFindings(computeTimeliness(computeTurns(makeLog())));
  assert.equal(healthy.length, 0, '正常一轮不该报问题');
});

test('量不出来的旧轮不产生假问题', () => {
  // 时间戳补齐之前写的事件：没有 endAt，也没有 firstTextAt
  const turns = computeTurns([
    { type: 'user/echo', seq: 1, messageId: 'u1', text: '老消息', at: T0 },
    { type: 'message/start', seq: 2, messageId: 'm1', at: T0 + 100 },
  ]);
  const findings = ruleFindings(computeTimeliness(turns));
  assert.equal(findings.length, 0, '没有时间戳的轮不能拿来下判断');
});

test('任务簿：同一个毛病不重复登记，只加计数', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-tasks-'));
  const book = new TaskBook(dir);

  const a = book.add({ title: '空窗太长', detail: 'x', severity: 'medium', kind: 'timeliness' });
  const b = book.add({ title: '空窗太长', detail: 'x', severity: 'medium', kind: 'timeliness' });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(book.list().length, 1);
  assert.equal(book.list()[0].seenCount, 2);

  book.complete(a.task.id);
  assert.equal(book.list({ status: 'open' }).length, 0);
  assert.equal(book.list({ status: 'done' }).length, 1);

  // 修完之后同样的问题再出现，应该**新开一条**（因为上一条已经关掉了）
  const c = book.add({ title: '空窗太长', detail: 'x' });
  assert.equal(c.created, true);
  assert.equal(book.list({ status: 'open' }).length, 1);
});

test('挂着没完成的任务会被揪出来（静默失败）', () => {
  // 这就是 2026-09-14 那次真实事故的形状：说了"我单独拿去做"就再也没回来
  const T0 = 1700000000000;
  const log = [
    { type: 'user/echo', seq: 1, messageId: 'u1', text: '帮我改一下浮窗', at: T0, clientAt: T0 },
    { type: 'task/created', seq: 2, taskId: 't1', title: '帮我改一下浮窗', at: T0 },
  ];
  const stuck = stuckTasks(log, { now: T0 + 30 * 60 * 1000 });
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].severity, 'high');
  assert.match(stuck[0].what, /30 分钟/);
  assert.match(stuck[0].what, /一直没回来/);

  // 刚建的还在宽限期内，不算"卡住"
  assert.equal(stuckTasks(log, { now: T0 + 1000 }).length, 0);

  // 完成了就不算
  const done = [...log, { type: 'task/completed', seq: 3, taskId: 't1', at: T0 + 60000 }];
  assert.equal(stuckTasks(done, { now: T0 + 30 * 60 * 1000 }).length, 0);
});

test('任务按类别立项：措辞不同、数字不同，同一类毛病只登记一条（踩过）', () => {
  // 机械规则的说法
  const rule = '时效：「上海现在天气怎么样」 中间有 9477ms 完全没有输出';
  // debug agent 的说法（措辞完全不同，但说的是同一类毛病）
  const model = '时效：「上海现在天气怎么样」这一轮，第一句 959 毫秒就出来了，但之后到结论之间出现 11792ms 完全无输出的空窗';
  assert.equal(TaskBook.issueClass(rule), 'gap');
  assert.equal(TaskBook.issueClass(model), 'gap');
  assert.equal(TaskBook.key(rule, 'timeliness'), TaskBook.key(model, 'timeliness'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-key-'));
  const book = new TaskBook(dir);
  book.add({ title: rule, detail: 'x', kind: 'timeliness' });
  book.add({ title: model, detail: 'y', kind: 'timeliness' });
  assert.equal(book.list().length, 1, '同一类毛病只该有一条任务');
  assert.equal(book.list()[0].seenCount, 2);
  assert.match(book.list()[0].detail, /y/, '保留最近一次的具体描述');

  // 不同类别要分开
  book.add({ title: '回答：来源条数是 0 却写了数据来自某网站', detail: 'z', kind: 'reasonableness' });
  assert.equal(book.list().length, 2);
});

test('从 agent 回复里抠 JSON：后面跟说明文字也不崩（踩过）', () => {
  assert.deepEqual(extractJsonObject('{"verdict":"好","problems":[]}'), { verdict: '好', problems: [] });
  assert.deepEqual(extractJsonObject('{"a":1}\n\n补充说明：这里用了 {花括号}'), { a: 1 });
  assert.deepEqual(extractJsonObject('前缀 {"s":"带\\"引号\\"","n":[1,2]} 后缀'), { s: '带"引号"', n: [1, 2] });
  assert.equal(extractJsonObject('完全没有 JSON'), null);
  assert.equal(extractJsonObject('{坏的'), null);
});
