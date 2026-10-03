#!/usr/bin/env bash
# **「数据契约：声明过边界的数据 ＋ 按命名空间隔离」的闸**（`D4.24` · **D1** ·
#   2026-10-03 主人定；出处 `docs/dev/85-FRAMEWORK.md` §四·1 · 签字页 `docs/dev/161-OWNER-DECISIONS-11.md` D1 ·
#   `docs/dev/90-APP-CONTRACT.md` §3.2／§3.3 Q3.1／Q3.2 · `docs/dev/91-TRIPLE-CONTRACT.md` §2.3.3／§3.2 ·
#   `docs/dev/92-TRIPLE-PLAN.md` §② · 事实记录见 `docs/dev/166-DATA-CONTRACT.md`）。
#
# 用法：
#   bash scripts/check-data-contract.sh
#
# 退出码 = 失败数（0 ⇒ 通过）；末尾固定打印 **`通过 N · 失败 M`**。
#
# ── 它问的是哪一件事（与 A1 那条闸不是一回事）────────────────
#   `check-data-shape.sh`（A1）问的是"**那份描述形状的声明能不能随版本走、值能不能不随**"；
#   这一条问的是**取用那一侧**：**谁**能取到**哪一格**数据 ——
#   契约＝声明（没声明取不到）· 命名空间隔离（同 app 跨包拒）· 跨 app 隔离（两个方向都拒）·
#   越界零残留 · 规则一处（含**变异**）· 不过度拒。
#   两件事的机制、会坏的方式都不一样 ⇒ **新开一条**，老七条一个字节不动。
#
# ── 判据 S1–S6（每条都带**负向对照**；每条都能反着验）──────────
#   S1 (=①) 🔴 **契约＝声明**：要取的那一格没被 `data-shape.json` 声明过 ⇒ **拒**（fail-closed），
#             理由**看得见**（点名哪一格、缺哪个文件）；
#             ★ 负向对照：补上一份**只写形状**的声明 ⇒ **过**（不是"一律拒"）。
#   S2 (=②) 🔴 **命名空间隔离**：同 app 里一个包取另一个包 ⇒ **三条路（取／写／列）全拒**；
#             ★ 负向对照：自己取自己 ⇒ **过**，而且读到的**是自己那一格**的值。
#   S3 (=③) 🔴 **跨 app 隔离**：`bbb → aaa` 与 `aaa → bbb` **两个方向都拒**；
#             ★ 负向对照：同一个 app 自己的数据照旧读得到。
#   S4 (=④) 🔴 **越界尝试零残留**：跨 app／跨包／`..` 那几种尝试逐个拒，
#             跑完**整棵树逐文件 sha256 复原**；
#             ★ 负向对照：一次**合法写**必须真的改动盘（证明上面那条不是恒等空跑）。
#   S5 (=⑤) 🔴 **规则只住一处**：源码级扫描（边界判定只一份 · 三条路都走它 ·
#             格名与包名形状只**复用**不另抄）；**变异**：把那处 guard 改坏（两处接线各拔一次）⇒ **红**。
#   S6 (=⑥) 🔴 **不过度拒**：没有数据格的 app **照旧打包**；干净只读的场景**照旧通**；
#             ★ 负向对照：不许"一律拒"。
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
echo '── S1–S4／S6：临时目录里用**真代码**（不碰线上、不碰真数据目录）'
# ══════════════════════════════════════════════════════════════════

cat > "$T/ns-probe.mjs" <<'NODE'
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
const { AppWorkspaces, snapshotWorkspace } = await mod('workspace.js');
const { DATA_SHAPE_FILENAME, buildDataShape } = await mod('data-shape.js');
const {
  DataNamespaceError, adjudicateDataAccess, dataNamespaceList, dataNamespaceRead, dataNamespaceWrite,
} = await mod('data-namespace.js');

let seq = 0;
const tmp = (tag) => nodeFs.mkdtempSync(nodePath.join(T, `${tag}-${seq++}-`));
function world(tag) {
  const dir = tmp(tag);
  return { dir, apps: new Apps({ dir, sub: 'u1' }), workspaces: new AppWorkspaces({ dir, log: () => {} }) };
}
const KEYS = [{ name: 'id', type: 'string', null: 'never', dedup: true }];
const shapeText = (packs = ['news']) => JSON.stringify(buildDataShape(packs.map((pack) => ({ pack, keys: KEYS }))));

