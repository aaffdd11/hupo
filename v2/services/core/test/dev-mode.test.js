// **开发者模式** —— 判据 D1–D7、D9（契约 `docs/dev/82-DEV-MODE.md` §六）。
//
// ── 这份怎么打 ──────────────────────────────────────────────
//   · **宿主那半边**（D1–D6、D9）：起一台**真 HTTP**服务，用一个**假盒子**（真的 TCP 口）
//     接住转发 —— "路径到底有没有带 `/h`"只有从**接住的那一头**才看得见。
//   · **盒子那半边**（D7、D9）：注入**假 spawn + 假上游**（不用真 DSH、不用真容器），
//     验参数、验换 cookie、验改写的头、验只连回环。
//
// ⚠️ 判据 D8（真图）在 `scripts/check-dev-mode.mjs` 里（要**部署好的**系统才跑得起来）。
//
// ── 每条判据都要能**反着验** ────────────────────────────────
//   D1 没标 dev ⇒ 拒          · 反例：同样的请求给标了的人 ⇒ 200
//   D2 标了 + cookie ⇒ 200    · 而且进容器那条路**带 `/h` 前缀**
//   D3 标了但没 cookie ⇒ 拒    · 反例：假 cookie 也拒
//   D4 关掉标记 ⇒ **当场**拒   · 反例：翻回来又通（证明拒的是标记不是 cookie）
//   D5 签名**分域**            · 反例：制品签名 / 登录令牌 / **cookie 域的签名** ⇒ 403
//   D6 只有 owner 能翻 / 只给自己 · 反例：u2 的令牌 ⇒ 403
//   D9 开发者域名上的**升级**（界面那条主数据通道 `/api/remote.mux`）
//      · 正例：有效 cookie ⇒ **真的升级成**，容器收到 `/h/api/remote.mux`
//      · 反例：没 cookie / 假 cookie / 没标 dev / 没有租户 ⇒ **握手阶段就拒**
//
// ⚠️ **D9 是 2026-09-24 修的真 bug**：当初判成"那台界面全走普通 HTTP"，
//    于是开发者域名上的升级一律 404 ⇒ **界面能打开，但一个会话都列不出来**
//    （左下角一直 `Reconnecting…`、工作区写 `No sessions yet`）。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import nodeFs from 'node:fs';
import nodeHttp from 'node:http';
import nodeNet from 'node:net';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { Readable, Writable } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

import { Auth } from '../src/auth.js';
import { Users } from '../src/users.js';
import { SayService } from '../src/say.js';
import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';
import { createServer } from '../src/server.js';
import { signEntry } from '../src/app-serve.js';
import {
  DEV_COOKIE,
  DEV_ENTER_PATH,
  createDevWebRelay,
  devCookieValue,
  devEntryLink,
  devHostFor,
  devSig,
  devWebArgs,
  parseDevHost,
  parseDshWebLine,
  redactSecrets,
  readCookie,
  verifyDevCookie,
} from '../src/dev-mode.js';

const BASE = 'stalkerai.cn';
const PHONE = '19145526557'; // u2（开发者）
const OTHER = '13800001111'; // u3（不是开发者）
const NO_TENANT = '13700002222'; // u4（被标成开发者，但**没有租户**）
const KEY = Buffer.alloc(32, 7); // 判据自己的密钥（**不是**生产那把）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const openServers = new Set();
const openClients = new Set();
after(async () => {
  // ⚠️ **先把客户端断掉**：`wss.close()` 会等连接自己结束（同 `server.js` 的那条注释）。
  for (const ws of openClients) {
    try {
      ws.terminate();
    } catch {
      /* 已经断了 */
    }
  }
  await sleep(30);
  for (const close of openServers) {
    try {
      await close();
    } catch {
      /* 关不干净不影响结论 */
    }
  }
  openServers.clear();
  openClients.clear();
});

// ── 小工具 ─────────────────────────────────────────────────

/** 真 HTTP 请求（**Host 头要能自己给** —— 判据打的就是按 Host 分流）。 */
function request(origin, path, { method = 'GET', headers = {}, body = null } = {}) {
  const u = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request(
      { host: u.hostname, port: u.port, method, path, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body !== null) req.end(body);
    else req.end();
  });
}

/**
 * 真 WebSocket 客户端连一次。
 *
 * ⚠️ 判 D9 的关键是"**握手阶段**的结论"：`ok:true` = 真的 `101` 了；
 *    `ok:false, status` = 对面在握手阶段就拒了（**不是**先连上再关 —— 那样会先 `open`）。
 * ⚠️ `host` 头**要能自己给**（判据打的就是按 Host 分流）。
 */
function wsConnect(url, { headers = {}, protocols = null } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const ws = protocols ? new WebSocket(url, protocols, { headers }) : new WebSocket(url, { headers });
    openClients.add(ws);
    ws.on('open', () => finish({ ok: true, ws }));
    ws.on('unexpected-response', (_q, res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => finish({ ok: false, status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => finish({ ok: false, status: res.statusCode, body: '' }));
      res.on('close', () => finish({ ok: false, status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    ws.on('error', (err) => finish({ ok: false, err: String(err.message) }));
  });
}

/** 一个**假盒子**：把转发进来的请求原样记下来，回一段带 `__DSH_BOOT__` 的 HTML。
 *  ⚠️ 它也接**升级**（判据 D9）—— 记下 `req.url` / `req.headers`，然后**真的**完成握手，
 *     并把客户端说的话原样回一句（证明双向管道通着）。
 */
function fakeBox() {
  const seen = [];
  const upgraded = [];
  const srv = nodeHttp.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>那台 DSH</title>__DSH_BOOT__');
  });
  const wss = new WebSocketServer({ noServer: true });
  srv.on('upgrade', (req, sock, head) => {
    upgraded.push({ method: req.method, url: req.url, headers: req.headers });
    wss.handleUpgrade(req, sock, head, (ws) => {
      ws.on('message', (d, isBinary) => ws.send(d, { binary: isBinary }));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        port: srv.address().port,
        seen,
        upgraded,
        close: () =>
          new Promise((r) => {
            for (const c of wss.clients) {
              try {
                c.terminate();
              } catch {
                /* 已经断了 */
              }
            }
            wss.close();
            srv.closeAllConnections?.();
            srv.close(() => r());
          }),
      });
    });
  });
}

