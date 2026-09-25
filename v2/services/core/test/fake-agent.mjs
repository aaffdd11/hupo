// 假 agent：说和 `dsh --profile sdk` **同一套** JSON-RPC。
//
// 为什么要有它：真 agent 一次调用要花钱、要几秒、还要网络。
// 但"spawn + stdio + 协议"这一段**必须真跑**——用 mock 替换掉它，
// 就等于把最容易错的那一段（分帧、代号、退出、收尾）排除在测试之外。
//
// 场景由环境变量 `FAKE_SCENARIO` 选：
//   normal     正常一轮（含**推理原文**——用来验它不会被推给用户）
//   truncated  turn/end 的 reason 是 max-tokens（半句）
//   silent     一句话都不说就收尾（不许留白）
//   crash      中途进程退出（必须收口）
//   slow       答得很慢（用来验淘汰前会先收口）
//   two-step   两步：先应一声（quick），再给结论（deep）
//   hang       一轮开始之后**永远不结束**（用来验超时硬收口；第二个 prompt 排队）
//   hang-talk  hang 的变体：**先说半句**再不结束（验"已经说了一半"那种超时）
//   hang-die   一轮开起来、**一个字都没说**，然后进程直接死
//              （验 forceClose 那条"没有 writer 也要说话"的路 —— N19）
//   tool-read  一轮里用了一个**只读**工具（`read`），正常收尾
//   tool-write 一轮里用了一个**会改东西**的工具（`write`），正常收尾
//   tool-write-die  用了会改东西的工具、说了半句，然后进程死
//              （验"动过东西的活不许自动重来"那条 —— 决策 D10.1）
//   handoff    ★ **D 期**：一轮里**调用转交那条工具**（`handoff_to` ⇒ 服务端
//              `op:'handoff'`，走**真那条域套接字**），然后正常收尾。
//              ⚠️ 这是"**只有工具调用能发起转交**"（D-1）那半的落点：
//              它发的是一帧 `tool/call` ＋ 一次**真的**套接字请求 ——
//              不是"正文里说一句我转给某一间"。
//              目标由 `FAKE_HANDOFF_TARGET` 给；套接字由 `FAKE_LEDGER_SOCKET` 给。

import fs from 'node:fs';
import nodeNet from 'node:net';

const scenario = process.env.FAKE_SCENARIO ?? 'normal';
/**
 * ⚠️ **DSH 的会话记录是"跨进程活着"的**——这是真 DSH 的行为，不是我们编的。
 *
 * 实测：`session/prompt` 对一个**已经存在**的会话 id 直接报
 * `session "main.xxx" already exists`（SDK 只能 create，不能 resume）。
 * 会话记录落在 `$DSH_HOME/sessions/` 里（实测那个目录下有 19 个 `main.<bootId>`）。
 *
 * 为什么假 agent 也要模拟这一条：**真 bug 差点漏过去。**
 * 超时硬收口会在**同一个 runtime 里**把 agent 卸掉再起一个；
 * 如果沿用同一个会话 id，用户接下来每一句都发不出去。
 * 假 agent 不模拟"已存在"的话，**这一条在 CI 里永远测不出来**
 * （它当时确实是靠端到端真 agent 才抓到的）。
 *
 * `FAKE_SESSION_FILE` 给一个路径就开启这个行为（**跨进程共享**，
 * 所以"上一个进程创建过"这件事真的能被下一个进程看见）。
 */
/**
 * ★ **D 期**：照 `mcp-ledger-server.mjs` 那一层的样子，**真的**问一次账本那口。
 *
 * 🔴 为什么假 agent 也要走这条真路：判据 D-1/D-2/D-3 打的是"**工具调用**能不能
 *    发起转交、服务端怎么裁决"——拿内存里直接调 `handoffTo()` 当证据，
 *    就把"这条工具口通不通"排除在判据外面了（`16-STREAM.md` 那条教训）。
 */
