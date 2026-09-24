// **上架前的评审**（A16＋A17 的"评审"那一半）—— 契约 `docs/dev/93-OUTBOUND-USAGE.md` §三／§六 ·
// 主人 2026-09-25 第 1／2／3／3b／4 条（`docs/dev/96-OWNER-DECISIONS.md`）。
//
// 每条判据都带**反例**：
//   R-1 🔴 规则读不到 / 指纹对不上 / 被改过 ⇒ **不自动放行**（fail-closed）
//   R-2 🔴 规则只许**更严**：想把自动放行那一档放宽到代码门槛以外 ⇒ 拒
//   R-3 🔴 低风险 ⇒ 自动放行；高风险 ⇒ **找主人**（门槛住代码）
//   R-4 🔴 评审 agent 没接上 / 回的东西认不出 ⇒ **escalate**（不许因为"审不了"就放行）
//   R-5 🔴 结论**绑 `rootHash`** 落 `review.jsonl`，只追加；下一版不覆盖上一版
//   R-6 🔴 读不到申报 / 审不了 ⇒ 拒；**共享库一个字节都不动**
//   R-7 🔴 用量与申报严重偏离 ⇒ escalate（以运营方为准，偏差不静默）
//   R-8 ★ 预审与运营方复评对不上 ⇒ 红（96 我自定的第 4 条）
//   R-9 🔴 规则住**产品层只读挂载 ＋ 指纹**（用户改不了的那一份）

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { OUTBOUND_DECL_FILENAME } from '../src/app-outbound.js';
import { Apps } from '../src/apps.js';
import { handleAppsOp } from '../src/apps-socket.js';
import { Published } from '../src/published.js';
import {
  REVIEW_AUTO_PASS_MAX_RISK,
  REVIEW_FILENAME,
  ReviewError,
  appendReview,
  assertReviewPolicy,
  buildReviewPolicy,
  compareReviews,
  loadReviewPolicy,
  operatorReview,
  preReview,
  reviewRows,
  rulesHashOf,
} from '../src/review.js';
import { UsageLedger } from '../src/usage.js';

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});

function tmp(prefix = 'hupo-review-') {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const APP = { title: '新闻', icon: 'dice', entry: 'index.html' };

const DECLARATION = JSON.stringify({
  schema: 1,
  outbound: [],
  declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '还没人用过，先按 0 报' },
});

function world({ declaration = DECLARATION } = {}) {
  const dir = tmp();
  const apps = new Apps({ dir, sub: 'u1' });
  const published = new Published({ dir });
  const usage = new UsageLedger({ apps });
  const files = { 'index.html': '<p>新闻</p>', ...(declaration === null ? {} : { [OUTBOUND_DECL_FILENAME]: declaration }) };
  const man = apps.create({ id: 'news', ...APP, files });
  return { dir, apps, published, usage, man };
}

const PASS = async () => ({ summary: '看了一遍，没看到外联风险', risks: [], rating: 0, verdict: 'pass' });
const HIGH = async () => ({ summary: '这份东西会往外发东西', risks: ['未申报的出网点'], rating: 5, verdict: 'pass' });
const REJECT = async () => ({ summary: '这段代码会把他的私密内容发出去', risks: ['私密内容外发'], rating: 5, verdict: 'reject' });

const caught = (fn) => { try { fn(); return null; } catch (err) { return err; } };
const caughtAsync = async (fn) => { try { await fn(); return null; } catch (err) { return err; } };

// ════════════════════════════════════════════════════════════════
// R-1／R-2：规则那两道
// ════════════════════════════════════════════════════════════════

test('🔴 R-1 规则缺指纹 / 认不出 / **正文被改过**（rulesHash 对不上）⇒ 拒', () => {
  const good = buildReviewPolicy({ fingerprint: 'fp1' });
  assert.equal(assertReviewPolicy(good).autoPassMaxRisk, REVIEW_AUTO_PASS_MAX_RISK);

  assert.match(String(caught(() => assertReviewPolicy(null))?.message), /读不出来/);
  assert.match(String(caught(() => assertReviewPolicy({ ...good, schema: 9 }))?.message), /版本认不出/);
  assert.match(String(caught(() => assertReviewPolicy({ ...good, fingerprint: '' }))?.message), /没有指纹/);
  assert.match(String(caught(() => assertReviewPolicy({ ...good, rules: null }))?.message), /没有规则正文/);
  // ★ 反例正身：**只改正文、不改 rulesHash** ⇒ 当场认出来
  const tampered = { ...good, rules: { ...good.rules, autoPassMaxRisk: 5 } };
  const err = caught(() => assertReviewPolicy(tampered));
  assert.ok(err instanceof ReviewError, String(err));
  assert.match(err.message, /对不上（被改过）/, err.message);
  // 连 rulesHash 一起改（把门槛放宽）⇒ 第二道把它拦下来
  const loosened = { ...tampered, rulesHash: rulesHashOf(tampered.rules) };
  assert.match(String(caught(() => assertReviewPolicy(loosened))?.message), /放宽到代码那道门槛以外/);
  // 少一道必须的检查 ⇒ 拒
  const missing = buildReviewPolicy({ fingerprint: 'fp1', checks: ['declaration'] });
  assert.match(String(caught(() => assertReviewPolicy(missing))?.message), /少了一道必须的检查/);
});

