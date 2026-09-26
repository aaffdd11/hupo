// 过程四档（决策 **D7 / D7.1–D7.4** · 契约 `docs/dev/26-PROCESS-LEVELS.md`）。
//
// 这一篇守两件**最容易做错、代价最大**的事：
//
//   ① 🔴 **泄露闸**（契约 §二）：**推理原文与步骤**是**瞬态**的 ——
//      新连接 `sinceSeq=0` 重放**拿不到一个字节**，盘上的日志也**grep 不到**。
//      为什么这么贵：`emit()` 会落盘，而新连接会 replay 全部历史 ⇒
//      一段走了 `emit()` 的推理原文，**以后每个连上来的人都能拿到**。
//      ★ **`116`（2026-09-26 主人："首先全部开放"）改了这条闸的另一半**：
//        **工具名 / 入参 / 输出摘要 / 每轮用量 / 系统提示词** 从"内部词，一个字节都不许出去"
//        改成 **持久事件**（有号、落盘、翻页与重连都拿得到）——契约 `docs/dev/116`。
//        ⇒ 这一份判据现在钉的是**两件事同时成立**：
//          · 推理原文与 `step/*` **仍然**一个字节都不落盘；
//          · 工具行那几样**必须**落盘（否则"全部开放"是假的）。
//
//   ② **四档那道闸只管"过程"这一路**（`server.js` `levelAllows`）。
//      这条是**踩过坑补的**：早先写成白名单，默认档把 `user/echo`、
//      `turn/*` 一起挡掉了 —— 补发那一路不过闸，所以 replay 全绿、
//      只有"连上之后新说的一句"红。判据：**默认档 = 加四档之前的行为**。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import WebSocket from 'ws';

import { Auth } from '../src/auth.js';
import { SayService } from '../src/say.js';
import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';
import { TurnTranslator, stepStateForTool } from '../src/session-translate.js';
import {
  DEFAULT_PROCESS_LEVEL,
  PROCESS_LEVELS,
  createServer,
  levelAllows,
  parseLevel,
} from '../src/server.js';

/** 那一段**绝不许出去**的推理原文（grep 用它）。 */
const SECRET = '推理原文样本-别让任何人看见-7f3a9c';
/** `116`：系统提示词那一段（它**应该**落盘 —— "全部开放"）。 */
const SYS_PROMPT = '系统提示词样本-该落盘-116';
/** 它**应该**落盘（正对照：证明"grep 不到"不是因为什么都没写）。 */
const VISIBLE = '好的，我查到了。';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一条时间线 + 翻译层；把推出来的事件分成"落盘的"和"瞬态的"。 */
function bench() {
  const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-lv-'));
  const store = new Store({ dataDir, fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const transient = [];
  const persisted = [];
  timeline.subscribe((e) => {
    // 落盘的带 `seq`（`emit` 取号），瞬态没有（`emitTransient` 不取号）
    if ('seq' in e) persisted.push(e);
    else transient.push(e);
  });
  const translator = new TurnTranslator({ timeline });
  return { dataDir, store, timeline, translator, transient, persisted };
}

/** 盘上那段原始字节（没有日志 ⇒ 空串，不是异常）。 */
function disk({ store }) {
  const p = store.pathFor('main');
  return nodeFs.existsSync(p) ? nodeFs.readFileSync(p, 'utf8') : '';
}

/** 真起一个服务，时间线用给进来的那一条。 */
async function serveOn(b) {
  const authDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-lv-auth-'));
  const auth = new Auth({ dataDir: authDir, lockAfter: 3, lockMs: 60_000 });
  const password = '正确的密码啦';
  auth.setPassword(password);
  const say = new SayService({ timeline: b.timeline, store: b.store, timelineId: 'main' });
  const { listen, close } = createServer({
    timeline: b.timeline, store: b.store, auth, say, webRoot: null, buildId: 'lv-test',
  });
  const addr = await listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const login = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const { token } = await login.json();
  return { origin, token, wsUrl: `ws://127.0.0.1:${addr.port}/api/stream`, close };
}

/** 连一条流；`level` 不带 ⇒ 默认档（就是"加四档之前"的那种连接）。 */
function wsConnect(wsUrl, { token, sinceSeq = 0, level = null, dev = false } = {}) {
  const q = new URLSearchParams({ sinceSeq: String(sinceSeq) });
  if (level) q.set('level', level);
  if (dev) q.set('dev', '1');
  const ws = new WebSocket(`${wsUrl}?${q}`, ['bearer', token]);
  const frames = [];
  return new Promise((resolve, reject) => {
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) =>
      reject(Object.assign(new Error('rejected'), { status: res.statusCode })));
  });
}

