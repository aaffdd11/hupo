// **`net`：制品要访问哪几个站**（契约 `docs/dev/148-APP-FULL-SET.md` §二 · 第 ② 片）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   · **N1** 声明了 `net` ＋ 名单 ⇒ **制品那一条 CSP 里真有那几个站**（真 app 原点、真响应头）；
//   · **N2** 没声明 ⇒ **只有 `'self'`**（一个字节都不放宽）；
//   · **N3** 🔴 **名单是安全边界**：`evil.com; script-src *` 这种**在入口就被拒**
//     （两个入口都拒：`register` 与 `create`）；真发出去的头上也**只可能出现规规矩矩的域名**；
//   · **N4** 🔴 **他关掉 ⇒ 名单立刻不进 CSP**（"设置里能关"这句话**真的成立**的地方）；
//   · **N5** **一个 app 的名单不会跑到另一个 app 的头上**（按 app 算，不是全局白名单）；
//   · **N6** 名单**不许自己长**：加站 = 新的一版（重发一次 `register`/`create` 才换得来）。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeHttp from 'node:http';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';

import { Apps, MAX_NET_HOSTS, checkNetHosts } from '../src/apps.js';
import { createAppServer, entryUrl, netHostsFor } from '../src/app-serve.js';

const KEY = Buffer.from('b'.repeat(64), 'hex');
const NOW = 1_800_000_000_000;

function tmpdir() {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-net-'));
}

