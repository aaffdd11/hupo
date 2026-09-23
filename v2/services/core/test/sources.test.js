// **出处**（「它替你查过的东西，是哪来的」）· 契约 `docs/dev/67-SOURCES.md`。
//
// 这一份钉四件：
//   ① 纯函数：只认 `web_search` / `web_fetch`，坏载荷 ⇒ **空**（不许编一条来源出来）
//   ② 🔴 **工具名 / 查询词 / 别的 meta 字段一个字节都不许进 `sources`**（它会画在屏幕上）
//   ③ 真跑一遍翻译层：一轮里查过 ⇒ `message/end.sources` 有那几条（持久、带 seq）
//   ④ 负向对照：没查过 ⇒ `sources` **是空的**（这个字段一直在 —— `message-writer.js` 的 `end()`
//      本来就带它；判据是"里面没有东西"，不是"字段不在"）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_SOURCES, sourceLabel, sourcesFromToolResult } from '../src/sources.js';
import { TurnTranslator } from '../src/session-translate.js';
import { collector, tempTimeline } from './helpers.js';

// ══ ① 纯函数 ═══════════════════════════════════════════════

test('★ `web_search` 的结果 ⇒ 出处（有标题用标题）', () => {
  const got = sourcesFromToolResult('web_search', {
    sources: [
      { url: 'https://www.weather.com.cn/beijing', title: '中国天气网 · 北京' },
      { url: 'https://example.com/a', title: '  ' },
    ],
    truncated: false,
    answer: '这段是给模型看的，不是出处',
  });
  assert.deepEqual(got, [
    { url: 'https://www.weather.com.cn/beijing', title: '中国天气网 · 北京' },
    { url: 'https://example.com/a', title: 'example.com' }, // 没标题 ⇒ 域名
  ]);
});

test('★ `web_fetch` 的结果 ⇒ 一条出处（上游没给标题 ⇒ 域名）', () => {
  const got = sourcesFromToolResult('web_fetch', { url: 'https://news.example.cn/x/y', statusCode: 200, truncated: false });
  assert.deepEqual(got, [{ url: 'https://news.example.cn/x/y', title: 'news.example.cn' }]);
});

test('🔴 只认那两件工具：别的工具**一条都不算出处**', () => {
  const meta = { sources: [{ url: 'https://a.example/x', title: '甲' }] };
  for (const name of ['read', 'write', 'bash', 'todo_write', 'web_search_v2', undefined, null, 42]) {
    assert.deepEqual(sourcesFromToolResult(name, meta), [], String(name));
  }
});

test('🔴 坏载荷 ⇒ 空（宁可不显示，也不显示一条没核对过的来源）', () => {
  for (const meta of [undefined, null, 42, 'x', [], {}, { sources: 'x' }, { sources: [null, 7, 'x', {}] }]) {
    assert.deepEqual(sourcesFromToolResult('web_search', meta), [], JSON.stringify(meta));
  }
  // 非 http(s) 的一律不算（`javascript:` / `data:` / `file:` 不该被点开）
  assert.deepEqual(sourcesFromToolResult('web_fetch', { url: 'javascript:alert(1)' }), []);
  assert.deepEqual(sourcesFromToolResult('web_fetch', { url: 'file:///etc/passwd' }), []);
  assert.deepEqual(sourcesFromToolResult('web_fetch', { url: '   ' }), []);
});

test('★ 同一页查两次 ⇒ 只算一条；条数**封顶**', () => {
  const twice = sourcesFromToolResult('web_search', {
    sources: [
      { url: 'https://a.example/x', title: '甲' },
      { url: 'https://a.example/x', title: '甲（又查了一次）' },
    ],
  });
  assert.equal(twice.length, 1, '同一个 URL 只留一条');

  const many = Array.from({ length: MAX_SOURCES + 5 }, (_, i) => ({ url: `https://s${i}.example/x`, title: `第 ${i}` }));
  assert.equal(sourcesFromToolResult('web_search', { sources: many }).length, MAX_SOURCES, '上限住代码里');
});

test('🔴 只带 `title` 与 `url` 两个字段（`snippet`/`publishedAt`/`answer` 一律不带出去）', () => {
  const got = sourcesFromToolResult('web_search', {
    sources: [{ url: 'https://a.example/x', title: '甲', snippet: '摘要不该出去', publishedAt: '2026-09-23', hidden: 1 }],
    answer: '答案不该出去',
    truncated: true,
  });
  assert.deepEqual(Object.keys(got[0]).sort(), ['title', 'url']);
});

