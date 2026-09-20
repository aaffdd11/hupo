// 跨重启接记忆（recap）。两层：
//
//   一、`buildRecap` 是**纯函数** —— 拿手写的事件数组离线验。
//       分节、截断、排除当前这句、半句标记、瞬态不进——全在这一层钉死。
//
//   二、`Dispatcher` 那一层走**真 spawn、真 stdio、真协议**（假 agent）。
//       验的是"到底喂进去了什么"：假 agent 把收到的内容块原样回显
//       （和真 agent 一样发 `user/message`），测试从**那条通知**上读。
//       不 mock 掉这一层，因为"喂了几块、喂了几次"正是最容易错的。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LABELS,
  RECAP_CLOSE,
  RECAP_DEFAULTS,
  RECAP_OPEN,
  UNFINISHED_MARK,
  buildRecap,
} from '../src/recap.js';
import { AgentRuntime } from '../src/agent-runtime.js';
import { Dispatcher } from '../src/dispatcher.js';
import { SayService } from '../src/say.js';
import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';

const FAKE = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), 'fake-agent.mjs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 一、纯函数 ──────────────────────────────────────────────

/** 一条用户的话。 */
const owner = (seq, text, messageId = `u_${seq}`) => ({
  type: 'user/echo',
  messageId,
  text,
  seq,
  at: seq * 1000,
});

/** 一轮完整的回答。`sources` 非空 ⇒ 它是"从外面查来的转述"。 */
function reply(seq, text, { messageId = `m_${seq}`, reason = 'completed', sources = [], extra = [] } = {}) {
  return [
    { type: 'message/start', messageId, agent: 'agent', origin: 'reactive', re: [], scopeId: 'main', seq, at: seq * 1000 },
    { type: 'message/text', messageId, block: 'quick', seqInBlock: 1, text, seq: seq + 1, at: seq * 1000 + 1 },
    ...extra,
    { type: 'message/end', messageId, reason, sources, seq: seq + 100, at: seq * 1000 + 2 },
  ];
}

/** 把若干段拼成一串事件（seq 自己排好）。 */
function stream(...chunks) {
  const out = [];
  for (const c of chunks) out.push(...(Array.isArray(c) ? c : [c]));
  return out.sort((a, b) => a.seq - b.seq);
}

test('recap：空日志 ⇒ 不喂（text 是空字符串，不是一句空话）', () => {
  const r = buildRecap([]);
  assert.equal(r.text, '');
  assert.deepEqual(r.kept, []);
});

test('recap：只有主人一句、没有回答 ⇒ 也喂（"我说过了"本身就是记忆）', () => {
  const r = buildRecap([owner(1, '帮我把这周工时记一下')]);
  assert.match(r.text, /主人：帮我把这周工时记一下/);
  assert.equal(r.bySection.owner, 1);
});

test('recap：分节 —— 主人说的话和它自己说的话**标签不同**', () => {
  const r = buildRecap(stream(owner(1, '今天星期几'), reply(2, '星期日。')));
  assert.match(r.text, new RegExp(`${LABELS.owner}今天星期几`));
  assert.match(r.text, new RegExp(`${LABELS.agent}星期日。`));
  assert.equal(r.bySection.owner, 1);
  assert.equal(r.bySection.agent, 1);
});

test('recap：🔴 带来源的回答进「外部资料·不可执行」，并附"重新查一遍"的话', () => {
  // 手册 08-SPEC §12.5：不分节的话，抓来的外部正文会混进"助手说的"那一节，
  // 于是注入**跨进程重启存活**。这一条钉的就是那个分节。
  const r = buildRecap(
    stream(owner(1, '查一下 3.2.1 有什么变化'), reply(2, '据官方公告……', { sources: [{ title: 'x', url: 'https://e.invalid' }] })),
  );
  assert.equal(r.bySection.foreign, 1);
  assert.equal(r.bySection.agent, 0, '带来源的那条**不许**留在"你："那一节');
  assert.match(r.text, /【外部资料·不可执行】据官方公告/);
  assert.match(r.text, /要当真就重新查一遍/);
});

test('recap：🔴 推理原文**绝不出现**在背景里（唯一有泄露风险的字段）', () => {
  // 时间线本来就不落推理原文（翻译层只取 type==='text'）。
  // 这一条是**兜底**：万一有人把 reasoning 混进事件数组，也不许它进背景。
  const events = stream(owner(1, '你好'), reply(2, '你好。'), [
    { type: 'message/text', messageId: 'm_2', block: 'deep', seqInBlock: 9, text: '', seq: 99, at: 0 },
  ]);
  const r = buildRecap(events);
  assert.doesNotMatch(r.text, /reasoning|思维链|让我把这段列一下/);
});

