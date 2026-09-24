// **甲那一条的两个"不许出事"** —— 判据 **H6（不许留孤儿）** 与 **H7（与琥珀隔离）**。
//
// 这一份**故意用真进程**：H6 要问的是"那个子进程**真的死了没有**"，
// 拿一个假对象回答不了它 —— 得拿内核（`process.kill(pid, 0)`）当证人。
// H7 也一样：琥珀那一侧是真的 `AgentRuntime` + 真的假 agent 子进程，
// 这样"harness 有没有动它"才是**可观察**的（数实例、看 pid、看事件）。
//
// 判据出处：`docs/dev/81-HARNESS-ENTRY.md` §六 H6 / H7 与 §5.3 最后两条。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentRuntime } from '../src/agent-runtime.js';
import { createHarnessRelay } from '../src/harness-session.mjs';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const FAKE_DSH = nodePath.join(HERE, 'fake-harness-dsh.mjs');
const FAKE_AGENT = nodePath.join(HERE, 'fake-agent.mjs');
const CORE = nodePath.resolve(HERE, '..');
const MODEL_PATCH = nodePath.join(CORE, 'hupo-model-proxy.yml');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const kids = new Set();
const relays = new Set();
const runtimes = new Set();
after(async () => {
  for (const r of relays) {
    try {
      r.shutdown();
    } catch {
      /* 关不干净不影响结论 */
    }
  }
  for (const rt of runtimes) {
    try {
      await rt.shutdown();
    } catch {
      /* 关不干净不影响结论 */
    }
  }
  for (const c of kids) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* 已经没了 */
    }
  }
  await sleep(80);
});

/** **内核**说它还活着吗（`process.kill(pid, 0)` 是唯一诚实的证人）。 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid, what, ms = 5000) {
  const t0 = Date.now();
  while (alive(pid)) {
    if (Date.now() - t0 > ms) throw new Error(`还剩一个孤儿：${what}（pid ${pid}）`);
    await sleep(20);
  }
}

async function waitFor(fn, what, ms = 6000) {
  const t0 = Date.now();
  for (;;) {
    const hit = fn();
    if (hit) return hit;
    if (Date.now() - t0 > ms) throw new Error(`等不到：${what}（${ms}ms）`);
    await sleep(15);
  }
}

/** 假客户端（同 `harness-session.test.js`：真 `ws` 只用得到这几样）。 */
class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
  }
  send(s) {
    this.sent.push(JSON.parse(String(s)));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
  raw() {
    return this.sent.filter((m) => m.t === 'raw').map((m) => m.m);
  }
  states() {
    return this.sent.filter((m) => m.t === 'state');
  }
}

function tmpDir(tag) {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), `hupo-${tag}-`));
}

/** 起一个 relay（真 spawn 假 DSH），并把起过的进程对象收着。 */
function makeRelay({ env = {}, killGraceMs = 300, cfgOver = {} } = {}) {
  const dir = tmpDir('harness-proc');
  const cfg = {
    dshBin: 'unused',
    agentProfile: 'sdk',
    agentCwd: dir,
    dshHome: dir,
    agentProvider: 'deepseek-official',
    agentModel: 'deepseek-flash',
    agentEffort: 'low',
    agentMaxTokens: 16000,
    agentBootTimeoutMs: 20000,
    agentUid: null,
    agentGid: null,
    modelPatchPath: MODEL_PATCH,
    ...cfgOver,
  };
  const spawned = [];
  const spawnFn = (bin, args, opts) => {
    const child = realSpawn(process.execPath, [FAKE_DSH, ...args], { ...opts, env: { ...opts.env, ...env } });
    spawned.push(child);
    kids.add(child);
    child.on('exit', () => kids.delete(child));
    return child;
  };
  const relay = createHarnessRelay({ cfg, spawnFn, killGraceMs });
  relays.add(relay);
  return { relay, cfg, spawned, dir };
}

// ── H6：不许留孤儿 ───────────────────────────────────────────

