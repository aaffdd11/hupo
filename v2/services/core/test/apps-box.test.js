// **B15：小程序库以盒子为准**（`docs/dev/77-BLOCKERS.md` 那一行 · 主人 2026-09-25 拍板）。
//
// ── 这一份钉什么（五条，每条都带反例）──────────────────────
//   · **B15-1** 租户的 `GET /api/apps` 列的是**他盒子里**那份（假盒子塞一条独特的 ⇒
//     回执里**有**它、宿主那份的**不在**）；主人（没租户）仍走本机那份。
//   · **B15-2** 制品字节来自盒子（同名制品两边内容不同 ⇒ 宿主回的是**盒子那份**）；
//     **没签名 ⇒ 403，而且盒子**一次都没被碰**（"先验签、再碰盒子"的顺序不许反）。
//   · **B15-3** 内部读接口**只在可信 UDS 上**接；**公网口 ⇒ 404，且库一次都没被碰**。
//   · **B15-4** 迁移：dry-run 不动任何盘 · `--apply` 后**逐字节不变**（读回来核 sha256）·
//     可重跑（第二次全是 `already`、不新开版本）· 搬完**宿主那份仍在**。
//   · **B15-5** 别的租户看不到：u1 的请求只去 u1 的盒子（乙那台**一次都没被碰**）。
//
// ── 这一份为什么必须"打在这一侧"（V13 那条）────────────────
// 纯函数判据（`rootHashOf` / 签名）全绿也照样漏：**"宿主会不会拿自己那份替他答"
// 只有真的发一个请求、看盒子里那条独特的东西出没出现，才看得见**。
//
// ⚠️ 这一份起的是**真的两个服务**：一个"宿主"、一个"盒子"（盒子听可信 UDS），
//    中间那条隧道用**真的** `net.connect`（不是假装一个函数）。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeNet from 'node:net';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test, { after } from 'node:test';

import { Apps, sha256hex } from '../src/apps.js';
import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { createAppServer, verifyEntry } from '../src/app-serve.js';
import { createBoxApps } from '../src/apps-box.js';
import {
  PRUNE_WHAT,
  createAppsMigrateServer,
  describePruneReport,
  migrateAppsToBox,
  migrateCall,
  migrateSocketPath,
  pruneHostApps,
  pruneVerdict,
} from '../src/apps-migrate.js';
import { auditPath } from '../src/audit.js';

const NOW = 1_800_000_000_000;
const KEY = Buffer.from('b'.repeat(64), 'hex');

/** 起过的东西（红了也要能退出 —— 同 `server.test.js` 那段说明）。 */
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

function tmp(tag = 'hupo-b15-') {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), tag));
}

/** 一个"按人取世界"的假壳：只给那几个人的那一格。 */
function makeWorlds(dirs) {
  const map = new Map();
  for (const [sub, dir] of Object.entries(dirs)) {
    map.set(sub, { userId: sub, dir, apps: new Apps({ dir, sub }) });
  }
  return { worldFor: (sub) => map.get(sub) ?? null };
}

const OK = (id, title, body) => ({
  id,
  title,
  icon: 'dice',
  entry: 'index.html',
  files: { 'index.html': body },
});

/**
 * **起一台"盒子"**：一个真的服务，只在一条 `0600` 的 UDS 上接内部口。
 * @param {object} o
 * @param {string} o.dir    盒子自己的数据目录（`<dir>/hupo/apps/…` 就是它的库）
 * @param {(apps:object)=>void} [o.onResolve]  每次"取库"时叫一声（判据拿它数"碰没碰库"）
 */
async function bootBox(t, { dir, onResolve = null }) {
  const uds = nodePath.join(tmp('hupo-b15-box-'), 'local-api.sock');
  const authDir = tmp('hupo-b15-boxauth-');
  const auth = new Auth({ dataDir: authDir });
  auth.setPassword('盒子里的口令（这条 UDS 上根本不用它）');
  const worlds = makeWorlds({ owner: dir });
  const { listen, listenTrusted, close } = createServer({
    auth,
    worlds,
    trustedSub: 'owner',
    appsOf: onResolve
      ? (sub) => {
        onResolve(sub);
        return worlds.worldFor(sub)?.apps ?? null;
      }
      : null,
    apps: { base: 'http://127.0.0.1:9', key: KEY },
    now: () => NOW,
    webRoot: null,
    buildId: 'b15-box',
    log: () => {},
  });
  t.after(guard(close));
  const pub = await listen(0);
  await listenTrusted(uds);
  return { uds, publicPort: pub.port, worlds };
}

