// **`147`：他允许 / 关掉"这个小程序能存东西" —— 两道权威都在他那一格里**
// （主人 2026-09-30 拍的注册制：*"在设置里可以看到也可以关闭"*）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   · **G1 签字的是他**：`POST /api/app-grant` 走**登录态**；没令牌 ⇒ 401/403；
//     声明了没允许 ⇒ 存不进去（403）；他点了允许 ⇒ **当场存得进去**；关掉 ⇒ **当场进不去**。
//   · **G2 界面看得到两件事**：`/api/apps` 同时给 `permissions`（**它想要**）与
//     `granted`（**你给了没有**）—— 少任何一个，那一屏就说不清。
//   · **G3 租户：字落在盒子里**（不是宿主那一格）—— 走真隧道、真内部口；
//     `grant.json` 与那一个 SQLite 文件都只出现在盒里，宿主那格**一个字节都没有**。
//   · **G4 认不出来就拒**：不认识的权限名 400（**不许**悄悄收下再"当没发生"）。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeNet from 'node:net';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test, { after } from 'node:test';

import { Apps } from '../src/apps.js';
import { Auth } from '../src/auth.js';
import { createBoxApps } from '../src/apps-box.js';
import { createServer } from '../src/server.js';

const NOW = 1_800_000_000_000;
const KEY = Buffer.from('f'.repeat(64), 'hex');

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

function tmp(tag = 'hupo-g147-') {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), tag));
}

function makeWorlds(dirs) {
  const map = new Map();
  for (const [sub, dir] of Object.entries(dirs)) {
    map.set(sub, { userId: sub, dir, apps: new Apps({ dir, sub, now: () => NOW }) });
  }
  return { worldFor: (sub) => map.get(sub) ?? null };
}

const OK = (id, title, permissions = []) => ({
  id,
  title,
  icon: 'dice',
  entry: 'index.html',
  files: { 'index.html': '<p>x</p>' },
  permissions,
});

/** 起一台**盒子**（真服务，只在一条 UDS 上接内部口 · 照 `app-ask-box.test.js`）。 */
async function bootBox(t, { dir }) {
  const uds = nodePath.join(tmp('hupo-g147-box-'), 'local-api.sock');
  const auth = new Auth({ dataDir: tmp('hupo-g147-boxauth-'), now: () => NOW });
  auth.setPassword('盒子里的口令');
  const worlds = makeWorlds({ owner: dir });
  const { listen, listenTrusted, close } = createServer({
    auth,
    worlds,
    trustedSub: 'owner',
    apps: { base: 'http://127.0.0.1:9', key: KEY },
    now: () => NOW,
    webRoot: null,
    buildId: 'g147-box',
    log: () => {},
  });
  t.after(guard(close));
  const pub = await listen(0);
  await listenTrusted(uds);
  return { uds, publicPort: pub.port };
}

/** 起一台**宿主**（租户走真隧道进他的盒子；主人走本机那份）。 */
async function bootHost(t, { hostDirs, boxUds = {}, tenants = {} }) {
  const auth = new Auth({ dataDir: tmp('hupo-g147-hostauth-'), now: () => NOW });
  auth.setPassword('宿主上的口令');
  const worlds = makeWorlds(hostDirs);
  const dials = new Map();
  const dialFor = (tenant) => {
    dials.set(tenant, (dials.get(tenant) ?? 0) + 1);
    const uds = boxUds[tenant];
    if (!uds) return null;
    return nodeNet.connect(uds);
  };
  const tenantOf = (sub) => tenants[sub] ?? null;
  const appsOf = (sub) => {
    const tenant = tenantOf(sub);
    if (tenant) return createBoxApps({ sub, dial: () => dialFor(tenant) });
    return worlds.worldFor(sub)?.apps ?? null;
  };
  const { listen, close } = createServer({
    auth,
    worlds,
    appsOf,
    apps: { base: 'http://127.0.0.1:9999', key: KEY },
    tenantOf,
    proxyFor: (tenant) => dialFor(tenant),
    now: () => NOW,
    webRoot: null,
    buildId: 'g147-host',
    log: () => {},
  });
  t.after(guard(close));
  const addr = await listen(0);
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    dials,
    tokenFor: (sub) => auth.issue({ sub }).token,
    appsFor: appsOf,
  };
}

