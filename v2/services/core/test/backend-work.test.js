// **P1 后台语义 ＋ 逐件落盘**（契约 `docs/dev/88-P1-TIME-WAIT.md` §三 · §四 T2 / T4）。
//
// 真 `Worlds` ＋ 真 HTTP ＋ 真 spawn（假 agent）—— 形状照 `scope-single-log.test.js`。
// 这一份钉的是"从外面打进来"的那条链：他说一句话 → 那句真的变成一件活（落盘）
// → 长活先说一声 → 做完/失败各有一条提醒 → 他随时问得出"那件怎么样了"。
//
// 每条判据都带**反例的正身**：
//   T4 删掉"完成"那条提醒 ⇒ 判据函数必须返回 false（下面那条负向对照）。
//   短活**不许**预告（别啰嗦）—— 负向对照。
//   T2 逐件落盘：硬杀（换一个进程读盘）之后逐件答得出"已停"。

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
import { Store } from '../src/store.js';
import { Worlds } from '../src/worlds.js';
import { WorkLog } from '../src/worklog.js';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const FAKE = nodePath.join(HERE, 'fake-agent.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const open = new Set();
const tmpDirs = [];
after(async () => {
  for (const h of open) {
    try { await h.close(); } catch { /* 关不干净不影响结论 */ }
  }
  open.clear();
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});

function tmp() {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-p1-'));
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
    turnDeadlineMs: 5000,
    ...over,
  };
}

async function boot({ scenario = 'normal', cfg: over = {} } = {}) {
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
      realSpawn(process.execPath, [FAKE], { ...opts, env: { ...opts.env, FAKE_SCENARIO: scenario } }),
  });
  worlds = new Worlds({ cfg, runtime, log: () => {}, warn: () => {} });

  const auth = new Auth({ dataDir, lockAfter: 3, lockMs: 60_000 });
  auth.setPassword('test-pass');
  const { listen, close } = createServer({ worlds, auth, buildId: 'p1-test' });
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
    },
  };
  open.add(h);
  return h;
}

const tokenFor = (h) => h.auth.issue({ sub: 'u1' }).token;
const post = (h, path, body) =>
  fetch(`${h.origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor(h)}` },
    body: JSON.stringify(body),
  });

async function waitFor(pred, why, ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await sleep(40);
  }
  throw new Error(`等不到：${why}（等了 ${ms}ms）`);
}