/**
 * **起一台"宿主"**：租户经 `dial` 走真隧道去他的盒子；主人走本机那份。
 * @param {object} o
 * @param {Record<string,string>} o.hostDirs   sub → 宿主上那一格
 * @param {Record<string,string>} o.boxUds     租户名 → 那台盒子的可信 UDS
 * @param {Record<string,string>} [o.tenants]  sub → 租户名（默认 `u1→hupo-a`、`u2→hupo-b`）
 * @returns {{origin:string, artifactOrigin:string, dials:Map<string,number>, tokenFor:Function}}
 */
async function bootHost(t, { hostDirs, boxUds, tenants = { u1: 'hupo-a', u2: 'hupo-b' } }) {
  const authDir = tmp('hupo-b15-hostauth-');
  const auth = new Auth({ dataDir: authDir });
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
    buildId: 'b15-host',
    log: () => {},
  });
  t.after(guard(close));
  const addr = await listen(0);

  let artifactOrigin = null;
  {
    const origin = createAppServer({
      resolveApps: (sub) => appsOf(sub),
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
    artifactOrigin = `http://127.0.0.1:${a.port}`;
    t.after(guard(() => new Promise((r) => origin.close(() => r()))));
  }
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    artifactOrigin,
    dials,
    tokenFor: (sub) => auth.issue({ sub }).token,
  };
}

const listApps = (origin, token) =>
  fetch(`${origin}/api/apps`, { headers: { authorization: `Bearer ${token}` } });

// ════════════════════════════════════════════════════════════
// B15-1 —— 租户的清单是**盒子里**那份
// ════════════════════════════════════════════════════════════
test('B15-1 租户的 /api/apps 列的是盒子里那份；宿主那份的**不在**（主人仍走本机）', async (t) => {
  const hostDir = tmp();
  const boxDir = tmp();
  // 宿主那份：**只在这个人这一格里**（本机旧库）
  new Apps({ dir: hostDir, sub: 'u2' }).create(OK('tianqi-probe', '看天气', '<p>宿主的天气</p>'));
  // 盒子里那份：一条**独特**的
  new Apps({ dir: boxDir, sub: 'owner' }).create(OK('city-weather', '看天气（盒子）', '<p>盒子的天气</p>'));

  const box = await bootBox(t, { dir: boxDir });
  const host = await bootHost(t, { hostDirs: { u2: hostDir }, boxUds: { 'hupo-b': box.uds } });

  const j = await (await listApps(host.origin, host.tokenFor('u2'))).json();
  assert.deepEqual(j.apps.map((a) => a.id), ['city-weather'], '★ 清单必须是**盒子里**那份');
  assert.equal(j.apps.some((a) => a.id === 'tianqi-probe'), false, '★ 宿主那份**不许**出现');
  // ★ 入口 URL 仍然由**宿主**签（绑人 + 绑版本 + 用宿主那个公开基址）
  const one = j.apps[0];
  assert.match(one.entryUrl, /^http:\/\/127\.0\.0\.1:9999\/a\/city-weather\/1\/index\.html\?/);
  const u = new URL(one.entryUrl);
  assert.equal(
    verifyEntry({ key: KEY, sig: u.searchParams.get('s'), sub: 'u2', id: 'city-weather', version: 1, exp: u.searchParams.get('e'), now: NOW }),
    true,
    '宿主用自己的签名键现签',
  );
});

test('B15-1 反例：主人（没有租户）仍然读**本机**那份（不是"什么都读盒子"）', async (t) => {
  const ownerDir = tmp();
  new Apps({ dir: ownerDir, sub: 'owner' }).create(OK('mine-here', '本机的', '<p>本机</p>'));
  const box = await bootBox(t, { dir: tmp() });
  const host = await bootHost(t, { hostDirs: { owner: ownerDir }, boxUds: { 'hupo-b': box.uds } });
  const j = await (await listApps(host.origin, host.tokenFor('owner'))).json();
  assert.deepEqual(j.apps.map((a) => a.id), ['mine-here']);
});