function buildScope(w, { id = 'mall', packs = ['news'], declare = true, values = [] } = {}) {
  w.workspaces.ensure(id, { title: id, entry: 'index.html' });
  w.workspaces.write(id, {
    'index.html': `<!doctype html><p>${id}</p>`,
    ...(declare ? { [DATA_SHAPE_FILENAME]: shapeText(packs) } : {}),
  });
  for (const [pack, rel, text] of values) {
    const cell = nodePath.join(w.workspaces.dirFor(id), '.data', pack);
    nodeFs.mkdirSync(nodePath.dirname(nodePath.join(cell, rel)), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(cell, rel), text);
  }
  return { id };
}

/** 整棵树逐文件 sha256（判"零残留"用）。 */
function treeSha(root) {
  const out = [];
  const walk = (rel) => {
    let entries = [];
    try { entries = nodeFs.readdirSync(rel === '' ? root : nodePath.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const next = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) { out.push(`${next}/`); walk(next); continue; }
      out.push(`${next}:${nodeCrypto.createHash('sha256').update(nodeFs.readFileSync(nodePath.join(root, next))).digest('hex')}`);
    }
  };
  walk('');
  return out.join('\n');
}

process.on('uncaughtException', (e) => {
  console.log(`BAD probe :: 探针崩了（算不出来） ;; ${String(e?.stack ?? e).slice(0, 300)}`);
  process.exitCode = 1;
});

// ── S1 (=①) 契约＝声明：没声明 ⇒ 拒；补上 ⇒ 过 ────────────────────
try {
  const w = world('S1');
  buildScope(w, { id: 'mall', declare: false, values: [['news', 'rows.json', '{"id":"a"}']] });
  const tries = [
    caught(() => dataNamespaceRead({ workspaces: w.workspaces, id: 'mall', pack: 'news', rel: 'rows.json' })),
    caught(() => dataNamespaceWrite({ workspaces: w.workspaces, id: 'mall', pack: 'news', rel: 'x.json', content: 'x' })),
    caught(() => dataNamespaceList({ workspaces: w.workspaces, id: 'mall', pack: 'news' })),
  ];
  const refused = tries.filter((e) => e instanceof DataNamespaceError).length;
  const visible = tries.every((e) => /news/.test(e?.message ?? '') && /data-shape\.json/.test(e?.message ?? ''));
  // ★ 负向对照：补上一份只写形状的声明 ⇒ 过
  w.workspaces.write('mall', { [DATA_SHAPE_FILENAME]: shapeText(['news']) });
  const read = dataNamespaceRead({ workspaces: w.workspaces, id: 'mall', pack: 'news', rel: 'rows.json' });
  const ctrlOk = read.content.toString('utf8') === '{"id":"a"}';
  // ★ 负向对照二：声明里没有的那一包照旧拒
  const other = caught(() => dataNamespaceList({ workspaces: w.workspaces, id: 'mall', pack: 'weather' }));
  const notBlanket = other instanceof DataNamespaceError;
  if (refused === 3 && visible && ctrlOk && notBlanket) {
    ok('S1', '🔴 契约＝声明：没声明的那一格 ⇒ 三条路全拒（fail-closed，理由点名哪一格／缺哪份文件）',
      `3/3 拒 · 理由含「news」与「${'data-shape.json'}」· **负向对照**：补上只写形状的声明 ⇒ 过 · 声明外那一包照旧拒`);
  } else {
    bad('S1', '契约＝声明', `拒了 ${refused}/3；理由可见=${visible}；补上过=${ctrlOk}；声明外也拒=${notBlanket}`);
  }
} catch (e) {
  bad('S1', '契约＝声明', `**不可算**（${e?.message ?? e}）`);
}

