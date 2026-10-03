#!/usr/bin/env bash
# **「形状随 fork 走、值永不随」的闸**（`D4.24` · **A1** · 2026-10-03 主人定；
#   出处 `docs/dev/161-OWNER-DECISIONS-11.md` A1 · `docs/dev/90-APP-CONTRACT.md` §3.2／§3.3 Q3.1／Q3.2 ·
#   `docs/dev/91-TRIPLE-CONTRACT.md` §3.2／§6.6／§8.1 · `docs/dev/92-TRIPLE-PLAN.md` §② ·
#   事实记录见 `docs/dev/165-DATA-SHAPE-FORK.md`）。
#
# 用法：
#   bash scripts/check-data-shape.sh
#
# 退出码 = 失败数（0 ⇒ 通过）；末尾固定打印 **`通过 N · 失败 M`**。
#
# ── 为什么不扩别的闸（那六条**一个字节没动**）─────────────────
#   `check-scope-boundary.sh`（真机边界）／`check-outbound-bridge.sh`（出界独木桥）／
#   `check-edge-kinds.sh`（三条登记边）／`check-app-entry-identity.sh`（入口 URL 与身份）／
#   `check-index-author-hash.sh`（共享库作者假名）／`check-read-side-assert.sh`（读侧隐藏路径）
#   各管一件事：**什么能出去** / **哪条边记在哪** / **读不读得出**。
#   这一条问的是**另一件事**：**那份描述"数据长什么样"的声明，能不能随版本一起走，
#   而又一个值的字节都不带走**。判据、机制、会坏的方式都不一样 ⇒ **新开一条**。
#
# ── 判据 S1–S5（每条都带**负向对照**；每条都能反着验）──────────
#   S1 (=①) 🔴 **把「值」塞进形状声明 ⇒ 拒**，而且**盘上零残留**；
#             ★ 负向对照：只写形状 ⇒ **过**（不是"一律拒"）。
#   S2 (=②) 🔴 **形状随版本冻结**：只改数据的**值** ⇒ 形状的号**逐字不变**；
#             改形状**不改号** ⇒ **拒**；改形状且号跟着 ⇒ **必变**（两个方向都钉住）。
#   S3 (=③) 🔴 **fork／装上之后值不随**：真跑一次「发布 → 装上 → 镜像」＋一次真 `fork`
#             ⇒ 新那一份**整个目录树里搜不到源那份的值**；而**形状在**（两边指纹逐字相同）。
#             ★ 负向对照：源那份的值**不许被误判成"形状"**（塞进声明 ⇒ 拒）。
#   S4 (=④) 🔴 **规则只住一处**：源码级扫描 —— 那份固定名文件的名字与形状的判据本体
#             只在 `data-shape.js` 一处（`apps.js`／`workspace.js`／`published.js` 只 **import** 它）；
#             **变异**：把那一处改坏（两处关键接线各拔一次）⇒ **红**（证明它真的承重）。
#   S5 (=⑤) 🔴 **没声明 ⇒ 最严**：盘上有数据格（`.data/<pack>/`）而没有形状声明 ⇒ **拒**，
#             理由**看得见**（点名哪一格、缺哪个文件），**盘上零残留**；
#             ★ 负向对照：补上只写形状的声明 ⇒ **过**；根本没有数据格 ⇒ **不拦**。
#
# 🔴 纪律（92 §④ 末两条）：
#   · 读不出 / 算不出 ⇒ 如实打印 **`不可算`** 并记**失败**，**绝不安静地绿**；
#   · **每一条都要有负向对照**，而且脚本自己核那条对照真的在。
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
echo '── S1／S2／S3／S5：临时目录里用**真代码**（不碰线上、不碰真数据目录）'
# ══════════════════════════════════════════════════════════════════

cat > "$T/shape-probe.mjs" <<'NODE'
// 一次性探针：真 `src/` 模块 ＋ 临时目录里的真盘（真 `apps.create` / `snapshotWorkspace` /
// `published.publish` / `handleAppsOp`）。输出协议 `OK <id> :: <名字> ;; <读数>` / `BAD ...`。
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
const {
  DATA_SHAPE_FILENAME, DataShapeError, buildDataShape, dataShapeDigest, parseDataShape, shapeVersionOf,
} = await mod('data-shape.js');
const { AppWorkspaces, mirrorArtifactIntoWorkspace, snapshotWorkspace } = await mod('workspace.js');
const { handleAppsOp } = await mod('apps-socket.js');

