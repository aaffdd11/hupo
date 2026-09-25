// 84 · **C 期：焦点路由**（契约 `docs/dev/84-DISPATCHER-FOCUS.md` §三/§五）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
// 手册 `02-ARCHITECTURE.md` §四 核心原则 3：**一个 WS 连接是物理约束**
// —— 不能每个会话/房间一条连接；§四① ：**焦点**那条的输出投给用户，
// 其它条**照常进时间线、但不实时提醒**。
//
// `#121`（`83-APP-WORKSPACE.md`）把这里做成了相反的样子（`?scope=` 是连接级的、
// 切房间就重连）——`84 §八` 把那种形状列为**明确不做**。这一份是收回来的判据：
//
//   **F2**：客户端切焦点**不重连**（连接数不变 / `sinceSeq` 连续 / 那一间的历史
//          按视图补过来）。反例：切焦点就新建连接 ⇒ 红。
//   **F3**：焦点在哪条 ⇒ **那条的输出现时到**；别的条**进日志但不实时推**。
//          反例：把别的条也实时推 ⇒ 红。
//   **F6**：回归 —— A1–A7 里不冲突的那些仍绿（工作区 / 保留 id / 主线不变 /
//          一条日志一套号）。正面判据在 `app-workspace.test.js`（整份必须绿），
//          这里只把"这一期不该动"的那几条重钉一遍。
//   **第 16 条**（`96-OWNER-DECISIONS.md`）：指称与焦点不一致 ⇒ **先反问一句**
//          —— 不投递、不落盘；一致（或压根没告知过焦点）⇒ 照旧送。
//
// ⚠️ 风格照仓库现有测试：真 `Worlds` ＋ 真 HTTP ＋ 真 spawn（假 agent），
//    每条判据都带**反例的正身**。

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
import { refuseReservedAppId } from '../src/apps.js';
import { routeTarget } from '../src/focus.js';
import { Worlds, BUILTIN_SCOPES, scopeTimelineId } from '../src/worlds.js';
import { checkScope, snapshotWorkspace } from '../src/workspace.js';
import { MAIN_LOG, mainLogPath } from '../../../../scripts/merge-scope-logs.mjs';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const FAKE = nodePath.join(HERE, 'fake-agent.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 这一轮起过的东西（`after()` 兜底收掉：红了也要能退出）。 */
const open = new Set();
const tmpDirs = [];
after(async () => {
  for (const s of open) {
    try {
      await s.close();
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

function tmp(prefix = 'hupo-focus-') {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function cfgFor(dataDir) {
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
  };
}

/** 起一套：真 `Worlds` + 真 HTTP + 真 spawn（假 agent）。形状照 `scope-single-log.test.js`。 */
async function boot({ scenario = 'normal' } = {}) {
  const dataDir = tmp('hupo-focus-run-');
  const cfg = cfgFor(dataDir);
  nodeFs.mkdirSync(cfg.dshHome, { recursive: true });
  nodeFs.mkdirSync(cfg.agentCwd, { recursive: true });

  let worlds = null;
  const runtime = new AgentRuntime({
    cfg,
    cfgFor: (key) => worlds.cfgForAgentKey(key),
    onEvict: (id) => worlds.onEvict(id),
    spawnFn: (bin, args, opts) =>
      realSpawn(process.execPath, [FAKE], { ...opts, env: { ...opts.env, FAKE_SCENARIO: scenario } }),
  });
  worlds = new Worlds({ cfg, runtime, log: () => {}, warn: () => {} });

  const auth = new Auth({ dataDir, lockAfter: 3, lockMs: 60_000 });
  auth.setPassword('test-pass');

  const { listen, close } = createServer({ worlds, auth, buildId: 'focus-test' });
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

const tokenFor = (h, sub) => h.auth.issue({ sub }).token;
const get = (h, path, sub) =>
  fetch(`${h.origin}${path}`, { headers: { authorization: `Bearer ${tokenFor(h, sub)}` } });
const post = (h, path, body, sub) =>
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

/** 在测试里造一个 scope（工作区 ＋ 登记成 app）——照 `app-workspace.test.js` 那条。
 *  ⚠️ `title` 是**给人看的名字**：判"内部 id 不许上屏"时要把它和 id 分开写。 */
function makeScope(h, sub, id, title = id) {
  const w = h.worlds.worldFor(sub);
  w.workspaces.ensure(id, { title, entry: 'index.html' });
  w.workspaces.write(id, { 'index.html': `<!doctype html><p>${id}</p>` });
  snapshotWorkspace({ apps: w.apps, workspaces: w.workspaces, id, title, icon: 'dice' });
  return w;
}

/** 连一条流（**客户端**那一侧：真 `ws`，不是探针）。 */
function wsConnect(h, { sub = 'u1', scope = null, sinceSeq = 0 } = {}) {
  const protocols = ['bearer', tokenFor(h, sub)];
  const qs = new URLSearchParams({ sinceSeq: String(sinceSeq) });
  if (scope) qs.set('scope', scope);
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
    ws.on('unexpected-response', (_req, res) =>
      reject(Object.assign(new Error('rejected'), { status: res.statusCode })));
  });
}

/** 切焦点（**不重连**：就在这条 socket 上发一帧）。 */
function focus(ws, scope, sinceSeq) {
  ws.send(JSON.stringify(sinceSeq === undefined ? { t: 'focus', scope } : { t: 'focus', scope, sinceSeq }));
}

const hellos = (frames) => frames.filter((f) => f?.type === 'client/hello').length;
const resets = (frames) => frames.filter((f) => f?.type === 'client/reset').length;
const focusAcks = (frames) => frames.filter((f) => f?.type === 'client/focus');
const textOf = (frames) => frames.map((f) => f?.text ?? '').join('\n');

const logEvents = (dir) =>
  nodeFs
    .readFileSync(mainLogPath(dir), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

// ════════════════════════════════════════════════════════════════
// F2 · 一条连接：切焦点**不重连**
// ════════════════════════════════════════════════════════════════

test('🔴 F2：切焦点不重连（连接数不变 · `sinceSeq` 连续 · 历史按视图补过来）', async () => {
  // ⚠️ `slow`（1.5 秒一轮）不是凑数：**"另一间在跑"这件事必须活到连接建立之后**，
  //    才测得到"切回它时缺的那一段靠补发"（`normal` 太快，切的时候早就说完了）。
  const h = await boot({ scenario: 'slow' });
  makeScope(h, 'u1', 'alpha');
  makeScope(h, 'u1', 'beta');
  const w = h.worlds.worldFor('u1');

  const endsOf = (s) =>
    logEvents(w.dir).filter((e) => e.type === 'message/end' && e.scopeId === s).length;

  // 两间各先说一句（两边都有历史可补）
  assert.equal(
    (await post(h, '/api/say', { messageId: 'b1', text: '乙房早先那句', scope: 'beta' }, 'u1')).status,
    200,
  );
  assert.equal(
    (await post(h, '/api/say', { messageId: 'a1', text: '甲房那句', scope: 'alpha' }, 'u1')).status,
    200,
  );

  // ① 进来时焦点 = beta（`?scope=` 只是**初始焦点**）
  const c = await wsConnect(h, { scope: 'beta' });
  await waitFor(() => hellos(c.frames) === 1, '`client/hello` 没来');
  await waitFor(
    () => c.frames.some((f) => f.type === 'user/echo' && f.text === '乙房早先那句'),
    'beta 的历史没补过来',
  );
  await waitFor(() => endsOf('beta') >= 1, '乙房早先那句没收口');
  await waitFor(
    () => c.frames.some((f) => f.type === 'message/end' && f.scopeId === 'beta'),
    '焦点那间的收口没现时到',
  );
  const betaMax = Math.max(...c.frames.filter((f) => typeof f.seq === 'number').map((f) => f.seq));
  assert.ok(betaMax > 0, '★ 起点要有号（不然下面的"游标被当真"测不出来）');
  assert.equal(resets(c.frames), 0);

  // ② **焦点在 beta 时**让乙再开一轮（一致 ⇒ 收下了）；紧接着把焦点切到 alpha
  //    ⇒ 这一轮的输出落进日志，但**不推**给这条连接（F3 的同一条规矩）
  assert.equal(
    (await post(h, '/api/say', { messageId: 'b2', text: '乙房后一句', scope: 'beta' }, 'u1')).status,
    200,
  );
  focus(c.ws, 'alpha', 0);
  await waitFor(
    () => focusAcks(c.frames).some((f) => f.ok === true && f.scope === 'alpha'),
    '切焦点的确认没来',
  );
  await waitFor(
    () => c.frames.some((f) => f.type === 'user/echo' && f.text === '甲房那句'),
    '切了焦点却拿不到那一间的历史',
  );
  // 🔴 **判据本体**：一条连接 —— `client/hello` 只有一次（重连才会再发一次）
  assert.equal(hellos(c.frames), 1, '🔴 切焦点就新建连接 ⇒ 这里会变成 2（84 §八·3/4 明说不做）');
  assert.equal(c.ws.readyState, WebSocket.OPEN, '★ 还是同一条连接、还开着');
  assert.equal(resets(c.frames), 0, '🔴 换个焦点就被要求"从头来" ⇒ 红');

  // ③ 焦点在 alpha 时，乙那一轮照常收口（进日志），但这条连接不许看见它
  const n = c.frames.length;
  await waitFor(() => endsOf('beta') >= 2, '乙房后一句没收口');
  await sleep(200);
  assert.equal(
    c.frames.slice(n).filter((f) => f.scopeId === 'beta').length,
    0,
    '🔴 焦点在甲，乙的输出却实时推过来了 ⇒ 红',
  );

  // ④ 切回 beta，带上**它自己**那个游标 ⇒ 只补缺的那一段（已有的不许重发）
  focus(c.ws, 'beta', betaMax);
  await waitFor(
    () => focusAcks(c.frames).filter((f) => f.scope === 'beta').length >= 1,
    '切回 beta 的确认没来',
  );
  await waitFor(
    () => c.frames.some((f) => f.type === 'user/echo' && f.text === '乙房后一句'),
    '切回 beta 之后缺的那一段没补过来（sinceSeq 连续就是这件事）',
  );
  const betaEchoes = c.frames.filter((f) => f.type === 'user/echo' && f.scopeId === 'beta');
  assert.equal(
    betaEchoes.filter((f) => f.text === '乙房早先那句').length,
    1,
    `🔴 游标被归零 ⇒ 已有那句会重发一遍；实际=${JSON.stringify(betaEchoes.map((f) => f.text))}`,
  );
  // ★ 缺的那一段是**补发**（`sinceSeq > 0` ⇒ 打 `catchUp`），不是"刚发生"：
  //   拿**收口**那一帧来判（它 1.5 秒后才落，切焦点时早就切走了 ⇒ 只可能来自补发；
  //   `user/echo` 是发出去的当下就写的，可能赶在切焦点之前实时到，判不准）。
  const lateEnds = c.frames.filter(
    (f) => f.type === 'message/end' && f.scopeId === 'beta' && typeof f.seq === 'number' && f.seq > betaMax,
  );
  assert.ok(lateEnds.length >= 1, '★ 切回来之后缺的那一段（收口）没补过来');
  assert.equal(
    lateEnds.every((f) => f.catchUp === true),
    true,
    '★ 那一段应当是 catchUp（历史），不是实时帧',
  );
  assert.equal(hellos(c.frames), 1, '🔴 全程只有一条连接');
  assert.equal(resets(c.frames), 0);

  // **反例的正身**：真开第二条连接 ⇒ `hello` 就是 2
  //   （证明上面那条 `=== 1` 的刻度是"连接数"，不是随便一个数）
  const c2 = await wsConnect(h, { scope: 'beta' });
  await waitFor(() => hellos(c2.frames) === 1, '第二条连接没连上');
  assert.equal(
    hellos([...c.frames, ...c2.frames]),
    2,
    '★ 多一条连接 = 多一个 `client/hello`（反例：切焦点就重连 ⇒ 上面那条当场红）',
  );
  c2.ws.close();
  c.ws.close();
  await h.close();
});

// ════════════════════════════════════════════════════════════════
// F3 · 焦点路由：焦点那条现时到；别的条进日志、不实时推
// ════════════════════════════════════════════════════════════════

test('🔴 F3：焦点那条现时到；别的条**进日志但不实时推**（反例：都推 ⇒ 红）', async () => {
  // ⚠️ `slow`：每一轮 1.5 秒才回话 ⇒ "另一间正在跑"这件事在连接建立**之后**
  //    还活着，才测得到"别的条不实时推"（`normal` 太快，连上时它早说完了）。
  const h = await boot({ scenario: 'slow' });
  makeScope(h, 'u1', 'alpha');
  makeScope(h, 'u1', 'beta');
  const w = h.worlds.worldFor('u1');

  // 先让**两间都在跑**（这会儿还没有焦点 ⇒ 第 16 条那条闸不做比较，两间都收下了）
  assert.equal(
    (await post(h, '/api/say', { messageId: 'a1', text: '甲房那句-F3', scope: 'alpha' }, 'u1')).status,
    200,
  );
  assert.equal(
    (await post(h, '/api/say', { messageId: 'b1', text: '乙房那句-F3', scope: 'beta' }, 'u1')).status,
    200,
  );

  // 焦点 = alpha
  const c = await wsConnect(h, { scope: 'alpha' });
  await waitFor(() => hellos(c.frames) === 1, '`client/hello` 没来');

  // ① 焦点那条的输出**现时**到
  await waitFor(
    () => c.frames.some((f) => f.type === 'message/end' && f.scopeId === 'alpha'),
    '焦点那条的输出没现时到',
  );
  // ② 别的条：**进日志**，但**一个字节都不许实时推给这条连接**
  await waitFor(
    () => logEvents(w.dir).some((e) => e.type === 'message/end' && e.scopeId === 'beta'),
    '★ 乙那条根本没进日志 ⇒ 这条判据测的不是路由',
  );
  await sleep(250); // 补发/实时都是连着发的 ⇒ 多给一会儿再判"不许出现"
  assert.equal(
    c.frames.filter((f) => f.scopeId === 'beta').length,
    0,
    `🔴 别的条也实时推过来了（84 §四①）——那是反例；实际=${textOf(c.frames.filter((f) => f.scopeId === 'beta'))}`,
  );
  // 而它**确实在**那一间的视图里（视图过滤，不是丢）
  const page = await get(h, '/api/timeline?before=9999&limit=100&scope=beta', 'u1');
  assert.equal(page.status, 200);
  assert.match(textOf((await page.json()).frames), /乙房那句-F3/);

  // ③ 甲房再来一句（焦点还在甲 ⇒ 一致，照旧送，而且它的回答也该**现时**到）
  assert.equal(
    (await post(h, '/api/say', { messageId: 'a2', text: '甲房第二句-F3', scope: 'alpha' }, 'u1')).status,
    200,
  );

  // ④ 切焦点到乙 ⇒ 乙那间**没实时推**的那些从"历史"补过来
  //    （证明②不是"乙那边什么都没有"，而是**路由**把它按住了）
  focus(c.ws, 'beta', 0);
  await waitFor(
    () => c.frames.some((f) => f.type === 'user/echo' && f.text === '乙房那句-F3'),
    '切了焦点也拿不到乙那句 ⇒ 判据②可能只是"那边没东西"',
  );
  // ⑤ 反向：焦点在乙 ⇒ 甲第二句的回答**不许**再实时推过来
  const alphaEnds = () =>
    logEvents(w.dir).filter((e) => e.type === 'message/end' && e.scopeId === 'alpha').length;
  await waitFor(() => alphaEnds() >= 2, '甲房第二句没落盘');
  const n = c.frames.length;
  await sleep(250);
  assert.equal(
    c.frames.slice(n).filter((f) => f.scopeId === 'alpha').length,
    0,
    '🔴 焦点已经在乙了，甲的输出还在实时推 ⇒ 红',
  );

  // ⑥ 负向对照：焦点在乙时，乙的下一条是**实时**的
  //    （⇒ ①②⑤ 的差别只可能来自**焦点**，不是"乙那条从来不实时"）
  const betaEnds2 = () =>
    logEvents(w.dir).filter((e) => e.type === 'message/end' && e.scopeId === 'beta').length;
  const before2 = betaEnds2();
  assert.equal(
    (await post(h, '/api/say', { messageId: 'b2', text: '乙房第二句-F3', scope: 'beta' }, 'u1')).status,
    200,
  );
  await waitFor(
    () => c.frames.filter((f) => f.type === 'message/end' && f.scopeId === 'beta').length >= 2,
    '焦点在乙，乙的回答却没现时到（负向对照失败）',
  );
  assert.ok(betaEnds2() > before2, '★ 那一轮真的收口了');
  assert.equal(hellos(c.frames), 1, '★ 全程一条连接');

  c.ws.close();
  await h.close();
});

// ════════════════════════════════════════════════════════════════
// 第 16 条 · 指称与焦点不一致 ⇒ 先反问一句
// ════════════════════════════════════════════════════════════════

test('🔴 第 16 条：焦点/目标不一致 ⇒ 先反问（不投递、不落盘）；一致或没告知过 ⇒ 照旧送', async () => {
  const h = await boot();
  // ⚠️ 名字**故意和人话分开**（`alpha`/`beta` 是内部 id）：这样"内部 id 不许上屏"
  //    那条断言才有牙齿 —— 要是拿 id 当标题，它就永远是绿的。
  makeScope(h, 'u1', 'alpha', '甲屋');
  makeScope(h, 'u1', 'beta', '乙屋');
  const w = h.worlds.worldFor('u1');

  // ── 0. **老行为不许破**：从来没被告知过焦点 ⇒ 不做比较、照旧送到提示那一间
  assert.equal(w.dispatcher.focusScope, null, '起点：还没连流 ⇒ 没有焦点');
  assert.equal(
    (await post(h, '/api/say', { messageId: 'n1', text: '还没连流时说的一句', scope: 'beta' }, 'u1')).status,
    200,
    '🔴 没有焦点就反问 ⇒ 老客户端全挂（协议只加不改）',
  );
  await waitFor(
    () => logEvents(w.dir).some((e) => e.type === 'user/echo' && e.text === '还没连流时说的一句'),
    '没焦点那句没送出去',
  );

  // ── 1. 焦点 = alpha
  const c = await wsConnect(h, { scope: 'alpha' });
  await waitFor(() => hellos(c.frames) === 1, '`client/hello` 没来');
  assert.equal(w.dispatcher.focusScope, 'alpha', '★ 连上就该知道他在看哪一间');

  // ── 2. 他看着 alpha，却把这一句送到 beta ⇒ **反问**
  const ask = await post(h, '/api/say', { messageId: 'x1', text: '乙房那件事', scope: 'beta' }, 'u1');
  assert.equal(ask.status, 409, '★ 冲突要和 404（没这间）/ 429（忙）分得开');
  const j = await ask.json();
  assert.equal(j.ask, true, '★ `ask` 是**显式字段**（客户端不许靠状态码猜）');
  assert.equal(j.error, 'focus-mismatch');
  assert.equal(j.focus, 'alpha', '★ 要如实说"他刚才在看哪一间"');
  assert.equal(j.scope, 'beta', '★ 也要如实说"这一句想去哪一间"');
  assert.equal(typeof j.text, 'string');
  assert.ok(j.text.trim().length > 0, '★ 反问必须是一句**人话**');
  // ★ 名字要**说得出是哪两间**（人话那半句来自制品库的 title）
  assert.match(j.text, /甲屋/, `★ 反问里要说得出"他现在看的那一间"：${j.text}`);
  assert.match(j.text, /乙屋/, `★ 也要说得出"这一句想去的那一间"：${j.text}`);
  // 🔴 不许把内部 id 写上屏（禁用词那条）：这句话里只许有"人话的间名"
  assert.doesNotMatch(j.text, /alpha|beta|main/, `🔴 内部 scope 名上屏了：${j.text}`);
  // 🔴 **一个字都没落盘**（`say.say()` 根本没被调用 ⇒ 盘上不留"没被回答的话"）
  const after = logEvents(w.dir);
  assert.equal(
    after.some((e) => e.text === '乙房那件事'),
    false,
    '🔴 反问了却把话写进日志 ⇒ 盘上留着一句永远没有回答的话',
  );
  assert.equal(
    after.some((e) => e.type === 'message/start' && e.scopeId === 'beta' && e.turn === 2),
    false,
    '🔴 反问了却投递了 ⇒ "送错地方"正是第 16 条要挡的',
  );

  // ── 3. 一致 ⇒ 照旧送到（同一个端点、同一套字段）
  assert.equal(
    (await post(h, '/api/say', { messageId: 'x2', text: '甲房那边的事', scope: 'alpha' }, 'u1')).status,
    200,
  );
  await waitFor(
    () => logEvents(w.dir).some((e) => e.type === 'user/echo' && e.text === '甲房那边的事' && e.scopeId === 'alpha'),
    '一致的那句没送出去',
  );

  // ── 4. 切焦点到乙（**不重连**）⇒ 那一句再说一次就送出去了
  //      ⚠️ 用**同一个 messageId**：反问那次没落盘 ⇒ 它还算"没收到过"（N11 可重试）
  focus(c.ws, 'beta', 0);
  await waitFor(
    () => focusAcks(c.frames).some((f) => f.ok === true && f.scope === 'beta'),
    '切焦点的确认没来',
  );
  assert.equal(w.dispatcher.focusScope, 'beta');
  assert.equal(
    (await post(h, '/api/say', { messageId: 'x1', text: '乙房那件事', scope: 'beta' }, 'u1')).status,
    200,
  );
  await waitFor(
    () => logEvents(w.dir).some((e) => e.type === 'user/echo' && e.text === '乙房那件事' && e.scopeId === 'beta'),
    '切了焦点之后那句还是没送出去',
  );

  // ── 5. **重发不判这一条**：那一句早就落盘了 ⇒ 焦点再不一致也只许回"重复"
  //      （拿"归处不确定"拒重发 ⇒ 界面会说"没发出去"，而服务端其实收下了）
  focus(c.ws, 'alpha', 0);
  await waitFor(
    () => focusAcks(c.frames).some((f) => f.ok === true && f.scope === 'alpha'),
    '切回 alpha 的确认没来',
  );
  const again = await post(h, '/api/say', { messageId: 'x1', text: '乙房那件事', scope: 'beta' }, 'u1');
  assert.equal(again.status, 200, '🔴 重发被"归处不确定"拒了 ⇒ 屏幕上一句假话');
  assert.equal((await again.json()).duplicate, true, '★ 只许回"这一句我早收下了"');

  // ── 反例的正身：判据本体是纯函数，三档各钉一次
  assert.deepEqual(routeTarget({ hint: 'beta', focus: 'alpha' }), {
    deliver: false,
    ask: true,
    focus: 'alpha',
    target: 'beta',
  });
  assert.deepEqual(routeTarget({ hint: 'beta', focus: 'beta' }), {
    deliver: true,
    ask: false,
    focus: 'beta',
    target: 'beta',
  });
  assert.deepEqual(routeTarget({ hint: 'beta', focus: null }), {
    deliver: true,
    ask: false,
    focus: null,
    target: 'beta',
  });

  c.ws.close();
  await h.close();
});

// ════════════════════════════════════════════════════════════════
// F6 · 回归（A1–A7 里不冲突的那些）
// ════════════════════════════════════════════════════════════════

test('🔴 F6 回归：工作区 / 保留 id / 主线不变 / 一条日志一套号（焦点路由不许碰坏）', async () => {
  const h = await boot();
  makeScope(h, 'u1', 'alpha');
  makeScope(h, 'u1', 'beta');
  const w = h.worlds.worldFor('u1');

  // 焦点路由这一期**不许动**这几条 —— 先按 F2/F3 那条路走一遍（真的连流、真的切焦点）
  const c = await wsConnect(h, { scope: 'alpha' });
  await waitFor(() => hellos(c.frames) === 1, '`client/hello` 没来');
  await post(h, '/api/say', { messageId: 'a1', text: '甲房的话-F6', scope: 'alpha' }, 'u1');
  focus(c.ws, 'beta', 0);
  await waitFor(
    () => focusAcks(c.frames).some((f) => f.ok === true && f.scope === 'beta'),
    '切焦点没确认',
  );
  await post(h, '/api/say', { messageId: 'b1', text: '乙房的话-F6', scope: 'beta' }, 'u1');
  await waitFor(
    () =>
      ['alpha', 'beta'].every((s) =>
        logEvents(w.dir).some((e) => e.type === 'message/end' && e.scopeId === s),
      ),
    '两间的轮都没收口',
  );

  // ① **一条日志**（P-l / F1）：两间的话在**同一个文件**里，而且没有 `scope-*.jsonl`
  assert.equal(mainLogPath(w.dir).endsWith(MAIN_LOG), true);
  const evs = logEvents(w.dir);
  for (const t of ['甲房的话-F6', '乙房的话-F6']) {
    assert.ok(evs.some((e) => e.type === 'user/echo' && e.text === t), `★ 「${t}」必须在同一条日志里`);
  }
  assert.equal(
    nodeFs.readdirSync(w.dir).filter((n) => /^scope-.*\.jsonl$/.test(n)).length,
    0,
    '🔴 不许再有每 scope 一份日志',
  );
  assert.equal(scopeTimelineId('alpha'), 'main');
  assert.equal(scopeTimelineId('beta'), 'main');

  // ② **一套号**（不跳、不各从 1 起）
  const seqs = evs.filter((e) => typeof e.seq === 'number').map((e) => e.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), `🔴 号不是一条线：${JSON.stringify(seqs)}`);
  w.store.verifyMonotonic('main');

  // ③ **主线不变**（A3/A4）：它的视图里没有房间的话；身份一个字没动
  const mainView = w.timeline.readAll();
  assert.equal(mainView.some((e) => e.text === '甲房的话-F6' || e.text === '乙房的话-F6'), false);
  assert.equal(w.scopeId, 'main');
  assert.equal(w.agentKey, 'u1/main');
  assert.equal(w.timeline.id, 'main');

  // ④ **工作区**（A1/A2）：一间一格的 cwd，而且**不在**主目录里面
  const mainDir = h.worlds.pathsFor('u1').agentCwd;
  for (const id of ['alpha', 'beta']) {
    const p = h.worlds.pathsFor('u1', id);
    assert.equal(p.agentCwd, nodePath.join(nodePath.dirname(mainDir), 'workspaces', id));
    assert.equal(p.agentCwd.startsWith(`${mainDir}${nodePath.sep}`), false, '🔴 工作区不许落在主目录里');
    assert.equal(p.dshHome, w.cfg.dshHome, '★ DSH_HOME 还是每人一份（不是每间一份）');
  }

  // ⑤ **保留 id**（A 里那一条）：内置那四个是**房间**、但**不许当 app**
  for (const id of BUILTIN_SCOPES) {
    assert.equal(checkScope(id), id, `★ ${id} 是**房间**（roomFor 认它）`);
    assert.throws(() => refuseReservedAppId(id), /桌面上/, `🔴 ${id} 不许当小程序`);
  }
  assert.equal(refuseReservedAppId('dice'), 'dice', '★ 负向对照：不是保留 id 的照旧放行');

  c.ws.close();
  await h.close();
});
