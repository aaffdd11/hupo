// **运行记录（用量链）** —— 契约 `docs/dev/93-OUTBOUND-USAGE.md` §四／§五 ·
// 主人 2026-09-25 第 7／8 条 ＋ P2-3（`docs/dev/96-OWNER-DECISIONS.md`）。
//
// 每条判据都带**反例**：
//   U-1 🔴 那条断链：`usage` 到了翻译层就被丢 ⇒ 现在**按 `scopeId` 落账**（判据 5.2.2）
//   U-2 🔴 按 app 归因（判据 5.2.1）：A 房 3 次、B 房 1 次 ⇒ 各记各的
//   U-3 🔴 **只记量**（判据 4.1.1）：正文／URL 一个字节都不许进这个文件
//   U-4 🔴 三格拆分 ＋ `cacheRead` **不进任何阈值**（判据 4.1.2）
//   U-5 🔴 日均与曲线**读取时算**（不另存第二份）；跨天**多一行**（不覆盖）
//   U-6 🔴 记录住登记（`hupo/apps/<id>/`），不住工作区（判据 4.2.1）
//   U-7 🔴 写失败**留痕且不挡**（判据 4.5.5）
//   U-8 🔴 卸载 ⇒ 记录随 app 挪进 `.removed/`（判据 4.4.2）
//   U-9 🔴 盒里那份 vs 运营方那份：以运营方为准；对不上有**可查的偏差信号**（主人第 7 条）
//   U-10 ★ P2-3：**一个账本三个计数器**（token／张数／分钟），对外仍一个数

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { Apps } from '../src/apps.js';
import { Dispatcher } from '../src/dispatcher.js';
import {
  USAGE_KINDS,
  UsageLedger,
  aggregate,
  dayOf,
  normalizeUsage,
  oneNumber,
  reconcileUsage,
  scopeForUsage,
  usageDeviation,
} from '../src/usage.js';
import { tempTimeline } from './helpers.js';

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});

