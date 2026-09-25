// 能力层那条**真链路**（批 4 · 契约 `docs/dev/31-LEDGER.md` v2 §7.1–§7.3）。
//
// 这一篇不起 dsh（那是 `scripts/check-capabilities.mjs` 的事），但它**起真进程**：
//
//   测试 ──stdio JSON-RPC──▶ mcp-ledger-server.mjs ──域套接字──▶ LedgerSocket ──▶ 盘
//
// 守的几条：
//   ① 🔴 **`ledger_propose` 一个字节都不写**（D6.4/D6.5：不确认不写）
//   ② 🔴 **`ledger_write` 才写**，而且**校验不过就什么都不记**
//   ③ 🔴 **通道不通 ⇒ 明确失败**（`isError`），不许假装成功
//   ④ **模型看到的那几个名字/说明**过禁用词闸（工具名会进 prompt）
//   ⑤ 本地通道**权限 0600**；坏输入**只让那一条失败**，不许把服务带走
//   ⑥ `stdio` 上除了 JSON-RPC **不许有别的输出**（多一行就把通道弄坏）

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeChildProcess from 'node:child_process';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';
import { Ledger } from '../src/ledger.js';
import { LedgerSocket, ledgerSocketPath } from '../src/ledger-socket.js';

const HERE = nodePath.dirname(new URL(import.meta.url).pathname);
const MCP_SERVER = nodePath.resolve(HERE, '..', 'src', 'mcp-ledger-server.mjs');
const AT = new Date(2026, 8, 21, 10, 0).getTime();

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});

/** 起一套：真账本 + 真套接字 + 真 MCP 进程。 */
function setup({ socketPath = null, ctx = null } = {}) {
  const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-chain-'));
  tmpDirs.push(dataDir);
  const store = new Store({ dataDir, fsync: false });
  const timeline = new Timeline({ id: 'ledger', store, clock: () => AT });
  let n = 0;
  const ledger = new Ledger({ store, timeline, now: () => AT, newId: () => `e${++n}` }).sync();
  const path = socketPath ?? ledgerSocketPath(dataDir);
  const sock = new LedgerSocket({ ledger, socketPath: path, ctx }).listen();
  return { dataDir, store, timeline, ledger, sock, socketPath: path };
}

/** 把 MCP 进程拉起来，并给它一个 `call()`。 */
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

const FIELD_ARGS = {
  kind: '装空调', qty: 3, unit: '台', unitPrice: 1200, tax: false,
  date: '2026-08-20', said: '上周装了三台空调，一台一千二，不含税',
};

// ── 握手 + 工具名 ────────────────────────────────────────────

test('握手给的是**标准 MCP**：initialize → tools/list 六条工具', async () => {
  const s = setup();
  const c = mcpClient({ HUPO_LEDGER_SOCKET: s.socketPath });
  try {
    const init = await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    assert.equal(init.result.protocolVersion, '2025-06-18', '对面报的版本我们认识，就用它的');
    assert.equal(init.result.serverInfo.name, 'hupo-ledger');
    assert.equal(init.result.capabilities.tools.listChanged, false);
    c.notify('notifications/initialized', {});

    const list = await c.call('tools/list', {});
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['handoff_to', 'ledger_delete', 'ledger_list', 'ledger_propose', 'ledger_write', 'work_status']);
    for (const t of list.result.tools) {
      assert.equal(t.inputSchema.type, 'object');
      assert.ok(typeof t.description === 'string' && t.description.length > 10, '每条都要说清什么时候调');
    }
  } finally {
    c.child.kill('SIGKILL'); s.sock.close();
  }
});

test('认不出的版本 ⇒ 退回我们默认的那个（不是崩）', async () => {
  const s = setup();
  const c = mcpClient({ HUPO_LEDGER_SOCKET: s.socketPath });
  try {
    const init = await c.call('initialize', { protocolVersion: '2099-01-01' });
    assert.equal(init.result.protocolVersion, '2024-11-05');
  } finally {
    c.child.kill('SIGKILL'); s.sock.close();
  }
});

