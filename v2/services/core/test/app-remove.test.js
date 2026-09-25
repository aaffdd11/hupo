// **`103`：从桌面上删掉一个小程序 —— 服务端这几条**（契约 `docs/dev/103-APP-DELETE.md` §四 S1–S5）。
//
// ── 它守的是什么（一句话）──────────────────────────────────
// "删掉了"这四个字**必须打在权威那一份上**：租户的制品库在**他盒子里**
// （宿主那份是空的 —— P2-6 之后连老库都删了）。⇒ 这一份真起**两台服务**
// （宿主 ＋ 盒子，中间那条隧道用**真的** `net.connect`），打真请求，看**哪一格的盘**动了。
//
//   反例的形状就是这一类的病：**宿主替盒子答** ⇒ 屏幕上说"删掉了"，
//   而他盒子里那个 app 还在（"页面在说假话"）。
//
// ⚠️ 每条都带反例；判据打在**这一侧**（V13）：只断言 `remove()` 这个函数对，全绿也照样漏。

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
const tmp = (tag = 'hupo-103-') => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), tag));
const APP = (id, title) => ({ id, title, icon: 'dice', entry: 'index.html', files: { 'index.html': '<p>x</p>' } });
const appDirOf = (dir, id) => nodePath.join(dir, 'hupo', 'apps', id);
const removedUnder = (dir) => {
  try {
    return nodeFs.readdirSync(nodePath.join(dir, 'hupo', 'apps', '.removed'));
  } catch {
    return [];
  }
};
const auditHas = (dir, id) => {
  try {
    return nodeFs
      .readFileSync(nodePath.join(dir, 'hupo', 'apps', 'audit.jsonl'), 'utf8')
      .split('\n')
      .some((l) => l.includes('"remove"') && l.includes(id));
  } catch {
    return false;
  }
};

function makeWorlds(dirs) {
  const map = new Map();
  for (const [sub, dir] of Object.entries(dirs)) {
    map.set(sub, { userId: sub, dir, apps: new Apps({ dir, sub, now: () => NOW }) });
  }
  return { worldFor: (sub) => map.get(sub) ?? null };
}

/** 起一台盒子（真服务，内部口只在一条 UDS 上）。 */
async function bootBox(t, { dir }) {
  const uds = nodePath.join(tmp('hupo-103-box-'), 'local-api.sock');
  const auth = new Auth({ dataDir: tmp('hupo-103-boxauth-'), now: () => NOW });
  auth.setPassword('盒子里的口令（这条 UDS 上根本不用它）');
  const worlds = makeWorlds({ owner: dir });
  const { listen, listenTrusted, close } = createServer({
    auth,
    worlds,
    trustedSub: 'owner',
    apps: { base: 'http://127.0.0.1:9', key: KEY },
    now: () => NOW,
    webRoot: null,
    buildId: 's103-box',
    log: () => {},
  });
  t.after(guard(close));
  const pub = await listen(0);
  await listenTrusted(uds);
  return { uds, publicPort: pub.port };
}

/** 起一台宿主：租户经真隧道去他的盒子；主人走本机那份。 */
async function bootHost(t, { hostDirs, boxUds = {}, tenants = { u2: 'hupo-b' } }) {
  const auth = new Auth({ dataDir: tmp('hupo-103-hostauth-'), now: () => NOW });
  auth.setPassword('宿主上的口令');
  const worlds = makeWorlds(hostDirs);
  const dials = new Map();
  const dialFor = (tenant) => {
    const uds = boxUds[tenant];
    if (!uds) return null; // ⚠️ 只数**真的拨出去**的那几次（否则"没连上"这条会假红）
    dials.set(tenant, (dials.get(tenant) ?? 0) + 1);
    return nodeNet.connect(uds);
  };
  const tenantOf = (sub) => tenants[sub] ?? null;
  const appsOf = (sub) => {
    const tenant = tenantOf(sub);
    if (tenant) return createBoxApps({ sub, dial: () => dialFor(tenant), log: () => {} });
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
    buildId: 's103-host',
    log: () => {},
  });
  t.after(guard(close));
  const addr = await listen(0);
  return { origin: `http://127.0.0.1:${addr.port}`, dials, tokenFor: (sub) => auth.issue({ sub }).token };
}

