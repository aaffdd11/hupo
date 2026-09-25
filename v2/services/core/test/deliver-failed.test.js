// **投递失败必须给用户一条看得见的话**（判据 T3 · 契约 110 · 2026-09-26 真机事故的 B 半）。
//
// ── 这一份钉什么 ─────────────────────────────────────────────
//
// 真机读数（产品层发布之后）：`session/prompt` 被拒（服务端回 error 帧：
// `sessionId 形状不认…`）⇒ **用户那一句永远没有答复**、调度器**不写收口**、
// 那一轮在盘上像没发生过（`/api/say` 200，之后**五分钟里一个新事件都没有**）。
//
// 根因（B 半）：`session/prompt` 被拒时 DSH **一轮都没开**（`turn/start` 永远不来）
// ⇒ 原来的 `forceClose` 收的是 `#turns` 里**已经开过的轮**，收了 **0** 轮
// ⇒ 一个字都没写；而那条瞬态 `error` 客户端今天**不渲染** ⇒ 用户什么都看不到。
//
// ⇒ 这一份走**真 spawn、真 stdio、真协议**（`test/fake-agent.mjs` 的
//   `prompt-reject` 场景），打两件：
//   ① **客户端不挂**：deliver 如实回 `delivered:false` ＋ 原话进 `lastError`；
//   ② **盘上有一条给用户的收口**（`message/end`，reason `failed`，人话、无内部词）。
//
// ⚠️ 变异（报告里记读数）：把 `deliveryFailed` 换回 `forceClose` ⇒ 这一条**必须红**
//    （真机就是这个形状：0 轮可收 ⇒ 盘上什么都没有）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentRuntime } from '../src/agent-runtime.js';
import { Dispatcher } from '../src/dispatcher.js';
import { SayService } from '../src/say.js';
import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';

const FAKE = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), 'fake-agent.mjs');

function cfg(dir) {
  return {
    dshBin: 'unused',
    agentProfile: 'sdk',
    agentCwd: dir,
    dshHome: dir,
    sessionMapPath: nodePath.join(dir, 'dsh-sessions.json'),
    agentProvider: 'fake',
    agentModel: 'fake',
    agentEffort: 'low',
    agentMaxTokens: 512,
    agentBootTimeoutMs: 20000,
    agentMaxProcesses: 4,
    agentIdleEvictMs: 60000,
    personaPath: null,
  };
}

/** 一条气泡（`message/start … text* … end`）。形状照 `deadline.test.js` 的 `bubbles`。 */
function bubbles(store) {
  const out = new Map();
  for (const e of store.readAll('main')) {
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

function setup({ scenario = 'prompt-reject' } = {}) {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-deliverfailed-'));
  const store = new Store({ dataDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-df-tl-')), fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const runtime = new AgentRuntime({
    cfg: cfg(dir),
    spawnFn: (bin, args, opts) =>
      realSpawn(process.execPath, [FAKE], { ...opts, env: { ...opts.env, FAKE_SCENARIO: scenario } }),
  });
  const dispatcher = new Dispatcher({ timeline, runtime, store, turnDeadlineMs: 5000 });
  const say = new SayService({ timeline, store, timelineId: 'main' });
  const s = { store, timeline, runtime, dispatcher, say };
  return s;
}

test('🔴 T3：`session/prompt` 被拒 ⇒ 客户端不挂，而且**盘上有一条给用户的收口**', async () => {
  const s = setup();
  try {
    const messageId = 'u_1';
    s.say.say({ messageId, text: '这件事你帮我办一下' });
    const r = await s.dispatcher.deliver('这件事你帮我办一下', { messageId });

    // ① **投递如实失败**（客户端没挂，错误原话留着）
    assert.equal(r.delivered, false, '★ 被拒的投递必须如实回 delivered:false');
    assert.match(String(r.error ?? ''), /形状不认/u, '★ 对端那条原话要留住（排障看它）');

    // ② **盘上有一条给用户的收口**（这就是真机缺的那一条）
    const b = bubbles(s.store);
    assert.equal(b.length, 1, '★ 必须有一条落盘的气泡（真机：一个字都没有）');
    assert.equal(b[0].reason, 'failed', '收尾理由记 failed');
    assert.equal(b[0].agent, 'agent', '收口的话是**它**说的，不是把主人的话改了');
    assert.match(b[0].text, /接不上活/u, '文案就是既有那句"我接不上活"');
    // N19 / 内部词那条：给用户看的话里不许出现内部词
    for (const word of ['工具', '会话', '连接', '服务', '超时', 'sessionId', 'session']) {
      assert.ok(!b[0].text.includes(word), `★ 人话里不许出现内部词「${word}」：${b[0].text}`);
    }

    // ③ **那一句用户说的话本身**也在盘上（它是 `/api/say` 先落的）
    assert.ok(
      s.store.readAll('main').some((e) => e.type === 'user/echo'),
      '主人那句照旧在盘上（投递失败不改历史）',
    );

    // ④ 队列不留欠条（那张票已经摘掉）
    assert.equal(s.dispatcher.pendingDeliveries, 0, '★ 投不出去的票不许留在队列里');
  } finally {
    await s.dispatcher.shutdown();
    await s.runtime.shutdown();
  }
});

test('🔴 T3·补：被拒之后这一间**照旧活着**（再投一次仍然能走到对端，不是一次就瘫）', async () => {
  // "客户端不挂"那一半：被拒一次不许把 dispatcher / runtime 弄死。
  const s = setup();
  try {
    s.say.say({ messageId: 'u_1', text: '第一句' });
    const first = await s.dispatcher.deliver('第一句', { messageId: 'u_1' });
    assert.equal(first.delivered, false);

    s.say.say({ messageId: 'u_2', text: '第二句' });
    const second = await s.dispatcher.deliver('第二句', { messageId: 'u_2' });
    assert.equal(second.delivered, false, '第二句照旧被拒（对端一直拒）——但**走到了对端**');
    assert.match(String(second.error ?? ''), /形状不认/u, '★ 原话照旧拿得到 ⇒ 这条路没被打坏');
    // 两条各自有一条收口（不是把第一条重复收一遍）
    assert.equal(bubbles(s.store).length, 2, '★ 每一句被拒的话都有自己的收口');
  } finally {
    await s.dispatcher.shutdown();
    await s.runtime.shutdown();
  }
});
