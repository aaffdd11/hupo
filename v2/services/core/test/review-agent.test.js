// **评审真的跑起来**（96 第 1／2／3／3b／4／5 条 · 契约 `docs/dev/93-OUTBOUND-USAGE.md` §三／§六）。
//
// 这一份补的是"上一批如实报的那条缺口"：
//   · `cfg.reviewAgent` 原来是 `null` ⇒ 预审**没有真模型调用** ⇒ 一律 escalate
//     （fail-closed 是对的，但审核等于没跑）；
//   · 运营方那一侧的复评只有函数、没有真实现。
//
// 判据（每条都带反例；**评审 agent 可注入；假 DSH 真 spawn，但绝不真打模型**）：
//   A-1 ★ 预审**真被调用**：评审 agent 真收到**源码与申报** ⇒ 结论绑 `rootHash` 落 `review.jsonl`
//   A-2 ★ **真跑一次**（假 DSH 真 spawn 真分帧）：按规则回评级；**算力记到那个 app 头上**；
//         而且跑完**工作区逐文件 sha 不变**、cwd 是一次性临时目录且跑完就清
//   A-3 🔴 反例：评审若真去写工作区 ⇒ **当场抓住**（escalate ＋ 点名），不许当审过了
//   A-4 🔴 反例：评审往**自己的 cwd** 写相对路径 ⇒ 落的是临时目录，工作区一个字节没动
//   A-5 🔴 起不来 / 超时 / 没结论 / 结论认不出 ⇒ 一律 escalate（fail-closed 的四种样子）
//   A-6 ★ 运营方复评**独立再读一遍**；与预审**差太多 ⇒ escalate**（共享库零残留）；
//         对得上 ⇒ 上架；复评跑不起来 ⇒ 也 escalate
//   A-7 🔴 低风险自动放行 / 高风险 escalate（各一反例，走 `reviewForPublish` 那条真路）

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { OUTBOUND_DECL_FILENAME } from '../src/app-outbound.js';
import { Apps } from '../src/apps.js';
import { handleAppsOp } from '../src/apps-socket.js';
import { Published } from '../src/published.js';
import { buildReviewPolicy, preReview, reviewForPublish, reviewRows, rulesHashOf } from '../src/review.js';
import {
  REVIEW_WORKDIR_PREFIX,
  buildReviewPrompt,
  changedFiles,
  createDshReviewAgent,
  extractReviewAnswer,
  snapshotTree,
} from '../src/review-agent.js';
import { UsageLedger, normalizeUsage, oneNumber } from '../src/usage.js';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const FAKE = nodePath.join(HERE, 'fake-review-dsh.mjs');

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});

function tmp(prefix = 'hupo-rv-') {
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

function world() {
  const dir = tmp();
  const apps = new Apps({ dir, sub: 'u1' });
  const published = new Published({ dir });
  const usage = new UsageLedger({ apps });
  apps.create({
    id: 'news',
    ...APP,
    files: { 'index.html': '<p>新闻</p>', [OUTBOUND_DECL_FILENAME]: DECLARATION },
  });
  return { dir, apps, published, usage, man: apps.manifest('news', apps.current('news')) };
}

const policy = () => buildReviewPolicy({ fingerprint: 'fp' });

/** 带 `categories` 的一份规则（真规则里有；正文判据要按它长出来，不是写死一份名单）。 */
function policyWithCategories() {
  const base = policy();
  const rules = {
    ...base.rules,
    categories: [
      { id: 'declaration', title: '外联申报对照', ask: '去哪儿、带哪些字段、走不走我们的中转' },
      { id: 'private-leak', title: '私密带出', ask: '有没有把他的私密内容带出去' },
    ],
  };
  return { ...base, rules, rulesHash: rulesHashOf(rules) };
}

/** 假 DSH 的 spawn 包装：真起进程、真 stdio，只是换成那支假脚本。 */
const kids = new Set();
after(() => {
  for (const k of kids) {
    try { k.kill('SIGKILL'); } catch { /* 已经没了 */ }
  }
});

function fakeSpawn(extraEnv = {}, spy = {}) {
  return (bin, args, opts) => {
    spy.bin = bin;
    spy.args = args;
    spy.cwd = opts?.cwd;
    const child = realSpawn(process.execPath, [FAKE, ...args], { ...opts, env: { ...opts.env, ...extraEnv } });
    kids.add(child);
    child.on('exit', () => kids.delete(child));
    return child;
  };
}

/** 一个真评审 agent（假 DSH 在跑）—— 判据里**不许**真打模型。 */
function dshAgent({ dir, usage = null, guardDir = null, spawnFn, timeoutMs = 8000 }) {
  return createDshReviewAgent({
    cfg: { dshBin: 'unused（假 DSH 用 process.execPath 起）', agentProfile: 'sdk', dshHome: dir },
    usage,
    guardDir,
    spawnFn,
    timeoutMs,
  });
}

const asObj = (map) => Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));

