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
import { Users, maskPhone } from './users.js';
import { TenantChannel } from './tenant-channel.mjs';
import { stepsFor } from './space-steps.js';
import { Worlds } from './worlds.js';
import { OWNER_ID } from './tenants.js';
import { CRASH_WINDOW_MS } from './boot-marker.js';
import { RESUMED_EVENT } from './resume-plan.js';
import { createServer } from './server.js';
import { describeAgentIdentity, loadConfig, preflight } from './config.js';
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

const auth = new Auth({ dataDir: cfg.dataDir });
// ★ **用户表**（多租户第一步 · 契约 `docs/dev/37-MULTITENANT.md` §三）：
//   手机号 → 用户。落在 `data/users.json`（0600、gitignore 里）。
const users = new Users({ dataDir: cfg.dataDir });
// ★ 把主人那个号绑到**原来那个账号**（`owner`）——不绑的话，"先用口令登过的那份数据"
//   和"后来用手机号进来的那个人"会是两个身份（今天看不出来，将来数据一分就分家）。
let ownerBind = null;
if (cfg.ownerPhone) {
  try {
    ownerBind = users.bind(cfg.ownerPhone, 'owner');
  } catch (err) {
    console.warn(`  ⚠️ 主人那个号没绑上（${err?.message ?? err}）——手机号登录会当新用户`);
  }
}

// ════════════════════════════════════════════════════════════
// ★ **一人一份完整的世界**（多租户那一步 · `docs/dev/38-ISOLATION-SPLIT.md` §二）
//
// ⚠️ 这一段原来是一串**单例**（`store` / `timeline` / `notice` / `say` / `trash` /
//    `ledger` / `ledgerSocket` / `dispatcher`）。单例在多租户下有两个**静默串号**：
//      ① 所有人的 agent 会话键都是 `'main'` ⇒ 甲说的话进乙的窗口；
//      ② 所有人共用一个 `DSH_HOME` ⇒ 会话记录互相看得见（N21）。
//    ⇒ 现在全部按 userId 各配一份，见 `worlds.js`。
//
// ⚠️ **顺序上有个环**：runtime 要问 worlds"这个键是谁的 cfg"，
//    而 worlds 要拿着 runtime 才能建派发器 ⇒ 先声明、后赋值，
//    `cfgFor` 是个**闭包**（调用时才读 `worlds`，那时已经赋好了）。
// ════════════════════════════════════════════════════════════
let worlds = null;
const runtime = new AgentRuntime({
  cfg,
  // 🔴 DSH_HOME / 工作目录**按人取** —— 少了这一句，甲乙共用一个 DSH_HOME
  cfgFor: (agentKey) => worlds.cfgForAgentKey(agentKey),
  // ⚠️ 卸一个 agent 时要**先让它的主人收口**：键里带着是谁的（`u1/main`）
  onEvict: (sessionId) => worlds.onEvict(sessionId),
});
worlds = new Worlds({
  cfg,
  runtime,
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
});

// ★ **开机把每个人的世界热一遍**：对账 / 崩溃环 / 回收站都**按人各算一份**。
//   ⚠️ 先 `owner`（他那一份是**原来那份**，`data/` 原地不动），再所有登记过的用户。
//   ⚠️ 一个人失败不许把开机带走（`warmUp` 自己吞）。
const warmed = worlds.warmUp([OWNER_ID, ...users.ids()]);
// 主人那一份：横幅、进程级兜底、开机那几句话都报**他这一份**
// （横幅是本机的排障视图，不是给用户看的；用户各自看自己的界面）。
// ⚠️ **按人各清各的**（`38` §二·补.2 记的第二个窄口）：
//    以前只清**主人那一份**（`cfg.dshHome`），而每个租户都有他自己的 `DSH_HOME`
//    ⇒ 他们的 `sessions/` **只涨不降**。
//    ⚠️ 只动"这个人自己的工作目录对应的那一组"（分组见 `prune.js`）——
//      不分组地清会连**别的项目**和这个 GUI 自己可 resume 的记录一起删。
const pruned = [];
for (const w of worlds.all()) {
  try {
    const groupDir = nodePath.join(w.cfg.dshHome, 'sessions', groupSlugFor(w.cfg.agentCwd));
    if (!nodeFs.existsSync(groupDir)) continue;
    const plan = planPrune({ entries: scanEntries({ root: groupDir }) });
    if (plan.remove.length > 0) {
      const done = applyPrune(plan.remove, { root: groupDir });
      pruned.push({ userId: w.userId, text: summarize(plan, { applied: true, done }) });
    }
  } catch (err) {
    // ⚠️ 一个人清不动不许影响别人，也不许阻断启动
    console.warn(`  ⚠️ ${w.userId} 的旧记录没清成（不影响服务）：${err?.message ?? err}`);
  }
}