test('★ 名字：有标题用标题；没有用域名（去 `www.`）；坏 URL 原样还回去', () => {
  assert.equal(sourceLabel('https://x.example/a', '标题'), '标题');
  assert.equal(sourceLabel('https://www.x.example/a'), 'x.example');
  assert.equal(sourceLabel('https://sub.a.example/b'), 'sub.a.example');
  assert.equal(sourceLabel('不是个地址'), '不是个地址');
});

// ══ ② 真跑一遍翻译层 ═══════════════════════════════════════

/** 喂一串会话事件，返回 `message/end` 那条（没有就 undefined）。 */
function feed(events) {
  const { store, timeline } = tempTimeline();
  const c = collector();
  timeline.subscribe(c.fn);
  const t = new TurnTranslator({ timeline });
  for (const e of events) t.handle({ event: e });
  return store.readAll('main').find((e) => e.type === 'message/end');
}

test('★ 一轮里查过 ⇒ `message/end.sources` 真的有那几条', () => {
  const end = feed([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'web_search', arguments: '{"queries":["北京天气"]}' } },
    { type: 'tool/result', data: { turn: 1, step: 1, meta: { sources: [{ url: 'https://www.weather.com.cn/bj', title: '中国天气网' }] }, message: {} } },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '北京今天多云。' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]);
  assert.ok(end, '这一轮得收口');
  assert.equal(typeof end.seq, 'number', '带号 ⇒ 补发时也看得到');
  assert.deepEqual(end.sources, [{ url: 'https://www.weather.com.cn/bj', title: '中国天气网' }]);
});

test('🔴 负向对照：没查过 ⇒ `sources` 是**空的**（这个字段一直在：空 = 没有出处）', () => {
  const end = feed([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"/x"}' } },
    { type: 'tool/result', data: { turn: 1, step: 1, meta: { sources: [{ url: 'https://a.example/x', title: '甲' }] }, message: {} } },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '看了下文件。' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]);
  assert.ok(end);
  assert.deepEqual(end.sources, [], '没查过 ⇒ 里面一条都没有（⚠️ 字段本身一直在，见 `message-writer.js` 的 `end()`）');
});

test('🔴 工具名与入参**一个字节都不进** `message/end`（屏幕上会出现的字段）', () => {
  const end = feed([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'web_search', arguments: '{"queries":["秘密查询词"]}' } },
    { type: 'tool/result', data: { turn: 1, step: 1, meta: { sources: [{ url: 'https://a.example/x', title: '甲' }] }, message: {} } },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '查到了。' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]);
  const raw = JSON.stringify(end);
  for (const word of ['web_search', 'secret', '秘密查询词', 'callId', 'c1', 'queries', 'arguments']) {
    assert.equal(raw.includes(word), false, `不该出现：${word}`);
  }
});

test('★ 出处攒在**这一轮**上：下一轮的收口不带上一轮的（负向对照）', () => {
  const ends = [];
  const { store, timeline } = tempTimeline();
  const c = collector();
  timeline.subscribe(c.fn);
  const t = new TurnTranslator({ timeline });
  const batch = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'web_search', arguments: '{}' } },
    { type: 'tool/result', data: { turn: 1, step: 1, meta: { sources: [{ url: 'https://a.example/x', title: '甲' }] }, message: {} } },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '第一轮。' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: '第二轮。' }] } } },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ];
  for (const e of batch) t.handle({ event: e });
  for (const e of store.readAll('main')) if (e.type === 'message/end') ends.push(e);
  assert.equal(ends.length, 2);
  assert.deepEqual(ends[0].sources, [{ url: 'https://a.example/x', title: '甲' }]);
  assert.deepEqual(ends[1].sources, [], '第二轮没查过 ⇒ 不许继承第一轮的出处');
});

test('★ 查完才断的轮：出处照样进 `message/end`（收尾那一版是权威）', () => {
  const end = feed([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'web_search', arguments: '{}' } },
    { type: 'tool/result', data: { turn: 1, step: 1, meta: { sources: [{ url: 'https://a.example/x', title: '甲' }] }, message: {} } },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '查到一半……' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } },
  ]);
  assert.equal(end.reason, 'failed');
  assert.deepEqual(end.sources, [{ url: 'https://a.example/x', title: '甲' }], '断了也要说清是查过哪儿');
});