/**
 * 一个**真的假 `dsh web`**（判据 D9 · 盒子侧）：
 *   · `GET /?token=…` ⇒ 303 + `dsh-auth-…`（换 cookie 那一跳，和真的一样）；
 *   · 升级 ⇒ 记下路径与头，然后**真的**完成握手并把客户端说的话回给它。
 * 用真 `net`/`http`（不是注入的假货），所以验的是**真那条路**。
 */
function fakeDshWeb() {
  const httpSeen = [];
  const upgrades = [];
  const srv = nodeHttp.createServer((req, res) => {
    httpSeen.push({ url: req.url, headers: req.headers });
    if (req.url.startsWith('/?token=')) {
      res.writeHead(303, { location: '/', 'set-cookie': ['dsh-auth-abc=1; Path=/; HttpOnly'] });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html>__DSH_BOOT__');
  });
  const wss = new WebSocketServer({ noServer: true });
  srv.on('upgrade', (req, sock, head) => {
    upgrades.push({ method: req.method, url: req.url, headers: req.headers });
    wss.handleUpgrade(req, sock, head, (ws) => {
      ws.on('message', (d, isBinary) => ws.send(d, { binary: isBinary }));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        port: srv.address().port,
        httpSeen,
        upgrades,
        close: () =>
          new Promise((r) => {
            for (const c of wss.clients) {
              try {
                c.terminate();
              } catch {
                /* 已经断了 */
              }
            }
            wss.close();
            srv.closeAllConnections?.();
            srv.close(() => r());
          }),
      });
    });
  });
}

/**
 * 起一台宿主 + 一个假盒子（隧道"通"）。
 * `u2` = 开发者，`u3` = 不是。
 */
