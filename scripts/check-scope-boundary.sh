#!/usr/bin/env bash
# **92 §④「真机（这台机器上真装真跑）」那一列的闸**
# （契约 `docs/dev/92-TRIPLE-PLAN.md` §④ · `docs/dev/91-TRIPLE-CONTRACT.md` §7.2 · `docs/dev/98-STAGE3-DEFAULTS.md`）。
#
# 用法：
#   bash scripts/check-scope-boundary.sh            # portable：只跑**复用那几条测试**（不碰真机）
#   bash scripts/check-scope-boundary.sh --live     # 再加"真机"那几条（**这台机器就是线上机，谨慎**）
#
# ── 判据（七条，照 §④ 那一列逐条落；每条都带**负向对照**）──────
#   一 真实 scope 放 `.data/a.json` 再上架 ⇒ `manifest.files[]` **无它**（＋制品口也取不到）
#   二 删 `.exp/` ⇒ 能力体**照开**（91 §7.2.1；读的还是制品口那条路 `apps.read`）
#   三 模型写**无声明** `.exp/` 包 ⇒ 不自动生效（上架 fail-closed ＋ 每轮输入侧零读路）
#   四 收到别人的经验包 ⇒ **不自动生效**、能回退（逐字节等于应用前）
#   五 装一次 ⇒ 改过的本地那份**有副本、可一步退**
#   六 上架一次 ⇒ 共享库**全库**搜数据哨兵与令牌 ⇒ **零命中**
#   七 助手自己想到要做小程序（用户没明说）⇒ **拒**（回归 `apps-consent.js`）
#
# 🔴 两条纪律（92 §④ 末）：
#   · 读不出字段 ⇒ 如实报 **`不可算`**，记**失败**，绝不安静地绿；
#   · 判据自己**也要有负向对照**（喂坏样本必须抓得住）。
#
# ── 哪些是"复用已有测试"（不重复造）────────────────────────
#   一（离线）`test/app-write-gates.test.js` · 三（离线）`test/outbound-defaults.test.js`
#   四（离线）`test/delivery-stage4.test.js` · 五（离线）`test/app-install-fork.test.js`
#   六（离线）`test/outbound-gate.test.js` · 七 `test/apps-consent.test.js`
#   ⇒ 那几条只**跑那个测试并如实报读数**（含它自带的负向对照）。
#
# ── 真机那几条怎么做到"改动很小、能自己收干净"──────────────
#   用**一次性探针制品**（id 一律 `probe-` 前缀）：scope 落在临时目录里，
#   只有"上架"那一下会碰到**真共享库**（`<data>/published-apps/`）。
#   跑完：删探针目录 ＋ 把审计账逐字节复原 ＋ **全库再搜一遍哨兵**（这是判据的一部分）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/v2/services/core"
LIVE=0
[ "${1:-}" = "--live" ] && LIVE=1

