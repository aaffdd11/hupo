// **上架前的评审（A16 ＋ A17 的"评审"那一半）** ——
// 契约 `docs/dev/93-OUTBOUND-USAGE.md` §三／§六 · 主人 2026-09-25 第 1／3／3b／4 条
// （`docs/dev/96-OWNER-DECISIONS.md`）。
//
// ── 主人在这一件事上拍的四条（逐条落在这里）──────────────────
//   第 1 条：**审核主体是"运营方保存的那个 agent 读整份源码 → 总结／风险点／评级"**
//            （**不是**作者自报为准）。
//   第 3 条：作者**仍要申报**；而且**容器里由运营方预置一份"审核能力"让用户先预审**
//            （容器里跑的是用户的 agent ⇒ **算力用户出**）。
//   第 3b 条：🔴 **预审规则必须住产品层**（只读挂载＋指纹，母体升级）——
//            **绝不许用户能改**，否则"自己审自己"是笑话。
//   第 4 条：**预审＝上架流程第一步自动跑**（他随时也能手动再跑一次）。
//
// ── 规则住哪（第 3b 条 · 这是本模块最要紧的一条）────────────
// 规则 = 产品层里那份 `review-policy.json`，而产品层是**只读挂载**进来的
// （`product-layer.js`：`/srv/hupo/tenant-code/<指纹>/`）＋**指纹**
// （`manifest.json` 的 `fingerprint`）。
//   · 读不到产品层 / 读不到规则 / **指纹对不上** ⇒ **fail-closed**（不自动放行）；
//   · 用户能改的那一份**不在**这里 —— 它在只读挂载上，用户的 agent 写不进去。
// ⚠️ **阈值（多少算低风险）住代码**（93 F4；本文件的 `REVIEW_AUTO_PASS_MAX_RISK`），
//    文档里搜不到数值。
//
// ── 低风险自动放行、高风险找主人（第 2 条）──────────────────
// 评级 ≤ 门槛 ⇒ `pass`（自动放行）；> 门槛 ⇒ `escalate`（**找主人**，不静默放行）。
//
// ── 真模型调用可以先留成可注入的（本批的边界）───────────────
// `agent` 是一个**注入的**评审实现（接口在这儿、判据是真的）。**没注入 / 没接上**
// ⇒ `verdict:'unavailable'` ⇒ **escalate**（fail-closed：**不许**因为"审不了"就自动放行）。
// ⇒ 今天是"一次都自动放行不了"，这是**如实的**；真跑放下一批。

import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { DeclarationError, assertDeclarationAllowed } from './app-outbound.js';
import { readProductLayer } from './product-layer.js';
import { usageDeviation } from './usage.js';

/** 评审记录的形状版本。 */
export const REVIEW_SCHEMA = 1;

/** 结论记录落在哪（与 `audit.jsonl` 同一格、同一"只追加"规矩 · 93 §3.2）。 */
export const REVIEW_FILENAME = 'review.jsonl';

/** 产品层里那份规则的文件名（**只读挂载 ＋ 指纹**）。 */
export const REVIEW_POLICY_FILENAME = 'review-policy.json';

/**
 * 🔴 **多少算低风险**（第 2 条：门槛住代码，93 F4）。
 *
 * 评级是 0–5 的整数（0 = 没看到风险）。**≤ 这个数 ⇒ 自动放行**；否则找主人。
 * ⚠️ 产品层那份规则可以**更严**（`autoPassMaxRisk`），**不许更松**——
 *    `assertReviewPolicy()` 会拒掉比这个常量更松的规则。
 */
export const REVIEW_AUTO_PASS_MAX_RISK = 2;

/**
 * 预审必须包含的检查项（规则里少一项 ⇒ 认不出 ⇒ fail-closed）。
 *
 * 这五类就是主人点名要审的（93 §三 R1–R4 ／ 96 第 3 条）：
 *   `declaration` 外联申报对照 · `outbound-scan` 代码扫描的判定 · `usage` 用量对照 ·
 *   `private-leak` 私密带出 · `injection` 注入安全。
 * 🔴 名单一变，**所有**旧规则都认不出（少一项就拒）⇒ 这正是"规则升级要被发现"。
 */
