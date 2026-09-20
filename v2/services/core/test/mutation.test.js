// 「这一轮**动过东西没有**」。决策 **D10.1 / D10.2**（`05-DECISIONS.md` §二·补）。
//
// 为什么要它：**「续做」= 把主人的原话重新派一遍**，所以它会把已经做过的副作用
// 再做一遍。要安全，就必须能回答"这件事做过没有"——而这个仓库里**没有任何东西**
// 能回答它（工具结果不进时间线）。
// ⇒ 取法：**只自动续做"整轮只碰过只读工具"的活**，其余只通知。
//
// 这一层验三件事：
//   ① 白名单本身是对的（**默认拒绝**，`bash` 不在里面）
//   ② `tool/call` 到了翻译层之后，**会落一条盘**（重启之后才查得到）
//   ③ 落下来那条**不含工具名、不含参数** —— 它是会 replay 给客户端的

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { READ_ONLY_TOOLS, isReadOnlyTool } from '../src/tools.js';
import { AgentRuntime } from '../src/agent-runtime.js';
import { Dispatcher } from '../src/dispatcher.js';
import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';

const FAKE = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), 'fake-agent.mjs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 一、白名单 ──────────────────────────────────────────────

test('🔴 D10.2：白名单是**默认拒绝** —— 认不出来的一律算"会改东西"', () => {
  assert.equal(isReadOnlyTool('read'), true);
  assert.equal(isReadOnlyTool('web_search'), true);
  assert.equal(isReadOnlyTool('从来没见过的新工具'), false, '★ DSH 升级加了新工具 ⇒ 自动落到"会改"');
  assert.equal(isReadOnlyTool(''), false);
  assert.equal(isReadOnlyTool(null), false);
  assert.equal(isReadOnlyTool(undefined), false);
  assert.equal(isReadOnlyTool(42), false);
});

test('🔴 D10.2：**`bash` 不在白名单里** —— 一个 shell 能干任何事', () => {
  assert.ok(!READ_ONLY_TOOLS.includes('bash'));
  assert.equal(isReadOnlyTool('bash'), false);
  // 代价要先认：走了 bash（哪怕只是 ls）就只通知、不自动重来。
  // 这一条**故意**钉住，免得下一个人"顺手把 bash 加进去让续做更容易触发"。
});

test('写类工具一个都不在白名单里', () => {
  for (const t of ['write', 'edit', 'subagent', 'workflow', 'send_message', 'job_kill']) {
    assert.equal(isReadOnlyTool(t), false, `${t} 不该在只读白名单里`);
  }
});

test('白名单是**冻的数组**（不是 Set —— `Object.freeze` 冻不住 Set 的 add）', () => {
  assert.ok(Array.isArray(READ_ONLY_TOOLS));
  assert.throws(() => { READ_ONLY_TOOLS.push('bash'); }, TypeError);
});

// ── 二、真 spawn：`tool/call` → 落盘 ────────────────────────

const fakeSpawn = (scenario) => (bin, args, opts) =>
  realSpawn(process.execPath, [FAKE], { ...opts, env: { ...opts.env, FAKE_SCENARIO: scenario } });

function cfg() {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-mut-'));
  return {
    dshBin: 'unused', agentProfile: 'sdk', agentCwd: dir, dshHome: dir,
    agentProvider: 'fake', agentModel: 'fake', agentEffort: 'low', agentMaxTokens: 512,
    agentBootTimeoutMs: 20000, agentMaxProcesses: 4, agentIdleEvictMs: 60000, personaPath: null,
  };
}

async function setup(scenario) {
  const store = new Store({
    dataDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-mut-')),
    fsync: false,
  });
  const timeline = new Timeline({ id: 'main', store });
  const runtime = new AgentRuntime({ cfg: cfg(), spawnFn: fakeSpawn(scenario) });
  const dispatcher = new Dispatcher({ timeline, runtime, store });
  return { store, timeline, runtime, dispatcher };
}

test('🔴 用了会改东西的工具 ⇒ **落一条盘**，而且归属到主人那句话', async () => {
  const s = await setup('tool-write');
  try {
    await s.dispatcher.deliver('帮我把那个文件改一下', { messageId: 'u_42' });
    await wait(500);

    const evs = s.store.readAll('main');
    const marks = evs.filter((e) => e.type === 'task/mutated');
    assert.equal(marks.length, 1, '★ 必须**落盘** —— 重启之后只有盘上这份查得到');
    assert.equal(marks[0].ref, 'u_42', '★ 归属到主人那句话（产品事件里没有轮号）');
    assert.equal(typeof marks[0].seq, 'number', '它是持久事件（要对账就得活过重启）');
  } finally {
    await s.runtime.shutdown();
  }
});

test('只用只读工具 ⇒ **什么都不落**（不然"只读"就没有意义了）', async () => {
  const s = await setup('tool-read');
  try {
    await s.dispatcher.deliver('帮我查一下', { messageId: 'u_7' });
    await wait(500);
    assert.equal(s.store.readAll('main').filter((e) => e.type === 'task/mutated').length, 0);
  } finally {
    await s.runtime.shutdown();
  }
});

test('🔴 落下来那一条**不含工具名、不含参数**（它会 replay 给客户端）', async () => {
  const s = await setup('tool-write');
  try {
    await s.dispatcher.deliver('改一下', { messageId: 'u_1' });
    await wait(500);
    const line = JSON.stringify(s.store.readAll('main').find((e) => e.type === 'task/mutated'));
    for (const leak of ['write', 'edit', 'bash', 'arguments', 'tool', 'callId']) {
      assert.ok(!line.includes(leak), `那条记录里漏了内部词「${leak}」：${line}`);
    }
  } finally {
    await s.runtime.shutdown();
  }
});

test('一轮里调了好几次 ⇒ 只记一次（判据是"有没有"，不是"几次"）', async () => {
  const s = await setup('tool-write');
  try {
    // 假 agent 每次 prompt 只发一次 tool/call；这里用两次投递验证"每轮一条"
    await s.dispatcher.deliver('第一件', { messageId: 'u_1' });
    await wait(400);
    await s.dispatcher.deliver('第二件', { messageId: 'u_2' });
    await wait(400);
    const marks = s.store.readAll('main').filter((e) => e.type === 'task/mutated');
    assert.deepEqual(marks.map((m) => m.ref), ['u_1', 'u_2'], '两轮各一条，不是一轮两条');
  } finally {
    await s.runtime.shutdown();
  }
});
