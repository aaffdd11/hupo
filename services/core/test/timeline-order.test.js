// 「反馈完全按时间来说话」——把它写成一个**不变量**。
//
// 创始人原话（2026-09-14）：
//   「我发现你在尝试补齐对话。这个不对。不能补齐，反馈完全按时间来说话。」
//
// 他看到的"补齐"是这样的（按 seq，客户端就是按 seq 渲染的）：
//
//   seq 571  开气泡1
//   seq 572  写进气泡1  「收到，我去查…」
//   seq 573  开气泡2    「这件事比我想的久，我单独拿去做，完了跟你说。」
//   seq 578  写回气泡1  ← 答案长回了**上面那个**气泡
//
// 客户端一个 messageId 一个气泡、按 seq 排序 ⇒ **上面那个气泡在"我拿去做"
// 之后还在继续往后长** ⇒ 时间倒流 ⇒ 看起来像在补齐对话。
//
// 所以不变量是：**消息之间不许交叉**。
// 一条消息开始之后，就不能再有别的消息的正文写进更早的那条里。
//
// 跑：node --test "test/*.test.js"

import test from 'node:test';
import assert from 'node:assert/strict';

import { Conversation, MessageWriter, newId } from '../src/conversation.js';
import { TurnTranslator, looksLikeUnsourcedClaim } from '../src/session-translate.js';

/**
 * 把事件流折成"每条消息的 [开始seq, 结束seq]"。
 * @returns {{id: string, start: number, end: number}[]}
 */
function spans(log) {
  const out = [];
  const byId = new Map();
  for (const e of log) {
    if (e.type === 'message/start') {
      const rec = { id: e.messageId, start: e.seq, end: e.seq };
      byId.set(e.messageId, rec);
      out.push(rec);
    } else if (e.type === 'message/end') {
      const rec = byId.get(e.messageId);
      if (rec) rec.end = e.seq;
    }
  }
  return out;
}

/** 断言：任何两条消息的时间区间**不重叠**（不交叉）。 */
function assertNoInterleave(log, why) {
  const s = spans(log);
  for (let i = 1; i < s.length; i++) {
    assert.ok(
      s[i].start > s[i - 1].end,
      `${why}：消息交叉了 —— 「${s[i - 1].id}」到 seq${s[i - 1].end} 还没完，` +
        `「${s[i].id}」在 seq${s[i].start} 就开了。反馈没有按时间说话。`,
    );
  }
}

/** 造一个 translator，喂一串 session 事件，返回它产生的事件流。 */
function run(events) {
  const conv = new Conversation('c1');
  const t = new TurnTranslator(conv, { nextProvenance: () => ({ origin: 'reactive', re: [] }) });
  for (const e of events) t.handle({ event: e });
  return { conv, t };
}

const turnStart = (turn = 1) => ({ type: 'turn/start', data: { turn } });
const say = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
const toolCall = (name = 'web_search') => ({ type: 'tool/call', data: { name, arguments: '{}' } });

test('不变量：消息之间不交叉（每轮结束时成立）', () => {
  const { conv } = run([turnStart(), say('收到，我先去查。'), toolCall(), say('查到了，结论是这样。'), { type: 'turn/end', data: {} }]);
  assertNoInterleave(conv.log, '普通一轮');
  assert.equal(spans(conv.log).length, 1, '没挪走时就是一条消息');
});

test('挪走（handoff）：先把当前气泡收口，后面的话另起一条', () => {
  const { conv, t } = run([turnStart(), say('收到，我先去查。')]);
  const before = spans(conv.log);
  assert.equal(before.length, 1, '先只有"收到"那一条');

  t.handoff(); // 「这件事我单独拿去做，完了跟你说」

  // 挪走之后 agent 才把答案说出来
  t.handle({ event: say('查到了，夜萝莉就是叶罗丽的早期名字。') });
  t.handle({ event: { type: 'turn/end', data: {} } });

  const s = spans(conv.log);
  assert.equal(s.length, 2, '答案必须另起一条，不能长回上面那条');
  assertNoInterleave(conv.log, '挪走之后');

  // "收到"那条必须**在**答案那条开始之前就收口了
  const ack = conv.log.find((e) => e.type === 'message/text' && e.text.includes('收到'));
  const answer = conv.log.find((e) => e.type === 'message/text' && e.text.includes('夜萝莉'));
  assert.ok(ack.seq < answer.seq, '答案在时间上必须晚于"收到"');
  assert.notEqual(ack.messageId, answer.messageId, '两条不能是同一个气泡');

  const answerStart = conv.log.find((e) => e.type === 'message/start' && e.messageId === answer.messageId);
  assert.equal(answerStart.origin, 'proactive', '另起的那条是"做完了回来说"');
});

