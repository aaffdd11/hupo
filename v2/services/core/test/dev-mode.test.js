// **开发者模式** —— 判据 D1–D9（契约 `docs/dev/82-DEV-MODE.md` §六）；
// **"开的是你自己那台 · 全部房间"那一组见契约 `docs/dev/109-DEV-ENTRY-IS-YOURS.md`**。
//
// ── 这份怎么打 ──────────────────────────────────────────────
//   · **宿主那半边**（D1–D6、D9）：起一台**真 HTTP**服务，用一个**假盒子**（真的 TCP 口）
//     接住转发 —— "路径到底有没有带 `/h`"只有从**接住的那一头**才看得见。
//   · **盒子那半边**（D7、D9）：注入**假 spawn + 假上游**（不用真 DSH、不用真容器），
//     验参数、验换 cookie、验改写的头、验只连回环。
//
// ⚠️ 判据 D8（真图 · 旧那套）在 `scripts/check-dev-mode.mjs` 里（要**部署好的**系统才跑得起来）。
//
// ── 109 那几条（2026-09-25）────────────────────────────────
//   **D1** 参数与真那台**同源**：`--profile sdk` ＋ 人格 ＋ 能力层 ＋ 模型那条（= `agentArgs()`）
//          · 变异：改回 `--profile web` ⇒ 红
//   **D2** cwd ＝ **那一间的 cwd**（`main` ⇒ 主对话那一间；工作区 ⇒ `workspaces/<它>`）
//          · 变异：指回 `/data`（或别的房间）⇒ 红
//   **D6** 清单里**列得出全部房间**（`main` ＋ 每一间工作区）
//          · 变异：只列 `main` ⇒ 红
//   **D7** 🔴 **只有一套配置、一个家**：源码里不许再出现 `--profile web`；`DSH_HOME` 只有一个
//   **D3/D4** 🔴 **真机**判据（真机上那两个进程共用一份会话）—— 读数写在 `109` 那份的账里，
//          这一份打不了（它不碰真 DSH）。
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
import { agentPatchArgs } from '../src/agent-runtime.js';
import {
  DEV_COOKIE,
  DEV_ENTER_PATH,
  DEV_BOARD_NOT_HUPO,
  DEV_BOARD_WHY_NOT,
  DEV_ROOMS_PATH,
  DEV_WEB_PROFILE,
  createDevWebRelay,
  devCookieValue,
  devEntryLink,
  devHostFor,
  devRoomsHtml,
  devSig,
  devWebArgs,
  ensureRoomRegistered,
  injectDevBanner,
  normalizeRooms,
  parseDevHost,
  parseDshWebLine,
  redactSecrets,
  readCookie,
  verifyDevCookie,
  workspaceRegistryPath,
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


test('🔴 D1/D7′：起那台的参数 —— **patch 集合与真那台同一处出处**，只听回环', () => {
  const cfg = {
    agentProfile: 'sdk',
    // ★ 契约 110：开发者入口那台**也**要挂 SDK server 那一层（与调度器同源）——
    //   它换的是"谁来收发帧"，那一层在 `--profile web` 下不会生效
    //   （那个 profile 里没有 `sdk-jsonrpc-server`，也没有 `sdkAppStartup`），
    //   但**参数必须同源**：两处各拼一份就是这个契约要防的那种漂。
    sdkServerPatchPath: '/app/code/hupo-sdk-server.yml',
    personaPath: '/app/code/hupo-persona.yml',
    capabilitiesPath: '/app/code/hupo-capabilities.yml',
    modelPatchPath: '/app/code/hupo-model-proxy.yml',
    agentCwd: '/data/main',
  };
  const want = [
    '--profile',
    'web', // ← D7″：界面这个 app（DSH 只在它里面提供浏览器界面）
    '--patch',
    '/app/code/hupo-sdk-server.yml',
    '--patch',
    '/app/code/hupo-persona.yml',
    '--patch',
    '/app/code/hupo-capabilities.yml',
    '--patch',
    '/app/code/hupo-model-proxy.yml',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '--no-open',
  ];
  assert.deepEqual(devWebArgs(cfg), want);

  // ★ **D7′：patch 集合与调度器那台同一处产出**（`agentPatchArgs()`）——
  //    这一条把"各写一份"结构上钉死。
  assert.deepEqual(
    devWebArgs(cfg).filter((_a, i, all) => all[i - 1] === '--patch'),
    agentPatchArgs(cfg).filter((_a, i, all) => all[i - 1] === '--patch'),
    '入口那台与调度器那台的 patch 集合必须是**同一个函数**产出的',
  );
  // 顺序也一样：人格 → 能力层 → 模型（`--patch` 可重复，顺序就是叠加顺序）
  assert.deepEqual(devWebArgs(cfg), ['--profile', 'web', ...agentPatchArgs(cfg), '--host', '127.0.0.1', '--port', '0', '--no-open']);
  // ★ **D1 的变异**：少挂一条（或回到"只有模型那条"那种 `harnessArgs` 形状）⇒ 当场红
  assert.notDeepEqual(
    devWebArgs(cfg),
    ['--profile', 'web', '--patch', cfg.modelPatchPath, '--host', '127.0.0.1', '--port', '0', '--no-open'],
    '只有模型那条 patch（改前那种"没有人格、没有工具"）必须红',
  );
  assert.ok(devWebArgs(cfg).includes(cfg.personaPath), '人格那一层必须在');
  assert.ok(devWebArgs(cfg).includes(cfg.capabilitiesPath), '能力层必须在');
  assert.ok(devWebArgs(cfg).includes(cfg.modelPatchPath), '模型那条必须在');

  const args = devWebArgs(cfg);
  assert.ok(!args.includes('0.0.0.0'), '绝对不许听 0.0.0.0（那等于把盒子递给整张网）');
  assert.ok(!args.includes('-p') && !args.some((a) => a.includes('--publish')), '不开宿主端口');
  // ⚠️ `--patch` 是**全局选项**，必须写在 `--profile` **后面**（H5 那条同一条纪律）
  const pi = args.indexOf('--profile');
  for (const i of [args.indexOf('--patch'), args.lastIndexOf('--patch')]) assert.ok(i > pi, '`--patch` 要在 `--profile` 后面');
  // 那几层 patch 是**可选**的，但 profile 永远在
  assert.deepEqual(devWebArgs({}), ['--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open']);
});

test('🔴 D7′/D7″（源码级）：patch 集合与 `agent-runtime` **同一处产出**；`DSH_HOME` 只有一个；`web` 那一行有读数撑着', async () => {
  const src = nodeFs.readFileSync(
    nodePath.join(nodePath.dirname(new URL(import.meta.url).pathname), '../src/dev-mode.js'),
    'utf8',
  );
  // ⚠️ 注释里当然会提到那些字（那是在讲事实）⇒ 把注释剥掉只看**代码**。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//gu, '') // 块注释（JSDoc 也在内）
    .split('\n')
    .filter((l) => !/^\s*\/\//u.test(l)) // 行注释
    .join('\n');
  // ① **D7′**：patch 层**不许自己拼一份** —— 只能走 `agentPatchArgs()`。
  assert.match(code, /agentPatchArgs\(/u, 'patch 层必须由 `agentPatchArgs()` 造（与 agent-runtime 一处出处）');
  assert.ok(!/harnessArgs/u.test(code), '不许再用 `harnessArgs()`（那套只有模型那条 patch）');
  assert.ok(!/cfg\.personaPath/u.test(code), '不许自己拼 `--patch cfg.personaPath`（那是第二处出处）');
  assert.ok(!/cfg\.capabilitiesPath/u.test(code), '不许自己拼 `--patch cfg.capabilitiesPath`');
  assert.ok(!/cfg\.modelPatchPath/u.test(code), '不许自己拼 `--patch cfg.modelPatchPath`');
  // ② **D7′**：env（`DSH_HOME` ＋ 能力层那几样）也只能有一处出处：`agentEnv(cfg)`。
  //    ⚠️ 少给能力层那几样，`hupo-capabilities.yml` 会让 dsh **整个 plugin tree 加载失败**
  //       （真机读数：`expected {…} but got {"args":[null]}`）—— 见 `agentEnv` 的注释。
  assert.match(code, /agentEnv\(cfg\)/u, 'env 必须由 `agentEnv(cfg)` 造（与 agent-runtime 一处出处）');
  assert.ok(!/childEnv\(/u.test(code), '不许在这里自己拼 env（那是第二处出处）');
  assert.ok(!/\bhome:\s+(?!cfg\.dshHome)/u.test(code), '不许另设第二个 home');
  // ③ **D7″**：`--profile web` **可以有**，但必须有那两条读数撑着（下一个人不许以为换 sdk 就同源）。
  const comments = src;
  assert.match(comments, /dsh --profile sdk --host/u, '注释里要留 `--profile sdk --host` 那条读数（原话）');
  assert.match(comments, /unknown option/u, "注释里要留 `unknown option '--host'` 那句原话");
  assert.match(comments, /stdio JSON-RPC/u, '注释里要说清 sdk 是 stdio JSON-RPC（没有浏览器界面）');
  assert.match(code, /DEV_WEB_PROFILE/u, '`web` 那一行要走具名常量（它的来历写在常量上面）');
  assert.equal(DEV_WEB_PROFILE, 'web');
});

/** 走一次"选某一间"（`/?room=<id>` ⇒ 302），返回那次响应。 */
async function selectRoom(relay, id) {
  const url = `/?room=${encodeURIComponent(id)}`;
  const { req, res } = fakeReqRes({ url });
  await relay.handle(req, res, url);
  return res;
}

test('🔴 D3 的必要条件：注册表冻结了 ⇒ 默认**只读提示**（一个字节都不写）；要动它得显式开', () => {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-dev-reg-'));
  const storages = nodePath.join(dir, 'storages');
  nodeFs.mkdirSync(storages, { recursive: true });
  const mainDir = nodePath.join(dir, 'main');
  const otherDir = nodePath.join(dir, 'other');
  nodeFs.mkdirSync(mainDir);
  nodeFs.mkdirSync(otherDir);
  const file = workspaceRegistryPath(dir);
  /** 冻结在 `other`（真机上那一份就是这种形状：`initialized:true` 且只认一间）。 */
  const frozen = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: ['s-archived'] },
    tables: { workspaces: { w1: { path: otherDir, title: 'other', sessionIds: ['x.1'] } } },
  };
  const write = (o) => nodeFs.writeFileSync(file, `${JSON.stringify(o, null, 2)}\n`);
  try {
    // ★ **默认（`apply` 不给）= 只读**：看出来了，但**一个字节都不许动**。
    write(frozen);
    const before = nodeFs.readFileSync(file, 'utf8');
    const ro = ensureRoomRegistered({ dshHome: dir, cwd: mainDir });
    assert.equal(ro.registered, false, '要看出来"这一间不在注册表里"');
    assert.equal(ro.changed, false, '默认**不许**写盘');
    assert.equal(nodeFs.readFileSync(file, 'utf8'), before, '🔴 默认一个字节都不许动（写它要主人拍）');
    assert.match(ro.why, /得主人拍/u, '要有一句"这事得主人拍"的话');

    // ① 显式 `apply:true` ⇒ 置回 `initialized:false`（DSH 下次按会话头重新发现）
    const r1 = ensureRoomRegistered({ dshHome: dir, cwd: mainDir, apply: true });
    assert.equal(r1.changed, true);
    const after = JSON.parse(nodeFs.readFileSync(file, 'utf8'));
    assert.equal(after.global.initialized, false, '要让 DSH 重新发现房间');
    assert.deepEqual(after.global.archivedSessionIds, ['s-archived'], '既有账一条都不许动');
    assert.deepEqual(after.tables.workspaces.w1.sessionIds, ['x.1'], '既有记录一条都不许动');

    // ② 已经在里面 ⇒ **一个字节都不动**（幂等）
    after.global.initialized = true;
    write(after);
    const before2 = nodeFs.readFileSync(file, 'utf8');
    assert.equal(ensureRoomRegistered({ dshHome: dir, cwd: otherDir, apply: true }).changed, false);
    assert.equal(nodeFs.readFileSync(file, 'utf8'), before2, '已经在里面 ⇒ 不动它');

    // ③ 注册表不在 / 坏了 ⇒ 什么都不做（DSH 自己会 bootstrap；坏的更不许碰）
    nodeFs.rmSync(file);
    assert.equal(ensureRoomRegistered({ dshHome: dir, cwd: mainDir, apply: true }).changed, false);
    nodeFs.writeFileSync(file, '{ 不是 json');
    assert.equal(ensureRoomRegistered({ dshHome: dir, cwd: mainDir, apply: true }).changed, false);
    assert.equal(nodeFs.readFileSync(file, 'utf8'), '{ 不是 json', '坏的也不许动');

    // ④ 反向对照：冻结着而**不** nudge ⇒ 它一直是 `true`（界面就看不到那一间 —— 真机读数）
    write(frozen);
    assert.equal(JSON.parse(nodeFs.readFileSync(file, 'utf8')).global.initialized, true);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('🔴 D2/D6：房间清单 = `main` ＋ 每一间工作区；点哪间就用**那间的 cwd** 起（一次只开一间）', async () => {
  // 一个**冻结在别处**的 DSH 注册表：这一间不在里面 ⇒ 起那台之前要 nudge 它。
  const regDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-dev-reg2-'));
  nodeFs.mkdirSync(nodePath.join(regDir, 'storages'), { recursive: true });
  nodeFs.writeFileSync(
    workspaceRegistryPath(regDir),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ['w0'], archivedSessionIds: [] },
      tables: { workspaces: { w0: { path: '/somewhere/else', title: 'else', sessionIds: [] } } },
    }),
  );
  const cfg = {
    dshBin: '/bin/dsh',
    agentCwd: '/data/main',
    dshHome: regDir,
    personaPath: '/app/code/hupo-persona.yml',
    capabilitiesPath: '/app/code/hupo-capabilities.yml',
    modelPatchPath: '/app/code/hupo-model-proxy.yml',
    agentUid: 1000,
    agentGid: 1000,
    agentBootTimeoutMs: 5000,
  };
  // ★ 房间清单的来源（生产里由 `serve.js` 从 `worlds` 取 —— 与真那台**同一处**）
  const rooms = [
    { id: 'main', name: '主对话', cwd: '/data/main' },
    { id: 'count-abc', name: 'count-abc', cwd: '/data/workspaces/count-abc' },
  ];
  const spawned = [];
  const kids = [];
  const spawnFn = (bin, args, opts) => {
    const c = fakeChild(`dsh web: http://127.0.0.1:${41001 + spawned.length}/?token=T${spawned.length}`);
    spawned.push({ bin, args, opts });
    kids.push(c);
    return c;
  };
  const { httpRequest } = fakeUpstream();
  const relay = createDevWebRelay({
    cfg,
    rooms: () => rooms,
    // ⚠️ **显式开**才动 DSH 的注册表（默认关 —— 写它要主人拍）。
    workspaceNudge: true,
    spawnFn,
    httpRequest,
    bootTimeoutMs: 2000,
  });
  try {
    // ① ★ D6：清单页列出**全部**房间（`main` ＋ 每一间工作区），而且**一间 DSH 都不用起**
    const page = fakeReqRes({ url: DEV_ROOMS_PATH });
    await relay.handle(page.req, page.res, DEV_ROOMS_PATH);
    assert.equal(page.res.status, 200);
    assert.equal(spawned.length, 0, '列房间**不该**花掉一台 DSH');
    assert.match(page.res.body(), /主对话/u);
    assert.match(page.res.body(), /count-abc/u);
    assert.match(page.res.body(), /\?room=main/u, '`main` 要能点（href 里带 id）');
    assert.match(page.res.body(), /\?room=count-abc/u);
    // ★ **变异：只列 `main` ⇒ 当场红**（两条清单的形状必须不一样）
    assert.notEqual(
      devRoomsHtml({ rooms: normalizeRooms([rooms[0]]) }),
      devRoomsHtml({ rooms: normalizeRooms(rooms) }),
      '只列 `main` 的清单与"全部房间"的清单必须不一样 —— D6 的变异就是"只列 main"',
    );

    // ② 还没选过 ⇒ `/` 先给清单（契约 109 §"先给一个房间清单"）
    const home = fakeReqRes({ url: '/' });
    await relay.handle(home.req, home.res, '/');
    assert.equal(home.res.status, 200);
    assert.match(home.res.body(), /count-abc/u);
    assert.equal(spawned.length, 0, '还没选哪间 ⇒ 一台都不许起');

    // ③ 选 `main` ⇒ 302；再来 `/` ⇒ 用 **main 的 cwd** 起
    const sel = await selectRoom(relay, 'main');
    assert.equal(sel.status, 302, '选房间就是 302 到 `/`');
    const mainReq = fakeReqRes({ url: '/' });
    await relay.handle(mainReq.req, mainReq.res, '/');
    for (let i = 0; i < 50 && mainReq.res.status === null; i += 1) await sleep(5);
    assert.equal(spawned.length, 1);
    // ★ **D2**：cwd = 那一间的 cwd（盒里就是 `/data/main`）—— **不是 `/data`**
    assert.equal(spawned[0].opts.cwd, '/data/main', 'main 那一间 ⇒ cwd 就是主对话那一间（不是 /data）');
    assert.equal(spawned[0].opts.env.DSH_HOME, regDir, 'DSH_HOME 就是那一个（不另设第二个家）');
    assert.deepEqual(spawned[0].args, [
      '--profile',
      DEV_WEB_PROFILE,
      ...agentPatchArgs(cfg),
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--no-open',
    ]);
    // ★ **D3 的必要条件**：这一间不在冻结的注册表里 ⇒ 起那台之前要 nudge 它
    //   （不然 DSH 界面会把这一间的会话整个藏掉 —— 真机读见 `ensureRoomRegistered`）。
    assert.equal(
      JSON.parse(nodeFs.readFileSync(workspaceRegistryPath(regDir), 'utf8')).global.initialized,
      false,
      '冻结的注册表里没有这一间 ⇒ 起那台之前必须让它重新发现房间',
    );

    // ④ 换一间 ⇒ **旧的收掉** ＋ 新的用**那间的 cwd**（"一次只开一间"）
    const sel2 = await selectRoom(relay, 'count-abc');
    assert.equal(sel2.status, 302);
    const roomReq = fakeReqRes({ url: '/' });
    await relay.handle(roomReq.req, roomReq.res, '/');
    for (let i = 0; i < 50 && roomReq.res.status === null; i += 1) await sleep(5);
    assert.equal(spawned.length, 2, '换房间要**新起一台**');
    assert.equal(spawned[1].opts.cwd, '/data/workspaces/count-abc', '点哪间就用**那间的 cwd**');
    assert.equal(kids[0].killed, true, '换房间 ⇒ 旧的必须收掉（内存/句柄别失控）');
    assert.equal(relay.state().room, 'count-abc');
    assert.equal(relay.state().cwd, '/data/workspaces/count-abc');
    assert.equal(relay.state().running, true);

    // ⑤ 不认识的一间 ⇒ 404，而且**一台都不许起**（不拿随手的字符串当 cwd）
    const bad = await selectRoom(relay, '../../etc');
    assert.equal(bad.status, 404);
    assert.equal(spawned.length, 2, '不认识的一间 ⇒ **一台都不许起**');

    // ⑥ 那一间没了（工作区被删）⇒ 回清单页，不拿一个已经不存在的 cwd 去 spawn
    rooms.pop();
    const gone = fakeReqRes({ url: '/' });
    await relay.handle(gone.req, gone.res, '/');
    assert.equal(gone.res.status, 200);
    assert.match(gone.res.body(), /主对话/u);
    assert.equal(relay.state().running, false, '那一间没了 ⇒ 那一台也要收掉');
  } finally {
    relay.shutdown();
    nodeFs.rmSync(regDir, { recursive: true, force: true });
  }
});

test('🔴 默认**不动** DSH 的注册表（写它要主人拍）—— 只留一句只读提示', async () => {
  const regDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-dev-reg3-'));
  nodeFs.mkdirSync(nodePath.join(regDir, 'storages'), { recursive: true });
  const frozen = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['w0'], archivedSessionIds: [] },
    tables: { workspaces: { w0: { path: '/somewhere/else', title: 'else', sessionIds: [] } } },
  };
  nodeFs.writeFileSync(workspaceRegistryPath(regDir), `${JSON.stringify(frozen, null, 2)}\n`);
  const before = nodeFs.readFileSync(workspaceRegistryPath(regDir), 'utf8');
  const cfg = {
    dshBin: '/bin/dsh',
    agentCwd: '/data/main',
    dshHome: regDir,
    agentUid: 1000,
    agentGid: 1000,
    agentBootTimeoutMs: 5000,
  };
  const logs = [];
  const spawned = [];
  const { httpRequest } = fakeUpstream();
  const relay = createDevWebRelay({
    cfg,
    rooms: () => [{ id: 'main', name: '主对话', cwd: '/data/main' }],
    // ⚠️ **故意不传 `workspaceNudge`**（默认 `false`）
    spawnFn: (_b, _a, opts) => {
      spawned.push(opts);
      return fakeChild('dsh web: http://127.0.0.1:41001/?token=T');
    },
    httpRequest,
    bootTimeoutMs: 2000,
    log: (m) => logs.push(String(m)),
  });
  try {
    await selectRoom(relay, 'main');
    const { req, res } = fakeReqRes({ url: '/' });
    await relay.handle(req, res, '/');
    for (let i = 0; i < 50 && res.status === null; i += 1) await sleep(5);
    assert.equal(spawned.length, 1, '那台照常起（只读提示不挡路）');
    assert.equal(
      nodeFs.readFileSync(workspaceRegistryPath(regDir), 'utf8'),
      before,
      '🔴 默认**一个字节都不写**（写 DSH 的存储要主人拍）',
    );
    assert.ok(
      logs.some((m) => /不在 DSH 的注册表里/u.test(m) && /主人拍/u.test(m)),
      '要留一句只读提示（说清"看不到那一间"＋"这事得主人拍"）',
    );
  } finally {
    relay.shutdown();
    nodeFs.rmSync(regDir, { recursive: true, force: true });
  }
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

/** 假上游：第一跳是换 cookie，第二跳才是真请求。
 *
 * @param {object} [o]
 * @param {string} [o.doc] 第二跳那个响应体（默认没有 `<body>` —— 那是"认不出来"那一档）
 * @param {string} [o.docType] 第二跳的 `content-type`
 */
function fakeUpstream({ doc = '<!doctype html>__DSH_BOOT__', docType = 'text/html; charset=utf-8' } = {}) {
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
              'content-type': docType,
              'set-cookie': ['dsh-auth-abc=1; Path=/'],
              location: 'http://127.0.0.1:41001/next',
            },
            body: doc,
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
    // ★ 新形状：入口**先给房间清单** ⇒ 先选一间（默认清单里那一间是 `main`）。
    const sel = await selectRoom(relay, 'main');
    assert.equal(sel.status, 302);
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
  await selectRoom(relay, 'main'); // 新形状：先选一间
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
  // ★ 新形状：升级那条也要先知道开的是哪一间 ⇒ 先选一间（默认清单里是 `main`）。
  assert.equal((await selectRoom(relay, 'main')).status, 302);

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
  // ★ **还没选哪一间** ⇒ 握手阶段 503（不是先给一条 101）
  const noRoom = await wsConnect(`ws://127.0.0.1:${front.port}/h/api/remote.mux`, {
    headers: { host: 'dsh19145526557.stalkerai.cn' },
  });
  assert.equal(noRoom.ok, false, '还没选房间 ⇒ 不许先给一条 101');
  assert.equal(noRoom.status, 503);
  assert.match(noRoom.body ?? '', /房间/u, '要有一句人话（回房间清单选一间）');

  // 选一间之后：那台起不来 ⇒ 502
  assert.equal((await selectRoom(relay, 'main')).status, 302);
  const r = await wsConnect(`ws://127.0.0.1:${front.port}/h/api/remote.mux`, {
    headers: { host: 'dsh19145526557.stalkerai.cn' },
  });
  assert.equal(r.ok, false, '起不来 ⇒ 不许先给一条 101');
  assert.equal(r.status, 502);
  assert.match(r.body ?? '', /没起来/u, '要有一句人话');
});