const postGrant = (host, token, body) =>
  fetch(`${host.origin}/api/app-grant`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const getApps = (host, token) => fetch(`${host.origin}/api/apps`, { headers: { authorization: `Bearer ${token}` } });

const dbFileOf = (dir, sub, id) => nodePath.join(dir, 'hupo', 'apps', id, 'data.sqlite');
const grantFileOf = (dir, id) => nodePath.join(dir, 'hupo', 'apps', id, 'grant.json');
const exists = (p) => {
  try {
    nodeFs.statSync(p);
    return true;
  } catch {
    return false;
  }
};

// ════════════════════════════════════════════════════════════
// G1 / G2 —— 主人这一侧：他点一下，能力当场有 / 当场没
// ════════════════════════════════════════════════════════════

test('G1 ★ 默认不给：声明了也**要等他点头**；`unanswered` 就是"打开时那张弹窗"的依据；他关掉 ⇒ 又不生效', async (t) => {
  const dir = tmp();
  const apps = new Apps({ dir, sub: 'main', now: () => NOW });
  apps.register({ id: 'coin', title: '硬币', entry: 'index.html', permissions: ['db'] });
  const host = await bootHost(t, { hostDirs: { main: dir } });
  const token = host.tokenFor('main');

  // ① 🔴 **光声明还不算数**（主人 2026-10-01：不要"声明即用"，改成"打开时弹窗申请"）
  assert.deepEqual(apps.grants('coin'), [], '默认不给');
  assert.deepEqual(apps.unanswered('coin'), ['db'], '★ 还没表过态的那几样 = 弹窗要问的');
  const before = await apps.dbExec('coin', { op: 'run', sql: 'CREATE TABLE t(a TEXT)' });
  assert.equal(before.ok, false);
  assert.equal(before.status, 403);
  //    清单那一侧也看得到（客户端就是拿它弹窗）
  let list = (await (await getApps(host, token)).json()).apps;
  assert.deepEqual(list.find((a) => a.id === 'coin').unanswered, ['db']);

  // ② 他点头（设置页那颗开关 / 打开时那张弹窗，两条路都走这一条口）
  const allow = await postGrant(host, token, { id: 'coin', permission: 'db', allow: true });
  assert.equal(allow.status, 200, JSON.stringify(await allow.clone().json()));
  assert.deepEqual((await allow.json()).permissions, ['db']);
  assert.deepEqual(apps.grants('coin'), ['db'], '★ 点头之后才生效');
  assert.deepEqual(apps.unanswered('coin'), [], '表过态了 ⇒ 不再弹');
  assert.deepEqual(Object.keys(JSON.parse(nodeFs.readFileSync(grantFileOf(dir, 'coin'), 'utf8'))), ['allowed', 'denied', 'at']);

  // ③ 当场就能存了（同一份库、同一个进程，什么都不用重启）
  const mk = await apps.dbExec('coin', { op: 'run', sql: 'CREATE TABLE t(a TEXT)' });
  assert.equal(mk.ok, true, JSON.stringify(mk)); // ★ ① 里那一条被 403 真的拦掉了，所以表先前没建成
  const r1 = await apps.dbExec('coin', { op: 'run', sql: 'INSERT INTO t VALUES (?)', params: ['甲'] });
  assert.equal(r1.ok, true, JSON.stringify(r1));

  // ④ 他关掉 ⇒ 当场进不去（而且记成"他表过态"⇒ 不再自动弹）
  const deny = await postGrant(host, token, { id: 'coin', permission: 'db', allow: false });
  assert.deepEqual((await deny.json()).permissions, []);
  assert.deepEqual(apps.grants('coin'), [], '关掉就不生效');
  assert.deepEqual(apps.unanswered('coin'), [], '他拒过 ⇒ 不再自动弹（设置里能改回来）');
  const off = await apps.dbExec('coin', { op: 'all', sql: 'SELECT a FROM t' });
  assert.equal(off.ok, false);
  assert.equal(off.status, 403);

  // ⑤ 再打开 ⇒ 又行了，**数据还在**
  await postGrant(host, token, { id: 'coin', permission: 'db', allow: true });
  const r7 = await apps.dbExec('coin', { op: 'all', sql: 'SELECT a FROM t' });
  assert.equal(r7.ok, true, JSON.stringify(r7));
  assert.deepEqual(r7.rows, [{ a: '甲' }], '关掉再打开，数据还在');
  assert.equal(exists(dbFileOf(dir, 'main', 'coin')), true, '关掉不许顺手删他的数据');
});

test('G2 清单里三件事分得清：`permissions`＝它想要 · `granted`＝你给了 · `unanswered`＝还没问过', async (t) => {
  const dir = tmp();
  const apps = new Apps({ dir, sub: 'main', now: () => NOW });
  apps.register({ id: 'wants', title: '想要', entry: 'index.html', permissions: ['db'] });
  apps.register({ id: 'plain', title: '不要', entry: 'index.html' });
  const host = await bootHost(t, { hostDirs: { main: dir } });
  const token = host.tokenFor('main');

  let list = (await (await getApps(host, token)).json()).apps;
  const wants = list.find((a) => a.id === 'wants');
  const plain = list.find((a) => a.id === 'plain');
  assert.deepEqual(wants.permissions, ['db'], '它想要什么');
  assert.deepEqual(wants.granted, [], '默认不给');
  assert.deepEqual(wants.unanswered, ['db'], '★ 还没问过他 ⇒ 打开时弹窗');
  assert.deepEqual(plain.permissions, [], '没声明的：什么都不想要');
  assert.deepEqual(plain.granted, []);
  assert.deepEqual(plain.unanswered, [], '没声明的：没什么可问的');

  // 他点头 ⇒ 换到 granted；他关掉 ⇒ 换到"表过态"（unanswered 不再有它）
  await postGrant(host, token, { id: 'wants', permission: 'db', allow: true });
  list = (await (await getApps(host, token)).json()).apps;
  assert.deepEqual(list.find((a) => a.id === 'wants').granted, ['db']);
  assert.deepEqual(list.find((a) => a.id === 'wants').unanswered, []);
  await postGrant(host, token, { id: 'wants', permission: 'db', allow: false });
  list = (await (await getApps(host, token)).json()).apps;
  assert.deepEqual(list.find((a) => a.id === 'wants').permissions, ['db'], '它想要什么**没变**');
  assert.deepEqual(list.find((a) => a.id === 'wants').granted, [], '关掉之后：能用什么是空的');
  assert.deepEqual(list.find((a) => a.id === 'wants').unanswered, [], '表过态 ⇒ 不再问');
  assert.deepEqual(list.find((a) => a.id === 'plain').granted, [], '别的 app 不受影响');
});

test('G4 认不出来的权限名 / 不存在的 app ⇒ 如实拒（不许悄悄收下）', async (t) => {
  const dir = tmp();
  const apps = new Apps({ dir, sub: 'main', now: () => NOW });
  apps.register({ id: 'coin', title: '硬币', entry: 'index.html', permissions: ['db'] });
  const host = await bootHost(t, { hostDirs: { main: dir } });
  const token = host.tokenFor('main');
  const bad = await postGrant(host, token, { id: 'coin', permission: 'root', allow: true });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).text, /还不给/);
  const missing = await postGrant(host, token, { id: 'nope', permission: 'db', allow: true });
  assert.equal(missing.status, 400, '不在他这儿的 app 不许"允许成功"');
  // 没令牌 ⇒ 拒（这一条口是**他**签的字）
  const anon = await fetch(`${host.origin}/api/app-grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'coin', permission: 'db', allow: true }),
  });
  assert.ok(anon.status === 401 || anon.status === 403, `没令牌要拒（实际 ${anon.status}）`);
});

// ════════════════════════════════════════════════════════════
// G5 —— **老文件（允许清单）翻新语义**：他当年关掉的，今天仍然是关着的
// ════════════════════════════════════════════════════════════

test('G5 ★ 老文件照旧认：老"允许清单"＝他已经点过头（不能因为换版作废）；老"关掉清单"＝他表过态、不给', async () => {
  const dir = tmp();
  const apps = new Apps({ dir, sub: 'main', now: () => NOW });
  const grantFile = (id) => nodePath.join(dir, 'hupo', 'apps', id, 'grant.json');

  // ① 最早那份 `{permissions:[…]}`（那时"写进清单 = 他允许了"）⇒ 原样认成 allowed
  apps.register({ id: 'old-allow', title: '老的·允许过', entry: 'index.html', permissions: ['db'] });
  nodeFs.writeFileSync(grantFile('old-allow'), `${JSON.stringify({ permissions: ['db'], at: NOW })}\n`);
  assert.deepEqual(apps.grants('old-allow'), ['db'], '★ 他当年的点头不许作废');
  assert.deepEqual(apps.unanswered('old-allow'), [], '表过态 ⇒ 不弹');
  const ok1 = await apps.dbExec('old-allow', { op: 'run', sql: 'CREATE TABLE t(a)' });
  assert.equal(ok1.ok, true, JSON.stringify(ok1));

  // ② 上一版那份 `{denied:[…]}`（"他关掉了"）⇒ 认成"表过态、不给"
  apps.register({ id: 'old-deny', title: '老的·关着', entry: 'index.html', permissions: ['db'] });
  nodeFs.writeFileSync(grantFile('old-deny'), `${JSON.stringify({ denied: ['db'], at: NOW })}\n`);
  assert.deepEqual(apps.grants('old-deny'), [], '关着的照样关着');
  assert.deepEqual(apps.unanswered('old-deny'), [], '表过态 ⇒ 不弹');
  const bad = await apps.dbExec('old-deny', { op: 'run', sql: 'CREATE TABLE t(a)' });
  assert.equal(bad.ok, false);

  // ③ 他一点头 ⇒ 文件变成新形状（两张表），而且行为逐字对
  apps.setGrants('old-deny', ['db']);
  assert.deepEqual(apps.grants('old-deny'), ['db']);
  assert.deepEqual(Object.keys(JSON.parse(nodeFs.readFileSync(grantFile('old-deny'), 'utf8'))), ['allowed', 'denied', 'at']);
  nodeFs.rmSync(dir, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════
// G6 —— **清空它存的东西**（`148` §五 · 设置页那颗按钮背后那一条）
// ════════════════════════════════════════════════════════════

const postClear = (host, token, id) =>
  fetch(`${host.origin}/api/app-db-clear`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });

test('G6 主人：清空 ⇒ 库真没了、制品还在；没令牌拒；幂等', async (t) => {
  const dir = tmp();
  const apps = new Apps({ dir, sub: 'main', now: () => NOW });
  apps.register({ id: 'jizhang', title: '记账', entry: 'index.html', permissions: ['db'] });
  const host = await bootHost(t, { hostDirs: { main: dir } });
  const token = host.tokenFor('main');
  // 他先点头（下面钉的是"清空"，不是"给不给存"）
  assert.equal((await postGrant(host, token, { id: 'jizhang', permission: 'db', allow: true })).status, 200);
  // 先存一笔
  const w = await apps.dbExec('jizhang', { op: 'run', sql: 'CREATE TABLE t(a TEXT)' });
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.equal(exists(dbFileOf(dir, 'main', 'jizhang')), true);

  const r = await postClear(host, token, 'jizhang');
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.equal((await r.json()).ok, true);
  assert.equal(exists(dbFileOf(dir, 'main', 'jizhang')), false, '★ 库要真没了');
  assert.equal(apps.has('jizhang'), true, '★ 那个 app 还在（清的是内容，不是壳）');
  // 幂等：再点一次也算成了
  assert.equal((await postClear(host, token, 'jizhang')).status, 200);
  // 没令牌 ⇒ 拒（这一条是**他**签的字）
  const anon = await fetch(`${host.origin}/api/app-db-clear`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'jizhang' }),
  });
  assert.ok(anon.status === 401 || anon.status === 403, `没令牌要拒（实际 ${anon.status}）`);
  // 没说清是哪一个 ⇒ 400 一句人话
  const noId = await postClear(host, token, '');
  assert.equal(noId.status, 400);
});

test('G6 租户：清空**在盒里落**（宿主那格一个字节都没有）', async (t) => {
  const hostDir = tmp();
  const boxDir = tmp();
  const boxApps = new Apps({ dir: boxDir, sub: 'owner', now: () => NOW });
  boxApps.register({ id: 'jizhang', title: '记账', entry: 'index.html', permissions: ['db'] });
  // 盒里先真存一笔（先点头，否则存不进去）
  boxApps.setGrants('jizhang', ['db']);
  await boxApps.dbExec('jizhang', { op: 'run', sql: 'CREATE TABLE t(a TEXT)' });
  assert.equal(exists(dbFileOf(boxDir, 'owner', 'jizhang')), true, '前提：盒里有库');
  const box = await bootBox(t, { dir: boxDir });
  const host = await bootHost(t, {
    hostDirs: { u2: hostDir },
    boxUds: { 'hupo-b': box.uds },
    tenants: { u2: 'hupo-b' },
  });
  const r = await postClear(host, host.tokenFor('u2'), 'jizhang');
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.equal(exists(dbFileOf(boxDir, 'owner', 'jizhang')), false, '★ 盒里那份要真没了');
  assert.equal(exists(dbFileOf(hostDir, 'u2', 'jizhang')), false, '★ 宿主那格始终不该有它');
  assert.ok((host.dials.get('hupo-b') ?? 0) >= 1, '★ 这一下必须过隧道去盒里落');
});

// ════════════════════════════════════════════════════════════
// G3 —— 租户：字与库都落在**他盒子里**
// ════════════════════════════════════════════════════════════

test('G3 租户：`grant.json` 与那个 SQLite 都只出现在盒里（宿主那格一个字节都没有）', async (t) => {
  const hostDir = tmp(); // ★ 宿主那格是空的（B15 之后就是这样）
  const boxDir = tmp();
  const boxApps = new Apps({ dir: boxDir, sub: 'owner', now: () => NOW });
  boxApps.register({ id: 'coin', title: '硬币', entry: 'index.html', permissions: ['db'] });
  const box = await bootBox(t, { dir: boxDir });
  const host = await bootHost(t, {
    hostDirs: { u2: hostDir },
    boxUds: { 'hupo-b': box.uds },
    tenants: { u2: 'hupo-b' },
  });
  const token = host.tokenFor('u2');

  // ① 清单里看得到"它想要 db、还没表过态"（盒子那一侧的判据也一样）
  let list = (await (await getApps(host, token)).json()).apps;
  assert.deepEqual(list.map((a) => a.id), ['coin']);
  assert.deepEqual(list[0].permissions, ['db']);
  assert.deepEqual(list[0].granted, [], '★ 默认不给：声明只是"它想要"');
  assert.deepEqual(list[0].unanswered, ['db'], '★ 还没问过他 ⇒ 打开时弹窗');

  // ② 他点头 ⇒ **盒子里**落一份（宿主那格没有）；答应的是盒子，不是宿主
  const allow = await postGrant(host, token, { id: 'coin', permission: 'db', allow: true });
  assert.equal(allow.status, 200, JSON.stringify(await allow.clone().json()));
  assert.equal(exists(grantFileOf(boxDir, 'coin')), true, '★ 他的点头要落在盒里');
  assert.equal(exists(grantFileOf(hostDir, 'coin')), false, '★ 宿主那格不许有它');
  list = (await (await getApps(host, token)).json()).apps;
  assert.deepEqual(list[0].granted, ['db'], '盒里那份说了算');

  // ③ 他再关掉 ⇒ 盒里那份立马不算数；再打开（④ 要接着跑）
  const deny = await postGrant(host, token, { id: 'coin', permission: 'db', allow: false });
  assert.equal(deny.status, 200, JSON.stringify(await deny.clone().json()));
  list = (await (await getApps(host, token)).json()).apps;
  assert.deepEqual(list[0].granted, [], '关掉之后盒里那份说了算');
  const allow2 = await postGrant(host, token, { id: 'coin', permission: 'db', allow: true });
  assert.deepEqual((await allow2.json()).permissions, ['db']);

  // ④ **真跑一条**：经隧道在盒里跑，库文件落在盒里
  const store = host.appsFor('u2');
  const w = await store.dbExec('coin', { op: 'run', sql: 'CREATE TABLE t(a TEXT)' });
  assert.equal(w.ok, true, JSON.stringify(w));
  const w2 = await store.dbExec('coin', { op: 'run', sql: 'INSERT INTO t VALUES (?)', params: ['盒里的'] });
  assert.equal(w2.ok, true);
  const w3 = await store.dbExec('coin', { op: 'all', sql: 'SELECT a FROM t' });
  assert.deepEqual(w3.rows, [{ a: '盒里的' }]);
  assert.equal(exists(dbFileOf(boxDir, 'owner', 'coin')), true, '★ 库要落在盒里');
  assert.equal(exists(dbFileOf(hostDir, 'u2', 'coin')), false, '★ 宿主这一侧**绝不许**也建一个');
  // ★ 它真的过了隧道（不是宿主自己答的）
  assert.ok((host.dials.get('hupo-b') ?? 0) >= 3, '存储那几步都必须去问盒子');

  // ⑤ 最后再关一次 ⇒ 盒里那份立马不算数（"关掉"这一下**永远在他手里**）
  const deny2 = await postGrant(host, token, { id: 'coin', permission: 'db', allow: false });
  assert.deepEqual((await deny2.json()).permissions, []);
  const w4 = await store.dbExec('coin', { op: 'all', sql: 'SELECT a FROM t' });
  assert.equal(w4.ok, false);
  assert.equal(w4.status, 403);
});