let seq = 0;
const tmp = (tag) => nodeFs.mkdtempSync(nodePath.join(T, `${tag}-${seq++}-`));
function world(tag) {
  const dir = tmp(tag);
  return {
    dir,
    apps: new Apps({ dir, sub: 'u1' }),
    workspaces: new AppWorkspaces({ dir, log: () => {} }),
    published: new Published({ dir }),
  };
}
const OUTBOUND = JSON.stringify({
  schema: 1, outbound: [],
  declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '探针' },
});
const PACK_JSON = JSON.stringify({ schema: 1, outbound: 'one-to-one', items: [] });
const KEYS = [{ name: 'id', type: 'string', null: 'never', dedup: true }];
const shapeText = (keys = KEYS, pack = 'news') => JSON.stringify(buildDataShape([{ pack, keys }]));

function buildScope(w, { id = 'news', shape = shapeText(), value = '第一份值' } = {}) {
  w.workspaces.ensure(id, { title: '新闻', entry: 'index.html' });
  w.workspaces.write(id, {
    'index.html': '<!doctype html><p>新闻</p>',
    'outbound.json': OUTBOUND,
    ...(shape === null ? {} : { [DATA_SHAPE_FILENAME]: shape }),
  });
  const cell = nodePath.join(w.workspaces.dirFor(id), '.data', 'news');
  nodeFs.mkdirSync(cell, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(cell, 'pack.json'), `${PACK_JSON}\n`);
  nodeFs.writeFileSync(nodePath.join(cell, 'payload.json'), `${value}\n`);
  return { id, cell };
}
function dirText(root) {
  let out = '';
  const walk = (rel) => {
    let es = [];
    try { es = nodeFs.readdirSync(nodePath.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of es.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out += `${next}/\n`; walk(next); continue; }
      try { out += `${next}\n${nodeFs.readFileSync(nodePath.join(root, next), 'latin1')}\n`; } catch { /* 读不到 */ }
    }
  };
  walk('');
  return out;
}
const versions = (w, id) => { try { return nodeFs.readdirSync(w.apps.versionsDir(id)).length; } catch { return 0; } };

process.on('uncaughtException', (e) => {
  console.log(`BAD probe :: 探针崩了（算不出来） ;; ${String(e?.stack ?? e).slice(0, 300)}`);
  process.exitCode = 1;
});

// ── S1 (=①) 值塞进形状声明 ⇒ 拒 ＋ 零残留；负向对照：只写形状 ⇒ 过 ──────
try {
  const w = world('S1');
  const good = JSON.parse(shapeText());
  const smuggle = [
    ['顶层 values', { ...good, values: ['张三', '李四'] }],
    ['包级 rows', { ...good, packs: [{ ...good.packs[0], rows: [{ id: '张三' }] }] }],
    ['列级 sample', { ...good, packs: [{ ...good.packs[0], keys: [{ ...good.packs[0].keys[0], sample: '张三' }] }] }],
  ];
  let refused = 0; let last = '';
  for (const [, body] of smuggle) {
    const err = caught(() => w.apps.create({
      id: 'news', title: '新闻', icon: 'dice', entry: 'index.html',
      files: { 'index.html': '<p>x</p>', [DATA_SHAPE_FILENAME]: JSON.stringify(body) },
    }));
    if (err instanceof DataShapeError && /值一个字节都不许进来/.test(err.message)) { refused += 1; last = err.message; }
  }
  const noResidue = !nodeFs.existsSync(nodePath.join(w.dir, 'hupo', 'apps')) && w.apps.list().length === 0;
  const m = w.apps.create({
    id: 'news', title: '新闻', icon: 'dice', entry: 'index.html',
    files: { 'index.html': '<p>x</p>', [DATA_SHAPE_FILENAME]: shapeText() },
  });
  const ctrlOk = m.files.some((f) => f.path === DATA_SHAPE_FILENAME) && w.apps.dataShape('news').declared === true;
  if (refused === smuggle.length && noResidue && ctrlOk) {
    ok('S1', '🔴 把「值」塞进形状声明 ⇒ 拒（3 种塞法逐个拒），且盘上零残留',
      `${smuggle.length} 种塞法全拒：「${last.slice(0, 44)}…」；拒时制品库一个目录都没建；`
      + '**负向对照**（只写形状）⇒ 过，声明真进了 `manifest.files[]`');
  } else {
    bad('S1', '把值塞进形状声明 ⇒ 拒', `拒了 ${refused}/${smuggle.length}；零残留=${noResidue}；对照过=${ctrlOk}`);
  }
} catch (e) {
  bad('S1', '把值塞进形状声明 ⇒ 拒', `**不可算**（${e?.message ?? e}）`);
}