// ── ★ 「看板那句话」（主人 2026-09-25 拍的「甲」· 契约 109 §八）──────────────
//
// 判据：**页面上明写"在这儿说话的不是琥珀"**。三处落点：
//   ① 进之前那一页（`devRoomsHtml`）；② **那一页本体**（`injectDevBanner`）；
//   ③ 客户端「我自己那台」那一层（`dev_harness_words.dart` → 判据在 Dart 那一侧）。
// ⚠️ 为什么非要有：那一页里回话的**真的不是琥珀**（`standard` preset 自己那份 persona
//    盖住了我们那层 —— 真机读数在 `dev-mode.js` 顶上）。不写 = 界面说假话。

test('★ 看板那句话：进之前那一页上**明写**（而且一个内部词都没有）', () => {
  const html = devRoomsHtml({ rooms: [{ id: 'main', name: '主对话', cwd: '/data/main' }] });
  assert.ok(html.includes(DEV_BOARD_NOT_HUPO), '那一页必须写着"在这儿说话的不是琥珀"');
  assert.ok(html.includes(DEV_BOARD_WHY_NOT), '还得说清哪一份是它的、哪一份不是');
  // 反例：那句话必须在**这一页上**（不是某个变量里躺着）
  assert.ok(/<body>[\s\S]*不是琥珀/u.test(html), '那句必须在 `<body>` 里面（真的画得出来）');
});

