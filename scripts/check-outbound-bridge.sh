#!/usr/bin/env bash
# **92 §③ 阶段 2「出界收成一条独木桥 ＋ 声明带锚」的闸**（离线那一列）
# （契约 `docs/dev/92-TRIPLE-PLAN.md` §② 第三条硬规矩 · §③ 阶段 2 · §④ 离线那一列；
#   事实记录见 `docs/dev/157-OUTBOUND-BRIDGE-GATE.md`）。
#
# 用法：
#   bash scripts/check-outbound-bridge.sh
#
# 退出码 = 失败数（0 ⇒ 通过）；末尾固定打印 **`通过 N · 失败 M`**。
#
# ── 为什么不扩 `check-scope-boundary.sh`（阶段 1 那条）──────────
#   那一条管的是 92 §④ 的**「真机」那一列**（真上架、真共享库、跑完核零残留）；
#   这一条管的是**「离线」那一列里属于阶段 2 的那几行**（临时目录里造声明、真调
#   `published.publish`）—— **不碰线上、不碰真共享库**，谁都能随时跑。
#   两列判据、两种风险（一个会动真盘、一个不会），混成一条脚本会让"该不该
#   小心跑"这件事变模糊 ⇒ **新开一条**，并在这里写明为什么不扩。
#
# ── 判据 A–E（照 §③ 那一行 ＋ §④ 抄；每条都带**负向对照**）──────
#   A 🔴 `.exp/` 里一份**受版权记录** ＋ `share:true` ＋ **没有锚** ⇒ 上架**必须红**
#   B ★  给它补上来源 `rootHash`（锚）⇒ **过**（正对照，证明闸不是空转）
#   C 🔴 把锚**删掉** ⇒ **又拒**（不是"一次通过就永远通过"）
#   D 🔴 **冒出第二个绕过这条检查的出口 ⇒ 红**（源码级扫描；既有测试 ＋ 新加强版）
#   E ★  `share:false` ／ `outbound=one-to-one` ／ **未声明（默认最严）** ⇒ 逐条有据
#
# 🔴 纪律（92 §④ 末两条）：
#   · 读不出 / 算不出 ⇒ 如实打印 **`不可算`** 并记**失败**，**绝不安静地绿**；
#   · **每一条都要有负向对照**，而且脚本要**核那条对照真的在**（下面逐个核）。
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

# ══════════════════════════════════════════════════════════════════
echo '── A–E：临时目录里真调 `published.publish`（**不碰线上、不碰真共享库**）'
# ══════════════════════════════════════════════════════════════════

cat > "$T/bridge-probe.mjs" <<'NODE'
// 一次性探针：真代码（`src/` 里那几个模块）＋ 临时目录里的真盘。
// 输出协议：`OK `/`BAD ` 开头，交给外面那个 bash 数数并打印。
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { pathToFileURL } from 'node:url';

const CORE = process.env.HUPO_CORE;
const T = process.env.HUPO_PROBE_TMP;

const ok = (id, name, reading) => console.log(`OK  ${id} :: ${name} ;; ${reading}`);
const bad = (id, name, reading) => console.log(`BAD ${id} :: ${name} ;; ${reading}`);

const mod = (rel) => import(pathToFileURL(nodePath.join(CORE, 'src', rel)).href);
const { Apps } = await mod('apps.js');
const { AppWorkspaces } = await mod('workspace.js');
const { Published } = await mod('published.js');
const { OutboundError, assertOutboundAllowed } = await mod('outbound.js');

const APP = { title: '新闻', icon: 'dice', entry: 'index.html' };
// ★ A16：制品里必须有外联申报（读不到 ⇒ 上架拒）—— 这一组验的是**出界闸**，带上它。
const DECL = JSON.stringify({
  schema: 1,
  outbound: [],
  declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '还没人用过，先按 0 报' },
});

let seq = 0;
function world(tag) {
  const dir = nodeFs.mkdtempSync(nodePath.join(T, `w-${tag}-${seq++}-`));
  const apps = new Apps({ dir, sub: 'u1' });
  const workspaces = new AppWorkspaces({ dir, log: () => {} });
  const published = new Published({ dir });
  return { dir, apps, workspaces, published, shared: (id) => nodePath.join(dir, 'published-apps', id) };
}

function makeApp(w, id = 'news', body = '<p>第一版</p>') {
  w.apps.create({ id, ...APP, files: { 'index.html': body, 'outbound.json': DECL } });
  return w.apps.manifest(id, w.apps.current(id));
}