// ── S2 (=②) 只改值 ⇒ 号不变；改形状不改号 ⇒ 拒；改形状 ⇒ 号必变 ────────
try {
  const w = world('S2');
  const { id } = buildScope(w, { value: '第一份值' });
  const v1 = snapshotWorkspace({ apps: w.apps, workspaces: w.workspaces, id, title: '新闻', icon: 'dice' });
  const s1 = w.apps.dataShape(id, v1.manifest.version);
  nodeFs.writeFileSync(nodePath.join(w.workspaces.dirFor(id), '.data', 'news', 'payload.json'), '第二份值\n');
  const v2 = snapshotWorkspace({ apps: w.apps, workspaces: w.workspaces, id, title: '新闻', icon: 'dice' });
  const s2 = w.apps.dataShape(id, v2.manifest.version);
  const sameSide = s2.digest === s1.digest
    && s2.decl.packs[0].shapeVersion === s1.decl.packs[0].shapeVersion
    && v2.manifest.rootHash === v1.manifest.rootHash;
  // 改形状**不改号** ⇒ 拒
  const before = versions(w, id);
  w.workspaces.write(id, { [DATA_SHAPE_FILENAME]: shapeText().replace('"string"', '"number"') });
  const staleErr = caught(() => snapshotWorkspace({ apps: w.apps, workspaces: w.workspaces, id, title: '新闻', icon: 'dice' }));
  const staleRefused = staleErr instanceof DataShapeError && versions(w, id) === before;
  // 改形状**且号跟着** ⇒ 必变
  const changed = [{ name: 'id', type: 'number', null: 'never', dedup: true }];
  w.workspaces.write(id, { [DATA_SHAPE_FILENAME]: shapeText(changed) });
  const v3 = snapshotWorkspace({ apps: w.apps, workspaces: w.workspaces, id, title: '新闻', icon: 'dice' });
  const s3 = w.apps.dataShape(id, v3.manifest.version);
  const movedSide = s3.decl.packs[0].shapeVersion !== s1.decl.packs[0].shapeVersion
    && s3.decl.packs[0].shapeVersion === shapeVersionOf({ pack: 'news', keys: changed });
  const frozen = w.apps.dataShape(id, v1.manifest.version).digest === s1.digest;
  if (sameSide && staleRefused && movedSide && frozen) {
    ok('S2', '🔴 形状随版本冻结：只改值 ⇒ 号逐字不变；改形状不改号 ⇒ 拒；改形状 ⇒ 号必变',
      `只改值：号与指纹逐字不变（${s1.decl.packs[0].shapeVersion} · rootHash 也相同）；`
      + `改形状不改号 ⇒ ${staleErr.name} 且零残留；改形状＋改号 ⇒ ${s1.decl.packs[0].shapeVersion}→${s3.decl.packs[0].shapeVersion}；`
      + '旧那一版的形状照旧冻结着');
  } else {
    bad('S2', '形状随版本冻结', `只改值不变=${sameSide}；改形状不改号被拒=${staleRefused}；改形状号变=${movedSide}；旧版冻结=${frozen}`);
  }
} catch (e) {
  bad('S2', '形状随版本冻结', `**不可算**（${e?.message ?? e}）`);
}

