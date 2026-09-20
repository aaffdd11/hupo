// 单轮硬收口（超时）。手册 N19「挂起必有收尾」+ N10「超时必须伴随资源回收
// （收气泡 ≠ 停 agent）」。
//
// 三条实测事实决定了这一批的形状（`docs/dev/07-TIMEOUT.md` §一）：
//   ① DSH **不变** `turn/end` 就没人知道它卡住了 ⇒ 只能靠我们这边的钟
//   ② 一轮没结束时再发一句，DSH **接受并排队**（`inbox/spliced target=next-turn`）
//      ⇒ 踢掉进程时那句会跟着一起没 ⇒ **必须逐条收口**
//   ③ `turn/start` 可能**早于** `prompt()` 返回 ⇒ 投递队列要**先记账再投**
//
// 走**真 spawn、真 stdio**（假 agent），因为要验的正是"进程到底有没有被卸掉"。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentRuntime } from '../src/agent-runtime.js';
import { Dispatcher } from '../src/dispatcher.js';
import { DEADLINE_LINES } from '../src/session-translate.js';
import { SayService } from '../src/say.js';
import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';

const FAKE = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), 'fake-agent.mjs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 假 agent 的 spawn。**场景可以按"第几次 spawn"给**（传数组）。
 *
 * 为什么需要：要验"卡住 → 卸下 → 用户再说一次 → 新 agent 好好答"，
 * 就必须让**第一个**进程卡住、**第二个**正常。一个固定场景做不到这件事
 * （第一个被卸掉之后，新的那个也会一样卡住——那验的就不是恢复，是重复卡住）。
 */
const fakeSpawn = (scenarios, extraEnv = {}) => {
  const list = Array.isArray(scenarios) ? scenarios : [scenarios];
  let n = 0;
  return (bin, args, opts) => {
    const scenario = list[Math.min(n, list.length - 1)];
    n += 1;
    return realSpawn(process.execPath, [FAKE], {
      ...opts,
      env: { ...opts.env, FAKE_SCENARIO: scenario, ...extraEnv },
    });
  };
};

function cfg(over = {}) {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-hang-'));
  return {
    dshBin: 'unused',
    agentProfile: 'sdk',
    agentCwd: dir,
    dshHome: dir,
    agentProvider: 'fake',
    agentModel: 'fake',
    agentEffort: 'low',
    agentMaxTokens: 512,
    agentBootTimeoutMs: 20000,
    agentMaxProcesses: 4,
    agentIdleEvictMs: 60000,
    personaPath: null,
    ...over,
  };
}

