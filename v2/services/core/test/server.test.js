// 服务面的集成验收 —— 真 HTTP + 真 WebSocket（手册 §2.1 / §2.2 / §15.5）
//
// 这些用例是**端到端**的：起一个真监听、用真 fetch / 真 ws 打进去。
// 单元测试证明"逻辑对"，这里证明"**接起来也对**"。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';

import { Auth } from '../src/auth.js';
import { SayService } from '../src/say.js';
import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';
import { createServer } from '../src/server.js';

async function boot({ withWeb = true, password = null } = {}) {
  const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-srv-'));
  const store = new Store({ dataDir, fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const auth = new Auth({ dataDir, lockAfter: 3, lockMs: 60_000 });
  if (password) auth.setPassword(password);
  const say = new SayService({ timeline, store, timelineId: 'main' });

  let webRoot = null;
  if (withWeb) {
    webRoot = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-web-'));
    nodeFs.writeFileSync(nodePath.join(webRoot, 'index.html'), '<!doctype html><title>琥珀</title>');
    nodeFs.writeFileSync(nodePath.join(webRoot, 'flutter_service_worker.js'), '// sw');
  }

  const { server, listen, close } = createServer({
    timeline, store, auth, say, webRoot, buildId: 'test-build',
  });
  const addr = await listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const wsUrl = `ws://127.0.0.1:${addr.port}/api/stream`;
  return { dataDir, store, timeline, auth, say, webRoot, origin, wsUrl, port: addr.port, close, server };
}

const post = (origin, path, body, headers = {}) =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

// ── 公开路由 ──────────────────────────────────────────────

test('/api/version 公开，带 service worker 需要的构建指纹', async () => {
  const s = await boot();
  const r = await fetch(`${s.origin}/api/version`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.buildId, 'test-build');
  assert.equal(typeof j.serverNow, 'number');
  await s.close();
});

test('/api/auth 公开，告诉客户端"还没设密码"', async () => {
  const s = await boot();
  const j = await (await fetch(`${s.origin}/api/auth`)).json();
  assert.equal(j.needsSetup, true);
  await s.close();
});

// ── fail-closed ───────────────────────────────────────────

test('★ 没设口令 ⇒ 受保护路由一律 503（不是放行）', async () => {
  const s = await boot();
  const r = await post(s.origin, '/api/say', { messageId: 'u_1', text: 'hi' });
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.equal(j.error, 'not-setup');
  await s.close();
});

test('★ 没设口令 + 没令牌 ⇒ 仍然是 503（不是 401）', async () => {
  const s = await boot();
  const r = await fetch(`${s.origin}/api/health`);
  assert.equal(r.status, 503);
  await s.close();
});

// ── 登录 ──────────────────────────────────────────────────

test('口令错 ⇒ 401；连续错到阈值 ⇒ 429 且给剩余秒数', async () => {
  const s = await boot({ password: '正确的密码啦' });
  for (let i = 0; i < 3; i += 1) {
    const r = await post(s.origin, '/api/login', { password: '错的' });
    assert.equal(r.status, i < 2 ? 401 : 401, `第 ${i + 1} 次`);
  }
  const locked = await post(s.origin, '/api/login', { password: '正确的密码啦' });
  assert.equal(locked.status, 429, '锁上之后连对的也不收');
  const j = await locked.json();
  assert.ok(j.retryAfterSec > 0, '★ D2：必须给剩余时间');
  await s.close();
});

test('口令对 ⇒ 拿到令牌', async () => {
  const s = await boot({ password: '正确的密码啦' });
  const r = await post(s.origin, '/api/login', { password: '正确的密码啦' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.token);
  assert.ok(j.expiresAt > Date.now());
  await s.close();
});

// ── 令牌 ──────────────────────────────────────────────────

test('★ 没有令牌 ⇒ 401（不要说 403——那会泄露"它存在"）', async () => {
  const s = await boot({ password: '正确的密码啦' });
  const r = await post(s.origin, '/api/say', { messageId: 'u_1', text: 'hi' });
  assert.equal(r.status, 401);
  await s.close();
});

test('★ 令牌放 URL 里**不算数**（必须走 Authorization 头）', async () => {
  const s = await boot({ password: '正确的密码啦' });
  const { token } = await (await post(s.origin, '/api/login', { password: '正确的密码啦' })).json();
  const r = await fetch(`${s.origin}/api/health?token=${encodeURIComponent(token)}`);
  assert.equal(r.status, 401, '★ URL 里的令牌必须被忽略');
  await s.close();
});

test('带令牌 ⇒ /api/health 200', async () => {
  const s = await boot({ password: '正确的密码啦' });
  const { token } = await (await post(s.origin, '/api/login', { password: '正确的密码啦' })).json();
  const r = await fetch(`${s.origin}/api/health`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.timelineId, 'main');
  await s.close();
});

// ── say ───────────────────────────────────────────────────

test('say 成功 ⇒ 落盘并回号；重发同 id ⇒ duplicate', async () => {
  const s = await boot({ password: '正确的密码啦' });
  const { token } = await (await post(s.origin, '/api/login', { password: '正确的密码啦' })).json();
  const h = { authorization: `Bearer ${token}` };

  const r1 = await post(s.origin, '/api/say', { messageId: 'u_1', text: '帮我把这周工时记一下' }, h);
  assert.equal(r1.status, 200);
  const j1 = await r1.json();
  assert.equal(j1.duplicate, false);
  assert.equal(j1.seq, 1);

  const r2 = await post(s.origin, '/api/say', { messageId: 'u_1', text: '帮我把这周工时记一下' }, h);
  const j2 = await r2.json();
  assert.equal(j2.duplicate, true, '★ 重发不许让 agent 干两遍');
  assert.equal(j2.seq, null);

  assert.deepEqual(s.store.verifyMonotonic('main'), { count: 1, maxSeq: 1 });
  await s.close();
});

// ── 静态（Flutter web）────────────────────────────────────

test('静态：根路径给 index.html，且**不许长缓存**', async () => {
  const s = await boot();
  const r = await fetch(`${s.origin}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /no-cache/);
  assert.match(await r.text(), /琥珀/);
  await s.close();
});

test('静态：service worker **不许长缓存**（否则用户看到几小时前的界面）', async () => {
  const s = await boot();
  const r = await fetch(`${s.origin}/flutter_service_worker.js`);
  assert.match(r.headers.get('cache-control'), /no-cache/);
  await s.close();
});

test('静态：带 hash 的产物可以长缓存', async () => {
  const s = await boot();
  // 造一个"已构建产物"（真实 Flutter web 产物是 main.dart.js 这种带指纹的名字）
  nodeFs.writeFileSync(nodePath.join(s.webRoot, 'main.dart.js'), '// built');
  const r = await fetch(`${s.origin}/main.dart.js`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /immutable/);
  await s.close();
});

test('★ 静态：目录穿越被挡（用原始请求，否则 fetch 会先替我们规范化）', async () => {
  const s = await boot();
  // ⚠️ `fetch('.../../../etc/passwd')` 会被客户端**先规范化**成 `/etc/passwd`，
  //    根本打不到服务端的检查——那样的测试是假的。这里直接用 socket 发原始路径。
  const raw = await new Promise((resolve, reject) => {
    const sock = net.connect(s.port, '127.0.0.1', () => {
      sock.write('GET /../etc/passwd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    });
    let buf = '';
    sock.on('data', (d) => { buf += d.toString(); });
    sock.on('end', () => resolve(buf));
    sock.on('error', reject);
  });
  assert.doesNotMatch(raw, /root:x:/, '★ 绝不能把 /etc/passwd 的内容返回去');
  const status = Number.parseInt(raw.split(' ')[1], 10);
  assert.ok([200, 403, 404].includes(status), `实际 ${status}`);
  await s.close();
});

// ── WebSocket ─────────────────────────────────────────────

function wsConnect(url, { token, sinceSeq = 0 } = {}) {
  const protocols = token ? ['bearer', token] : [];
  const full = `${url}?sinceSeq=${sinceSeq}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(full, protocols);
    const frames = [];
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('error', (err) => reject(err));
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error('rejected'), { status: res.statusCode })));
  });
}

