// **出网留痕**的判据（P2-8 · 主人 2026-09-25 拍板「② 先只做出网留痕」）。
//
// 守的几条：
//   ① 🔴 **不记正文**：只落域名/时间/量 —— URL 的路径与查询串、标题、摘要、
//      查询词**一个字节都不许进记录**（哨兵法；反例就是往那些地方塞私密哨兵）；
//   ② 🔴 **不改网络**：这个模块不认识 socket / 不装代理 / 不改路由（源码里也扫一遍）；
//   ③ **认不出来就不记**（不是那两件工具 / URL 坏了 / meta 坏了 ⇒ 空数组，不猜）；
//   ④ 🔴 **写不进去不许挡住那一轮**：写失败留在 `errors` 里，**不抛**；
//   ⑤ 记录落 `hupo/egress.jsonl`，**不在**工作区、**不在**制品里。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import {
  EGRESS_FILE,
  EGRESS_REL,
  EgressLog,
  egressFromToolResult,
  egressPath,
  hostOf,
} from '../src/egress-log.js';
import { TurnTranslator } from '../src/session-translate.js';
import { tempTimeline } from './helpers.js';

function tmp() {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-egress-'));
}

// ══ ① 纯函数：取出网留痕 ═══════════════════════════════════
test('① `web_fetch` ⇒ 记**请求的目标域名**＋状态＋字节（只这三样）', () => {
  const out = egressFromToolResult('web_fetch', {
    url: 'https://News.Example.COM/a/b?q=1#frag',
    statusCode: 200,
    bytes: 4096,
    truncated: false,
    title: '不该被记的标题',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].host, 'news.example.com', '★ 只留域名（小写），路径/查询串都丢掉');
  assert.equal(out[0].role, 'target');
  assert.equal(out[0].status, 200);
  assert.equal(out[0].bytes, 4096);
  assert.equal(out[0].results, null);
  // 拿不到数字 ⇒ null（**不猜**）
  const bare = egressFromToolResult('web_fetch', { url: 'https://a.example/x' });
  assert.equal(bare[0].bytes, null);
  assert.equal(bare[0].status, null);
});

test('① `web_search` ⇒ 记**结果来自哪几个域名**＋条数（不记标题/摘要）', () => {
  const out = egressFromToolResult('web_search', {
    sources: [
      { url: 'https://a.example/1', title: '甲', snippet: '摘要' },
      { url: 'https://www.b.example/2', title: '乙' },
      { url: 'https://a.example/3', title: '甲又一条' }, // 同一站 ⇒ 只算一条
      { url: '不是地址', title: '坏' },
    ],
  });
  assert.deepEqual(out.map((x) => x.host), ['a.example', 'www.b.example']);
  assert.equal(out[0].role, 'result');
  assert.equal(out[0].results, 4, '条数＝它收到几条（量）');
  assert.equal(out[0].bytes, null);
});

test('③ 认不出来就不记（别的工具 / 坏 URL / 坏 meta ⇒ 空数组）', () => {
  assert.deepEqual(egressFromToolResult('read', { url: 'https://a.example/x' }), []);
  assert.deepEqual(egressFromToolResult('bash', { url: 'https://a.example/x' }), []);
  assert.deepEqual(egressFromToolResult('web_fetch', null), []);
  assert.deepEqual(egressFromToolResult('web_fetch', { url: 'file:///etc/passwd' }), [], '不是 http(s) ⇒ 认不出');
  assert.deepEqual(egressFromToolResult('web_fetch', { url: '不是地址' }), []);
  assert.deepEqual(egressFromToolResult('web_search', {}), []);
  assert.equal(hostOf('https://X.example/a'), 'x.example');
  assert.equal(hostOf('nope'), null);
});

test('🔴 不改网络（源码里也不许出现 socket / 代理 / 路由那套东西）', () => {
  const src = nodeFs.readFileSync(nodePath.resolve(import.meta.dirname, '../src/egress-log.js'), 'utf8');
  const body = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const bad of ['node:net', 'node:http', 'node:https', 'createConnection', 'request(', 'proxy', 'iptables']) {
    assert.equal(body.includes(bad), false, `★ 留痕模块不该碰网络：${bad}`);
  }
});

