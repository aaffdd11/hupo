#!/usr/bin/env bash
# **读侧那道闸的闸**（`D4.24` · 2026-10-03 主人点头「加」；事实记录
#   `docs/dev/164-READ-SIDE-HIDDEN-GATE.md`，来由是 `docs/dev/158` §五·1 那一笔）。
#
# 用法：
#   bash scripts/check-read-side-assert.sh
#
# 退出码 = 失败数（0 ⇒ 通过）；末尾固定打印 **`通过 N · 失败 M`**。
#
# ── 判据（四条，逐条能反着验；每条都带**负向对照**）────────────
#   R1 🔴 **含隐藏路径的包 ⇒ 读被拒**：真 HTTP（真 `createAppServer` ＋ 真签名 URL）
#         回 **403 ＋ 点名理由（谁拒的 / 拒的哪条 / 为什么 / 怎么办）**
#         ＋ 一条**可查的审计**；**负向对照**：干净包照旧 **200**（不是"一律拒"）。
#   R2 🔴 **读侧只有一处**：源码级扫描 —— 唯一"版本目录 + rel"的取字节路是
#         `Apps.read()`，那道闸就在它里面、跑在 `readFileSync` 之前；
#         **变异**：把 `read()` 里那处调用拔掉（临时副本）⇒ 隐藏路径**照旧读得出**
#         （证明那道调用**真的承重**，不是摆设）。
#   R3 🔴 **与写侧同规则**：同一条路径，写侧 `create()` 拒的话 === 读侧 `read()` 拒的话
#         （两处调的是**同一个** `refuseHiddenRelPath`）；
#         **负向对照**：把路径改合法（`.data/` → `data/`）⇒ 放行。
#   R4 🔴 **零残留 ＋ 真机盘查**：本机可读的制品库跑前跑后**逐文件 sha256 一致**
#         （这一条闸对真机**只读**）；并报出"有多少个在架制品会因此受影响"的
#         **清单（名称 ＋ 路径）**；**负向对照**：指纹函数改一个字节 ⇒ 必须变
#         （证明它不是恒真的空转）。
#
# ── 为什么不把那几条已有的闸扩一扩 ──────────────────────────
#   `check-outbound-bridge.sh`（**写侧**/出界独木桥）/ `check-scope-boundary.sh`（真机边界）/
#   `check-edge-kinds.sh`（三条登记边）/ `check-app-entry-identity.sh`（入口 URL 与审计身份）/
#   `check-index-author-hash.sh`（共享库作者假名）各自管一件事，与"**读侧**这条取字节的路
#   过不过同一道隐藏路径闸"没有重叠；混进去会让"这一条红了该找谁"变模糊。
#   ⇒ **新开一条**，那五条**一个字节没动**。
#
# 🔴 纪律：读不出 / 算不出 ⇒ 打印 **`不可算`** 并记失败，绝不安静地绿；
#   每一条都有负向对照，脚本自己核那条对照真的在。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/v2/services/core"
# 真机数据目录（`serve.js` 用的是 `HUPO_DATA`；`restart-core.sh` 把它设成 `<core>/data`）。
LIVE_DATA="${HUPO_DATA:-$CORE/data}"