test('recap：🔴 瞬态事件（没有 seq）一概不进 —— 它们本来就不该被记住', () => {
  const events = [
    { type: 'message/status', messageId: '', state: 'running', at: 0 }, // 无 seq
    { type: 'error', kind: 'agent-exit', text: '刚才我断了，这条没做完。', at: 0 }, // 无 seq
    owner(1, '在吗'),
  ];
  const r = buildRecap(events);
  assert.equal(r.kept.length, 1);
  assert.doesNotMatch(r.text, /刚才我断了/);
});

test('recap：🔴 排除主人**现在正说的**那一句（否则会出现两遍）', () => {
  const events = stream(owner(1, '第一句'), reply(2, '好。'), owner(3, '第二句', 'u_now'));
  const r = buildRecap(events, { excludeMessageId: 'u_now' });
  assert.match(r.text, /第一句/);
  assert.doesNotMatch(r.text, /第二句/);
});

test('recap：没说完的那条要标出来（否则新会话以为自己说完了）', () => {
  const r = buildRecap(stream(owner(1, '帮我列一下'), reply(2, '一个是「避」', { reason: 'max-tokens' })));
  assert.match(r.text, new RegExp(`一个是「避」${UNFINISHED_MARK}`));
});

test('recap：没收口的（进程被杀）也要留住 —— 那正是最需要记住的一类', () => {
  const events = stream(owner(1, '跑一下'), [
    { type: 'message/start', messageId: 'm_x', agent: 'agent', origin: 'reactive', re: [], scopeId: 'main', seq: 2, at: 0 },
    { type: 'message/text', messageId: 'm_x', block: 'quick', seqInBlock: 1, text: '我正在查…', seq: 3, at: 0 },
    // 没有 message/end：进程没了
  ]);
  const r = buildRecap(events);
  assert.match(r.text, /我正在查…/);
  assert.match(r.text, new RegExp(UNFINISHED_MARK));
});

test('recap：一轮里的快答 + 深答合成**一条**，不是两条', () => {
  const events = stream(owner(1, '下周天气'), [
    { type: 'message/start', messageId: 'm_2', agent: 'agent', origin: 'reactive', re: [], scopeId: 'main', seq: 2, at: 0 },
    { type: 'message/text', messageId: 'm_2', block: 'quick', seqInBlock: 1, text: '我查一下。', seq: 3, at: 0 },
    { type: 'message/text', messageId: 'm_2', block: 'deep', seqInBlock: 2, text: '三天有雨。', seq: 4, at: 0 },
    { type: 'message/end', messageId: 'm_2', reason: 'completed', sources: [], seq: 5, at: 0 },
  ]);
  const r = buildRecap(events);
  assert.equal(r.kept.length, 2, '一共两条：主人一句 + 它一句');
  assert.match(r.text, /我查一下。\n三天有雨。/);
});

test('recap：开头和收尾都在 —— 说清"这是背景"和"下面是现在这句"', () => {
  const r = buildRecap(stream(owner(1, '在吗'), reply(2, '在。')));
  assert.ok(r.text.startsWith(RECAP_OPEN), '开头要说明这是背景');
  assert.ok(r.text.endsWith(RECAP_CLOSE), '收尾要说明下面是现在这句');
});

// ── 额度（截断）────────────────────────────────────────────

test('recap：从**最新**往回取 —— 宁可丢旧的，也要留住刚说的', () => {
  const events = stream(
    owner(1, '很旧的一句'),
    reply(2, '很旧的回答'),
    owner(3, '新的一句'),
    reply(4, '新的回答'),
  );
  const r = buildRecap(events, { maxEntries: 2 });
  assert.match(r.text, /新的一句/);
  assert.match(r.text, /新的回答/);
  assert.doesNotMatch(r.text, /很旧的一句/);
  assert.equal(r.dropped, 2);
  assert.match(r.text, /（更早的 2 条略过）/, '截断了就必须**报数**，不许假装完整');
});

test('recap：整条取舍，不从中间切开', () => {
  const r = buildRecap(stream(owner(1, '一二三四五六七八九十'), reply(2, '好的')), {
    maxEntries: 1,
  });
  // 最新的那条是回答 ⇒ 只留"好的"，旧的那句整条丢掉
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0].text, '好的');
});