function askLedger(payload, timeoutMs = 3000) {
  const sock = process.env.FAKE_LEDGER_SOCKET ?? '';
  return new Promise((resolve) => {
    if (!sock) {
      resolve({ ok: false, error: '假 agent 没拿到套接字路径' });
      return;
    }
    const conn = nodeNet.connect(sock);
    let buf = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { conn.destroy(); } catch { /* 尽力 */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish({ ok: false, error: '那边没回话' }), timeoutMs);
    conn.setEncoding('utf8');
    conn.on('connect', () => conn.write(`${JSON.stringify(payload)}\n`));
    conn.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      try {
        finish(JSON.parse(buf.slice(0, nl)));
      } catch {
        finish({ ok: false, error: '回答读不懂' });
      }
    });
    conn.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: String(err?.code ?? err?.message ?? err) });
    });
  });
}

const sessionFile = process.env.FAKE_SESSION_FILE ?? null;
/**
 * ★ **D 期**：这一轮是在**哪一间**里跑的（服务端按房间给的 `HUPO_SCOPE`）。
 * 与真那条工具口**同一个来源**（`mcp-ledger-server.mjs` 顶上那个 `SCOPE`）——
 * 转交要"发起那一间"，而模型那边**不许**自己声称身份。
 */
const SCOPE_OF_FAKE = process.env.HUPO_SCOPE ?? 'main';
function sessionExists(id) {
  if (!sessionFile) return false;
  try {
    return fs.readFileSync(sessionFile, 'utf8').split('\n').includes(id);
  } catch {
    return false;
  }
}
function rememberSession(id) {
  if (!sessionFile) return;
  try {
    fs.appendFileSync(sessionFile, `${id}\n`);
  } catch {
    /* 记不上就算了——那是测试脚手架的事 */
  }
}

let buf = '';
let seq = 0;
let turn = 0;
const timers = [];

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    onMessage(msg);
  }
});

const reply = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);

const notifyEvent = (type, data) => {
  seq += 1;
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/event',
      params: { event: { type, seq, time: Date.now(), data } },
    })}\n`,
  );
};

const notifyStatus = (status) =>
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'session/status', params: { sessionId: 'fake', status } })}\n`,
  );

/**
 * 一次工具调用。字段形状按**实测**的真帧（`tool/call {turn, step, callId, name, arguments}`）。
 * ⚠️ 只发名字，不发参数 —— 我们这边也只看名字（决策 D10.2）。
 */
const notifyToolCall = (t, step, name) =>
  notifyEvent('tool/call', {
    turn: t,
    step,
    callId: `call_${name}_${seq}`,
    name,
    arguments: '{}',
  });

/** 一条 assistant 消息：**推理原文和正文在同一个数组里**（和真 agent 一样）。 */
const assistantMessage = (t, step, text, reasoning) =>
  notifyEvent('assistant/message', {
    turn: t,
    step,
    message: {
      role: 'assistant',
      content: [
        ...(reasoning ? [{ type: 'reasoning', text: reasoning }] : []),
        { type: 'text', text },
      ],
      source: { kind: 'model', provider: 'fake', model: 'fake' },
      id: `m_${seq}`,
    },
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 100, cacheReadTokens: 85 },
    stream: [],
  });

