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

test('G1 主人：没允许 ⇒ 403；他允许 ⇒ 当场存得进去；关掉 ⇒ 当场进不去', async (t) => {
  const dir = tmp();
  const apps = new Apps({ dir, sub: 'main', now: () => NOW });
  apps.register({ id: 'coin', title: '硬币', entry: 'index.html', permissions: ['db'] });
  const host = await bootHost(t, { hostDirs: { main: dir } });
  const token = host.tokenFor('main');

  // ① 声明了、他还没允许 ⇒ 存不进去（**声明只是申请**）
  const before = await apps.dbExec('coin', { op: 'run', sql: 'CREATE TABLE t(a)' });
  assert.equal(before.ok, false);
  assert.equal(before.status, 403);

  // ② 他在设置页点"允许"
  const allow = await postGrant(host, token, { id: 'coin', permission: 'db', allow: true });
  assert.equal(allow.status, 200, JSON.stringify(await allow.clone().json()));
  assert.deepEqual((await allow.json()).permissions, ['db']);
  // ★ 落在他那一格里
  assert.deepEqual(JSON.parse(nodeFs.readFileSync(grantFileOf(dir, 'coin'), 'utf8')).permissions, ['db']);

  // ③ **当场就能存了**（同一份库、同一个进程，什么都不用重启）
  const r1 = await apps.dbExec('coin', { op: 'run', sql: 'CREATE TABLE t(a TEXT)' });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const r2 = await apps.dbExec('coin', { op: 'run', sql: 'INSERT INTO t VALUES (?)', params: ['甲'] });
  assert.equal(r2.ok, true);
  const r3 = await apps.dbExec('coin', { op: 'all', sql: 'SELECT a FROM t' });
  assert.deepEqual(r3.rows, [{ a: '甲' }]);
  assert.equal(exists(dbFileOf(dir, 'main', 'coin')), true, '库要真的落在他那一格里');

  // ④ 关掉 ⇒ **当场**进不去（不是等下一次打开）
  const deny = await postGrant(host, token, { id: 'coin', permission: 'db', allow: false });
  assert.deepEqual((await deny.json()).permissions, []);
  const r4 = await apps.dbExec('coin', { op: 'all', sql: 'SELECT a FROM t' });
  assert.equal(r4.ok, false);
  assert.equal(r4.status, 403);
  // ★ 关掉**不删库**（关掉是"现在不给"，不是"抹掉"）：数据还在盘上
  assert.equal(exists(dbFileOf(dir, 'main', 'coin')), true, '关掉不许顺手删他的数据');
});

test('G2 界面两件事分开：`permissions`＝它想要 · `granted`＝你给了没有', async (t) => {
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
  assert.deepEqual(wants.granted, [], '还没给');
  assert.deepEqual(plain.permissions, []);
  assert.deepEqual(plain.granted, []);

  await postGrant(host, token, { id: 'wants', permission: 'db', allow: true });
  list = (await (await getApps(host, token)).json()).apps;
  assert.deepEqual(list.find((a) => a.id === 'wants').granted, ['db'], '给了之后要看得到');
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

  // ① 清单里看得到"它想要 db、还没给"
  let list = (await (await getApps(host, token)).json()).apps;
  assert.deepEqual(list.map((a) => a.id), ['coin']);
  assert.deepEqual(list[0].permissions, ['db']);
  assert.deepEqual(list[0].granted, []);

  // ② 他点允许 ⇒ **盒子里**多一份 grant.json（宿主那格没有）
  const allow = await postGrant(host, token, { id: 'coin', permission: 'db', allow: true });
  assert.equal(allow.status, 200, JSON.stringify(await allow.clone().json()));
  assert.equal(exists(grantFileOf(boxDir, 'coin')), true, '★ 允许要落在盒里');
  assert.equal(exists(grantFileOf(hostDir, 'coin')), false, '★ 宿主那格不许有它');

  // ③ 清单里现在"给了"
  list = (await (await getApps(host, token)).json()).apps;
  assert.deepEqual(list[0].granted, ['db']);

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

  // ⑤ 关掉 ⇒ 盒里那份立马不算数
  const deny = await postGrant(host, token, { id: 'coin', permission: 'db', allow: false });
  assert.deepEqual((await deny.json()).permissions, []);
  const w4 = await store.dbExec('coin', { op: 'all', sql: 'SELECT a FROM t' });
  assert.equal(w4.ok, false);
  assert.equal(w4.status, 403);
});
