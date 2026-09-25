// **B17：`/api/app-ask` 的宿主预闸要读「盒里那份」**（`docs/dev/77-BLOCKERS.md` 的 B17 那一行）。
//
// ── 它修的是什么（一句话）──────────────────────────────────
// B15 把**权威**改成了"盒子里那份"（`/api/apps` 与制品字节都那样了），
// 但 `/api/app-ask` 那道"问了先查有没有这个小程序"的**预闸**还在读宿主
// `data/users/<id>/hupo/apps/`。而 P2-6 之后**宿主那几格已经删掉了** ⇒
// **只在盒里**（迁移后新造）的 app 会被判"没有这个小程序"（**页面在说假话**）。
//
// ── 这一份钉什么（每条都带反例）────────────────────────────
//   · **B17-1** 盒里有、宿主没有 ⇒ **预闸放行**，而且配额记在**盒里**那份上。
//     反例①：**宿主有、盒里没有** ⇒ 按盒里算（404），而且盒子**真被问过**
//            （宿主那份**一次都没被拿来当答案**）。
//     反例②：**盒子不通** ⇒ **如实 503**，而且宿主那份**没被花**（不许顶替）。
//   · **B17-2** 四道闸（在他这儿 / 声明了 / 授予了 / 配额还有）仍在**权威那份**上
//     生效 —— 盒里没声明 / 没授予 ⇒ 403，**一个字节都不转发**。
//   · **B17-3** 那条内部口**只在可信 UDS 上**：公网口 ⇒ 404 且**一次都不碰库**；
//     可信口上 ⇒ 真答得上来（正对照）。
//   · **B17-4** 盒子答的话**认不出** ⇒ 503（fail-closed，**绝不许**当成"过了"）。
//
// ── 为什么必须"打在这一侧"（V13 那条）──────────────────────
// 只断言 `gateAsk()` 这个函数是对的、或者只断言 `checkAppAsk()` 是对的，全绿也照样漏：
// **"宿主到底读了哪一份库"**只有真的起一个宿主 + 一个盒子、发一个请求、看那条
// 独特的 app 出没出现，才看得见。
//
// ⚠️ 起的是**真的两个服务**（照 `apps-box.test.js`）：中间那条隧道用**真的**
//    `net.connect`（不是假装一个函数）。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeHttp from 'node:http';
import nodeNet from 'node:net';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test, { after } from 'node:test';

import { Apps } from '../src/apps.js';
import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { createBoxApps } from '../src/apps-box.js';

const NOW = 1_800_000_000_000;
const KEY = Buffer.from('b'.repeat(64), 'hex');

/** 起过的东西（红了也要能退出）。 */
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

function tmp(tag = 'hupo-b17-') {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), tag));
}

/** 一个"按人取世界"的假壳：只给那几个人的那一格。 */
function makeWorlds(dirs) {
  const map = new Map();
  for (const [sub, dir] of Object.entries(dirs)) {
    map.set(sub, { userId: sub, dir, apps: new Apps({ dir, sub, now: () => NOW }) });
  }
  return { worldFor: (sub) => map.get(sub) ?? null };
}

/** 一个 app 的制品形状（照 `apps-box.test.js`）。 */
const OK = (id, title) => ({
  id,
  title,
  icon: 'dice',
  entry: 'index.html',
  files: { 'index.html': '<p>x</p>' },
});

