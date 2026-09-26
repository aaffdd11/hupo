// **用户端没有"包"的那三道上限**（契约 `docs/dev/114-APP-USER-SIDE-NO-LIMIT.md`）。
//
// ── 这一份钉什么（主人 2026-09-26 真机现场）──────────────────
//   助手在主人的「奥数小站」里撞上一堵墙：*"这一页现在 246,522 字节，离 256KB 的那条线
//   只剩 15,622 字节……一条页面根本装不下，差着十几倍。"* 然后他停在岔口上等主人挑
//   （压答案 / 拆两个图标 / 只补几个模块）—— 而**这堵墙本来就不该存在**。
//
//   根子（`docs/dev/113-APP-SHAPE-LIVE.md` §三·2）：我们把**"包"的规矩**
//   （不可变版本 ＋ 单文件 256KB／总 2MB／40 个文件）**挂在了用户端**。
//   主人的形状：*"所谓的版本快照，只在市场中存在。不在用户端。"*
//
// ── 判据（每条都带**反着验**）───────────────────────────────
//   ① **用户端**：`workspaces.write()` ＋ 登记（`app.json`）**不查**尺寸 / 文件数；
//      而且**不落** `versions/`（没有"包"）；
//   ② **反着验**：同一个目录**打成包**（`apps.create()` / 上架那一步）**照旧拒**
//      —— 上限没消失，只是回到了它该在的那一侧；
//   ③ `app_create` **可以不交内容**（他/助手写在那一间目录里的就是它）；
//   ④ 改名 / 复制 / 删除 对"活的那一份"照旧能用（`meta()` 那一处认人）；
//   ⑤ **老的那一份（只有包）行为一个字没变**（协议与盘上布局都冻着）。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeNet from 'node:net';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';

import { Apps, MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES } from '../src/apps.js';
import { AppsSocket, handleAppsOp } from '../src/apps-socket.js';
import { AppWorkspaces } from '../src/workspace.js';

const tmp = () => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-114-'));

/** 一个人那一份（真 `Apps` ＋ 真 `AppWorkspaces`；`live` 就是 `worlds.js` 里那条接线）。 */
function boot() {
  const dir = tmp();
  const workspaces = new AppWorkspaces({ dir, log: () => {} });
  const apps = new Apps({ dir, sub: 'u1', live: () => ({ workspaces }) });
  return { dir, workspaces, apps };
}

/** 一份**超过三道包上限**的内容：文件数超、单文件超、总量也超。 */
function tooBig() {
  const files = {};
  for (let i = 0; i < MAX_FILES + 5; i += 1) files[`p${i}.html`] = `<p>${i}</p>`;
  files['index.html'] = 'x'.repeat(MAX_FILE_BYTES + 1);
  files['big2.html'] = 'y'.repeat(MAX_TOTAL_BYTES);
  return files;
}

const ASK = () => '帮我做一个题库的小程序';

// ══ ① 用户端不查上限，也不落"包" ═══════════════════════════

test('🔴 V1：用户端（工作区 ＋ 登记）**不查**单文件/整版/文件数 —— 而且**不落** `versions/`', async () => {
  const { dir, workspaces, apps } = boot();
  const files = tooBig();
  const r = await handleAppsOp(
    apps,
    { op: 'create', app: { id: 'tiku', title: '题库小站', icon: 'book', entry: 'index.html', files } },
    { workspace: workspaces, sub: 'u1', turnInput: ASK },
  );
  assert.equal(r.ok, true, `用户端不该被这三道挡住：${JSON.stringify(r)}`);

  const appDir = nodePath.join(dir, 'hupo', 'apps', 'tiku');
  assert.equal(nodeFs.existsSync(nodePath.join(appDir, 'app.json')), true, '★ 登记要在（桌面认人）');
  assert.equal(nodeFs.existsSync(nodePath.join(appDir, 'versions')), false, '🔴 用户端不许落"包"');
  assert.equal(nodeFs.existsSync(nodePath.join(appDir, 'current.json')), false, '🔴 也不该有版本指针');

  // 内容在**工作区**里（活的这一份就是它）
  const ws = workspaces.read('tiku');
  assert.equal(ws.files['index.html'].length, MAX_FILE_BYTES + 1);
  assert.equal(Object.keys(ws.files).length, Object.keys(files).length, '文件数一个都不许掉');
  // 清单里看得见（桌面那一格）
  const inList = apps.list().find((a) => a.id === 'tiku');
  assert.ok(inList, '★ `/api/apps` 那条路要看得见它');
  assert.ok(inList.version >= 1, '协议里的 `version` 照旧要给（老客户端在跑）');
  assert.equal(inList.live, true);
});

