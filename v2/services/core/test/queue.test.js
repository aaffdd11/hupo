// **117 · 排队看得见、撤得掉**（契约 `docs/dev/117-QUEUE-VISIBLE.md`）。
//
// ── 这一份钉什么 ─────────────────────────────────────────────
//
// 主人 2026-09-26：*"首先全部开放，聊天窗口的设计也要重做。"*
// 研究（`115` §一.5 · `115-raw/B-render.md` §3.3）里 DSH 的形状是 **QueueDock**：
// 运行中再发一句 ⇒ 它进队列、**在屏幕上看得见**、而且**撤得掉**。
// 我们这一侧**早就排队了**（`dispatcher.js` 的 `#delivered` 票）—— 屏幕上却一个字都没有。
//
// 这一份把那一帧（`queue/changed`，瞬态、按房间）与那一帧回程
// （客户端→服务端 `{"t":"unsay","messageId":"m_…"}`）逐条钉住：
//
//   **Q1** 形状：`{type:'queue/changed', items:[{messageId,text,at,truncated}], count}`，
//          带 `scopeId = 那一间`；**瞬态**（没有 `seq`、**盘上一个字都没有**）。
//   **Q2** 范围：只有**正开着那一间**的那条连接收得到（别的房间收不到）。
//   **Q3** 裁剪：`text` 是主人原话的**前缀**、最多 200 个字符；截了如实标 `truncated`。
//   **Q4** 次序：FIFO（最早投的那条在前）。
//   **Q5** 撤一句：**没被认领**的摘得掉；**已经被认领**（那一轮正用着）的撤不动，
//          而且**没有错误面**（不报错、不回一句编的话）——两种都回一份新快照。
//   **Q6** `client/hello` 那一刻**现发一份快照**（瞬态帧不重放 ⇒ 刷新/重连只能靠它）。
//   **Q7** 认不出的帧**安静忽略**（连接照旧活着）。
//
// ⚠️ 风格照仓库现有测试：真 `Worlds` ＋ 真 HTTP ＋ 真 spawn（假 agent），
//    每条都带**反例的正身**。用 `hang` 场景：第一轮开着不收口、**后面几句真的排队**
//    （`fake-agent.mjs`：`hang*` 场景下第 2 个及以后的 prompt 连 `turn/start` 都不发
//     —— 那正是"排队中"真实的样子）。

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
import { Worlds } from '../src/worlds.js';
import { snapshotWorkspace } from '../src/workspace.js';
import { QUEUE_TEXT_MAX } from '../src/queue.js';

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

function tmp(prefix = 'hupo-queue-') {
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
    // 这一轮**不许被超时收掉**：判据要的是"排队的还在排队"
    turnDeadlineMs: 60000,
  };
}

/** 起一套：真 `Worlds` + 真 HTTP + 真 spawn（假 agent，`hang`）。形状照 `focus.test.js`。 */
async function boot({ scenario = 'hang' } = {}) {
  const dataDir = tmp('hupo-queue-run-');
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

  const { listen, close } = createServer({ worlds, auth, buildId: 'queue-test' });
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
const post = (h, path, body, sub) =>
  fetch(`${h.origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor(h, sub)}` },
    body: JSON.stringify(body),
  });

async function waitFor(pred, why, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await sleep(20);
  }
  throw new Error(`等不到：${why}（等了 ${ms}ms）`);
}

/** 造一个 scope（工作区 ＋ 登记成 app）——照 `focus.test.js` 那条。 */
function makeScope(h, sub, id, title = id) {
  const w = h.worlds.worldFor(sub);
  w.workspaces.ensure(id, { title, entry: 'index.html' });
  w.workspaces.write(id, { 'index.html': `<!doctype html><p>${id}</p>` });
  snapshotWorkspace({ apps: w.apps, workspaces: w.workspaces, id, title, icon: 'dice' });
  return w;
}