const ownerWorld = worlds.worldFor(OWNER_ID);
const { timeline, notice, ledger } = ownerWorld;
const boot = ownerWorld.boot;
const reconciled = boot.reconciled;

// ★ **崩溃环判定**（§11.1）：判断"是不是刚崩过几次"。
// ⚠️ 现在它是**按人各算一份**的（`worlds.js` 里每人一个 `recordStart`）。
//    这里把降级的那些人**挨个喊一声** —— 一个进程崩过，不代表所有人都不该续做。
for (const w of worlds.all()) {
  if (!w.boot.degraded) continue;
  console.warn(
    `  ⚠️ ${w.userId}：${HUMAN_LINES.degraded}\n` +
      `     （${CRASH_WINDOW_MS / 60000} 分钟内启动了 ${w.boot.starts} 次，上一次没善终 ⇒ **这一份这次不续做**）`,
  );
}

// ★ **崩溃/报警那条通知**（批 3 第三件 · 欠账 **#22**："报警没有推送渠道"）。
//
// 判据是 **"上一次没善终"**（被硬杀 / OOM / 断电）——它和横幅那一行
// （`上次退出 ⚠️ 没善终`）说的是**同一个事实**，而横幅只有本机看得见，用户看不见。
//
// ⚠️ **对账已经说过一声的，这里不再说**（契约 §二：同一件事只走一条通道）：
//    那种情况下时间线上已经有一条通知/气泡在讲这次出事，再来一条就是**通知疲劳**
//    ——那正是手册 R1.2 点名叫批 3 合并掉的东西。
//
// ⚠️ 默认**落盘**（取号 ⇒ 时间线里那一条就是它）。`noticeOrUrgent()` 只在
//    **写盘本身失败**时退回瞬态，而那句瞬态**自己说清**"这条我没能记下来"
//    （契约 §三①：例外不许伪装成正常）。
let crashNotice = null;
if (boot.uncleanLastRun && reconciled.told === 0) {
  try {
    crashNotice = notice.noticeOrUrgent({ kind: 'crash' });
  } catch (err) {
    // ⚠️ **不许把进程带走**：那是开机路上的一句话，不是要命的事（照对账那条规矩）。
    console.warn(`  ⚠️ "我起来了"那条通知没发出去：${err?.message ?? err}`);
  }
}

// ⚠️ 下面这几样**不再各自 `new` 一份**了 —— 它们现在住在 `worlds.js` 里，按人各一份。
//    `timeline` / `notice` / `ledger` 在上面取主人那一份时已经解出来了，
//    别的（`say` / `trash` / `ledgerSocket` / `dispatcher`）**一律走 `worlds` 的方法**，
//    免得又出现"两处都能拿到同一件东西"。

