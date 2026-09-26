// **"桌面那一格打开的是他正在改的那一份"**（契约 `docs/dev/112-OWN-APP-IS-LIVE.md`）。
//
// ── 这一份钉什么（V1–V4 ＋ `/api/apps` 现签那一半）──────────
//   · **V1** 活地址（`/w/`）取的是**工作区里现在那一份**：直接改工作区的 `index.html`
//     ⇒ 再取就是新内容；**同一时刻**制品那一版（`/a/`）仍是老的（"发布"那条侧没动）。
//   · **V2** 白名单：只认那一间里**能当页面用**的文件 —— `../` / `.hupo.json` /
//     `build/` 一律拒，**而且连库都不碰**（反例钉在"resolver 被叫了几次"上）。
//   · **V3** 沙箱那三条不变量**没被动**：另一原点·`allow-scripts`·只有 `ask` 通道
//     —— 这一份验它落在服务端的可验部分（CSP 与 `/a/` **逐字同一条**、不许发
//     `X-Frame-Options`、`no-store`）；客户端那三条住在
//     `test/widget/remote_app_test.dart` 与 `scripts/check-web-browser.mjs`（没动过）。
//   · **V4** "内容变了"**只推给正开着那一间的连接**（别的 app / 没开着的收不到），
//     而且那一帧**不进日志**（瞬态）。走**真 WS 连接**（不是探针：V13 那族）。
//   · `/api/apps` 现签那一半：两次调用给出**两条不同的活地址**（新 exp ⇒ 新签名）
//     —— 客户端"收到就重取一次、换掉 iframe"靠的就是它（客户端那半见契约 §六）。
//
// ⚠️ **每一刀变异都跑过**（读数抄在 `docs/dev/112-OWN-APP-IS-LIVE.md` §五）。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeHttp from 'node:http';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test, { after } from 'node:test';

import { WebSocket } from 'ws';

import { APP_WORKSPACE_CHANGED, LIVE_VERSION, appWorkspaceChangeOf, appWorkspaceChangedEvent, checkLiveRel, createLiveWatcher, liveEntryOf, liveRelOk, parseLivePath } from '../src/app-live.js';
import { Apps } from '../src/apps.js';
import { Auth } from '../src/auth.js';
import { createAppServer, entryUrl, liveEntryUrl, verifyEntry } from '../src/app-serve.js';
import { BoxError } from '../src/apps-box.js';
import { createServer } from '../src/server.js';
import { AgentRuntime } from '../src/agent-runtime.js';
import { AppWorkspaces, liveScopeOfChange, makeLiveForSub, readLiveApp, snapshotWorkspace } from '../src/workspace.js';
import { Worlds } from '../src/worlds.js';

const NOW = 1_800_000_000_000;
const KEY = Buffer.from('c'.repeat(64), 'hex');

const open = new Set();
after(async () => {
  for (const close of open) {
    try {
      await close();
    } catch {
      /* 关不干净不影响结论 */
    }
  }
  open.clear();
});
function guard(fn) {
  const g = async () => {
    open.delete(g);
    await fn();
  };
  open.add(g);
  return g;
}

function tmp(tag = 'hupo-112-') {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), tag));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, why, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await sleep(20);
  }
  throw new Error(`等不到：${why}（等了 ${ms}ms）`);
}

// ── 一条"世界"：真的 `Apps` ＋ 真的 `AppWorkspaces`（活地址的落点）──────
function makeWorld(dir, sub) {
  return { userId: sub, dir, apps: new Apps({ dir, sub }), workspaces: new AppWorkspaces({ dir }) };
}

/** 起一个**制品原点**（两条路都在）：`/a/` 走制品、`/w/` 走工作区。 */
async function bootOrigin(t, { worlds, spy = null }) {
  const origin = createAppServer({
    resolveApps: (sub) => worlds.worldFor(sub)?.apps ?? null,
    resolveLive: (sub) => {
      spy?.calls.push(sub);
      const w = worlds.worldFor(sub);
      if (!w?.workspaces) return null;
      return { readLive: (id, rel) => readLiveApp({ apps: w.apps, workspaces: w.workspaces, id, rel }) };
    },
    key: KEY,
    frameAncestors: "'self'",
    now: () => NOW,
    log: () => {},
  });
  await new Promise((res, rej) => {
    origin.once('error', rej);
    origin.listen(0, '127.0.0.1', res);
  });
  const a = origin.address();
  t.after(guard(() => new Promise((r) => origin.close(() => r()))));
  return `http://127.0.0.1:${a.port}`;
}