test('不认识的方法 ⇒ JSON-RPC 的 -32601（不是把进程弄死）', async () => {
  const s = setup();
  const c = mcpClient({ HUPO_LEDGER_SOCKET: s.socketPath });
  try {
    const r = await c.call('tools/nope', {});
    assert.equal(r.error.code, -32601);
    const still = await c.call('ping', {});
    assert.deepEqual(still.result, {}, '答完错话还得能继续干活');
  } finally {
    c.child.kill('SIGKILL'); s.sock.close();
  }
});

// ── ①③ 只算不写 / 通道不通 ───────────────────────────────────

test('🔴 `ledger_propose` **一个字节都不写**，而且把听到的念回去', async () => {
  const s = setup();
  const c = mcpClient({ HUPO_LEDGER_SOCKET: s.socketPath });
  try {
    const r = await c.call('tools/call', { name: 'ledger_propose', arguments: FIELD_ARGS });
    const text = r.result.content[0].text;
    assert.ok(text.includes('1200'), `回显里要有钱数：${text}`);
    assert.ok(text.includes('2026-08-20'), `回显里要有日期：${text}`);
    assert.equal(r.result.isError ?? false, false);
    assert.equal(s.store.readAll('ledger').length, 0, 'propose 碰盘就是破 D6.4');
  } finally {
    c.child.kill('SIGKILL'); s.sock.close();
  }
});

test('🔴 `ledger_write` 才写；写完之后账上有这一笔', async () => {
  const s = setup();
  const c = mcpClient({ HUPO_LEDGER_SOCKET: s.socketPath });
  try {
    const r = await c.call('tools/call', { name: 'ledger_write', arguments: FIELD_ARGS });
    assert.equal(r.result.isError ?? false, false, r.result.content[0].text);
    const rows = s.store.readAll('ledger');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, '装空调');
    assert.equal(rows[0].said, FIELD_ARGS.said, '**原话**要留下来（D6.4 的出处）');
    assert.equal(rows[0].tax, false);
    assert.equal(s.ledger.totals().total, 3600);
  } finally {
    c.child.kill('SIGKILL'); s.sock.close();
  }
});

test('🔴 校验不过 ⇒ `isError`，**点名哪一项**，而且什么都没记', async () => {
  const s = setup();
  const c = mcpClient({ HUPO_LEDGER_SOCKET: s.socketPath });
  try {
    const r = await c.call('tools/call', {
      name: 'ledger_write',
      arguments: { ...FIELD_ARGS, date: '八月二十号' },
    });
    assert.equal(r.result.isError, true);
    assert.ok(r.result.content[0].text.includes('日期'), r.result.content[0].text);
    assert.equal(s.store.readAll('ledger').length, 0);
  } finally {
    c.child.kill('SIGKILL'); s.sock.close();
  }
});

test('🔴 那条口不通 ⇒ **明确失败**，不许"先记下来等会再写"', async () => {
  const want = nodePath.join(nodeOs.tmpdir(), `hupo-none-${process.pid}.sock`);
  const c = mcpClient({ HUPO_LEDGER_SOCKET: want });
  try {
    const r = await c.call('tools/call', { name: 'ledger_write', arguments: FIELD_ARGS });
    assert.equal(r.result.isError, true, '连不上就必须说没记下来');
    assert.ok(r.result.content[0].text.includes('没记下来') || r.result.content[0].text.includes('连不上'),
      r.result.content[0].text);
  } finally {
    c.child.kill('SIGKILL');
  }
});

test('没配那条口 ⇒ 也说清楚（不是静默成功）', async () => {
  const c = mcpClient({ HUPO_LEDGER_SOCKET: '' });
  try {
    const r = await c.call('tools/call', { name: 'ledger_list', arguments: {} });
    assert.equal(r.result.isError, true);
  } finally {
    c.child.kill('SIGKILL');
  }
});

