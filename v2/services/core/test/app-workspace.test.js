// 83 · **一个图标 = 一个工作区 = 一条对话**（判据 A1–A7 · 契约 `docs/dev/83-APP-WORKSPACE.md`）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
// 手册 `02-ARCHITECTURE.md` §2.1 早就写着 `workspaces/<scope-name>/ ← 子工作区
// （= 桌面上的一个图标）`，但**从来没接上**：`/data/workspaces` 是空的、
// 小程序文件躺在 `/data/main` 里、事件里的 `scopeId` 恒为 `'main'`。
//
// 这一份就是"接上了没有"的判据，**每条都带反例**：
//   A1 造 app ⇒ 文件**只**在它自己的工作区里（写进 main ⇒ 红）
//   A2 每个 scope 自己的 DSH 会话 / cwd（两个 app 落进同一个 slug ⇒ 红）
//   A3 对话分家（**一条日志 ＋ 视图过滤**：不带标签的话不许出现在别间；
//      ⚠️ 2026-09-25 按 P-l 改：分的是**视图**，不是"每间一份日志"）
//   A4 主线不受影响（分了家把主线弄坏 ⇒ 红）
//   A5 制品库是快照（直接线上读工作区 ⇒ 红）
//   A6 迁移逐字节不变、主目录里不许再留着它（搬丢 / 没删源 ⇒ 红）
//   A7 三条硬规则仍在（把 workspaces 挪进 main ⇒ 红）
//
// ⚠️ 风格照仓库现有测试：真 `Worlds` + 真 HTTP + 真域套接字 + **真 spawn 假 agent**。
//    "接线的每一段都要有一条闸从外面打进来"（`multitenant.test.js` 顶上那段教训）。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodeNet from 'node:net';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { spawn as realSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { AgentRuntime } from '../src/agent-runtime.js';
import { Apps } from '../src/apps.js';
import { handleAppsOp } from '../src/apps-socket.js';
import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { groupSlugFor } from '../src/prune.js';
import { OWNER_ID } from '../src/tenants.js';
import {
  BUILTIN_SCOPES,
  MAIN_SCOPE,
  RESERVED_APP_SCOPES,
  Worlds,
  agentKeyFor,
  isBuiltinScope,
  parseScope,
  scopeTimelineId,
} from '../src/worlds.js';
import {
  AppWorkspaces,
  checkScope,
  safeScope,
  scopeDirFor,
  snapshotWorkspace,
  workspacesRoot,
} from '../src/workspace.js';
import {
  MAIN_LEAK_MAX_PATHS,
  MAIN_LEAK_WHAT,
  MainLeakWatch,
  addedPaths,
  leakNoticeText,
  leakReport,
  listFiles,
} from '../src/main-leak.js';
import {
  compareTrees,
  migrateAppWorkspaces,
  walkTree,
} from '../../../../scripts/migrate-app-workspaces.mjs';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const FAKE = nodePath.join(HERE, 'fake-agent.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 这一轮起过的东西（`after()` 兜底收掉：红了也要能退出）。 */
const open = new Set();
const tmpDirs = [];
after(async () => {
  for (const s of open) {
    try { await s.close(); } catch { /* 关不干净不影响结论 */ }
  }
  open.clear();
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});

function tmp(prefix = 'hupo-ws-') {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function cfgFor(dataDir) {
  return {
    dataDir,
    // ⚠️ 主人那一份的 DSH_HOME / 工作目录 —— 判据要盯住"它**没被搬**"
    dshHome: nodePath.join(dataDir, '__owner_dsh__'),
    agentCwd: nodePath.join(dataDir, '__owner_cwd__'),
    ledgerSocketPath: nodePath.join(dataDir, 'ledger.sock'),
    dshBin: 'unused',
    agentProfile: 'sdk',
    agentProvider: 'fake',
    agentModel: 'fake',
    agentEffort: 'low',
    agentMaxTokens: 512,
    agentBootTimeoutMs: 20000,
    agentMaxProcesses: 4,
    agentIdleEvictMs: 60000,
    personaPath: null,
    recap: {},
    turnDeadlineMs: 5000,
  };
}

/** 起一套：真 `Worlds` + 真 HTTP 监听 + 真 spawn（假 agent）。 */
async function boot({ scenario = 'normal', turnDeadlineMs = null } = {}) {
  const dataDir = tmp('hupo-ws-run-');
  const cfg = cfgFor(dataDir);
  if (turnDeadlineMs !== null) cfg.turnDeadlineMs = turnDeadlineMs;
  nodeFs.mkdirSync(cfg.dshHome, { recursive: true });
  nodeFs.mkdirSync(cfg.agentCwd, { recursive: true });

  // **真 spawn 出去的 cwd / DSH_HOME** —— 只比 `cfg` 是抓不到"接线断了"的
  const spawned = [];

  let worlds = null;
  const runtime = new AgentRuntime({
    cfg,
    cfgFor: (key) => worlds.cfgForAgentKey(key),
    onEvict: (id) => worlds.onEvict(id),
    spawnFn: (bin, args, opts) => {
      spawned.push({ dshHome: opts?.env?.DSH_HOME ?? null, cwd: opts?.cwd ?? null });
      return realSpawn(process.execPath, [FAKE], {
        ...opts,
        env: { ...opts.env, FAKE_SCENARIO: scenario },
      });
    },
  });
  worlds = new Worlds({ cfg, runtime, log: () => {}, warn: () => {} });

  const auth = new Auth({ dataDir, lockAfter: 3, lockMs: 60_000 });
  auth.setPassword('test-pass');

  const { listen, close } = createServer({ worlds, auth, buildId: 'ws-test' });
  const addr = await listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;

  const h = {
    dataDir, cfg, worlds, runtime, auth, origin, spawned,
    close: async () => {
      open.delete(h);
      await worlds.shutdownDispatchers();
      await runtime.shutdown();
      await close();
      // ⚠️ 账本/制品那两条本地通道是**真的 Unix 套接字监听**，不关它测试进程永不退出
      worlds.closeSockets();
      nodeFs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  open.add(h);
  return h;
}

const tokenFor = (h, sub) => h.auth.issue({ sub }).token;
const get = (h, path, sub) =>
  fetch(`${h.origin}${path}`, { headers: { authorization: `Bearer ${tokenFor(h, sub)}` } });
const post = (h, path, body, sub) =>
  fetch(`${h.origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor(h, sub)}` },
    body: JSON.stringify(body),
  });

async function waitFor(pred, why, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await sleep(50);
  }
  throw new Error(`等不到：${why}（等了 ${ms}ms）`);
}

async function waitForCount(h, n) {
  await waitFor(() => h.runtime.count >= n, `进程池里攒够 ${n} 个（实际 ${h.runtime.count}）`);
  return h.runtime.count;
}

const jsonl = (dir, name = 'main.jsonl') => {
  const f = nodePath.join(dir, name);
  return nodeFs.existsSync(f) ? nodeFs.readFileSync(f, 'utf8') : '';
};

/** 一棵树里所有文件的相对路径（用来证"一个都不在"）。 */
function walkFiles(root) {
  const out = [];
  const walk = (rel) => {
    const here = rel === '' ? root : nodePath.join(root, rel);
    let entries;
    try {
      entries = nodeFs.readdirSync(here, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const next = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(next);
      else out.push(next);
    }
  };
  walk('');
  return out.sort();
}

const sha = (buf) => nodeCrypto.createHash('sha256').update(buf).digest('hex');

/** 部署那一本审计账（`auditPath(cfg.dataDir)`；没有 ⇒ 空串）。**只读，不猜**。 */
const auditText = (h) => {
  const f = nodePath.join(h.dataDir, 'audit.log');
  return nodeFs.existsSync(f) ? nodeFs.readFileSync(f, 'utf8') : '';
};

/** 主线那条日志里所有**落盘取号的通知**（`notice`）。 */
const noticesOf = (w) =>
  jsonl(w.dir)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === 'notice');

/** 那个口上问一句、拿一句（同 `mcp-apps-server.mjs` 的形状）。 */
function askApps(sockPath, payload) {
  return new Promise((resolve, reject) => {
    const conn = nodeNet.connect(sockPath);
    let buf = '';
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      try { conn.destroy(); } catch { /* 尽力 */ }
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new Error('本地通道没回话')), 8000);
    conn.setEncoding('utf8');
    conn.on('connect', () => conn.write(`${JSON.stringify(payload)}\n`));
    conn.on('data', (c) => {
      buf += c;
      const i = buf.indexOf('\n');
      if (i === -1) return;
      clearTimeout(timer);
      try { finish(resolve, JSON.parse(buf.slice(0, i))); } catch (e) { finish(reject, e); }
    });
    conn.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * **在测试里造一个 scope**：工作区 ＋ 登记成 app。
 * ⚠️ A1/A6 走的是**真那一刀**（`handleAppsOp` / 迁移）；这里只是给 A2–A5 备房间。
 */
function makeScope(h, sub, id, files = { 'index.html': `<!doctype html><p>${id}</p>` }, title = id) {
  const w = h.worlds.worldFor(sub);
  w.workspaces.ensure(id, { title, entry: 'index.html' });
  w.workspaces.write(id, files);
  const snap = snapshotWorkspace({
    apps: w.apps, workspaces: w.workspaces, id, title, icon: 'dice',
  });
  return { world: w, manifest: snap.manifest, dir: snap.workspace };
}

function wsConnect(origin, { token, scope = null, sinceSeq = 0, level = null } = {}) {
  const protocols = token ? ['bearer', token] : [];
  const qs = new URLSearchParams({ sinceSeq: String(sinceSeq) });
  if (scope) qs.set('scope', scope);
  if (level) qs.set('level', level);
  const url = `${origin.replace(/^http/, 'ws')}/api/stream?${qs}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols);
    const frames = [];
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('error', (err) => reject(err));
    ws.on('unexpected-response', (_req, res) =>
      reject(Object.assign(new Error('rejected'), { status: res.statusCode })));
  });
}

// ════════════════════════════════════════════════════════════════
// A1 · 造一个 app ⇒ 文件**只**在它自己的工作区里
// ════════════════════════════════════════════════════════════════

test('🔴 A1：造 app ⇒ 文件只出现在它自己的工作区里；主目录里一个都不许多', async () => {
  const h = await boot();
  const w = h.worlds.worldFor('u1');
  const mainDir = w.cfg.agentCwd; // 别人那一格：<dir>/main
  const body = '<!doctype html><title>天气</title><p>今天晴</p>';

  const r = await handleAppsOp(
    w.apps,
    { op: 'create', app: { id: 'city-weather', title: '天气', icon: 'dice', entry: 'index.html', files: { 'index.html': body } } },
    // ★ 服务端那一刀的形状：工作区 ＋ 当轮他说了什么（P1-22）
    { workspace: w.workspaces, sub: 'u1', turnInput: () => '帮我做一个小程序' },
  );
  assert.equal(r.ok, true, JSON.stringify(r));

  const wsFile = nodePath.join(workspacesRoot(w.dir), 'city-weather', 'index.html');
  assert.equal(nodeFs.existsSync(wsFile), true, '★ 产物必须在它自己的工作区里');
  assert.equal(nodeFs.readFileSync(wsFile, 'utf8'), body, '★ 工作区里就是模型给的那份内容');

  // ★ **它只在那里**：主目录（`<dir>/main`）下一个文件都不许多
  assert.deepEqual(walkFiles(mainDir), [], '🔴 主目录里一个文件都不许有（反例：写进 main ⇒ 红）');
  assert.equal(
    wsFile.startsWith(`${mainDir}${nodePath.sep}`), false,
    '🔴 工作区**不许在主目录里面** —— 必须平行（否则主目录的 agent 写得到它）',
  );

  // ★ **`114`：用户端就到此为止** —— 桌面上那一格靠**登记**（`app.json`），
  //    内容就是**这一间工作区**（活的），**不落"包"**（版本快照只在市场那一侧）。
  const artRoot = nodePath.join(w.dir, 'hupo', 'apps', 'city-weather');
  assert.equal(nodeFs.existsSync(nodePath.join(artRoot, 'app.json')), true, '★ 要登记（桌面认人靠它）');
  assert.equal(
    nodeFs.existsSync(nodePath.join(artRoot, 'versions')), false,
    '🔴 用户端不许落"包"（主人 2026-09-26：版本快照只在市场中存在）',
  );
  assert.ok(w.apps.list().some((a) => a.id === 'city-weather'), '★ 清单里要看得见它');
  assert.equal(JSON.parse(nodeFs.readFileSync(nodePath.join(artRoot, 'app.json'), 'utf8')).title, '天气');
  // **反例的正身**：真去打一版"包" ⇒ 内容对得上（证明工作区那一份就是源头）
  const packed = snapshotWorkspace({
    apps: w.apps,
    workspaces: w.workspaces,
    id: 'city-weather',
    title: '天气',
    createdBy: 'user',
  });
  assert.equal(packed.manifest.files.find((f) => f.path === 'index.html').bytes, Buffer.byteLength(body));

  // **反例的正身**：同一个内容若真写进主目录，上面那条 walkFiles 立刻非空 ⇒ 红
  const leak = nodePath.join(mainDir, 'city-weather');
  nodeFs.mkdirSync(leak, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(leak, 'index.html'), body);
  assert.notDeepEqual(walkFiles(mainDir), [], '反例：写进 main ⇒ 这条判据会红（证明闸真的在盯）');

  await h.close();
});

test('🔴 A1 真接线：走真域套接字 + 真一轮 —— `worlds` 有没有把工作区那一刀接上', async () => {
  // ⚠️ 为什么非要这一条：上面那条验的是"那一刀本身对不对"，
  //    而**最容易坏的是接线**（`ctx.workspace` 忘了传 ⇒ 那一刀根本不在）。
  const h = await boot({ scenario: 'hang', turnDeadlineMs: 60_000 });
  const w = h.worlds.worldFor('u1');
  await w.appsSocket.ready();

  // ① 还没人说话 ⇒ 拒（当轮输入是空的，fail-closed）
  const silent = await askApps(w.appsSocket.path, {
    op: 'create',
    app: { id: 'quiet-one', title: '没说要', files: { 'index.html': '<p>x</p>' } },
  });
  assert.equal(silent.ok, false, '★ 没有"他那句话" ⇒ 一律不许造');

  // ② 他真说了 ⇒ 成（这一轮挂着，当轮输入还有效）
  w.dispatcher.deliver('帮我做一个天气的小程序', { messageId: null }).catch(() => {});
  await waitFor(() => w.dispatcher.turnInput !== '', '这一轮还没起来（turn-start 没到）');
  const ok = await askApps(w.appsSocket.path, {
    op: 'create',
    app: { id: 'city-weather', title: '天气', entry: 'index.html', files: { 'index.html': '<p>晴</p>' } },
  });
  assert.equal(ok.ok, true, `★ 接线断了（worlds 没把工作区递过来）：${JSON.stringify(ok)}`);

  assert.equal(nodeFs.existsSync(nodePath.join(workspacesRoot(w.dir), 'city-weather', 'index.html')), true);
  assert.deepEqual(walkFiles(w.cfg.agentCwd), [], '🔴 走了真通道，文件还是不许落进主目录');
  await h.close();
});

// ════════════════════════════════════════════════════════════════
// A2 · 每个 scope 自己的 DSH 会话 / cwd
// ════════════════════════════════════════════════════════════════

test('★ A1 补：装上来也要有自己的工作区（一个图标 = 一个工作区，不分来源）', async () => {
  const h = await boot();
  const u1 = h.worlds.worldFor('u1');
  const u2 = h.worlds.worldFor('u2');
  // 甲做了一份、发出去
  u2.workspaces.ensure('shared-one', { title: '共享的', entry: 'index.html' });
  u2.workspaces.write('shared-one', {
    'index.html': '<p>共享的</p>',
    // ★ A16：外联申报（93 §2.2）—— 没有它上架拒（fail-closed）
    'outbound.json': JSON.stringify({
      schema: 1, outbound: [],
      declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '还没人用过，先按 0 报' },
    }),
  });
  snapshotWorkspace({ apps: u2.apps, workspaces: u2.workspaces, id: 'shared-one', title: '共享的', icon: 'dice' });
  u2.published.publish(u2.apps, { id: 'shared-one', authorSub: 'u2', authorName: '乙' });

  // 乙装上 ⇒ 他桌上那一份也**必须**有一间自己的工作区
  const r = await handleAppsOp(
    u1.apps,
    { op: 'install', id: 'shared-one' },
    { published: u1.published, sub: 'u1', workspace: u1.workspaces },
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  const file = nodePath.join(workspacesRoot(u1.dir), 'shared-one', 'index.html');
  assert.equal(nodeFs.existsSync(file), true, '★ 装上来那一份也要有自己的工作区');
  assert.equal(nodeFs.readFileSync(file, 'utf8'), '<p>共享的</p>');
  assert.deepEqual(walkFiles(u1.cfg.agentCwd), [], '🔴 主目录里同样一个文件都不许有');
  await h.close();
});

test('🔴 A2：一个 app 一个工作目录一个 agent 键（反例：两个 app 落进同一个 slug）', async () => {
  const h = await boot();
  makeScope(h, 'u1', 'alpha');
  makeScope(h, 'u1', 'beta');
  const w = h.worlds.worldFor('u1');

  const pathA = h.worlds.pathsFor('u1', 'alpha');
  const pathB = h.worlds.pathsFor('u1', 'beta');
  const pathMain = h.worlds.pathsFor('u1');
  assert.notEqual(pathA.agentCwd, pathB.agentCwd, '🔴 两个 app 共用一个工作目录 ⇒ 文件糊在一起');
  assert.equal(pathA.agentCwd, nodePath.join(workspacesRoot(w.dir), 'alpha'));
  assert.equal(pathMain.agentCwd, w.cfg.agentCwd, '★ 主线的工作目录一个字都没动');

  assert.equal(agentKeyFor('u1', 'alpha'), 'u1/alpha');
  assert.equal(agentKeyFor('u1', 'beta'), 'u1/beta');
  assert.equal(agentKeyFor('u1'), 'u1/main', '★ 主线的键逐字不变');
  assert.notEqual(agentKeyFor('u1', 'alpha'), agentKeyFor('u1', 'beta'));

  // ★ **DSH 是按 cwd 给会话分组的**（`prune.groupSlugFor`）——
  //   "两个 app 落进同一个 slug ⇒ 红"这条反例就打在它上面。
  const slugA = groupSlugFor(pathA.agentCwd);
  const slugB = groupSlugFor(pathB.agentCwd);
  assert.notEqual(slugA, slugB, '🔴 两个 app 的会话落进同一个 slug ⇒ 甲的话进乙的窗口');
  assert.notEqual(slugA, groupSlugFor(pathMain.agentCwd), '★ app 的会话也不许和主线混一组');

  // **反例的正身**：键里不带 scope（今天那种写法）时，两个 app **就是同一个键**
  const withoutScope = () => agentKeyFor('u1');
  assert.equal(
    withoutScope('alpha'), withoutScope('beta'),
    '反例：这就是"两个 app 落进同一个 slug"的撞法 —— 上面那条 notEqual 正是为它写的',
  );

  // 真 spawn：两个房间各自起一个 agent，cwd 必须是各自的工作区
  await post(h, '/api/say', { messageId: 'a1', text: '在甲的房间里说', scope: 'alpha' }, 'u1');
  await post(h, '/api/say', { messageId: 'b1', text: '在乙的房间里说', scope: 'beta' }, 'u1');
  await waitForCount(h, 2);
  const keys = h.runtime.snapshot().map((x) => x.sessionId).sort();
  assert.deepEqual(keys, ['u1/alpha', 'u1/beta'], `★ 池里必须是两个房间两个键；实际=${JSON.stringify(keys)}`);
  const cwds = h.spawned.map((s) => s.cwd);
  assert.ok(cwds.includes(pathA.agentCwd), `★ 甲的 agent 的 cwd 必须是甲的工作区；实际 ${JSON.stringify(cwds)}`);
  assert.ok(cwds.includes(pathB.agentCwd), `★ 乙的 agent 的 cwd 必须是乙的工作区；实际 ${JSON.stringify(cwds)}`);
  // ⚠️ **DSH_HOME 还是每人一份**（硬规则第 3 条是"每人一份"，不是"每间一份"）
  assert.ok(
    h.spawned.filter((s) => s.cwd === pathA.agentCwd || s.cwd === pathB.agentCwd)
      .every((s) => s.dshHome === pathA.dshHome),
    '★ 房间共用这个人那份 DSH_HOME（会话靠 cwd 分组，不靠换 home）',
  );
  await h.close();
});

test('★ A2 反例：不合法 / 保留的 scope 名字一律拒（不许拼进路径）', () => {
  for (const bad of ['../etc', 'a/b', 'A', '', '-x', 'x'.repeat(33), null]) {
    assert.equal(safeScope(bad), null, `这不是个合法 scope：${String(bad)}`);
    assert.throws(() => checkScope(bad), /不合法|主线/, `必须拒：${String(bad)}`);
  }
  assert.throws(() => checkScope('main'), /主线/, '🔴 `main` 是主线那个房间，不许当工作区');
});

// ════════════════════════════════════════════════════════════════
// A3 · 对话分家
// ════════════════════════════════════════════════════════════════

test('🔴 A3：A 房间说的话，B 房间**看不到**（正对照：A 自己那间有）', async () => {
  const h = await boot();
  makeScope(h, 'u1', 'alpha');
  makeScope(h, 'u1', 'beta');
  const w = h.worlds.worldFor('u1');

  assert.equal((await post(h, '/api/say', { messageId: 'a1', text: '甲的暗号-ALPHA', scope: 'alpha' }, 'u1')).status, 200);
  assert.equal((await post(h, '/api/say', { messageId: 'b1', text: '乙的暗号-BETA', scope: 'beta' }, 'u1')).status, 200);

  const page = async (sub, scope) => {
    const q = new URLSearchParams({ before: '9999', limit: '100' });
    if (scope) q.set('scope', scope);
    const r = await get(h, `/api/timeline?${q}`, sub);
    assert.equal(r.status, 200);
    return (await r.json()).frames;
  };
  const textOf = (frames) => frames.map((f) => f.text ?? '').join('\n');

  const a = await page('u1', 'alpha');
  const b = await page('u1', 'beta');
  const main = await page('u1', null);
  assert.match(textOf(a), /甲的暗号-ALPHA/, '★ 甲那间必须有自己说的话');
  assert.doesNotMatch(textOf(a), /乙的暗号-BETA/, '🔴 甲的房间里不许出现乙的话');
  assert.match(textOf(b), /乙的暗号-BETA/, '负向对照：乙那间也有自己的');
  assert.doesNotMatch(textOf(b), /甲的暗号-ALPHA/, '🔴 乙的房间里不许出现甲的话');
  assert.doesNotMatch(textOf(main), /暗号-ALPHA|暗号-BETA/, '🔴 主线里两间房的话都不许出现');

  // ★ 事件上带的是**真的 scope**（不是恒 'main'）
  const alphaEcho = a.find((f) => f.type === 'user/echo' && f.text === '甲的暗号-ALPHA');
  assert.equal(alphaEcho.scopeId, 'alpha', '★ 事件里的 scopeId 必须是真的 scope');
  // ⚠️ 主线那一份**一条 echo 都不该有**（A3 里没人跟主线说过话）——
  //    反过来说：分家分得对，就不会有东西漏到主线那条日志里。
  assert.equal(main.some((f) => f.type === 'user/echo'), false, '🔴 主线里不许出现任何一间房的话');

  // ★ **流也是分家的**（WS 连接级 scope，照 `level` 那个先例）
  const { ws: wsA, frames: fa } = await wsConnect(h.origin, { token: tokenFor(h, 'u1'), scope: 'alpha' });
  const { ws: wsB, frames: fb } = await wsConnect(h.origin, { token: tokenFor(h, 'u1'), scope: 'beta' });
  // ⚠️ **等"该到的真的到了"**（补发是连上之后发的，睡一觉赌它是会假红的）
  await waitFor(() => fa.some((x) => x.text === '甲的暗号-ALPHA'), '甲的流里没补发出自己那句');
  await waitFor(() => fb.some((x) => x.text === '乙的暗号-BETA'), '乙的流里没补发出自己那句');
  await sleep(40); // 补发是一口气发的 ⇒ 再多给一帧的时间，才判"另一间的话不许出现"
  wsA.close();
  wsB.close();
  const fA = textOf(fa.filter((x) => x.type === 'user/echo'));
  const fB = textOf(fb.filter((x) => x.type === 'user/echo'));
  assert.match(fA, /甲的暗号-ALPHA/);
  assert.doesNotMatch(fA, /乙的暗号-BETA/, '🔴 甲的流里不许补发出乙的话');
  assert.match(fB, /乙的暗号-BETA/);
  assert.doesNotMatch(fB, /甲的暗号-ALPHA/, '🔴 乙的流里不许补发出甲的话');

  // ★ **反例的正身**（2026-09-25 按手册 P-l **改了**，契约 `84-DISPATCHER-FOCUS.md` §六）：
  //
  //   ⚠️ **为什么改**：这几行原来断言的是"每 scope 一份日志、各一套号"
  //      （`scope-alpha.jsonl` / `scope-beta.jsonl` 各有各的文件）——
  //      那正是 `#121` 走偏的第二处，与 `05-DECISIONS.md` **P-l**
  //      「一条可见时间线 = 一条日志；多作用域只是事件上的标签」**相反**。
  //      收回来之后：**一条日志（`main.jsonl`）、一套号**，
  //      "是哪一间"只住在事件上的 `scopeId`（上面那些 notMatch 靠**视图过滤**成立）。
  //
  //   反例：每 scope 一份日志 ⇒ 下面这两条 `false` / `不存在` 会当场红。
  assert.equal(scopeTimelineId('alpha'), 'main', '🔴 一条可见时间线 = 一条日志（P-l）');
  assert.equal(scopeTimelineId('beta'), 'main');
  assert.equal(w.store.pathFor(scopeTimelineId('alpha')), w.store.pathFor('main'));
  assert.equal(w.store.pathFor(scopeTimelineId('alpha')).endsWith('scope-alpha.jsonl'), false);
  assert.equal(
    nodeFs.existsSync(nodePath.join(w.dir, 'scope-alpha.jsonl')), false,
    '🔴 分家的旧文件不许再出现（反例：每 scope 一份日志 ⇒ 红）',
  );
  assert.equal(nodeFs.existsSync(nodePath.join(w.dir, 'scope-beta.jsonl')), false);
  // 两间的事件确实在**同一个文件**里（判据 F1 在 `scope-single-log.test.js` 里正面钉）
  assert.match(jsonl(w.dir), /甲的暗号-ALPHA/);
  assert.match(jsonl(w.dir), /乙的暗号-BETA/);

  await h.close();
});

test('★ 协议只加可选字段：不给 `scope` 就是主线；给了不存在的 ⇒ 404（不许悄悄回主线）', async () => {
  const h = await boot();
  makeScope(h, 'u1', 'alpha');

  // 不给 scope（老客户端）⇒ 主线，照旧
  assert.equal((await post(h, '/api/say', { messageId: 'm1', text: '主线的话' }, 'u1')).status, 200);
  assert.match(jsonl(h.worlds.pathsFor('u1').dir), /主线的话/);

  // 给了不存在的 ⇒ **如实 404**，而且**什么都没写**
  const miss = await post(h, '/api/say', { messageId: 'm2', text: '进错房间的', scope: 'nope' }, 'u1');
  assert.equal(miss.status, 404);
  assert.doesNotMatch(jsonl(h.worlds.pathsFor('u1').dir), /进错房间的/);

  assert.equal((await get(h, '/api/timeline?before=9&limit=9&scope=nope', 'u1')).status, 404);
  // 不含 scope 的那条（老客户端）照旧 200
  assert.equal((await get(h, '/api/timeline?before=9&limit=9', 'u1')).status, 200);

  // WS：不存在的房间**握手阶段就拒**（不是先连上再关）
  await assert.rejects(() => wsConnect(h.origin, { token: tokenFor(h, 'u1'), scope: 'nope' }), (err) => {
    assert.equal(err.status, 404);
    return true;
  });

  // `parseScope`：缺了 / 空的 ⇒ 主线
  assert.equal(parseScope(''), MAIN_SCOPE);
  assert.equal(parseScope('level=steps'), MAIN_SCOPE);
  assert.equal(parseScope('scope=alpha'), 'alpha');
  assert.equal(parseScope('scope='), MAIN_SCOPE);

  await h.close();
});

// ════════════════════════════════════════════════════════════════
// A4 · 主线不受影响
// ════════════════════════════════════════════════════════════════

test('★ A4：主线（main）不受影响 —— 老对话还在、还能说、号还接着走', async () => {
  const h = await boot();
  const w = h.worlds.worldFor('u1');

  // 先攒一句"老对话"
  assert.equal((await post(h, '/api/say', { messageId: 'old1', text: '主线的老话-A4' }, 'u1')).status, 200);
  const mainFile = jsonl(w.dir);
  assert.match(mainFile, /主线的老话-A4/);
  // ★ **主线的 user/echo 逐字不变**：盘上老事件没有 `scopeId`，新事件也不许有
  const mainEchoes = mainFile.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => e.type === 'user/echo');
  assert.ok(mainEchoes.length >= 1);
  assert.equal('scopeId' in mainEchoes[0], false, '★ 主线那条**不带**这个字段（与盘上老事件逐字一致）');
  // ⚠️ **等那一轮真的收口了再记号**：agent 的事件是异步落盘的，
  //    不收口就记号 ⇒ "下一句 = 这个号 + 1"会时灵时不灵（这条判据第一版就假红过）。
  await waitFor(() => jsonl(w.dir).includes('"message/end"'), '主线那一轮还没收口');
  const beforeSeq = w.timeline.seq;

  // 造个 app，在它房间里说一句
  makeScope(h, 'u1', 'alpha');
  assert.equal((await post(h, '/api/say', { messageId: 's1', text: '房间里的新话', scope: 'alpha' }, 'u1')).status, 200);

  // ★ **盘上是同一条日志**（2026-09-25 按 P-l **改了**，契约 84 §六）：
  //   ⚠️ **为什么改**：原来这三行断言"文件里不许出现房间的话"＋"房间的事件不占号"
  //      —— 那是"每 scope 一份日志 / 各一套号"的旧契约（`#121` 走偏的第二处），
  //      与 `05-DECISIONS.md` P-l「一条可见时间线 = 一条日志；编号是一条线」**相反**。
  //   ⇒ 现在：房间的话**就在那个文件里**（靠 `scopeId` 标签分），而且**占同一条线的号**。
  //      "主线那一眼看不到它"这条**行为**没变 —— 改由**主线视图**保证（下面那一条钉它）。
  const after = jsonl(w.dir);
  assert.match(after, /主线的老话-A4/, '★ 老对话还在');
  assert.match(after, /房间里的新话/, '★ 一条日志：房间的话也在这个文件里（标签是 `scopeId`）');
  assert.equal(w.store.pathFor('main').endsWith('main.jsonl'), true, '★ 只有那一条日志');

  // ★ **主线那层视图**看不到房间的话（行为一个字没改；反例：不按标签挑 ⇒ 红）
  assert.equal(
    w.timeline.readAll().some((e) => e.text === '房间里的新话'), false,
    '🔴 主线视图里不许出现房间的话（A4 保的是**这一条**）',
  );

  // ★ 号：**一条线**（判据 F1）—— 房间的事件也占这条线的号
  assert.ok(w.timeline.seq > beforeSeq, '★ 房间的事件占**同一条线**的号（P-l）');
  const afterRoomSeq = w.timeline.seq;

  // 主线还能说，而且接着原来的号
  const again = await post(h, '/api/say', { messageId: 'old2', text: '主线接着说-A4' }, 'u1');
  assert.equal(again.status, 200);
  assert.equal((await again.json()).seq, afterRoomSeq + 1, '★ 号接着走、不跳（一条线，分家没把它弄坏）');

  // 主线的流照旧
  const { ws, frames } = await wsConnect(h.origin, { token: tokenFor(h, 'u1') });
  await waitFor(
    () => frames.some((f) => f.type === 'user/echo' && f.text === '主线接着说-A4'),
    '主线的流里没补发出那句话',
  );
  await sleep(40);
  ws.close();
  assert.ok(frames.some((f) => f.type === 'user/echo' && f.text === '主线接着说-A4'), '★ 主线流照旧');
  assert.equal(frames.some((f) => f.text === '房间里的新话'), false, '🔴 主线流里不许出现房间的话');

  // 主线的身份逐字不变
  assert.equal(w.agentKey, 'u1/main');
  assert.equal(w.scopeId, 'main');
  assert.equal(w.cfg.agentCwd, h.worlds.pathsFor('u1').agentCwd);
  assert.equal(w.timeline.id, 'main');
  await h.close();
});

