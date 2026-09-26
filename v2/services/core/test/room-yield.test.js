// **B46：那一间正被开发者入口开着时，产品里的聊天要答得上**
// （2026-09-26 主人原话："我在小程序里说话，他回复我现在接不上话。"）。
//
// ── 根因（真机读数 · u2 的盒子 · 产品层 `af752e466843`）────────────
//   开发者入口把 `aoshu-bank` 那一间开着（`dsh --profile web` 活着）时，
//   从聊天那条路往**同一间**说一句 ⇒ 那一轮答不上。原话：
//       session "owner/aoshu-bank.muh709vsibnh.1" is already owned by an active write handle
//   ⇒ DSH 的持久化层对每条会话有一把**写租约**（`session.lock`，flock），
//     第二个进程直接被拒。⚠️ 与内存无关（`oom_kill` 0）。
//
// ── 这一份钉什么（每条都能**反着验**；变异读数写进报告）────────────
//   **L1** 那一间正被入口开着 ⇒ 起那一轮之前**先收掉那台**（点名的就是那一间）；
//          · 变异：不收 ⇒ 这一条红
//   **L3** 宿主侧（没有那台中继）⇒ **什么都不做**（照旧答得上）；
//          · 变异：不守卫（抛 / 调空对象）⇒ 红
//   **L4** 写租约那一档 ⇒ 用户看到的是那条**能指路**的人话
//          （真 stdio ＋ 假 agent 回一条带 `already owned by an active write handle` 的 error 帧）；
//          · 变异：回旧那句"我接不上活" ⇒ 红
//   **L5** **别的失败**照旧走原来那句（两档不许混成一个）；
//          · 变异：全都走新那句 ⇒ 红
//
// ⚠️ L2（入口开着**别的**房间 ⇒ 一个手指头都不许碰那条守卫）在 `dev-mode.test.js`
//    （它打的是**真那个中继**；这一份打的是"接线"那一层）。
//
// ── 形状 ───────────────────────────────────────────────────
// **真 `Worlds` ＋ 真 `Dispatcher` ＋ 真 spawn（`fake-agent.mjs`）＋ 真 stdio**：
//   · L1/L3：注入一个**假 devContainer**（只记"谁被点名了"）；
//   · L4/L5：不注入（宿主侧那条路），由假 agent 回**真那一帧** error。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentRuntime } from '../src/agent-runtime.js';
import { OWNER_ID } from '../src/tenants.js';
import { Worlds } from '../src/worlds.js';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const FAKE = nodePath.join(HERE, 'fake-agent.mjs');

const tmpDirs = [];
const openRuntimes = new Set();

after(async () => {
  for (const r of openRuntimes) {
    try {
      await r.shutdown();
    } catch {
      /* 关不干净不影响结论 */
    }
  }
  openRuntimes.clear();
  for (const d of tmpDirs) {
    try {
      nodeFs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 尽力 */
    }
  }
});

