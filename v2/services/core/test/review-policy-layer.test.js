// **预审规则住产品层**（96 第 3b 条：只读挂载 ＋ 指纹 ⇒ 用户改不了）。
//
// 这一份补的是**产品层产线那一段**（缺口：`build-tenant-code.sh` 原来不产出
// `review-policy.json` ⇒ 容器里读不到规则 ⇒ 预审一律 escalate —— fail-closed 是对的，
// 但审核等于没跑）。契约 `docs/dev/93-OUTBOUND-USAGE.md` §八·2.5（阶段 2.5）。
//
// 每条判据都带**反例**（照 `app-review.test.js` 的风格）：
//   P1 ★ 产品层**真的带上了**这份规则 —— 按 `build-tenant-code.sh` 的**输入名单**断言，
//        而且真跑一遍产线，看盘上那一版是不是自带它（不是"文件存在"就算数）
//   P2 🔴 改规则**一个字节** ⇒ `rulesHash` 变 ⇒ **旧评级失效**；反例：不改 ⇒ 指纹不变
//   P3 🔴 读不到规则 ⇒ **escalate**（fail-closed）；反例：读得到 ⇒ 按规则走
//
// ⚠️ 判据自己**跑真产线**（`build-tenant-code.sh`），只是把根指到一个临时目录
//    （`HUPO_CODE_ROOT`）—— 一个字节都不写 `/srv`，也不碰任何容器。
//    探针**不写死**规则内容：它读的就是产线拷进产品层的那一份（V13 同款纪律）。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { OUTBOUND_DECL_FILENAME } from '../src/app-outbound.js';
import { Apps } from '../src/apps.js';
import { handleAppsOp } from '../src/apps-socket.js';
import { Published } from '../src/published.js';
import {
  REVIEW_REQUIRED_CHECKS,
  assertReviewPolicy,
  judgeRatingsByPolicy,
  loadReviewPolicy,
  preReview,
  reviewRows,
  rulesHashOf,
} from '../src/review.js';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const CORE = nodePath.resolve(HERE, '..'); // v2/services/core
const ROOT = nodePath.resolve(CORE, '..', '..', '..'); // 仓库根（core → services → v2 → 根）
const BUILD = nodePath.join(ROOT, 'scripts', 'build-tenant-code.sh');

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});

function tmp(prefix = 'hupo-pol-') {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** 产线那份**输入名单**（只有 `build-tenant-code.sh` 里那一处是权威）。 */
function readInputs() {
  const sh = nodeFs.readFileSync(BUILD, 'utf8');
  const m = sh.match(/^INPUTS=\(([^)]*)\)/m);
  assert.ok(m, 'build-tenant-code.sh 里那句 INPUTS=(...) 必须还在 —— 名单是这条判据的依据');
  return m[1].trim().split(/\s+/).filter(Boolean);
}

/** 真跑一遍产线（根指到临时目录；不写 /srv、不碰容器）。 */
function buildInto(root, { core = CORE } = {}) {
  return spawnSync('bash', [BUILD], {
    env: { ...process.env, HUPO_CORE: core, HUPO_CODE_ROOT: root },
    encoding: 'utf8',
  });
}

/** 造一版并把它读出来（容器那种摆法：整份只读挂进 `/app/code` ⇒ 走 `codeDir`）。 */
function buildLayer(root) {
  const r = buildInto(root);
  assert.equal(r.status, 0, `产线没跑通：\n${r.stdout}\n${r.stderr}`);
  const fp = nodeFs.readFileSync(nodePath.join(root, '.last'), 'utf8').trim();
  const dest = nodePath.join(root, fp);
  const raw = nodeFs.readFileSync(nodePath.join(dest, 'review-policy.json'), 'utf8');
  return { fp, dest, raw, policy: loadReviewPolicy({ codeDir: dest }) };
}

const caught = (fn) => { try { fn(); return null; } catch (err) { return err; } };

const APP = { title: '新闻', icon: 'dice', entry: 'index.html' };
const DECLARATION = JSON.stringify({
  schema: 1,
  outbound: [],
  declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '还没人用过，先按 0 报' },
});
const PASS = async () => ({ summary: '看了一遍，没看到外联风险', risks: [], rating: 0, verdict: 'pass' });