// ── S3 (=③) fork／装上 ⇒ 值不随、形状在；负向对照：值不许被误判成形状 ──
try {
  const SENT = 'shape-gate-sentinel-DO-NOT-SHIP-4a2';
  const author = world('S3a');
  const { id } = buildScope(author, { value: SENT });
  const snap = snapshotWorkspace({ apps: author.apps, workspaces: author.workspaces, id, title: '新闻', icon: 'dice' });
  const shapeIn = snap.manifest.files.some((f) => f.path === DATA_SHAPE_FILENAME);
  const noHidden = snap.manifest.files.every((f) => !f.path.split('/').some((p) => p.startsWith('.')));
  const shared = tmp('S3-shared');
  const published = new Published({ dir: shared });
  const idx = published.publish(author.apps, { id, authorSub: 'u1', authorName: '甲' });
  const sharedVer = nodePath.join(shared, 'published-apps', id, 'versions', String(idx.version));
  const sharedClean = !dirText(sharedVer).includes(SENT);
  const sharedHasShape = nodeFs.existsSync(nodePath.join(sharedVer, DATA_SHAPE_FILENAME));

  const viewer = world('S3v');
  const inst = published.installInto(viewer.apps, id);
  mirrorArtifactIntoWorkspace({ apps: viewer.apps, workspaces: viewer.workspaces, id });
  const viewerClean = !dirText(viewer.dir).includes(SENT);
  const noCell = !nodeFs.existsSync(nodePath.join(viewer.workspaces.dirFor(id), '.data'));
  const shapeSame = viewer.apps.dataShape(id, inst.version).digest
    === author.apps.dataShape(id, snap.manifest.version).digest;

  // 真 `fork`：先装一版、改自己的、上游再出一版 ⇒ 分叉（默认那一侧）
  author.workspaces.write(id, { 'index.html': '<!doctype html><p>上游第二版</p>' });
  snapshotWorkspace({ apps: author.apps, workspaces: author.workspaces, id, title: '新闻', icon: 'dice' });
  published.publish(author.apps, { id, authorSub: 'u1', authorName: '甲' });
  viewer.workspaces.write(id, { 'index.html': '<p>我自己改的</p>' });
  const fork = await handleAppsOp(viewer.apps, { op: 'install', id, mode: 'fork' }, {
    published, sub: 'u2', workspace: viewer.workspaces,
  });
  const forkClean = !dirText(viewer.dir).includes(SENT);
  const forkShape = fork.ok === true && fork.forked === true && viewer.apps.dataShape(id).declared === true;

  // 负向对照：值不许被误判成"形状"
  const srcDecl = author.workspaces.read(id).files[DATA_SHAPE_FILENAME].toString('utf8');
  const notInShape = !srcDecl.includes(SENT);
  const badDecl = JSON.parse(srcDecl);
  badDecl.packs[0].keys[0].value = SENT;
  const valueRefused = caught(() => parseDataShape(badDecl)) instanceof DataShapeError;
  const srcHasValue = dirText(author.dir).includes(SENT);
  if (shapeIn && noHidden && sharedClean && sharedHasShape && viewerClean && noCell && shapeSame
      && forkClean && forkShape && notInShape && valueRefused && srcHasValue) {
    ok('S3', '🔴 fork／装上之后值不随、形状在（真发布→装上→镜像＋真 fork 两条路）',
      `共享库/装上那份/分叉那份整个目录树搜哨兵 **零命中**；两边形状指纹逐字相同（${String(snap.shape.digest).slice(0, 12)}…）；`
      + '`forked=true`；**负向对照**：值不在声明里，塞进去当场拒（不会被误判成形状）；'
      + '正对照：源那份的值真在');
  } else {
    bad('S3', 'fork 之后值不随、形状在',
      `制品含形状=${shapeIn}；零隐藏路径=${noHidden}；共享库干净=${sharedClean}；共享库有形状=${sharedHasShape}；`
      + `装上干净=${viewerClean}；装上无数据格=${noCell}；形状同源=${shapeSame}；`
      + `fork 干净=${forkClean}；fork 形状在=${forkShape}；对照组=${notInShape && valueRefused && srcHasValue}`);
  }
} catch (e) {
  bad('S3', 'fork 之后值不随、形状在', `**不可算**（${e?.message ?? e}）`);
}