// ── 出口（列表 / 删）─────────────────────────────────────────

test('`ledger_list` 给的是**一段能粘走的文字**，而且口径对：说不清的要说出来', async () => {
  const s = setup();
  s.ledger.write({ ...FIELD_ARGS, qty: 1, unitPrice: 100, tax: false }, { said: FIELD_ARGS.said });
  s.ledger.write({ ...FIELD_ARGS, kind: '搬东西', qty: 2, unitPrice: 50, tax: 'unknown' }, { said: FIELD_ARGS.said });
  s.ledger.write({ ...FIELD_ARGS, kind: '帮忙', qty: 1, unitPrice: null }, { said: FIELD_ARGS.said });

  const c = mcpClient({ HUPO_LEDGER_SOCKET: s.socketPath });
  try {
    const r = await c.call('tools/call', { name: 'ledger_list', arguments: {} });
    const text = r.result.content[0].text;
    assert.ok(text.includes('装空调') && text.includes('搬东西'), text);
    assert.ok(text.includes('一共 100'), `合计只算能算的那些：${text}`);
    assert.ok(text.includes('1 条含不含税说不清'), `排除掉的要**明说**：${text}`);
    assert.ok(text.includes('1 条没说钱'), `没钱的也要说：${text}`);
    assert.ok(!text.includes('|'), '不给表格');
  } finally {
    c.child.kill('SIGKILL'); s.sock.close();
  }
});

test('`ledger_delete` 把它收起来（可拿回来），不是"说删就删"', async () => {
  const s = setup();
  const rec = s.ledger.write(FIELD_ARGS, { said: FIELD_ARGS.said });
  const c = mcpClient({ HUPO_LEDGER_SOCKET: s.socketPath });
  try {
    const r = await c.call('tools/call', {
      name: 'ledger_delete',
      arguments: { date: rec.date, kind: rec.kind },
    });
    assert.equal(r.result.isError ?? false, false, r.result.content[0].text);
    assert.deepEqual(s.ledger.list(), []);
    assert.equal(s.ledger.listBin().length, 1, '它得在回收站里（30 天能拿回来）');
    assert.ok(s.ledger.restore([rec.entryId]));
    assert.equal(s.ledger.list().length, 1);
  } finally {
    c.child.kill('SIGKILL'); s.sock.close();
  }
});

test('🔴 对得上好几笔 ⇒ **不猜**，把候选说出来让主人挑', async () => {
  const s = setup();
  s.ledger.write({ ...FIELD_ARGS, unit: '台' }, { said: FIELD_ARGS.said });
  s.ledger.write({ ...FIELD_ARGS, unit: '批' }, { said: FIELD_ARGS.said });
  const c = mcpClient({ HUPO_LEDGER_SOCKET: s.socketPath });
  try {
    const r = await c.call('tools/call', {
      name: 'ledger_delete',
      arguments: { date: FIELD_ARGS.date, kind: FIELD_ARGS.kind },
    });
    assert.equal(r.result.isError, true);
    const text = r.result.content[0].text;
    assert.ok(text.includes('2 笔'), text);
    assert.equal(s.ledger.list().length, 2, '说不清就一笔都不许动');
    assert.equal(s.ledger.listBin().length, 0);
  } finally {
    c.child.kill('SIGKILL'); s.sock.close();
  }
});

test('没说是哪一笔的删 ⇒ 拒绝，而且什么都没动', async () => {
  const s = setup();
  const rec = s.ledger.write(FIELD_ARGS, { said: FIELD_ARGS.said });
  const c = mcpClient({ HUPO_LEDGER_SOCKET: s.socketPath });
  try {
    const r = await c.call('tools/call', { name: 'ledger_delete', arguments: {} });
    assert.equal(r.result.isError, true);
    assert.equal(s.ledger.list().length, 1);
    assert.equal(s.ledger.list()[0].entryId, rec.entryId);
  } finally {
    c.child.kill('SIGKILL'); s.sock.close();
  }
});

