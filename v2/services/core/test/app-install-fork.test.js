// 90 §4.1–4.2 · **装／升级前先拍快照；改过就不许静默覆盖**（判据 S1–S3）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
// `docs/dev/90-APP-CONTRACT.md` Q4.3／Q4.4／Q4.5 与 `89-APP-MARKET-FORK.md` §⑫
// 说的是同一件事：**今天这里是静默销毁** ——
// `installInto` → `apps.create`（移指针）→ `mirrorArtifactIntoWorkspace`
// （`published.js:239-253`、`apps-socket.js:159-189`）**全程不拍快照**，
// 工作区里与制品同名的那些字节被 `writeAtomic` 逐个覆盖（`workspace.js:344-348`），
// 而盘上报"成功"。
//
// 这一份就是"补上了没有"的判据，**每条都带反例**：
//   S1  装到一份"你改过的那份"上 ⇒ **先有快照**（逐文件 sha 可核）＋ 默认**不覆盖**
//       反例：没有快照就覆盖 ⇒ 红（下面用"老那两步"把这件事演出来）
//   S1a 工作区里先有同名的一份（还没登记）⇒ 同样先快照、默认不覆盖
//   S2  工作区 hash ＝ 当前 `rootHash`（没改过）⇒ 允许刷新，快照**仍然留**
//   S3  可回退：拿快照能**逐字节还原**（sha 相同），而且还能再滚回去
//
// ⚠️ 风格照仓库现有测试：不用起 HTTP（这一条全在制品库 ＋ 工作区那一层），
//    但**走真那一刀** `handleAppsOp`（接线断了就抓得到）。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { Apps } from '../src/apps.js';
import { handleAppsOp } from '../src/apps-socket.js';
import { Published } from '../src/published.js';
import {
  AppWorkspaces,
  mirrorArtifactIntoWorkspace,
  workspaceRootHash,
} from '../src/workspace.js';

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});