test('🔴 R-9 规则住**产品层**（只读挂载 ＋ 指纹）：指纹对不上 / 读不到 ⇒ 拒', () => {
  const root = tmp('hupo-code-');
  const fp = 'abc123abc123';
  nodeFs.mkdirSync(nodePath.join(root, fp), { recursive: true });
  nodeFs.writeFileSync(nodePath.join(root, fp, 'manifest.json'), JSON.stringify({ fingerprint: fp }));
  nodeFs.symlinkSync(nodePath.join(root, fp), nodePath.join(root, 'current'));

  // 没有规则文件 ⇒ 拒
  assert.match(String(caught(() => loadReviewPolicy({ codeRoot: root }))?.message), /没有预审规则/);

  // 规则指纹与产品层对不上 ⇒ 拒
  nodeFs.writeFileSync(
    nodePath.join(root, fp, 'review-policy.json'),
    JSON.stringify(buildReviewPolicy({ fingerprint: '别人的指纹' })),
  );
  assert.match(String(caught(() => loadReviewPolicy({ codeRoot: root }))?.message), /指纹.*对不上/);

  // 对得上 ⇒ 过，且读的就是产品层那一份
  const policy = buildReviewPolicy({ fingerprint: fp });
  nodeFs.writeFileSync(nodePath.join(root, fp, 'review-policy.json'), JSON.stringify(policy));
  const got = loadReviewPolicy({ codeRoot: root });
  assert.equal(got.fingerprint, fp);
  assert.equal(got.source, nodePath.join(root, fp));

  // **反着验**：用户改规则正文（不动指纹）⇒ 指纹那一关能过，但 rulesHash 那一关抓住
  const edited = { ...policy, rules: { ...policy.rules, autoPassMaxRisk: 5 } };
  nodeFs.writeFileSync(nodePath.join(root, fp, 'review-policy.json'), JSON.stringify(edited));
  assert.match(String(caught(() => loadReviewPolicy({ codeRoot: root }))?.message), /对不上（被改过）/);

  // 产品层都读不到 ⇒ 拒（不许猜一份默认规则）
  assert.match(String(caught(() => loadReviewPolicy({ codeRoot: nodePath.join(root, '没有') }))?.message), /读不到产品层/);

  // ★ **容器里那种摆法**：整份只读挂进 `/app/code`（没有 `current` 软链）⇒ 走 `codeDir`
  const boxDir = tmp('hupo-box-');
  nodeFs.writeFileSync(nodePath.join(boxDir, 'manifest.json'), JSON.stringify({ fingerprint: 'boxfp' }));
  nodeFs.writeFileSync(nodePath.join(boxDir, 'review-policy.json'), JSON.stringify(buildReviewPolicy({ fingerprint: 'boxfp' })));
  const gotBox = loadReviewPolicy({ codeDir: boxDir });
  assert.equal(gotBox.fingerprint, 'boxfp');
  assert.equal(gotBox.source, boxDir);
  // 容器里规则被改过 ⇒ 同样抓住
  nodeFs.writeFileSync(
    nodePath.join(boxDir, 'review-policy.json'),
    JSON.stringify({ ...buildReviewPolicy({ fingerprint: 'boxfp' }), rules: { checks: ['declaration', 'outbound-scan', 'usage'], autoPassMaxRisk: 4 } }),
  );
  assert.match(String(caught(() => loadReviewPolicy({ codeDir: boxDir }))?.message), /对不上（被改过）/);
});

// ════════════════════════════════════════════════════════════════
// R-3／R-4：低风险放行、高风险找主人、审不了不放行
// ════════════════════════════════════════════════════════════════

test('★ R-3 低风险 ⇒ 自动放行；结论绑 `rootHash` 落 `review.jsonl`', async () => {
  const w = world();
  const policy = buildReviewPolicy({ fingerprint: 'fp' });
  const out = await preReview({ apps: w.apps, id: 'news', policy, agent: PASS });
  assert.equal(out.allow, true, JSON.stringify(out));
  assert.equal(out.verdict, 'pass');
  const rows = reviewRows(w.apps, 'news');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rootHash, w.man.rootHash, '结论要指得到被审那一版的起点');
  assert.equal(rows[0].scope, 'pre');
  assert.equal(rows[0].what, 'outbound-review');
  assert.equal(rows[0].verdict, 'pass');
  assert.equal(rows[0].rating, 0);
  assert.equal(rows[0].by, 'pre-review');
});