const get = (base, url) => fetch(`${base}${url}`);

/**
 * **原样把路径发出去**（不经过 `fetch`/`URL` 的规范化）。
 *
 * 🔴 为什么非要它：`fetch` 会把 `/w/dice/../x` **规范化成** `/w/x` ——
 *    那样测的就不是我们那道白名单了（`..` 根本没到服务端）。
 */
function rawGet(base, rawPath) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request(
      { host: u.hostname, port: u.port, method: 'GET', path: rawPath },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ════════════════════════════════════════════════════════════
// V1 —— 活地址取的是**工作区里现在那一份**
// ════════════════════════════════════════════════════════════
test('V1 改工作区的 index.html ⇒ 同一成活地址再取就是新内容（而制品那一版没动）', async (t) => {
  const dir = tmp();
  const w = makeWorld(dir, 'u1');
  // 一版制品 ＋ 一间工作区（正常形状：先有工作区，快照从它读）
  w.workspaces.ensure('dice', { title: '掷骰子', entry: 'index.html' });
  w.workspaces.write('dice', { 'index.html': '<p>第一版</p>' });
  snapshotWorkspace({ apps: w.apps, workspaces: w.workspaces, id: 'dice', title: '掷骰子', icon: 'dice' });

  const worlds = { worldFor: (sub) => (sub === 'u1' ? w : null) };
  const base = await bootOrigin(t, { worlds });

  const live = liveEntryUrl({ base, key: KEY, sub: 'u1', id: 'dice', entry: 'index.html', now: NOW });

  // ── ① 现在取到的 = 工作区那一份
  let r = await get(base, live.slice(base.length));
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '<p>第一版</p>');

  // ── ② 他（或者助手）**直接改盘上那个文件**（不经我们的任何函数）
  nodeFs.writeFileSync(nodePath.join(w.workspaces.dirFor('dice'), 'index.html'), '<p>刚改的那一行</p>', 'utf8');

  // ── ③ **同一条活地址**再取 ⇒ 新内容（不要求重新发布、不要求换 URL）
  r = await get(base, live.slice(base.length));
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '<p>刚改的那一行</p>', '★ 桌面那一格必须是"他现在改的那一份"');

  // ── ④ 制品那一版**一个字没动**（发布/血缘/回滚那一侧照旧）
  const art = entryUrl({ base, key: KEY, sub: 'u1', id: 'dice', version: 1, entry: 'index.html', now: NOW });
  r = await get(base, art.slice(base.length));
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '<p>第一版</p>', '★ 制品是快照：他改了它不许跟着变');

  // ── ⑤ 两条路的签名**互不通用**（域分离：活地址那一格签的是哨兵 `live`）
  const u = new URL(live);
  assert.equal(
    verifyEntry({ key: KEY, sig: u.searchParams.get('s'), sub: 'u1', id: 'dice', version: LIVE_VERSION, exp: u.searchParams.get('e'), now: NOW }),
    true,
  );
  assert.equal(
    verifyEntry({ key: KEY, sig: u.searchParams.get('s'), sub: 'u1', id: 'dice', version: 1, exp: u.searchParams.get('e'), now: NOW }),
    false,
    '活地址的签名拿不去当制品的',
  );
});

