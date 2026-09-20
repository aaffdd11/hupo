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
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { AgentRuntime } from './agent-runtime.js';
import { Auth } from './auth.js';
import { Dispatcher } from './dispatcher.js';
import { SayService } from './say.js';
import { Store } from './store.js';
import { reconcileOnBoot } from './reconcile.js';
import { CRASH_WINDOW_MS, markCleanExit, recordStart } from './boot-marker.js';
import { RESUMED_EVENT } from './resume-plan.js';
import { Timeline } from './timeline.js';
import { createServer } from './server.js';
import { loadConfig, preflight } from './config.js';
import { integrityReport } from './integrity.js';
import { describeAdmission, readAdmission } from './admission.js';
import { applyPrune, groupSlugFor, planPrune, scanEntries, summarize } from './prune.js';
import { createTurnStatus, statusPath } from './turn-status.js';
import { HUMAN_LINES, installProcessGuard } from './process-guard.js';


const cfg = loadConfig(process.env, process.cwd());

// ⚠️ 启动前把能提前查的都查一遍：
//    spawn 的失败是**异步**的，而且它的 ENOENT **分不清**
//    "程序找不到"和"工作目录不存在"——在这里查清，能省掉半天排查。
const { problems, notes } = preflight(cfg);

// ★ **P1：开机完整性核对**（手册 `05-DECISIONS.md` P1.2 / P1.4）。
//   ⚠️ 放在这儿而不是 `preflight()` 里：`preflight` 也被单元测试调，
//      而在"改代码改到一半"的机器上核对清单只会把测试弄红——
//      那会逼着下一个人把这道闸从测试里绕开。**闸要拦的是"开机"，不是"跑测试"。**
//   ⚠️ 仓库根从 `serve.js` 自己的位置推（`v2/services/core/src/serve.js`），
//      不依赖 cwd —— 从哪儿起的进程都算得对。
// ★ **准入闸**：开机读一次，横幅里**如实**写它现在算不算得出判据（手册 §9.1）。
const adm = readAdmission();

// ★ **顺手清理自己那一组旧的会话记录**（欠账第 9 条：`$DSH_HOME/sessions/` 只涨不降）。
//
// ⚠️ 只动 `HUPO_AGENT_CWD` 对应的**那一组**：
//    盘上是两层的（`sessions/<项目>-<slug>--/<记录>/`），不分组地清会连
//    **别的项目**和**这个 GUI 自己的可 resume 记录**一起删（AGENTS §六.5）。
// ⚠️ 而且它**不许阻断启动**：清记录是维护动作，出任何事都只记一句（照开机对账那条规矩）。
let pruned = null;
try {
  const groupDir = nodePath.join(cfg.dshHome, 'sessions', groupSlugFor(cfg.agentCwd));
  if (nodeFs.existsSync(groupDir)) {
    const plan = planPrune({ entries: scanEntries({ root: groupDir }) });
    if (plan.remove.length > 0) {
      const done = applyPrune(plan.remove, { root: groupDir });
      pruned = summarize(plan, { applied: true, done });
    }
  }
} catch (err) {
  console.warn(`  ⚠️ 顺手清旧记录没做成（不影响服务）：${err?.message ?? err}`);
}

const ig = integrityReport({
  repo: nodePath.resolve(import.meta.dirname, '../../..'),
  home: nodeOs.homedir(),
});
problems.push(...ig.problems);
notes.push(...ig.notes);
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
// ★ **开机对账**：把上一次没说完的话收干净，并告诉用户"可能没做完"。
// ⚠️ 位置就在这儿：**在服务开始收请求之前**。晚一步的话，
//    客户端可能已经连上、把那条没收口的气泡渲染成"还在做"了。
// ⚠️ 而且它**不许阻断启动**（手册 §15.3）——函数内部自己包住了。
// ★ **崩溃环判定**（§11.1）：判断"是不是刚崩过几次"。
// ⚠️ 必须在对账**之前** —— 降级状态是"要不要续做"的输入之一。
const boot = recordStart(cfg.dataDir);
if (boot.degraded) {
  console.warn(
    `  ⚠️ ${HUMAN_LINES.degraded}\n` +
      `     （${CRASH_WINDOW_MS / 60000} 分钟内启动了 ${boot.starts} 次，上一次没善终 ⇒ **这次不续做**）`,
  );
}