// ══ ② 落盘那本账 ═══════════════════════════════════════════
test('⑤ 落 `hupo/egress.jsonl`（0600），可读回来；不在工作区、不在制品里', () => {
  const dir = tmp();
  try {
    const log = new EgressLog({ dir, sub: 'u2', now: () => 42 });
    assert.equal(log.path, egressPath(dir));
    assert.equal(log.path, nodePath.join(dir, EGRESS_REL));
    assert.equal(EGRESS_REL, nodePath.join('hupo', EGRESS_FILE));
    assert.equal(log.noteAll(egressFromToolResult('web_fetch', { url: 'https://a.example/x', bytes: 7 })), 1);
    const rows = log.read();
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      at: 42, sub: 'u2', tool: 'web_fetch', role: 'target', host: 'a.example', bytes: 7, status: null, results: null,
    });
    assert.equal(nodeFs.statSync(log.path).mode & 0o777, 0o600, '留痕文件 0600');
    // ⚠️ 不在工作区、也不在任何 `versions/` 里（93 §4.2 同款纪律）
    assert.equal(log.path.includes(`${nodePath.sep}workspaces${nodePath.sep}`), false);
    assert.equal(log.path.includes(`${nodePath.sep}versions${nodePath.sep}`), false);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('🔴 不记正文（反例）：把私密哨兵塞进 path/query/标题/摘要 ⇒ 记录里**零命中**', () => {
  const dir = tmp();
  try {
    const SENTINEL = '私密哨兵-9f3a-不许出现';
    const log = new EgressLog({ dir, sub: 'u2' });
    log.noteAll(egressFromToolResult('web_fetch', {
      url: `https://a.example/${SENTINEL}?q=${SENTINEL}`,
      title: SENTINEL,
      body: SENTINEL,
    }));
    log.noteAll(egressFromToolResult('web_search', {
      sources: [{ url: `https://b.example/${SENTINEL}?q=${SENTINEL}`, title: SENTINEL, snippet: SENTINEL }],
    }));
    const raw = nodeFs.readFileSync(log.path, 'utf8');
    assert.equal(raw.includes(SENTINEL), false, `★ 记录里一个正文片段都不许有：${raw}`);
    assert.equal(raw.includes('q='), false, '查询串也不许有');
    assert.equal(raw.includes('/9f3a'), false, '路径也不许有');
    assert.ok(raw.includes('"host":"a.example"'), '但域名要在（这才是"往哪发"）');
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('④ 写不进去 ⇒ **只记不抛**（errors 留痕），坏行读的时候跳过', () => {
  const boom = {
    mkdirSync: () => {},
    appendFileSync: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); },
  };
  const said = [];
  const log = new EgressLog({ dir: '/nowhere', fs: boom, log: (m) => said.push(m) });
  assert.equal(log.noteAll(egressFromToolResult('web_fetch', { url: 'https://a.example/x' })), 0);
  assert.deepEqual(log.errors, ['ENOSPC']);
  assert.ok(said.some((m) => m.includes('没写进去')), '写失败要留一句痕');

  // 坏行（写一半）⇒ 读回来时跳过，不让整本账读不出来
  const dir = tmp();
  try {
    const good = new EgressLog({ dir });
    good.noteAll(egressFromToolResult('web_fetch', { url: 'https://a.example/x' }));
    nodeFs.appendFileSync(good.path, '{"at":1,"host":"b.example"'); // 半行
    assert.equal(good.read().length, 1, '半行跳过，好的那行照读');
    assert.equal(good.note({}), false, '没有 host ⇒ 不记（不猜一个空域名）');
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

// ══ ③ 翻译层真的把它交出去 ═════════════════════════════════
test('★ 翻译层：`tool/result` 到了 ⇒ 出网痕迹交给上层', () => {
  const { timeline } = tempTimeline();
  const got = [];
  const t = new TurnTranslator({ timeline, onEgress: (e) => got.push(e) });
  t.handle({ event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'web_fetch', arguments: '{"url":"https://a.example/秘密"}' } } });
  t.handle({ event: { type: 'tool/result', data: { turn: 1, step: 1, meta: { url: 'https://a.example/秘密?q=哨兵', statusCode: 200 } } } });
  assert.equal(got.length, 1);
  assert.equal(got[0].entries[0].host, 'a.example');
  assert.equal(JSON.stringify(got[0]).includes('秘密'), false, '★ 交给上层的只有域名与量');
  assert.equal(JSON.stringify(got[0]).includes('哨兵'), false);

  // 第二条：同一个人的另一次出网照记
  t.handle({ event: { type: 'tool/call', data: { turn: 2, step: 1, callId: 'c2', name: 'web_search', arguments: '{"queries":["不许进留痕的词"]}' } } });
  t.handle({ event: { type: 'tool/result', data: { turn: 2, step: 1, meta: { sources: [{ url: 'https://b.example/y', title: '乙' }] } } } });
  assert.equal(got.length, 2);
  assert.equal(got[1].entries[0].host, 'b.example');
  assert.equal(JSON.stringify(got[1]).includes('不许进留痕的词'), false, '查询词一个字节都不进留痕');

  // 🔴 反例：**配不上工具名**（没收到 `tool/call`）⇒ 不记 —— 认不出就不许猜
  t.handle({ event: { type: 'tool/result', data: { turn: 2, step: 9, meta: { url: 'https://c.example/z' } } } });
  assert.equal(got.length, 2, '认不出是哪件工具 ⇒ 不记（不猜）');

  // 没接回调 ⇒ 什么都不发生（老行为）
  const t2 = new TurnTranslator({ timeline });
  assert.doesNotThrow(() => {
    t2.handle({ event: { type: 'tool/result', data: { turn: 3, step: 1, meta: { url: 'https://d.example/z' } } } });
  });
});

test('🔴 回调抛了 ⇒ 不许把这一轮弄失败（留痕是旁路）', () => {
  const { timeline } = tempTimeline();
  const t = new TurnTranslator({ timeline, onEgress: () => { throw new Error('账本炸了'); } });
  assert.doesNotThrow(() => {
    t.handle({ event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'web_fetch', arguments: '{}' } } });
    t.handle({ event: { type: 'tool/result', data: { turn: 1, step: 1, meta: { url: 'https://a.example/x' } } } });
  });
});
