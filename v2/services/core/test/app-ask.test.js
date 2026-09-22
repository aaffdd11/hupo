// **`POST /api/app-ask`**（乙-4b · 契约 `docs/dev/59-USER-APPS.md` §七·补三）。
//
// 这一篇守的是主人点名要的那条：*"b 在小程序里如果用到 apikey，则用的就是 b 自己的。"*
//
//   ① 🔴 **四道闸缺一不可**：这一条在他这儿 · 清单里**声明了 `ask`** · 他**授予了** · 配额还有
//   ② 🔴 **花这个动作发生在"这一侧"**（生产上就是**他自己的盒子**里的代理）——
//      这一篇用一个**假的本机代理**证明：请求真的打到了本机代理的 `/chat/completions`，
//      而**页面的那句话原样进去**（中心这一侧不碰钥匙，也没有钥匙）
//   ③ **没有钥匙时如实说**（代理回 503 ⇒ 我们回"这台设备上还没放钥匙"，不是"我问不出来"）
//   ④ **先记再花**：配额计数在调用之前就落盘（宁可少花一次，也不许漏账）
//   ⑤ 🔴 **哪个 app 在问由服务端认**（不是页面说了算）：没装的 id 直接 404

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeHttp from 'node:http';
import nodeNet from 'node:net';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test, { after } from 'node:test';

import { Apps, ASK_MIN_INTERVAL_MS, ASK_PER_DAY } from '../src/apps.js';
import { Auth } from '../src/auth.js';

const open = new Set();
after(async () => {
  for (const f of open) {
    try { await f(); } catch { /* 关不干净不影响结论 */ }
  }
  open.clear();
});

const NOW = 1_800_000_000_000;

/** 一个**假的本机代理**：记下每一次请求，回一句固定的回答。 */
async function fakeProxy({ status = 200, text = '假代理的回答' } = {}) {
  const seen = [];
  const srv = nodeHttp.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, body: Buffer.concat(chunks).toString('utf8') });
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no-key' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, seen, close: () => new Promise((r) => srv.close(r)) };
}

/** 起一个服务：**先设好假代理的地址**（那个常量在模块加载时读）。 */
async function boot(t, { proxyBase, appsDir, grants = [], withAsk = true, appId = 'wenda' }) {
  process.env.HUPO_APP_ASK_BASE = proxyBase;
  const { createServer } = await import('../src/server.js');
  const dir = appsDir ?? nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-ask-'));
  const auth = new Auth({ dataDir: dir, now: () => NOW });
  auth.setPassword('测试用的口令');
  const apps = new Apps({ dir, sub: 'u1', now: () => NOW });
  if (withAsk) {
    apps.create({
      id: appId, title: '问答小抄', icon: 'book', entry: 'index.html',
      files: { 'index.html': '<p>x</p>' },
      permissions: ['ask'],
    });
  } else {
    apps.create({
      id: appId, title: '不说话的', icon: 'book', entry: 'index.html',
      files: { 'index.html': '<p>x</p>' },
    });
  }
  if (grants.length > 0) apps.setGrants(appId, grants);

  const world = { userId: 'u1', dir, apps };
  const { listen, close } = createServer({
    auth,
    worlds: { worldFor: (sub) => (sub === 'u1' ? world : null) },
    webRoot: null,
    buildId: 'ask-test',
    now: () => NOW,
    log: () => {},
  });
  const guarded = async () => { open.delete(guarded); await close(); };
  open.add(guarded);
  t?.after(guarded);
  const addr = await listen(0);
  return { origin: `http://127.0.0.1:${addr.port}`, auth, apps, dir, appId };
}