test('V1·补 老 app（只有制品、工作区还没有）⇒ 先从当前那一版落成一次；之后**绝不再退回旧版**', async (t) => {
  const dir = tmp();
  const w = makeWorld(dir, 'u1');
  // 真机形状：**只有制品**（`data/workspaces/` 那时候根本不存在）
  w.apps.create({ id: 'dice', title: '掷骰子', icon: 'dice', entry: 'index.html', files: { 'index.html': '<p>老那一版</p>' } });
  assert.equal(nodeFs.existsSync(w.workspaces.dirFor('dice')), false, '前提：工作区真的还没有');

  const worlds = { worldFor: (sub) => (sub === 'u1' ? w : null) };
  const base = await bootOrigin(t, { worlds });
  const live = liveEntryUrl({ base, key: KEY, sub: 'u1', id: 'dice', entry: 'index.html', now: NOW });

  let r = await get(base, live.slice(base.length));
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '<p>老那一版</p>', '落成之后先是他原来那一版');

  // 改一次 ⇒ 活的
  nodeFs.writeFileSync(nodePath.join(w.workspaces.dirFor('dice'), 'index.html'), '<p>改过的</p>', 'utf8');
  r = await get(base, live.slice(base.length));
  assert.equal(await r.text(), '<p>改过的</p>');

  // 🔴 **他删掉了那个文件** ⇒ 如实 404，**不许**拿制品那一版顶上来
  //    （"悄悄退回某一版"就是这一条要修的那种假话）
  nodeFs.unlinkSync(nodePath.join(w.workspaces.dirFor('dice'), 'index.html'));
  r = await get(base, live.slice(base.length));
  assert.equal(r.status, 404, '★ 删了就是没了，不许拿旧版替他画出来');
});

// ════════════════════════════════════════════════════════════
// V2 —— 白名单（写清单：允许什么、拒绝什么）
// ════════════════════════════════════════════════════════════
test('V2 白名单（纯函数）：允许 index.html 与子目录；`.` 开头 / build / 越界一律拒', () => {
  // ✅ 允许
  assert.equal(liveRelOk('index.html'), true);
  assert.equal(liveRelOk('assets/app.js'), true);
  assert.equal(liveRelOk('a/b/c.css'), true);
  // ❌ 工作区自己的账 / 数据 / 经验 / 回收处 / 原子写的中间文件
  for (const rel of ['.hupo.json', '.data/x.json', 'assets/.hidden/x.js', '.exp/e.md', '.removed/x']) {
    assert.equal(liveRelOk(rel), false, `. 开头的必须拒：${rel}`);
  }
  // ❌ 保留目录（当前只有 build）
  assert.equal(liveRelOk('build/x.js'), false);
  assert.equal(liveRelOk('assets/build/x.js'), false, '★ 每一段都判，不只看第一段');
  // ❌ 越界 / 形状
  for (const rel of ['../etc/passwd', 'a/../../b', '/etc/passwd', 'a\\b', 'a//b', './x', 'a/./b', '']) {
    assert.equal(liveRelOk(rel), false, `必须拒：${JSON.stringify(rel)}`);
  }
  // 入口只有一个：认不出的 entry ⇒ 退回 index.html
  assert.equal(liveEntryOf('build/x.html'), 'index.html');
  assert.equal(liveEntryOf('main.html'), 'main.html');
  assert.equal(liveEntryOf(null), 'index.html');
});

