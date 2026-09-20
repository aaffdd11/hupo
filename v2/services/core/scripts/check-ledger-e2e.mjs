#!/usr/bin/env node
// 账本的**端到端**检查：**真模型 + 真能力层**，看它会不会真的调那几条工具。
//
// ⚠️ **它花真钱、花真时间**（要跑两轮模型），所以**不进 `npm test`** ——
//    和 `check-capabilities.mjs` 一样是"发版前 / 改完能力层跑一次"的慢闸。
//
// 它验的是前面几道闸**都验不到**的那一环：
//   * `npm test` 验的是账本本体与那条通道（假 agent）；
//   * `check-capabilities.mjs` 验的是"dsh 会不会把服务器拉起来"；
//   * **只有这里**验的是"**模型会不会真的去调它**"。
//     这一条正是 V13 那条判据的形状：**客户端/模型自己算出来的东西，闸要打在这一侧**。
//
// 两轮（这正是 D6.5「不确认不写」的形状）：
//   ① 「帮我记一笔…」 ⇒ 它该调 `ledger_propose`（**回显**），而且**账本一条都不许多**
//   ② 「对，记吧」     ⇒ 它该调 `ledger_write`，账本**正好多一条**
//
// 用法：
//   node scripts/check-ledger-e2e.mjs
//   HUPO_E2E_MODEL=deepseek-flash node scripts/check-ledger-e2e.mjs
//
// 退出码：0 = 全过；非 0 = 哪一条没过就报哪一条。

import nodeChildProcess from 'node:child_process';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

const CORE = nodePath.resolve(nodePath.dirname(new URL(import.meta.url).pathname), '..');
const { Store } = await import(nodePath.join(CORE, 'src/store.js'));
const { Timeline } = await import(nodePath.join(CORE, 'src/timeline.js'));
const { Ledger } = await import(nodePath.join(CORE, 'src/ledger.js'));
const { LedgerSocket, ledgerSocketPath } = await import(nodePath.join(CORE, 'src/ledger-socket.js'));

const TURN_WAIT_MS = Number.parseInt(process.env.HUPO_E2E_TURN_WAIT_MS ?? '90000', 10);
const SAID = '帮我记一笔：今天装了三台空调，一台一千二，不含税，日期 2026-08-20。';

/**
 * ⚠️ **会话 id 每跑一次都要换一个**。
 * 复用一个固定的 id，第二次跑就会撞上 `session "e2e" already exists`
 * ——而那个错**不会**让你看到任何事件（整整 90 秒一条都没有），
 * 现场看起来像"模型不理人"。（`agent-runtime.js` 早踩过同一个坑：
 * 它给 DSH 的会话 id 是**带 bootId** 的。）
 */
const SESSION = `e2e-${Date.now().toString(36)}-${process.pid}`;

const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); process.exitCode = 1; };

// ── 一个**隔离**的账本（自己的数据目录、自己的口）────────────────
const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-e2e-'));
const store = new Store({ dataDir, fsync: false });
const timeline = new Timeline({ id: 'ledger', store });
const ledger = new Ledger({ store, timeline }).sync();
const sockPath = ledgerSocketPath(dataDir);
const sock = new LedgerSocket({ ledger, socketPath: sockPath }).listen();
await sock.ready();
console.log(`账本那条口：${sockPath}`);

const child = nodeChildProcess.spawn('dsh', [
  '--profile', 'sdk',
  '--patch', nodePath.join(CORE, 'hupo-persona.yml'),
  '--patch', nodePath.join(CORE, 'hupo-capabilities.yml'),
], {
  cwd: nodeOs.tmpdir(),
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PATH: `${nodePath.join(nodeOs.homedir(), '.nvm', 'versions', 'node', 'v24.15.0', 'bin')}:${process.env.PATH}`,
    HUPO_NODE_BIN: process.execPath,
    HUPO_LEDGER_SERVER: nodePath.join(CORE, 'src/mcp-ledger-server.mjs'),
    HUPO_LEDGER_SOCKET: sockPath,
  },
});

const events = [];
let buf = '';
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); continue; }
    // ⚠️ **通知的方法名用「点」，请求用「斜杠」**（`agent-runtime.js` 那个坑）。
    const isEvent = m.method === 'session.event' || m.method === 'session/event';
    if (isEvent && m.params?.event) events.push(m.params.event);
    else if (process.env.HUPO_E2E_DEBUG) console.log('[raw]', line.slice(0, 300));
  }
});
const stderr = [];
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => stderr.push(String(d)));

let id = 0;
const req = (method, params, ms) => new Promise((resolve) => {
  const myId = ++id;
  const t = setTimeout(() => { pending.delete(myId); resolve({ timeout: true }); }, ms);
  pending.set(myId, (m) => { clearTimeout(t); resolve(m); });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
});

const finished = () => events.some((e) => e.type === 'turn/end');
const toolCalls = () => events
  .filter((e) => e.type === 'tool/call')
  .map((e) => e.data?.name ?? e.name ?? '');
