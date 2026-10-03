// **壳给页面的那两条内边距**（主人 2026-10-01 报的"小程序没铺满、底色不同" ·
// 契约 `docs/dev/150-APP-FULLBLEED.md`）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   ① 🔴 **老客户端（URL 上没有 `pt`/`pb`）⇒ 字节一个都不许动**（这是兼容那条底线）；
//   ② 🔴 **带上了就注入**：插在 `</head>` 之前，数对得上，`!important` 在；
//   ③ 🔴 **那两个数只认数字**（URL 是页面自己也能改的东西）—— 负数 / 非数字 / 越界
//      一律当 0 或夹住，**一个字符都不许跑进 HTML 结构里**；
//   ④ 🔴 **注入之后 `content-length` 要跟着改**（不然浏览器会截断或挂住）；
//   ⑤ 别的响应头（CSP / `no-store`）一个字不变；非 HTML（`.js` 之类）不注入。
//
// ⚠️ 都是**真 HTTP**（真 `createAppServer` + 真签名 URL），不是纯函数自说自话 ——
//    纯函数那一半（`shellInsetOf` / `injectShellInset`）顺带在里面量。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeHttp from 'node:http';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';

import { Apps } from '../src/apps.js';
import { createAppServer, entryUrl, injectShellInset, shellInsetOf } from '../src/app-serve.js';

const NOW = 1_800_000_000_000;
const KEY = Buffer.from('d'.repeat(64), 'hex');

const PAGE = '<!doctype html><html><head><title>天气</title></head><body><p>今天 26°</p></body></html>';

function tmp() {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-inset-'));
  return d;
}