test('★ `injectDevBanner`：插在 `<body>` 之后（第一个孩子），其余字节一个不动', () => {
  const before = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div><script src="./a.js"></script></body></html>';
  const after = injectDevBanner(before);
  assert.ok(after !== null, '认得出 `<body>` ⇒ 必须插进去');
  assert.ok(after.includes(DEV_BOARD_NOT_HUPO) && after.includes(DEV_BOARD_WHY_NOT));
  // 插在 `<body>` 之后、`#root` 之前（后面那条靠 `flex` 占满剩下的地方 —— 见那一段 CSS）
  assert.ok(
    after.indexOf('<body>') < after.indexOf('hupo-dev-notice'),
    '那一条要在 `<body>` 里面',
  );
  assert.ok(
    after.indexOf('hupo-dev-notice') < after.indexOf('id="root"'),
    '那一条要在 `#root` **之前**（不然它会掉到页面底下）',
  );
  // 原文一个字都没丢（只多插了一段）
  for (const keep of ['<!doctype html>', '<title>t</title>', '<div id="root"></div>', '<script src="./a.js"></script>', '</html>']) {
    assert.ok(after.includes(keep), `原来那一段不许被动：${keep}`);
  }
  // 🔴 **认不出来 ⇒ `null`**（宁可没有那一条，也不许猜着改那一页）
  assert.equal(injectDevBanner('<div>没有 body 的一小段</div>'), null);
  assert.equal(injectDevBanner(''), null);
});