test('B15-1 盒子不通 ⇒ **如实 503**（绝不许拿宿主那份旧的顶替）', async (t) => {
  const hostDir = tmp();
  new Apps({ dir: hostDir, sub: 'u2' }).create(OK('tianqi-probe', '宿主的', '<p>旧的</p>'));
  // ⚠️ 故意给一个**不存在**的 UDS：隧道连不上
  const host = await bootHost(t, {
    hostDirs: { u2: hostDir },
    boxUds: { 'hupo-b': nodePath.join(tmp('hupo-b15-nowhere-'), 'nope.sock') },
  });
  const r = await listApps(host.origin, host.tokenFor('u2'));
  assert.equal(r.status, 503, '盒子不通必须**如实说**，不许回宿主那份');
  const body = await r.json();
  assert.equal(body.error, 'tenant-not-ready');
  assert.equal(body.apps, undefined, '正常回执的字段一个都不许出现');
});

// ════════════════════════════════════════════════════════════
// B15-2 —— 制品字节来自盒子；没签名 ⇒ 403 且盒子没被碰
// ════════════════════════════════════════════════════════════
test('B15-2 同名制品两边内容不同 ⇒ 宿主回的是**盒子那份**字节', async (t) => {
  const hostDir = tmp();
  const boxDir = tmp();
  new Apps({ dir: hostDir, sub: 'u2' }).create(OK('dinner', '晚饭', '<p>宿主那份的晚饭</p>'));
  new Apps({ dir: boxDir, sub: 'owner' }).create(OK('dinner', '晚饭', '<p>盒子那份的晚饭</p>'));

  const box = await bootBox(t, { dir: boxDir });
  const host = await bootHost(t, { hostDirs: { u2: hostDir }, boxUds: { 'hupo-b': box.uds } });
  const token = host.tokenFor('u2');
  const j = await (await listApps(host.origin, token)).json();
  const u = new URL(j.apps[0].entryUrl);
  const r = await fetch(`${host.artifactOrigin}${u.pathname}${u.search}`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '<p>盒子那份的晚饭</p>', '★ 字节必须是盒子里那份');
  assert.match(String(r.headers.get('content-security-policy')), /frame-ancestors 'self'/);
});

test('🔴 B15-2 反例：没签名 / 签名是别人的 ⇒ 403，而且盒子**一次都没被碰**', async (t) => {
  const hostDir = tmp();
  const boxDir = tmp();
  new Apps({ dir: hostDir, sub: 'u2' }).create(OK('dinner', '晚饭', '<p>宿主</p>'));
  new Apps({ dir: boxDir, sub: 'owner' }).create(OK('dinner', '晚饭', '<p>盒子</p>'));

  const box = await bootBox(t, { dir: boxDir });
  const host = await bootHost(t, { hostDirs: { u2: hostDir }, boxUds: { 'hupo-b': box.uds } });
  const token = host.tokenFor('u2');
  const j = await (await listApps(host.origin, token)).json();
  const good = new URL(j.apps[0].entryUrl);
  const before = host.dials.get('hupo-b');

  // ① 一个签名都不带
  const r1 = await fetch(`${host.artifactOrigin}${good.pathname}`);
  assert.equal(r1.status, 403);
  // ② 签名是**别人**的（同一串字节换个 u）
  const q = new URLSearchParams(good.search);
  q.set('u', 'u1');
  const r2 = await fetch(`${host.artifactOrigin}${good.pathname}?${q}`);
  assert.equal(r2.status, 403, '签名绑人 —— 换成别人必须过不了');
  // ③ 过期
  const q2 = new URLSearchParams(good.search);
  q2.set('e', String(NOW - 1));
  const r3 = await fetch(`${host.artifactOrigin}${good.pathname}?${q2}`);
  assert.equal(r3.status, 403);

  assert.equal(
    host.dials.get('hupo-b'),
    before,
    '★ **先验签、再碰盒子**：这三条没签名的请求一次都不许去碰盒子',
  );
});

// ════════════════════════════════════════════════════════════
// B15-3 —— 内部口只在可信口上接
// ════════════════════════════════════════════════════════════
test('🔴 B15-3 内部口只在可信 UDS 上接；**公网口 ⇒ 404 且库一次都没被碰**', async (t) => {
  const boxDir = tmp();
  new Apps({ dir: boxDir, sub: 'owner' }).create(OK('city-weather', '看天气', '<p>盒子的</p>'));
  let touched = 0;
  const box = await bootBox(t, { dir: boxDir, onResolve: () => { touched += 1; } });
  const pub = `http://127.0.0.1:${box.publicPort}`;

  // ① 公网口：三条内部路径一律 404（不是 200、不是 500）
  for (const p of ['/internal/apps', '/internal/artifact?id=city-weather&version=1&rel=index.html', '/internal/app']) {
    const r = await fetch(`${pub}${p}`);
    assert.equal(r.status, 404, `公网口上的 ${p} 必须是 404`);
  }
  assert.equal(touched, 0, '★ 公网口那三条**一次都不许碰库/中继**');

  // ② 反例的另一半：**可信口上它是通的**（不然上面那三条 404 可能只是"路由根本没写"）
  const trust = await internalGet(box.uds, '/internal/apps');
  assert.equal(trust.status, 200);
  const j = JSON.parse(trust.body.toString('utf8'));
  assert.deepEqual(j.apps.map((a) => a.id), ['city-weather']);
  assert.ok(touched > 0, '可信口上必须真的走了一次库（证明这条路是活的）');
});

