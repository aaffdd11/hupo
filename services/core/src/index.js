// 入口：起服务。
//
// 用法：node src/index.js
// 环境变量见 config.js（端口、模型、密钥来源）

import { Auth } from './auth.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

const cfg = loadConfig();
const { server, shutdown, auth } = createServer(cfg);

/**
 * 启动横幅。
 *
 * ⚠ 鉴权没生效时必须**大声喊出来** —— 这台机器上跑着一个能执行命令、
 * 能动自己代码的 agent，裸奔一秒钟都不行。不能让它在日志里悄悄溜过去。
 */
if (!auth.active) {
  const why = auth.enabled ? '还没设口令' : '被显式关掉了';
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════════╗');
  console.log('  ║  ⚠  鉴权未生效 —— 任何能访问到本服务的人都可以：          ║');
  console.log('  ║     读你的全部对话 / 以你的身份下指令 / 读调试数据        ║');
  console.log(`  ║     原因：${why.padEnd(46)}║`);
  console.log('  ║     修：node src/auth-cli.mjs --random                   ║');
  console.log('  ╚══════════════════════════════════════════════════════════╝');
  console.log('');
}

server.listen(cfg.port, '127.0.0.1', () => {
  const keyState = cfg.apiKey ? `已配置（${cfg.apiKey.slice(0, 6)}…）` : '⚠️ 未配置';
  console.log(`concierge-core 已启动`);
  console.log(`  监听     http://127.0.0.1:${cfg.port}`);
  console.log(`  密钥     ${keyState}`);
  console.log(`  agent    ${cfg.agentProvider}/${cfg.agentModel}（profile=${cfg.agentProfile}）`);
  console.log(`  人格     ${cfg.personaPath}`);
  console.log(`  工作目录 ${cfg.agentCwd}`);
  console.log(`  挪走阈值 ${cfg.escalateAfterMs}ms ｜ 单轮上限 ${cfg.turnDeadlineMs}ms`);
  console.log(`  鉴权     ${auth.active ? '✓ 生效（要令牌）' : '✗ 未生效（所有人可访问）'}`);
});

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n收到 ${sig}，关闭中…`);
    await shutdown();
    console.log('已关闭');
    process.exit(0);
  });
}