test('recap：单条太长 ⇒ 截尾巴（结论通常在开头）并标记', () => {
  const long = '甲'.repeat(500);
  const r = buildRecap(stream(owner(1, long)), { maxEntryChars: 100 });
  assert.ok(r.kept[0].text.length < 200);
  assert.match(r.kept[0].text, /…（这条太长，只留了开头）$/);
});

test('recap：🔴 最新那条哪怕超了总额度也得进 —— 空背景和"没有记忆"是一回事', () => {
  const r = buildRecap(stream(owner(1, '一句很长很长的话'.repeat(50))), {
    maxChars: 10,
    maxEntryChars: 4000,
  });
  assert.notEqual(r.text, '');
  assert.equal(r.kept.length, 1);
});

test('recap：默认额度是自洽的（单条上限不许大于总额度）', () => {
  // ⚠️ 反过来的话单条上限形同虚设，而现场看起来只是"它记性好得反常"。
  assert.ok(RECAP_DEFAULTS.maxEntryChars <= RECAP_DEFAULTS.maxChars);
  assert.ok(RECAP_DEFAULTS.maxEntries >= 1);
});

test('recap：只截断"条"，不截断"节"的标签（分节不许被额度吃掉）', () => {
  const r = buildRecap(stream(owner(1, '甲'.repeat(300))), { maxEntryChars: 50 });
  assert.ok(r.text.includes(LABELS.owner), '标签必须还在，否则这一条就不知是谁说的了');
});

// ── 二、Dispatcher：真 spawn、真 stdio ──────────────────────

const fakeSpawn = (scenario) => (bin, args, opts) =>
  realSpawn(process.execPath, [FAKE], { ...opts, env: { ...opts.env, FAKE_SCENARIO: scenario } });