// 出事谁接：进程级兜底（手册 §5.2 第 3 层）。
// ⚠️ **已知的窄口**（记在 `38` §二·补）：进程级崩溃是**宿主级**事件，
//    而这条兜底只能往**一份**时间线上写 ⇒ 这里写的是**主人那一份**。
//    别的用户不会被这条叫醒。要不要按人各装一条，等有人真的多起来再定。
// ⚠️ **进程级崩溃是"宿主级"事件**（谁都会被波及）⇒ 通知要**发给每一个人**，
//    而不是只发主人那一份（`38` §二·补.2 里记的窄口就是这个）。
//    ⚠️ 一个人发不出去不许影响别人（各自 `try` 一次）。
installProcessGuard({
  timeline: {
    emitTransient: (e) => {
      for (const w of worlds.all()) {
        try {
          w.timeline.emitTransient(e);
        } catch {
          /* 这一份发不出去，别的照发 */
        }
      }
    },
  },
  notice: {
    noticeUrgent: (o) => {
      for (const w of worlds.all()) {
        try {
          w.notice.noticeUrgent(o);
        } catch {
          /* 同上 */
        }
      }
    },
  },
});

const webRoot = nodeFs.existsSync(nodePath.join(cfg.webRoot, 'index.html')) ? cfg.webRoot : null;

// ★ **"手上还有没有没说完的话"** —— 写一个每秒刷新的小文件（`data/status.json`）。
//   为什么：重启（部署、改配置）**不该把正在说的那一轮切掉**（手册 `06-OPERATIONS.md` §8.3）。
//   `scripts/restart-core.sh` 默认会等它变成"不忙"再动手。
//   ⚠️ 它**只是旁路信息**：写不进去也不许影响服务（`createTurnStatus` 自己吞掉异常）。
const turnStatus = createTurnStatus({
  file: statusPath(cfg.dataDir),
  // ⚠️ **聚合**（`38-ISOLATION-SPLIT.md` §三③）：一人一份会让重启脚本读不懂
  //    （它只看这一个文件）。规则是**任一忙就算忙** —— 宁等不切。
  snapshot: () => worlds.busySnapshot(),
});
turnStatus.start();

// ════════════════════════════════════════════════════════════
// ★ **租户通道**（多租户 ②-4b）：把"这个人自己的 key"送进**他的**容器。
//
// ⚠️ key **只在内存里**（`tenantKeys`）：不落盘、不进日志 —— 中心的角色是**管道**，
//    不是仓库（`37-MULTITENANT.md` §12.1）。服务重启 ⇒ 用户得重填一次，
//    这是**刻意的**（"中心不留用户的 key"）。
// ════════════════════════════════════════════════════════════
const tenantKeys = new Map(); // userId → key（**只在内存**）

const { listen, listenTrusted, close } = createServer({
  // ★ **多租户那一侧**：每个请求按令牌里的 `sub` 取那个人的世界。
  //   ⚠️ 上面那五个单例**不再传**了 —— 传了就等于"所有人共用一份"。
  worlds,
  auth, webRoot, buildId: cfg.buildId,
  users,
  devCode: cfg.devCode,
  setModelKey,
  tenantOf,
  // ★ **"主人那一份"只有一个**：别人要么走他那台容器，要么如实说没准备好
  isLocalUser: (userId) => userId === OWNER_ID,
  // ⚠️ **只查不发**（`hasTunnel` 没有副作用）；主人那种没有容器的 ⇒ `kind:'local'`
  tenantStatusOf: (userId) => {
    // 🔴 **只有"主人"才是 `local`**（他自己那份就在宿主上，没有单独一台）。
    //    ⚠️ 一个**新号**在 `tenantMap` 里**没有对应租户** —— 那**不是** `local`：
    //       `local` 的语义是"本机那份 = 主人那一份"，把新号当成它
    //       就是**让新用户看见主人的东西**（多租户要防的第一件事）。
    const tenant = tenantOf(userId);
    if (!tenant) {
      if (userId === OWNER_ID) return { kind: 'local' };
      // ⚠️ **没分到**不是"正在开" —— 池子里没有空了（见 `41-SPECIAL-CODE.md` §四）。
      //    如实说 `queued`，别让他以为马上就好。
      return { kind: 'tenant', state: 'queued', hasKey: false, steps: stepsFor(0) };
    }
    const up = channel.hasTunnel(tenant);
    return {
      kind: 'tenant',
      state: up ? 'ready' : 'starting',
      hasKey: tenantKeys.has(userId),
      // ★ **真进度**（主人 2026-09-21："创建 docker 空间要能够对用户展示进度"）：
      //   这三条**每一条都是服务端真的知道的事实**，不是编的、也没有百分比。
      steps: stepsFor(up ? 2 : 1),
    };
  },
  // ⚠️ 隧道没通时返回 `null`（调用方**如实回 503**，不许假装通了）
  proxyFor: (tenant) => channel.openSocket(tenant),
  log: (m) => console.log(m),
});

