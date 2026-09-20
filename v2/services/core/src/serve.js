// 服务入口。`npm start`
//
// 环境变量（都有默认值，本机跑不需要配）：
//   HUPO_PORT      监听端口（默认 8020）
//   HUPO_DATA      数据目录（默认 ./data）
//   HUPO_WEB       Flutter web 产物目录（默认 ./web；不存在则只服务 API）
//   HUPO_BUILD_ID  构建指纹（默认取环境或 dev）
//
// ⚠️ **只在 127.0.0.1 上听**。对外由 VPS 那条 stcp 隧道走——
//    stcp **不占任何公网端口**，所以 nginx 绕不过去（见 docs/dev/03-DEPLOY-WEB.md）。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { AgentRuntime } from './agent-runtime.js';
import { Auth } from './auth.js';
import { Dispatcher } from './dispatcher.js';
import { SayService } from './say.js';
import { Store } from './store.js';
import { Timeline } from './timeline.js';
import { createServer } from './server.js';
import { loadConfig, preflight } from './config.js';
import { installProcessGuard } from './process-guard.js';


const cfg = loadConfig(process.env, process.cwd());

// ⚠️ 启动前把能提前查的都查一遍：
//    spawn 的失败是**异步**的，而且它的 ENOENT **分不清**
//    "程序找不到"和"工作目录不存在"——在这里查清，能省掉半天排查。
const { problems, notes } = preflight(cfg);
if (problems.length > 0) {
  console.error('✗ 起不来：');
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(2);
}
for (const n of notes) console.warn(`  ⚠️ ${n}`);

const store = new Store({ dataDir: cfg.dataDir });
const timeline = new Timeline({
  id: 'main',
  store,
  onSubscriberError: (err, event) => {
    console.error(`[timeline] 订阅者出错（${event.type}）：${err?.message ?? err}`);
  },
});
const auth = new Auth({ dataDir: cfg.dataDir });
const say = new SayService({ timeline, store, timelineId: 'main' });

// agent 运行时 + 粘合层。
// ⚠️ `onEvict` 是「**先收口再卸**」里的那个收口——runtime 没有翻译层，
//    它不知道哪条消息还没说完，只能回调出来（手册 §5.5）。
const runtime = new AgentRuntime({
  cfg,
  onEvict: (sessionId) => dispatcher.onEvict(sessionId),
});
const dispatcher = new Dispatcher({ timeline, runtime, scopeId: timeline.id });

// 出事谁接：进程级兜底（手册 §5.2 第 3 层）
installProcessGuard({ timeline });

const webRoot = nodeFs.existsSync(nodePath.join(cfg.webRoot, 'index.html')) ? cfg.webRoot : null;

const { listen, close } = createServer({
  timeline, store, auth, say, dispatcher, webRoot, buildId: cfg.buildId,
  log: (m) => console.log(m),
});

const addr = await listen(cfg.port, '127.0.0.1');

// 启动横幅**报告状态**，不喊口号（手册 §11.4）
console.log('── 琥珀 · 调度器（v2）────────────────────────');
console.log(`  监听     127.0.0.1:${addr.port}   （对外走 VPS 的 stcp 隧道）`);
console.log(`  数据     ${cfg.dataDir}`);
console.log(`  界面     ${webRoot ?? '（没有 web 产物，只服务 API）'}`);
console.log(`  构建     ${cfg.buildId}`);
console.log(`  agent    ${cfg.dshBin} --profile ${cfg.agentProfile}（最多 ${cfg.agentMaxProcesses} 个）`);
console.log(`  工作目录 ${cfg.agentCwd}`);
console.log(
  auth.needsSetup
    // fail-closed 不是"警告"，是**当前状态**——所以要说清楚它现在拒绝服务
    ? '  鉴权     ⚠️ 还没设密码 ⇒ **除三个公开路由外一律 503**（fail-closed）\n' +
      '           设密码：npm run set-pass -- "你的密码"'
    : '  鉴权     ✓ 已设密码（fail-closed 生效）',
);
console.log(`  时间线   已有事件 ${timeline.seq} 条`);
console.log('──────────────────────────────────────────────');

// 优雅退出：先停止接新连接，再关。
// ⚠️ 不要 resume/续做任何东西——那是**下次启动**的事（对账在启动时做）。
let closing = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    console.log(`\n收到 ${sig}，收工。`);
    // ⚠️ 顺序：**先把话说圆、再放 agent 走**
    await dispatcher.shutdown();
    await runtime.shutdown();
    await close();
    process.exit(0);
  });
}