function onMessage(msg) {
  if (msg.method === 'initialize') {
    return reply(msg.id, { serverInfo: { name: 'fake-sdk-runtime', version: '0' } });
  }
  if (msg.method === 'shutdown') {
    reply(msg.id, {});
    setTimeout(() => process.exit(0), 10);
    return;
  }
  if (msg.method === 'session/prompt') {
    // ★ 和真 DSH 一样：**已存在**的会话 id 直接报错（只能 create，不能 resume）
    const sid = msg.params?.sessionId;
    if (sid && sessionExists(sid)) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: `session "${sid}" already exists` },
        })}\n`,
      );
      return;
    }
    if (sid) rememberSession(sid);
    // ★ 真 agent 会发 `user/message`（把收到的那几个内容块回显出来），
    //   假 agent 也发——这样"我们到底喂了什么进去"可以在**真 stdio 上**验，
    //   而不用去猜。翻译层会忽略它（它不进产品事件）。
    notifyEvent('user/message', {
      content: msg.params?.contentBlocks ?? [],
      role: 'user',
      id: `pm_${seq}`,
    });
    reply(msg.id, { messageId: `pm_${seq}` });
    turn += 1;
    runScenario(turn);
    return;
  }
  // 别的请求：一律空结果，别把客户端挂住
  if (msg.id !== undefined) reply(msg.id, {});
}

function runScenario(t) {
  // ⚠️ `hang*` 场景下：**第 2 个及以后的 prompt 一律"排队"**——
  //    真 agent 会把它塞进 inbox（`agent/inbox/spliced {target:"next-turn"}`），
  //    等当前这轮结束才变成下一轮。所以这里**连 `turn/start` 都不发**，
  //    那就是"排队中"真实的样子。
  //    （实测见 `docs/dev/07-TIMEOUT.md` §一；不这样模拟，
  //      "超时要顺手收掉排队那句"这条就永远测不出来。）
  if ((scenario === 'hang' || scenario === 'hang-talk') && t > 1) return;

  notifyStatus('running');
  notifyEvent('turn/start', { turn: t });

  switch (scenario) {
    case 'truncated':
      notifyEvent('step/start', { turn: t, step: 1 });
      assistantMessage(t, 1, '一个是「避」', '让我把这段列一下');
      notifyEvent('step/end', { turn: t, step: 1 });
      notifyEvent('turn/end', { turn: t, reason: { kind: 'max-tokens' } });
      notifyStatus('idle');
      break;

    case 'silent':
      notifyEvent('turn/end', { turn: t, reason: { kind: 'completed' } });
      notifyStatus('idle');
      break;

    case 'crash':
      notifyEvent('step/start', { turn: t, step: 1 });
      assistantMessage(t, 1, '我正在查…', '先调用工具');
      // 说到一半进程没了
      timers.push(setTimeout(() => process.exit(9), 30));
      break;

    case 'slow':
      timers.push(
        setTimeout(() => {
          notifyEvent('step/start', { turn: t, step: 1 });
          assistantMessage(t, 1, '慢的结果来了。', null);
          notifyEvent('turn/end', { turn: t, reason: { kind: 'completed' } });
          notifyStatus('idle');
        }, 1500),
      );
      break;

    case 'two-step':
      notifyEvent('step/start', { turn: t, step: 1 });
      assistantMessage(t, 1, '收到，我查一下。', '先应一声');
      notifyEvent('step/end', { turn: t, step: 1 });
      notifyEvent('step/start', { turn: t, step: 2 });
      assistantMessage(t, 2, '查到了，下周三天有雨。', '结论');
      notifyEvent('step/end', { turn: t, step: 2 });
      notifyEvent('turn/end', { turn: t, reason: { kind: 'completed' } });
      notifyStatus('idle');
      break;

    case 'hang':
      // 一轮开始，然后**什么都不发生**——永远不收口。
      // 真 agent 卡住时的样子就是这样：进程活着、`running` 恒真、
      // 而用户那条气泡永远停在"马上说完"。
      break;

    case 'hang-die':
      // 一轮开了、一个字都没说，然后进程没了。
      // ⚠️ 早先这条路**什么都不说**，而且那一轮**永远留在 `#turns` 里**——
      //    用户就一直等一条不会来的回答（N19 要挡的正是这个）。
      timers.push(setTimeout(() => process.exit(9), 30));
      break;

    case 'hang-talk':
      // 说了半句再卡住 —— 超时收口要能认出"这一轮已经有 writer 了"
      notifyEvent('step/start', { turn: t, step: 1 });
      assistantMessage(t, 1, '我正在查…', '先调用工具');
      notifyEvent('step/end', { turn: t, step: 1 });
      break;

    case 'tool-read':
      notifyEvent('step/start', { turn: t, step: 1 });
      notifyToolCall(t, 1, 'read');
      notifyEvent('step/end', { turn: t, step: 1 });
      notifyEvent('step/start', { turn: t, step: 2 });
      assistantMessage(t, 2, '查到了。', null);
      notifyEvent('step/end', { turn: t, step: 2 });
      notifyEvent('turn/end', { turn: t, reason: { kind: 'completed' } });
      notifyStatus('idle');
      break;

    case 'tool-write':
      notifyEvent('step/start', { turn: t, step: 1 });
      notifyToolCall(t, 1, 'write');
      notifyEvent('step/end', { turn: t, step: 1 });
      notifyEvent('step/start', { turn: t, step: 2 });
      assistantMessage(t, 2, '改好了。', null);
      notifyEvent('step/end', { turn: t, step: 2 });
      notifyEvent('turn/end', { turn: t, reason: { kind: 'completed' } });
      notifyStatus('idle');
      break;

    case 'tool-write-die':
      notifyEvent('step/start', { turn: t, step: 1 });
      notifyToolCall(t, 1, 'write');
      notifyEvent('step/end', { turn: t, step: 1 });
      notifyEvent('step/start', { turn: t, step: 2 });
      assistantMessage(t, 2, '我正在改…', null);
      notifyEvent('step/end', { turn: t, step: 2 });
      timers.push(setTimeout(() => process.exit(9), 30));
      break;

    case 'handoff': {
      // ★ **D 期**：一轮里**真的调一次转交**（工具口那条路）。
      //   ① 先发 `tool/call`（服务端据此记"这一轮动过东西"）；
      //   ② 再**真的**问一次账本那口（`op:'handoff'`）—— 目标与理由是
      //      `FAKE_HANDOFF_TARGET` / `FAKE_HANDOFF_REASON` 给的；
      //   ③ 把结果**写到 stderr**（判据要能看见"服务端到底怎么裁决的"，
      //      而 stdout 是 JSON-RPC，一个字节都不许多）；
      //   ④ 最后照常收尾（发起者这一轮就到此为止；那条消息**不收口**）。
      //
      //   🔴 **只有发起那一侧才调工具**：发起者是**主线那一间**（`HUPO_SCOPE=main`），
      //      接活那一间（工作区里的房间）**不许**再转一次 —— 否则就成了两个 agent
      //      互相甩锅（真机上的形状是"目标那一轮做完就完了"）。
      //      ⚠️ `FAKE_HANDOFF_TARGET` 是**每个 agent 都会拿到**的环境变量
      //      （spawn 那一层统一给的），所以不能只看它。
      const target = SCOPE_OF_FAKE === 'main' ? (process.env.FAKE_HANDOFF_TARGET ?? '') : '';
      const reason = process.env.FAKE_HANDOFF_REASON ?? null;
      if (target === '') {
        notifyEvent('step/start', { turn: t, step: 1 });
        assistantMessage(t, 1, '好，我接着做。', null);
        notifyEvent('step/end', { turn: t, step: 1 });
        notifyEvent('turn/end', { turn: t, reason: { kind: 'completed' } });
        notifyStatus('idle');
        break;
      }
      notifyEvent('step/start', { turn: t, step: 1 });
      notifyToolCall(t, 1, 'handoff_to');
      // ⚠️ 顺带把"发起者说了半句"这件事也造出来：这样 A 那条消息**已经开了口**，
      //   D-4 的"同一条消息"才有东西可指。内容里**不许**出现"我转给某一间"
      //   那类话（D-1 的反例正身就靠它：正文说了也不算）。
      assistantMessage(t, 1, '我先起个头。', null);
      // 🔴 **这一轮要等工具的结果回来再收尾**：真 agent 也是这个形状
      //   （调工具 → 拿到结果 → 接着说/收尾）。不等的话，服务端收到那一帧时
      //   这一轮已经收了，转交的锚只能落在一条**空消息**上（判据 D-4 会红）。
      askLedger({ op: 'handoff', target, reason, scope: SCOPE_OF_FAKE }).then((r) => {
        process.stderr.write(`[fake-agent] handoff → ${JSON.stringify(r)}\n`);
        notifyEvent('step/end', { turn: t, step: 1 });
        notifyEvent('turn/end', { turn: t, reason: { kind: 'completed' } });
        notifyStatus('idle');
      });
      break;
    }

    case 'normal':
    default:
      notifyEvent('step/start', { turn: t, step: 1 });
      assistantMessage(t, 1, '你好。', '用户让我打招呼，回一句就好');
      notifyEvent('step/end', { turn: t, step: 1 });
      notifyEvent('turn/end', { turn: t, reason: { kind: 'completed' } });
      notifyStatus('idle');
      break;
  }
}
