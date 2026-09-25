// **D 期：转交 / 未读 / 焦点告知**（契约 `docs/dev/100-DISPATCHER-D.md` §三 的 D-1…D-9）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
// 手册 `02-ARCHITECTURE.md` §3.5 那三件配套，从"设计"变成"能跑"：
//
//   ① **转交**（`handoff_to` ⇒ 服务端 `op:'handoff'`）：只有**工具调用**能发起 ·
//      目标必须已存在 · 一轮最多一次 · 禁回环 · 那条消息**不收口**、B 往
//      **同一个 `messageId`** 里写（一个气泡）；
//   ② **未读**：服务端**能查、能清、落盘**（客户端那个点由客户端画）；
//   ③ **焦点告知**：按**连接/设备**记 ＋ 答不准就标 `unknown`（叠加）。
//
// ── 两条不许走样的（§六）────────────────────────────────────
//   · **工具住哪**：现有那条 MCP（`mcp-ledger-server.mjs` → `handoff_to`）
//     ＋ 服务端 `op:'handoff'`。**不动能力层**、不新造通道。
//   · **标签语义**：续写事件的 `scopeId` 打**发起那一间**（用户可见的那一间），
//     "谁在干活"另加 `byScope`（**只**用于审计/用量）。
//
// ⚠️ 形状照 `focus.test.js` / `backend-work.test.js`：**真 `Worlds` ＋ 真 HTTP ＋
//    真 spawn（假 agent）＋ 真域套接字**（转交那一帧是**真的**问过去的）。
// ⚠️ 每条判据都带**反例的正身**（假的那一半当场红）。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { spawn as realSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { AgentRuntime } from '../src/agent-runtime.js';
import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { Worlds, scopeTimelineId } from '../src/worlds.js';
import { ScopeView } from '../src/timeline.js';
import { HandoffBook, decideHandoff, HANDOFF_LINES } from '../src/handoff.js';
import { FocusBook, resolveFocus } from '../src/focus-book.js';
import { UnreadBook, scopeUnread } from '../src/unread.js';
import { routeTarget } from '../src/focus.js';
import { handleLedgerOp } from '../src/ledger-socket.js';
import { HANDOFF_BRIEF_SAYS } from '../src/dispatcher.js';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const FAKE = nodePath.join(HERE, 'fake-agent.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const open = new Set();
const tmpDirs = [];
after(async () => {
  for (const h of open) {
    try {
      await h.close();
    } catch {
      /* 关不干净不影响结论 */
    }
  }
  open.clear();
  for (const d of tmpDirs) {
    try {
      nodeFs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 尽力 */
    }
  }
});

function tmp(prefix = 'hupo-handoff-') {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function cfgFor(dataDir, over = {}) {
  return {
    dataDir,
    dshHome: nodePath.join(dataDir, '__owner_dsh__'),
    agentCwd: nodePath.join(dataDir, '__owner_cwd__'),
    ledgerSocketPath: nodePath.join(dataDir, 'ledger.sock'),
    dshBin: 'unused',
    agentProfile: 'sdk',
    agentProvider: 'fake',
    agentModel: 'fake',
    agentEffort: 'low',
    agentMaxTokens: 512,
    agentBootTimeoutMs: 20000,
    agentMaxProcesses: 4,
    agentIdleEvictMs: 60000,
    personaPath: null,
    recap: {},
    turnDeadlineMs: 30000,
    ...over,
  };
}

/**
 * 起一套（形状照 `focus.test.js`）。
 * @param {object} [o]
 * @param {string} [o.scenario] 主线那个假 agent 跑哪个场景
 * @param {string} [o.target]   转交的目标（`handoff` 场景用）
 */
async function boot({ scenario = 'normal', target = '', reason = '', cfg: over = {} } = {}) {
  const dataDir = tmp();
  const cfg = cfgFor(dataDir, over);
  nodeFs.mkdirSync(cfg.dshHome, { recursive: true });
  nodeFs.mkdirSync(cfg.agentCwd, { recursive: true });

  let worlds = null;
  const runtime = new AgentRuntime({
    cfg,
    cfgFor: (key) => worlds.cfgForAgentKey(key),
    onEvict: (id) => worlds.onEvict(id),
    spawnFn: (bin, args, opts) =>
      realSpawn(process.execPath, [FAKE], {
        ...opts,
        env: {
          ...opts.env,
          FAKE_SCENARIO: scenario,
          // ★ **D 期**：转交那一帧要真的问过去 ⇒ 把它要的路径与目标给假 agent。
          //   ⚠️ 路径**不能**照 `cfg` 猜：多租户下账本那条口是**按人**派生的
          //      （`<data>/users/<id>/ledger.sock`）⇒ 从世界那份拿（`pathsFor`）。
          FAKE_LEDGER_SOCKET: worlds.pathsFor('u1').ledgerSocketPath,
          FAKE_HANDOFF_TARGET: target,
          FAKE_HANDOFF_REASON: reason,
        },
      }),
  });
  worlds = new Worlds({ cfg, runtime, log: () => {}, warn: () => {} });

  const auth = new Auth({ dataDir, lockAfter: 3, lockMs: 60_000 });
  auth.setPassword('test-pass');
  const { listen, close } = createServer({ worlds, auth, buildId: 'handoff-test' });
  const addr = await listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;

  const h = {
    dataDir,
    cfg,
    worlds,
    runtime,
    auth,
    origin,
    close: async () => {
      open.delete(h);
      await worlds.shutdownDispatchers();
      await runtime.shutdown();
      await close();
      worlds.closeSockets();
      nodeFs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  open.add(h);
  return h;
}

const tokenFor = (h, sub = 'u1') => h.auth.issue({ sub }).token;
const get = (h, path, sub = 'u1') =>
  fetch(`${h.origin}${path}`, { headers: { authorization: `Bearer ${tokenFor(h, sub)}` } });
const post = (h, path, body, sub = 'u1') =>
  fetch(`${h.origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor(h, sub)}` },
    body: JSON.stringify(body),
  });

async function waitFor(pred, why, ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await sleep(25);
  }
  throw new Error(`等不到：${why}（等了 ${ms}ms）`);
}

/** 造一间**真存在**的房间（照 `focus.test.js` 那条：工作区 ＋ 登记成 app）。 */
function makeScope(h, id, title = id, sub = 'u1') {
  const w = h.worlds.worldFor(sub);
  w.apps.create({
    id,
    title,
    icon: 'dice',
    entry: 'index.html',
    files: { 'index.html': `<p>${id}</p>` },
  });
  h.worlds.roomFor(sub, id);
  return w;
}

/** 盘上那条日志（**真日志**，不是内存里那份）。 */
const logEvents = (dir) => {
  const f = nodePath.join(dir, 'main.jsonl');
  if (!nodeFs.existsSync(f)) return [];
  return nodeFs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

const textOf = (events) =>
  events.filter((e) => e.type === 'message/text').map((e) => e.text ?? '').join('');
const ofMessage = (events, messageId) => events.filter((e) => e.messageId === messageId);

/** 连一条流（真 `ws`）。 */
function wsConnect(h, { sub = 'u1', scope = null, device = null } = {}) {
  const protocols = ['bearer', tokenFor(h, sub)];
  const qs = new URLSearchParams({ sinceSeq: '0' });
  if (scope) qs.set('scope', scope);
  if (device) qs.set('device', device);
  const url = `${h.origin.replace(/^http/, 'ws')}/api/stream?${qs}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols);
    const frames = [];
    ws.on('message', (d) => {
      try {
        frames.push(JSON.parse(d.toString()));
      } catch {
        /* 不是 JSON 的帧不算 */
      }
    });
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('error', (err) => reject(err));
  });
}

// ════════════════════════════════════════════════════════════════
// D-1 · 转交只能由**工具调用**发起（正文里说一句不算）
// ════════════════════════════════════════════════════════════════

test('🔴 D-1：转交只能由工具调用发起 —— 正文里说"我转给某一间"**不算**、也不留记录', async () => {
  // ① **反例那半先跑**：一轮正文里**说**"我把它转给看天气那一间"，没调工具。
  //    （`normal` 场景：假 agent 只会说话，一个工具都不调。）
  const h = await boot({ scenario: 'normal' });
  const w = makeScope(h, 'city-weather', '看天气');
  assert.equal(
    (await post(h, '/api/say', { messageId: 'u_plain', text: '这件事你帮我看看' })).status,
    200,
  );
  await waitFor(
    () => logEvents(w.dir).some((e) => e.type === 'message/end' && e.messageId !== 'u_plain'),
    '那一轮要收口',
  );
  await sleep(150);
  // 🔴 **判据本体**：盘上**一条转交记录都没有**，也没有任何转交状态事件。
  assert.equal(w.dispatcher.handoffs.all().length, 0, '🔴 正文里说一句就留下转交记录 = D-1 的反例');
  assert.equal(
    logEvents(w.dir).some((e) => e.type === 'message/handoff'),
    false,
    '🔴 正文里说一句就打上"转交"状态 = 自然语言当控制面',
  );
  // ★ 反例的正身：**正文里那句话本身**可以出现在回答里（我们不解析它、也不当承诺）。
  assert.equal(
    nodeFs.existsSync(nodePath.join(w.dir, 'handoffs.jsonl')),
    false,
    '★ 连那本账的文件都不该被建出来（没有转交就没有账）',
  );

  // ①b 🔴 **工具那条口本身也要"真的裁决"**：一个不存在的目标 ⇒ 它必须拒
  //     （这正是"谁说什么都算转交"那条反例的落点：把这条口的裁决去掉 ⇒ 红）。
  const refusal = handleLedgerOp(
    w.ledger,
    { op: 'handoff', target: '没有这一间', scope: 'main' },
    { dispatcher: () => w.dispatcher },
  );
  assert.equal(refusal.ok, false, `🔴 工具那条口不裁决了：${JSON.stringify(refusal)}`);
  assert.equal(refusal.reason, 'missing');
  assert.equal(w.dispatcher.handoffs.all().length, 0, '🔴 被拒的转交不许留下记录');

  // ② **正身**：真的调一次工具（`handoff` 场景 ⇒ 真域套接字那一帧）。
  const h2 = await boot({ scenario: 'handoff', target: 'city-weather', reason: '那边更合适' });
  const w2 = makeScope(h2, 'city-weather', '看天气');
  assert.equal(
    (await post(h2, '/api/say', { messageId: 'u_tool', text: '这件事你帮我看看' })).status,
    200,
  );
  await waitFor(() => w2.dispatcher.handoffs.all().length === 1, '工具那条路要留下一条转交记录');
  const rec = w2.dispatcher.handoffs.all()[0];
  assert.equal(rec.scopeId, 'main', '★ 发起那一间 = 他提问的那一间');
  assert.equal(rec.target, 'city-weather');
  // ★ **锚在那条"还没说完的回答"上**（手册 §3.5 ②：A 那条**不收口**的那个气泡）——
  //   不是他那句提问（`u_tool`）：客户端那一个气泡就是这条 `message/*`。
  assert.equal(rec.messageId.startsWith('m_'), true, `★ 锚在服务端那条消息上：${rec.messageId}`);
  assert.ok(
    logEvents(w2.dir).some((e) => e.type === 'message/start' && e.messageId === rec.messageId),
    '★ 那条消息真的开了口（前半段就是它）',
  );
  assert.equal(rec.reason, '那边更合适', '★ 交接包要带"为什么"');
  await waitFor(() => w2.dispatcher.handoffs.byId(rec.id)?.status !== 'recorded', '目标要真接过去');
  // 🔴 **可见标签**是发起那一间（§6.2）
  assert.equal(
    logEvents(w2.dir).some((e) => e.type === 'message/handoff' && e.scopeId === 'main'),
    true,
    '★ 转交状态打在发起那一间上',
  );
  await h.close();
  await h2.close();
});

// ════════════════════════════════════════════════════════════════
// D-2 · 一轮最多一次 ＋ 禁回环（手册 N16）
// ════════════════════════════════════════════════════════════════

test('🔴 D-2：`A→B→A` **必须被拒**；同一条消息再转一次 ⇒ 拒（一轮最多一次）', async () => {
  // ① **纯判据的正身 / 反例**：同一条消息上已经有一条从 A 发出的转交 ⇒ 回 A = 转圈。
  const records = [{ scopeId: 'alpha', target: 'beta', messageId: 'u_1' }];
  assert.deepEqual(
    decideHandoff({ by: 'beta', target: 'alpha', targetExists: true, messageId: 'u_1', records }),
    { ok: false, reason: 'loop', text: HANDOFF_LINES.loop },
    '🔴 回环放行 = 手册 N16 那条被破了',
  );
  assert.equal(
    decideHandoff({ by: 'alpha', target: 'gamma', targetExists: true, messageId: 'u_1', records }).reason,
    'twice',
    '★ 同一条消息的第二次转交一律拒（一轮最多一次）',
  );
  assert.equal(
    decideHandoff({ by: 'alpha', target: 'beta', targetExists: true, messageId: 'u_2', records: [] }).ok,
    true,
    '★ 负向对照：干净的一条消息、存在的目标 ⇒ 放行（证明上面两条不是恒假）',
  );

  // ② **真那条路**：A（主线）转给 beta，然后**从 beta 转回主线** ⇒ 服务端拒。
  const h = await boot({ scenario: 'handoff', target: 'beta' });
  const w = makeScope(h, 'beta', '乙屋');
  assert.equal((await post(h, '/api/say', { messageId: 'u_1', text: '这件事看一下' })).status, 200);
  await waitFor(() => w.dispatcher.handoffs.all().length === 1, '第一条转交没落账');
  // beta 那一轮的工具口再转回主线 —— 用**真那条口**（`handleLedgerOp`，与 MCP 同一条）
  const back = handleLedgerOp(
    w.ledger,
    { op: 'handoff', target: 'main', reason: '还是你来', scope: 'beta' },
    { dispatcher: () => w.dispatcher },
  );
  assert.equal(back.ok, false, `🔴 A→B→A 被放行了：${JSON.stringify(back)}`);
  assert.equal(back.reason, 'loop');
  assert.equal(w.dispatcher.handoffs.all().length, 1, '🔴 拒了却还是记了一条 = 拒了个寂寞');
  // 负向对照：**换一个真存在的目标**、换一条消息 ⇒ 放行（说明上面那条不是恒假）
  const elsewhere = decideHandoff({
    by: 'beta',
    target: 'gamma',
    targetExists: true,
    messageId: 'u_2',
    records: [],
  });
  assert.equal(elsewhere.ok, true);

  // ③ **同一条消息**再转一次（同一个目标）⇒ 如实回"已经转过去了"，**不产生第二条**
  //    ⚠️ 到这一步那条链已经被目标接过去（`completed`）⇒ 重复那一下要认的是
  //    "**我**转出去的"（链上那条记录），不是"目标一样"。
  const dup = handleLedgerOp(
    w.ledger,
    { op: 'handoff', target: 'beta', scope: 'main' },
    { dispatcher: () => w.dispatcher },
  );
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicate, true, '★ 重复要如实说"已经转过去了"（不制造第二个副作用）');
  assert.equal(w.dispatcher.handoffs.all().length, 1, '🔴 一轮最多一次：不许留下第二条');
  await h.close();
});

// ════════════════════════════════════════════════════════════════
// D-3 · 目标必须已存在（**不许顺手建一个**）
// ════════════════════════════════════════════════════════════════

test('🔴 D-3：转交给**不存在**的房 ⇒ 拒；而且**不建**那一间（盘上不留痕）', async () => {
  const h = await boot({ scenario: 'normal' });
  const w = h.worlds.worldFor('u1');
  // 这一间**不在**制品库里、工作区也没有 ⇒ `existsScope` 必须如实说"没有"
  const dir = h.worlds.pathsFor('u1', 'nope').agentCwd;

  const r = handleLedgerOp(
    w.ledger,
    { op: 'handoff', target: 'nope', reason: '那边做', scope: 'main' },
    { dispatcher: () => w.dispatcher },
  );
  assert.equal(r.ok, false, `🔴 转给不存在的房被放行了：${JSON.stringify(r)}`);
  assert.equal(r.reason, 'missing');
  assert.match(r.text, /没有那一间/);
  // 🔴 **不许顺手建一个**：目录与账都不许冒出来
  assert.equal(nodeFs.existsSync(dir), false, '🔴 顺手把目标建出来了 —— 正是 D-3 的反例');
  assert.equal(w.dispatcher.handoffs.all().length, 0, '🔴 没转成却留了记录');
  assert.equal(w.dispatcher.scopes().includes('nope'), false, '★ 也不许给它挂一条会话');

  // ★ 负向对照：**先真的建出来**（同一个名字）⇒ 同一句就放行了（判据不是恒假）
  makeScope(h, 'nope', '那边');
  const ok = handleLedgerOp(
    w.ledger,
    { op: 'handoff', target: 'nope', reason: '那边做', scope: 'main' },
    { dispatcher: () => w.dispatcher },
  );
  // ⚠️ 到这一步它会因为"没有一条正在说的消息"另谋出路（下面的 D-4 才造消息），
  //    所以这里只验**不是 `missing`** —— 那正是"存在"与"不存在"的分水岭。
  assert.notEqual(ok.reason, 'missing', `★ 目标真存在之后就不该再以"没有那一间"拒：${JSON.stringify(ok)}`);
  await h.close();
});

// ════════════════════════════════════════════════════════════════
// D-3·补 · 目标"存在，但还没被打开过" ⇒ 照旧送得到（**不建**前提不变）
// ════════════════════════════════════════════════════════════════

test('🔴 D-3·补：目标**存在但他没点开过**（会话还没挂上来）⇒ 转交照样送得到', async () => {
  const h = await boot({ scenario: 'handoff', target: 'beta' });
  const w = h.worlds.worldFor('u1');
  // ★ 只在**制品库**里造出来（模拟"桌面上有那个图标，但这一轮还没打开过"）——
  //    **不**调 `roomFor` ⇒ 调度器手上没有这一间的会话。
  w.apps.create({
    id: 'beta',
    title: '乙屋',
    icon: 'dice',
    entry: 'index.html',
    files: { 'index.html': '<p>x</p>' },
  });
  assert.equal(w.dispatcher.sessionFor('beta'), null, '★ 起点：这一间还没挂上来');
  assert.equal(
    (await post(h, '/api/say', { messageId: 'u_1', text: '这件事看一下' })).status,
    200,
  );
  await waitFor(() => w.dispatcher.sessionFor('beta') !== null, '目标那一间要能被挂上来');
  await waitFor(() => w.dispatcher.handoffs.all().length === 1, '转交没落账');
  const mid = w.dispatcher.handoffs.all()[0].messageId;
  await waitFor(
    () => logEvents(w.dir).some((e) => e.type === 'message/text' && e.messageId === mid && e.byScope === 'beta'),
    '🔴 目标那一间没被挂上来 ⇒ 这件活**没人接**（而它明明存在）',
  );
  await waitFor(
    () => logEvents(w.dir).some((e) => e.type === 'message/end' && e.messageId === mid),
    '这条要收口',
  );
  await h.close();
});

// ════════════════════════════════════════════════════════════════
// D-4 · 同一条消息：A 那条**不收口**，B 往**同一个 `messageId`** 里写
// ════════════════════════════════════════════════════════════════

test('🔴 D-4：A 那条**不收口**；B 往**同一个 `messageId`** 里写（一个气泡、一个标签）', async () => {
  const h = await boot({ scenario: 'handoff', target: 'beta', reason: '那边更合适' });
  const w = makeScope(h, 'beta', '乙屋');
  assert.equal((await post(h, '/api/say', { messageId: 'u_1', text: '这件事看一下' })).status, 200);

  // ★ **先认准那条消息**（客户端那个气泡）：转交锚在**A 那条回答**上
  //   （不是他那句提问 `u_1` —— 那是 `user/echo`）。
  await waitFor(() => w.dispatcher.handoffs.all().length === 1, '转交没落账');
  const mid = w.dispatcher.handoffs.all()[0].messageId;
  await waitFor(
    () => {
      const evs = ofMessage(logEvents(w.dir), mid);
      return evs.some((e) => e.type === 'message/text' && e.byScope === 'beta');
    },
    'B 的续写没落盘',
  );
  await waitFor(
    () => logEvents(w.dir).some((e) => e.type === 'message/end' && e.messageId === mid),
    '这条消息没人收口（N19 不许留"永远马上说完"的气泡）',
  );
  await sleep(150);
  const evs = ofMessage(logEvents(w.dir), mid);

  // ① **一条消息、一套 start/end**（B 没有另起一条）
  assert.equal(evs.filter((e) => e.type === 'message/start').length, 1, '🔴 B 另起了一条 ⇒ 两个气泡');
  assert.equal(evs.filter((e) => e.type === 'message/end').length, 1, '🔴 收口两次 / 没收到口');
  assert.equal(evs.filter((e) => e.type === 'message/handoff').length, 1, '★ 转交状态只有一条');
  // ② **前后半段都在**（少一半 = "页面在说假话"）
  const text = textOf(evs);
  assert.match(text, /我先起个头。/, `★ 前半段要在：${text}`);
  assert.match(text, /好，我接着做。/, `★ 后半段要在（那是 B 写的）：${text}`);
  // ③ 🔴 **可见标签是发起那一间**（§6.2）：续写的事件也打 main
  const wrote = evs.filter((e) => e.type === 'message/text');
  assert.equal(
    wrote.every((e) => e.scopeId === undefined || e.scopeId === null || e.scopeId === 'main' || e.scopeId === 'main'),
    true,
    `🔴 续写事件打上了干活者的标签 ⇒ 视图会裂：${JSON.stringify(wrote.map((e) => e.scopeId))}`,
  );
  // ④ ★ **谁在干活**另加一个字段（审计/用量）——**不是**可见标签
  assert.equal(
    wrote.some((e) => e.byScope === 'beta'),
    true,
    `★ 后半段要带上"谁在干活"：${JSON.stringify(wrote)}`,
  );
  // ⑤ ★ **可见那一间的视图里，整条答案都在**（他提问的那一间看得到头也看得到尾）
  const mainView = w.timeline;
  const seen = mainView.readAll().filter((e) => e.messageId === mid);
  assert.match(
    textOf(seen),
    /我先起个头。[\s\S]*好，我接着做。/,
    `🔴 他提问的那一间里答案少了一半：${textOf(seen)}`,
  );
  assert.equal(
    seen.some((e) => e.type === 'message/end' && e.byScope === 'beta'),
    true,
    '★ 收口那一帧要记着"是谁收的"',
  );
  // ⑥ **反例的正身**：拿**干活者那一间**的视图去挑 ⇒ 它**挑不到**
  //    （证明③那条不是恒真：标签真的打在**发起那一间**上）
  const betaView = new ScopeView({ timeline: mainView.base, scope: 'beta' });
  assert.equal(
    betaView.readAll().filter((e) => e.messageId === mid).length,
    0,
    '🔴 续写事件被打上了干活者的标签 ⇒ 视图会裂成两半',
  );
  await h.close();
});

// ════════════════════════════════════════════════════════════════
// D-5 · 不投递：他在 B 时 A 做完了 ⇒ 结果**不进 B**
// ════════════════════════════════════════════════════════════════

test('🔴 D-5：他在乙间时甲间做完了 ⇒ **不实时推给乙**；甲的历史里查得到', async () => {
  // ⚠️ `slow`：甲那一轮 1.5 秒才收口 ⇒ "他在乙间"这件事活得到收口之后。
  const h = await boot({ scenario: 'slow', cfg: { backgroundAfterMs: 9999 } });
  const w = makeScope(h, 'alpha');
  makeScope(h, 'beta');
  // 甲先开一轮（`slow` 那条），紧接着把焦点切到乙
  // ⚠️ 先连**甲**（这一段他确实在甲那儿 ⇒ 第 16 条不反问），再切到乙。
  const c = await wsConnect(h, { scope: 'alpha' });
  await waitFor(() => c.frames.some((f) => f.type === 'client/hello'), 'hello 没来');
  // ⚠️ **等调度器真的记下焦点再发**：`hello` 是我们发出去的，而"焦点已经记下"
  //    是**这一侧**的事实（不等的话 `/api/say` 看到的是"还没告知过"那份）。
  await waitFor(() => w.dispatcher.focusScope === 'alpha', '焦点没记到 alpha');
  assert.equal(
    (await post(h, '/api/say', { messageId: 'u_a', text: '甲房那件事', scope: 'alpha' })).status,
    200,
  );
  // 他切走了（不重连）——此后甲的输出现时到**没人在看**的那一间
  c.ws.send(JSON.stringify({ t: 'focus', scope: 'beta' }));
  await waitFor(
    () => c.frames.some((f) => f.type === 'client/focus' && f.ok === true && f.scope === 'beta'),
    '切焦点没确认',
  );
  await waitFor(
    () => logEvents(w.dir).some((e) => e.type === 'message/end' && e.scopeId === 'alpha'),
    '甲那一轮收口',
  );
  await sleep(250);
  // 🔴 **判据本体**：这条连接（焦点已经在乙）**收不到甲间那一轮的输出**。
  //   ⚠️ 只算**它自己说的话之外**的那些帧（`user/echo` 是切焦点之前就到的，
  //      它本来就该到 —— 拿它当"甲的输出"会让这条判据变成恒假）。
  const agentFramesOfAlpha = () =>
    c.frames.filter(
      (f) => f.scopeId === 'alpha' && typeof f.type === 'string' && f.type.startsWith('message/'),
    );
  assert.equal(
    agentFramesOfAlpha().length,
    0,
    `🔴 甲间做完了却实时推给了乙：${JSON.stringify(agentFramesOfAlpha())}`,
  );
  // 而它**确实在**甲那一间的历史里（"搁置"不是"不投递"）
  const page = await get(h, '/api/timeline?before=9999&limit=100&scope=alpha');
  assert.equal(page.status, 200);
  assert.match(
    (await page.json()).frames.map((f) => f.text ?? '').join('\n'),
    /慢的结果来了|甲房那件事/,
    '★ 结果要进甲自己的会话历史',
  );
  c.ws.close();
  await h.close();
});

// ════════════════════════════════════════════════════════════════
// D-6 · 未读：能查、能清、落盘
// ════════════════════════════════════════════════════════════════

test('🔴 D-6：有新东西 ⇒ 答得出"有未读"；他打开过那一间 ⇒ 没了（＋落盘）', async () => {
  const h = await boot({ scenario: 'normal' });
  const w = h.worlds.worldFor('u1');
  // 一开始：什么都还没有 ⇒ 不带点
  let r = await get(h, '/api/unread');
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).unread, [], '★ 空房间不许带点（动作可静默）');

  // ① 他不在那一间时冒出东西 ⇒ **有未读**
  assert.equal((await post(h, '/api/say', { messageId: 'u_1', text: '帮我记一下' })).status, 200);
  await waitFor(
    () => logEvents(w.dir).some((e) => e.type === 'message/end'),
    '这一轮要收口',
  );
  r = await get(h, '/api/unread');
  const now = (await r.json()).unread;
  assert.equal(now.length > 0, true, '🔴 有新东西却答"没有未读" = 事实被静默');
  const mainOne = now.find((x) => x.scopeId === 'main');
  assert.ok(mainOne, `★ 主对话那一间要带点：${JSON.stringify(now)}`);
  assert.equal(mainOne.lastSeq > mainOne.lastReadSeq, true, '★ 号要真的在前头');
  // ② **落盘**：换一本（新进程）从盘上重建 ⇒ 照样答得出
  const book = new UnreadBook({ dir: w.dir, store: new Store({ dataDir: w.dir, fsync: false }) });
  assert.equal(book.list().length > 0, true, '★ 重启之后照样答得出（盘上那份）');

  // ③ **他打开过那一间** ⇒ 点没了
  const read = await post(h, '/api/unread/read', { scope: 'main' });
  assert.equal(read.status, 200);
  assert.deepEqual((await read.json()).unread, [], '★ 打开过就没了（D-6 的反面）');
  r = await get(h, '/api/unread');
  assert.deepEqual((await r.json()).unread, []);
  // ④ 新的一句 ⇒ 又有了（证明上面那条不是"永远不带点"）
  assert.equal((await post(h, '/api/say', { messageId: 'u_2', text: '再说一句' })).status, 200);
  await waitFor(
    () => logEvents(w.dir).some((e) => e.type === 'message/end' && e.messageId !== 'u_1' && e.messageId !== 'u_2'),
    '第二句收口',
  );
  r = await get(h, '/api/unread');
  assert.equal((await r.json()).unread.length > 0, true, '★ 又来新东西 ⇒ 点又出来（判据不是恒假）');

  // ⑤ **纯判据的正身 / 反例**（口径只有一处）
  const events = logEvents(w.dir);
  const lastSeq = Math.max(...events.map((e) => e.seq));
  assert.deepEqual(scopeUnread({ events, lastRead: {}, scope: 'main' }), {
    unread: true,
    lastSeq,
    lastReadSeq: 0,
  });
  assert.equal(scopeUnread({ events, lastRead: { main: lastSeq }, scope: 'main' }).unread, false);
  // ★ 没有事件的房间**不算**未读
  assert.equal(scopeUnread({ events, lastRead: {}, scope: 'never-used' }).unread, false);

  // ⑥ 认不出的 scope ⇒ **404 且什么都不记**（不许悄悄记到主线头上）
  const bad = await post(h, '/api/unread/read', { scope: 'nope' });
  assert.equal(bad.status, 404);
  const after = await get(h, '/api/unread');
  assert.equal((await after.json()).unread.length > 0, true, '★ 拒了之后不许把别的点顺手清掉');
  // ★ **转交那半的挂法**（§6.2）：可见标签是发起那一间 ⇒ 未读点也在那一间
  assert.equal(scopeTimelineId('main'), 'main');
  await h.close();
});

// ════════════════════════════════════════════════════════════════
// D-7 · 回收前落盘：agent 卸下之后结果仍查得到
// ════════════════════════════════════════════════════════════════

test('🔴 D-7：agent 被卸下之后，那件事/那条消息**仍查得到**（换一个进程读盘）', async () => {
  const h = await boot({ scenario: 'handoff', target: 'beta' });
  const w = makeScope(h, 'beta', '乙屋');
  assert.equal((await post(h, '/api/say', { messageId: 'u_1', text: '这件事看一下' })).status, 200);
  await waitFor(() => w.dispatcher.handoffs.all().length === 1, '转交没落账');
  const mid7 = w.dispatcher.handoffs.all()[0].messageId;
  await waitFor(
    () => logEvents(w.dir).some((e) => e.type === 'message/end' && e.messageId === mid7),
    '转交这条要收口并落盘',
  );

  // ① **把它卸下来**（真的卸：超时硬收口那条路会先收口、再让 runtime 卸）
  await w.dispatcher.sessionFor('beta').onEvict('u1/beta');
  await h.runtime.stop('u1/beta', { reason: 'test-evict' }).catch(() => {});
  await sleep(50);
  // ⚠️ 这里**不**断言"runtime 里取不到它"：`runtime.agent()` 会**按需再起一个**
  //    （那是它的正常语义），所以那个断言测的是别的事。判据要的是
  //    "**卸下这个动作做过之后**，结果照样查得到"——见下。
  assert.equal(typeof h.runtime.stop, 'function');

  // ② **换一个进程读盘**（新 `Store` / 新那两本账）⇒ 结果照样查得到
  const store = new Store({ dataDir: w.dir, fsync: false });
  const fresh = new HandoffBook({ dir: w.dir });
  const rec = fresh.byMessage(mid7);
  assert.equal(rec.length, 1, '🔴 卸下之后转交记录查不到了');
  assert.equal(rec[0].status, 'completed', '★ 状态也要落盘（不只是"发生过"）');
  assert.equal(rec[0].byScope, 'beta', '★ 谁干的也要落盘');
  const events = store.readAll('main').filter((e) => e.messageId === mid7);
  assert.equal(events.some((e) => e.type === 'message/end'), true, '🔴 卸下之后那条消息查不到了');
  assert.match(textOf(events), /好，我接着做。/, '★ 结果正文在盘上（不是只在内存里）');

  // ③ **反例的正身**：把盘上那条收口抹掉 ⇒ 判据当场变假（证明它不是恒真）
  const raw = nodeFs
    .readFileSync(nodePath.join(w.dir, 'main.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .filter((l) => !(l.includes('"type":"message/end"') && l.includes(`"${mid7}"`)));
  nodeFs.writeFileSync(nodePath.join(w.dir, 'main.jsonl'), `${raw.join('\n')}\n`);
  const wiped = new Store({ dataDir: w.dir, fsync: false });
  assert.equal(
    wiped.readAll('main').some((e) => e.type === 'message/end' && e.messageId === mid7),
    false,
    '★ 抹掉之后就该查不到（这一条判据不是恒真）',
  );
  await h.close();
});

// ════════════════════════════════════════════════════════════════
// D-8 · 状态拆分：`handoff`（不收口）与「挪走」（先收口）不是同一个值
// ════════════════════════════════════════════════════════════════

test('🔴 D-8：`handoff` 与「挪走」**不是同一个值**（决策 D10.4 点名）', async () => {
  // ① **语义分家**（纯判据）：转交 = 不收口、同一条继续写。
  //    那条路上**不许**出现收口 —— 而"挪走"的定义就是"先收口"。
  const h = await boot({ scenario: 'handoff', target: 'beta' });
  const w = makeScope(h, 'beta', '乙屋');
  assert.equal((await post(h, '/api/say', { messageId: 'u_1', text: '这件事看一下' })).status, 200);
  // ⚠️ **在目标开写之前**取样：这一刻 A 已经"交出去了"，而那条消息**还没收口**。
  await waitFor(() => w.dispatcher.handoffs.all().length === 1, '转交没落账');
  const mid8 = w.dispatcher.handoffs.all()[0].messageId;
  const atHandoff = ofMessage(logEvents(w.dir), mid8);
  assert.equal(
    atHandoff.some((e) => e.type === 'message/handoff'),
    true,
    '★ 转交要有**它自己那个状态值**（`message/handoff`）',
  );
  assert.equal(
    atHandoff.some((e) => e.type === 'message/end'),
    false,
    '🔴 转交那一刻就收口 = 把它做成了"挪走"（两者共用一个标记 · D10.4 禁）',
  );

  // ② **两个值确实不同**（形状上钉死：不是同一个 `type`、也不是同一个 `reason`）
  await waitFor(
    () => logEvents(w.dir).some((e) => e.type === 'message/end' && e.messageId === mid8),
    '后面那半要收口',
  );
  const evs = ofMessage(logEvents(w.dir), mid8);
  const handoffEvent = evs.find((e) => e.type === 'message/handoff');
  const endEvent = evs.find((e) => e.type === 'message/end');
  assert.equal(typeof handoffEvent.type, 'string');
  assert.notEqual(handoffEvent.type, endEvent.type, '🔴 两种语义共用一个标记 = D10.4 要拆的那件事');
  assert.equal(handoffEvent.messageId, endEvent.messageId, '★ 同一个气泡（前半后半同一条）');
  // ★ "挪走"那条路（先收口、另起一条）今天**没有**生产入口；这里把它的形状
  //   钉成"另一种"，免得以后谁拿 `message/handoff` 去当它。
  assert.equal(
    evs.filter((e) => e.type === 'message/end').length,
    1,
    '★ 收口只有一次（挪走那条路会是"一收口 + 另一条 start"）',
  );
  await h.close();
});

// ════════════════════════════════════════════════════════════════
// D-9 · 焦点告知：按连接/设备记 ＋ 答不准就 `unknown`（叠加）
// ════════════════════════════════════════════════════════════════

test('🔴 D-9：焦点按**设备**记；没带/没告知/多台矛盾 ⇒ `unknown`（**不许**拿最新那台顶替）', async () => {
  const h = await boot({ scenario: 'normal' });
  const w = makeScope(h, 'alpha', '甲屋');
  makeScope(h, 'beta', '乙屋');
  const d = w.dispatcher;

  // ① **纯判据的正身 / 反例**（三档，一条都不许少）
  assert.deepEqual(resolveFocus({ device: null, byDevice: {}, fallback: 'alpha' }), {
    scope: 'alpha',
    known: true,
  }, '★ 不带设备标识 ⇒ 老行为（C 期那一份）');
  assert.deepEqual(
    resolveFocus({ device: 'phone', byDevice: {}, fallback: 'alpha' }),
    { scope: null, known: false },
    '🔴 带了设备标识、那台又没告知过 ⇒ 就是"不知道"（**不许**退回别的那一份）',
  );
  assert.deepEqual(
    resolveFocus({ device: 'tablet', byDevice: { phone: 'alpha' }, fallback: null }),
    { scope: null, known: false },
    '🔴 这台从没告知过 ⇒ 必须标 unknown，**不许**拿别台的顶替',
  );
  assert.deepEqual(
    resolveFocus({ device: 'tablet', byDevice: { phone: 'alpha', ipad: 'beta' }, fallback: 'alpha' }),
    { scope: null, known: false },
    '🔴 多台矛盾 ⇒ unknown（那正是"最后被告知的那一个"要修掉的病）',
  );
  assert.deepEqual(
    resolveFocus({ device: 'tablet', byDevice: { phone: 'alpha', ipad: 'alpha' }, fallback: null }),
    { scope: null, known: false },
    '★ 别的设备说法一致**也不顶替**：这一台自己没说过话 ⇒ 就是"不知道"',
  );

  // ② **真那条路**：两台设备各说一套 ⇒ 这一份是 `unknown`，第 16 条**反问**
  const a = await wsConnect(h, { scope: 'alpha', device: 'phone' });
  await waitFor(() => a.frames.some((f) => f.type === 'client/hello'), 'phone 那条流没连上');
  const b = await wsConnect(h, { scope: 'beta', device: 'tablet' });
  await waitFor(() => b.frames.some((f) => f.type === 'client/hello'), 'tablet 那条流没连上');
  assert.equal(d.focusFor('phone').scope, 'alpha', '★ 甲那台的口径');
  assert.equal(d.focusFor('tablet').scope, 'beta', '★ 乙那台的口径');
  // 🔴 **别的设备来问**：不许拿"最新那台"（tablet/beta）顶替
  const other = d.focusFor('laptop');
  assert.equal(other.known, false, '🔴 没告知过的那台被塞了"最新那台"的答案');
  // ★ **老字段仍在**（协议只加不改）：它只回答"**没带设备标识**的那些连接"
  //   说的最后一句 —— 两台**都带了设备标识** ⇒ 它压根没被污染（这正是 D-9
  //   要修的那个病：拿"最新那台"当"他现在就在这儿"）。
  assert.equal(d.focusScope, null, '🔴 带了设备标识的焦点**不许**污染 C 期那一份');
  assert.equal(d.focusFor(null).scope, null, '★ 不带设备标识、也没人告知过 ⇒ 不比较（老行为）');

  // ③ **用到焦点的地方**（第 16 条那句反问）按"不知道"处理 ⇒ 该问就问
  assert.deepEqual(routeTarget({ hint: 'beta', focus: 'unknown' }), {
    deliver: false,
    ask: true,
    focus: 'unknown',
    target: 'beta',
  }, '🔴 答不准却照送 = 拿最新那台顶替');
  assert.deepEqual(routeTarget({ hint: 'beta', focus: null }), {
    deliver: true,
    ask: false,
    focus: null,
    target: 'beta',
  }, '★ 负向对照：没告知过 ≠ 不知道（老行为不许变）');
  assert.deepEqual(routeTarget({ hint: 'beta', focus: 'beta' }), {
    deliver: true,
    ask: false,
    focus: 'beta',
    target: 'beta',
  });

  // ④ **HTTP 那条路真的这么判**：带一台从没告知过的设备 ⇒ 409 ＋ 反问
  const r = await post(h, '/api/say', { messageId: 'u_1', text: '乙房那件事', scope: 'beta', device: 'laptop' });
  assert.equal(r.status, 409, `🔴 带着"说不准"的焦点却照送：${r.status}`);
  const j = await r.json();
  assert.equal(j.ask, true);
  assert.equal(j.focus, 'unknown', '★ 要如实说"这一份说不准"，不许伪装成某一间');
  // ★ 负向对照：**不带 device**（老客户端）⇒ 走 C 期那一份（= beta）⇒ 照旧送
  const ok = await post(h, '/api/say', { messageId: 'u_2', text: '乙房那件事' , scope: 'beta' });
  assert.equal(ok.status, 200, '🔴 老客户端被这条新规矩误伤了（协议只加可选字段）');
  // ★ 而**带上那台真告知过的设备** ⇒ 也对得上（alpha）
  const known = await post(h, '/api/say', { messageId: 'u_3', text: '甲房那件事', scope: 'alpha', device: 'phone' });
  assert.equal(known.status, 200, '★ 告知过的那台要答得准');

  // ⑤ **落盘**：换一本读盘 ⇒ 那两台还在（重启之后不是"从来没告知过"）
  const book = new FocusBook({ dir: w.dir });
  assert.deepEqual(book.devices(), { phone: 'alpha', tablet: 'beta' });
  assert.throws(() => new FocusBook({ dir: '' }), /dir/);
  a.ws.close();
  b.ws.close();
  await h.close();
});

// ════════════════════════════════════════════════════════════════
// §6.2 · 交接包要带"谁给的 / 为什么 / 哪条消息 / 上下文摘要"
// ════════════════════════════════════════════════════════════════

test('🔴 §6.2：交接包带上"谁给的/为什么/哪条消息/摘要"，而且**不带内部 id 上屏**', async () => {
  const h = await boot({ scenario: 'handoff', target: 'beta', reason: '那边更合适' });
  const w = makeScope(h, 'beta', '乙屋');
  assert.equal(
    (await post(h, '/api/say', { messageId: 'u_1', text: '把明天的天气画出来' })).status,
    200,
  );
  // ★ **等目标那一间把我们拼的交接包记下来**（它是这一侧拼的，不是主人说的那句）。
  await waitFor(() => typeof w.dispatcher.sessionFor('beta')?.lastHandoffPacket === 'string', '交接包没投出去');
  const packet = w.dispatcher.sessionFor('beta').lastHandoffPacket;
  assert.match(packet, /转到我这儿来了/, `★ 要说清"谁给的"：${packet}`);
  assert.match(packet, /那边更合适/, '★ 要带"为什么"');
  assert.match(packet, /把明天的天气画出来/, '★ 要带上下文摘要（他刚说过的话）');
  // 🔴 **内部 id 不许出现在给模型看的那段里**（`06` 禁用词那条：它会照着说出来）
  assert.doesNotMatch(packet, /beta|main/, `🔴 内部 scope 名混进交接包了：${packet}`);
  // ★ 摘要那半句"带多少"住代码（文档只说要带）
  assert.equal(typeof HANDOFF_BRIEF_SAYS, 'number');
  assert.ok(HANDOFF_BRIEF_SAYS > 0);
  await h.close();
});

// ════════════════════════════════════════════════════════════════
// 反例的正身集合（把"这些闸不是恒真"钉在这儿）
// ════════════════════════════════════════════════════════════════

test('★ 反例的正身：把每条判据**改回错的形状** ⇒ 当场假', () => {
  // D-1：正文关键词当转交 ⇒ `decideHandoff` 根本不会被调用（它不是判据的一部分），
  //      所以这里钉的是"转交的入口只有一条"这件事的**形状**：
  //      `decideHandoff` 认的是 `by/target/targetExists/records`，**没有** `text`。
  const withText = decideHandoff({ by: 'a', target: 'b', targetExists: true, messageId: 'm', records: [], text: '我转给 b' });
  assert.equal(withText.ok, true, '★ 传了正文也不改变裁决（正文不是控制面）');
  assert.equal(
    decideHandoff({ by: 'a', target: 'b', targetExists: false, messageId: 'm', records: [], text: '我转给 b' }).ok,
    false,
    '🔴 目标不存在时，正文说什么都不放行',
  );
  // D-2：把回环那条去掉 ⇒ 这条本来就是它拦住的
  assert.equal(
    decideHandoff({ by: 'b', target: 'a', targetExists: true, messageId: 'm', records: [{ scopeId: 'a' }] }).reason,
    'loop',
  );
  // D-3：目标不存在 ⇒ 拒（这一条与上面那条一起证明"存在"是必要条件）
  assert.equal(
    decideHandoff({ by: 'a', target: 'b', targetExists: false, messageId: 'm', records: [] }).reason,
    'missing',
  );
  // D-6：永远带点 / 永远不带点，两种错的形状各钉一次
  const events = [{ type: 'message/end', seq: 1, scopeId: 'x' }];
  assert.equal(scopeUnread({ events, lastRead: {}, scope: 'x' }).unread, true, '★ 看过之前：有');
  assert.equal(scopeUnread({ events, lastRead: { x: 1 }, scope: 'x' }).unread, false, '★ 看过之后：没有');
  // D-9：拿"最新那台的"顶替 ⇒ 这一条会红
  assert.equal(
    resolveFocus({ device: 'new', byDevice: { old: 'x' }, fallback: 'x' }).known,
    false,
    '🔴 没告知过的那台被塞了别台的答案 = 拿"最新那台"顶替',
  );
  assert.equal(
    resolveFocus({ device: 'new', byDevice: { old: 'x', other: 'y' }, fallback: 'y' }).known,
    false,
  );
});