// ★ **回收站那一趟活**：① 到期前一周**告一声** ② 到点就真删（X3③）。
//
// ⚠️ 开机**先跑一次**，不是只等一个钟头：不跑这一次，上一个进程活着的期间
//    就已经进入"最后一周"的那一条，要**再等一小时**才会被告一声。
//
// ⚠️ 两件事都**不许阻断启动 / 不许把进程带走**：它们是维护动作，
//    而且台账（`turn/deleted` 那些墓碑）还在盘上 ⇒ 下一轮还会再试一次，不会漏掉。
// ⚠️ 现在它是**按人各扫一遍**（`worlds.sweepTrash()` 自己吞掉单个人的失败）。
const sweepTrash = () => {
  for (const done of worlds.sweepTrash()) {
    console.log(`  🗑 ${done.userId} 的回收站到点，彻底删掉 ${done.messageIds.length} 条（释放 ${done.freedBytes} 字节）`);
  }
};
try {
  sweepTrash();
} catch (err) {
  console.warn(`  ⚠️ 回收站开机扫一遍没做成（不影响服务）：${err?.message ?? err}`);
}
const trashSweep = setInterval(() => {
  try {
    sweepTrash();
  } catch (err) {
    // ⚠️ 压实失败**不许把进程带走**：它是维护动作，而且台账（`turn/deleted`）
    //    还在盘上 ⇒ 下一轮扫描还会再试一次，不会漏掉。
    console.warn(`  ⚠️ 回收站扫描失败：${err?.message ?? err}`);
  }
}, 60 * 60 * 1000);
trashSweep.unref?.();

// ★ **续做**：对账说出口的那句"我重新做一遍"，在这里真的做。
// ⚠️ 顺序不能反：**先落 `task/resumed`（记额度）再投递** ——
//    投递失败也要算一次"发起过"，否则一个每次投递都失败的活会被无限重试。
// ⚠️ 那句对用户说的话**不在这儿**：它由对账按契约 `29-NOTICE.md` §5.1
//    走**通知通道**发（`resumed` / `not-resumed`）——**同一件事只走一条通道**。
// ⚠️ 现在**按人各做各的**：甲那份要续做，与乙没关系。一个人失败不许影响别人。
for (const w of worlds.all()) {
  const r = w.boot.reconciled;
  if (r?.resume) {
    const { ref, text, attempt } = r.resume;
    console.log(`  ▶ ${w.userId} 续做：把「${text.slice(0, 24)}…」重做一遍（第 ${attempt} 次）`);
    try {
      w.timeline.emit({ type: RESUMED_EVENT, ref, attempt });
      w.dispatcher.deliver(text, { messageId: ref }).catch((err) => {
        console.warn(`  ⚠️ ${w.userId} 续做投递失败：${err?.message ?? err}（额度已经记过了）`);
      });
    } catch (err) {
      console.warn(`  ⚠️ ${w.userId} 续做没发起：${err?.message ?? err}`);
    }
  } else if ((r?.total ?? 0) > 0) {
    console.log(`  · ${w.userId} 没有自动重做（原因：${r.resumeReason}）`);
  }
  if (r?.noticed) console.log(`  🔔 ${w.userId} 已通知 ${r.noticed}（时间线里有一条）`);
  if (!r?.ok) console.warn(`  ⚠️ ${w.userId} 开机对账没做成：${r?.error}（**不影响启动**）`);
}
// ⚠️ 这两行要**如实报**：通知发没发出去、发的哪一条，是"用户到底看没看见"的唯一线索
//    （横幅是本机那一眼，通知才是**用户那一眼**）。
if (reconciled.noticed) console.log(`  🔔 已通知   ${reconciled.noticed}（时间线里有一条）`);
if (crashNotice) console.log('  🔔 已通知   crash（时间线里有一条）');