// ── S2 (=②) 同 app 跨 pack ⇒ 拒；自己取自己 ⇒ 过 ─────────────────
try {
  const w = world('S2');
  buildScope(w, {
    id: 'mall', packs: ['news', 'weather'],
    values: [['news', 'rows.json', '新闻的值'], ['weather', 'rows.json', '天气的值']],
  });
  const tries = [
    caught(() => dataNamespaceRead({ workspaces: w.workspaces, id: 'mall', pack: 'weather', rel: 'rows.json', callerPack: 'news' })),
    caught(() => dataNamespaceWrite({ workspaces: w.workspaces, id: 'mall', pack: 'weather', rel: 'x', content: 'x', callerPack: 'news' })),
    caught(() => dataNamespaceList({ workspaces: w.workspaces, id: 'mall', pack: 'weather', callerPack: 'news' })),
  ];
  const refused = tries.filter((e) => e instanceof DataNamespaceError).length;
  const saysCross = tries.every((e) => /跨命名空间/.test(e?.message ?? ''));
  const reverse = caught(() => dataNamespaceRead({ workspaces: w.workspaces, id: 'mall', pack: 'news', rel: 'rows.json', callerPack: 'weather' }));
  const reverseOk = reverse instanceof DataNamespaceError;
  // ★ 负向对照：自己取自己 ⇒ 过，且拿到自己那一格的值
  const mine = dataNamespaceRead({ workspaces: w.workspaces, id: 'mall', pack: 'news', rel: 'rows.json', callerPack: 'news' });
  const ctrlOk = mine.content.toString('utf8') === '新闻的值' && /\/\.data\/news$/.test(mine.dir);
  if (refused === 3 && saysCross && reverseOk && ctrlOk) {
    ok('S2', '🔴 命名空间隔离：同 app 跨 pack ⇒ 取／写／列三条路全拒；自己取自己 ⇒ 过',
      `3/3 拒且理由说"跨命名空间" · 反向也拒 · **负向对照**：自己取自己读到自己那一格（${mine.dir.replace(T, '…')}）`);
  } else {
    bad('S2', '命名空间隔离', `拒了 ${refused}/3；理由对=${saysCross}；反向拒=${reverseOk}；自己取自己过=${ctrlOk}`);
  }
} catch (e) {
  bad('S2', '命名空间隔离', `**不可算**（${e?.message ?? e}）`);
}

// ── S3 (=③) 跨 app 两个方向都拒；自己那份照旧读得到 ─────────────
try {
  const w = world('S3');
  buildScope(w, { id: 'aaa', values: [['news', 'rows.json', 'aaa 的值']] });
  buildScope(w, { id: 'bbb', values: [['news', 'rows.json', 'bbb 的值']] });
  const e1 = caught(() => dataNamespaceRead({ workspaces: w.workspaces, id: 'aaa', pack: 'news', rel: 'rows.json', callerId: 'bbb', callerPack: 'news' }));
  const e2 = caught(() => dataNamespaceWrite({ workspaces: w.workspaces, id: 'bbb', pack: 'news', rel: 'x', content: 'x', callerId: 'aaa', callerPack: 'news' }));
  const both = e1 instanceof DataNamespaceError && e2 instanceof DataNamespaceError
    && /跨 app/.test(e1.message) && /跨 app/.test(e2.message);
  const ctrlA = dataNamespaceRead({ workspaces: w.workspaces, id: 'aaa', pack: 'news', rel: 'rows.json' }).content.toString('utf8');
  const ctrlB = dataNamespaceRead({ workspaces: w.workspaces, id: 'bbb', pack: 'news', rel: 'rows.json' }).content.toString('utf8');
  const ctrlOk = ctrlA === 'aaa 的值' && ctrlB === 'bbb 的值';
  if (both && ctrlOk) {
    ok('S3', '🔴 跨 app 隔离：`bbb→aaa` 与 `aaa→bbb` 两个方向都拒',
      '两个方向都拒且理由说"跨 app" · **负向对照**：各自的 `.data/` 照旧读得到（aaa／bbb 各读到自己的值）');
  } else {
    bad('S3', '跨 app 隔离', `两个方向都拒=${both}；自己那份照旧读=${ctrlOk}`);
  }
} catch (e) {
  bad('S3', '跨 app 隔离', `**不可算**（${e?.message ?? e}）`);
}