export const REVIEW_REQUIRED_CHECKS = Object.freeze([
  'declaration',
  'outbound-scan',
  'private-leak',
  'injection',
  'usage',
]);

/** 两份结论（预审 vs 运营方复评）评级差多少算"对不上"（96 · 我自定的第 4 条）。 */
export const REVIEW_AGREEMENT_MAX_DELTA = 1;

/** 评审这条路上的错（认不出、写不下去……）。**人话**。 */
export class ReviewError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReviewError';
  }
}

/**
 * **规则本身长什么样才算数**（认不出 ⇒ 抛）。
 *
 * 🔴 两道**反着验**的：
 *   ① `rulesHash` —— 规则正文（`rules`）的 sha256。**改一个字节**（比如把自动放行那一档
 *      从 2 改成 5）而不同时改 `rulesHash` ⇒ 这里当场认出来。⚠️ 它**不是**"防住能写文件的人"
 *      （那靠**只读挂载**），它防的是"规则被悄悄换过而我们看不出来"。
 *   ② `autoPassMaxRisk` **比代码常量更松** ⇒ 拒（规则只许更严，不许把闸调松）。
 */
export function assertReviewPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new ReviewError('预审规则读不出来 —— 这次不敢自动放行');
  }
  if (policy.schema !== 1) {
    throw new ReviewError(`预审规则的版本认不出（schema=${String(policy.schema).slice(0, 20)}）—— 不敢自动放行`);
  }
  if (typeof policy.fingerprint !== 'string' || policy.fingerprint === '') {
    throw new ReviewError('预审规则没有指纹 —— 分不清"还是原来那份"还是"被换过了"，不敢自动放行');
  }
  const rules = policy.rules;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
    throw new ReviewError('预审规则里没有规则正文（rules）—— 认不出，不敢自动放行');
  }
  if (typeof policy.rulesHash !== 'string' || policy.rulesHash !== rulesHashOf(rules)) {
    throw new ReviewError('预审规则的内容与它自己记的指纹对不上（被改过）—— 不认，不敢自动放行');
  }
  const max = Number.isFinite(rules.autoPassMaxRisk) ? rules.autoPassMaxRisk : REVIEW_AUTO_PASS_MAX_RISK;
  if (max < 0 || max > REVIEW_AUTO_PASS_MAX_RISK) {
    throw new ReviewError('预审规则想把"自动放行"的档放宽到代码那道门槛以外 —— 不认，不敢自动放行');
  }
  if (!Array.isArray(rules.checks)) {
    throw new ReviewError('预审规则里没有检查项表（checks）—— 认不出，不敢自动放行');
  }
  for (const c of REVIEW_REQUIRED_CHECKS) {
    if (!rules.checks.includes(c)) {
      throw new ReviewError(`预审规则少了一道必须的检查（${c}）—— 认不出，不敢自动放行`);
    }
  }
  return { ...policy, rules: { ...rules, autoPassMaxRisk: max }, autoPassMaxRisk: max };
}

/**
 * **深度**稳定序列化：每一层的键都排序后拼（数组顺序保持 —— 它是内容）。
 *
 * 🔴 为什么不能用 `JSON.stringify(v, sortedTopKeys)`：那个数组是**对所有层**的键的
 *    白名单 ⇒ 嵌套对象里没有跟顶层重名的键**会被整个丢掉**。
 *    实测：`{checks:['a'], autoPassMaxRisk:2, categories:[{id:'x',ask:'…'}], rating:{meaning:'…'}}`
 *    序列化出来是 `{"autoPassMaxRisk":2,"categories":[{}],"checks":["a"],"rating":{}}` ——
 *    于是**规则正文（要审哪几类、评级怎么给）改一个字节，`rulesHash` 纹丝不动**。
 *    那正是"改规则要被发现"这条机制的反面。⇒ 必须深度规范化。
 */
