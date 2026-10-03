// **92 §③ 阶段 5「三条登记边分开建」的判据**（契约 `docs/dev/92-TRIPLE-PLAN.md` §③ 阶段 5／§④）。
//
// ── 这一份钉什么（每条都带**负向对照**）──────────────────────
//   §5-1 🔴 **只改 `.exp/`**（内容与声明不动的那一部分）⇒ `rootHash`／`version`／
//          `shapeVersion` **均不变**。
//          对照：改 app 自己的字节 ⇒ `rootHash` **必须变**（不是"这个数永远不动"）。
//   §5-2 🔴 把"**来源**"塞进 app 血缘 ⇒ **红**（来源属于登记边，不属于能力体血缘）。
//          对照：正经的能力体版本边（白名单那四个键）⇒ 记得下来。
//   §5-3 🔴 **删血缘边 ⇒ 能力体仍能装能跑**（"可检查性 0"）。对照：删了之后
//          `capabilityEdgeOf` 核不出那个来源（说明这条边真的没在承重位上承重）。
//   §5-4 🔴 **能力体版本边"只增"**：`noteLineage` 没有任何删的路，追加之后旧边还在。
//   §5-5 🔴 **经验方法边（唯一有回流方向）**：**应用点**（先拍快照再动字节）＋
//          **回退点**（逐字节等于应用前）。对照：来源核不出 ⇒ **拒**（不应用、零残留）。
//   §5-6 🔴 **数据交付边：成对、永不回流**。对照：删掉同意 ⇒ `paired` 假 ＋ 交付失败。
//   §5-7 🔴 **共享库 index 能回指 `rootHash`**：index 里的起点 == 装上之后那一版的起点。
//          对照：把共享库 index 的起点改一个字 ⇒ **装不上**（不是"照着说"）。
//
// 🔴 **判据打在真调那些函数上**（V13）：`apps.noteLineage`／`capabilityEdgeOf`／
//    `MethodEdges.apply/rollback`／`Delivery.*`／`published.publish/installInto`，
//    不是这一份自己算一遍。
//
// ⚠️ 风格照仓库现有测试：不起 HTTP、不起进程；盘上用真临时目录。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { Apps, rootHashOf, sha256hex } from '../src/apps.js';
import { AppWorkspaces } from '../src/workspace.js';
import { Published } from '../src/published.js';
import {
  EDGE_KINDS,
  MethodEdgeError,
  MethodEdges,
  capabilityEdgeOf,
  methodEdgePath,
  readMethodEdges,
} from '../src/method-edge.js';
import {
  Delivery,
  EV_CONSENT,
  EV_DELIVER,
  EV_REQUEST,
  EV_REVOKE,
  edgeSummary,
  personaKeyOf,
  parseConsent,
} from '../src/delivery.js';
import { Store } from '../src/store.js';
import { ScopeView, Timeline } from '../src/timeline.js';

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});

function tmp(prefix = 'hupo-edges-s5-') {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** ★ A16：制品里必须有外联申报（读不到 ⇒ 上架拒）—— 带上它。 */
const DECL = JSON.stringify({
  schema: 1,
  outbound: [],
  declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '还没人用过，先按 0 报' },
});

const APP = { title: '新闻', icon: 'dice', entry: 'index.html' };

/** 一套：一个人（制品库 ＋ 工作区）＋ 共享库。 */
function world(tag = 'w') {
  const dir = tmp(`${tag}-`);
  const apps = new Apps({ dir, sub: 'u1' });
  const workspaces = new AppWorkspaces({ dir, log: () => {} });
  const published = new Published({ dir });
  return { dir, apps, workspaces, published };
}

/**
 * 一个**读者**：他自己的制品库在**自己那个目录**，但他读的是**作者那一份共享库**
 * （`<作者 dir>/published-apps/`）—— 这就是"装别人的"那条路的真实形状。
 */