// ════════════════════════════════════════════════════════════════
// A5 · 制品库是快照
// ════════════════════════════════════════════════════════════════

test('🔴 A5：工作区改了没发布 ⇒ 线上不变；发布了 ⇒ 变（反例：直接线上读工作区）', async () => {
  const h = await boot();
  const w = h.worlds.worldFor('u1');
  const v1 = '<!doctype html><p>第一版</p>';
  const { manifest } = makeScope(h, 'u1', 'alpha', { 'index.html': v1 });
  assert.equal(manifest.version, 1);

  // 线上那一份（制品库）
  const served = () => w.apps.read('alpha', w.apps.current('alpha'), 'index.html').content.toString('utf8');
  assert.equal(served(), v1);

  // **在工作区里改**（发布之前）
  const v2 = '<!doctype html><p>第二版</p>';
  w.workspaces.write('alpha', { 'index.html': v2 });
  assert.equal(
    w.workspaces.read('alpha').files['index.html'].toString('utf8'), v2,
    '★ 工作区**真的变了**（正对照：别让下面那条变成"文件根本没改"）',
  );
  assert.equal(served(), v1, '🔴 没发布 ⇒ 线上**必须**还是旧的（快照语义）');
  assert.notEqual(served(), w.workspaces.read('alpha').files['index.html'].toString('utf8'),
    '反例：线上那一份与工作区**不是同一处**读的 —— 直接读工作区就会在这里露馅');

  // **发布** = 再从工作区拷一份新的进制品库
  const snap = snapshotWorkspace({
    apps: w.apps, workspaces: w.workspaces, id: 'alpha', title: 'alpha', icon: 'dice',
  });
  assert.equal(snap.manifest.version, 2, '★ 发布了 ⇒ 新的一版');
  assert.equal(served(), v2, '★ 发布之后线上才变');
  // 旧版本不可变：第 1 版还是原来那些字节
  assert.equal(w.apps.read('alpha', 1, 'index.html').content.toString('utf8'), v1, '★ 旧版本原样留着');

  await h.close();
});