// ── S5 (=⑤) 没声明 ⇒ 最严；补上 ⇒ 过；没有数据格 ⇒ 不拦 ──────────────
try {
  const w = world('S5');
  const { id } = buildScope(w, { shape: null }); // 有 `.data/news/`，制品里没有声明
  const err = caught(() => snapshotWorkspace({ apps: w.apps, workspaces: w.workspaces, id, title: '新闻', icon: 'dice' }));
  const refused = err instanceof DataShapeError
    && /没有形状声明|按最严办/.test(err.message) && err.message.includes('news') && versions(w, id) === 0;
  w.workspaces.write(id, { [DATA_SHAPE_FILENAME]: shapeText() });
  const snap = snapshotWorkspace({ apps: w.apps, workspaces: w.workspaces, id, title: '新闻', icon: 'dice' });
  const ctrlOk = snap.shape.refused.length === 0 && snap.shape.carried.map((c) => c.pack).join(',') === 'news'
    && snap.manifest.files.every((f) => !f.path.startsWith('.data'));
  const w2 = world('S5b');
  w2.workspaces.ensure('plain', { title: '素', entry: 'index.html' });
  w2.workspaces.write('plain', { 'index.html': '<p>没有数据</p>' });
  const plain = snapshotWorkspace({ apps: w2.apps, workspaces: w2.workspaces, id: 'plain', title: '素', icon: 'dice' });
  const noOverRefuse = plain.shape.refused.length === 0 && plain.shape.declared === false;
  if (refused && ctrlOk && noOverRefuse) {
    ok('S5', '🔴 没声明 ⇒ 最严（拒，理由看得见、零残留）；补上 ⇒ 过；没有数据格 ⇒ 不拦',
      `拒的话点名了「news」与缺的那个文件；拒时 ${0} 个版本目录；补上只写形状的声明 ⇒ 过；`
      + '没有数据格那一份如实记 `declared:false` 且不拦');
  } else {
    bad('S5', '没声明 ⇒ 最严', `拒=${refused}；补上过=${ctrlOk}；不过拦=${noOverRefuse}`);
  }
} catch (e) {
  bad('S5', '没声明 ⇒ 最严', `**不可算**（${e?.message ?? e}）`);
}

process.exitCode = 0;
NODE

OUT="$(HUPO_CORE="$CORE" HUPO_PROBE_TMP="$T" "$NODE" "$T/shape-probe.mjs" 2>&1)"
rc=$?
printf '%s\n' "$OUT" | grep '^OK  ' | sed 's/^OK  /  ✓ /'
printf '%s\n' "$OUT" | grep '^BAD ' | sed 's/^BAD /  ✗ /'
np="$(printf '%s\n' "$OUT" | grep -c '^OK  ' || true)"
nf="$(printf '%s\n' "$OUT" | grep -c '^BAD ' || true)"
pass=$((pass + np)); fail=$((fail + nf))
if [ "$rc" != "0" ] && [ "$nf" = "0" ]; then
  bad "S1–S5 探针异常退出（rc=$rc）却没报哪一条 ⇒ 这些判据**不可算**"
fi
if [ "$nf" = "0" ] && [ "$np" -lt 4 ]; then
  bad "S1–S5 应该出 4 条读数（S1/S2/S3/S5），只读到 $np 条 ⇒ **不可算**"
fi

# ══════════════════════════════════════════════════════════════════
echo
echo '── S4 (=④)：源码级（规则只住一处）＋ 变异（把关键那几处改坏 ⇒ 红）'
# ══════════════════════════════════════════════════════════════════

