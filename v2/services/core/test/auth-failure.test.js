// **失败那一档要说成人话**：上游说"钥匙不对"时，屏幕上的那句话。
//
// 契约依据：`docs/dev/44-CONTAINER-MODEL-KEY.md` §六.1。
//
// ── 为什么单独立一份闸 ────────────────────────────────────
// 这是主人 2026-09-21 那句 *"apikey 是否完成也需要测试才行"* 挖出来的东西：
// dsh 在 `turn/end` 里**把原因说得很清楚**（`code:'AUTH'`, `status:401`），
// 而翻译层原来**一律**说"这条我没说完就断了"。
// ⇒ 用户拿到的是一句**他没法行动**的话，于是他会一遍遍重试 ——
//    而真正该做的是回去把那串钥匙重新填一次。
//
// ⚠️ 判据的形状：**每一条都要有负向对照**。
//    "认得出 AUTH" ≠ "把别的失败也说成 AUTH" —— 后者会让人白改一遍钥匙。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTH_LINE,
  EMPTY_LINE,
  INTERRUPTED_LINE,
  TRUNCATED_LINE,
  TurnTranslator,
  isAuthFailure,
} from '../src/session-translate.js';
import { EventEmitter } from 'node:events';

import { Dispatcher } from '../src/dispatcher.js';
import { collector, tempTimeline } from './helpers.js';

// ══ ① 纯函数：认得出 / 认不出 ═══════════════════════════════

test('认得出：`code:"AUTH"` 那一种（dsh 真机上给的就是这个形状）', () => {
  const data = {
    turn: 1,
    reason: {
      kind: 'error',
      error: {
        message: 'Authentication Fails, Your api key: ****0000 is invalid',
        code: 'AUTH',
        status: 401,
      },
    },
  };
  assert.equal(isAuthFailure(data), true);
});

test('认得出：只给了 `status:401`（没有 `code`）也算', () => {
  assert.equal(isAuthFailure({ turn: 1, reason: { kind: 'error', error: { status: 401 } } }), true);
  assert.equal(
    isAuthFailure({ turn: 1, reason: { kind: 'error', failure: { code: 'auth' } } }),
    true,
    '小写也算（大小写不该决定用户看到什么）',
  );
});

