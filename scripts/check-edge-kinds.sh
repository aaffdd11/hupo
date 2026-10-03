#!/usr/bin/env bash
# **92 §③ 阶段 5「三条登记边分开建」的闸**（离线那一列）
# （契约 `docs/dev/92-TRIPLE-PLAN.md` §③ 阶段 5 · §④ · 事实记录见
#   `docs/dev/161-EDGE-KINDS-GATE.md`）。
#
# 用法：
#   bash scripts/check-edge-kinds.sh
#
# 退出码 = 失败数（0 ⇒ 通过）；末尾固定打印 **`通过 N · 失败 M`**。
#
# ── 为什么不扩 `check-outbound-bridge.sh`（阶段 2／6 那条）──────────
#   那一条管的是**出界那一条独木桥**（声明带锚 · 出界那一刻的常驻断言）：它问的是
#   "**什么东西能出去**"。这一条管的是**登记**：三条边各自的**形状／方向／来源**是不是
#   分开的 —— 它问的是"**这件事记在哪、谁核得出来**"。两者的判据、机制、会坏的方式
#   都不一样（一条在 `published.publish` 上，一条在 `apps.noteLineage`／方法边／交付登记面上）。
#   混成一条会让"这条脚本红了到底是出界坏了还是登记坏了"说不清 ⇒ **新开一条**，
#   并在这里写明为什么不扩。⚠️ 那两条**一个字没改**（照旧绿）。
#
# ── 判据 K1–K7（照 §③ 那一行 ＋ §④ 抄；每条都带**负向对照**）──────
#   K1 🔴 **只改 `.exp/`**（内容与声明不动）⇒ `rootHash`／`version`／`shapeVersion` **均不变**
#         对照：改 app 自己的字节 ⇒ `rootHash` **必变**（不是"这个数永远不动"）
#   K2 🔴 把"**来源**"塞进 app 血缘 ⇒ **红**（来源属于登记边，不属于能力体血缘）
#         对照：正经的能力体版本边（白名单四个键）⇒ 记得下来
#   K3 🔴 **删血缘边 ⇒ 能力体仍能装能跑**（"可检查性 0"）
#         对照：`lineage.json` 整个删掉之后，`lineage()` 读到空（不猜；也不许把 app 拦死）
#   K4 🔴 **能力体版本边只增**（没有任何删的路）
#         对照：源码扫描 —— `apps.js` 里不存在删血缘边的方法
#   K5 🔴 **经验方法边（唯一有回流方向）**：**应用点**（先拍快照、再动字节）＋
#         **回退点**（逐字节等于应用前）
#         对照：来源核不出 ⇒ **拒**，且盘上零残留（快照都不许拍）
#   K6 🔴 **数据交付边：成对、永不回流**
#         对照：没有同意的交付 ⇒ `paired` 假，而且 `deliver()` 本身也拒
#   K7 🔴 **共享库 index 能回指 `rootHash`**（装上那一版逐字同源）
#         对照：把 index 上那条起点改一个字 ⇒ **装不上**；换掉字节 ⇒ 读都读不出来
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
echo '── K1–K7：临时目录里真调那三条边（**不碰线上、不碰真共享库**）'
# ══════════════════════════════════════════════════════════════════

cat > "$T/edges-probe.mjs" <<'NODE'
// 一次性探针：真代码（`src/` 里那几个模块）＋ 临时目录里的真盘。
// 输出协议：`OK `/`BAD ` 开头，交给外面那个 bash 数数并打印。
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
const { AppWorkspaces } = await mod('workspace.js');
const { Published } = await mod('published.js');
const {
  EDGE_KINDS, MethodEdgeError, MethodEdges, capabilityEdgeOf, methodEdgePath, readMethodEdges,
} = await mod('method-edge.js');
const { Delivery, edgeSummary, personaKeyOf, parseConsent } = await mod('delivery.js');
const { Store } = await mod('store.js');
const { ScopeView, Timeline } = await mod('timeline.js');

const APP = { title: '新闻', icon: 'dice', entry: 'index.html' };
// ★ A16：制品里必须有外联申报（读不到 ⇒ 上架拒）—— 带上它。
const DECL = JSON.stringify({
  schema: 1, outbound: [],
  declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '还没人用过，先按 0 报' },
});