# ── S4a 源码扫描：固定名与判据本体只在 `data-shape.js`；三条写路只 import 它
scan="$(HUPO_CORE="$CORE" "$NODE" -e '
const fs = require("node:fs");
const path = require("node:path");
const src = path.join(process.env.HUPO_CORE, "src");
const files = fs.readdirSync(src).filter((f) => f.endsWith(".js"));
const read = (f) => fs.readFileSync(path.join(src, f), "utf8");
const withLiteral = files.filter((f) => read(f).includes("\x27data-shape.json\x27"));
if (withLiteral.length !== 1 || withLiteral[0] !== "data-shape.js") {
  console.log(`BAD 那份固定名文件出现在 [${withLiteral.join(",")}] —— 应只在 data-shape.js`);
  process.exit(0);
}
const all = files.map(read).join("\n");
const n = (re) => (all.match(re) ?? []).length;
if (n(/export function parseDataShape\(/g) !== 1) { console.log("BAD 形状的判据本体不止一份"); process.exit(0); }
if (n(/export const SHAPE_TYPES = /g) !== 1) { console.log("BAD 类型枚举不止一份"); process.exit(0); }
if (n(/export const NULL_POLICIES = /g) !== 1) { console.log("BAD 空值口径枚举不止一份"); process.exit(0); }
for (const f of ["apps.js", "workspace.js", "published.js"]) {
  if (!/from \x27\.\/data-shape\.js\x27/.test(read(f))) { console.log(`BAD ${f} 没 import 那一处`); process.exit(0); }
}
// 包名走**与 app id 同一条形状**（91 §3.3.5）：两处的正则与长度上限逐字核过
const shapeSrc = read("data-shape.js"); const appsSrc = read("apps.js");
const packRe = (shapeSrc.match(/PACK_NAME_RE = (\/[^\/\n]+\/);/) ?? [])[1];
const appRe = (appsSrc.match(/!(\/[^\/\n]+\/)\.test\(id\)/) ?? [])[1];
if (!packRe || packRe !== appRe) { console.log(`BAD 包名正则两处不一致：data-shape=${packRe} apps=${appRe}`); process.exit(0); }
const maxPack = (shapeSrc.match(/MAX_PACK_NAME_CHARS = ([0-9]+)/) ?? [])[1];
const maxId = (appsSrc.match(/MAX_ID_CHARS = ([0-9]+)/) ?? [])[1];
if (!maxPack || maxPack !== maxId) { console.log(`BAD 包名长度上限两处不一致：${maxPack} vs ${maxId}`); process.exit(0); }
console.log("OK 固定名与判据本体只在 data-shape.js；三条写路都 import 它；包名形状与 app id 同一个正则/上限");
' 2>&1)"
case "$scan" in
  OK*) ok "S4a ${scan#OK }" ;;
  *)   bad "S4a ${scan#BAD }（读不出 ⇒ 不可算）" ;;
esac

# ── S4b 变异：临时副本里把两处关键接线各拔一次 ⇒ 两条判据都必须**红**
MUT="$T/mut"
mkdir -p "$MUT"
cp -r "$CORE/src" "$MUT/src"
ln -s "$CORE/node_modules" "$MUT/node_modules" 2>/dev/null || true
MUT_RESULT="$(HUPO_MUT="$MUT/src" "$NODE" -e '
const fs = require("node:fs");
const path = require("node:path");
const src = process.env.HUPO_MUT;
const appsPath = path.join(src, "apps.js");
const shapePath = path.join(src, "data-shape.js");
// 变异 A：拔掉写侧那道调用（值就能塞进形状声明了）
let a = fs.readFileSync(appsPath, "utf8");
const call = "if (rel === DATA_SHAPE_FILENAME) parseDataShape(buf);";
if (!a.includes(call)) { console.log("NOCALL"); process.exit(0); }
a = a.replace(call, "/* 变异：拔掉写侧那道调用 */");
fs.writeFileSync(appsPath, a);
// 变异 B：让"没声明 ⇒ 最严"那一条永不抛（规则本体那一处改坏）
let d = fs.readFileSync(shapePath, "utf8");
const guard = "if (plan.refused.length > 0) {";
if (!d.includes(guard)) { console.log("NOGUARD"); process.exit(0); }
d = d.replace(guard, "if (false && plan.refused.length > 0) {");
fs.writeFileSync(shapePath, d);
console.log("MUTATED");
' 2>&1)"
if [ "$MUT_RESULT" != "MUTATED" ]; then
  bad "S4b 变异没做成（**不可算**）：$MUT_RESULT"
else
  cat > "$T/mut-probe.mjs" <<'NODE'
// 变异探针：只问两件事 —— 值还塞得进吗？没声明还拦得住吗？
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { pathToFileURL } from 'node:url';
const SRC = process.env.MUT_SRC;
const T = process.env.HUPO_PROBE_TMP;
const mod = (rel) => import(pathToFileURL(nodePath.join(SRC, rel)).href);
const { Apps } = await mod('apps.js');
const { DataShapeError, buildDataShape } = await mod('data-shape.js');
const { AppWorkspaces, snapshotWorkspace } = await mod('workspace.js');
const caught = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const OUTBOUND = JSON.stringify({ schema: 1, outbound: [], declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '变异' } });
const good = JSON.parse(JSON.stringify(buildDataShape([{ pack: 'news', keys: [{ name: 'id', type: 'string', null: 'never', dedup: true }] }])));
const badDecl = { ...good, values: ['张三'] };
const dir = nodeFs.mkdtempSync(nodePath.join(T, 'mut-'));
const apps = new Apps({ dir, sub: 'u1' });
let valuesAccepted = false;
try {
  apps.create({ id: 'news', title: '新闻', icon: 'dice', entry: 'index.html',
    files: { 'index.html': '<p>x</p>', 'data-shape.json': JSON.stringify(badDecl) } });
  valuesAccepted = true;
} catch (e) { if (!(e instanceof DataShapeError)) valuesAccepted = true; }
console.log(`VALUES_${valuesAccepted ? 'ACCEPTED' : 'REFUSED'}`);

