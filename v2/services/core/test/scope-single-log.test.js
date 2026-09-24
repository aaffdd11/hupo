// 84 · **调度器、焦点、转交**的 B 期与 E 期（契约 `docs/dev/84-DISPATCHER-FOCUS.md`）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
// `#121`（`83-APP-WORKSPACE.md`）把三处做成了**与手册相反**的样子。这里钉的是
// 其中两处（第三处"切房间就重连"是 **C 期**，见契约 §八，**不在这里做**）：
//
//   **F1**：一条可见时间线 = **一条日志**（手册 `05-DECISIONS.md` **P-l**）：
//          两个不同 scope 的事件落在**同一个文件**、**同一套号**（不跳号、不各从 1 起）。
//          反例：每 scope 一份日志 / 各自编号 ⇒ 红。
//
//   **F5**：结构上**每个用户一个**调度器对象，内部持有 N 条会话。
//          反例：`roomFor()` 那种"每间 new 一个 Dispatcher" ⇒ 红。
//
//   **迁移**：把已经分出去的 `scope-<id>.jsonl` **按时间并回**那条日志、
//          重新统一编号。默认 dry-run、`--apply` 才动、可重跑（第二次全 `skipped`）、
//          旧文件留作证据不删、并之前先算 sha 并如实报告"哪些号变了"。
//
// ⚠️ 风格照仓库现有测试：真 `Worlds` ＋ 真 HTTP ＋ 真 spawn（假 agent），
//    每条判据都带**反例的正身**（照 `multitenant.test.js` 顶上那条纪律：
//    "接线的每一段都要有一条闸从外面打进来"）。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { spawn as realSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { AgentRuntime } from '../src/agent-runtime.js';
import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { Dispatcher } from '../src/dispatcher.js';
import { Store } from '../src/store.js';
import { Worlds, agentKeyFor, scopeTimelineId } from '../src/worlds.js';
import { snapshotWorkspace } from '../src/workspace.js';
import {
  MAIN_LOG,
  describeMerge,
  mainLogPath,
  mergeScopeLogs,
  planMerge,
  scanScopeLogs,
  sha256hex,
} from '../../../../scripts/merge-scope-logs.mjs';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const FAKE = nodePath.join(HERE, 'fake-agent.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 这一轮起过的东西（`after()` 兜底收掉：红了也要能退出）。 */
const open = new Set();
const tmpDirs = [];
after(async () => {
  for (const s of open) {
    try { await s.close(); } catch { /* 关不干净不影响结论 */ }
  }
  open.clear();
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});

function tmp(prefix = 'hupo-f1-') {
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
    turnDeadlineMs: 5000,
  };
}