function world() {
  const dir = tmp('hupo-pol-app-');
  const apps = new Apps({ dir, sub: 'u1' });
  const published = new Published({ dir });
  apps.create({ id: 'news', ...APP, files: { 'index.html': '<p>新闻</p>', [OUTBOUND_DECL_FILENAME]: DECLARATION } });
  return { dir, apps, published };
}

// ════════════════════════════════════════════════════════════════
// P1：产品层**真的带上了**这份规则
// ════════════════════════════════════════════════════════════════

test('★ P1 产品层带上预审规则：按产线**输入名单**断言 ＋ 真跑一遍看盘上那一版（不是"文件存在"）', () => {
  // ① 名单本身：这是"带上它"的唯一权威（改一处就够，别处不许再抄一份）
  const inputs = readInputs();
  assert.ok(inputs.includes('review-policy.json'), `产线名单里没有 review-policy.json：${inputs.join(' ')}`);

  // ② 真跑产线：那一版**自带**规则，而且 manifest 记着它进了名单
  const root = tmp('hupo-pol-root-');
  const { fp, dest, policy } = buildLayer(root);
  assert.match(fp, /^[0-9a-f]{12}$/, `指纹形状不对：${fp}`);
  const man = JSON.parse(nodeFs.readFileSync(nodePath.join(dest, 'manifest.json'), 'utf8'));
  assert.ok(man.inputs.includes('review-policy.json'), `manifest 的名单里没有它：${man.inputs.join(' ')}`);

  // ③ 反例：不在名单里的东西**进不了**产品层（`test/` 按设计就不该在 —— 免得"整个 CORE 拷过去"也算过）
  assert.equal(man.inputs.includes('test'), false);
  assert.equal(nodeFs.existsSync(nodePath.join(dest, 'test')), false, '产品层里混进了 test/ ⇒ 拷的就不是名单');

  // ④ 构建那一刻盖上的指纹 = 这一版的指纹（自指字段），规则**读得出来**且五脏俱全
  const built = JSON.parse(nodeFs.readFileSync(nodePath.join(dest, 'review-policy.json'), 'utf8'));
  assert.equal(built.fingerprint, fp, '产品层那份规则要盖着这一版的指纹（96#3b 的"指纹"那一半）');
  assert.equal(policy.layerFingerprint, fp);
  assert.equal(policy.rulesHash, rulesHashOf(policy.rules), '规则正文与它自己记的指纹必须对得上');
  for (const c of REVIEW_REQUIRED_CHECKS) {
    assert.ok(policy.rules.checks.includes(c), `规则少了必须的检查项 ${c}`);
  }
  // 反例：把指纹抹掉（空串）⇒ 认不出（那就是"没盖上"的样子）
  assert.throws(() => assertReviewPolicy({ ...built, fingerprint: '' }), /没有指纹/);
});

// ════════════════════════════════════════════════════════════════
// P2：改一个字节 ⇒ rulesHash 变 ⇒ 旧评级失效
// ════════════════════════════════════════════════════════════════

