#!/usr/bin/env bash
# **「发布真跑一次（分级）＋ 升级分级派 ＋ 升级粒度」的闸**（`D4.24` · **A2／C1／C3** ·
#   2026-10-03 主人定；出处 `docs/dev/85-FRAMEWORK.md` §五 F1–F4 · `docs/dev/90-APP-CONTRACT.md`
#   §10.1 ②④ · `docs/dev/92-TRIPLE-PLAN.md` §② · 签字页 `docs/dev/161-OWNER-DECISIONS-11.md`
#   A2／C1／C3 · 事实记录见 `docs/dev/168-PUBLISH-RUN-UPGRADE.md`）。
#
# 用法：
#   bash scripts/check-publish-run-upgrade.sh
#
# 退出码 = 失败数（0 ⇒ 通过）；末尾固定打印 **`通过 N · 失败 M`**。
#
# ── 它问的是哪三件事（与已有那九条闸不是一回事）──────────────────
#   **A2** 发布**必须真跑过，但分级**：只验"能跑起来的最小判据"（**入口必崩 ⇒ 拒**），
#          **不做全量回归**；驳回要说清为什么。
#   **C1** 升级=**分级派**：**契约版本变了才请 AI 重写** ⇒ 判据最硬的一条
#          **契约版未变 ⇒ AI 重写计数 = 0**（能反着验），而且判定**只有一处**（含**变异**）。
#   **C3** 升级粒度=**默认按用户整体跟，允许按 app 留旧版**（留旧版要有可观察表示）。
#
# ── 判据 ①–⑧（每条都带**负向对照**；⑥ 带**变异**）───────────────
#   ① A2 真跑过的最小判据**通过 ⇒ 发**（登记里有"跑过"的凭据）
#   ② A2 **入口必崩 ⇒ 拒**；★ 负向对照：**把崩的那份修好 ⇒ 过**
#   ③ A2 **不做全量回归**（源码级：不碰子进程／网络／npm；行为级：`while(true)` 被硬预算截）
#   ④ A2 驳回理由**看得见**（点名哪个文件、哪一行、什么错）
#   ⑤ C1 **契约版未变 ⇒ 重写计数 = 0**；★ 负向对照：**变了 ⇒ 计数 > 0**
#   ⑥ C1 判定**只有一处**（源码级）＋ **变异**：把那处 guard 改坏 ⇒ 红
#   ⑦ C3 **默认按用户跟**；★ 负向对照：**显式留旧版的那一个 ⇒ 不跟**，且状态看得见
#   ⑧ C3 **不过度**：没升级需求的 ⇒ **一个字节都不写**（整棵树逐文件 sha256 不变）
#
# 🔴 纪律（`92` §④ 末两条）：
#   · 读不出 / 算不出 ⇒ 如实打印 **`不可算`** 并记**失败**，**绝不安静地绿**；
#   · **每一条都要有负向对照**，而且脚本自己核那条对照真的在；
#   · **越界／误操作零残留**：真数据目录跑完**逐文件 sha256 复原**（本脚本自己核）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/v2/services/core"