test('★ 看板那句话：**顶层那一页**才插（别的路径 / 非 HTML 一字节都不改）', async (t) => {
  const cfg = {
    dshBin: '/bin/dsh',
    agentCwd: '/data/main',
    dshHome: '/data/dsh',
    agentUid: 1000,
    agentGid: 1000,
    agentBootTimeoutMs: 5000,
  };
  const doc = '<!doctype html><html><body><div id="root"></div></body></html>';
  const { httpRequest, calls } = fakeUpstream({ doc });
  const relay = createDevWebRelay({
    cfg,
    spawnFn: () => fakeChild('dsh web: http://127.0.0.1:41002/?token=PROC-TOKEN'),
    httpRequest,
    bootTimeoutMs: 2000,
  });
  t.after(() => relay.shutdown());
  assert.equal((await selectRoom(relay, 'main')).status, 302);

  // ① 顶层那一页 ⇒ 那一条**必须在**（而且 content-length 跟着新长度走）
  const a = fakeReqRes({ url: '/', headers: { host: 'dsh19145526557.stalkerai.cn' } });
  await relay.handle(a.req, a.res, '/');
  for (let i = 0; i < 100 && a.res.status === null; i += 1) await sleep(5);
  assert.equal(a.res.status, 200);
  assert.ok(a.res.body().includes(DEV_BOARD_NOT_HUPO), '顶层那一页必须有那一条');
  assert.ok(a.res.body().includes('id="root"'), '原来那一页还得在');
  assert.equal(
    Number(a.res.outHeaders['content-length']),
    Buffer.byteLength(a.res.body(), 'utf8'),
    '改了本体就必须改 content-length（不然浏览器会截断）',
  );
  // 而且**要了不压缩**（压缩过的字节没法安全地插一行）
  const docCall = calls.find((c) => c.opts.path === '/');
  assert.equal(docCall?.opts.headers['accept-encoding'], 'identity');
  // 反例：**不是顶层那一份**（别的路径，哪怕也是 HTML）⇒ 一个字节都不碰
  const b = fakeReqRes({ url: '/other.html', headers: { host: 'dsh19145526557.stalkerai.cn' } });
  await relay.handle(b.req, b.res, '/other.html');
  for (let i = 0; i < 100 && b.res.status === null; i += 1) await sleep(5);
  assert.equal(b.res.body(), doc, '只有顶层那一份才插；别的路径原样');
});