test('挪走时 agent 还没说话：不留空气泡', () => {
  const { conv, t } = run([turnStart()]);
  assert.equal(t.handoff(), null === null ? t.current : null, 'handoff 返回当前这轮');
  // 一句话都没说过 ⇒ 不该冒出一个空的 message/start
  assert.equal(conv.log.filter((e) => e.type === 'message/start').length, 0, '别留空气泡');

  t.handle({ event: say('做完了，结果是这个。') });
  t.handle({ event: { type: 'turn/end', data: {} } });
  const s = spans(conv.log);
  assert.equal(s.length, 1, '只该有一条（答案那条）');
  assertNoInterleave(conv.log, '空手套');
});

test('挪走只生效一次（两句"我拿去做"不该裂成三条）', () => {
  const { conv, t } = run([turnStart(), say('收到。')]);
  t.handoff();
  t.handoff();
  t.handle({ event: say('答案。') });
  t.handle({ event: { type: 'turn/end', data: {} } });
  assert.equal(spans(conv.log).length, 2);
  assertNoInterleave(conv.log, '重复挪走');
});

test('来源跟着新那条走（旧那条收口时不能带上后来的来源）', () => {
  const { conv, t } = run([turnStart(), say('收到，我去查。')]);
  t.handoff();
  t.handle({
    event: {
      type: 'tool/result',
      data: { meta: { sources: [{ url: 'https://a.com/x', title: 'A' }] } },
    },
  });
  t.handle({ event: say('答案。') });
  t.handle({ event: { type: 'turn/end', data: {} } });

  const ends = conv.log.filter((e) => e.type === 'message/end');
  assert.equal(ends.length, 2);
  assert.equal((ends[0].sources ?? []).length, 0, '"收到"那条那时还没有来源');
  assert.equal((ends[1].sources ?? []).length, 1, '来源归到答案那条');
});

// ── 不能说半句话就当作说完了 ──────────────────────────────────
//
// 真实事故（2026-09-14）：agent 撞上输出长度上限，`turn/end` 的 reason 是
// `max-tokens`，可见文本断在半句（「一个是"避」「临海老」）——
// 而翻译层原来**一律写 completed**，用户拿到一个"看起来说完了"的残篇。
//
// 不变量：**一轮非正常收尾时，最后必须有一句说清"这条没说完"。**

test('撞上长度上限：必须补一句说明，不能把半句当完整回答', () => {
  const { conv } = run([
    turnStart(),
    say('收到，我去把这几块资料查齐了再讲。'),
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } },
  ]);
  const texts = conv.log.filter((e) => e.type === 'message/text').map((e) => e.text);
  assert.ok(texts.some((t) => t.includes('截断')), `要补一句说清被截断了，实际：${JSON.stringify(texts)}`);

  const end = conv.log.find((e) => e.type === 'message/end');
  assert.equal(end.reason, 'failed', '截断不是正常完成，不能标 completed');
});

test('正常收尾：不许多那句废话', () => {
  const { conv } = run([
    turnStart(),
    say('上海的天气今天多云。'),
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]);
  const texts = conv.log.filter((e) => e.type === 'message/text').map((e) => e.text);
  assert.equal(texts.length, 1);
  assert.ok(!texts[0].includes('截断'));
  assert.equal(conv.log.find((e) => e.type === 'message/end').reason, 'completed');
});

