// **画图那一支 MCP**的判据（P1-27 后半：它从小程序那条上拆出来了）。
//
// 守的几条：
//   ① 它只暴露**一件**工具（`image_generate`）—— 小程序那九件不该出现在这儿；
//   ② 调它 ⇒ 那条通道上收到的是 `{op:'draw', prompt}`（**原样**，不许加戏）；
//   ③ 服务端那句"拒了/没成"**原样转达**（不许自己编一个更具体的说法）；
//   ④ 地址要**原样**回到回话里（模型才能把它放给他看）；
//   ⑤ 🔴 **通道不通 ⇒ 明确失败**（不许回一句"好了"）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeChildProcess from 'node:child_process';
import nodeFs from 'node:fs';
import nodeNet from 'node:net';
import nodeOs from 'node:os';
import nodePath from 'node:path';

const SERVER = nodePath.resolve(import.meta.dirname, '..', 'src', 'mcp-image-server.mjs');

/** 起一个**假的**那条口：收到一行就记下来，回一条我给的回答。 */
function fakeSocket(reply) {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-imgsock-'));
  const sock = nodePath.join(dir, 'apps.sock');
  const got = [];
  const server = nodeNet.createServer((conn) => {
    let buf = '';
    conn.on('data', (c) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        got.push(JSON.parse(line));
        conn.write(`${JSON.stringify(reply(got[got.length - 1]))}\n`);
      }
    });
  });
  server.listen(sock);
  return { dir, sock, got, close: () => new Promise((r) => server.close(() => r())) };
}

function client(env) {
  const child = nodeChildProcess.spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
  });
  let buf = '';
  const waiters = [];
  child.stdout.on('data', (b) => {
    buf += b.toString();
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const w = waiters.shift();
      if (w) w(JSON.parse(line));
    }
  });
  const call = (method, params) => new Promise((res) => {
    waiters.push(res);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`);
  });
  return { child, call };
}

test('① 🔴 它只暴露**一件**工具（画图），而且说明里有"只有他明确说才调"', async () => {
  const s = fakeSocket(() => ({ ok: true, urls: [] }));
  const c = client({ HUPO_IMAGE_SOCKET: s.sock });
  try {
    await c.call('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    const list = await c.call('tools/list', {});
    assert.deepEqual(list.result.tools.map((t) => t.name), ['image_generate'],
      '★ 这一支就是画图那一件（小程序那九件不该在这儿）');
    const t = list.result.tools[0];
    assert.match(t.description, /明确说|只有他/, '说明里必须有"只在他明说时才画"');
    assert.match(t.description, /地址/, '要交代"把地址放回话里"');
    // 内部词表也要过（说明会进 prompt）
    for (const w of ['工作区', '客户端', '云端', '时间线', '会话', '口令', 'mcp__', 'socket', 'entryId']) {
      assert.ok(!t.description.includes(w), `说明里出现了内部词「${w}」`);
    }
  } finally {
    c.child.kill();
    await s.close();
  }
});

test('②③④ 调它 ⇒ 通道上收到 `{op:draw,prompt}`；回话里是**原样**的地址', async () => {
  const s = fakeSocket(() => ({ ok: true, urls: ['https://x.example/a.png'] }));
  const c = client({ HUPO_IMAGE_SOCKET: s.sock });
  try {
    await c.call('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    const r = await c.call('tools/call', { name: 'image_generate', arguments: { prompt: '  一只猫  ' } });
    assert.equal(r.result.isError, false);
    assert.deepEqual(s.got, [{ op: 'draw', prompt: '一只猫' }], '★ 首尾空格去掉、原样递上去');
    const text = r.result.content[0].text;
    assert.match(text, /https:\/\/x\.example\/a\.png/, '★ 地址要原样在回话里');
    assert.match(text, /临时地址/, '要提醒他"想要就存下来"');
  } finally {
    c.child.kill();
    await s.close();
  }
});

test('③ 服务端说"拒了" ⇒ **原样转达**（不许自己编）；空提示词 ⇒ 根本不发', async () => {
  const s = fakeSocket(() => ({ ok: false, error: '（这句是服务端给的）得你亲口说一句才画。' }));
  const c = client({ HUPO_IMAGE_SOCKET: s.sock });
  try {
    await c.call('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    const r = await c.call('tools/call', { name: 'image_generate', arguments: { prompt: '一只猫' } });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /这句是服务端给的/);
    // 空提示词：**一次都不发**
    const before = s.got.length;
    const blank = await c.call('tools/call', { name: 'image_generate', arguments: { prompt: '   ' } });
    assert.equal(blank.result.isError, true);
    assert.equal(s.got.length, before, '空提示词不许发出去');
    // 不认识的工具
    assert.equal((await c.call('tools/call', { name: 'app_create', arguments: {} })).result.isError, true,
      '小程序那几件不属于这一支');
  } finally {
    c.child.kill();
    await s.close();
  }
});

test('⑤ 🔴 通道不通 ⇒ **明确失败**（不许回一句"好了"）', async () => {
  const c = client({ HUPO_IMAGE_SOCKET: '/tmp/definitely-not-here-12345.sock' });
  try {
    await c.call('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    const r = await c.call('tools/call', { name: 'image_generate', arguments: { prompt: '一只猫' } });
    assert.equal(r.result.isError, true, '★ 通道不通就该失败');
    assert.match(r.result.content[0].text, /没画成|一直/, `要明说是哪种失败：${r.result.content[0].text}`);
  } finally {
    c.child.kill();
  }
});
