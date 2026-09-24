// **`/api/harness` 那道闸门** —— 判据 **H1（公网口一律拒）** 与 **H2（没令牌就拒）**。
//
// 这一份打的是**真 HTTP + 真 WebSocket + 真 UDS**（和 `asr.test.js` 同一个做法）：
// 闸门这种东西，只有"从真的那个口连一次"才算验过。
//
// ── 两个入口，一个字都不许记混 ────────────────────────────────
//   · **公网口**（`server.on('upgrade', …, false)`）：要令牌；**盒子那台 DSH 不在这儿**。
//     有租户的人从这儿进来 ⇒ **原样转进他自己的盒子**（`proxyUpgrade`）。
//     走到它还没租户可转的（主人 / 盒子自己的 `0.0.0.0:8080`）⇒ **拒**（H1）。
//   · **可信口**（容器里那条 `0600` UDS · 选项甲 · `trusted === true`）：
//     身份**由内核保证**（谁能开那个文件谁才是隧道代理）⇒ 不查令牌，这才是接 DSH 的那条。
//
// 判据出处：`docs/dev/81-HARNESS-ENTRY.md` §五 5.1 / §六 H1·H2。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeNet from 'node:net';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { WebSocket } from 'ws';

import { Auth } from '../src/auth.js';
import { SayService } from '../src/say.js';
import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';
import { createServer } from '../src/server.js';
import { HARNESS_PATH } from '../src/harness-session.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const openServers = new Set();
const openClients = new Set();
after(async () => {
  for (const ws of openClients) {
    try {
      ws.terminate();
    } catch {
      /* 已经断了 */
    }
  }
  await sleep(30);
  for (const s of openServers) {
    try {
      await s.close();
    } catch {
      /* 关不干净不影响结论 */
    }
  }
  openServers.clear();
  openClients.clear();
});

/**
 * 一个**记事的假中继**：只要有人接上了就 `attach`。
 * ⚠️ 判 H1 的关键不是"回没回 404"，而是"**那个中继到底有没有被接上**"——
 *    只要回 404 就绿的那种闸，把整条路删掉也能绿。
 */
function spyRelay() {
  const attached = [];
  return {
    path: HARNESS_PATH,
    attached,
    attach(ws) {
      attached.push(ws);
      try {
        ws.send(JSON.stringify({ t: 'state', s: 'booting' }));
      } catch {
        /* 已经没了 */
      }
    },
    stats: () => ({ connections: attached.length, processes: 0 }),
    shutdown: () => {},
  };
}

/**
 * 起一台服务。
 *
 * @param {object} o
 * @param {boolean} [o.password] 有没有设口令（**容器里没有** ⇒ `needsSetup`）
 * @param {object} [o.harness] 中继（默认一个记事的假中继）
 * @param {(sub:string)=>string|null} [o.tenantOf]
 * @param {Function} [o.proxyFor]
 */