test('被中断（进程没了）：同样要补一句', () => {
  const { conv } = run([
    turnStart(),
    say('我正在查'),
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } },
  ]);
  const texts = conv.log.filter((e) => e.type === 'message/text').map((e) => e.text);
  assert.ok(texts.some((t) => t.includes('断了')), '被中断也要说清');
  assert.equal(conv.log.find((e) => e.type === 'message/end').reason, 'failed');
});

test('一句话都没说就断了：也要给个交代，不能留白', () => {
  const { conv } = run([turnStart(), { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } }]);
  const texts = conv.log.filter((e) => e.type === 'message/text').map((e) => e.text);
  assert.ok(texts.length >= 1, '绝不能一个字都不说就收口');
});

// ── 编造具体来源 ──────────────────────────────────────────────
//
// 真实事故：回答里写「上海师范大学 2010 年有一篇硕士论文专门研究这个，
// 访谈了 227 名 3 到 5 岁幼儿」，而那一轮**来源条数 0**。
// 年份、机构、样本量俱全，听起来特别可信 —— 正是最该拦住的那一类。
//
// 光靠提示词挡不住（模型顺口就编齐了），所以机械兜一道。

test('无来源的具体研究断言：会被认出来', () => {
  const bad = [
    '上海师范大学 2010 年有一篇硕士论文专门研究这个，访谈了 227 名 3 到 5 岁幼儿',
    '研究表明，睡眠不足会影响记忆',
    '受访者中有 68% 表示同意',
    '样本量 500 人的调查显示',
    '据 2023 年的统计，这个比例在上升',
  ];
  for (const t of bad) {
    assert.equal(looksLikeUnsourcedClaim(t), true, `该认出来：${t}`);
  }
});

test('正常说法不会被误伤（宽了比漏了更烦人）', () => {
  const ok = [
    '今天上海多云，气温 24 到 31 度',
    '现在是 2026 年 9 月 14 日星期一',
    '我们刚才聊了三条',
    '我查到了，数据来自中国天气网',
    '明天最高 28 度，你带把伞',
  ];
  for (const t of ok) {
    assert.equal(looksLikeUnsourcedClaim(t), false, `不该误伤：${t}`);
  }
});

test('无来源的具体断言 ⇒ 收口前补一句提醒', () => {
  const { conv, t } = run([turnStart(), say('上海师范大学 2010 年有一篇硕士论文，访谈了 227 名幼儿。')]);
  t.handle({ event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } });
  const texts = conv.log.filter((e) => e.type === 'message/text').map((e) => e.text);
  assert.ok(texts.some((x) => x.includes('出处')), `要补一句提醒，实际：${JSON.stringify(texts)}`);
});

test('有来源时**不**补那句（真查到了就别说废话）', () => {
  const { conv, t } = run([turnStart()]);
  t.handle({
    event: { type: 'tool/result', data: { meta: { sources: [{ url: 'https://a.com/x', title: 'A' }] } } },
  });
  t.handle({ event: say('研究表明这个结论成立。') });
  t.handle({ event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } });
  const texts = conv.log.filter((e) => e.type === 'message/text').map((e) => e.text);
  assert.equal(texts.length, 1, '有来源就不该补');
});

test('来源跟着**结论**走，不挂在"我拿去做"之前的应声条上', () => {
  // 实测踩过：工具在挪走之前就返回了，16 条来源全挂到"收到，我去查…"，
  // 而真正给结论的那条一条来源都没有 —— 正好挂反了。
  const { conv, t } = run([turnStart(), say('收到，我去查。')]);
  t.handle({
    event: { type: 'tool/result', data: { meta: { sources: [{ url: 'https://a.com/x', title: 'A' }] } } },
  }); // ← 挪走**之前**就拿到来源了
  t.handoff();
  t.handle({ event: say('查到了，结论是这样。') });
  t.handle({ event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } });

  const ends = conv.log.filter((e) => e.type === 'message/end');
  assert.equal(ends.length, 2);
  assert.equal((ends[0].sources ?? []).length, 0, '应声条不该带来源');
  assert.equal((ends[1].sources ?? []).length, 1, '来源要挂在给结论的那条上');
});
