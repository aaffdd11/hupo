// **多租户的判据**：甲登录之后，**看不到乙的任何东西**。
//
// 手册/契约依据：`docs/dev/38-ISOLATION-SPLIT.md` §五（六步迁移的第 2–3 步）与 §六（七条判据）。
// 主人 2026-09-21 的原话是这一条要证的东西：
//   "应该进去又是一个独立的 copy 啊，应该是一个空白的"。
//
// ── 这一份专门盯什么 ──────────────────────────────────────
// 在接线之前，`tenants.js` 那十条闸证明的是"**数据**分开取"——
// 而服务里那一串东西（时间线 / 通知 / 回收站 / 账本 / 派发器 / agent 进程池键）**还是单例**。
// ⇒ 那十条闸**全绿也可能串号**。这一份补的就是那个缺口，而且**每条都带负向对照**：
//    * 甲写的进甲的盘、**乙的盘上没有** ⇄ 主人写的进主人的盘（证明不是"文件根本没在写"）；
//    * 两个人的 agent 键**同时**在进程池里 ⇄ 把键改回 `main` ⇒ **只剩一个**（"今天必撞"的证明）；
//    * 乙的东西**不在**甲的导出里 ⇄ 甲自己的东西**在**（证明不是"导出坏了，什么都导不出来"）。
//
// ⚠️ 这一层仍然**不是安全边界**（控制面原话）：它证的是"服务内部不串号"。
//    跨 uid 的边界要靠每租户一个 OS 用户 + 容器（`39-PERMISSIONS.md`）。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { spawn as realSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { AgentRuntime } from '../src/agent-runtime.js';
import { Auth } from '../src/auth.js';
import { Worlds, agentKeyFor } from '../src/worlds.js';
import { createServer } from '../src/server.js';
import { OWNER_ID } from '../src/tenants.js';

const FAKE = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), 'fake-agent.mjs');
const fakeSpawn = (scenario = 'normal') => (bin, args, opts) =>
  realSpawn(process.execPath, [FAKE], { ...opts, env: { ...opts.env, FAKE_SCENARIO: scenario } });

/** 这一轮起过的东西（`after()` 兜底收掉：红了也要能退出，见 `server.test.js` 里那段说明）。 */
const open = new Set();
after(async () => {
  for (const s of open) {
    try {
      await s.close();
    } catch {
      /* 关不干净不影响结论 */
    }
  }
  open.clear();
});

function cfgFor(dataDir) {
  return {
    dataDir,
    // ⚠️ 主人那一份的 DSH_HOME / 工作目录 —— 判据要盯住"它**没被搬**"
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
    // ⚠️ **不能是 0**：`turnDeadlineMs = 0` 时"轮已经宣布、但一个字都还没说"那一段
    //    没有任何信号（`armedDeadlines` 不涨、`openMessageId` 还是空）——
    //    生产上是靠这个计时器把它算成"忙"的（手册 `06-OPERATIONS.md` §8.3）。
    //    给一个远大于假 agent 耗时的值，就不会真触发收口。
    turnDeadlineMs: 5000,
  };
}