test('🔴 V1·反着验：**同一个目录打成包**（上架那一步）照旧被拒 —— 上限没消失，只是回到"包"那一侧', () => {
  const { apps } = boot();
  const files = tooBig();
  assert.throws(
    () => apps.create({ id: 'tiku', title: '题库小站', entry: 'index.html', files }),
    /文件太多|单个文件太大|整个制品太大/,
    '🔴 包那一侧的上限被一起拿掉了 ⇒ 这条判据会红（那是另一头的事）',
  );
});

// ══ ② 内容可以不经过工具（写在那一间目录里就是它） ═══════════

test('🔴 V2：`app_create` **不给内容**也成 —— 那一间目录里已有的就是它（助手不必把整页内联进工具调用）', async () => {
  const { workspaces, apps } = boot();
  const big = `<!doctype html><p>${'题'.repeat(1_000)}</p>`;
  workspaces.ensure('tiku', { title: '题库小站', entry: 'index.html' });
  workspaces.write('tiku', { 'index.html': big });

  const r = await handleAppsOp(
    apps,
    { op: 'create', app: { id: 'tiku', title: '题库小站', icon: 'book', entry: 'index.html' } },
    { workspace: workspaces, sub: 'u1', turnInput: ASK },
  );
  assert.equal(r.ok, true, `不带内容也该能登记：${JSON.stringify(r)}`);
  assert.equal(workspaces.read('tiku').files['index.html'].toString('utf8'), big, '一个字节都不许被动');

  // 反例的正身：这一间里**什么都没有**时，登记出来的是那一张占位页（不是"白屏"）
  const second = await handleAppsOp(
    apps,
    { op: 'create', app: { id: 'empty-one', title: '空的一格', entry: 'index.html' } },
    { workspace: workspaces, sub: 'u1', turnInput: ASK },
  );
  assert.equal(second.ok, true);
  assert.ok(workspaces.read('empty-one').files['index.html'].length > 0, '空的那一间要有占位页（点开不是白屏）');
});

test('🔴 V2·反着验：**没明说**照旧拒（"他明说才许写"那条闸没被顺手拆掉）', async () => {
  const { workspaces, apps } = boot();
  const r = await handleAppsOp(
    apps,
    { op: 'create', app: { id: 'tiku', title: '题库小站', files: { 'index.html': '<p>x</p>' } } },
    { workspace: workspaces, sub: 'u1', turnInput: () => null },
  );
  assert.equal(r.ok, false);
  assert.equal(r.refused, 'needs-ask');
});

// ══ ③ 改名 / 复制 / 删除（认人那一处 = `meta()`） ═══════════

test('🔴 V3：活的那一份**改名 / 复制 / 删除**都还能用', async () => {
  const { dir, workspaces, apps } = boot();
  workspaces.ensure('tiku', { title: '题库小站', entry: 'index.html' });
  workspaces.write('tiku', { 'index.html': '<p>题</p>', 'style.css': 'p{color:red}' });
  const made = await handleAppsOp(
    apps,
    { op: 'create', app: { id: 'tiku', title: '题库小站', icon: 'book', entry: 'index.html' } },
    { workspace: workspaces, sub: 'u1', turnInput: ASK },
  );
  assert.equal(made.ok, true);

  // ① 改名：落在**登记**上（清单跟着变）
  assert.equal(apps.setTitle('tiku', '奥数小站'), '奥数小站');
  assert.equal(apps.meta('tiku').title, '奥数小站');
  assert.equal(apps.list().find((a) => a.id === 'tiku').title, '奥数小站');

  // ② 复制：新那一格**有自己的工作区**（字节一样）＋ 自己那份登记；源那份不动
  const cp = apps.copy('tiku');
  assert.equal(cp.id, 'tiku-copy');
  assert.equal(cp.title, '奥数小站 副本');
  assert.equal(workspaces.read('tiku-copy').files['index.html'].toString('utf8'), '<p>题</p>');
  assert.equal(workspaces.read('tiku-copy').files['style.css'].toString('utf8'), 'p{color:red}');
  assert.equal(apps.meta('tiku-copy').title, '奥数小站 副本');
  assert.equal(apps.meta('tiku').title, '奥数小站', '源那份一个字都不许动');

  // ③ 删除：真回收（那一格挪进 `.removed/`）⇒ 清单里没有了
  apps.remove('tiku');
  assert.equal(apps.has('tiku'), false, '删完还在清单里 ⇒ 红');
  assert.equal(apps.list().some((a) => a.id === 'tiku'), false);
  assert.equal(nodeFs.existsSync(nodePath.join(dir, 'hupo', 'apps', 'tiku')), false);
  const removed = nodeFs.readdirSync(nodePath.join(dir, 'hupo', 'apps', '.removed'));
  assert.ok(removed.some((n) => n.startsWith('tiku-')), `回收处里要有它：${removed}`);
});