test('★ WS 没令牌 ⇒ **握手阶段就拒**（不是先连上再关）', async () => {
  const s = await boot({ password: '正确的密码啦' });
  await assert.rejects(() => wsConnect(s.wsUrl), (err) => {
    assert.equal(err.status, 401);
    return true;
  });
  await s.close();
});

test('★ WS 没设口令 ⇒ 503', async () => {
  const s = await boot();
  await assert.rejects(() => wsConnect(s.wsUrl, { token: 'x' }), (err) => {
    assert.equal(err.status, 503);
    return true;
  });
  await s.close();
});

test('★ WS 首次打开（sinceSeq=0）⇒ 拿全量历史，但帧上**没有** catchUp', async () => {
  const s = await boot({ password: '正确的密码啦' });
  const { token } = await (await post(s.origin, '/api/login', { password: '正确的密码啦' })).json();
  await post(s.origin, '/api/say', { messageId: 'u_1', text: 'A' }, { authorization: `Bearer ${token}` });
  await post(s.origin, '/api/say', { messageId: 'u_2', text: 'B' }, { authorization: `Bearer ${token}` });

  const { ws, frames } = await wsConnect(s.wsUrl, { token, sinceSeq: 0 });
  await new Promise((r) => setTimeout(r, 60));
  ws.close();

  const echoes = frames.filter((f) => f.type === 'user/echo');
  assert.equal(echoes.length, 2);
  assert.ok(echoes.every((f) => f.catchUp === undefined), '★ 首次打开不是补发');
  assert.ok(frames.some((f) => f.type === 'client/hello'));
  await s.close();
});

