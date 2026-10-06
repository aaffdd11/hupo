// **桌面上那颗加号：建一个空的小程序**（主人 2026-09-27 · 契约 `docs/dev/127-CREATE-APP-FROM-DESKTOP.md`）。
//
// ── 这一份钉什么（一句话）──────────────────────────────────
// ① **建出来的是"工作区 ＋ 登记"，不打成包**（`114`：用户端没有版本快照那一套），
//    空工作区那个 `index.html` 是**占位页**（点进去看得见东西，不是 404）；
// ② **名字必填**（空 / 太长 ⇒ 400 ＋ 一句人话）；**描述可选**（存进清单，读得回来）；
// ③ **以盒子为准**：租户这一下必须在**他盒子里**落，宿主那份**一个字节都不许动**；
// ④ **"里面不能再开一个"**：助手在某个小程序那一间里调 `create` ⇒ 人话拒；
//    `main` 与**派活那间**（长活"另开一处做"）照旧放行。
//
// ⚠️ 形状照 `test/app-menu.test.js`：**真 `Worlds`** ＋ **真 HTTP** ＋
//    租户那一条走**真 `net.connect`** 隧道。**不 mock 业务**。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeNet from 'node:net';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test, { after } from 'node:test';

import { AgentRuntime } from '../src/agent-runtime.js';
import { Apps, MAX_DESC_CHARS, MAX_TITLE_CHARS, isAnAppRoom, newAppId } from '../src/apps.js';
import { createBoxApps } from '../src/apps-box.js';
import { INSIDE_APP_NO_CREATE, NEEDS_ASK } from '../src/apps-consent.js';
import { handleAppsOp } from '../src/apps-socket.js';
import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { AppWorkspaces, registerBlankApp } from '../src/workspace.js';
import { Worlds } from '../src/worlds.js';

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

const tmp = (tag = 'hupo-127-') => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), tag));

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
  const auth = new Auth({ dataDir: tmp('hupo-127-auth-'), now: () => NOW });
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

const getApps = async (origin, token) => {
  const r = await fetch(`${origin}/api/apps`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json() };
};

// ════════════════════════════════════════════════════════════
// S1 —— 两个纯的：短名怎么抽 · "这一间是不是一个小程序"
// ════════════════════════════════════════════════════════════
test('S1 `newAppId`：合法 · 撞了就换一个 · 试满还撞 ⇒ 明着抛；`isAnAppRoom` 只认"他的小程序与内置那几格"', () => {
  // 名字里的中文**不音译**：id 是随机那几个字符（`app-` 打头）
  const id = newAppId();
  assert.match(id, /^app-[a-z0-9]+$/, `抽出来的短名要合法：${id}`);

  // 撞了就再抽（有界）：第一次抽到被占的那个，第二次换一个
  let n = 0;
  const seq = ['aaaaaaaa', 'bbbbbbbb'];
  const next = newAppId({ rand: () => seq[n++], tries: 2, taken: (x) => x === 'app-aaaaaaaa' });
  assert.equal(next, 'app-bbbbbbbb', '★ 撞了就换一个');
  assert.throws(
    () => newAppId({ rand: () => 'aaaaaaaa', tries: 3, taken: () => true }),
    /短名/,
    '★ 试满还撞 ⇒ 明着抛（不许返回一个会被拒的 id）',
  );

  // `isAnAppRoom`：main 不算、内置那两格算、他自己的 app 算、别的不算
  const apps = { has: (x) => x === 'aoshu' };
  assert.equal(isAnAppRoom(apps, 'main'), false, '桌面本身不算"一个小程序"');
  assert.equal(isAnAppRoom(apps, ''), false);
  assert.equal(isAnAppRoom(apps, null), false);
  assert.equal(isAnAppRoom(apps, 'settings'), true, '内置那几格也是"一个小程序那一屏"');
  assert.equal(isAnAppRoom(apps, 'discover'), true);
  // ⚠️ 2026-10-06：「我自己那台」那一格删了 ⇒ 它**不再是**桌面上的一屏
  assert.equal(isAnAppRoom(apps, 'harness'), false,
    '★ 那一格已经从产品里去掉（`docs/dev/200-REMOVE-HARNESS.md`）');
  assert.equal(isAnAppRoom(apps, 'aoshu'), true, '他自己的小程序');
  assert.equal(isAnAppRoom(apps, 'job-x7'), false, '派活那间不是（长活要在那里造 app）');
  assert.equal(isAnAppRoom({ has: () => { throw new Error('坏了'); } }, 'aoshu'), false, '认不出 ⇒ false，不抛');
});