// ── S4 (=④) 越界零残留；★ 对照：合法写真的改盘 ────────────────────
try {
  const w = world('S4');
  buildScope(w, { id: 'aaa', values: [['news', 'rows.json', 'aaa 的值']] });
  buildScope(w, { id: 'bbb', values: [['news', 'rows.json', 'bbb 的值']] });
  const before = treeSha(w.dir);
  const attempts = [
    () => dataNamespaceRead({ workspaces: w.workspaces, id: 'aaa', pack: 'news', rel: 'rows.json', callerId: 'bbb' }),
    () => dataNamespaceWrite({ workspaces: w.workspaces, id: 'aaa', pack: 'news', rel: 'sneak.json', content: 'x', callerId: 'bbb' }),
    () => dataNamespaceWrite({ workspaces: w.workspaces, id: 'aaa', pack: 'news', rel: 'deep/sneak.json', content: 'x', callerPack: 'weather' }),
    () => dataNamespaceRead({ workspaces: w.workspaces, id: 'aaa', pack: 'news', rel: '../../bbb/.data/news/rows.json' }),
    () => dataNamespaceWrite({ workspaces: w.workspaces, id: 'aaa', pack: 'news', rel: '../escape.json', content: 'x' }),
  ];
  const errs = attempts.map((fn) => caught(fn));
  const allRefused = errs.every((e) => e !== null);
  const after = treeSha(w.dir);
  const zeroResidue = after === before;
  const noSneak = !nodeFs.existsSync(nodePath.join(w.workspaces.dirFor('aaa'), '.data', 'news', 'sneak.json'))
    && !nodeFs.existsSync(nodePath.join(w.workspaces.dirFor('bbb'), '.data', 'news', 'escape.json'));
  // ★ 负向对照：合法写**真的**改动盘（证明上面那条不是恒等空跑）
  dataNamespaceWrite({ workspaces: w.workspaces, id: 'aaa', pack: 'news', rel: 'ok.json', content: 'ok' });
  const ctrlChanged = treeSha(w.dir) !== before;
  if (allRefused && zeroResidue && noSneak && ctrlChanged) {
    ok('S4', '🔴 越界尝试零残留：跨 app／跨包／`..` 逐个拒，跑完逐文件 sha256 复原',
      `5 种越界尝试全拒 · 整棵树 sha256 逐字复原 · 零新文件 · **负向对照**：一次合法写真改动了盘`);
  } else {
    bad('S4', '越界尝试零残留', `全拒=${allRefused}；复原=${zeroResidue}；无残留文件=${noSneak}；对照改盘=${ctrlChanged}`);
  }
} catch (e) {
  bad('S4', '越界尝试零残留', `**不可算**（${e?.message ?? e}）`);
}

// ── S6 (=⑥) 不过度拒 ────────────────────────────────────────────
try {
  const w = world('S6');
  w.workspaces.ensure('plain', { title: '素', entry: 'index.html' });
  w.workspaces.write('plain', { 'index.html': '<p>没有数据</p>' });
  const snap = snapshotWorkspace({ apps: w.apps, workspaces: w.workspaces, id: 'plain', title: '素', icon: 'dice' });
  const noOverRefuse = snap.shape.refused.length === 0 && snap.shape.declared === false;
  buildScope(w, { id: 'mall', values: [['news', 'rows.json', '值']] });
  const one = dataNamespaceList({ workspaces: w.workspaces, id: 'mall', pack: 'news' });
  const two = dataNamespaceList({ workspaces: w.workspaces, id: 'mall', pack: 'news' });
  const readOnlySame = JSON.stringify(one.files) === JSON.stringify(two.files) && JSON.stringify(one.files) === '["rows.json"]';
  const selfOk = adjudicateDataAccess({ callerApp: 'mall', callerPack: 'news', targetApp: 'mall', targetPack: 'news' }).app === 'mall';
  if (noOverRefuse && readOnlySame && selfOk) {
    ok('S6', '🔴 不过度拒：没有数据格的 app 照旧打包；干净只读照旧通',
      '没有数据格那一份如实记 `declared:false` 且不拦 · 列两次结果一致（读无副作用）· 自己取自己那份判定 ⇒ 过');
  } else {
    bad('S6', '不过度拒', `没数据格不拦=${noOverRefuse}；只读一致=${readOnlySame}；自己取自己过=${selfOk}`);
  }
} catch (e) {
  bad('S6', '不过度拒', `**不可算**（${e?.message ?? e}）`);
}