// ════════════════════════════════════════════════════════════════
// A6 · 迁移
// ════════════════════════════════════════════════════════════════

test('🔴 A6：迁移把主目录里的小程序搬进工作区（逐字节不变），主目录里不许再留着它', async () => {
  const dataDir = tmp('hupo-ws-mig-');
  const mainDir = nodePath.join(dataDir, 'main');
  const from = nodePath.join(mainDir, 'city-weather');
  nodeFs.mkdirSync(nodePath.join(from, 'assets'), { recursive: true });
  // 盒子里实况那一份是 6750B 的单文件 —— 这里就用那个量级
  const index = `<!doctype html><title>天气</title>\n${'今天晴。'.repeat(900)}`;
  nodeFs.writeFileSync(nodePath.join(from, 'index.html'), index);
  nodeFs.writeFileSync(nodePath.join(from, 'assets', 'app.js'), 'console.log("weather");\n');
  // 主目录里还放一个**不像小程序**的目录（它不许被搬）
  nodeFs.mkdirSync(nodePath.join(mainDir, 'not-an-app'), { recursive: true });
  nodeFs.writeFileSync(nodePath.join(mainDir, 'not-an-app', 'notes.txt'), '随手写的东西\n');

  const src = walkTree(from);
  const before = Object.fromEntries(src.map((rel) => [rel, sha(nodeFs.readFileSync(nodePath.join(from, rel)))]));

  // ① **先只看**：一个字节都不许动（反例的两半：搬丢了 / 没删源）
  const plan = migrateAppWorkspaces({ dataDir, mainDir, apply: false });
  assert.equal(plan.moved.length, 1, JSON.stringify(plan));
  assert.equal(nodeFs.existsSync(from), true, '★ 只看的那一趟**不许动盘**');
  assert.deepEqual(walkTree(from), src);

  // ② 真搬
  const done = migrateAppWorkspaces({ dataDir, mainDir, apply: true });
  assert.equal(done.moved.length, 1, JSON.stringify(done));
  assert.equal(done.moved[0].id, 'city-weather');
  const to = nodePath.join(workspacesRoot(dataDir), 'city-weather');
  assert.equal(nodeFs.existsSync(from), false, '🔴 主目录里不许再留着它');
  assert.equal(nodeFs.existsSync(to), true);
  // **内容逐字节不变**
  assert.deepEqual(compareTrees(to, to), [], '（自检：比对函数本身没坏）');
  for (const rel of src) {
    assert.equal(
      sha(nodeFs.readFileSync(nodePath.join(to, rel))), before[rel],
      `🔴 搬过去之后 ${rel} 必须逐字节一样`,
    );
  }
  assert.deepEqual(walkTree(to).filter((f) => !f.startsWith('.')), src, '★ 文件一个不多一个不少（清单除外）');

  // ③ 登记成 app（制品库那一份也是同样那些字节）
  const apps = new Apps({ dir: dataDir, sub: null });
  assert.equal(apps.current('city-weather'), 1, '★ 搬完要补登记成一个 app');
  assert.equal(apps.read('city-weather', 1, 'index.html').content.toString('utf8'), index);

  // ④ **可重跑**：第二趟什么都不动、也不开新版本
  const twice = migrateAppWorkspaces({ dataDir, mainDir, apply: true });
  assert.equal(twice.moved.length, 0, JSON.stringify(twice));
  assert.equal(apps.current('city-weather'), 1, '★ 重跑不许开新版本（版本不可变）');
  for (const rel of src) {
    assert.equal(sha(nodeFs.readFileSync(nodePath.join(to, rel))), before[rel]);
  }

  // ④b **更强的一条**：把源又造出来一份（模拟"文件又躺回主目录"）⇒
  //    迁移**拒绝对着一个已经存在的工作区下手** —— 绝不覆盖（那会把内容换了）
  nodeFs.mkdirSync(from, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(from, 'index.html'), '<!doctype html><p>另一份完全不同的</p>');
  const third = migrateAppWorkspaces({ dataDir, mainDir, apply: true });
  assert.equal(third.moved.length, 0, JSON.stringify(third));
  assert.equal(third.conflicts.some((c) => c.id === 'city-weather'), true, '🔴 两边都有 ⇒ 必须拒，不许覆盖');
  assert.equal(
    nodeFs.readFileSync(nodePath.join(to, 'index.html'), 'utf8'), index,
    '★ 工作区那一份一个字节都没动',
  );
  nodeFs.rmSync(from, { recursive: true, force: true });

  // ⑤ **不像小程序的目录不动**（反例：见目录就搬）
  assert.equal(nodeFs.existsSync(nodePath.join(mainDir, 'not-an-app', 'notes.txt')), true);
  assert.equal(nodeFs.existsSync(nodePath.join(workspacesRoot(dataDir), 'not-an-app')), false);

  // ⑥ **平行**：workspaces 与 main 是兄弟，不是父子
  assert.equal(nodePath.dirname(mainDir), dataDir);
  assert.equal(nodePath.dirname(workspacesRoot(dataDir)), dataDir);
});