/** 模型这一轮**说给主人听的话**（只要 `text` 块；推理不算）。 */
const spoken = () => events
  .filter((e) => e.type === 'assistant/message')
  .flatMap((e) => (e.data?.message?.content ?? e.content ?? []))
  .filter((b) => b?.type === 'text')
  .map((b) => b.text)
  .join('');

const turn = async (text, label) => {
  events.length = 0;
  const t0 = Date.now();
  const resp = await req('session/prompt', { sessionId: SESSION, contentBlocks: [{ type: 'text', text }] }, TURN_WAIT_MS);
  if (process.env.HUPO_E2E_DEBUG) console.log('[prompt 响应]', JSON.stringify(resp).slice(0, 300));
  // ⚠️ prompt 的**响应**不等于这一轮说完（事件是另外推的）⇒ 等 `turn/end`。
  while (!finished() && Date.now() - t0 < TURN_WAIT_MS) {
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`\n───── ${label}（${Math.round((Date.now() - t0) / 1000)}s）─────`);
  const said = spoken().trim();
  if (said) console.log(`  它说：${said.slice(0, 200)}`);
  console.log(`  调了：${toolCalls().join('、') || '（没有调工具）'}`);
};

try {
  const init = await req('initialize', {
    cwd: nodePath.join(nodeOs.homedir(), 'hupo-workspace'),
    provider: 'deepseek-official',
    model: process.env.HUPO_E2E_MODEL ?? 'deepseek-flash',
    reasoningEffort: 'low',
    maxTokens: 16000,
  }, 120000);
  if (init.timeout || !init.result?.serverInfo) {
    bad(`agent 起不来：${JSON.stringify(init).slice(0, 200)}`);
  } else {
    ok(`agent 起来了（${init.result.serverInfo.name}）`);

    // ── ① 说"记一笔" ⇒ 只回显，**不写** ─────────────────────
    console.log('① 主人说「帮我记一笔…」');
    await turn(SAID, '第一轮');
    const calls1 = toolCalls();
    if (calls1.includes('mcp__ledger__ledger_propose')) ok('它调了 `ledger_propose`（**先把听到的念回来**）');
    else bad(`它没调 propose，调的是：${calls1.join('、') || '（空）'}`);
    if (calls1.some((n) => n.includes('ledger_write'))) bad('**它还没等人点头就写了** —— D6.5 被破了');
    else ok('它**没有**直接写（D6.5：钱数/日期不确认不写）');
    if (ledger.list().length === 0) ok('账本一条都没多（propose 只算不写）');
    else bad(`账本多了 ${ledger.list().length} 条 —— propose 碰盘了`);
    if (spoken().trim() !== '') ok('它对主人说了话（不是只在那儿想）');
    else bad('它一个字都没说给主人 —— 那正是手册事故一的形状');

    // ── ② 主人点头 ⇒ 真的写 ─────────────────────────────────
    console.log('② 主人说「对，记吧」');
    await turn('对，记吧。', '第二轮');
    const calls2 = toolCalls();
    if (calls2.includes('mcp__ledger__ledger_write')) ok('它调了 `ledger_write`（点头之后才写）');
    else bad(`它没调 write，调的是：${calls2.join('、') || '（空）'}`);

    const rows = ledger.list();
    if (rows.length === 1) ok('账本上正好多了一条');
    else bad(`账本上是 ${rows.length} 条（该正好 1 条）`);
    if (rows.length === 1) {
      const r = rows[0];
      const want = { kind: '装空调', qty: 3, unit: '台', unitPrice: 1200, tax: false, date: '2026-08-20' };
      const got = { kind: r.kind, qty: r.qty, unit: r.unit, unitPrice: r.unitPrice, tax: r.tax, date: r.date };
      if (JSON.stringify(got) === JSON.stringify(want)) ok(`六个字段都对：${JSON.stringify(got)}`);
      else bad(`字段听错了：${JSON.stringify(got)}`);
      if (r.said === SAID) ok('**原话**留下来了（D6.4 的出处）');
      else bad(`原话没留住：${JSON.stringify(r.said).slice(0, 80)}`);
      if (ledger.totals().total === 3600) ok('合计 3600');
      else bad(`合计不对：${ledger.totals().total}`);
    }
  }
} finally {
  console.log('\n===== 盘上那条账目 =====');
  console.log(JSON.stringify(ledger.list(), null, 2));
  child.kill('SIGKILL');
  sock.close();
  try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 尽力 */ }
  if (process.exitCode && stderr.length) {
    console.error('\ndsh 的 stderr（前几行）：');
    for (const line of stderr.join('').split('\n').slice(0, 8)) console.error(`  ${line}`);
  }
}

if (process.exitCode) { console.error('\n❌ 端到端**没通**：模型没有按 D6.4/D6.5 的形状用它'); process.exit(1); }
console.log('\n✅ 端到端通了：模型真的会「先回显确认、点头之后才写」');
