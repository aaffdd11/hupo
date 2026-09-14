// 演示监听者：先聊几轮（真模型），再叫它总结。
import { WebSocket } from 'ws';

const BASE = process.env.BASE || 'https://hupo.stalkerai.cn';
const conv = 'c_demo_listen';
const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(6);

const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/api/stream?conversationId=${conv}&sinceSeq=0`);
const texts = new Map();

ws.on('message', (raw) => {
  const e = JSON.parse(raw.toString());
  if (e.type === 'message/start') {
    texts.set(e.messageId, '');
    if (e.agent) console.log(`[${ms()}] ▶ ${e.agent}${e.interrupts ? ' 【打断】' : ''}`);
  }
  if (e.type === 'message/text') texts.set(e.messageId, (texts.get(e.messageId) || '') + e.text);
  if (e.type === 'message/end') console.log(`[${ms()}] ■ ${texts.get(e.messageId)}`);
  if (e.type === 'task/created') console.log(`[${ms()}] ⏳ ${e.title}`);
  if (e.type === 'task/completed') console.log(`[${ms()}] ✓ 任务完成`);
});

const say = async (text) => {
  console.log(`\n[${ms()}] ── 用户：${text}`);
  await fetch(`${BASE}/api/say`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: conv, text }),
  });
};

const waitQuiet = async (quietMs = 12000, maxMs = 90000) => {
  let last = Date.now();
  ws.on('message', () => (last = Date.now()));
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    await new Promise((r) => setTimeout(r, 500));
    if (Date.now() - last > quietMs) return;
  }
};

ws.on('open', async () => {
  await say('我下周三下午要跟客户开会，帮我安排一下');
  await waitQuiet();
  await say('顺便提醒我提前一天准备材料');
  await waitQuiet();
  await say('总结一下我们刚才聊的');
  await waitQuiet(15000);
  console.log('\n=== 结束 ===');
  ws.close();
  process.exit(0);
});