/** 往 `.exp/<pack>/` 写一份声明（`json` 给字符串就原样写 —— 造坏声明）。 */
function writePack(w, id, pack, json, extra = {}) {
  const dir = nodePath.join(w.workspaces.dirFor(id), '.exp', pack);
  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(dir, 'pack.json'),
    typeof json === 'string' ? json : `${JSON.stringify(json, null, 2)}\n`,
  );
  for (const [name, body] of Object.entries(extra)) nodeFs.writeFileSync(nodePath.join(dir, name), body);
}

const caught = (fn) => { try { fn(); return null; } catch (err) { return err; } };
const publish = (w, id = 'news') => w.published.publish(w.apps, { id, authorSub: 'u1', authorName: '甲' });
const noAnchor = () => ({
  schema: 1, expVersion: 1, title: '攒下来的门道',
  items: [{ path: 'notes.md', kind: 'copyright', share: true }],
});
const withAnchor = (rootHash) => ({
  schema: 1, expVersion: 1, title: '攒下来的门道',
  items: [{ path: 'notes.md', kind: 'copyright', share: true, anchor: { rootHash } }],
});

// ── A 🔴 无锚的 share:true ⇒ 上架必须红 ──────────────────────────
try {
  const w = world('A');
  const man = makeApp(w);
  writePack(w, 'news', 'notes', noAnchor(), { 'notes.md': '受版权保护的一段记录（探针，不是真数据）\n' });
  const err = caught(() => publish(w));
  const residue = nodeFs.existsSync(w.shared('news'));
  if (!err) {
    bad('A', '`.exp/` 里 share:true 而**没有锚** ⇒ 上架必须红', '上架**过了**（闸空转）');
  } else if (!(err instanceof OutboundError)) {
    bad('A', '无锚的 share:true ⇒ 上架必须红', `拒是拒了，但不是 OutboundError（${err?.name}）：${err?.message}`);
  } else if (residue) {
    bad('A', '无锚的 share:true ⇒ 上架必须红', '拒了，但共享库**有残留**');
  } else {
    ok('A', '🔴 `.exp/` 里 share:true 而**没有锚** ⇒ 上架必须红',
      `${err.name}：${err.message}；盘上零残留（rootHash=${man.rootHash.slice(0, 12)}…）`);
  }
} catch (e) {
  bad('A', '无锚的 share:true ⇒ 上架必须红', `**不可算**（探针自己炸了：${e?.message ?? e}）`);
}

// ── B ★ 补上锚 ⇒ 过（正对照）────────────────────────────────────
try {
  const w = world('B');
  const man = makeApp(w);
  writePack(w, 'news', 'notes', withAnchor(man.rootHash), { 'notes.md': '受版权保护的一段记录\n' });
  const idx = publish(w);
  const copied = nodeFs.existsSync(nodePath.join(w.shared('news'), 'versions', '1', 'index.html'));
  if (idx?.rootHash === man.rootHash && copied) {
    ok('B', '★ 补上来源 rootHash（锚）⇒ **过**', `rootHash=${man.rootHash.slice(0, 12)}… 逐字带出去；共享库真有一份`);
  } else {
    bad('B', '补上锚 ⇒ 过', `没有真的上架成功（rootHash 对得上=${idx?.rootHash === man.rootHash}；真有文件=${copied}）`);
  }
} catch (e) {
  bad('B', '补上锚 ⇒ 过', `**不可算**（${e?.message ?? e}）`);
}

// ── C 🔴 删掉锚 ⇒ 又拒（同一条声明）─────────────────────────────
try {
  const w = world('C');
  const man = makeApp(w);
  writePack(w, 'news', 'notes', withAnchor(man.rootHash), { 'notes.md': '受版权保护的一段记录\n' });
  publish(w); // ① 加锚 ⇒ 过（同一条声明）
  writePack(w, 'news', 'notes', noAnchor(), { 'notes.md': '受版权保护的一段记录\n' }); // ② 只把锚删掉
  const err = caught(() => publish(w));
  if (err) {
    ok('C', '🔴 同一条声明：加锚过、**删锚 ⇒ 又拒**（不是"一次通过就永远通过"）',
      `${err.name}：${err.message}`);
  } else {
    bad('C', '删掉锚 ⇒ 又拒', '删了锚之后**还是过了** ⇒ 否决权只生效一次');
  }
} catch (e) {
  bad('C', '删掉锚 ⇒ 又拒', `**不可算**（${e?.message ?? e}）`);
}