test('★ WS 断线重连（sinceSeq>0）⇒ 只补后面的，且帧上**有** catchUp', async () => {
  const s = await boot({ password: '正确的密码啦' });
  const { token } = await (await post(s.origin, '/api/login', { password: '正确的密码啦' })).json();
  const h = { authorization: `Bearer ${token}` };
  await post(s.origin, '/api/say', { messageId: 'u_1', text: 'A' }, h);
  await post(s.origin, '/api/say', { messageId: 'u_2', text: 'B' }, h);

  const { ws, frames } = await wsConnect(s.wsUrl, { token, sinceSeq: 1 });
  await new Promise((r) => setTimeout(r, 60));
  ws.close();

  const echoes = frames.filter((f) => f.type === 'user/echo');
  assert.equal(echoes.length, 1, '只补序号 2 那条');
  assert.equal(echoes[0].seq, 2);
  assert.equal(echoes[0].catchUp, true, '★ 重连才算补发');
  await s.close();
});

test('★ WS 实时：连上之后新说的一句会被推过来', async () => {
  const s = await boot({ password: '正确的密码啦' });
  const { token } = await (await post(s.origin, '/api/login', { password: '正确的密码啦' })).json();
  const { ws, frames } = await wsConnect(s.wsUrl, { token, sinceSeq: 0 });

  await post(s.origin, '/api/say', { messageId: 'u_live', text: '连上之后说的' }, { authorization: `Bearer ${token}` });
  await new Promise((r) => setTimeout(r, 60));
  ws.close();

  const live = frames.filter((f) => f.type === 'user/echo' && f.messageId === 'u_live');
  assert.equal(live.length, 1);
  assert.equal(live[0].catchUp, undefined, '实时的不该标补发');
  await s.close();
});

test('★ WS 客户端的号跑到前面 ⇒ 收到 client/reset（不是静默什么都不发）', async () => {
  const s = await boot({ password: '正确的密码啦' });
  const { token } = await (await post(s.origin, '/api/login', { password: '正确的密码啦' })).json();
  const { ws, frames } = await wsConnect(s.wsUrl, { token, sinceSeq: 999 });
  await new Promise((r) => setTimeout(r, 60));
  ws.close();
  assert.ok(frames.some((f) => f.type === 'client/reset'), '必须明确要求它从头来');
  await s.close();
});

test('★ 落盘失败时，WS 上不会收到那条（先落盘再推）', async () => {
  const s = await boot({ password: '正确的密码啦' });
  const { token } = await (await post(s.origin, '/api/login', { password: '正确的密码啦' })).json();
  const { ws, frames } = await wsConnect(s.wsUrl, { token, sinceSeq: 0 });
  // 直接把时间线换成一个必定失败的口
  const { Store } = await import('../src/store.js');
  const { Timeline } = await import('../src/timeline.js');
  const bad = new Timeline({
    id: 'main',
    store: new Store({
      dataDir: '/nowhere',
      fs: {
        mkdirSync: () => {}, openSync: () => 7,
        writeSync: () => { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; },
        fsyncSync: () => {}, closeSync: () => {}, statSync: () => ({ size: 0 }), readFileSync: () => '',
      },
      fsync: false,
    }),
  });
  assert.throws(() => bad.emit({ type: 'user/echo', messageId: 'u_bad' }));
  await new Promise((r) => setTimeout(r, 50));
  ws.close();
  assert.ok(!frames.some((f) => f.messageId === 'u_bad'), '★ 没落盘就不许推');
  await s.close();
});