process.exitCode = 0;
NODE

OUT="$(HUPO_CORE="$CORE" HUPO_PROBE_TMP="$T" "$NODE" "$T/ns-probe.mjs" 2>&1)"
rc=$?
printf '%s\n' "$OUT" | grep '^OK  ' | sed 's/^OK  /  ✓ /'
printf '%s\n' "$OUT" | grep '^BAD ' | sed 's/^BAD /  ✗ /'
np="$(printf '%s\n' "$OUT" | grep -c '^OK  ' || true)"
nf="$(printf '%s\n' "$OUT" | grep -c '^BAD ' || true)"
pass=$((pass + np)); fail=$((fail + nf))
if [ "$rc" != "0" ] && [ "$nf" = "0" ]; then
  bad "S1–S4／S6 探针异常退出（rc=$rc）却没报哪一条 ⇒ 这些判据**不可算**"
fi
if [ "$nf" = "0" ] && [ "$np" -lt 5 ]; then
  bad "S1–S4／S6 应该出 5 条读数（S1/S2/S3/S4/S6），只读到 $np 条 ⇒ **不可算**"
fi

# ══════════════════════════════════════════════════════════════════
echo
echo '── S5 (=⑤)：源码级（规则只住一处）＋ 变异（把那处 guard 改坏 ⇒ 红）'
# ══════════════════════════════════════════════════════════════════