/** 直接问可信 UDS 一条 GET（判据用；宿主那条客户端走的是同一套字节）。 */
function internalGet(uds, path, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const sock = nodeNet.connect(uds);
    let buf = Buffer.alloc(0);
    sock.on('connect', () => {
      sock.write(
        `${method} ${path} HTTP/1.1\r\nHost: box\r\nConnection: close\r\n` +
          (body ? `content-type: application/json\r\ncontent-length: ${body.length}\r\n` : '') +
          '\r\n',
      );
      if (body) sock.write(body);
    });
    sock.on('data', (c) => { buf = Buffer.concat([buf, c]); });
    sock.on('end', () => {
      const i = buf.indexOf('\r\n\r\n');
      const head = buf.slice(0, i).toString('utf8');
      const status = Number.parseInt(head.split(' ')[1], 10);
      resolve({ status, body: buf.slice(i + 4) });
    });
    sock.on('error', reject);
  });
}

// ════════════════════════════════════════════════════════════
// B15-4 —— 存量迁移
// ════════════════════════════════════════════════════════════
/** 把一棵制品库目录树里每个文件的 sha256 记下来（"一个字节都没动"的证据）。 */
function fingerprint(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const e of nodeFs.readdirSync(dir, { withFileTypes: true })) {
      const p = nodePath.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(nodePath.relative(root, p), sha256hex(nodeFs.readFileSync(p)));
    }
  };
  walk(root);
  return out;
}

test('🔴 B15-4 迁移：dry-run 不动盘 · --apply 逐字节不变 · 可重跑 · 宿主那份仍在', async (t) => {
  const hostDir = tmp();
  const boxDir = tmp();
  const host = new Apps({ dir: hostDir, sub: 'u2' });
  host.create(OK('tianqi-probe', '看天气', '<p>宿主的天气 v1</p>'));
  host.create(OK('wenda', '问答小抄', '<p>宿主的问答</p>'));

  const box = await bootBox(t, { dir: boxDir });
  const boxClient = () => createBoxApps({ sub: 'u2', dial: () => nodeNet.connect(box.uds) });
  const boxApps = new Apps({ dir: boxDir, sub: 'owner' });

  const hostRoot = nodePath.join(hostDir, 'hupo', 'apps');
  const before = fingerprint(hostRoot);

  // ── ① dry-run：一个字节都不发
  const plan = await migrateAppsToBox({ userId: 'u2', hostApps: host, box: boxClient(), apply: false });
  assert.deepEqual(plan.planned.map((a) => a.id).sort(), ['tianqi-probe', 'wenda']);
  assert.equal(plan.pushed.length, 0);
  assert.deepEqual(boxApps.list(), [], 'dry-run 之后盒子里必须还是空的');
  assert.equal(boxApps.manifest('tianqi-probe', 1), null);

  // ── ② --apply：真搬
  const done = await migrateAppsToBox({ userId: 'u2', hostApps: host, box: boxClient(), apply: true });
  assert.deepEqual(done.pushed.map((a) => a.id).sort(), ['tianqi-probe', 'wenda']);
  assert.equal(done.pushed.every((a) => a.verified === true), true, '每一版都要"读回来核过"');
  assert.deepEqual(boxApps.list().map((a) => a.id).sort(), ['tianqi-probe', 'wenda']);

  // ── ③ **逐字节不变**：拿回盒子里的字节，与宿主那份逐个 sha256 比
  for (const id of ['tianqi-probe', 'wenda']) {
    const hm = host.manifest(id, host.current(id));
    for (const f of hm.files) {
      const fromHost = host.read(id, hm.version, f.path).content;
      const fromBox = boxApps.read(id, hm.version, f.path).content;
      assert.equal(sha256hex(fromBox), sha256hex(fromHost), `${id}/${f.path} 的字节必须一模一样`);
    }
    assert.equal(boxApps.manifest(id, 1).rootHash, hm.rootHash, '两边算出来的 hash 要对得上');
  }
  // ── ④ 宿主那份**仍在**（不删、不挪、一个字节没动）
  assert.equal(nodeFs.existsSync(hostRoot), true, '★ 宿主那份不许被删');
  const after = fingerprint(hostRoot);
  assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort(), '宿主那份一个字节都不许动');
  assert.equal(done.leftOnHost, true);

  // ── ⑤ 可重跑：第二次全是 already，**不新开版本**
  const again = await migrateAppsToBox({ userId: 'u2', hostApps: host, box: boxClient(), apply: true });
  assert.equal(again.pushed.length, 0, '重跑不许再推一次');
  assert.deepEqual(again.already.map((a) => a.id).sort(), ['tianqi-probe', 'wenda']);
  for (const id of ['tianqi-probe', 'wenda']) {
    assert.equal(boxApps.manifest(id, 2), null, '★ 重跑不许开新版本（版本不可变）');
    assert.equal(nodeFs.readdirSync(boxApps.versionsDir(id)).length, 1);
  }
});