async function boot({ password = true, harness = spyRelay(), tenantOf = () => null, proxyFor = null, isLocalUser = () => false } = {}) {
  const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-hroute-'));
  const store = new Store({ dataDir, fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const auth = new Auth({ dataDir });
  if (password) auth.setPassword('这一份判据用的口令');
  const say = new SayService({ timeline, store, timelineId: 'main' });
  const webRoot = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-hroute-web-'));
  nodeFs.writeFileSync(nodePath.join(webRoot, 'index.html'), '<!doctype html><title>琥珀</title>');

  const { listen, listenTrusted, close } = createServer({
    timeline,
    store,
    auth,
    say,
    webRoot,
    buildId: 'hupo-harness-route-test',
    harness,
    tenantOf,
    proxyFor,
    isLocalUser,
    trustedSub: 'owner',
  });
  const addr = await listen(0);
  const sock = nodePath.join(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-hroute-sock-')), 'api.sock');
  await listenTrusted(sock);
  const handle = {
    wsBase: `ws://127.0.0.1:${addr.port}`,
    sock,
    auth,
    harness,
    close,
  };
  openServers.add(handle);
  return handle;
}

/** 连一次（**握手阶段的结论**才算数：不是"先连上再关"）。 */
function tryUpgrade(url, protocols = null) {
  return new Promise((resolve) => {
    // ⚠️ 空串当子协议是**非法**的（`ws` 直接抛）⇒ 没有令牌就干脆不给子协议，
    //    那正是"不带令牌"在真客户端上的样子。
    const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
    openClients.add(ws);
    ws.on('open', () => resolve({ ok: true, ws }));
    ws.on('unexpected-response', (_q, res) => {
      res.resume();
      resolve({ ok: false, status: res.statusCode });
    });
    ws.on('error', (err) => resolve({ ok: false, err: String(err.message) }));
  });
}

// ── H2：没令牌 ⇒ 拒 ──────────────────────────────────────────

test('★ H2：不带令牌升级 `/api/harness` ⇒ **握手阶段** 401（不是"先连上再关"）', async () => {
  const s = await boot();
  const r = await tryUpgrade(`${s.wsBase}${HARNESS_PATH}`);
  assert.equal(r.ok, false, '没令牌不许接上');
  assert.equal(r.status, 401);
  assert.equal(s.harness.attached.length, 0, '没验过身份**不许**碰到那个中继');
  await s.close();
});

test('★ H2：令牌是假的 ⇒ 同样 401', async () => {
  const s = await boot();
  const r = await tryUpgrade(`${s.wsBase}${HARNESS_PATH}`, ['bearer', 'not-a-real-token']);
  assert.equal(r.status, 401);
  assert.equal(s.harness.attached.length, 0);
  await s.close();
});

test('★ 别的路径照旧 404（别顺手把别的口放进来）', async () => {
  const s = await boot();
  const r = await tryUpgrade(`${s.wsBase}/api/nope`, ['bearer', s.auth.issue({ sub: 'owner' }).token]);
  assert.equal(r.status, 404);
  await s.close();
});

// ── H1：公网口一律拒 ──────────────────────────────────────────

test('🔴 H1：公网口**带着有效令牌**也拒（而可信那条接得上 —— 证明闸门认的是 `trusted`）', async () => {
  const s = await boot();
  const token = s.auth.issue({ sub: 'owner' }).token;

  // ① 公网口 + 有效令牌：**拒**（宿主上主人那一份没有盒子 ⇒ 没有那台 DSH 可给）
  const pub = await tryUpgrade(`${s.wsBase}${HARNESS_PATH}`, ['bearer', token]);
  assert.equal(pub.ok, false, '公网口不许接上 `/api/harness`');
  assert.equal(pub.status, 404);
  assert.equal(s.harness.attached.length, 0, '公网口**一次都不许**碰到那个中继（H1 的反例）');

  // ② **负向对照**：同一条路径、同一个中继，从**可信口**（内核保证身份那条）进来 ⇒ 接上
  const trusted = await tryUpgrade(`ws+unix://${s.sock}:${HARNESS_PATH}`);
  assert.equal(trusted.ok, true, '可信口才是接 DSH 的那条（少了它上面那条 404 就是"整条路没接"）');
  assert.equal(s.harness.attached.length, 1, '可信口必须真的把连接交给中继');
  await s.close();
});

test('🔴 H1：**盒子自己那个公网口**（没设口令 · `0.0.0.0:8080` 那种）⇒ 拒，中继一次都不许被接上', async () => {
  // ⚠️ 容器里**没有口令**（身份由宿主验）⇒ `needsSetup` 为真。
  //    这就是"公网口"在盒子里的真形状：谁都能连到 8080，而这条口不该服务那台 DSH。
  const s = await boot({ password: false });
  const r1 = await tryUpgrade(`${s.wsBase}${HARNESS_PATH}`);
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 503, '没设口令 ⇒ fail-closed 那一句（不是把 DSH 递出去）');
  const r2 = await tryUpgrade(`${s.wsBase}${HARNESS_PATH}`, ['bearer', 'garbage']);
  assert.equal(r2.ok, false);
  assert.equal(s.harness.attached.length, 0, '公网口一次都不许碰到中继');
  // 可信口照旧能用（宿主隧道代理就是从那一条进来的）
  const trust = await tryUpgrade(`ws+unix://${s.sock}:${HARNESS_PATH}`);
  assert.equal(trust.ok, true);
  assert.equal(s.harness.attached.length, 1);
  await s.close();
});

test('🔴 H1 的反面（不许误伤）：有租户的人从公网口连 ⇒ **原样转进他自己那台盒子**', async () => {
  // 一个"假盒子"：只把收到的**原始升级请求**记下来（字节级），然后关门。
  const got = [];
  const box = nodeNet.createServer((c) => {
    c.on('data', (b) => got.push(String(b)));
    c.on('error', () => {});
    setTimeout(() => c.destroy(), 60);
  });
  await new Promise((r) => box.listen(0, '127.0.0.1', r));
  const boxPort = box.address().port;

  const s = await boot({
    tenantOf: (sub) => (sub === 'u2' ? 'hupo-b' : null),
    proxyFor: () => nodeNet.connect(boxPort, '127.0.0.1'),
  });
  const token = s.auth.issue({ sub: 'u2' }).token;
  const r = await tryUpgrade(`${s.wsBase}${HARNESS_PATH}`, ['bearer', token]);
  // 客户端这一侧会因为"假盒子"没回 101 而失败 —— **要看的不是它**，
  // 而是"这次升级到底有没有被原样转进盒子"。
  assert.equal(r.ok, false);
  const t0 = Date.now();
  while (got.length === 0 && Date.now() - t0 < 2000) await sleep(20);
  const raw = got.join('');
  assert.ok(raw.startsWith(`GET ${HARNESS_PATH} HTTP/1.1`), `该原样转进去；实际：${raw.slice(0, 120)}`);
  assert.match(raw, /sec-websocket-protocol:\s*bearer/iu, '子协议（令牌走的那条）要原样带着');
  assert.equal(s.harness.attached.length, 0, '有租户的人**不该**落在宿主上（该进他自己那台盒子）');
  await new Promise((r2) => box.close(r2));
  await s.close();
});

// ── 那条真正的活：可信口接上之后，能不能真起一个 DSH ─────────────

test('★ 可信口接上 ⇒ 中继真的接住了这条连接（客户端拿得到 `state`）', async () => {
  let attachedOk = false;
  const relay = {
    path: HARNESS_PATH,
    attach(ws) {
      attachedOk = true;
      ws.send(JSON.stringify({ t: 'state', s: 'booting' }));
      ws.send(JSON.stringify({ t: 'state', s: 'ready' }));
    },
    stats: () => ({ connections: 1, processes: 0 }),
    shutdown: () => {},
  };
  const s = await boot({ harness: relay });
  // ⚠️ **监听要在握手之前挂上**：`attach` 里那两条是**同步**发的，
  //    等 `open` 回来再挂就会漏掉它们（客户端真跑的时候是提前挂好的）。
  const msgs = [];
  const ws = new WebSocket(`ws+unix://${s.sock}:${HARNESS_PATH}`);
  openClients.add(ws);
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  const ok = await new Promise((resolve) => {
    ws.on('open', () => resolve(true));
    ws.on('unexpected-response', (_q, res) => {
      res.resume();
      resolve(false);
    });
    ws.on('error', () => resolve(false));
  });
  assert.equal(ok, true, '可信口必须接得上');
  const t0 = Date.now();
  while (msgs.length < 2 && Date.now() - t0 < 2000) await sleep(20);
  assert.deepEqual(msgs.map((m) => m.s), ['booting', 'ready']);
  assert.equal(attachedOk, true);
  await s.close();
});