let seq = 0;
function world(tag) {
  const dir = nodeFs.mkdtempSync(nodePath.join(T, `w-${tag}-${seq++}-`));
  return {
    dir,
    apps: new Apps({ dir, sub: 'u1' }),
    workspaces: new AppWorkspaces({ dir, log: () => {} }),
    published: new Published({ dir }),
  };
}
function readerFor(author, tag) {
  const dir = nodeFs.mkdtempSync(nodePath.join(T, `r-${tag}-${seq++}-`));
  return {
    dir,
    apps: new Apps({ dir, sub: 'u2' }),
    workspaces: new AppWorkspaces({ dir, log: () => {} }),
    published: new Published({ dir: author.dir }),
  };
}
function makeApp(w, id = 'news', body = '<p>第一版</p>') {
  w.workspaces.ensure(id, { title: APP.title, entry: APP.entry });
  w.workspaces.write(id, { 'index.html': body, 'outbound.json': DECL });
  return w.apps.create({ id, ...APP, files: w.workspaces.read(id).files, createdBy: 'user' });
}
const three = (w, id = 'news') => {
  const v = w.apps.current(id);
  return { version: v, rootHash: w.apps.manifest(id, v)?.rootHash ?? null, shapeVersion: w.apps.shapeVersion(id) };
};
function writePack(w, id, pack, json, extra = {}) {
  const dir = nodePath.join(w.workspaces.dirFor(id), '.exp', pack);
  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(dir, 'pack.json'), `${JSON.stringify(json, null, 2)}\n`);
  for (const [name, body] of Object.entries(extra)) nodeFs.writeFileSync(nodePath.join(dir, name), body);
}

// ── K1 🔴 只改 `.exp/` ⇒ 三个号均不变；对照：改能力体 ⇒ rootHash 必变 ──
try {
  const w = world('K1');
  makeApp(w);
  const before = three(w);
  writePack(w, 'news', 'notes', {
    schema: 1, expVersion: 1, items: [{ path: 'notes.md', kind: 'note', share: false }],
  }, { 'notes.md': '攒下来的门道\n' });
  const afterExp = three(w);
  // 对照：改 app **自己**的字节
  w.workspaces.write('news', { 'index.html': '<p>第二版</p>' });
  const m2 = w.apps.create({ id: 'news', ...APP, files: w.workspaces.read('news').files, createdBy: 'user' });
  const unchanged = JSON.stringify(afterExp) === JSON.stringify(before);
  const moved = m2.rootHash !== before.rootHash && m2.version === before.version + 1;
  if (unchanged && moved) {
    ok('K1', '🔴 只改 `.exp/` ⇒ `rootHash`／`version`／`shapeVersion` **均不变**',
      `三个号逐字相同（${before.rootHash.slice(0, 12)}… · v${before.version} · shape ${before.shapeVersion}）；`
      + `**负向对照**（改能力体字节）⇒ rootHash 变成 ${m2.rootHash.slice(0, 12)}…、version=${m2.version}`);
  } else {
    bad('K1', '只改 `.exp/` ⇒ 三个号不变',
      `不变=${unchanged}（改前 ${JSON.stringify(before)}；改后 ${JSON.stringify(afterExp)}）；对照真的变了=${moved}`);
  }
} catch (e) {
  bad('K1', '只改 `.exp/` ⇒ 三个号不变', `**不可算**（探针自己炸了：${e?.message ?? e}）`);
}