test('B15-4 反例：盒子里已有一个**不一样**的同名 ⇒ 报冲突、**不动它**', async (t) => {
  const hostDir = tmp();
  const boxDir = tmp();
  new Apps({ dir: hostDir, sub: 'u2' }).create(OK('wenda', '问答小抄', '<p>宿主版</p>'));
  new Apps({ dir: boxDir, sub: 'owner' }).create(OK('wenda', '问答小抄（盒子自己的）', '<p>盒子版</p>'));

  const box = await bootBox(t, { dir: boxDir });
  const rep = await migrateAppsToBox({
    userId: 'u2',
    hostApps: new Apps({ dir: hostDir, sub: 'u2' }),
    box: createBoxApps({ sub: 'u2', dial: () => nodeNet.connect(box.uds) }),
    apply: true,
  });
  assert.equal(rep.pushed.length, 0);
  assert.equal(rep.conflicts.length, 1);
  const boxApps = new Apps({ dir: boxDir, sub: 'owner' });
  assert.equal(boxApps.manifest('wenda', 2), null, '冲突时一个字节都不许写');
  assert.equal(boxApps.read('wenda', 1, 'index.html').content.toString('utf8'), '<p>盒子版</p>');
});

test('B15-4 迁移走的是服务那条维护口（`apps-migrate.sock`）—— CLI 用的就是它', async (t) => {
  const hostDir = tmp();
  const boxDir = tmp();
  new Apps({ dir: hostDir, sub: 'u2' }).create(OK('wenda', '问答小抄', '<p>宿主的问答</p>'));
  const box = await bootBox(t, { dir: boxDir });
  const hosts = makeWorlds({ u2: hostDir });

  const dataDir = tmp('hupo-b15-mig-');
  const server = createAppsMigrateServer({
    socketPath: migrateSocketPath(dataDir),
    hostAppsFor: (user) => hosts.worldFor(user)?.apps ?? null,
    tenantOf: (user) => (user === 'u2' ? 'hupo-b' : null),
    dialFor: () => nodeNet.connect(box.uds),
    log: () => {},
  });
  server.listen();
  await server.ready();
  t.after(guard(() => server.close()));
  assert.equal(nodeFs.statSync(migrateSocketPath(dataDir)).mode & 0o777, 0o600, '维护口必须是 0600');

  // ① 先 plan（不动）
  const plan = await migrateCall({ socketPath: migrateSocketPath(dataDir), msg: { op: 'plan', user: 'u2' } });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.report.planned.map((a) => a.id), ['wenda']);
  assert.deepEqual(new Apps({ dir: boxDir, sub: 'owner' }).list(), []);

  // ② 再 push
  const push = await migrateCall({ socketPath: migrateSocketPath(dataDir), msg: { op: 'push', user: 'u2' } });
  assert.deepEqual(push.report.pushed.map((a) => a.id), ['wenda']);

  // ③ 没有盒子的人 ⇒ 明说"不用搬"（不是静默成功）
  const none = await migrateCall({ socketPath: migrateSocketPath(dataDir), msg: { op: 'push', user: 'u9' } });
  assert.equal(none.ok, false);
  assert.equal(none.error, 'no-tenant');
});