const eventsOf = (dir) => {
  const f = nodePath.join(dir, 'main.jsonl');
  if (!nodeFs.existsSync(f)) return [];
  return nodeFs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const notices = (dir) => eventsOf(dir).filter((e) => e.type === 'notice');
const noticeOfKind = (dir, kind) => notices(dir).find((e) => e.kind === kind) ?? null;

/**
 * **后台四句的判据本体（纯函数）**：这三条都必须在盘上、且**取过号**。
 * ⚠️ 抽出来是为了能**反着验**：把"完成"那条删掉 ⇒ 它必须当场 `false`。
 */
function backgroundSentences(events) {
  const ns = events.filter((e) => e.type === 'notice' && String(e.kind).startsWith('work-'));
  const has = (kind) => ns.some((e) => e.kind === kind && typeof e.seq === 'number' && typeof e.text === 'string' && e.text !== '');
  return { started: has('work-started'), done: has('work-done'), failed: has('work-failed') };
}

test('T4①② 长活：先说"我去做" · 做完主动提醒（＋结果一句＋去哪看）· 都落盘取号', async () => {
  // 阈值调小，好在测试里看得到"长活"那一句；`slow` 场景 1.5 秒才答完。
  const h = await boot({ scenario: 'slow', cfg: { backgroundAfterMs: 150 } });
  const w = h.worlds.worldFor('u1');
  try {
    assert.equal(
      (await post(h, '/api/say', { messageId: 'u_1', text: '帮我做一个小程序' })).status,
      200,
    );
    await waitFor(() => noticeOfKind(w.dir, 'work-started'), '开场那句"我去做"');
    const started = noticeOfKind(w.dir, 'work-started');
    assert.equal(started.text, '我去做，做完叫你。');
    assert.equal(typeof started.seq, 'number', '★ 落盘取号');

    await waitFor(() => noticeOfKind(w.dir, 'work-done'), '做完那条提醒');
    const done = noticeOfKind(w.dir, 'work-done');
    assert.match(done.text, /^做完了。/, `结果一句：${done.text}`);
    assert.match(done.text, /就在这儿|在「/, '要说清去哪看');
    assert.equal(typeof done.seq, 'number', '★ 落盘取号');

    const s = backgroundSentences(eventsOf(w.dir));
    assert.deepEqual(s, { started: true, done: true, failed: false });

    // 🔴 反例的正身：**删掉"完成"那条** ⇒ 判据当场 false（这一条不是白写的）
    const withoutDone = eventsOf(w.dir).filter((e) => !(e.kind === 'work-done'));
    assert.equal(backgroundSentences(withoutDone).done, false);
  } finally {
    await h.close();
  }
});

test('T4③ 失败也要提醒（超时那条路）：删掉它 ⇒ 判据 red', async () => {
  // `hang` 永远不收口 ⇒ 超时硬收口那条路必须发一条"没做完"。
  const h = await boot({ scenario: 'hang', cfg: { backgroundAfterMs: 120, turnDeadlineMs: 700 } });
  const w = h.worlds.worldFor('u1');
  try {
    assert.equal((await post(h, '/api/say', { messageId: 'u_1', text: '帮我做一件事' })).status, 200);
    await waitFor(() => noticeOfKind(w.dir, 'work-started'), '开场那句');
    await waitFor(() => noticeOfKind(w.dir, 'work-failed'), '失败那条提醒');
    const failed = noticeOfKind(w.dir, 'work-failed');
    assert.match(failed.text, /没做完|停了/, failed.text);
    assert.equal(typeof failed.seq, 'number');
    assert.equal(backgroundSentences(eventsOf(w.dir)).failed, true);
    const withoutFail = eventsOf(w.dir).filter((e) => e.kind !== 'work-failed');
    assert.equal(backgroundSentences(withoutFail).failed, false);
  } finally {
    await h.close();
  }
});

test('T4④ 短活**不许**预告（别啰嗦）—— 负向对照', async () => {
  const h = await boot({ scenario: 'normal', cfg: { backgroundAfterMs: 400 } });
  const w = h.worlds.worldFor('u1');
  try {
    assert.equal((await post(h, '/api/say', { messageId: 'u_1', text: '你好' })).status, 200);
    await waitFor(() => eventsOf(w.dir).some((e) => e.type === 'message/end'), '这一轮收口');
    // 等过阈值一点点，确认它**没有**冒出来一句
    await sleep(600);
    assert.deepEqual(backgroundSentences(eventsOf(w.dir)), { started: false, done: false, failed: false });
  } finally {
    await h.close();
  }
});

test('T4④b 他随时能问"那件怎么样了"：逐件答案（真跑着的那件）', async () => {
  const h = await boot({ scenario: 'hang', cfg: { backgroundAfterMs: 9999, turnDeadlineMs: 60000 } });
  const w = h.worlds.worldFor('u1');
  try {
    assert.equal((await post(h, '/api/say', { messageId: 'u_1', text: '帮我看一下' })).status, 200);
    await waitFor(() => w.dispatcher.turnInput !== '', '这一轮开始');
    const line = w.dispatcher.workReport({ ref: 'u_1' });
    assert.match(line, /还在做/, `逐件答案：${line}`);
    // 查无此件也有一句（不许空着）
    assert.match(w.dispatcher.workReport({ ref: 'u_不存在' }), /没找到/);
  } finally {
    await h.close();
  }
});

test('T2（真 Worlds）挂 1 件 → 逐件落盘 → **换个进程读盘** → 逐件答"已停"', async () => {
  const h = await boot({ scenario: 'hang', cfg: { backgroundAfterMs: 9999, turnDeadlineMs: 60000 } });
  const w = h.worlds.worldFor('u1');
  try {
    assert.equal((await post(h, '/api/say', { messageId: 'u_1', text: '帮我改一下' })).status, 200);
    await waitFor(() => w.work.live().some((r) => typeof r.turn === 'number'), '这件活要绑到轮上（逐件落盘）');

    // ① **逐件可查**：不只是 busy 布尔
    const live = w.work.live();
    assert.equal(live.length, 1);
    assert.equal(live[0].scopeId, 'main');
    assert.equal(live[0].ref, 'u_1');
    assert.equal(typeof live[0].turn, 'number');
    assert.equal(typeof live[0].startedAt, 'number');
    // 聚合状态里也逐件带着（重启脚本读的那个文件）
    const snap = h.worlds.busySnapshot();
    assert.ok(snap.items.some((it) => it.ref === 'u_1' && it.scopeId === 'main'), JSON.stringify(snap));

    // ② **硬杀 → 重启**：换一个 `WorkLog`（新进程）从**盘上**重建
    const after = new WorkLog({ store: new Store({ dataDir: w.dir, fsync: false }) });
    assert.equal(after.live().length, 1, '重启后仍逐件查得到（没有"消失"）');
    after.settleDead({ aliveGenerations: [] });
    const ans = after.answer({ scopeId: 'main', ref: 'u_1' });
    assert.ok(ans, '逐件答得出');
    assert.equal(ans.answer, 'stopped', '答"已停"，不是"查无此件"');
    // ③ 负向对照：删掉盘上那条开口记录 ⇒ 重启后**查无此件**（判据不是恒真）
    const raw = nodeFs
      .readFileSync(nodePath.join(w.dir, 'pending.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .filter((l) => !l.includes('"ref":"u_1"'));
    nodeFs.writeFileSync(nodePath.join(w.dir, 'pending.jsonl'), `${raw.join('\n')}\n`);
    const wiped = new WorkLog({ store: new Store({ dataDir: w.dir, fsync: false }) });
    assert.equal(wiped.answer({ scopeId: 'main', ref: 'u_1' }), null, '删了记录就该查无此件');
  } finally {
    await h.close();
  }
});