// ★ **可信的本地 UDS**（选项甲）：容器里额外听一条 `0600` 的套接字 ——
//   隧道代理（root）从它进来，请求就**不再需要令牌**（身份由内核的文件权限保证）。
//   ⚠️ 先删掉上次留下的：套接字文件不删，`listen` 会撞 `EADDRINUSE`
//      （而那句话看起来像"端口被占"）。
if (cfg.trustedSocketPath) {
  try {
    nodeFs.unlinkSync(cfg.trustedSocketPath);
  } catch {
    /* 不存在是正常的 */
  }
}
const addr = await listen(cfg.port, cfg.host);
if (cfg.trustedSocketPath) {
  try {
    nodeFs.mkdirSync(nodePath.dirname(cfg.trustedSocketPath), { recursive: true, mode: 0o700 });
    await listenTrusted(cfg.trustedSocketPath);
    console.log(`  可信口   ${cfg.trustedSocketPath}（0600 · 只有 root 开得开）`);
  } catch (err) {
    console.warn(`  ⚠️ 可信口没起来：${err?.message ?? err}（隧道进来的请求会拿不到身份）`);
  }
}

// 启动横幅**报告状态**，不喊口号（手册 §11.4）
console.log('── 琥珀 · 调度器（v2）────────────────────────');
console.log(
  cfg.host === '127.0.0.1'
    ? `  监听     127.0.0.1:${addr.port}   （对外走 VPS 的 stcp 隧道）`
    // ⚠️ 绑到 0.0.0.0 只有一种正当场合：**服务跑在容器里**。
    //    在宿主上这么干 = 把服务递给整个局域网 ⇒ 必须**大声**说出来（不许静默）。
    : `  ⚠️ 监听     ${cfg.host}:${addr.port} —— **不是回环**！` +
      `只有"服务跑在容器里"才该这样；在宿主上这是把服务递给了整个局域网。`,
);
console.log(`  数据     ${cfg.dataDir}`);
console.log(`  界面     ${webRoot ?? '（没有 web 产物，只服务 API）'}`);
console.log(`  构建     ${cfg.buildId}`);
// ⚠️ 这一行必须**如实**：清单还没建的时候，这道闸是**没有**的。
//    报成"OK"就是"看起来有闸、其实没有"——比不设更坏。
console.log(`  准入     ${describeAdmission(adm)}`);
for (const p of pruned) console.log(`  顺手清   ${p.userId}：${p.text}`);
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
// ⚠️ 这一行必须**如实报**"手是谁"：换手没配/换不过去的时候一切看起来都正常，
//    而它恰好决定决策 ① 那条边界在不在（`39-PERMISSIONS.md` §7.1）。
console.log(`  agent 身份 ${describeAgentIdentity(cfg)}`);
// ⚠️ 下面这几行**报的是「主人那一份」**（横幅是本机排障视图，不是给用户看的）。
//    多租户之后每个人的 DSH_HOME / 工作目录都不同 —— 不标明就会被读成「所有人的」。
console.log(`  工作目录 ${cfg.agentCwd}（主人那一份；别人各在自己那一格里）`);
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
  `  上次收尾(主人) ${
    reconciled.total === 0
      ? '干净（没有未说完的话）'
      : `⚠️ 有 ${reconciled.total} 处没说完（未收口气泡 ${reconciled.orphans} 条` +
        `${reconciled.unanswered > 0 ? ` + 问了没人答 ${reconciled.unanswered} 句` : ''}）` +
        `—— 已收口${reconciled.told > 0 ? '，并告诉了用户' : '（太旧，没打扰用户）'}`
  }`,
);
console.log(
  // ⚠️ "上次是怎么结束的"要一眼看见：它是排障时第一个要问的问题
  `  上次退出(主人) ${boot.uncleanLastRun ? '⚠️ 没善终（被硬杀 / 断电）' : '干净'}` +
    `（${CRASH_WINDOW_MS / 60000} 分钟内第 ${boot.starts} 次启动${boot.degraded ? '，**已降级：这次不续做**' : ''}）`,
);
console.log(`  时间线   主人那一份已有事件 ${timeline.seq} 条（别人各数各的）`);
console.log(
  // ⚠️ 这一行要**如实报账本那两支东西在不在**：能力层缺了的时候，
  //    "它今天没记账"看起来只是它忘了 —— 而那正是查不出来的故障。
  `  账本(主人) ${ledger.list().length} 笔（回收站 ${ledger.listBin().length} 组）` +
    `；本地通道 ${nodeFs.existsSync(cfg.ledgerSocketPath) ? '通了' : '⚠️ 没起来'}`,
);
console.log(`  能力层   ${cfg.capabilitiesPath}（${nodeFs.existsSync(cfg.capabilitiesPath) ? '已挂上' : '⚠️ 文件不在'}）`);
console.log(
  // ⚠️ **这一行必须大声**：临时码开着 = **谁都能用任意手机号进去**（手机号就是账号）。
  //    这个项目最忌的就是"看起来有闸、其实没有"——所以它不许静默开着。
  cfg.devCode
    ? `  ⚠️ 临时验证码 **开着**（HUPO_DEV_CODE）⇒ **任何手机号 + 它都能进**。这不是上线形态。`
    : '  手机号登录 没开（要临时验证码就设 HUPO_DEV_CODE；⚠️ 设了谁都能进）',
);
console.log(
  `  用户     ${users.size} 个（手机号只落在 data/users.json，不进仓库不进日志）` +
    (ownerBind
      ? `｜主人号 ${maskPhone(cfg.ownerPhone)}${ownerBind.changed ? ' 刚绑上' : ' 已绑'} → owner`
      : ''),
);
console.log(
  // ⚠️ 通道那一行也要**如实**：它报的是"我给几个租户开着口"，
  //    而不是"有几台容器真的在跑"（那两个数不是一回事）。
  `  租户通道 ${channelTenants > 0 ? `${channelTenants} 个租户在听（${cfg.tenantChannelDir}）` : '⚠️ 没开（HUPO_TENANT_MAP 空 / 目录没配）'}`,
);
console.log(
  // ⚠️ **这一行是多租户接上之后必须有的**：不报它，就看不出「到底有几个人各过各的」。
  //    ⚠️ 它是**建了几份世界**，**不是「在线人数」** —— 这两个数不是一回事。
  `  世界     ${worlds.size} 份（owner + 登记过的用户，各过各的；不是在线人数）`,
);
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
    // ⚠️ 现在**每个人都要收**：只收主人那一份 = 别人的话被切断
    //    （而且他们的 agent 会成为孤儿进程）。
    await worlds.shutdownDispatchers();
    await runtime.shutdown();
    await close();
    turnStatus.stop();
    clearInterval(trashSweep);
    // ⚠️ 账本那些口要关掉**并把套接字文件删掉**：留着它，下次
    //    `listen()` 会撞上 `EADDRINUSE`，而那句话看起来像"端口被占"。
    worlds.closeSockets();
    channel.close();
    // ★ 每个人各留一个"这次是好好走的"标记 ⇒ 下次开机才知道上一次是不是被硬杀的
    worlds.markCleanExitAll();
    process.exit(0);
  });
}