/** 起一套：真 `Worlds` + 真 HTTP + 真 spawn（假 agent）。形状照 `app-workspace.test.js`。 */
async function boot({ scenario = 'normal' } = {}) {
  const dataDir = tmp('hupo-f1-run-');
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

  const { listen, close } = createServer({ worlds, auth, buildId: 'f1-test' });
  const addr = await listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;

  const h = {
    dataDir, cfg, worlds, runtime, auth, origin,
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

async function waitFor(pred, why, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await sleep(50);
  }
  throw new Error(`等不到：${why}（等了 ${ms}ms）`);
}

/** 在测试里造一个 scope（工作区 ＋ 登记成 app）——照 `app-workspace.test.js` 那条。 */
function makeScope(h, sub, id) {
  const w = h.worlds.worldFor(sub);
  w.workspaces.ensure(id, { title: id, entry: 'index.html' });
  w.workspaces.write(id, { 'index.html': `<!doctype html><p>${id}</p>` });
  snapshotWorkspace({ apps: w.apps, workspaces: w.workspaces, id, title: id, icon: 'dice' });
  return w;
}

/** 那条日志里的全部事件（**不过滤**：一条日志就是一条）。 */
const logEvents = (dir) =>
  nodeFs
    .readFileSync(mainLogPath(dir), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const shaOf = (p) => (nodeFs.existsSync(p) ? sha256hex(nodeFs.readFileSync(p)) : null);

/**
 * **F1 的判据本体（纯函数）**：这一串事件是不是"一条线"——
 * 具备 `seq` 的事件里，号必须是 `1..N` **连续**（既不跳、也不各从 1 起两次）。
 *
 * ⚠️ 抽成纯函数是为了能**反着验**：喂它一份"每 scope 各自编号"的拼盘，
 *    它必须当场 `false`（见下面那条反例）。
 */
function isOneLine(events) {
  const seqs = events.filter((e) => typeof e?.seq === 'number').map((e) => e.seq);
  for (const [i, s] of seqs.entries()) if (s !== i + 1) return false;
  return seqs.length > 0;
}

// ════════════════════════════════════════════════════════════════
// F1 · 两个 scope ⇒ 同一个文件、同一套号
// ════════════════════════════════════════════════════════════════

test('🔴 F1：两个 scope 的事件落在**同一个日志文件**、**同一套号**（不跳号、不各从 1 起）', async () => {
  const h = await boot();
  makeScope(h, 'u1', 'alpha');
  makeScope(h, 'u1', 'beta');
  const w = h.worlds.worldFor('u1');

  assert.equal((await post(h, '/api/say', { messageId: 'a1', text: '甲房的话-F1', scope: 'alpha' }, 'u1')).status, 200);
  assert.equal((await post(h, '/api/say', { messageId: 'b1', text: '乙房的话-F1', scope: 'beta' }, 'u1')).status, 200);
  assert.equal((await post(h, '/api/say', { messageId: 'm1', text: '主线的话-F1' }, 'u1')).status, 200);
  // 等两间的轮都收口（假 agent 会回话 ⇒ 每一间都有自己的 message/* ）
  await waitFor(
    () => {
      const evs = logEvents(w.dir);
      return ['alpha', 'beta'].every((s) => evs.some((e) => e.type === 'message/end' && e.scopeId === s));
    },
    '两间的回话都没落进那条日志',
  );

  // ① **一个文件**：那条日志里三条 echo 都在，而且没有第二份 scope 日志
  const evs = logEvents(w.dir);
  for (const text of ['甲房的话-F1', '乙房的话-F1', '主线的话-F1']) {
    assert.ok(evs.some((e) => e.type === 'user/echo' && e.text === text), `★ 「${text}」必须在同一条日志里`);
  }
  assert.equal(
    nodeFs.readdirSync(w.dir).filter((n) => /^scope-.*\.jsonl$/.test(n)).length, 0,
    '🔴 不许再有 scope-<id>.jsonl（反例：每 scope 一份日志 ⇒ 红）',
  );
  assert.equal(mainLogPath(w.dir).endsWith(MAIN_LOG), true);

  // ② **一套号**：连续 1..N（不跳号、不各从 1 起）
  assert.equal(isOneLine(evs), true, `🔴 号不是一条线：${JSON.stringify(evs.map((e) => e.seq))}`);
  const distinct = new Set(evs.map((e) => e.seq));
  assert.equal(distinct.size, evs.length, '🔴 两个 scope 各自编号 ⇒ 会有重号');
  w.store.verifyMonotonic('main'); // 盘上真的一条线（跳号会抛）
  const numbers = evs.map((e) => e.seq);
  assert.equal(Math.min(...numbers), 1);
  assert.equal(Math.max(...numbers), evs.length, '★ 1..N 一条线');

  // ③ **标签**：同一份文件里靠 `scopeId` 分得开
  const alphaEcho = evs.find((e) => e.text === '甲房的话-F1');
  const betaEcho = evs.find((e) => e.text === '乙房的话-F1');
  const mainEcho = evs.find((e) => e.text === '主线的话-F1');
  assert.equal(alphaEcho.scopeId, 'alpha');
  assert.equal(betaEcho.scopeId, 'beta');
  assert.equal('scopeId' in mainEcho, false, '★ 主线那条仍然不带这个字段（老事件与老客户端都不动）');
  assert.ok(
    evs.some((e) => e.type === 'message/start' && e.scopeId === 'alpha'),
    '★ 房间里 agent 的话也必须带标签（不然那条视图会漏掉它、还会漏进主线）',
  );

  // ④ **视图过滤**（A4/A3 的行为一个字没改）：主线那一眼看不到房间的话
  const mainView = w.timeline.readAll();
  assert.equal(mainView.some((e) => e.text === '甲房的话-F1'), false, '🔴 主线视图里不许有甲房的话');
  assert.equal(mainView.some((e) => e.scopeId === 'alpha' || e.scopeId === 'beta'), false);
  const alphaView = h.worlds.roomFor('u1', 'alpha').timeline.readAll();
  assert.ok(alphaView.some((e) => e.text === '甲房的话-F1'));
  assert.equal(alphaView.every((e) => e.scopeId === 'alpha'), true, '★ 甲房的视图里只该有甲房的事件');

  // ⑤ 老接口照旧：`/api/timeline` 带 scope = 只看这一间；不带 = 主线
  const page = async (scope) => {
    const q = new URLSearchParams({ before: '9999', limit: '500' });
    if (scope) q.set('scope', scope);
    const r = await get(h, `/api/timeline?${q}`, 'u1');
    assert.equal(r.status, 200);
    return (await r.json()).frames;
  };
  const textOf = (frames) => frames.map((f) => f.text ?? '').join('\n');
  assert.doesNotMatch(textOf(await page('alpha')), /乙房的话-F1/);
  assert.doesNotMatch(textOf(await page(null)), /甲房的话-F1|乙房的话-F1/);

  // **反例的正身**：`scopeTimelineId` 若随 scope 变（旧写法）⇒ 文件就分家了
  assert.equal(scopeTimelineId('alpha'), 'main');
  assert.equal(scopeTimelineId('beta'), 'main');
  assert.equal(w.store.pathFor(scopeTimelineId('alpha')), w.store.pathFor(scopeTimelineId('beta')));

  await h.close();
});

test('🔴 F1 反例：每 scope 各自从 1 起 ⇒ `isOneLine` 当场红（证明闸真的在盯号）', () => {
  // 两份日志各自从 1 开始（`#121` 的旧形状），原样拼起来：
  const perScope = [
    { type: 'user/echo', scopeId: 'alpha', seq: 1 },
    { type: 'message/end', seq: 1 }, // 甲那间的第 1 号…
    { type: 'user/echo', scopeId: 'beta', seq: 1 }, // …乙那间又从 1 起
    { type: 'message/end', seq: 2 },
  ];
  assert.equal(isOneLine(perScope), false, '🔴 重号 / 不连续 ⇒ 必须红');
  // 一条线（归并重编号之后）：
  assert.equal(isOneLine(perScope.map((e, i) => ({ ...e, seq: i + 1 }))), true);
  // 跳号也要红
  assert.equal(isOneLine([{ seq: 1 }, { seq: 3 }]), false, '🔴 跳号 ⇒ 红');
  assert.equal(isOneLine([]), false, '空的不算"一条线"（没内容时判据不该假绿）');
});

// ════════════════════════════════════════════════════════════════
// F5 · 每个用户一个调度器，内部持有多条会话
// ════════════════════════════════════════════════════════════════

test('🔴 F5：每个用户**一个**调度器对象，内部持有 N 条会话', async () => {
  // ⚠️ `hang`：假 agent 不回话 ⇒ `turn-start` 之后当轮输入**留在那儿**，
  //    才有得比"甲那条会话认得出、主线那条不受影响"（`normal` 太快，会收口后清空）。
  const h = await boot({ scenario: 'hang' });
  makeScope(h, 'u1', 'alpha');
  makeScope(h, 'u1', 'beta');
  const world = h.worlds.worldFor('u1');
  const roomA = h.worlds.roomFor('u1', 'alpha');
  const roomB = h.worlds.roomFor('u1', 'beta');

  // ① **结构**：三处拿到的是**同一个对象**（反例：每间 new 一个 ⇒ 红）
  assert.equal(roomA.dispatcher, world.dispatcher, '🔴 甲房与主线必须是**同一个**调度器');
  assert.equal(roomB.dispatcher, world.dispatcher, '🔴 乙房与主线必须是**同一个**调度器');
  assert.equal(
    new Set(h.worlds.allRooms().filter((r) => r.userId === 'u1').map((r) => r.dispatcher)).size, 1,
    '🔴 一个用户只能有一个调度器对象（反例：`roomFor` 每间 new 一个 ⇒ 这里 >1）',
  );

  // ② **内部持有 N 条会话**：主线 + 两间，各有自己的 scopeId / agentKey
  assert.equal(world.dispatcher.sessionCount, 3, `★ 会话数；实际=${JSON.stringify(world.dispatcher.scopes())}`);
  assert.deepEqual(world.dispatcher.scopes().sort(), ['alpha', 'beta', 'main']);
  assert.equal(world.dispatcher.sessionFor('alpha'), roomA.session);
  assert.equal(world.dispatcher.sessionFor('beta'), roomB.session);
  assert.equal(world.dispatcher.sessionFor('main'), world.dispatcher.mainSession);
  assert.equal(roomA.session.scopeId, 'alpha');
  assert.equal(roomA.session.agentKey, agentKeyFor('u1', 'alpha'));
  assert.equal(roomB.session.agentKey, agentKeyFor('u1', 'beta'));
  assert.equal(world.dispatcher.mainSession.agentKey, agentKeyFor('u1', 'main'));
  assert.notEqual(roomA.session.agentKey, roomB.session.agentKey, '★ 每条会话自己的 agent 窗口');

  // ③ **账各算一份**（"收的是谁持有，不是把账合成一本"）：
  //    甲那间的一轮在跑 ⇒ 甲那条会话认得出，主线那条**不受影响**
  assert.equal(
    (await post(h, '/api/say', { messageId: 'a1', text: '甲房一轮-F5', scope: 'alpha' }, 'u1')).status, 200,
  );
  await waitFor(() => roomA.session.turnInput !== '', '甲那条会话的一轮还没起来');
  assert.equal(world.dispatcher.turnInput, '', '🔴 别间的轮不许把主线的当轮输入顶掉');
  assert.equal(roomB.session.turnInput, '', '🔴 也不许顶掉乙那间');

  // ④ **反例的正身**：`new Dispatcher(...)` 出来的东西**不是**它
  const other = new Dispatcher({
    timeline: world.timeline,
    runtime: h.runtime,
    store: world.store,
    turnDeadlineMs: 0,
    scopeId: 'main',
    agentKey: 'someone-else/main',
  });
  assert.notEqual(roomA.dispatcher, other, '反例：每间 new 一个 Dispatcher ⇒ 上面那几条 equal 全都会红');
  assert.equal(other.sessionCount, 1, '（新 new 出来的只有一个 scope —— 那正是旧形状）');
  await other.shutdown();

  // ⑤ 投递给**不认识**的 scope ⇒ 如实失败，**不许悄悄落到主线**
  const miss = await world.dispatcher.deliver('这该失败', { messageId: null, scope: 'nope' });
  assert.equal(miss.delivered, false);
  assert.match(String(miss.error), /nope/);

  await h.close();
});

// ════════════════════════════════════════════════════════════════
// 迁移 · 把分出去的日志并回一条
// ════════════════════════════════════════════════════════════════

/** 造一份"`#121` 那个形状"的盘：主线一条 ＋ 两间各一条，**各自从 1 起**。 */
function makeOldLayout() {
  const dir = tmp('hupo-merge-');
  const main = [
    { type: 'user/echo', messageId: 'm1', text: '主线一', at: 1000, seq: 1 },
    { type: 'message/start', messageId: 'r1', at: 2000, seq: 2 },
  ];
  // ⚠️ 照 `#121` 的真形状：`message/text` **不带** `scopeId`（归属靠"在哪个文件里"）
  const alpha = [
    { type: 'user/echo', messageId: 'a1', text: '甲一', scopeId: 'alpha', at: 1500, seq: 1 },
    { type: 'message/start', messageId: 'ra', scopeId: 'alpha', at: 2500, seq: 2 },
    { type: 'message/text', messageId: 'ra', text: '甲那半句', at: 2600, seq: 3 },
  ];
  const beta = [
    { type: 'user/echo', messageId: 'b1', text: '乙一', scopeId: 'beta', at: 1200, seq: 1 },
  ];
  const write = (name, evs) =>
    nodeFs.writeFileSync(nodePath.join(dir, name), evs.map((e) => `${JSON.stringify(e)}\n`).join(''));
  write(MAIN_LOG, main);
  write('scope-alpha.jsonl', alpha);
  write('scope-beta.jsonl', beta);
  return { dir, main, alpha, beta };
}

test('🔴 迁移：默认 dry-run · 并之前算 sha · 如实报"哪些号变了" · 旧文件不删', () => {
  const { dir, main, alpha, beta } = makeOldLayout();
  const before = {
    main: shaOf(mainLogPath(dir)),
    alpha: shaOf(nodePath.join(dir, 'scope-alpha.jsonl')),
    beta: shaOf(nodePath.join(dir, 'scope-beta.jsonl')),
  };

  // ① **默认 dry-run**：一个字节都不许动（sha 是逐字节的证）
  const dry = mergeScopeLogs({ dir });
  assert.equal(dry.apply, false);
  assert.equal(dry.merged.length, 2, JSON.stringify(dry));
  assert.equal(shaOf(mainLogPath(dir)), before.main, '🔴 dry-run 不许动那条日志');
  assert.equal(shaOf(nodePath.join(dir, 'scope-alpha.jsonl')), before.alpha, '🔴 也不许动 scope 文件');
  assert.equal(shaOf(nodePath.join(dir, 'scope-beta.jsonl')), before.beta);
  assert.match(describeMerge(dry), /只看，不会动/);

  // ② **并之前先算 sha**（报告里每一份都要有）
  assert.equal(dry.shaBefore[MAIN_LOG], before.main);
  for (const f of dry.files) assert.equal(typeof f.sha256, 'string');
  // ★ **补标签**：`#121` 那套里 `message/text` 不带 `scopeId`（归属全靠文件名）
  assert.equal(dry.tagged, 1, '★ "甲那半句"要补上 alpha 这个标签');

  // ③ **如实报"哪些号变了"**：主线第 2 号会被早于它的两间事件（乙一 1200、甲一 1500）挤到第 4 号
  assert.ok(dry.numberChangesTotal > 0, '★ 一定有号会变（两间的事件插进来了）');
  const mainChanges = dry.numberChanges.filter((c) => c.file === MAIN_LOG);
  assert.deepEqual(
    mainChanges.map((c) => [c.oldSeq, c.newSeq]),
    [[2, 4]],
    `★ 主线第 2 号 → 第 4 号；实际=${JSON.stringify(mainChanges)}`,
  );

  // ④ **真并**
  const done = mergeScopeLogs({ dir, apply: true });
  assert.equal(done.merged.length, 2);
  assert.equal(done.tagged, 1);
  // 归并顺序：按 `at` ⇒ 1000 主线一、1200 乙一、1500 甲一、2000 主线 r1、2500 甲 ra、2600 甲那半句
  const merged = logEvents(dir);
  assert.deepEqual(
    merged.map((e) => e.text ?? e.messageId),
    ['主线一', '乙一', '甲一', 'r1', 'ra', '甲那半句'],
    '★ 按 `at` 归并',
  );
  assert.equal(isOneLine(merged), true, '★ 并完是**一条线**');
  new Store({ dataDir: dir, fsync: false }).verifyMonotonic('main'); // 跳号会抛
  assert.ok(done.shaAfter && done.shaAfter !== before.main, '★ 并完 sha 变了（报告里要如实写）');
  // ★ 补了标签之后，那条半句才回得到**它那一间**（不然会被当成主线的话）
  assert.equal(merged.find((e) => e.text === '甲那半句').scopeId, 'alpha', '🔴 不许漏补标签');
  // （负向对照）主线那一份里没有它 —— 它本来就不是主线的话
  assert.equal(merged.find((e) => e.text === '主线一').scopeId, undefined);

  // ⑤ **旧文件不删**：改名为 `.merged.jsonl` 留着（逐字节证据）
  assert.equal(nodeFs.existsSync(nodePath.join(dir, 'scope-alpha.merged.jsonl')), true, '🔴 旧文件必须留着');
  assert.equal(nodeFs.existsSync(nodePath.join(dir, 'scope-beta.merged.jsonl')), true);
  assert.equal(nodeFs.existsSync(nodePath.join(dir, 'scope-alpha.jsonl')), false);
  assert.equal(shaOf(nodePath.join(dir, 'scope-alpha.merged.jsonl')), before.alpha, '★ 证据逐字节没变');
  // 并之前那份时间线的快照也在
  const evidence = nodePath.join(dir, 'log-merge-evidence');
  const stamps = nodeFs.readdirSync(evidence).filter((n) => n !== 'merged.json');
  assert.equal(stamps.length, 1, '★ 一次并 = 一份快照');
  assert.equal(shaOf(nodePath.join(evidence, stamps[0], MAIN_LOG)), before.main, '★ 快照就是并之前那份');
  assert.equal(nodeFs.existsSync(nodePath.join(evidence, stamps[0], 'report.json')), true);

  // ⑥ **可重跑**：第二次**全 skipped**、一个字节都不动
  const again = mergeScopeLogs({ dir, apply: true });
  assert.equal(again.merged.length, 0, JSON.stringify(again));
  assert.equal(again.skipped.filter((s) => s.id === 'alpha').length, 1, '★ 甲那份要报 skipped');
  assert.equal(again.skipped.filter((s) => s.id === 'beta').length, 1, '★ 乙那份要报 skipped');
  assert.equal(shaOf(mainLogPath(dir)), done.shaAfter, '🔴 重跑不许再动那条日志');
  assert.equal(nodeFs.existsSync(nodePath.join(evidence, stamps[0], 'report.json')), true, '快照也不许再开一份');

  // **反例的正身**：并之前那份盘**不是**一条线（否则上面"归并"这一步什么都没证明）
  assert.equal(isOneLine([...main, ...alpha, ...beta]), false, '旧盘就是"各自从 1 起"');
  assert.equal(main.length + alpha.length + beta.length, merged.length, '一条都不许丢');
});

test('★ 盒子里：迁移新写出来的东西要交给 agent 的 uid；宿主上一步都不做', () => {
  // 🔴 2026-09-24 的事故教训（`docs/dev/39-PERMISSIONS.md`）：盒子里服务是 root、
  //    干活的是 agent（uid 1000）⇒ 新写出来的文件不交出去，agent 就读不到
  //    （EACCES）——而那种故障看起来只是"它失忆了"。
  const { dir } = makeOldLayout();
  const calls = [];
  const fs = { ...nodeFs, chownSync: (p, u, g) => calls.push([p, u, g]) };
  const r = mergeScopeLogs({
    dir, apply: true, fs,
    env: { HUPO_AGENT_UID: '1000', HUPO_AGENT_GID: '1000' },
    uid: 0,
  });
  assert.equal(r.handed?.done, true, JSON.stringify(r.handed));
  assert.ok(calls.length > 0, '★ 盒子里并完必须交给 agent');
  assert.ok(calls.every(([, u, g]) => u === 1000 && g === 1000), JSON.stringify(calls));
  assert.ok(calls.some(([p]) => p === mainLogPath(dir)), '★ 那条日志本身要交出去');
  assert.ok(calls.some(([p]) => p.endsWith('report.json')), '★ 证据（报告）也要交出去');

  // 宿主：`uid !== 0` ⇒ **一步都不做**（服务的身份就是 agent 的身份）
  const { dir: hostDir } = makeOldLayout();
  const touched = [];
  const hostFs = { ...nodeFs, chownSync: (p) => touched.push(p) };
  const host = mergeScopeLogs({ dir: hostDir, apply: true, fs: hostFs, env: {}, uid: 501 });
  assert.equal(host.handed?.done, false);
  assert.deepEqual(touched, [], '★ 宿主上不许 chown（那会把文件交给一个不相干的人）');
  // 而并本身照样做成了
  assert.equal(isOneLine(logEvents(hostDir)), true);
});

test('🔴 迁移纯函数：`planMerge` 稳定（同 `at` 保持原顺序）· `scanScopeLogs` 认得出两种名字', () => {
  const main = [{ type: 'x', seq: 1, at: 100 }];
  const scopes = [
    { name: 'scope-alpha.jsonl', events: [{ type: 'x', scopeId: 'alpha', seq: 1, at: 100 }] },
    { name: 'scope-beta.jsonl', events: [{ type: 'x', scopeId: 'beta', seq: 1, at: 50 }] },
  ];
  const plan = planMerge({ mainEvents: main, scopes });
  // at 50 的乙排最前；at 100 的主线与甲保持插入顺序（主线先）
  assert.deepEqual(plan.events.map((e) => e.scopeId ?? 'main'), ['beta', 'main', 'alpha']);
  assert.deepEqual(plan.events.map((e) => e.seq), [1, 2, 3]);
  // 主线的 1 号被挤到 2 号 —— "哪些号变了"要说得出这一条
  assert.deepEqual(plan.changes, [
    { file: MAIN_LOG, oldSeq: 1, newSeq: 2 },
    { file: 'scope-alpha.jsonl', oldSeq: 1, newSeq: 3 },
  ]);

  // `scanScopeLogs`：还没并的与已并的分得开（`scope-alpha.merged.jsonl` 不算待并）
  const dir = tmp('hupo-scan-');
  nodeFs.writeFileSync(nodePath.join(dir, 'scope-alpha.jsonl'), '{}\n');
  nodeFs.writeFileSync(nodePath.join(dir, 'scope-beta.merged.jsonl'), '{}\n');
  nodeFs.writeFileSync(nodePath.join(dir, MAIN_LOG), '{}\n');
  const { pending, merged } = scanScopeLogs(dir);
  assert.deepEqual(pending.map((p) => p.id), ['alpha']);
  assert.deepEqual(merged.map((m) => m.id), ['beta']);
});