const reconciled = reconcileOnBoot({
  timeline,
  store,
  // 续做只在**没降级**时开（§11.1：崩溃环里继续续做只会放大问题）
  resume: { degraded: boot.degraded },
  log: (m) => console.warn(m),
});
if (!reconciled.ok) {
  console.warn(`  ⚠️ 开机对账没做成：${reconciled.error}（**不影响启动**）`);
}

const auth = new Auth({ dataDir: cfg.dataDir });
const say = new SayService({ timeline, store, timelineId: 'main' });

// agent 运行时 + 粘合层。
// ⚠️ `onEvict` 是「**先收口再卸**」里的那个收口——runtime 没有翻译层，
//    它不知道哪条消息还没说完，只能回调出来（手册 §5.5）。
const runtime = new AgentRuntime({
  cfg,
  onEvict: (sessionId) => dispatcher.onEvict(sessionId),
});
const dispatcher = new Dispatcher({
  timeline,
  runtime,
  scopeId: timeline.id,
  store,
  recap: cfg.recap,
  turnDeadlineMs: cfg.turnDeadlineMs,
});

// 出事谁接：进程级兜底（手册 §5.2 第 3 层）
installProcessGuard({ timeline });

const webRoot = nodeFs.existsSync(nodePath.join(cfg.webRoot, 'index.html')) ? cfg.webRoot : null;

// ★ **"手上还有没有没说完的话"** —— 写一个每秒刷新的小文件（`data/status.json`）。
//   为什么：重启（部署、改配置）**不该把正在说的那一轮切掉**（手册 `06-OPERATIONS.md` §8.3）。
//   `scripts/restart-core.sh` 默认会等它变成"不忙"再动手。
//   ⚠️ 它**只是旁路信息**：写不进去也不许影响服务（`createTurnStatus` 自己吞掉异常）。
const turnStatus = createTurnStatus({
  file: statusPath(cfg.dataDir),
  snapshot: () => ({
    openMessageId: timeline.openMessageId,
    pending: dispatcher?.pendingDeliveries ?? 0,
    // ⚠️ "轮已经宣布、但一个字都还没说"那一段也得算忙（实测有 3 秒以上）
    turns: dispatcher?.armedDeadlines ?? 0,
  }),
});
turnStatus.start();

const { listen, close } = createServer({
  timeline, store, auth, say, dispatcher, webRoot, buildId: cfg.buildId,
  log: (m) => console.log(m),
});

// ★ **续做**：对账说出口的那句"我重新做一遍"，在这里真的做。
// ⚠️ 顺序不能反：**先落 `task/resumed`（记额度）再投递** ——
//    投递失败也要算一次"发起过"，否则一个每次投递都失败的活会被无限重试。
if (reconciled.resume) {
  const { ref, text, attempt } = reconciled.resume;
  console.log(`  ▶ 续做：把「${text.slice(0, 24)}…」重做一遍（第 ${attempt} 次）`);
  try {
    timeline.emit({ type: RESUMED_EVENT, ref, attempt });
    dispatcher.deliver(text, { messageId: ref }).catch((err) => {
      console.warn(`  ⚠️ 续做投递失败：${err?.message ?? err}（额度已经记过了）`);
    });
  } catch (err) {
    console.warn(`  ⚠️ 续做没发起：${err?.message ?? err}`);
  }
} else if (reconciled.total > 0) {
  console.log(`  · 没有自动重做（原因：${reconciled.resumeReason}）`);
}

const addr = await listen(cfg.port, '127.0.0.1');