# ⚠️ `sudo` 底下 PATH 里没有 node（这台机器只有 nvm 里那一个）⇒ 兜一圈找它。
NODE="${NODE_BIN:-}"
if [ -z "$NODE" ]; then
  for c in /home/deploy/.nvm/versions/node/*/bin/node "$(command -v node 2>/dev/null || true)"; do
    [ -x "$c" ] && { NODE="$c"; break; }
  done
fi
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "✗ 找不到 node（这台机器只有 nvm 里那一个）"; exit 2; }

pass=0; fail=0
ok()  { echo "  ✓ $1"; pass=$((pass + 1)); }
bad() { echo "  ✗ $1"; fail=$((fail + 1)); }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

# ── 真数据目录**跑前**的逐文件 sha256（收尾核"零残留"用）────────────────
snapshot_data() {
  if [ -d "$CORE/data" ]; then
    find "$CORE/data" -type f -print0 2>/dev/null | sort -z | xargs -0 -r sha256sum 2>/dev/null
  fi
}
DATA_BEFORE="$(snapshot_data)"

# ══════════════════════════════════════════════════════════════════
echo '── ①–⑧：临时目录里用**真代码**（不碰线上、不碰真数据目录）'
# ══════════════════════════════════════════════════════════════════

cat > "$T/run-up-probe.mjs" <<'NODE'
// 一次性探针：真 `src/` 模块 ＋ 临时目录里的真盘。输出协议 `OK <id> :: <名字> ;; <读数>` / `BAD ...`。
import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { pathToFileURL } from 'node:url';

const CORE = process.env.HUPO_CORE;
const T = process.env.HUPO_PROBE_TMP;

const ok = (id, name, reading) => console.log(`OK  ${id} :: ${name} ;; ${reading}`);
const bad = (id, name, reading) => console.log(`BAD ${id} :: ${name} ;; ${reading}`);
const caught = (fn) => { try { fn(); return null; } catch (err) { return err; } };

const mod = (rel) => import(pathToFileURL(nodePath.join(CORE, 'src', rel)).href);
const { Apps } = await mod('apps.js');
const { Published } = await mod('published.js');
const { RUN_FAILURES, RUN_TIMEOUT_MS, describeRunFailure, runEntryOnce } = await mod('app-run.js');
const {
  UPGRADE_KINDS, UpgradeBook, UpgradePolicy, decideUpgrade, planUpgrade,
} = await mod('app-upgrade.js');

const OUTBOUND = JSON.stringify({
  schema: 1, outbound: [], declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '闸' },
});
const page = (body) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
let seq = 0;
const tmp = (tag) => nodeFs.mkdtempSync(nodePath.join(T, `${tag}-${seq++}-`));
function world(tag) {
  const dir = tmp(tag);
  return { dir, apps: new Apps({ dir, sub: 'u1' }), published: new Published({ dir }) };
}
const makeApp = (w, id, files) => w.apps.create({
  id, title: id, icon: 'dice', entry: 'index.html',
  files: { 'index.html': page('<p>x</p>'), ...files },
});
const publish = (w, id) => w.published.publish(w.apps, { id, authorSub: 'u1', authorName: '甲' });

/** 整棵树逐文件 sha256（判"零残留／一个字节都没动"用）。 */
function treeSha(root) {
  const out = [];
  const walk = (rel) => {
    let es = [];
    try { es = nodeFs.readdirSync(rel === '' ? root : nodePath.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of [...es].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const next = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) { out.push(`${next}/`); walk(next); continue; }
      out.push(`${next}:${nodeCrypto.createHash('sha256').update(nodeFs.readFileSync(nodePath.join(root, next))).digest('hex')}`);
    }
  };
  walk('');
  return out.join('\n');
}
const read = (f) => nodeFs.readFileSync(nodePath.join(CORE, 'src', f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

process.on('uncaughtException', (e) => {
  console.log(`BAD probe :: 探针崩了（算不出来） ;; ${String(e?.stack ?? e).slice(0, 300)}`);
  process.exitCode = 1;
});

// ── ① A2：真跑过的最小判据通过 ⇒ 发（登记里有凭据）────────────────
try {
  const w = world('P1');
  makeApp(w, 'good', { 'index.html': page('<script>window.__x = 1</script>'), 'outbound.json': OUTBOUND });
  const idx = publish(w, 'good');
  const onDisk = JSON.parse(nodeFs.readFileSync(nodePath.join(w.published.appDir('good'), 'index.json'), 'utf8'));
  const passed = idx && idx.id === 'good';
  const receipt = idx?.ran?.ok === true && idx.ran.scripts === 1 && onDisk?.ran?.ok === true;
  if (passed && receipt) {
    ok('P1 =①', '🔴 A2 真跑过的最小判据通过 ⇒ 发（凭据落进登记）',
      `发成了（第 ${idx.version} 版）· 登记里 \`ran.ok=true\`（跑了 ${idx.ran.scripts} 段、${idx.ran.ms}ms）· 盘上那份 index.json 逐字有它`);
  } else {
    bad('P1 =①', 'A2 通过 ⇒ 发', `发成=${passed}；凭据=${receipt}`);
  }
} catch (e) {
  bad('P1 =①', 'A2 通过 ⇒ 发', `**不可算**（${e?.message ?? e}）`);
}

// ── ② A2：入口必崩 ⇒ 拒；★ 修好 ⇒ 过；拒时零残留 ─────────────────
try {
  const w = world('P2');
  const pubRoot = nodePath.join(w.dir, 'published-apps');
  makeApp(w, 'boom', { 'index.html': page('<script>throw new Error("入口就崩了")</script>'), 'outbound.json': OUTBOUND });
  const before = treeSha(pubRoot);
  const err = caught(() => publish(w, 'boom'));
  const after = treeSha(pubRoot);
  const refused = err?.name === 'EntryRunError';
  const zeroResidue = before === after && w.published.index('boom') === null;
  const visible = /起不来/.test(err?.message ?? '') && /index\.html/.test(err?.message ?? '');
  // ★ 负向对照：把崩的那一份**修好** ⇒ 同一件事就成
  makeApp(w, 'boom', { 'index.html': page('<script>var ok = 1</script>'), 'outbound.json': OUTBOUND });
  let fixedIdx = null;
  try { fixedIdx = publish(w, 'boom'); } catch { /* 修好了还发不成 ⇒ 下面照样判红 */ }
  const fixedOk = fixedIdx?.ran?.ok === true;
  if (refused && zeroResidue && visible && fixedOk) {
    ok('P2 =②', '🔴 A2 入口必崩 ⇒ 拒（理由看得见、盘上零残留）；★ 负向对照：修好 ⇒ 过',
      `拒了（\`EntryRunError\`）· 共享库逐文件 sha256 **逐字复原**（一条都没有） · ★ 把那一句抛改成 \`var ok=1\` ⇒ 同一条路发成了`);
  } else {
    bad('P2 =②', 'A2 入口必崩 ⇒ 拒', `拒=${refused}；零残留=${zeroResidue}；理由可见=${visible}；修好过=${fixedOk}（err=${err?.message ?? '—'}）`);
  }
} catch (e) {
  bad('P2 =②', 'A2 入口必崩 ⇒ 拒', `**不可算**（${e?.message ?? e}）`);
}

// ── ③ A2：不做全量回归（源码级 ＋ 行为级）─────────────────────────
try {
  const src = strip(read('app-run.js'));
  const noHeavy = ['child_process', 'execSync', 'spawnSync', 'node:net', 'node:http', 'node:https', 'npm test']
    .every((b) => !src.includes(b));
  const hasBudget = /timeout: RUN_TIMEOUT_MS/.test(src);
  const onlyOne = strip(read('published.js')).includes('runEntryOnce({')
    && ['app-run.js', 'published.js', 'apps-socket.js', 'workspace.js', 'apps.js']
      .filter((f) => read(f).includes('export function runEntryOnce(')).length === 1;
  const t0 = Date.now();
  const r = runEntryOnce({ entry: 'index.html', files: { 'index.html': page('<script>while (true) {}</script>') } });
  const ms = Date.now() - t0;
  const cut = r.ok === false && r.kind === RUN_FAILURES.TIMEOUT && ms < RUN_TIMEOUT_MS * 20;
  if (noHeavy && hasBudget && onlyOne && cut) {
    ok('P3 =③', '🔴 A2 不做全量回归（源码级 ＋ 行为级）',
      `源码里没有子进程／网络／npm；跑的时候带硬预算 · \`runEntryOnce\` 只在 app-run.js 定义一次、publish 只调它一次 · ★ 死循环入口 ${ms}ms 被截住（预算 ${RUN_TIMEOUT_MS}ms；**没有跑长**）`);
  } else {
    bad('P3 =③', 'A2 不做全量回归', `无重家伙=${noHeavy}；有硬预算=${hasBudget}；只一处=${onlyOne}；截住=${cut}（${ms}ms）`);
  }
} catch (e) {
  bad('P3 =③', 'A2 不做全量回归', `**不可算**（${e?.message ?? e}）`);
}

// ── ④ A2：驳回理由看得见（点名文件与行）───────────────────────────
try {
  const r = runEntryOnce({
    entry: 'index.html',
    files: { 'index.html': page('<script>\nvar a = 1;\nthrow new Error("第三行崩的")\n</script>') },
  });
  const words = describeRunFailure(r);
  const seen = r.ok === false && r.file === 'index.html#script-0' && r.line === 3
    && /第三行崩的/.test(r.error ?? '') && /起不来/.test(words) && /第 3 行/.test(words);
  // ★ 负向对照：没崩的那一份**不许**被说成"起不来"
  const cleanRun = runEntryOnce({ entry: 'index.html', files: { 'index.html': page('<p>素</p>') } });
  const cleanOk = cleanRun.ok === true && /起来了/.test(cleanRun.message) && !/起不来/.test(cleanRun.message);
  if (seen && cleanOk) {
    ok('P4 =④', '🔴 A2 驳回理由看得见（哪个文件、哪一行、什么错）',
      `拒的话点名 \`index.html#script-0 第 3 行：第三行崩的\` · ★ 负向对照：没崩的那一份说的是"起来了"，**不是**"起不来"`);
  } else {
    bad('P4 =④', 'A2 驳回理由看得见', `点名=${seen}；没崩那份说对了=${cleanOk}（${words}）`);
  }
} catch (e) {
  bad('P4 =④', 'A2 驳回理由看得见', `**不可算**（${e?.message ?? e}）`);
}

// ── C1／C3 共用：一个 app 三版（v1/v2 同契约，v3 契约变了）─────────
function threeVersions(tag) {
  const w = world(tag);
  for (let i = 0; i < 3; i += 1) makeApp(w, 'a', { 'outbound.json': OUTBOUND });
  const p = nodePath.join(w.apps.versionDir('a', 3), 'manifest.json');
  nodeFs.chmodSync(p, 0o644);
  const j = JSON.parse(nodeFs.readFileSync(p, 'utf8'));
  j.schema = 2;
  nodeFs.writeFileSync(p, `${JSON.stringify(j, null, 2)}\n`);
  return w;
}

// ── ⑤ C1：契约版未变 ⇒ 计数 0；★ 变了 ⇒ > 0 ──────────────────────
try {
  const w = threeVersions('P5');
  const book = new UpgradeBook({ dir: w.dir });
  const same = book.plan({ apps: w.apps, id: 'a', fromVersion: 1, toVersion: 2 });
  const zero = book.rewriteCount() === 0 && same.kind === UPGRADE_KINDS.BYTE_SWAP && same.rewrite === false;
  // ★ 负向对照：契约版变了的那一次 ⇒ 计数必须涨
  const changed = book.plan({ apps: w.apps, id: 'a', fromVersion: 2, toVersion: 3 });
  const rose = book.rewriteCount() > 0 && changed.kind === UPGRADE_KINDS.AI_REWRITE && changed.rewrite === true;
  if (zero && rose) {
    ok('P5 =⑤', '🔴 C1 契约版未变 ⇒ AI 重写计数 = 0；★ 负向对照：变了 ⇒ 计数 > 0',
      `未变那一次：\`${same.kind}\`／计数 **0** · 变了那一次：\`${changed.kind}\`（契约 ${changed.contractFrom}→${changed.contractTo}）／计数 **${book.rewriteCount()}**`);
  } else {
    bad('P5 =⑤', 'C1 重写计数', `未变=0 成立=${zero}；变了>0 成立=${rose}`);
  }
} catch (e) {
  bad('P5 =⑤', 'C1 重写计数', `**不可算**（${e?.message ?? e}）`);
}

// ── ⑥ C1：判定只有一处（源码级；变异在 bash 那一段）────────────────
try {
  const files = nodeFs.readdirSync(nodePath.join(CORE, 'src')).filter((f) => f.endsWith('.js'));
  const whole = files.map((f) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')).join('\n');
  const n = (re) => (whole.match(re) ?? []).length;
  const ones = n(/export function decideUpgrade\(/g) === 1
    && n(/contractFrom === contractTo/g) === 1
    && n(/: UPGRADE_KINDS\.AI_REWRITE;/g) === 1
    && n(/AI_REWRITE: 'ai-rewrite'/g) === 1;
  const up = strip(read('app-upgrade.js'));
  const at = up.indexOf('export function planUpgrade(');
  const planUses = at > 0 && /decideUpgrade\(/.test(up.slice(at, at + 2600));
  const wired = strip(read('apps-socket.js')).includes('ctx.upgrade.plan(');
  if (ones && planUses && wired) {
    ok('P6 =⑥', '🔴 C1 判定只有一处（源码级）',
      '那条比较／那个结论／那个取值全仓各只一份 · `planUpgrade` 只走它 · 装／升级那条真路（`apps-socket`）只调 `ctx.upgrade.plan`');
  } else {
    bad('P6 =⑥', 'C1 判定只有一处', `各一份=${ones}；planUpgrade 走它=${planUses}；真路接线=${wired}`);
  }
} catch (e) {
  bad('P6 =⑥', 'C1 判定只有一处', `**不可算**（${e?.message ?? e}）`);
}

// ── ⑦ C3：默认按用户跟；★ 留旧版 ⇒ 不跟，状态看得见 ───────────────
try {
  const w = threeVersions('P7');
  const policy = new UpgradePolicy({ dir: w.dir });
  const dflt = policy.state('a');
  const followsPlan = planUpgrade({ apps: w.apps, id: 'a', fromVersion: 2, toVersion: 3, policy });
  const defaultFollows = dflt.mode === 'user' && dflt.follows === true && followsPlan.kind === UPGRADE_KINDS.AI_REWRITE;
  // ★ 负向对照：显式留旧版的那一个 ⇒ **不跟**（哪怕别人都在跟）
  makeApp(w, 'b', { 'outbound.json': OUTBOUND });
  policy.pin('a', 2);
  const st = policy.state('a');
  const heldPlan = planUpgrade({ apps: w.apps, id: 'a', fromVersion: 2, toVersion: 3, policy });
  const held = st.follows === false && st.pinnedVersion === 2 && heldPlan.kind === UPGRADE_KINDS.HELD
    && heldPlan.rewrite === false && policy.state('b').follows === true;
  if (defaultFollows && held) {
    ok('P7 =⑦', '🔴 C3 默认按用户跟；★ 负向对照：显式留旧版的那一个 ⇒ 不跟（状态看得见）',
      `默认 \`mode=user\`／\`follows=true\` ⇒ 契约变了就请 AI · 留旧版那个：\`follows=false\`、\`pinnedVersion=2\`、决定 \`${heldPlan.kind}\` · 别的 app（b）照旧跟`);
  } else {
    bad('P7 =⑦', 'C3 升级粒度', `默认跟=${defaultFollows}；留旧版不跟=${held}`);
  }
} catch (e) {
  bad('P7 =⑦', 'C3 升级粒度', `**不可算**（${e?.message ?? e}）`);
}

// ── ⑧ C3：不过度（没升级需求 ⇒ 一个字节都不写）─────────────────────
try {
  const w = threeVersions('P8');
  const book = new UpgradeBook({ dir: w.dir });
  const before = treeSha(w.dir);
  const none = book.plan({ apps: w.apps, id: 'a', fromVersion: 2, toVersion: 2 });
  const quiet = none.kind === UPGRADE_KINDS.NONE && book.entries().length === 0
    && !nodeFs.existsSync(book.file) && treeSha(w.dir) === before;
  // ★ 负向对照：真有升级需求 ⇒ 账本必须**真的**写一行（证明上面不是恒等空跑）
  book.plan({ apps: w.apps, id: 'a', fromVersion: 1, toVersion: 2 });
  const wrote = book.entries().length === 1 && treeSha(w.dir) !== before;
  if (quiet && wrote) {
    ok('P8 =⑧', '🔴 C3 不过度：没有升级需求 ⇒ 一个字节都不写',
      `\`kind=${none.kind}\`／账本没建／整棵树逐文件 sha256 **逐字不变** · ★ 负向对照：真有升级 ⇒ 账本真写了一行、树真变了`);
  } else {
    bad('P8 =⑧', 'C3 不过度', `没需求不动=${quiet}；对照写真了=${wrote}`);
  }
} catch (e) {
  bad('P8 =⑧', 'C3 不过度', `**不可算**（${e?.message ?? e}）`);
}

process.exitCode = 0;
NODE

OUT="$(HUPO_CORE="$CORE" HUPO_PROBE_TMP="$T" "$NODE" "$T/run-up-probe.mjs" 2>&1)"
rc=$?
printf '%s\n' "$OUT" | grep '^OK  ' | sed 's/^OK  /  ✓ /'
printf '%s\n' "$OUT" | grep '^BAD ' | sed 's/^BAD /  ✗ /'
np="$(printf '%s\n' "$OUT" | grep -c '^OK  ' || true)"
nf="$(printf '%s\n' "$OUT" | grep -c '^BAD ' || true)"
pass=$((pass + np)); fail=$((fail + nf))
if [ "$rc" != "0" ] && [ "$nf" = "0" ]; then
  bad "①–⑧ 探针异常退出（rc=$rc）却没报哪一条 ⇒ 这些判据**不可算**"
fi
if [ "$nf" = "0" ] && [ "$np" -lt 8 ]; then
  bad "①–⑧ 应该出 8 条读数（P1–P8），只读到 $np 条 ⇒ **不可算**"
fi

# ══════════════════════════════════════════════════════════════════
echo
echo '── ⑥（后半）：**变异** —— 把那处 guard 改坏 ⇒ 红'
# ══════════════════════════════════════════════════════════════════

MUT="$T/mut"
mkdir -p "$MUT"
cp -r "$CORE/src" "$MUT/src"
ln -s "$CORE/node_modules" "$MUT/node_modules" 2>/dev/null || true
MUT_RESULT="$(HUPO_MUT="$MUT/src" "$NODE" -e '
const fs = require("node:fs");
const path = require("node:path");
const p = path.join(process.env.HUPO_MUT, "app-upgrade.js");
let s = fs.readFileSync(p, "utf8");
// 变异：把"契约版未变 ⇒ 换字节"那一条**改坏**（变成"一律请 AI 重写"）
const guard = "return contractFrom === contractTo ? UPGRADE_KINDS.BYTE_SWAP : UPGRADE_KINDS.AI_REWRITE;";
if (!s.includes(guard)) { console.log("NOGUARD"); process.exit(0); }
s = s.replace(guard, "return UPGRADE_KINDS.AI_REWRITE;");
fs.writeFileSync(p, s);
console.log("MUTATED");
' 2>&1)"
if [ "$MUT_RESULT" != "MUTATED" ]; then
  bad "⑥ 变异没做成（**不可算**）：$MUT_RESULT"
else
  cat > "$T/mut-probe.mjs" <<'NODE'
// 变异探针：只问一件事 —— **契约版没变**的那一次，会不会触发重写？
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { pathToFileURL } from 'node:url';
const SRC = process.env.MUT_SRC;
const T = process.env.HUPO_PROBE_TMP;
const mod = (rel) => import(pathToFileURL(nodePath.join(SRC, rel)).href);
const { Apps } = await mod('apps.js');
const { UpgradeBook } = await mod('app-upgrade.js');
const dir = nodeFs.mkdtempSync(nodePath.join(T, 'mut-'));
const apps = new Apps({ dir, sub: 'u1' });
const files = { 'index.html': '<p>x</p>' };
apps.create({ id: 'a', title: 'a', icon: 'dice', entry: 'index.html', files });
apps.create({ id: 'a', title: 'a', icon: 'dice', entry: 'index.html', files });
const book = new UpgradeBook({ dir });
book.plan({ apps, id: 'a', fromVersion: 1, toVersion: 2 });
console.log(book.rewriteCount() > 0 ? 'UNCHANGED_REWRITTEN' : 'UNCHANGED_NO_REWRITE');
NODE

  real="$(HUPO_PROBE_TMP="$T" MUT_SRC="$CORE/src" "$NODE" "$T/mut-probe.mjs" 2>&1)"
  mut="$(HUPO_PROBE_TMP="$T" MUT_SRC="$MUT/src" "$NODE" "$T/mut-probe.mjs" 2>&1)"
  echo "  · 真代码：$(printf '%s' "$real" | tr '\n' ' ')"
  echo "  · 变异后：$(printf '%s' "$mut" | tr '\n' ' ')"
  case "$real" in
    UNCHANGED_NO_REWRITE*) ok '⑥ 正对照：真代码里"契约版未变"那一次的重写计数 = 0' ;;
    *) bad "⑥ 正对照：真代码里未变那一次本该是 0（**不可算**）：$real" ;;
  esac
  case "$mut" in
    UNCHANGED_REWRITTEN*)
      ok '⑥ 变异：把那处 guard 改坏（一律请 AI）⇒ **未变也重写了**（证明那处判定真的承重，判据能反着验）' ;;
    *) bad "⑥ 变异：改坏 guard 之后未变那一次居然还是 0 ⇒ 要么改错地方，要么别处还有一道闸（**红**）：$mut" ;;
  esac
fi

# ── 判据自己也要有负向对照：核那两份测试里真的有"对照" ───────────────────
markers_in() {
  local tf="$1"; shift
  if [ ! -f "$tf" ]; then
    bad "找不到 $(basename "$tf") ⇒ 它的读数**不可算**"
    return
  fi
  for marker in "$@"; do
    if ! grep -qF "$marker" "$tf"; then
      bad "$(basename "$tf") 里找不到负向对照「$marker」⇒ 可能没在反着验"
    fi
  done
}
markers_in "$CORE/test/app-run.test.js" '负向对照' '零残留' '起不来' '不过度' '全量回归'
markers_in "$CORE/test/app-upgrade.test.js" '负向对照' '重写计数' '留旧版' '不过度' '不可算'

# ══════════════════════════════════════════════════════════════════
echo
echo '── 越界／误操作零残留：真数据目录跑完**逐文件 sha256 复原**'
# ══════════════════════════════════════════════════════════════════
DATA_AFTER="$(snapshot_data)"
if [ "$DATA_BEFORE" = "$DATA_AFTER" ]; then
  n_files="$(printf '%s\n' "$DATA_AFTER" | grep -c . || true)"
  ok "真数据目录（$n_files 个文件）逐文件 sha256 **逐字复原** —— 本闸只碰临时目录，没动线上、没动真数据"
else
  bad "真数据目录变了（越界／误操作）—— 逐文件 sha256 对不上"
  diff <(printf '%s\n' "$DATA_BEFORE") <(printf '%s\n' "$DATA_AFTER") | head -10
fi

echo
echo "──────────────────────────────"
if [ "$fail" = "0" ]; then
  echo "✅ 通过 $pass · 失败 $fail"
  exit 0
fi
echo "✗ 通过 $pass · 失败 $fail"
exit 1