// ── E1 ★ share:false ⇒ 过（该走）；对照：同形状 share:true 无锚 ⇒ 拒 ──
try {
  const w = world('E1');
  makeApp(w);
  writePack(w, 'news', 'notes', { schema: 1, expVersion: 1, items: [{ path: 'a.md', kind: 'note', share: false }] }, { 'a.md': '私密\n' });
  let passed = false;
  try { publish(w); passed = true; } catch { /* 记 false */ }
  const leaked = nodeFs.existsSync(nodePath.join(w.shared('news'), 'versions', '1', 'a.md'));

  const w2 = world('E1c');
  makeApp(w2);
  writePack(w2, 'news', 'notes', { schema: 1, expVersion: 1, items: [{ path: 'a.md', kind: 'note', share: true }] }, { 'a.md': '私密\n' });
  const ctrl = caught(() => publish(w2));

  if (passed && !leaked && ctrl) {
    ok('E1', '★ `share:false` ⇒ **该走的走**（过，且那份字节不进共享库）',
      `上架过了；versions/1 里没有 a.md；**负向对照**（同形状改成 share:true 无锚）⇒ ${ctrl.name}: ${ctrl.message}`);
  } else {
    bad('E1', '`share:false` ⇒ 过；对照：share:true 无锚 ⇒ 拒',
      `过=${passed}；泄漏=${leaked}；对照拒=${Boolean(ctrl)}`);
  }
} catch (e) {
  bad('E1', '`share:false` ⇒ 过；对照 ⇒ 拒', `**不可算**（${e?.message ?? e}）`);
}

// ── E2 ★ outbound=one-to-one ⇒ 永不出（条目不算可分享）；对照：share 无锚 ⇒ 拒 ──
try {
  const w = world('E2');
  makeApp(w);
  writePack(w, 'news', 'notes', {
    schema: 1, outbound: 'one-to-one',
    items: [{ path: 'a.md', kind: 'data', share: true }], // 逐条写着 share:true 也不算数
  }, { 'a.md': '一对一的那些\n' });
  const adj = assertOutboundAllowed({ route: 'publish', apps: w.apps, workspaces: w.workspaces, id: 'news' });
  let passed = false;
  try { publish(w); passed = true; } catch { /* 记 false */ }

  const w2 = world('E2c');
  makeApp(w2);
  writePack(w2, 'news', 'notes', { schema: 1, outbound: 'share', items: [{ path: 'a.md', kind: 'data', share: true }] }, { 'a.md': '一对一的那些\n' });
  const ctrl = caught(() => publish(w2));

  if (passed && adj.share.length === 0 && ctrl) {
    ok('E2', '★ `outbound=one-to-one` ⇒ **永不出**（包级说了算，逐条 share:true 也不出）',
      `带出去的条目 ${adj.share.length} 条；**负向对照**（包级改成 share）⇒ ${ctrl.name}: ${ctrl.message}`);
  } else {
    bad('E2', '`outbound=one-to-one` ⇒ 永不出',
      `过=${passed}；share 条目=${adj.share.length}；对照拒=${Boolean(ctrl)}`);
  }
} catch (e) {
  bad('E2', '`outbound=one-to-one` ⇒ 永不出', `**不可算**（${e?.message ?? e}）`);
}

// ── E3 🔴 未声明（默认最严）⇒ 拒；对照：补一份合法声明 ⇒ 过 ─────────
try {
  const w = world('E3');
  makeApp(w);
  const pack = nodePath.join(w.workspaces.dirFor('news'), '.exp', 'notes');
  nodeFs.mkdirSync(pack, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(pack, 'note.md'), '没声明的那些\n'); // 目录在、pack.json 不在
  const err = caught(() => publish(w));

  nodeFs.writeFileSync(nodePath.join(pack, 'pack.json'), `${JSON.stringify({ schema: 1, outbound: 'never', items: [] })}\n`);
  let ctrlPassed = false;
  try { publish(w); ctrlPassed = true; } catch { /* 记 false */ }

  if (err && ctrlPassed) {
    ok('E3', '🔴 **未声明（读不到 pack.json）⇒ 拒**（默认最严，不是"当没有"）',
      `${err.name}：${err.message}；**负向对照**（补一份合法声明）⇒ 过`);
  } else {
    bad('E3', '未声明 ⇒ 拒', `拒=${Boolean(err)}；补声明后过=${ctrlPassed}`);
  }
} catch (e) {
  bad('E3', '未声明 ⇒ 拒', `**不可算**（${e?.message ?? e}）`);
}

process.exitCode = 0;
NODE