function tmp(prefix = 'hupo-yield-') {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function cfgFor(dataDir) {
  return {
    dataDir,
    dshHome: nodePath.join(dataDir, '__dsh__'),
    agentCwd: nodePath.join(dataDir, '__cwd__'),
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
    // ⚠️ `Worlds` 建那条本地通道要它（少了它 `worldFor()` 当场抛 `LedgerError`）
    ledgerSocketPath: nodePath.join(dataDir, 'ledger.sock'),
  };
}

/** 一条气泡（`message/start … text* … end`）；形状同 `deliver-failed.test.js`。 */
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

/**
 * 起一套**真**的：`Worlds` ＋ 真 spawn 假 agent。
 * @param {object} [o]
 * @param {string} [o.scenario]       假 agent 跑哪个场景
 * @param {object|null} [o.devContainer] 注入的开发者中继（`null` = 宿主侧）
 */
async function boot({ scenario = 'normal', devContainer = null } = {}) {
  const dataDir = tmp();
  const cfg = cfgFor(dataDir);
  nodeFs.mkdirSync(cfg.dshHome, { recursive: true });
  nodeFs.mkdirSync(cfg.agentCwd, { recursive: true });

  const spawned = [];
  let worlds = null;
  const runtime = new AgentRuntime({
    cfg,
    cfgFor: (key) => worlds.cfgForAgentKey(key),
    onEvict: (id) => worlds.onEvict(id),
    spawnFn: (bin, args, opts) => {
      const c = realSpawn(process.execPath, [FAKE], {
        ...opts,
        env: { ...opts.env, FAKE_SCENARIO: scenario },
      });
      spawned.push(c);
      return c;
    },
  });
  openRuntimes.add(runtime);
  worlds = new Worlds({ cfg, runtime, log: () => {}, warn: () => {}, devContainer });
  const w = worlds.worldFor(OWNER_ID);
  return { dataDir, cfg, worlds, runtime, w, spawned };
}

async function close(h) {
  try {
    await h.worlds.shutdownDispatchers();
  } catch {
    /* 尽力 */
  }
  try {
    h.worlds.closeSockets();
  } catch {
    /* 尽力 */
  }
  try {
    await h.runtime.shutdown();
  } catch {
    /* 尽力 */
  }
  openRuntimes.delete(h.runtime);
}

// ════════════════════════════════════════════════════════════
// L1 —— 那一间正被入口开着 ⇒ 起那一轮之前先收掉（点名是那一间）
// ════════════════════════════════════════════════════════════

test('🔴 L1：入口正开着那一间 ⇒ 起那一轮**之前**收掉那台，而且点名是那一间', async () => {
  const asked = [];
  let spawnedWhenAsked = null;
  const fake = {
    async yieldRoom(scope) {
      asked.push(scope);
      spawnedWhenAsked = h.spawned.length; // ← 断言"收台发生在起 agent 之前"
      return { held: true, room: scope, pid: 4242, dropped: true };
    },
  };
  const h = await boot({ devContainer: fake });
  try {
    // 这一间挂上来（内置那三个之一：桌面图标本来就在）
    h.worlds.roomFor(OWNER_ID, 'discover');
    const s = h.w.dispatcher.sessionFor('discover');
    assert.ok(s, '发现那一间的会话要真的挂上来了');

    const r = await s.deliver('这一间你正开着吗', { messageId: 'u_1' });

    // ★ ① 让开之后这一轮**真的投出去**（不是"让开了但还是答不上"）
    assert.equal(r.delivered, true, `让开之后这一轮要成功：${r.error ?? ''}`);
    // ★ ② **点名是那一间**，而且只问一次
    assert.deepEqual(asked, ['discover'], '★ 问的就是要说话的那一间（而且只问一次）');
    // ★ ③ 顺序：问 / 收台发生在**起 agent 之前**（这就是"起那一轮之前"）
    assert.equal(spawnedWhenAsked, 0, '★ 收台必须发生在起那一轮之前（那一刻 agent 一台都没起）');
    // ★ 变异（写在注释里，报告里记读数）：把 `#yieldEntryForTalk()` 那一行删掉
    //    ⇒ `asked` 为空 ⇒ 这一条当场红；把它挪到 `#ensureAgent()` 之后 ⇒ ③ 红。
  } finally {
    await close(h);
  }
});

// ════════════════════════════════════════════════════════════
// L3 —— 宿主侧（没有那台中继）⇒ 什么都不做，也不许抛
// ════════════════════════════════════════════════════════════

test('🔴 L3：宿主侧（没有 `devContainer`）⇒ **什么都不做**（聊天照旧；变异：抛 / 调空对象 ⇒ 红）', async () => {
  // `null` = 根本没有那台中继；`{}` = 有对象但**没有那个动作**（认不出来）
  // ⇒ 两种都必须走得通（不守卫的写法两种都会抛 ⇒ 投递失败 ⇒ 这一条红）。
  for (const devContainer of [null, {}]) {
    const h = await boot({ devContainer });
    try {
      const r = await h.w.dispatcher.deliver('你好', { messageId: 'u_1' });
      assert.equal(
        r.delivered,
        true,
        `没有入口那台时聊天必须照旧（devContainer=${JSON.stringify(devContainer)}）：${r.error ?? ''}`,
      );
    } finally {
      await close(h);
    }
  }
});

// ════════════════════════════════════════════════════════════
// L4 —— 写租约那一档 ⇒ 那条能指路的人话
// ════════════════════════════════════════════════════════════

/** `forbidden_words_test.dart` 那张表（一个内部词都不许上屏）。 */
const FORBIDDEN = [
  '工作区', '口令', '暗号', '客户端', '云端', '服务器', '调度器', '时间线', '作用域',
  '会话', '工具', '搜索', '上下文', '系统提示', '模型',
  'web_search', 'web_fetch', 'tool-fs', 'bash', 'subagent',
  '正在听', '第 1 个', '第 2 个', '序号',
];

test('🔴 L4：写租约那一档 ⇒ 用户看到的是那条"你正开着"的人话（真 stdio ＋ 真 error 帧）', async () => {
  const h = await boot({ scenario: 'lease-owned' });
  try {
    const messageId = 'u_1';
    // 真那条路是 `/api/say` **先落盘**再投递 —— 这里照做
    h.w.say.say({ messageId, text: '怎么题库还是没有？' });
    const r = await h.w.dispatcher.deliver('怎么题库还是没有？', { messageId });

    // ① 投递如实失败，**对端原话留着**（排障第一眼要看的就是它）
    assert.equal(r.delivered, false, '写租约那一轮本来就投不出去（这一档是**兜底**）');
    assert.match(
      String(r.error ?? ''),
      /already owned by an active write handle/u,
      '★ 对端那条原话要留住',
    );

    // ② 盘上那条给用户的话 = **能指路**的那句
    const b = bubbles(h.w.store);
    assert.equal(b.length, 1, '必须有一条落盘的气泡（用户看得见）');
    assert.equal(b[0].agent, 'agent', '是**它**说的，不是把主人的话改了');
    assert.match(b[0].text, /你正开着/u, `★ 用户看到的是那条能指路的人话：${b[0].text}`);
    assert.ok(
      !b[0].text.includes('接不上活'),
      `★ 不许还是原来那句含糊的：${b[0].text}`,
    );
    // ③ 一个内部词都不许有（同 `forbidden_words_test.dart` 那张表）
    for (const word of FORBIDDEN) {
      assert.ok(!b[0].text.includes(word), `★ 人话里不许出现内部词「${word}」：${b[0].text}`);
    }
    // ★ 变异：把这一档换回 `AGENT_UNAVAILABLE_LINE` ⇒ ② 里那两条当场红。
  } finally {
    await close(h);
  }
});

// ════════════════════════════════════════════════════════════
// L5 —— 别的失败照旧走原来那句（两档不许混成一个）
// ════════════════════════════════════════════════════════════

test('🔴 L5：**别的**失败照旧走原来那句（变异：全都走新那句 ⇒ 红）', async () => {
  const h = await boot({ scenario: 'prompt-reject' }); // id 形状不认 —— 与写租约**无关**
  try {
    const messageId = 'u_1';
    h.w.say.say({ messageId, text: '这件事你帮我办一下' });
    const r = await h.w.dispatcher.deliver('这件事你帮我办一下', { messageId });
    assert.equal(r.delivered, false);
    assert.match(String(r.error ?? ''), /形状不认/u, '对端原话要留住');

    const b = bubbles(h.w.store);
    assert.equal(b.length, 1);
    assert.match(b[0].text, /接不上活/u, `★ 别的失败照旧走原来那句：${b[0].text}`);
    assert.ok(
      !b[0].text.includes('你正开着'),
      `★ 不许把"别的失败"也说成"你正开着"（两档混一个 ⇒ 用户分不清）：${b[0].text}`,
    );
    // ★ 变异：`isWriteLeaseError()` 改成恒 `true` ⇒ 上面这条当场红。
  } finally {
    await close(h);
  }
});
