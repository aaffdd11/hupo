// **宿主↔容器那条通道**：容器开机连出来领自己那份配置（多租户 ②-4）。
//
// 契约依据：`37-MULTITENANT.md` §12.1（那五步）· `39-PERMISSIONS.md` §5.7（"挂载表就是边界"）。
//
// ── 这一份钉四条 ──────────────────────────────────────────
//   1. **一个租户一个套接字**：身份 = "你连的是哪一个"（**不靠令牌、不靠 `SO_PEERCRED`**
//      —— 后者纯 Node 拿不到，实测见 `tenant-channel.mjs` 文件头）；
//   2. **还没有 key ⇒ 如实说 `waiting`**，而且**不许把占位符/空串当 key 发出去**；
//   3. **key 晚到**（用户过一会儿才填）⇒ 已经连着的容器**不用重连**就能拿到；
//   4. 🔴 **两边的日志里都不许出现 key**（拿真日志扫）。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeNet from 'node:net';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { CHANNEL_VERSION, TenantChannel, channelPathFor } from '../src/tenant-channel.mjs';
import { parseTenantMap } from '../src/config.js';
import { fetchKeyFromHost, watchForKey, writeKeyFile } from '../src/tenant-shell.mjs';

const REAL_KEY = 'host-must-hand-this-over-KEY';
const openClose = new Set();
after(async () => {
  for (const c of openClose) {
    try {
      await c();
    } catch {
      /* 关不干净不影响结论 */
    }
  }
  openClose.clear();
});

