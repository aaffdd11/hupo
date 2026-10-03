// **形状声明：随 fork 走、值永不随**（`D4.24` · A1 · 2026-10-03）—— 离线判据。
//
// 事实与理由见 `docs/dev/165-DATA-SHAPE-FORK.md`；闸脚本 `scripts/check-data-shape.sh`。
//
// 这一份钉五件（每条都带**负向对照**）：
//   D1 把"值"塞进形状声明 ⇒ 拒（且**盘上零残留**）；只写形状 ⇒ 过
//   D2 只改数据的值 ⇒ 形状的号**逐字不变**；改形状 ⇒ 号**必变**（两个方向）
//   D3 fork／装上 ⇒ 值一个字节都不随，而形状在（同一份指纹）
//   D4 规则只住一处（源码级——`DATA_SHAPE_FILENAME` 与判据本体只在 `data-shape.js`）
//   D5 没声明 ⇒ 最严（拒，且理由**看得见**）；补上声明 ⇒ 过

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { Apps, MAX_ID_CHARS } from '../src/apps.js';
import { handleAppsOp } from '../src/apps-socket.js';
import { Published } from '../src/published.js';
import {
  DATA_SHAPE_FILENAME,
  DataShapeError,
  MAX_PACK_NAME_CHARS,
  buildDataShape,
  dataShapeDigest,
  parseDataShape,
  shapeVersionOf,
} from '../src/data-shape.js';
import {
  AppWorkspaces,
  mirrorArtifactIntoWorkspace,
  snapshotWorkspace,
} from '../src/workspace.js';

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});
const tmp = () => {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-shape-'));
  tmpDirs.push(d);
  return d;
};

const OUTBOUND = JSON.stringify({
  schema: 1,
  outbound: [],
  declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '测试' },
});
const PACK_JSON = JSON.stringify({ schema: 1, outbound: 'one-to-one', items: [] });
const KEYS = [{ name: 'id', type: 'string', null: 'never', dedup: true }];
const shapeText = (keys = KEYS, pack = 'news') => JSON.stringify(buildDataShape([{ pack, keys }]));

const caught = (fn) => { try { fn(); return null; } catch (err) { return err; } };

/** 一个世界：制品库 ＋ 工作区 ＋（可选）共享库，同一个根。 */
function world(tag = 'w') {
  const dir = tmp();
  return {
    dir,
    apps: new Apps({ dir, sub: 'u1' }),
    workspaces: new AppWorkspaces({ dir, log: () => {} }),
    published: new Published({ dir }),
    tag,
  };
}

/** 这一间房：制品文件（含形状声明）＋ 数据格（值 ＋ `pack.json`）。 */
function buildScope(w, { id = 'news', shape = shapeText(), value = '第一份值', packJson = PACK_JSON } = {}) {
  w.workspaces.ensure(id, { title: '新闻', entry: 'index.html' });
  w.workspaces.write(id, {
    'index.html': '<!doctype html><p>新闻</p>',
    'outbound.json': OUTBOUND,
    ...(shape === null ? {} : { [DATA_SHAPE_FILENAME]: shape }),
  });
  const cell = nodePath.join(w.workspaces.dirFor(id), '.data', 'news');
  nodeFs.mkdirSync(cell, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(cell, 'pack.json'), `${packJson}\n`);
  nodeFs.writeFileSync(nodePath.join(cell, 'payload.json'), `${value}\n`);
  return { id, cell };
}

/** 整个目录树里的文本（用来搜哨兵）。 */
function dirText(root) {
  let out = '';
  const walk = (rel) => {
    let es = [];
    try { es = nodeFs.readdirSync(nodePath.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of es.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out += `${next}/\n`; walk(next); continue; }
      try { out += `${next}\n${nodeFs.readFileSync(nodePath.join(root, next), 'latin1')}\n`; } catch { /* 读不到就算了 */ }
    }
  };
  walk('');
  return out;
}

const versionCount = (w, id) => {
  try { return nodeFs.readdirSync(w.apps.versionsDir(id)).length; } catch { return 0; }
};

// ════════════════════════════════════════════════════════════════
// D1 · 值塞进形状声明 ⇒ 拒；只写形状 ⇒ 过；盘上零残留
// ════════════════════════════════════════════════════════════════