test('🔴 R-3 高风险（评级超过代码门槛）⇒ **找主人**（escalate），不自动放行', async () => {
  const w = world();
  const policy = buildReviewPolicy({ fingerprint: 'fp' });
  const out = await preReview({ apps: w.apps, id: 'news', policy, agent: HIGH });
  assert.equal(out.allow, false);
  assert.equal(out.verdict, 'escalate');
  assert.equal(out.refused, 'high-risk');
  assert.match(out.words, /请主人看一眼/);
  assert.equal(reviewRows(w.apps, 'news')[0].verdict, 'escalate');
});

test('🔴 R-4 评审 agent 没接上 / 回的东西认不出 / 直接抛 ⇒ 一律 escalate（fail-closed）', async () => {
  const w = world();
  const policy = buildReviewPolicy({ fingerprint: 'fp' });
  const noAgent = await preReview({ apps: w.apps, id: 'news', policy, agent: null });
  assert.equal(noAgent.allow, false);
  assert.equal(noAgent.refused, 'reviewer-unavailable');
  assert.match(noAgent.words, /还没接上评审 agent/);

  const junk = await preReview({ apps: w.apps, id: 'news', policy, agent: async () => ({ nope: 1 }) });
  assert.equal(junk.refused, 'reviewer-unavailable');

  const boom = await preReview({ apps: w.apps, id: 'news', policy, agent: async () => { throw new Error('模型没答'); } });
  assert.equal(boom.refused, 'reviewer-unavailable');
  assert.match(boom.words, /模型没答/);
});

test('🔴 R-4 没有规则（产品层读不到）⇒ escalate，**不是跳过预审**', async () => {
  const w = world();
  const out = await preReview({ apps: w.apps, id: 'news', policy: null, agent: PASS });
  assert.equal(out.allow, false);
  assert.equal(out.refused, 'no-policy');
  assert.match(out.words, /请主人看一眼/);
});

test('🔴 R-3 评审说"不能上架" ⇒ reject（不是 escalate）', async () => {
  const w = world();
  const policy = buildReviewPolicy({ fingerprint: 'fp' });
  const out = await preReview({ apps: w.apps, id: 'news', policy, agent: REJECT });
  assert.equal(out.verdict, 'reject');
  assert.equal(out.refused, 'reviewer-rejected');
});

// ════════════════════════════════════════════════════════════════
// R-5／R-6：记录只追加；读不到申报 ⇒ 拒 + 盘上零残留
// ════════════════════════════════════════════════════════════════

test('🔴 R-5 结论**只追加**：同一条 rootHash 审两次留两条；下一版不覆盖上一版', async () => {
  const w = world();
  const policy = buildReviewPolicy({ fingerprint: 'fp' });
  await preReview({ apps: w.apps, id: 'news', policy, agent: PASS, now: 1 });
  await preReview({ apps: w.apps, id: 'news', policy, agent: HIGH, now: 2 });
  assert.equal(reviewRows(w.apps, 'news').length, 2, '两条都要在（没有"改"的入口）');

  // 下一版（字节变了 ⇒ rootHash 变了）⇒ 上一版那两条**原样还在**
  w.apps.create({ id: 'news', ...APP, files: { 'index.html': '<p>第二版</p>', [OUTBOUND_DECL_FILENAME]: DECLARATION } });
  await preReview({ apps: w.apps, id: 'news', policy, agent: PASS, now: 3 });
  const rows = reviewRows(w.apps, 'news');
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((r) => r.rootHash === w.man.rootHash).length, 2, '旧起点那两条不许被动');
  assert.equal(rows[2].version, 2);
  // ⚠️ 写不下去 ⇒ 抛（凭据留不下来就不许上架）
  const badFs = { ...nodeFs, appendFileSync: () => { throw new Error('ENOSPC'); } };
  assert.throws(() => appendReview({ appDir: w.apps.appDir.bind(w.apps), fs: badFs }, 'news', { at: 1 }), /凭据就不上架|没记下来/);
});

