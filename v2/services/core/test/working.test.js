// **"正在干活的那几间"**（主人 2026-10-06：*「我觉得应该在左下角有一个清单按钮，
//   点击会出来浮窗，浮窗里有正在干活的聊天的列表。」*）· 契约 `docs/dev/198-WORK-LIST.md`。
//
// ── 这一份钉什么（一句话）──────────────────────────────────
// ① `/api/working` 回的**就是桌面上那一格"在做"读的同一本逐件活账**（`world.work.live()`）
//    —— 两处不许给出两个答案；
// ② 一间的**几件活算一行**（`count`），`since` 取最早那一件；先干的先列；
// ③ 🔴 **拿不到活账 ⇒ 空清单**（宁可空着，也不许编一间"在干活"出来）；
// ④ 🔴 `title` **只从他自己那份小程序库**里取，认不出就是 `null`
//    —— **绝不把 scope 那串内部 id 当名字发给屏幕**。
//
// ⚠️ 形状照 `test/app-working.test.js`：**真 `Worlds`** ＋ **真 HTTP**，
//    活账那一条**真开真收**，不 mock 业务。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test, { after } from 'node:test';

import { AgentRuntime } from '../src/agent-runtime.js';
import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { Worlds } from '../src/worlds.js';
import { WORK_STATES } from '../src/worklog.js';

const NOW = 1_800_000_000_000;
const open = new Set();
after(async () => {
  for (const close of open) {
    try {
      await close();
    } catch {
      /* 关不干净不影响结论 */
    }
  }
  open.clear();
});
function guard(fn) {
  const g = async () => {
    open.delete(g);
    await fn();
  };
  open.add(g);
  return g;
}

const tmp = (tag = 'hupo-198-') => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), tag));