function tmp(prefix = 'hupo-usage-') {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function world() {
  const dir = tmp();
  const apps = new Apps({ dir, sub: 'u1' });
  const usage = new UsageLedger({ apps });
  return { dir, apps, usage };
}

/** 一个只够调度器用的假 runtime（照 `notice.test.js` 那条）。 */
function stubRuntime() {
  const agent = new EventEmitter();
  agent.prompt = async () => ({ messageId: 'm_1' });
  return { agent: () => agent, stop: async () => {} };
}

function makeDispatcher({ onUsage, scopeId = 'main' } = {}) {
  const { store, timeline } = tempTimeline();
  const dispatcher = new Dispatcher({
    timeline,
    runtime: stubRuntime(),
    store,
    scopeId,
    agentKey: `u1/${scopeId}`,
    turnDeadlineMs: 0,
    onUsage,
  });
  return { dispatcher, timeline };
}

// ════════════════════════════════════════════════════════════════
// U-1 🔴 那条断链接上了（判据 5.2.2）
// ════════════════════════════════════════════════════════════════

test('🔴 U-1 塞一个假 `usage` 进翻译层 ⇒ 盘上**多一行**；不接回调（老行为）⇒ 零行', () => {
  const w = world();
  const seen = [];
  const { dispatcher: d } = makeDispatcher({
    onUsage: ({ scopeId, turn, usage }) => {
      seen.push({ scopeId, turn });
      w.usage.note(scopeId, { kind: USAGE_KINDS.agentTurn, usage, scopeId, turn });
    },
  });
  // 翻译层真的会带 `usage` 出来（`session-translate.js` 那一行）
  d.translator.emit('text', { turn: 7, text: '你好', usage: { prompt_tokens: 120, completion_tokens: 30 } });
  assert.deepEqual(seen, [{ scopeId: 'main', turn: 7 }]);
  const rows = w.usage.rows('main');
  assert.equal(rows.length, 1, '🔴 盘上必须多一行（改前这一行是 0 —— `dispatcher.js` 只解构 `{text}`）');
  assert.equal(rows[0].uncachedInput, 120);
  assert.equal(rows[0].output, 30);
  assert.equal(rows[0].kind, 'agent-turn');

  // **反例正身**：老行为（不接 `onUsage`）⇒ 盘上零行
  const w2 = world();
  const { dispatcher: old } = makeDispatcher({ onUsage: null });
  old.translator.emit('text', { turn: 1, text: '你好', usage: { prompt_tokens: 9 } });
  assert.equal(w2.usage.rows('main').length, 0, '没接线 ⇒ 不记（这就是改前那条断链的样子）');

  // `usage` 缺失 ⇒ 不记（不许拿 0 充一笔）
  const { dispatcher: d3 } = makeDispatcher({ onUsage: ({ usage }) => { assert.fail(`usage 为空不该回调：${JSON.stringify(usage)}`); } });
  d3.translator.emit('text', { turn: 2, text: '没有用量' });
  assert.equal(w.usage.rows('main').length, 1);
});

test('🔴 U-2 按 app 归因（判据 5.2.1）：A 房 3 次、B 房 1 次、主线 1 次 ⇒ 各记各的', () => {
  const w = world();
  const { dispatcher: d, timeline } = makeDispatcher({
    onUsage: ({ scopeId, turn, usage }) => w.usage.note(scopeId, { kind: USAGE_KINDS.agentTurn, usage, scopeId, turn }),
  });
  d.addSession({ scope: 'app-a', timeline, agentKey: 'u1/app-a' });
  d.addSession({ scope: 'app-b', timeline, agentKey: 'u1/app-b' });
  const usage = { prompt_tokens: 10, completion_tokens: 1 };
  for (let i = 0; i < 3; i += 1) d.sessionFor('app-a').translator.emit('text', { turn: i + 1, text: `a${i}`, usage });
  d.sessionFor('app-b').translator.emit('text', { turn: 1, text: 'b', usage });
  d.translator.emit('text', { turn: 1, text: '主线', usage });

  assert.equal(w.usage.rows('app-a').length, 3, 'A 房 3 次');
  assert.equal(w.usage.rows('app-b').length, 1, 'B 房 1 次');
  assert.equal(w.usage.rows('main').length, 1, '主线的那本账是主线自己的');
  assert.equal(w.usage.rows('app-a').every((r) => r.scopeId === 'app-a'), true, '🔴 scopeId 不许串');
  assert.equal(w.usage.rows('app-b')[0].scopeId, 'app-b');
});

// ════════════════════════════════════════════════════════════════
// U-3 🔴 只记量（判据 4.1.1）
// ════════════════════════════════════════════════════════════════

test('🔴 U-3 往那一轮塞私密哨兵与 URL ⇒ `usage.jsonl` 里**零命中**，而且字段就是那几个量', () => {
  const w = world();
  const SENTINEL = '私密哨兵-9f3a-别外传';
  const { dispatcher: d } = makeDispatcher({
    onUsage: ({ scopeId, turn, usage }) => w.usage.note(scopeId, { kind: USAGE_KINDS.agentTurn, usage, scopeId, turn }),
  });
  d.translator.emit('text', {
    turn: 1,
    text: `${SENTINEL} 我看了 https://example.com/secret 这个页面`,
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  });
  const file = nodePath.join(w.dir, 'hupo', 'apps', 'main', 'usage.jsonl');
  const raw = nodeFs.readFileSync(file, 'utf8');
  assert.equal(raw.includes(SENTINEL), false, '🔴 正文进了账 ⇒ 那就是访问日志（主人点名不许）');
  assert.equal(/https?:\/\//.test(raw), false, '🔴 URL 一个都不许有');
  const row = JSON.parse(raw.trim());
  assert.deepEqual(
    Object.keys(row).sort(),
    ['at', 'cacheRead', 'calls', 'day', 'images', 'kind', 'output', 'schema', 'scopeId', 'source', 'turn', 'uncachedInput', 'voiceSeconds'].sort(),
    '记录只许有"量"那几个字段（多一个内容字段就是访问日志的苗头）',
  );
});

// ════════════════════════════════════════════════════════════════
// U-4 🔴 三格 ＋ `cacheRead` 不进阈值（判据 4.1.2）
// ════════════════════════════════════════════════════════════════

test('🔴 U-4 三格拆开记；`cacheRead` 不进**对外那一个数**、也不进阈值', () => {
  // DeepSeek 形状：prompt_cache_hit_tokens 是 cache read
  const ds = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 900 });
  assert.equal(ds.uncachedInput, 100, 'uncached = prompt − cache hit');
  assert.equal(ds.output, 50);
  assert.equal(ds.cacheRead, 900);
  assert.equal(oneNumber(ds), 150, '🔴 对外那一个数**不含** cache read');
  // Anthropic 形状
  const an = normalizeUsage({ input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 10_000 });
  assert.equal(an.uncachedInput, 20);
  assert.equal(an.cacheRead, 10_000);
  assert.equal(oneNumber(an), 25);
  // 认不出 ⇒ 全 0 且 known:false（不许拿总数当"没缓存"）
  assert.equal(normalizeUsage({ total_tokens: 999 }).known, false);
  assert.equal(normalizeUsage({ total_tokens: 999 }).uncachedInput, 0);
  // 🔴 反例正身：拿 cache read 去比阈值 ⇒ 一个几乎免费的量把阈值淹没
  const dev = usageDeviation({ measured: oneNumber(an), declared: 0 });
  assert.equal(dev.verdict, 'ok', '有 1 万 cache read、对外那个数只有 25 ⇒ 不该被判成偏离');
});