test('🔴 D1：把值塞进形状声明 ⇒ 人话拒，盘上零残留；负向对照：只写形状 ⇒ 过', () => {
  const w = world('D1');
  const good = JSON.parse(shapeText());
  const smuggle = [
    ['顶层多一个 values', { ...good, values: ['张三', '李四'] }],
    ['包一级多一个 rows', { ...good, packs: [{ ...good.packs[0], rows: [{ id: '张三' }] }] }],
    ['列一级多一个 sample', {
      ...good,
      packs: [{ ...good.packs[0], keys: [{ ...good.packs[0].keys[0], sample: '张三' }] }],
    }],
  ];
  for (const [name, bad] of smuggle) {
    const err = caught(() => w.apps.create({
      id: 'news', title: '新闻', icon: 'dice', entry: 'index.html',
      files: { 'index.html': '<p>x</p>', [DATA_SHAPE_FILENAME]: JSON.stringify(bad) },
    }));
    assert.ok(err instanceof DataShapeError, `${name}：拒的必须是人话错误，实为 ${err?.name}`);
    assert.match(err.message, /值一个字节都不许进来/, `★ ${name}：拒的话要点明"值不许进来"：${err.message}`);
  }
  // 🔴 盘上零残留（校验全在动盘之前）
  assert.equal(nodeFs.existsSync(nodePath.join(w.dir, 'hupo', 'apps')), false, '拒了 ⇒ 一个目录都不许建出来');
  assert.deepEqual(w.apps.list(), []);

  // **负向对照**：只写形状 ⇒ 过，而且它真的进了制品（被 rootHash 盖住）
  const m = w.apps.create({
    id: 'news', title: '新闻', icon: 'dice', entry: 'index.html',
    files: { 'index.html': '<p>x</p>', [DATA_SHAPE_FILENAME]: shapeText() },
  });
  assert.ok(m.files.some((f) => f.path === DATA_SHAPE_FILENAME), '形状声明必须进 manifest.files（随版本冻结）');
  const read = w.apps.dataShape('news');
  assert.equal(read.declared, true);
  assert.equal(read.digest, dataShapeDigest(parseDataShape(shapeText())));
});

// ════════════════════════════════════════════════════════════════
// D2 · 只改值 ⇒ 号不变；改形状 ⇒ 号必变（两个方向）
// ════════════════════════════════════════════════════════════════

test('🔴 D2：只改数据的值 ⇒ 形状的号逐字不变；改形状不改号 ⇒ 拒；改形状且号跟着 ⇒ 必变', () => {
  const w = world('D2');
  const { id } = buildScope(w, { value: '第一份值' });
  const v1 = snapshotWorkspace({ apps: w.apps, workspaces: w.workspaces, id, title: '新闻', icon: 'dice' });
  const s1 = w.apps.dataShape(id, v1.manifest.version);
  const digest1 = s1.digest;
  const packVer1 = s1.decl.packs[0].shapeVersion;

  // ① **只改数据的值**（另一格里的字节）⇒ 再打一版 ⇒ 形状逐字不变
  nodeFs.writeFileSync(nodePath.join(w.workspaces.dirFor(id), '.data', 'news', 'payload.json'), '第二份值\n');
  const v2 = snapshotWorkspace({ apps: w.apps, workspaces: w.workspaces, id, title: '新闻', icon: 'dice' });
  const s2 = w.apps.dataShape(id, v2.manifest.version);
  assert.equal(s2.digest, digest1, '🔴 只改值 ⇒ 形状指纹不许变');
  assert.equal(s2.decl.packs[0].shapeVersion, packVer1, '🔴 只改值 ⇒ 形状的号不许变');
  assert.equal(v2.manifest.rootHash, v1.manifest.rootHash, '★ 值不在制品里（同一份能力体 ⇒ 同一个 rootHash）');
  assert.equal(w.apps.dataShape(id, v1.manifest.version).digest, digest1, '旧那一版的形状照旧冻结着');

  // ② **改形状而不改号** ⇒ 拒（不许偷偷改形状），盘上零残留
  const before = versionCount(w, id);
  const stale = shapeText().replace('"string"', '"number"'); // 键改了，号留着
  w.workspaces.write(id, { [DATA_SHAPE_FILENAME]: stale });
  const err = caught(() => snapshotWorkspace({ apps: w.apps, workspaces: w.workspaces, id, title: '新闻', icon: 'dice' }));
  assert.ok(err instanceof DataShapeError, `🔴 改形状不改号 ⇒ 必须拒：${err?.name}`);
  assert.match(err.message, /号与它自己的形状对不上|形状变了号没变/);
  assert.equal(versionCount(w, id), before, '🔴 拒的时候盘上零残留（没有多出版本目录）');

  // ③ **改形状且号跟着改** ⇒ 号**必变**（正方向）
  const changedKeys = [{ name: 'id', type: 'number', null: 'never', dedup: true }];
  w.workspaces.write(id, { [DATA_SHAPE_FILENAME]: shapeText(changedKeys) });
  const v3 = snapshotWorkspace({ apps: w.apps, workspaces: w.workspaces, id, title: '新闻', icon: 'dice' });
  const s3 = w.apps.dataShape(id, v3.manifest.version);
  assert.notEqual(s3.decl.packs[0].shapeVersion, packVer1, '🔴 改了形状 ⇒ 号必须变');
  assert.notEqual(s3.digest, digest1, '🔴 改了形状 ⇒ 指纹必须变');
  assert.equal(s3.decl.packs[0].shapeVersion, shapeVersionOf({ pack: 'news', keys: changedKeys }));
});