/** 连一条流（**客户端**那一侧：真 `ws`，不是探针）。 */
function wsConnect(h, { sub = 'u1', scope = null } = {}) {
  const protocols = ['bearer', tokenFor(h, sub)];
  const qs = new URLSearchParams({ sinceSeq: '0' });
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

/** 某一间那一帧里的 items（只有它是那一间的；`scopeId` 主线可以不盖）。 */
const qItems = (frames, scope) =>
  frames.filter((f) => f?.type === 'queue/changed' && (f.scopeId ?? 'main') === scope);

/**
 * 等到那一间的排队**稳定成只有 [id]**（m1 已经被那一轮认领走了）。
 *
 * ⚠️ 必须等这一步：`/api/say` 的投递是**异步**的（`server.js` 不等 `deliver`）⇒
 *    "m1 认领"与"m2 进队"谁先谁后是不定的，中间那一帧可能两条都在。
 *    判据要的是**稳定之后**那份快照。
 */
async function waitQueued(c, scope, id, why = '排队稳定那条帧') {
  await waitFor(() => {
    const f = qItems(c.frames, scope).at(-1);
    return f && f.items.length === 1 && f.items[0].messageId === id;
  }, why);
}

const logEvents = (h) =>
  nodeFs
    .readFileSync(nodePath.join(h.worlds.worldFor('u1').dir, 'main.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

/** 那一句多久还没轮到它跑（判据用；`hang` 场景下 m1 一开轮就被认领了）。 */
async function queued(h, m1, m2, scope = 'alpha') {
  assert.equal(
    (await post(h, '/api/say', { messageId: m1, text: '先做这一件', scope }, 'u1')).status,
    200,
    '第一句要先收下（它会被那一轮认领）',
  );
  assert.equal(
    (await post(h, '/api/say', { messageId: m2, text: '这件事也做一下', scope }, 'u1')).status,
    200,
    '第二句是"排队"那一句',
  );
}

// ════════════════════════════════════════════════════════════
// Q1 · 形状 ＋ 瞬态（没有号、盘上一个字都没有）
// ════════════════════════════════════════════════════════════

test('🔴 Q1：排队那一帧的形状对，而且是**瞬态**（没有 seq、盘上 0 行）', async () => {
  const h = await boot();
  try {
    makeScope(h, 'u1', 'alpha');
    const c = await wsConnect(h, { scope: 'alpha' });
    await waitFor(() => c.frames.some((f) => f.type === 'client/hello'), '`client/hello` 没来');

    await queued(h, 'm1', 'm2');
    await waitQueued(c, 'alpha', 'm2');

    const frame = qItems(c.frames, 'alpha').at(-1);
    assert.equal(frame.type, 'queue/changed');
    assert.equal(frame.count, 1, '`count` 要等于 items 的数量');
    const item = frame.items[0];
    assert.deepEqual(Object.keys(item).sort(), ['at', 'messageId', 'text', 'truncated']);
    assert.equal(item.messageId, 'm2');
    assert.equal(item.text, '这件事也做一下', '🔴 text 必须是主人自己的原话（不摘要/不改写）');
    assert.equal(typeof item.at, 'number');
    assert.equal(item.truncated, false);

    // 🔴 瞬态：没有号 ⇒ 不是"盘上的事实"
    assert.equal('seq' in frame, false, '瞬态帧不许带 seq（带了就是进了那套号）');
    // 🔴 盘上 0 行（反例的正身：`emit` 一换就红）
    const persisted = logEvents(h).filter((e) => e.type === 'queue/changed');
    assert.equal(persisted.length, 0, `🔴 queue/changed 落盘了：${JSON.stringify(persisted)}`);
    c.ws.close();
  } finally {
    await h.close();
  }
});

// ════════════════════════════════════════════════════════════
// Q2 · 范围：只有正开着那一间的那条连接收得到
// ════════════════════════════════════════════════════════════

test('🔴 Q2：只有**正开着这一间**的那条连接收得到（别的房间一个字节都没有）', async () => {
  const h = await boot();
  try {
    makeScope(h, 'u1', 'alpha');
    makeScope(h, 'u1', 'beta');
    const a = await wsConnect(h, { scope: 'alpha' });
    await waitFor(() => a.frames.some((f) => f.type === 'client/hello'), 'alpha 的 hello 没来');
    await queued(h, 'm1', 'm2');
    await waitQueued(a, 'alpha', 'm2', 'alpha 没收到自己那一帧');

    // 第二条连接看着 **beta**：它不许看见 alpha 的排队
    const b = await wsConnect(h, { scope: 'beta' });
    await waitFor(() => b.frames.some((f) => f.type === 'client/hello'), 'beta 的 hello 没来');
    await sleep(150);
    assert.equal(
      b.frames.filter((f) => f.scopeId === 'alpha').length,
      0,
      '🔴 焦点在 beta，alpha 的排队却推过来了',
    );
    assert.equal(
      b.frames.some((f) => f.type === 'queue/changed' && f.items.some((i) => i.messageId === 'm2')),
      false,
      '🔴 别的房间的排队内容漏到了这一条连接上',
    );
    a.ws.close();
    b.ws.close();
  } finally {
    await h.close();
  }
});

// ════════════════════════════════════════════════════════════
// Q3 · 裁剪：原话的前缀，最多 200 字符，截了如实说
// ════════════════════════════════════════════════════════════

test('🔴 Q3：text 裁到 200 个字符、是**原话的前缀**，截了标 truncated', async () => {
  const h = await boot();
  try {
    makeScope(h, 'u1', 'alpha');
    const c = await wsConnect(h, { scope: 'alpha' });
    await waitFor(() => c.frames.some((f) => f.type === 'client/hello'), 'hello 没来');

    const long = '甲'.repeat(250);
    const exact = '乙'.repeat(QUEUE_TEXT_MAX);
    assert.equal((await post(h, '/api/say', { messageId: 'm1', text: '先做这一件', scope: 'alpha' }, 'u1')).status, 200);
    assert.equal((await post(h, '/api/say', { messageId: 'long', text: long, scope: 'alpha' }, 'u1')).status, 200);
    assert.equal((await post(h, '/api/say', { messageId: 'exact', text: exact, scope: 'alpha' }, 'u1')).status, 200);

    await waitFor(() => {
      const f = qItems(c.frames, 'alpha').at(-1);
      return f?.items?.length === 2;
    }, '两条排队那条帧没来');

    const items = qItems(c.frames, 'alpha').at(-1).items;
    const byId = new Map(items.map((i) => [i.messageId, i]));

    const clip = byId.get('long');
    assert.ok(clip, '长的那一条不在 items 里');
    assert.equal(Array.from(clip.text).length, QUEUE_TEXT_MAX, '🔴 裁到 200 个字符');
    assert.equal(clip.text, long.slice(0, QUEUE_TEXT_MAX), '🔴 裁出来的必须是**原话的前缀**（不摘要/不改写）');
    assert.equal(clip.truncated, true, '🔴 截了就要说');

    const noClip = byId.get('exact');
    assert.ok(noClip, '正好 200 的那一条不在 items 里');
    assert.equal(noClip.text, exact, '没超上限的不许动');
    assert.equal(noClip.truncated, false, '没截就不许标截断');
    c.ws.close();
  } finally {
    await h.close();
  }
});

// ════════════════════════════════════════════════════════════
// Q4 · FIFO
// ════════════════════════════════════════════════════════════

test('🔴 Q4：items 是 FIFO（最早投的那条在前）', async () => {
  const h = await boot();
  try {
    makeScope(h, 'u1', 'alpha');
    const c = await wsConnect(h, { scope: 'alpha' });
    await waitFor(() => c.frames.some((f) => f.type === 'client/hello'), 'hello 没来');

    for (const [id, text] of [['m1', '第一件'], ['m2', '第二件'], ['m3', '第三件']]) {
      assert.equal((await post(h, '/api/say', { messageId: id, text, scope: 'alpha' }, 'u1')).status, 200);
    }
    await waitFor(() => {
      const f = qItems(c.frames, 'alpha').at(-1);
      return f?.items?.length === 2;
    }, '两条排队那条帧没来');

    const items = qItems(c.frames, 'alpha').at(-1).items;
    assert.deepEqual(
      items.map((i) => i.messageId),
      ['m2', 'm3'],
      '🔴 排队的次序必须是投的次序（m1 已经被那一轮认领走了）',
    );
    c.ws.close();
  } finally {
    await h.close();
  }
});

// ════════════════════════════════════════════════════════════
// Q5 · 撤一句：只撤没被认领的；认领过的撤不动而且没有错误面
// ════════════════════════════════════════════════════════════

test('🔴 Q5：撤得掉**还没被认领**的；**已经被那一轮认领**的撤不动、也没有错误面', async () => {
  const h = await boot();
  try {
    const w = makeScope(h, 'u1', 'alpha');
    const c = await wsConnect(h, { scope: 'alpha' });
    await waitFor(() => c.frames.some((f) => f.type === 'client/hello'), 'hello 没来');

    await queued(h, 'm1', 'm2');
    await waitQueued(c, 'alpha', 'm2');

    // ① 撤 **m1**（那一轮已经认领它了）⇒ 什么都不做，只回一份新快照（还是 m2）
    const n0 = c.frames.length;
    c.ws.send(JSON.stringify({ t: 'unsay', messageId: 'm1' }));
    await waitFor(() => {
      const f = qItems(c.frames, 'alpha').at(-1);
      return f?.items?.length === 1 && f.items[0].messageId === 'm2';
    }, '撤一句已经在跑的之后那份快照没来');
    const afterClaimed = qItems(c.frames, 'alpha').at(-1);
    assert.deepEqual(afterClaimed.items.map((i) => i.messageId), ['m2'], '🔴 已经在跑的那一句不许被撤掉');
    // 没有错误面：不许回一条"失败"的话（`error` / `job/answer-ack` 那类都不许冒出来）
    assert.equal(
      c.frames.slice(n0).filter((f) => f.type === 'error' || f.type === 'notice').length,
      0,
      '🔴 "那句已经在跑了"不是错误 —— 不许有一条报错',
    );

    // ② 撤 **m2**（还没被认领）⇒ 真摘掉，那一间自己回一份新快照（空了）
    c.ws.send(JSON.stringify({ t: 'unsay', messageId: 'm2' }));
    await waitFor(() => {
      const f = qItems(c.frames, 'alpha').at(-1);
      return f && f.items.length === 0;
    }, '撤掉 m2 之后那份空快照没来');
    assert.equal(w.dispatcher.queueItemsOf('alpha').count, 0, '🔴 队列里还留着 m2');
    // 负向对照：那一轮的票**没被误伤**（m1 已经认领走了，`pendingDeliveries` 本来就是 0）
    assert.equal(w.dispatcher.pendingDeliveries, 0);
    c.ws.close();
  } finally {
    await h.close();
  }
});

// ════════════════════════════════════════════════════════════
// Q6 · client/hello 那一刻现发一份快照
// ════════════════════════════════════════════════════════════

test('🔴 Q6：`client/hello` 那一刻**现发一份当前快照**（刷新/重连靠它重建）', async () => {
  const h = await boot();
  try {
    makeScope(h, 'u1', 'alpha');
    const a = await wsConnect(h, { scope: 'alpha' });
    await waitFor(() => a.frames.some((f) => f.type === 'client/hello'), 'alpha 的 hello 没来');
    await queued(h, 'm1', 'm2');
    await waitQueued(a, 'alpha', 'm2');

    // 新开一条连接（= 刷新 / 重连那一边）⇒ hello 之后必须有一份快照
    const b = await wsConnect(h, { scope: 'alpha' });
    await waitFor(() => b.frames.some((f) => f.type === 'client/hello'), '新连接的 hello 没来');
    await waitFor(() => qItems(b.frames, 'alpha').some((f) => f.items.some((i) => i.messageId === 'm2')),
      '🔴 hello 之后没给快照 ⇒ 刷新一下那条"还排着"就没了');

    // 次序：快照在 hello **之后**（hello = "补发到此为止"那条界）
    const helloAt = b.frames.findIndex((f) => f.type === 'client/hello');
    const snapAt = b.frames.findIndex((f) => f.type === 'queue/changed' && f.items.some((i) => i.messageId === 'm2'));
    assert.ok(snapAt > helloAt, `快照不许早于 hello（hello@${helloAt} · snap@${snapAt}）`);

    // 反例的正身：**空队也要给一份**（给的是"现在没有排队"，不是一个谜）
    makeScope(h, 'u1', 'beta');
    const e = await wsConnect(h, { scope: 'beta' });
    await waitFor(() => e.frames.some((f) => f.type === 'client/hello'), 'beta 的 hello 没来');
    await waitFor(() => qItems(e.frames, 'beta').length >= 1, '空队那一份快照没来');
    assert.deepEqual(qItems(e.frames, 'beta')[0].items, []);
    assert.equal(qItems(e.frames, 'beta')[0].count, 0);
    a.ws.close();
    b.ws.close();
    e.ws.close();
  } finally {
    await h.close();
  }
});

// ════════════════════════════════════════════════════════════
// Q7 · 认不出的帧：安静忽略，连接照旧
// ════════════════════════════════════════════════════════════

test('🔴 Q7：认不出的帧**安静忽略**（不踹连接、不回话），之后照常能撤', async () => {
  const h = await boot();
  try {
    makeScope(h, 'u1', 'alpha');
    const c = await wsConnect(h, { scope: 'alpha' });
    await waitFor(() => c.frames.some((f) => f.type === 'client/hello'), 'hello 没来');
    await queued(h, 'm1', 'm2');
    await waitQueued(c, 'alpha', 'm2');

    const n0 = c.frames.length;
    c.ws.send('这不是 JSON');
    c.ws.send(JSON.stringify({ t: 'nonsense', messageId: 'm2' }));
    c.ws.send(JSON.stringify({ t: 'unsay' })); // 没有 messageId ⇒ 认不出
    await sleep(200);
    assert.equal(c.frames.length, n0, '🔴 认不出的帧回话了（应该安静忽略）');
    assert.equal(c.ws.readyState, WebSocket.OPEN, '🔴 认不出的帧把连接踹了');

    // 正对照：这一条帧是认得出来的 —— 它必须还有效（证明上面那些"没反应"不是连接死了）
    c.ws.send(JSON.stringify({ t: 'unsay', messageId: 'm2' }));
    await waitFor(() => {
      const f = qItems(c.frames, 'alpha').at(-1);
      return f && f.items.length === 0;
    }, '正常那一帧没生效 ⇒ 上面那些"没反应"可能只是连接死了');
    c.ws.close();
  } finally {
    await h.close();
  }
});
