// 小程序那几条工具的**真链路**（乙-2 · 契约 `docs/dev/59-USER-APPS.md` §二）。
//
// 这一篇不起 dsh，但它**起真进程**：
//
//   测试 ──stdio JSON-RPC──▶ mcp-apps-server.mjs ──域套接字──▶ AppsSocket ──▶ 盘
//
// 守的几条：
//   ① 🔴 **工具进程不写盘**：它只把请求递过去，写盘只有服务端那一个实例
//   ② 🔴 **通道不通 ⇒ 明确失败**（`isError`），**绝不许**回一句"好了"
//   ③ 🔴 **还没做的那几件（publish/install/grant）⇒ 明说"还没做"**，不许假装成功
//   ④ 工具名与说明**过禁用词闸**（它们会进 prompt）
//   ⑤ 本地通道**权限 0600**；坏输入**只让那一条失败**
//   ⑥ `stdio` 上除了 JSON-RPC **不许有别的输出**（多一行就把通道弄坏）
//   ⑦ 造出来的东西**落在那个人的那一格里**（按人分）

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeChildProcess from 'node:child_process';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { Apps } from '../src/apps.js';
import { AppsSocket, appsSocketPath, handleAppsOp } from '../src/apps-socket.js';

const HERE = nodePath.dirname(new URL(import.meta.url).pathname);
const MCP_SERVER = nodePath.resolve(HERE, '..', 'src', 'mcp-apps-server.mjs');

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});

/** 起一套：真制品库 + 真套接字。 */
function setup() {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-apps-chain-'));
  tmpDirs.push(dir);
  const apps = new Apps({ dir, sub: 'u1' });
  const path = appsSocketPath(dir);
  const sock = new AppsSocket({ apps, socketPath: path }).listen();
  return { dir, apps, sock, socketPath: path };
}

/** 把 MCP 进程拉起来，并给它一个 `call()`（与账本那条同一形状）。 */
function mcpClient(env) {
  const child = nodeChildProcess.spawn(process.execPath, [MCP_SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const stdoutLines = [];
  const stderr = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() !== '') stdoutLines.push(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => stderr.push(String(c)));

  let id = 0;
  const waiters = new Map();
  const pump = setInterval(() => {
    while (stdoutLines.length > 0) {
      const line = stdoutLines.shift();
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  }, 2);
  pump.unref?.();

  const call = (method, params, ms = 8000) => new Promise((resolve) => {
    const myId = ++id;
    const timer = setTimeout(() => { waiters.delete(myId); resolve({ timeout: true }); }, ms);
    waiters.set(myId, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
  });
  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };
  return { child, call, notify, stderr, stdout: () => stdoutLines };
}

const APP = {
  id: 'dice',
  title: '掷骰子',
  icon: 'dice',
  files: { 'index.html': '<!doctype html><button id="r">掷</button><script>document.getElementById("r")</script>' },
};

async function handshake(c) {
  const init = await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'hupo-apps');
  c.notify('notifications/initialized', {});
  return init;
}

// ── 纯函数那一层：那几件"还没做"的必须明说 ──────────────────

test('🔴 还没做的那几件 ⇒ 明说"还没做"（不许假装成功）', () => {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-apps-op-'));
  tmpDirs.push(dir);
  const apps = new Apps({ dir });
  for (const op of ['publish', 'unpublish', 'install', 'uninstall', 'grant', 'revoke']) {
    const r = handleAppsOp(apps, { op });
    assert.equal(r.ok, false, `${op} 现在做不了，必须说做不了`);
    assert.match(r.error, /还没做/, `${op} 要说清"还没做"`);
  }
  assert.equal(handleAppsOp(apps, { op: '不懂' }).ok, false);
  assert.equal(handleAppsOp(apps, {}).ok, false);
});

test('坏输入只让那一条失败（校验不过 ⇒ ok:false，而且盘上没东西）', () => {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-apps-op2-'));
  tmpDirs.push(dir);
  const apps = new Apps({ dir });
  const bad = handleAppsOp(apps, { op: 'create', app: { ...APP, id: '../evil' } });
  assert.equal(bad.ok, false);
  assert.equal(nodeFs.existsSync(nodePath.join(dir, 'hupo', 'apps')), false, '不该建出任何东西');
});

// ── 真链路 ──────────────────────────────────────────────────

test('握手给的是**标准 MCP**：initialize → tools/list 两条工具（这一批只有两条）', async () => {
  const s = setup();
  const c = mcpClient({ HUPO_APPS_SOCKET: s.socketPath });
  try {
    await handshake(c);
    const list = await c.call('tools/list', {});
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['app_create', 'app_list'], '这一批只做这两件（其余要等发现/权限那两批）');
    for (const t of list.result.tools) {
      assert.equal(t.inputSchema.type, 'object');
      assert.ok(t.description.length > 10, '每条都要说清什么时候调');
      // ④ 工具名与说明会进 prompt（等于上了界面）⇒ 也要过禁用词闸
      //    ⚠️ 用**同一份词表**的形状（与 `ledger-chain.test.js` 那条一致）
      for (const w of ['工作区', '客户端', '云端', '时间线', '会话', '口令', '记录', 'mcp__', 'socket', 'entryId']) {
        assert.ok(!t.name.includes(w), `工具名里出现了内部词「${w}」`);
        assert.ok(!t.description.includes(w), `说明里出现了内部词「${w}」：${t.name}`);
      }
    }
    // 🔴 那条规矩必须写在说明里（"只在他明说时才造"）
    const create = list.result.tools.find((t) => t.name === 'app_create');
    assert.match(create.description, /明确说|明说/, '★ 说明里必须有"只在他明说时才造"这条');
  } finally {
    c.child.kill();
    await s.sock.close();
  }
});