export function canonicalRulesJson(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalRulesJson).join(',')}]`;
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalRulesJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** `rules` 正文的 sha256（**逐字节**：嵌套的键序也定死 —— 同一份内容同一个 hash）。 */
export function rulesHashOf(rules) {
  return nodeCrypto.createHash('sha256').update(canonicalRulesJson(rules ?? null)).digest('hex');
}

/**
 * **造一份规则**（产品层构建脚本与判据都用它 —— 手写 `rulesHash` 一定会漂）。
 */
export function buildReviewPolicy({
  fingerprint,
  checks = REVIEW_REQUIRED_CHECKS,
  autoPassMaxRisk = REVIEW_AUTO_PASS_MAX_RISK,
} = {}) {
  const rules = { checks: [...checks], autoPassMaxRisk };
  return { schema: 1, fingerprint, rulesHash: rulesHashOf(rules), rules };
}

/**
 * **把产品层里那份规则读出来**（只读挂载 ＋ 指纹，第 3b 条）。
 *
 * 🔴 三种"读不出"都**抛**（fail-closed）：产品层读不到 / 规则文件读不到 / **指纹对不上**。
 *    ⚠️ 指纹对不上这一条是"用户改不了"的**可反着验**的那一半：改了规则字节 ⇒ 规则文件的
 *    `rulesHash` 与 `rules` 对不上 ⇒ 这里立刻认出来。
 *
 * ⚠️ **两种摆法都要认**：
 *   · **宿主**：`<codeRoot>/current → <指纹>/`（`readProductLayer` 那套）；
 *   · **容器里**：产品层**整份只读挂进** `/app/code`（`scripts/create-tenant-pool.sh` 的
 *     `--env HUPO_CODE_DIR=/app/code`）⇒ 那一份**本身就是那一版**，没有 `current` 软链。
 *     ⇒ 容器里走 `codeDir`（读 `/app/code/manifest.json` 的指纹）。
 *   🔴 两条都不通 ⇒ 抛（**绝不**退回一份"默认规则"）。
 */
export function loadReviewPolicy({ codeRoot = process.env.HUPO_CODE_ROOT, codeDir = process.env.HUPO_CODE_DIR, fs = nodeFs } = {}) {
  let dir = null;
  let fingerprint = null;
  if (typeof codeDir === 'string' && codeDir !== '') {
    // 容器里：`/app/code` 就是那一版（只读挂载）
    try {
      const man = JSON.parse(fs.readFileSync(nodePath.join(codeDir, 'manifest.json'), 'utf8'));
      if (typeof man?.fingerprint === 'string' && man.fingerprint !== '') {
        dir = codeDir;
        fingerprint = man.fingerprint;
      }
    } catch {
      /* 读不到 ⇒ 下面按"读不到产品层"报 */
    }
  }
  if (dir === null) {
    const layer = readProductLayer({ root: codeRoot, fs });
    if (!layer) {
      throw new ReviewError('读不到产品层（宿主上还没翻过任何一版，容器里也没挂上）—— 预审规则没着落，不敢自动放行');
    }
    dir = layer.dir;
    fingerprint = layer.fingerprint;
  }
  let raw;
  try {
    raw = fs.readFileSync(nodePath.join(dir, REVIEW_POLICY_FILENAME), 'utf8');
  } catch {
    throw new ReviewError(`产品层里没有预审规则（${REVIEW_POLICY_FILENAME}）—— 读不到就不敢自动放行`);
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new ReviewError('预审规则不是 JSON —— 认不出，不敢自动放行');
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) {
    throw new ReviewError('预审规则不是一份对象 —— 认不出，不敢自动放行');
  }
  if (j.fingerprint !== fingerprint) {
    throw new ReviewError(
      `预审规则的指纹（${String(j.fingerprint).slice(0, 16)}）与产品层对不上（${String(fingerprint).slice(0, 16)}）—— 规则可能被换过，不敢自动放行`,
    );
  }
  return { ...assertReviewPolicy(j), source: dir, layerFingerprint: fingerprint };
}

/**
 * **读这一版已经有的评审结论**（只追加的那条流）。
 * ⚠️ 读不到 ⇒ 空数组（**不猜**）；坏行跳过（它的存在由 `reviewRows().length` 与文件本身看得到）。
 */
export function reviewRows(apps, id) {
  try {
    const raw = (apps.fs ?? nodeFs).readFileSync(nodePath.join(apps.appDir(id), REVIEW_FILENAME), 'utf8');
    const out = [];
    for (const line of String(raw).split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j && typeof j === 'object' && !Array.isArray(j)) out.push(j);
      } catch {
        /* 坏行跳过 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * **落一条结论**（只追加；没有"改"的入口 · 93 §3.2／`ledger.js` 的①）。
 *
 * 🔴 写不下去 ⇒ **抛**（R5：结论只在界面上闪一下、盘上无据 ⇒ 红）。
 *    这一条与"用量记账写失败不许挡轮次"（93 §4.5.5）**不同**：那是**记账**，
 *    这是**上架闸的凭据** —— 凭据留不下来，这次就不许上架。
 */
export function appendReview(apps, id, rec) {
  const fs = apps.fs ?? nodeFs;
  const file = nodePath.join(apps.appDir(id), REVIEW_FILENAME);
  try {
    fs.mkdirSync(nodePath.dirname(file), { recursive: true, mode: 0o755 });
    fs.appendFileSync(file, `${JSON.stringify({ schema: REVIEW_SCHEMA, ...rec })}\n`, { mode: 0o644 });
  } catch (err) {
    throw new ReviewError(`评审结论没记下来（${err?.message ?? err}）—— 没有凭据就不上架`);
  }
  return { ...rec };
}

/** 评审 agent 回的那一份形状对不对（认不出 ⇒ 当成"没审"= fail-closed）。 */
function readReviewerVerdict(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const rating = Number.isFinite(v.rating) ? Math.trunc(v.rating) : null;
  if (rating === null || rating < 0 || rating > 5) return null;
  if (!['pass', 'reject'].includes(v.verdict)) return null;
  const risks = Array.isArray(v.risks) ? v.risks.filter((r) => typeof r === 'string' && r.trim() !== '') : [];
  const summary = typeof v.summary === 'string' ? v.summary.trim() : '';
  if (summary === '') return null;
  return { rating, risks, summary, verdict: v.verdict };
}

/**
 * 🔴 **上架流程的第一步：预审**（第 4 条）——**自动跑**，不靠谁记得。
 *
 * 它按顺序做五件（每一步读不出都**不自动放行**）：
 *   ① 规则在不在（产品层 ＋ 指纹）；
 *   ② 申报读不读得出（A16 · fail-closed）；
 *   ③ 代码里的出网点 ⊆ 申报（R1／R2）；
 *   ④ 用量：盒里那份的日均 vs 申报的量级（偏差是一个**可查的信号**）；
 *   ⑤ 运营方那一侧/这个容器里的评审 agent（**注入的**；没接上 ⇒ escalate）。
 * 然后把结论**绑 `rootHash`** 落进 `review.jsonl`（R5）。
 *
 * @returns {Promise<{allow:boolean, verdict:'pass'|'escalate'|'reject', refused:string|null,
 *                    words:string, record:object|null, review:object|null}>}
 */
export async function preReview({
  apps,
  id,
  version = null,
  policy = null,
  agent = null,
  usage = null,
  now = Date.now,
  turn = null,
  by = 'pre-review',
} = {}) {
  if (!apps || typeof apps.manifest !== 'function') {
    return { allow: false, verdict: 'reject', refused: 'no-apps', words: '这次上架没有制品库，审不了', record: null, review: null };
  }
  const v = version === null || version === undefined ? apps.current(id) : Number.parseInt(version, 10);
  const man = Number.isInteger(v) && v >= 1 ? apps.manifest(id, v) : null;
  const rootHash = man?.rootHash ?? null;
  const base = {
    at: now,
    what: 'outbound-review',
    scope: 'pre',
    id,
    version: Number.isInteger(v) ? v : null,
    rootHash,
    by,
    turn,
    // ★ **这一条评级是按哪份规则给的**（`rulesHash`）。改规则 ⇒ 旧评级失效
    //   （`judgeRatingsByPolicy()`）—— 没有它就分不清"这条评级还算不算数"。
    rulesHash: null,
  };

  const finish = (verdict, refused, words, extra = {}) => {
    const { reasons: extraReasons = [], ...rest } = extra;
    const review = { ...base, verdict, reasons: [words, ...extraReasons], ...rest };
    try {
      appendReview(apps, id, review);
    } catch (err) {
      // 凭据留不下来 ⇒ **不许上架**（R5），并把这句话说清楚
      return {
        allow: false,
        verdict: 'reject',
        refused: 'review-not-recorded',
        words: `评审结论没记下来（${err?.message ?? err}）—— 没有凭据就不上架`,
        record: null,
        review: null,
      };
    }
    return {
      allow: verdict === 'pass',
      verdict,
      refused: refused ?? (verdict === 'pass' ? null : verdict),
      words,
      record: review,
      review,
    };
  };

  // ① 规则（产品层 ＋ 指纹 · 第 3b 条）
  let rules = null;
  if (policy) {
    try {
      rules = assertReviewPolicy(policy);
      // 规则认下来了 ⇒ 从现在起每条结论都绑着它的指纹（改了规则，旧评级立刻失效）
      base.rulesHash = rules.rulesHash;
    } catch (err) {
      return finish('escalate', 'bad-policy', `预审规则不可用（${err?.message ?? err}）—— 这次不自动放行，请主人看一眼`);
    }
  } else {
    return finish('escalate', 'no-policy', '读不到预审规则（产品层那份）—— 这次不自动放行，请主人看一眼');
  }
  if (!man) {
    // ⚠️ 这个 app 根本不在 ⇒ **先别写记录**（盘上零残留）：没有版本可绑，
    //    写一条 `review.jsonl` 只会凭空造出一个目录。
    let exists = false;
    try {
      exists = apps.current(id) !== null;
    } catch {
      exists = false;
    }
    if (!exists) {
      return {
        allow: false,
        verdict: 'reject',
        refused: 'no-app',
        words: '你自己这儿还没有这个，先做出来再发',
        record: null,
        review: null,
      };
    }
    return finish('reject', 'no-version', `这一版（${String(id).slice(0, 40)} · ${String(v)}）读不出来 —— 审不了就不上架`);
  }

  // ②③ 申报 ＋ 代码扫描（读每个文件都会**逐字节核 hash** ⇒ 读到的是真东西）
  const files = {};
  try {
    for (const f of man.files ?? []) {
      files[f.path] = apps.read(id, v, f.path).content;
    }
  } catch (err) {
    return finish('reject', 'unreadable', `这一版的字节读不出来（${err?.message ?? err}）—— 审不了就不上架`);
  }
  let decl = null;
  let points = [];
  try {
    const r = assertDeclarationAllowed({ files, version: v });
    decl = r.decl;
    points = r.points;
  } catch (err) {
    if (err instanceof DeclarationError) {
      return finish('reject', 'declaration', err.message, { declarationOk: false });
    }
    return finish('reject', 'declaration', `申报读不出来（${err?.message ?? err}）—— 读不到就不上架`);
  }

  // ④ 用量：盒里那份日均 vs 申报的量级（偏差只是一个**可查的信号**，主人第 7 条）
  const summary = usage && typeof usage.summary === 'function' ? usage.summary(id) : null;
  const deviation = usageDeviation({
    measured: summary ? summary.dailyAverage.ones : null,
    declared: decl.declaredUsage.dailyTokensBand,
  });
  const usageBlock = {
    boxDailyAverage: summary ? summary.dailyAverage.ones : null,
    boxDays: summary ? summary.dailyAverage.days : null,
    declaredBand: decl.declaredUsage.dailyTokensBand,
    deviation: deviation.verdict,
    authoritative: 'operator',
  };

  // ⑤ 评审 agent（**注入的**；没接上 ⇒ 不自动放行）
  let verdictFromAgent = null;
  if (typeof agent === 'function') {
    let raw = null;
    try {
      raw = await agent({ id, version: v, rootHash, files, decl, points, policy: rules, usage: summary });
    } catch (err) {
      raw = { unavailable: `评审没跑起来（${err?.message ?? err}）` };
    }
    verdictFromAgent = readReviewerVerdict(raw);
    if (!verdictFromAgent) {
      const why = typeof raw?.unavailable === 'string' ? raw.unavailable : '评审那边回的东西认不出';
      return finish('escalate', 'reviewer-unavailable', `${why} —— 这次不自动放行，请主人看一眼`, {
        declarationOk: true,
        usage: usageBlock,
      });
    }
  } else {
    return finish('escalate', 'reviewer-unavailable', '这台部署还没接上评审 agent —— 这次不自动放行，请主人看一眼', {
      declarationOk: true,
      usage: usageBlock,
    });
  }

  // ⑥ 裁决（低风险自动放行、高风险找主人；门槛住代码，规则只许更严）
  const rating = verdictFromAgent.rating;
  const reasons = [...verdictFromAgent.risks];
  if (verdictFromAgent.verdict === 'reject') {
    return finish('reject', 'reviewer-rejected', `评审说这一版不能上架：${verdictFromAgent.summary}`, {
      declarationOk: true,
      usage: usageBlock,
      rating,
      summary: verdictFromAgent.summary,
      risks: reasons,
      points: points.map((p) => ({ kind: p.kind, path: p.path })),
    });
  }
  if (deviation.verdict === 'deviation') {
    return finish('escalate', 'usage-deviation', `申报的量级与盒里记的日均对不上 —— 以运营方实测为准，请主人看一眼`, {
      declarationOk: true,
      usage: usageBlock,
      rating,
      summary: verdictFromAgent.summary,
      risks: [...reasons, '申报用量与实测偏离'],
      points: points.map((p) => ({ kind: p.kind, path: p.path })),
    });
  }
  if (rating > rules.autoPassMaxRisk) {
    return finish('escalate', 'high-risk', `这一版的风险评级是 ${rating}（超过自动放行那一档）—— 请主人看一眼`, {
      declarationOk: true,
      usage: usageBlock,
      rating,
      summary: verdictFromAgent.summary,
      risks: reasons,
      points: points.map((p) => ({ kind: p.kind, path: p.path })),
    });
  }
  return finish('pass', null, `预审过了（风险评级 ${rating}）`, {
    declarationOk: true,
    usage: usageBlock,
    rating,
    summary: verdictFromAgent.summary,
    risks: reasons,
    points: points.map((p) => ({ kind: p.kind, path: p.path })),
  });
}

/**
 * **运营方那一侧的复评**（主人第 1 条：运营方保存的那个 agent 读整份源码）。
 *
 * ⚠️ 它和预审**用同一个 agent 接口**、落**同一条流**（`scope:'operator'`），
 *    只是 `by` 不同；这样两份结论指得到同一个 `rootHash`（R5）。
 */
export async function operatorReview({ apps, id, version = null, agent = null, policy = null, now = Date.now, turn = null } = {}) {
  const v = version === null || version === undefined ? apps.current(id) : Number.parseInt(version, 10);
  const man = Number.isInteger(v) && v >= 1 ? apps.manifest(id, v) : null;
  if (!man) throw new ReviewError('要复评的那一版读不出来');
  // 复评也要绑规则指纹 —— 否则"两份评级哪一份是现在这份规则给的"就答不出来。
  let rulesHash = null;
  if (policy) {
    try {
      rulesHash = assertReviewPolicy(policy).rulesHash;
    } catch {
      rulesHash = null; // 规则认不出 ⇒ 结论照落（事实不能静默），但**不算数**
    }
  }
  const files = {};
  for (const f of man.files ?? []) files[f.path] = apps.read(id, v, f.path).content;
  const raw = typeof agent === 'function' ? await agent({ id, version: v, rootHash: man.rootHash, files }) : null;
  const got = readReviewerVerdict(raw);
  if (!got) throw new ReviewError('运营方那一侧的评审没跑起来（或者回的东西认不出）—— 如实报，不猜');
  const review = {
    at: now,
    what: 'outbound-review',
    scope: 'operator',
    id,
    version: v,
    rootHash: man.rootHash,
    verdict: got.verdict,
    reasons: [...got.risks],
    rating: got.rating,
    summary: got.summary,
    by: 'operator-agent',
    turn,
    rulesHash,
  };
  appendReview(apps, id, review);
  return review;
}

/**
 * 🔴 **改了规则 ⇒ 所有旧评级失效**（96 第 3b 条 · 93 §八 阶段 2.5）。
 *
 * 每条评级都记着它**当时是按哪份规则**给的（`rulesHash`）。现在这份规则的指纹与它不同
 * ⇒ 那一条**不算数** —— 不许拿"旧规则说它低风险"去自动放行。
 * 🔴 现在这份规则读不出来 ⇒ **一条都不算数**（fail-closed）。
 *
 * @param {object} o
 * @param {Array<object>} o.rows      `reviewRows()` 读出来的结论
 * @param {object|string|null} o.policy 产品层那份规则（或直接给 `rulesHash`）
 * @returns {{hash:string|null, valid:Array<object>, stale:Array<object>, why:string}}
 */
export function judgeRatingsByPolicy({ rows = [], policy = null } = {}) {
  const hash = typeof policy === 'string' && policy !== ''
    ? policy
    : (typeof policy?.rulesHash === 'string' && policy.rulesHash !== '' ? policy.rulesHash : null);
  if (hash === null) {
    return {
      hash: null,
      valid: [],
      stale: [...(rows ?? [])],
      why: '现在这份规则读不出来 —— 旧评级一条都不算数（fail-closed）',
    };
  }
  const valid = [];
  const stale = [];
  for (const r of rows ?? []) (r && r.rulesHash === hash ? valid : stale).push(r);
  return {
    hash,
    valid,
    stale,
    why: stale.length === 0 ? '旧评级都还是按现在这份规则给的' : `${stale.length} 条旧评级是别的规则给的 —— 失效`,
  };
}

/**
 * **预审与复评对不对得上**（96 · 我自定的第 4 条：差太多本身就是一条反着验的判据）。
 *
 * @returns {{agree:boolean, delta:number|null, why:string}}
 */
export function compareReviews({ pre = null, operator = null } = {}) {
  if (!pre || !operator) {
    return { agree: false, delta: null, why: '两份结论少一份 —— 对不上就是对不上（不许当成"一致"）' };
  }
  if (pre.rootHash !== operator.rootHash) {
    return { agree: false, delta: null, why: '两份结论指的不是同一个 rootHash —— 比不了' };
  }
  if (pre.verdict !== operator.verdict) {
    return { agree: false, delta: null, why: `预审说 ${pre.verdict}、运营方说 ${operator.verdict} —— 对不上` };
  }
  const a = Number.isFinite(pre.rating) ? pre.rating : null;
  const b = Number.isFinite(operator.rating) ? operator.rating : null;
  const delta = a === null || b === null ? null : Math.abs(a - b);
  if (delta === null) return { agree: false, delta: null, why: '有一份没有评级 —— 比不了' };
  return {
    agree: delta <= REVIEW_AGREEMENT_MAX_DELTA,
    delta,
    why: delta <= REVIEW_AGREEMENT_MAX_DELTA ? '两份对得上' : `评级差了 ${delta} 档 —— 差太多`,
  };
}