/** 一个**假的本机代理**：记下每一次请求，回一句固定的回答（照 `app-ask.test.js`）。 */
async function fakeProxy({ text = '代理给的回答' } = {}) {
  const seen = [];
  const srv = nodeHttp.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${srv.address().port}`,
    seen,
    close: () => new Promise((r) => srv.close(r)),
  };
}

/** **起一台"盒子"**：真服务，只在一条 UDS 上接内部口（照 `apps-box.test.js`）。 */
async function bootBox(t, { dir, onResolve = null }) {
  const uds = nodePath.join(tmp('hupo-b17-box-'), 'local-api.sock');
  const auth = new Auth({ dataDir: tmp('hupo-b17-boxauth-'), now: () => NOW });
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
    buildId: 'b17-box',
    log: () => {},
  });
  t.after(guard(close));
  const pub = await listen(0);
  await listenTrusted(uds);
  return { uds, publicPort: pub.port };
}

/** **起一台"宿主"**：租户经真隧道去他的盒子；主人走本机那份。 */
async function bootHost(t, { hostDirs, boxUds, tenants = { u2: 'hupo-b' } }) {
  const auth = new Auth({ dataDir: tmp('hupo-b17-hostauth-'), now: () => NOW });
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
    buildId: 'b17-host',
    log: () => {},
  });
  t.after(guard(close));
  const addr = await listen(0);
  return { origin: `http://127.0.0.1:${addr.port}`, dials, tokenFor: (sub) => auth.issue({ sub }).token };
}