test('🔴 负向对照：别的失败**不许**被说成"钥匙不对"', () => {
  // ⚠️ 说错了的代价是实打实的：用户会回去把一把好好的钥匙改掉，
  //    然后问题还在 —— 而他会以为是自己的错。
  const others = [
    { turn: 1, reason: { kind: 'completed' } },
    { turn: 1, reason: { kind: 'max-tokens' } },
    { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', status: 429 } } },
    { turn: 1, reason: { kind: 'error', error: { code: 'UPSTREAM', status: 502 } } },
    { turn: 1, reason: { kind: 'error', error: { message: 'socket hang up' } } },
    { turn: 1, reason: { kind: 'error' } },
    { turn: 1 },
    {},
    null,
  ];
  for (const d of others) {
    assert.equal(isAuthFailure(d), false, `${JSON.stringify(d)} 不该被认成"钥匙不对"`);
  }
});

test('认不出东西时不许抛（它是收口路上的一段，抛了会把收口带走）', () => {
  assert.equal(isAuthFailure(undefined), false);
  assert.equal(isAuthFailure({ reason: { error: 'a string' } }), false);
  assert.equal(isAuthFailure({ reason: { error: 42 } }), false);
});

// ══ ② 真跑一遍翻译层：屏幕上到底出了哪句话 ═════════════════

/** 喂一轮并返回**用户能看到的那句话**（盘上那些 `message/text`）。 */
function sayOnce(reason) {
  const { timeline } = tempTimeline();
  // ⚠️ 用**订阅**取，而不是去读盘：这一条验的是"屏幕上会出哪句话"，
  //    而屏幕上那些字就是订阅者拿到的东西（读盘会绕开这一层）。
  const c = collector();
  timeline.subscribe(c.fn);
  const t = new TurnTranslator({ timeline });
  t.handle({ event: { type: 'turn/start', data: { turn: 1 } } });
  t.handle({ event: { type: 'turn/end', data: { turn: 1, reason } } });
  return c.got
    .filter((e) => e.type === 'message/text')
    .map((e) => e.text)
    .join('');
}

test('🔴 钥匙不对 ⇒ 屏幕上就是"钥匙不对"（不是那句含糊的"没说完就断了"）', () => {
  const text = sayOnce({
    kind: 'error',
    error: { message: 'Authentication Fails, Your api key: ****0000 is invalid', code: 'AUTH', status: 401 },
  });
  assert.equal(text, AUTH_LINE);
  assert.notEqual(text, INTERRUPTED_LINE, '🔴 含糊那句不许再出现');
});

test('负向对照：别的失败 ⇒ 还是原来那句（这次改动没有波及它们）', () => {
  // ⚠️ 对着**同一份出处**比（`session-translate.js` 里那几个常量），
  //    不在这里手抄一遍 —— 抄一遍就是"两处数字"，它们一定会漂。
  assert.equal(sayOnce({ kind: 'error', error: { code: 'UPSTREAM', status: 502 } }), INTERRUPTED_LINE);
  // ⚠️ `max-tokens` 且**一句话都没说**时走的是"没说完"那句，不是"被截断"那句 ——
  //    因为"截断"是**给已经说了半句的那种**用的（见 `#onTurnEnd` 两个分支）。
  //    这是既有行为，这次改动**没有碰它**（负向对照要如实反映现状，不是我希望的样子）。
  assert.equal(sayOnce({ kind: 'max-tokens' }), INTERRUPTED_LINE);
  // 而"说了半句、然后被截断"那一种才用 `TRUNCATED_LINE`
  assert.ok(TRUNCATED_LINE.length > 0);
  // 🔴 2026-09-22 主人真机栽过：只说"我没说完"，用户**既没拿到东西也不知道该说什么**
  //    ⇒ 这句话必须带一条**照着做就有用**的下一步。
  assert.match(TRUNCATED_LINE, /接着说/, '🔴 必须告诉他回哪句话能接着讲（只说"没说完"= 把他晾在那儿）');
  assert.ok(!/文件/.test(TRUNCATED_LINE), '⚠️ 不许往"文件"上引 —— 他没有打开那台机器上文件的路');
  assert.equal(sayOnce({ kind: 'completed' }), EMPTY_LINE);
});

test('🔴 那句"钥匙不对"里不许有内部词（尤其 `模型`）', () => {
  const text = sayOnce({ kind: 'error', error: { code: 'AUTH', status: 401 } });
  for (const w of ['模型', '工作区', '口令', '客户端', '云端', '服务器', '调度器', '时间线', '作用域', '会话', '搜索', '上下文', '系统提示']) {
    assert.ok(!text.includes(w), `界面上出现了内部词「${w}」：${text}`);
  }
});

// ══ ③ 调度器那一侧：宿主得**知道**这件事（不然用户回不去填钥匙那一屏）

/** 一个假 runtime（只要 `agent()` 与 `stop()`）——调度器只调这两个。 */
function stubRuntime() {
  const agent = new EventEmitter();
  agent.prompt = async () => ({ messageId: 'm_1' });
  return { agent: () => agent, stop: async () => {}, _agent: agent };
}

function makeDispatcher(onAuthFailure) {
  const { store, timeline } = tempTimeline();
  const runtime = stubRuntime();
  const d = new Dispatcher({
    timeline,
    runtime,
    scopeId: 'main',
    agentKey: 'u1/main',
    store,
    recap: {},
    onAuthFailure,
  });
  return { d, runtime };
}

test('🔴 上游说"钥匙不对" ⇒ 调度器**叫一声**（宿主据此让用户能重填）', async () => {
  let called = 0;
  const { d, runtime } = makeDispatcher(() => {
    called += 1;
  });
  await d.deliver('你好'); // 先挂上监听（`#ensureAgent` 才接线）
  runtime._agent.emit('session-event', {
    event: {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'error', error: { code: 'AUTH', status: 401 } } },
    },
  });
  assert.equal(called, 1);
});

