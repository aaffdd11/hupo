// agent 运行时 + 翻译层。走**真 spawn、真 stdio、真协议**（用假 agent，不花钱）。
//
// 为什么不用 mock 替掉 spawn：最容易错的那一段恰恰就是它——
// 分帧、代号、退出、收尾。把它 mock 掉等于把 bug 藏在测试之外。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentRuntime, DshAgent, childEnv } from '../src/agent-runtime.js';
import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';
import { Dispatcher } from '../src/dispatcher.js';

const FAKE = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), 'fake-agent.mjs');

/** 起假 agent 的 spawn：把 node 当"dsh"用，脚本当 profile。 */
const fakeSpawn = (scenario) => (bin, args, opts) =>
  realSpawn(process.execPath, [FAKE], {
    ...opts,
    env: { ...opts.env, FAKE_SCENARIO: scenario },
  });

function cfg(over = {}) {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-agent-'));
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

async function setup({ scenario = 'normal', over = {}, store: given = null } = {}) {
  const store =
    given ??
    new Store({ dataDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-tl-')), fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const runtime = new AgentRuntime({ cfg: cfg(over), spawnFn: fakeSpawn(scenario) });
  const dispatcher = new Dispatcher({ timeline, runtime, store });
  return { store, timeline, runtime, dispatcher };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 服务端的 `Timeline` **没有 `items` getter**——它只管取号与推送
 * （那是客户端的模型）。要看"发生了什么"，读**落盘的日志**。
 *
 * 这本身就是一条纪律的体现：**落盘的才是可信的**。
 */
function productEvents(store) {
  return store.readAll('main');
}

/** 把 message/text 拼成一条气泡的正文。 */
function bubble(store, kind = 'text') {
  const evs = productEvents(store);
  const start = evs.filter((e) => e.type === 'message/start');
  if (start.length === 0) return null;
  const id = start[0].messageId;
  const texts = evs.filter((e) => e.type === 'message/text' && e.messageId === id);
  const end = evs.find((e) => e.type === 'message/end' && e.messageId === id);
  return {
    id,
    quick: texts.filter((t) => t.block === 'quick').map((t) => t.text).join(''),
    deep: texts.filter((t) => t.block === 'deep').map((t) => t.text).join(''),
    all: texts.map((t) => t.text).join(''),
    ended: !!end,
    reason: end?.reason ?? null,
    count: start.length,
    kind,
  };
}

async function turn(dispatcher) {
  await dispatcher.deliver('你好');
  await wait(500); // 让事件流回来
}

// ── 协议与起进程 ──────────────────────────────────────────

test('spawn + initialize 能起来，prompt 能投出去', async () => {
  const { dispatcher, runtime } = await setup();
  const r = await dispatcher.deliver('你好');
  assert.equal(r.delivered, true);
  assert.ok(r.messageId, '应该拿回一个 messageId（prompt 立刻返回，答案另走）');
  await runtime.shutdown();
});

test('★ cwd 不存在时，报的错要**把两种可能都写出来**（ENOENT 是二义的）', async () => {
  const bad = cfg({ agentCwd: '/definitely/not/here' });
  const agent = new DshAgent({ sessionId: 's', cfg: bad, spawnFn: fakeSpawn('normal') });
  await assert.rejects(
    () => agent.start(),
    (err) => {
      assert.match(err.message, /工作目录不存在/);
      assert.match(err.message, /ENOENT/, '要提到 ENOENT 这个二义性，否则下一个人会去查 PATH');
      return true;
    },
  );
  await agent.dispose();
});

test('★ spawn 失败是异步事件——接住了就不该把进程带崩', async () => {
  const bad = cfg({ dshBin: '/definitely/not/here/also' });
  const agent = new DshAgent({
    sessionId: 's',
    cfg: bad,
    spawnFn: () => realSpawn('/definitely/not/here/also', [], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  const exits = [];
  agent.on('exit', (i) => exits.push(i));
  await assert.rejects(() => agent.start(), /起不来|ENOENT/);
  await wait(80);
  assert.ok(exits.length >= 1, 'exit 事件必须发出来（不然调用方永远挂着）');
  assert.match(exits[0].reason, /找不到 dsh 程序|工作目录不存在/);
  await agent.dispose();
});

// ── ⚠️ 泄露那条 ───────────────────────────────────────────

test('★★ 推理原文绝不许进时间线（真 agent 把两者放在同一个 content 数组里）', async () => {
  const { store, timeline, runtime, dispatcher } = await setup({ scenario: 'normal' });
  await turn(dispatcher);

  const all = JSON.stringify(productEvents(store));
  assert.doesNotMatch(all, /用户让我打招呼/, '★ 推理原文泄进时间线了 —— 它可能含系统提示片段');
  assert.match(all, /你好。/, '正文要正常进来');
  // 但它是"看见过"的（只计数，不落内容）
  assert.ok(dispatcher.translator.reasoningSeen > 0, '应该计数到推理段的存在');
  await runtime.shutdown();
});

// ── 一轮怎么收口 ─────────────────────────────────────────

test('正常一轮：快答与深答在**同一个气泡**里', async () => {
  const { store, timeline, runtime, dispatcher } = await setup({ scenario: 'two-step' });
  await turn(dispatcher);

  const b = bubble(store);
  assert.equal(b.count, 1, '两步必须合成一个气泡（协议 R2）');
  assert.equal(b.ended, true);
  assert.equal(b.reason, 'completed');
  assert.match(b.quick, /收到/);
  assert.match(b.deep, /有雨/);
  await runtime.shutdown();
});

test('★ 被截断（max-tokens）⇒ 补一句 + 标成失败收尾', async () => {
  const { store, timeline, runtime, dispatcher } = await setup({ scenario: 'truncated' });
  await turn(dispatcher);

  const b = bubble(store);
  assert.match(b.all, /没说完/, '★ 绝不许把半句当完整回答');
  assert.equal(b.ended, true);
  assert.equal(b.reason, 'failed', '半句必须是失败收尾');
  await runtime.shutdown();
});

test('★ 一句话都没说 ⇒ 也要有个交代（不许留白）', async () => {
  const { store, timeline, runtime, dispatcher } = await setup({ scenario: 'silent' });
  await turn(dispatcher);

  const evs = productEvents(store);
  const starts = evs.filter((e) => e.type === 'message/start');
  assert.ok(starts.length >= 1, '不能什么都不留');
  const b = bubble(store);
  assert.ok(b.all.length > 0, '补的那句不能是空的');
  assert.equal(b.reason, 'failed');
  await runtime.shutdown();
});

test('★ 进程中途死掉 ⇒ 必须收口（不然用户永远等一条不会来的回答）', async () => {
  const { store, timeline, runtime, dispatcher } = await setup({ scenario: 'crash' });
  await turn(dispatcher);
  await wait(600);

  const b = bubble(store);
  assert.ok(b, '半句应该已经落盘');
  assert.equal(b.ended, true, '★ 进程死了也必须收口');
  assert.equal(dispatcher.translator.openTurn, null, '不许留下未收口的');
  await runtime.shutdown();
});

// ── S7：turns 的键 ────────────────────────────────────────

test('★ 两轮之后不留残留状态（turns 用的是「轮」的编号，不是气泡 id）', async () => {
  const { runtime, dispatcher } = await setup({ scenario: 'normal' });
  await turn(dispatcher);
  await turn(dispatcher);
  assert.equal(dispatcher.translator.openTurn, null, '★ 每轮都该清干净');
  // 还能继续跑到第三轮（没有被幽灵状态挡住）
  const r = await dispatcher.deliver('第三句');
  assert.equal(r.delivered, true);
  await wait(400);
  assert.equal(dispatcher.translator.openTurn, null);
  await runtime.shutdown();
});

test('🔴 forceClose：一轮开了、一个字都没说 ⇒ **也必须留下话**（N19）', async () => {
  // ⚠️ 这条是**改过的**。原先它断言的是：
  //      forceClose 在没有 writer 时返回 false、什么都不做。
  //    而那个行为**正是缺陷**：一轮开了、一个字都没说、然后进程没了 ⇒
  //    用户永远等一条不会来的回答（手册事故一那行挂了 68 分钟）。
  //    ⇒ 现在返回值是"收掉了几轮"，而且**没有 writer 也要说话**。
  const { runtime, dispatcher, store } = await setup({ scenario: 'slow' });
  try {
    await dispatcher.deliver('慢慢答');
    await wait(200); // 还没答 —— 但这一轮已经开了
    assert.equal(
      dispatcher.translator.forceClose('failed'),
      1,
      '★ 有未收口的轮 ⇒ 要收掉，而且**要说话**',
    );

    const b = bubble(store);
    assert.ok(b, '★ 屏幕上必须真的多一条（不许留白）');
    assert.equal(b.ended, true, '而且要收口');
    assert.equal(b.reason, 'failed');

    assert.equal(dispatcher.translator.forceClose('failed'), 0, '再收一次：没有了');
  } finally {
    // ⚠️ try/finally 不是洁癖：这条测试断言失败过一次，
    //    而当时没有 finally ⇒ `runtime.shutdown()` 没跑到 ⇒
    //    **假 agent 的子进程一直活着**，把整个 `npm test` 拖到 180 秒后
    //    被超时杀掉。**一个断言失败变成了整个测试套件挂住。**
    await runtime.shutdown();
  }
});

// ── 进程上限与淘汰 ────────────────────────────────────────

test('★ LRU 淘汰：只淘汰空闲的，而且**先收口再卸**', async () => {
  const { runtime, dispatcher } = await setup({ over: { agentMaxProcesses: 1 } });

  // 造一个"跑着"的 agent 和一个"空闲"的
  const busy = runtime.agent('busy');
  busy.running = true; // 假装它在干活
  const idle = runtime.agent('idle');
  await idle.start();
  assert.equal(runtime.count, 2);

  const evictedOrder = [];
  const runtime2 = runtime;
  runtime2.on('evict-error', () => {});
  // 换一个能观察回调顺序的 onEvict
  const calls = [];
  const rt = new AgentRuntime({
    cfg: cfg({ agentMaxProcesses: 1 }),
    spawnFn: fakeSpawn('normal'),
    onEvict: async (id) => {
      calls.push(`收口:${id}`);
    },
  });
  const b = rt.agent('busy');
  b.running = true;
  const i = rt.agent('idle');
  await i.start();
  const out = await rt.evictIfNeeded();

  assert.deepEqual(calls, ['收口:idle'], '★ 回调必须在卸载**之前**（先收口再卸）');
  assert.deepEqual(out, ['idle']);
  assert.equal(rt.count, 1, '跑着的那个必须留下');
  assert.ok(rt.snapshot().some((s) => s.sessionId === 'busy'));
  evictedOrder.push(...out, ...calls);
  await rt.shutdown();
  await runtime.shutdown();
  await dispatcher.shutdown();
});

test('★ 没超上限就不动任何人（不要手贱去卸）', async () => {
  const rt = new AgentRuntime({ cfg: cfg({ agentMaxProcesses: 4 }), spawnFn: fakeSpawn('normal') });
  await rt.agent('a').start();
  await rt.agent('b').start();
  assert.deepEqual(await rt.evictIfNeeded(), []);
  assert.equal(rt.count, 2);
  await rt.shutdown();
});

// ── 环境变量 ──────────────────────────────────────────────

test('★ env 先做减法：只删密钥类，**PATH/HOME 一定留着**', () => {
  const prev = { ...process.env };
  process.env.HUPO_TEST_API_KEY = 'x';
  process.env.HUPO_TEST_TOKEN = 'y';
  process.env.HUPO_TEST_SECRET = 'z';
  process.env.HUPO_TEST_PLAIN = 'keep-me';
  try {
    const env = childEnv({ home: '/tmp/dshhome' });
    assert.equal(env.HUPO_TEST_API_KEY, undefined);
    assert.equal(env.HUPO_TEST_TOKEN, undefined);
    assert.equal(env.HUPO_TEST_SECRET, undefined);
    assert.equal(env.HUPO_TEST_PLAIN, 'keep-me');
    // ★ 丢 PATH 就回到 ENOENT —— 而那是最难查的一种
    assert.equal(env.PATH, prev.PATH);
    assert.equal(env.HOME, prev.HOME);
    assert.equal(env.DSH_HOME, '/tmp/dshhome');
  } finally {
    process.env = prev;
  }
});

// ── DSH 会话 id：**唯一性是"每个实例"，不只是"每次启动"** ──────
//
// 实测：`session/prompt` 对**已存在**的会话 id 直接报
// `session "main" already exists` —— SDK 只能 create，不能 resume。
// 我第一次跑真 agent 就撞上了这个，现象只是"它不理我了"。

test('★ DSH 会话 id 带 bootId，而且每次启动都不一样', () => {
  const a = new AgentRuntime({ cfg: cfg(), spawnFn: fakeSpawn('normal') });
  const b = new AgentRuntime({ cfg: cfg(), spawnFn: fakeSpawn('normal') });
  assert.match(a.agent('main').dshSessionId, new RegExp(`^main\\.${a.bootId}\\.`));
  assert.notEqual(a.bootId, b.bootId, '两次启动的 bootId 必须不同，否则会撞上上次留下的会话');
});

test('🔴★ 同一个 runtime 里换一个 agent 实例 ⇒ **必须换 DSH 会话 id**', async () => {
  // ⚠️ 这条是**改过的**，原先它是反的（断言"同一进程内每次拿到同一个 id"），
  //    而那个断言编码的是一个**错的**信念："id 一样才不丢记忆"。
  //    真相：记忆在**进程**里，不在 id 里；而 DSH 的会话记录
  //    **落在 $DSH_HOME/sessions/ 里、跨进程活着**
  //    （实测那目录下躺着 19 个 `main.<bootId>`）。
  //
  //    实测复现（`/tmp/probe-session-reuse.mjs`）：
  //      同一个 runtime：起 agent → stop() → 再起 agent → prompt
  //      ⇒ `session "main.mu9rmdgzijr2" already exists`
  //      ⇒ **用户接下来每一句都发不出去**，而看起来只是"它不理我了"。
  //
  //    触发它的正是**超时硬收口**：它会在同一个 runtime 里卸掉再起。
  const rt = new AgentRuntime({ cfg: cfg(), spawnFn: fakeSpawn('normal') });
  const id1 = rt.agent('main').dshSessionId;
  await rt.stop('main');
  const id2 = rt.agent('main').dshSessionId;
  assert.notEqual(id1, id2, '★ 换实例必须换 id —— 否则 `already exists`');
  assert.match(id1, /^main\./);
  assert.match(id2, /^main\./);
  // 会话名还在最前面（人看得出这是哪个会话）
  assert.equal(id1.split('.')[0], 'main');
  assert.equal(id2.split('.')[0], 'main');
  await rt.shutdown();
});

test('★ 投给 agent 的是带后缀的那个 id（不是时间线 id）', async () => {
  const rt = new AgentRuntime({ cfg: cfg(), spawnFn: fakeSpawn('normal') });
  const a = rt.agent('main');
  assert.equal(a.sessionId, 'main', '时间线 id 不变');
  assert.match(a.dshSessionId, /^main\./, '给 DSH 的要带后缀');
  await rt.shutdown();
});

// ── 通知的方法名是「点」不是「斜杠」──────────────────────
//
// 实测：我们**发出去**的是 `session/prompt`（斜杠），
//      而它**发过来**的是 `session.event` / `session.status`（**点**）。
// 我一开始按斜杠比，于是所有事件被静默丢掉——
// 现象是"agent 起来了、prompt 也成功、但一个事件都收不到"。

test('★ 假 agent 用点号方法名，也必须能收到（防回归）', async () => {
  const { store, runtime, dispatcher } = await setup({ scenario: 'normal' });
  await turn(dispatcher);
  const ends = store.readAll('main').filter((e) => e.type === 'message/end');
  assert.equal(ends.length, 1, '★ 事件被丢掉了 —— 检查方法名的点/斜杠');
  await runtime.shutdown();
});

// ── S2：过程状态**按轮寻址**（不是按气泡）────────────────────
//
// 旧实现发的是 `messageId: ''`，客户端按 id 找、恒 null ⇒ 状态永远挂不上
// （`07-APPENDIX.md` §1.5）。根因不是"忘填 id"：DSH 的 `session.status`
// 都落在消息生命周期之外，**那个地址没有可能的值**。见 `dispatcher.js` `#announceTurn`。

test('🔴 S2：`message/status` 的地址是「轮」，而且**绝不许发空字符串当地址**', async () => {
  const { runtime, dispatcher, timeline } = await setup({ scenario: 'normal' });
  const statuses = [];
  timeline.subscribe((e) => {
    if (e.type === 'message/status') statuses.push(e);
  });
  try {
    await dispatcher.deliver('你好');
    await wait(400);

    assert.ok(statuses.length >= 1, '★ 一轮开起来就要告诉界面（那段空白正是放弃点所在）');
    for (const s of statuses) {
      assert.equal(typeof s.turn, 'number', '★ 地址是「轮」');
      assert.notEqual(s.messageId, '', '★ 空字符串不是地址 —— 它是"永远挂不上"的成因');
      assert.equal(s.seq, undefined, '瞬态不占号（决策 P-g）');
    }
    assert.equal(statuses[0].state, 'started');
  } finally {
    await runtime.shutdown();
  }
});

test('🔴 进程死掉时：一轮开了、一个字没说 ⇒ **必须落一条看得见的话**', async () => {
  // 这条路原先**什么都不说**，而且那一轮**永远留在 `#turns` 里**（泄漏）。
  // `openTurn` 只找"有 writer 的那一轮"，所以它看不见这一种。
  const { runtime, dispatcher, store } = await setup({ scenario: 'hang-die' });
  try {
    await dispatcher.deliver('跑个东西');
    await wait(900);

    const b = bubble(store);
    assert.ok(b, '★ 用户必须看到一句交代（N19：挂起必有收尾）');
    assert.equal(b.ended, true);
    assert.match(b.all, /断了|没做完/, `说的话要是人话：${b.all}`);
  } finally {
    await runtime.shutdown();
  }
});

test('★ P1-20：取用新 agent 的那一刻**自动**淘汰（上限才真的生效）', async () => {
  // 在接线之前：产品代码一处都没调过 `evictIfNeeded` ⇒ `maxProcesses` 形同虚设。
  const calls = [];
  const rt = new AgentRuntime({
    cfg: cfg({ agentMaxProcesses: 1 }),
    spawnFn: fakeSpawn('normal'),
    onEvict: async (id) => {
      calls.push(id);
    },
  });
  const one = rt.agent('one');
  await one.start();
  const two = rt.agent('two');
  await two.start();
  // 淘汰是**后台**跑的（`agent()` 不许被它拖住）⇒ 给它一拍
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(rt.count <= 1, `上限是 1，现在 ${rt.count} 个 ⇒ 那个上限没生效`);
  assert.deepEqual(calls, ['one'], '该淘汰**最久没用**的那个（LRU 那一头）');
  await rt.shutdown();
});