test('★ H6：`stop` ⇒ 那个 DSH 进程**真死了**（内核为证），而且 `gone` 说清了为什么', async () => {
  const { relay, spawned } = makeRelay();
  const ws = new FakeWs();
  relay.attach(ws);
  await waitFor(() => ws.states().find((m) => m.s === 'ready'), 'state:ready');
  const child = spawned[0];
  assert.ok(alive(child.pid), '先说清它本来活着（不然下面那条是空话）');
  assert.equal(relay.stats().processes, 1);

  ws.emit('message', Buffer.from(JSON.stringify({ t: 'stop' })), false);
  const gone = await waitFor(() => ws.states().find((m) => m.s === 'gone'), 'state:gone');
  assert.ok(gone.why.includes('你说停'), `该说清是"按停"，实际：${gone.why}`);
  await waitDead(child.pid, '`stop` 之后还留着的那一个');
  assert.equal(relay.stats().processes, 0, '收干净之后不该还数得到一个');
  ws.close();
});

test('★ H6：连接断开（客户端没了）⇒ 同样**收干净**（不许留孤儿）', async () => {
  const { relay, spawned } = makeRelay();
  const ws = new FakeWs();
  relay.attach(ws);
  await waitFor(() => ws.states().find((m) => m.s === 'ready'), 'state:ready');
  const child = spawned[0];
  assert.ok(alive(child.pid));

  ws.close(); // 客户端那一边断了（网络掉了 / 关了页面）
  await waitDead(child.pid, '断线之后还留着的那一个');
  assert.equal(relay.stats().processes, 0);
});

test('★ H6：它装死不理会 `shutdown` 与 `SIGTERM` ⇒ **兜底那一刀（SIGKILL）也得把它收掉**', async () => {
  const { relay, spawned } = makeRelay({
    env: { FAKE_DSH_IGNORE_SIGTERM: '1', FAKE_DSH_IGNORE_SHUTDOWN: '1' },
    killGraceMs: 200,
  });
  const ws = new FakeWs();
  relay.attach(ws);
  await waitFor(() => ws.states().find((m) => m.s === 'ready'), 'state:ready');
  const child = spawned[0];
  assert.ok(alive(child.pid));

  ws.close();
  await waitDead(child.pid, '装死的那个');
  assert.equal(relay.stats().processes, 0);
});

test('★ H6：`relay.shutdown()`（服务关门前那一兜）⇒ 手上的进程一个不剩', async () => {
  const { relay, spawned } = makeRelay();
  const wsA = new FakeWs();
  const wsB = new FakeWs();
  // ⚠️ 一个 relay 可以接**多条连接**：每一条**各自**一个进程
  relay.attach(wsA);
  relay.attach(wsB);
  await waitFor(() => wsA.states().find((m) => m.s === 'ready'), 'A ready');
  await waitFor(() => wsB.states().find((m) => m.s === 'ready'), 'B ready');
  assert.equal(spawned.length, 2, '一个 WS 连接 = 一个 DSH 进程');
  assert.equal(relay.stats().processes, 2);

  relay.shutdown();
  for (const c of spawned) await waitDead(c.pid, 'shutdown 之后还留着的那一个');
  assert.equal(relay.stats().processes, 0);
});

// ── H7：与琥珀自己那一条完全隔离 ─────────────────────────────