test('🔴 走一遍真链路：造 ⇒ 盘上有 ⇒ 他看得见（而且只在他那一格里）', async () => {
  const s = setup();
  const c = mcpClient({ HUPO_APPS_SOCKET: s.socketPath });
  try {
    await handshake(c);
    const made = await c.call('tools/call', { name: 'app_create', arguments: APP });
    assert.equal(made.result.isError, false, `不该失败：${JSON.stringify(made.result)}`);
    assert.match(made.result.content[0].text, /掷骰子/, '回话要把名字说给他听');

    // 盘上真有（而且只有服务端那一个实例写出来的）
    const file = nodePath.join(s.dir, 'hupo', 'apps', 'dice', 'versions', '1', 'index.html');
    assert.equal(nodeFs.existsSync(file), true, '★ 制品要真的落盘');
    assert.match(nodeFs.readFileSync(file, 'utf8'), /掷/);
    // 版本不可变：写下去就是只读
    const mode = nodeFs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o444, `制品文件该是只读的（实为 ${mode.toString(8)}）`);

    const listed = await c.call('tools/call', { name: 'app_list', arguments: {} });
    assert.match(listed.result.content[0].text, /掷骰子/);
    assert.match(listed.result.content[0].text, /dice/);
  } finally {
    c.child.kill();
    await s.sock.close();
  }
});

test('🔴 通道不通 ⇒ **明确失败**（不是"好了"）', async () => {
  const c = mcpClient({ HUPO_APPS_SOCKET: '/tmp/这条口根本不存在-hupo.sock' });
  try {
    await handshake(c);
    const r = await c.call('tools/call', { name: 'app_create', arguments: APP });
    assert.equal(r.result.isError, true, '★ 通道不通就必须是错误，不许假装成功');
    assert.match(r.result.content[0].text, /连不上|没配/, '而且要说清是"连不上"');
  } finally {
    c.child.kill();
  }
});

test('本地通道权限 0600 · 坏行只让那一条失败 · stdout 只有 JSON-RPC', async () => {
  const s = setup();
  const mode = nodeFs.statSync(s.socketPath).mode & 0o777;
  assert.equal(mode, 0o600, `那条口该是 0600（实为 ${mode.toString(8)}）`);

  const c = mcpClient({ HUPO_APPS_SOCKET: s.socketPath });
  try {
    await handshake(c);
    // 直接往那条口里塞两行：一行坏 JSON、一行好请求
    const net = await import('node:net');
    const reply = await new Promise((resolve) => {
      const conn = net.connect(s.socketPath);
      let buf = '';
      conn.setEncoding('utf8');
      conn.on('connect', () => {
        conn.write('这不是 JSON\n');
        conn.write(`${JSON.stringify({ op: 'list' })}\n`);
      });
      conn.on('data', (chunk) => {
        buf += chunk;
        if (buf.split('\n').filter((l) => l.trim()).length >= 2) {
          conn.destroy();
          resolve(buf.trim().split('\n'));
        }
      });
      setTimeout(() => { conn.destroy(); resolve(buf.trim().split('\n')); }, 3000);
    });
    assert.equal(reply.length >= 2, true, `两条请求该有两条回话：${JSON.stringify(reply)}`);
    assert.match(reply[0], /不是 JSON/);
    assert.match(reply[1], /"ok":true/);

    // stdout 上除了 JSON-RPC 什么都没有
    await new Promise((r) => setTimeout(r, 120));
    for (const line of c.stdout()) {
      assert.equal(line.trimStart().startsWith('{'), true, `stdout 上出现了非 JSON-RPC 的东西：${line}`);
    }
  } finally {
    c.child.kill();
    await s.sock.close();
  }
});