OUT="$(HUPO_CORE="$CORE" HUPO_PROBE_TMP="$T" "$NODE" "$T/bridge-probe.mjs" 2>&1)"
rc=$?
sed 's/^/  /' <<<"$OUT"
np="$(grep -c '^OK ' <<<"$OUT" || true)"
nf="$(grep -c '^BAD ' <<<"$OUT" || true)"
pass=$((pass + np)); fail=$((fail + nf))
if [ "$rc" != "0" ] && [ "$nf" = "0" ]; then
  bad "A–E 探针异常退出（rc=$rc）却没报哪一条 ⇒ 这些判据**不可算**"
fi
if [ "$nf" = "0" ] && [ "$np" -lt 6 ]; then
  bad "A–E 应该出 6 条读数（A/B/C/E1/E2/E3），只读到 $np 条 ⇒ **不可算**"
fi

# ══════════════════════════════════════════════════════════════════
echo
echo "── D：源码级只许**一处**出界检查（扫描 ＋ 它自己的负向对照）"
# ══════════════════════════════════════════════════════════════════

# D-① 既有那条：字面量扫描（`published-apps` / `PUBLISHED_DIR`）
run_test() {
  local f="$1" name="$2" marker="$3" out p fl
  local file="$CORE/test/$f.test.js"
  if [ ! -f "$file" ]; then bad "$name：找不到 test/$f.test.js ⇒ **不可算**"; return; fi
  # 🔴 先核"那条负向对照真的在"（92 §④：判据自己也要有负向对照）
  if ! grep -qF "$marker" "$file"; then
    bad "$name：那份测试里找不到负向对照「$marker」⇒ 可能没在反着验"
    return
  fi
  out="$(cd "$CORE" && "$NODE" --test "test/$f.test.js" 2>&1)"
  p="$(sed -n 's/^ℹ pass //p' <<<"$out" | tail -1)"
  fl="$(sed -n 's/^ℹ fail //p' <<<"$out" | tail -1)"
  if [ -z "$p" ] || [ -z "$fl" ]; then
    bad "$name：读数读不出来（**不可算**）—— 测试跑挂了吗"
    return
  fi
  if [ "$fl" = "0" ] && [ "$p" -gt 0 ]; then
    ok "$name ⇒ 过 $p 条／败 0（含负向对照「$marker」）"
  else
    bad "$name：败了 $fl 条（过 $p 条）"
  fi
}

# D-① 阶段 2 原来那一份（字面量那一类）
run_test outbound-gate "D-① 既有：写共享库的只许一处，且必须过闸" "第二出口"
# D-② 加强版（绕开字面量：`published.root` / `published.appDir()` 那一类）
run_test outbound-single-exit "D-② 加强：绕开目录名字面量的第二出口也要红" "PLANTED_SECOND_EXIT"

# D-③ 真实读数：扫描真 `src/` 树，把"能写共享库的文件"逐条打出来
SCAN="$(cd "$CORE" && "$NODE" --input-type=module -e "
import nodeFs from 'node:fs';
import nodePath from 'node:path';
const SRC = nodePath.resolve('src');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
const LIT = /published-apps|PUBLISHED_DIR/;
const ACC = /\b[A-Za-z0-9_\$]*published[A-Za-z0-9_\$]*\s*\.\s*(?:root|appDir|dir)\b/iu;
const W = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|mkdirSync|mkdir|renameSync|rename|copyFileSync|copyFile|createWriteStream|rmSync|rm|unlinkSync|unlink|truncateSync|truncate|chmodSync|chmod|openSync|open)\b/u;
const out = [];
const walk = (d) => { for (const e of nodeFs.readdirSync(d, { withFileTypes: true })) {
  const p = nodePath.join(d, e.name);
  if (e.isDirectory()) walk(p);
  else if (/\.(js|mjs)\$/.test(e.name)) { const c = strip(nodeFs.readFileSync(p, 'utf8'));
    if (LIT.test(c) || (ACC.test(c) && W.test(c))) out.push(nodePath.relative(SRC, p)); }
} };
walk(SRC);
console.log(out.sort().join(',') || '(空)');
" 2>&1 || true)"
if [ "$SCAN" = "published.js" ]; then
  ok "D-③ 真树读数：能写共享库的文件 = [$SCAN] —— **只有一处**"
else
  bad "D-③ 真树读数：能写共享库的文件 = [$SCAN] ⇒ 不是「只有 published.js 一处」"
fi

echo
echo "──────────────────────────────"
if [ "$fail" = "0" ]; then
  echo "✅ 通过 $pass · 失败 $fail"
  exit 0
fi
echo "✗ 通过 $pass · 失败 $fail"
exit 1