function cfgFor(dataDir, tag) {
  return {
    dataDir,
    dshHome: nodePath.join(dataDir, `__${tag}_dsh__`),
    agentCwd: nodePath.join(dataDir, `__${tag}_cwd__`),
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

async function bootWorlds(t, { tag = 'host', dataDir = tmp() } = {}) {
  const cfg = cfgFor(dataDir, tag);
  nodeFs.mkdirSync(cfg.dshHome, { recursive: true });
  nodeFs.mkdirSync(cfg.agentCwd, { recursive: true });
  let worlds = null;
  const runtime = new AgentRuntime({
    cfg,
    cfgFor: (key) => worlds.cfgForAgentKey(key),
    onEvict: (id) => worlds.onEvict(id),
    spawnFn: () => {
      throw new Error('这一份判据不许起 agent');
    },
  });
  worlds = new Worlds({ cfg, runtime, log: () => {}, warn: () => {} });
  t.after(
    guard(async () => {
      await worlds.shutdownDispatchers();
      await runtime.shutdown();
      worlds.closeSockets();
    }),
  );
  return { dataDir, worlds };
}

async function bootServer(t, opts) {
  const auth = new Auth({ dataDir: tmp('hupo-198-auth-'), now: () => NOW });
  auth.setPassword('这一份判据只用令牌');
  const s = createServer({
    apps: { base: 'http://127.0.0.1:9', key: Buffer.from('d'.repeat(64), 'hex') },
    now: () => NOW,
    webRoot: null,
    log: () => {},
    ...opts,
    auth,
  });
  t.after(guard(s.close));
  return { ...s, auth };
}

const workingOf = async (origin, token) => {
  const r = await fetch(`${origin}/api/working`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json() };
};

const postCreate = (origin, token, body) =>
  fetch(`${origin}/api/app-create`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// ════════════════════════════════════════════════════════════
// W1 —— 没活在干 ⇒ 空清单；开一件 ⇒ 一行；收口 ⇒ 又空了
// ════════════════════════════════════════════════════════════
test('W1 🔴 清单与活账同一本：没活 ⇒ 空 · 开一件 ⇒ 一行 · 收口 ⇒ 空', async (t) => {
  const { worlds } = await bootWorlds(t);
  const srv = await bootServer(t, { worlds });
  const addr = await srv.listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = srv.auth.issue({ sub: 'owner' }).token;

  const a = await (await postCreate(origin, token, { title: '甲本' })).json();
  assert.ok(a.id, '要先有一个小程序当那一间');

  const none = await workingOf(origin, token);
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.working, [], '★ 一格都没在干活 ⇒ 空清单（不是"编一间出来"）');

  const w = worlds.worldFor('owner');
  w.work.declare({ scopeId: a.id, ref: 'r-1' });
  const one = await workingOf(origin, token);
  assert.equal(one.body.working.length, 1);
  assert.equal(one.body.working[0].scope, a.id, '★ 哪一间要如实说（客户端拿它去切房间）');
  assert.equal(one.body.working[0].title, '甲本', '★ 名字从他自己那份小程序库里取');
  assert.equal(one.body.working[0].count, 1);
  assert.equal(typeof one.body.working[0].since, 'number', '★ 开始时刻要带上（界面上说"多久了"）');

  // 收口 ⇒ 立刻不在清单里（**不是"做过就算"**）
  w.work.closeByRef({ scopeId: a.id, ref: 'r-1', outcome: WORK_STATES.done });
  const after1 = await workingOf(origin, token);
  assert.deepEqual(after1.body.working, [], '★ 收口了 ⇒ 立刻从清单里下去');
});

// ════════════════════════════════════════════════════════════
// W2 —— 一间的几件活算一行；两间按"先干的先列"
// ════════════════════════════════════════════════════════════
test('W2 🔴 一间几件算一行（count）· since 取**最早**那件 · 先干的先列（清单不许自己跳）', async (t) => {
  // ⚠️ 活账那个钟是它自己的（`WorkLog` 默认 `Date.now`，这一层注入不进去）⇒ 这一条
  //    **自己把三件活拉开时间**开，然后用"它自己回的那两个 `since`"验次序 ——
  //    不去猜"现在几点"，也不许靠"两件活碰巧落在同一毫秒"。
  //    🔴 开活的次序**故意造成能分辨的那个形状**：
  //      甲第一件（t0）→ 乙（t1）→ **甲第二件（t2）**
  //      ⇒ `since(甲) = t0` 必须**早于** `since(乙) = t1`（若拿的是"最近那件"，甲会排到乙后面）。
  const { worlds } = await bootWorlds(t);
  const srv = await bootServer(t, { worlds });
  const addr = await srv.listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = srv.auth.issue({ sub: 'owner' }).token;

  const a = await (await postCreate(origin, token, { title: '甲本' })).json();
  const b = await (await postCreate(origin, token, { title: '乙本' })).json();
  const w = worlds.worldFor('owner');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  w.work.declare({ scopeId: a.id, ref: 'r-a1' });
  await sleep(10);
  w.work.declare({ scopeId: b.id, ref: 'r-b1' });
  await sleep(10);
  w.work.declare({ scopeId: a.id, ref: 'r-a2' });

  const got = await workingOf(origin, token);
  const byId = new Map(got.body.working.map((x) => [x.scope, x]));
  assert.equal(got.body.working.length, 2, '★ 甲那间两件活 ⇒ **还是两行**（一间一行）');
  assert.equal(byId.get(a.id).count, 2, '★ 两件活要如实报 2（不是只报"有活"）');
  assert.equal(byId.get(b.id).count, 1);
  assert.equal(byId.get(b.id).title, '乙本');
  assert.equal(typeof byId.get(a.id).since, 'number', '★ 开始时刻要带上');
  assert.ok(
    byId.get(a.id).since < byId.get(b.id).since,
    '★ 一间里的 `since` 要取**最早**那件（甲第二件比乙晚开 ⇒ 不许把甲排到乙后面）',
  );
  assert.deepEqual(
    got.body.working.map((x) => x.scope),
    [a.id, b.id],
    '★ 先干的先列',
  );
  // 🔴 清单**不许自己跳**：连着问两次，顺序与内容一模一样
  const again = await workingOf(origin, token);
  assert.deepEqual(
    again.body.working.map((x) => x.scope),
    got.body.working.map((x) => x.scope),
    '★ 两次问出来的次序必须一样（中间没有任何事变过）',
  );
});

// ════════════════════════════════════════════════════════════
// W3 —— 🔴 名字认不出 ⇒ `title: null`（**绝不把内部 id 当名字发上去**）
// ════════════════════════════════════════════════════════════
test('W3 🔴 认不出那一间的小程序 ⇒ `title` 是 `null`，不是那串内部 id', async (t) => {
  const { worlds } = await bootWorlds(t);
  const srv = await bootServer(t, { worlds });
  const addr = await srv.listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = srv.auth.issue({ sub: 'owner' }).token;

  const w = worlds.worldFor('owner');
  w.work.declare({ scopeId: 'not-an-app', ref: 'r-x' });
  const got = await workingOf(origin, token);
  assert.equal(got.body.working.length, 1);
  assert.equal(got.body.working[0].scope, 'not-an-app');
  assert.equal(got.body.working[0].title, null, '★ 认不出就说认不出 —— 界面那边会退回一个通用说法');
});

// ════════════════════════════════════════════════════════════
// W4 —— 🔴 没接上活账（老部署 / 老测试替身）⇒ **空清单**，不是 500、也不是编一间
// ════════════════════════════════════════════════════════════
test('W4 🔴 没接上活账 ⇒ 空清单（宁可空着，也不许编一间"在干活"）', async (t) => {
  const srv = await bootServer(t, { worlds: null });
  const addr = await srv.listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = srv.auth.issue({ sub: 'owner' }).token;
  const got = await workingOf(origin, token);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.working, []);
});

// ════════════════════════════════════════════════════════════
// W5 —— 没令牌 ⇒ 401（这一条是"另开一条口"时必须自己带上的那一句）
// ════════════════════════════════════════════════════════════
test('W5 没令牌 ⇒ 401（不许裸着开一条口）', async (t) => {
  const { worlds } = await bootWorlds(t);
  const srv = await bootServer(t, { worlds });
  const addr = await srv.listen(0);
  const r = await fetch(`http://127.0.0.1:${addr.port}/api/working`);
  assert.equal(r.status, 401);
});