# ── S5a 源码扫描：边界判定只一份；三条路都走它；格名与包名形状只复用 ──
scan="$(HUPO_CORE="$CORE" "$NODE" -e '
const fs = require("node:fs");
const path = require("node:path");
const src = path.join(process.env.HUPO_CORE, "src");
const files = fs.readdirSync(src).filter((f) => f.endsWith(".js"));
const read = (f) => fs.readFileSync(path.join(src, f), "utf8");
const whole = files.map(read).join("\n");
const n = (re) => (whole.match(re) ?? []).length;
if (n(/export function adjudicateDataAccess\(/g) !== 1) { console.log("BAD 边界判定不止一份"); process.exit(0); }
if (n(/export function resolveDataNamespace\(/g) !== 1) { console.log("BAD 命名空间解析口不止一份"); process.exit(0); }
if (n(/callerApp !== targetApp/g) !== 1) { console.log("BAD `callerApp !== targetApp` 不止一处（有人另抄了判定）"); process.exit(0); }
if (n(/callerPack !== targetPack/g) !== 1) { console.log("BAD `callerPack !== targetPack` 不止一处"); process.exit(0); }
if (n(/export function checkPackName\(/g) !== 1) { console.log("BAD 包名形状的入口不止一份"); process.exit(0); }
if (n(/PACK_NAME_RE = /g) !== 1) { console.log("BAD 包名正则不止一份"); process.exit(0); }
if (n(/DATA_DIRNAME = /g) !== 1) { console.log("BAD 数据格名不止一处定义"); process.exit(0); }
const nsSrc = read("data-namespace.js");
for (const fn of ["dataNamespaceRead", "dataNamespaceWrite", "dataNamespaceList"]) {
  const at = nsSrc.indexOf("export function " + fn + "(");
  if (at < 0) { console.log("BAD " + fn + " 不在 data-namespace.js 里"); process.exit(0); }
  if (!/resolveDataNamespace\(/.test(nsSrc.slice(at, at + 900))) { console.log("BAD " + fn + " 没走那一个解析口"); process.exit(0); }
}
if (!/from \x27\.\/outbound\.js\x27/.test(nsSrc) || !/DATA_DIRNAME/.test(nsSrc)) { console.log("BAD 格名没有复用 outbound.DATA_DIRNAME"); process.exit(0); }
if (!/checkPackName/.test(nsSrc) || !/from \x27\.\/data-shape\.js\x27/.test(nsSrc)) { console.log("BAD 包名形状没有复用 data-shape.checkPackName"); process.exit(0); }
const withLiteral = files.filter((f) => read(f).includes("\x27data-shape.json\x27"));
if (withLiteral.length !== 1 || withLiteral[0] !== "data-shape.js") { console.log("BAD 固定名出现在 [" + withLiteral.join(",") + "]"); process.exit(0); }
console.log("OK 边界判定与解析口各一份；三条路（取／写／列）都走它；格名／包名形状只复用不另抄；固定名仍只在 data-shape.js");
' 2>&1)"
case "$scan" in
  OK*) ok "S5a ${scan#OK }" ;;
  *)   bad "S5a ${scan#BAD }（读不出 ⇒ 不可算）" ;;
esac

# ── S5b 变异：临时副本里把那处 guard 的两条接线各拔一次 ⇒ 两条判据都必须**红** ──
MUT="$T/mut"
mkdir -p "$MUT"
cp -r "$CORE/src" "$MUT/src"
ln -s "$CORE/node_modules" "$MUT/node_modules" 2>/dev/null || true
MUT_RESULT="$(HUPO_MUT="$MUT/src" "$NODE" -e '
const fs = require("node:fs");
const path = require("node:path");
const nsPath = path.join(process.env.HUPO_MUT, "data-namespace.js");
let s = fs.readFileSync(nsPath, "utf8");
// 变异 A：把"跨 app / 跨包"那两条判定拔掉（越界就进得去了）
const aApp = "if (callerApp !== targetApp) {";
const aPack = "if (callerPack !== targetPack) {";
if (!s.includes(aApp) || !s.includes(aPack)) { console.log("NOGUARD"); process.exit(0); }
s = s.replace(aApp, "if (false && callerApp !== targetApp) {");
s = s.replace(aPack, "if (false && callerPack !== targetPack) {");
// 变异 B：把"契约＝声明"那一条拔掉（没声明也取得到了）
const decl = "if (!carried) {";
if (!s.includes(decl)) { console.log("NODECL"); process.exit(0); }
s = s.replace(decl, "if (false && !carried) {");
fs.writeFileSync(nsPath, s);
console.log("MUTATED");
' 2>&1)"
if [ "$MUT_RESULT" != "MUTATED" ]; then
  bad "S5b 变异没做成（**不可算**）：$MUT_RESULT"
else
  cat > "$T/mut-probe.mjs" <<'NODE'
// 变异探针：只问四件事 —— 自己取自己还通吗？跨包／跨 app 还拦得住吗？没声明还拦得住吗？
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { pathToFileURL } from 'node:url';
const SRC = process.env.MUT_SRC;
const T = process.env.HUPO_PROBE_TMP;
const mod = (rel) => import(pathToFileURL(nodePath.join(SRC, rel)).href);
const { Apps } = await mod('apps.js');
const { AppWorkspaces } = await mod('workspace.js');
const { DATA_SHAPE_FILENAME, buildDataShape } = await mod('data-shape.js');
const { DataNamespaceError, dataNamespaceList, dataNamespaceRead } = await mod('data-namespace.js');
const caught = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const KEYS = [{ name: 'id', type: 'string', null: 'never', dedup: true }];
const shapeText = (packs) => JSON.stringify(buildDataShape(packs.map((pack) => ({ pack, keys: KEYS }))));
const dir = nodeFs.mkdtempSync(nodePath.join(T, 'mut-'));
const ws = new AppWorkspaces({ dir, log: () => {} });
const cell = (id, pack, rel, text) => {
  const p = nodePath.join(ws.dirFor(id), '.data', pack, rel);
  nodeFs.mkdirSync(nodePath.dirname(p), { recursive: true });
  nodeFs.writeFileSync(p, text);
};
// mall：两包都声明 ＋ 都有值（跨包那条要有东西才走得下去）
ws.ensure('mall', { title: 'm', entry: 'index.html' });
ws.write('mall', { 'index.html': '<p>m</p>', [DATA_SHAPE_FILENAME]: shapeText(['news', 'weather']) });
cell('mall', 'news', 'rows.json', '新闻的值');
cell('mall', 'weather', 'rows.json', '天气的值');
// aaa／bbb：各一包、都声明、都有值
for (const id of ['aaa', 'bbb']) {
  ws.ensure(id, { title: id, entry: 'index.html' });
  ws.write(id, { 'index.html': `<p>${id}</p>`, [DATA_SHAPE_FILENAME]: shapeText(['news']) });
  cell(id, 'news', 'rows.json', `${id} 的值`);
}
// 没声明的那一格（有字节、没声明）
ws.ensure('raw', { title: 'r', entry: 'index.html' });
ws.write('raw', { 'index.html': '<p>r</p>' });
cell('raw', 'news', 'rows.json', '没有声明的值');

const self = caught(() => dataNamespaceRead({ workspaces: ws, id: 'mall', pack: 'news', rel: 'rows.json' }));
console.log(`SELF_${self ? 'REFUSED' : 'OK'}`);
const crossPack = caught(() => dataNamespaceRead({ workspaces: ws, id: 'mall', pack: 'weather', rel: 'rows.json', callerPack: 'news' }));
console.log(`CROSSPACK_${crossPack instanceof DataNamespaceError ? 'REFUSED' : crossPack ? 'ERR' : 'ALLOWED'}`);
const crossApp = caught(() => dataNamespaceRead({ workspaces: ws, id: 'aaa', pack: 'news', rel: 'rows.json', callerId: 'bbb', callerPack: 'news' }));
console.log(`CROSSAPP_${crossApp instanceof DataNamespaceError ? 'REFUSED' : crossApp ? 'ERR' : 'ALLOWED'}`);
const undeclared = caught(() => dataNamespaceList({ workspaces: ws, id: 'raw', pack: 'news' }));
console.log(`UNDECLARED_${undeclared instanceof DataNamespaceError ? 'REFUSED' : undeclared ? 'ERR' : 'ALLOWED'}`);
NODE

  real="$(cd "$CORE" && HUPO_PROBE_TMP="$T" MUT_SRC="$CORE/src" "$NODE" "$T/mut-probe.mjs" 2>&1)"
  mut="$(cd "$CORE" && HUPO_PROBE_TMP="$T" MUT_SRC="$MUT/src" "$NODE" "$T/mut-probe.mjs" 2>&1)"
  echo "  · 真代码：$(printf '%s' "$real" | tr '\n' ' ')"
  echo "  · 变异后：$(printf '%s' "$mut" | tr '\n' ' ')"
  case "$real" in
    *SELF_OK*CROSSPACK_REFUSED*CROSSAPP_REFUSED*UNDECLARED_REFUSED*)
      ok 'S5b 正对照：真代码里"自己取自己通"且"跨包／跨 app／没声明"三条都拒' ;;
    *) bad "S5b 正对照：真代码里那四条本该成立（**不可算**）：$real" ;;
  esac
  case "$mut" in
    *CROSSPACK_ALLOWED*CROSSAPP_ALLOWED*)
      ok 'S5b 变异 A：拔掉跨 app／跨包那两条判定 ⇒ **越界真的进得去**了（证明那处 guard 承重）' ;;
    *) bad "S5b 变异 A：拔掉判定后越界居然还拒 ⇒ 要么拔错地方，要么别处还有一道闸（**红**）：$mut" ;;
  esac
  case "$mut" in
    *UNDECLARED_ALLOWED*)
      ok 'S5b 变异 B：拔掉"契约＝声明"那一条 ⇒ 没声明也**取得到了**（证明那处 guard 承重）' ;;
    *) bad "S5b 变异 B：拔掉声明闸后居然还拒 ⇒ 别处另有一套规则（**红**）：$mut" ;;
  esac
fi

# ── 判据自己也要有负向对照：核那份测试里真的有"对照" ───────────────────
TESTFILE="$CORE/test/data-namespace.test.js"
if [ ! -f "$TESTFILE" ]; then
  bad "找不到 test/data-namespace.test.js ⇒ S1–S6 的读法**不可算**"
else
  for marker in '负向对照' '零残留' '跨命名空间' '跨 app' '一律拒' '复原'; do
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