test('★ 看板那句话：非 HTML / 子路径**一个字节都不碰**（认不出就不插）', async (t) => {
  const cfg = {
    dshBin: '/bin/dsh',
    agentCwd: '/data/main',
    dshHome: '/data/dsh',
    agentUid: 1000,
    agentBootTimeoutMs: 5000,
  };
  const doc = '<!doctype html><html><body><div id="root"></div></body></html>';
  const { httpRequest } = fakeUpstream({ doc, docType: 'application/javascript' });
  const relay = createDevWebRelay({
    cfg,
    spawnFn: () => fakeChild('dsh web: http://127.0.0.1:41003/?token=PROC-TOKEN'),
    httpRequest,
    bootTimeoutMs: 2000,
  });
  t.after(() => relay.shutdown());
  assert.equal((await selectRoom(relay, 'main')).status, 302);

  const r = fakeReqRes({ url: '/', headers: { host: 'dsh19145526557.stalkerai.cn' } });
  await relay.handle(r.req, r.res, '/');
  for (let i = 0; i < 100 && r.res.status === null; i += 1) await sleep(5);
  assert.equal(r.res.status, 200);
  assert.equal(r.res.body(), doc, '不是 HTML ⇒ **原样**（一个字节都不许动）');
});

test('★ 看板那句话：JS 与 Dart 两份文案**逐字一样**（改一份不改另一份 ⇒ 当场红）', () => {
  // ⚠️ 同一句话不许有两处来源 —— 但它们**必须**跨语言各存一份
  //    （一份给盒子里的页面，一份给 App 那一层）⇒ 用这条闸把它们钉在一起。
  const dart = nodeFs.readFileSync(
    nodePath.resolve(import.meta.dirname, '../../../apps/mobile/lib/models/dev_harness_words.dart'),
    'utf8',
  );
  const pick = (name) => {
    const m = new RegExp(`const String ${name} = '([^']*)';`, 'u').exec(dart);
    assert.ok(m, `Dart 那份里找不到 ${name}`);
    return m[1];
  };
  assert.equal(pick('devBoardNotHupo'), DEV_BOARD_NOT_HUPO, '那句话两份必须逐字一样');
  assert.equal(pick('devBoardWhyNot'), DEV_BOARD_WHY_NOT, '那句解释两份必须逐字一样');
});