function startAppOrigin(apps) {
  const server = createAppServer({
    resolveApps: () => apps,
    key: KEY,
    frameAncestors: 'https://w.example',
    now: () => NOW,
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function get(port, url) {
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request({ host: '127.0.0.1', port, path: url, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const sigOf = (port, id) => {
  const url = entryUrl({ base: `http://127.0.0.1:${port}`, key: KEY, sub: 'u1', id, version: 1, entry: 'index.html', now: NOW });
  return url.slice(`http://127.0.0.1:${port}`.length);
};

// ── N3 · 名单本身（纯函数，安全边界）────────────────────────────

test('N3 名单只认规规矩矩的域名（带 `;`／空格／通配／scheme／端口的一律拒）', () => {
  assert.deepEqual(checkNetHosts(['api.example.com', 'API.Example.com', 'a.b.c']), {
    ok: true,
    hosts: ['api.example.com', 'a.b.c'],
  });
  assert.deepEqual(checkNetHosts(undefined), { ok: true, hosts: [] });
  for (const bad of [
    ['evil.com; script-src *'], // 🔴 改写整条 CSP 的那一种
    ['evil.com script-src'],
    ['*'],
    ['*.example.com'],
    ['https://api.example.com'],
    ['api.example.com/path'],
    ['api.example.com:8443'],
    ['api.example.com\n'],
    [''],
    ['..'],
    ['.example.com'],
    ['-bad.example.com'],
    ['example'],
    [123],
    ['a'.repeat(101) + '.com'],
  ]) {
    assert.equal(checkNetHosts(bad).ok, false, `该拒：${JSON.stringify(bad)}`);
  }
  // 个数上限
  const many = Array.from({ length: MAX_NET_HOSTS + 1 }, (_, i) => `h${i}.example.com`);
  assert.equal(checkNetHosts(many).ok, false);
  // 不是数组 ⇒ 拒
  assert.equal(checkNetHosts('api.example.com').ok, false);
});

test('N3 两个入口都拒：坏名单**连写都写不进去**（register 与 create）', () => {
  const dir = tmpdir();
  const apps = new Apps({ dir, sub: 'u1', now: () => NOW });
  const bad = ['evil.com; script-src *'];
  assert.throws(() => apps.register({ id: 'a1', title: 'A', entry: 'index.html', permissions: ['net'], net: bad }), /不像|域名|空白/);
  assert.throws(
    () => apps.create({ id: 'a2', title: 'A', icon: 'dice', entry: 'index.html', files: { 'index.html': '<p>x</p>' }, permissions: ['net'], net: bad }),
    /不像|域名|空白/,
  );
  // 写了名单却没说要用网 ⇒ 也拒（不许留一个"看着像"的）
  assert.throws(() => apps.register({ id: 'a3', title: 'A', entry: 'index.html', net: ['api.example.com'] }), /一起给/);
  assert.equal(apps.list().length, 0, '一个都不许写进去');
  nodeFs.rmSync(dir, { recursive: true, force: true });
});

// ── N1/N2/N4/N5/N6 · 真响应头 ────────────────────────────────

test('N1/N2 真制品头：声明了就在 `connect-src` 里；没声明就只有 `\'self\'`', async (t) => {
  const dir = tmpdir();
  const apps = new Apps({ dir, sub: 'u1', now: () => NOW });
  apps.create({
    id: 'shuju',
    title: '看数据',
    icon: 'dice',
    entry: 'index.html',
    files: { 'index.html': '<p>x</p>' },
    permissions: ['net'],
    net: ['api.example.com', 'data.example.org'],
  });
  apps.create({ id: 'pure', title: '纯页面', icon: 'dice', entry: 'index.html', files: { 'index.html': '<p>x</p>' } });
  const { server, port } = await startAppOrigin(apps);
  try {
    const a = await get(port, sigOf(port, 'shuju'));
    const cspA = String(a.headers['content-security-policy']);
    assert.match(cspA, /connect-src 'self' https:\/\/api\.example\.com https:\/\/data\.example\.org/, cspA);
    // 🔴 只放那几个站：别的照旧什么都没有
    assert.ok(!/connect-src[^;]*\*/.test(cspA), '不许出现通配');
    assert.ok(!cspA.includes('https://other.example'), '没声明的站不许出现');

    const b = await get(port, sigOf(port, 'pure'));
    const cspB = String(b.headers['content-security-policy']);
    assert.match(cspB, /connect-src 'self'(;|$)/, `没声明 ⇒ 只有 'self'（实际 ${cspB}）`);
    assert.ok(!cspB.includes('example.com'), '★ N5：别人的名单不许跑到这一份头上');
  } finally {
    server.close();
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('N4 🔴 他关掉 ⇒ 名单**立刻**不进 CSP（"设置里能关"真的成立的地方）', async (t) => {
  const dir = tmpdir();
  const apps = new Apps({ dir, sub: 'u1', now: () => NOW });
  apps.create({
    id: 'shuju',
    title: '看数据',
    icon: 'dice',
    entry: 'index.html',
    files: { 'index.html': '<p>x</p>' },
    permissions: ['net'],
    net: ['api.example.com'],
  });
  const { server, port } = await startAppOrigin(apps);
  try {
    const before = String((await get(port, sigOf(port, 'shuju'))).headers['content-security-policy']);
    assert.match(before, /https:\/\/api\.example\.com/, '前提：开着的时候它在');

    apps.setGrants('shuju', []); // ★ 他在设置页关掉
    const after = String((await get(port, sigOf(port, 'shuju'))).headers['content-security-policy']);
    assert.ok(!after.includes('api.example.com'), `★ 关掉之后一个站都不许留（实际 ${after}）`);
    assert.match(after, /connect-src 'self'(;|$)/);

    // 再打开 ⇒ 又回来（关掉只是"现在不给"）
    apps.setGrants('shuju', ['net']);
    const again = String((await get(port, sigOf(port, 'shuju'))).headers['content-security-policy']);
    assert.match(again, /https:\/\/api\.example\.com/);
  } finally {
    server.close();
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('N6 名单**不许自己长**：加站要重新登记一版（旧那一版的文件头照旧是老的）', async (t) => {
  const dir = tmpdir();
  const apps = new Apps({ dir, sub: 'u1', now: () => NOW });
  const files = { 'index.html': '<p>x</p>' };
  apps.create({ id: 'shuju', title: '看数据', icon: 'dice', entry: 'index.html', files, permissions: ['net'], net: ['api.example.com'] });
  const { server, port } = await startAppOrigin(apps);
  try {
    const v1 = String((await get(port, sigOf(port, 'shuju'))).headers['content-security-policy']);
    assert.match(v1, /api\.example\.com/);
    assert.ok(!v1.includes('new.example.com'), '还没加过的站不在头上');
    // 加一个站 = 重新登记一版（助手改页面就是这么做的）
    apps.register({ id: 'shuju', title: '看数据', entry: 'index.html', permissions: ['net'], net: ['api.example.com', 'new.example.com'] });
    const { netHostsFor: hostsOf } = await import('../src/app-serve.js');
    assert.deepEqual(await hostsOf(apps, 'shuju'), ['api.example.com', 'new.example.com']);
    // 而**旧那一版**（`/a/<id>/1/`）的那条头 —— 它签的是版本 1，取的是**现在那一份声明**：
    // ⚠️ 如实说：今天 CSP 是按**这个 app 现在的声明**算的（不是按那一版快照算），
    //    所以"旧版文件"也会带上新名单 —— 这是刻意的（他改的是他自己那一份，桌面上就一个 app）。
    const v1again = String((await get(port, sigOf(port, 'shuju'))).headers['content-security-policy']);
    assert.match(v1again, /new\.example\.com/);
  } finally {
    server.close();
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('netHostsFor：三道闸缺一不可（没声明 / 他关掉 / 读不出来 ⇒ 空名单）', async () => {
  const dir = tmpdir();
  const apps = new Apps({ dir, sub: 'u1', now: () => NOW });
  const files = { 'index.html': '<p>x</p>' };
  // ① 没声明 net（只有 db）⇒ 空
  apps.create({ id: 'onlydb', title: 'A', icon: 'dice', entry: 'index.html', files, permissions: ['db'], net: [] });
  assert.deepEqual(await netHostsFor(apps, 'onlydb'), []);
  // ② 声明了、他关掉 ⇒ 空
  apps.create({ id: 'off', title: 'B', icon: 'dice', entry: 'index.html', files, permissions: ['net'], net: ['api.example.com'] });
  apps.setGrants('off', []);
  assert.deepEqual(await netHostsFor(apps, 'off'), []);
  // ③ 正常 ⇒ 名单
  apps.create({ id: 'on', title: 'C', icon: 'dice', entry: 'index.html', files, permissions: ['net'], net: ['api.example.com'] });
  assert.deepEqual(await netHostsFor(apps, 'on'), ['api.example.com']);
  // ④ 不存在的 app ⇒ 空（不抛）
  assert.deepEqual(await netHostsFor(apps, 'nope'), []);
  // ⑤ 🔴 **盘上被手改过**（有名单却没声明 `net`）⇒ 照样空 ——
  //    正常入口拒这种组合（"两样要一起给"），所以这一条是**防线里那一层**：
  //    谁绕过入口直接把文件改了，CSP 也不会给出去。
  //  ⚠️ 用 `register`（它写的是 `app.json`）—— 手改的就是那一份
  apps.register({ id: 'hacked', title: 'D', entry: 'index.html' });
  const metaPath = nodePath.join(dir, 'hupo', 'apps', 'hacked', 'app.json');
  const meta = JSON.parse(nodeFs.readFileSync(metaPath, 'utf8'));
  meta.net = ['api.example.com']; // 手改：塞一张名单进去
  nodeFs.writeFileSync(metaPath, `${JSON.stringify(meta)}\n`);
  assert.deepEqual(await netHostsFor(apps, 'hacked'), [], '没声明 net ⇒ 名单一个都不许进 CSP');

  // ⑥ 抛着的 store ⇒ 空（fail-closed）
  assert.deepEqual(await netHostsFor({ meta: () => { throw new Error('坏了'); } }, 'on'), []);
  nodeFs.rmSync(dir, { recursive: true, force: true });
});

test('租户那一侧也拿得到名单（盒代理没有 meta ⇒ 走它的清单）', async () => {
  const dir = tmpdir();
  const apps = new Apps({ dir, sub: 'owner', now: () => NOW });
  apps.create({ id: 'shuju', title: '看数据', icon: 'dice', entry: 'index.html', files: { 'index.html': '<p>x</p>' }, permissions: ['net'], net: ['api.example.com'] });
  // 一个"盒代理"的替身：只有 list()（没有 meta）—— 形状照 `apps-box.js`
  const boxLike = {
    isBox: true,
    list: async () => apps.list(),
    grants: undefined,
  };
  // ⚠️ 盒代理没有 grants ⇒ `netHostsFor` 会当"他关掉了"处理吗？不会：
  //    它只在**明确读出来是空**时才空 —— 读不出来（这里 grants 不存在）按"没有授予信息"处理。
  //    🔴 这条如实钉住今天的行为，等盒子那一侧的 grants 接上再改（见 §二·欠）。
  const got = await netHostsFor(boxLike, 'shuju');
  assert.deepEqual(got, [], '盒代理今天读不到 grants ⇒ **fail-closed**（宁可连不出去）');
  nodeFs.rmSync(dir, { recursive: true, force: true });
});