function tmp(prefix = 'hupo-fork-') {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const sha = (buf) => nodeCrypto.createHash('sha256').update(buf).digest('hex');

/** 一棵工作区里**逐文件 sha**（相对路径 → sha；与 `read()` 同一条边界：跳过 `.` 开头）。 */
function filesSha(dir) {
  const out = {};
  const walk = (rel) => {
    const here = rel === '' ? dir : nodePath.join(dir, rel);
    let entries;
    try {
      entries = nodeFs.readdirSync(here, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const next = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(next);
      else out[next] = sha(nodeFs.readFileSync(nodePath.join(dir, next)));
    }
  };
  walk('');
  return out;
}

/** 一整套：甲（作者）＋ 共享库 ＋ 乙（装的人：制品库 ＋ 工作区）。 */
function world() {
  const root = tmp();
  const author = new Apps({ dir: nodePath.join(root, 'author'), sub: 'u1' });
  const published = new Published({ dir: nodePath.join(root, 'shared') });
  const viewerDir = nodePath.join(root, 'viewer');
  const apps = new Apps({ dir: viewerDir, sub: 'u2' });
  const workspaces = new AppWorkspaces({ dir: viewerDir, log: () => {} });
  return { root, author, published, apps, workspaces };
}

const APP = { title: '新闻', icon: 'dice', entry: 'index.html' };

/** 甲发第 n 版（同名同 id，版本只增 —— 这就是"上游出了新版本"）。 */
function publish(w, n, id = 'news') {
  w.author.create({ id, ...APP, files: { 'index.html': `<p>上游第 ${n} 版</p>` } });
  return w.published.publish(w.author, { id, authorSub: 'u1', authorName: '甲' });
}

/** 乙：先装上游第 1 版 ⇒ 在自己的那份里改 ⇒ 上游随后出第 2 版。 */
async function editedAfterInstall({ extraLocal = false } = {}) {
  const w = world();
  const id = 'news';
  publish(w, 1);
  const ctx = { published: w.published, sub: 'u2', workspace: w.workspaces };
  const first = await handleAppsOp(w.apps, { op: 'install', id }, ctx);
  assert.equal(first.ok, true, `起点：新装必须成功 ${JSON.stringify(first)}`);
  assert.equal(w.apps.current(id), 1);
  const mine = { 'index.html': '<p>我自己改的（别弄丢）</p>' };
  if (extraLocal) mine['local-notes.md'] = '我自己写的备注';
  w.workspaces.write(id, mine);
  const before = filesSha(w.workspaces.dirFor(id));
  publish(w, 2);
  return { w, id, ctx, before };
}

// ════════════════════════════════════════════════════════════════
// S1 · 改过 ⇒ 先快照 ＋ 默认不覆盖
// ════════════════════════════════════════════════════════════════

test('🔴 S1：装到"你改过的那份"上 ⇒ 先拍快照；默认（分叉）一个字节都不许覆盖', async () => {
  const { w, id, ctx, before } = await editedAfterInstall({ extraLocal: true });
  const wsDir = w.workspaces.dirFor(id);

  // 默认那次安装（不给 mode）⇒ 拒，而且**把两项摆给他看**
  const r = await handleAppsOp(w.apps, { op: 'install', id }, ctx);
  assert.equal(r.ok, false, '🔴 默认不许静默覆盖');
  assert.equal(r.refused, 'needs-choice', JSON.stringify(r));
  assert.deepEqual([...r.options].sort(), ['fork', 'refresh'], '★ 必须给出"刷新／分叉"二选一');
  assert.equal(r.default, 'fork', '🔴 默认分叉');
  assert.deepEqual(filesSha(wsDir), before, '🔴 默认那一次不许动工作区一个字节（含他新加的那个文件）');
  // 人话里要能看见两条路（不是一句"失败了"）
  assert.match(String(r.error), /刷新/);
  assert.match(String(r.error), /分叉/);

  // ★ **快照**：落成制品库里一个不可变版本，逐文件 sha 可核，而且与装前那一份相同
  assert.ok(r.snapshot && Number.isInteger(r.snapshot.version), JSON.stringify(r.snapshot));
  const snap = w.apps.manifest(id, r.snapshot.version);
  assert.ok(snap, '快照必须落进制品库（`hupo/apps/<id>/versions/<n>/`）');
  assert.deepEqual(
    Object.fromEntries(snap.files.map((f) => [f.path, f.sha256])),
    before,
    '★ 快照里的逐文件 sha 必须与装前工作区逐字节相同',
  );
  assert.equal(snap.rootHash, r.snapshot.rootHash);
  assert.equal(workspaceRootHash(w.workspaces, id), snap.rootHash, '工作区 hash 与快照同源（同一条算法）');
  // 指针还在**他自己那一版**（没被上游顶掉）
  assert.equal(w.apps.current(id), snap.version);
});

test('🔴 S1a：工作区里先有同名的一份（还没登记）⇒ 装同一个名字：先快照、默认不覆盖', async () => {
  const w = world();
  const id = 'news';
  // 他自己在聊天里长出来的一份（工作区在，制品库没有）
  w.workspaces.ensure(id, { title: '我的新闻', entry: 'index.html' });
  w.workspaces.write(id, { 'index.html': '<p>我自己养出来的那份</p>' });
  const before = filesSha(w.workspaces.dirFor(id));
  assert.equal(w.apps.current(id), null, '起点：制品库里还没有它');
  // 共享库里有一个**同名但内容不同**的制品
  publish(w, 1, id);

  const r = await handleAppsOp(w.apps, { op: 'install', id }, {
    published: w.published, sub: 'u2', workspace: w.workspaces,
  });
  assert.equal(r.ok, false, '🔴 同名不同内容 ⇒ 默认不许覆盖');
  assert.equal(r.refused, 'needs-choice');
  assert.deepEqual(filesSha(w.workspaces.dirFor(id)), before, '🔴 他养出来的那份必须原封不动');
  const snap = w.apps.manifest(id, r.snapshot.version);
  assert.deepEqual(
    Object.fromEntries(snap.files.map((f) => [f.path, f.sha256])),
    before,
    '★ 快照先拍下来了（逐文件 sha 可核）',
  );
});

test('🔴 S1 反例的正身：没有快照就覆盖 ⇒ 他改的字节真的会没（老那两步）', async () => {
  // 这一条**故意走**旧那两步（`installInto` → 直接镜像，中间没有快照）——
  // 它就是"今天这里是静默销毁"那个病的正身。
  const w = world();
  const id = 'news';
  w.workspaces.ensure(id, { title: '我的新闻', entry: 'index.html' });
  w.workspaces.write(id, { 'index.html': '<p>我自己养出来的那份</p>' });
  const before = filesSha(w.workspaces.dirFor(id));
  publish(w, 1, id);

  w.published.installInto(w.apps, id); // ← 没有 `snapshotBeforeInstall`
  mirrorArtifactIntoWorkspace({ apps: w.apps, workspaces: w.workspaces, id });

  const after = filesSha(w.workspaces.dirFor(id));
  assert.notDeepEqual(after, before, '反例：没有快照 ⇒ 他改的字节被覆盖了');
  assert.match(nodeFs.readFileSync(nodePath.join(w.workspaces.dirFor(id), 'index.html'), 'utf8'), /上游第 1 版/);
  // 而且盘上**找不到**他原来那份的快照（这正是"不可逆"三个字的意思）
  const archived = [1, 2, 3].some((v) => {
    const m = w.apps.manifest(id, v);
    if (!m) return false;
    return JSON.stringify(Object.fromEntries(m.files.map((f) => [f.path, f.sha256]))) === JSON.stringify(before);
  });
  assert.equal(archived, false, '反例：没有快照 ⇒ 他那份盘上找不回来');
});

// ════════════════════════════════════════════════════════════════
// S2 · 没改过 ⇒ 允许刷新，快照仍然留
// ════════════════════════════════════════════════════════════════

test('★ S2：工作区 hash ＝ 当前 rootHash（没改过）⇒ 允许刷新，且快照仍然留', async () => {
  const w = world();
  const id = 'news';
  const ctx = { published: w.published, sub: 'u2', workspace: w.workspaces };
  publish(w, 1);
  assert.equal((await handleAppsOp(w.apps, { op: 'install', id }, ctx)).ok, true);

  // 起点读数：**一个字节都没改过** ⇒ 两个 hash 相等
  const before = filesSha(w.workspaces.dirFor(id));
  const curMan = w.apps.manifest(id, w.apps.current(id));
  assert.equal(workspaceRootHash(w.workspaces, id), curMan.rootHash, '起点：工作区 hash ＝ 当前 rootHash');

  publish(w, 2);
  // 不给 mode：没改过 ⇒ **不必二选一**，允许刷新
  const r = await handleAppsOp(w.apps, { op: 'install', id }, ctx);
  assert.equal(r.ok, true, `没改过 ⇒ 允许刷新：${JSON.stringify(r)}`);
  assert.equal(r.forked, false);
  // 真刷新了：工作区现在就是上游第 2 版
  assert.match(
    nodeFs.readFileSync(nodePath.join(w.workspaces.dirFor(id), 'index.html'), 'utf8'),
    /上游第 2 版/,
  );
  // ★ **快照仍然留**（宁多一份）：装前那一版还在，逐文件 sha 与装前相同
  assert.ok(r.snapshot && Number.isInteger(r.snapshot.version), JSON.stringify(r.snapshot));
  const snap = w.apps.manifest(id, r.snapshot.version);
  assert.ok(snap, '★ 快照必须还在盘上');
  assert.deepEqual(
    Object.fromEntries(snap.files.map((f) => [f.path, f.sha256])),
    before,
    '★ 快照就是装前那一份（逐文件 sha 可核）',
  );
});

// ════════════════════════════════════════════════════════════════
// S3 · 可回退：拿快照逐字节还原
// ════════════════════════════════════════════════════════════════

test('🔴 S3：拿快照能逐字节还原（sha 相同），而且还能再滚回去', async () => {
  // ⚠️ 这一条让**两边的文件集一样**（只差 `index.html` 的字节）——
  //    `mirrorArtifactIntoWorkspace` 只覆盖它写到的那些路径（制品里没有的文件活得下来，
  //    90 §2.3），所以"整棵树逐字节还原"只有在文件集相同时才是同一句话。
  const { w, id, ctx, before } = await editedAfterInstall({ extraLocal: false });
  const wsDir = w.workspaces.dirFor(id);

  // 他选「刷新」⇒ 覆盖（允许：旧版已经留档）
  const r = await handleAppsOp(w.apps, { op: 'install', id, mode: 'refresh' }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.forked, false);
  assert.match(nodeFs.readFileSync(nodePath.join(wsDir, 'index.html'), 'utf8'), /上游第 2 版/);
  assert.notDeepEqual(filesSha(wsDir), before, '刷新之后工作区就是上游那份了');

  // ★ **拿快照还原**：逐字节回到装前那一份（sha 相同）
  mirrorArtifactIntoWorkspace({ apps: w.apps, workspaces: w.workspaces, id, version: r.snapshot.version });
  assert.deepEqual(filesSha(wsDir), before, '🔴 逐字节还原（sha 相同）');

  // ★ **一步能退、也能再滚回来**（旧版本都在，指针说了算）
  w.apps.rollback(id, r.version);
  mirrorArtifactIntoWorkspace({ apps: w.apps, workspaces: w.workspaces, id });
  assert.match(nodeFs.readFileSync(nodePath.join(wsDir, 'index.html'), 'utf8'), /上游第 2 版/);
  assert.equal(w.apps.current(id), r.version);
});

test('★ S3·分叉：明说「分叉」⇒ 留着他改的、记下上游那一版（工作区不动）', async () => {
  const { w, id, ctx, before } = await editedAfterInstall({ extraLocal: true });
  const r = await handleAppsOp(w.apps, { op: 'install', id, mode: 'fork' }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.forked, true, '★ 分叉要如实回一句');
  assert.deepEqual(filesSha(w.workspaces.dirFor(id)), before, '🔴 分叉：工作区一个字节都不动');
  // 上游那一版**记下来了**（登记在 `lineage.json`，不是写进不可变清单）
  const edges = w.apps.lineage(id);
  assert.equal(edges.length, 1, JSON.stringify(edges));
  assert.equal(edges[0].kind, 'fork');
  assert.equal(typeof edges[0].baseRootHash, 'string');
  assert.equal(edges[0].myVersion, r.snapshot.version);
  // 指针落回他自己那一版
  assert.equal(w.apps.current(id), r.snapshot.version);
  // 但上游那一版真的在制品库里（不是一句空话）
  assert.ok(w.apps.manifest(id, edges[0].baseVersion));
});