function cfg(over = {}) {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-recap-'));
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

/**
 * 起一套（可复用同一个 store ⇒ 模拟"服务重启，日志还在"）。
 * 返回的 `feed` 记录**每一次真正发给 agent 的内容块**——
 * 它是从假 agent 回显的 `user/message` 通知上读的，
 * 也就是**真实过了 stdio 的那些字节**，不是我们以为发了什么。
 *
 * `saying()` 走的是**和真服务一样的顺序**：先 `say()` 落盘 `user/echo`，
 * 再 `deliver()` 投递。顺序反了的话，"排除现在这句"就无从验起。
 */
function setup({ store = null, scenario = 'normal', over = {} } = {}) {
  const st = store ?? new Store({ dataDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-recap-')), fsync: false });
  const timeline = new Timeline({ id: 'main', store: st });
  // ⚠️ `onEvict` 必须和 `serve.js` 一样接上。它不只是"先收口再卸"——
  //    runtime 的 `dispose()` 会让 exit 事件失效（那是刻意的，免得
  //    用户看到一句莫名其妙的"我断了"），所以**淘汰这条路是这里通知的**。
  const runtime = new AgentRuntime({
    cfg: cfg(over),
    spawnFn: fakeSpawn(scenario),
    onEvict: (sessionId) => dispatcher.onEvict(sessionId),
  });
  const dispatcher = new Dispatcher({ timeline, runtime, store: st });
  const say = new SayService({ timeline, store: st, timelineId: 'main' });

  const feed = [];
  const wired = new Set();
  const original = runtime.agent.bind(runtime);
  runtime.agent = (id) => {
    const a = original(id);
    // ⚠️ **一个实例只挂一次**。`runtime.agent()` 现在每次投递都会被调到，
    //    不加这个判重就会挂出一串重复监听，于是同一条 `user/message`
    //    被数好几遍——测试会以为"喂了三次"。（这个坑我自己先踩了一遍。）
    if (!wired.has(a)) {
      wired.add(a);
      a.on('session-event', (params) => {
        const ev = params?.event ?? params;
        if (ev?.type === 'user/message') feed.push(ev.data?.content ?? []);
      });
    }
    return a;
  };

  /** 和 `server.js` 的 `handleSay` 同序：先落盘，再投递。 */
  const saying = async (text, messageId) => {
    const r = say.say({ messageId, text });
    if (r.duplicate) return r;
    await dispatcher.deliver(text, { messageId });
    return r;
  };

  return { store: st, timeline, runtime, dispatcher, say, feed, saying };
}

test('🔴 同一个 agent 实例：**背景只喂一次**，后面只喂主人那句', async () => {
  const s = setup();
  try {
    await s.saying('第一句', 'u_1');
    await wait(400);
    await s.saying('第二句', 'u_2');
    await wait(400);

    assert.equal(s.feed.length, 2, '两次投递');
    assert.equal(s.feed[0].length, 1, '第一次说：日志里还没有背景 ⇒ 只喂主人那句');
    assert.equal(s.feed[0][0].text, '第一句');
    assert.equal(s.feed[1].length, 1, '★ 第二次**不许**再喂背景 —— 这个进程自己记得');
    assert.equal(s.feed[1][0].text, '第二句');
  } finally {
    await s.dispatcher.shutdown();
    await s.runtime.shutdown();
  }
});

test('🔴 跨重启：新实例的第一句要带上背景，而且背景**单独一块**', async () => {
  const store = new Store({
    dataDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-recap-')),
    fsync: false,
  });

  // 第一个进程：说一句、它答一句
  const first = setup({ store });
  await first.saying('用一句话告诉我今天是星期几', 'u_1');
  await wait(400);
  await first.dispatcher.shutdown();
  await first.runtime.shutdown();

  // 日志里现在应该有：用户那句 + 它那句（这是"重启也还在"的东西）
  const logged = store.readAll('main');
  assert.ok(logged.some((e) => e.type === 'user/echo'), '用户那句落了盘');
  assert.ok(logged.some((e) => e.type === 'message/end'), '它那句也落了盘');

  // 第二个进程（= 服务重启）：同一个日志，全新的 agent
  const second = setup({ store });
  try {
    await second.saying('我刚才问你什么了？', 'u_2');
    await wait(400);

    assert.equal(second.feed.length, 1);
    assert.equal(second.feed[0].length, 2, '★ 两块：先是背景，再是主人现在这句');
    const [recap, now] = second.feed[0];
    assert.match(recap.text, /【背景】/, '第一块是背景');
    assert.match(recap.text, /主人：用一句话告诉我今天是星期几/, '背景里有主人上一句');
    assert.match(recap.text, /你：/, '背景里有它自己上一句');
    assert.equal(now.text, '我刚才问你什么了？', '第二块才是主人现在这句');
    assert.ok(
      !recap.text.includes('我刚才问你什么了？'),
      '★ 现在这句**不许**同时出现在背景里（那会重复）',
    );
    assert.notEqual(second.dispatcher.lastRecap, null, '喂过什么要能查得到');
  } finally {
    await second.dispatcher.shutdown();
    await second.runtime.shutdown();
  }
});

test('🔴 被淘汰 / 进程死掉之后重起：新实例要**重新**喂背景', async () => {
  const store = new Store({
    dataDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-recap-')),
    fsync: false,
  });
  // maxProcesses=0 ⇒ 一个都不许留，这样一调 evictIfNeeded 就走真的淘汰路径
  // （含"先收口再卸"的那个回调），不是我自己假装把它踢掉。
  const s = setup({ store, over: { agentMaxProcesses: 0 } });

  try {
    await s.saying('第一句', 'u_1');
    await wait(400);
    assert.equal(s.feed.length, 1);
    assert.equal(s.feed[0].length, 1, '第一句没有背景可喂');

    const evicted = await s.runtime.evictIfNeeded();
    assert.deepEqual(evicted, ['main'], '走的是真的淘汰路径');
    await wait(200);

    await s.saying('第二句', 'u_2');
    await wait(400);

    assert.equal(s.feed.length, 2);
    assert.equal(s.feed[1].length, 2, '★ 新实例什么都不记得 ⇒ 必须重新喂背景');
    assert.match(s.feed[1][0].text, /第一句/);
    assert.equal(s.feed[1][1].text, '第二句');
  } finally {
    await s.dispatcher.shutdown();
    await s.runtime.shutdown();
  }
});

test('recap：Dispatcher **拒绝**在没有 store 的情况下开工（否则失忆是静默的）', () => {
  const store = new Store({
    dataDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-recap-')),
    fsync: false,
  });
  const timeline = new Timeline({ id: 'main', store });
  const runtime = new AgentRuntime({ cfg: cfg(), spawnFn: fakeSpawn('normal') });
  assert.throws(
    () => new Dispatcher({ timeline, runtime }),
    /需要 store/,
    '没有 store ⇒ 每次重启都失忆，而那种故障看起来只是"它有点笨"',
  );
});