test('V2 活地址那三条路 ⇒ 404，**而且一次都不碰库**（先验签、再过白名单、最后才碰盘）', async (t) => {
  const dir = tmp();
  const w = makeWorld(dir, 'u1');
  w.workspaces.ensure('dice', { title: '掷骰子', entry: 'index.html' });
  w.workspaces.write('dice', { 'index.html': '<p>页面</p>', 'assets/app.js': 'console.log(1)' });
  nodeFs.writeFileSync(nodePath.join(w.workspaces.dirFor('dice'), '.hupo.json'), JSON.stringify({ id: 'dice' }));
  nodeFs.mkdirSync(nodePath.join(w.workspaces.dirFor('dice'), 'build'), { recursive: true });
  nodeFs.writeFileSync(nodePath.join(w.workspaces.dirFor('dice'), 'build', 'x.js'), 'secret');
  snapshotWorkspace({ apps: w.apps, workspaces: w.workspaces, id: 'dice', title: '掷骰子', icon: 'dice' });

  const worlds = { worldFor: (sub) => (sub === 'u1' ? w : null) };
  const spy = { calls: [] };
  const base = await bootOrigin(t, { worlds, spy });

  // 合法的那两条：入口 ＋ 子目录里的文件
  for (const [rel, want] of [['index.html', '<p>页面</p>'], ['assets/app.js', 'console.log(1)']]) {
    const url = liveEntryUrl({ base, key: KEY, sub: 'u1', id: 'dice', entry: rel, now: NOW });
    const r = await get(base, url.slice(base.length));
    assert.equal(r.status, 200, `${rel} 应当能取到`);
    assert.equal(await r.text(), want);
  }

  // 三条都要拒（`../` / `.hupo.json` / `build/`）
  const bad = ['../etc/passwd', '.hupo.json', 'build/x.js'];
  const before = spy.calls.length;
  for (const rel of bad) {
    const url = liveEntryUrl({ base, key: KEY, sub: 'u1', id: 'dice', entry: rel, now: NOW });
    // ⚠️ 原样发（`fetch` 会把 `..` 规范化掉 —— 那就测不到这一道了）
    const r = await rawGet(base, url.slice(base.length));
    assert.equal(r.status, 404, `${rel} 必须拒`);
  }
  assert.equal(spy.calls.length, before, '★ 白名单不过 ⇒ **连库都不碰**（更别说去 dial 盒子）');

  // 反例（负向对照）：**换一个坏签名**也拒，而且同样不碰库
  const good = liveEntryUrl({ base, key: KEY, sub: 'u1', id: 'dice', entry: 'index.html', now: NOW });
  const u = new URL(good);
  u.searchParams.set('s', '0'.repeat(64));
  const r = await get(base, `${u.pathname}${u.search}`);
  assert.equal(r.status, 403);
  assert.equal(spy.calls.length, before, '★ 验签不过 ⇒ 一样连库都不碰');
});

// ════════════════════════════════════════════════════════════
// V3 —— 沙箱那三条（服务端这一半）
// ════════════════════════════════════════════════════════════
test('V3 活地址与制品**同一条 CSP**（另一原点那一套没被放宽 · 不许发 X-Frame-Options）', async (t) => {
  const dir = tmp();
  const w = makeWorld(dir, 'u1');
  w.workspaces.ensure('dice', { title: '掷骰子', entry: 'index.html' });
  w.workspaces.write('dice', { 'index.html': '<p>页面</p>' });
  snapshotWorkspace({ apps: w.apps, workspaces: w.workspaces, id: 'dice', title: '掷骰子', icon: 'dice' });
  const worlds = { worldFor: (sub) => (sub === 'u1' ? w : null) };
  const base = await bootOrigin(t, { worlds });

  const live = liveEntryUrl({ base, key: KEY, sub: 'u1', id: 'dice', entry: 'index.html', now: NOW });
  const r = await get(base, live.slice(base.length));
  const csp = String(r.headers.get('content-security-policy'));
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.equal(r.headers.get('x-frame-options'), null, '🔴 发了它壳里就嵌不进去');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');

  // 与制品那一条**逐字相同**（活地址没有另一套 CSP —— 那会是"悄悄放宽"）
  const art = entryUrl({ base, key: KEY, sub: 'u1', id: 'dice', version: 1, entry: 'index.html', now: NOW });
  const r2 = await get(base, art.slice(base.length));
  assert.equal(String(r2.headers.get('content-security-policy')), csp);
});

// ════════════════════════════════════════════════════════════
// V4 —— "内容变了"只推给正开着那一间的连接
// ════════════════════════════════════════════════════════════
test('V4 `fs.watch` 那条相对路径算哪一间（认不出 ⇒ 不发）', () => {
  const rel = (p) => nodePath.join('dice', p);
  const scopeOf = (filename) => liveScopeOfChange('/data/workspaces', filename);
  assert.equal(scopeOf(rel('index.html')), 'dice');
  assert.equal(scopeOf(rel('assets/app.js')), 'dice');
  assert.equal(scopeOf(rel('.hupo.json')), null, '工作区自己的账 ⇒ 不发');
  assert.equal(scopeOf(rel('build/x.js')), null, '保留目录 ⇒ 不发');
  assert.equal(scopeOf(rel('.index.html.tmp-1')), null, '原子写的中间文件 ⇒ 不发');
  assert.equal(scopeOf('dice'), null, '改的是那一间目录自己 ⇒ 不发');
  assert.equal(scopeOf('main/x.html'), null, '主线不是小程序 ⇒ 不发');
  assert.equal(scopeOf('../x/index.html'), null, '越界 ⇒ 不发');
  assert.equal(scopeOf('DICE/index.html'), null, '名字不合法 ⇒ 不发');
  assert.equal(scopeOf(''), null);
  assert.equal(scopeOf(null), null);
});