/** 喂一整轮：开轮 → 起一步 → 调一个工具 → 边想边说 → 收口。 */
function feedOneTurn(t, { name = 'web_search' } = {}) {
  t.handle({ event: { type: 'turn/start', data: { turn: 1 } } });
  t.handle({ event: { type: 'step/start', data: { turn: 1, step: 1 } } });
  t.handle({
    event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call_1', name, arguments: '{}' } },
  });
  t.handle({
    event: {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'reasoning', text: SECRET }, { type: 'text', text: VISIBLE }],
        },
      },
    },
  });
  t.handle({ event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } });
}

// ── 一、🔴 泄露闸 ────────────────────────────────────────────

test('🔴 泄露闸（盘）：推理原文与步骤**仍然**不落盘；而工具行/用量**必须**落盘（`116` 全部开放）', () => {
  const b = bench();
  feedOneTurn(b.translator);
  b.translator.handle({ event: { type: 'system/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: SYS_PROMPT }] } } } });

  const raw = disk(b);
  assert.ok(raw.includes(VISIBLE), '★ 正对照：它说的话**应该**在盘上（否则"grep 不到"是假绿）');
  assert.ok(!raw.includes(SECRET), '★ 推理原文绝不许落盘 —— 它会 replay 给每一个新连接');
  assert.ok(!raw.includes('step/start'), '★ 步骤是过程噪音，也不许落盘');
  // ★ `116`：这三样**必须**在盘上（主人 2026-09-26：*"首先全部开放"*）
  assert.ok(raw.includes('web_search'), '★ 工具名要落盘（不然"全部开放"是假的）');
  assert.ok(raw.includes('"type":"tool/call"'), '★ 工具行要落盘（有号、翻页拿得到）');
  assert.ok(raw.includes('"callId":"call_1"'), '★ callId 要在（结果行靠它配回调用行）');
  assert.ok(raw.includes('"type":"turn/usage"'), '★ 每轮用量要落盘');
  assert.ok(raw.includes(SYS_PROMPT), '★ 系统提示词要落盘');
  // ⚠️ 反着验：这条闸不是恒真 —— 认不出的档/TYPE 不会被顺手写进去
  assert.ok(!raw.includes('reasoning/delta'), '★ 推理那一路仍然一个字节都不许落盘');
});

test('🔴 泄露闸（重放）：新连接 `sinceSeq=0` 收不到推理原文；但**收得到工具行**（`116`）', async (t) => {
  const b = bench();
  feedOneTurn(b.translator);

  const srv = await serveOn(b);
  // ⚠️ 收尾挂在 `t.after` 上：断言失败也要把这个服务关掉 ——
  //    否则一个挂着的 HTTP server 会让整个测试文件**永远不退出**（2026-09-26 真栽过一次）。
  t.after(() => srv.close());
  // ⚠️ 用**默认档**连：这一条要证明的是"盘上根本没有"，
  //    而不是"某一档把它挡了"（档位是第二道，不是地基）。
  const { ws, frames } = await wsConnect(srv.wsUrl, { token: srv.token, sinceSeq: 0 });
  await wait(80);
  ws.close();

  const blob = JSON.stringify(frames);
  assert.ok(!blob.includes(SECRET), '★ 重放里绝不许有推理原文');
  assert.ok(!frames.some((f) => f.type === 'reasoning/delta'), '★ 一条都没有');
  assert.ok(!blob.includes('step/start'), '★ 步骤也不许重放（它没落盘）');
  // 正对照：重放**确实**把落盘的东西给了（不然上面几条可能是"什么都没发"）
  assert.ok(blob.includes(VISIBLE), '★ 正对照：落盘的正文必须在重放里');
  // ★ `116`：工具行这一半**必须**在重放里（默认档也要给 —— 它不是"过程"那一档的事）
  assert.ok(blob.includes('web_search'), '★ 工具名要在重放里');
  assert.ok(frames.some((f) => f.type === 'tool/call'), '★ 工具行要在重放里');
});

// ── 二、四档那道闸 ──────────────────────────────────────────

test('🔴 回归闸：默认档 = 加四档之前的行为 —— **非过程事件每一档都发**', () => {
  const 与档位无关 = [
    'user/echo', 'turn/start', 'turn/end', 'title',
    'message/start', 'message/text', 'message/end', 'agent/mutated',
  ];
  for (const level of PROCESS_LEVELS) {
    for (const type of 与档位无关) {
      assert.equal(
        levelAllows({ type }, { level }),
        true,
        `★ ${level} 档把 ${type} 丢了 —— 档位调的是"过程说多少"，不是"时间线还剩什么"`,
      );
    }
  }
});

test('四档是**累加的梯子**：每一档多给哪几样，一格一格对', () => {
  const 过程 = {
    'message/status': ['doing', 'steps', 'reasoning'],
    'step/start': ['steps', 'reasoning'],
    'step/end': ['steps', 'reasoning'],
    'reasoning/delta': ['reasoning'],
  };
  for (const [type, allows] of Object.entries(过程)) {
    for (const level of PROCESS_LEVELS) {
      assert.equal(
        levelAllows({ type }, { level }),
        allows.includes(level),
        `${level} 档对 ${type} 的判断不对`,
      );
    }
  }
});

test('安静档要**真的安静**：`message/status` 也不发（契约 §四点名要验）', () => {
  assert.equal(levelAllows({ type: 'message/status' }, { level: 'quiet' }), false);
  assert.equal(levelAllows({ type: 'message/status' }, { level: 'doing' }), true);
});

test('`dev=1` 是**附加**通道：只加不减，而且不许把推理原文带进来', () => {
  // 只加：quiet + dev ⇒ 步骤放行
  assert.equal(levelAllows({ type: 'step/start' }, { level: 'quiet', dev: true }), true);
  // 不减：dev 不会顺手把 status 也开了（那是档位的事）
  assert.equal(levelAllows({ type: 'message/status' }, { level: 'quiet', dev: true }), false);
  // ★ 最要紧的一条：`dev=1` **绝不**等于"能看推理原文"（那是主人一个人的档）
  assert.equal(levelAllows({ type: 'reasoning/delta' }, { level: 'quiet', dev: true }), false);
  assert.equal(levelAllows({ type: 'reasoning/delta' }, { level: 'steps', dev: true }), false);
});

test('认不出来的档 ⇒ **默认档**，不报错也不拒连接（N10：宁可少说，不能不说）', () => {
  assert.equal(DEFAULT_PROCESS_LEVEL, 'doing');
  assert.deepEqual([...PROCESS_LEVELS], ['quiet', 'doing', 'steps', 'reasoning']);
  assert.equal(parseLevel('level=reasoning'), 'reasoning');
  assert.equal(parseLevel('sinceSeq=3&level=steps'), 'steps');
  assert.equal(parseLevel('level=REASONING'), 'doing', '大小写不同 = 认不出来');
  assert.equal(parseLevel('level='), 'doing');
  assert.equal(parseLevel('level=从来没见过的新档'), 'doing', '客户端比服务端新 ⇒ 按默认档服务');
  assert.equal(parseLevel('dev=1'), 'doing');
  assert.equal(parseLevel(null), 'doing');
  assert.equal(parseLevel(undefined), 'doing', '没有 query 也是默认档');
});

test('四档端到端：quiet 真安静 · doing 有状态 · steps 有步骤 · reasoning 才有原文', async () => {
  const b = bench();
  const srv = await serveOn(b);
  try {
    const conns = {};
    for (const level of PROCESS_LEVELS) {
      conns[level] = await wsConnect(srv.wsUrl, { token: srv.token, level });
    }
    // 连上之后才发（瞬态事件**不会**补发，所以必须"活着"才收得到）
    b.timeline.emitTransient({ type: 'message/status', state: 'started' });
    b.timeline.emitTransient({ type: 'step/start', turn: 1, step: 1, state: 'searching' });
    b.timeline.emitTransient({ type: 'reasoning/delta', turn: 1, text: SECRET });
    // 一件与档位无关的事：用户自己刚说的一句（实时，不是补发）
    b.timeline.emit({ type: 'user/echo', messageId: 'u_live', text: '连上之后说的' });
    await wait(100);

    const types = (level) => conns[level].frames.map((f) => f.type);
    for (const level of PROCESS_LEVELS) {
      assert.ok(
        conns[level].frames.some((f) => f.messageId === 'u_live'),
        `★ ${level} 档丢了用户自己的回声（实时那一路）`,
      );
    }
    for (const level of ['quiet']) {
      assert.ok(!types(level).includes('message/status'), '★ 安静档连"在做什么"都不发');
      assert.ok(!types(level).includes('step/start'));
      assert.ok(!types(level).includes('reasoning/delta'));
    }
    assert.ok(types('doing').includes('message/status'));
    assert.ok(!types('doing').includes('step/start'), '第②档不发步骤');
    assert.ok(types('steps').includes('step/start'));
    assert.ok(!types('steps').includes('reasoning/delta'), '第③档看不到推理原文');
    assert.ok(types('reasoning').includes('reasoning/delta'));
    assert.ok(types('reasoning').includes('step/start'), '第④档在梯子最上面，也收步骤');

    // ★ 推理原文只在第④档那条连接上出现过，而且**没有** `seq`（瞬态）
    const 原文帧 = conns.reasoning.frames.filter((f) => f.type === 'reasoning/delta');
    assert.equal(原文帧.length, 1);
    assert.ok(!('seq' in 原文帧[0]), '★ 推理原文不许占号');
    assert.ok(!JSON.stringify(conns.quiet.frames).includes(SECRET));
    assert.ok(!JSON.stringify(conns.steps.frames).includes(SECRET));

    for (const level of PROCESS_LEVELS) conns[level].ws.close();
  } finally {
    await srv.close();
  }
});

test('安静档的闸也在**控制器**那一侧（服务端不发 ≠ 屏幕上不显示）', async () => {
  // ⚠️ 这一条是**契约 §6.3 第 1 条**的指针：`timeline.agentLine` 有一条
  //    **与档位无关**的兜底（"有没收口的气泡 ⇒ 推得出它在做"）。
  //    所以客户端必须自己按档位压住那行提示 —— 光靠服务端不发 `message/status`
  //    是不够的。客户端那半边在 `test/unit/process_steps_test.dart`，
  //    这里只钉住"服务端确实没发"，别让两边都以为对方管了。
  assert.equal(levelAllows({ type: 'message/status' }, { level: 'quiet' }), false);
});

// ── 三、步骤的**类别**（契约 §6.1）─────────────────────────

test('工具名 → 类别：只认名字、认不出来不猜（N10）', () => {
  assert.equal(stepStateForTool('web_search'), 'searching');
  assert.equal(stepStateForTool('web_fetch'), 'searching');
  assert.equal(stepStateForTool('read'), 'reading');
  assert.equal(stepStateForTool('grep'), 'reading');
  assert.equal(stepStateForTool('read_image'), 'reading');
  assert.equal(stepStateForTool('write'), 'writing');
  assert.equal(stepStateForTool('edit'), 'writing');
  assert.equal(stepStateForTool('bash'), 'running');
  assert.equal(stepStateForTool('job_list'), 'running', '`job_*` 都是"在动手做"');
  assert.equal(stepStateForTool('从来没见过的新工具'), 'thinking', '认得出是工具 ⇒ 说"在琢磨"');
  // ★ 认不出来 ⇒ `null`（**不补**），绝不是"猜一个"
  assert.equal(stepStateForTool(''), null);
  assert.equal(stepStateForTool(null), null);
  assert.equal(stepStateForTool(undefined), null);
  assert.equal(stepStateForTool(42), null);
});

test('契约 §6.1：`tool/call` 到了 ⇒ 给**同一个 (turn, step)** 补一次带类别的状态', () => {
  const b = bench();
  b.translator.handle({ event: { type: 'turn/start', data: { turn: 1 } } });
  b.translator.handle({ event: { type: 'step/start', data: { turn: 1, step: 1 } } });
  b.translator.handle({
    event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call_1', name: 'web_search', arguments: '{}' } },
  });

  const steps = b.transient.filter((e) => e.type === 'step/start');
  assert.equal(steps.length, 2, '两条：先"开始了"，再补"在查资料"');
  assert.equal(steps[0].state, 'started', '第一条能诚实说的只有"开始了"');
  assert.equal(steps[1].state, 'searching');
  assert.equal(steps[1].turn, 1);
  assert.equal(steps[1].step, 1);

  // ★ 工具名（和 callId）**绝不许**出现在发出去的东西里 —— 界面上不许有内部词
  const blob = JSON.stringify(b.transient);
  assert.ok(!blob.includes('web_search'), '★ 工具名不许发给客户端');
  assert.ok(!blob.includes('callId'), '★ 连 callId 也不发');
});

test('只补**已经报过**的步：没先 `step/start` 就不许凭空造一个', () => {
  const b = bench();
  b.translator.handle({
    event: { type: 'tool/call', data: { turn: 7, step: 3, callId: 'c', name: 'read' } },
  });
  assert.equal(
    b.transient.filter((e) => e.type === 'step/start').length,
    0,
    '★ 凭空造的步等不到 `step/end` ⇒ 屏幕上挂成"永远在读东西"（H4 不许）',
  );
});

test('补发也走**瞬态**：不占号、不落盘', () => {
  const b = bench();
  feedOneTurn(b.translator); // 里面就有一次 web_search 的补发
  const 全部过程 = b.transient.filter((e) => String(e.type).startsWith('step/') || e.type === 'reasoning/delta');
  assert.ok(全部过程.length >= 3, '应该有 step/start、补发的 step/start、step/end');
  for (const e of 全部过程) assert.ok(!('seq' in e), '★ 过程事件不许占号');
  const raw = disk(b);
  assert.ok(!raw.includes('step/'), '★ 也不许落盘');
  assert.ok(!raw.includes('reading') && !raw.includes('searching'), '★ 类别名同样不许落盘');
});

test('这一轮的步骤账**跟着轮一起清**（不许跨轮串号）', () => {
  const b = bench();
  b.translator.handle({ event: { type: 'turn/start', data: { turn: 1 } } });
  b.translator.handle({ event: { type: 'step/start', data: { turn: 1, step: 1 } } });
  b.translator.handle({ event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } });
  // 轮 1 已经收口；现在轮到第 1 号步再来一次 `tool/call` ⇒ 不许补（账清了）
  b.translator.handle({
    event: { type: 'tool/call', data: { turn: 2, step: 1, callId: 'c', name: 'read' } },
  });
  assert.equal(
    b.transient.filter((e) => e.type === 'step/start' && e.turn === 2).length,
    0,
    '★ 第 2 轮的第 1 号步还没报过，不许补',
  );
});
