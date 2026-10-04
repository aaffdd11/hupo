// **桌面上那一格"在做"**（主人 2026-10-04：*"如果某个小程序的聊天还在运行，我们应该给
//   这个小程序有一个状态。就是某项工作还在工作中。"*）· 契约 `docs/dev/178-APP-WORKING.md`。
//
// ── 这一份钉什么（一句话）──────────────────────────────────
// ① `/api/apps` 里那一格带 `working`，而它读的**就是"那件怎么样了"读的那一本活账**
//    （`world.work.live()`）—— 两处不许给出两个答案；
// ② **开着的活 ⇒ true；收口了 ⇒ false**（不是"做过就算"）；**别的 app 不受牵连**；
// ③ 🔴 **拿不到活账 ⇒ 一律 false**（宁可晚一拍，也不许点亮"它还在做"这种假话）；
// ④ 🔴 `working` 是**算出来的**，不许写进 `app.json`
//    （写进去就成了会漂的存量字段 —— 与 `building` 同一条理由）。
//
// ⚠️ 形状照 `test/app-create.test.js`：**真 `Worlds`** ＋ **真 HTTP**。
//    活账那一条**真开真收**（`work.declare` / `work.closeByRef`），不 mock 业务。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeNet from 'node:net';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test, { after } from 'node:test';

import { WebSocket } from 'ws';

import { AgentRuntime } from '../src/agent-runtime.js';
import { Apps } from '../src/apps.js';
import { createBoxApps } from '../src/apps-box.js';
import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { Worlds } from '../src/worlds.js';
import { WORK_STATES } from '../src/worklog.js';

const NOW = 1_800_000_000_000;
const KEY = Buffer.from('d'.repeat(64), 'hex');

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

const tmp = (tag = 'hupo-178-') => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), tag));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, why, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await sleep(20);
  }
  throw new Error(`等不到：${why}（等了 ${ms}ms）`);
}