// ════════════════════════════════════════════════════════════
// ★ 换房间的**内存峰值**（2026-09-25 真机踩出来的 · `DEV_EXIT_WAIT_MS`）
//
// 真机读数：容器上限 768MB；一台 `dsh web` 348MB ＋ 它那三个 MCP 子进程 ~144MB ＋
// 盒里自己的服务 ~76MB。换房间原来是"`SIGTERM` 旧的 ⇒ **立刻**起新的"（旧那台要
// `killGraceMs` 之后才 `SIGKILL`）⇒ 两台峰值叠在一起 ⇒ 内核把**新起来的那台**杀掉
// （`oom_kill` 3 → 5，正好对应两次换房间）⇒ 那一间**打不开**。
// ⇒ 判据：**起新台之前，旧那台必须已经真的没了**。
// ════════════════════════════════════════════════════════════

/** 一个"死得慢"的假子进程：`kill()` 之后**过一会儿**才吐 `exit`（真 DSH 就是这样）。 */
function slowFakeChild(line, { exitAfterMs = 60 } = {}) {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stdout.setEncoding = () => {};
  c.stderr = new EventEmitter();
  c.stderr.setEncoding = () => {};
  c.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
  c.killed = false;
  c.exited = false;
  c.signals = [];
  c.kill = (sig = 'SIGTERM') => {
    c.killed = true;
    c.signals.push(sig);
    if (c.exited) return;
    // ★ **`SIGKILL` 是当场就没了**（真进程也一样）；`SIGTERM` 才是"过一会儿才退"
    const ms = sig === 'SIGKILL' ? 0 : exitAfterMs;
    const t = setTimeout(() => {
      c.exited = true;
      c.emit('exit', null, sig);
    }, ms);
    t.unref?.();
  };
  setImmediate(() => c.stdout.emit('data', `${line}\n`));
  return c;
}