const postAsk = (host, token, body) =>
  fetch(`${host.origin}/api/app-ask`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const askFileOf = (dir, sub, id) => nodePath.join(dir, 'hupo', 'apps', id, 'ask.json');
const exists = (p) => {
  try {
    nodeFs.statSync(p);
    return true;
  } catch {
    return false;
  }
};

// ════════════════════════════════════════════════════════════
// B17-1 —— 闸读的是**盒里那份**
// ════════════════════════════════════════════════════════════
test('B17-1 盒里有、宿主**没有** ⇒ 预闸放行；配额记在盒里那份上（宿主那格一个字节都不动）', async (t) => {
  const proxy = await fakeProxy({ text: '盒里那份给的回答' });
  t.after(() => proxy.close());
  process.env.HUPO_APP_ASK_BASE = proxy.base;

  const hostDir = tmp(); // ★ 宿主那格**空的**（P2-6 之后就是这样）
  const boxDir = tmp();
  const boxApps = new Apps({ dir: boxDir, sub: 'owner', now: () => NOW });
  boxApps.create({ ...OK('city-weather', '看天气'), permissions: ['ask'] });
  boxApps.setGrants('city-weather', ['ask']);

  const box = await bootBox(t, { dir: boxDir });
  const host = await bootHost(t, { hostDirs: { u2: hostDir }, boxUds: { 'hupo-b': box.uds } });

  const r = await postAsk(host, host.tokenFor('u2'), { appId: 'city-weather', prompt: '给我出一道题' });
  assert.equal(r.status, 200, '★ 盒里有就该放行（改前这里会被宿主那份判成"没有这个小程序"）');
  assert.equal((await r.json()).text, '盒里那份给的回答');
  assert.equal(proxy.seen.length, 1, '★ 花只发生一次');
  assert.match(proxy.seen[0].body, /给我出一道题/);

  // ★ 先记再花，而且**只记一次**（宿主那次内部预闸 bump 了，转发进去之后不许再 bump）
  const boxAsk = JSON.parse(nodeFs.readFileSync(askFileOf(boxDir, 'owner', 'city-weather'), 'utf8'));
  assert.equal(boxAsk.n, 1, '★ 配额记在盒里那份上，而且只记一次');
  // ★ 反例的正身：宿主那格**一个字节都不许有**
  assert.equal(exists(askFileOf(hostDir, 'u2', 'city-weather')), false, '★ 宿主那份不许被花');
});

test('B17-1 反例：宿主有、盒里**没有** ⇒ 按盒里算（404），而且盒子**真被问过**', async (t) => {
  const hostDir = tmp();
  const hostApps = new Apps({ dir: hostDir, sub: 'u2', now: () => NOW });
  hostApps.create({ ...OK('only-on-host', '宿主上的'), permissions: ['ask'] });
  hostApps.setGrants('only-on-host', ['ask']);
  const boxDir = tmp(); // ★ 盒里没有它

  const box = await bootBox(t, { dir: boxDir });
  const host = await bootHost(t, { hostDirs: { u2: hostDir }, boxUds: { 'hupo-b': box.uds } });

  const r = await postAsk(host, host.tokenFor('u2'), { appId: 'only-on-host', prompt: '你好' });
  assert.equal(r.status, 404, '★ 权威是盒里那份 ⇒ 盒里没有就是没有');
  assert.match((await r.json()).error, /没有这个小程序/);
  // ★ 反例的正身：**盒子真被问过**（宿主不是拿自己那份答的）
  assert.ok((host.dials.get('hupo-b') ?? 0) >= 1, '★ 预闸必须去问盒子（改前宿主自己答，一次隧道都不开）');
  // ★ 宿主那份**没被花**（它只是被读到了，不该有任何动作）
  assert.equal(exists(askFileOf(hostDir, 'u2', 'only-on-host')), false, '★ 宿主那份不许被 bump');
});

test('B17-1 反例：盒子不通 ⇒ **如实 503**（绝不许拿宿主那份顶替）', async (t) => {
  const hostDir = tmp();
  const hostApps = new Apps({ dir: hostDir, sub: 'u2', now: () => NOW });
  hostApps.create({ ...OK('city-weather', '看天气'), permissions: ['ask'] });
  hostApps.setGrants('city-weather', ['ask']);

  // ⚠️ 故意给一个**不存在**的 UDS：隧道连不上
  const host = await bootHost(t, {
    hostDirs: { u2: hostDir },
    boxUds: { 'hupo-b': nodePath.join(tmp('hupo-b17-nowhere-'), 'nope.sock') },
  });

  const r = await postAsk(host, host.tokenFor('u2'), { appId: 'city-weather', prompt: '你好' });
  assert.equal(r.status, 503, '★ 盒子不通必须**如实说**，不许回宿主那份');
  const j = await r.json();
  assert.equal(j.error, 'tenant-not-ready');
  // ⚠️ 拒绝要给人话（N11）：503 带一句人话，但**正常回执的字段一个都不许出现**
  assert.equal(typeof j.text, 'string');
  assert.ok(j.text.length > 0);
  assert.equal(j.left, undefined);
  assert.equal(j.apps, undefined, '正常回执的字段一个都不许出现');
  // ★ 宿主那份**一次都没被花**（顶替 = 拿他的钥匙去花，那是最坏的一种）
  assert.equal(exists(askFileOf(hostDir, 'u2', 'city-weather')), false, '★ 不许拿宿主那份顶替');
});

// ════════════════════════════════════════════════════════════
// B17-2 —— 四道闸仍在权威那份上生效
// ════════════════════════════════════════════════════════════
test('B17-2 盒里没声明 / 没授予 ⇒ 403，而且**一个字节都不转发**（授予之后才通）', async (t) => {
  const proxy = await fakeProxy();
  t.after(() => proxy.close());
  process.env.HUPO_APP_ASK_BASE = proxy.base;

  const hostDir = tmp(); // ★ 宿主那格是空的 ⇒ 这些判断只可能来自盒里那份
  const boxDir = tmp();
  const boxApps = new Apps({ dir: boxDir, sub: 'owner', now: () => NOW });
  boxApps.create(OK('quiet', '不说话的')); // 没声明 ask
  boxApps.create({ ...OK('wenda', '问答小抄'), permissions: ['ask'] }); // 声明了、还没授予

  const box = await bootBox(t, { dir: boxDir });
  const host = await bootHost(t, { hostDirs: { u2: hostDir }, boxUds: { 'hupo-b': box.uds } });
  const token = host.tokenFor('u2');

  const a = await postAsk(host, token, { appId: 'quiet', prompt: '你好' });
  assert.equal(a.status, 403);
  assert.match((await a.json()).error, /没说要问话/);

  const b = await postAsk(host, token, { appId: 'wenda', prompt: '你好' });
  assert.equal(b.status, 403);
  assert.match((await b.json()).error, /还没允许/);

  assert.equal(proxy.seen.length, 0, '★ 闸没过就**不许**碰到代理');

  // ★ 正对照：在**盒里**授予 ⇒ 立刻通（说明上面那两条不是"恒拒"）
  boxApps.setGrants('wenda', ['ask']);
  const ok = await postAsk(host, token, { appId: 'wenda', prompt: '给我出一道题' });
  assert.equal(ok.status, 200);
  assert.equal(proxy.seen.length, 1);
});

// ════════════════════════════════════════════════════════════
// B17-3 —— 内部口只在可信 UDS 上
// ════════════════════════════════════════════════════════════
function udsCall(uds, path, { method = 'POST', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const buf = body === null ? null : Buffer.from(body, 'utf8');
    const req = nodeHttp.request(
      {
        createConnection: () => nodeNet.connect(uds),
        method,
        path,
        headers: buf ? { 'content-type': 'application/json', 'content-length': String(buf.length) } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(buf ?? undefined);
  });
}

test('B17-3 公网口上那条内部口 ⇒ 404，而且**一次都不碰库**；可信 UDS 上 ⇒ 真答得上来', async (t) => {
  const boxDir = tmp();
  const boxApps = new Apps({ dir: boxDir, sub: 'owner', now: () => NOW });
  boxApps.create({ ...OK('wenda', '问答小抄'), permissions: ['ask'] });
  boxApps.setGrants('wenda', ['ask']);

  let touched = 0;
  const box = await bootBox(t, { dir: boxDir, onResolve: () => { touched += 1; } });

  const pub = await new Promise((resolve, reject) => {
    const req = nodeHttp.request(
      { host: '127.0.0.1', port: box.publicPort, method: 'POST', path: '/internal/app-ask-check' },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end('{"appId":"wenda"}');
  });
  assert.equal(pub, 404, '★ 公网口不许接那条口');
  assert.equal(touched, 0, '★ 判不过 ⇒ 连库都不许碰');

  // ★ 正对照：同一条请求走可信 UDS ⇒ 真答得上来（而且裁决与盒里那份一致）
  const ok = await udsCall(box.uds, '/internal/app-ask-check', { body: '{"appId":"wenda"}' });
  assert.equal(ok.status, 200);
  const verdict = JSON.parse(ok.body);
  assert.equal(verdict.ok, true, `可信口上应当放行：${ok.body}`);
  assert.ok(touched >= 1, '★ 可信口上真的读了库（正对照）');
  // 而且它**真的记了一笔**（先记再花就在这一步）
  const state = JSON.parse(nodeFs.readFileSync(askFileOf(boxDir, 'owner', 'wenda'), 'utf8'));
  assert.equal(state.n, 1);
});

// ════════════════════════════════════════════════════════════
// B17-4 —— 认不出 ⇒ fail-closed
// ════════════════════════════════════════════════════════════
/** 一个**只会胡说**的假盒子（挂在 UDS 上）。 */
async function lyingBox(t, { status = 200, json = '{"hello":1}' }) {
  const uds = nodePath.join(tmp('hupo-b17-ly-'), 'local-api.sock');
  const srv = nodeHttp.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(json);
    });
  });
  await new Promise((r) => srv.listen(uds, r));
  t.after(guard(() => new Promise((r) => srv.close(() => r()))));
  return { uds };
}

test('B17-4 盒子答的话**认不出** ⇒ 503（fail-closed；绝不许当成"过了"）', async (t) => {
  const hostDir = tmp();
  const lying = await lyingBox(t, { json: '{"hello":1}' });
  const host = await bootHost(t, { hostDirs: { u2: hostDir }, boxUds: { 'hupo-b': lying.uds } });

  const r = await postAsk(host, host.tokenFor('u2'), { appId: 'city-weather', prompt: '你好' });
  assert.equal(r.status, 503, '★ 认不出就是"没过"，不许放行');
  assert.equal((await r.json()).error, 'tenant-not-ready');
});

test('B17-4 反例：盒子那条口回 500 ⇒ 也是 503（不拿"它坏了"当"你可以花"）', async (t) => {
  const hostDir = tmp();
  const lying = await lyingBox(t, { status: 500, json: '{"error":"boom"}' });
  const host = await bootHost(t, { hostDirs: { u2: hostDir }, boxUds: { 'hupo-b': lying.uds } });

  const r = await postAsk(host, host.tokenFor('u2'), { appId: 'city-weather', prompt: '你好' });
  assert.equal(r.status, 503);
});