# ⚠️ `sudo` 底下 PATH 里没有 node（这台机器只有 nvm 里那一个）⇒ 兜一圈找它。
NODE="${NODE_BIN:-}"
if [ -z "$NODE" ]; then
  for c in /home/deploy/.nvm/versions/node/*/bin/node "$(command -v node 2>/dev/null || true)"; do
    [ -x "$c" ] && { NODE="$c"; break; }
  done
fi
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "✗ 找不到 node（这台机器只有 nvm 里那一个）"; exit 2; }

pass=0; fail=0
ok()  { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

echo '── R1 / R3：临时目录里用**真代码**（不碰线上、不碰真数据目录）'
echo

cat > "$T/r13.mjs" <<'NODE'
// 一次性探针：真 `src/` 模块 ＋ 临时目录里的真盘 ＋ 真 HTTP。
// 输出协议：`OK <id> :: <名字> ;; <读数>` / `BAD ...`，交给外面那个 bash 数数。
import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { pathToFileURL } from 'node:url';

const CORE = process.env.HUPO_CORE;
const T = process.env.HUPO_PROBE_TMP;

const ok = (id, name, reading) => console.log(`OK  ${id} :: ${name} ;; ${reading}`);
const bad = (id, name, reading) => console.log(`BAD ${id} :: ${name} ;; ${reading}`);

const mod = (rel) => import(pathToFileURL(nodePath.join(CORE, 'src', rel)).href);
const { Apps, HIDDEN_PATH_CODE, isHiddenPathRefusal, rootHashOf, sha256hex } = await mod('apps.js');
const { createAppServer, entryUrl } = await mod('app-serve.js');

const NOW = 1_800_000_000_000;
const KEY = Buffer.from('d'.repeat(64), 'hex');
const HIDDEN = '.data/a.json';
const HIDDEN_BODY = '{"sentinel":"PROBE-READ-SIDE-DATA"}';
const OKF = Object.freeze({ id: 'dice', title: '掷骰子', icon: 'dice', entry: 'index.html', files: { 'index.html': '<!doctype html><p>掷</p>' } });

const tmp = (tag) => nodeFs.mkdtempSync(nodePath.join(T, `${tag}-`));

/** 造一个"老包里带隐藏路径"的制品（写侧闸之前写进去的那种）。 */
function plantHidden(dir, id = 'dice') {
  const apps = new Apps({ dir, sub: 'u1' });
  apps.create({ ...OKF, id });
  const vdir = apps.versionDir(id, 1);
  nodeFs.mkdirSync(nodePath.join(vdir, '.data'), { recursive: true });
  nodeFs.writeFileSync(nodePath.join(vdir, HIDDEN), HIDDEN_BODY);
  const mpath = nodePath.join(vdir, 'manifest.json');
  nodeFs.chmodSync(mpath, 0o644);
  const man = JSON.parse(nodeFs.readFileSync(mpath, 'utf8'));
  man.files.push({ path: HIDDEN, sha256: sha256hex(Buffer.from(HIDDEN_BODY)), bytes: Buffer.from(HIDDEN_BODY).length });
  man.rootHash = rootHashOf(man.files.map((f) => ({ path: f.path, sha256: f.sha256 })));
  nodeFs.writeFileSync(mpath, `${JSON.stringify(man, null, 2)}\n`);
  return { apps, manifest: man };
}

function digest(root) {
  const out = new Map();
  const walk = (rel) => {
    let es = [];
    try { es = nodeFs.readdirSync(nodePath.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of es.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.set(`${next}/`, 'dir'); walk(next); continue; }
      out.set(next, nodeCrypto.createHash('sha256').update(nodeFs.readFileSync(nodePath.join(root, next))).digest('hex'));
    }
  };
  walk('');
  return out;
}

async function bootOrigin(resolveApps) {
  const origin = createAppServer({ resolveApps, key: KEY, frameAncestors: "'self'", subsOf: () => ['u1'], now: () => NOW, log: () => {} });
  await new Promise((res, rej) => { origin.once('error', rej); origin.listen(0, '127.0.0.1', res); });
  return { base: `http://127.0.0.1:${origin.address().port}`, close: () => new Promise((r) => origin.close(() => r())) };
}

process.on('uncaughtException', (e) => { bad('probe', '探针崩了（算不出来）', String(e?.stack ?? e)); process.exitCode = 1; });

