// 观测一轮：发一句话，把它在后台走的每一步和耗时都打出来。
//
// 这是"边聊边改"的观测工具 —— 每次改完提示词/阈值/人格，跑一次就知道有没有变快、卡在哪儿。
//
// 用法：
//   node watch.mjs "你的问题"                       # 打本地服务
//   BASE=https://hupo.stalkerai.cn node watch.mjs "问题"   # 打线上
//   DEV=0 node watch.mjs "问题"                     # 不看后台步骤，只看用户看到的
//   CONV=c_main WARM_MS=8000 node watch.mjs "问题"   # 复用会话，先等 agent 冷启动（测真实首字延迟）

import { WebSocket } from 'ws';
import fs from 'node:fs';

// 鉴权：这台机器上的 agent 能执行命令，所以服务要令牌。
// 令牌**只从环境或本地文件读**，绝不写进 URL（URL 会进 nginx 日志）。
const TOKEN = process.env.HUPO_TOKEN
  || (fs.existsSync('/tmp/hupo.token') ? fs.readFileSync('/tmp/hupo.token', 'utf8').trim() : '');
const wsOpts = TOKEN ? { protocols: ['bearer', TOKEN] } : {};
const authHeaders = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

const BASE = process.env.BASE || 'http://127.0.0.1:8091';
const DEV = process.env.DEV !== '0';
const text = process.argv[2];
if (!text) {
  console.error('用法: node watch.mjs "你的问题"');
  process.exit(1);
}

// CONV 固定时复用同一个会话；WARM_MS 先空连一次，等 agent 进程起来（冷启动实测 2.7–5.1s）
const conversationId = process.env.CONV || `c_watch_${Date.now().toString(36)}`;
const WARM_MS = Number(process.env.WARM_MS || 0);
const wsBase = BASE.replace(/^http/, 'ws');
const url = `${wsBase}/api/stream?conversationId=${conversationId}&sinceSeq=0${DEV ? '&dev=1' : ''}`;

const steps = [];
let turnDone = false;
let firstLineAt = null;
let t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(6);

function run() {
  t0 = Date.now();
  console.log(`\n问题：${text}`);
  console.log(`会话：${conversationId}`);
  console.log(`连 ${url}\n`);

  const ws = new WebSocket(url, wsOpts.protocols);

  ws.on('message', (raw) => {
    const e = JSON.parse(raw.toString());
    switch (e.type) {
      case 'dev/step': {
        if (e.status === 'end' && e.ms != null) steps.push({ phase: e.phase, ms: e.ms });
        const icon = { start: '▶', end: '✓', error: '✗', info: '·' }[e.status] || '?';
        const dur = e.ms != null ? String(`${e.ms}ms`).padStart(8) : '        ';
        console.log(`[${ms()}] ${icon} ${String(e.phase).padEnd(9)}${dur}  ${e.detail || ''}`);
        break;
      }
      case 'message/start':
        console.log(`[${ms()}] ▶ 说话：${e.agent || '?'}${e.interrupts ? ' 【打断】' : ''}`);
        break;
      case 'message/text':
        if (e.text) {
          if (firstLineAt == null) firstLineAt = Date.now() - t0;
          console.log(`[${ms()}]   「${e.text}」`);
        }
        break;
      case 'task/created':
        console.log(`[${ms()}] ⏳ 变成独立的事：${e.title}`);
        break;
      case 'task/completed':
        console.log(`[${ms()}] ✓ 那件事做完了`);
        break;
      case 'message/end':
        if (!turnDone) {
          turnDone = true;
          const n = (e.sources || []).length;
          console.log(`[${ms()}] ■ 本轮结束（${e.reason}）${n ? `来源 ${n} 条` : ''}`);
        }
        break;
      case 'error':
        console.log(`[${ms()}] ✗ ${e.code}: ${e.message}`);
        break;
      default:
        break;
    }
  });

  ws.on('open', async () => {
    await fetch(`${BASE}/api/say`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({ conversationId, text }),
    });
  });

  const started = Date.now();
  const timer = setInterval(() => {
    const quiet = turnDone && Date.now() - t0 > 4000;
    const timeout = Date.now() - started > 120000;
    if (!quiet && !timeout) return;
    clearInterval(timer);
    console.log('\n── 汇总 ──');
    const stages = steps.filter((s) => s.phase !== 'turn');
    console.log(`  步骤：${stages.map((s) => `${s.phase} ${s.ms}ms`).join(' ｜ ') || '（无）'}`);
    const turn = steps.filter((s) => s.phase === 'turn').pop();
    if (turn) console.log(`  整轮：${turn.ms}ms`);
    if (firstLineAt) console.log(`  第一句话到达：${firstLineAt}ms`);
    ws.close();
    process.exit(0);
  }, 400);
}

if (WARM_MS) {
  // 只连不发言：服务端一看到 WS 连上就会预热这个会话的 agent
  const warm = new WebSocket(`${wsBase}/api/stream?conversationId=${conversationId}&sinceSeq=0`, wsOpts.protocols);
  warm.on('open', () => {
    console.log(`预热 ${WARM_MS}ms（等 agent 进程起来）…`);
    setTimeout(() => {
      warm.close();
      run();
    }, WARM_MS);
  });
  warm.on('error', (e) => {
    console.error('预热失败：', e.message);
    process.exit(1);
  });
} else {
  run();
}