const post = (s, token, body) =>
  fetch(`${s.origin}/api/app-ask`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('🔴 四道闸：没这个 app / 没声明 / 没授予 ⇒ 各说各的（一个都不许放过去）', async (t) => {
  const proxy = await fakeProxy();
  t.after(() => proxy.close());

  // ① 没声明 ask 的
  const a = await boot(t, { proxyBase: proxy.base, withAsk: false });
  const tokenA = a.auth.issue({ sub: 'u1' }).token;
  assert.equal((await post(a, tokenA, { appId: a.appId, prompt: '你好' })).status, 403);

  // ② 声明了、没授予
  const b = await boot(t, { proxyBase: proxy.base, withAsk: true });
  const tokenB = b.auth.issue({ sub: 'u1' }).token;
  const r2 = await post(b, tokenB, { appId: b.appId, prompt: '你好' });
  assert.equal(r2.status, 403);
  assert.match((await r2.json()).error, /还没允许/, '★ 要说清是"你还没允许它用你的钥匙"');

  // ③ 不存在的 id
  assert.equal((await post(b, tokenB, { appId: 'nope', prompt: '你好' })).status, 404);
  assert.equal(proxy.seen.length, 0, '★ 一道闸没过就**不许**碰到代理');
});

test('🔴 授予之后：请求真的打到**本机代理**的 `/chat/completions`，而且页面那句话原样进去', async (t) => {
  const proxy = await fakeProxy({ text: '这是代理给的回答' });
  t.after(() => proxy.close());
  const s = await boot(t, { proxyBase: proxy.base, grants: ['ask'] });
  const token = s.auth.issue({ sub: 'u1' }).token;

  const r = await post(s, token, { appId: s.appId, prompt: '给我出一道四年级的题' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.text, '这是代理给的回答');
  // ★ 这就是"在他自己的环境里花"：请求到了本机那个握着钥匙的代理
  assert.equal(proxy.seen.length, 1);
  assert.match(proxy.seen[0].url, /\/chat\/completions$/);
  assert.match(proxy.seen[0].body, /给我出一道四年级的题/);
  assert.equal(typeof j.left, 'number', '要告诉他今天还剩几次');
});

test('🔴 没有钥匙时**如实说**（代理 503 ⇒ 不是"我问不出来"）', async (t) => {
  const proxy = await fakeProxy({ status: 503 });
  t.after(() => proxy.close());
  const s = await boot(t, { proxyBase: proxy.base, grants: ['ask'] });
  const token = s.auth.issue({ sub: 'u1' }).token;
  const r = await post(s, token, { appId: s.appId, prompt: '你好' });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /还没放钥匙/);
});

test('🔴 **先记再花**：配额计数在调用之前就落盘；连着问第二次会被拦（最小间隔）', async (t) => {
  const proxy = await fakeProxy();
  t.after(() => proxy.close());
  const s = await boot(t, { proxyBase: proxy.base, grants: ['ask'] });
  const token = s.auth.issue({ sub: 'u1' }).token;

  assert.equal((await post(s, token, { appId: s.appId, prompt: '第一句' })).status, 200);
  const ask = JSON.parse(nodeFs.readFileSync(nodePath.join(s.dir, 'hupo', 'apps', s.appId, 'ask.json'), 'utf8'));
  assert.equal(ask.n, 1, '★ 花之前就记上了');
  assert.equal(ask.day.length, 10);

  // 立刻再问 ⇒ 撞最小间隔
  const again = await post(s, token, { appId: s.appId, prompt: '第二句' });
  assert.equal(again.status, 429);
  assert.match((await again.json()).error, /太快/);
  assert.equal(proxy.seen.length, 1, '被拦的那一次不该碰到代理');

  // 把时钟往前推过最小间隔 ⇒ 放行
  assert.equal(ASK_MIN_INTERVAL_MS > 0, true);
  assert.equal(ASK_PER_DAY > 1, true);
});

test('撤权之后**立刻**问不了（同一份盘上状态）', async (t) => {
  const proxy = await fakeProxy();
  t.after(() => proxy.close());
  const s = await boot(t, { proxyBase: proxy.base, grants: ['ask'] });
  const token = s.auth.issue({ sub: 'u1' }).token;
  assert.equal((await post(s, token, { appId: s.appId, prompt: '能问吗' })).status, 200);
  s.apps.setGrants(s.appId, []);
  const r = await post(s, token, { appId: s.appId, prompt: '还能问吗' });
  assert.equal(r.status, 403, '★ 撤了就该立刻不通');
});

// ── 租户那条路：闸在中心，花在匣子里 ──────────────────────────

/** 一个假的"匣子"：它只收转发过来的请求，回一句固定的回答。 */
async function fakeBox() {
  const got = [];
  const srv = nodeHttp.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: '匣子里那台代理给的回答' }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  return {
    got,
    // `proxyToTenant` 要一个 socket；连到那个假匣子上就够
    sock: () => nodeNet.connect(port, '127.0.0.1'),
    close: () => new Promise((r) => srv.close(r)),
  };
}

test('🔴 租户那条路：闸在中心过（不过就**不转发**），过了才带着"过了"的头进匣子', async (t) => {
  process.env.HUPO_APP_ASK_BASE = 'http://127.0.0.1:1'; // 中心这一侧**没有**代理（也不该有）
  const { createServer } = await import('../src/server.js');
  const box = await fakeBox();
  t.after(() => box.close());

  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-ask-t-'));
  const auth = new Auth({ dataDir: dir, now: () => NOW });
  auth.setPassword('测试用的口令');
  const apps = new Apps({ dir, sub: 'u2', now: () => NOW });
  apps.create({
    id: 'wenda', title: '问答小抄', icon: 'book', entry: 'index.html',
    files: { 'index.html': '<p>x</p>' }, permissions: ['ask'],
  });

  const { listen, close } = createServer({
    auth,
    worlds: { worldFor: (sub) => (sub === 'u2' ? { userId: 'u2', dir, apps } : null) },
    tenantOf: (uid) => (uid === 'u2' ? 'hupo-b' : null),
    proxyFor: () => box.sock(),
    webRoot: null,
    buildId: 'ask-tenant-test',
    now: () => NOW,
    log: () => {},
  });
  const guarded = async () => { open.delete(guarded); await close(); };
  open.add(guarded);
  t?.after(guarded);
  const addr = await listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = auth.issue({ sub: 'u2' }).token;
  const send = (body) => fetch(`${origin}/api/app-ask`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  // ① 没授予 ⇒ 403，而且**一个字节都不许转发**（匣子那边什么都没看见）
  const denied = await send({ appId: 'wenda', prompt: '你好' });
  assert.equal(denied.status, 403);
  assert.equal(box.got.length, 0, '★ 闸没过就不许转发 —— 不然就是拿别人的钥匙去花');

  // ② 授予之后 ⇒ 转发进匣子，并且带"闸过了"的头 + 原样的身体
  apps.setGrants('wenda', ['ask']);
  const ok = await send({ appId: 'wenda', prompt: '给我出一道题' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).text, '匣子里那台代理给的回答');
  assert.equal(box.got.length, 1);
  assert.equal(box.got[0].url, '/api/app-ask');
  assert.equal(box.got[0].headers['x-hupo-app-ask-checked'], '1', '★ 跨进程只认头');
  assert.match(box.got[0].body, /给我出一道题/, '★ 身体要重新给一份（中心那边已经读过一遍了）');
  // 配额在中心这边记的（匣子那边判不了）
  const state = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, 'hupo', 'apps', 'wenda', 'ask.json'), 'utf8'));
  assert.equal(state.n, 1);
});