// ════════════════════════════════════════════════════════════
// R3 —— 写侧拒的话 === 读侧拒的话；负向对照：改合法 ⇒ 放行
// ════════════════════════════════════════════════════════════
{
  const dir = tmp('r3');
  const apps = new Apps({ dir, sub: 'u1' });
  let writeErr = null;
  try { apps.create({ ...OKF, id: 'w', files: { 'index.html': '<p>x</p>', [HIDDEN]: HIDDEN_BODY } }); } catch (e) { writeErr = e; }
  const { apps: reader } = plantHidden(dir, 'r');
  let readErr = null;
  try { reader.read('r', 1, HIDDEN); } catch (e) { readErr = e; }
  if (!writeErr) {
    bad('R3', '写侧必须拒 `.data/…`（前提）', '写侧居然放行了 —— 这条判据是空的');
  } else if (!readErr) {
    bad('R3', '读侧必须拒 `.data/…`', '读侧放行了');
  } else if (readErr.message !== writeErr.message || readErr.code !== writeErr.code) {
    bad('R3', '两处规则不许漂（拒的话要逐字相同）', `写=${writeErr.message}；读=${readErr.message}`);
  } else {
    ok('R3', '写侧拒的话 === 读侧拒的话（同一个 `refuseHiddenRelPath`）', `${readErr.code} · ${readErr.message.slice(0, 70)}…`);
  }
  // 负向对照：同一条路径改合法（`.data/` → `data/`）⇒ 放行
  const dir2 = tmp('r3-ok');
  const apps2 = new Apps({ dir: dir2, sub: 'u1' });
  apps2.create({ ...OKF, id: 'legal', files: { 'index.html': '<p>ok</p>', 'data/a.json': HIDDEN_BODY } });
  const got = apps2.read('legal', 1, 'data/a.json').content.toString('utf8');
  if (got === HIDDEN_BODY) ok('R3', '负向对照：路径改合法（`data/a.json`）⇒ 放行', '读回来逐字节一致');
  else bad('R3', '负向对照：路径改合法 ⇒ 放行', '居然读不出/内容不对');
}

// ════════════════════════════════════════════════════════════
// R1 —— 真制品口：隐藏路径 ⇒ 403 ＋ 点名理由 ＋ 可查审计；负向对照：干净包 200
// ════════════════════════════════════════════════════════════
{
  const dir = tmp('r1-hidden');
  const { apps } = plantHidden(dir);
  const cleanDir = tmp('r1-clean');
  const clean = new Apps({ dir: cleanDir, sub: 'u1' });
  clean.create({ ...OKF, id: 'clean-app', files: { 'index.html': '<p>干净</p>' } });

  const origin = await bootOrigin((sub) => (sub === 'u1'
    ? { read: (id, v, rel) => (id === 'clean-app' ? clean.read(id, v, rel) : apps.read(id, v, rel)) }
    : null));
  try {
    const good = entryUrl({ base: 'https://apps.example', key: KEY, sub: 'u1', id: 'dice', version: 1, entry: 'index.html', now: NOW });
    const q = new URL(good).searchParams;
    const sig = `e=${q.get('e')}&s=${q.get('s')}`;

    const r = await fetch(`${origin.base}/a/dice/1/${HIDDEN}?${sig}`);
    const text = await r.text();
    const says = {
      who: text.includes('琥珀的制品口'),
      what: text.includes(HIDDEN),
      why: text.includes('为什么'),
      how: text.includes('怎么办'),
    };
    if (r.status !== 403) {
      bad('R1', '隐藏路径 ⇒ 403（不是假 404 / 白屏）', `实际 HTTP ${r.status}`);
    } else if (r.headers.get('x-hupo-refusal') !== 'hidden-path') {
      bad('R1', '隐藏路径 ⇒ 机器可分的拒绝头', `x-hupo-refusal=${r.headers.get('x-hupo-refusal')}`);
    } else if (!(says.who && says.what && says.why && says.how)) {
      bad('R1', '拒绝的理由要能查（谁/什么/为什么/怎么办）', JSON.stringify(says));
    } else {
      ok('R1', '隐藏路径 ⇒ 403 ＋ 点名理由（谁/什么/为什么/怎么办）', text.trim().split('\n')[0]);
    }

    // 可审计：那一行真的落进 `<world>/hupo/apps/audit.jsonl`
    let auditHit = null;
    try {
      auditHit = nodeFs.readFileSync(nodePath.join(dir, 'hupo/apps/audit.jsonl'), 'utf8')
        .trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.what === 'hidden-path-refused');
    } catch { /* 没读到就是没有 */ }
    if (auditHit && auditHit.id === 'dice' && auditHit.path === HIDDEN) {
      ok('R1', '留了一条可查的审计（谁的世界 · 哪个 app · 哪条路径）', `audit.jsonl · hidden-path-refused · ${auditHit.path}`);
    } else {
      bad('R1', '留了一条可查的审计', '没读到 `hidden-path-refused` 那一条');
    }

    // 负向对照：同一个包的干净入口 ⇒ 200；另一个干净包 ⇒ 200
    const ok1 = await fetch(`${origin.base}/a/dice/1/index.html?${sig}`);
    const good2 = entryUrl({ base: 'https://apps.example', key: KEY, sub: 'u1', id: 'clean-app', version: 1, entry: 'index.html', now: NOW });
    const q2 = new URL(good2).searchParams;
    const ok2 = await fetch(`${origin.base}/a/clean-app/1/index.html?e=${q2.get('e')}&s=${q2.get('s')}`);
    if (ok1.status === 200 && ok2.status === 200) ok('R1', '负向对照：同一个包的干净入口 + 另一个干净包 ⇒ 都 200', `${ok1.status} / ${ok2.status}`);
    else bad('R1', '负向对照：干净包照旧 200', `${ok1.status} / ${ok2.status}`);
  } finally {
    await origin.close();
  }
}
NODE