test('🔴 P2 改规则一个字节 ⇒ rulesHash 变 ⇒ **旧评级失效**；不改 ⇒ 指纹不变（反例）', async () => {
  const root = tmp('hupo-pol-root-');
  const built = buildLayer(root);
  const policy = built.policy;

  // 这一版规则下真发一条评级（绑着它当时那份规则的指纹）
  const w = world();
  const out = await preReview({ apps: w.apps, id: 'news', policy, agent: PASS });
  assert.equal(out.allow, true, JSON.stringify(out));
  const rows = reviewRows(w.apps, 'news');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rulesHash, policy.rulesHash, '每条评级都要记着"是按哪份规则给的"');
  assert.equal(judgeRatingsByPolicy({ rows, policy }).valid.length, 1);
  assert.deepEqual(judgeRatingsByPolicy({ rows, policy }).stale, []);

  // 反例正身：**改一个字节**（规则正文里加一个空格），**不碰** rulesHash
  const oneByte = built.raw.replace('外联申报对照', '外联申报对照 ');
  assert.notEqual(oneByte, built.raw, '这条判据得真改到字节');
  const changedRules = JSON.parse(oneByte).rules;
  assert.notEqual(rulesHashOf(changedRules), policy.rulesHash, '改一个字节 ⇒ rulesHash 必须变（嵌套正文也算数）');

  // ① 文件没重签 ⇒ 当场认出来（"改规则要被发现"）
  assert.match(String(caught(() => assertReviewPolicy({ ...policy, rules: changedRules }))?.message), /对不上（被改过）/);

  // ② 重签之后规则认了，但**旧评级一条都不算数**
  const resigned = { ...policy, rules: changedRules, rulesHash: rulesHashOf(changedRules) };
  assert.equal(assertReviewPolicy(resigned).rulesHash, resigned.rulesHash);
  const judged = judgeRatingsByPolicy({ rows, policy: resigned });
  assert.deepEqual(judged.valid, [], '旧评级是别的规则给的 ⇒ 不许拿去自动放行');
  assert.equal(judged.stale.length, 1);
  assert.match(judged.why, /失效/);

  // ③ 反例：**不改** ⇒ 指纹不变、旧评级仍然算数
  assert.equal(rulesHashOf(JSON.parse(built.raw).rules), policy.rulesHash);
  assert.equal(judgeRatingsByPolicy({ rows, policy }).valid.length, 1);
  assert.equal(judgeRatingsByPolicy({ rows, policy }).stale.length, 0);
  // 规则读不出来（没给）⇒ 一条都不算数（fail-closed 的那一半）
  assert.deepEqual(judgeRatingsByPolicy({ rows, policy: null }).valid, []);
  assert.equal(judgeRatingsByPolicy({ rows, policy: null }).stale.length, 1);

  // ④ 改了规则 ⇒ **产品层指纹也变**（不然容器不会重开，"母体升级"落不了地）
  const mut = tmp('hupo-pol-core-');
  for (const n of readInputs()) {
    nodeFs.cpSync(nodePath.join(CORE, n), nodePath.join(mut, n), { recursive: true });
  }
  nodeFs.writeFileSync(nodePath.join(mut, 'review-policy.json'), oneByte);
  const root2 = tmp('hupo-pol-root-');
  const r2 = buildInto(root2, { core: mut });
  assert.equal(r2.status, 0, `${r2.stdout}\n${r2.stderr}`);
  const fp2 = nodeFs.readFileSync(nodePath.join(root2, '.last'), 'utf8').trim();
  assert.notEqual(fp2, built.fp, '规则改一个字节必须换一版（同一版 = 容器不会重开 = 升级是假的）');
});

// ════════════════════════════════════════════════════════════════
// P3：读不到规则 ⇒ escalate（fail-closed）
// ════════════════════════════════════════════════════════════════

test('🔴 P3 读不到规则 ⇒ escalate；反例：读得到 ⇒ 按规则自动放行（且共享库零残留）', async () => {
  const root = tmp('hupo-pol-root-');
  const built = buildLayer(root);

  // 反例（正身）：读得到 ⇒ 低风险按规则走，上架那条真口也放行
  const okWorld = world();
  const ok = await preReview({ apps: okWorld.apps, id: 'news', policy: built.policy, agent: PASS });
  assert.equal(ok.allow, true, JSON.stringify(ok));
  assert.equal(ok.verdict, 'pass');
  const pubOk = await handleAppsOp(okWorld.apps, { op: 'publish', id: 'news' }, {
    published: okWorld.published, sub: 'u1', authorName: '甲',
    reviewPolicy: built.policy, reviewAgent: PASS,
  });
  assert.equal(pubOk.ok, true, JSON.stringify(pubOk));

  // 正身：**产品层还在，规则文件没了** ⇒ 读不出 ⇒ 抛（不许猜一份默认规则）
  const broken = tmp('hupo-pol-broken-');
  nodeFs.cpSync(built.dest, broken, { recursive: true });
  nodeFs.rmSync(nodePath.join(broken, 'review-policy.json'));
  assert.match(String(caught(() => loadReviewPolicy({ codeDir: broken }))?.message), /没有预审规则/);

  // 走**上架那条真口**：没规则 ⇒ 不自动放行，共享库一个字节没有，但**留了一条痕**
  const w = world();
  const r = await handleAppsOp(w.apps, { op: 'publish', id: 'news' }, {
    published: w.published, sub: 'u1', authorName: '甲', reviewPolicy: null, reviewAgent: PASS,
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.refused, 'no-policy', '读不到规则就得点名是哪一条（N11）');
  assert.equal(nodeFs.existsSync(nodePath.join(w.dir, 'published-apps', 'news')), false, '盘上零残留');
  assert.equal(reviewRows(w.apps, 'news').at(-1).verdict, 'escalate', '事实不能静默：拒也要留一条结论');
});