// 没声明那一半（干净的一份代码：真 `workspace.js` 只是被变异过 data-shape.js 的 guard）
const dir2 = nodeFs.mkdtempSync(nodePath.join(T, 'mut2-'));
const apps2 = new Apps({ dir: dir2, sub: 'u1' });
const ws = new AppWorkspaces({ dir: dir2, log: () => {} });
ws.ensure('news', { title: '新闻', entry: 'index.html' });
ws.write('news', { 'index.html': '<p>x</p>', 'outbound.json': OUTBOUND });
nodeFs.mkdirSync(nodePath.join(ws.dirFor('news'), '.data', 'news'), { recursive: true });
nodeFs.writeFileSync(nodePath.join(ws.dirFor('news'), '.data', 'news', 'pack.json'),
  JSON.stringify({ schema: 1, outbound: 'one-to-one', items: [] }));
let undeclaredPassed = false;
try { snapshotWorkspace({ apps: apps2, workspaces: ws, id: 'news', title: '新闻', icon: 'dice' }); undeclaredPassed = true; } catch { /* 期望不抛 */ }
console.log(`UNDECLARED_${undeclaredPassed ? 'PASSED' : 'REFUSED'}`);
NODE

  real="$(cd "$CORE" && HUPO_PROBE_TMP="$T" MUT_SRC="$CORE/src" "$NODE" "$T/mut-probe.mjs" 2>&1)"
  mut="$(cd "$CORE" && HUPO_PROBE_TMP="$T" MUT_SRC="$MUT/src" "$NODE" "$T/mut-probe.mjs" 2>&1)"
  echo "  · 真代码：$(printf '%s' "$real" | tr '\n' ' ')"
  echo "  · 变异后：$(printf '%s' "$mut" | tr '\n' ' ')"
  case "$real" in
    *VALUES_REFUSED*UNDECLARED_REFUSED*) ok 'S4b 正对照：真代码里"值塞不进"且"没声明必拒"' ;;
    *) bad "S4b 正对照：真代码里那两条本该成立（**不可算**）：$real" ;;
  esac
  case "$mut" in
    *VALUES_ACCEPTED*) ok 'S4b 变异 A：拔掉写侧那道调用 ⇒ 值**塞得进**了（证明那道调用承重）' ;;
    *VALUES_REFUSED*) bad 'S4b 变异 A：拔掉写侧调用后居然还拒 ⇒ 要么拔错地方，要么别处还有一道闸' ;;
    *) bad "S4b 变异 A 探针没出声（**不可算**）：$mut" ;;
  esac
  case "$mut" in
    *UNDECLARED_PASSED*) ok 'S4b 变异 B：把"最严"那一处改坏 ⇒ 没声明也**放过去了**（证明规则本体承重）' ;;
    *UNDECLARED_REFUSED*) bad 'S4b 变异 B：改坏规则本体后居然还拒 ⇒ 别处另有一套规则（破坏了"只住一处"）' ;;
    *) bad "S4b 变异 B 探针没出声（**不可算**）：$mut" ;;
  esac
fi

# ── 判据自己也要有负向对照：核那份测试里真的有"对照" ───────────────────
TESTFILE="$CORE/test/data-shape.test.js"
if [ ! -f "$TESTFILE" ]; then
  bad "找不到 test/data-shape.test.js ⇒ S1–S5 的读法**不可算**"
else
  for marker in '负向对照' '零残留' '逐字不变' '误判' '最严'; do
    if ! grep -qF "$marker" "$TESTFILE"; then
      bad "那份测试里找不到负向对照「$marker」⇒ 可能没在反着验"
    fi
  done
fi

echo
echo "──────────────────────────────"
if [ "$fail" = "0" ]; then
  echo "✅ 通过 $pass · 失败 $fail"
  exit 0
fi
echo "✗ 通过 $pass · 失败 $fail"
exit 1
