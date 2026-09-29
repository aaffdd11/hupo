// 探针：**在"服务那一份环境"里起一次 agent**（判据 · 见 docs/dev/140-AGENT-BIN.md）。
// 它只回答一件事：调度器那句 spawn 在这份环境里能不能起来。
import { loadConfig } from '/home/deploy/proj/hupo/v2/services/core/src/config.js';
import { AgentRuntime } from '/home/deploy/proj/hupo/v2/services/core/src/agent-runtime.js';

const cfg = loadConfig(process.env, '/home/deploy/proj/hupo/v2/services/core');
console.log('PATH 里有 nvm bin 吗：', String(process.env.PATH || '').includes('nvm') ? '有' : '没有');
console.log('dshBin =', cfg.dshBin);
console.log('agentCwd =', cfg.agentCwd, '存在=', (await import('node:fs')).existsSync(cfg.agentCwd));
console.log('agentBootTimeoutMs =', cfg.agentBootTimeoutMs);

const rt = new AgentRuntime({ cfg });
const a = rt.agent('main');
a.on('exit', (info) => console.log('退出事件：', JSON.stringify(info).slice(0, 900)));
try {
  await a.start();
  console.log('✅ agent 起来了：ready =', a.ready);
} catch (err) {
  console.log('❌ 起不来：', String((err && err.message) || err));
} finally {
  try {
    await rt.shutdown();
  } catch {
    /* 收尾失败不影响结论 */
  }
}
process.exit(0);