// ── K2 🔴 把"来源"塞进 app 血缘 ⇒ 红；对照：正经边记得下来 ──────────────
try {
  const w = world('K2');
  const m1 = makeApp(w);
  makeApp(w); // 前提：让第 2 版存在（对照那条边要指回 v1）
  w.workspaces.write('news', { 'index.html': '<p>改过的</p>' });
  const m2 = w.apps.create({ id: 'news', ...APP, files: w.workspaces.read('news').files, createdBy: 'user' });
  const FOREIGN = [
    { packId: 'notes' }, { expVersion: 3 }, { source: { app: 'other' } }, { from: personaKeyOf('u1') },
  ];
  let refusals = 0;
  let lastMsg = '';
  for (const extra of FOREIGN) {
    const err = caught(() => w.apps.noteLineage('news', {
      kind: 'fork', baseRootHash: m1.rootHash, baseVersion: 1, myVersion: 2, ...extra,
    }));
    if (err && /血缘边只记能力体那一族/.test(err.message)) { refusals += 1; lastMsg = err.message; }
  }
  const none = w.apps.lineage('news').length === 0;
  // 对照：白名单那四个键 ⇒ 记得下来
  const rec = w.apps.noteLineage('news', capabilityEdgeOf({
    apps: w.apps, id: 'news', baseRootHash: m1.rootHash, baseVersion: 1, myVersion: 2,
  }));
  const saved = w.apps.lineage('news').length === 1 && rec.baseRootHash === m1.rootHash;
  const raw = nodeFs.readFileSync(nodePath.join(w.apps.appDir('news'), 'lineage.json'), 'utf8');
  const clean = !/packId|expVersion|shapeVersion|"source"|"from"/.test(raw);
  if (refusals === FOREIGN.length && none && saved && clean && m2.rootHash) {
    ok('K2', '🔴 把「来源」塞进 app 血缘 ⇒ **红**（4 种塞法逐个拒）',
      `${FOREIGN.length} 种塞法全拒：「${lastMsg.slice(0, 46)}…」；被拒的**一条都没落盘**；`
      + '**负向对照**（白名单四个键）⇒ 记得下来，且 `lineage.json` 里没有另一条边的字段名');
  } else {
    bad('K2', '把来源塞进血缘 ⇒ 红',
      `拒了 ${refusals}/${FOREIGN.length}；没落盘=${none}；对照记得下来=${saved}；血缘干净=${clean}`);
  }
} catch (e) {
  bad('K2', '把来源塞进血缘 ⇒ 红', `**不可算**（${e?.message ?? e}）`);
}

// ── K3 🔴 删血缘边 ⇒ 能力体仍能装能跑；对照：读出来是空 ──────────────────
try {
  const w = world('K3');
  const m1 = makeApp(w);
  w.workspaces.write('news', { 'index.html': '<p>改过的</p>' });
  const m2 = w.apps.create({ id: 'news', ...APP, files: w.workspaces.read('news').files, createdBy: 'user' });
  w.apps.noteLineage('news', capabilityEdgeOf({
    apps: w.apps, id: 'news', baseRootHash: m1.rootHash, baseVersion: 1, myVersion: 2,
  }));
  nodeFs.rmSync(nodePath.join(w.apps.appDir('news'), 'lineage.json'));
  const empty = w.apps.lineage('news').length === 0;
  const readable = w.apps.read('news', 2, 'index.html').content.toString('utf8') === '<p>改过的</p>';
  const sameRoot = w.apps.manifest('news', 2).rootHash === m2.rootHash;
  const idx = w.published.publish(w.apps, { id: 'news', authorSub: 'u1', authorName: '甲' });
  const installed = readerFor(w, 'K3').published.installInto(readerFor(w, 'K3').apps, 'news');
  if (empty && readable && sameRoot && idx.rootHash === m2.rootHash && installed.version >= 1) {
    ok('K3', '🔴 **删血缘边 ⇒ 能力体仍能装能跑**（可检查性 0）',
      '删掉 `lineage.json` 之后：读文件逐字节对得上 · `rootHash` 照旧 · 上架照旧过 · 装上照旧成；'
      + '**负向对照**：`lineage()` 读到空（不猜），而**上架没被拦死**');
  } else {
    bad('K3', '删血缘边 ⇒ 能力体仍能装能跑',
      `读出来空=${empty}；文件读得回=${readable}；rootHash 照旧=${sameRoot}；上架 rootHash 对=${idx?.rootHash === m2.rootHash}`);
  }
} catch (e) {
  bad('K3', '删血缘边 ⇒ 能力体仍能装能跑', `**不可算**（${e?.message ?? e}）`);
}