// ════════════════════════════════════════════════════════════════
// A7 · 三条硬规则仍在
// ════════════════════════════════════════════════════════════════

test('🔴 A7：主目录 root 不是 home · main 与 workspaces 平行 · 每人一份 DSH_HOME', async () => {
  const h = await boot();
  const rooms = [
    { who: 'u1', scope: MAIN_SCOPE },
    { who: 'u2', scope: MAIN_SCOPE },
    { who: OWNER_ID, scope: MAIN_SCOPE },
  ];
  // 房间也要有工作区（先造出来）
  makeScope(h, 'u1', 'alpha');
  makeScope(h, 'u2', 'beta');
  rooms.push({ who: 'u1', scope: 'alpha' }, { who: 'u2', scope: 'beta' });

  for (const { who, scope } of rooms) {
    const p = h.worlds.pathsFor(who, scope);
    const mainCwd = h.worlds.pathsFor(who).agentCwd;
    // ① 主目录 root **不是** home（`~/.dsh` / `~/.ssh` / `~/.bashrc` 都不在它下面）
    assert.notEqual(p.agentCwd, p.dshHome, `${who}/${scope}：工作目录不许就是 DSH_HOME`);
    assert.equal(
      p.dshHome.startsWith(`${p.agentCwd}${nodePath.sep}`), false,
      `🔴 ${who}/${scope}：DSH_HOME 不许在工作目录里面（否则 agent 读得到 .credentials.yaml）`,
    );
    // ② `workspaces` 与 `main` **平行**
    assert.equal(
      nodePath.dirname(mainCwd), nodePath.dirname(workspacesRoot(p.dir)),
      `🔴 ${who}/${scope}：main 与 workspaces 必须平行`,
    );
    assert.equal(
      workspacesRoot(p.dir).startsWith(`${mainCwd}${nodePath.sep}`), false,
      `🔴 ${who}/${scope}：workspaces 不许在 main 里面`,
    );
    assert.equal(
      mainCwd.startsWith(`${workspacesRoot(p.dir)}${nodePath.sep}`), false,
      `🔴 ${who}/${scope}：main 也不许在 workspaces 里面`,
    );
  }

  // ③ **每人一份 DSH_HOME**（同名工作区不许撞进同一份记忆）
  assert.notEqual(h.worlds.pathsFor('u1').dshHome, h.worlds.pathsFor('u2').dshHome);
  assert.equal(
    h.worlds.pathsFor('u1', 'alpha').dshHome, h.worlds.pathsFor('u1').dshHome,
    '★ 房间共用**这个人**那份 DSH_HOME（会话靠 cwd 分组）',
  );

  // **反例的正身**：把 workspaces 挪进 main ⇒ 上面那条平行判据当场红
  const mainCwd = h.worlds.pathsFor('u1').agentCwd;
  const wrong = nodePath.join(mainCwd, 'workspaces');
  assert.notEqual(
    nodePath.dirname(wrong), nodePath.dirname(mainCwd),
    '反例：workspaces 挪进 main 之后就不是兄弟了 —— 这条判据正是为它写的',
  );
  assert.equal(
    wrong.startsWith(`${mainCwd}${nodePath.sep}`), true,
    '（同上：那种摆法会被上面那条红线抓住）',
  );

  await h.close();
});