out13="$(cd "$CORE" && HUPO_CORE="$CORE" HUPO_PROBE_TMP="$T" "$NODE" "$T/r13.mjs" 2>&1)"
rc13=$?
printf '%s\n' "$out13" | grep '^OK  ' | sed 's/^OK  /  ✓ /'
printf '%s\n' "$out13" | grep '^BAD ' | sed 's/^BAD /  ✗ /'
n_ok="$(printf '%s\n' "$out13" | grep -c '^OK  ' || true)"
n_bad="$(printf '%s\n' "$out13" | grep -c '^BAD ' || true)"
if ! printf '%s\n' "$out13" | grep -q '^OK  \|^BAD '; then
  bad 'R1/R3' '探针没出声（**不可算**）' '一条判据都跑不出来'
  printf '%s\n' "$out13" | tail -20 | sed 's/^/      | /'
else
  pass=$((pass + n_ok)); fail=$((fail + n_bad))
  if [ "$rc13" -ne 0 ] && [ "$n_bad" -eq 0 ]; then
    bad 'R1/R3' '探针非零退出但没报 BAD（**不可算**）' "rc=$rc13"
  fi
fi

echo
echo '── R2：源码级（唯一取字节那条路）＋ 变异（拔掉那处调用 ⇒ 闸真的空转）'
echo

cat > "$T/r2.mjs" <<'NODE'
// R2 探针：喂一个模块目录（`APPS_DIR`），造隐藏包并读它 —— 看它**拒不拒**。
// 输出：`REFUSED <code>` / `NOT_REFUSED <怎么读出来的>` / `SCAN ...`
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { pathToFileURL } from 'node:url';

const APPS_DIR = process.env.APPS_DIR;
const T = process.env.HUPO_PROBE_TMP;
const m = await import(pathToFileURL(nodePath.join(APPS_DIR, 'apps.js')).href);
const { Apps, HIDDEN_PATH_CODE, isHiddenPathRefusal, rootHashOf, sha256hex } = m;

const HIDDEN = '.data/a.json';
const BODY = '{"sentinel":"PROBE-R2"}';
const dir = nodeFs.mkdtempSync(nodePath.join(T, 'r2-'));
const apps = new Apps({ dir, sub: 'u1' });
apps.create({ id: 'dice', title: '掷骰子', icon: 'dice', entry: 'index.html', files: { 'index.html': '<p>x</p>' } });
const vdir = apps.versionDir('dice', 1);
nodeFs.mkdirSync(nodePath.join(vdir, '.data'), { recursive: true });
nodeFs.writeFileSync(nodePath.join(vdir, HIDDEN), BODY);
const mpath = nodePath.join(vdir, 'manifest.json');
nodeFs.chmodSync(mpath, 0o644);
const man = JSON.parse(nodeFs.readFileSync(mpath, 'utf8'));
man.files.push({ path: HIDDEN, sha256: sha256hex(Buffer.from(BODY)), bytes: Buffer.from(BODY).length });
man.rootHash = rootHashOf(man.files.map((f) => ({ path: f.path, sha256: f.sha256 })));
nodeFs.writeFileSync(mpath, `${JSON.stringify(man, null, 2)}\n`);

try {
  apps.read('dice', 1, HIDDEN);
  console.log('NOT_REFUSED 隐藏路径照旧读出来了');
} catch (e) {
  if (isHiddenPathRefusal(e) && e.code === HIDDEN_PATH_CODE) console.log(`REFUSED ${e.code}`);
  else console.log(`REFUSED_OTHER ${e?.name}: ${e?.message}`);
}
NODE