test('🔴 H7：harness 那一路**不动**琥珀自己的实例（另一个进程、另一套会话 id、另一条命）', async () => {
  const dir = tmpDir('harness-iso');
  const amberCfg = {
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
  };
  /** 琥珀那一侧起过的进程（真 spawn 假 agent）。 */
  const amberKids = [];
  const runtime = new AgentRuntime({
    cfg: amberCfg,
    spawnFn: (bin, args, opts) => {
      const child = realSpawn(process.execPath, [FAKE_AGENT], { ...opts, env: { ...opts.env, FAKE_SCENARIO: 'normal' } });
      amberKids.push(child);
      kids.add(child);
      child.on('exit', () => kids.delete(child));
      return child;
    },
  });
  runtimes.add(runtime);
  const exits = [];
  runtime.on('agent-exit', (id) => exits.push(id));

  // ★ 琥珀那一份：起一个 agent（**它在的时候**再动 harness —— 这才叫"隔离"）
  const amber = runtime.agent('main');
  await amber.start();
  assert.equal(runtime.count, 1);
  const amberPid = amberKids[0].pid;
  assert.ok(alive(amberPid));
  /** 琥珀那套会话 id 的形状：`main.<bootId>.<第几个>`（**不是** UUID）。 */
  assert.match(amber.dshSessionId, /^main\./u);

  // ★ 现在接上 harness（同一个工作目录 / 同一个 DSH_HOME —— 故意的：
  //   连"住在一起"都不许互相动）
  const harnessCfg = {
    ...amberCfg,
    agentProvider: 'deepseek-official',
    agentModel: 'deepseek-flash',
    agentMaxTokens: 16000,
    modelPatchPath: MODEL_PATCH,
  };
  const harnessKids = [];
  const harnessWrites = [];
  const relay = createHarnessRelay({
    cfg: harnessCfg,
    spawnFn: (bin, args, opts) => {
      const child = realSpawn(process.execPath, [FAKE_DSH, ...args], opts);
      harnessKids.push(child);
      kids.add(child);
      child.on('exit', () => kids.delete(child));
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (s, ...rest) => {
        harnessWrites.push(String(s));
        return write(s, ...rest);
      };
      return child;
    },
    killGraceMs: 300,
  });
  relays.add(relay);
  const ws = new FakeWs();
  relay.attach(ws);
  await waitFor(() => ws.states().find((m) => m.s === 'ready'), 'harness ready');
  ws.emit('message', Buffer.from(JSON.stringify({ t: 'say', text: '你好' })), false);
  await waitFor(() => ws.raw().find((m) => m?.params?.event?.type === 'assistant/message'), 'harness 回话');

  // ① **是另一个进程**
  assert.equal(harnessKids.length, 1);
  assert.notEqual(harnessKids[0].pid, amberPid);
  assert.ok(alive(harnessKids[0].pid) && alive(amberPid), '两条路各自活着');

  // ② **没动琥珀的实例与 LRU**
  assert.equal(runtime.count, 1, 'harness 不许往琥珀的池子里加/摘实例');
  const snap = runtime.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].sessionId, 'main');
  assert.deepEqual(exits, [], 'harness 那一路不许引出琥珀的 agent-exit');

  // ③ **会话 id 不是同一套**（UUID vs `main.<bootId>.<n>`）
  const prompt = harnessWrites
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .find((r) => r?.method === 'session/prompt');
  assert.ok(prompt, 'harness 没发 session/prompt');
  assert.match(prompt.params.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-/u, '契约 §5.3：sessionId 用 crypto.randomUUID()');
  assert.notEqual(prompt.params.sessionId, amber.dshSessionId, '两条路不许共用会话 id');

  // ④ **harness 收掉自己那个，琥珀那个还活着**
  ws.close();
  await waitDead(harnessKids[0].pid, 'harness 那一个');
  assert.ok(alive(amberPid), 'harness 收尾**不许**碰琥珀那一份');
  assert.equal(runtime.count, 1);
  assert.deepEqual(exits, []);

  // ⑤ 琥珀那一份还能正常说话（证明它真的没被弄坏）
  await amber.prompt('还在吗');
  await waitFor(() => runtime.count === 1, '琥珀还在');
  assert.ok(alive(amberPid));
});

test('🔴 H7（结构那一半）：harness 那份代码**不许**碰 `AgentRuntime` 的实例与 LRU', () => {
  const file = nodePath.join(CORE, 'src/harness-session.mjs');
  /**
   * ⚠️ **整行注释不算**（照 `reverse-drift.test.js` 那条理由）：
   *    "这里不许 import AgentRuntime"这句话本身就该写在文件头。
   *    拿整份文件去 grep，结果是"解释一句禁令反而违规"——那种闸会被绕过去。
   */
  const code = nodeFs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');
  // 它会 import `childEnv`（契约点名要的那个纯函数）—— 这是**唯一**该有的关系
  assert.ok(code.includes("from './agent-runtime.js'"), '该借用的是 childEnv 那一个纯函数');
  for (const forbidden of ['AgentRuntime', 'runtime.agent(', 'evictIfNeeded', 'new DshAgent', '.dispose()']) {
    assert.ok(!code.includes(forbidden), `不许出现「${forbidden}」（那就是在复用/干扰琥珀那条路）`);
  }
});

test('★ H7：`server.close()` 那一兜会把 harness 手上的进程收干净（接线在 `server.js` 里）', () => {
  const src = nodeFs.readFileSync(nodePath.join(CORE, 'src/server.js'), 'utf8');
  assert.ok(src.includes('harness?.shutdown?.()'), '关门时要兜一次（不许留孤儿）');
  assert.ok(src.includes('harnessWss'), '那条 WS 也要终止，否则 `close()` 会一直挂着');
});