# ⚠️ `sudo` 底下 PATH 里没有 node（这台机器只有 nvm 里那一个）⇒ 兜一圈找它。
NODE="${NODE_BIN:-}"
if [ -z "$NODE" ]; then
  for c in /home/deploy/.nvm/versions/node/*/bin/node "$(command -v node 2>/dev/null || true)"; do
    [ -x "$c" ] && { NODE="$c"; break; }
  done
fi
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "✗ 找不到 node（这台机器只有 nvm 里那一个）"; exit 2; }

pass=0; fail=0; skipped=0
ok()   { echo "  ✓ $1"; pass=$((pass + 1)); }
bad()  { echo "  ✗ $1"; fail=$((fail + 1)); }
skip() { echo "  · $1"; skipped=$((skipped + 1)); }

# ══════════════════════════════════════════════════════════════════
echo "── portable：复用已有测试（**不碰真机**）"
# ══════════════════════════════════════════════════════════════════

# 跑一份测试，如实报读数；顺便核"那份测试里**真的**有负向对照"。
# $1 = test 文件名（不带 .test.js）· $2 = 判据名 · $3 = 负向对照必须出现的字
run_reused() {
  local f="$1" name="$2" neg="$3" out p fl file
  file="$CORE/test/$f.test.js"
  if [ ! -f "$file" ]; then bad "$name：找不到 test/$f.test.js ⇒ **不可算**"; return; fi
  out="$(cd "$CORE" && "$NODE" --test "test/$f.test.js" 2>&1)"
  p="$(sed -n 's/^ℹ pass //p' <<<"$out" | tail -1)"
  fl="$(sed -n 's/^ℹ fail //p' <<<"$out" | tail -1)"
  if [ -z "$p" ] || [ -z "$fl" ]; then
    bad "$name：读数读不出来（**不可算**）—— 测试跑挂了吗"
    return
  fi
  if ! grep -qF "$neg" "$file"; then
    bad "$name：那份测试里找不到负向对照「$neg」⇒ 这条判据可能没在反着验"
    return
  fi
  if [ "$fl" = "0" ] && [ "$p" -gt 0 ]; then
    ok "$name ⇒ 复用 test/$f.test.js（过 $p 条／败 0；含负向对照「$neg」）"
  else
    bad "$name：test/$f.test.js 败了 $fl 条（过 $p 条）"
  fi
}

# 判据一（离线那一半）：两格字节进不了制品 —— 写入侧拒 ＋ 发布时不带
run_reused app-write-gates "判据一·离线：「.data/」「.exp/」不进制品" "盘上零残留"
# 判据二：没有离线判据（它就是"真机上真删真开"那一条）
skip "判据二：**没有离线判据** —— 它只有真机那一条（--live）"
# 判据三（离线那一半）：每轮输入那一侧**没有**读路（源码扫描，含"不是恒真"的反例）
run_reused outbound-defaults "判据三·离线：每轮输入侧无「.exp」「.data」读路" "不是恒真"
# 判据四（离线那一半）：一对一交付这一版**不搬字节**（只建登记面）
run_reused delivery-stage4 "判据四·离线：交付登记面不搬「.data/」「.exp/」字节" "不搬字节"
# 判据五（离线那一半）：装前先拍快照 ＋ 拿快照能逐字节还原
run_reused app-install-fork "判据五·离线：装前快照、可逐字节回退" "反例"
# 判据六（离线那一半）：无锚的 `share:true` ⇒ 拒；冒出第二个出口 ⇒ 红
run_reused outbound-gate "判据六·离线：出界只一条独木桥、无锚不出去" "第二出口"
# 判据七：他没明说 ⇒ 拒（助手自己想到的只许提）
run_reused apps-consent "判据七：没明说就拒、说了才成" "盘上一点东西都没有"

# ══════════════════════════════════════════════════════════════════
if [ "$LIVE" != "1" ]; then
  echo
  echo "（真机那几条没跑 —— 加 --live。⚠️ 这台机器**就是**线上机，跑之前想清楚。）"
else
  echo
  echo "── 真机：一次性探针制品（probe- 前缀；跑完删掉 ＋ 再核零残留）"
  # ══════════════════════════════════════════════════════════════════
  REAL_DATA="${HUPO_SCOPE_DATA:-${HUPO_DATA:-$CORE/data}}"
  PUBROOT="$REAL_DATA/published-apps"
  if [ ! -d "$PUBROOT" ]; then
    bad "真机共享库不在（$PUBROOT）⇒ 判据一/六 **不可算**"
  elif [ ! -w "$PUBROOT" ]; then
    bad "共享库不可写（$PUBROOT）⇒ 判据一/六 **不可算**（要 deploy 身份）"
  else
    ID="probe-scope-$$"
    T="$(mktemp -d)"
    trap 'rm -rf "$T"' EXIT
    # 探针本体写在临时目录里（**仓库里只多这一个 .sh**）；变量从环境进。
    cat > "$T/live-probe.mjs" <<'NODE'
// 一次性探针：真代码 ＋ 真盘（scope 在临时目录；**上架那一下落进真共享库**）。
// 输出协议：`OK `/`BAD `/`SKIP `/`INFO ` 开头，交给外面那个 bash 数数。
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeCrypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const CORE = process.env.HUPO_CORE;
const REAL_DATA = process.env.HUPO_REAL_DATA;
const T = process.env.HUPO_PROBE_TMP;
const ID = process.env.HUPO_PROBE_ID;
const SUB = 'probe-scope-boundary';

// 🔴 哨兵是**假的**，不是任何一把真钥匙：它只是"令牌形态串"，用来证明它没被带出去。
const DATA_SENTINEL = 'PROBE-DATA-SENTINEL-do-not-ship-7f3a';
const EXP_SENTINEL = 'PROBE-EXP-SENTINEL-do-not-ship-9c21';
const TOKEN_SENTINEL = 'sk-probeonlyfake0000000000000000';
const SENTINEL_RE = /PROBE-(?:DATA|EXP)-SENTINEL-do-not-ship-[0-9a-f]{4}|sk-probeonlyfake[0-9a-z]{8,}/;

let ctxFail = 0;
const ok = (m) => console.log(`OK  ${m}`);
const bad = (m) => { ctxFail += 1; console.log(`BAD ${m}`); };
const skip = (m) => console.log(`SKIP ${m}`);
const info = (m) => console.log(`INFO ${m}`);

const sha = (b) => nodeCrypto.createHash('sha256').update(b).digest('hex');
const listFiles = (dir, rel = '') => {
  const out = [];
  let es = [];
  try { es = nodeFs.readdirSync(nodePath.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    const next = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, next));
    else if (e.isFile()) out.push(next);
  }
  return out;
};

/** 递归搜哨兵（**文本才搜**；二进制跳过）。 */
function hitsIn(dir, re) {
  const out = [];
  const walk = (d) => {
    let es = [];
    try { es = nodeFs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = nodePath.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;
      let b;
      try { b = nodeFs.readFileSync(p); } catch { continue; }
      if (b.includes(0)) continue;
      if (re.test(b.toString('utf8'))) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// 与 `test/outbound-defaults.test.js` 的 S3-5 同一套判法（去注释、认路径段与常量名）。
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}
function forbiddenHits(src) {
  const code = stripComments(src);
  const hits = [];
  const seg = /(^|[^A-Za-z0-9_$?.])\.(exp|data)(?![A-Za-z0-9_$])/g;
  let m;
  while ((m = seg.exec(code)) !== null) hits.push(`路径段「.${m[2]}」`);
  const id = /\b(EXP_DIRNAME|DATA_DIRNAME|readPacks|readExpPacks)\b/g;
  while ((m = id.exec(code)) !== null) hits.push(`名字「${m[1]}」`);
  return hits;
}

// 🔴 判据未 README：读不出就如实报 `不可算`（这里用 BAD 记失败）。
process.on('uncaughtException', (e) => { bad(`🔴 探针崩了：${e?.stack ?? e}`); process.exitCode = 1; });

const mod = (rel) => import(pathToFileURL(nodePath.join(CORE, 'src', rel)).href);
const { Apps } = await mod('apps.js');
const { AppWorkspaces, snapshotWorkspace, workspaceRootHash, mirrorArtifactIntoWorkspace } = await mod('workspace.js');
const { Published } = await mod('published.js');
const { handleAppsOp } = await mod('apps-socket.js');

if (!ID.startsWith('probe-')) throw new Error(`探针 id 必须 probe- 开头（拿到 ${ID}）`);
const PUBROOT = nodePath.join(REAL_DATA, 'published-apps');
const PUBDIR = nodePath.join(PUBROOT, ID);
const AUDIT = nodePath.join(PUBROOT, 'audit.jsonl');
if (nodePath.resolve(PUBDIR) === nodePath.resolve(PUBROOT)) throw new Error('拒绝：探针目录不能就是共享库根');

const WORLD = nodePath.join(T, 'world');
const SCOPE = nodePath.join(WORLD, 'workspaces', ID);
const apps = new Apps({ dir: WORLD, sub: SUB });
const workspaces = new AppWorkspaces({ dir: WORLD });
const published = new Published({ dir: REAL_DATA });

const beforeAudit = nodeFs.existsSync(AUDIT) ? nodeFs.readFileSync(AUDIT) : null;

// ── 负向对照：哨兵搜索器自己先验一遍（喂坏样本抓得住、喂干净放行）──
try {
  const badDir = nodePath.join(T, 'search-bad');
  const cleanDir = nodePath.join(T, 'search-clean');
  nodeFs.mkdirSync(badDir, { recursive: true });
  nodeFs.mkdirSync(cleanDir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(badDir, 'leak.txt'), DATA_SENTINEL);
  nodeFs.writeFileSync(nodePath.join(cleanDir, 'ok.txt'), 'nothing to see here');
  const caught = hitsIn(badDir, SENTINEL_RE).length;
  const cleanHits = hitsIn(cleanDir, SENTINEL_RE).length;
  if (caught === 1 && cleanHits === 0) ok('判据六·补 负向对照：哨兵搜索器喂坏样本 ⇒ 抓得住；喂干净样本 ⇒ 放行');
  else bad(`🔴 哨兵搜索器自己不对（坏样本命中 ${caught}、干净样本命中 ${cleanHits}）⇒ 判据六不可信`);
} catch (e) {
  bad(`🔴 哨兵搜索器负向对照跑不起来：${e?.message ?? e}`);
}

/** 收尾：删探针目录 ＋ 把审计账逐字节复原（只认"原样 ＋ 我们那几行"）。 */
function cleanupReal() {
  try { nodeFs.rmSync(PUBDIR, { recursive: true, force: true }); } catch (e) { bad(`🔴 探针目录删不掉：${e?.message ?? e}`); }
  try {
    if (beforeAudit === null) return;
    const cur = nodeFs.readFileSync(AUDIT);
    if (!cur.slice(0, beforeAudit.length).equals(beforeAudit)) {
      info('审计账在我们之前被别人动过 ⇒ 不截（只删探针目录）');
      return;
    }
    const appended = cur.slice(beforeAudit.length).toString('utf8').split('\n').filter(Boolean);
    // 探针自己会写两行：`publish`（判据六）与 `install`（判据五）。
    const ours = appended.filter((l) => {
      try { const j = JSON.parse(l); return j.id === ID && (j.what === 'publish' || j.what === 'install'); } catch { return false; }
    });
    if (appended.length === ours.length) nodeFs.writeFileSync(AUDIT, beforeAudit);
    else info('审计账里混进了别的进程写的行 ⇒ 不截（只删探针目录）');
  } catch (e) {
    info(`审计账没法复原（如实说）：${e?.message ?? e}`);
  }
}

try {
  // ── 建探针 scope（真代码 ＋ 真盘）────────────────────────────
  workspaces.ensure(ID, { title: '边界探针（一次性的）', entry: 'index.html' });
  workspaces.write(ID, {
    'index.html': '<!doctype html><meta charset="utf-8"><title>probe</title><h1>scope boundary probe</h1>',
    'outbound.json': JSON.stringify({
      schema: 1,
      outbound: [{ kind: 'none', purpose: '一次性边界探针，不联外网' }],
      declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '探针只读一个页面' },
    }, null, 2),
    '.data/a.json': JSON.stringify({ sentinel: DATA_SENTINEL, probe_token: TOKEN_SENTINEL }),
    '.exp/probe-declared/pack.json': JSON.stringify({ schema: 1, outbound: 'never', items: [] }),
    '.exp/probe-declared/notes.md': EXP_SENTINEL,
  });
  if (nodeFs.existsSync(nodePath.join(SCOPE, '.data', 'a.json'))) {
    ok('判据一·前提：`.data/a.json` 真的在 scope 里（不是"没东西可漏"的空转）');
  } else {
    bad('🔴 前提就不成立：`.data/a.json` 没写进 scope');
  }

  const snap = snapshotWorkspace({
    apps, workspaces, id: ID, title: '边界探针（一次性的）', icon: 'star', permissions: [], createdBy: 'user',
  });
  const v = snap.manifest.version;
  const man = apps.manifest(ID, v);
  const paths = (man?.files ?? []).map((f) => f.path);
  const dot = paths.filter((p) => p.split('/').some((s) => s.startsWith('.')));
  if (dot.length === 0) {
    ok(`判据一：真实 scope 里放着 \`.data/a.json\`，快照出来 \`manifest.files[]\` **一个隐藏路径都没有**（${paths.length} 个文件：${paths.join('、')}）`);
  } else {
    bad(`🔴 判据一：\`manifest.files[]\` 里出现了隐藏路径：${dot.join('、')}`);
  }
  if (paths.includes('index.html') && paths.includes('outbound.json')) {
    ok('判据一·正对照：能力体那两个文件**在**（不是"清单是空的"）');
  } else {
    bad(`🔴 判据一·正对照不成立：清单里没有能力体那两个文件（${paths.join('、')}）`);
  }
  let served = false;
  try { apps.read(ID, v, '.data/a.json'); served = true; } catch { /* 期望抛 */ }
  if (!served) ok('判据一·补：制品口那条路（`apps.read`）也**取不到** `.data/a.json`');
  else bad('🔴 判据一·补：制品口居然取得到 `.data/a.json`');

  // ── 真上架一次（落进**真共享库**）──────────────────────────
  const idx = published.publish(apps, { id: ID, authorSub: SUB, authorName: '边界探针' });
  ok(`判据六·前提：真机上架了一次（${ID} v${idx.version} ⇒ 真共享库）`);

  // 判据六：**全库**搜（含刚上架那一版）
  const leaks = hitsIn(PUBROOT, SENTINEL_RE);
  if (leaks.length === 0) {
    ok('判据六：上架一次之后，共享库**全库**搜数据哨兵／经验哨兵／令牌形态串 ⇒ **零命中**');
  } else {
    bad(`🔴 判据六：共享库里搜到了哨兵：${leaks.join('、')}`);
  }
  const pfiles = pubVersionFiles(PUBDIR, v);
  const phidden = pfiles.filter((p) => p.split('/').some((s) => s.startsWith('.')));
  if (phidden.length === 0) ok(`判据六·补：上架那一版里也只有能力体那两个文件（${pfiles.join('、')}）`);
  else bad(`🔴 判据六·补：上架那一版里出现了两格的字节：${phidden.join('、')}`);

  // ── 判据二：删 `.exp/` ⇒ 能力体照开（91 §7.2.1）────────────
  const entryBefore = apps.read(ID, v, 'index.html').content;
  const rootBefore = apps.manifest(ID, v).rootHash;
  const wsHashBefore = workspaceRootHash(workspaces, ID);
  nodeFs.rmSync(nodePath.join(SCOPE, '.exp'), { recursive: true, force: true });
  const entryAfter = apps.read(ID, v, 'index.html').content;
  const rootAfter = apps.manifest(ID, v).rootHash;
  if (entryAfter.equals(entryBefore) && rootAfter === rootBefore) {
    ok('判据二：删掉 `.exp/` ⇒ 能力体的入口字节与 `rootHash` **逐字节不变**（照开）');
  } else {
    bad('🔴 判据二：删掉 `.exp/` 之后能力体变了 ⇒ 经验偷偷变成了运行期依赖');
  }
  if (wsHashBefore === workspaceRootHash(workspaces, ID)) {
    ok('判据二·补：`.exp/` 本来就不在能力体指纹里（每轮输入那一侧看不到它）');
  } else {
    bad('🔴 判据二·补：删 `.exp/` 动了能力体指纹 ⇒ 分家不成立');
  }
  let threw = false;
  try { apps.read(ID, v, 'nope-probe-does-not-exist.html'); } catch { threw = true; }
  if (threw) ok('判据二·负向对照：制品口读一个不存在的文件会抛（上面那条不是"读什么都成功"）');
  else bad('🔴 判据二·负向对照：制品口读不存在的文件居然成功了 ⇒ 那条判据是空的');

  // ── 判据三：模型写的**无声明** `.exp/` 包 ⇒ 不自动生效 ──────
  const undecl = nodePath.join(SCOPE, '.exp', 'probe-undeclared');
  nodeFs.mkdirSync(undecl, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(undecl, 'notes.md'), `${EXP_SENTINEL}-undeclared`);
  const hashNoPack = workspaceRootHash(workspaces, ID);
  let rejected = null;
  try { published.publish(apps, { id: ID, authorSub: SUB, authorName: '边界探针' }); } catch (e) { rejected = e; }
  if (rejected) {
    ok(`判据三：无声明 \`.exp/\` 包 ⇒ **上架被拒**（fail-closed）：${String(rejected.message).slice(0, 58)}…`);
  } else {
    bad('🔴 判据三：无声明 `.exp/` 包居然上架成功了（fail-closed 没生效）');
  }
  const leaked = hitsIn(PUBROOT, SENTINEL_RE).length;
  if (leaked === 0) ok('判据三·补：被拒之后共享库**一个字节都没多**（零残留）');
  else bad(`🔴 判据三·补：被拒之后共享库多出了东西（哨兵命中 ${leaked}）`);
  if (hashNoPack === workspaceRootHash(workspaces, ID)) {
    ok('判据三·补：写进 `.exp/` 的字节**不进能力体指纹**（它只能在应用点被读，而应用点今天不存在）');
  } else {
    bad('🔴 判据三·补：写 `.exp/` 动了能力体指纹');
  }
  // 🔴 最要紧的一半：**每轮输入那一侧不许有读路**（源码级，含它自己的反例）
  const turnFiles = ['dispatcher.js', 'session-translate.js', 'worlds.js'];
  const hitFiles = [];
  for (const f of turnFiles) {
    const src = nodeFs.readFileSync(nodePath.join(CORE, 'src', f), 'utf8');
    if (forbiddenHits(src).length > 0) hitFiles.push(f);
  }
  const selfHit = forbiddenHits("nodeFs.readFileSync(nodePath.join(scopeDir, '.exp', 'x', 'pack.json'))");
  const selfClean = forbiddenHits('if (isAuthFailure(params?.event?.data)) {');
  if (hitFiles.length === 0 && selfHit.length > 0 && selfClean.length === 0) {
    ok(`判据三：每轮输入那三份（${turnFiles.join('／')}）里**没有** \`.exp\`／\`.data\` 的读路（负向对照：喂坏样本抓得住、\`event.data\` 不误伤）`);
  } else {
    bad(`🔴 判据三：每轮输入侧有读路（${hitFiles.join('、') || '—'}）；扫描器自检 hit=${selfHit.length} clean=${selfClean.length}`);
  }
  info('判据三·如实说：**没有真重启线上服务**（那会打断正在用的用户）。"自动生效"要求存在一条读路；上面两条证明读路不存在 ⇒ 重启与不重启同结论。');
  nodeFs.rmSync(undecl, { recursive: true, force: true });

  // ── 判据四：收到别人的经验包 ⇒ 不自动生效、能回退 ───────────
  const recv = nodePath.join(SCOPE, '.exp', 'probe-received');
  nodeFs.mkdirSync(recv, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(recv, 'pack.json'), JSON.stringify({ schema: 1, outbound: 'never', items: [] }));
  nodeFs.writeFileSync(nodePath.join(recv, 'method.md'), `${EXP_SENTINEL}-received`);
  const hashRecv = workspaceRootHash(workspaces, ID);
  if (hashRecv === hashNoPack && apps.manifest(ID, v).rootHash === rootAfter) {
    ok('判据四：别人的经验包落进来 ⇒ 能力体指纹与入口**一个字节都没变**（不自动生效）');
  } else {
    bad('🔴 判据四：收进来的经验包动了能力体 ⇒ "不自动生效"不成立');
  }
  const recvLeak = hitsIn(PUBROOT, SENTINEL_RE).length;
  if (recvLeak === 0) ok('判据四·补：它也没从任何出界面漏出去（共享库零命中）');
  else bad(`🔴 判据四·补：收进来的经验包漏到了共享库（命中 ${recvLeak}）`);
  // 🔴 算不出来就如实报 —— 今天**没有**"应用一封经验包"的动作。
  info('判据四·如实说："应用"那个动作今天不存在（阶段 4 只建登记面）⇒ 没有应用点');
  bad('判据四：**"能回退（逐字节等于应用前）" 不可算** —— 没有应用点可退（`delivery.js` 自己写着不搬字节）');
  nodeFs.rmSync(recv, { recursive: true, force: true });

  // ── 判据五：装一次 ⇒ 改过的本地那份有副本、可一步退 ─────────
  const inst = published.installInto(apps, ID); // 先像用户装过一样，把他那份复制进自己这儿
  mirrorArtifactIntoWorkspace({ apps, workspaces, id: ID, version: inst.version });
  const MINE = '<!doctype html><meta charset="utf-8"><h1>我改过的本地那份</h1>';
  workspaces.write(ID, { 'index.html': MINE });
  const r = await handleAppsOp(apps, { op: 'install', id: ID }, { published, workspace: workspaces, sub: SUB });
  const sv = r?.snapshot?.version ?? null;
  if (r && r.ok === false && r.refused === 'needs-choice' && Number.isInteger(sv)) {
    ok('判据五：装到"改过的那份"上 ⇒ 默认**不动手**，并报出快照版本（先问一句）');
  } else {
    bad(`🔴 判据五：默认那次安装没按"先快照、先问"办：${JSON.stringify(r).slice(0, 150)}`);
  }
  const sm = sv ? apps.manifest(ID, sv) : null;
  if (sm && sm.rootHash === workspaceRootHash(workspaces, ID)) {
    ok(`判据五：改过的那份**有副本**（v${sv}，逐文件 sha 可核）`);
  } else {
    bad('🔴 判据五：快照那一版与工作区对不上 ⇒ "有副本"不成立');
  }
  const kep = workspaces.read(ID).files['index.html']?.toString('utf8');
  if (kep === MINE) ok('判据五：默认那次安装**一个字节都没覆盖**（他改的还在）');
  else bad('🔴 判据五：默认那次安装把他改的盖掉了');
  if (sm) {
    // 一步退：先"刷新"到上游（他改的没了），再拿快照退回来 ⇒ 逐字节等于应用前
    apps.rollback(ID, inst.version);
    mirrorArtifactIntoWorkspace({ apps, workspaces, id: ID, version: inst.version });
    const wiped = workspaces.read(ID).files['index.html']?.toString('utf8') === MINE;
    apps.rollback(ID, sv);
    mirrorArtifactIntoWorkspace({ apps, workspaces, id: ID, version: sv });
    const back = workspaces.read(ID).files['index.html']?.toString('utf8');
    if (!wiped && back === MINE) ok('判据五：**一步退** ⇒ 逐字节等于应用前那份（负向对照：刷新那一下确实把它盖掉过）');
    else bad(`🔴 判据五：回退对不上（刷新后还在=${wiped}、退回后相等=${back === MINE}）`);
  } else {
    bad('判据五：没有快照版本 ⇒ "一步退"**不可算**');
  }
} catch (e) {
  bad(`🔴 真机探针中途出错：${e?.stack ?? e}`);
} finally {
  cleanupReal();
  try { nodeFs.rmSync(WORLD, { recursive: true, force: true }); } catch { /* 临时目录由外面那个 trap 兜 */ }
  // ── 收尾这一条**也是判据**：盘上零残留 ──────────────────────
  if (!nodeFs.existsSync(PUBDIR)) ok('收尾：真共享库里那个探针目录**已删干净**');
  else bad('🔴 收尾：探针目录还在真共享库里');
  const left = hitsIn(PUBROOT, SENTINEL_RE);
  if (left.length === 0) ok('收尾：全库**再搜一遍**哨兵 ⇒ 仍然零命中');
  else bad(`🔴 收尾：全库还有哨兵残留：${left.join('、')}`);
  const idLeft = listFiles(PUBROOT).filter((p) => p.includes(ID));
  if (idLeft.length === 0) ok('收尾：共享库里**没有**任何名字带探针 id 的残留');
  else bad(`🔴 收尾：共享库里还有探针 id 的残留：${idLeft.join('、')}`);
  const auditOk = beforeAudit === null
    ? !nodeFs.existsSync(AUDIT)
    : (nodeFs.existsSync(AUDIT) && sha(nodeFs.readFileSync(AUDIT)) === sha(beforeAudit));
  if (auditOk) {
    ok('收尾：审计账（`.data/published-apps/audit.jsonl`）逐字节复原');
  } else {
    // 逐字节没复原也要看**探针那一行在不在** —— 那才是"盘上零残留"。
    let stillMine = false;
    try {
      stillMine = nodeFs.readFileSync(AUDIT, 'utf8').split('\n').some((l) => {
        try { return JSON.parse(l).id === ID; } catch { return false; }
      });
    } catch { /* 读不到就当没有 */ }
    if (!stillMine) ok('收尾：审计账里**没有**探针那一行（没能逐字节复原，但残留已清）');
    else bad('🔴 收尾：审计账里还留着探针那一行（零残留不成立）');
  }
}

function pubVersionFiles(pubdir, version) {
  return listFiles(nodePath.join(pubdir, 'versions', String(version)));
}
process.exitCode = ctxFail > 0 ? 1 : 0;
NODE
    OUT="$(HUPO_CORE="$CORE" HUPO_REAL_DATA="$REAL_DATA" HUPO_PROBE_TMP="$T" HUPO_PROBE_ID="$ID" "$NODE" "$T/live-probe.mjs" 2>&1)"
    rc=$?
    sed 's/^/  /' <<<"$OUT"
    np="$(grep -c '^OK ' <<<"$OUT" || true)"
    nf="$(grep -c '^BAD ' <<<"$OUT" || true)"
    ns="$(grep -c '^SKIP ' <<<"$OUT" || true)"
    pass=$((pass + np)); fail=$((fail + nf)); skipped=$((skipped + ns))
    if [ "$rc" != "0" ] && [ "$nf" = "0" ]; then
      bad "真机探针异常退出（rc=$rc）但没报哪一条 ⇒ 判据**不可算**"
    fi
  fi
fi

echo
echo "──────────────────────────────"
if [ "$fail" = "0" ]; then
  echo "✅ 通过 $pass · 失败 $fail"
  [ "$skipped" != "0" ] && echo "⚠️ **有跳过的**（上面写了）—— 跳过的**不是**过的。"
  exit 0
fi
echo "✗ 通过 $pass · 失败 $fail"
[ "$skipped" != "0" ] && echo "⚠️ **有跳过的**（上面写了）—— 跳过的**不是**过的。"
exit 1