test('🔴 R-6 读不到申报 ⇒ 拒；预审也**不许写**共享库（盘上零残留）', async () => {
  const w = world({ declaration: null });
  const policy = buildReviewPolicy({ fingerprint: 'fp' });
  const out = await preReview({ apps: w.apps, id: 'news', policy, agent: PASS });
  assert.equal(out.verdict, 'reject');
  assert.equal(out.refused, 'declaration');
  assert.match(out.words, /outbound\.json/);

  // 真上架那条口：也拒，且共享库一个字节都没有
  const r = await handleAppsOp(w.apps, { op: 'publish', id: 'news' }, {
    published: w.published, sub: 'u1', authorName: '甲', reviewPolicy: policy, reviewAgent: PASS,
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(nodeFs.existsSync(nodePath.join(w.dir, 'published-apps', 'news')), false, '盘上零残留');
});

// ════════════════════════════════════════════════════════════════
// R-7：用量偏离（以运营方为准，偏差不静默）
// ════════════════════════════════════════════════════════════════

test('🔴 R-7 盒里记的日均远超申报量级 ⇒ escalate，而且偏差**写进结论**（可查）', async () => {
  const w = world();
  w.usage.note('news', { kind: 'agent-turn', usage: { prompt_tokens: 500_000, completion_tokens: 10 }, at: Date.now() });
  const policy = buildReviewPolicy({ fingerprint: 'fp' });
  const out = await preReview({ apps: w.apps, id: 'news', policy, agent: PASS, usage: w.usage });
  assert.equal(out.allow, false);
  assert.equal(out.refused, 'usage-deviation');
  const row = reviewRows(w.apps, 'news').at(-1);
  assert.equal(row.usage.deviation, 'deviation');
  assert.equal(row.usage.authoritative, 'operator', '以运营方实测为准');
  assert.equal(row.usage.boxDailyAverage, 500_010);
});

// ════════════════════════════════════════════════════════════════
// R-8：预审 vs 运营方复评
// ════════════════════════════════════════════════════════════════

test('★ R-8 运营方复评落同一条流（`scope:"operator"`）；两份差太多 ⇒ 红', async () => {
  const w = world();
  const policy = buildReviewPolicy({ fingerprint: 'fp' });
  const pre = await preReview({ apps: w.apps, id: 'news', policy, agent: PASS });
  const op = await operatorReview({ apps: w.apps, id: 'news', agent: async () => ({ summary: '我自己看了一遍', risks: [], rating: 5, verdict: 'pass' }) });
  assert.equal(op.scope, 'operator');
  assert.equal(op.rootHash, w.man.rootHash);
  assert.equal(reviewRows(w.apps, 'news').length, 2);

  const bad = compareReviews({ pre: pre.review, operator: op });
  assert.equal(bad.agree, false, '评级差 5 档 ⇒ 对不上');
  assert.match(bad.why, /差太多/);

  // 对得上那一侧
  const op2 = await operatorReview({ apps: w.apps, id: 'news', agent: async () => ({ summary: '和预审一致', risks: [], rating: 1, verdict: 'pass' }) });
  assert.equal(compareReviews({ pre: pre.review, operator: op2 }).agree, true);
  // 少一份 / 起点不同 ⇒ 不许当成"一致"
  assert.equal(compareReviews({ pre: pre.review, operator: null }).agree, false);
  assert.equal(compareReviews({ pre: pre.review, operator: { ...op2, rootHash: 'x' } }).agree, false);
});

// ════════════════════════════════════════════════════════════════
// R-3'：预审是**上架流程第一步**（自动跑，不靠谁记得）
// ════════════════════════════════════════════════════════════════

test('★ R-3 上架那条口：预审自动跑 —— 低风险 ⇒ 上架成功并在 `review.jsonl` 留痕；高风险 ⇒ 拒且零残留', async () => {
  const okWorld = world();
  const policy = buildReviewPolicy({ fingerprint: 'fp' });
  const r = await handleAppsOp(okWorld.apps, { op: 'publish', id: 'news' }, {
    published: okWorld.published, sub: 'u1', authorName: '甲', reviewPolicy: policy, reviewAgent: PASS,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.verdict, 'pass');
  assert.equal(reviewRows(okWorld.apps, 'news').length, 1, '预审是自动跑的（没人显式调它）');

  const hiWorld = world();
  const r2 = await handleAppsOp(hiWorld.apps, { op: 'publish', id: 'news' }, {
    published: hiWorld.published, sub: 'u1', authorName: '甲', reviewPolicy: policy, reviewAgent: HIGH,
  });
  assert.equal(r2.ok, false, JSON.stringify(r2));
  assert.equal(r2.verdict, 'escalate');
  assert.match(r2.error, /请主人看一眼/);
  assert.equal(nodeFs.existsSync(nodePath.join(hiWorld.dir, 'published-apps', 'news')), false, '拒了 ⇒ 共享库零残留');
  assert.equal(reviewRows(hiWorld.apps, 'news').length, 1, '拒也要留一条结论（事实不能静默）');
});

test('🔴 R-3 没接预审（这台部署没产品层规则）⇒ 上架**不自动放行**（真链路也一样）', async () => {
  const w = world();
  const r = await handleAppsOp(w.apps, { op: 'publish', id: 'news' }, {
    published: w.published, sub: 'u1', authorName: '甲',
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.refused, 'no-policy');
  assert.equal(nodeFs.existsSync(nodePath.join(w.dir, 'published-apps', 'news')), false);
});
