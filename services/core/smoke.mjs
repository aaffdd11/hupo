// 真跑一次闭环：起服务 → 连 WebSocket → 发一句 → 打印事件与耗时。
// 用法：node smoke.mjs ["你的问题"]

import { loadConfig } from './src/config.js';
import { createServer } from './src/server.js';
import { WebSocket } from 'ws';

const cfg = loadConfig({ port: 8099 });
const { server } = createServer(cfg);
await new Promise((r) => server.listen(cfg.port, '127.0.0.1', r));

const text = process.argv[2] || '我的接口偶发 500，日志里看不出原因，帮我定位一下';
const conversationId = 'c_smoke';
const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(5);
const messages = new Map();

const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/api/stream?conversationId=${conversationId}&sinceSeq=0`);

let lastEventAt = Date.now();
let sawTask = false;
let taskDone = false;

ws.on('open', async () => {
  console.log(`[${ms()}ms] 已连接。用户说：${text}\n`);
  await fetch(`http://127.0.0.1:${cfg.port}/api/say`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId, text }),
  });
});

ws.on('message', (raw) => {
  const e = JSON.parse(raw.toString());
  lastEventAt = Date.now();
  switch (e.type) {
    case 'message/start':
      console.log(`[${ms()}ms] ▶ agent=${e.agent} ${e.origin}${e.interrupts ? ' 【打断】' : ''}`);
      messages.set(e.messageId, '');
      break;
    case 'message/text':
      messages.set(e.messageId, (messages.get(e.messageId) || '') + e.text);
      console.log(`[${ms()}ms]   +「${e.text}」`);
      break;
    case 'message/status':
      console.log(`[${ms()}ms]   · ${e.state}`);
      break;
    case 'task/created':
      sawTask = true;
      console.log(`[${ms()}ms] ⏳ 任务建立：${e.title}`);
      break;
    case 'task/completed':
      taskDone = true;
      console.log(`[${ms()}ms] ✓ 任务完成`);
      break;
    case 'message/end':
      console.log(`[${ms()}ms] ■ 结束（${e.reason}）\n`);
      break;
    case 'error':
      console.log(`[${ms()}ms] ✗ ${e.code}: ${e.message}\n`);
      break;
  }
});

// 退出条件：没有任务且静默 5 秒；有任务则等任务完成后再静默 5 秒
const check = setInterval(() => {
  const quiet = Date.now() - lastEventAt > 25000;
  const taskPending = sawTask && !taskDone;
  if (quiet && !taskPending) {
    clearInterval(check);
    console.log('── 最终每段内容（按到达顺序）──');
    for (const [, t] of messages) console.log(`  ${t}`);
    ws.close();
    server.close(() => process.exit(0));
  }
}, 500);
setTimeout(() => { console.log('\n（超时退出）'); process.exit(1); }, 120000);