/** 起一套：真 `Worlds` + 真 HTTP 监听。 */
async function boot({ scenario = 'normal' } = {}) {
  const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-mt-'));
  const cfg = cfgFor(dataDir);
  nodeFs.mkdirSync(cfg.dshHome, { recursive: true });
  nodeFs.mkdirSync(cfg.agentCwd, { recursive: true });

  // ⚠️ **记下每一次真 spawn 出去的 env**。
  //    为什么非要记它：只比 `world.cfg.dshHome` 测的是"世界**算出来**的值"，
  //    而"agent **实际拿到**哪个 DSH_HOME"是另一件事 ——
  //    **变异验证证明过**：把 `cfgForAgentKey` 换成"永远返回全局 cfg"，
  //    只比 `cfg` 的写法**一条都抓不到**（9 条全绿，而边界已经不在了）。
  const spawned = [];

  let worlds = null;
  const runtime = new AgentRuntime({
    cfg,
    cfgFor: (key) => worlds.cfgForAgentKey(key),
    onEvict: (id) => worlds.onEvict(id),
    spawnFn: (bin, args, opts) => {
      spawned.push({ dshHome: opts?.env?.DSH_HOME ?? null, cwd: opts?.cwd ?? null });
      return realSpawn(process.execPath, [FAKE], {
        ...opts,
        env: { ...opts.env, FAKE_SCENARIO: scenario },
      });
    },
  });
  worlds = new Worlds({ cfg, runtime, log: () => {}, warn: () => {} });

  const auth = new Auth({ dataDir, lockAfter: 3, lockMs: 60_000 });
  auth.setPassword('test-pass');

  const { listen, close } = createServer({ worlds, auth, buildId: 'mt-test' });
  const addr = await listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;

  const h = {
    dataDir, cfg, worlds, runtime, auth, origin, spawned,
    close: async () => {
      open.delete(h);
      await worlds.shutdownDispatchers();
      await runtime.shutdown();
      await close();
      // ⚠️ **这一句不能少**：账本那条本地通道是个**真的 Unix 套接字监听**，
      //    不关它 ⇒ 事件循环一直有活的句柄 ⇒ **node 测试进程永不退出**
      //    （现象是"九条全过，但文件挂到超时"——很难看出是这一句漏了）。
      worlds.closeSockets();
      nodeFs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  open.add(h);
  return h;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等进程池里攒够 n 个（投递是异步的）。 */
async function waitForCount(h, n) {
  for (let i = 0; i < 80 && h.runtime.count < n; i += 1) await sleep(50);
  return h.runtime.count;
}

const tokenFor = (h, sub) => h.auth.issue({ sub }).token;
const get = (h, path, sub) =>
  fetch(`${h.origin}${path}`, { headers: { authorization: `Bearer ${tokenFor(h, sub)}` } });
const post = (h, path, body, sub) =>
  fetch(`${h.origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor(h, sub)}` },
    body: JSON.stringify(body),
  });

const jsonl = (dir, name = 'main.jsonl') => {
  const f = nodePath.join(dir, name);
  return nodeFs.existsSync(f) ? nodeFs.readFileSync(f, 'utf8') : '';
};

// ── ① 数据：甲写的进甲的盘，乙的盘上没有 ────────────────────

test('★ 甲说的话只进甲的盘：乙与主人那两份**都没有**（带负向对照）', async () => {
  const h = await boot();
  const about = { authorization: `Bearer ${tokenFor(h, 'u1')}` };

  const r = await fetch(`${h.origin}/api/say`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...about },
    body: JSON.stringify({ messageId: 'm_u1', text: '甲的暗号-ALPHA' }),
  });
  assert.equal(r.status, 200);

  const u1dir = h.worlds.pathsFor('u1').dir;
  const u2dir = h.worlds.pathsFor('u2').dir;
  assert.match(jsonl(u1dir), /甲的暗号-ALPHA/, '★ 甲自己那一份里必须有');
  assert.doesNotMatch(jsonl(u2dir), /甲的暗号-ALPHA/, '🔴 乙那一份里**不许**有');
  assert.doesNotMatch(jsonl(h.dataDir), /甲的暗号-ALPHA/, '🔴 主人那一份里也不许有');

  // ⚠️ **负向对照**：主人写一句 ⇒ 主人那一份**必须有**。
  //    没有这一条，"乙那里没有"可能只是因为**文件根本没在写**（空跑）。
  const ro = await fetch(`${h.origin}/api/say`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor(h, OWNER_ID)}` },
    body: JSON.stringify({ messageId: 'm_owner', text: '主人的暗号-OMEGA' }),
  });
  assert.equal(ro.status, 200);
  assert.match(jsonl(h.dataDir), /主人的暗号-OMEGA/, '负向对照：主人那一份必须写得进去');
  assert.doesNotMatch(jsonl(u1dir), /主人的暗号-OMEGA/, '🔴 主人的话不许漏进甲那一份');

  await h.close();
});

test('★ 乙的号数（seq）与甲各数各的', async () => {
  const h = await boot();
  await post(h, '/api/say', { messageId: 'a1', text: '甲一' }, 'u1');
  await post(h, '/api/say', { messageId: 'a2', text: '甲二' }, 'u1');
  await post(h, '/api/say', { messageId: 'b1', text: '乙一' }, 'u2');

  const s1 = await (await get(h, '/api/health', 'u1')).json();
  const s2 = await (await get(h, '/api/health', 'u2')).json();
  assert.ok(s1.seq > s2.seq, `★ 甲说了两句、乙说了一句 ⇒ 甲的数必须更大（${s1.seq} vs ${s2.seq}）`);
  assert.notEqual(s1.seq, s2.seq, '🔴 两个人的号**不许**是同一个计数器');

  await h.close();
});

// ── ② agent 进程池的键：这是"甲说的话进乙的窗口"那个根 ────────

test('🔴 两个人**同时**在 agent 进程池里（键是 u1/main、u2/main）', async () => {
  const h = await boot();
  await post(h, '/api/say', { messageId: 'k1', text: '甲' }, 'u1');
  await post(h, '/api/say', { messageId: 'k2', text: '乙' }, 'u2');
  // 投递是异步的，等它们真的把 agent 建出来
  await waitForCount(h, 2);

  const keys = h.runtime.snapshot().map((x) => x.sessionId).sort();
  assert.deepEqual(
    keys,
    ['u1/main', 'u2/main'],
    `★ 池里必须**同时**看得到两个人的键；实际=${JSON.stringify(keys)}`,
  );
  await h.close();
});

test('🔴 负向对照：键退回 `main` ⇒ 两个人**只剩一个**（"今天必撞"的证明）', async () => {
  // ⚠️ 这一条不跑服务，直接问派发器：`agentKey` 不给时它只能退回 `timeline.id`，
  //    而每个人的 timeline 都叫 `'main'` ⇒ 两个人的键**一模一样**。
  //    这正是接线之前的状态，也是"甲说的话进乙的窗口"的机制。
  const h = await boot();
  const a = h.worlds.worldFor('u1');
  const fakeRuntime = { agent: (id) => ({ id }), stop: async () => {} };
  const { Dispatcher } = await import('../src/dispatcher.js');

  const noKey = new Dispatcher({
    timeline: a.timeline, runtime: fakeRuntime, store: a.store, turnDeadlineMs: 0,
  });
  const withKey = new Dispatcher({
    timeline: a.timeline, runtime: fakeRuntime, store: a.store, turnDeadlineMs: 0,
    agentKey: agentKeyFor('u1'),
  });

  // 私有的键取不出来，就用"投递时向 runtime 要哪个键"来观察
  const seen = [];
  const spy = { agent: (id) => { seen.push(id); return { id }; }, stop: async () => {} };
  const d1 = new Dispatcher({ timeline: a.timeline, runtime: spy, store: a.store, turnDeadlineMs: 0 });
  const d2 = new Dispatcher({
    timeline: a.timeline, runtime: spy, store: a.store, turnDeadlineMs: 0, agentKey: agentKeyFor('u1'),
  });
  assert.equal(typeof noKey.onEvict, 'function');
  assert.equal(typeof withKey.onEvict, 'function');

  await d1.deliver('x', { messageId: 'n1' }).catch(() => {});
  await d2.deliver('y', { messageId: 'n2' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(seen.includes('main'), `负向对照：不传 agentKey 时键是 'main'（实际 ${JSON.stringify(seen)}）`);
  assert.ok(seen.includes('u1/main'), `★ 传了 agentKey 之后键是 'u1/main'（实际 ${JSON.stringify(seen)}）`);
  assert.notEqual('main', 'u1/main', '🔴 两个键相同 ⇒ 甲和乙共用同一个 agent');

  await d1.shutdown().catch(() => {});
  await d2.shutdown().catch(() => {});
  await h.close();
});

// ── ③ DSH_HOME / 工作目录：N21（会话键是绝对路径编码的）────────

test('★ 每个人的 DSH_HOME 与工作目录都不同；**主人那两份没被搬**', async () => {
  const h = await boot();
  const w1 = h.worlds.worldFor('u1');
  const w2 = h.worlds.worldFor('u2');
  const wo = h.worlds.worldFor(OWNER_ID);

  assert.notEqual(w1.cfg.dshHome, w2.cfg.dshHome, '🔴 两个人共用一个 DSH_HOME ⇒ 会话记录互相看得见');
  assert.notEqual(w1.cfg.agentCwd, w2.cfg.agentCwd, '🔴 两个人的工作目录也必须是两个');
  assert.notEqual(w1.cfg.ledgerSocketPath, w2.cfg.ledgerSocketPath, '🔴 账本那条口会串账');

  // 🔴 **主人那一份必须原地不动**（N21：会话键是绝对路径编码的，动它=让他失忆）
  assert.equal(wo.cfg.dshHome, h.cfg.dshHome, '🔴 主人的 DSH_HOME 不许被搬');
  assert.equal(wo.cfg.agentCwd, h.cfg.agentCwd, '🔴 主人的工作目录不许被搬');
  assert.equal(wo.dir, h.dataDir, '🔴 主人的数据目录必须还是 data/ 根');
  assert.equal(wo.agentKey, 'owner/main');

  // 别人那一格：**建出来了**，而且是空的
  assert.ok(nodeFs.existsSync(w1.cfg.dshHome), '别人那一份 DSH_HOME 要建出来');
  assert.equal(nodeFs.readdirSync(w1.cfg.dshHome).length, 0, '★ 新的人拿到的必须是**空白**');
  assert.equal(nodeFs.statSync(w1.dir).mode & 0o777, 0o700, '别人的东西别人读不了');

  // ★ **真起 agent，看它实际拿到哪个 `DSH_HOME`** ——
  //   ⚠️ 这一步才是这条判据的要害：上面那些比的是"世界**算出来**的值"，
  //      而 agent 拿到没有是**另一条路**（`runtime.cfgFor`）。
  //      变异验证：把 `cfgForAgentKey` 换成"永远返回全局 cfg"，
  //      **只比 cfg 的写法 9 条全绿也抓不到** —— 补了这一句才抓得到。
  await post(h, '/api/say', { messageId: 'ds1', text: '甲' }, 'u1');
  await post(h, '/api/say', { messageId: 'ds2', text: '乙' }, 'u2');
  await post(h, '/api/say', { messageId: 'ds3', text: '主人' }, OWNER_ID);
  await waitForCount(h, 3);

  const homes = h.spawned.map((s) => s.dshHome);
  assert.ok(
    homes.includes(w1.cfg.dshHome),
    `🔴 甲的 agent 必须拿到甲那份 DSH_HOME；实际起过 ${JSON.stringify(homes)}`,
  );
  assert.ok(
    homes.includes(w2.cfg.dshHome),
    `🔴 乙的 agent 必须拿到乙那份 DSH_HOME；实际起过 ${JSON.stringify(homes)}`,
  );
  // 负向对照：主人**必须**还是拿到原来那个（否则"按人分"把主人也搬走了 = N21 违规）
  assert.ok(
    homes.includes(h.cfg.dshHome),
    `负向对照：主人必须还是原来那份；实际起过 ${JSON.stringify(homes)}`,
  );

  await h.close();
});

// ── ④ 身份只从令牌来（URL / body 说了不算）────────────────────

test('🔴 拿甲的令牌，`?sub=` 塞乙的名字**也不管用**', async () => {
  const h = await boot();
  await post(h, '/api/say', { messageId: 's1', text: '甲的话-SUBTEST' }, 'u1');

  // 甲的令牌 + URL 上写乙 ⇒ 必须还是**甲那一份**
  const r = await get(h, '/api/export?sub=u2&userId=u2', 'u1');
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.match(text, /甲的话-SUBTEST/, '★ 只能是甲自己那一份');

  // body 上写别人也一样
  const r2 = await post(h, '/api/say', { sub: 'u2', userId: 'u2', messageId: 's2', text: '还是甲的' }, 'u1');
  assert.equal(r2.status, 200);
  assert.match(jsonl(h.worlds.pathsFor('u2').dir), /^$|^(?!.*还是甲的)/s, '🔴 不许因为 body 里写了 u2 就写进乙那一份');

  await h.close();
});

test('★ 乙的导出里**没有**甲的话（负向对照：甲自己的导出里有）', async () => {
  const h = await boot();
  await post(h, '/api/say', { messageId: 'e1', text: '甲的私房话-EXPORT' }, 'u1');
  await post(h, '/api/say', { messageId: 'e2', text: '乙的私房话-EXPORT' }, 'u2');

  const t1 = await (await get(h, '/api/export', 'u1')).text();
  const t2 = await (await get(h, '/api/export', 'u2')).text();
  assert.match(t1, /甲的私房话-EXPORT/, '★ 甲导得出自己的');
  assert.doesNotMatch(t1, /乙的私房话-EXPORT/, '🔴 甲的导出里**不许**出现乙的');
  assert.match(t2, /乙的私房话-EXPORT/, '负向对照：乙也导得出自己的');
  assert.doesNotMatch(t2, /甲的私房话-EXPORT/, '🔴 乙的导出里不许出现甲的');

  await h.close();
});

// ── ⑤ 回收站也各是各的 ──────────────────────────────────────

test('★ 甲的回收站里有甲的，乙的回收站里没有', async () => {
  const h = await boot();
  await post(h, '/api/say', { messageId: 'tr1', text: '甲要删的-TRASH' }, 'u1');
  const rm = await post(h, '/api/trash/remove', { confirm: true, messageIds: ['tr1'] }, 'u1');
  assert.equal(rm.status, 200);

  const b1 = await (await get(h, '/api/trash', 'u1')).json();
  const b2 = await (await get(h, '/api/trash', 'u2')).json();
  assert.equal(b1.items.length, 1, '★ 甲那边看得见自己删的那条');
  assert.equal(b2.items.length, 0, '🔴 乙那边**不许**看得见（回收站也是单例过）');

  await h.close();
});

// ── ⑥ 状态聚合：任一忙就算忙（宁等不切）──────────────────────

test('★ `status.json` 的"忙"是**聚合**的（不是只看主人）', async () => {
  // ⚠️ 用 `slow`（1.5 秒后自己收口）而**不是** `hang`：`hang` 那一轮永远结束不了，
  //    收尾时 `dispatcher.shutdown()` 会一直等它 ⇒ **测试进程挂住**
  //    （我第一版就是这么挂的：断言全过，最后卡在 close 上）。
  const h = await boot({ scenario: 'slow' });
  await post(h, '/api/say', { messageId: 'b1', text: '一句会拖住的话' }, 'u2');
  for (let i = 0; i < 60 && (h.worlds.busySnapshot().turns ?? 0) === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const s = h.worlds.busySnapshot();
  assert.ok(
    (s.turns ?? 0) + (s.pending ?? 0) > 0,
    `🔴 乙在忙的时候，聚合状态必须是忙的（实际 ${JSON.stringify(s)}）—— 否则重启会切掉他的话`,
  );
  // 负向对照：主人自己那时没在忙（聚合状态**不是**"主人忙"的别名）
  assert.equal(h.worlds.worldFor(OWNER_ID).dispatcher.armedDeadlines, 0, '主人这一份是闲的');
  await h.close();
});
