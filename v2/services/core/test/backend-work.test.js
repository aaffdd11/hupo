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
import { Worlds, titleOfApp } from '../src/worlds.js';
import { WorkLog } from '../src/worklog.js';
import { workWhereWords } from '../src/work-words.js';
import { handleLedgerOp } from '../src/ledger-socket.js';

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

test('T4②b 房间那条完成提醒要说**它自己的名字**（反例：名字取成版本号 ⇒ 恒空 ⇒ 红）', async () => {
  const h = await boot({ scenario: 'slow', cfg: { backgroundAfterMs: 150 } });
  const w = h.worlds.worldFor('u1');
  try {
    // 这一格里真有一个 app：它的名字只有**一处出处**（那一版制品的 `manifest.json`）
    w.apps.create({
      id: 'city-weather',
      title: '看天气',
      icon: 'cloud',
      entry: 'index.html',
      files: { 'index.html': '<p>天气</p>' },
    });
    // ★ 纯判据的正身 / 反例：`current()` 给的是**版本号**——
    //   照它取 `.title`（修前那一行）⇒ 恒 `null` ⇒ 那半句永远出不来。
    assert.equal(
      titleOfApp({ current: () => 1, manifest: (_id, v) => (v === 1 ? { title: '看天气' } : null) }, 'city-weather'),
      '看天气',
    );
    assert.equal(titleOfApp({ current: () => 1, manifest: () => null }, 'city-weather'), null);
    // 认不出 ⇒ **不写内部 id 上屏**（`06` 禁用词那条）
    assert.equal(workWhereWords({ scopeId: 'city-weather', title: null }), '');

    // 开他这一间 ⇒ 那条完成提醒里"去哪看"要带上它自己的名字
    assert.ok(h.worlds.roomFor('u1', 'city-weather'), '这一间要开得出来');
    const r = await post(h, '/api/say', {
      messageId: 'u_room_1',
      text: '把明天的天气画出来',
      scope: 'city-weather',
    });
    assert.equal(r.status, 200);
    await waitFor(
      () => notices(w.dir).some((e) => e.kind === 'work-done'),
      '房间里那条完成提醒',
    );
    const done = notices(w.dir).filter((e) => e.kind === 'work-done').pop();
    assert.match(done.text, /在「看天气」里/, `要说清去哪看：${done.text}`);
    assert.equal(typeof done.seq, 'number', '★ 落盘取号');
    // ★ **提醒要走到他眼前**：那句落的是**主线那本可见的账**（`notice` 是"对用户说话"
    //   的唯一出口）—— 所以他回了桌面也看得见"哪一间做完了"（P1 §三②）。
    assert.ok(
      w.timeline.readAll().some((e) => e.kind === 'work-done'),
      '那条完成提醒要在**主线视图**里看得见（他回到桌面也收得到）',
    );
    // ⚠️ 反过来说清：这一间的**正文**不许进主线（A4/A5）——
    //   只有那条提醒是例外（它是"对用户说话"，不是那一间的话）。
    assert.ok(
      !w.timeline.readAll().some((e) => e.type === 'message/text'),
      '🔴 房间的正文一个字都不许漏进主线',
    );
  } finally {
    await h.close();
  }
});

test('T4④c（真 Worlds）`work` 那条口问的是**这个人的活账**，答的是**人话**；🔴 正在问的那一轮要排掉', async () => {
  const h = await boot({ scenario: 'hang', cfg: { backgroundAfterMs: 9999, turnDeadlineMs: 60000 } });
  const w = h.worlds.worldFor('u1');
  try {
    w.apps.create({
      id: 'city-weather',
      title: '看天气',
      icon: 'cloud',
      entry: 'index.html',
      files: { 'index.html': '<p>天气</p>' },
    });
    h.worlds.roomFor('u1', 'city-weather');
    // 这一间里挂上一件（`hang` ⇒ 它一直跑着，不会自己收口）
    assert.equal(
      (await post(h, '/api/say', { messageId: 'u_room_q', text: '把明天天气画出来', scope: 'city-weather' })).status,
      200,
    );
    await waitFor(() => w.dispatcher.workList().length > 0, '这一件要挂上账');
    // ⚠️ **等这一轮真的开始**（`turn/start`）：工具只可能在**一轮里面**被调，
    //    那一刻这件活已经从 `waiting` 变成 `running`、而且绑上了 `(gen,turn)`
    //    —— 判据要打在**那个时刻**上，不能停在"刚投递、还没轮到"那一档。
    await waitFor(() => w.dispatcher.sessionFor('city-weather')?.turnInput !== '', '这一轮开始跑');
    assert.equal(w.dispatcher.workList().length, 1, '账上就这一件');

    // ① **从别的房间问**（`scope: 'main'`）⇒ 那一件**照报**（那正是他要问的）
    const fromMain = handleLedgerOp(w.ledger, { op: 'work', scope: 'main' }, { dispatcher: () => w.dispatcher });
    assert.equal(fromMain.ok, true, JSON.stringify(fromMain));
    assert.equal(fromMain.count, 1);
    assert.match(fromMain.text, /还在做|还排着/, `逐件答案：${fromMain.text}`);
    // ⚠️ **人话里必须是那一间的名字，不是内部 id**（`06` 禁用词那条）
    assert.match(fromMain.text, /看天气/);
    assert.ok(!fromMain.text.includes('city-weather'), `不许把内部 id 上屏：${fromMain.text}`);

    // ② 🔴 **从那件活自己那一间问** ⇒ 它**就是"正在问的那一轮"** ⇒ 排掉，回"没有挂着的活"
    //    （真机第一次就是这么答错的：他问"那件怎么样了"，回的是"那件还在做"——而那件是这句提问本身）
    const fromRoom = handleLedgerOp(w.ledger, { op: 'work', scope: 'city-weather' }, { dispatcher: () => w.dispatcher });
    assert.equal(fromRoom.count, 0, `正在问的那一轮必须排掉：${JSON.stringify(fromRoom)}`);
    assert.match(fromRoom.text, /没有挂着的活/);
    // 反例的正身：**不带 scope**（排不了任何一件）⇒ 又把它报出来了（说明 ① 不是恒真/恒假）
    const noScope = handleLedgerOp(w.ledger, { op: 'work' }, { dispatcher: () => w.dispatcher });
    assert.equal(noScope.count, 1);

    // ③ 负向对照：账上没有的那一件 ⇒ 也**必须有一句实话**（真调度器给的是
    //    "我没找到那件事。"），而**绝不能**说成"还在做"。
    const miss = handleLedgerOp(w.ledger, { op: 'work', ref: 'u_根本没有' }, { dispatcher: () => w.dispatcher });
    assert.equal(miss.ok, true);
    assert.match(miss.text, /没找到/, `查无此件也要说清：${miss.text}`);
    assert.ok(!/还在做|还排着/.test(miss.text), `查无此件不许说成还在做：${miss.text}`);

    // ④ 反例的正身：**不接那本活账** ⇒ 如实说"问不到"（绝不回"没有挂着的活"）
    const blind = handleLedgerOp(w.ledger, { op: 'work' }, null);
    assert.equal(blind.ok, false);
    assert.match(blind.error, /没接上/);
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