// ════════════════════════════════════════════════════════════
// S2 —— 落点：工作区 ＋ 登记（不打成包）＋ 占位页 ＋ 描述存得住
// ════════════════════════════════════════════════════════════
test('S2 `registerBlankApp`：建工作区 ＋ 登记 ＋ 占位页；描述存进清单读得回来', () => {
  const root = tmp();
  const apps = new Apps({ dir: nodePath.join(root, 'apps'), sub: 'u1' });
  const workspaces = new AppWorkspaces({ dir: nodePath.join(root, 'workspaces'), now: () => NOW });

  const m = registerBlankApp({
    apps,
    workspaces,
    id: 'app-abc12345',
    title: '记账本',
    description: '记每天的开销，月底给我一张表。',
    createdBy: 'user',
  });
  assert.equal(m.live, true, '★ 是**登记**（活的那一份），不是包');
  assert.equal(m.title, '记账本');
  assert.equal(m.description, '记每天的开销，月底给我一张表。', '★ 描述要存下来');
  assert.ok(m.icon, '★ 图标要有一个（没给他挑就自动配）');
  assert.equal(m.entry, 'index.html');
  // 清单读得回来（桌面那条 `/api/apps` 走的就是它）
  const again = apps.meta('app-abc12345');
  assert.equal(again.description, '记每天的开销，月底给我一张表。');
  // **空工作区里那个 index.html 是占位页**（点进去看得见东西，不是 404）
  const index = workspaces.fs.readFileSync(nodePath.join(workspaces.dirFor('app-abc12345'), 'index.html'), 'utf8');
  assert.match(index, /这里还空着/);
  assert.match(index, /记账本/, '占位页的标题是它的名字');
  assert.equal(apps.current('app-abc12345'), null, '★ 不许给它打包（用户端没有版本快照那一套）');

  // 负向对照：**没有描述**照样能建（描述是可选的）
  const m2 = registerBlankApp({ apps, workspaces, id: 'app-def67890', title: '随手记' });
  assert.equal(m2.description, '', '没填 ⇒ 空串（不是 undefined）');
});

// ════════════════════════════════════════════════════════════
// S2′ —— ★ 2026-10-04：桌面那一格**"在建"**（主人：*"icon 是一个灰色的在建图标。
//        就像 ios 那个开发中的那个。"*）
// ════════════════════════════════════════════════════════════
test('S2′ 占位页还在 ⇒ `building=true`；入口被真内容顶掉 ⇒ `false`（含负向对照）', () => {
  const root = tmp();
  const ready = [];
  const workspaces = new AppWorkspaces({
    dir: nodePath.join(root, 'workspaces'),
    now: () => NOW,
    onReady: (id) => ready.push(id),
  });
  // 🔴 与生产同一条接线：`Apps` 要拿得到工作区那一层才判得出"在建"
  const apps = new Apps({ dir: nodePath.join(root, 'apps'), sub: 'u1', live: () => ({ workspaces }) });

  registerBlankApp({ apps, workspaces, id: 'zaijian', title: '在建的' });
  // ⚠️ 断言打在 `meta()` / `list()` 上 —— 那**正是桌面读的那两条路**
  //    （`register()` 的返回值是**落盘那份 `app.json`**：`building` 是**算出来的**，
  //     不许写进那个文件，否则它就成了一个会漂的存量字段）
  assert.equal(apps.meta('zaijian').building, true, '★ 刚建出来（只有占位页）⇒ 桌面该画"在建"');
  assert.equal(apps.list().find((a) => a.id === 'zaijian').building, true, '清单那一份也一样');

  // 🔴 负向对照：写一份**别的**文件（入口那份还是占位）⇒ **仍然在建**
  workspaces.write('zaijian', { 'note.txt': '先记一笔' });
  assert.equal(apps.meta('zaijian').building, true, '入口没换 ⇒ 不该摘掉"在建"');
  assert.deepEqual(ready, [], '★ 那一声"做完了"这时候**一次都不许叫**');

  // 真内容来了（入口那一份被顶掉）⇒ 不再在建，而且**叫一声**（桌面据此重拉清单）
  workspaces.write('zaijian', { 'index.html': '<!doctype html><html><body>真的内容</body></html>' });
  assert.equal(apps.meta('zaijian').building, false, '★ 入口换成真内容 ⇒ 不该再画灰的');
  assert.deepEqual(ready, ['zaijian'], '★ "做完了"那一声要叫，而且只叫一次');

  // 负向对照：**没接工作区那一层**（老部署 / 盒代理）⇒ `building` 一律 false
  //   （"不知道"不许画成"在建"：那会把做好的小程序显示成灰的）
  const bare = new Apps({ dir: nodePath.join(root, 'apps2'), sub: 'u1' });
  registerBlankApp({
    apps: bare,
    workspaces: new AppWorkspaces({ dir: nodePath.join(root, 'workspaces2'), now: () => NOW }),
    id: 'bare',
    title: '没接线那一份',
  });
  assert.equal(bare.meta('bare').building, false, '★ 拿不到工作区 ⇒ 不许说"在建"');
});