test('V4 watcher：白名单里的路径才叫；同一间连着写 ⇒ 合成一下', async () => {
  const calls = [];
  let fire = null;
  const fakeWatch = (_root, _opts, cb) => {
    fire = cb;
    return { on: () => {}, close: () => {}, unref: () => {} };
  };
  const watcher = createLiveWatcher({
    root: '/data/workspaces',
    scopeOf: (filename) => liveScopeOfChange('/data/workspaces', filename),
    onChange: (scope) => calls.push(scope),
    watch: fakeWatch,
    fs: { mkdirSync: () => {} },
    debounceMs: 30,
    log: () => {},
  });
  assert.equal(watcher.start(), true);
  assert.equal(watcher.watching, true);

  fire('change', nodePath.join('dice', 'index.html'));
  fire('change', nodePath.join('dice', 'index.html')); // 原子写的第二下
  fire('change', nodePath.join('dice', '.hupo.json')); // 不许叫
  fire('change', nodePath.join('dice', 'build', 'x.js')); // 不许叫
  fire('change', nodePath.join('yizi', 'index.html')); // 另一间
  await waitFor(() => calls.length >= 2, '两间各叫一次');
  await sleep(80);
  assert.deepEqual(calls.sort(), ['dice', 'yizi'], '★ 同一间合成一次；白名单外的路径一次都不叫');
  watcher.stop();
});