function startAppOrigin(apps) {
  const server = createAppServer({
    resolveApps: () => apps,
    key: KEY,
    frameAncestors: 'https://w.example',
    // ★ **`A3`：URL 上不带人 ⇒ 这个测试世界里"可能的人"只有 u1**
    subsOf: () => ['u1'],
    now: () => NOW,
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function req(port, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const r = nodeHttp.request({ host: '127.0.0.1', port, path: url, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    r.on('error', reject);
    r.end();
  });
}

const sigOf = (port, id, version = 1) =>
  entryUrl({ base: `http://127.0.0.1:${port}`, key: KEY, sub: 'u1', id, version, entry: 'index.html', now: NOW }).slice(
    `http://127.0.0.1:${port}`.length,
  );

function makeApps(dir) {
  const apps = new Apps({ dir, sub: 'u1', now: () => NOW });
  apps.create({
    id: 'tianqi',
    title: '看天气',
    icon: 'book',
    entry: 'index.html',
    files: { 'index.html': PAGE, 'app.js': 'console.log(1)' },
  });
  return apps;
}

test('I1 🔴 没带 `pt`/`pb`（老客户端）⇒ **字节逐字一样**（一个字节都不许动）', async () => {
  const dir = tmp();
  const apps = makeApps(dir);
  const { server, port } = await startAppOrigin(apps);
  try {
    const r = await req(port, sigOf(port, 'tianqi'));
    assert.equal(r.status, 200);
    assert.equal(r.body.toString('utf8'), PAGE, '★ 没要边距 ⇒ 那份 HTML 要原样发出去');
    assert.ok(!r.body.toString('utf8').includes('hupo-shell-inset'), '不许凭空注入');
  } finally {
    server.close();
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('I2 带上了 `pt`/`pb` ⇒ 注入那一条（插在 `</head>` 之前，数对得上）', async () => {
  const dir = tmp();
  const apps = makeApps(dir);
  const { server, port } = await startAppOrigin(apps);
  try {
    const r = await req(port, `${sigOf(port, 'tianqi')}&pt=24&pb=150`);
    const body = r.body.toString('utf8');
    assert.equal(r.status, 200);
    assert.match(body, /<style id="hupo-shell-inset">/, '没注入');
    assert.match(body, /padding-top:24px !important/);
    assert.match(body, /padding-bottom:150px !important/);
    assert.match(body, /box-sizing:border-box !important/, '要带 box-sizing（防"写了 100vh 的页面"溢出）');
    // 位置：在 `</head>` 之前（页面自己的样式先落地，我们这条最后压上去）
    assert.ok(body.indexOf('<style id="hupo-shell-inset">') < body.indexOf('</head>'), '插错地方了');
    // 原文一个标签没动
    assert.equal(body.replace(/<style id="hupo-shell-inset">[\s\S]*?<\/style>/, ''), PAGE);
    // ⚠️ 头要跟着改（不然浏览器按老长度截断/挂住）
    assert.equal(Number(r.headers['content-length']), r.body.length);
    // 别的头一个字不变
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.match(String(r.headers['content-security-policy']), /frame-ancestors/);
  } finally {
    server.close();
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('I3 🔴 那两个数只认数字：坏值 ⇒ 当 0（**一个字符都不许跑进 HTML 结构里**）', async () => {
  const dir = tmp();
  const apps = makeApps(dir);
  const { server, port } = await startAppOrigin(apps);
  try {
    const bad = [
      '1px;}body{display:none',
      '</style><script>alert(1)</script>',
      '-5',
      'abc',
      '1e9',
      '24.7',
    ];
    // 单个坏值 ⇒ 只注入「另一个」那一条（坏的那个当 0）
    const r1 = await req(port, `${sigOf(port, 'tianqi')}&pt=${encodeURIComponent(bad[0])}&pb=0`);
    const b1 = r1.body.toString('utf8');
    assert.ok(!b1.includes('display:none'), '★ 坏串跑进页面里了');
    assert.equal(b1.includes('hupo-shell-inset'), false, '两个数都是坏的 ⇒ 不注入');

    const r2 = await req(port, `${sigOf(port, 'tianqi')}&pt=${encodeURIComponent(bad[1])}&pb=120`);
    const b2 = r2.body.toString('utf8');
    assert.ok(!b2.includes('<script>'), '★ 坏串跑进页面里了');
    assert.match(b2, /padding-bottom:120px !important/);
    assert.match(b2, /padding-top:0px !important/, '坏的那个当 0（照样写出来，但值是 0）');

    // 纯函数那一半：逐个数对表
    assert.equal(shellInsetOf('-5'), 0);
    assert.equal(shellInsetOf('abc'), 0);
    assert.equal(shellInsetOf(null), 0);
    assert.equal(shellInsetOf('24.7'), 25, '四舍五入到整数');
    assert.equal(shellInsetOf(1e9), 400, '★ 越界夹到上限');
    assert.equal(injectShellInset(PAGE, { padTop: 0, padBottom: 0 }), PAGE, '都是 0 ⇒ 原样');
  } finally {
    server.close();
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('I4 非 HTML（`.js` 之类）不注入；HEAD 的长度与 GET 一致', async () => {
  const dir = tmp();
  const apps = makeApps(dir);
  const { server, port } = await startAppOrigin(apps);
  try {
    const js = entryUrl({
      base: `http://127.0.0.1:${port}`,
      key: KEY,
      sub: 'u1',
      id: 'tianqi',
      version: 1,
      entry: 'app.js',
      now: NOW,
    }).slice(`http://127.0.0.1:${port}`.length);
    const r = await req(port, `${js}&pt=24&pb=150`);
    assert.equal(r.status, 200);
    assert.equal(r.body.toString('utf8'), 'console.log(1)', '★ 非 HTML 也被注入了？');

    const g = await req(port, `${sigOf(port, 'tianqi')}&pt=24&pb=150`);
    const h = await req(port, `${sigOf(port, 'tianqi')}&pt=24&pb=150`, 'HEAD');
    assert.equal(h.status, 200);
    assert.equal(h.body.length, 0, 'HEAD 不该有 body');
    assert.equal(
      Number(h.headers['content-length']),
      g.body.length,
      '★ 注入了内容，HEAD 报的长度必须与 GET 的一样',
    );
  } finally {
    server.close();
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});