test('负向对照：别的失败**不许**叫那一声（叫错了会把人好好的钥匙标成坏的）', async () => {
  let called = 0;
  const { d, runtime } = makeDispatcher(() => {
    called += 1;
  });
  await d.deliver('你好');
  const others = [
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'UPSTREAM', status: 502 } } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
  ];
  for (const e of others) runtime._agent.emit('session-event', { event: e });
  assert.equal(called, 0);
});

test('回调抛了也不许把这一轮带走（它只是记账）', async () => {
  const { d, runtime } = makeDispatcher(() => {
    throw new Error('记账炸了');
  });
  await d.deliver('你好');
  assert.doesNotThrow(() => {
    runtime._agent.emit('session-event', {
      event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'AUTH' } } } },
    });
  });
});

// ══ ④ 通道那一侧：容器说"那把钥匙不灵了" ⇒ 宿主必须把"有钥匙"这条记忆撤掉

test('🔴 容器说 `key-bad` ⇒ 通道撤掉"有钥匙"，并叫一声（宿主据此标成用不了）', async (t) => {
  const { TenantChannel } = await import('../src/tenant-channel.mjs');
  const nodeNet = await import('node:net');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  const nodeFs = await import('node:fs');

  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-kb-'));
  const seen = [];
  const ch = new TenantChannel({
    dir,
    keyFor: () => null,
    onKeyBad: (t, why) => seen.push([t, why]),
    log: () => {},
  });
  // ⚠️ **一定要在这里收干净**（项目里为这个挂过不止一次）：
  //    通道是个真的 `net.Server`，不收它事件循环就一直转 ⇒ 测试进程**挂住不退出**，
  //    而现象是"跑了 60 秒什么都没输出"（看起来像断言失败，其实根本没跑到断言）。
  t.after(() => {
    try {
      ch.close();
    } catch {
      /* 已经关了 */
    }
  });
  ch.listenFor('hupo-a');

  // 假装是容器那条隧道连进来（说它**有**钥匙），再说一句"那把不灵了"
  const conn = nodeNet.connect(nodePath.join(dir, 'hupo-a', 'channel.sock'));
  await new Promise((r) => conn.once('connect', r));
  conn.write(`${JSON.stringify({ v: 1, type: 'tunnel-ready', hasKey: true })}\n`);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(ch.hasKeyFor('hupo-a'), true, '先说它有');

  conn.write(`${JSON.stringify({ v: 1, type: 'key-bad' })}\n`);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(ch.hasKeyFor('hupo-a'), false, '🔴 说了不灵之后，宿主不该还记着"有钥匙"');
  assert.deepEqual(seen, [['hupo-a', 'rejected']], '宿主得被叫一声（它才标得成"要重填"）');
  conn.destroy();
});

// ══ ⑤ 🔴 **接线那一段**（这一条是为了一个真栽过的坑加的）
//
// 2026-09-21 实测：`Dispatcher` 那两条用例全绿，可**线上一点反应都没有**。
// 根因：`Worlds` 的构造函数里**少了一行** `this.#onAuthFailure = onAuthFailure;`
//   —— 参数加了、往下传的那一行也加了，就是**没存下来**。
// ⇒ 上面那些用例都是**直接打 `Dispatcher`** 的，绕过了 `Worlds` 这一段接线。
// ⇒ 所以这一条**从外面打进来**：造一个真的 `Worlds`，走它给的那条路。

test('🔴 `Worlds` 必须把 `onAuthFailure` 真的存下来并转给调度器（缺一行就静默断掉）', async () => {
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  const { Worlds } = await import('../src/worlds.js');

  const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-w-'));
  const cfg = {
    dataDir,
    dshHome: nodePath.join(dataDir, '__dsh__'),
    agentCwd: nodePath.join(dataDir, '__cwd__'),
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
    capabilitiesPath: null,
    modelPatchPath: null,
    recap: {},
    turnDeadlineMs: 60_000,
  };
  nodeFs.mkdirSync(cfg.dshHome, { recursive: true });
  nodeFs.mkdirSync(cfg.agentCwd, { recursive: true });

  const agent = new EventEmitter();
  agent.prompt = async () => ({ messageId: 'm_1' });
  const runtime = { agent: () => agent, stop: async () => {} };

  const seen = [];
  const worlds = new Worlds({
    cfg,
    runtime,
    log: () => {},
    warn: () => {},
    onAuthFailure: (uid) => seen.push(uid),
  });
  try {
    const w = worlds.worldFor('u1');
    await w.dispatcher.deliver('你好');
    agent.emit('session-event', {
      event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'AUTH' } } } },
    });
    // ⚠️ 断言里**要带 userId** —— 回调必须知道"是谁那一把不灵了"
    assert.deepEqual(seen, ['u1'], 'Worlds 这一段接线断了（参数存下来了吗）');
  } finally {
    worlds.closeSockets?.();
  }
});