async function boot(t, { dev = true } = {}) {
  const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-dev-'));
  const store = new Store({ dataDir, fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const say = new SayService({ timeline, store, timelineId: 'main' });

  const auth = new Auth({ dataDir: nodePath.join(dataDir, 'auth') });
  auth.setPassword('这一份判据用的口令');

  const usersDir = nodePath.join(dataDir, 'users');
  nodeFs.mkdirSync(usersDir, { recursive: true });
  const users = new Users({ dataDir: usersDir });
  users.ensure(PHONE, { newId: 'u2' });
  users.ensure(OTHER, { newId: 'u3' });
  // ⚠️ u4 **没有租户**（`tenantOf` 不认他）—— 判据 D9 的反例之一要用
  users.ensure(NO_TENANT, { newId: 'u4' });
  if (dev) users.setDev(PHONE, true);

  const box = await fakeBox();
  openServers.add(box.close);

  const auditFile = nodePath.join(dataDir, 'audit.log');
  const { listen, close } = createServer({
    timeline,
    store,
    say,
    auth,
    users,
    webRoot: null,
    buildId: 'dev-mode-test',
    auditFile,
    tenantOf: (sub) => (sub === 'u2' ? 'hupo-b' : sub === 'u3' ? 'hupo-c' : null),
    proxyFor: () => nodeNet.connect(box.port, '127.0.0.1'),
    isLocalUser: (sub) => sub === 'owner',
    dev: { key: KEY, base: BASE, scheme: 'https' },
  });
  const guarded = async () => {
    openServers.delete(guarded);
    await close();
  };
  openServers.add(guarded);
  t.after(guarded);

  const addr = await listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  return {
    origin,
    wsBase: `ws://127.0.0.1:${addr.port}`,
    box,
    users,
    auditFile,
    tokenFor: (sub) => auth.issue({ sub }).token,
    devHostOf: (phone) => devHostFor(phone, BASE),
    cookieFor: (sub) => devCookieValue({ key: KEY, sub, exp: Date.now() + 60_000 }),
  };
}

// ════════════════════════════════════════════════════════════
// 纯函数那一层（Host 解析 / cookie 验签）—— 判据的"地基"
// ════════════════════════════════════════════════════════════

test('Host：只认**整整一个 label**的 `dsh<11位手机号>`（正反例一起钉）', () => {
  assert.equal(parseDevHost(`dsh${PHONE}.${BASE}`, BASE), PHONE);
  assert.equal(parseDevHost(`dsh${PHONE}.${BASE}:8443`, BASE), PHONE, '端口要剥掉');
  assert.equal(parseDevHost(`DSH${PHONE}.${BASE}`, BASE), PHONE, '大小写不敏感');
  // 反例：一个都不许认
  assert.equal(parseDevHost(BASE, BASE), null);
  assert.equal(parseDevHost(`w.${BASE}`, BASE), null, '`w.` 是站点，不许当成开发者域名');
  assert.equal(parseDevHost(`dsh1234567890.${BASE}`, BASE), null, '10 位不是手机号');
  assert.equal(parseDevHost(`dsh123456789012.${BASE}`, BASE), null, '12 位也不是');
  assert.equal(parseDevHost(`dsh19145526557.${BASE}`, null), null);
  assert.equal(
    parseDevHost(`evildsh${PHONE}.${BASE}`, BASE),
    null,
    '前缀不是边界 ⇒ 认出来就等于开了个别名',
  );
  assert.equal(parseDevHost(`dsh${PHONE}.${BASE}.evil.com`, BASE), null, '后缀必须到头');
});

test('cookie：验签 + 到期（改一个字符就不过）', () => {
  const now = 1_700_000_000_000;
  const value = devCookieValue({ key: KEY, sub: 'u2', exp: now + 1000 });
  assert.deepEqual(verifyDevCookie({ key: KEY, value, now }), { sub: 'u2', exp: now + 1000 });
  assert.equal(verifyDevCookie({ key: KEY, value: `${value}x`, now }), null, '尾巴多一个字符');
  // ⚠️ 别人的那份 cookie **本身是合法的**（签名对）——挡住它的是宿主那一步的
  //    "`sess.sub` 必须就是这个域名这个人"（见 D1/D4 那两条判据）。
  assert.deepEqual(
    verifyDevCookie({ key: KEY, value: devCookieValue({ key: KEY, sub: 'u3', exp: now + 1000 }), now }),
    { sub: 'u3', exp: now + 1000 },
    'u3 的 cookie 是合法的（那是**另一个人**，由宿主那一步挡）',
  );
  // ★ 把 sub 换掉、签名不换 ⇒ 不过（签名盖住的正是 sub）
  const [, expPart, sigPart] = value.split('.');
  assert.equal(verifyDevCookie({ key: KEY, value: `u3.${expPart}.${sigPart}`, now }), null, '改 sub 不改签名');
  assert.equal(verifyDevCookie({ key: KEY, value, now: now + 2000 }), null, '过期就不过');
  assert.equal(verifyDevCookie({ key: Buffer.alloc(32, 9), value, now }), null, '换密钥就不过');
});

// ════════════════════════════════════════════════════════════
// D1：没被标 `dev` ⇒ 那个域名**一律拒**
// ════════════════════════════════════════════════════════════

test('★ D1：没标 dev 的人 ⇒ 那个域名一律拒（**带着合法 cookie 也拒**）', async (t) => {
  const s = await boot(t, { dev: false });
  const h = s.devHostOf(OTHER);
  const r = await request(s.origin, '/', {
    headers: { host: h, cookie: `${DEV_COOKIE}=${s.cookieFor('u3')}` },
  });
  assert.equal(r.status, 403, '没标记 ⇒ 拒；放行就是把别人的盒子露出去');
  assert.equal(s.box.seen.length, 0, '**一次都不许**碰到盒子');

  // 反例（负向对照）：同样形状的请求，给**标了**的那个人 ⇒ 通
  s.users.setDev(PHONE, true);
  const ok = await request(s.origin, '/', {
    headers: { host: s.devHostOf(PHONE), cookie: `${DEV_COOKIE}=${s.cookieFor('u2')}` },
  });
  assert.equal(ok.status, 200, '标了的人同样的请求必须通 —— 否则上面那个 403 什么都不说明');
});

// ════════════════════════════════════════════════════════════
// D2：标了 + 带我们的 cookie ⇒ 200，且转发路径带 `/h` 前缀
// ════════════════════════════════════════════════════════════

test('★ D2：标了 + cookie ⇒ 200，而且进容器那条路**带 `/h` 前缀**、剥掉浏览器 cookie', async (t) => {
  const s = await boot(t);
  const r = await request(s.origin, '/', {
    headers: { host: s.devHostOf(PHONE), cookie: `${DEV_COOKIE}=${s.cookieFor('u2')}` },
  });
  assert.equal(r.status, 200);
  assert.match(r.body, /__DSH_BOOT__/u, '界面本体要真的通到盒子里那台');
  assert.equal(s.box.seen.length, 1);
  assert.equal(s.box.seen[0].url, '/h/', '`/` 进容器必须是 `/h/`（少了前缀盒里认不出来）');
  assert.equal(s.box.seen[0].headers.cookie, undefined, '浏览器那份 cookie **不许**进容器');

  // `/api/x?y=1` → `/h/api/x?y=1`（查询串要原样带着）
  const r2 = await request(s.origin, '/api/space?y=1', {
    headers: { host: s.devHostOf(PHONE), cookie: `${DEV_COOKIE}=${s.cookieFor('u2')}` },
  });
  assert.equal(r2.status, 200);
  assert.equal(s.box.seen[1].url, '/h/api/space?y=1');
});

// ════════════════════════════════════════════════════════════
// D3：标了但**没 cookie** ⇒ 拒（不是先给界面）
// ════════════════════════════════════════════════════════════

test('★ D3：标了但没 cookie ⇒ 拒（不许"先给界面再弹登录"）', async (t) => {
  const s = await boot(t);
  const h = s.devHostOf(PHONE);
  const no = await request(s.origin, '/', { headers: { host: h } });
  assert.equal(no.status, 403);
  assert.equal(s.box.seen.length, 0, '没通过外层 ⇒ **一次都不许**给界面');

  // 反例：假 cookie 也拒（不是"有没有这个头"就算数）
  const fake = await request(s.origin, '/', { headers: { host: h, cookie: `${DEV_COOKIE}=u2.9999999999999.deadbeef` } });
  assert.equal(fake.status, 403);
  assert.equal(s.box.seen.length, 0);
});

// ════════════════════════════════════════════════════════════
// D4：标记一关 ⇒ **当场**拒
// ════════════════════════════════════════════════════════════

test('🔴 D4：把标记关掉 ⇒ **当场**拒（同一个 cookie，不重启、不等缓存过期）', async (t) => {
  const s = await boot(t);
  const headers = { host: s.devHostOf(PHONE), cookie: `${DEV_COOKIE}=${s.cookieFor('u2')}` };
  assert.equal((await request(s.origin, '/', { headers })).status, 200, '先证明这条路本来是通的');
  const before = s.box.seen.length;

  assert.equal(s.users.setDev(PHONE, false).changed, true, '关掉要真的改了记录');
  const off = await request(s.origin, '/', { headers });
  assert.equal(off.status, 403, '关了标记 ⇒ 当场拒（每个请求现查，不是启动时读一次）');
  assert.equal(s.box.seen.length, before, '关了之后不许再碰盒子');

  // 反例：翻回来又通 —— 证明拒的是**标记**，不是 cookie 被弄坏了
  s.users.setDev(PHONE, true);
  assert.equal((await request(s.origin, '/', { headers })).status, 200);
});

// ════════════════════════════════════════════════════════════
// D5：`/__enter` 的签名**分域**
// ════════════════════════════════════════════════════════════

test('★ D5：`/__enter` 的签名**分域** —— 制品签名 / 登录令牌 / 别的域 ⇒ 403', async (t) => {
  const s = await boot(t);
  const h = s.devHostOf(PHONE);
  const exp = Date.now() + 60_000;

  // ① 正例：我们这条域（`d`）签出来的 ⇒ 302 + 第一方 cookie
  const link = devEntryLink({ origin: `https://${h}`, key: KEY, sub: 'u2', now: Date.now() });
  const q = new URL(link.url).searchParams;
  const ok = await request(s.origin, `${DEV_ENTER_PATH}?${q.toString()}`, { headers: { host: h } });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.location, '/');
  const setCookie = String(ok.headers['set-cookie'] ?? '');
  assert.match(setCookie, new RegExp(`^${DEV_COOKIE}=`, 'u'));
  assert.match(setCookie, /HttpOnly/u);
  assert.match(setCookie, /Secure/u);
  assert.match(setCookie, /SameSite=Lax/u);
  assert.match(setCookie, /Max-Age=\d+/u);

  // ② 🔴 **制品那条签名**（同一个密钥、另一个域）：`<sub>|<id>|<version>|<exp>`
  const artifactSig = signEntry({ key: KEY, sub: 'u2', id: 'demo', version: 1, exp });
  const r2 = await request(s.origin, `${DEV_ENTER_PATH}?u=u2&e=${exp}&s=${artifactSig}`, { headers: { host: h } });
  assert.equal(r2.status, 403, '制品签名不许当入口签名用（不验域 ⇒ 这条红）');

  // ③ 🔴 **甲那条**（琥珀自己的登录令牌）：它长成 `<base64url>.<base64url>`
  const r3 = await request(s.origin, `${DEV_ENTER_PATH}?u=u2&e=${exp}&s=${await s.tokenFor('u2')}`, {
    headers: { host: h },
  });
  assert.equal(r3.status, 403);

  // ④ 🔴 **cookie 那个域的签名**（`dh|…`）：同一把密钥、另一个域 —— 也不能当入口用
  const cookieSig = devSig({ key: KEY, domain: 'dh', sub: 'u2', exp });
  const r4 = await request(s.origin, `${DEV_ENTER_PATH}?u=u2&e=${exp}&s=${cookieSig}`, { headers: { host: h } });
  assert.equal(r4.status, 403, '换了域就得换一把签名 —— 这正是"分域"要钉的');

  // ⑤ 过期 / 换人 / 换密钥都不行
  const old = devSig({ key: KEY, domain: 'd', sub: 'u2', exp: exp - 120_000 });
  assert.equal(
    (await request(s.origin, `${DEV_ENTER_PATH}?u=u2&e=${exp - 120_000}&s=${old}`, { headers: { host: h } })).status,
    403,
    '过期不算',
  );
  const forU3 = devSig({ key: KEY, domain: 'd', sub: 'u3', exp });
  assert.equal(
    (await request(s.origin, `${DEV_ENTER_PATH}?u=u3&e=${exp}&s=${forU3}`, { headers: { host: h } })).status,
    403,
    '链接是给 u3 的，拿到 u2 的域名上用 ⇒ 不认',
  );
  const otherKey = devSig({ key: Buffer.alloc(32, 3), domain: 'd', sub: 'u2', exp });
  assert.equal(
    (await request(s.origin, `${DEV_ENTER_PATH}?u=u2&e=${exp}&s=${otherKey}`, { headers: { host: h } })).status,
    403,
    '换一把密钥签的 ⇒ 不认',
  );
});

test('`/__enter` 不是 GET ⇒ 405（别的方法不作数）', async (t) => {
  const s = await boot(t);
  const r = await request(s.origin, DEV_ENTER_PATH, { method: 'POST', headers: { host: s.devHostOf(PHONE) } });
  assert.equal(r.status, 405);
});

// ════════════════════════════════════════════════════════════
// D6：只有 owner 能翻标记；`/api/dev-harness` 只给自己
// ════════════════════════════════════════════════════════════

test('🔴 D6：只有 owner 能翻标记（u2 的令牌 ⇒ 403），而且翻一次记一笔', async (t) => {
  const s = await boot(t, { dev: false });
  const u2 = await s.tokenFor('u2');
  const owner = await s.tokenFor('owner');
  const post = (token, body) =>
    request(s.origin, '/api/dev-mode', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  assert.equal((await post(u2, { phone: OTHER, on: true })).status, 403, 'u2 想翻别人的 ⇒ 403');
  assert.equal(s.users.isDev('u3'), false, '拒了就得**什么都没发生**');

  const ok = await post(owner, { phone: OTHER, on: true });
  assert.equal(ok.status, 200);
  assert.equal(s.users.isDev('u3'), true, '主人翻得动');

  // 记一笔：谁、什么时候、开了谁（**手机号只许掩码**）
  const log = nodeFs.readFileSync(s.auditFile, 'utf8');
  assert.match(log, /开发者模式/u);
  assert.match(log, /138\*\*\*\*1111/u, '被开的那个人要出现在那一行里（掩码形态）');
  assert.ok(!log.includes(OTHER), '**整个手机号不许进审计文件**');

  // 关掉也要能翻
  assert.equal((await post(owner, { phone: OTHER, on: false })).status, 200);
  assert.equal(s.users.isDev('u3'), false);

  // 没令牌 ⇒ 401（它不是公开路由）
  assert.equal(
    (await request(s.origin, '/api/dev-mode', { method: 'POST', body: '{}' })).status,
    401,
  );
});

test('★ D6：`/api/dev-harness` 只给自己（owner 可点名）；没标 dev ⇒ 如实说不给', async (t) => {
  const s = await boot(t);
  const u2 = await s.tokenFor('u2');
  const owner = await s.tokenFor('owner');
  const get = (token, path) =>
    request(s.origin, path, { headers: { authorization: `Bearer ${token}` } });

  // 自己 ⇒ 自己的链接
  const mine = await get(u2, '/api/dev-harness');
  assert.equal(mine.status, 200);
  const mineJson = JSON.parse(mine.body);
  assert.equal(mineJson.ok, true);
  assert.match(mineJson.url, new RegExp(`^https://dsh${PHONE}\\.${BASE.replace('.', '\\.')}${DEV_ENTER_PATH}\\?`, 'u'));
  assert.ok(mineJson.expiresAt > Date.now(), '短时效也要说清到什么时候');

  // 别人想点名 ⇒ 403
  assert.equal((await get(u2, `/api/dev-harness?phone=${OTHER}`)).status, 403, 'u2 不许点名别人');

  // owner 点名 ⇒ 给那个人的链接
  const named = await get(owner, `/api/dev-harness?phone=${PHONE}`);
  assert.equal(named.status, 200);
  assert.equal(JSON.parse(named.body).ok, true);

  // 没标 dev ⇒ **不给链接**，而且如实说
  // ⚠️ **必须是 `404` 不是 `200`**（2026-09-24 收尾时改的）：客户端那条约定是
  //    "**非 200 ⇒ 没被标**"；`200` + 没有 `url` 会被它判成**坏回执** ⇒ 屏幕上写成
  //    「这会儿问不到」= **把"你没被标"说成"网络问题"**。这条断言就是钉这个的。
  const notDev = await get(owner, `/api/dev-harness?phone=${OTHER}`);
  assert.equal(notDev.status, 404, '没被标 ⇒ 404（客户端据此画"没被标"那句）');
  const nj = JSON.parse(notDev.body);
  assert.equal(nj.dev, false);
  assert.equal(nj.url, undefined);
  assert.match(nj.text, /还没被标成开发者/u);

  // 这条链接**真的能用**（拿它去 `/__enter` 换 cookie）
  const q = new URL(mineJson.url).searchParams;
  const hit = await request(s.origin, `${DEV_ENTER_PATH}?${q.toString()}`, { headers: { host: s.devHostOf(PHONE) } });
  assert.equal(hit.status, 302, '发出去的链接必须真的能换到 cookie');
});

test('别的 Host 照旧走站点（**不许把站点抢过来**）', async (t) => {
  const s = await boot(t);
  // 站点那台：同一个路径照常答
  const site = await request(s.origin, '/api/version', { headers: { host: 'w.stalkerai.cn' } });
  assert.equal(site.status, 200, '别的 Host 一律照旧走站点（这条路由是公开的）');
  assert.equal(s.box.seen.length, 0, '站点请求**一次都不许**碰到开发者中继');
  // 同一个路径落在开发者域名上 ⇒ 归开发者中继（没 cookie ⇒ 拒）
  const dev = await request(s.origin, '/api/version', { headers: { host: s.devHostOf(PHONE) } });
  assert.equal(dev.status, 403, '开发者域名上的**一切**都归外层那把锁管');
});

test('🔴 盒子侧只在 `trusted`（那条 0600 UDS）上接 `/h` —— 公网口不接', async (t) => {
  const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-dev-h-'));
  const store = new Store({ dataDir, fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const auth = new Auth({ dataDir: nodePath.join(dataDir, 'auth') });
  const seen = [];
  const devContainer = {
    handle(req, res, rel) {
      seen.push(rel);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('__DSH_BOOT__');
    },
  };
  const { listen, listenTrusted, close } = createServer({
    timeline,
    store,
    say: new SayService({ timeline, store, timelineId: 'main' }),
    auth,
    webRoot: null,
    buildId: 't',
    devContainer,
  });
  openServers.add(close);
  const addr = await listen(0);
  const sock = nodePath.join(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-dev-sock-')), 'api.sock');
  await listenTrusted(sock);

  // ① 可信口：`/h/api/x?y=1` ⇒ 前缀剥掉、交给中继
  const viaTrusted = await new Promise((resolve, reject) => {
    const r = nodeHttp.request({ socketPath: sock, path: '/h/api/x?y=1', method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end();
  });
  assert.equal(viaTrusted.status, 200);
  assert.equal(viaTrusted.body, '__DSH_BOOT__');
  assert.deepEqual(seen, ['/api/x?y=1'], '`/h` 前缀要剥掉再交给反代');

  // ② 公网口：同一条路径 ⇒ **中继一次都不许被碰到**
  const viaPublic = await request(`http://127.0.0.1:${addr.port}`, '/h/api/x?y=1');
  assert.notEqual(viaPublic.status, 200);
  assert.equal(seen.length, 1, '公网口不许接 `/h`（少了这道闸就是把盒子递给整张网）');
  await close();
});

test('没配开发者模式（`dev=null`）⇒ `/api/dev-harness` 404（这条路关着）', async (t) => {
  const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-dev-off-'));
  const store = new Store({ dataDir, fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const auth = new Auth({ dataDir: nodePath.join(dataDir, 'auth') });
  auth.setPassword('这一份判据用的口令');
  const { listen, close } = createServer({
    timeline,
    store,
    say: new SayService({ timeline, store, timelineId: 'main' }),
    auth,
    webRoot: null,
    buildId: 't',
  });
  openServers.add(close);
  const addr = await listen(0);
  const r = await request(`http://127.0.0.1:${addr.port}`, '/api/dev-harness', {
    headers: { authorization: `Bearer ${auth.issue({ sub: 'owner' }).token}` },
  });
  assert.equal(r.status, 404);
  await close();
});

// ════════════════════════════════════════════════════════════
// D9：开发者域名上的**升级**（界面那条主数据通道 `/api/remote.mux`）
//     —— 2026-09-24 修的真 bug：当初一律 404 ⇒ "界面能打开、什么都列不出来"
// ════════════════════════════════════════════════════════════

test('★ D9：开发者域名 + 有效 cookie + 升级 `/api/remote.mux` ⇒ **真的升级成**，容器收到 `/h/api/remote.mux`', async (t) => {
  const s = await boot(t);
  const h = s.devHostOf(PHONE);
  const r = await wsConnect(`${s.wsBase}/api/remote.mux`, {
    headers: { host: h, origin: `https://${h}`, cookie: `${DEV_COOKIE}=${s.cookieFor('u2')}` },
  });
  assert.equal(r.ok, true, '带着合法 cookie 的升级**必须真的升上去**（界面的会话流就是它）');

  // ★ **容器那一侧收到的是加过 `/h` 前缀的那一条**（从接住的那一头才看得见）
  assert.equal(s.box.upgraded.length, 1, '这条升级要真的进到盒子里');
  assert.equal(
    s.box.upgraded[0].url,
    '/h/api/remote.mux',
    '`/api/remote.mux` 进容器必须是 `/h/api/remote.mux`',
  );
  assert.equal(s.box.upgraded[0].headers.cookie, undefined, '浏览器那份 cookie 不许进容器');

  // ★ **双向管道**：客户端说一句、盒子原样回一句（证明不是"101 之后就断了"）
  const got = new Promise((res) => r.ws.on('message', (d) => res(String(d))));
  r.ws.send('ping');
  assert.equal(await got, 'ping');
  r.ws.terminate();
});

test('🔴 D9 反例：没 cookie / 假 cookie / 没标 dev / 没有租户 ⇒ **握手阶段就拒**，盒子一次都不许被碰到', async (t) => {
  const s = await boot(t);
  s.users.setDev(NO_TENANT, true); // u4 被标了，但 `tenantOf` 不认他
  const h = s.devHostOf(PHONE);

  // ① 标了 + **没 cookie** ⇒ 403（`ok:false` 就是"没升上去"；不是先 `open` 再关）
  const no = await wsConnect(`${s.wsBase}/api/remote.mux`, { headers: { host: h } });
  assert.equal(no.ok, false, '没通过外层 ⇒ 不许升上去');
  assert.equal(no.status, 403);

  // ② 假 cookie ⇒ 也是 403（不是"有这个头就算数"）
  const fake = await wsConnect(`${s.wsBase}/api/remote.mux`, {
    headers: { host: h, cookie: `${DEV_COOKIE}=u2.9999999999999.deadbeef` },
  });
  assert.equal(fake.ok, false);
  assert.equal(fake.status, 403);

  // ③ **没有租户**（标了 dev、cookie 也合法）⇒ 503 —— 宿主不许替他接
  const noTenant = await wsConnect(`${s.wsBase}/api/remote.mux`, {
    headers: { host: s.devHostOf(NO_TENANT), cookie: `${DEV_COOKIE}=${s.cookieFor('u4')}` },
  });
  assert.equal(noTenant.ok, false, '没有租户 ⇒ 不许升上去');
  assert.equal(noTenant.status, 503);

  // ④ **没标 dev**（另一个 boot：谁都没标）⇒ 403，哪怕 cookie 是真的
  const off = await boot(t, { dev: false });
  const offHost = off.devHostOf(PHONE);
  const offR = await wsConnect(`${off.wsBase}/api/remote.mux`, {
    headers: { host: offHost, cookie: `${DEV_COOKIE}=${off.cookieFor('u2')}` },
  });
  assert.equal(offR.ok, false, '没标 dev ⇒ 一律拒（连升级也不给机会）');
  assert.equal(offR.status, 403);

  // ★ 四个反例合起来：**一次都不许**碰到盒子
  assert.equal(s.box.upgraded.length, 0, '没通过外层 ⇒ 升级一次都不许进容器');
  assert.equal(off.box.upgraded.length, 0);
});

test('🔴 D9：`/h…` 的升级**只在 `trusted`（那条 0600 UDS）上接** —— 公网口一律拒', async (t) => {
  const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-dev-hup-'));
  const store = new Store({ dataDir, fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const auth = new Auth({ dataDir: nodePath.join(dataDir, 'auth') });
  const seen = [];
  // ⚠️ 桩里用**真的** `WebSocketServer` 完成握手：回一个裸 `101` 是过不了 `ws` 客户端
  //    校验的（缺 `Sec-WebSocket-Accept`）⇒ 那条正例会假红。
  const wss = new WebSocketServer({ noServer: true });
  const devContainer = {
    handle(_req, res) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('__DSH_BOOT__');
    },
    handleUpgrade(req, socket, head, rel) {
      seen.push(rel);
      wss.handleUpgrade(req, socket, head, () => {});
    },
  };
  const srv = createServer({
    timeline,
    store,
    say: new SayService({ timeline, store, timelineId: 'main' }),
    auth,
    webRoot: null,
    buildId: 't',
    devContainer,
  });
  openServers.add(srv.close);
  const addr = await srv.listen(0);
  const sockPath = nodePath.join(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-dev-hsock-')), 'api.sock');
  await srv.listenTrusted(sockPath);

  // ① 可信口：`/h/api/remote.mux` ⇒ 前缀剥掉、交给 `handleUpgrade`
  const viaTrusted = await wsConnect(`ws+unix://${sockPath}:/h/api/remote.mux`);
  assert.equal(viaTrusted.ok, true, '可信口上这条升级必须交给中继');
  assert.deepEqual(seen, ['/api/remote.mux'], '`/h` 前缀要剥掉再交给反代');

  // ② 公网口：同一条升级 ⇒ **中继一次都不许被碰到**
  const viaPublic = await wsConnect(`ws://127.0.0.1:${addr.port}/h/api/remote.mux`);
  assert.equal(viaPublic.ok, false, '公网口不许接 `/h` 的升级（少了这道闸就是把盒子递给整张网）');
  assert.equal(seen.length, 1, '公网口**一次都不许**碰到那个中继');
  // ⚠️ 先把那条真连接断掉再 `close()`：`server.close()` 会等连接自己结束
  //    （桩里那个 `wss` 不在 `server.js` 的清单里，它不会替我们断）。
  viaTrusted.ws.terminate();
  await srv.close();
});

// ════════════════════════════════════════════════════════════
// D7：盒子侧**没有**宿主端口；`dsh web` 只听回环
// ════════════════════════════════════════════════════════════


test('🔴 D7：起 `dsh web` 的参数 —— **只听回环、端口交给内核**，`--patch` 在 `--profile web` 后面', () => {
  const cfg = { modelPatchPath: '/app/code/hupo-model-proxy.yml', agentProfile: 'sdk' };
  assert.deepEqual(devWebArgs(cfg), [
    '--profile',
    'web',
    '--patch',
    '/app/code/hupo-model-proxy.yml',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '--no-open',
  ]);
  const args = devWebArgs(cfg);
  assert.ok(!args.includes('0.0.0.0'), '绝对不许听 0.0.0.0（那等于把盒子递给整张网）');
  assert.ok(!args.includes('-p') && !args.some((a) => a.includes('--publish')), '不开宿主端口');
  // 模型那条 patch 是**可选**的，但 profile 永远在
  assert.deepEqual(devWebArgs({}), ['--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open']);
});

test('`parseDshWebLine`：认得出那一行，认不出就 null（不猜）', () => {
  assert.deepEqual(parseDshWebLine('dsh web: http://127.0.0.1:41001/?token=abc.DEF-123'), {
    port: 41001,
    token: 'abc.DEF-123',
  });
  assert.equal(parseDshWebLine('dsh web: http://0.0.0.0:41001/?token=abc'), null, '不是回环的不认');
  assert.equal(parseDshWebLine('随便一行'), null);
  assert.deepEqual(readCookie('a=1; hupo-dev=x.y.z; b=2', DEV_COOKIE), 'x.y.z');
  // ⚠️ 日志前要把进程令牌 / DSH cookie 抹掉（那是能力，不是给日志看的）
  assert.equal(
    redactSecrets('dsh web: http://127.0.0.1:1/?token=SECRET-PROC 带着 dsh-auth-abc=SECRET-COOKIE'),
    'dsh web: http://127.0.0.1:1/?token=<已隐去> 带着 dsh-auth-abc=<已隐去>',
  );
});

/** 假子进程：`stdout`/`stderr` 是 EventEmitter，`kill` 会发 `exit`。 */
function fakeChild(line) {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stdout.setEncoding = () => {};
  c.stderr = new EventEmitter();
  c.stderr.setEncoding = () => {};
  c.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
  c.killed = false;
  c.kill = () => {
    c.killed = true;
    c.emit('exit', null, 'SIGTERM');
  };
  setImmediate(() => c.stdout.emit('data', `${line}\n`));
  return c;
}

/** 假上游：第一跳是换 cookie，第二跳才是真请求。 */
function fakeUpstream() {
  const calls = [];
  const httpRequest = (opts, cb) => {
    const rec = { opts, body: '' };
    calls.push(rec);
    const sink = new Writable({
      write(chunk, _e, next) {
        rec.body += String(chunk);
        next();
      },
    });
    sink.on('finish', () => {
      const isExchange = typeof rec.opts.path === 'string' && rec.opts.path.startsWith('/?token=');
      const r = isExchange
        ? { status: 303, headers: { location: '/', 'set-cookie': ['dsh-auth-abc=1; Path=/; HttpOnly'] }, body: '' }
        : {
            status: 200,
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'set-cookie': ['dsh-auth-abc=1; Path=/'],
              location: 'http://127.0.0.1:41001/next',
            },
            body: '<!doctype html>__DSH_BOOT__',
          };
      const upRes = Readable.from([Buffer.from(r.body)]);
      upRes.statusCode = r.status;
      upRes.headers = r.headers;
      cb(upRes);
    });
    sink.on('error', () => {});
    return sink;
  };
  return { httpRequest, calls };
}

/** 假 `req` / `res`（只要 relay 用到的那几样）。 */
function fakeReqRes({ method = 'GET', url = '/', headers = {} } = {}) {
  const req = Readable.from([]);
  req.method = method;
  req.url = url;
  req.headers = headers;
  const chunks = [];
  const res = new Writable({
    write(chunk, _e, next) {
      chunks.push(Buffer.from(chunk));
      next();
    },
  });
  res.headersSent = false;
  res.status = null;
  res.outHeaders = null;
  res.writeHead = (status, h) => {
    res.status = status;
    res.outHeaders = h;
    res.headersSent = true;
    return res;
  };
  res.destroy = () => {};
  res.body = () => Buffer.concat(chunks).toString('utf8');
  return { req, res };
}

test('🔴 D7：盒子侧 relay —— 只连回环、替浏览器带 DSH 的 cookie、改写 Host/Origin，且不缓冲', async () => {
  const cfg = {
    dshBin: '/bin/dsh',
    agentCwd: '/data/main',
    dshHome: '/data/dsh',
    modelPatchPath: '/app/code/hupo-model-proxy.yml',
    agentUid: 1000,
    agentGid: 1000,
    agentBootTimeoutMs: 5000,
  };
  const spawned = [];
  const child = fakeChild('dsh web: http://127.0.0.1:41001/?token=PROC-TOKEN');
  const spawnFn = (bin, args, opts) => {
    spawned.push({ bin, args, opts });
    return child;
  };
  const { httpRequest, calls } = fakeUpstream();

  // 环境里塞一把"密钥"：`childEnv()` 必须把它摘掉（**绝不许**递给 DSH）
  const saved = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'should-not-leak';
  const relay = createDevWebRelay({ cfg, spawnFn, httpRequest, bootTimeoutMs: 2000 });
  try {
    const { req, res } = fakeReqRes({
      method: 'POST',
      url: '/api/x?y=1',
      headers: { host: 'dsh19145526557.stalkerai.cn', origin: 'https://dsh19145526557.stalkerai.cn', cookie: 'hupo-dev=browser', 'sec-fetch-site': 'same-origin' },
    });
    await relay.handle(req, res, '/api/x?y=1');
    // 等假上游那一跳（`finish` 是异步的）
    for (let i = 0; i < 50 && res.status === null; i += 1) await sleep(5);

    // ① spawn 的形状：换手 + 摘密钥 + 听回环
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].bin, '/bin/dsh');
    assert.deepEqual(spawned[0].args.slice(0, 4), ['--profile', 'web', '--patch', '/app/code/hupo-model-proxy.yml']);
    assert.ok(spawned[0].args.includes('--host') && spawned[0].args.includes('127.0.0.1'));
    assert.equal(spawned[0].opts.uid, 1000, '盒子里的"手"必须换到 1000（不许 root 跑 DSH）');
    assert.equal(spawned[0].opts.gid, 1000);
    assert.equal(spawned[0].opts.cwd, '/data/main');
    assert.equal(spawned[0].opts.env.DSH_HOME, '/data/dsh');
    assert.equal(spawned[0].opts.env.DEEPSEEK_API_KEY, undefined, '`childEnv()` 要摘掉密钥');

    // ② 两跳：先换 cookie，再真请求
    assert.equal(calls.length, 2);
    assert.equal(calls[0].opts.path, '/?token=PROC-TOKEN');
    assert.equal(calls[0].opts.host, '127.0.0.1');
    assert.equal(calls[0].opts.port, 41001, '只连回环上那个端口');
    const real = calls[1];
    assert.equal(real.opts.host, '127.0.0.1');
    assert.equal(real.opts.port, 41001);
    assert.equal(real.opts.path, '/api/x?y=1', '`/h` 前缀由**宿主**剥掉后才进来；这里原样转给 dsh');
    assert.equal(real.opts.headers.cookie, 'dsh-auth-abc=1', '替浏览器带上 DSH 自己那把');
    assert.equal(real.opts.headers.host, '127.0.0.1:41001', 'Host 要改写成回环（`/api` 栅栏靠它）');
    assert.equal(real.opts.headers.origin, 'http://127.0.0.1:41001', 'Origin 也要回环');
    assert.equal(real.opts.headers['sec-fetch-site'], 'same-origin');

    // ③ 响应：本体到了、`set-cookie` 被剥掉、回环 location 改成相对路径
    assert.equal(res.status, 200);
    assert.match(res.body(), /__DSH_BOOT__/u);
    assert.equal(res.outHeaders['set-cookie'], undefined, '里层那把锁的 cookie **不许**给浏览器');
    assert.equal(res.outHeaders.location, '/next');
  } finally {
    if (saved === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = saved;
    relay.shutdown();
  }
});

test('D7：盒里那台起不来 ⇒ 502 说人话（不是空连接，也不是 200）', async () => {
  const cfg = { dshBin: '/bin/dsh', agentCwd: '/data/main', dshHome: '/data/dsh', agentUid: 1000, agentBootTimeoutMs: 50 };
  const spawnFn = () => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stdout.setEncoding = () => {};
    c.stderr = new EventEmitter();
    c.stderr.setEncoding = () => {};
    c.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    c.kill = () => {};
    setImmediate(() => c.emit('exit', 1, null));
    return c;
  };
  const relay = createDevWebRelay({ cfg, spawnFn, bootTimeoutMs: 200 });
  const { req, res } = fakeReqRes({ url: '/', headers: { host: '127.0.0.1:1' } });
  await relay.handle(req, res, '/');
  assert.equal(res.status, 502);
  assert.match(res.body(), /没起来/u);
  relay.shutdown();
});

// ════════════════════════════════════════════════════════════
// D9 · 盒子侧：`/h…` 的**升级** ⇒ 原样搬字节到回环上的 `dsh web`
// ════════════════════════════════════════════════════════════

/** 一个 `dsh web` **起不来**的假子进程（立刻 `exit 1`）。 */
function deadChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stdout.setEncoding = () => {};
  c.stderr = new EventEmitter();
  c.stderr.setEncoding = () => {};
  c.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
  c.kill = () => {};
  setImmediate(() => c.emit('exit', 1, null));
  return c;
}

/**
 * 一条**可信口**的壳（生产里那是容器里那条 `0600` UDS）：把 `/h…` 的升级交给中继。
 * ⚠️ 这里只做**前缀剥掉**那一件 —— 和 `server.js` 的 `handleUpgrade` 里那一行逐字一致。
 */
async function devFront(relay) {
  const front = nodeHttp.createServer(() => {});
  front.on('upgrade', (req, sock, head) => {
    relay.handleUpgrade(req, sock, head, req.url.replace(/^\/h/u, '') || '/');
  });
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  openServers.add(() => new Promise((r) => front.close(() => r())));
  return { port: front.address().port };
}

test('★ D9（盒子侧）：升级到回环 —— Host/Origin 改写、DSH cookie 注入、浏览器 cookie 剥掉、双向管道', async (t) => {
  const dsh = await fakeDshWeb();
  openServers.add(dsh.close);

  const cfg = {
    dshBin: '/bin/dsh',
    agentCwd: '/data/main',
    dshHome: '/data/dsh',
    agentUid: 1000,
    agentGid: 1000,
    agentBootTimeoutMs: 5000,
  };
  // 假子进程报的是**那个假上游**的端口 ⇒ 换 cookie 与升级都打到它身上。
  // ⚠️ child **必须在 spawn 那一刻才造**：`fakeChild` 是 `setImmediate` 报端口，
  //    提前造好会在监听挂上之前就把那一行发掉（那样这一条会白等一个 boot 超时）。
  const relay = createDevWebRelay({
    cfg,
    spawnFn: () => fakeChild(`dsh web: http://127.0.0.1:${dsh.port}/?token=PROC-TOKEN`),
    bootTimeoutMs: 2000,
  });
  t.after(() => relay.shutdown());

  const front = await devFront(relay);
  const r = await wsConnect(`ws://127.0.0.1:${front.port}/h/api/remote.mux`, {
    headers: {
      host: 'dsh19145526557.stalkerai.cn',
      origin: 'https://dsh19145526557.stalkerai.cn',
      // ⚠️ 浏览器那份里塞两把：`hupo-dev`（外层锁）与一把**假的** DSH cookie ——
      //    两把都**不许**进上游，替它带上的是换来的那把。
      //    ⚠️ 头值只能是 ASCII（node 拒 U+00FF 以上的字符）⇒ 这里用英文写。
      cookie: 'hupo-dev=outer-lock; dsh-auth-should-be-removed=1',
      'sec-fetch-site': 'cross-site',
    },
  });
  assert.equal(r.ok, true, '盒子里这条升级必须真的接上（那是界面唯一的会话流）');

  // ★ 上游看到的路径与头
  const up = dsh.upgrades[0];
  assert.ok(up, '假上游必须真的收到那条升级');
  assert.equal(dsh.httpSeen[0]?.url, '/?token=PROC-TOKEN', '先拿进程令牌换 cookie（那一跳不能少）');
  assert.equal(up.url, '/api/remote.mux', '`/h` 前缀由**宿主**剥掉后才进来；这里原样转给 dsh');
  assert.equal(up.headers.host, `127.0.0.1:${dsh.port}`, 'Host 要改写成回环（`/api` 栅栏靠它）');
  assert.equal(up.headers.origin, `http://127.0.0.1:${dsh.port}`, 'Origin 也要回环');
  assert.equal(up.headers.cookie, 'dsh-auth-abc=1', '**剥掉浏览器那份**，替它带上 DSH 自己那把');
  assert.equal(up.headers['sec-fetch-site'], 'same-origin');
  assert.match(String(up.headers.upgrade), /websocket/iu, '`Connection`/`Upgrade` 不许被当 hop-by-hop 删掉');

  // ★ **双向**：客户端说一句、上游回一句
  const got = new Promise((res) => r.ws.on('message', (d) => res(String(d))));
  r.ws.send('ping');
  assert.equal(await got, 'ping');
  r.ws.terminate();
});

test('D9（盒子侧）：盒里那台起不来 ⇒ **握手阶段** 502 说人话（不是先 101 再关）', async (t) => {
  const cfg = { dshBin: '/bin/dsh', agentCwd: '/data/main', dshHome: '/data/dsh', agentUid: 1000, agentBootTimeoutMs: 50 };
  const relay = createDevWebRelay({ cfg, spawnFn: () => deadChild(), bootTimeoutMs: 200 });
  t.after(() => relay.shutdown());

  const front = await devFront(relay);
  const r = await wsConnect(`ws://127.0.0.1:${front.port}/h/api/remote.mux`, {
    headers: { host: 'dsh19145526557.stalkerai.cn' },
  });
  assert.equal(r.ok, false, '起不来 ⇒ 不许先给一条 101');
  assert.equal(r.status, 502);
  assert.match(r.body ?? '', /没起来/u, '要有一句人话');
});