test('★ A1 反例（负向）：工作区名字 / 制品路径越界一律拒（`..` 跑不出根外）', () => {
  const dir = tmp('hupo-ws-safe-');
  const ws = new AppWorkspaces({ dir });
  assert.throws(() => ws.ensure('../escape'), /不合法/);
  ws.ensure('ok', { title: 'ok' });
  assert.throws(() => ws.write('ok', { '../escape.html': 'x' }), /路径|不许/);
  assert.throws(() => ws.write('ok', { '/etc/passwd': 'x' }), /路径|不许/);
  assert.throws(() => ws.write('ok', { '.hupo.json': '{}' }), /工作区自己在用/);
  assert.equal(nodeFs.existsSync(nodePath.join(dir, 'escape')), false);
});

test('★ 盒子里：新工作区要交给 agent 的 uid；宿主上一步都不做', () => {
  const dir = tmp('hupo-ws-hand-');
  // 🔴 盒子的形状：服务是 root、agent 是 1000 ⇒ 刚建的那一格必须交出去
  //    （不交 ⇒ agent 写不进自己的工作区，正是那两条套接字踩过的 EACCES）
  const calls = [];
  const spied = { ...nodeFs, chownSync: (p, u, g) => calls.push([p, u, g]) };
  const boxed = new AppWorkspaces({
    dir,
    fs: spied,
    env: { HUPO_AGENT_UID: '1000', HUPO_AGENT_GID: '1000' },
    uid: 0,
    log: () => {},
  });
  boxed.ensure('alpha', { title: 'alpha' });
  assert.ok(calls.length > 0, '★ 盒子里建出来的工作区必须交给 agent');
  assert.ok(calls.every(([, u, g]) => u === 1000 && g === 1000), JSON.stringify(calls));
  assert.ok(calls.some(([p]) => p.endsWith(nodePath.join('workspaces', 'alpha'))), '目录本身要交出去');
  assert.ok(calls.some(([p]) => p.endsWith('index.html')), '骨架那个文件也要交出去');
  // 写进新文件之后同样要交（否则 agent 改不动它自己刚写的东西）
  calls.length = 0;
  boxed.write('alpha', { 'app.js': 'x' });
  assert.ok(calls.some(([p]) => p.endsWith('app.js')), JSON.stringify(calls));

  // 宿主：没配 `HUPO_AGENT_UID` ⇒ **一步都不做**（服务的身份就是 agent 的身份）
  let touched = 0;
  const hostFs = { ...nodeFs, chownSync: () => { touched += 1; } };
  const host = new AppWorkspaces({ dir, fs: hostFs, env: {}, uid: 501 });
  host.ensure('beta', { title: 'beta' });
  assert.equal(touched, 0, '★ 宿主上不许 chown（那会把文件交给一个不相干的人）');
});

// ════════════════════════════════════════════════════════════════
// A1·补 ·「**发现就报**」（主人 2026-09-25 · 契约 §四）
//
// 这一条补的是 A1 那条缝的**另一半**：
//
//   A1（上面那几条）证的是"**造 app ⇒ 文件只落进它自己的工作区**"——那是**硬的**，
//   因为 `app_create` 由**服务端**那一刀写进 `<dir>/workspaces/<scope>/`。
//
//   🔴 **但**模型在主房间那一轮里**另外**用通用写文件 / 执行命令写相对路径时，
//      那些会落 `<dir>/main` —— DSH 的 cwd **启动时定死**、一轮中途换不了
//      ⇒ 服务端**拦不住**通用文件写。
//
// ⇒ 这一条是"**检测不阻止，但绝不许它静默发生**"：
//     这一轮**确实造过 app**、而且主目录**多出了新文件**
//     ⇒ ① 账上一行（审计日志）② 用现成那条通道讲给他听（`Notice`）。
//
// 🔴 **反例比正例更要紧**：没造 app 的一轮，主目录多出文件**很正常**
//    （那就是主房间自己的工作目录）⇒ **一个字的报告都不许有**。
// ════════════════════════════════════════════════════════════════

test('★ A1·补（纯函数）：只记路径 · 差集只认"多出来的" · 文案最多列前几个', () => {
  const dir = tmp('hupo-leak-');
  nodeFs.mkdirSync(nodePath.join(dir, 'sub'), { recursive: true });
  nodeFs.writeFileSync(nodePath.join(dir, 'a.txt'), 'a');
  nodeFs.writeFileSync(nodePath.join(dir, 'sub', 'b.js'), 'b');
  const before = listFiles(dir);
  assert.deepEqual(before, ['a.txt', 'sub/b.js'], '递归、相对路径、排好序');

  // **只记路径**：内容改了不算"多出东西"（不然一次重写就误报）
  nodeFs.writeFileSync(nodePath.join(dir, 'a.txt'), 'a2');
  assert.deepEqual(addedPaths(before, listFiles(dir)), [], '改了内容 ⇒ 零新增');

  // 真多出来一个
  nodeFs.writeFileSync(nodePath.join(dir, 'c.md'), 'c');
  assert.deepEqual(addedPaths(before, listFiles(dir)), ['c.md']);

  // 报告：**只列前几个**，但总数如实（别把整棵树刷进日志）
  const many = ['file-a', 'file-b', 'file-c', 'file-d', 'file-e', 'file-f', 'file-g'];
  const r = leakReport({ apps: ['dice'], paths: many });
  assert.deepEqual(r.shown, many.slice(0, MAIN_LEAK_MAX_PATHS));
  assert.equal(r.total, 7);
  assert.equal(r.more, 2);

  const text = leakNoticeText(r);
  assert.match(text, /dice/, '没有名字时退回 id（**不编**）');
  assert.match(text, /file-a/, '列出来的那几个要在');
  assert.match(text, /还有 2 个/, '没列出来的要说清还有几个');
  assert.doesNotMatch(text, /file-f|file-g/, '没列出来的不许出现在话里');
  // **有名字就用名字**：给他看的那句话里不许露出内部那个 slug
  const named = leakNoticeText(leakReport({ apps: ['city-weather'], titles: ['天气'], paths: ['x.txt'] }));
  assert.match(named, /天气/);
  assert.doesNotMatch(named, /city-weather/, '🔴 内部 slug 不许露给他看');
  // 禁用词（与 `notice.test.js` ⑤ 同一张表的口径）：这是**缺陷**，不是文风问题
  for (const w of ['工作区', '客户端', '云端', '口令', '连接', '工具', '调度器', '时间线', '会话', '服务器', '模型', '搜索']) {
    assert.ok(!text.includes(w), `通知里出现内部词「${w}」：${text}`);
  }
});