// ════════════════════════════════════════════════════════════
// B15-5 —— 别的租户看不到
// ════════════════════════════════════════════════════════════
test('🔴 B15-5 别的租户看不到：u1 去 u1 的盒子，乙那台**一次都没被碰**', async (t) => {
  const u1Host = tmp();
  const u2Host = tmp();
  const u1Box = tmp();
  const u2Box = tmp();
  new Apps({ dir: u1Host, sub: 'u1' }).create(OK('host-one', '宿主甲的', '<p>宿主甲</p>'));
  new Apps({ dir: u2Host, sub: 'u2' }).create(OK('host-two', '宿主乙的', '<p>宿主乙</p>'));
  new Apps({ dir: u1Box, sub: 'owner' }).create(OK('box-one', '盒子甲的', '<p>盒子甲</p>'));
  new Apps({ dir: u2Box, sub: 'owner' }).create(OK('box-two', '盒子乙的', '<p>盒子乙</p>'));

  const boxA = await bootBox(t, { dir: u1Box });
  const boxB = await bootBox(t, { dir: u2Box });
  const host = await bootHost(t, {
    hostDirs: { u1: u1Host, u2: u2Host },
    boxUds: { 'hupo-a': boxA.uds, 'hupo-b': boxB.uds },
  });

  const j1 = await (await listApps(host.origin, host.tokenFor('u1'))).json();
  assert.deepEqual(j1.apps.map((a) => a.id), ['box-one'], '★ 甲只看得到自己盒子里那份');
  assert.equal(j1.apps.some((a) => a.id === 'box-two'), false, '甲的清单里不许有乙的');
  assert.equal(j1.apps.some((a) => a.id.startsWith('host-')), false, '也不许有宿主那份旧的');
  assert.equal(host.dials.get('hupo-b') ?? 0, 0, '★ 甲那一趟**一次都不许**去碰乙的盒子');
  assert.equal(host.dials.get('hupo-a'), 1);

  const j2 = await (await listApps(host.origin, host.tokenFor('u2'))).json();
  assert.deepEqual(j2.apps.map((a) => a.id), ['box-two']);
  assert.equal(host.dials.get('hupo-b'), 1, '乙那一趟只去乙那台');
});

test('B15-2/B15-5 制品字节也不会串：甲拿到的签名换到乙的盒子口也取不到别人的', async (t) => {
  const u1Box = tmp();
  const u2Box = tmp();
  new Apps({ dir: u1Box, sub: 'owner' }).create(OK('box-one', '盒子甲的', '<p>甲的内容</p>'));
  new Apps({ dir: u2Box, sub: 'owner' }).create(OK('box-one', '盒子乙的同名', '<p>乙的内容</p>'));

  const boxA = await bootBox(t, { dir: u1Box });
  const boxB = await bootBox(t, { dir: u2Box });
  const host = await bootHost(t, {
    hostDirs: { u1: tmp(), u2: tmp() },
    boxUds: { 'hupo-a': boxA.uds, 'hupo-b': boxB.uds },
  });

  const j1 = await (await listApps(host.origin, host.tokenFor('u1'))).json();
  const u = new URL(j1.apps[0].entryUrl);
  const r = await fetch(`${host.artifactOrigin}${u.pathname}${u.search}`);
  assert.equal(await r.text(), '<p>甲的内容</p>', '★ 甲只取得到甲盒子里那份');

  // 反例：同一串签名换个 u ⇒ 过不了（绑人）
  const q = new URLSearchParams(u.search);
  q.set('u', 'u2');
  assert.equal((await fetch(`${host.artifactOrigin}${u.pathname}?${q}`)).status, 403);
});

