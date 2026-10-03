// **`ask` 那条口搬到了 app 原点**（契约 `docs/dev/148-APP-FULL-SET.md` §一）。
//
// ── 为什么要它（主人 2026-09-30：「这些功能都要有」）────────────────
//   原来 `ask` 只走**壳的桥**（制品 `postMessage` → 壳 → 服务端）⇒ **只有网页那一侧有**；
//   安卓那一侧**不许装桥**（铁律 3）⇒ **平板上问不了话**。
//   ⇒ 现在制品**对它自己那个源**发一次请求（和存东西 `/db` **同一个形状**）：
//     **两端都通**，而且**不再依赖壳**。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   · **K1** 真起一个 app 原点：入口签名 → `POST /ask` ⇒ **200 ＋ 回答**（真的过了一次代理）；
//   · **K2** 拿回的那张票能接着用（页面开着的时候不再反复出示入口签名）；
//   · **K3** 没凭据 ⇒ 403（而且不是 500）；别的 POST 照旧 405；OPTIONS 预检答得上；
//   · **K4** 🔴 **闸还是那道闸**：没声明 `ask` ⇒ 403（"没说要问话"）；
//     **他关掉了** ⇒ 403（"还没允许"）——**一次都不许打到代理**；
//   · **K5** 🔴 **配额照记**（`ask.json`）：问一次记一次，而且**记在它自己那一格里**；
//   · **K6** 这条口没接线（`askApp: null`）⇒ **503 ＋"还没跟上"**（不许说成"你不许问"）。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeHttp from 'node:http';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';

import { Apps } from '../src/apps.js';
import { createAppServer, entryUrl } from '../src/app-serve.js';

const KEY = Buffer.from('a'.repeat(64), 'hex');
const NOW = 1_800_000_000_000;

function tmpdir() {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-ask-'));
}

/** 一个**假的本机小代理**（照 `app-ask.test.js`）：记下每一次请求，回一句固定的话。 */
async function fakeProxy({ text = '代理给的回答', usage = null } = {}) {
  const seen = [];
  const srv = nodeHttp.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: text } }],
          ...(usage ? { usage } : {}),
        }),
      );
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${srv.address().port}`,
    seen,
    close: () => new Promise((r) => srv.close(r)),
  };
}

/** 起一个 app 原点。`askApp` 由调用方给（或故意不给 —— K6）。 */
function startAppOrigin({ apps, askApp }) {
  const server = createAppServer({
    resolveApps: () => apps,
    key: KEY,
    frameAncestors: 'https://w.example',
    askApp,
    // ★ **`A3`：URL 上不带人 ⇒ 这个测试世界里"可能的人"只有 u1**
    subsOf: () => ['u1'],
    now: () => NOW,
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/**
 * ★ **起一台真服务，并把它那条 `askApp` 接到一个 app 原点上**。
 *
 * 🔴 这一条是刻意的：**闸（声明 → 允许 → 配额）用的是线上那一个**（`askForApp`），
 *    不是我在这儿重写一遍 —— 重写一遍的判据证明不了"两条口同一道闸"。
 */
async function bootReal(t, { dir, apps, proxyBase, clock = () => NOW }) {
  process.env.HUPO_APP_ASK_BASE = proxyBase;
  const { createServer } = await import('../src/server.js');
  const { Auth } = await import('../src/auth.js');
  const auth = new Auth({ dataDir: dir, now: clock });
  auth.setPassword('测试用的口令');
  const world = { userId: 'u1', dir, apps };
  const { listen, close, askApp } = createServer({
    auth,
    worlds: { worldFor: (sub) => (sub === 'u1' ? world : null) },
    webRoot: null,
    buildId: 'ask-fetch-test',
    now: clock,
    log: () => {},
  });
  t.after(async () => {
    await close();
  });
  await listen(0);
  const origin = await startAppOrigin({ apps, askApp });
  t.after(() => origin.server.close());
  return { port: origin.port };
}

function post(port, path, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': payload.length, ...headers } },
      (res) => {
        let out = '';
        res.on('data', (d) => {
          out += d;
        });
        res.on('end', () => {
          let j = null;
          try {
            j = JSON.parse(out);
          } catch {
            /* 非 JSON（405 那种） */
          }
          resolve({ status: res.statusCode, headers: res.headers, body: j, raw: out });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function signUrl(port, { id = 'wenda', version = 1, sub = 'u1' } = {}) {
  const url = entryUrl({ base: `http://127.0.0.1:${port}`, key: KEY, sub, id, version, entry: 'index.html', now: NOW });
  const q = new URLSearchParams(url.split('?')[1]);
  // ★ `A3`：入口 URL 上没有人（只有 `e`/`s`）。
  return { e: q.get('e'), s: q.get('s') };
}