function setup({ scenario, turnDeadlineMs = 150, dshSessions = false }) {
  // `scenario` 可以是数组：第 N 个进程用第 N 个场景
  const store = new Store({
    dataDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-hang-')),
    fsync: false,
  });
  const timeline = new Timeline({ id: 'main', store });
  // `dshSessions: true` ⇒ 让假 agent **真的执行** DSH 那条"会话 id 只能 create"的规矩
  // （会话记录写在一个跨进程共享的文件里）。不打开的话，
  // "换了实例却沿用同一个会话 id"这类 bug 在 CI 里**永远测不出来**。
  const sessionFile = dshSessions
    ? nodePath.join(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-dshsess-')), 'sessions.txt')
    : null;
  const runtime = new AgentRuntime({
    cfg: cfg(),
    spawnFn: fakeSpawn(scenario, dshSessions ? { FAKE_SESSION_FILE: sessionFile } : {}),
    onEvict: (sessionId) => dispatcher.onEvict(sessionId),
  });
  const dispatcher = new Dispatcher({ timeline, runtime, store, turnDeadlineMs });
  const say = new SayService({ timeline, store, timelineId: 'main' });
  const saying = async (text, messageId) => {
    say.say({ messageId, text });
    return dispatcher.deliver(text, { messageId });
  };
  // 记下 runtime 发出去过的**每一个实例**。
  // ⚠️ 不能靠事后自己调 `runtime.agent(id)` 去取——那个方法**会顺手造一个新的**
  //    （于是"新实例"永远成立、而它根本没被启动过）。要验"是不是换了实例"，
  //    只能记**派出去过的那些**。
  const seen = [];
  const orig = runtime.agent.bind(runtime);
  runtime.agent = (id) => {
    const a = orig(id);
    if (!seen.includes(a)) seen.push(a);
    return a;
  };
  return { store, timeline, runtime, dispatcher, saying, seen, sessionFile };
}

/** 落盘的 `message/*`，按 messageId 归拢成气泡。 */
function bubbles(store) {
  const evs = store.readAll('main');
  const out = new Map();
  for (const e of evs) {
    if (e.type === 'message/start') out.set(e.messageId, { text: '', reason: null, agent: e.agent });
    if (e.type === 'message/text') {
      const b = out.get(e.messageId) ?? { text: '', reason: null, agent: null };
      b.text += e.text;
      out.set(e.messageId, b);
    }
    if (e.type === 'message/end') {
      const b = out.get(e.messageId) ?? { text: '', reason: null, agent: null };
      b.reason = e.reason;
      out.set(e.messageId, b);
    }
  }
  return [...out.values()];
}

async function disposeAll(s) {
  try {
    await s.dispatcher.shutdown();
    await s.runtime.shutdown();
  } catch {
    /* 已经没了 */
  }
}

// ── N19：挂起必有收尾 ───────────────────────────────────────

test('🔴 N19：一轮开始之后永远不结束 ⇒ 到点必须收口，而且**必须留下话**', async () => {
  const s = setup({ scenario: 'hang', turnDeadlineMs: 150 });
  try {
    await s.saying('这件事你帮我办一下', 'u_1');
    // 卡住的样子：进程活着、一轮开着、一句话都没有
    await wait(120);
    // ⚠️ 不能用 `translator.openTurn` 判——它的语义是"**有 writer 的**那一轮"
    //    （`forceClose` 用它），而这里恰恰是"开了一轮、一句话都没说"。
    //    计时器挂着就说明轮开始了、而且没有 turn/end。
    assert.equal(s.dispatcher.armedDeadlines, 1, '一轮确实开着（计时器挂着）');
    assert.equal(bubbles(s.store).length, 0, '此刻一条气泡都没有 —— 这正是事故的样子');

    await wait(300); // 越过 150ms

    const b = bubbles(s.store);
    assert.equal(b.length, 1, '★ 必须**主动**说一句（不许留白）');
    assert.equal(b[0].text, DEADLINE_LINES.empty);
    assert.equal(b[0].reason, 'timeout', '收尾理由要记成 timeout，不是含糊的 failed');
  } finally {
    await disposeAll(s);
  }
});

test('🔴 N19：已经说了半句再卡住 ⇒ 收口时补一句，而且**不重复开头**', async () => {
  const s = setup({ scenario: 'hang-talk', turnDeadlineMs: 150 });
  try {
    await s.saying('帮我查一下', 'u_1');
    await wait(450);
    const b = bubbles(s.store);
    assert.equal(b.length, 1, '还是**一条**气泡（快答/深答是同一个气泡，协议 R2）');
    assert.match(b[0].text, /我正在查…/, '它说过的那半句要留住');
    assert.match(b[0].text, /这条我卡住了/, '补的那句要接在后面');
    assert.equal(b[0].reason, 'timeout');
  } finally {
    await disposeAll(s);
  }
});

test('🔴 收尾理由 `timeout` 与 `failed` 是**两回事**（记成一样以后查不出来）', async () => {
  const s = setup({ scenario: 'hang', turnDeadlineMs: 150 });
  try {
    await s.saying('卡住的', 'u_1');
    await wait(400);
    assert.ok(s.store.readAll('main').some((e) => e.reason === 'timeout'));
    assert.ok(!s.store.readAll('main').some((e) => e.reason === 'failed'), '这一路不该出现 failed');
  } finally {
    await disposeAll(s);
  }
});

// ── N10：收气泡 ≠ 停 agent ─────────────────────────────────

test('🔴 N10：超时**必须把 agent 卸掉**（只收气泡不算数）', async () => {
  const s = setup({ scenario: 'hang', turnDeadlineMs: 150 });
  try {
    const agent = s.runtime.agent('main');
    await s.saying('卡住的', 'u_1');
    await wait(400);

    assert.equal(agent.ready, false, '★ 进程必须被卸掉（N10：收气泡 ≠ 停 agent）');
    assert.equal(s.runtime.count, 0, '★ runtime 的表里也不许再留着它');
    // 为什么这条要紧：留着的话它 `running` 恒真，
    // 而 LRU 的规矩是"跑着的不许卸" ⇒ **永远不会被淘汰**，永久占一个位置。
    assert.deepEqual(await s.runtime.evictIfNeeded(), [], '已经没有它了，淘汰无事可做');
  } finally {
    await disposeAll(s);
  }
});

test('🔴 卸掉之后用户再说话：起**新的** agent（而且是好的那个），并重新喂背景', async () => {
  // 第一个进程卡死，第二个是好的 —— 这才是用户真正会遇到的那条路
  const s = setup({ scenario: ['hang', 'normal'], turnDeadlineMs: 150 });
  try {
    const first = s.runtime.agent('main');
    await s.saying('第一句', 'u_1');
    await wait(400);
    assert.equal(first.ready, false, '第一个已经被卸了');
    assert.equal(s.runtime.count, 0, '表里也不剩了');

    const r = await s.saying('第二句', 'u_2');
    await wait(400);
    assert.equal(r.delivered, true, '★ 新实例要能接上活');
    const second = s.seen.at(-1);
    assert.notEqual(second, first, '★ 必须是**新实例**');
    assert.equal(second.ready, true, '新实例活着');
    // 新实例什么都不记得 ⇒ 必须把背景喂回去（否则用户会看到"失忆"）
    assert.match(s.dispatcher.lastRecap ?? '', /第一句/, '★ 背景里要有上一句');
    // 而且它真的答上了（不是又一次卡住）
    const answered = s.store.readAll('main').some(
      (e) => e.type === 'message/end' && e.reason === 'completed',
    );
    assert.ok(answered, '★ 恢复了：新 agent 把这一轮好好答完了');
    assert.equal(s.dispatcher.pendingDeliveries, 0);
  } finally {
    await disposeAll(s);
  }
});

test('🔴★ 恢复时必须**换一个 DSH 会话 id**（真 DSH 只 create 不 resume）', async () => {
  // ⚠️ 这一条差点漏过去，是**端到端真 agent** 才抓到的：
  //    超时硬收口在**同一个 runtime 里**把 agent 卸掉再起一个，
  //    而 `bootId` 是整个 runtime 一份、永不改变 ⇒ 新实例沿用同一个会话 id
  //    ⇒ 真 DSH 报 `session "main.<bootId>" already exists`
  //    ⇒ **用户接下来每一句都发不出去**，而看起来只是"它不理我了"。
  //
  //    这里让假 agent **真的执行**那条规矩（会话记录写在跨进程共享的文件里），
  //    于是这条 bug 从此在 CI 里就能被抓住，不用每次都花真模型调用。
  const s = setup({ scenario: ['hang', 'normal'], turnDeadlineMs: 150, dshSessions: true });
  try {
    await s.saying('第一句（这轮会卡住）', 'u_1');
    await wait(450);
    assert.equal(s.runtime.count, 0, '卡住的那个已经被卸了');
    assert.equal(s.dispatcher.armedDeadlines, 0);

    const r = await s.saying('第二句（恢复）', 'u_2');
    await wait(400);
    assert.equal(r.delivered, true, '★ 恢复投递必须成功——不许撞 already exists');

    const ids = nodeFs.readFileSync(s.sessionFile, 'utf8').trim().split('\n');
    assert.equal(ids.length, 2, '真起了两代会话');
    assert.notEqual(ids[0], ids[1], '★ 两代的 DSH 会话 id 必须不同');

    const answered = s.store.readAll('main').some(
      (e) => e.type === 'message/end' && e.reason === 'completed',
    );
    assert.ok(answered, '★ 而且新 agent 好好答完了');
  } finally {
    await disposeAll(s);
  }
});

// ── 排队那句（实测出来的那条路）─────────────────────────────

test('🔴 一轮卡住时又说了两句 ⇒ 到点**排队那两句也要逐条收口**', async () => {
  // 实测：一轮没结束时再发，DSH 会**接受并排队**（`inbox/spliced target=next-turn`）。
  // 超时踢掉进程 ⇒ 排队那些话**再也没有下一轮**⇒ 不收就是永久空白。
  const s = setup({ scenario: 'hang', turnDeadlineMs: 400 });
  try {
    await s.saying('第一句（这轮开始，然后卡住）', 'u_1');
    await wait(80);
    await s.saying('第二句（排队）', 'u_2');
    await s.saying('第三句（排队）', 'u_3');
    await wait(150);
    assert.equal(s.dispatcher.pendingDeliveries, 2, '两条排在队里（第一句已经被轮消费掉）');
    assert.equal(bubbles(s.store).length, 0, '排队中——按定义还没有任何回答');

    await wait(500); // 越过 400ms

    const b = bubbles(s.store);
    assert.equal(b.length, 3, '★ 1 条收口 + 2 条排队的，**一条都不许剩**');
    for (const x of b) {
      assert.equal(x.reason, 'timeout');
      assert.equal(x.agent, 'agent', '收口的话是**它**说的，不是把主人的话改了');
    }
    assert.equal(b.filter((x) => x.text === DEADLINE_LINES.empty).length, 1);
    assert.equal(b.filter((x) => x.text === DEADLINE_LINES.queued).length, 2);
    assert.equal(s.dispatcher.pendingDeliveries, 0, '队列要清干净');
  } finally {
    await disposeAll(s);
  }
});

test('🔴 投递队列在**一轮开始时**消费（不然超时会漏收）', async () => {
  const s = setup({ scenario: 'normal', turnDeadlineMs: 5000 });
  try {
    await s.saying('第一句', 'u_1');
    await wait(300);
    assert.equal(s.dispatcher.pendingDeliveries, 0, '变成一轮之后就不算排队了');
    assert.equal(s.dispatcher.translator.openTurn, null, '这一轮已经正常收口');
  } finally {
    await disposeAll(s);
  }
});

// ── 计时器本身的纪律 ────────────────────────────────────────

test('正常收口时**计时器要撤掉**（否则每一轮都留一个定时器）', async () => {
  const s = setup({ scenario: 'normal', turnDeadlineMs: 5000 });
  try {
    await s.saying('你好', 'u_1');
    await wait(300);
    assert.equal(s.dispatcher.armedDeadlines, 0, '收口了就该撤，不然会越攒越多');
  } finally {
    await disposeAll(s);
  }
});

test('正常收口之后**不许**再被超时收一次（那会把一条好回答标成失败）', async () => {
  const s = setup({ scenario: 'normal', turnDeadlineMs: 120 });
  try {
    await s.saying('你好', 'u_1');
    await wait(400); // 越过了 120ms，但这一轮早就正常结束了
    const b = bubbles(s.store);
    assert.equal(b.length, 1);
    assert.equal(b[0].reason, 'completed', '★ 不许被超时改成 timeout');
    assert.equal(b[0].text, '你好。');
    assert.equal(s.runtime.count, 1, '也不许因为"超时"把好好的 agent 卸了');
  } finally {
    await disposeAll(s);
  }
});

test('`turnDeadlineMs = 0` 等于关掉（测试与排障用）', async () => {
  const s = setup({ scenario: 'hang', turnDeadlineMs: 0 });
  try {
    await s.saying('卡住的', 'u_1');
    await wait(300);
    assert.equal(s.dispatcher.armedDeadlines, 0);
    assert.equal(bubbles(s.store).length, 0, '关掉就是关掉——什么都不发生');
    assert.equal(s.runtime.count, 1, 'agent 也还在');
  } finally {
    await disposeAll(s);
  }
});

test('收工（shutdown）要把计时器全撤掉，别让定时器把进程钉住', async () => {
  const s = setup({ scenario: 'hang', turnDeadlineMs: 60_000 });
  try {
    await s.saying('卡住的', 'u_1');
    await wait(250);
    assert.equal(s.dispatcher.armedDeadlines, 1, '挂着呢');
    await s.dispatcher.shutdown();
    assert.equal(s.dispatcher.armedDeadlines, 0, '收工要撤干净');
  } finally {
    await disposeAll(s);
  }
});

// ── 文案本身也是验收对象 ────────────────────────────────────

test('那三句话必须是**人话**：不许出现内部词，而且要说清"怎么办"', () => {
  const banned = [
    '工作区', '口令', '连接', '客户端', '云端', '超时', '超时了', '进程', 'agent',
    '工具', '服务', '系统', 'token', 'API', 'web_search', 'bash', '失败', '错误', '异常',
  ];
  for (const [k, line] of Object.entries(DEADLINE_LINES)) {
    for (const w of banned) {
      assert.ok(!line.includes(w), `「${k}」里有内部词「${w}」：${line}`);
    }
    // 可重试（N11：拒绝要给人话 + **可重试**）
    assert.ok(
      /再说一次|让我接着说|再说一次吧/.test(line),
      `「${k}」没说清怎么办：${line}`,
    );
    assert.ok(line.length <= 40, `「${k}」太长了（${line.length} 字）`);
  }
  // 三句话必须**互不相同**——一样的话用户分不出发生了哪种
  assert.equal(new Set(Object.values(DEADLINE_LINES)).size, 3);
});
