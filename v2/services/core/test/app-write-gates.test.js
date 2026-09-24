// 91 §11.3·4／·5 · **写入侧那两道缝**（判据 S4／S5）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
// 91 契约点出两处"闸有缝"，两处都是**只画在读取侧**：
//
//   S4  `.data/`／`.exp/` 前缀（数据包／经验包）**不进制品** ——
//       今天唯一的机制是 `workspace.js:395`（`read()` 跳过 `.` 开头），
//       而 `apps.js` 的 `checkRelPath` **允许**这些路径 ⇒ 谁把一份带 `.data/` 的
//       `files` 直接交给 `apps.create`（老路 / 装上 / 迁移），数据就进制品了。
//       ⇒ 写入侧也要拒（人话），并且**盘上零残留**。
//
//   S5  保留 id（`main`／桌面内置四格）**从任何一条写入路**都进不去 ——
//       原来闸在 `worlds.js` 的 `UserWorkspaces`（工作区那一层），
//       而 `apps-socket.js` 那条**没接 `ctx.workspace` 的老路**能绕过它，
//       保留 id 照样进制品库 ⇒ 客户端按内置处理 ⇒ "造了但看不见"。
//       ⇒ 闸挪到/补到**所有写路的汇合点** `apps.create`（一个闸），
//         工作区那一侧用**同一个函数**（同一份逻辑，不是又抄一遍）。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { Apps, AppsError, REFUSED_APP_IDS, refuseReservedAppId } from '../src/apps.js';
import { handleAppsOp } from '../src/apps-socket.js';
import { Published } from '../src/published.js';
import { AppWorkspaces, snapshotWorkspace } from '../src/workspace.js';
import { BUILTIN_SCOPES, MAIN_SCOPE, RESERVED_APP_SCOPES } from '../src/worlds.js';

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});