test('🔴 删账那一层**不接受内部身份**：模型手里根本没有 id 可以传', async () => {
  const s = setup();
  s.ledger.write(FIELD_ARGS, { said: FIELD_ARGS.said });
  const c = mcpClient({ HUPO_LEDGER_SOCKET: s.socketPath });
  try {
    const list = await c.call('tools/list', {});
    const del = list.result.tools.find((t) => t.name === 'ledger_delete');
    assert.deepEqual(Object.keys(del.inputSchema.properties).sort(), ['date', 'kind', 'qty', 'unit']);
    // 列表那段文字里也不许出现身份
    const r = await c.call('tools/call', { name: 'ledger_list', arguments: {} });
    assert.ok(!r.result.content[0].text.includes('e1'), r.result.content[0].text);
  } finally {
    c.child.kill('SIGKILL'); s.sock.close();
  }
});

// ── ⑤⑥ 通道本身 ─────────────────────────────────────────────

test('🔴 本地通道的权限是 **0600**（准入就是它，不是令牌）', async () => {
  const s = setup();
  try {
    await s.sock.ready();
    const mode = nodeFs.statSync(s.socketPath).mode & 0o777;
    assert.equal(mode, 0o600, `套接字权限是 ${mode.toString(8)}，必须是 600`);
  } finally {
    s.sock.close();
  }
});

test('坏输入**只让那一条失败**（读不懂的一句、认不出的 op、超长的行）', async () => {
  const s = setup();
  const net = await import('node:net');
  const ask = (raw) => new Promise((resolve) => {
    const conn = net.connect(s.socketPath);
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('connect', () => conn.write(raw));
    conn.on('data', (c) => { buf += c; if (buf.includes('\n')) { conn.destroy(); resolve(buf.trim()); } });
    conn.on('error', (e) => resolve(`ERR ${e.code}`));
    conn.on('close', () => resolve(buf.trim()));
  });
  try {
    assert.match(await ask('这不是 JSON\n'), /读不懂/);
    assert.match(await ask(`${JSON.stringify({ op: '拿命来' })}\n`), /认不出/);
    assert.match(await ask(`${JSON.stringify({ nope: 1 })}\n`), /没说要做什么/);
    // 通道还活着
    const ok = await ask(`${JSON.stringify({ op: 'list' })}\n`);
    assert.match(ok, /"ok":true/);
  } finally {
    s.sock.close();
  }
});

test('🔴 stdio 上**只有 JSON-RPC**：多一行就把整条通道弄坏', async () => {
  const s = setup();
  const c = mcpClient({ HUPO_LEDGER_SOCKET: s.socketPath });
  try {
    await c.call('initialize', { protocolVersion: '2025-06-18' });
    await c.call('tools/list', {});
    await c.call('tools/call', { name: 'ledger_propose', arguments: FIELD_ARGS });
    const stray = c.stdout().filter((l) => {
      try { JSON.parse(l); return false; } catch { return true; }
    });
    assert.deepEqual(stray, [], `stdout 上不许有非 JSON-RPC 的行：${stray.join(' / ')}`);
    assert.ok(c.stderr.join('').length > 0, '诊断走 stderr（这也是负向对照：它确实说过话）');
  } finally {
    c.child.kill('SIGKILL'); s.sock.close();
  }
});

test('🔴 工具名与说明过禁用词闸（它们会进 prompt，等于上了界面）', async () => {
  const s = setup();
  const c = mcpClient({ HUPO_LEDGER_SOCKET: s.socketPath });
  try {
    const list = await c.call('tools/list', {});
    const blob = JSON.stringify(list.result.tools);
    for (const w of ['工作区', '客户端', '云端', '时间线', '会话', '口令', '记录', 'mcp__', 'socket', 'entryId']) {
      assert.ok(!blob.includes(w), `工具说明里出现了内部词「${w}」`);
    }
  } finally {
    c.child.kill('SIGKILL'); s.sock.close();
  }
});