function readerFor(author, tag = 'reader') {
  const dir = tmp(`${tag}-`);
  return {
    dir,
    apps: new Apps({ dir, sub: 'u2' }),
    workspaces: new AppWorkspaces({ dir, log: () => {} }),
    published: new Published({ dir: author.dir }),
  };
}

/** 造一个 app（**能力体走工作区**，这样 `.exp/` 才有地方放）。 */
function makeApp(w, id = 'news', body = '<p>第一版</p>') {
  w.workspaces.ensure(id, { title: APP.title, entry: APP.entry });
  w.workspaces.write(id, { 'index.html': body, 'outbound.json': DECL });
  const ws = w.workspaces.read(id);
  return w.apps.create({ id, ...APP, files: ws.files, createdBy: 'user' });
}

/** 往 `.exp/<pack>/` 写一份声明 ＋ 可选的附加文件。 */
function writePack(w, id, pack, json, extra = {}) {
  const dir = nodePath.join(w.workspaces.dirFor(id), '.exp', pack);
  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(dir, 'pack.json'),
    typeof json === 'string' ? json : `${JSON.stringify(json, null, 2)}\n`,
  );
  for (const [name, body] of Object.entries(extra)) nodeFs.writeFileSync(nodePath.join(dir, name), body);
}

/** 把"这一版现在长什么样"三个号一起读出来（判据 §5-1 就是比它们）。 */
function threeNumbers(w, id = 'news') {
  const v = w.apps.current(id);
  const m = w.apps.manifest(id, v);
  return { version: v, rootHash: m?.rootHash ?? null, shapeVersion: w.apps.shapeVersion(id) };
}

// ══════════════════════════════════════════════════════════════════
// §5-1 🔴 只改 `.exp/` ⇒ `rootHash`／`version`／`shapeVersion` 均不变
// ══════════════════════════════════════════════════════════════════