// ════════════════════════════════════════════════════════════
// S3 —— 那一条 HTTP 口（主人这一份）：名字必填 · 描述可选 · 清单里马上看得见
// ════════════════════════════════════════════════════════════
test('S3 `/api/app-create`：建成 ⇒ 清单立刻看得见 ＋ 盘上有占位页；空名字 / 太长的都拒', async (t) => {
  const dataDir = tmp('hupo-127-owner-');
  const { worlds } = await bootWorlds(t, { tag: 'owner', dataDir });
  const srv = await bootServer(t, { worlds });
  const addr = await srv.listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = srv.auth.issue({ sub: 'owner' }).token;

  const r = await postCreate(origin, token, { title: '记账本', description: '记开销' });
  const raw = await r.text();
  assert.equal(r.status, 200, raw);
  const got = JSON.parse(raw);
  assert.equal(got.ok, true);
  assert.match(got.id, /^app-[a-z0-9]+$/);
  assert.equal(got.title, '记账本');
  assert.equal(got.description, '记开销');
  assert.ok(got.icon, '回执里要带上"最后配的那个图标"（否则界面说不出实话）');

  // 清单里马上看得见（桌面那颗图标就是这么长出来的）
  const list = await getApps(origin, token);
  assert.equal(list.status, 200);
  const mine = list.body.apps.find((a) => a.id === got.id);
  assert.ok(mine, '★ 建完立刻进 `/api/apps`');
  assert.equal(mine.title, '记账本');
  assert.equal(mine.description, '记开销');
  assert.ok(mine.entryUrl, '入口 URL 照旧现签');

  // 盘上：工作区里那个占位页在
  const w = worlds.worldFor('owner');
  const index = w.workspaces.fs.readFileSync(nodePath.join(w.workspaces.dirFor(got.id), 'index.html'), 'utf8');
  assert.match(index, /这里还空着/);

  // 空名字 ⇒ 400 ＋ 一句人话
  const blank = await postCreate(origin, token, { title: '   ' });
  const blankBody = await blank.text();
  assert.equal(blank.status, 400, blankBody);
  assert.equal(JSON.parse(blankBody).error, 'blank-title');
  assert.match(JSON.parse(blankBody).text, /名字/, '★ 要是一句人话（说清该怎么办）');
  // 名字太长 / 描述太长 ⇒ 400
  const longTitle = await postCreate(origin, token, { title: '名'.repeat(MAX_TITLE_CHARS + 1) });
  assert.equal(longTitle.status, 400);
  const longDesc = await postCreate(origin, token, { title: '好的', description: '字'.repeat(MAX_DESC_CHARS + 1) });
  assert.equal(longDesc.status, 400);
  // 负向对照：**描述不填**照旧能建
  const noDesc = await postCreate(origin, token, { title: '随手记' });
  const noDescBody = await noDesc.text();
  assert.equal(noDesc.status, 200, noDescBody);
  assert.equal(JSON.parse(noDescBody).description, '');
});

// ════════════════════════════════════════════════════════════
// S4 —— 以盒子为准：租户这一下在**他盒子里**落，宿主那份一个字节都不动
// ════════════════════════════════════════════════════════════
test('S4 租户：那一颗加号在**盒子里**落地（宿主那份不许动）；盒子不通 ⇒ 如实 503', async (t) => {
  // ── 盒子：真世界 ＋ 真服务（内部口只在一条 0600 UDS 上）──────────
  const boxRoot = tmp('hupo-127-box-');
  const box = await bootWorlds(t, { tag: 'box', dataDir: boxRoot });
  const boxSrv = await bootServer(t, { worlds: box.worlds, trustedSub: 'owner', buildId: 's4-box' });
  await boxSrv.listen(0);
  const uds = nodePath.join(tmp('hupo-127-uds-'), 'local-api.sock');
  await boxSrv.listenTrusted(uds);

  // ── 宿主：租户 u2（他自己那一格故意留一个"旧副本"的痕迹，证明"没动宿主"不是空话）
  const hostRoot = tmp('hupo-127-host-');
  const host = await bootWorlds(t, { tag: 'host', dataDir: hostRoot });
  const state = { down: false, dials: 0 };
  const hostSrv = await bootServer(t, {
    worlds: host.worlds,
    tenantOf: (x) => (x === 'u2' ? 'hupo-b' : null),
    appsOf: (x) =>
      x === 'u2'
        ? createBoxApps({
          sub: x,
          dial: () => {
            if (state.down) return null;
            state.dials += 1;
            return nodeNet.connect(uds);
          },
          log: () => {},
        })
        : host.worlds.worldFor(x)?.apps ?? null,
    proxyFor: () => (state.down ? null : nodeNet.connect(uds)),
    buildId: 's4-host',
  });
  const addr = await hostSrv.listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = hostSrv.auth.issue({ sub: 'u2' }).token;

  const r = await postCreate(origin, token, { title: '买菜清单', description: '每天买菜' });
  const raw = await r.text();
  assert.equal(r.status, 200, raw);
  const got = JSON.parse(raw);
  assert.equal(got.ok, true);
  assert.ok(state.dials > 0, '🔴 必须**真过隧道**（否则"落在他盒里"这一条什么都没证明）');

  // 盒里：真建出来了（清单 ＋ 工作区 ＋ 占位页）
  const boxUser = box.worlds.worldFor('owner');
  const inBox = boxUser.apps.meta(got.id);
  assert.ok(inBox, '🔴 盒子的库里有它');
  assert.equal(inBox.title, '买菜清单');
  assert.equal(inBox.description, '每天买菜');
  const boxIndex = boxUser.workspaces.fs.readFileSync(
    nodePath.join(boxUser.workspaces.dirFor(got.id), 'index.html'),
    'utf8',
  );
  assert.match(boxIndex, /这里还空着/);
  // 宿主这一格：**那个 id 在宿主那份库里查不到**（东西只在他盒里）
  const hostUser = host.worlds.worldFor('u2');
  assert.equal(hostUser.apps.meta(got.id), null, '🔴 宿主那份不许也建一份（"两处库"那句假话）');

  // 盒子不通 ⇒ 如实 503，**不退回宿主那份**
  state.down = true;
  const down = await postCreate(origin, token, { title: '断线也要试' });
  const downBody = await down.text();
  assert.equal(down.status, 503, downBody);
  assert.equal(JSON.parse(downBody).error, 'tenant-not-ready');
});