test('🔴 容器说"我这儿没有钥匙"（`tunnel-ready hasKey:false`）⇒ 宿主清账，但**不许**标成坏的', async (t) => {
  // ⚠️ 这一条钉的是一个很容易犯的错：把它和"上游说钥匙不对"混成一种，
  //    容器每重启一次就会把用户一把**好好的**钥匙标成"要重填"。
  const { TenantChannel } = await import('../src/tenant-channel.mjs');
  const nodeNet = await import('node:net');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  const nodeFs = await import('node:fs');

  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-abs-'));
  const seen = [];
  const ch = new TenantChannel({ dir, keyFor: () => null, onKeyBad: (t, why) => seen.push([t, why]), log: () => {} });
  t.after(() => {
    try {
      ch.close();
    } catch {
      /* 已经关了 */
    }
  });
  ch.listenFor('hupo-a');

  const conn = nodeNet.connect(nodePath.join(dir, 'hupo-a', 'channel.sock'));
  await new Promise((r) => conn.once('connect', r));
  conn.write(`${JSON.stringify({ v: 1, type: 'tunnel-ready', hasKey: false })}\n`);
  await new Promise((r) => setTimeout(r, 60));

  assert.deepEqual(seen, [['hupo-a', 'absent']], '要说清是"它没有"，不是"它说那把坏了"');
  assert.equal(ch.hasKeyFor('hupo-a'), false);
  conn.destroy();
});

test('🔴 领到一把之后**还要接着守**（不然换的那把 / 重填的那把没人接）', async (t) => {
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  const nodeNet = await import('node:net');
  const { writeKeyFile } = await import('../src/tenant-shell.mjs');
  const { TenantChannel } = await import('../src/tenant-channel.mjs');

  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-wk-'));
  const keyFile = nodePath.join(dir, 'creds.yaml');
  let key = 'sk-first-0000';
  const ch = new TenantChannel({
    dir,
    keyFor: () => key,
    log: () => {},
  });
  t.after(() => {
    try {
      ch.close();
    } catch {
      /* 已经关了 */
    }
  });
  ch.listenFor('hupo-a');

  // ⚠️ 真的起那个"守钥匙"的后台循环（与容器里跑的是**同一份代码**）
  const { watchForKey } = await import('../src/tenant-shell.mjs');
  const w = watchForKey({
    socketPath: nodePath.join(dir, 'hupo-a', 'channel.sock'),
    keyFile,
    attemptMs: 800,
    idleMs: 60,
    log: () => {},
  });
  t.after(() => w.stop());

  // ① 第一把：等它落盘
  const first = await waitFor(() => nodeFs.existsSync(keyFile), 4000);
  assert.ok(first, '第一把没送到');
  assert.match(nodeFs.readFileSync(keyFile, 'utf8'), /sk-first-0000/);

  // ② 宿主换一把（模拟"他那把不灵了、重新填一把"）⇒ 必须**也**送得到
  key = 'sk-second-1111';
  const second = await waitFor(
    () => nodeFs.existsSync(keyFile) && nodeFs.readFileSync(keyFile, 'utf8').includes('sk-second-1111'),
    5000,
  );
  assert.ok(second, '🔴 第二把没送到 —— 那个循环领到一把就收工了');

  writeKeyFile(keyFile, key); // 静音那个未用告警
});

/** 等到 `fn()` 为真（或超时）。 */
async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (fn()) return true;
    } catch {
      /* 还没好 */
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}