// ════════════════════════════════════════════════════════════════
// 纯函数那一半（正文 / 解析 / 快照）
// ════════════════════════════════════════════════════════════════

test('★ A-0 给评审的正文：整份源码 ＋ 申报 ＋ 规则要审的每一类 ＋ 钉死的输出形状', () => {
  const files = { 'index.html': '<p>新闻</p>', 'app.js': "fetch('https://x/y');", [OUTBOUND_DECL_FILENAME]: DECLARATION };
  const p = policyWithCategories();
  const prompt = buildReviewPrompt({
    id: 'news',
    version: 2,
    rootHash: 'abc123',
    files,
    decl: { outbound: [], declaresNone: true },
    points: [{ kind: 'artifact-fetch', path: 'app.js', what: 'fetch(' }],
    policy: p,
  });
  // 规则里要审的每一类都要出现（**从规则里长出来**，不是写死一份名单）
  for (const c of p.rules.categories) assert.ok(prompt.includes(c.ask), `正文里少了【${c.id}】`);
  // 整份源码是**正文**（不是路径）
  assert.ok(prompt.includes('文件：index.html'));
  assert.ok(prompt.includes('<p>新闻</p>'));
  assert.ok(prompt.includes('文件：app.js'));
  assert.ok(prompt.includes("fetch('https://x/y');"));
  // 申报与扫描命中都在
  assert.ok(prompt.includes('outbound.json') || prompt.includes('外联申报'));
  assert.ok(prompt.includes('artifact-fetch'));
  // 输出形状钉死
  assert.ok(prompt.includes('"verdict"'));
  assert.ok(prompt.includes('"rating"'));
});

