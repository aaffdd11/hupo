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
import { Users, maskPhone } from './users.js';
import { TenantChannel } from './tenant-channel.mjs';
import { stepsFor } from './space-steps.js';
import { Worlds } from './worlds.js';
import { OWNER_ID, readTenantTemplate, tenancyFor, tenantNameFor, userIdNumber } from './tenants.js';
import { ProvisionQueue } from './provision.js';
import { dropTunnel, notifyHost } from './tenant-tunnel-agent.mjs';
import { CRASH_WINDOW_MS } from './boot-marker.js';
import { RESUMED_EVENT } from './resume-plan.js';
import { appsBaseOf, createAppServer, loadSignKey } from './app-serve.js';
import { createAsrRelay } from './asr.js';
import { createHarnessRelay } from './harness-session.mjs';
import { createDevWebRelay } from './dev-mode.js';
import { readUserCreds, writeUserCreds } from './creds-store.js';
import { makeDrawImage } from './image-use.js';
import { OWNER_KEY_REF, writeOwnerKey } from './owner-creds.js';
import { describeVoiceCreds, resolveVoiceCreds, voiceCredsFor } from './asr-creds.js';
import { createServer } from './server.js';
import { describeAgentIdentity, loadConfig, preflight } from './config.js';
import { integrityReport, repoRootFor, resolveServiceHome } from './integrity.js';
import { describeAdmission, readAdmission } from './admission.js';
import { applyPrune, groupSlugFor, planPrune, scanEntries, summarize } from './prune.js';
import { createTurnStatus, statusPath } from './turn-status.js';
import { ROLLOUT_SWEEP_MS, compareTenantBuild, createNagBook, planRollout, readProductLayer } from './product-layer.js';
import { DEFAULT_DROP_DIR, createKeyDrop, resolveDropName } from './key-drop.js';
import { keyFileFor } from './key-path.mjs';
import { keyStateOf } from './key-state.js';
import { auditPath } from './audit.js';
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
const repoRoot = repoRootFor(import.meta.dirname);
// ⚠️ **不许在这儿写 `os.homedir()`**（P1-15，2026-09-24）：那算的是**现在跑这条命令的人**
//    的 home。用 `sudo` 起服务时它是 `/root`，而清单里几条 `~/.dsh/**` 是**按仓库属主**算的
//    ⇒ 两边算的不是同一个 home ⇒ 那几条**没在核对**，而横幅照样写"对上了"。
//    ⇒ 身份只住在 `resolveServiceHome()` 一处（与 `--build` 那一侧同一个函数）。
const serviceHome = resolveServiceHome({ repo: repoRoot });
const ig = integrityReport({
  // ⚠️ **不许在这儿手写"往上几级"**（2026-09-22：写成 `'../../..'` ⇒ 只到 `v2/`，
  //    7 条受保护路径不存在、那条闸空转、补救命令指向不存在的文件）。
  //    ⇒ 那一段只住在 `integrity.js` 的 `REPO_ROOT_FROM_SRC`。
  repo: repoRoot,
  home: serviceHome,
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
/**
 * 🔴 **上游说"用不了"的那几把钥匙**（`44-CONTAINER-MODEL-KEY.md` §六）。
 *
 * 为什么要有它：钥匙**填错了**是最常见的一种失败，而客户端只有在
 * "这一台没有钥匙"时才进得去填钥匙那一屏 —— 不把那一把标掉，
 * 用户就**永远回不去**（那句"刷新一下就能重新填"也就成了假话）。
 *
 * ⚠️ **只标在宿主内存里**（不落盘、不进日志）：它是一份"这一把不灵"的账，
 *    不是钥匙本身 —— 钥匙照旧只在内存与盒内 tmpfs 里。
 * ⚠️ 用户重新填一把 ⇒ 立刻从这里面摘掉（见 `setModelKey`）。
 */
const badKeys = new Set();

worlds = new Worlds({
  cfg,
  runtime,
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
  // ★ 上游回 401 ⇒ 把那一把标成"用不了"（`hasKey` 随之变回 false）
  onAuthFailure: (userId) => {
    // 🔴 **每一次都要真做，去重只留给日志**（2026-09-21 实测栽了一次）：
    //    原来这里第一行是 `if (badKeys.has(userId)) return;` —— 于是
    //    **一个容器一辈子只会撤一次钥匙**：用户第二把又填错时，
    //    盒里那本账还记着"说过"，于是**不删、不告诉宿主** ⇒
    //    宿主那边 `hasKey` 还是 `true` ⇒ **他刷新也回不到填钥匙那一屏**（卡住）。
    //    ⚠️ 宿主清那本账的唯一时机是"他又填了一把"，**盒里那本没人清** ——
    //      所以这里不能拿它当"做过了"的依据。
    const first = !badKeys.has(userId);
    badKeys.add(userId);
    tenantKeys.delete(userId);
    if (first) {
      console.log(
        `  🔑 ${userId} 那把钥匙上游说用不了 —— 标成"要重填"（他刷新那一页就能重新填）`,
      );
    }
    // 🔴 **还要告诉宿主**（2026-09-21）：租户那一份调度器在**容器里**跑，
    //    它标掉的是**盒内**那本账；而用户那一屏问的是**宿主** ——
    //    不告诉它的话，宿主内存里那份会让 `hasKey` 还是 `true`，
    //    于是"刷新一下就能重新填"**又变成一句假话**（这条我踩过一次了）。
    //    ⚠️ 宿主上这条是**空操作**（那儿没有隧道，`liveSend` 是 null）。
    const told = notifyHost({ v: 1, type: 'key-bad' });
    // ⚠️ **它可能没送到**（连接恰好在重连 ⇒ 写进了空气）。实测栽过一次：
    //    容器日志说"我告诉宿主了"，而宿主什么都没收到。
    //    ⇒ 再**掐一下隧道**：三秒后它自己连回来，`tunnel-ready` 里会**自报**
    //      "我这儿没有钥匙了" —— 那是一条**一定会送到**的路。
    if (!told) dropTunnel();
    // ⚠️ 顺手把盒里那一把也删掉：上游已经不认它了，留着只是让它继续被拿去试。
    //    （宿主上没有这个文件，删不到就是删不到，不影响。）
    try {
      nodeFs.unlinkSync(keyFileFor());
    } catch {
      /* 不在（宿主上就是这样）或者删不掉 —— 都不该把收口带走 */
    }
  },
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
// 🔴 **只有在"真的打断了什么"的时候才说**（2026-09-21 主人报的一个真问题）：
//    原来只判 `uncleanLastRun` ⇒ **无事也报**。现象是主人**一登录**就看见
//    "刚才出了点事，我已经重来了" —— 他刚进来、什么都没说，那句话读起来像
//    "你刚才说的那条我还没做好"（而它其实在报告"上一次进程是怎么没的"）。
//    ⚠️ 这违反项目自己的 **R1.2「通知疲劳」**：没有被打断的事，就不该打扰人；
//       **真的打断了**（`reconciled.total > 0`）时，对账那一路**本来就会说**
//       （`told > 0`），所以这一条只在"有东西没收口、但对账没来得及说"时补位。
if (boot.uncleanLastRun && reconciled.told === 0 && reconciled.total > 0) {
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

// ⚠️ 下面这一整段（`tenantOf` / `userOfTenant` / 通道）在 2026-09-21 被我**误删过一次** ——
//    删内联函数时切多了，现象是服务起来就 `ReferenceError: tenantOf is not defined`。
//    ⇒ 教训记在 `38` §9.4：**动启动路径上的顺序/片段，改完先在隔离目录跑一次**。
// ★ **租户命名模板**（契约 `43-AUTO-PROVISION.md` §三 A2）：**唯一权威**在
//   `tenant-template.conf`（服务侧与 root 侧都读它 ⇒ 两边推出来的名字必然逐字相同）。
//   ⚠️ 读不到 ⇒ "自动开一台"这条路**关着**，但**不许**因此挡住服务（那是附加能力）。
const tpl = readTenantTemplate();
const queue = new ProvisionQueue({
  // ⚠️ `''` 时退回默认那个路径（`/run/hupo-provision`）—— 但判据里可以指到临时目录
  ...(cfg.provisionDir ? { dir: cfg.provisionDir } : {}),
  // ⚠️ 标记**另放一个目录**（同 `provision.js` 顶上那段：留在投放口里会反复触发）
  ...(cfg.provisionFailedDir ? { failedDir: cfg.provisionFailedDir } : {}),
  log: (m) => console.log(m),
});

// ⚠️ **表优先，推出来的兜底**：
//   · `u1→hupo-a`、`u2→hupo-b` 是**已经建好在跑**的两台 ⇒ 表里写死的那个名字赢；
//   · 表里没有的 `u<N>`（第 3 个及以后的新号）⇒ 按模板推 `hupo-t<N>`。
//   ⚠️ 这一条**必须**留着表的优先权：否则 `u1` 会被推成 `hupo-t1`，
//      而真在跑的那台叫 `hupo-a` ⇒ 服务去听一个没人连的通道，
//      现象是"主人自己那台好好的、老用户全都连不上"。
const tenantOf = (userId) => cfg.tenantMap.get(userId) ?? tenantNameFor(userId, tpl);
const userOfTenant = (tenant) => {
  for (const [uid, t] of cfg.tenantMap) if (t === tenant) return uid;
  // 推出来的那种：`hupo-t<N>` → `u<N>`（只认前缀 + 纯数字，别的一律不认）
  if (tpl.ok && tenant.startsWith(tpl.namePrefix)) {
    const rest = tenant.slice(tpl.namePrefix.length);
    if (/^[1-9][0-9]{0,2}$/.test(rest)) return `u${rest}`;
  }
  return null;
};

// ★ **当前产品层是哪一版**（契约 `docs/dev/45-TENANT-UPDATE.md`）。
//   ⚠️ **读不到就是 `null`**，而且那时**谁都不叫重开** ——
//      叫了就是让每一台去挂一个不存在的东西（那正好会把它们全弄死）。
//   ⚠️ 这里**不自己算指纹**：算它的地方只有 `scripts/build-tenant-code.sh` 一处。
//   🔴 **不许缓存**（2026-09-21 真机实测栽的）：开机时读一次存起来，翻完 `current`
//      它就**变成一句假话** —— 而它正好用在"要不要叫那台重开"的判断上 ⇒
//      容器拿到新的一版、报上来，宿主却拿**旧的**当前版去比 ⇒ 又叫它重开 ⇒
//      **来回退、永远不收敛**（实测：两台容器被反复重启）。
//      ⇒ 规矩：**每次现读**（一次 `readlink` + 一个小文件，便宜到不用想）。

// ★ **隔一会儿扫一遍"有没有哪台还在旧版上"**（契约 `docs/dev/45-TENANT-UPDATE.md` §三）。
//   🔴 为什么非要它：比版本原来只挂在 `tunnel-ready` 上，而那条隧道是**长连接** ——
//      一直连着就永远不再报 ⇒ **翻完 current，正在跑的那几台谁都不知道**
//      （要等宿主重启或它自己断线）。那等于"自动更新"只在碰巧重连时成立。
//   ⚠️ 那一帧**发重了没害处**（容器只认一次、而且只在空闲时才退），
//      但**日志不许刷屏** ⇒ 同一台同一版只说一次（`createNagBook`）。
const nagBook = createNagBook();
const rolloutTimer = setInterval(() => {
  const cur = readProductLayer()?.fingerprint ?? null;
  for (const { tenant, line } of planRollout({ reports: channel.builds, current: cur })) {
    if (nagBook.take(tenant, cur)) console.log(`  ⚠️ ${tenant}：${line} —— 叫它重开一次`);
    channel.requestReload(tenant);
  }
  for (const [tenant, reported] of channel.builds) {
    if (cur && reported === cur) nagBook.forget(tenant);
  }
}, ROLLOUT_SWEEP_MS);
rolloutTimer.unref?.();

// ⚠️ 先声明（投递看守在**下面**才建得起来：它要用 `channelTenantNames`）。
//    用 `let` + `?.` 是因为通道**开机就可能连进容器**，而那时候它还没建好 ——
//    直接引用一个 `const` 会撞 TDZ（那个回调被 try 包着，只会打一行警告、真事丢了）。
let keyDrop = null;

const channel = new TenantChannel({
  dir: cfg.tenantChannelDir,
  // ⚠️ 收到的 `tenant` 是**套接字名**；key 按 **userId** 存 ⇒ 这里要翻一次
  keyFor: (tenant) => {
    const uid = userOfTenant(tenant);
    return uid ? (tenantKeys.get(uid) ?? null) : null;
  },
  // ★ **容器自报的版本指纹**（契约 `docs/dev/45-TENANT-UPDATE.md`）：
  //   比完**该说话就说话**（`compareTenantBuild` 是纯函数，`test/unit` 里真验），
  //   不一致就**叫它重开**（那一帧不带内容；退不退由它自己定）。
  //   ⚠️ **读不到当前产品层 ⇒ 谁都不叫**（`unknown`）：叫了就是让它们去挂一个
  //      不存在的东西 —— 那正好会把每一台都弄死。
  onBuild: (tenant, buildId) => {
    // ⚠️ **现读**（原因见上面那条：缓存会在翻转之后变成假话）
    const cur = readProductLayer()?.fingerprint ?? null;
    const v = compareTenantBuild({ reported: buildId, current: cur });
    if (v.verdict !== 'same') console.log(`  ${v.reload ? '⚠️' : '·'} ${tenant}：${v.line}`);
    return v;
  },
  // ★ **容器说"那把钥匙不灵了"**（`44-CONTAINER-MODEL-KEY.md` §六）：
  //   把宿主这本账也收拾干净 —— 不然用户那一屏会一直说"有钥匙"，回不去重填。
  // ★ **容器自报"我有钥匙了"**（2026-09-22 加 · `46-KEY-DELIVERY.md` §四）：
  //   两种情况会走到这儿 —— 主人在**盒子里**放了一把（`put-key`），或者
  //   主人从**本机投递**进来一把。两种情况下中心那本"这把用不了"的旧账都该清掉，
  //   不然用户明明换了一把好的，界面上还挂着"刷新一下重新填"。
  onKeyUp: (tenant) => {
    const uid = userOfTenant(tenant);
    if (!uid) return;
    if (badKeys.delete(uid)) console.log(`  🔑 ${uid} 换了一把能用的 ⇒ 把"要重填"那条清掉`);
    // ★ 投递那条路：**它自己说拿到了**，才把主人投的那个文件删掉（契约 §三.2）
    keyDrop?.confirmed(uid);
  },
  onKeyBad: (tenant, why) => {
    const uid = userOfTenant(tenant);
    if (!uid) return;
    // ⚠️ **两种情形要分开**（`why`）：
    //   · `rejected` —— 上游说这一把不灵了 ⇒ **标成"要重填"**；
    //   · `absent`   —— 容器说"我这儿没有钥匙"（它重启过 / 刚被撤掉）⇒
    //                   **只清宿主这本账**，**不许**把那把标成坏的
    //                   （我们并不知道它坏，只是宿主忘了而已）。
    //    混成一种的话，容器每重启一次就会把用户一把**好好的**钥匙标成坏的。
    if (why === 'rejected') badKeys.add(uid);
    tenantKeys.delete(uid);
    console.log(
      why === 'rejected'
        ? `  🔑 ${uid} 那把钥匙用不了（他那台说的）—— 他刷新那一页就能重新填`
        : `  🔑 ${uid} 那台说它手上没有钥匙 —— 宿主这本账跟着清掉（别的地方都不用动）`,
    );
  },
  log: (m) => console.log(m),
});
// ★ **静态表里那几台** + **已经推出来的那几台**都要在开机时把耳朵支起来。
//
// ⚠️ 为什么要管推出来的那些（`43-AUTO-PROVISION.md`）：它们是**按需**建的，
//    而这条通道在 `/run`（**tmpfs**）—— 宿主一重启，目录全没了。
//    那时候容器还活着、还在重连，而服务这边**没有人再替它听** ⇒
//    现象是"重启之后某几个老用户永远卡在 waiting"（`38` §七 那个坑的同族）。
const channelTenantNames = [
  ...new Set([
    ...cfg.tenantMap.values(),
    // ⚠️ 只认**已经存在**的（`users.ids()` 是登记过的号）：不认识的号不在开机时开通道，
    //    它们是登录那一刻才支耳朵（见 `ensureTenant`）。
    // 🔴 **表里已经有名字的那些要排掉**（2026-09-21 隔离启动抓到的）：
    //    `u1` 在表里是 `hupo-a`，而 `tenantNameFor('u1')` 会推出 `hupo-t1` ——
    //    那是个**不存在的租户**。不排掉的话开机就会多听两条没人连的通道，
    //    而横幅会报"4 个租户在听"（**在说假话**：真在跑的只有两台）。
    ...users
      .ids()
      .filter((uid) => !cfg.tenantMap.has(uid))
      .map((uid) => tenantNameFor(uid, tpl))
      .filter(Boolean),
  ]),
];
if (cfg.tenantChannelDir && channelTenantNames.length > 0) {
  try {
    for (const t of channelTenantNames) {
      channel.listenFor(t);
    }
  } catch (err) {
    console.warn(`  ⚠️ 租户通道没全开起来：${err?.message ?? err}（那几台容器会一直等配置）`);
  }
}
// ════════════════════════════════════════════════════════════
// ★ **本机投递一把钥匙**（2026-09-22 · 契约 `docs/dev/46-KEY-DELIVERY.md` §三.2）
//
//   主人要的第三个入口：*"还要能从外面投进去（不动 root）"*。
//   往 `<投递目录>/<租户名|编号|手机号>.key` 里写一把，宿主替他送进那台容器。
//
//   ⚠️ **它不新增能力**：能写那个目录的人就是 `deploy`（主人），他本来就能
//      `podman exec`、就能跑 `scripts/…`。这条路的价值是**顺手**。
//   ⚠️ **送到才删**：文件留到那一台**自报"我有钥匙了"**才删；认不出的挪进
//      `.rejected/`（**留证据，不删**）—— 那里面可能是一把真钥匙。
//   ⚠️ **钥匙永远不进日志**（这一整段里没有一处打 key）。
// ════════════════════════════════════════════════════════════
// ⚠️ **只在宿主那侧起**（2026-09-21 一次性容器里看出来的）：盒子里 `os.homedir()`
//    是 `/data` ⇒ 默认目录会算成 `/data/.hupo-keys`，而"投递"这件事**压根不是盒里的事**
//    ⇒ 盒里的横幅会报一个不存在的目录（那是**在说假话**）。
const dropDir = process.env.HUPO_KEY_DROP ?? DEFAULT_DROP_DIR;
const isHostSide = !process.env.HUPO_CHANNEL; // 盒里那条通道是必给的（`--env HUPO_CHANNEL=…`）
if (isHostSide) {
keyDrop = createKeyDrop({
  dir: dropDir,
  deliver: (userId, key) => setModelKey(userId, key),
  resolve: (name) =>
    resolveDropName(name, {
      tenantNames: channelTenantNames,
      userIdOfTenant: (t) => userOfTenant(t),
      tenantOfUser: (u) => tenantOf(u),
      userIdOfPhone: (p) => users.get(p)?.id ?? null,
    }),
  log: (m) => console.log(m),
});
keyDrop.start();
}

// ⚠️ 这条路关着的时候要**说一声**（不然"新号一直排队"看起来像别的地方坏了）
if (!tpl.ok) {
  console.warn(
    '  ⚠️ 没有租户模板（v2/services/core/tenant-template.conf）⇒ **"自动开一台"这条路关着**，' +
      '新号只能排队',
  );
}

/**
 * **用户填了自己的 key** ⇒ 只做两件事：记在内存里、推给他那台容器。
 * ⚠️ 返回值里**不含 key**；日志里也不含。
 * ⚠️ （这一坨在 2026-09-21 被我误删过一次 —— 删内联函数时切多了，
 *     现象是服务起来就 `ReferenceError: setModelKey is not defined`。）
 */
/**
 * 主人那一份的凭据文件在哪（**只此一处**）。
 * ⚠️ 事实来自 DSH 自己：`$DSH_HOME/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`
 *    ——`records` 里那条是**浏览器会话授权**，与钥匙无关（`owner-creds.js` 顶上写着）。
 */
function ownerCredsFile() {
  return nodePath.join(cfg.dshHome, '.credentials.yaml');
}

/** 主人那份凭据里**现在有没有**一把语言钥匙（读，不写；读不到 ⇒ false）。 */
function ownerHasModelKey() {
  try {
    const text = nodeFs.readFileSync(ownerCredsFile(), 'utf8');
    const m = text.match(new RegExp(`^\\s+${OWNER_KEY_REF}\\s*:\\s*(\\S.*)$`, 'm'));
    return Boolean(m && m[1].trim().length > 0);
  } catch {
    return false;
  }
}

/**
 * **配置页那四样写进来**（主人 2026-09-24）。
 *
 * 分路（**别读成一套**）：
 *   · 语言那一把 + 主人 ⇒ 写 **DSH 自己那份凭据**（他授权我动它：2026-09-24）；
 *   · 语言那一把 + 租户 ⇒ **已有的那条路**（推给他盒子的卷，`setModelKey`）；
 *   · 其余三样 ⇒ **中心这份按人存档**（`creds-store.js`）。
 *     ⚠️ 为什么不塞进盒子那个文件：盒子那边是**整份重写**（只写一行模型钥匙）
 *        ⇒ 下一次送钥匙就把它们抹掉；要真进盒子得改产品层（部署期，要主人签字）。
 *
 * @returns {{ok:boolean, why:string, status?:number, text?:string, creds?:object}}
 */
/**
 * **画一张图**（P1-27 · 主人 2026-09-24：*"图片用seedream，volcengine的。"*）。
 *
 * ⚠️ 规则**只住一处**（`image-use.js`）：这里只是把它造出来，
 *    两个入口（`/api/image` 与小程序通道上的 `draw`）用的是**同一个**。
 */
const drawImage = makeDrawImage({
  dataDir: cfg.dataDir,
  log: (m) => console.log(`  ${m}`),
});

function setCreds(userId, patch) {
  const out = {};
  const modelKey = Object.prototype.hasOwnProperty.call(patch, 'model') ? patch.model : null;
  const others = { ...patch };
  delete others.model;

  if (modelKey !== null) {
    if (tenantOf(userId)) {
      // ★ **整包一起推**（P1-29）：模型那一把 ＋ 它这次给的所有字段（语音/图片/视频）
      //   ⇒ 盒子里那个服务（识别路、画图工具）才拿得到。老的 `setModelKey` 只推一把。
      const r = setModelKey(userId, modelKey, patch);
      if (!r?.ok) return { ok: false, why: r?.why ?? 'cannot-set', status: 409 };
    } else {
      // 主人（`local`）—— 只有他这一种人会被写这一份
      const r = writeOwnerKey({ file: ownerCredsFile(), key: modelKey });
      if (!r?.ok) {
        // ⚠️ 报错**不带钥匙、不带路径**（`why` 是几个固定词，见 `owner-creds.js`）
        return { ok: false, why: r?.why ?? 'cannot-set', status: 409 };
      }
      console.log(`  🔑 主人那一份的语言钥匙换好了（备份：${nodePath.basename(r.backup ?? '')}）`);
    }
    out.model = modelKey;
  }

  if (Object.keys(others).length > 0) {
    const r = writeUserCreds(cfg.dataDir, userId, others);
    if (!r?.ok) return { ok: false, why: r?.why ?? 'cannot-set', status: 409 };
  }
  return { ok: true, why: 'saved', creds: credStatusOf(userId) };
}

/**
 * **那四样有没有**（配置页那四个 tab 与 `/api/space`）。
 * 🔴 只回**有没有** —— 一个字符的值都不出去。
 */
function credStatusOf(userId) {
  const mine = readUserCreds(cfg.dataDir, userId).status;
  let model = mine.model;
  if (tenantOf(userId)) {
    // 租户：权威是**他那台自己报的**（他真拿着），宿主内存只是"我送过"
    try {
      model = Boolean(keyStateOf({
        hasKeyPushed: tenantKeys.has(userId),
        hasKeyReported: channel.hasKeyFor(tenantOf(userId)),
        rejected: badKeys.has(userId),
      }).hasKey);
    } catch {
      model = false;
    }
  } else {
    model = ownerHasModelKey() || mine.model;
  }
  return { model, voice: mine.voice, image: mine.image, video: mine.video };
}

function setModelKey(userId, key, creds = null) {
  const tenant = tenantOf(userId);
  if (!tenant) return { ok: false, why: 'no-tenant' };
  // ★ 他又填了一把 ⇒ 上一把"用不了"的账**当场清掉**
  badKeys.delete(userId);
  tenantKeys.set(userId, key);
  // ⚠️ 老形状（key）与新形状（creds）**一起送**（`pushKey` 顶上写着理由）
  const pushed = channel.pushKey(tenant, key, creds);
  // ⚠️ **这句话 2026-09-22 改过**：原来写"**不落盘**"，而钥匙现在会落在他自己那台
  //    容器的**卷**里（`46-KEY-DELIVERY.md` §二）⇒ 那句话当时起就是**假话**了。
  //    中心这一侧仍然不落盘（内存里那份宿主一重启就没了），落盘的是**他那台自己**。
  console.log(
    `  🔑 ${userId} 的模型凭据已收下（送给他那台容器；中心不留，他那台自己存在卷里）` +
      (pushed > 0 ? '' : '（⚠️ 他那台现在没连着，等他连上会自动推过去）'),
  );
  return { ok: true, why: pushed > 0 ? 'pushed' : 'queued', pushed };
}

/**
 * **他要一台，我们就替他申请一台**（契约 `43-AUTO-PROVISION.md` §四）。
 *
 * 🔴 这是这套设计里**唯一一处新增的副作用**：往申请目录里放一个**空文件**，
 *    名字是一个整数。**服务永远不执行任何特权动作**（A1）。
 *
 * @returns {{ok:boolean, why:string}}
 */
function ensureTenant(userId) {
  const kind = tenancyFor(userId, { map: cfg.tenantMap, tpl });
  // 主人那一份在本机、静态表里那两台已经建好在跑 ⇒ 没什么可申请的
  if (kind === 'local' || kind === 'mapped') return { ok: true, why: kind };
  if (kind !== 'provisionable') return { ok: false, why: kind };

  const tenant = tenantNameFor(userId, tpl);
  // ★ **先把耳朵支起来**（在投申请**之前**）：容器起来时它的 `ExecStartPre`
  //   在等这个套接字，等不到的话 podman 会把那个路径**建成一个目录**，
  //   然后容器连它连不上 —— 而报错完全看不出原因（`38` §七 那个坑）。
  try {
    channel.listenFor(tenant);
  } catch (err) {
    console.warn(`  ⚠️ 给 ${userId} 支通道没成：${err?.message ?? err}`);
  }
  return queue.request(userId);
}

// ★ **主人那一份的"问一句"**（乙-4c · 契约 `docs/dev/59-USER-APPS.md` §八）。
//
//   主人没有匣子 ⇒ 他这一份的钥匙在 **DSH 自己那份凭据**里
//   （`<DSH_HOME>/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`，实测出来的形状）。
//   ⇒ 在本机起一个**同样的小代理**：钥匙进内存，**不打印、不落盘、不回显**；
//     小程序问一句时由它换成真 key（和匣子里那条路一模一样）。
//
//   ⚠️ **只在宿主上起**：匣子里那一份由 `entry.mjs` 起过了，两边都起会撞端口。
//   ⚠️ 起不来**不许把服务带走**（但要说出来 —— 静默降级是本仓库反复栽的形状）。
if (process.env.HUPO_ROLE !== 'tenant') {
  try {
    const dshCreds = nodePath.join(cfg.dshHome, '.credentials.yaml');
    if (nodeFs.existsSync(dshCreds)) {
      const { startModelProxy } = await import('./model-proxy.mjs');
      await startModelProxy({
        keyFile: dshCreds,
        keyFormat: 'dsh-refs',
        log: (m) => console.log(m),
      }).listen();
    } else {
      console.log('  （没找到主人那份凭据 ⇒ 小程序"问一句"这条路过不去）');
    }
  } catch (err) {
    console.warn(`  ⚠️ 本机那个小代理没起来：${err?.message ?? err}（小程序"问一句"会说不通）`);
  }
}

// ★ **制品那第二个原点**（乙-1 · 契约 `docs/dev/59-USER-APPS.md` §五）。
//   🔴 手册 N1：执行第三方代码的东西**绝不与持有令牌的原点同源** ⇒ 它听**另一个端口**。
//   ⚠️ 分成两个进程更干净（共享不到任何东西），但那要再维护一条常驻进程
//      （这台机器上已经有"服务不在 systemd 下"那笔账）⇒ 这一批先做成**同进程第二个口**：
//      对浏览器来说它就是**另一个原点**（同源看的是 scheme+host+port），
//      而它自己的路由面小到看得完（三条：验签 / 读 / 带 CSP 回）。
const appsSignKey = loadSignKey(cfg.appsSignKeyPath);
// ⚠️ **对外那个地址优先**（生产上制品口是另一个域名）；没配才退回本机那个。
//    🔴 这条一定要能配，否则"上线"就得改代码 —— 而"改代码才上线"正是要避免的形状。
//    （规则本身在 `appsBaseOf()` 里，有判据钉着。）
const appsBase = appsBaseOf(cfg);
const appsOrigin = createAppServer({
  resolveApps: (sub) => worlds.worldFor(sub)?.apps ?? null,
  key: appsSignKey,
  frameAncestors: cfg.appsFrameAncestors,
  log: (m) => console.warn(`  ⚠️ ${m}`),
});

const { listen, listenTrusted, close } = createServer({
  // ★ **多租户那一侧**：每个请求按令牌里的 `sub` 取那个人的世界。
  //   ⚠️ 上面那五个单例**不再传**了 —— 传了就等于"所有人共用一份"。
  worlds,
  auth,
  webRoot,
  buildId: cfg.buildId,
  // ★ **语音那条**（`/api/asr`）的凭据：**按连接现取**（P1-26 · `src/asr-creds.js`）——
  //   ① `data/asr.env` 每次现读 ⇒ **换一把钥匙不用重启服务**（B5 那条要用它）；
  //   ② 身份（`sub`）已经传进来了，"以后按人取"只差那个缝里的一处实现
  //      （形状要主人先拍 B1/B2）。
  //   ⚠️ 没配钥匙**也照样挂上这条路** —— 它会让浏览器收到一句
  //      "没配"的原话，而不是一个握手失败让界面去猜。
  asr: createAsrRelay({
    config: (info) => voiceCredsFor({ sub: info?.sub, dataDir: cfg.dataDir }),
    log: (m) => console.log(`▶ ${m}`),
  }),
  /**
   * ★ **甲那条**（`/api/harness` · 2026-09-24）：盒子里那台 DSH 自己的**原始会话流**。
   *
   * ⚠️ 它**只在容器侧够得着**：`server.js` 那道闸门要求 `trusted === true`，
   *    而宿主上根本不听那条 UDS（`cfg.trustedSocketPath` 只有盒里设）。
   *
   * ⚠️ 它和琥珀自己那条路**完全隔离**（判据 H7）：另起进程、**不带人格/能力 patch**，
   *    也不碰 `AgentRuntime` 的实例与 LRU —— 见 `src/harness-session.mjs` 顶上那段。
   */
  harness: createHarnessRelay({
    cfg,
    log: (m) => console.log(`▶ ${m}`),
  }),
  /**
   * ★ **开发者模式**（契约 `docs/dev/82-DEV-MODE.md` · 2026-09-24）—— 两侧分开给：
   *
   *   · **宿主这一侧**（`dev`）：按 `Host` 认出 `dsh<手机号>.<HUPO_DEV_BASE>` ⇒ 走开发者中继。
   *     签名用**制品那条同一个密钥**，但**分域**（payload `d|…`）。
   *   · **盒子这一侧**（`devContainer`）：只在**容器里**建 —— 它懒起回环上那台 `dsh web`
   *     并反代 `/h…`。宿主上不建（宿主那条公开口永远不接 `/h`）。
   *     ⚠️ 判据 D7：盒子**不开任何宿主端口**，`dsh web` 只听回环。
   */
  dev: isHostSide
    ? { key: appsSignKey, base: cfg.devBase, scheme: cfg.devScheme }
    : null,
  devContainer: cfg.trustedSocketPath
    ? createDevWebRelay({ cfg, log: (m) => console.log(`  ${m}`) })
    : null,
  // ★ **字体镜像的缓存目录**（`/fonts/…` 那条口）：镜像下来的字体落在这儿
  fontCacheDir: nodePath.join(cfg.dataDir, 'font-cache'),
  // ★ **我的小程序清单**（乙-1）：给了才挂 `/api/apps`
  apps: { base: appsBase, key: appsSignKey },
  // ★ **给主人看的那一笔账**（账 #39）：注销/回收那条路上每一件都留一行
  auditFile: auditPath(cfg.dataDir),
  users,
  devCode: cfg.devCode,
  setModelKey,
  setCreds,
  credStatusOf,
  drawImage,
  tenantOf,
  // ★ **新号登录时替他申请一台**（除了改状态，这是登录路径上唯一新增的动作）
  ensureTenant,
  /**
   * ★ **他自己要注销 ⇒ 请特权侧把他那一台回收掉**（2026-09-22）。
   *
   * 🔴 **判据都在这边**（服务知道"谁对应哪一台、哪几台不许动"）：
   *    · 主人那一份（`local`）—— 没有单独一台可回收；
   *    · **静态表里那两台** —— 🔴 **不许自助回收**：它们是**早期手工开的**，
   *      而 `remove-tenant.sh` 那边也**硬拒**它们 ⇒ 两边一致，不给"网页说好了、
   *      实际没动"那种假话留缝。
   * ⚠️ 这条路的身份**只来自验签令牌里的 `sub`** ⇒ "取消别人"不可能发生。
   */
  cancelTenant: (userId) => {
    if (userId === OWNER_ID) return { ok: false, why: 'local' };
    if (cfg.tenantMap.has(userId)) return { ok: false, why: 'protected' };
    if (!tenantOf(userId)) return { ok: false, why: 'no-tenant' };
    return queue.cancel(userId);
  },
  // ★ **"主人那一份"只有一个**：别人要么走他那台容器，要么如实说没准备好
  isLocalUser: (userId) => userId === OWNER_ID,
  // ⚠️ 这一段**只查不发**（`hasTunnel` / `outstanding` 都没有副作用）——
  //    申请那件事只发生在 `ensureTenant()` 里（登录那一刻），见上面那段。
  tenantStatusOf: (userId) => {
    // 🔴 **只有"主人"才是 `local`**（他自己那份就在宿主上，没有单独一台）。
    //    ⚠️ 一个**新号**在 `tenantMap` 里**没有对应租户** —— 那**不是** `local`：
    //       `local` 的语义是"本机那份 = 主人那一份"，把新号当成它
    //       就是**让新用户看见主人的东西**（多租户要防的第一件事）。
    if (userId === OWNER_ID) {
      // ⚠️ **这里原来只回 `{kind:'local'}`** ⇒ 主人那一屏只能显示"还没有填"，
      //    而他其实有一把能用的钥匙（在 DSH 自己那份凭据里）—— 那是**在说假话**。
      //    现在照实报：他那一份的"有没有"就是那份文件里那个 ref 在不在。
      //    ⚠️ `keyBad` 恒 `false`：我们**不知道**它灵不灵（那要真发一次请求才知道），
      //      而"不知道"**不许**写成"不灵"。
      return { kind: 'local', state: 'ready', hasKey: ownerHasModelKey(), keyBad: false };
    }
    const tenant = tenantOf(userId);
    if (!tenant) {
      // 推不出名字 = 只有两种可能，**都不是"正在开"**：
      //   · 超过上限（`full`）—— 公开口烧资源那条代价的最后一道闸（A4）
      //   · 这个 id 根本不认识（也不该发生）
      const kind = tenancyFor(userId, { map: cfg.tenantMap, tpl });
      // ⚠️ 原来的写法是**一律** `queued` —— 那是"永远等"，而屏幕上没有一个字
      //    说它会永远等。这正是项目最忌的"看着在动、其实到不了"。
      return {
        kind: 'tenant',
        state: kind === 'full' ? 'full' : 'queued',
        why: kind === 'full' ? (tpl.ok ? 'capacity' : 'no-template') : 'unknown-id',
        hasKey: false,
        keyBad: false,
        steps: stepsFor(0),
      };
    }
    // ⚠️ **顺序要紧**：先看"在飞没有"，再看"上次是不是失败了"。
    //    反过来的话，重试那张申请还躺在目录里、屏幕却已经说"给不了"
    //    —— 那是"看着到不了、其实正在开"，同样是假话。
    const mapped = cfg.tenantMap.has(userId);
    const inFlight = !mapped && queue.outstanding(userId);
    const up = channel.hasTunnel(tenant);
    if (up) {
      return {
        kind: 'tenant',
        state: 'ready',
        // ★ **两个来源取"或"，而且"没有"要说清是哪一种**。
        //   规则住在 `key-state.js`（纯函数，`test/unit` 里钉着三种状态）：
        //     · 宿主内存里那份（我送过）**或** 容器自己报的（它真的拿着，权威）；
        //     · 上游说过"不灵" ⇒ `hasKey:false` **且** `keyBad:true`
        //       （客户端据此才说得清"你换一串就好" vs "你还没填过"）。
        //   ⚠️ 加字段是安全的（协议纪律：**加不破**，老客户端忽略它）。
        ...keyStateOf({
          hasKeyPushed: tenantKeys.has(userId),
          hasKeyReported: channel.hasKeyFor(tenant),
          rejected: badKeys.has(userId),
        }),
        // ⚠️ 3 不是 2 —— 就绪时**三步都算走完**（传 2 会自相矛盾：state=ready 而第三步没打勾）
        steps: stepsFor(3),
      };
    }
    // 申请**还在飞**（特权侧还没消费掉它）⇒ 正在开。这是四条里唯一"马上会变"的那条。
    if (inFlight) {
      return { kind: 'tenant', state: 'provisioning', hasKey: false, steps: stepsFor(1) };
    }
    // 特权侧**试过、但没建成** ⇒ 也**不许**让他一直等（A5 那个标记就是为这一条）
    if (!mapped && queue.failed(userId)) {
      return { kind: 'tenant', state: 'full', why: 'failed', hasKey: false, steps: stepsFor(0) };
    }
    // 没通、也没在飞：两种**不同**的实情，不许混成一个词
    //   · 静态表里那台 / 已经建出来的那台 ⇒ 在跑，只是隧道还没连上来
    //   · 特权侧**根本没装** ⇒ **没人会来开**，如实说给不了（原来这里说 `queued`，
    //     而屏幕上一个字都没说它会永远等）
    const state = mapped || queue.available ? 'starting' : 'full';
    return {
      kind: 'tenant',
      state,
      ...(state === 'full' ? { why: 'no-helper' } : {}),
      hasKey: !badKeys.has(userId) && (tenantKeys.has(userId) || channel.hasKeyFor(tenant)),
      steps: stepsFor(state === 'full' ? 0 : 1),
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

// ★ 制品那个口（乙-1）：**它起来失败不许拖垮壳** —— 但必须**当场看得见**（静默降级是本仓库反复栽的形状）。
try {
  await new Promise((res2, rej) => {
    appsOrigin.once('error', rej);
    appsOrigin.listen(cfg.appsPort, cfg.appsHost, res2);
  });
  console.log(`  制品口   ${appsBase}（另一个原点 · 只许 ${cfg.appsFrameAncestors} 嵌它）`);
} catch (err) {
  console.warn(`  ⚠️ 制品口没起来：${err?.message ?? err}（小程序点开会取不到东西）`);
}
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
    ig.identity?.mismatch
      ? `⚠️ **看着是"对上了"，其实那几条没在核**：清单按 ${ig.identity.builtWith} 算、现在按 ${ig.identity.used} 算`
      : ig.state === 'ok'
        ? `对上了（按 ${ig.identity?.used ?? serviceHome} 算）`
        : ig.state === 'tampered'
          ? `⚠️ 有 ${ig.warnings.length} 个"只报不拦"的条目动过`
          : '⚠️ **还没启用**（清单不在，见上面那条提示）'
  }`,
);
// ★ **语音那一行**（P1-26）：开机就把"有没有配、从哪来"说清楚 ——
//   它同时也是**密钥轮换**的凭据（`data/asr.env` 是现读的：换了不用重启，这一行会变）。
//   ⚠️ 只报**长度与来源**，一个字符的钥匙都不进去（见 `describeVoiceCreds`）。
console.log(`  语音     ${describeVoiceCreds(resolveVoiceCreds({ dataDir: cfg.dataDir }))}`);
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
  // ⚠️ 这个数是**通道自己算的**（`listeningCount`），不是记出来的：
  //    租户现在会在**运行时**多出来（按需开一台）⇒ 记出来的那个数一定会漂。
  `  租户通道 ${channel.listeningCount > 0 ? `${channel.listeningCount} 个租户在听（${cfg.tenantChannelDir}）` : '⚠️ 没开（HUPO_TENANT_MAP 空 / 目录没配）'}`,
);
console.log(
  // ★ **每台跑的是哪一版**（契约 `docs/dev/45-TENANT-UPDATE.md` §二）。
  //   ⚠️ 这一行必须**如实**：读不到就写读不到，不一致就写不一致 ——
  //      "一台悄悄跑着旧的、而两边都以为没事"正是这套东西要防的那件事。
  (() => {
    const p = readProductLayer(); // ⚠️ 现读（横幅只打一次，但代码形状要与上面那条规矩一致）
    return `  产品层   ${
      p
        ? `${p.fingerprint}（${p.gitRev ?? '未知提交'}${p.builtAt ? ` · ${p.builtAt}` : ''}）`
        : '⚠️ 读不到（还没翻过任何一版；容器会停在镜像里那份兜底上）'
    }${channel.builds.size > 0 ? `｜在跑的：${[...channel.builds.entries()].map(([t, b2]) => `${t}=${b2}`).join(' ')}` : ''}`;
  })(),
);
if (isHostSide) {
  console.log(
    // ⚠️ **投递目录要写在横幅上**：主人得知道往哪儿放那个 `.key`
    //    （`46-KEY-DELIVERY.md` §三.2）。⚠️ 它只是个**目录**，不含任何钥匙。
    `  投递     ${dropDir}${
      nodeFs.existsSync(dropDir) ? '' : '（还没有这个目录，服务会自己建）'
    } · 放 <租户名|编号|手机号>.key，我替你送进那台容器`,
  );
  console.log(
    // ★ **开发者模式**（契约 `docs/dev/82-DEV-MODE.md`）：露的是
    //   `dsh<手机号>.<后缀>` —— **只有标了 `dev` 的人**那个域名才接得进来。
    //   ⚠️ 后缀要写出来：它是"链接长什么样"的唯一线索（证书按人单签也是照它签的）。
    `  开发者   ${cfg.devBase}（dsh<手机号>.${cfg.devBase}；只有标了 dev 的人能进，别人一律拒）`,
  );
}
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