function tmp(prefix = 'hupo-gate-') {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const OK = Object.freeze({
  id: 'news',
  title: '新闻',
  icon: 'dice',
  entry: 'index.html',
  files: { 'index.html': '<p>新闻</p>' },
});

/** 把一句人话错误抓出来（`assert.throws` 不返回那个 error）。 */
function caught(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('这一条本该被拒，但没有');
}

// ════════════════════════════════════════════════════════════════
// S4 · `.data/`／`.exp/`：写入侧也要拒，且盘上零残留
// ════════════════════════════════════════════════════════════════

test('🔴 S4：`apps.create` 收到 `.data/`／`.exp/` 前缀 ⇒ 人话拒，盘上零残留', () => {
  const dir = tmp();
  const apps = new Apps({ dir, sub: 'u1' });

  const hidden = [
    '.data/rows.jsonl',       // 数据包那一格
    '.data/news/pack.json',
    '.exp/hints/tip.md',      // 经验包那一格
    '.exp/news/pack.json',
    'assets/.hidden/x.js',    // 只要有一段以 `.` 开头，就读不进制品 ⇒ 同样拒
    '.hupo.json',
  ];
  for (const rel of hidden) {
    const err = caught(() => apps.create({ ...OK, files: { ...OK.files, [rel]: 'x' } }));
    assert.ok(err instanceof AppsError, `${rel}：拒的必须是人话错误，实为 ${err?.name}`);
    assert.match(err.message, /不进制品/, `★ ${rel}：拒的话要说清为什么：${err.message}`);
    assert.ok(err.message.includes(rel), `★ 拒的话要点名那个文件：${err.message}`);
  }
  // 🔴 **盘上零残留**：校验全在动盘之前（四条硬规矩②）
  assert.equal(nodeFs.existsSync(nodePath.join(dir, 'hupo', 'apps')), false, '拒了 ⇒ 一个目录都不许建出来');
  assert.deepEqual(apps.list(), []);

  // **负向对照**：正常的名字（含 `.` 在中间、不在开头）照旧能建
  const fine = apps.create({ ...OK, files: { 'index.html': 'x', 'a/b.min.js': 'y' } });
  assert.equal(fine.id, 'news');
  assert.deepEqual(fine.files.map((f) => f.path).sort(), ['a/b.min.js', 'index.html']);
});

test('★ S4 负向对照：工作区**写得进** `.data/`／`.exp/`，但发布时它们**不进制品**', () => {
  const dir = tmp();
  const workspaces = new AppWorkspaces({ dir, log: () => {} });
  workspaces.ensure('news', { title: '新闻', entry: 'index.html' });
  workspaces.write('news', {
    'index.html': '<p>新闻</p>',
    '.data/rows.jsonl': '{"v":1}',
    '.exp/hints/tip.md': '这样问更准',
  });
  // 91 §3.1.2：这两格是**写得进**的（不然数据／经验没地方住）
  assert.equal(nodeFs.existsSync(nodePath.join(dir, 'workspaces', 'news', '.data', 'rows.jsonl')), true);
  assert.equal(nodeFs.existsSync(nodePath.join(dir, 'workspaces', 'news', '.exp', 'hints', 'tip.md')), true);

  // 快照从工作区读 ⇒ `.` 开头的不算能力体（读取侧唯一的机制，91 §2.1）
  const snap = snapshotWorkspace({
    apps: new Apps({ dir }), workspaces, id: 'news', title: '新闻', icon: 'dice',
  });
  const paths = snap.manifest.files.map((f) => f.path);
  assert.deepEqual(paths, ['index.html'], '🔴 `.data/`／`.exp/` 绝不许进制品');
  assert.equal(paths.some((p) => p.startsWith('.data') || p.startsWith('.exp')), false);
});

// ════════════════════════════════════════════════════════════════
// S5 · 保留 id：从任何一条写入路都进不去
// ════════════════════════════════════════════════════════════════

test('★ S5 起点：保留名单只有一个出处，而且就是契约点的那五个', () => {
  assert.deepEqual([...REFUSED_APP_IDS], ['main', 'settings', 'math', 'discover', 'harness']);
  // `worlds.js` 那两个导出与它是同一份（**不是各抄一遍**）
  assert.deepEqual([...RESERVED_APP_SCOPES], [...REFUSED_APP_IDS]);
  assert.deepEqual([...REFUSED_APP_IDS], [MAIN_SCOPE, ...BUILTIN_SCOPES]);
  // 闸本身的形状：保留 id 抛，别的原样
  assert.throws(() => refuseReservedAppId('main'), /主线/);
  assert.throws(() => refuseReservedAppId('settings'), /桌面上/);
  assert.equal(refuseReservedAppId('dice'), 'dice');
  assert.equal(refuseReservedAppId(''), '');
});

test('🔴 S5：保留 id 从**每一条写入路**都进不去（含 `apps-socket.js` 那条旧路）', async () => {
  const dir = tmp();
  const apps = new Apps({ dir, sub: 'u1' });
  const workspaces = new AppWorkspaces({ dir, log: () => {} });
  const published = new Published({ dir: nodePath.join(dir, 'shared') });
  const app = { ...OK, title: '假的', files: { 'index.html': '<p>不该存在</p>' } };
  const oldWay = { turnInput: () => '帮我做一个小程序' };                     // ← 没接 workspace（旧路）
  const newWay = { ...oldWay, workspace: workspaces };                       // ← 接上了（新路）

  for (const id of REFUSED_APP_IDS) {
    // ① **唯一落点** `apps.create`：所有写路最后都汇到这里
    assert.throws(
      () => apps.create({ ...app, id }),
      /主线|桌面上/,
      `🔴 ${id}：制品库那一层必须拒`,
    );

    // ② **旧路**（`apps-socket.js` 里没有 `ctx.workspace` 的那一支）——
    //    这正是 91 §11.3·5 说"绕得过"的那条；现在必须红。
    const viaOld = await handleAppsOp(apps, { op: 'create', app: { ...app, id } }, oldWay);
    assert.equal(viaOld.ok, false, `🔴 旧路必须拒（${id}）：${JSON.stringify(viaOld)}`);
    assert.match(String(viaOld.error), /主线|桌面上/, `★ ${id}：旧路拒的话要是人话`);

    // ③ **新路**（带工作区）：也要拒，而且**一个目录都不许留**
    const viaNew = await handleAppsOp(apps, { op: 'create', app: { ...app, id } }, newWay);
    assert.equal(viaNew.ok, false, `🔴 ${id}：新路也必须拒`);
    assert.equal(workspaces.has(id), false, `🔴 ${id}：拒了就不许给它建工作区`);

    // ④ 制品库 / 工作区 / 共享库：盘上零残留
    assert.equal(apps.current(id), null, `🔴 ${id}：不许登记进制品库`);
    assert.equal(published.index(id), null);
  }
  assert.equal(nodeFs.existsSync(nodePath.join(dir, 'hupo', 'apps')), false, '🔴 全程盘上零残留');

  // 负向对照：普通 id 照旧能造（证明闸没把整条路关掉）
  const ok = await handleAppsOp(
    apps,
    { op: 'create', app: { ...app, id: 'dice' } },
    { ...oldWay, workspace: workspaces },
  );
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test('🔴 S5·装上也算一条写入路：共享库里就算塞了条保留 id，`install` 也进不去', () => {
  // 手工造一条"保留 id"的共享库条目（模拟旧数据/别人塞进去的东西）——
  // 装上那条路最后也走 `apps.create`，所以同一道闸必须挡住它。
  const dir = tmp();
  const apps = new Apps({ dir: nodePath.join(dir, 'viewer'), sub: 'u2' });
  const published = new Published({ dir: nodePath.join(dir, 'shared') });
  const appDir = published.appDir('settings');
  nodeFs.mkdirSync(nodePath.join(appDir, 'versions', '1'), { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(appDir, 'index.json'),
    JSON.stringify({
      schema: 1, id: 'settings', title: '假的', icon: 'dice', entry: 'index.html',
      version: 1, rootHash: 'x', permissions: [], published: true,
    }),
  );
  nodeFs.writeFileSync(nodePath.join(appDir, 'versions', '1', 'index.html'), '<p>假的</p>');

  const err = caught(() => published.installInto(apps, 'settings'));
  assert.ok(err instanceof AppsError || /桌面上|主线/.test(String(err?.message)), String(err?.message));
  assert.match(String(err.message), /桌面上|主线/);
  assert.equal(apps.current('settings'), null, '🔴 装上那条路也进不去');
  assert.equal(nodeFs.existsSync(nodePath.join(apps.root, 'settings')), false, '盘上零残留');
});
