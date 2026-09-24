// **假的那台 DSH**：说和 `dsh --profile sdk` **同一套** SDK JSON-RPC（判据 H3–H7 用）。
//
// 为什么要有它（和 `fake-agent.mjs` 同一个理由）：
//   真 DSH 要花钱、要网络、要盒内那个模型代理；但"spawn + stdio 分帧 + 原样转发 + 收进程"
//   这一段**必须真跑** —— mock 掉它就等于把最容易错的那一段排除在判据之外。
//
// ⚠️ "它会说什么、会带哪些工具"住在 `harness-fake-voice.mjs`（**判据用的是同一份**）：
//   挂了人格 patch 它就用琥珀的声音、挂了能力层它的工具清单里就多出那几条
//   ⇒ 判据 H5 因此**能被反着验**（挂上去就必须红）。
//
// 场景由环境变量选：
//   （默认）        正常一轮：`initialize` 成，`session/prompt` 回那 14 种事件
//    FAKE_DSH_NEVER_INIT=1   `initialize` **永远不回**（验"起不来"那条人话 + 收进程）
//    FAKE_DSH_INIT_ERROR=1   `initialize` 回一个 JSON-RPC 错（同上，另一条路）
//    FAKE_DSH_GARBAGE=1      stdout 上先吐一行**不是 JSON** 的东西（它不该出现在线上协议里）
//    FAKE_DSH_SENTINEL=1     只吐那一帧"原样"探针（判据比 deep-equal）
//    FAKE_DSH_IGNORE_SIGTERM=1  不理会 `SIGTERM` ⇒ 只有 `SIGKILL` 收得掉它（判据 H6）
//    FAKE_DSH_IGNORE_SHUTDOWN=1 连 `shutdown` 也不理会（和上一条一起用 ⇒ 真的只剩 SIGKILL）

import { SENTINEL_FRAME, startupEvents, turnEvents, voiceFor } from './harness-fake-voice.mjs';

const env = process.env;
const voice = voiceFor(process.argv.slice(2));
const mode = {
  neverInit: env.FAKE_DSH_NEVER_INIT === '1',
  initError: env.FAKE_DSH_INIT_ERROR === '1',
  garbage: env.FAKE_DSH_GARBAGE === '1',
  sentinel: env.FAKE_DSH_SENTINEL === '1',
};

let buf = '';
let seq = 0;
let turn = 0;

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

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const notify = (method, params) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
const event = (type, data) => {
  seq += 1;
  notify('session.event', { event: { type, seq, time: 1_700_000_000_000, data } });
};
const status = (s) => notify('session.status', { sessionId: 'harness-fake', status: s });

function onMessage(msg) {
  if (msg.method === 'initialize') {
    if (mode.neverInit) return; // 一声不吭（判据 H3 的"起不来"那条）
    if (mode.initError) {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'initialize 不成（假装的）' } })}\n`,
      );
      return;
    }
    reply(msg.id, { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } });
    if (mode.garbage) process.stdout.write('这不是 JSON —— 真 dsh 的 stderr 才该有这种东西\n');
    if (mode.sentinel) {
      process.stdout.write(`${JSON.stringify(SENTINEL_FRAME)}\n`);
      return;
    }
    for (const e of startupEvents()) event(e.type, e.data);
    return;
  }
  if (msg.method === 'shutdown') {
    if (env.FAKE_DSH_IGNORE_SHUTDOWN === '1') return; // 装死：只留 SIGKILL 这一条路
    reply(msg.id, {});
    setTimeout(() => process.exit(0), 10);
    return;
  }
  if (msg.method === 'session/prompt') {
    reply(msg.id, { messageId: `pm_${seq}` });
    turn += 1;
    status('running');
    for (const e of turnEvents(turn, voice)) event(e.type, e.data);
    status('idle');
    return;
  }
  if (msg.id !== undefined) reply(msg.id, {});
}

// ⚠️ 判据 H6 的"兜底那一刀"要能真验到：设了它，`SIGTERM` 不理会
//    ⇒ 只有 `SIGKILL` 能收掉它。
if (env.FAKE_DSH_IGNORE_SIGTERM === '1') {
  process.on('SIGTERM', () => {});
}
// stdin 关了不算"我该走"（真 dsh 也不是靠那个收的）。
process.stdin.on('end', () => {});
// ⚠️ **必须有这一条**：它让"那个进程还活着"这件事**不依赖 stdio 开着**
//    ⇒ 判据 H6 里"连接断了之后，是不是真有人把它收了"才验得出来
//      （不然子进程可能自己退掉，测试就变成一句空话）。
setInterval(() => {}, 1 << 30);
