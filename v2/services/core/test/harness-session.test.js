// **甲：盒子那台 DSH 的原始会话流** —— 容器侧那一段的判据（**H3 / H4 / H5**）。
//
// 走**真 spawn、真 stdio、真分帧**（用假 DSH，`test/fake-harness-dsh.mjs`）：
// 最容易错的那一段恰恰就是"起进程 / 读行 / 原样转发 / 收进程"，
// 把它 mock 掉等于把 bug 藏在判据之外（同 `agent.test.js` 那条理由）。
//
// 判据出处：`docs/dev/81-HARNESS-ENTRY.md` §六。
//   H3 连上 ⇒ 先 `state:booting`，`initialize` 成 ⇒ `state:ready`；进程退 ⇒ `state:gone` + 人话
//   H4 `say` 一句 ⇒ 回流的 `raw` 里**出现过** `params.event.type === 'assistant/message'`
//   H5 🔴 **它是 DSH 本人**：`system/message` 含 DSH 那句固定开场、**不含琥珀人格的特征串**
//      ⇒ 这一条**必须能反着验**：把人格 patch 挂上（在 spawn 那一层塞进去）**就必须红**。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { HARNESS_PATH, createHarnessRelay, harnessArgs, harnessExitWhy, harnessSpawnWhy } from '../src/harness-session.mjs';
import {
  AMBER_MARK,
  CAP_TOOLS,
  DSH_OPENING,
  DSH_TOOLS,
  SENTINEL_FRAME,
  assistantTexts,
  voiceFor,
} from './harness-fake-voice.mjs';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const FAKE = nodePath.join(HERE, 'fake-harness-dsh.mjs');
const CORE = nodePath.resolve(HERE, '..');
const MODEL_PATCH = nodePath.join(CORE, 'hupo-model-proxy.yml');
/** ★ **真**那份人格（反例里要真把它挂上去 —— 假的挂法验不出东西）。 */
const PERSONA_PATCH = nodePath.join(CORE, 'hupo-persona.yml');
/** ★ **真**那份能力层（第二个反例）。 */
const CAPS_PATCH = nodePath.join(CORE, 'hupo-capabilities.yml');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 手里起的进程：收尾时**必须**一个不剩（判据 H6 那件事在这里也要成立）。 */
const kids = new Set();
const relays = new Set();
after(async () => {
  for (const relay of relays) {
    try {
      relay.shutdown();
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
  await sleep(50);
});

/** 假客户端：真 `ws` 只用得到这几样（`on` / `send` / `readyState` / `close`）。 */
class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    /** 全是 JSON.parse 回来的（判据比的是**对象**，proof 在下面那条"原样"测试里）。 */
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
  /** 模拟客户端发来一条文本帧。 */
  fromClient(o) {
    this.emit('message', Buffer.from(JSON.stringify(o)), false);
  }
  /** 收到的 `raw` 消息体（就是 DSH stdout 上那些 JSON-RPC 消息）。 */
  raws() {
    return this.sent.filter((m) => m.t === 'raw').map((m) => m.m);
  }
  states() {
    return this.sent.filter((m) => m.t === 'state');
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

/**
 * 起一个 relay（真 spawn 假 DSH）。
 *
 * @param {object} o
 * @param {object} [o.env] 给假 DSH 的场景变量
 * @param {string[]} [o.extraArgs] **在 spawn 那一层**追加的参数
 *   —— 判据 H5 的反例就是这么造的：假装"漏挂了一层"，于是人格进了那个进程。
 * @param {object} [o.cfgOver]
 */
function makeRelay({ env = {}, extraArgs = [], cfgOver = {} } = {}) {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-harness-'));
  const cfg = {
    dshBin: 'unused（假 DSH 用 process.execPath 起）',
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
    // ★ 只有模型这一条 patch 该进那个进程（人格 / 能力层**不许**）
    modelPatchPath: MODEL_PATCH,
    personaPath: PERSONA_PATCH,
    capabilitiesPath: CAPS_PATCH,
    ...cfgOver,
  };
  /** 我们**发出去**的原始 JSON-RPC 行（判据要看 `initialize` / `session/prompt` 的参数）。 */
  const writes = [];
  const spawnFn = (bin, args, opts) => {
    const child = realSpawn(process.execPath, [FAKE, ...args, ...extraArgs], {
      ...opts,
      env: { ...opts.env, ...env },
    });
    kids.add(child);
    child.once('exit', () => kids.delete(child));
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (s, ...rest) => {
      writes.push(String(s));
      return write(s, ...rest);
    };
    return child;
  };
  const relay = createHarnessRelay({ cfg, spawnFn, killGraceMs: 300 });
  relays.add(relay);
  return { relay, cfg, writes, dir };
}

/** 我们发出去的那些请求行，按 `method` 取一条。 */
function sentRequests(writes) {
  return writes
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ── H5 的**结构那一半**：参数里根本没有"人格/能力"这两个词 ──────

test('🔴 H5：给那个进程的参数**只有** profile 与模型那条 patch（人格/能力层一个字都不许有）', () => {
  const args = harnessArgs({
    agentProfile: 'sdk',
    modelPatchPath: '/app/code/hupo-model-proxy.yml',
    personaPath: '/app/code/hupo-persona.yml',
    capabilitiesPath: '/app/code/hupo-capabilities.yml',
  });
  assert.deepEqual(args, ['--profile', 'sdk', '--patch', '/app/code/hupo-model-proxy.yml']);
  const all = args.join(' ');
  assert.ok(!all.includes('persona'), '挂了人格就变成"琥珀"，不是那台 DSH 本人');
  assert.ok(!all.includes('capabilities'), '挂了能力层就多出账本/小程序那几样工具');
  // 负向对照：模型那条**必须**在（少了它盒里那个进程没有模型）
  assert.ok(all.includes('hupo-model-proxy.yml'));
});

// ── H3：booting → ready；进程退 ⇒ gone + 人话 ─────────────────

test('★ H3：连上 ⇒ 先 `state:booting`，`initialize` 成 ⇒ `state:ready`；进程退 ⇒ `state:gone` + 人话', async () => {
  const { relay, cfg, writes } = makeRelay();
  const ws = new FakeWs();
  relay.attach(ws);

  // ① **先 booting**（同步就该在）
  assert.deepEqual(ws.states()[0], { t: 'state', s: 'booting' });

  // ② initialize 成 ⇒ ready
  await waitFor(() => ws.states().find((m) => m.s === 'ready'), 'state:ready');
  // `initialize` 的参数照 `agent-runtime.js:432-439`（逐字段比）
  const init = sentRequests(writes).find((r) => r.method === 'initialize');
  assert.ok(init, '没发 initialize');
  assert.equal(init.jsonrpc, '2.0');
  assert.deepEqual(init.params, {
    cwd: cfg.agentCwd,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'low',
    maxTokens: 16000,
  });

  // ③ 进程退 ⇒ gone + **人话**
  const child = [...kids][0];
  child.kill('SIGKILL');
  const gone = await waitFor(() => ws.states().find((m) => m.s === 'gone'), 'state:gone');
  assert.equal(typeof gone.why, 'string');
  assert.ok(gone.why.length > 0, 'gone 必须带一句人话');
  assert.ok(gone.why.includes('那台 DSH 退出了'), `原因该是人话，实际：${gone.why}`);
  relay.shutdown();
  ws.close();
});

test('★ H3 的另一半：`initialize` 永远不回 ⇒ `gone` + 人话，而且进程**收干净**', async () => {
  const { relay } = makeRelay({ env: { FAKE_DSH_NEVER_INIT: '1' }, cfgOver: { agentBootTimeoutMs: 250 } });
  const ws = new FakeWs();
  relay.attach(ws);
  /** ⚠️ **先抓住这个进程对象**：它一退，`kids` 里就没了（那是"收干净"的证据）。 */
  const child = [...kids][0];
  const gone = await waitFor(() => ws.states().find((m) => m.s === 'gone'), 'state:gone（initialize 超时）');
  assert.ok(gone.why.includes('起不来'), `该说"起不来"，实际：${gone.why}`);
  // 超时不等于放着它 —— 半条命的进程比没有更坏
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, '那个进程被收掉');
  relay.shutdown();
  ws.close();
});

test('起不来（spawn 的 ENOENT）要**把两种可能都报出来**（那是二义的）', () => {
  const why = harnessSpawnWhy(Object.assign(new Error('spawn dsh ENOENT'), { code: 'ENOENT' }), {
    dshBin: '/bin/dsh',
    agentCwd: '/data/main',
  });
  assert.ok(why.includes('/bin/dsh'));
  assert.ok(why.includes('/data/main'));
  const other = harnessExitWhy({ code: 9, signal: null, stderrTail: 'boom' });
  assert.ok(other.includes('code=9'));
  assert.ok(other.includes('boom'));
});

// ── H4：`say` ⇒ raw 里出现 `assistant/message` ────────────────

test('★ H4：`say` 一句 ⇒ 回流的 `raw` 里出现 `assistant/message`（原样的每一条都在）', async () => {
  const { relay, cfg, writes } = makeRelay();
  const ws = new FakeWs();
  relay.attach(ws);
  await waitFor(() => ws.states().find((m) => m.s === 'ready'), 'state:ready');

  ws.fromClient({ t: 'say', text: '你好' });
  await waitFor(
    () => ws.raws().find((m) => m?.params?.event?.type === 'assistant/message'),
    'raw 里的 assistant/message',
  );

  // `session/prompt` 的形状照契约 §5.3：会话 id 是**每条连接一个新 UUID**，内容是内容块
  const prompt = sentRequests(writes).find((r) => r.method === 'session/prompt');
  assert.ok(prompt, '没发 session/prompt');
  assert.match(prompt.params.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  assert.deepEqual(prompt.params.contentBlocks, [{ type: 'text', text: '你好' }]);

  // 探针见过的那 14 种，一种都不许缺
  const types = ws.raws().filter((m) => m?.params?.event).map((m) => m.params.event.type);
  for (const t of [
    'turn/start', 'step/start', 'system/message', 'user/message', 'request/header',
    'request/context', 'session/title', 'assistant/message', 'step/end', 'turn/end',
    'permission/preset', 'sandbox/mode', 'approval/policy', 'agent/inbox/spliced',
  ]) {
    assert.ok(types.includes(t), `少了 ${t}（客户端那一侧要给它落点）`);
  }
  // `session.status` 也是原样一条（它走的是同一条 stdout）
  await waitFor(
    // ⚠️ **通知的方法名用「点」**（`session.status`）——请求才用斜杠（`session/prompt`）
    () => ws.raws().some((m) => m?.method === 'session.status' && m?.params?.status === 'idle'),
    'session.status idle',
  );
  // `initialize` 的响应也**原样**在流里（容器不做任何投影 ⇒ 客户端自己解）
  assert.ok(
    ws.raws().some((m) => m?.result?.serverInfo?.name === 'deepseek-harness-sdk-runtime'),
    'initialize 的响应也该原样出现在 raw 里',
  );
  assert.equal(cfg.agentProfile, 'sdk');
  relay.shutdown();
  ws.close();
});

test('★ H4 反例：**没说话**就不该有 `assistant/message`（那条判据不是"永远真"）', async () => {
  const { relay, writes } = makeRelay();
  const ws = new FakeWs();
  relay.attach(ws);
  await waitFor(() => ws.states().find((m) => m.s === 'ready'), 'state:ready');
  // 等开机那一批到齐，再给它足够的时间"自己说话"（如果它会的话）
  await waitFor(() => ws.raws().some((m) => m?.params?.event?.type === 'agent/inbox/spliced'), '开机那一批');
  await sleep(150);
  assert.equal(
    ws.raws().some((m) => m?.params?.event?.type === 'assistant/message'),
    false,
    '一句话都没说就冒出回话 —— 那 H4 那条判据就是假的',
  );
  assert.equal(
    sentRequests(writes).some((r) => r.method === 'session/prompt'),
    false,
    '没 `say` 就不许发 `session/prompt`',
  );
  relay.shutdown();
  ws.close();
});

test('★ 原样：stdout 上那条 JSON-RPC 消息**一个字段都不许动**（deep-equal）', async () => {
  const { relay } = makeRelay({ env: { FAKE_DSH_GARBAGE: '1', FAKE_DSH_SENTINEL: '1' } });
  const ws = new FakeWs();
  relay.attach(ws);
  const got = await waitFor(
    () => ws.raws().find((m) => m?.params?.event?.type === 'harness/原样'),
    '那条探针帧',
  );
  assert.deepEqual(got, SENTINEL_FRAME, '裁剪/改名/丢字段都会在这里露出来');
  // 不是 JSON 的那一行**不许**包装成 raw（线上只有那三种消息，字段冻结）
  assert.ok(ws.raws().every((m) => m && typeof m === 'object'));
  relay.shutdown();
  ws.close();
});

test('不认识的消息（或二进制帧）⇒ 不猜、不回话、也不把进程弄坏', async () => {
  const { relay } = makeRelay();
  const ws = new FakeWs();
  relay.attach(ws);
  await waitFor(() => ws.states().find((m) => m.s === 'ready'), 'state:ready');
  // 等"开机那一批"也到齐（`ready` 之后 stdout 上还会来几条）
  await waitFor(() => ws.raws().some((m) => m?.params?.event?.type === 'agent/inbox/spliced'), '开机那一批');
  const before = ws.sent.length;
  ws.fromClient({ t: 'nope', text: '?' });
  ws.emit('message', Buffer.from([1, 2, 3]), true);
  await sleep(150);
  assert.equal(ws.sent.length, before, '不认识的东西不许引出任何回话');
  assert.equal(relay.stats().processes, 1, '进程还该好好活着');
  relay.shutdown();
  ws.close();
});

// ── 客户端那三条对齐（2026-09-24 对面提的）────────────────────

test('🔴 对齐①：客户端发 `stop` ⇒ **一定**回一条 `state:gone` + 人话（客户端不自己改状态）', async () => {
  const { relay } = makeRelay();
  const ws = new FakeWs();
  relay.attach(ws);
  await waitFor(() => ws.states().find((m) => m.s === 'ready'), 'state:ready');
  ws.fromClient({ t: 'stop' });
  const gone = await waitFor(() => ws.states().find((m) => m.s === 'gone'), 'stop 之后的 state:gone');
  assert.deepEqual(Object.keys(gone).sort(), ['s', 't', 'why'], '字段冻结：只有 t / s / why');
  assert.equal(gone.s, 'gone');
  assert.equal(typeof gone.why, 'string');
  assert.ok(gone.why.length > 0, '客户端要拿这句话显示 —— 不许空着');
  assert.equal(ws.states().at(-1).s, 'gone', '它该是最后一条状态（客户端发完 stop 就等这一条）');

  // ⚠️ **再按一次也得回**：进程已经没了也要如实说，不许让界面卡在「停」
  const before = ws.states().filter((m) => m.s === 'gone').length;
  ws.fromClient({ t: 'stop' });
  await waitFor(() => ws.states().filter((m) => m.s === 'gone').length > before, '第二次 stop 也要回一句');
  relay.shutdown();
  ws.close();
});

test('🔴 对齐①：`ready` 之前就按 `stop` ⇒ 同样回一句 `gone`', async () => {
  const { relay } = makeRelay();
  const ws = new FakeWs();
  relay.attach(ws);
  assert.equal(ws.states()[0].s, 'booting');
  ws.fromClient({ t: 'stop' });
  const gone = await waitFor(() => ws.states().find((m) => m.s === 'gone'), 'booting 期间的 state:gone');
  assert.equal(gone.s, 'gone');
  assert.ok(String(gone.why).length > 0);
  relay.shutdown();
  ws.close();
});

test('🔴 对齐③：`say` 在 `ready` 之前到 ⇒ **排队**（等 initialize 成了再发，不许静默丢）', async () => {
  const { relay, writes } = makeRelay();
  const ws = new FakeWs();
  relay.attach(ws);
  // 连上就发（客户端输入框这时是灰的，但万一还是发来了）
  assert.equal(ws.states()[0].s, 'booting');
  ws.fromClient({ t: 'say', text: '早到的一句' });
  await waitFor(() => ws.states().find((m) => m.s === 'ready'), 'state:ready');
  const reqs = sentRequests(writes);
  const initAt = reqs.findIndex((r) => r.method === 'initialize');
  const promptAt = reqs.findIndex((r) => r.method === 'session/prompt');
  assert.ok(initAt >= 0 && promptAt > initAt, '`initialize` 必须在前（DSH 的规矩：先 initialize 才能 prompt）');
  assert.deepEqual(reqs[promptAt].params.contentBlocks, [{ type: 'text', text: '早到的一句' }], '那句话不许丢');
  relay.shutdown();
  ws.close();
});

test('🔴 对齐③的反面：`initialize` 起不来时，那一句**不是**悄悄没的（前面已经有一句 `gone`）', async () => {
  const { relay } = makeRelay({ env: { FAKE_DSH_NEVER_INIT: '1' }, cfgOver: { agentBootTimeoutMs: 250 } });
  const ws = new FakeWs();
  relay.attach(ws);
  ws.fromClient({ t: 'say', text: '这一句投不出去了' });
  const gone = await waitFor(() => ws.states().find((m) => m.s === 'gone'), 'state:gone');
  assert.ok(String(gone.why).includes('起不来'), `要说清为什么，实际：${gone.why}`);
  relay.shutdown();
  ws.close();
});

// ── H5：它是 DSH 本人（**正例 + 两个反例**）────────────────────

/**
 * **H5 那条判据**（测试自己的一份，不是产物）：
 *   · `system/message` / 助手说的话里**有** DSH 那句固定开场；
 *   · 整条流里**没有**琥珀人格的特征串；
 *   · 工具清单里**没有**只有能力层才会带的那几条。
 */
function judgeH5(raws) {
  const all = JSON.stringify(raws);
  const texts = assistantTexts(raws);
  const tools =
    raws.find((m) => m?.params?.event?.type === 'request/header')?.params?.event?.data?.tools ?? [];
  return {
    dshOpening: texts.includes(DSH_OPENING),
    noAmber: !all.includes(AMBER_MARK),
    noCapsTools: !tools.some((t) => CAP_TOOLS.includes(t)),
    tools,
  };
}

test('🔴 H5：它说话像 **DSH 本人**，不像琥珀（人格特征串一个字都没有）', async () => {
  const { relay } = makeRelay();
  const ws = new FakeWs();
  relay.attach(ws);
  await waitFor(() => ws.states().find((m) => m.s === 'ready'), 'state:ready');
  ws.fromClient({ t: 'say', text: '你好' });
  await waitFor(() => ws.raws().find((m) => m?.params?.event?.type === 'assistant/message'), 'assistant/message');

  const j = judgeH5(ws.raws());
  assert.ok(j.dshOpening, `它该说 DSH 那句固定开场；实际系统消息里是：${JSON.stringify(ws.raws().find((m) => m?.params?.event?.type === 'system/message'))}`);
  assert.ok(j.noAmber, `流里出现了琥珀人格的特征串「${AMBER_MARK}」`);
  assert.ok(j.noCapsTools, `工具清单里多出了能力层那几条：${JSON.stringify(j.tools)}`);
  assert.deepEqual(j.tools, DSH_TOOLS);
  relay.shutdown();
  ws.close();
});

test('🔴 H5 反例①：**把人格 patch 挂上**（在 spawn 那一层塞进去）⇒ 同一条判据必须红', async () => {
  // ⚠️ 这就是"漏挂了一层"那个 bug 的真形状：参数里多了 `--patch <persona>`。
  const { relay } = makeRelay({ extraArgs: ['--patch', PERSONA_PATCH] });
  const ws = new FakeWs();
  relay.attach(ws);
  await waitFor(() => ws.states().find((m) => m.s === 'ready'), 'state:ready');
  ws.fromClient({ t: 'say', text: '你好' });
  await waitFor(() => ws.raws().find((m) => m?.params?.event?.type === 'assistant/message'), 'assistant/message');

  const j = judgeH5(ws.raws());
  assert.equal(j.noAmber, false, '挂了人格还必须红 —— 不红就说明这条判据是空的');
  assert.equal(j.dshOpening, false, '挂了人格它就不说 DSH 那句了');
  assert.ok(JSON.stringify(ws.raws()).includes(AMBER_MARK));
  relay.shutdown();
  ws.close();
});

test('🔴 H5 反例②：**把能力层 patch 挂上** ⇒ 工具清单那条也必须红', async () => {
  const { relay } = makeRelay({ extraArgs: ['--patch', CAPS_PATCH] });
  const ws = new FakeWs();
  relay.attach(ws);
  await waitFor(() => ws.states().find((m) => m.s === 'ready'), 'state:ready');
  ws.fromClient({ t: 'say', text: '你好' });
  await waitFor(() => ws.raws().find((m) => m?.params?.event?.type === 'request/header'), 'request/header');
  const j = judgeH5(ws.raws());
  assert.equal(j.noCapsTools, false, '挂了能力层就多出账本/小程序那几样 ⇒ 必须红');
  assert.ok(j.tools.includes('ledger_append'));
  relay.shutdown();
  ws.close();
});

test('它自己**不会**给那个进程挂人格/能力层（正例的负向对照）', () => {
  const { persona, capabilities, patches } = voiceFor(harnessArgs({ agentProfile: 'sdk', modelPatchPath: MODEL_PATCH }));
  assert.equal(persona, false);
  assert.equal(capabilities, false);
  assert.deepEqual(patches, [MODEL_PATCH]);
});

// ── 路径常量 ─────────────────────────────────────────────────

test('路径就是 `/api/harness`（和 `ASR_PATH` 同一个形状，别改）', () => {
  assert.equal(HARNESS_PATH, '/api/harness');
  const { relay } = makeRelay();
  assert.equal(relay.path, HARNESS_PATH);
  relay.shutdown();
});