// ════════════════════════════════════════════════════════════
// P2-6 —— 删宿主那份旧库（主人 2026-09-25「乙：把宿主那份删掉」）
// ════════════════════════════════════════════════════════════
test('🔴 P2-6：核对全过才删 · dry-run 不动盘也不写审计 · 可重跑 · 删完留一行审计', async (t) => {
  const hostDir = tmp();
  const boxDir = tmp();
  const host = new Apps({ dir: hostDir, sub: 'u2' });
  host.create(OK('tianqi-probe', '看天气', '<p>宿主的天气</p>'));
  host.create(OK('wenda', '问答小抄', '<p>宿主的问答</p>'));
  const box = await bootBox(t, { dir: boxDir });
  const boxClient = () => createBoxApps({ sub: 'u2', dial: () => nodeNet.connect(box.uds) });
  // 先把旧的搬进盒子（这一步用现成的迁移 —— 核对的前提就是"盒里已经有一份一样的"）
  await migrateAppsToBox({ userId: 'u2', hostApps: host, box: boxClient(), apply: true });
  // "问盒里那份"这条路 = 现成的 `plan` 作业（逐条拿宿主字节重算 hash、与盒里比）
  const planFn = () => migrateAppsToBox({ userId: 'u2', hostApps: host, box: boxClient(), apply: false });

  const hostRoot = nodePath.join(hostDir, 'hupo', 'apps');
  const boxRoot = nodePath.join(boxDir, 'hupo', 'apps');
  const before = fingerprint(hostRoot);
  const boxBefore = fingerprint(boxRoot);
  const auditFile = auditPath(hostDir);

  // ── ① dry-run：一个字节都不动，**而且不写审计**（"只看"就要真的什么都没发生）
  const plan = await pruneHostApps({ userId: 'u2', hostApps: host, plan: planFn, apply: false, auditFile });
  assert.deepEqual(plan.verified.map((a) => a.id).sort(), ['tianqi-probe', 'wenda']);
  assert.equal(plan.deleted, false);
  assert.equal(nodeFs.existsSync(auditFile), false, '★ dry-run 不许写审计');
  assert.deepEqual([...fingerprint(hostRoot).entries()].sort(), [...before.entries()].sort(), 'dry-run 一个字节都不许动');

  // ── ② --apply：核对全过 ⇒ 删掉租户那一格
  const done = await pruneHostApps({
    userId: 'u2', hostApps: host, plan: planFn, apply: true, tenant: 'hupo-b', auditFile, now: () => NOW,
  });
  assert.equal(done.deleted, true);
  assert.equal(done.blocked, null);
  assert.equal(nodeFs.existsSync(hostRoot), false, '★ 租户那一格删掉了');
  // 🔴 盒子里那份**仍在**（它是权威；桌面照旧走盒子）
  assert.deepEqual([...fingerprint(boxRoot).entries()].sort(), [...boxBefore.entries()].sort(), '盒子那份一个字节都不许动');
  assert.equal(new Apps({ dir: boxDir, sub: 'owner' }).list().length, 2);
  // 审计一行（事件名 + 谁 + 哪台）
  const audit = nodeFs.readFileSync(auditFile, 'utf8');
  assert.ok(audit.includes(PRUNE_WHAT.done), `审计里要有那一行：${audit}`);
  assert.ok(audit.includes('u2'));
  assert.ok(audit.includes('hupo-b'));
  assert.equal(done.auditLine.includes(PRUNE_WHAT.done), true);

  // ── ③ 可重跑：已经空了 ⇒ 报"没有要删的"，什么都不做（**连问都不问**）
  const again = await pruneHostApps({
    userId: 'u2', hostApps: host, plan: () => { throw new Error('已经空了就不该再问盒子'); }, apply: true, auditFile,
  });
  assert.equal(again.alreadyClean, true);
  assert.equal(again.deleted, false);
  assert.equal(describePruneReport(again).includes('没有要删的'), true);
});

test('🔴 P2-6 反例：盒子里对不上 ⇒ **一个字节都不删**（盒里没有 / hash 不同）', async (t) => {
  // ① 盒里那个同名但**不一样**（hash 不同）
  const hostDir = tmp();
  const boxDir = tmp();
  new Apps({ dir: hostDir, sub: 'u2' }).create(OK('wenda', '问答小抄', '<p>宿主版</p>'));
  new Apps({ dir: boxDir, sub: 'owner' }).create(OK('wenda', '问答小抄（盒子自己的）', '<p>盒子版</p>'));
  const host = new Apps({ dir: hostDir, sub: 'u2' });
  const box = await bootBox(t, { dir: boxDir });
  const boxClient = () => createBoxApps({ sub: 'u2', dial: () => nodeNet.connect(box.uds) });
  const hostRoot = nodePath.join(hostDir, 'hupo', 'apps');
  const before = fingerprint(hostRoot);
  const auditFile = auditPath(hostDir);
  const rep = await pruneHostApps({
    userId: 'u2', hostApps: host, plan: () => migrateAppsToBox({ userId: 'u2', hostApps: host, box: boxClient(), apply: false }),
    apply: true, auditFile,
  });
  assert.equal(rep.deleted, false, '★ 对不上就不许删');
  assert.equal(rep.unverified.length, 1);
  assert.ok(rep.blocked);
  assert.deepEqual([...fingerprint(hostRoot).entries()].sort(), [...before.entries()].sort(), '★ 整格都不许动');
  assert.ok(nodeFs.readFileSync(auditFile, 'utf8').includes(PRUNE_WHAT.refused), '拒了也要记一行（"想删、没删、为什么"）');

  // ② 盒子里**根本没有**那一个 ⇒ 也不许删
  const hostDir2 = tmp();
  const boxDir2 = tmp();
  const host2 = new Apps({ dir: hostDir2, sub: 'u2' });
  host2.create(OK('only-host', '只有宿主有', '<p>x</p>'));
  const box2 = await bootBox(t, { dir: boxDir2 });
  const rep2 = await pruneHostApps({
    userId: 'u2',
    hostApps: host2,
    plan: () => migrateAppsToBox({
      userId: 'u2', hostApps: host2, box: createBoxApps({ sub: 'u2', dial: () => nodeNet.connect(box2.uds) }), apply: false,
    }),
    apply: true,
  });
  assert.equal(rep2.deleted, false);
  assert.match(rep2.unverified[0].why, /盒子里没有/);
  assert.equal(nodeFs.existsSync(nodePath.join(hostDir2, 'hupo', 'apps')), true);
});