// 启动横幅**报告状态**，不喊口号（手册 §11.4）
console.log('── 琥珀 · 调度器（v2）────────────────────────');
console.log(`  监听     127.0.0.1:${addr.port}   （对外走 VPS 的 stcp 隧道）`);
console.log(`  数据     ${cfg.dataDir}`);
console.log(`  界面     ${webRoot ?? '（没有 web 产物，只服务 API）'}`);
console.log(`  构建     ${cfg.buildId}`);
// ⚠️ 这一行必须**如实**：清单还没建的时候，这道闸是**没有**的。
//    报成"OK"就是"看起来有闸、其实没有"——比不设更坏。
console.log(`  准入     ${describeAdmission(adm)}`);
if (pruned) console.log(`  顺手清   ${pruned}`);
console.log(
  `  完整性   ${
    ig.state === 'ok'
      ? '对上了'
      : ig.state === 'tampered'
        ? `⚠️ 有 ${ig.warnings.length} 个"只报不拦"的条目动过`
        : '⚠️ **还没启用**（清单不在，见上面那条提示）'
  }`,
);
console.log(`  agent    ${cfg.dshBin} --profile ${cfg.agentProfile}（最多 ${cfg.agentMaxProcesses} 个）`);
console.log(`  工作目录 ${cfg.agentCwd}`);
console.log(
  // ⚠️ 这一行必须说**它到底记不记得**——那是用户最先会问的问题。
  //    所以报的是"额度"（能记多少），不是"功能已启用"这种口号。
  `  接记忆   起 agent 时喂回最近 ${cfg.recap.maxEntries} 句 / 最多 ${cfg.recap.maxChars} 字` +
    `（单条 ${cfg.recap.maxEntryChars} 字封顶）`,
);
console.log(
  // ⚠️ 人格必须**报出来**：它没挂上的时候一切照常，
  //    只是"它说话不像它"——那是查不出来的故障。
  `  人格     ${cfg.personaPath}（${nodeFs.existsSync(cfg.personaPath) ? '已挂上' : '⚠️ 文件不在'}）`,
);
console.log(
  cfg.turnDeadlineMs > 0
    ? `  卡住收口 一轮超过 ${Math.round(cfg.turnDeadlineMs / 1000)} 秒没收口就收掉，并卸下那个 agent`
    : '  卡住收口 ⚠️ 关掉了（turnDeadlineMs=0）——agent 卡住不会有收尾',
);
console.log(
  auth.needsSetup
    // fail-closed 不是"警告"，是**当前状态**——所以要说清楚它现在拒绝服务
    ? '  鉴权     ⚠️ 还没设密码 ⇒ **除三个公开路由外一律 503**（fail-closed）\n' +
      '           设密码：npm run set-pass -- "你的密码"'
    : '  鉴权     ✓ 已设密码（fail-closed 生效）',
);
console.log(
  // ⚠️ 这一行必须说**上一轮是怎么结束的**——否则"它上次是不是被硬杀的"
  //    只能靠猜，而那是排障时第一个要问的问题。
  `  上次收尾 ${
    reconciled.total === 0
      ? '干净（没有未说完的话）'
      : `⚠️ 有 ${reconciled.total} 处没说完（未收口气泡 ${reconciled.orphans} 条` +
        `${reconciled.unanswered > 0 ? ` + 问了没人答 ${reconciled.unanswered} 句` : ''}）` +
        `—— 已收口${reconciled.told > 0 ? '，并告诉了用户' : '（太旧，没打扰用户）'}`
  }`,
);
console.log(
  // ⚠️ "上次是怎么结束的"要一眼看见：它是排障时第一个要问的问题
  `  上次退出 ${boot.uncleanLastRun ? '⚠️ 没善终（被硬杀 / 断电）' : '干净'}` +
    `（${CRASH_WINDOW_MS / 60000} 分钟内第 ${boot.starts} 次启动${boot.degraded ? '，**已降级：这次不续做**' : ''}）`,
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
    turnStatus.stop();
    // ★ 留下"这次是好好走的"标记 ⇒ 下次开机才知道上一次是不是被硬杀的
    markCleanExit(cfg.dataDir);
    process.exit(0);
  });
}