test('★ 换房间：**起新台之前旧那台要真的没了**（不然两台峰值叠加 ⇒ 新的被 OOM 杀掉）', async () => {
  const cfg = {
    dshBin: '/bin/dsh',
    agentCwd: '/data/main',
    dshHome: '/data/dsh',
    agentUid: 1000,
    agentBootTimeoutMs: 5000,
  };
  const rooms = [
    { id: 'main', name: '主对话', cwd: '/data/main' },
    { id: 'other', name: 'other', cwd: '/data/workspaces/other' },
  ];
  const kids = [];
  /** 起第二台的那一刻，第一台还在不在（**这就是那条判据**）。 */
  const firstStillAliveWhenSecondSpawned = [];
  const spawnFn = () => {
    if (kids.length > 0) firstStillAliveWhenSecondSpawned.push(kids.some((k) => k && !k.exited));
    const c = slowFakeChild(`dsh web: http://127.0.0.1:${42000 + kids.length}/?token=T${kids.length}`);
    kids.push(c);
    return c;
  };
  const { httpRequest } = fakeUpstream();
  const relay = createDevWebRelay({
    cfg,
    rooms: () => rooms,
    spawnFn,
    httpRequest,
    killGraceMs: 50,
    bootTimeoutMs: 2000,
  });
  try {
    assert.equal((await selectRoom(relay, 'main')).status, 302);
    const a = fakeReqRes({ url: '/' });
    await relay.handle(a.req, a.res, '/');
    for (let i = 0; i < 100 && a.res.status === null; i += 1) await sleep(5);
    assert.equal(a.res.status, 200);

    // 换一间：旧的收掉 ⇒ **它真的没了**之后才准起新的
    assert.equal((await selectRoom(relay, 'other')).status, 302);
    const b = fakeReqRes({ url: '/' });
    await relay.handle(b.req, b.res, '/');
    for (let i = 0; i < 200 && b.res.status === null; i += 1) await sleep(5);
    assert.equal(b.res.status, 200, '换过去那一间也要起得来');
    assert.equal(kids.length, 2, '换房间要新起一台');
    assert.equal(kids[0].exited, true, '旧那台必须已经退出');
    assert.deepEqual(
      firstStillAliveWhenSecondSpawned,
      [false],
      '🔴 **起第二台的时候，第一台必须已经不在了**（叠在一起就是真机那次 OOM 的形状）',
    );
    // 正对照：旧那台是被**收掉**的（不是"它自己碰巧没了"）
    assert.equal(kids[0].killed, true, '换房间要收掉旧的');
  } finally {
    relay.shutdown();
  }
});

test('★ 那台起不来 ⇒ **失败的那一台要被真的收掉**（不留孤儿赖着内存）＋ 如实说原因', async () => {
  const cfg = {
    dshBin: '/bin/dsh',
    agentCwd: '/data/main',
    dshHome: '/data/dsh',
    agentUid: 1000,
  };
  const kids = [];
  /** cgroup 那个"被 OOM 杀了几个"的读数（起台**期间**它涨了 ⇒ 就是被系统杀的）。 */
  let oomKills = 3;
  // 一个**永远不报端口、也不自己退**的假子进程（正是"起不来"那一档）
  const spawnFn = () => {
    oomKills = 5; // ← 起这一台的过程中，系统杀了两个（真机那次就是这个形状）
    const c = slowFakeChild('', { exitAfterMs: 100000 });
    c.stdout.emit = () => {}; // 永远不吐那一行
    kids.push(c);
    return c;
  };
  const { httpRequest } = fakeUpstream();
  /** relay 说过的话（判据要读"它有没有如实说原因"）。 */
  const saidLines = [];
  const relay = createDevWebRelay({
    cfg,
    rooms: () => [{ id: 'main', name: '主对话', cwd: '/data/main' }],
    spawnFn,
    httpRequest,
    log: (m) => saidLines.push(String(m)),
    killGraceMs: 30,
    bootTimeoutMs: 120,
    // 起之前 3、起之后 5 ⇒ "被系统杀了（内存不够）"这句要**读得出来**
    oomKillsFn: () => oomKills,
  });
  try {
    assert.equal((await selectRoom(relay, 'main')).status, 302);
    const r = fakeReqRes({ url: '/' });
    await relay.handle(r.req, r.res, '/');
    for (let i = 0; i < 200 && r.res.status === null; i += 1) await sleep(5);
    assert.equal(r.res.status, 502, '起不来 ⇒ 如实 502（不是 200，也不是空连接）');
    // 收掉它（SIGTERM 之后按上限 SIGKILL）
    assert.equal(kids[0].killed, true, '🔴 失败的那一台必须被收掉（不许留着赖内存）');
    await sleep(80);
    assert.equal(kids[0].exited, true, '🔴 收完要真的退出');

    // ★ **第二半：OOM 读数要能把它说具体**（读不到就一个字都不编）
    const r2 = fakeReqRes({ url: '/' });
    await relay.handle(r2.req, r2.res, '/');
    for (let i = 0; i < 200 && r2.res.status === null; i += 1) await sleep(5);
    assert.equal(r2.res.status, 502);
    // 日志里那句要带上 oom 读数（判据读的是 relay 的日志）
    const said = saidLines.join('\n');
    assert.match(said, /oom_kill 3 → 5/u, `要如实说"被系统杀过（内存不够）"：${said.slice(-300)}`);
    assert.equal(kids.length, 2, '第二次请求要再起一台（不复用失败那台）');
  } finally {
    relay.shutdown();
  }
});

// ════════════════════════════════════════════════════════════
// ★ **不许把 DSH 的注册表改成它自己读不了的东西**（2026-09-25 真机踩的）
//
// 真机读数：注册表是**那台 DSH（uid=1000）**建/读的，而写它的是**盒里那个服务（root）**。
// 原来按 `mode: 0o600` 一写 ⇒ 文件变成 `root:root 0600` ⇒ DSH 一起来就
// `EACCES: open '/data/dsh/storages/workspace.json'` ⇒ **每一间都起不来**（界面一片 502）。
// ⇒ 判据：**写完必须还是原来那个属主、原来那个权限**；换不过手 ⇒ **一个字都不许改**。
// ════════════════════════════════════════════════════════════