test('🔴 P2-6 反例：核对拿不到（服务不在 / 隧道不通）⇒ **不许删**（而且不碰盘）', async () => {
  const hostDir = tmp();
  new Apps({ dir: hostDir, sub: 'u2' }).create(OK('wenda', '问答小抄', '<p>宿主版</p>'));
  const hostRoot = nodePath.join(hostDir, 'hupo', 'apps');
  const before = fingerprint(hostRoot);
  await assert.rejects(
    () => pruneHostApps({
      userId: 'u2',
      hostApps: new Apps({ dir: hostDir, sub: 'u2' }),
      plan: async () => { throw new Error('隧道没通'); },
      apply: true,
    }),
    /隧道没通/,
  );
  assert.deepEqual([...fingerprint(hostRoot).entries()].sort(), [...before.entries()].sort());
  // 没接 plan ⇒ 也不许删（宁可不删）
  const rep = await pruneHostApps({ userId: 'u2', hostApps: new Apps({ dir: hostDir, sub: 'u2' }), apply: true });
  assert.equal(rep.deleted, false);
  assert.ok(rep.blocked);
});

test('🔴 P2-6 反例：主人自己那份（`data/hupo/apps`）**一个字节都不许动**', async () => {
  const dataDir = tmp();
  const owner = new Apps({ dir: dataDir, sub: 'owner' });
  owner.create(OK('coin', '我的硬币', '<p>主人的东西</p>'));
  const ownerRoot = nodePath.join(dataDir, 'hupo', 'apps');
  const before = fingerprint(ownerRoot);
  // 认出来就停：**连"问盒里那份"都不问**（plan 一被叫就抛）
  const rep = await pruneHostApps({
    userId: 'owner',
    hostApps: owner,
    plan: async () => { throw new Error('主人那份根本不该被问'); },
    apply: true,
    protect: [ownerRoot],
  });
  assert.equal(rep.deleted, false);
  assert.match(rep.blocked, /主人/);
  assert.deepEqual([...fingerprint(ownerRoot).entries()].sort(), [...before.entries()].sort(), '★ 主人那份一个字节都不许动');
});

test('🔴 P2-6 裁决（纯函数）：少一个 / 报冲突 / 报要搬 ⇒ 都不放行', () => {
  const all = pruneVerdict({
    hostIds: ['a', 'b'],
    migrateReport: { already: [{ id: 'a', version: 1, boxVersion: 1, rootHash: 'h' }, { id: 'b', version: 1, boxVersion: 1, rootHash: 'h' }] },
  });
  assert.equal(all.ok, true);
  const missing = pruneVerdict({ hostIds: ['a', 'b'], migrateReport: { already: [{ id: 'a' }], planned: [{ id: 'b' }] } });
  assert.equal(missing.ok, false);
  assert.match(missing.unverified[0].why, /盒子里没有/);
  const conflict = pruneVerdict({ hostIds: ['a'], migrateReport: { already: [], conflicts: [{ id: 'a', why: 'hash 不一样' }] } });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.unverified[0].why, 'hash 不一样');
  // 宿主那份是空的 ⇒ 不放行（那由 `alreadyClean` 那一支处置，不该走到这儿）
  assert.equal(pruneVerdict({ hostIds: [], migrateReport: { already: [] } }).ok, false);
  assert.equal(pruneVerdict({}).ok, false);
});