const postRemove = (host, token, body) =>
  fetch(`${host.origin}/api/app-remove`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// ════════════════════════════════════════════════════════════
// S1 —— 软删 ＋ 审计（主人那一份走本机）
// ════════════════════════════════════════════════════════════
test('S1 删掉 ⇒ 清单里没了、**盘上还在** `.removed/`、而且留了一行审计', async (t) => {
  const hostDir = tmp();
  const apps = new Apps({ dir: hostDir, sub: 'owner', now: () => NOW });
  apps.create(APP('dice', '丢骰子'));
  const host = await bootHost(t, { hostDirs: { owner: hostDir }, tenants: {} });

  const r = await postRemove(host, host.tokenFor('owner'), { id: 'dice' });
  assert.equal(r.status, 200, await r.text());

  const after = new Apps({ dir: hostDir, sub: 'owner', now: () => NOW });
  assert.deepEqual(after.list().map((a) => a.id), [], '清单里不许还有它');
  assert.equal(removedUnder(hostDir).length, 1, '🔴 必须是**软删**（挪进 .removed/），不是真删');
  assert.ok(auditHas(hostDir, 'dice'), '🔴 删除要有审计一行');
  // 反例的正身：那个 app 目录**真的**不在原位了（否则这判据是空转）
  assert.equal(nodeFs.existsSync(appDirOf(hostDir, 'dice')), false);
});

// ════════════════════════════════════════════════════════════
// S2 —— 租户：动的是**盒里那份**，宿主那一格一个字节都不动
// ════════════════════════════════════════════════════════════
test('S2 租户删的是**盒里那份**；宿主那格一个字节都不动', async (t) => {
  const hostDir = tmp(); // ★ 宿主那格**空的**（P2-6 之后就是这样）
  const boxDir = tmp();
  const boxApps = new Apps({ dir: boxDir, sub: 'owner', now: () => NOW });
  boxApps.create(APP('aoshu', '奥数练一练'));
  const box = await bootBox(t, { dir: boxDir });
  const host = await bootHost(t, { hostDirs: { u2: hostDir }, boxUds: { 'hupo-b': box.uds } });

  const r = await postRemove(host, host.tokenFor('u2'), { id: 'aoshu' });
  assert.equal(r.status, 200, await r.text());
  assert.deepEqual(new Apps({ dir: boxDir, sub: 'owner', now: () => NOW }).list(), [], '🔴 盒里那个要真没了');
  assert.equal(removedUnder(boxDir).length, 1, '★ 盒里那份也要是软删');
  assert.deepEqual(new Apps({ dir: hostDir, sub: 'u2', now: () => NOW }).list(), [], '宿主那格本来就是空的');
  assert.equal(removedUnder(hostDir).length, 0, '🔴 宿主那格**不许**被碰');
});

// ════════════════════════════════════════════════════════════
// S3 —— 盒子不通 ⇒ 503，而且宿主那格没被动
// ════════════════════════════════════════════════════════════
test('S3 盒子不通 ⇒ **503**，宿主那份**没被动**（绝不顶替）', async (t) => {
  const hostDir = tmp();
  const hostApps = new Apps({ dir: hostDir, sub: 'u2', now: () => NOW });
  hostApps.create(APP('aoshu', '宿主那份的旧副本')); // ★ 故意在宿主放一个**同名**的
  const host = await bootHost(t, { hostDirs: { u2: hostDir }, boxUds: {} }); // 没有盒子

  const r = await postRemove(host, host.tokenFor('u2'), { id: 'aoshu' });
  assert.equal(r.status, 503, await r.text());
  assert.equal(host.dials.get('hupo-b') ?? 0, 0, '连都没连上（隧道不在）');
  const after = new Apps({ dir: hostDir, sub: 'u2', now: () => NOW });
  assert.deepEqual(after.list().map((a) => a.id), ['aoshu'], '🔴 宿主那份**一个字节都不许动**');
  assert.equal(removedUnder(hostDir).length, 0);
});

// ════════════════════════════════════════════════════════════
// S4 —— 没有那个东西 ⇒ 404 ＋ 一句人话，什么都没动
// ════════════════════════════════════════════════════════════
test('S4 不在他这儿 ⇒ **404 ＋ 人话**，盘上什么都没动', async (t) => {
  const boxDir = tmp();
  const boxApps = new Apps({ dir: boxDir, sub: 'owner', now: () => NOW });
  boxApps.create(APP('aoshu', '奥数练一练'));
  const box = await bootBox(t, { dir: boxDir });
  const host = await bootHost(t, { hostDirs: { u2: tmp() }, boxUds: { 'hupo-b': box.uds } });

  const r = await postRemove(host, host.tokenFor('u2'), { id: '根本没有这个' });
  const raw = await r.text();
  assert.equal(r.status, 404, raw);
  const j = JSON.parse(raw);
  assert.ok(typeof j.text === 'string' && j.text !== '', '🔴 要带一句人话（N11）');
  assert.deepEqual(new Apps({ dir: boxDir, sub: 'owner', now: () => NOW }).list().map((a) => a.id), ['aoshu']);
  assert.equal(removedUnder(boxDir).length, 0, '什么都没动');
  // 不合法 id 也当"没这个东西"（404，不是 500）
  const r2 = await postRemove(host, host.tokenFor('u2'), { id: 'NO/../P' });
  assert.equal(r2.status, 404, await r2.text());
});

// ════════════════════════════════════════════════════════════
// S5 —— 内部口只在可信 UDS 上（公网口 404 且不碰库）
// ════════════════════════════════════════════════════════════
test('S5 内部口**只在可信 UDS 上**：公网口 ⇒ 404 且一次都不碰库；可信口 ⇒ 真答得上来', async (t) => {
  const boxDir = tmp();
  const boxApps = new Apps({ dir: boxDir, sub: 'owner', now: () => NOW });
  boxApps.create(APP('aoshu', '奥数练一练'));
  const box = await bootBox(t, { dir: boxDir });

  // 公网口：拿一条**普通**请求打那条内部路径 ⇒ 404（它不是 UDS，不受信）
  const pub = await fetch(`http://127.0.0.1:${box.publicPort}/internal/app-remove`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'aoshu' }),
  });
  assert.equal(pub.status, 404, `公网口必须 404，实际 ${pub.status}`);
  assert.deepEqual(new Apps({ dir: boxDir, sub: 'owner', now: () => NOW }).list().map((a) => a.id), ['aoshu'], '🔴 一次都不许碰库');

  // 正对照：可信 UDS 上那条口真答得上来（否则上面那个 404 什么都证明不了）
  const conn = nodeNet.connect(box.uds);
  const reply = await new Promise((resolve, reject) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('connect', () => {
      const body = JSON.stringify({ id: 'aoshu' });
      conn.write(
        `POST /internal/app-remove HTTP/1.1\r\nhost: box\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      );
    });
    conn.on('data', (c) => {
      buf += c;
    });
    conn.on('end', () => resolve(buf));
    conn.on('error', reject);
  });
  assert.match(reply, /200/, reply.slice(0, 120));
  assert.match(reply, /"ok":true/, reply.slice(-200));
  assert.deepEqual(new Apps({ dir: boxDir, sub: 'owner', now: () => NOW }).list(), [], '可信口上要真删掉');
});