// ══ ④ 老的那一份（只有包）行为一个字没变 ═══════════════════

test('🔴 V4：只有"包"的老 app（装来的 / 发过一版的）行为逐字不变', () => {
  const { dir, apps } = boot();
  const m = apps.create({
    id: 'dice',
    title: '掷骰子',
    icon: 'dice',
    entry: 'index.html',
    files: { 'index.html': '<p>掷</p>' },
  });
  assert.equal(m.version, 1);
  assert.equal(nodeFs.existsSync(nodePath.join(dir, 'hupo/apps/dice/versions/1/manifest.json')), true);
  const face = apps.meta('dice');
  assert.equal(face.live, false, '没有登记的那一份：`live:false`（读法照旧走包）');
  assert.equal(face.title, '掷骰子');
  assert.equal(apps.current('dice'), 1);
  assert.equal(apps.has('dice'), true, '★ `has()` 对"只有包"的也要真');
  // 改名照旧改到清单里（老行为）
  assert.equal(apps.setTitle('dice', '骰子'), '骰子');
  assert.equal(apps.manifest('dice', 1).title, '骰子');
  // 回滚 / 版本核对那几条照旧
  assert.equal(apps.read('dice', 1, 'index.html').content.toString('utf8'), '<p>掷</p>');
});

test('🔴 V4·补：只有登记、**还没有包**时 `rollback` 如实说"没有那一版"（不许假装滚了）', async () => {
  const { workspaces, apps } = boot();
  workspaces.ensure('tiku', { title: '题库小站', entry: 'index.html' });
  workspaces.write('tiku', { 'index.html': '<p>题</p>' });
  await handleAppsOp(
    apps,
    { op: 'create', app: { id: 'tiku', title: '题库小站', entry: 'index.html' } },
    { workspace: workspaces, sub: 'u1', turnInput: ASK },
  );
  assert.throws(() => apps.rollback('tiku', 1), /要回滚到的那一版不在/);
});

// ══ ⑤ 真的那条口（MCP 工具走的就是它）也要扛得住大的一份 ═══════

/** 经**真域套接字**递一条请求（`mcp-apps-server.mjs` 那条口就是它）。 */
function sendOp(socketPath, req) {
  return new Promise((resolve, reject) => {
    const conn = nodeNet.connect(socketPath, () => conn.write(`${JSON.stringify(req)}\n`));
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      conn.end();
      try {
        resolve(JSON.parse(buf.slice(0, i)));
      } catch (err) {
        reject(err);
      }
    });
    conn.on('error', reject);
  });
}

test('🔴 V5：一份 ~1MB 的页面走**真那条口**（工具 → 套接字 → 登记）也成 —— 不许再撞"这一行太长了"', async (t) => {
  const { dir, workspaces, apps } = boot();
  const sockPath = nodePath.join(dir, 'apps.sock');
  const sock = new AppsSocket({
    apps,
    socketPath: sockPath,
    ctx: { workspace: workspaces, sub: 'u1', turnInput: ASK, turnInputFor: ASK },
  }).listen();
  await sock.ready();
  t.after(() => sock.close());

  const big = 'x'.repeat(1024 * 1024);
  const r = await sendOp(sockPath, {
    op: 'create',
    app: { id: 'tiku', title: '题库小站', icon: 'book', entry: 'index.html', files: { 'index.html': big } },
  });
  assert.equal(r.ok, true, `真那条口不该在这一档拒人：${JSON.stringify(r)}`);
  assert.equal(workspaces.read('tiku').files['index.html'].length, big.length, '一个字节都不许掉');
  assert.equal(nodeFs.existsSync(nodePath.join(dir, 'hupo', 'apps', 'tiku', 'versions')), false);
});