// ════════════════════════════════════════════════════════════════
// D3 · fork／装上 ⇒ 值不随、形状在
// ════════════════════════════════════════════════════════════════

test('🔴 D3：真跑一次装上／fork ⇒ 新那一份里搜不到源那份的值；形状在（同一份指纹）', async () => {
  const SENTINEL = 'shape-fork-sentinel-DO-NOT-SHIP-7c1';
  const author = world('D3-author');
  const { id } = buildScope(author, { value: SENTINEL });
  const snap = snapshotWorkspace({ apps: author.apps, workspaces: author.workspaces, id, title: '新闻', icon: 'dice' });
  const paths = snap.manifest.files.map((f) => f.path);
  assert.ok(paths.includes(DATA_SHAPE_FILENAME), '形状声明必须随制品走');
  assert.equal(paths.some((p) => p.startsWith('.data')), false, '值那一格绝不许进制品');

  const shared = tmp();
  const published = new Published({ dir: shared });
  const idx = published.publish(author.apps, { id, authorSub: 'u1', authorName: '甲' });
  const sharedVer = nodePath.join(shared, 'published-apps', id, 'versions', String(idx.version));
  assert.equal(dirText(sharedVer).includes(SENTINEL), false, '🔴 共享库里出现了值');
  assert.ok(nodeFs.existsSync(nodePath.join(sharedVer, DATA_SHAPE_FILENAME)), '★ 共享库那一版里有形状声明');

  // 乙：装上 ＋ 镜像进他自己的那一间
  const viewer = world('D3-viewer');
  const viewerPub = new Published({ dir: shared });
  const r = viewerPub.installInto(viewer.apps, id);
  mirrorArtifactIntoWorkspace({ apps: viewer.apps, workspaces: viewer.workspaces, id });
  assert.equal(dirText(viewer.dir).includes(SENTINEL), false, '🔴 装上／复制过去的那一份里出现了值');
  assert.equal(
    nodeFs.existsSync(nodePath.join(viewer.workspaces.dirFor(id), '.data')),
    false,
    '🔴 随装复制不许把 `.data/` 带过去',
  );
  assert.equal(
    viewer.apps.dataShape(id, r.version).digest,
    author.apps.dataShape(id, snap.manifest.version).digest,
    '★ 形状随 fork 走：两边指纹逐字相同',
  );

  // **fork** 那条真路（默认分叉）：先装一版、改自己的、上游再出一版 ⇒ 分叉
  const v2body = '<!doctype html><p>上游第二版</p>';
  author.workspaces.write(id, { 'index.html': v2body });
  snapshotWorkspace({ apps: author.apps, workspaces: author.workspaces, id, title: '新闻', icon: 'dice' });
  author.published = published;
  published.publish(author.apps, { id, authorSub: 'u1', authorName: '甲' });

  viewer.workspaces.write(id, { 'index.html': '<p>我自己改的</p>' });
  const fork = await handleAppsOp(viewer.apps, { op: 'install', id, mode: 'fork' }, {
    published: viewerPub, sub: 'u2', workspace: viewer.workspaces,
  });
  assert.equal(fork.ok, true, `分叉这条路必须走得通：${JSON.stringify(fork)}`);
  assert.equal(fork.forked, true, '★ 这次真的是分叉');
  assert.equal(dirText(viewer.dir).includes(SENTINEL), false, '🔴 分叉之后值照样一个字节都没有');
  assert.equal(viewer.apps.dataShape(id).declared, true, '★ 分叉之后形状还在');

  // **负向对照**：源那份的值**不许被误判成形状** —— 它不在声明里，塞进去就拒
  const srcShape = author.workspaces.read(id).files[DATA_SHAPE_FILENAME].toString('utf8');
  assert.equal(srcShape.includes(SENTINEL), false, '形状声明里本来就没有值');
  const bad = JSON.parse(srcShape);
  bad.packs[0].keys[0].value = SENTINEL;
  assert.ok(caught(() => parseDataShape(bad)) instanceof DataShapeError, '🔴 把值塞进声明 ⇒ 必须拒（不许当成形状）');
  assert.equal(dirText(author.dir).includes(SENTINEL), true, '★ 正对照：源那份的值原本真在（上面那条不是空跑）');
});

// ════════════════════════════════════════════════════════════════
// D4 · 规则只住一处（源码级）
// ════════════════════════════════════════════════════════════════