# ── R2a 源码扫描：唯一取字节那条路 = `Apps.read()`，闸在它里面、跑在 readFileSync 之前
scan="$(HUPO_CORE="$CORE" "$NODE" -e '
const fs = require("node:fs");
const path = require("node:path");
const src = fs.readFileSync(path.join(process.env.HUPO_CORE, "src", "apps.js"), "utf8");
const at = src.indexOf("  read(id, version, rel) {");
if (at < 0) { console.log("BAD 找不到 Apps.read()"); process.exit(0); }
const body = src.slice(at, at + 2600);
const gate = body.indexOf("refuseHiddenRelPath(rel);");
const read = body.indexOf("readFileSync");
const joins = src.match(/nodePath\.join\(this\.versionDir\([^)]*\), rel\)/g) ?? [];
if (gate < 0) console.log("BAD read() 里没有那道闸");
else if (read >= 0 && gate > read) console.log("BAD 闸跑在读盘之后");
else if (joins.length !== 1) console.log(`BAD 取字节的拼法有 ${joins.length} 处（应 1）`);
else console.log("OK 读侧只有一处：Apps.read() 里过闸，且跑在读盘之前");
' 2>&1)"
case "$scan" in
  OK*) ok 'R2a' "${scan#OK }" ;;
  *)   bad 'R2a' "${scan#BAD }" ;;
esac

# ── R2b 变异：临时副本里把 read() 那处调用拔掉 ⇒ 隐藏路径必须**照旧读得出**（原闸承重）
MUT="$T/mut"
mkdir -p "$MUT"
cp -r "$CORE/src" "$MUT/src"
ln -s "$CORE/node_modules" "$MUT/node_modules" 2>/dev/null || true
HUPO_MUT="$MUT/src/apps.js" "$NODE" -e '
const fs = require("node:fs");
const p = process.env.HUPO_MUT;
let s = fs.readFileSync(p, "utf8");
const at = s.indexOf("  read(id, version, rel) {");
if (at < 0) { console.error("找不到 read()"); process.exit(2); }
const head = s.slice(0, at), tail = s.slice(at);
const call = "refuseHiddenRelPath(rel);";
if (!tail.includes(call)) { console.error("read() 里找不到那处调用"); process.exit(2); }
s = head + tail.replace(call, "/* 变异：拔掉读侧那道调用 */");
fs.writeFileSync(p, s);
'
if [ $? -ne 0 ]; then
  bad 'R2b' '变异没做成（**不可算**）' '临时副本改不动'
else
  real_out="$(cd "$CORE" && HUPO_PROBE_TMP="$T" APPS_DIR="$CORE/src" "$NODE" "$T/r2.mjs" 2>&1)"
  mut_out="$(cd "$CORE" && HUPO_PROBE_TMP="$T" APPS_DIR="$MUT/src" "$NODE" "$T/r2.mjs" 2>&1)"
  case "$real_out" in
    REFUSED*) ok 'R2b' '正对照：真代码里隐藏路径被拒' "${real_out#REFUSED }" ;;
    *) bad 'R2b' '正对照：真代码里隐藏路径被拒' "$real_out" ;;
  esac
  case "$mut_out" in
    NOT_REFUSED*) ok 'R2b' '变异：拔掉那处调用 ⇒ 隐藏路径照旧读得出（证明那道调用**真的承重**）' "$mut_out" ;;
    REFUSED*)     bad 'R2b' '变异：拔掉那处调用后居然还拒' "$mut_out —— 要么拔错了地方，要么别处还有一道闸" ;;
    *)            bad 'R2b' '变异探针没出声（**不可算**）' "$mut_out" ;;
  esac
fi

echo
echo '── R4：真机只读盘查 ＋ 零残留（跑前跑后逐文件 sha256）'
echo

cat > "$T/r4.mjs" <<'NODE'
// R4 探针：本机**可读**的制品库只读盘查 ＋ 跑前跑后逐文件 sha256。
// 输出：`OK/BAD ...`（零残留/负向对照） / `INVENTORY ...`（数字与清单） / `NOTE ...`。
import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

const LIVE = process.env.HUPO_LIVE_DATA;
const ROOTS = ['/home/hupo-a/tenant', '/home/hupo-b/tenant', '/home/hupo-t3/tenant'];