test('★ A-0 从回复里抠结论：三种摆法都认；认不出 ⇒ `null`（不许猜）', () => {
  assert.deepEqual(extractReviewAnswer('{"a":1}'), { a: 1 });
  assert.deepEqual(extractReviewAnswer('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractReviewAnswer('我先看了一遍：\n{"a":1}\n就这样。'), { a: 1 });
  assert.equal(extractReviewAnswer('我觉得没问题'), null);
  assert.equal(extractReviewAnswer(''), null);
  assert.equal(extractReviewAnswer('[1,2]'), null);
});

test('A-0 快照比对：增 / 删 / 改都算；没动 ⇒ 空', () => {
  const d = tmp();
  nodeFs.writeFileSync(nodePath.join(d, 'a.txt'), '1');
  const before = snapshotTree(d);
  assert.deepEqual(changedFiles(before, snapshotTree(d)), []);
  nodeFs.writeFileSync(nodePath.join(d, 'a.txt'), '2');
  nodeFs.writeFileSync(nodePath.join(d, 'b.txt'), '新的');
  const changed = changedFiles(before, snapshotTree(d));
  assert.deepEqual(changed, ['a.txt', 'b.txt']);
  nodeFs.rmSync(nodePath.join(d, 'a.txt'));
  assert.deepEqual(changedFiles(before, snapshotTree(d)), ['a.txt', 'b.txt']);
});

// ════════════════════════════════════════════════════════════════
// A-1：预审真被调用
// ════════════════════════════════════════════════════════════════

test('★ A-1 预审真把**源码与申报**交给评审 ⇒ 结论绑 `rootHash` 落 `review.jsonl`（只追加）', async () => {
  const w = world();
  let seen = null;
  const agent = async (args) => {
    seen = args;
    return { summary: '看了一遍', risks: ['有一个出网点'], rating: 1, verdict: 'pass' };
  };
  const out = await preReview({ apps: w.apps, id: 'news', policy: policy(), agent, turn: 7 });
  assert.equal(out.allow, true, JSON.stringify(out));
  assert.ok(seen, '评审 agent 必须被真的调用');
  // ① 源码进去了（逐字节就是制品里那一份）
  assert.equal(String(seen.files['index.html']), '<p>新闻</p>');
  assert.ok(seen.files[OUTBOUND_DECL_FILENAME], '申报也要一起交给评审');
  // ② 申报解析结果与规则都在
  assert.ok(seen.decl && Array.isArray(seen.decl.outbound));
  for (const c of policy().rules.checks) assert.ok(seen.policy.rules.checks.includes(c), `规则缺 ${c}`);
  // ③ 绑的是**被审那一版**的 rootHash
  assert.equal(seen.rootHash, w.man.rootHash);
  const rows = reviewRows(w.apps, 'news');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rootHash, w.man.rootHash);
  assert.equal(rows[0].rating, 1);
  assert.equal(rows[0].risks[0], '有一个出网点');
});

// ════════════════════════════════════════════════════════════════
// A-2：真跑一次（假 DSH 真 spawn）
// ════════════════════════════════════════════════════════════════

test('★ A-2 真跑一次：按规则回评级；**算力记到那个 app**；工作区逐文件 sha 不变；cwd 是一次性临时目录', async () => {
  const w = world();
  const wsDir = nodePath.join(w.dir, 'workspaces', 'news');
  nodeFs.mkdirSync(wsDir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(wsDir, 'notes.txt'), '他的私密笔记\n');
  const before = asObj(snapshotTree(wsDir));

  const spy = {};
  const agent = dshAgent({ dir: w.dir, usage: w.usage, guardDir: () => wsDir, spawnFn: fakeSpawn({}, spy) });
  const out = await preReview({ apps: w.apps, id: 'news', policy: policy(), agent, usage: w.usage, turn: 7 });
  assert.equal(out.allow, true, JSON.stringify(out));
  assert.equal(out.review.rating, 0);
  assert.equal(out.review.summary.length > 0, true);

  // ① 工作区**逐文件 sha 不变**（评审是看，不是写）
  assert.deepEqual(asObj(snapshotTree(wsDir)), before);

  // ② cwd 是那个一次性临时目录（**不是**工作区），而且跑完就清掉
  assert.ok(spy.cwd && spy.cwd.includes(REVIEW_WORKDIR_PREFIX), `cwd 不是临时目录：${spy.cwd}`);
  assert.notEqual(spy.cwd, wsDir);
  assert.equal(nodeFs.existsSync(spy.cwd), false, '临时目录跑完必须清掉');

  // ③ 参数形状：`--profile` 在前、`--patch` 在后；**不挂人格 / 能力层**（中立读者、不带写盘工具）
  const iProfile = spy.args.indexOf('--profile');
  const iPatch = spy.args.indexOf('--patch');
  assert.ok(iProfile !== -1, JSON.stringify(spy.args));
  if (iPatch !== -1) assert.ok(iPatch > iProfile, '`--patch` 是全局选项，必须排在 `--profile` 之后');
  assert.equal(spy.args.some((a) => /persona|capabilit/u.test(a)), false, '评审不许挂人格/能力层');

  // ④ 🔴 **算力归到这个 app**（96 第 3 条）：usage.jsonl 里多出预审那一笔（三格照口径拆）
  const rows = w.usage.rows('news');
  assert.equal(rows.length, 1, '预审那次模型调用要记到这个 app 头上');
  assert.equal(rows[0].kind, 'agent-turn');
  assert.equal(rows[0].scopeId, 'news');
  assert.equal(rows[0].uncachedInput, 100, 'prompt 120 − cache 20');
  assert.equal(rows[0].output, 30);
  assert.equal(rows[0].cacheRead, 20);
  assert.equal(rows[0].turn, 7);
  assert.equal(rows[0].source, 'box');
});

// ════════════════════════════════════════════════════════════════
// A-2c：这台 DSH 真实那份 usage 形状
// ════════════════════════════════════════════════════════════════

test('★ A-2c 这台 DSH 真实那份 usage（camelCase）也要认 —— 否则"算力归到这个 app"只是记了一笔 0', async () => {
  // 实测形状：`{inputTokens, outputTokens, totalTokens, cacheReadTokens, reasoningTokens}`
  // 而且实测 `totalTokens = inputTokens + outputTokens + cacheReadTokens`（input **不含** cache）
  const w = world();
  const real = { inputTokens: 6358, outputTokens: 25, totalTokens: 7151, cacheReadTokens: 768, reasoningTokens: 19 };
  const agent = dshAgent({
    dir: w.dir,
    usage: w.usage,
    spawnFn: fakeSpawn({ FAKE_REVIEW_USAGE: JSON.stringify(real) }),
  });
  const out = await preReview({ apps: w.apps, id: 'news', policy: policy(), agent, usage: w.usage });
  assert.equal(out.allow, true, JSON.stringify(out));
  const row = w.usage.rows('news').at(-1);
  assert.equal(row.uncachedInput, 6358);
  assert.equal(row.output, 25);
  assert.equal(row.cacheRead, 768);
  assert.equal(oneNumber(row), 6383, '对外一个数 = uncachedInput + output（cache read 不算）');

  // 反例：只有 `totalTokens` ⇒ **认不出就如实全 0**（不许拿总数当"没缓存"填进去）
  assert.equal(normalizeUsage({ totalTokens: 7151 }).known, false);
  assert.equal(normalizeUsage({ totalTokens: 7151 }).uncachedInput, 0);
});

// ════════════════════════════════════════════════════════════════
// A-2b：盒里新建的目录要交给 agent 的 uid（不交 ⇒ 换了手的评审进不去）
// ════════════════════════════════════════════════════════════════

test('🔴 A-2b 评审的临时目录**交给 agent 的 uid**（`81-HARNESS-ENTRY.md` §9.3）；交不出去 ⇒ 不自动放行', async () => {
  const me = typeof process.getuid === 'function' ? process.getuid() : null;
  if (me === null) return; // 没有 uid 的平台（Windows）不适用

  // 反例（正身）：交给**自己这个 uid** ⇒ 交得出去 ⇒ 照常审
  const w = world();
  const spy = {};
  const okAgent = createDshReviewAgent({
    cfg: { dshBin: 'unused', agentProfile: 'sdk', dshHome: w.dir, agentUid: me, agentGid: me },
    usage: w.usage,
    spawnFn: fakeSpawn({}, spy),
    timeoutMs: 8000,
  });
  const outOk = await preReview({ apps: w.apps, id: 'news', policy: policy(), agent: okAgent, usage: w.usage });
  assert.equal(outOk.allow, true, JSON.stringify(outOk));
  assert.equal(nodeFs.existsSync(spy.cwd), false);

  // ② 交不出去（拿一个不是自己、也不是 root 的 uid）⇒ **不自动放行**
  if (me !== 0) {
    const w2 = world();
    const badAgent = createDshReviewAgent({
      cfg: { dshBin: 'unused', agentProfile: 'sdk', dshHome: w2.dir, agentUid: me + 1, agentGid: me + 1 },
      usage: w2.usage,
      spawnFn: fakeSpawn({}),
      timeoutMs: 8000,
    });
    const outBad = await preReview({ apps: w2.apps, id: 'news', policy: policy(), agent: badAgent, usage: w2.usage });
    assert.equal(outBad.allow, false, '交不出 uid 就不许静默退回 root');
    assert.equal(outBad.refused, 'reviewer-unavailable');
    assert.match(outBad.words, /交不给|身份/);
  }
});

// ════════════════════════════════════════════════════════════════
// A-3 / A-4：评审不许改工作区（反例两枚）
// ════════════════════════════════════════════════════════════════

test('🔴 A-3 反例：评审真去写工作区 ⇒ **当场抓住**（escalate ＋ 点名），不许当审过了', async () => {
  const w = world();
  const wsDir = nodePath.join(w.dir, 'workspaces', 'news');
  nodeFs.mkdirSync(wsDir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(wsDir, 'notes.txt'), '他的私密笔记\n');

  const agent = dshAgent({
    dir: w.dir,
    usage: w.usage,
    guardDir: () => wsDir,
    spawnFn: fakeSpawn({ FAKE_REVIEW_WRITE_DIR: wsDir }),
  });
  const out = await preReview({ apps: w.apps, id: 'news', policy: policy(), agent, usage: w.usage });
  assert.equal(out.allow, false, '动了工作区就不许自动放行');
  assert.equal(out.refused, 'reviewer-unavailable');
  assert.match(out.words, /动了不该动的东西/);
  assert.match(out.words, /evil\.txt/);
  assert.equal(reviewRows(w.apps, 'news').at(-1).verdict, 'escalate', '事实不能静默：留一条痕');
});

test('🔴 A-4 反例：评审往**自己的 cwd** 写相对路径 ⇒ 落的是临时目录，工作区一个字节没动', async () => {
  const w = world();
  const wsDir = nodePath.join(w.dir, 'workspaces', 'news');
  nodeFs.mkdirSync(wsDir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(wsDir, 'notes.txt'), '他的私密笔记\n');
  const before = asObj(snapshotTree(wsDir));

  const spy = {};
  const agent = dshAgent({
    dir: w.dir,
    usage: w.usage,
    guardDir: () => wsDir,
    spawnFn: fakeSpawn({ FAKE_REVIEW_WRITE_CWD: '1' }, spy),
  });
  const out = await preReview({ apps: w.apps, id: 'news', policy: policy(), agent, usage: w.usage });
  assert.equal(out.allow, true, '写的是它自己那个临时目录 ⇒ 不该误伤（工作区没动）');
  assert.deepEqual(asObj(snapshotTree(wsDir)), before, '工作区逐文件 sha 不变');
  assert.equal(nodeFs.existsSync(spy.cwd), false, '连同它写的东西一起清掉');
});

// ════════════════════════════════════════════════════════════════
// A-5：审不了 ⇒ escalate（fail-closed 的四种样子）
// ════════════════════════════════════════════════════════════════

test('🔴 A-5 没结论 / 结论认不出 / 起不来 / 超时 ⇒ 一律 escalate', async () => {
  // ① 一句话都不说
  const w1 = world();
  const silent = dshAgent({ dir: w1.dir, spawnFn: fakeSpawn({ FAKE_REVIEW_SILENT: '1' }) });
  const o1 = await preReview({ apps: w1.apps, id: 'news', policy: policy(), agent: silent });
  assert.equal(o1.allow, false);
  assert.equal(o1.refused, 'reviewer-unavailable');

  // ② 回的正文不是 JSON
  const w2 = world();
  const junk = dshAgent({ dir: w2.dir, spawnFn: fakeSpawn({ FAKE_REVIEW_ANSWER: '我觉得还行' }) });
  const o2 = await preReview({ apps: w2.apps, id: 'news', policy: policy(), agent: junk });
  assert.equal(o2.allow, false);
  assert.equal(o2.refused, 'reviewer-unavailable');
  assert.match(o2.words, /认不出/);

  // ③ `initialize` 永远不回（超时）
  const w3 = world();
  const hanging = dshAgent({ dir: w3.dir, spawnFn: fakeSpawn({ FAKE_REVIEW_NEVER_INIT: '1' }), timeoutMs: 400 });
  const o3 = await preReview({ apps: w3.apps, id: 'news', policy: policy(), agent: hanging });
  assert.equal(o3.allow, false);
  assert.equal(o3.refused, 'reviewer-unavailable');
  assert.match(o3.words, /超时/);

  // ④ 连 dsh 都找不到（spawn 真失败）
  const w4 = world();
  const missing = createDshReviewAgent({
    cfg: { dshBin: '/nonexistent/dsh-xyz', agentProfile: 'sdk' },
    timeoutMs: 3000,
  });
  const o4 = await preReview({ apps: w4.apps, id: 'news', policy: policy(), agent: missing });
  assert.equal(o4.allow, false);
  assert.equal(o4.refused, 'reviewer-unavailable');
});

// ════════════════════════════════════════════════════════════════
// A-6：运营方复评（宿主侧）与「两份对不对得上」
// ════════════════════════════════════════════════════════════════

test('★ A-6 运营方复评**独立跑一遍**；与预审**差太多 ⇒ escalate**（共享库零残留）；对得上 ⇒ 上架', async () => {
  const PASS0 = async () => ({ summary: '预审：没看到风险', risks: [], rating: 0, verdict: 'pass' });
  const OP5 = async () => ({ summary: '复评：这份东西会往外发', risks: ['未申报的出网点'], rating: 5, verdict: 'pass' });
  const OP0 = async () => ({ summary: '复评：和预审看到的一样', risks: [], rating: 1, verdict: 'pass' });

  // ① 对不上（差 5 档）⇒ **红**，而且盘上零残留
  const bad = world();
  const r = await handleAppsOp(bad.apps, { op: 'publish', id: 'news' }, {
    published: bad.published, sub: 'u1', authorName: '甲',
    reviewPolicy: policy(), reviewAgent: PASS0, operatorAgent: OP5,
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.refused, 'review-disagreement');
  assert.match(r.error, /对不上/);
  assert.equal(nodeFs.existsSync(nodePath.join(bad.dir, 'published-apps', 'news')), false, '拒了 ⇒ 共享库零残留');
  // 两份结论都留了痕（预审 + 复评），都指得到同一个 rootHash
  const rowsBad = reviewRows(bad.apps, 'news');
  assert.equal(rowsBad.length, 2);
  assert.deepEqual([...new Set(rowsBad.map((x) => x.scope))].sort(), ['operator', 'pre']);
  assert.equal(new Set(rowsBad.map((x) => x.rootHash)).size, 1);

  // ② 对得上 ⇒ 上架
  const good = world();
  const r2 = await handleAppsOp(good.apps, { op: 'publish', id: 'news' }, {
    published: good.published, sub: 'u1', authorName: '甲',
    reviewPolicy: policy(), reviewAgent: PASS0, operatorAgent: OP0,
  });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(reviewRows(good.apps, 'news').length, 2);

  // ③ 复评**跑不起来** ⇒ 也不许自动放行（fail-closed）
  const broken = world();
  const r3 = await reviewForPublish({
    apps: broken.apps, id: 'news', policy: policy(), preAgent: PASS0,
    operatorAgent: async () => { throw new Error('运营方那边今天没起来'); },
  });
  assert.equal(r3.allow, false);
  assert.equal(r3.refused, 'no-operator-review');
  assert.match(r3.words, /请主人看一眼/);

  // ④ 反例（不假装）:没接复评 ⇒ 如实标 `agreement:null`，**不伪造"对得上"**
  const solo = world();
  const r4 = await reviewForPublish({ apps: solo.apps, id: 'news', policy: policy(), preAgent: PASS0 });
  assert.equal(r4.allow, true);
  assert.equal(r4.agreement, null);
  assert.match(r4.agreementWhy, /没有接上/);
});

test('★ A-6b 运营方复评拿到的**是同一套规则 ＋ 整份源码 ＋ 同一份申报**（不是只记个指纹）', async () => {
  const w = world();
  let seen = null;
  const pre = async () => ({ summary: '预审：没看到风险', risks: [], rating: 0, verdict: 'pass' });
  const operatorAgent = async (args) => {
    seen = args;
    return { summary: '复评：和预审一致', risks: [], rating: 0, verdict: 'pass' };
  };
  const out = await reviewForPublish({ apps: w.apps, id: 'news', policy: policyWithCategories(), preAgent: pre, operatorAgent });
  assert.equal(out.allow, true, JSON.stringify(out));
  assert.ok(seen, '运营方那一侧的 agent 必须被调用');
  // ① 整份源码（逐字节就是制品里那一份，`apps.read` 已核过 rootHash）
  assert.equal(String(seen.files['index.html']), '<p>新闻</p>');
  assert.ok(seen.files[OUTBOUND_DECL_FILENAME]);
  // ② **同一套规则**：正文（categories / checks / 评级）都进去了
  assert.ok(seen.policy?.rules?.categories?.length > 0);
  for (const c of seen.policy.rules.checks) assert.ok(seen.policy.rules.checks.includes(c));
  // ③ 同一份申报与扫描结果
  assert.ok(seen.decl && Array.isArray(seen.decl.outbound));
  assert.ok(Array.isArray(seen.points));
  assert.equal(seen.rootHash, w.man.rootHash);
  // 两份结论绑同一条规则指纹
  const rows = reviewRows(w.apps, 'news');
  assert.equal(new Set(rows.map((x) => x.rulesHash)).size, 1);
});

// ════════════════════════════════════════════════════════════════
// A-7：低风险放行 / 高风险找主人（各一反例，走 `reviewForPublish`）
// ════════════════════════════════════════════════════════════════
test('🔴 A-7 低风险 ⇒ 自动放行；高风险（超过规则那一档）⇒ escalate（各一反例）', async () => {
  const LOW = async () => ({ summary: '没看到风险', risks: [], rating: 0, verdict: 'pass' });
  const HIGH = async () => ({ summary: '有风险', risks: ['未申报的出网点'], rating: 5, verdict: 'pass' });

  const lo = world();
  const rLo = await reviewForPublish({ apps: lo.apps, id: 'news', policy: policy(), preAgent: LOW });
  assert.equal(rLo.allow, true, JSON.stringify(rLo));
  assert.equal(rLo.verdict, 'pass');

  const hi = world();
  const rHi = await reviewForPublish({ apps: hi.apps, id: 'news', policy: policy(), preAgent: HIGH });
  assert.equal(rHi.allow, false);
  assert.equal(rHi.verdict, 'escalate');
  assert.equal(rHi.refused, 'high-risk');
  assert.match(rHi.words, /请主人看一眼/);
});
