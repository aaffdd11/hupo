// 决定性验证：把 DSH 的 **SDK 真 agent** 拉起来，握一次手，看它到底是不是 agent。
//
// 协议：`dsh --profile sdk` 起一个 stdio JSON-RPC 运行时；
//   客户端 → 服务端：initialize / session/prompt / shutdown
//   服务端 → 客户端：session.event（**完整会话日志事件**）/ session.status /
//                    subagent.started / subagent.finished
//
// 要点：一个 `sessionId` = 一个真 agent 会话（带工具循环、子 agent、持久化）。
// 跑：node sdk-spike.mjs ["你的话"]

import { spawn } from 'node:child_process';

const TEXT = process.argv[2] || '先看一眼你当前工作目录里 package.json 的 name 字段，然后用一句话回答。';
const CWD = process.env.SPIKE_CWD || '/home/deploy/projects/assistant';
const SESSION_ID = process.env.SPIKE_SESSION || 'spike_1';
const PROVIDER = process.env.SPIKE_PROVIDER || 'deepseek-official';
const MODEL = process.env.SPIKE_MODEL || 'deepseek-flash';
const TIMEOUT_MS = Number(process.env.SPIKE_TIMEOUT || 120000);

const t0 = Date.now();
const stamp = () => `[${String(Date.now() - t0).padStart(6)}ms]`;

/** 会话回到 idle 时 resolve（这一轮跑完了）。**必须在 prompt 之前挂上**。 */
let onIdle = null;
const waitIdle = () =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, TIMEOUT_MS);
    onIdle = () => {
      clearTimeout(timer);
      onIdle = null;
      resolve();
    };
  });

const PATCH = process.env.SPIKE_PATCH || '';
const args = ['--profile', 'sdk', ...(PATCH ? ['--patch', PATCH] : [])];

const child = spawn('dsh', args, {
  cwd: CWD,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});

let nextId = 1;
const pending = new Map();
let buf = '';

child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log(`${stamp()} ✗ 坏帧：${line.slice(0, 120)}`);
      continue;
    }
    handle(msg);
  }
});
child.stderr.on('data', (d) => {
  const s = d.toString().trim();
  if (s) console.log(`${stamp()} [stderr] ${s.slice(0, 300)}`);
});
child.on('exit', (code, sig) => console.log(`${stamp()} 进程退出 code=${code} sig=${sig}`));

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function textOf(blocks) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : `[${b?.type}]`))
    .join('');
}

let toolsPrinted = false;

function describeEvent(ev) {
  const t = ev?.type ?? '?';
  if (process.env.SPIKE_TYPES) return `TYPE ${t}`;
  if (process.env.SPIKE_TOOL && (t === 'tool/result' || t === 'tool/call')) {
    return `RAWTOOL ${JSON.stringify(ev)}`;
  }
  const p = ev?.data ?? {};
  switch (t) {
    case 'user/message':
      return `👤 用户：${textOf(p.content)}`;
    case 'assistant/message': {
      const blocks = p.message?.content ?? [];
      const parts = blocks.map((b) => {
        if (b?.type === 'text') return `🗣 助手：${b.text}`;
        if (b?.type === 'reasoning') return `💭 思考：${String(b.text ?? '').slice(0, 100)}…`;
        if (b?.type === 'tool-call') return `🔧 调用 ${b.name}`;
        return `[${b?.type}]`;
      });
      return parts.join('\n           ');
    }
    case 'tool/call':
      return `   → ${p.name} ${String(p.arguments ?? '').slice(0, 160)}`;
    case 'tool/result':
      return `   ↳ ${textOf(p.message?.content).slice(0, 200)}`;
    case 'turn/start':
      return `── 第 ${p.turn} 轮开始`;
    case 'turn/end':
      return `── 第 ${p.turn} 轮结束（${p.reason?.kind ?? '?'}）`;
    case 'step/start':
      return `   ▸ step ${p.step}`;
    case 'step/end':
      return `   ◂ step ${p.step} 完`;
    case 'system/message': {
      const text = textOf(p.message?.content);
      return process.env.SPIKE_SHOW_PROMPT
        ? `（系统提示 ${text.length} 字）\n────────\n${text.slice(0, 2600)}\n────────`
        : `（系统提示 ${text.length} 字）`;
    }
    case 'session/title':
      return `（会话标题：${p.title}）`;
    case 'request/header': {
      if (!toolsPrinted) {
        toolsPrinted = true;
        const names = (p.header?.tools ?? []).map((t2) => t2.name);
        return `📋 工具清单（${names.length} 个）：${names.join(', ')}`;
      }
      return null;
    }
    case 'permission/preset':
      return `（权限：${p.preset}）`;
    case 'sandbox/mode':
      return `（沙箱：${p.mode}）`;
    case 'approval/policy':
      return `（审批：${p.policy}）`;
    case 'agent/inbox/spliced':
      return null; // 入队细节，噪音
    default:
      return `${t} ${JSON.stringify(p).slice(0, 200)}`;
  }
}

function handle(msg) {
  // 响应
  if (msg.id != null && !msg.method) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (!p) return;
    if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
    else p.resolve(msg.result);
    return;
  }
  // 服务端反过来请求客户端 —— SDK 运行时不该这么做，如实报出来
  if (msg.id != null && msg.method) {
    console.log(`${stamp()} ⚠ 服务端请求 ${msg.method}`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`);
    return;
  }
  if (msg.method === 'session.event') {
    const { sessionId, event } = msg.params;
    const line = describeEvent(event);
    if (line) console.log(`${stamp()} [${sessionId}] ${line}`);
    return;
  }
  if (msg.method === 'session.status') {
    console.log(`${stamp()} ── 会话状态：${msg.params.status}`);
    if (msg.params?.status === 'idle') onIdle?.();
    return;
  }
  if (msg.method === 'subagent.started' || msg.method === 'subagent.finished') {
    console.log(`${stamp()} ── ${msg.method} ${JSON.stringify(msg.params).slice(0, 200)}`);
    return;
  }
  console.log(`${stamp()} ? ${msg.method} ${JSON.stringify(msg.params).slice(0, 200)}`);
}

try {
  const init = await request('initialize', {
    cwd: CWD,
    provider: PROVIDER,
    model: MODEL,
    reasoningEffort: 'low',
    maxTokens: Number(process.env.SPIKE_MAXTOKENS || 2000),
  });
  console.log(`${stamp()} ✓ initialize：${JSON.stringify(init)}`);

  const idle = waitIdle();
  const sent = await request('session/prompt', {
    sessionId: SESSION_ID,
    contentBlocks: [{ type: 'text', text: TEXT }],
  });
  console.log(`${stamp()} ✓ session/prompt 已入队：${JSON.stringify(sent)}`);

  await idle; // 等这一轮真的跑完
} catch (e) {
  console.log(`${stamp()} ✗ 失败：${e.message}`);
}

console.log(`${stamp()} ── 收工 ──`);
try {
  await request('shutdown', undefined);
} catch {
  /* 已经关了 */
}
child.kill('SIGTERM');
setTimeout(() => process.exit(0), 500).unref?.();