function cfgFor(dataDir, tag) {
  return {
    dataDir,
    dshHome: nodePath.join(dataDir, `__${tag}_dsh__`),
    agentCwd: nodePath.join(dataDir, `__${tag}_cwd__`),
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

async function bootWorlds(t, { tag = 'host', dataDir = tmp() } = {}) {
  const cfg = cfgFor(dataDir, tag);
  nodeFs.mkdirSync(cfg.dshHome, { recursive: true });
  nodeFs.mkdirSync(cfg.agentCwd, { recursive: true });
  let worlds = null;
  const runtime = new AgentRuntime({
    cfg,
    cfgFor: (key) => worlds.cfgForAgentKey(key),
    onEvict: (id) => worlds.onEvict(id),
    spawnFn: () => {
      throw new Error('这一份判据不许起 agent');
    },
  });
  worlds = new Worlds({ cfg, runtime, log: () => {}, warn: () => {} });
  t.after(
    guard(async () => {
      await worlds.shutdownDispatchers();
      await runtime.shutdown();
      worlds.closeSockets();
    }),
  );
  return { dataDir, cfg, worlds, runtime };
}

async function bootServer(t, opts) {
  const auth = new Auth({ dataDir: tmp('hupo-178-auth-'), now: () => NOW });
  auth.setPassword('这一份判据只用令牌');
  const s = createServer({
    apps: { base: 'http://127.0.0.1:9', key: KEY },
    now: () => NOW,
    webRoot: null,
    log: () => {},
    ...opts,
    auth,
  });
  t.after(guard(s.close));
  return { ...s, auth };
}

const postCreate = (origin, token, body) =>
  fetch(`${origin}/api/app-create`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const appsOf = async (origin, token) => {
  const r = await fetch(`${origin}/api/apps`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json() };
};

const workingOf = (list, id) => list.find((a) => a.id === id)?.working;

// ════════════════════════════════════════════════════════════
// W1 —— 活账开着 ⇒ 那一格亮；收口 ⇒ 灭；别的不受牵连
// ════════════════════════════════════════════════════════════
test('W1 🔴 `working` 与活账同一本：开着 ⇒ true · 收口 ⇒ false · 没活的那一格一直 false', async (t) => {
  const { worlds } = await bootWorlds(t);
  const srv = await bootServer(t, { worlds });
  const addr = await srv.listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = srv.auth.issue({ sub: 'owner' }).token;

  // 两格：一格要开活，一格**整场不许亮**（负向对照）
  const a = await (await postCreate(origin, token, { title: '甲本' })).json();
  const b = await (await postCreate(origin, token, { title: '乙本' })).json();
  assert.ok(a.id && b.id);

  const first = await appsOf(origin, token);
  assert.equal(first.status, 200);
  assert.equal(workingOf(first.body.apps, a.id), false, '★ 刚建出来、没人动 ⇒ 不亮');
  assert.equal(workingOf(first.body.apps, b.id), false);

  const w = worlds.worldFor('owner');
  // 活账上真开一件（与"那件怎么样了"读的是同一本）
  w.work.declare({ scopeId: a.id, ref: 'r-1' });
  const lit = await appsOf(origin, token);
  assert.equal(workingOf(lit.body.apps, a.id), true, '★ 甲那一间有活开着 ⇒ 亮');
  assert.equal(workingOf(lit.body.apps, b.id), false, '★ 乙那一间没活 ⇒ 一格都不许跟着亮');

  // 收口（做完了）⇒ 灭：**不是"做过就算"**
  w.work.closeByRef({ scopeId: a.id, ref: 'r-1', outcome: WORK_STATES.done });
  const dark = await appsOf(origin, token);
  assert.equal(workingOf(dark.body.apps, a.id), false, '★ 收口了 ⇒ 立刻灭');
  assert.deepEqual(
    w.work.live().map((r) => r.scopeId),
    [],
    '★ 盘上那本活账真是空的（灭不是因为读失败）',
  );

  // 负向对照：**不是 app 的 scope**（主线）开着活 ⇒ 桌面上照样一格都不亮
  w.work.declare({ scopeId: 'main', ref: 'r-2' });
  const mainOnly = await appsOf(origin, token);
  assert.equal(workingOf(mainOnly.body.apps, a.id), false, '★ 主线的活不许算到某一格头上');
  assert.equal(workingOf(mainOnly.body.apps, b.id), false);
  w.work.closeByRef({ scopeId: 'main', ref: 'r-2', outcome: WORK_STATES.done });

  // 🔴 是**算出来的**，不许落盘：`app.json` 里不许有 `working`（也不许有 `building`）
  const meta = nodeFs.readFileSync(w.apps.metaPath(a.id), 'utf8');
  assert.doesNotMatch(meta, /"working"/, '★ `working` 不许写进登记文件（它会漂）');
  assert.doesNotMatch(meta, /"building"/, '★ `building` 同一条理由');
});

// ════════════════════════════════════════════════════════════
// W2 —— 🔴 拿不到活账 ⇒ 一律不亮（fail-open：不许凭猜点亮）
// ════════════════════════════════════════════════════════════
test('W2 🔴 活账读不出来 ⇒ `working` 全 false，而且清单照样出得来（不 500）', async (t) => {
  const { worlds } = await bootWorlds(t);
  const srv = await bootServer(t, { worlds });
  const addr = await srv.listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = srv.auth.issue({ sub: 'owner' }).token;
  const a = await (await postCreate(origin, token, { title: '丙本' })).json();

  const w = worlds.worldFor('owner');
  // 真开一件活：**先证明这一格本来是亮的**（否则下面那句"不亮"什么都没证明）
  w.work.declare({ scopeId: a.id, ref: 'r-3' });
  assert.equal(workingOf((await appsOf(origin, token)).body.apps, a.id), true, '★ 前提：本来亮着');

  // 让"活账"这条路坏掉（读就抛）
  const real = w.work;
  Object.defineProperty(w, 'work', {
    value: {
      live: () => {
        throw new Error('坏了');
      },
    },
    configurable: true,
    writable: true,
  });
  try {
    const broken = await appsOf(origin, token);
    assert.equal(broken.status, 200, '★ 读不到活账 ⇒ 也不许把整个清单打成 500');
    const mine = broken.body.apps.find((x) => x.id === a.id);
    assert.ok(mine, '★ 那一格还在（"在做"画不出来，不等于小程序没了）');
    assert.equal(mine.working, false, '🔴 不知道 ⇒ 不亮（宁可晚一拍，也不许说"它还在做"）');
  } finally {
    Object.defineProperty(w, 'work', { value: real, configurable: true, writable: true });
  }
  // 活账回来了 ⇒ 又亮（证明上面那次"不亮"是**读坏了**，不是活没了）
  assert.equal(workingOf((await appsOf(origin, token)).body.apps, a.id), true, '★ 活账接回来 ⇒ 照旧亮');
});

// ════════════════════════════════════════════════════════════
// W3 —— 🔴 **租户那一条：以盒子里那份为准**（真隧道 ＋ 真内部口）
//       ⚠️ 这一条是"验在哪一端"那一课的产物：活是**在他盒子里**跑的，
//          盒子里那本活账才是事实；宿主这一侧根本没有他的活账
//          （2026-10-04 实测：`data/users/u2/` 下没有他那一份流水）。
//          拿宿主那份去覆盖 ⇒ 症状是"**桌面上永远不亮**"，而单租户判据全绿。
// ════════════════════════════════════════════════════════════
test('W3 🔴 租户：盒子里说他那一间在做 ⇒ 亮（宿主自己那份**不许**覆盖盒里那份）', async (t) => {
  const boxDir = tmp('hupo-178-box-');
  const boxApps = new Apps({ dir: boxDir, sub: 'owner', now: () => NOW });
  boxApps.register({ id: 'busy', title: '在忙的', entry: 'index.html' });
  boxApps.register({ id: 'idle', title: '闲着的', entry: 'index.html' });

  // **盒子**那一侧：`busy` 正有活在做 —— 这是权威那一份
  const uds = nodePath.join(tmp('hupo-178-sock-'), 'local-api.sock');
  const boxAuth = new Auth({ dataDir: tmp('hupo-178-boxauth-'), now: () => NOW });
  boxAuth.setPassword('盒子里的口令');
  const box = createServer({
    auth: boxAuth,
    worlds: {
      worldFor: (sub) =>
        sub === 'owner'
          ? { userId: 'owner', apps: boxApps, work: { live: () => [{ scopeId: 'busy' }] } }
          : null,
    },
    trustedSub: 'owner',
    apps: { base: 'http://127.0.0.1:9', key: KEY },
    now: () => NOW,
    webRoot: null,
    buildId: '178-box',
    log: () => {},
  });
  t.after(guard(box.close));
  await box.listen(0);
  await box.listenTrusted(uds);

  // **宿主**那一侧：他那一格**故意**说"闲的那一间在做"（与盒子里那份相反）
  //   ⇒ 出来的必须是盒子里那份（否则"覆盖"这件事就发生了，而屏幕上会指错一格）
  const hostAuth = new Auth({ dataDir: tmp('hupo-178-hostauth-'), now: () => NOW });
  hostAuth.setPassword('宿主上的口令');
  const host = createServer({
    auth: hostAuth,
    worlds: {
      worldFor: (sub) =>
        sub === 'u2' ? { userId: 'u2', apps: null, work: { live: () => [{ scopeId: 'idle' }] } } : null,
    },
    appsOf: (sub) => createBoxApps({ sub, dial: () => nodeNet.connect(uds), log: () => {} }),
    tenantOf: (sub) => (sub === 'u2' ? 'hupo-b' : null),
    apps: { base: 'http://127.0.0.1:9999', key: KEY },
    now: () => NOW,
    webRoot: null,
    buildId: '178-host',
    log: () => {},
  });
  t.after(guard(host.close));
  const addr = await host.listen(0);
  const token = hostAuth.issue({ sub: 'u2' }).token;

  const r = await fetch(`http://127.0.0.1:${addr.port}/api/apps`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const raw = await r.text();
  assert.equal(r.status, 200, raw);
  const list = JSON.parse(raw).apps;
  assert.deepEqual(list.map((a) => a.id).sort(), ['busy', 'idle'], '前提：盒子那份清单到了宿主这儿');
  assert.equal(workingOf(list, 'busy'), true, '★ 盒子里那本活账说他那一间在做 ⇒ 桌面要亮');
  assert.equal(workingOf(list, 'idle'), false, '🔴 宿主那份说他那一间在做 —— 这一格**不许**亮');
});

// ════════════════════════════════════════════════════════════
// W4 —— 🔴 **那条信号真的推得到客户端**（真服务 ＋ 真 WebSocket 连接）
//
//   为什么非有这一条：主人 2026-10-04 报的那件事正是**这一段的缝** ——
//   *"桌面并没有自动刷新。就是app做好了没有刷新。我们要有刷新机制。"*
//   ⇒ 这条判据从"写进入口那一份"（＝做好了）与"活账动一下"（＝在做）两头各推一次，
//     量**客户端那条连接收不收得到**（收不到 ⇒ 桌面就不会重拉，屏幕上就是旧样子）。
// ════════════════════════════════════════════════════════════
test('W4 🔴 写进入口 / 活账动一下 ⇒ 他那条连接**收得到** `app/installed`（桌面据此重拉）', async (t) => {
  const { worlds } = await bootWorlds(t);
  const srv = await bootServer(t, { worlds });
  const addr = await srv.listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = srv.auth.issue({ sub: 'owner' }).token;
  const made = await (await postCreate(origin, token, { title: '要做的' })).json();
  assert.ok(made.id, '前提：先建出一格（占位页还在 ⇒ 它"在建"）');

  // ── 真连一条（形状照 `test/app-live.test.js` V5）────────────────
  const frames = [];
  const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/stream?sinceSeq=0`, ['bearer', token]);
  t.after(guard(async () => {
    try {
      ws.close();
    } catch {
      /* 已经没了 */
    }
  }));
  ws.on('message', (d) => {
    try {
      frames.push(JSON.parse(d.toString()));
    } catch {
      /* 不是 JSON 的帧不算 */
    }
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  await waitFor(() => frames.some((e) => e.type === 'client/hello'), '先握上手（拿到 hello）');

  const installed = (id) => frames.filter((e) => e.type === 'app/installed' && e.appId === id);

  // ── ① **"做好了"那一下**：入口那一份被真内容顶掉 ──────────────
  const w = worlds.worldFor('owner');
  w.workspaces.write(made.id, { 'index.html': '<!doctype html><p>真的内容</p>' });
  await waitFor(() => installed(made.id).length > 0, '★ 写进入口那一份 ⇒ 那条连接要收到 app/installed');
  const one = installed(made.id)[0];
  assert.equal(one.seq, undefined, '★ 瞬态：不占号（不占号才不会进历史被重放）');
  assert.equal(
    w.timeline.readAll().some((e) => e.type === 'app/installed'),
    false,
    '★ 不许落盘（落盘 ⇒ 重连时桌面会莫名其妙闪一下）',
  );

  // ── ② **"在做"那一下**：活账开票 / 收口 ───────────────────────
  const before = installed(made.id).length;
  w.work.declare({ scopeId: made.id, ref: 'r-w4' });
  await waitFor(() => installed(made.id).length > before, '★ 活账开票 ⇒ 那条连接也要收到（桌面亮角标）');
  const opened = installed(made.id).length;
  w.work.closeByRef({ scopeId: made.id, ref: 'r-w4', outcome: WORK_STATES.done });
  await waitFor(() => installed(made.id).length > opened, '★ 收口 ⇒ 再收一条（桌面灭角标）');

  // 负向对照：**别的 app** 的信号不许数到这一格头上
  assert.equal(
    frames.some((e) => e.type === 'app/installed' && e.appId !== made.id && e.appId !== 'main'),
    false,
    '★ 只有这一格的信号（别人那几格一个字节都不许跟着喊）',
  );
});

// ════════════════════════════════════════════════════════════
// W5 —— 🔴 **"助手在那一间目录里直接把文件写完"这一条路，桌面也要收到信号**
//
//   主人 2026-10-04 报的原话：*"桌面并没有自动刷新。就是app做好了没有刷新。
//   我们要有刷新机制。"* ⇒ 查出来的**正是这一条**：
//   助手最常用的"部署"方式是在那一间目录里**直接写文件**（`docs/dev/112`）——
//   它**不经过** `AppWorkspaces.write()` ⇒ 不会有 `app/installed`；
//   而那条路上唯一的一声是 `app/workspace-changed`，它是**按焦点路由**的
//   （只推给"正开着这一间"的那条连接）⇒ 站在桌面前的人**一个字节都收不到**。
// ════════════════════════════════════════════════════════════
test('W5 🔴 直接写盘把入口写完 ⇒ 桌面那条连接也收得到（免得那一格一直是灰的）', async (t) => {
  const { worlds } = await bootWorlds(t);
  const srv = await bootServer(t, { worlds });
  const addr = await srv.listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = srv.auth.issue({ sub: 'owner' }).token;
  const made = await (await postCreate(origin, token, { title: '直接写的' })).json();
  assert.ok(made.id);

  const w = worlds.worldFor('owner');
  assert.equal(w.apps.meta(made.id).building, true, '前提：它现在"在建"（桌面那一格是灰的）');

  // 真连一条**主线**（桌面那一屏就是主线）
  const frames = [];
  const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/stream?sinceSeq=0`, ['bearer', token]);
  t.after(guard(async () => {
    try {
      ws.close();
    } catch {
      /* 已经没了 */
    }
  }));
  ws.on('message', (d) => {
    try {
      frames.push(JSON.parse(d.toString()));
    } catch {
      /* 不是 JSON 的帧不算 */
    }
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  await waitFor(() => frames.some((e) => e.type === 'client/hello'), '先握上手');
  const installed = () => frames.filter((e) => e.type === 'app/installed' && e.appId === made.id);

  // ── ① 负向对照：**还在建**的时候，watcher 那一声不许把桌面叫起来 ──
  //   （`emitLiveChange` 就是 `serve.js` 那条 watcher 的唯一出口）
  nodeFs.writeFileSync(nodePath.join(w.workspaces.dirFor(made.id), 'note.txt'), '先记一笔', 'utf8');
  assert.equal(worlds.emitLiveChange('owner', made.id), true, '前提：这一声本身推出去了');
  await sleep(200);
  assert.equal(installed().length, 0, '★ 入口还没写 ⇒ 桌面那一格没变 ⇒ 一个信号都不许发');

  // ── ② 入口那一份**直接写盘**（助手在那一间目录里干活就是这个形状）──
  nodeFs.writeFileSync(
    nodePath.join(w.workspaces.dirFor(made.id), 'index.html'),
    '<!doctype html><p>真的内容</p>',
    'utf8',
  );
  assert.equal(w.apps.meta(made.id).building, false, '前提：现在不是"在建"了');
  assert.equal(worlds.emitLiveChange('owner', made.id), true);
  await waitFor(() => installed().length > 0, '★ 桌面那条连接要收到那一声（否则那一格永远是灰的）');
  assert.equal(installed()[0].seq, undefined, '★ 瞬态：不占号');

  // ── ③ 负向对照：**不是他的小程序**（scratch 那种房间）⇒ 一个信号都不发 ──
  w.workspaces.ensure('job-x9', { title: '派活那间', entry: 'index.html' });
  nodeFs.writeFileSync(
    nodePath.join(w.workspaces.dirFor('job-x9'), 'index.html'),
    '<!doctype html><p>派活那间的东西</p>',
    'utf8',
  );
  const before = installed().length;
  assert.equal(worlds.emitLiveChange('owner', 'job-x9'), true);
  await sleep(200);
  assert.equal(installed().length, before, '★ 派活那间变了跟桌面那一格没关系');
});