test('K1/K2 真 app 原点：入口签名 ⇒ 200 ＋ 回答；那张票能接着用', async (t) => {
  const dir = tmpdir();
  const proxy = await fakeProxy({ text: '它是这么答的' });
  t.after(() => proxy.close());
  process.env.HUPO_APP_ASK_BASE = proxy.base;
  let clock = NOW;
  const apps = new Apps({ dir, sub: 'u1', now: () => clock });
  apps.register({ id: 'wenda', title: '问答', entry: 'index.html', permissions: ['ask'] });
  apps.setGrants('wenda', ['ask']);
  const { port } = await bootReal(t, { dir, apps, proxyBase: proxy.base, clock: () => clock });
  try {
    const sig = signUrl(port);
    const first = await post(port, '/ask', { id: 'wenda', v: '1', ...sig, prompt: '给我出一道题' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.ok, true);
    assert.equal(first.body.text, '它是这么答的');
    assert.equal(typeof first.body.ticket, 'string', '要顺手给一张票');
    assert.equal(proxy.seen.length, 1, '★ 真的过了一次代理');
    assert.match(proxy.seen[0].body, /给我出一道题/);

    // ★ 票能接着用（页面开着的时候不必再出示入口签名）
    //   ⚠️ 时钟往前推 4 秒：`ask` 有道"两次之间最小间隔"的闸（那是要的），
    //      原地连问两次**本来就该被拦**。
    clock += 4000;
    const second = await post(port, '/ask', { id: 'wenda', v: '1', ticket: first.body.ticket, prompt: '再来一道' });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(proxy.seen.length, 2, '★ 第二次也真的问出去了');
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('K4 闸还是那道闸：没声明 ⇒ 403；**他关掉了** ⇒ 403（一次都不许打到代理）', async (t) => {
  const dir = tmpdir();
  const proxy = await fakeProxy();
  t.after(() => proxy.close());
  process.env.HUPO_APP_ASK_BASE = proxy.base;
  const apps = new Apps({ dir, sub: 'u1', now: () => NOW });
  apps.register({ id: 'quiet', title: '不说话的', entry: 'index.html' }); // 没声明
  apps.register({ id: 'wenda', title: '问答', entry: 'index.html', permissions: ['ask'] });
  apps.setGrants('wenda', []); // ★ 他关掉了
  const { port } = await bootReal(t, { dir, apps, proxyBase: proxy.base });
  try {
    const a = await post(port, '/ask', { id: 'quiet', v: '1', ...signUrl(port, { id: 'quiet' }), prompt: '你好' });
    assert.equal(a.status, 403);
    assert.match(a.body.text, /没说要问话/, '要说清"它没说要问话"');
    const b = await post(port, '/ask', { id: 'wenda', v: '1', ...signUrl(port, { id: 'wenda' }), prompt: '你好' });
    assert.equal(b.status, 403);
    assert.match(b.body.text, /还没允许/, '要说清"你还没允许"');
    assert.equal(proxy.seen.length, 0, '🔴 闸没过就**一个字节都不许**打到代理');
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('K5 配额照记：问一次记一次，而且记在**它自己那一格**里', async (t) => {
  const dir = tmpdir();
  const proxy = await fakeProxy({ text: '好' });
  t.after(() => proxy.close());
  process.env.HUPO_APP_ASK_BASE = proxy.base;
  let clock = NOW;
  const apps = new Apps({ dir, sub: 'u1', now: () => clock });
  apps.register({ id: 'wenda', title: '问答', entry: 'index.html', permissions: ['ask'] });
  apps.setGrants('wenda', ['ask']);
  const { port } = await bootReal(t, { dir, apps, proxyBase: proxy.base, clock: () => clock });
  try {
    await post(port, '/ask', { id: 'wenda', v: '1', ...signUrl(port), prompt: '一' });
    clock += 4000; // 隔开（不然撞那道"问得太快了" —— 它该拦）
    await post(port, '/ask', { id: 'wenda', v: '1', ...signUrl(port), prompt: '二' });
    const st = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, 'hupo', 'apps', 'wenda', 'ask.json'), 'utf8'));
    assert.equal(st.n, 2, '★ 两次都要记上（先记再花）');
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('K3 没凭据 ⇒ 403；别的 POST 照旧 405；预检答得上', async (t) => {
  const dir = tmpdir();
  const proxy = await fakeProxy();
  t.after(() => proxy.close());
  const apps = new Apps({ dir, sub: 'u1', now: () => NOW });
  apps.register({ id: 'wenda', title: '问答', entry: 'index.html', permissions: ['ask'] });
  apps.setGrants('wenda', ['ask']);
  // 这一条量的是**这条口自己的那几道**（凭据 / 方法 / 预检）⇒ `askApp` 给不给都不影响
  const { server, port } = await startAppOrigin({ apps, askApp: null });
  try {
    const bad = await post(port, '/ask', { id: 'wenda', v: '1', prompt: '你好' });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers['access-control-allow-origin'], '*', '不透明源那一侧要它');
    const elsewhere = await post(port, '/a/wenda/1/index.html', {});
    assert.equal(elsewhere.status, 405, '这条口**只有 /db 与 /ask**');
    const pre = await new Promise((resolve, reject) => {
      const req = nodeHttp.request(
        { host: '127.0.0.1', port, path: '/ask', method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'POST' } },
        (r) => {
          r.resume();
          resolve({ status: r.statusCode, headers: r.headers });
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-methods'], 'POST');
    assert.equal(proxy.seen.length, 0, '被拒的那几条一个字都不许花');
  } finally {
    server.close();
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('K6 这条口没接线 ⇒ **503 ＋"还没跟上"**（不许说成"你不许问"）', async (t) => {
  const dir = tmpdir();
  const apps = new Apps({ dir, sub: 'u1', now: () => NOW });
  apps.register({ id: 'wenda', title: '问答', entry: 'index.html', permissions: ['ask'] });
  apps.setGrants('wenda', ['ask']);
  const { server, port } = await startAppOrigin({ apps, askApp: null });
  try {
    const r = await post(port, '/ask', { id: 'wenda', v: '1', ...signUrl(port), prompt: '你好' });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'not-ready');
    assert.match(r.body.text, /还没跟上/, '「这一台还没有这个能力」和「你不许问」是两件事');
  } finally {
    server.close();
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});