// ════════════════════════════════════════════════════════════
// S5 —— "里面不能再开一个"（助手那条路）
// ════════════════════════════════════════════════════════════
test('S5 助手在**某个小程序那一间**里调 create ⇒ 人话拒；main 与派活那间照旧放行', async () => {
  const root = tmp();
  const apps = new Apps({ dir: nodePath.join(root, 'apps'), sub: 'u1' });
  const workspaces = new AppWorkspaces({ dir: nodePath.join(root, 'workspaces'), now: () => NOW });
  // 他库里已经有一个（"奥数练一练"）—— 这就是"他已经在那个小程序里"的那一间
  registerBlankApp({ apps, workspaces, id: 'aoshu', title: '奥数练一练' });

  const ctx = (scope) => ({
    // 他**明说**了（这一条是"明说才许写"那道闸的正身）—— 好让这里只测"里面不能再开一个"
    turnInputFor: () => '帮我做一个错题本小程序',
    workspace: workspaces,
    onInstalled: () => {},
    onAppBuilt: () => {},
    ...(scope ? { scope } : {}),
  });
  const make = (id) => ({ op: 'create', app: { id, title: '错题本', entry: 'index.html', files: {} }, scope: undefined });

  // ① 在小程序那一间里 ⇒ 拒，而且是人话（那句话本身就告诉他该怎么办）
  const inside = await handleAppsOp(apps, { ...make('wrongbook'), scope: 'aoshu' }, ctx('aoshu'));
  assert.equal(inside.ok, false, JSON.stringify(inside));
  assert.equal(inside.refused, 'inside-app');
  assert.equal(inside.error, INSIDE_APP_NO_CREATE);
  assert.equal(apps.meta('wrongbook'), null, '被拒 ⇒ 盘上零残留');
  // 内置那几格也一样
  const inBuiltin = await handleAppsOp(apps, { ...make('wrongbook'), scope: 'settings' }, ctx('settings'));
  assert.equal(inBuiltin.refused, 'inside-app');

  // ② 负向对照 ①：**在桌面上说**（scope=main / 不给 scope）⇒ 照旧能造
  const fromMain = await handleAppsOp(apps, { ...make('wrongbook'), scope: 'main' }, ctx('main'));
  assert.equal(fromMain.ok, true, JSON.stringify(fromMain));
  // ③ 负向对照 ②：**派活那间**（长活"另开一处做"）⇒ 照旧能造（那条产品行为靠它）
  const fromJob = await handleAppsOp(apps, { ...make('wrongbook2'), scope: 'job-x7' }, ctx('job-x7'));
  assert.equal(fromJob.ok, true, JSON.stringify(fromJob));
  // ④ 负向对照 ③：他没明说（那道闸照旧在，与这一条不冲突）
  const notAsked = await handleAppsOp(
    apps,
    { ...make('wrongbook3'), scope: 'main' },
    { ...ctx('main'), turnInputFor: () => '今天天气不错' },
  );
  assert.equal(notAsked.refused, 'needs-ask');
  assert.equal(notAsked.error, NEEDS_ASK);
});