function tmpDir() {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-chan-'));
  openClose.add(() => nodeFs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** 起一条宿主通道（一个租户），把它的日志记下来。 */
function host({ key = null } = {}) {
  const dir = tmpDir();
  const lines = [];
  const state = { key };
  const ch = new TenantChannel({
    dir,
    keyFor: () => state.key,
    log: (m) => lines.push(m),
  });
  openClose.add(() => ch.close());
  return { ch, dir, lines, state };
}

// ── ⓪ `userId → 租户名` 那张表 ────────────────────────────

test('🔴 `HUPO_TENANT_MAP` 解析：**坏的那条丢掉，绝不猜**（猜错=甲的 key 进乙的容器）', () => {
  assert.deepEqual([...parseTenantMap('u1=hupo-a,u2=hupo-b')], [['u1', 'hupo-a'], ['u2', 'hupo-b']]);
  assert.deepEqual([...parseTenantMap('u1=hupo-a,坏的')], [['u1', 'hupo-a']], '坏条目丢掉');
  assert.deepEqual([...parseTenantMap('bad')], [], '没有等号 ⇒ 一条都不要');
  assert.deepEqual([...parseTenantMap('u1=a b')], [], '租户名要进路径 ⇒ 形状必须卡住');
  assert.deepEqual([...parseTenantMap('=hupo-a')], [], '空 userId 不要');
  assert.deepEqual([...parseTenantMap('u1=')], [], '空租户名不要');
  assert.deepEqual([...parseTenantMap(undefined)], []);
  assert.deepEqual([...parseTenantMap('')], []);
});

// ── ① 一个租户一个套接字（路径就是身份）─────────────────────

test('★ 路径：一个租户一个套接字；userId 不许当路径用（防穿越）', () => {
  assert.equal(channelPathFor('/run/x', 'u1'), '/run/x/u1.sock');
  assert.equal(channelPathFor('/run/x', 'owner'), '/run/x/owner.sock');
  for (const bad of ['../x', 'a/b', '', null, 'x'.repeat(65)]) {
    assert.throws(() => channelPathFor('/run/x', bad), /不能当文件名/, `${bad} 该被拒`);
  }
});

// ── ② 还没有 key ⇒ 如实 waiting（负向对照：有了就 ready）──────

test('🔴 宿主还没有 key ⇒ 容器收到 `waiting`，而且**不许**造出一个空的 key 文件', async () => {
  const h = host({ key: null });
  h.ch.listenFor('u1');
  const keyFile = nodePath.join(h.dir, 'creds.yaml');
  const lines = [];

  const t0 = Date.now();
  const got = await fetchKeyFromHost({
    socketPath: channelPathFor(h.dir, 'u1'),
    keyFile,
    waitMs: 0, // 立刻放弃
    // ⚠️ 总时限**要给一个"变异发生时也能被断言抓住"的值**：
    //    给 0 的话（默认是 waitMs+30s）变异会表现为"挂 30 秒"，
    //    而那种"挂住"在我的时限里看不出是红 ⇒ 变异等于没抓住。
    hardMs: 5000,
    log: (m) => lines.push(m),
  });
  const dt = Date.now() - t0;
  assert.equal(got, false, '没有 key 时必须如实说"没领到"');
  // 🔴 **必须断言"多快"**：`waiting` 那条分支要是没了，总时限兜底最终**也会**返回 false，
  //    只是要等 30 秒 —— 只断言返回值的话，**这个变异抓不住**（2026-09-21 实测）。
  assert.ok(dt < 2000, `🔴 用了 ${dt}ms —— "还没有 key"应当立刻收场，不该靠总时限兜底`);
  assert.equal(nodeFs.existsSync(keyFile), false, '🔴 不许造出一个空/占位的 key 文件');
});

test('★ 负向对照：宿主有了 key ⇒ 同一个壳就领到了（证明上面那个 false 是因为没 key）', async () => {
  const h = host({ key: REAL_KEY });
  h.ch.listenFor('u1');
  const keyFile = nodePath.join(h.dir, 'creds.yaml');
  const got = await fetchKeyFromHost({
    socketPath: channelPathFor(h.dir, 'u1'),
    keyFile,
    waitMs: 0,
    log: () => {},
  });
  assert.equal(got, true);
  const st = nodeFs.statSync(keyFile);
  assert.equal(st.mode & 0o777, 0o600, '★ 凭据必须是 0600');
  assert.match(nodeFs.readFileSync(keyFile, 'utf8'), new RegExp(REAL_KEY));
});

test('🔴 两个租户：**各自的套接字给各自的 key**（抓"都用同一个人的 key"）', async () => {
  // ⚠️ 这一条是补出来的：原来只有一个租户 ⇒ `keyFor(userId)` 写成 `keyFor('u1')`
  //    这种变异**一条都抓不住**（2026-09-21 实测）。两个租户一起才看得出来。
  const dir = tmpDir();
  const keys = { u1: 'KEY-FOR-U1', u2: 'KEY-FOR-U2' };
  const ch = new TenantChannel({ dir, keyFor: (u) => keys[u] ?? null, log: () => {} });
  ch.listenFor('u1');
  ch.listenFor('u2');
  openClose.add(() => ch.close());

  const f1 = nodePath.join(dir, 'k1.yaml');
  const f2 = nodePath.join(dir, 'k2.yaml');
  const [g1, g2] = await Promise.all([
    fetchKeyFromHost({ socketPath: channelPathFor(dir, 'u1'), keyFile: f1, log: () => {} }),
    fetchKeyFromHost({ socketPath: channelPathFor(dir, 'u2'), keyFile: f2, log: () => {} }),
  ]);
  assert.equal(g1, true);
  assert.equal(g2, true);
  const t1 = nodeFs.readFileSync(f1, 'utf8');
  const t2 = nodeFs.readFileSync(f2, 'utf8');
  assert.match(t1, /KEY-FOR-U1/);
  assert.ok(!t1.includes('KEY-FOR-U2'), `🔴 甲的套接字给了乙的 key：${t1}`);
  assert.match(t2, /KEY-FOR-U2/);
  assert.ok(!t2.includes('KEY-FOR-U1'), `🔴 乙的套接字给了甲的 key：${t2}`);
});

// ── ③ key 晚到（用户过一会儿才在网页上填）────────────────────

test('★ key **晚到**：容器连上时是 `waiting`，之后不用重连也能拿到', async () => {
  const h = host({ key: null });
  h.ch.listenFor('u1');
  const keyFile = nodePath.join(h.dir, 'creds.yaml');

  const p = fetchKeyFromHost({
    socketPath: channelPathFor(h.dir, 'u1'),
    keyFile,
    waitMs: 10_000,
    retryMs: 60,
    // ⚠️ 同上：总时限要短到"变异发生时能在断言里看见"，而不是把测试挂住
    hardMs: 3000,
    log: () => {},
  });

  await new Promise((r) => setTimeout(r, 250));
  assert.equal(nodeFs.existsSync(keyFile), false, '这会儿还没有 key');

  // 用户刚填完 ⇒ 宿主这里有了
  h.state.key = REAL_KEY;
  h.ch.pushKey('u1', REAL_KEY);

  assert.equal(await p, true, '★ 晚到的 key 也要送到');
  assert.match(nodeFs.readFileSync(keyFile, 'utf8'), new RegExp(REAL_KEY));
});

test('★ 容器自己会催（`need-key`）：宿主拿到 key 之后下一次催就给了', async () => {
  const h = host({ key: null });
  h.ch.listenFor('u1');
  const keyFile = nodePath.join(h.dir, 'creds.yaml');

  const p = fetchKeyFromHost({
    socketPath: channelPathFor(h.dir, 'u1'),
    keyFile,
    waitMs: 10_000,
    retryMs: 80,
    hardMs: 3000,
    log: () => {},
  });
  await new Promise((r) => setTimeout(r, 40));
  h.state.key = REAL_KEY; // 不 push，只等它自己催
  assert.equal(await p, true);
  assert.ok(h.ch.recent.some((r) => r.state === 'hello'), '宿主该记下一笔 hello');
});

// ── ④ 🔴 两边的日志都不许出现 key ────────────────────────────

test('🔴 宿主与容器的日志里**一个字节的 key 都没有**（拿真日志扫）', async () => {
  const h = host({ key: REAL_KEY });
  h.ch.listenFor('u1');
  const keyFile = nodePath.join(h.dir, 'creds.yaml');
  const shellLines = [];
  await fetchKeyFromHost({
    socketPath: channelPathFor(h.dir, 'u1'),
    keyFile,
    log: (m) => shellLines.push(m),
  });
  await new Promise((r) => setTimeout(r, 60));

  const hostAll = h.lines.join('\n');
  const shellAll = shellLines.join('\n');
  assert.ok(hostAll.length > 0 && shellAll.length > 0, '两边都该有日志（不是"什么都没打"所以扫不到）');
  assert.ok(!hostAll.includes(REAL_KEY), `🔴 宿主日志里出现了 key：${hostAll}`);
  assert.ok(!shellAll.includes(REAL_KEY), `🔴 容器日志里出现了 key：${shellAll}`);
});

// ── ⑤ 协议版本 / 坏输入：照实说，别自己猜 ────────────────────

test('★ 版本不对 ⇒ 宿主回 `bad-version`（协议一旦上线就冻结）', async () => {
  const h = host({ key: REAL_KEY });
  h.ch.listenFor('u1');
  const sock = channelPathFor(h.dir, 'u1');
  const reply = await new Promise((resolve) => {
    const c = nodeNet.connect(sock, () => {
      c.write(`${JSON.stringify({ v: 999, type: 'hello' })}\n`);
    });
    let buf = '';
    c.setEncoding('utf8');
    c.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) {
        c.destroy();
        resolve(JSON.parse(buf.slice(0, i)));
      }
    });
    setTimeout(() => resolve(null), 1500);
  });
  // ⚠️ 第一条是"连上就发"的那条（ready），第二条才是对坏版本的回应
  assert.ok(reply, '必须回话');
  assert.equal(reply.v, CHANNEL_VERSION, '回话要带版本号');
});

