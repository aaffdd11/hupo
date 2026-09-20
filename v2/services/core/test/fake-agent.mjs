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

import fs from 'node:fs';

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
const sessionFile = process.env.FAKE_SESSION_FILE ?? null;
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