test('V4/V5 真链路：改工作区 ⇒ 只有**正开着那一间**的那条连接收到那一帧（别的收不到）', async (t) => {
  const dataDir = tmp('hupo-112-run-');
  const cfg = {
    dataDir,
    dshHome: nodePath.join(dataDir, '__dsh__'),
    agentCwd: nodePath.join(dataDir, '__cwd__'),
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
    turnDeadlineMs: 30000,
  };
  nodeFs.mkdirSync(cfg.dshHome, { recursive: true });
  nodeFs.mkdirSync(cfg.agentCwd, { recursive: true });
  let worlds = null;
  const runtime = new AgentRuntime({
    cfg,
    cfgFor: (key) => worlds.cfgForAgentKey(key),
    onEvict: (id) => worlds.onEvict(id),
  });
  worlds = new Worlds({ cfg, runtime, log: () => {}, warn: () => {} });
  const auth = new Auth({ dataDir, lockAfter: 3, lockMs: 60_000 });
  auth.setPassword('测试用的口令');
  const { listen, close } = createServer({ worlds, auth, buildId: 'app-live-test' });
  const addr = await listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const w = worlds.worldFor('u1');
  // 两间工作区：`dice`（正开着）与 `yizi`（另一间）
  w.workspaces.ensure('dice', { title: '掷骰子', entry: 'index.html' });
  w.workspaces.write('dice', { 'index.html': '<p>一</p>' });
  w.workspaces.ensure('yizi', { title: '椅子', entry: 'index.html' });
  w.workspaces.write('yizi', { 'index.html': '<p>二</p>' });

  // ★ **真的看着盘**（与 `serve.js` 里那一处同一条接线）
  const watcher = createLiveWatcher({
    root: w.workspaces.root,
    scopeOf: (filename) => liveScopeOfChange(w.workspaces.root, filename),
    onChange: (scope) => worlds.emitLiveChange('u1', scope),
    log: () => {},
  });
  assert.equal(watcher.start(), true, 'fs.watch 起得来（起不来这一条就没意义）');

  const frames = { dice: [], yizi: [], main: [] };
  const connect = (scope) =>
    new Promise((resolve, reject) => {
      const qs = new URLSearchParams({ sinceSeq: '0' });
      if (scope) qs.set('scope', scope);
      const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/stream?${qs}`, [
        'bearer',
        auth.issue({ sub: 'u1' }).token,
      ]);
      ws.on('message', (d) => {
        try {
          frames[scope ?? 'main'].push(JSON.parse(d.toString()));
        } catch {
          /* 不是 JSON 的帧不算 */
        }
      });
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });

  const wsDice = await connect('dice');
  const wsYizi = await connect('yizi');
  const wsMain = await connect(null);
  t.after(
    guard(async () => {
      watcher.stop();
      for (const ws of [wsDice, wsYizi, wsMain]) {
        try {
          ws.close();
        } catch {
          /* 已经没了 */
        }
      }
      await worlds.shutdownDispatchers();
      await runtime.shutdown();
      await close();
      worlds.closeSockets();
      nodeFs.rmSync(dataDir, { recursive: true, force: true });
    }),
  );

  const has = (arr) => arr.some((e) => e.type === APP_WORKSPACE_CHANGED && e.id === 'dice');

  // 改工作区里的 index.html（**直接写盘**：假装是助手在那个目录里干活）
  nodeFs.writeFileSync(nodePath.join(w.workspaces.dirFor('dice'), 'index.html'), '<p>改过了</p>', 'utf8');
  await waitFor(() => has(frames.dice), '正开着 dice 的那条连接要收到那一帧');

  // 🔴 **别的 app / 没开着它的连接一个字节都不许收**
  assert.deepEqual(frames.yizi.filter((e) => e.type === APP_WORKSPACE_CHANGED), [], '别的 app 不许收');
  assert.deepEqual(frames.main.filter((e) => e.type === APP_WORKSPACE_CHANGED), [], '主线那条不许收');

  // 那一帧的形状：只有 id（**没有签名 URL**）
  const one = frames.dice.find((e) => e.type === APP_WORKSPACE_CHANGED && e.id === 'dice');
  assert.deepEqual(Object.keys(one).sort(), ['at', 'id', 'scopeId', 'type'].sort());
  assert.equal(appWorkspaceChangeOf(one).id, 'dice');
  // 🔴 **瞬态**：不占号、不落盘 ⇒ 补发/重连不会把它再送一遍
  assert.equal(one.seq, undefined, '瞬态事件不许有号');
  assert.equal(
    w.timeline.readAll().some((e) => e.type === APP_WORKSPACE_CHANGED),
    false,
    '★ 它不许进日志（否则重连会"再变一次"）',
  );

  // 白名单外的写（`.hupo.json`）⇒ 一个字节都不推
  const before = frames.dice.length;
  nodeFs.writeFileSync(nodePath.join(w.workspaces.dirFor('dice'), '.hupo.json'), '{"x":1}', 'utf8');
  await sleep(400);
  assert.equal(frames.dice.length, before, '★ 工作区自己的账被写 ⇒ 不该推（页面看不见它）');
});

// ════════════════════════════════════════════════════════════
// V6 —— 尺寸 / 文件数那些上限**只属于"包"**（市场那一侧），不属于用户端活路
// ════════════════════════════════════════════════════════════
test('V6 活路**不因大小 / 文件数拒绝**（主人 2026-09-26：那些上限只在"包"那一侧）', async (t) => {
  const dir = tmp();
  const w = makeWorld(dir, 'u1');
  w.workspaces.ensure('big', { title: '大的', entry: 'index.html' });
  const d = w.workspaces.dirFor('big');
  // 🔴 直接写盘（**助手在那个目录里干活就是这个形状**）⇒ 绕过 `workspaces.write` 那些上限
  const big = `<p>${'x'.repeat(300 * 1024)}</p>`; // 比单文件上限大
  nodeFs.writeFileSync(nodePath.join(d, 'index.html'), big, 'utf8');
  for (let i = 0; i < 45; i += 1) nodeFs.writeFileSync(nodePath.join(d, `f${i}.js`), 'x'); // 比文件数上限多

  const base = await bootOrigin(t, { worlds: { worldFor: (sub) => (sub === 'u1' ? w : null) } });

  // ── ① 活地址照给：一个字节都不少
  const live = liveEntryUrl({ base, key: KEY, sub: 'u1', id: 'big', entry: 'index.html', now: NOW });
  const r = await get(base, live.slice(base.length));
  assert.equal(r.status, 200, '★ 活路不许因为"太大"拒绝（那是包那一侧的规矩）');
  assert.equal(r.headers.get('content-length'), String(Buffer.byteLength(big)));
  assert.equal((await r.text()).length, big.length);
  // ── ② 第 45 个文件也取得到（文件数上限同样走不到这条路上）
  const live2 = liveEntryUrl({ base, key: KEY, sub: 'u1', id: 'big', entry: 'f44.js', now: NOW });
  assert.equal((await get(base, live2.slice(base.length))).status, 200);

  // ── ③ 对照：**"包"那一侧是有上限的**（同一个目录快照成制品 ⇒ 当场拒）
  //     ⇒ 这两条边界不是"我们忘了加"，是**主人定的**（包 = 市场那条通道）。
  assert.throws(
    () => snapshotWorkspace({ apps: w.apps, workspaces: w.workspaces, id: 'big', title: '大的', icon: 'dice' }),
    /文件太多|太大/,
    '★ "落成包"那一侧该拒就拒（上限只属于它）',
  );
});

// ════════════════════════════════════════════════════════════
// 接线（V13）：取值来源那一根线**本身**也要有判据
// ════════════════════════════════════════════════════════════
test('接线 `makeLiveForSub`：本机那条真的能读（少一个名字 ⇒ 请求进来才 ReferenceError 的那个坑）', async () => {
  const dir = tmp();
  const w = makeWorld(dir, 'u1');
  w.workspaces.ensure('dice', { title: '掷骰子', entry: 'index.html' });
  w.workspaces.write('dice', { 'index.html': '<p>接线这一份</p>' });

  // 本机那条（`serve.js` 给的正是这一支）：**直接读得到**
  const local = makeLiveForSub({ worldFor: (sub) => (sub === 'u1' ? w : null) });
  const got = local('u1').readLive('dice', 'index.html');
  assert.equal(got.content.toString('utf8'), '<p>接线这一份</p>');
  assert.equal(got.contentType, 'text/html; charset=utf-8');

  // 那格不存在 ⇒ `null`（fail-closed，不许编一个空对象出来）
  assert.equal(local('u404'), null);

  // 租户那条：走注入的"盒子"那一支；没给 `boxLive` ⇒ **null**（绝不偷偷走本机那份）
  const called = [];
  const rented = makeLiveForSub({
    worldFor: () => w,
    tenantOf: (sub) => (sub === 'u2' ? 'hupo-b' : null),
    boxLive: (sub, tenant) => {
      called.push([sub, tenant]);
      return { readLive: () => ({ content: Buffer.from('<p>盒子那份</p>'), contentType: 'text/html' }) };
    },
  });
  assert.equal(rented('u2').readLive('dice', 'index.html').content.toString('utf8'), '<p>盒子那份</p>');
  assert.deepEqual(called, [['u2', 'hupo-b']]);
  assert.equal(
    makeLiveForSub({ worldFor: () => w, tenantOf: () => 'hupo-b' })('u2'),
    null,
    '★ 租户那一条没接上 ⇒ **null**（绝不退回本机那份）',
  );
});

// ════════════════════════════════════════════════════════════
// `/api/apps` 那一半 —— 每次现签，两条活地址**不一样**
// ════════════════════════════════════════════════════════════
test('`/api/apps`：两次现签给出两条不同的活地址（客户端"重取一次就换一帧"靠它）', async (t) => {
  const dir = tmp();
  const w = makeWorld(dir, 'u1');
  w.workspaces.ensure('dice', { title: '掷骰子', entry: 'index.html' });
  w.workspaces.write('dice', { 'index.html': '<p>页面</p>' });
  snapshotWorkspace({ apps: w.apps, workspaces: w.workspaces, id: 'dice', title: '掷骰子', icon: 'dice' });
  const worlds = { worldFor: (sub) => (sub === 'u1' ? w : null) };
  const authDir = tmp('hupo-112-auth-');
  const auth = new Auth({ dataDir: authDir, now: () => NOW });
  auth.setPassword('测试用的口令');
  let clock = NOW;
  const { listen, close } = createServer({
    auth,
    worlds,
    apps: { base: 'http://127.0.0.1:9999', key: KEY },
    now: () => clock,
    webRoot: null,
    buildId: 'app-live-sign',
    log: () => {},
  });
  t.after(guard(close));
  const addr = await listen(0);
  const list = () =>
    fetch(`http://127.0.0.1:${addr.port}/api/apps`, {
      headers: { authorization: `Bearer ${auth.issue({ sub: 'u1' }).token}` },
    }).then((r) => r.json());

  const a = await list();
  clock += 1000; // 过一秒（他是过一会儿才改的）
  const b = await list();
  assert.match(a.apps[0].entryUrl, /\/w\/dice\/index\.html\?/);
  assert.notEqual(a.apps[0].entryUrl, b.apps[0].entryUrl, '★ 每次现签 ⇒ 新 exp ⇒ 新签名（换一帧的前提）');
  // 两条都还是**同一个 app 的活地址**（只是时效不同）
  assert.deepEqual(parseLivePath(new URL(a.apps[0].entryUrl).pathname), { id: 'dice', rel: 'index.html' });
  assert.deepEqual(parseLivePath(new URL(b.apps[0].entryUrl).pathname), { id: 'dice', rel: 'index.html' });
});