test('🔴 D4：那份固定名文件与形状的判据**只在 `data-shape.js` 一处**（不许两处各写一套）', () => {
  const srcDir = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const files = nodeFs.readdirSync(srcDir).filter((f) => f.endsWith('.js'));
  const withLiteral = files.filter((f) => nodeFs.readFileSync(nodePath.join(srcDir, f), 'utf8').includes("'data-shape.json'"));
  assert.deepEqual(withLiteral, ['data-shape.js'], '🔴 那份固定名文件的名字只许在这一处写');

  const shapeSrc = nodeFs.readFileSync(nodePath.join(srcDir, 'data-shape.js'), 'utf8');
  const appsSrc = nodeFs.readFileSync(nodePath.join(srcDir, 'apps.js'), 'utf8');
  const whole = files.map((f) => nodeFs.readFileSync(nodePath.join(srcDir, f), 'utf8')).join('\n');
  const count = (re) => (whole.match(re) ?? []).length;
  assert.equal(count(/export function parseDataShape\(/g), 1, '形状的判据本体只许有一份');
  assert.equal(count(/export const SHAPE_TYPES = /g), 1, '类型的枚举只许有一份');
  assert.equal(count(/export const NULL_POLICIES = /g), 1, '空值口径的枚举只许有一份');
  assert.match(shapeSrc, /export const DATA_SHAPE_FILENAME = 'data-shape\.json'/);

  // 包名走**与 app id 同一条形状**（91 §3.3.5）：两处的正则与长度上限**逐字核过**
  const packRe = (shapeSrc.match(/PACK_NAME_RE = (\/[^/\n]+\/);/) ?? [])[1];
  const appRe = (appsSrc.match(/!(\/[^/\n]+\/)\.test\(id\)/) ?? [])[1];
  assert.equal(packRe, '/^[a-z0-9][a-z0-9-]*$/', `data-shape 的包名正则：${packRe}`);
  assert.equal(appRe, packRe, '🔴 包名形状必须与 `apps.checkAppId` 逐字相同（不许两处各写一套）');
  assert.equal(MAX_PACK_NAME_CHARS, MAX_ID_CHARS, '🔴 包名的长度上限也要与 app id 同一条');

  // 三条写路都只**调**它，不许另抄：各自 import 自 `./data-shape.js`
  for (const f of ['apps.js', 'workspace.js', 'published.js']) {
    const s = nodeFs.readFileSync(nodePath.join(srcDir, f), 'utf8');
    assert.match(s, /from '\.\/data-shape\.js'/, `${f} 必须调那一处（import 自 data-shape.js）`);
  }
});

// ════════════════════════════════════════════════════════════════
// D5 · 没声明 ⇒ 最严（拒，理由看得见）；补上 ⇒ 过
// ════════════════════════════════════════════════════════════════

test('🔴 D5：盘上有数据格而没有形状声明 ⇒ 拒（理由看得见、零残留）；补上声明 ⇒ 过', () => {
  const w = world('D5');
  const { id } = buildScope(w, { shape: null }); // 有 `.data/news/`，制品里没有声明
  const err = caught(() => snapshotWorkspace({ apps: w.apps, workspaces: w.workspaces, id, title: '新闻', icon: 'dice' }));
  assert.ok(err instanceof DataShapeError, `🔴 没声明必须拒：${err?.name}`);
  assert.match(err.message, /没有形状声明|按最严办/, '拒绝理由要看得见');
  assert.match(err.message, /news/, '拒绝理由要点名是哪一格');
  assert.equal(versionCount(w, id), 0, '🔴 拒的时候盘上零残留');

  // **负向对照**：补上只写形状的声明 ⇒ 过，而且值还是没随制品走
  w.workspaces.write(id, { [DATA_SHAPE_FILENAME]: shapeText() });
  const snap = snapshotWorkspace({ apps: w.apps, workspaces: w.workspaces, id, title: '新闻', icon: 'dice' });
  assert.equal(snap.shape.refused.length, 0);
  assert.deepEqual(snap.shape.carried.map((c) => c.pack), ['news']);
  assert.equal(snap.manifest.files.some((f) => f.path.startsWith('.data')), false, '值照旧不随制品');

  // **负向对照二**：根本没有数据格 ⇒ 不拦（他给自己做的 app 照旧打包得住）
  const w2 = world('D5b');
  w2.workspaces.ensure('plain', { title: '素', entry: 'index.html' });
  w2.workspaces.write('plain', { 'index.html': '<p>没有数据</p>' });
  const plain = snapshotWorkspace({ apps: w2.apps, workspaces: w2.workspaces, id: 'plain', title: '素', icon: 'dice' });
  assert.equal(plain.shape.refused.length, 0);
  assert.equal(plain.shape.declared, false, '如实记"没有声明"，不是编一个');
});
