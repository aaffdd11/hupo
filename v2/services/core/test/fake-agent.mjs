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

const scenario = process.env.FAKE_SCENARIO ?? 'normal';

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