// ── K4 🔴 能力体版本边"只增" ─────────────────────────────────────────
try {
  const w = world('K4');
  makeApp(w);
  const mk = () => capabilityEdgeOf({
    apps: w.apps, id: 'news',
    baseRootHash: w.apps.manifest('news', 1).rootHash, baseVersion: 1, myVersion: 1,
  });
  w.apps.noteLineage('news', mk());
  w.apps.noteLineage('news', mk());
  const all = w.apps.lineage('news');
  const grew = all.length === 2 && all[0].baseRootHash === all[1].baseRootHash;
  // 对照：源码里没有任何删这条边的方法
  const src = nodeFs.readFileSync(nodePath.join(CORE, 'src', 'apps.js'), 'utf8');
  const killers = [...src.matchAll(/^\s{2}(removeLineage|clearLineage|dropLineage|deleteLineage)\s*\(/gm)].length;
  if (grew && killers === 0) {
    ok('K4', '🔴 能力体版本边「**只增**」（没有任何删的路）',
      `两次追加 ⇒ 盘上两条都在；**负向对照**：源码扫描 apps.js 里删血缘边的方法 = ${killers} 个`);
  } else {
    bad('K4', '能力体版本边只增', `两条都在=${grew}（实际 ${all.length} 条）；删的方法=${killers} 个`);
  }
} catch (e) {
  bad('K4', '能力体版本边只增', `**不可算**（${e?.message ?? e}）`);
}

// ── K5 🔴 方法边：应用点 ＋ 回退点；对照：来源核不出 ⇒ 拒、零残留 ────────
try {
  const w = world('K5');
  const m1 = makeApp(w);
  const edges = new MethodEdges({ apps: w.apps, workspaces: w.workspaces, scope: 'news' });
  const vBefore = nodeFs.readdirSync(w.apps.versionsDir('news')).length;
  const refused = caught(() => edges.apply({
    packId: 'notes', shapeVersion: '1', why: '他说可以试试',
    source: { app: 'other', rootHash: 'f'.repeat(64), role: 'one-to-one' },
    bytes: { '.exp/notes/notes.md': '不该落下去\n' },
  }));
  const noEdge = readMethodEdges({ scopeDir: w.workspaces.dirFor('news') }).length === 0;
  const noSnap = nodeFs.readdirSync(w.apps.versionsDir('news')).length === vBefore;
  const noBytes = !nodeFs.existsSync(nodePath.join(w.workspaces.dirFor('news'), '.exp', 'notes'));

  const beforeVersion = w.apps.current('news');
  const before = w.apps.manifest('news', beforeVersion).rootHash;
  const beforeShape = w.apps.shapeVersion('news');
  const { edge, snapshot, applied } = edges.apply({
    packId: 'notes', shapeVersion: '1', why: '他说这份门道可以试试',
    source: { app: 'news', rootHash: m1.rootHash, role: 'one-to-one' },
    bytes: { '.exp/notes/notes.md': '攒下来的门道\n' },
  });
  const snapIsBefore = snapshot.manifest.rootHash === before;
  const bytesLanded = nodeFs.readFileSync(
    nodePath.join(w.workspaces.dirFor('news'), '.exp', 'notes', 'notes.md'), 'utf8',
  ) === '攒下来的门道\n';
  // ★ 三个号：**形状与内容一个都没变**。
  //   ⚠️ 如实说清一处：`apply()` 的**应用点**本身会拍一张快照（那是"回退点"的实现方式：
  //      多留一版**同内容**的登记版本），所以 `version` 这个**指针**会往前走一格 ——
  //      但那不是"经验改了能力体"：新那一版的 `rootHash`（内容）与 `schema`（形状）
  //      与改 `.exp/` **之前**逐字相同（`snapIsBefore` 就是这一条）。
  //      判据要问的是"经验有没有变成能力体的一部分"，答案在内容与形状上，不在指针上。
  const threeSame = w.apps.manifest('news', w.apps.current('news')).rootHash === before
    && w.apps.shapeVersion('news') === beforeShape
    && w.apps.manifest('news', w.apps.current('news')).rootHash === snapshot.manifest.rootHash;
  const back = edges.rollback({ edge });
  const byte = nodeFs.readFileSync(nodePath.join(w.workspaces.dirFor('news'), 'index.html'), 'utf8') === '<p>第一版</p>';
  const okAll = refused instanceof MethodEdgeError && noEdge && noSnap && noBytes
    && applied === true && snapIsBefore && bytesLanded && threeSame
    && back.restored === true && back.rootHash === before && byte;
  if (okAll) {
    ok('K5', '🔴 **方法边（唯一有回流方向）**：应用点（先拍快照）＋ 回退点（逐字节等于应用前）',
      `应用前快照 = ${before.slice(0, 12)}…（**先拍后写**）；回退后工作区指纹 == 应用前、入口文件逐字节相等；`
      + '应用前后**内容（rootHash）与形状（shapeVersion）逐字相同**（指针版号会 +1 —— 那正是应用点多留的那一版登记）；'
      + `**负向对照**（来源核不出）⇒ ${refused.name}：${refused.message.slice(0, 30)}…，盘上零残留`);
  } else {
    bad('K5', '方法边：应用点＋回退点',
      `拒=${refused?.name ?? '没拒'}；零残留=${noEdge && noSnap && noBytes}；`
      + `快照=应用前=${snapIsBefore}；字节落了=${bytesLanded}；三个号没变=${threeSame}；`
      + `回退逐字节=${back?.restored === true && back?.rootHash === before && byte}`);
  }
} catch (e) {
  bad('K5', '方法边：应用点＋回退点', `**不可算**（${e?.message ?? e}）`);
}

// ── K6 🔴 数据交付边：成对、永不回流；对照：没同意 ⇒ paired 假 ＋ 交付拒 ──
try {
  const mkReg = () => {
    const dataDir = nodeFs.mkdtempSync(nodePath.join(T, `log-${seq++}-`));
    const store = new Store({ dataDir, fsync: false });
    const timeline = new Timeline({ id: 'main', store });
    const view = new ScopeView({ timeline, scope: 'main' });
    return { timeline, delivery: new Delivery({ timeline: view, viewFor: (s) => new ScopeView({ timeline, scope: s }) }) };
  };
  const from = personaKeyOf('u1');
  const to = personaKeyOf('u2');
  const r = mkReg();
  r.delivery.request({ from, to, packId: 'rows', shapeVersion: '2', why: '他问能不能给一份' });
  const said = '同意把 rows 的 2 给他，范围 2026';
  const parsed = parseConsent({ said, packId: 'rows', shapeVersion: '2', range: '2026' });
  if (!parsed) throw new Error('前提不成立：那句同意认不出来');
  r.delivery.consent({ req: { from, to, packId: 'rows', shapeVersion: '2', range: '2026' }, said });
  r.delivery.deliver({ from, to, packId: 'rows', shapeVersion: '2', range: '2026' });
  const e = edgeSummary({ records: r.delivery.list() }).edges[0];
  const pair = e.paired === true && e.from === from && e.to === to;
  const noReflow = e.everReflowed === false;
  // 对照：没有同意的一条链
  const r2 = mkReg();
  r2.delivery.request({ from, to, packId: 'secret', shapeVersion: '1', why: '他问了' });
  r2.timeline.emit({
    type: 'delivery/deliver', chainId: `d:${from}:${to}:secret:1`,
    from, to, packId: 'secret', shapeVersion: '1',
  });
  const e2 = edgeSummary({ records: r2.delivery.list() }).edges.find((x) => x.packId === 'secret');
  const ctrlUnpaired = e2?.paired === false;
  const ctrlRefused = caught(() => r2.delivery.deliver({ from, to, packId: 'none', shapeVersion: '1' }));
  // 撤回：只管未来，照旧不回流
  r.delivery.revoke({ from, to, packId: 'rows', shapeVersion: '2', why: '他说以后别给了' });
  const e3 = edgeSummary({ records: r.delivery.list() }).edges[0];
  const revokeFutureOnly = e3.everReflowed === false && e3.steps.revoked === true;
  if (pair && noReflow && ctrlUnpaired && ctrlRefused && revokeFutureOnly) {
    ok('K6', '🔴 **数据交付边：成对、永不回流**',
      '一条链 = 一条边（请求→同意→交付，成对）；撤回后 everReflowed 照旧 false（不删对面那份）；'
      + `**负向对照**：没有同意的交付 ⇒ \`paired\`=false，而且 \`deliver()\` 自己拒（${ctrlRefused.name}）`);
  } else {
    bad('K6', '数据交付边：成对、永不回流',
      `成对=${pair}；不回流=${noReflow}；对照不成对=${ctrlUnpaired}；对照交付拒=${Boolean(ctrlRefused)}；撤回只管未来=${revokeFutureOnly}`);
  }
} catch (e) {
  bad('K6', '数据交付边：成对、永不回流', `**不可算**（${e?.message ?? e}）`);
}

// ── K7 🔴 共享库 index 回指 rootHash；对照：改一个字 ⇒ 装不上 ───────────
try {
  const author = world('K7');
  const m1 = makeApp(author);
  author.published.publish(author.apps, { id: 'news', authorSub: 'u1', authorName: '甲' });
  const idx = author.published.index('news');
  const points = idx.rootHash === m1.rootHash;
  const recomputed = author.apps.manifest('news', author.apps.current('news')).rootHash === idx.rootHash;
  const reader = readerFor(author, 'K7');
  const inst = reader.published.installInto(reader.apps, 'news');
  const sameRoot = reader.apps.manifest(inst.id, inst.version).rootHash === idx.rootHash;
  // 对照：把 index 的起点改一个字
  const idxPath = nodePath.join(author.dir, 'published-apps', 'news', 'index.json');
  nodeFs.chmodSync(idxPath, 0o644);
  const j = JSON.parse(nodeFs.readFileSync(idxPath, 'utf8'));
  const flipped = `${j.rootHash.slice(0, -1)}${j.rootHash.endsWith('0') ? '1' : '0'}`;
  nodeFs.writeFileSync(idxPath, `${JSON.stringify({ ...j, rootHash: flipped }, null, 2)}\n`);
  const reader2 = readerFor(author, 'K7b');
  const refused = caught(() => reader2.published.installInto(reader2.apps, 'news'));
  const noResidue = reader2.apps.has('news') === false;
  if (points && recomputed && sameRoot && refused && noResidue) {
    ok('K7', '🔴 **共享库 index 能回指 `rootHash`**（装上那一版逐字同源）',
      `index.rootHash == 制品那一版的起点（${String(idx.rootHash).slice(0, 12)}…，可复算）；装上之后逐字相同；`
      + `**负向对照**：index 上那条起点改一个字 ⇒ 装不上（${refused.name}），盘上零残留`);
  } else {
    bad('K7', '共享库 index 回指 rootHash',
      `回指=${points}；可复算=${recomputed}；装上同源=${sameRoot}；对照拒装=${Boolean(refused)}；零残留=${noResidue}`);
  }
} catch (e) {
  bad('K7', '共享库 index 回指 rootHash', `**不可算**（${e?.message ?? e}）`);
}

process.exitCode = 0;
NODE

OUT="$(HUPO_CORE="$CORE" HUPO_PROBE_TMP="$T" "$NODE" "$T/edges-probe.mjs" 2>&1)"
rc=$?
sed 's/^/  /' <<<"$OUT"
np="$(grep -c '^OK ' <<<"$OUT" || true)"
nf="$(grep -c '^BAD ' <<<"$OUT" || true)"
pass=$((pass + np)); fail=$((fail + nf))
if [ "$rc" != "0" ] && [ "$nf" = "0" ]; then
  bad "K1–K7 探针异常退出（rc=$rc）却没报哪一条 ⇒ 这些判据**不可算**"
fi
if [ "$nf" = "0" ] && [ "$np" -lt 7 ]; then
  bad "K1–K7 应该出 7 条读数（K1/K2/K3/K4/K5/K6/K7），只读到 $np 条 ⇒ **不可算**"
fi

# ══════════════════════════════════════════════════════════════════
echo
echo "── 源码级：这三条边各自的形状**都写在 method-edge.js 一处**（不许两处各写一份）"
# ══════════════════════════════════════════════════════════════════

SCAN="$(cd "$CORE" && "$NODE" --input-type=module -e "
import nodeFs from 'node:fs';
import nodePath from 'node:path';
const f = nodePath.resolve('src', 'method-edge.js');
const c = nodeFs.readFileSync(f, 'utf8');
const kinds = ['capability', 'method', 'data'].filter((k) => new RegExp('\\\\b' + k + ':').test(c));
console.log(kinds.join(','));
" 2>&1 || true)"
if [ "$SCAN" = "capability,method,data" ]; then
  ok "源码级：三条边在 EDGE_KINDS 里各有一条（[$SCAN]）"
else
  bad "源码级：三条边在 EDGE_KINDS 里读出来是 [$SCAN] ⇒ 不是三条各一份"
fi

# ── 判据自己也要有负向对照：核那份测试里真的有"对照" ───────────────────
TESTFILE="$CORE/test/edges-three-kinds.test.js"
if [ ! -f "$TESTFILE" ]; then
  bad "找不到 test/edges-three-kinds.test.js ⇒ K1–K7 的读法**不可算**"
else
  for marker in '对照' '核不出来' 'paired' 'everReflowed' '回指'; do
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