// ════════════════════════════════════════════════════════════════
// U-5 🔴 读取时算 ＋ 跨天多一行（不覆盖）
// ════════════════════════════════════════════════════════════════

test('🔴 U-5 跨天**多一行**（不覆盖）；日均与曲线读取时算，**不另存第二份**', () => {
  const w = world();
  const day1 = Date.parse('2026-09-20T10:00:00Z');
  const day2 = Date.parse('2026-09-21T10:00:00Z');
  w.usage.note('news', { kind: USAGE_KINDS.agentTurn, usage: { prompt_tokens: 100, completion_tokens: 0 }, at: day1 });
  w.usage.note('news', { kind: USAGE_KINDS.agentTurn, usage: { prompt_tokens: 300, completion_tokens: 0 }, at: day2 });
  const rows = w.usage.rows('news');
  assert.equal(rows.length, 2, '🔴 跨天多一行（`ask.json` 那种整份覆盖在这里是错的）');
  assert.deepEqual(rows.map((r) => r.day), ['2026-09-20', '2026-09-21']);
  assert.equal(rows[0].day, dayOf(day1));

  // 读取时算
  const s = w.usage.summary('news');
  assert.deepEqual(s.days.map((d) => d.day), ['2026-09-20', '2026-09-21']);
  assert.equal(s.totals.ones, 400);
  assert.equal(s.dailyAverage.ones, 200);
  assert.equal(s.badLines, 0);

  // **反例正身**：不许另存一份"算好的日均"
  const appDir = nodePath.join(w.dir, 'hupo', 'apps', 'news');
  const files = nodeFs.readdirSync(appDir).sort();
  assert.deepEqual(files, ['usage.jsonl'], `🔴 算出来的东西不许再存一份：${JSON.stringify(files)}`);
  // 纯函数再算一遍，与读出来的逐字一致（同一份数字不许两处）
  assert.deepEqual(aggregate(rows).dailyAverage, s.dailyAverage);
});

// ════════════════════════════════════════════════════════════════
// U-6 🔴 住登记，不住工作区
// ════════════════════════════════════════════════════════════════

test('🔴 U-6 记录住 `hupo/apps/<id>/usage.jsonl`，**不在** `workspaces/<scope>/` 里', () => {
  const w = world();
  w.usage.note('news', { kind: USAGE_KINDS.ask, usage: { prompt_tokens: 3, completion_tokens: 1 } });
  const inApps = nodePath.join(w.dir, 'hupo', 'apps', 'news', 'usage.jsonl');
  assert.equal(nodeFs.existsSync(inApps), true);
  assert.equal(inApps.startsWith(nodePath.join(w.dir, 'workspaces')), false, '🔴 放工作区 ⇒ 会被快照带走');
  assert.equal(scopeForUsage(''), 'main');
  assert.equal(scopeForUsage('  '), 'main');
});

// ════════════════════════════════════════════════════════════════
// U-7 🔴 写失败留痕、不挡（判据 4.5.5）
// ════════════════════════════════════════════════════════════════

test('🔴 U-7 盘写不进去 ⇒ 不抛（不挡那一轮）＋ 另留一行痕', () => {
  const w = world();
  const logs = [];
  const failing = {
    ...nodeFs,
    appendFileSync: (p, data, opts) => {
      if (String(p).endsWith('usage.jsonl')) throw new Error('ENOSPC: no space left');
      return nodeFs.appendFileSync(p, data, opts);
    },
  };
  const ledger = new UsageLedger({
    apps: { appDir: w.apps.appDir.bind(w.apps), fs: failing },
    log: (m) => logs.push(m),
  });
  const r = ledger.note('news', { kind: USAGE_KINDS.agentTurn, usage: { prompt_tokens: 1 } });
  assert.equal(r.ok, false, '如实回"没记上"');
  assert.match(r.error, /ENOSPC/);
  assert.equal(ledger.failures, 1);
  assert.equal(logs.length, 1, '日志里也要看得到');
  const trace = nodePath.join(w.dir, 'hupo', 'apps', 'news', 'usage-failures.jsonl');
  assert.equal(nodeFs.existsSync(trace), true, '🔴 F10：写失败要留痕');
  assert.match(nodeFs.readFileSync(trace, 'utf8'), /ENOSPC/);
  // 口径认不出 ⇒ 也不抛（如实回）
  const bad = ledger.note('news', { kind: '不认识的那种' });
  assert.equal(bad.ok, false);
});