const ok = (name, reading) => console.log(`OK  R4 :: ${name} ;; ${reading}`);
const bad = (name, reading) => console.log(`BAD R4 :: ${name} ;; ${reading}`);
const note = (s) => console.log(`NOTE ${s}`);

function digest(root) {
  const out = new Map();
  const walk = (rel) => {
    let es = [];
    try { es = nodeFs.readdirSync(nodePath.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of es.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.set(`${next}/`, 'dir'); walk(next); continue; }
      out.set(next, nodeCrypto.createHash('sha256').update(nodeFs.readFileSync(nodePath.join(root, next))).digest('hex'));
    }
  };
  walk('');
  return out;
}
const same = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/** 有隐藏段吗（**任一段**以 `.` 开头 —— 与 `refuseHiddenRelPath` 同一把尺子）。 */
const hiddenSeg = (rel) => String(rel).split('/').some((p) => p.startsWith('.'));

// ── 可读的制品库根（在架 = 活的那份；`.removed` 是回收站，单列）
const roots = [];
const push = (p) => { try { if (nodeFs.existsSync(p)) roots.push(p); } catch { /* 读不到就算了 */ } };
push(nodePath.join(LIVE, 'hupo', 'apps'));
try {
  for (const u of nodeFs.readdirSync(nodePath.join(LIVE, 'users'))) push(nodePath.join(LIVE, 'users', u, 'hupo', 'apps'));
} catch { /* 没有 users 这一格 */ }
push(nodePath.join(LIVE, 'published-apps'));

// ── 跑前指纹（只看**能读到的**那些根）
const before = new Map();
for (const r of roots) before.set(r, digest(r));

