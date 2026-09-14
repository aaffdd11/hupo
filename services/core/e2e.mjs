// 端到端验证：走**公网**（和客户端完全同一条路）
//   WebSocket wss://hupo.stalkerai.cn/api/stream  +  POST /api/say
// 用法：node e2e.mjs ["你的问题"]

import { WebSocket } from 'ws';

const BASE = process.env.BASE || 'https://hupo.stalkerai.cn';
const text = process.argv[2] || '接口偶发 500 怎么排查';
const conversationId = `c_e2e_${Date.now().toString(36)}`;
const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(5);
const messages = new Map();

const wsUrl = BASE.replace(/^http/, 'ws') + `/api/stream?conversationId=${conversationId}&sinceSeq=0`;
console.log(`连 ${wsUrl}\n`);
const ws = new WebSocket(wsUrl);

let lastEventAt = Date.now();
let sawTask = false;
let taskDone = false;

ws.on('open', async () => {
  console.log(`[${ms()}ms] 已连接。用户说：${text}\n`);
  const res = await fetch(`${BASE}/api/say`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId, text }),
  });
  console.log(`[${ms()}ms] POST /api/say → ${res.status}\n`);
});

ws.on('message', (raw) => {
  const e = JSON.parse(raw.toString());
  lastEventAt = Date.now();
  switch (e.type) {
    case 'message/start':
      console.log(`[${ms()}ms] ▶ ${e.agent} ${e.origin}${e.interrupts ? ' 【打断】' : ''}`);
      messages.set(e.messageId, '');
      break;
    case 'message/text':
      messages.set(e.messageId, (messages.get(e.messageId) || '') + e.text);
      console.log(`[${ms()}ms]   +「${e.text}」`);
      break;
    case 'message/status':
      console.log(`[${ms()}ms]   · ${e.state}`);
      break;
    case 'task/created': sawTask = true; console.log(`[${ms()}ms] ⏳ 任务：${e.title}`); break;
    case 'task/completed': taskDone = true; console.log(`[${ms()}ms] ✓ 任务完成`); break;
    case 'message/end': console.log(`[${ms()}ms] ■ 结束（${e.reason}）\n`); break;
    case 'error': console.log(`[${ms()}ms] ✗ ${e.code}: ${e.message}\n`); break;
  }
});

ws.on('error', (e) => { console.log('WebSocket 出错:', e.message); process.exit(1); });

const check = setInterval(() => {
  const quiet = Date.now() - lastEventAt > 25000;
  if (quiet && !(sawTask && !taskDone)) {
    clearInterval(check);
    console.log('── 用户实际看到的内容（按到达顺序）──');
    let i = 1;
    for (const [, t] of messages) console.log(`  ${i++}. ${t}`);
    ws.close();
    process.exit(0);
  }
}, 500);
setTimeout(() => { console.log('\n(超时)'); process.exit(1); }, 150000);