// ════════════════════════════════════════════════════════════════
// U-8 🔴 卸载 ⇒ 记录跟着挪进 `.removed/`
// ════════════════════════════════════════════════════════════════

test('🔴 U-8 卸载 ⇒ 记录随 app 进 `.removed/`（不是消失）', () => {
  const w = world();
  w.apps.create({ id: 'news', title: '新闻', icon: 'dice', entry: 'index.html', files: { 'index.html': '<p>x</p>' } });
  w.usage.note('news', { kind: USAGE_KINDS.agentTurn, usage: { prompt_tokens: 20, completion_tokens: 2 } });
  const before = nodePath.join(w.dir, 'hupo', 'apps', 'news', 'usage.jsonl');
  assert.equal(nodeFs.existsSync(before), true);
  w.apps.remove('news');
  assert.equal(nodeFs.existsSync(before), false, '原来那一格收起来了');
  const removed = nodePath.join(w.dir, 'hupo', 'apps', '.removed');
  const dirs = nodeFs.readdirSync(removed).filter((n) => n.startsWith('news-'));
  assert.equal(dirs.length, 1);
  assert.equal(nodeFs.existsSync(nodePath.join(removed, dirs[0], 'usage.jsonl')), true, '🔴 记录还在（删错了能拿回来）');
});

// ════════════════════════════════════════════════════════════════
// U-9 🔴 主人第 7 条：以运营方为准，偏差可查
// ════════════════════════════════════════════════════════════════

test('🔴 U-9 盒里那份 vs 运营方那份：对不上给**可查的偏差信号**；缺一份 ⇒ unknown（不当成 0）', () => {
  const match = reconcileUsage({ box: 1000, operator: 1000 });
  assert.equal(match.verdict, 'match');
  assert.equal(match.authoritative, 'operator');
  const dev = reconcileUsage({ box: 10, operator: 100_000 });
  assert.equal(dev.verdict, 'deviation');
  assert.match(dev.signal, /以运营方为准/);
  const noBox = reconcileUsage({ box: null, operator: 5 });
  assert.equal(noBox.verdict, 'unknown');
  assert.match(noBox.signal, /盒里那份读不到/);
  const noOp = reconcileUsage({ box: 5, operator: null });
  assert.equal(noOp.verdict, 'unknown');
  assert.match(noOp.signal, /运营方那份读不到/);
});

// ════════════════════════════════════════════════════════════════
// U-10 ★ P2-3：一个账本三个计数器
// ════════════════════════════════════════════════════════════════

test('★ U-10 一个账本三个计数器：token／张数／分钟都在同一份记录里，对外仍一个数', () => {
  const w = world();
  w.usage.note('news', { kind: USAGE_KINDS.agentTurn, usage: { prompt_tokens: 100, completion_tokens: 20 } });
  w.usage.note('news', { kind: USAGE_KINDS.ask, usage: { prompt_tokens: 50, completion_tokens: 10 } });
  w.usage.note('news', { kind: USAGE_KINDS.image, images: 2 });
  w.usage.note('news', { kind: USAGE_KINDS.voice, voiceSeconds: 150 });
  const s = w.usage.summary('news');
  assert.equal(s.totals.ones, 180, '对外那一个数 = 三格里的 uncachedInput + output');
  assert.equal(s.totals.images, 2, '画了几张');
  assert.equal(s.totals.voiceSeconds, 150);
  assert.equal(s.dailyAverage.voiceMinutes, 2.5, '听了几分钟（读取时算）');
  assert.equal(w.usage.submittedSummary('news').totals.images, 2, '上架要交的那份摘要能从记录复算');
  // 摘要**不带身份**（93 §4.5.3）
  const file = nodePath.join(w.dir, 'hupo', 'apps', 'news', 'usage.jsonl');
  assert.equal(/sub|author|phone/iu.test(nodeFs.readFileSync(file, 'utf8')), false);
});