// ── 只读盘查
let onShelf = 0; let removed = 0; let affected = 0;
const list = [];
const seenRoots = new Set();
for (const r of roots) {
  seenRoots.add(r);
  const isShared = nodePath.basename(r) === 'published-apps';
  let ids = [];
  try { ids = nodeFs.readdirSync(r, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { continue; }
  for (const id of ids) {
    if (id === '.removed') {
      // 回收站：不算"在架"，但一样列出来（不许自己删/改任何人的东西）
      let subs = [];
      try { subs = nodeFs.readdirSync(nodePath.join(r, id)); } catch { subs = []; }
      for (const s of subs) {
        const vroot = nodePath.join(r, id, s, 'versions');
        let vs = [];
        try { vs = nodeFs.readdirSync(vroot).filter((v) => /^[0-9]+$/.test(v)); } catch { vs = []; }
        for (const v of vs) {
          const mp = nodePath.join(vroot, v, 'manifest.json');
          let man = null;
          try { man = JSON.parse(nodeFs.readFileSync(mp, 'utf8')); } catch { man = null; }
          removed += 1;
          if (man && Array.isArray(man.files)) {
            for (const f of man.files) {
              if (hiddenSeg(f?.path ?? '')) note(`回收站（不算在架）里有隐藏路径：${id}@${v} :: ${f.path}`);
            }
          }
        }
      }
      continue;
    }
    if (isShared) {
      // 共享库：`<id>/versions/<n>/` 里的**文件名**（没有清单，直接走目录）
      const vroot = nodePath.join(r, id, 'versions');
      let vs = [];
      try { vs = nodeFs.readdirSync(vroot).filter((v) => /^[0-9]+$/.test(v)); } catch { vs = []; }
      for (const v of vs) {
        onShelf += 1;
        const walk = (rel) => {
          let es = [];
          try { es = nodeFs.readdirSync(nodePath.join(vroot, v, rel), { withFileTypes: true }); } catch { return; }
          for (const e of es) {
            const next = rel ? `${rel}/${e.name}` : e.name;
            if (hiddenSeg(next) && e.name !== 'manifest.json') { affected += 1; list.push(`共享库 ${id}@${v} :: ${next}`); }
            if (e.isDirectory()) walk(next);
          }
        };
        walk('');
      }
      continue;
    }
    // 个人制品库：`<id>/versions/<n>/manifest.json`
    const vroot = nodePath.join(r, id, 'versions');
    let vs = [];
    try { vs = nodeFs.readdirSync(vroot).filter((v) => /^[0-9]+$/.test(v)); } catch { vs = []; }
    for (const v of vs) {
      const mp = nodePath.join(vroot, v, 'manifest.json');
      let man = null;
      try { man = JSON.parse(nodeFs.readFileSync(mp, 'utf8')); } catch { man = null; }
      if (!man) continue;
      onShelf += 1;
      for (const f of man.files ?? []) {
        if (hiddenSeg(f?.path ?? '')) { affected += 1; list.push(`${r} ${id}@${v} :: ${f.path}`); }
      }
    }
  }
}
console.log(`INVENTORY 可读制品库 ${seenRoots.size} 个 · 在架制品 ${onShelf} 个 · 回收站 ${removed} 个 · **受影响 ${affected} 个**`);
for (const one of list) console.log(`AFFECTED ${one}`);

// ── 租户盒子：本机读不到 ⇒ 如实说不可算（**只读**；没有 docker、没有 sudo）
let unreadable = 0;
for (const r of ROOTS) {
  try { nodeFs.readdirSync(r); } catch { unreadable += 1; }
}
if (unreadable > 0) note(`租户盒子 ${unreadable} 台（/home/hupo-*，0700）本机读不到 ⇒ 那几台的盘查**不可算**（只报本机可读范围）`);

// ── 跑后指纹：逐文件 sha256 复原（这一条闸对真机**只读**）
const after = new Map();
for (const r of roots) after.set(r, digest(r));
let dirty = 0;
for (const r of roots) if (!same(before.get(r), after.get(r))) dirty += 1;
if (roots.length === 0) bad('零残留：跑前跑后逐文件 sha256 一致', '本机一个可读制品库都没有 ⇒ **不可算**');
else if (dirty === 0) ok('零残留：真机只读盘查跑前跑后逐文件 sha256 一致', `${roots.length} 个根全部复原`);
else bad('零残留：跑前跑后逐文件 sha256 一致', `${dirty} 个根变了`);

// ── 负向对照：指纹函数改一个字节 ⇒ 必须变（证明它不是恒真的空转）
try {
  const a = nodeFs.mkdtempSync(nodePath.join(process.env.HUPO_PROBE_TMP, 'r4-'));
  nodeFs.writeFileSync(nodePath.join(a, 'x.txt'), 'AAAA');
  const d1 = digest(a);
  nodeFs.writeFileSync(nodePath.join(a, 'x.txt'), 'AAAB');
  const d2 = digest(a);
  if (!same(d1, d2)) ok('负向对照：指纹函数改一个字节 ⇒ 必须变', 'sha256 会变（不是恒真）');
  else bad('负向对照：指纹函数改一个字节 ⇒ 必须变', '改了字节指纹却没变 —— 指纹函数有问题');
} catch (e) {
  bad('负向对照：指纹函数改一个字节 ⇒ 必须变', `**不可算**：${e?.message ?? e}`);
}
NODE

out4="$(cd "$CORE" && HUPO_PROBE_TMP="$T" HUPO_LIVE_DATA="$LIVE_DATA" "$NODE" "$T/r4.mjs" 2>&1)"
rc4=$?
printf '%s\n' "$out4" | grep '^OK  ' | sed 's/^OK  /  ✓ /'
printf '%s\n' "$out4" | grep '^BAD ' | sed 's/^BAD /  ✗ /'
printf '%s\n' "$out4" | grep '^INVENTORY ' | sed 's/^INVENTORY /  · /'
printf '%s\n' "$out4" | grep '^AFFECTED ' | sed 's/^AFFECTED /      - 受影响：/'
printf '%s\n' "$out4" | grep '^NOTE ' | sed 's/^NOTE /  ⚠️ /'
n_ok="$(printf '%s\n' "$out4" | grep -c '^OK  ' || true)"
n_bad="$(printf '%s\n' "$out4" | grep -c '^BAD ' || true)"
if ! printf '%s\n' "$out4" | grep -q '^OK  \|^BAD '; then
  bad 'R4' '真机盘查没出声（**不可算**）' '一条判据都跑不出来'
  printf '%s\n' "$out4" | tail -20 | sed 's/^/      | /'
else
  pass=$((pass + n_ok)); fail=$((fail + n_bad))
  if [ "$rc4" -ne 0 ] && [ "$n_bad" -eq 0 ]; then
    bad 'R4' '探针非零退出但没报 BAD（**不可算**）' "rc=$rc4"
  fi
fi

echo
echo "通过 $pass · 失败 $fail"
exit "$fail"