// ════════════════════════════════════════════════════════════
// 盒子那一侧：不通 ⇒ **如实拒**，绝不退回宿主那份（B15 同一条纪律）
// ════════════════════════════════════════════════════════════
test('活地址·盒子不通 ⇒ 503（**绝不**拿宿主那份旧的顶上）', async (t) => {
  const dir = tmp();
  const w = makeWorld(dir, 'u2');
  // 宿主上有一份**同名**的旧东西（假的"宿主那份"）—— 它一个字节都不许被端出去
  w.apps.create({ id: 'dice', title: '宿主的假货', icon: 'dice', entry: 'index.html', files: { 'index.html': '<p>宿主的假货</p>' } });
  const origin = createAppServer({
    resolveApps: () => w.apps,
    // 租户那一份在盒里，而隧道不通 ⇒ `readLive` 抛（这里直接建成不可用的代理）
    resolveLive: () => ({
      readLive: () => {
        throw new BoxError('你那台现在连不上（隧道没通）', 'unreachable');
      },
    }),
    key: KEY,
    frameAncestors: "'self'",
    now: () => NOW,
    log: () => {},
  });
  await new Promise((res, rej) => {
    origin.once('error', rej);
    origin.listen(0, '127.0.0.1', res);
  });
  t.after(guard(() => new Promise((r) => origin.close(() => r()))));
  const base = `http://127.0.0.1:${origin.address().port}`;
  const live = liveEntryUrl({ base, key: KEY, sub: 'u2', id: 'dice', entry: 'index.html', now: NOW });
  const r = await get(base, live.slice(base.length));
  assert.equal(r.status, 503, '★ 盒子不通就如实说"等会儿再试" —— 不许回宿主那份，也不许说"没这个文件"');
  assert.equal((await r.text()).includes('宿主的假货'), false);
});