test('★ 写 key 是**原子的**（先 .tmp 再 rename）—— 代理每次请求现读，不许读到半个', () => {
  const dir = tmpDir();
  const f = nodePath.join(dir, 'creds.yaml');
  writeKeyFile(f, REAL_KEY);
  assert.equal(nodeFs.existsSync(`${f}.tmp`), false, '不许留下 .tmp');
  assert.match(nodeFs.readFileSync(f, 'utf8'), /^HUPO_MODEL_KEY: /);
  assert.equal(nodeFs.statSync(f).mode & 0o777, 0o600);
});

test('🔴 宿主说了个**认不出的状态** ⇒ 立刻如实收场，**不许永远挂着**', async () => {
  // ⚠️ 这一条是**变异验证抓出来的**：把 `waiting` 那个分支去掉之后，
  //    promise **永远不 resolve** ⇒ 容器永远停在"等配置"那一步、界面永远起不来。
  //    "因为一句不认识的话而永远挂着"比"如实说不通"坏得多。
  const dir = tmpDir();
  const sock = nodePath.join(dir, 'weird.sock');
  const conns = new Set();
  const srv = nodeNet.createServer((c) => {
    conns.add(c);
    c.on('close', () => conns.delete(c));
    c.write(`${JSON.stringify({ v: CHANNEL_VERSION, state: '还没想好' })}\n`);
  });
  await new Promise((r) => srv.listen(sock, r));
  // ⚠️ `server.close()` **不会**踢掉已经连上的连接 ⇒ 有活连接时它的回调**永远不来**
  //    ⇒ 整个测试进程挂住（实测：只跑这一条是干净的，几条一起跑就挂）。
  //    ⇒ 关之前先把连接都销毁。
  openClose.add(() => {
    for (const c of conns) c.destroy();
    srv.close();
  });

  const keyFile = nodePath.join(dir, 'creds.yaml');
  const t0 = Date.now();
  const got = await fetchKeyFromHost({ socketPath: sock, keyFile, waitMs: 30_000, log: () => {} });
  const dt = Date.now() - t0;
  assert.equal(got, false, '认不出的状态要如实收场');
  assert.ok(dt < 3000, `🔴 用了 ${dt}ms —— 认不出的状态不该让它一直等`);
  assert.equal(nodeFs.existsSync(keyFile), false);
});