test('★ A1·补（`MainLeakWatch`）：三条路都走 `finish`；没造 / 没多出 ⇒ 零报告', () => {
  const dir = tmp('hupo-leak-watch-');
  const seen = [];
  const watch = new MainLeakWatch({ dir, onLeak: (r) => seen.push(r), log: () => {} });

  // 不在某一轮里 ⇒ 记了也不作数（没有起点清单可比）
  assert.equal(watch.noteBuilt({ id: 'dice' }), false);
  assert.equal(watch.finish({ turn: 0, reason: 'completed' }), null);

  // 一轮开始 → 造了 → 主目录没多出 ⇒ **不报**
  watch.start();
  assert.equal(watch.noteBuilt({ id: 'dice' }), true);
  assert.equal(watch.finish({ turn: 1, reason: 'completed' }), null, '干净的一轮不该被念');
  assert.deepEqual(seen, []);

  // 一轮开始 → 造了 → 主目录多出一个 ⇒ 报（而且带得出是哪条路收的）
  watch.start();
  watch.noteBuilt('dice');
  nodeFs.writeFileSync(nodePath.join(dir, 'leak.txt'), 'x');
  const r = watch.finish({ turn: 2, reason: 'timeout' });
  assert.ok(r, '★ 该报的时候必须报');
  assert.deepEqual(r.paths, ['leak.txt']);
  assert.deepEqual(r.apps, ['dice']);
  assert.equal(r.reason, 'timeout');
  assert.equal(seen.length, 1);

  // **没造 app** 的一轮：主目录多出文件也**一个字都不报**
  watch.start();
  nodeFs.writeFileSync(nodePath.join(dir, 'ordinary.txt'), 'x');
  assert.equal(watch.finish({ turn: 3, reason: 'failed' }), null, '🔴 没造 app ⇒ 零报告');
  assert.equal(seen.length, 1, '🔴 上一条报告不许被这一轮重复念');

  // 一轮只报一次（收口之后再收一次也不许把上一轮的账翻出来）
  assert.equal(watch.finish({ turn: 4, reason: 'completed' }), null);
  assert.equal(seen.length, 1);
});

test('★ A1·补：装上来那条路同样算"这一轮造了 app"（不许只认 `create`）', async () => {
  const h = await boot();
  const u1 = h.worlds.worldFor('u1');
  const u2 = h.worlds.worldFor('u2');
  u2.workspaces.ensure('shared-two', { title: '共享的', entry: 'index.html' });
  u2.workspaces.write('shared-two', {
    'index.html': '<p>共享</p>',
    // ★ A16：外联申报（93 §2.2）—— 没有它上架拒（fail-closed）
    'outbound.json': JSON.stringify({
      schema: 1, outbound: [],
      declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '还没人用过，先按 0 报' },
    }),
  });
  snapshotWorkspace({ apps: u2.apps, workspaces: u2.workspaces, id: 'shared-two', title: '共享的', icon: 'dice' });
  u2.published.publish(u2.apps, { id: 'shared-two', authorSub: 'u2', authorName: '乙' });

  const built = [];
  const r = await handleAppsOp(
    u1.apps,
    { op: 'install', id: 'shared-two' },
    {
      published: u1.published,
      sub: 'u1',
      workspace: u1.workspaces,
      onAppBuilt: (info) => built.push(info),
    },
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(built, [{ id: 'shared-two', title: '共享的', op: 'install' }], '★ 装上来也要记一笔');
  await h.close();
});

test('🔴 A1·补（正例）：造 app 的那一轮主目录多出文件 ⇒ 账上一行 + 他看得见一条', async () => {
  const h = await boot({ scenario: 'slow' });
  const w = h.worlds.worldFor('u1');
  const mainDir = w.cfg.agentCwd;
  await w.appsSocket.ready();

  // 他明说要做 ⇒ 这一轮才算"造东西的那一轮"（那条闸看的是**当轮那句话**）
  assert.equal(
    (await post(h, '/api/say', { messageId: 'm1', text: '帮我做一个小程序：掷硬币' }, 'u1')).status,
    200,
  );
  await waitFor(() => w.dispatcher.turnInput !== '', '这一轮还没开始（turn-start 没到）');
  // ★ **真那一刀**：走真域套接字造（服务端自己把它写进工作区）
  const made = await askApps(w.appsSocket.path, {
    op: 'create',
    app: { id: 'dice', title: '掷硬币', entry: 'index.html', files: { 'index.html': '<p>正</p>' } },
  });
  assert.equal(made.ok, true, JSON.stringify(made));
  // 🔴 **反例的正身**：模型**另外**用通用写文件写了一个相对路径 ⇒ 它落在主目录
  nodeFs.writeFileSync(nodePath.join(mainDir, 'leaked-notes.txt'), '我随手写的\n');

  await waitFor(() => jsonl(w.dir).includes('"message/end"'), '这一轮没收口');

  // ① **账上一行**：谁 / 哪个 app / 多出来哪些路径
  const log = auditText(h);
  assert.match(log, /leaked-notes\.txt/, `账上必须有那条路径：${log}`);
  assert.match(log, /dice/, `账上必须说清哪个 app：${log}`);
  assert.ok(log.includes(MAIN_LEAK_WHAT), `账上那一行的形状照 \`audit.js\`：${log}`);

  // ② **他看得见**：走现成那条通道（`Notice`：落盘、取号）
  const ns = noticesOf(w).filter((e) => String(e.text).includes('leaked-notes.txt'));
  assert.equal(ns.length, 1, `★ 必须有一条他看得见的；实际=${JSON.stringify(noticesOf(w))}`);
  assert.equal(ns[0].kind, 'failed', '用既有的那个 kind（不许新造一套）');
  assert.equal(typeof ns[0].seq, 'number', '★ 它是**落盘取号**的那一条，不是瞬态');
  assert.match(ns[0].text, /掷硬币/, '给他看的时候用**那个小程序的名字**');
  assert.doesNotMatch(ns[0].text, /dice/, '🔴 内部那个 slug 不许露给他看（账上留着就够了）');

  await h.close();
});

test('🔴 A1·补（反例一）：**没造 app** 的一轮，主目录多出文件 ⇒ 零报告（不许多话）', async () => {
  const h = await boot({ scenario: 'slow' });
  const w = h.worlds.worldFor('u1');
  const mainDir = w.cfg.agentCwd;

  assert.equal((await post(h, '/api/say', { messageId: 'm1', text: '帮我看一下这个' }, 'u1')).status, 200);
  await waitFor(() => w.dispatcher.turnInput !== '', '这一轮还没开始');
  // 主房间自己的工作目录，多出文件**很正常**（那正是它在干活）
  nodeFs.writeFileSync(nodePath.join(mainDir, 'ordinary-work.txt'), '主房间自己的活\n');
  await waitFor(() => jsonl(w.dir).includes('"message/end"'), '这一轮没收口');

  assert.equal(auditText(h).includes('ordinary-work.txt'), false, '🔴 没造 app ⇒ 账上不许有这条');
  assert.equal(
    noticesOf(w).some((e) => String(e.text).includes('ordinary-work')),
    false,
    '🔴 没造 app ⇒ 一条都不许念',
  );
  await h.close();
});

test('🔴 A1·补（反例二）：造了 app 但主目录**没多出**文件 ⇒ 零报告（干净的一轮）', async () => {
  const h = await boot({ scenario: 'slow' });
  const w = h.worlds.worldFor('u1');
  await w.appsSocket.ready();

  assert.equal((await post(h, '/api/say', { messageId: 'm1', text: '帮我做一个小程序' }, 'u1')).status, 200);
  await waitFor(() => w.dispatcher.turnInput !== '', '这一轮还没开始');
  const made = await askApps(w.appsSocket.path, {
    op: 'create',
    app: { id: 'clean-one', title: '干净的', entry: 'index.html', files: { 'index.html': '<p>x</p>' } },
  });
  assert.equal(made.ok, true, JSON.stringify(made));
  await waitFor(() => jsonl(w.dir).includes('"message/end"'), '这一轮没收口');

  assert.deepEqual(walkFiles(w.cfg.agentCwd), [], '这一轮主目录本来就该是空的');
  assert.equal(auditText(h), '', '🔴 没多出东西 ⇒ 账上一行都不许有');
  assert.deepEqual(noticesOf(w), [], '🔴 干净的一轮一条都不许念');
  await h.close();
});

test('🔴 A1·补（反例三·超时）：一轮**中途超时** ⇒ 该比的时候照样比', async () => {
  const h = await boot({ scenario: 'hang', turnDeadlineMs: 400 });
  const w = h.worlds.worldFor('u1');
  const mainDir = w.cfg.agentCwd;
  await w.appsSocket.ready();

  assert.equal((await post(h, '/api/say', { messageId: 'm1', text: '帮我做一个小程序' }, 'u1')).status, 200);
  await waitFor(() => w.dispatcher.turnInput !== '', '这一轮还没开始');
  const made = await askApps(w.appsSocket.path, {
    op: 'create',
    app: { id: 'dice', title: '掷硬币', entry: 'index.html', files: { 'index.html': '<p>正</p>' } },
  });
  assert.equal(made.ok, true, JSON.stringify(made));
  nodeFs.writeFileSync(nodePath.join(mainDir, 'hung-leak.txt'), '还在写\n');

  // 到点（400ms）硬收口 —— **超时那条路也必须比**
  await waitFor(() => jsonl(w.dir).includes('"reason":"timeout"'), '超时没收口', 8000);
  assert.match(auditText(h), /hung-leak\.txt/, '🔴 只在"正常结束"那条路上比 = 漏掉这一条');
  assert.equal(
    noticesOf(w).some((e) => String(e.text).includes('hung-leak.txt')),
    true,
    '超时那条路也要让他看得见',
  );
  await h.close();
});