// 那些纯函数的形状（一帧认法两处共用，漂了就靠这几条）
test('那一帧的认法：认不出 ⇒ `null`（安静忽略，协议只加不改）', () => {
  assert.deepEqual(appWorkspaceChangeOf(appWorkspaceChangedEvent({ id: 'dice', at: NOW })), { id: 'dice' });
  for (const bad of [null, {}, { type: APP_WORKSPACE_CHANGED }, { type: APP_WORKSPACE_CHANGED, id: '' }, { type: 'x', id: 'dice' }]) {
    assert.equal(appWorkspaceChangeOf(bad), null);
  }
  assert.deepEqual(parseLivePath('/w/dice/index.html'), { id: 'dice', rel: 'index.html' });
  assert.deepEqual(parseLivePath('/w/dice/a/b.js'), { id: 'dice', rel: 'a/b.js' });
  for (const bad of ['/w/', '/w/dice', '/a/dice/1/x.html', '/w/DICE/x.html', '/w/dice/']) {
    assert.equal(parseLivePath(bad), null, `认不出：${bad}`);
  }
  // 白名单的抛错是人话（排障看这一行）
  assert.throws(() => checkLiveRel('.hupo.json'), /自己的账/);
  assert.throws(() => checkLiveRel('build/x.js'), /不对外/);
  assert.throws(() => checkLiveRel('../x'), /\.\./);
});