// ── ★ **P1 §三④**：`work_status`（"他随时能问'那件怎么样了'"）──────────────
//
// 契约 `docs/dev/88-P1-TIME-WAIT.md` §三·④。这一条**只读**，但它守的事很硬：
//   · 模型拿到的那句话必须是**服务端拼的**（含"在哪一间"的名字），不是它自己猜的；
//   · 🔴 **没接上"活账" ⇒ 明确失败** —— 不许回一句"没有挂着的活"
//     （那正是"页面在说假话"：他明明有一件在做）。

/** 这一条回答里的那一段文字。 */
const textOf = (m) => m?.result?.content?.[0]?.text ?? '';

test('T4④c `work_status`：给回的是**服务端那句话**（原样转述，模型不许自己编）', async () => {
  const LINE = '还在做（在「看天气」里）';
  const seen = [];
  const s = setup({
    ctx: {
      dispatcher: () => ({
        workReport: ({ ref }) => (ref === 'u_1' ? LINE : null),
        workList: (o) => {
          seen.push(o);
          return [{ scopeId: 'city-weather', ref: 'u_1', turn: 3, state: 'running', text: LINE }];
        },
      }),
    },
  });
  // ★ 让这个 MCP 子进程"以为"自己跑在某一间里（调度器就是这么给它的）
  const c = mcpClient({ HUPO_LEDGER_SOCKET: s.socketPath, HUPO_SCOPE: 'city-weather' });
  try {
    // ① 全列：拿到的就是服务端那句话（一个字都不许自己编）
    const all = await c.call('tools/call', { name: 'work_status', arguments: {} });
    assert.equal(all.result.isError ?? false, false);
    assert.equal(textOf(all), LINE);
    // 🔴 **"我这一间"必须原样带到服务端**：它要拿它排掉"正在问的那一轮"自己
    //    （真机第一次就是没排，答成"那件还在做"，而那件就是这句提问）
    assert.deepEqual(seen.at(-1), { excludeScope: 'city-weather' });
    // ② 按原话问某一件事 ⇒ 也原样给回
    const one = await c.call('tools/call', { name: 'work_status', arguments: { ref: 'u_1' } });
    assert.equal(textOf(one), LINE);
    // ③ 账上没有那一件 ⇒ **明确失败**（不许空着、也不许编一句"快了"）
    const none = await c.call('tools/call', { name: 'work_status', arguments: { ref: 'u_没有这件' } });
    assert.equal(none.result.isError, true, '问不到那一件 ⇒ 必须是 isError');
    assert.match(textOf(none), /没有这一件/);
    // ④ 反例的正身：**这两条都不是白写的** —— 把 dispatcher 摘掉 ⇒ ①也红
    const noCtx = setup();
    const c2 = mcpClient({ HUPO_LEDGER_SOCKET: noCtx.socketPath });
    try {
      const r = await c2.call('tools/call', { name: 'work_status', arguments: {} });
      assert.equal(r.result.isError, true, '没接上"活账" ⇒ 必须 isError（**不许**回"没有挂着的活"）');
      assert.match(textOf(r), /问不到/);
    } finally {
      c2.child.kill('SIGKILL'); noCtx.sock.close();
    }
  } finally {
    c.child.kill('SIGKILL'); s.sock.close();
  }
});

test('T4④c 一件都没有 ⇒ 如实说"没有挂着的活"（**这不是失败**）', async () => {
  const s = setup({ ctx: { dispatcher: () => ({ workReport: () => null, workList: () => [] }) } });
  const c = mcpClient({ HUPO_LEDGER_SOCKET: s.socketPath });
  try {
    const r = await c.call('tools/call', { name: 'work_status', arguments: {} });
    assert.equal(r.result.isError ?? false, false, '没有活可报不是错误');
    assert.match(textOf(r), /没有挂着的活/);
  } finally {
    c.child.kill('SIGKILL'); s.sock.close();
  }
});