test('🔴 A1·补（反例三·失败）：一轮**中途失败**（进程没了）⇒ 该比的时候照样比', async () => {
  const h = await boot({ scenario: 'hang', turnDeadlineMs: 60_000 });
  const w = h.worlds.worldFor('u1');
  const mainDir = w.cfg.agentCwd;
  await w.appsSocket.ready();

  assert.equal((await post(h, '/api/say', { messageId: 'm1', text: '帮我做一个小程序' }, 'u1')).status, 200);
  await waitFor(() => w.dispatcher.turnInput !== '', '这一轮还没开始');
  const made = await askApps(w.appsSocket.path, {
    op: 'create',
    app: { id: 'dice', title: '掷硬币', entry: 'index.html', files: { 'index.html': '<p>正</p>' } },
  });
  assert.equal(made.ok, true, JSON.stringify(made));
  nodeFs.writeFileSync(nodePath.join(mainDir, 'die-leak.txt'), '写到一半\n');

  // **这一轮中途失败**：把 agent 卸掉（真那一条路：`onEvict` ⇒ `force-close`）
  await h.runtime.stop(w.agentKey, { reason: 'test' });
  await waitFor(() => auditText(h).includes('die-leak.txt'), '失败那条路没比', 8000);
  assert.equal(
    noticesOf(w).some((e) => String(e.text).includes('die-leak.txt')),
    true,
    '失败那条路也要让他看得见',
  );
  await h.close();
});

// ════════════════════════════════════════════════════════════════
// B16 · **桌面上的每个图标都有自己的房间**（`docs/dev/77-BLOCKERS.md` 的 B16 ·
//       主人 2026-09-25 原话：*"要分家"*）
//
// 原来只给 `/api/apps` 里那些"我的小程序"分房间；桌面上的内置那三个
// （设置 / 发现 /「我自己那台」）**不在**那份清单里、服务端没有它们的 id
// ⇒ 在它们那几屏里说的话落进**主线**。主人把这件事定成**要分家**：
// 桌面上的**每个**图标都是自己的房间，而且与小程序的房间**同一套不变量**。
//
// 四条判据（每条都带反例）：
//   B16-1 三个内置 id 各自一个 scope：**在 A 房里说的话，B 房里看不到**（主线也不受影响）
//         ⚠️ 判的是"看不看得见"，**不是**"每个 scope 一份日志文件 / 各有一套编号"——
//            手册 `05-DECISIONS.md` P-l：**一条可见时间线 = 一条日志，scope 只是事件上的标签**。
//   B16-2 内置房间的 cwd = `<dir>/workspaces/<id>/`，第一次用到时建、**交给 agent 的 uid**
//   B16-3 app **不许占用**这些保留 id（人话拒）；主线与既有小程序房间**行为不变**
//   B16-4 客户端纯逻辑那一条在 `v2/apps/mobile/test/unit/scope_test.dart`
// ════════════════════════════════════════════════════════════════

test('★ B16：内置那三个**是合法房间**，但**不许被 app 占用**（纯规则，含反例）', () => {
  // 🔴 与客户端 `lib/models/app_spec.dart` 的 `builtIn*Id` **逐字一致**
  //    （对不上 ⇒ 客户端拿着一个服务端不认识的 scope 去连 = 404）
  assert.deepEqual([...BUILTIN_SCOPES], ['settings', 'discover', 'harness']);
  for (const id of BUILTIN_SCOPES) {
    assert.equal(isBuiltinScope(id), true);
    assert.equal(safeScope(id), id, `内置 id 本身就得是合法 scope：${id}`);
    assert.equal(checkScope(id), id, `★ ${id} 过得了 checkScope —— 它是**房间**，不是保留名`);
  }
  // 保留名单 = 主线 ＋ 三个内置（app 一个都不许占）
  assert.deepEqual([...RESERVED_APP_SCOPES], ['main', 'settings', 'discover', 'harness']);

  // **反例**：不是内置的照旧不是；认不出的一律 `false`（不许猜）
  //   ⚠️ **2026-09-25（契约 `105-DROP-MATH.md` §一⑤）：`'math'` 就住在这一串里** ——
  //      奥数题那个内置格从产品里去掉了 ⇒ 它**不再是**内置、也不再是保留 id。
  for (const bad of ['Setting', 'dice', 'main', '', null, 'settings-x', 'math']) {
    assert.equal(isBuiltinScope(bad), false, `这不该被当成内置：${String(bad)}`);
  }
  // 而 `main` 仍然由 `checkScope` 拦（老规矩一个字没动）
  assert.throws(() => checkScope('main'), /主线/);
});

// ════════════════════════════════════════════════════════════════
// M3 · **`math` 不再是合法房间**（契约 `docs/dev/105-DROP-MATH.md` §一⑤ / §三·M3）
//
// 奥数题那个内置格从产品里去掉了（主人 2026-09-25 拍的「乙」）⇒ 它原来在
// `BUILTIN_SCOPES` 里那一个名字也要收走 —— **不收拾干净就是"半截"**：
// 白名单里留着 `math`，`?scope=math` 就还是"服务端认得的房间"。
//
// ⚠️ **不动盒里那一间的历史数据**（契约 §二）：这一条只判"名字还认不认"，
//    一个字节都不碰 `main.jsonl` 里那些 `scopeId: 'math'` 的老事件。
//    ⇒ 副作用如实说：他盒子里若已经建过 `workspaces/math/`，那一间**还进得去**
//      （`workspaces.has` 看盘上事实），只是桌面上**没有那一格**了。
// ════════════════════════════════════════════════════════════════

test('🔴 M3（105）：`math` 不再是合法房间（白名单 ＋ 真入口两条路都对）', async () => {
  // ① 纯规则那一半：白名单与"是不是内置"都不认它了
  assert.equal(BUILTIN_SCOPES.includes('math'), false, '★ 奥数题去掉了 ⇒ `math` 不许还在房间白名单里');
  assert.equal(isBuiltinScope('math'), false, '★ `math` 不再是内置房间');
  // 保留名单（不许当 app）也跟着收掉 —— 一份留、一份走就是"两处数字不一致"
  assert.equal(RESERVED_APP_SCOPES.includes('math'), false, '★ 那个名字已经还给用户了（不再保留）');
  // ⚠️ 形状那一层照旧过：`math` 只是**不再特殊**，不是"名字不合法"
  assert.equal(safeScope('math'), 'math', '★ 它只是不再特殊，不是一个非法名字');

  // ② 真入口那一半：没建过这一间的世界里，`?scope=math` 必须被当成"没有这个房间"
  const h = await boot();
  const bad = await get(h, '/api/timeline?before=9999&limit=10&scope=math', 'u1');
  assert.equal(bad.status, 404, `★ \`?scope=math\` 该被当成"没有这个工作区"：${await bad.text()}`);
  assert.equal((await post(h, '/api/say', { messageId: 'm-math', text: '这一间不该还能说话', scope: 'math' }, 'u1')).status, 404,
    '★ `/api/say` 的 `scope=math` 也要拒（两条真入口都收干净）');
  // **负向对照的正身**：剩下那三个内置照旧进得去
  //   （不然这一条量的只是"所有房间都 404"）
  for (const id of BUILTIN_SCOPES) {
    const ok = await get(h, `/api/timeline?before=9999&limit=10&scope=${id}`, 'u1');
    assert.equal(ok.status, 200, `★ ${id} 还是合法房间（对照）：${await ok.text()}`);
  }
  await h.close();
});

test('🔴 B16-1：三个内置房间各自一个 scope（A 房的话 B 房看不到；主线不受影响）', async () => {
  const h = await boot();
  const w = h.worlds.worldFor('u1');

  // 每间各说一句（走真 HTTP、真落盘）＋ 主线一句
  for (const id of BUILTIN_SCOPES) {
    const r = await post(h, '/api/say', { messageId: `m-${id}`, text: `暗号-${id}`, scope: id }, 'u1');
    assert.equal(r.status, 200, `★ ${id} 那一间必须能说话（它现在是合法房间）：${await r.text()}`);
  }
  assert.equal((await post(h, '/api/say', { messageId: 'm-main', text: '暗号-main' }, 'u1')).status, 200);

  const page = async (scope) => {
    const q = new URLSearchParams({ before: '9999', limit: '200' });
    if (scope) q.set('scope', scope);
    const r = await get(h, `/api/timeline?${q}`, 'u1');
    assert.equal(r.status, 200, `翻 ${scope ?? 'main'} 那一间`);
    return (await r.json()).frames;
  };
  const textOf = (frames) => frames.map((f) => f.text ?? '').join('\n');

  for (const id of BUILTIN_SCOPES) {
    const mine = await page(id);
    assert.match(textOf(mine), new RegExp(`暗号-${id}`), `★ ${id} 那一间必须有自己那句话`);
    for (const other of BUILTIN_SCOPES) {
      if (other === id) continue;
      assert.doesNotMatch(
        textOf(mine), new RegExp(`暗号-${other}`),
        `🔴 ${id} 那一间不许出现 ${other} 的话（反例：共用一条 timeline ⇒ 红）`,
      );
    }
    assert.doesNotMatch(textOf(mine), /暗号-main/, `🔴 ${id} 那一间不许出现主线的话`);
    // ★ 事件里带的是**真的** scopeId（不是恒 'main'）—— 这就是"分家"落在盘上的那个标签
    //   ⚠️ 只判标签，**不判**它住在哪个文件里（P-l：一条日志，scope 只是标签）
    const echo = mine.find((f) => f.type === 'user/echo' && f.text === `暗号-${id}`);
    assert.equal(echo.scopeId, id, '★ 事件里的 scopeId 必须是那个内置 id');
  }

  // **主线**：自己那句在、三间的话一句都没漏进来
  const main = textOf(await page(null));
  assert.match(main, /暗号-main/);
  for (const id of BUILTIN_SCOPES) {
    assert.doesNotMatch(main, new RegExp(`暗号-${id}`), `🔴 主线里不许出现 ${id} 那一间的话`);
  }
  // **主线本身**的身份一个字都没动
  assert.equal(w.scopeId, 'main');
  assert.equal(w.agentKey, 'u1/main');
  assert.equal(w.timeline.id, 'main');

  // **反例的正身**：几间共用一个 scope（今天之前那种）= 上面那几条"看不到"会一起红
  assert.equal(new Set(BUILTIN_SCOPES).size, BUILTIN_SCOPES.length, '三个内置 id 不许有重的');
  await h.close();
});