/** 一份冻在别处的注册表 ＋ 一个能用的假 fs。 */
function registryFixture({ mode = 0o640, uid = 12345, gid = 12345 } = {}) {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-dev-reg-own-'));
  nodeFs.mkdirSync(nodePath.join(dir, 'storages'), { recursive: true });
  const file = workspaceRegistryPath(dir);
  const raw = JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['w0'], archivedSessionIds: [] },
    tables: { workspaces: { w0: { path: '/somewhere/else', title: 'else', sessionIds: [] } } },
  });
  nodeFs.writeFileSync(file, raw, { mode });
  const calls = { chown: [], chmod: [] };
  const fs = {
    readFileSync: (...a) => nodeFs.readFileSync(...a),
    writeFileSync: (...a) => nodeFs.writeFileSync(...a),
    renameSync: (...a) => nodeFs.renameSync(...a),
    unlinkSync: (...a) => nodeFs.unlinkSync(...a),
    existsSync: (...a) => nodeFs.existsSync(...a),
    realpathSync: (p) => {
      try {
        return nodeFs.realpathSync(p);
      } catch {
        return String(p);
      }
    },
    statSync: () => ({ mode, uid, gid }),
    chownSync: (p, u, g) => {
      calls.chown.push([nodePath.basename(p), u, g]);
    },
    chmodSync: (p, m) => {
      calls.chmod.push([nodePath.basename(p), m]);
    },
  };
  return { dir, file, raw, fs, calls };
}

test('★ 写注册表：**属主与权限照原样**（换到临时文件上再改名 —— 先换手、后改名）', () => {
  const { dir, file, fs, calls } = registryFixture({ mode: 0o640, uid: 12345, gid: 12345 });
  const r = ensureRoomRegistered({ dshHome: dir, cwd: '/data/workspaces/other', fs, apply: true });
  assert.equal(r.changed, true, r.why);
  // ① 换手换在**临时文件**上（不是先把坏的盖上去再补救）
  assert.equal(calls.chown.length, 1, '要 chown 一次');
  assert.match(calls.chown[0][0], /^workspace\.json\.tmp-/u, '🔴 必须换在**临时文件**上（先换手、后改名）');
  assert.deepEqual(calls.chown[0].slice(1), [12345, 12345], '换回**原来那个属主**');
  assert.equal(calls.chmod.length, 1, '权限也要照原样');
  assert.equal(calls.chmod[0][1], 0o640, '🔴 权限不许写死成 0600');
  // ② 盘上真的改了（`initialized:false`）＋ 没有一个 `.tmp-` 留在那儿
  const after = JSON.parse(nodeFs.readFileSync(file, 'utf8'));
  assert.equal(after.global.initialized, false);
  assert.equal(
    nodeFs.readdirSync(nodePath.join(dir, 'storages')).filter((n) => n.includes('.tmp-')).length,
    0,
    '临时文件不许留着',
  );
  nodeFs.rmSync(dir, { recursive: true, force: true });
});

test('★ 换不过手（chown 失败）⇒ **原文一个字节都不许改**，而且如实说', () => {
  const { dir, file, raw, fs } = registryFixture();
  fs.chownSync = () => {
    throw new Error('EPERM: operation not permitted');
  };
  const r = ensureRoomRegistered({ dshHome: dir, cwd: '/data/workspaces/other', fs, apply: true });
  assert.equal(r.changed, false, '换不过手 ⇒ 不许说"改好了"');
  assert.match(r.why, /一个字节都没动/u, '要如实说一句');
  assert.equal(nodeFs.readFileSync(file, 'utf8'), raw, '🔴 原文必须原样');
  assert.equal(
    nodeFs.readdirSync(nodePath.join(dir, 'storages')).filter((n) => n.includes('.tmp-')).length,
    0,
    '临时文件要清掉',
  );
  nodeFs.rmSync(dir, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════
// 🔴 我们那一层 SDK server patch **不许** inject `sdkAppStartup`（2026-09-26 真机）
//
// 只有 `sdk` profile 有 `sdkAppStartup`（它是那个 app 的启动标记）。而**开发者入口
// 那台是 `--profile web`、挂的是同一套 patch**（契约 109 §七）⇒ 在 web profile 里
// 那个条目会**永远 pending** ⇒ DSH 当场：
//   `dsh: plugin tree failed to load: dsh: 1 entry did not activate … pending (waiting for service: sdkAppStartup)`
// ⇒ 那台 `dsh web` 打印完端口就死 ⇒ 开发者入口一片 502（真机读数，见 `110` §八·补）。
// ⇒ 判据：那份 yml 里**不许**有 `- sdkAppStartup`；`- loader` 必须在（`initialize` 要它）。
// ════════════════════════════════════════════════════════════
test('🔴 那一层 patch：inject 只有 `loader`，**没有** `sdkAppStartup`（否则开发者入口那台 web 起不来）', () => {
  const yml = nodeFs.readFileSync(
    nodePath.resolve(import.meta.dirname, '..', 'hupo-sdk-server.yml'),
    'utf8',
  );
  // ⚠️ 注释里当然会提到这个名字（那是在解释"为什么不能加"）⇒ 只看**没被注释掉的行**
  const live = yml.split('\n').filter((l) => !l.trim().startsWith('#'));
  assert.equal(
    live.some((l) => /^\s*-\s*sdkAppStartup\s*$/u.test(l)),
    false,
    '🔴 不许 inject `sdkAppStartup`：web profile 里没有这个服务 ⇒ 条目永远 pending ⇒ 入口 502',
  );
  assert.equal(
    live.some((l) => /^\s*-\s*loader\s*$/u.test(l)),
    true,
    '`loader` 必须在（`initialize` 里要 `loader.await()`）',
  );
  assert.match(yml, /disabled: true/u, '官方那支（只 create、不能 resume）必须关掉');
});