test('🔴 对面**一句话都不说** ⇒ 总时限到点也要收场（第二道兜底）', async () => {
  const dir = tmpDir();
  const sock = nodePath.join(dir, 'silent.sock');
  const conns = new Set();
  const srv = nodeNet.createServer((c) => {
    conns.add(c);
    c.on('close', () => conns.delete(c));
    /* 连上就不说话 */
  });
  await new Promise((r) => srv.listen(sock, r));
  openClose.add(() => {
    for (const c of conns) c.destroy();
    srv.close();
  });

  const keyFile = nodePath.join(dir, 'creds.yaml');
  const t0 = Date.now();
  const got = await fetchKeyFromHost({
    socketPath: sock, keyFile, waitMs: 200, hardMs: 600, log: () => {},
  });
  const dt = Date.now() - t0;
  assert.equal(got, false);
  assert.ok(dt < 3000, `🔴 用了 ${dt}ms —— 总时限没兜住`);
});

test('★ 后台"一直在等"：**先起来**，key 晚到时自己把文件补上（不挡服务启动）', async () => {
  const h = host({ key: null });
  h.ch.listenFor('u1');
  const keyFile = nodePath.join(h.dir, 'creds.yaml');
  const lines = [];

  // ⚠️ `watchForKey` **不 await** —— 它是后台的，服务该照常起来
  const w = watchForKey({
    socketPath: channelPathFor(h.dir, 'u1'),
    keyFile,
    attemptMs: 300,
    idleMs: 80,
    log: (m) => lines.push(m),
  });
  openClose.add(() => w.stop());

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(nodeFs.existsSync(keyFile), false, '这会儿还没 key（但它已经在后台等着）');

  h.state.key = REAL_KEY;
  // 它下一次尝试（或宿主推）就该拿到
  for (let i = 0; i < 40 && !nodeFs.existsSync(keyFile); i += 1) {
    h.ch.pushKey('u1', REAL_KEY);
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(nodeFs.existsSync(keyFile), true, '★ 晚到的 key 自己补上了');
  assert.match(nodeFs.readFileSync(keyFile, 'utf8'), new RegExp(REAL_KEY));
  w.stop();
});

test('★ 套接字不在（没挂进来）⇒ 返回 false，**不抛**（宿主上就是这个形态）', async () => {
  const got = await fetchKeyFromHost({
    socketPath: '/definitely/not/here.sock',
    keyFile: '/tmp/never-written',
    log: () => {},
  });
  assert.equal(got, false);
  assert.equal(nodeFs.existsSync('/tmp/never-written'), false);
});