test('🔴 B16-2：内置房间的 cwd 就是它自己的工作区（第一次用到时建、交给 agent 的 uid）', async () => {
  const h = await boot();
  const w = h.worlds.worldFor('u1');
  const mainDir = w.cfg.agentCwd;
  const root = workspacesRoot(w.dir);

  for (const id of BUILTIN_SCOPES) {
    assert.equal(nodeFs.existsSync(nodePath.join(root, id)), false, `（起点：${id} 的工作区还没建）`);
    const p = h.worlds.pathsFor('u1', id);
    assert.equal(p.agentCwd, nodePath.join(root, id), `★ ${id} 的 cwd 必须是 <dir>/workspaces/<id>`);
    assert.equal(p.agentCwd.startsWith(`${mainDir}${nodePath.sep}`), false, '🔴 不许落在主目录里面');
    // ⚠️ **不许做成"没有工作区"的特例**：DSH_HOME / 本地通道还是这个人那一份
    assert.equal(p.dshHome, w.cfg.dshHome, '★ DSH_HOME 还是每人一份（不是每间一份）');
    assert.equal(p.appsSocketPath, w.cfg.appsSocketPath, '★ 那条本地通道也是每人一份');
  }

  // 走真那一刀：第一次用到（`/api/say`）⇒ **建目录 ＋ 交给 agent**
  const handed = [];
  const orig = w.workspaces.hand.bind(w.workspaces);
  w.workspaces.hand = (id) => { handed.push(id); return orig(id); };
  assert.equal(
    (await post(h, '/api/say', { messageId: 's1', text: '在设置这一间说一句', scope: 'settings' }, 'u1')).status,
    200,
  );
  assert.equal(nodeFs.existsSync(nodePath.join(root, 'settings')), true, '★ 第一次用到时要把工作区建出来');
  assert.ok(
    handed.includes('settings'),
    `★ 必须走 workspace.js 那条唯一规则交给 agent；实际=${JSON.stringify(handed)}`,
  );

  // ★ **真 spawn 出去的那一下**：cwd 必须是那个内置房间的工作区
  //   （只比 `pathsFor` 是抓不到"接线断了"的 —— 与 A2 同一条纪律）
  await waitForCount(h, 1);
  const roomCwd = nodePath.join(root, 'settings');
  assert.ok(
    h.spawned.some((s) => s.cwd === roomCwd),
    `★ 真 spawn 出去的 cwd 必须是 <dir>/workspaces/settings；实际=${JSON.stringify(h.spawned.map((s) => s.cwd))}`,
  );
  assert.ok(
    h.spawned.filter((s) => s.cwd === roomCwd).every((s) => s.dshHome === w.cfg.dshHome),
    '★ DSH_HOME 还是这个人那一份（会话靠 cwd 分组，不是每间一份 home）',
  );
  // ★ **自己的 agentKey**：进程池的键里带 scope ⇒ 一间一个 agent 窗口
  assert.equal(agentKeyFor('u1', 'settings'), 'u1/settings');
  assert.equal(h.worlds.roomFor('u1', 'settings').agentKey, 'u1/settings');
  assert.equal(h.worlds.roomFor('u1', 'settings').scopeId, 'settings');

  // **盒子里的形状**：服务是 root、agent 是 1000 ⇒ 刚建的那一格要 chown 给 1000
  //   （宿主上没有 `HUPO_AGENT_UID` ⇒ 这一步是空操作，所以只能注入着验）
  const dir = tmp('hupo-ws-builtin-hand-');
  const calls = [];
  const boxed = new AppWorkspaces({
    dir,
    fs: { ...nodeFs, chownSync: (p, u, g) => calls.push([p, u, g]) },
    env: { HUPO_AGENT_UID: '1000', HUPO_AGENT_GID: '1000' },
    uid: 0,
    log: () => {},
  });
  // ⚠️ 照 `roomFor` 那一刀的形状建（mkdir ＋ `hand`）——
  //    不走 `ensure`：那一条是"造 app"，内置 id 在那儿是**被拒**的（B16-3）
  nodeFs.mkdirSync(boxed.dirFor('settings'), { recursive: true, mode: 0o700 });
  assert.equal(boxed.hand('settings').hand, true, '盒子形状下必须要交');
  assert.ok(calls.length > 0, '★ 盒子里内置那一格也要交给 agent');
  assert.ok(calls.every(([, u, g]) => u === 1000 && g === 1000), JSON.stringify(calls));
  assert.ok(
    calls.some(([p]) => p.endsWith(nodePath.join('workspaces', 'settings'))),
    '★ 目录本身要交出去（不然 agent 连进都进不去）',
  );

  // **宿主上一步都不做**（没配那两条 env ⇒ `hand` 是空操作）
  let touched = 0;
  const host = new AppWorkspaces({
    dir,
    fs: { ...nodeFs, chownSync: () => { touched += 1; } },
    env: {},
    uid: 501,
  });
  nodeFs.mkdirSync(host.dirFor('discover'), { recursive: true, mode: 0o700 });
  assert.equal(host.hand('discover').hand, false, '★ 宿主上没有"交给谁"这回事');
  assert.equal(touched, 0, '★ 宿主上不许 chown（那会把文件交给一个不相干的人）');

  await h.close();
});

test('🔴 B16-3：内置 id 不许当小程序（人话拒）；主线与既有小程序房间行为不变', async () => {
  const h = await boot({ scenario: 'hang', turnDeadlineMs: 60_000 });
  const w = h.worlds.worldFor('u1');
  const root = workspacesRoot(w.dir);
  await w.appsSocket.ready();

  // 他明说了 ⇒ "他明说才许写"那条闸放行 —— 这一次要卡的**是保留 id 那一条**
  w.dispatcher.deliver('帮我做一个小程序：设置一个闹钟', { messageId: null }).catch(() => {});
  await waitFor(() => w.dispatcher.turnInput !== '', '这一轮还没起来（turn-start 没到）');

  for (const id of BUILTIN_SCOPES) {
    const r = await askApps(w.appsSocket.path, {
      op: 'create',
      app: { id, title: '假的', files: { 'index.html': '<p>不该存在</p>' } },
    });
    assert.equal(r.ok, false, `🔴 "${id}" 是保留 id，必须被拒：${JSON.stringify(r)}`);
    assert.match(String(r.error), /桌面上/, `★ 拒的话必须是**人话**（说得出为什么）：${JSON.stringify(r)}`);
    // 拒了 ⇒ 盘上一点东西都不许有（与"他明说才许写"那条同一个方向：fail-closed）
    assert.equal(w.apps.current(id), null, `🔴 ${id}：拒了就不许登记进制品库`);
    assert.equal(nodeFs.existsSync(nodePath.join(root, id)), false, `🔴 ${id}：拒了就不许给它建工作区`);
  }

  // **负向对照**：不是保留 id 的照旧能造（证明这道闸没把整条路关掉）
  const ok = await askApps(w.appsSocket.path, {
    op: 'create',
    app: { id: 'dice', title: '掷硬币', entry: 'index.html', files: { 'index.html': '<p>正</p>' } },
  });
  assert.equal(ok.ok, true, `★ 普通 id 必须照旧能造：${JSON.stringify(ok)}`);
  assert.equal(nodeFs.existsSync(nodePath.join(root, 'dice', 'index.html')), true);

  // **回归：主线一个字都没变**
  assert.equal(w.agentKey, 'u1/main');
  assert.equal(w.scopeId, 'main');
  assert.equal(w.timeline.id, 'main');
  assert.equal(w.cfg.agentCwd, h.worlds.pathsFor('u1').agentCwd);
  assert.throws(() => w.workspaces.ensure('main'), /主线/, '★ `main` 还是原来那条规矩（照旧拒）');
  assert.equal((await post(h, '/api/say', { messageId: 'mn', text: '主线照旧' }, 'u1')).status, 200);

  // **回归：既有小程序房间一个字都没变**（A1–A3 那一套照旧）
  makeScope(h, 'u1', 'alpha');
  assert.equal((await post(h, '/api/say', { messageId: 'a1', text: '甲房暗号', scope: 'alpha' }, 'u1')).status, 200);
  const alpha = await get(h, '/api/timeline?before=9999&limit=100&scope=alpha', 'u1');
  assert.match(
    ((await alpha.json()).frames).map((f) => f.text ?? '').join('\n'),
    /甲房暗号/,
    '★ 既有小程序房间照旧能说、能翻',
  );

  // 内置那三个**从头到尾没被当成房间用过** ⇒ 不该凭空多出目录
  for (const id of BUILTIN_SCOPES) {
    assert.equal(nodeFs.existsSync(nodePath.join(root, id)), false, `（${id} 没被用到，就不该有目录）`);
  }
  await h.close();
});