test('🔴 §5-1 只改 `.exp/` ⇒ rootHash／version／shapeVersion 均不变；对照：改 app 自己的字节 ⇒ rootHash 必变', () => {
  const w = world('s5-1');
  makeApp(w);
  const before = threeNumbers(w);
  assert.equal(before.version, 1, '前提：刚造的 app 是第 1 版');
  assert.equal(typeof before.rootHash, 'string');
  assert.equal(typeof before.shapeVersion, 'number');

  // ── ① 只往 `.exp/` 里加字节（**内容与声明不动**：不碰 app 的任何一个文件）──
  writePack(w, 'news', 'notes', {
    schema: 1, expVersion: 1, items: [{ path: 'notes.md', kind: 'note', share: false }],
  }, { 'notes.md': '攒下来的门道\n' });
  nodeFs.mkdirSync(nodePath.join(w.workspaces.dirFor('news'), '.exp', 'more'), { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(w.workspaces.dirFor('news'), '.exp', 'more', 'pack.json'),
    `${JSON.stringify({ schema: 1, outbound: 'never', items: [] })}\n`,
  );
  const afterExp = threeNumbers(w);
  assert.deepEqual(afterExp, before, '只改 `.exp/` ⇒ 三个号一个都不许变');

  // ── ② 对照：改 app **自己**的字节 ⇒ rootHash 必须变（不是"这个数永远不动"）──
  w.workspaces.write('news', { 'index.html': '<p>第二版</p>' });
  const m2 = w.apps.create({
    id: 'news', ...APP, files: w.workspaces.read('news').files, createdBy: 'user',
  });
  assert.notEqual(m2.rootHash, before.rootHash, '对照：能力体字节变了 ⇒ rootHash 必须变');
  assert.equal(m2.version, 2, '对照：新写一版 ⇒ version 变');
  assert.equal(w.apps.shapeVersion('news'), before.shapeVersion, '形状还是那一族 ⇒ shapeVersion 不变');
  // 而且改完能力体之后，`.exp/` 里那两份**照旧在**（没被顺手清掉）
  assert.ok(nodeFs.existsSync(methodEdgePath(w.workspaces.dirFor('news')).replace(/edges\.jsonl$/, 'notes/pack.json')));
});

// ══════════════════════════════════════════════════════════════════
// §5-2 🔴 把"来源"塞进 app 血缘 ⇒ 红；对照：正经的能力体版本边 ⇒ 记得下来
// ══════════════════════════════════════════════════════════════════

test('🔴 §5-2 把「来源」塞进 app 血缘 ⇒ 红（血缘只记能力体那一族）；对照：正经边记得下来', () => {
  const w = world('s5-2');
  const m1 = makeApp(w);
  w.workspaces.write('news', { 'index.html': '<p>改过的</p>' });
  const m2 = w.apps.create({
    id: 'news', ...APP, files: w.workspaces.read('news').files, createdBy: 'user',
  });

  // ── 🔴 经验的"来源"塞进血缘 ⇒ 当场拒 ──────────────────────────
  for (const bad of [
    { kind: 'fork', baseRootHash: m1.rootHash, baseVersion: 1, myVersion: 2, packId: 'notes' },
    { kind: 'fork', baseRootHash: m1.rootHash, baseVersion: 1, myVersion: 2, expVersion: 3 },
    { kind: 'fork', baseRootHash: m1.rootHash, baseVersion: 1, myVersion: 2, source: { app: 'other' } },
    { kind: 'fork', baseRootHash: m1.rootHash, baseVersion: 1, myVersion: 2, from: personaKeyOf('u1') },
  ]) {
    assert.throws(
      () => w.apps.noteLineage('news', bad),
      (err) => /血缘边只记能力体那一族/.test(err.message),
      `se 进去的键（${Object.keys(bad).filter((k) => !['kind', 'baseRootHash', 'baseVersion', 'myVersion'].includes(k)).join('、')}）必须当场拒`,
    );
  }
  assert.deepEqual(w.apps.lineage('news'), [], '被拒的那几条**一条都不许落盘**');

  // ── ★ 对照：白名单那四个键 ⇒ 记得下来，而且盘上有 ──────────────
  const edge = capabilityEdgeOf({
    apps: w.apps, id: 'news', baseRootHash: m1.rootHash, baseVersion: 1, myVersion: 2,
  });
  const rec = w.apps.noteLineage('news', edge);
  const onDisk = w.apps.lineage('news');
  assert.equal(onDisk.length, 1, '正经边必须真的落盘');
  assert.equal(onDisk[0].baseRootHash, m1.rootHash);
  assert.equal(rec.baseRootHash, m1.rootHash);
  // ★ 卡上：`lineage.json` 里**没有**任何经验／数据的来源字段
  const raw = nodeFs.readFileSync(
    nodePath.join(w.apps.appDir('news'), 'lineage.json'), 'utf8',
  );
  assert.ok(!/packId|expVersion|shapeVersion|"source"|"from"/.test(raw), '血缘文件里不许出现另一条边的字段名');
  assert.equal(m2.rootHash, w.apps.manifest('news', 2).rootHash);
});

// ══════════════════════════════════════════════════════════════════
// §5-3 🔴 删血缘边 ⇒ 能力体仍能装能跑（可检查性 0）
// ══════════════════════════════════════════════════════════════════

test('🔴 §5-3 删血缘边 ⇒ 能力体仍能装能跑；对照：删了之后那个来源就核不出来了', () => {
  const w = world('s5-3');
  const m1 = makeApp(w);
  w.workspaces.write('news', { 'index.html': '<p>改过的</p>' });
  const m2 = w.apps.create({
    id: 'news', ...APP, files: w.workspaces.read('news').files, createdBy: 'user',
  });
  w.apps.noteLineage('news', capabilityEdgeOf({
    apps: w.apps, id: 'news', baseRootHash: m1.rootHash, baseVersion: 1, myVersion: 2,
  }));

  // 前提：删之前，那个来源核得出来（`assertOutboundAllowed` 的血缘那一半）
  assert.equal(w.apps.lineage('news').length, 1, '前提：边在');

  // 🔴 把登记整个删掉（模拟"登记丢了"）
  nodeFs.rmSync(nodePath.join(w.apps.appDir('news'), 'lineage.json'));
  assert.deepEqual(w.apps.lineage('news'), [], '删除后读出来是空的（不猜）');

  // ── ① 能力体**照旧能读能跑**（读一个文件：逐字节核 hash 那条路） ──
  const read = w.apps.read('news', 2, 'index.html');
  assert.equal(read.content.toString('utf8'), '<p>改过的</p>');
  assert.equal(w.apps.manifest('news', 2).rootHash, m2.rootHash, 'rootHash 照旧');
  assert.equal(w.apps.current('news'), 2, '指针照旧');
  // ② **制品口那条路**（工作区镜像）照旧能把它读回来
  w.workspaces.read('news');
  // ③ 上架照旧能过（一条分享声明都没有 ⇒ 不拦；出界闸管的是"带出去"）
  const idx = w.published.publish(w.apps, { id: 'news', authorSub: 'u1', authorName: '甲' });
  assert.equal(idx.rootHash, m2.rootHash, '删血缘不许把"上架"拦死');
  // ④ **装**（复制模型）照旧 —— 共享库那一份在作者那个 `dir` 下，读者按同一条路取
  const reader = readerFor(w, 's5-3-reader');
  const inst = reader.published.installInto(reader.apps, 'news');
  assert.equal(reader.apps.manifest(inst.id, inst.version).rootHash, m2.rootHash, '装上那一版逐字同源');

  // ── ★ 对照：一个**核不出来**的来源 ⇒ 拒（说明"来源可核"那一半真的在判）──
  assert.throws(
    () => capabilityEdgeOf({
      apps: w.apps, id: 'news', baseRootHash: 'a'.repeat(64), baseVersion: 1, myVersion: 2,
    }),
    (err) => err instanceof MethodEdgeError && /核不出来/.test(err.message),
    '对照：核不出来的起点必须拒（自称的来源不算来源）',
  );
  // ⚠️ 如实记一笔：**删除登记**这件事本身不影响能力体 —— 它只让"来源"这一条**查不出来**，
  //    而"查不出来"不是"装不了"（可检查性 0 说的正是这个）。上面 ①–④ 就是那四个反着验。
  assert.deepEqual(w.apps.lineage('news'), []);
  assert.equal(w.apps.read('news', 2, 'index.html').content.toString('utf8'), '<p>改过的</p>');
});

// ══════════════════════════════════════════════════════════════════
// §5-4 🔴 能力体版本边"只增"
// ══════════════════════════════════════════════════════════════════

test('🔴 §5-4 能力体版本边「只增」：追加新边之后旧边逐字还在（没有任何删的路）', () => {
  const w = world('s5-4');
  makeApp(w);
  const e1 = w.apps.noteLineage('news', capabilityEdgeOf({
    apps: w.apps, id: 'news',
    baseRootHash: w.apps.manifest('news', 1).rootHash, baseVersion: 1, myVersion: 1,
  }));
  const e2 = w.apps.noteLineage('news', capabilityEdgeOf({
    apps: w.apps, id: 'news',
    baseRootHash: w.apps.manifest('news', 1).rootHash, baseVersion: 1, myVersion: 1,
  }));
  const all = w.apps.lineage('news');
  assert.equal(all.length, 2, '两次追加 ⇒ 两条都在（只增）');
  assert.deepEqual({ ...all[0], at: 0 }, { ...e1, at: 0 });
  assert.deepEqual({ ...all[1], at: 0 }, { ...e2, at: 0 });
  // ★ 对照：源码里**没有**任何删这条边的路（`Apps` 上只有 `noteLineage` 一个写者）
  const src = nodeFs.readFileSync(
    nodePath.resolve(nodePath.dirname(new URL(import.meta.url).pathname), '..', 'src', 'apps.js'), 'utf8',
  );
  const writers = [...src.matchAll(/^\s{2}(removeLineage|clearLineage|dropLineage|deleteLineage)\s*\(/gm)];
  assert.equal(writers.length, 0, '`apps.js` 里不许出现删血缘边的方法');
});

// ══════════════════════════════════════════════════════════════════
// §5-5 🔴 经验方法边：应用点 ＋ 回退点；来源核不出 ⇒ 拒
// ══════════════════════════════════════════════════════════════════

test('🔴 §5-5 方法边：应用点（先拍快照）＋ 回退点（逐字节等于应用前）；对照：来源核不出 ⇒ 拒、零残留', () => {
  const w = world('s5-5');
  const m1 = makeApp(w);
  const edges = new MethodEdges({ apps: w.apps, workspaces: w.workspaces, scope: 'news' });

  // ── 🔴 对照：来源核不出 ⇒ **拒**，而且盘上零残留（快照都不许拍） ──────
  const beforeVersions = nodeFs.readdirSync(w.apps.versionsDir('news')).length;
  assert.throws(
    () => edges.apply({
      packId: 'notes', shapeVersion: '1', why: '他说可以试试',
      source: { app: 'other', rootHash: 'f'.repeat(64), role: 'one-to-one' },
      bytes: { '.exp/notes/notes.md': '不该落下去\n' },
    }),
    (err) => err instanceof MethodEdgeError && /核不出来/.test(err.message),
    '自称的来源不算来源',
  );
  assert.equal(edges.list().length, 0, '被拒 ⇒ 一条边都不许落盘');
  assert.equal(
    nodeFs.readdirSync(w.apps.versionsDir('news')).length, beforeVersions,
    '被拒 ⇒ 一张快照都不许多拍（零残留）',
  );
  assert.ok(
    !nodeFs.existsSync(nodePath.join(w.workspaces.dirFor('news'), '.exp', 'notes')),
    '被拒 ⇒ 一个字节都不许落进工作区',
  );

  // ── ★ 应用点：来源 = **这一版自己**（可核）⇒ 先拍快照、再写字节 ────────
  const snapshotBefore = w.apps.manifest('news', w.apps.current('news')).rootHash;
  const { edge, snapshot, applied } = edges.apply({
    packId: 'notes',
    shapeVersion: '1',
    why: '他说"这份门道可以试试"',
    source: { app: 'news', rootHash: m1.rootHash, role: 'one-to-one' },
    bytes: { '.exp/notes/notes.md': '攒下来的门道\n' },
  });
  assert.equal(applied, true);
  assert.equal(snapshot.manifest.rootHash, snapshotBefore, '应用点那一版 = **应用前**工作区的指纹');
  assert.equal(edge.appliedRootHash, snapshotBefore);
  assert.equal(edge.appliedVersion, snapshot.manifest.version);
  assert.equal(edge.kind, EDGE_KINDS.method.kind);
  assert.equal(edge.source.rootHash, m1.rootHash);
  const onDisk = readMethodEdges({ scopeDir: w.workspaces.dirFor('news') });
  assert.equal(onDisk.length, 1, '边必须真的落盘（读盘，不是读内存）');
  assert.equal(onDisk[0].packId, 'notes');

  // 🔴 应用之后：字节真的在
  assert.equal(
    nodeFs.readFileSync(nodePath.join(w.workspaces.dirFor('news'), '.exp', 'notes', 'notes.md'), 'utf8'),
    '攒下来的门道\n',
  );
  // ★ **能力体那三个号：一个都没变**（经验不是能力体）
  assert.equal(w.apps.manifest('news', w.apps.current('news')).rootHash, m1.rootHash);
  assert.equal(w.apps.shapeVersion('news'), 1);

  // ── ★ 回退点：逐字节等于应用前 ────────────────────────────────
  const back = edges.rollback({ edge });
  assert.equal(back.restored, true);
  assert.equal(back.rootHash, edge.appliedRootHash, '回退后工作区指纹 == 应用前');
  // 逐字节核一个具体文件（不是只看指纹）
  assert.equal(
    nodeFs.readFileSync(nodePath.join(w.workspaces.dirFor('news'), 'index.html'), 'utf8'),
    '<p>第一版</p>',
  );
  // ⚠️ 回退**不动**那条边（边是登记，回退的是字节）—— 边照旧在盘上
  assert.equal(edges.list().length, 1);
});

// ══════════════════════════════════════════════════════════════════
// §5-6 🔴 数据交付边：成对、永不回流
// ══════════════════════════════════════════════════════════════════

/** 一套**真的**登记面：真 `Store` ＋ 真 `Timeline`（那条可见日志）＋ 真 `ScopeView`。 */
function registry() {
  const dataDir = tmp('s5-6-log-');
  const store = new Store({ dataDir, fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const view = new ScopeView({ timeline, scope: 'main' });
  const delivery = new Delivery({
    timeline: view,
    viewFor: (scope) => new ScopeView({ timeline, scope }),
  });
  return { dataDir, store, timeline, view, delivery };
}

test('🔴 §5-6 数据交付边：成对（请求→同意→交付）＋ 永不回流；对照：没有同意 ⇒ paired 假、交付失败', () => {
  const r = registry();
  const d = r.delivery;
  const from = personaKeyOf('u1');
  const to = personaKeyOf('u2');

  // ── ★ 一条**成对**的边 ─────────────────────────────────────
  d.request({ from, to, packId: 'rows', shapeVersion: '2', why: '他问能不能给一份' });
  const said = '同意把 rows 的 2 给他，范围 2026';
  const parsed = parseConsent({ said, packId: 'rows', shapeVersion: '2', range: '2026' });
  assert.ok(parsed, '前提：这是一句可识别的逐项同意');
  d.consent({ req: { from, to, packId: 'rows', shapeVersion: '2', range: '2026' }, said });
  d.deliver({ from, to, packId: 'rows', shapeVersion: '2', range: '2026' });

  const sum = edgeSummary({ records: d.list() });
  assert.equal(sum.edges.length, 1, '一条链 = 一条边');
  const e = sum.edges[0];
  assert.equal(e.kind, EDGE_KINDS.data.kind);
  assert.equal(e.from, from, '来源就是"给的人"那一端');
  assert.equal(e.to, to);
  assert.deepEqual(e.steps, { request: true, consent: true, delivered: true, revoked: false });
  assert.equal(e.paired, true, '成对：交付有同意、同意有请求');
  assert.equal(e.everReflowed, false, '🔴 永不回流（结构上的事实）');

  // ── 🔴 对照：**没有同意**的一条链 ⇒ `paired` 假，而且交付**失败** ──────
  const r2 = registry();
  const d2 = r2.delivery;
  d2.request({ from, to, packId: 'secret', shapeVersion: '1', why: '他问了' });
  // 直接把【交付】塞进去（绕开 `deliver()`）—— 模拟"盘上有人手写了一条"
  r2.timeline.emit({
    type: EV_DELIVER, chainId: `d:${from}:${to}:secret:1`, from, to, packId: 'secret', shapeVersion: '1',
  });
  const e2 = edgeSummary({ records: d2.list() }).edges.find((x) => x.packId === 'secret');
  assert.equal(e2.paired, false, '对照：没有同意的交付 ⇒ 不成对');
  assert.throws(
    () => d2.deliver({ from, to, packId: 'rows2', shapeVersion: '1' }),
    (err) => /同意/.test(err.message),
    '对照：无同意 ⇒ 交付必须失败',
  );

  // ── 撤回：只管**未来**，**不回流** ─────────────────────────────
  d.revoke({ from, to, packId: 'rows', shapeVersion: '2', why: '他说以后别给了' });
  const e3 = edgeSummary({ records: d.list() }).edges[0];
  assert.equal(e3.steps.revoked, true);
  assert.equal(e3.everReflowed, false, '🔴 撤回之后照旧**永不回流**（删不掉对面那份）');
  assert.equal(e3.revokedBeforeDeliver, false, '撤回在交付**之后**（取号判先后）');
  assert.throws(
    () => d.request({ from, to, packId: 'rows', shapeVersion: '2', why: '再要一次' }),
    (err) => /以后不给了/.test(err.message),
    '撤回后新请求一律拒',
  );
  assert.deepEqual(
    d.list().map((x) => x.type).sort(),
    [EV_CONSENT, EV_DELIVER, EV_REQUEST, EV_REVOKE].sort(),
    '四步都在（撤回不删任何一步）',
  );
});

// ══════════════════════════════════════════════════════════════════
// §5-7 🔴 共享库 index 能回指 rootHash；对照：改了那个起点 ⇒ 装不上
// ══════════════════════════════════════════════════════════════════

test('🔴 §5-7 共享库 index 回指 rootHash（装上那一版逐字同源）；对照：起点被改一个字 ⇒ 装不上', () => {
  const author = world('s5-7-a');
  const m1 = makeApp(author);
  author.published.publish(author.apps, { id: 'news', authorSub: 'u1', authorName: '甲' });

  // ── ★ index 里那条起点 == 制品那一版的起点 ────────────────────
  const idx = author.published.index('news');
  assert.equal(idx.rootHash, m1.rootHash, '共享库 index 必须回指 rootHash');
  assert.equal(idx.version, 1);
  // ★ 而**制品口那份清单**算出来的起点与它逐字相同（可复算，不是抄的）
  const m = author.apps.manifest('news', author.apps.current('news'));
  assert.equal(m.rootHash, idx.rootHash);

  // ── ★ 装上：复制进他自己那一格，起点**逐字相同** ────────────────
  const reader = readerFor(author, 's5-7-reader');
  const inst = reader.published.installInto(reader.apps, 'news');
  assert.equal(reader.apps.manifest(inst.id, inst.version).rootHash, idx.rootHash,
    '装上那一版的起点必须与 index 上那条逐字相同（复制模型）');

  // ── 🔴 对照：把共享库 index 的起点改一个字 ⇒ **装不上**（不是"照着说"）──
  const idxPath = nodePath.join(author.dir, 'published-apps', 'news', 'index.json');
  nodeFs.chmodSync(idxPath, 0o644);
  const j = JSON.parse(nodeFs.readFileSync(idxPath, 'utf8'));
  const flipped = `${j.rootHash.slice(0, -1)}${j.rootHash.endsWith('0') ? '1' : '0'}`;
  nodeFs.writeFileSync(idxPath, `${JSON.stringify({ ...j, rootHash: flipped }, null, 2)}\n`);
  const reader2 = readerFor(author, 's5-7-reader2');
  assert.throws(
    () => reader2.published.installInto(reader2.apps, 'news'),
    (err) => /登记的起点|rootHash|对不上/.test(err.message),
    '对照：index 的起点被改 ⇒ 必须拒装',
  );
  assert.equal(reader2.apps.has('news'), false, '对照：拒装 ⇒ 盘上零残留');

  // ── 🔴 另一条对照：把**字节**换掉（hash 不动）⇒ `read` 当场拒 ────────
  const vfile = nodePath.join(reader.apps.versionDir('news', 1), 'index.html');
  nodeFs.chmodSync(vfile, 0o644);
  nodeFs.writeFileSync(vfile, '<p>换过了</p>');
  assert.throws(
    () => reader.apps.read('news', 1, 'index.html'),
    (err) => /hash/.test(err.message),
    '对照：字节与清单对不上 ⇒ 读都读不出来',
  );
});
