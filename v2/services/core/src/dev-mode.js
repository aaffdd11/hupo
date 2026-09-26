// **开发者模式**（契约 `docs/dev/82-DEV-MODE.md` · 主人 2026-09-24 定稿；
// **"开的是你自己那台"改于 2026-09-25 · 契约 `docs/dev/109-DEV-ENTRY-IS-YOURS.md`**）。
//
// 一句话：把某个（被标成 `dev` 的）用户盒子里那台 DSH 露到
// `dsh<手机号>.<HUPO_DEV_BASE>` 上，**盒子不开端口**（容器内只听回环），
// **外层用琥珀的登录锁**（App 里点一下 ⇒ 短时效签名链接 ⇒ 种第一方 cookie）。
//
// ── 两侧的活（别读成一套）───────────────────────────────────
//   · **宿主这一侧**（`createDevHostRelay`）：按 `Host` 认出开发者域名 ⇒
//     `/__enter` 验签种 cookie；其余路径要第一方 cookie（**验签 + 现查 dev**）⇒
//     经 `proxyFor(tenant)` 把请求送进容器，**路径加 `/h` 前缀**、**剥掉浏览器 cookie**。
//   · **盒子这一侧**（`createDevWebRelay` · 只在 `trusted === true` 的请求上）：
//     先给一个**房间清单**（`main` ＋ `workspaces/` 下每一间）；点某一间 ⇒
//     用**那一间的 cwd** 起一台 `dsh --profile sdk` ＋ 人格 ＋ 能力层 ＋ 模型那条 patch
//     （**与调度器按轮起的那台同源** —— 参数只有 `agentArgs()` 一处出处），
//     从 stdout 解析端口与进程令牌 ⇒ `GET /?token=` 换 DSH 自己的 cookie 存住 ⇒
//     之后每条上游请求都**替浏览器**带上它，并把 `Host`/`Origin` 改写成回环
//     （那道 `/api` 栅栏按回环放行，正反例都实测过 —— `81-HARNESS-ENTRY.md` §四）。
//
// 🔴 **只有一套配置、一个家**（主人 2026-09-25 铁律）：patch 层（人格 ＋ 能力层 ＋ 模型那条）
//    与调度器按轮起的那台**逐字同源**（`agentPatchArgs()`，一处出处），`$DSH_HOME` 就是
//    盒里那一个（`/data/dsh`，**不另设**），cwd 就是**选中的那一间**。
//    ⚠️ 这一份原来只挂**模型那条** patch（没人格、没能力层）——那才是"第二套配置"，
//    主人明说"绝对不允许"（"它只允许有一个 deepseek harness"）。现在那两样都挂上了。
//    ⚠️ 至于 `--profile web` 那一行：**它是界面这个 app**，DSH 只在它里面提供浏览器界面
//    （`dsh --profile sdk` 是 stdio JSON-RPC，`--host` 都不认）—— 见 `DEV_WEB_PROFILE` 那段读数。
//    会话按 cwd 分项目、而 `$DSH_HOME/sessions` 只有一份 ⇒ **看到的是同一份会话**。
//
// ⚠️ **一次只开一间**（内存与句柄都不许失控）：`dsh web` 是**一整台 DSH**（不是小工具），
//    盒子的上限是 768MB，而"一间留一台"会随房间数线性涨（每间还带自己的 agent 窗口）。
//    ⇒ **换房间 = 收掉旧的、起新的**（`killChild()` 之后才 spawn）。
//    **如实说清**：房间清单页上写着这件事；会话本身落盘（`$DSH_HOME/sessions`），
//    换房间**不丢**已经记下的对话，但**旧页面那条流会断开**（要重新进那一间）。
//
// 🔴 **一件事必须如实说**（2026-09-25 真机读数 · 真 dsh ＋ 本仓那三层 patch，
//    读的是会话日志里的 `system/message` / `request/header`，不是猜的）：
//      · **工具：是我们的** —— 46 个里含 `mcp__ledger__job_start`、`mcp__apps__*`、
//        `mcp__image__image_generate` ⇒ 能力层那三层 patch **真挂上了**；
//      · **人格：不是我们的** —— `--profile web` 的**会话 agent 是它自己的 agent preset
//        （`standard`）**，而那个 preset 自己声明了一份 `persona`
//        （"You are a coding agent powered by the {{model}} model."）——
//        它**盖住**了我们那层 `system-prompt` patch（system prompt 里**没有**
//        「你是「助手」」，也没有「守正出奇」）。
//    ⇒ **这一页是"看得见同一份会话"的窗口，不是"跟他助手同一副嗓子"的窗口。**
//      要那副嗓子得换一条形状（只读看板 / 我们自己接 SDK）—— 那要主人拍。
//
// ⚠️ **还有一件真机事实**（D3 的必要条件）：DSH 的工作区注册表一旦初始化过，
//    **再也不发现新房间**，界面会把那一间的会话整个藏掉（**光把 cwd 指对不够**）。
//    ⇒ `spawnWeb()` 起那台之前会先 `ensureRoomRegistered()` 看一眼：
//      · **默认只读**（`workspaceNudge:false`）：不在注册表里就**只留一句提示**，
//        一个字节都不写 —— 这时界面**看不到**那一间（D3 红），**如实**；
//      · `workspaceNudge:true` 才真把 `initialized` 置回 `false`（让 DSH 重新发现房间）。
//    🔴 **写盘要主人拍** ⇒ 默认关。`serve.js` 现在**不**传这个开关。
//
// ── ⚠️ 主数据通道是一条 **WebSocket**（2026-09-24 修的真 bug）──────
//   那个界面的主数据通道是 `@deepseek-ai/dsh-api-gateway/lib/client.js` 里的
//   `REMOTE_STREAM_MUX_PATH = "/api/remote.mux"`（*"Exact WebSocket route carrying
//   every Typert Remote stream"*）。当初"界面全走普通 HTTP"的**判断是错的**：
//   少了升级这一条，界面能打开但**一个会话都列不出来**（左下角一直 `Reconnecting…`，
//   工作区写 `No sessions yet`）。⇒ 两侧都要接升级：
//     · 宿主：开发者域名上的升级**先过和普通请求一模一样的那把锁**（`authorize`），
//       过了才 `proxyUpgrade` 进容器（路径加 `/h` 前缀）；没过 ⇒ **握手阶段就拒**。
//     · 盒子：`handleUpgrade` 把这条升级**原样搬字节**到回环上的 `dsh web`，
//       并改写 `Host`/`Origin`、注入 DSH 那把 cookie、剥掉浏览器 cookie。
//
// ── 四条不许破 ─────────────────────────────────────────────
//   ① 🔴 **签名分域**：`/__enter` 的 payload 是 `d|<sub>|<exp>`，cookie 是 `dh|<sub>|<exp>`；
//      拿**制品**那条签名（`<sub>|<id>|<version>|<exp>`）或别处的签名来用 ⇒ **一律不过**（判据 D5）。
//   ② 🔴 **每个请求现查 `dev`**（`users.isDev`）：关掉就**当场**拒，不是等重启（判据 D4）。
//      升级那条走的是**同一个** `authorize`（判据 D9 的反例：没 cookie / 假 cookie /
//      没标 dev / 没租户 ⇒ **握手阶段**拒，不是先连上再关）。
//   ③ 🔴 **不缓冲**：请求体与响应体两头都 `pipe`；升级那条是**双向管道**。
//   ④ 🔴 **一套配置、一个家**（契约 109 D7′/D7″）：patch 层只由 `agentPatchArgs()` 造
//      （人格 ＋ 能力层 ＋ 模型那条 —— 与调度器那台**一处出处**），`DSH_HOME` 只有
//      `cfg.dshHome` 一个。`--profile web` 那一行**是 DSH 逼出来的**（界面只有它有，
//      读数见 `DEV_WEB_PROFILE`）—— **不是**"可以随手换成 sdk"。换 `sdk` = 这条入口起不来。
//
// ⚠️ **绝不用 root 跑 DSH、绝不用容器真实的 `DSH_HOME` 做探针**（`81-HARNESS-ENTRY.md` §9.3
//    那次事故）。这一份里的 spawn 走 `agentEnv()` + `cfg.agentUid/Gid`（"换手"那条安全设计）。

import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodeHttp from 'node:http';
import nodeNet from 'node:net';
import nodePath from 'node:path';
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';

// ⚠️ 只借**三个纯函数**：
//    `agentEnv()` 摘掉密钥 ＋ 给那**一个** `DSH_HOME` ＋ 能力层要的那几样环境变量；
//    `agentPatchArgs()` 给出**与调度器那台逐字同一套** patch（判据 D1/D7′）。
import { agentEnv, agentPatchArgs } from './agent-runtime.js';
// ⚠️ 只借**掩码**那一个纯函数：手机号是个人信息，**日志里只许出现掩码形态**
//    （与 `users.js` / `audit.js` 同一条纪律）。
import { maskPhone } from './audit.js';

/** 第一方 cookie 的名字（外层那把锁）。 */
export const DEV_COOKIE = 'hupo-dev';
/** 换 cookie 的那条路径。 */
export const DEV_ENTER_PATH = '/__enter';
/**
 * **要一条签名链接**那条（契约 `docs/dev/82-DEV-MODE.md` §六 D6）。
 *
 * ⚠️ 它和 `HARNESS_PATH` 一样是**常量**（不是散在 `server.js` 里的字符串字面量）：
 *    路径只有这一处出处，改的时候不会漏掉一半。
 */
export const DEV_HARNESS_PATH = '/api/dev-harness';
/** **翻标记**那条（只有 `owner` 能调）。 */
export const DEV_MODE_PATH = '/api/dev-mode';
/** 进容器这条路的前缀：`/api/x` → `/h/api/x`、`/` → `/h/`。 */
export const DEV_PATH_PREFIX = '/h';
/**
 * **房间清单**那一页的路径（契约 109 §"房间清单"）。
 *
 * ⚠️ 它必须在 `/` 之外另有一个地址：`/` 选过房间之后就是**那台界面**了
 *    （DSH 的界面把 API 算在 `location.origin` 的根上 ⇒ 不能给它加路径前缀），
 *    所以"回房间清单"只能靠一个**界面不会用到的**路径 —— 这个。
 * ⚠️ 用 `__` 开头是刻意的：DSH 自己用的是 `/`、`/api/*`、`/plugins/*`、`/assets/*`。
 */
export const DEV_ROOMS_PATH = '/__rooms';
/** 选房间那个查询参数：`/?room=<id>`。 */
export const DEV_ROOM_QUERY = 'room';
/** 签名链接的有效期（**短**是刻意的：它是一条"凭 URL 就能进"的能力）。 */
export const DEV_LINK_TTL_MS = 10 * 60 * 1000;
/** cookie 会话的有效期（一天）。 */
export const DEV_COOKIE_TTL_MS = 24 * 60 * 60 * 1000;
/** 收 `dsh web` 的宽限：先 `SIGTERM`，到点还活着就 `SIGKILL`。 */
export const DEV_KILL_GRACE_MS = 2000;

/**
 * 🔴 **换房间时，等旧那台"真的没了"的上限**（真机踩出来的）。
 *
 * **踩到的是什么**（2026-09-25 真机 · u2 的盒子 · 硬读数）：容器内存上限 **768MB**，
 * 盒里自己的服务 ~76MB，而**一台 `dsh web` 是 348MB ＋ 它自己那三个 MCP 子进程 ~144MB**。
 * 换房间那条路原来是"`SIGTERM` 旧的 ⇒ **立刻**起新的"（旧那台要 `killGraceMs` 之后才被
 * `SIGKILL`）⇒ **两台的峰值叠在一起** ⇒ 内核把**新起来的那台**杀掉
 * （`/sys/fs/cgroup/memory.events` 的 `oom_kill` 3 → 5，正好对应两次换房间）⇒
 * 界面上那一间**打不开**（502），而且旧那台还可能变成孤儿赖着内存。
 * ⇒ 起新台之前**先等旧的退出**（有上限，超时如实说一句，不无限等）。
 */
export const DEV_EXIT_WAIT_MS = 8000;

/**
 * **容器这一层的内存被 OOM 杀了几个进程**（读不到 ⇒ `null`，**不猜**）。
 *
 * ⚠️ 只用来把"被系统杀掉了"这句话**说具体**（`oom_kill` 涨了 ⇒ 内存不够），
 *    读不到就什么都不说 —— 不许编原因。
 */
export function readOomKills(fs = nodeFs) {
  for (const f of ['/sys/fs/cgroup/memory.events', '/sys/fs/cgroup/memory/memory.failcnt']) {
    try {
      const raw = fs.readFileSync(f, 'utf8');
      const m = /oom_kill\s+(\d+)/u.exec(raw);
      if (m) return Number.parseInt(m[1], 10);
    } catch {
      /* 没有 / 读不到 ⇒ 试下一个 */
    }
  }
  return null;
}

/**
 * 🔴 **收台不能靠句柄**（2026-09-26 真机 · B43 第二版）。
 *
 * **真机读数**（u2 的盒子）：`dsh web` 是盒里那个服务（容器 root）用
 * `spawnFn(..., { uid: cfg.agentUid, gid: cfg.agentGid })` **换手**到 uid 1000 起的
 * （安全决策①，不许改）。而那个容器是
 * `podman run --cap-drop=ALL --cap-add=CHOWN,DAC_OVERRIDE,SETUID,SETGID,FOWNER`
 * —— **没有 `CAP_KILL`** ⇒ 容器 root 对 **另一个 uid** 的进程发不了信号：
 * 真机原话 `kill: (14) - Operation not permitted`。
 * ⇒ `killChild()` 里那两个 `c.kill(...)` **静默失败**（被 `try/catch` 吞了），
 *   "换房间先收旧的"**从来没真的收掉过**：旧那台还活着（`/proc/<pid>` RSS ~390MB），
 *   两台叠在一起 ⇒ 内核杀**新起来的那台** ⇒ 那一间 **502**（`oom_kill` 每换一次 +1）。
 *
 * ★ **修法**：发信号这件事换成一个**以同一个 uid/gid 起的小 helper** 来做
 *   —— 同 uid 的进程之间发信号**不需要** `CAP_KILL`。见 `makeKillPid()`。
 *
 * ⚠️ 判据 K1 的**变异**：把 `killChild()` 改回 `c.kill(...)` ⇒ 当场红。
 */

/** 那个"以同一个 uid 发信号"的小 helper 最多跑多久（**有上限**，不许挂住）。 */
export const DEV_KILL_HELPER_TIMEOUT_MS = 3000;

/** 发完信号之后，**核实它真的没了**的上限（不是"发了就算收干净"）。 */
export const DEV_PID_GONE_WAIT_MS = 5000;

/** 核实"真的没了"时的轮询间隔。 */
export const DEV_PID_POLL_MS = 100;

/** 孤儿清扫里，收掉一台之后等它消失的上限（每台）。 */
export const DEV_SWEEP_GONE_WAIT_MS = 2000;

/**
 * **起一台 `dsh web` 之前，这一层至少要有多少空闲内存**（字节）。
 *
 * **真机读数**（u2 的盒子）：`memory.max = 768MB`；一台 `dsh web` 的 RSS ~348MB
 * ＋ 它自己那三个 MCP 子进程 ~144MB ⇒ **一台要 ~490MB**；刚起时还要一点峰值。
 * ⇒ 余量不到这个数就**不起**（等它够，或者如实回 503）——
 *   硬起的结果是**被内核杀掉**，而那时报"没起来"就是把原因说错了。
 *
 * ⚠️ 阈值**住在代码里**（手册纪律 1：文档不写数值）。读不到 cgroup ⇒ **不挡**（不猜）。
 */
export const DEV_MEM_NEED_BYTES = 512 * 1024 * 1024;

/** 内存不够时**最多等多久**（等到够；到点还不够就如实 503）。 */
export const DEV_MEM_WAIT_MS = 15000;

/**
 * 🔴 **起台失败之后的冷却**（住代码）。
 *
 * 入口那一页的 WebSocket **会自动重连** ⇒ 没有冷却的话，一次失败会变成
 * "起一台 → 被内核杀掉 → 前端重连 → 再起一台"的**风暴**（真机读数：父 agent
 * 在 u2 上清完孤儿，过一会儿又冒出 1 台 / 2 台 / 3 台，而没人在点房间）。
 */
export const DEV_FAIL_COOLDOWN_MS = 15000;

/** 冷却中那句人话（HTTP 与升级**逐字一样**）。 */
export const DEV_FAIL_COOLDOWN_TEXT = '那一间刚没起来，等一会儿再试。';

/** 内存腾不出地方那句人话（HTTP 与升级**逐字一样**）。 */
export const DEV_NO_MEMORY_TEXT = '这一台现在腾不出地方开这一间，等一会儿再试。';

/** 等内存时的轮询间隔。 */
export const DEV_MEM_POLL_MS = 500;

/**
 * 造一个"**以同一个 uid/gid 发信号**"的 `killPid(pid, signal)`（默认实现）。
 *
 * 🔴 **为什么必须是同一个 uid**：盒里那个服务是**容器 root 却没有 `CAP_KILL`**
 *    （`--cap-drop=ALL` ＋ 只加回五条）⇒ 它**杀不动**换手之后（uid 1000）那台 DSH。
 *    真机原话：`kill: (14) - Operation not permitted`。
 *    而**同 uid** 的进程之间发信号不需要任何能力 ⇒ 拿 `cfg.agentUid/Gid` 起一个
 *    一次性的 node 小 helper，让**它**去 `process.kill`。
 *
 * ⚠️ **只把 `pid` 与信号名传进去**（`argv`，不经 shell）—— 别的什么都不传。
 * ⚠️ `pid` 必须是**正整数且大于 1**（0 / 1 / 负数一律拒绝：`kill(0)` 会打到整个进程组，
 *    `kill(1)` 会打到 init —— 这两条都是"手一滑就全灭"）。
 * ⚠️ 信号只认那两个（`SIGTERM` / `SIGKILL`）—— 别的名字在这条路上没有意义。
 * ⚠️ 认不出 / 起不来 / 超时 / 非零退出 ⇒ 回 `false`（**调用方据此如实说**，不猜）。
 *
 * @param {object} cfg `config.js` 那份（只要 `agentUid` / `agentGid`）
 * @param {object} [o]
 * @param {Function} [o.spawnSync] 注入用（判据里换成一个假的）
 * @param {string} [o.nodeBin] 那个 helper 用哪支 node 跑（默认 `process.execPath`）
 * @returns {(pid:number, signal?:string)=>boolean}
 */
export function makeKillPid(cfg = {}, { spawnSync = nodeSpawnSync, nodeBin = process.execPath } = {}) {
  const uid = Number.isInteger(cfg?.agentUid) ? cfg.agentUid : null;
  const gid = Number.isInteger(cfg?.agentGid) ? cfg.agentGid : null;
  return (pid, signal = 'SIGKILL') => {
    const n = Number(pid);
    // ⚠️ 1 以下一律拒（`0` = 整个进程组；`1` = init）。
    if (!Number.isInteger(n) || n <= 1) return false;
    if (n === process.pid) return false;
    const sig = signal === 'SIGTERM' || signal === 'SIGKILL' ? signal : null;
    if (sig === null) return false;
    /** @type {import('node:child_process').SpawnSyncOptions} */
    const opts = {
      stdio: 'ignore',
      // ⚠️ **有上限**：helper 挂住的话，"换房间"会卡在这儿（那比杀不动更坏）。
      timeout: DEV_KILL_HELPER_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    };
    // 🔴 **换手**：不带上这个，helper 就是 root，而 root 恰好是杀不动的那一个。
    if (uid !== null) opts.uid = uid;
    if (gid !== null) opts.gid = gid;
    try {
      const r = spawnSync(
        nodeBin,
        ['-e', 'process.kill(Number(process.argv[1]), process.argv[2])', String(n), sig],
        opts,
      );
      return r?.status === 0 && !r?.error;
    } catch {
      return false;
    }
  };
}

/**
 * `/proc/<pid>` 还在不在（**核实"真的没了"用**）。
 *
 * ⚠️ 认不出的 `pid` ⇒ `false`（不猜）。读不到 `/proc` ⇒ `false`
 *    （调用方据此如实说"读不到"，**不许**把它说成"已经收干净了"）。
 */
export function pidExists(pid, fs = nodeFs) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) return false;
  try {
    return fs.existsSync(`/proc/${n}`);
  } catch {
    return false;
  }
}

/**
 * 这一层的**内存余量**（`max - current`）；算不出 ⇒ `null`（**不猜、不挡**）。
 *
 * ⚠️ 两种 cgroup 都看（v2 的 `memory.max` / `memory.current`，
 *    v1 的 `memory.limit_in_bytes` / `memory.usage_in_bytes`）——
 *    盒里是哪一种由内核定，不是我们定的。
 * ⚠️ `max` 字面量（这一层没有上限）⇒ `null`：**算不出余量**，
 *    这时**不许**拿一个假数去挡人（手册纪律：算不出就说算不出）。
 */
export function readMemoryHeadroom(fs = nodeFs) {
  const pairs = [
    ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.current'],
    ['/sys/fs/cgroup/memory/memory.limit_in_bytes', '/sys/fs/cgroup/memory/memory.usage_in_bytes'],
  ];
  for (const [maxFile, curFile] of pairs) {
    try {
      const rawMax = String(fs.readFileSync(maxFile, 'utf8')).trim();
      if (rawMax === '' || rawMax === 'max') continue;
      const max = Number.parseInt(rawMax, 10);
      const current = Number.parseInt(String(fs.readFileSync(curFile, 'utf8')).trim(), 10);
      if (!Number.isFinite(max) || !Number.isFinite(current) || max <= 0) continue;
      return { max, current, free: max - current };
    } catch {
      /* 没有那个文件 / 读不到 ⇒ 试下一种 */
    }
  }
  return null;
}

/**
 * 这条命令行**是不是**"我们那台 `--profile web`"。
 *
 * 🔴 孤儿清扫**只认这一种**（`docs/dev/110` 那台开发者入口的界面）。
 *    调度器按轮起的是 **`--profile sdk`**（`agentArgs()`），评审那台也是 sdk
 *    —— 扫错一个就是把正在干活的 agent 收掉。
 *
 * ⚠️ 判据 K3 的**变异**：把判据放宽成"带 `--profile` 就算" ⇒ 当场红。
 */
export function isWebProfileArgs(args) {
  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === '--profile' && list[i + 1] === DEV_WEB_PROFILE) return true;
    if (list[i] === `--profile=${DEV_WEB_PROFILE}`) return true;
  }
  return false;
}

/**
 * 盒里**别的** `--profile web` 的 pid（**读盒里的 `/proc`**）。
 *
 * 🔴 **只在盒里用**：宿主上主人的 `dsh` 一堆（还可能带着 `--profile web`），
 *    在那儿扫就是"手一滑把主人的东西收掉"。所以
 *    · 默认**关**（`sweepOrphans` 默认 `false`）；
 *    · `serve.js` **只在容器那一支**（`cfg.trustedSocketPath` 那条，
 *      宿主上根本不建这个中继）才把它打开。
 * ⚠️ 判据里要能看出这条边界：默认关着的时候，**一台都不许动**。
 */
export function listWebProfilePids({ fs = nodeFs, procDir = '/proc', skipPids = [] } = {}) {
  const skip = new Set((Array.isArray(skipPids) ? skipPids : []).map((p) => Number(p)));
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(procDir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^\d+$/u.test(String(name))) continue;
    const pid = Number.parseInt(String(name), 10);
    if (skip.has(pid)) continue;
    let raw;
    try {
      raw = fs.readFileSync(`${procDir}/${name}/cmdline`, 'utf8');
    } catch {
      continue; // 读不到（已经没了 / 不是我们的）⇒ 跳过，不猜
    }
    const args = String(raw).split('\0').filter((a) => a !== '');
    if (isWebProfileArgs(args)) out.push(pid);
  }
  return out;
}

/** 等一会儿（`killChild` 那条路上用）。 */
function delay(ms) {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}
/**
 * 插"不是琥珀"那一条时，**最多**缓多少字节的顶层文档。
 * ⚠️ 超了就**边写边转发**（一个字节都不丢，只是那一条不插）——
 *    宁可没有那一条，也不许把那一页卡住 / 吃掉内存。
 */
export const DEV_BANNER_MAX_BYTES = 512 * 1024;

/** 签名分域：换 cookie 的短链接。 */
export const DEV_ENTER_DOMAIN = 'd';
/** 签名分域：cookie 里的那个无状态会话。 */
export const DEV_COOKIE_DOMAIN = 'dh';

/** hop-by-hop：两头都不许原样带过去。 */
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/**
 * 升级那条上**不许**原样带过去的 hop-by-hop。
 *
 * 🔴 与上面那张表的**唯一区别**：`connection` 与 `upgrade` 要**留着** ——
 *    它们正是"这次请求是升级"这件事本身。把它们删掉，上游只会当成一条普通 GET。
 */
const UPGRADE_HOP_BY_HOP = [
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
];

/**
 * 日志前把**进程令牌**抹掉。
 *
 * ⚠️ 为什么要有它：`dsh web` 那一行里带着 `?token=…`（**那是一条能力，不是给日志看的**），
 *    而它的 stdout/stderr 尾巴会被拼进错误信息。进程令牌 / cookie 值一律不许进日志。
 */
export function redactSecrets(s) {
  return String(s ?? '')
    .replace(/([?&]token=)[^\s&'"]+/giu, '$1<已隐去>')
    .replace(/(dsh-auth-[A-Za-z0-9_-]*=)[^\s;'"]+/giu, '$1<已隐去>');
}

// ── Host ───────────────────────────────────────────────────

/** 开发者域名长什么样：`dsh<11 位手机号>.<base>`。 */
export const DEV_HOST_RE = /^dsh(1[3-9]\d{9})$/;

/**
 * 从 `Host` 头里解出手机号。**认不出来一律 `null`**（不猜）。
 *
 * ⚠️ 必须是**整整一个 label**：`evildsh…` / `dsh…evil.com` 都不认。
 * ⚠️ 端口要剥掉（`dsh….stalkerai.cn:8443` 是合法形态）。
 *
 * @param {string} hostHeader
 * @param {string} base 例如 `stalkerai.cn`
 * @returns {string|null}
 */
export function parseDevHost(hostHeader, base) {
  if (typeof hostHeader !== 'string' || typeof base !== 'string') return null;
  let host = hostHeader.trim().toLowerCase();
  if (host === '') return null;
  // 剥端口（IPv6 字面量在域名这条路上不存在，直接按最后一个冒号切）
  const colon = host.lastIndexOf(':');
  if (colon !== -1) host = host.slice(0, colon);
  const b = base.trim().toLowerCase().replace(/^\.+/u, '').replace(/\.+$/u, '');
  if (b === '') return null;
  const suffix = `.${b}`;
  if (!host.endsWith(suffix)) return null;
  const m = DEV_HOST_RE.exec(host.slice(0, -suffix.length));
  return m ? m[1] : null;
}

/** 反过来：`dsh<手机号>.<base>`。 */
export function devHostFor(phone, base) {
  return `dsh${phone}.${String(base ?? '').trim().replace(/^\.+/u, '')}`;
}

// ── 签名（HMAC-SHA256，和制品那条**同一个密钥**，但**分域**）──────

/** 签名真正覆盖的那串东西：**域在最前面**。 */
export function devPayload(domain, sub, exp) {
  return `${domain}|${sub}|${exp}`;
}

/** 算签名（十六进制）。 */
export function devSig({ key, domain, sub, exp }) {
  return nodeCrypto.createHmac('sha256', key).update(devPayload(domain, sub, exp)).digest('hex');
}

/**
 * 验签名。**四条一起验**（格式 · 到期 · 域 · 内容）。
 *
 * ⚠️ 比较用 `timingSafeEqual`（先各自 sha256 一道，避免长度不同直接抛）——
 *    与 `app-serve.js` 那条同一个做法。
 */
export function devSigOk({ key, domain, sig, sub, exp, now = Date.now() }) {
  if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/u.test(sig)) return false;
  if (typeof sub !== 'string' || sub === '') return false;
  const raw = String(exp ?? '');
  if (!/^\d{1,16}$/u.test(raw)) return false;
  const e = Number.parseInt(raw, 10);
  if (!Number.isInteger(e) || e < now) return false;
  let want;
  try {
    want = devSig({ key, domain, sub, exp: e });
  } catch {
    return false;
  }
  const a = nodeCrypto.createHash('sha256').update(sig).digest();
  const b = nodeCrypto.createHash('sha256').update(want).digest();
  return nodeCrypto.timingSafeEqual(a, b);
}

/** `/__enter` 那条链接的验签（域 `d`）。 */
export function verifyDevLink({ key, sig, sub, exp, now = Date.now() }) {
  return devSigOk({ key, domain: DEV_ENTER_DOMAIN, sig, sub, exp, now });
}

/** 拼一条 `/__enter` 链接。`origin` = `https://dsh<手机号>.<base>`（不带尾斜杠）。 */
export function devEntryLink({ origin, key, sub, now = Date.now(), ttlMs = DEV_LINK_TTL_MS }) {
  const exp = now + ttlMs;
  const s = devSig({ key, domain: DEV_ENTER_DOMAIN, sub, exp });
  const q = new URLSearchParams({ u: sub, e: String(exp), s });
  return { url: `${String(origin).replace(/\/+$/u, '')}${DEV_ENTER_PATH}?${q}`, expiresAt: exp };
}

// ── cookie 会话（**无状态**：会话本身就是 HMAC）──────────────────

/** 值 = `<sub>.<exp>.<sig>`（域 `dh`）。 */
export function devCookieValue({ key, sub, exp }) {
  return `${sub}.${exp}.${devSig({ key, domain: DEV_COOKIE_DOMAIN, sub, exp })}`;
}

/** 验 cookie；不过一律 `null`（不猜、不说为什么）。 */
export function verifyDevCookie({ key, value, now = Date.now() }) {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [sub, exp, sig] = parts;
  if (!devSigOk({ key, domain: DEV_COOKIE_DOMAIN, sig, sub, exp, now })) return null;
  return { sub, exp: Number.parseInt(exp, 10) };
}

/** `Set-Cookie` 那一行（**第一方** cookie 的三个属性都不许少）。 */
export function devCookieHeader({ value, maxAgeSec }) {
  return `${DEV_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

/** 从 `Cookie` 头里取一个值（重复出现取第一个）。 */
export function readCookie(header, name) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// ── 被扣的人看到的那一屏 ────────────────────────────────────

/** 一句普通话（**不解释技术细节**，也不给界面）。 */
export const DEV_DENY_TEXT = '这个入口现在不给你进。要用的话，在琥珀里点一下"开发者入口"，从那条链接进来。\n';

/** 一律拒（`403`）。**没通过外层 ⇒ 拒，不许先给界面。** */
export function devDeny(res, status = 403) {
  const body = status === 405 ? '这个方法不行。\n' : DEV_DENY_TEXT;
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/** 通了外层、但里层（盒子/隧道）没准备好 —— **如实说**。 */
export function devUnavailable(res, status, text) {
  const body = `${text}\n`;
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/**
 * **握手阶段**拒一次升级（与 `server.js` 的 `rejectUpgrade` 同一个形状）。
 *
 * 🔴 为什么不能"先 `101` 再关"：那会给爬虫留下一个**站得住的连接**，
 *    而且界面那边分不清"没通过锁"和"连上又断了"（本项目最忌的"看起来在跑"）。
 * ⚠️ 带上 body 与 content-type：排障时一眼能认出这句出自我这儿。
 */
export function rejectUpgradeSocket(socket, status, reason, text) {
  const body = `${text}\n`;
  try {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\n` +
        'content-type: text/plain; charset=utf-8\r\n' +
        `content-length: ${Buffer.byteLength(body)}\r\n` +
        'connection: close\r\n' +
        '\r\n' +
        body,
    );
  } catch {
    /* 已经没了 */
  }
  try {
    socket.destroy();
  } catch {
    /* 已经没了 */
  }
}

// ── 宿主这一侧：按 Host 分流 ─────────────────────────────────

/**
 * 建宿主这一侧的开发者中继。
 *
 * @param {object} o
 * @param {Buffer|string} o.key    签名密钥（`appsSignKey`，**不进日志**）
 * @param {string} o.base          `HUPO_DEV_BASE`（默认 `stalkerai.cn`）
 * @param {(sock:import('node:stream').Duplex, req, res, path:string)=>void} o.forward
 *        把请求送进容器（宿主那一侧的 `proxyToTenant`）
 * @param {object} o.users         用户表（`isDev` / `get` / `phoneOf`）
 * @param {(sub:string)=>string|null} [o.tenantOf]
 * @param {(tenant:string)=>any} [o.proxyFor]
 */
export function createDevHostRelay({
  key,
  base,
  scheme = 'https',
  users = null,
  tenantOf = () => null,
  proxyFor = null,
  forward,
  now = Date.now,
  linkTtlMs = DEV_LINK_TTL_MS,
  cookieTtlMs = DEV_COOKIE_TTL_MS,
  log = () => {},
}) {
  if (!key) throw new Error('开发者模式需要签名密钥（appsSignKey）');
  if (typeof base !== 'string' || base.trim() === '') throw new Error('开发者模式需要域名后缀（HUPO_DEV_BASE）');
  if (typeof forward !== 'function') throw new Error('开发者模式需要 forward（把请求送进容器那条）');

  /** ⚠️ 日志一律先过 `redactSecrets`（进程令牌 / cookie 值不许进日志）。 */
  const say = (m) => log(redactSecrets(m));

  const devAt = (sub) => {
    try {
      return users?.isDev?.(sub) === true;
    } catch {
      return false;
    }
  };

  /**
   * 这个请求是**谁**：`{phone, sub}`；没被标 `dev` 一律 `sub: null`。
   *
   * ★ D1：没被标 `dev` ⇒ 这个域名**一律拒**（连 `/__enter` 都不给机会）。
   * ⚠️ **每一次现查**（`devAt` → `users.isDev`）——标记一关就当场生效（判据 D4）。
   */
  const subjectOf = (req) => {
    const phone = parseDevHost(req.headers?.host, base);
    const rec = phone ? users?.get?.(phone) ?? null : null;
    const sub = typeof rec?.id === 'string' ? rec.id : null;
    if (!sub || !devAt(sub)) {
      say(`开发者域名：${phone ? maskPhone(phone) : '（认不出来）'} 没有开发者标记 ⇒ 拒`);
      return { phone, sub: null };
    }
    return { phone, sub };
  };

  /**
   * **外层那把锁**（`/__enter` 之外的一切都要过它）：
   * 现查 dev 标记 ＋ cookie 验签（必须就是这个域名这个人）＋ 这个人有租户 ＋ 隧道通。
   *
   * 🔴 **普通 HTTP 与升级走的是这同一份**（`handle` 与 `server.js` 的 `handleUpgrade`）——
   *    两处各写一遍锁 = 迟早分叉，而分叉的那一次就是"**升级绕过了锁**"。
   *
   * @returns {{ok:true, sock:any, path:string}
   *          |{ok:false, status:number, error:string, text:string}}
   */
  const authorize = (req) => {
    const { sub } = subjectOf(req);
    if (!sub) return { ok: false, status: 403, error: 'forbidden', text: DEV_DENY_TEXT };

    //   ★ D3：没 cookie ⇒ 拒（不是先给界面）
    //   ★ D4：cookie 还在、但标记刚被关掉 ⇒ **当场**拒（`devAt` 是每个请求现查的）
    const sess = verifyDevCookie({
      key,
      value: readCookie(req.headers?.cookie, DEV_COOKIE),
      now: now(),
    });
    if (!sess || sess.sub !== sub || !devAt(sess.sub)) {
      return { ok: false, status: 403, error: 'forbidden', text: DEV_DENY_TEXT };
    }

    const tenant = tenantOf(sess.sub);
    if (!tenant) {
      return { ok: false, status: 503, error: 'no-tenant', text: '你这一份还没有单独一台，暂时进不去。' };
    }
    const sock = proxyFor ? proxyFor(tenant) : null;
    if (!sock) {
      return { ok: false, status: 503, error: 'tenant-not-ready', text: '你那台现在没连上，等会儿再试。' };
    }
    // ★ D2：进容器那条路**带 `/h` 前缀**（`/` → `/h/`、`/api/x` → `/h/api/x`）
    const rel = typeof req.url === 'string' && req.url.startsWith('/') ? req.url : `/${req.url ?? ''}`;
    return { ok: true, sock, path: `${DEV_PATH_PREFIX}${rel}` };
  };

  return {
    scheme,
    base,
    key,
    /**
     * 这个 `Host` 是不是开发者域名；是就回手机号。
     * ⚠️ **别的 Host 一律不管**（照旧走站点）—— 调用方只在它非 `null` 时接管。
     */
    match(hostHeader) {
      return parseDevHost(hostHeader, base);
    },
    /** ★ **升级那条**用的就是它（`server.js` 的 `handleUpgrade`）—— 见上面那段说明。 */
    authorize,
    /**
     * 处理一条落在开发者域名上的请求。
     *
     * @returns {Promise<void>}
     */
    async handle(req, res, url) {
      const path = url?.pathname ?? '/';

      // ── ★ `/__enter`：短时效签名 ⇒ 种第一方 cookie ⇒ 302 到 `/` ──
      //   ⚠️ 它自己**不要 cookie**（它正是来换 cookie 的），但**一样要先过 D1**。
      if (path === DEV_ENTER_PATH) {
        const { sub } = subjectOf(req);
        if (!sub) return devDeny(res);
        if (req.method !== 'GET') return devDeny(res, 405);
        const q = url.searchParams;
        const u = q.get('u') ?? '';
        const e = q.get('e') ?? '';
        const s = q.get('s') ?? '';
        if (!verifyDevLink({ key, sig: s, sub: u, exp: e, now: now() })) {
          // ★ D5：制品那条签名 / 别处的签名走到这儿**一律不过**（域分开了）
          say('开发者域名：/__enter 的签名不过 ⇒ 拒');
          return devDeny(res);
        }
        // 链接必须就是这个域名这个人的（换域名/换人都不行）
        if (u !== sub) return devDeny(res);
        const exp = now() + cookieTtlMs;
        const value = devCookieValue({ key, sub, exp });
        res.writeHead(302, {
          location: '/',
          'set-cookie': devCookieHeader({ value, maxAgeSec: Math.floor(cookieTtlMs / 1000) }),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        res.end();
        return undefined;
      }

      // ── 其余路径：**同一把锁**（cookie 验签 + 现查 dev + 有租户 + 隧道通）──
      const a = authorize(req);
      if (!a.ok) {
        if (a.status === 403) return devDeny(res);
        return devUnavailable(res, a.status, a.text);
      }
      // ★ 把**浏览器那份 cookie 剥掉**（`forward` 里做）—— 里层那把锁归壳拿着。
      try {
        forward(a.sock, req, res, a.path);
      } catch (err) {
        say(`开发者域名：转发进容器那一步抛了：${err?.message ?? err}`);
        if (!res.headersSent) devUnavailable(res, 502, '刚才没接上，等会儿再试。');
      }
      return undefined;
    },
  };
}

// ── 盒子这一侧：房间清单 ＋ 懒起一台 `dsh web`（与真那台同源）并反代 ──

/**
 * 🔴 **浏览器界面只有 `web` 这个 app 提供** —— 这一行是被 DSH 的形状逼出来的，不是选的。
 *
 * 真机读数（本机 `dsh` 0.1.5-rc.1）：
 * ```
 * $ dsh --profile sdk --help
 * Serve DeepSeek Harness SDK clients over stdio JSON-RPC.   ← 它没有 --host/--port
 * $ dsh --profile sdk --host 127.0.0.1 --port 0 --no-open
 * error: unknown option '--host'                            ← exit=1
 * $ dsh web --help
 * Serve the DeepSeek Harness browser UI.
 * Options: --host / --no-open / --port / --trusted-host     ← 界面只在这儿
 * ```
 * ⇒ 把这一行换成 `sdk` 不会"更同源"，只会让这条入口**当场起不来**。
 *
 * ★ **"同源"落在另外三样上**（它们才是会话/配置的实质，判据 D1/D7）：
 *   ① **同一套 patch**（`agentPatchArgs(cfg)` —— 与调度器那台**一处出处**）；
 *   ② **同一个 `$DSH_HOME`**（`cfg.dshHome`，盒里 `/data/dsh` —— 会话只有一份，按 cwd 分项目）；
 *   ③ **同一间的 cwd**（`room.cwd`）。
 * ⇒ 界面里看到的、和它平时干活时说的是**同一份会话**（D3）。
 */
export const DEV_WEB_PROFILE = 'web';

/**
 * **给那个进程的参数**（契约 109 §二/§三 D1/D2/D7）。
 *
 * 🔴 **配置层与调度器那台逐字同源**：人格 ＋ 能力层 ＋ 模型那条，全部由
 *    `agentPatchArgs()` 造（**只有那一处出处**）。这里**只多三样**：
 *    · `--profile web`：**界面**这个 app（见上面 `DEV_WEB_PROFILE` 那段读数 ——
 *      DSH 只在它里面提供浏览器界面）；
 *    · `--host 127.0.0.1` / `--port 0`：只听回环、端口交给内核挑
 *      （盒子**不开**任何宿主端口 —— 原判据 D7）；
 *    · `--no-open`：别去拉浏览器（盒里没有）。
 *
 * ⚠️ 判据 D1 的**变异**：把那几层 patch 少挂一条（或者换成 `harnessArgs()` 那套
 *    "只有模型那条"）⇒ 当场红 —— 那正是改前"没有人格、没有工具"的形状。
 */
export function devWebArgs(cfg = {}) {
  return [
    '--profile',
    DEV_WEB_PROFILE,
    ...agentPatchArgs(cfg),
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '--no-open',
  ];
}

/**
 * 房间清单**归一化**：只要 `{id, name, cwd}` 三样都认得出、`id` 不重复的。
 *
 * ⚠️ 认不出的**一律丢掉**（不猜）：`cwd` 认不出 ⇒ 那间点开就会 spawn ENOENT
 *    （而那个 ENOENT 分不清"目录不在"和"程序找不到"）。
 */
export function normalizeRooms(list) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(list) ? list : []) {
    const id = typeof r?.id === 'string' ? r.id.trim() : '';
    const cwd = typeof r?.cwd === 'string' ? r.cwd.trim() : '';
    if (id === '' || cwd === '' || seen.has(id)) continue;
    seen.add(id);
    const name = typeof r?.name === 'string' && r.name.trim() !== '' ? r.name.trim() : id;
    out.push({ id, name, cwd });
  }
  return out;
}

/** HTML 转义（房间名来自盘上/制品库，**不许**直接拼进页面）。 */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/gu, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

// ── ★ **看板那句话**（主人 2026-09-25 拍的「甲」；契约 `109-DEV-ENTRY-IS-YOURS.md` §八）──
//
// 🔴 **这一页里回话的不是琥珀**。真机读数（读的是会话日志，不是猜的）：
//    我们那三层 patch **真挂上了**（46 个工具里含 `mcp__ledger__*` / `mcp__apps__*`），
//    但 `--profile web` 那条路的**会话 agent 是 DSH 自己的 preset（`standard`）**，
//    而那个 preset 自己声明了一份 `persona`，**盖住**了我们那层 `system-prompt`
//    ⇒ 工具是我们的、**嗓子不是**。
//    ⇒ 名字叫"我自己那台"，说话的却**不是琥珀** —— 页面上必须**明写**这一句，
//      不然就是"名字一样、东西不一样"（那是界面在说假话，手册 §六·4）。
//
// ⚠️ **一处文案、两处落点**：这一页（进之前）与**那一页本体**（进去之后，`injectDevBanner`）。
//    客户端那边（`v2/apps/mobile/lib/models/dev_harness_words.dart`）也有同样两句 ——
//    **防漂的判据**在 `test/dev-mode.test.js`（逐字比对两份，改一份不改另一份 ⇒ 当场红）。
export const DEV_BOARD_NOT_HUPO = '在这儿说话的不是琥珀。';
export const DEV_BOARD_WHY_NOT = '干的活、记的事都是琥珀那一份；说话的规矩和口气是这台机器自带的。';

/**
 * 注进**那一页本体**顶部的那一条（`<body>` 之后第一个孩子）。
 *
 * 🔴 **一处尺寸都不写死**（手册 D3）：那条的高度由字自己撑，`#root` 用 `flex:1`
 *    把剩下的地方占满 —— 所以字放大/手机上折成两行都不会把它挤出去。
 * ⚠️ 深色主题也跟着（DSH 把 `data-ds-dark-theme` 挂在 `body` 上）。
 * ⚠️ 只用**内联 style + 一个 div**：不依赖任何脚本，也不碰 DSH 自己的任何文件。
 */
export const DEV_BOARD_BANNER = `<style>
body{display:flex;flex-direction:column}
#root{flex:1 1 auto;min-height:0;height:auto!important}
#hupo-dev-notice{flex:0 0 auto;padding:.35em .7em;font:inherit;font-size:.85rem;line-height:1.5;
  background:#F7E4DF;color:#C8452F;border-bottom:1px solid #E8E0D4}
#hupo-dev-notice span{color:#7A6E66;margin-left:.5em}
body[data-ds-dark-theme] #hupo-dev-notice{background:#2B2320;color:#E8A08E;border-bottom-color:#3A3230}
body[data-ds-dark-theme] #hupo-dev-notice span{color:#B9AEA6}
</style>
<div id="hupo-dev-notice">${DEV_BOARD_NOT_HUPO}<span>${DEV_BOARD_WHY_NOT}</span></div>`;

/**
 * 把上面那一条插进 DSH 自己那一页（**唯一一处**动它的地方，而且是**注入**、不改它的文件）。
 *
 * ⚠️ **认不出来就原样返回 `null`**（没有 `<body>` ⇒ 调用方一个字节都不改地发出去）：
 *    这一条是"如实"，不是"功能"，**宁可没有也不能把那一页弄坏**。
 */
export function injectDevBanner(html) {
  const s = String(html ?? '');
  const m = /<body[^>]*>/iu.exec(s);
  if (!m) return null;
  const at = m.index + m[0].length;
  return `${s.slice(0, at)}\n${DEV_BOARD_BANNER}\n${s.slice(at)}`;
}

/**
 * **房间清单那一页**（"先给一个房间清单"）。
 *
 * ⚠️ 它是**我们自己的**一小页（不是 DSH 的界面）：所以它**不需要**先起 `dsh web`
 *    （列房间不该花掉一台 DSH 的内存）。
 * ⚠️ 名字用人话：`main` 显示成"主对话"，工作区显示它自己的短名（**不露内部 id**）。
 * ⚠️ 页面上**如实写清**"一次只开一间"那件事（换房间会重开界面、旧页面断开）。
 * ⚠️ 页面上**明写**"在这儿说话的不是琥珀"（见上面那一段 —— 主人拍的「甲」）。
 */
export function devRoomsHtml({ rooms = [], current = null } = {}) {
  const items = rooms
    .map((r) => {
      const now = r.id === current ? '<span class="now">（现在打开的）</span>' : '';
      return `<li><a href="/?${DEV_ROOM_QUERY}=${encodeURIComponent(r.id)}">${escapeHtml(r.name)}</a>${now}</li>`;
    })
    .join('\n');
  const body =
    rooms.length === 0
      ? '<p>这一台现在没有可打开的房间。</p>'
      : `<ul>\n${items}\n</ul>`;
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>房间</title>
<style>
body{font:16px/1.6 system-ui,-apple-system,"Noto Sans CJK SC",sans-serif;margin:0;padding:24px;color:#222}
h1{font-size:20px;margin:0 0 4px}
p{margin:8px 0}
ul{list-style:none;padding:0;margin:16px 0}
li{margin:8px 0}
a{font-size:18px;text-decoration:none;border-bottom:1px solid #bbb}
.now{color:#888;font-size:14px;margin-left:8px}
.note{color:#666;font-size:14px}
.here{background:#F7E4DF;color:#C8452F;border:1px solid #E8E0D4;border-radius:8px;padding:8px 12px;font-size:15px}
.here span{color:#7A6E66}
</style>
</head>
<body>
<h1>房间</h1>
<p class="here">${DEV_BOARD_NOT_HUPO}<span>${DEV_BOARD_WHY_NOT}</span></p>
<p class="note">点一间进去。这里开的就是这台机器上那一台 DSH —— 与它平时干活的那台<b>同一个家</b>（会话只有一份、按房间分），所以看到的是同一份对话。</p>
${body}
<p class="note">一次只开一间：换一间会把上一间那台收掉（省内存）。已经记下的对话不会丢；但上一个页面的连接会断开，要重新进那一间。</p>
<p class="note"><a href="${DEV_ROOMS_PATH}">回到这一页</a></p>
</body>
</html>
`;
}

/**
 * 从 `dsh web` 的 stdout 里解出那一行：`dsh web: http://127.0.0.1:<port>/?token=…`。
 * 认不出来 `null`（**不猜**）。
 */
export function parseDshWebLine(line) {
  const m = /dsh web:\s*http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)/u.exec(String(line ?? ''));
  if (!m) return null;
  return { port: Number.parseInt(m[1], 10), token: m[2] };
}

/** 从 `set-cookie` 里挑出 DSH 自己那把（`dsh-auth-…`），返回 `name=value`。 */
export function pickDshAuth(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const raw of list) {
    const first = String(raw).split(';')[0].trim();
    if (/^dsh-auth/u.test(first)) return first;
  }
  return null;
}

/** DSH 那份工作区注册表在哪（`$DSH_HOME/storages/workspace.json`）。**只有这一处**。 */
export function workspaceRegistryPath(dshHome) {
  return nodePath.join(String(dshHome ?? ''), 'storages', 'workspace.json');
}

/**
 * **让 DSH 认得这一间** —— 这是 D3（真机看得见那一间里的会话）的**必要条件**。
 *
 * 🔴 真机读数（2026-09-25，`/tmp/dshreg`）：
 *   DSH 的工作区注册表（`$DSH_HOME/storages/workspace.json`）一旦
 *   `global.initialized === true`，它**再也不从会话头里发现新的房间** ——
 *   `dsh-workspace` 的 `bootstrap()` 只跑那一次（`if (!state.initialized) { … bootstrap }`）。
 *   实测：注册表冻结在 `other` 时，另起的那台界面**只列 `other`**；
 *   `main` 里那份会话**一个字都不显示**（连 `Ungrouped` 都没有）——
 *   哪怕那台进程的 cwd 就是 `main`。⇒ **光把 cwd 指对，不够**。
 *
 * ★ 修法（**最小、幂等、不动既有记录**）：起那台之前，如果这一间的 cwd
 *   **不在**注册表里，就把 `initialized` 置回 `false` —— 下一次 boot 会按会话头
 *   **重新发现所有房间**（`bootstrap` 保留既有表、只补新路径）。
 *   实测：置回 `false` 再起 ⇒ 注册表里 `other` 与 `main` 都在了，界面两间都列出来。
 *
 * 🔴 **写盘默认是关的**（`apply` 默认 `false`）：写 DSH 的存储属于"改运行中的东西"，
 *    **要主人拍**。不开的时候只做**只读检查**（调用方据此说一句提示），一个字节都不动。
 *
 * ⚠️ 真要写时，调用方必须保证**我们那台 `dsh web` 没在跑**（`spawnWeb()` 前面先 `killChild()`）
 *    —— 免得跟 DSH 自己的写撞上。
 * ⚠️ 认不出来（文件不在 / 读不动 / 不是 JSON）⇒ **什么都不做**：
 *    那种情况 DSH 自己会 bootstrap（本来就是"还没初始化"）。
 *
 * @param {object} o
 * @param {string} o.dshHome
 * @param {string} o.cwd
 * @param {object} [o.fs]
 * @param {boolean} [o.apply] **默认 `false`（只读）**；`true` 才真的把 `initialized` 置回 `false`
 * @returns {{changed:boolean, registered:boolean|null, why:string}}
 *          `registered:false` = 确知这一间不在注册表里（`changed` 才表示真写了盘）
 */
export function ensureRoomRegistered({ dshHome, cwd, fs = nodeFs, apply = false }) {
  const file = workspaceRegistryPath(dshHome);
  const want = (() => {
    try {
      return fs.realpathSync(cwd);
    } catch {
      return String(cwd ?? '');
    }
  })();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { changed: false, registered: null, why: '注册表还没有（DSH 自己会 bootstrap）' };
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return { changed: false, registered: null, why: '注册表读不出来（不猜、也不动它）' };
  }
  if (j?.global?.initialized !== true) {
    return { changed: false, registered: null, why: '注册表还没初始化（DSH 自己会 bootstrap）' };
  }
  const table = j?.tables?.workspaces;
  const rows = table && typeof table === 'object' ? Object.values(table) : [];
  for (const r of rows) {
    let p = typeof r?.path === 'string' ? r.path : '';
    if (p === '') continue;
    try {
      p = fs.realpathSync(p);
    } catch {
      /* 原来的路径没了 ⇒ 照原样比 */
    }
    if (p === want) return { changed: false, registered: true, why: '这一间已经在注册表里' };
  }
  // ★ 这一间不在
  if (!apply) {
    return {
      changed: false,
      registered: false,
      why: `这一间（${cwd}）不在 DSH 的注册表里 —— 界面可能看不到它的会话（要让它重新发现房间，得主人拍）`,
    };
  }
  // ★ 让 DSH 下次开机按会话头重新发现（幂等；表里的记录一条都不删）
  //
  // 🔴 **不许把它改成 DSH 自己读不了的东西**（2026-09-25 真机踩出来的）：
  //    这份注册表是**那台 DSH（uid=1000）**建/读的，而写它的是**盒里那个服务（root）**。
  //    原来按 `mode: 0o600` 一写 ⇒ 文件变成 **root:root 0600** ⇒ DSH 一起来就
  //    `EACCES: open '/data/dsh/storages/workspace.json'`（**每一间都起不来**，
  //    界面上一片 502）。⇒ 写之前**记下原来的属主与权限**，写到**临时文件**上、
  //    `chown` 回原主、再 `rename` 盖上去（原子；同时**先 chown 再改名** ⇒
  //    换不过去就什么都没换，原文一个字节不动）。
  let st = null;
  try {
    st = fs.statSync(file);
  } catch {
    st = null; // 读不到 stat ⇒ 什么都不改（宁可"没让它重新发现"，也不许写坏它）
  }
  if (!st) return { changed: false, registered: false, why: '读不到它的属主 —— 不改它' };
  const mode = Number.isInteger(st.mode) ? st.mode & 0o777 : 0o600;
  const me = typeof process.getuid === 'function' ? process.getuid() : null;
  const needChown = Number.isInteger(st.uid) && me !== null && st.uid !== me;
  const next = { ...j, global: { ...j.global, initialized: false } };
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode });
    // ⚠️ 顺序是死的：**先在临时文件上换手，再改名**。反过来的话，chown 失败时
    //    那个"改坏了属主"的文件**已经在原位**了 —— 退不回去。
    if (needChown) fs.chownSync(tmp, st.uid, st.gid);
    if (typeof fs.chmodSync === 'function') fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 没建起来 */
    }
    return {
      changed: false,
      registered: false,
      why: `写不进去（${err?.message ?? err}）—— 原文一个字节都没动`,
    };
  }
  return {
    changed: true,
    registered: false,
    why: `这一间（${cwd}）还不在注册表里 ⇒ 让 DSH 下次开机重新发现所有房间`,
  };
}

/**
 * 建盒子这一侧的 `dsh web` 反代（**懒起**：选了房间、第一条真请求才起进程）。
 *
 * ★ **房间清单**（契约 109）：先给 `main` ＋ 每一间工作区；点哪间就用**那间的 cwd**。
 *   ⇒ 那个 `cwd` 必须与真那台**同源**（`worlds` 那一套）—— 由调用方给 `rooms`
 *   （`serve.js` 从 `worlds` 取）；不给就退回只有 `main` 一间（`cfg.agentCwd`）。
 *
 * ⚠️ **一次只开一间**：换房间 ⇒ 先 `killChild()` 再 spawn；句柄/内存不随房间数涨。
 *
 * @param {object} o
 * @param {object} o.cfg   `config.js` 那份（`dshBin` / `agentCwd` / `dshHome` /
 *   `personaPath` / `capabilitiesPath` / `modelPatchPath` / `agentUid` / `agentGid` /
 *   `agentBootTimeoutMs`…）
 * @param {() => Array<{id:string,name:string,cwd:string}>|null} [o.rooms]
 *        房间清单的来源（**每次现取** ⇒ 新建的工作区不用重启就能看见）
 * @param {Function} [o.spawnFn]   注入用（判据里换成一个假子进程；默认真 spawn）
 * @param {Function} [o.httpRequest] 注入用（判据里换成一个假上游；默认真 `http.request`）
 * @param {Function} [o.connectFn] 注入用（**升级那条**接上游用的 `net.connect`；判据里换成假上游）
 */
export function createDevWebRelay({
  cfg,
  rooms = null,
  /**
   * 🔴 **要不要动 DSH 的工作区注册表**（`$DSH_HOME/storages/workspace.json`）。
   *
   * `false`（**默认**）= 只读：注册表里没有这一间时**只留一句提示**，一个字节都不写
   *   —— 那种情况下 DSH 界面**看不到**这一间的会话（D3 会红），这是**如实**的。
   * `true` = 起那台之前把 `initialized` 置回 `false`，让 DSH 按会话头重新发现所有房间
   *   （真机读数见 `ensureRoomRegistered`）。
   * ⚠️ 写它属于"改运行中的东西" ⇒ **默认关**，要主人拍。
   */
  workspaceNudge = false,
  spawnFn = nodeSpawn,
  httpRequest = nodeHttp.request,
  connectFn = nodeNet.connect,
  log = () => {},
  killGraceMs = DEV_KILL_GRACE_MS,
  bootTimeoutMs = null,
  /**
   * 等旧那台**真的退**的上限（默认 `DEV_EXIT_WAIT_MS`；判据注入一个小的）。
   * ⚠️ 换房间＝杀→**等它真死**→再起 —— 这个顺序不许变。
   */
  exitWaitMs = DEV_EXIT_WAIT_MS,
  /** 发完信号之后**核实它真的没了**的上限（默认 `DEV_PID_GONE_WAIT_MS`；判据注入一个小的）。 */
  pidGoneWaitMs = DEV_PID_GONE_WAIT_MS,
  /** 注入用：读"这一层被 OOM 杀了几个"（判据里给一个假的；默认读 cgroup）。 */
  oomKillsFn = readOomKills,
  /**
   * 🔴 **发信号那一步**（`(pid, signal) => boolean`）。
   *
   * 默认 = `makeKillPid(cfg)`：拿 **`cfg.agentUid/Gid` 起一个一次性 node helper**
   * 去 `process.kill` —— **因为盒里那个服务（容器 root）没有 `CAP_KILL`，
   * 杀不动换手到 uid 1000 的那台 DSH**（真机 `Operation not permitted`，见文件顶那段）。
   * 判据注入一个假的（**能数出调了几次、带了什么信号**）。
   * 变异 K1：把 `killChild()` 改回 `c.kill(...)` ⇒ 当场红。
   */
  killPid = null,
  /** 注入用：`/proc/<pid>` 还在不在（默认读 `/proc`；判据里给个假的）。 */
  pidAliveFn = null,
  /**
   * 🔴 **要不要扫盒里别的 `--profile web`**（默认 **`false`**）。
   *
   * 为什么默认关：**宿主上不能扫** —— 那儿主人的 `dsh` 一堆，扫到就是手一滑收掉别人的东西。
   * `serve.js` **只在容器那一支**（`cfg.trustedSocketPath` 那条路，宿主上根本不建这个中继）
   * 才传 `true`。⇒ 判据 K3 的边界就是"默认关着的时候，一台都不许动"。
   */
  sweepOrphans = false,
  /** 扫 `/proc` 用的 fs（判据里给个假的）。 */
  procFs = nodeFs,
  /** `/proc` 在哪儿（判据里给个假的目录）。 */
  procDir = '/proc',
  /** 注入用：读这一层的**内存余量**（默认读 cgroup；读不到 ⇒ `null` ⇒ **不挡**）。 */
  memFn = null,
  /** 起一台之前至少要多少空闲内存（默认 `DEV_MEM_NEED_BYTES`）。 */
  memNeedBytes = DEV_MEM_NEED_BYTES,
  /** 内存不够时最多等多久（默认 `DEV_MEM_WAIT_MS`）。 */
  memWaitMs = DEV_MEM_WAIT_MS,
  /**
   * 🔴 **起台失败之后的冷却**（默认 `DEV_FAIL_COOLDOWN_MS`；判据注入一个小的）。
   *
   * **为什么要有它**（2026-09-26 父 agent 在 u2 上量到的）：入口那一页的 WebSocket
   * **会自动重连**，而每一次重连（/ 每一次取页、每一条 `/` 请求）在"没有活着的那台"时
   * 都会走 `ensure()` ⇒ **又起一台**。⇒ 一个开着的标签页就足以把盒子拖进
   * "反复起、反复被 OOM 杀"的循环（他清完孤儿，过一会儿又冒出 1/2/3 台，而没人在点房间）。
   * ⇒ 失败之后**一段时间内不许再起新的**，冷却期里**如实回 503**。
   */
  failCooldownMs = DEV_FAIL_COOLDOWN_MS,
} = {}) {
  if (!cfg) throw new Error('开发者中继需要 cfg');
  /** ⚠️ 日志一律先过 `redactSecrets`（进程令牌 / cookie 值不许进日志）。 */
  const say = (m) => log(redactSecrets(m));

  /** 发信号（默认是"同 uid 的小 helper"，见 `makeKillPid` 那段）。 */
  const killPidFn = typeof killPid === 'function' ? killPid : makeKillPid(cfg);
  /** `/proc/<pid>` 还在不在。 */
  const pidAlive = typeof pidAliveFn === 'function' ? pidAliveFn : (p) => pidExists(p);
  /** 这一层的内存余量（读不到 ⇒ `null`）。 */
  const readMem = typeof memFn === 'function' ? memFn : () => readMemoryHeadroom();

  const bootMs =
    Number.isFinite(bootTimeoutMs) && bootTimeoutMs > 0
      ? bootTimeoutMs
      : Number.isFinite(cfg.agentBootTimeoutMs) && cfg.agentBootTimeoutMs > 0
        ? cfg.agentBootTimeoutMs
        : 90_000;

  /**
   * 现在那个进程（`null` = 没起 / 已经没了）。
   *
   * 🔴 **一次只开一间**（契约 109）：`currentId` 是**现在这一台**开的哪一间，
   *    `currentCwd` 是起它的那一刻用的 cwd（诊断用）。换房间 ⇒ `killChild()` 再 spawn。
   */
  let child = null;
  /** 起好之后的两个事实：回环端口、DSH 自己那把 cookie（**替浏览器**拿着）。 */
  let upstream = null;
  let starting = null;
  let closed = false;
  let stderrTail = '';
  /** 现在那一台开的哪一间（`null` = 还没选）。 */
  let currentId = null;
  /** 起进程那一刻那一间的 cwd（给 `state()` 排障用）。 */
  let currentCwd = null;
  /** 现在这一台**真的没了**的凭据（`exit` 一发生就 resolve；`null` = 没在跑）。 */
  let childGone = null;
  /**
   * **上一次收台还没做完**（`killChild()` 给的那个 promise）。
   * 🔴 起新台之前要 `await` 它 —— 见 `DEV_EXIT_WAIT_MS` 那段（换房间撞 OOM 的根因）。
   */
  let tearing = Promise.resolve();
  /**
   * 代号：换一台就 +1。
   * ⚠️ 少了它，"换房间"期间那条**在飞的启动**落地时会把**新**这一台的状态覆盖掉
   *    （它会把自己那个端口写进 `upstream`）—— 那是"两个 dev 进程"的形状。
   */
  let gen = 0;
  /**
   * **上一次起台失败**（时刻 / 错码 / 那句话）；成功一次就清掉。
   * 🔴 冷却（`DEV_FAIL_COOLDOWN_MS`）读的就是它 —— 没有它，
   *    入口那条会自动重连的 WebSocket 会把盒子拖进 spawn 风暴。
   */
  let lastFailure = null;

  /** **房间清单的来源**（不给 ⇒ 只有 `main` 一间，cwd 就是 `cfg.agentCwd`）。 */
  const roomsOf = () => {
    if (typeof rooms === 'function') return rooms();
    return [{ id: 'main', name: '主对话', cwd: cfg.agentCwd }];
  };

  /** 现在有哪些房间（**每次现取** —— 新工作区不用重启就能看见）。 */
  function listRooms() {
    try {
      return normalizeRooms(roomsOf());
    } catch (err) {
      say(`房间清单没读出来：${err?.message ?? err}`);
      return [];
    }
  }

  /** 找一间；**认不出 ⇒ `null`**（不许拿一个随手的字符串当 cwd）。 */
  function findRoom(id) {
    if (typeof id !== 'string' || id === '') return null;
    return listRooms().find((r) => r.id === id) ?? null;
  }

  /** 一个子进程的 pid（认不出 ⇒ `null`；**不猜**）。 */
  function pidOf(c) {
    const n = c?.pid;
    return Number.isInteger(n) && n > 1 ? n : null;
  }

  /** 冷却还剩多少毫秒（`0` = 没在冷却）。 */
  function cooldownLeft() {
    if (!lastFailure) return 0;
    const ms = Number.isFinite(failCooldownMs) && failCooldownMs > 0 ? failCooldownMs : DEV_FAIL_COOLDOWN_MS;
    const left = lastFailure.at + ms - Date.now();
    return left > 0 ? left : 0;
  }

  /**
   * 冷却期里那些请求：**不许再起新的** ⇒ 抛这个，调用方**如实 503 ＋ 人话**。
   * ⚠️ `lastCode` 是上一次失败那个错码：上一次是"内存腾不出地方"时，
   *    回的话也应当是那一句（**不许**把内存不够说成"没起来"）。
   */
  function cooldownError() {
    const e = new Error(
      `上一次起台刚失败（${lastFailure?.message ?? '原因不明'}），还要等 ${cooldownLeft()}ms`,
    );
    e.code = 'DEV_COOLDOWN';
    e.lastCode = lastFailure?.code ?? null;
    return e;
  }

  /**
   * 给一个子进程发信号：**有 pid 就走注入的那个 `killPid`**（同 uid 的小 helper）。
   *
   * ⚠️ 没有 pid（spawn 失败那一档 / 判据里的假子进程）⇒ 只剩句柄这一条路。
   *    那条路在盒里**不管用**（没有 `CAP_KILL`），所以它走的时候**一句话都不许省** ——
   *    由 `killChild()` 的"核实"那一步如实说。
   */
  function signalChild(c, sig) {
    const pid = pidOf(c);
    if (pid === null) {
      try {
        c?.kill?.(sig);
        return true;
      } catch {
        return false;
      }
    }
    try {
      return killPidFn(pid, sig) === true;
    } catch {
      return false;
    }
  }

  /** 等 `/proc/<pid>` 真的没了（**有上限**；到点还在 ⇒ `false`，不无限等）。 */
  async function waitPidGone(pid, waitMs = DEV_PID_GONE_WAIT_MS) {
    const deadline = Date.now() + waitMs;
    for (;;) {
      let alive = true;
      try {
        alive = pidAlive(pid) === true;
      } catch {
        // 读不到 ⇒ **不猜**：当成"还活着"，让调用方如实说
        alive = true;
      }
      if (!alive) return true;
      if (Date.now() >= deadline) return false;
      await delay(Math.min(DEV_PID_POLL_MS, waitMs));
    }
  }

  /**
   * 🔴 **起新台之前，把盒里别的 `--profile web` 收掉**（一次只开一间）。
   *
   * **为什么要有它**：`killChild()` 失败的年代（B43 第二版之前）留下的孤儿 ——
   * 盒里除了"现在这一台"之外**不该**有别的 `--profile web`；多一台就多 ~490MB，
   * 而这一层只有那么点地方。换房间那条路上，孤儿就是下一次 OOM 的来源。
   *
   * ⚠️ **三条不许破**：
   *   ① 只在**盒里**扫（`sweepOrphans` 默认 `false`；`serve.js` 只在容器那一支打开）
   *      —— 宿主上主人的 `dsh` 一堆，扫到就是收掉别人的东西；
   *   ② **只认 `--profile web`**（调度器按轮那台是 `--profile sdk`，评审那台也是）；
   *   ③ **不动"现在这一台"**（`child` 的 pid 与自己的 pid 都在跳过名单里）。
   *
   * ⚠️ 判据 K3 的两个变异：把 `sdk` 也扫 ⇒ 红；把当前那台也扫 ⇒ 红。
   */
  async function sweepOrphanWebs() {
    if (sweepOrphans !== true) return { swept: 0 };
    const keep = [process.pid];
    const cur = pidOf(child);
    if (cur !== null) keep.push(cur);
    let pids = [];
    try {
      pids = listWebProfilePids({ fs: procFs, procDir, skipPids: keep });
    } catch (err) {
      say(`盒里别的 dsh web 没扫成：${err?.message ?? err}（不敢乱动，这一台照常起）`);
      return { swept: 0 };
    }
    const swept = [];
    const left = [];
    for (const p of pids) {
      if (signalChild({ pid: p }, 'SIGKILL')) swept.push(p);
      else left.push(p);
    }
    if (swept.length > 0) {
      const still = [];
      for (const p of swept) {
        if (!(await waitPidGone(p, DEV_SWEEP_GONE_WAIT_MS))) still.push(p);
      }
      say(
        `⚠️ 盒里还留着 ${swept.length} 台别的 dsh web（不是现在这一台）⇒ 已经收掉` +
          `${still.length > 0 ? `（其中 ${still.length} 台还没收掉：pid ${still.join('、')}）` : ''}（一次只开一间）`,
      );
    }
    if (left.length > 0) {
      say(`⚠️ 盒里有 ${left.length} 台别的 dsh web 没收动（pid ${left.join('、')}）—— 它们还在占内存`);
    }
    return { swept: swept.length, left };
  }

  /**
   * 🔴 **起新台之前先确认"这一层腾得出地方"**（内存闸）。
   *
   * 真机读数：这一层 `memory.max` 只有那么大，而一台 `dsh web` ＋ 它那三个 MCP
   * 就是 ~490MB。硬起的下场是**被内核杀掉**（`oom_kill` +1），
   * 而那时报"没起来"就是把原因说错了。
   * ⇒ 余量不够就**等**（有上限）；到点还不够 ⇒ 抛一个带 `DEV_NO_MEMORY` 的错，
   *    调用方**如实回 503 ＋ 一句人话**。
   *
   * ⚠️ 读不到 cgroup（宿主上 `memory.max` 是 `max` / 没有那个文件）⇒ `null` ⇒ **不挡**：
   *    算不出余量时拿一个假数去挡人，就是"看着有闸、其实在猜"。
   */
  async function waitForMemory() {
    const need = Number.isFinite(memNeedBytes) && memNeedBytes > 0 ? memNeedBytes : DEV_MEM_NEED_BYTES;
    const now = () => {
      try {
        const m = readMem();
        return m && Number.isFinite(m.free) ? m : null;
      } catch {
        return null;
      }
    };
    const first = now();
    if (!first) return null; // 算不出 ⇒ 不挡（不猜）
    if (first.free >= need) return first;
    const deadline = Date.now() + (Number.isFinite(memWaitMs) ? memWaitMs : DEV_MEM_WAIT_MS);
    let last = first;
    while (Date.now() < deadline) {
      // ⚠️ **别睡过截止那一刻**（超时是"有上限"，不是"每次多睡一会儿"）。
      await delay(Math.max(1, Math.min(DEV_MEM_POLL_MS, deadline - Date.now())));
      const m = now();
      if (!m) return null; // 等的过程里读不到了 ⇒ 不挡（不猜）
      last = m;
      if (m.free >= need) return m;
    }
    const mb = (n) => Math.round(n / (1024 * 1024));
    const e = new Error(
      `这一层现在腾不出地方：余量 ${mb(last.free)}MB < 要 ${mb(need)}MB（等了 ${Number.isFinite(memWaitMs) ? memWaitMs : DEV_MEM_WAIT_MS}ms）`,
    );
    e.code = 'DEV_NO_MEMORY';
    throw e;
  }

  /**
   * 收掉现在这一台。**返回一个 promise：它真的没了（或者等到了上限）**。
   *
   * 🔴 **为什么要能等**：换房间是"先收旧的、再起新的"，而旧那台（一整台 DSH，
   *    ~348MB ＋ 三个 MCP 子进程）**不是一下就没了**的 —— 原来不等 ⇒ 两台的峰值叠在
   *    一起 ⇒ 盒子的内存上限顶不住 ⇒ 内核把**新起来的那台**杀掉（真机：`oom_kill` 3→5）。
   *    ⇒ 调用方（`ensure()`）**起新台之前先 `await` 它**。
   *
   * 🔴 **第二版（2026-09-26）：光"等"不够 —— 它**杀不动**。**
   *    真机读数：`c.kill()` 在盒里**静默失败**（容器 root 没有 `CAP_KILL`，而那台是 uid 1000
   *    起的）⇒ 等的是一个**永远不会来的** `exit`，等到上限就当"收完了"，旧那台照旧占着 ~390MB。
   *    ⇒ 现在①发信号走 `killPidFn`（同 uid 的小 helper）；②发完**核实真的没了**
   *      （读 `/proc/<pid>`，有上限）；③没杀掉就**如实说一句**（不许静默、不许当收干净了）。
   */
  function killChild() {
    gen += 1;
    const c = child;
    const gone = childGone;
    const pid = pidOf(c);
    child = null;
    childGone = null;
    upstream = null;
    starting = null;
    if (!c) return tearing;
    signalChild(c, 'SIGTERM');
    const t = setTimeout(() => {
      signalChild(c, 'SIGKILL');
    }, killGraceMs);
    t.unref?.();
    tearing = (async () => {
      // ★ **等 `exit`**（B43 那条不变：换房间＝杀→等它真死→再起）。
      await Promise.race([
        gone ?? Promise.resolve(),
        delay(Number.isFinite(exitWaitMs) && exitWaitMs >= 0 ? exitWaitMs : DEV_EXIT_WAIT_MS),
      ]);
      clearTimeout(t);
      // 🔴 **核实**：发过信号 ≠ 收干净了。没死就如实说（这条以前是静默的）。
      if (pid !== null) {
        const reallyGone = await waitPidGone(
          pid,
          Number.isFinite(pidGoneWaitMs) && pidGoneWaitMs >= 0 ? pidGoneWaitMs : DEV_PID_GONE_WAIT_MS,
        );
        if (!reallyGone) {
          say(
            `⚠️ 换房间：旧那台 dsh web（pid ${pid}）**没收掉** —— 它还活着（同 uid 那个 helper ` +
              `也没能收掉它），它还在占内存。**别当成收干净了。**`,
          );
        }
      }
    })();
    return tearing;
  }

  /**
   * 收掉现在这一台并**忘掉选过哪间**（房间没了 / 关掉中继时用）。
   * ⚠️ 与 `killChild()` 分开：那一个只收进程（"换一间"还要把新那间记上）。
   * 🔴 **把它那个"真的收干净了"的 promise 交出去**（B46）：聊天那条路要让开时
   *    必须能等到**写租约真的放开**（不然下一轮 prompt 照旧被拒）。
   */
  function dropCurrent() {
    const gone = killChild();
    currentId = null;
    currentCwd = null;
    return gone;
  }

  /**
   * 🔴 **让开这一间**（B46 · 2026-09-26 真机）。
   *
   * **为什么要有它**：主人在**产品里**跟某一间说话时，开发者入口那台 `dsh web`
   *   正开着**同一间** ⇒ DSH 的持久化层对那条会话有一把**写租约**（`session.lock`，
   *   flock），第二个进程直接被拒（真机原话：
   *   `session "owner/aoshu-bank.muh709vsibnh.1" is already owned by an active write handle`）
   *   ⇒ 那一轮答不上。**主人在产品里说话永远优先于"他开着看的那个窗口"**。
   *
   * 🔴 **三条守卫**（每一条都有判据钉着）：
   *   · **只收"正开着的、而且就是这一间"那一台** —— 别的房间一台都不许动（L2）；
   *   · 走的就是 `dropCurrent()`（换房间 / 关中继那**同一条**路，
   *     `killChild()` ＋ 核实真死 ＋ 失败如实说）—— **不另写第二套收台逻辑**；
   *   · 宿主侧根本没有这个中继（`serve.js` 只在容器里建）⇒ 调用方拿到 `null`，
   *     一次都不问（L3）。
   *
   * ⚠️ **代价是明说的**：收掉之后那个窗口会断开，入口回到房间清单页
   *    —— 房间清单页上本来就写着"一次只开一间"。
   *
   * @param {string} roomId 要说话的那一间（＝ scope id）
   * @returns {Promise<{held:boolean, room:string|null, pid:number|null, dropped:boolean}>}
   *   `held` = 这一间**正是**入口现在开着的那一间（⇒ 收了）；
   *   `dropped` = 真的有一台在跑／在起（收的是它）。
   */
  async function yieldRoom(roomId) {
    const id = typeof roomId === 'string' && roomId !== '' ? roomId : null;
    // ⚠️ **不是这一间 ⇒ 一个手指头都不许碰**（别的房间照常开着看 —— L2 的变异就在这行）
    if (id === null || currentId !== id) {
      return { held: false, room: id, pid: null, dropped: false };
    }
    const pid = pidOf(child);
    const wasRunning = pid !== null || starting !== null;
    const name = findRoom(id)?.name ?? id;
    // ★ **如实记一句**（哪一间、为什么收）—— 这是排障时唯一能看见"让开发生过"的地方
    say(
      `开发者入口正开着「${name}」这一间 ⇒ 收掉那台 dsh web` +
        `（主人在产品里跟这一间说话：聊天优先；那个窗口会断开，房间清单页上写着"一次只开一间"）`,
    );
    const gone = dropCurrent();
    try {
      await gone; // 等**写租约真的放开**（`killChild()` 自己不抛，这里兜底）
    } catch {
      /* 收不干净由 `killChild()` 那句"没收掉"如实说；调用方拿到的读数照旧 */
    }
    return { held: true, room: id, pid, dropped: wasRunning };
  }

  /** 起进程，等 stdout 上那一行。`room` = **那一间**（cwd 就是它）。 */
  function spawnWeb(room) {
    // ★ **起这台之前的内存读数**（只用来说清"是不是被 OOM 杀的"；读不到就是 `null`）
    const oomAtStart = (() => {
      try {
        return oomKillsFn();
      } catch {
        return null;
      }
    })();
    // 🔴 **先看看 DSH 认不认得这一间**（D3 的必要条件）：注册表一旦初始化过，DSH 就
    //    **不再**发现新房间，界面会把这一间的会话整个藏掉 —— 光把 cwd 指对不够。
    //    ⚠️ **默认只读**：写 DSH 的 `workspace.json` 属于"改运行中的东西"，要主人拍
    //       （`workspaceNudge` 是那个开关，默认 **关**）。关着的时候只留一句提示。
    //    ⚠️ 无论写不写，都必须在 spawn **之前**（此刻我们那台一定没在跑 —— `ensure()` 先收了）。
    const reg = ensureRoomRegistered({ dshHome: cfg.dshHome, cwd: room.cwd, apply: workspaceNudge });
    if (reg.changed) say(`房间 ${room.name}：${reg.why}`);
    else if (reg.registered === false) say(`房间 ${room.name}：⚠️ ${reg.why}`);
    // 🔴 **一套参数**（`--profile web` ＋ 那几层 patch）—— 见 `devWebArgs()`。
    const args = devWebArgs(cfg);
    // 🔴 **cwd = 那一间**（盒里 `main` 就是 `/data/main`）：DSH 按 cwd 给会话分组
    //    ⇒ 与调度器按轮起的那台看到的是**同一份会话**（契约 109 D2/D3）。
    const cwd = room.cwd;
    const c = spawnFn(cfg.dshBin, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // 🔴 **换手**：盒里的服务是 root，而 root 带 CAP_DAC_OVERRIDE
      //    ⇒ 不换手的话那台 DSH 能读钥匙（决策 ①）。换不过去会异步 EPERM ⇒ 大声失败。
      ...(cfg.agentUid !== null && cfg.agentUid !== undefined ? { uid: cfg.agentUid } : {}),
      ...(cfg.agentGid !== null && cfg.agentGid !== undefined ? { gid: cfg.agentGid } : {}),
      // ★ env 只有**一处出处**：`agentEnv(cfg)`（摘密钥 ＋ `DSH_HOME` **就是那一个**
      //   ＋ 能力层那几样 `HUPO_*`）。
      //   🔴 少了能力层那几样，`hupo-capabilities.yml` 那几条 `- insert:` 的 `args`
      //      会变成 `[null]` ⇒ **整个 plugin tree 加载失败、dsh 当场退**（真机读数：
      //      `failed to apply loader entry mcp-ledger … expected {…} but got {"args":[null]}`）。
      //   ⚠️ **绝不给第二个 home**：那等于第二个 harness（判据 D7′）。
      env: agentEnv(cfg),
    });
    child = c;
    // ★ **"真的没了"的凭据**：`exit` 一发生就 resolve（`killChild()` 等它）
    let goneResolve = null;
    childGone = new Promise((r) => {
      goneResolve = r;
    });
    if (c?.stdout?.setEncoding) c.stdout.setEncoding('utf8');
    if (c?.stderr?.setEncoding) c.stderr.setEncoding('utf8');
    c?.stderr?.on?.('data', (d) => {
      stderrTail = (stderrTail + String(d)).slice(-2000);
    });
    // 进程自己没了 ⇒ 清掉状态（下一条请求会**重新懒起**，不是永远坏着）
    c?.on?.('exit', () => {
      goneResolve?.();
      if (child === c) {
        child = null;
        childGone = null;
        upstream = null;
      }
    });

    return new Promise((resolve, reject) => {
      let buf = '';
      let done = false;
      const finish = (err, val) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(val);
      };
      // ★ 失败时**把这一台的句柄挂在错误上** —— 调用方据此收掉它（**不许留孤儿**：
      //   换房间时全局那个 `child` 可能已经指向新的一间了）。
      const oomBefore = oomAtStart;
      const failWith = (msg) => {
        const oomNow = (() => {
          try {
            return oomKillsFn();
          } catch {
            return null;
          }
        })();
        // 🔴 **只说读得到的事**：OOM 计数涨了 ⇒ 说明"被系统杀掉了（内存不够）"；
        //    读不到 / 没涨 ⇒ 一个字都不编。
        const hint =
          Number.isInteger(oomNow) && Number.isInteger(oomBefore) && oomNow > oomBefore
            ? `；⚠️ 这一层的内存被系统杀过（oom_kill ${oomBefore} → ${oomNow}）—— 多半是同时开着两台`
            : '';
        const e = new Error(`${msg}${hint}`);
        e.child = c;
        finish(e);
      };
      const timer = setTimeout(() => failWith(`等 dsh web 报端口超时（${bootMs}ms）`), bootMs);
      timer.unref?.();
      c?.stdout?.on?.('data', (chunk) => {
        buf += String(chunk);
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const hit = parseDshWebLine(line);
          if (hit) {
            // ⚠️ 把**这一台**的句柄一起交出去：调用方要能只收掉自己那一台
            //    （换房间时 `child` 可能已经指向新的那一间了）。
            finish(null, { ...hit, child: c });
            return;
          }
        }
      });
      c?.on?.('error', (err) => {
        err.child = c;
        finish(err);
      });
      c?.on?.('exit', (code, signal) => {
        failWith(
          `dsh web 起不来（code=${code ?? '—'}${signal ? `，signal=${signal}` : ''}）` +
            `${stderrTail.trim() ? `；它最后说的话：${redactSecrets(stderrTail).trim().slice(-300)}` : ''}`,
        );
      });
    });
  }

  /** 一条一次性 GET（不跟重定向）。 */
  function oneGet(port, path) {
    return new Promise((resolve, reject) => {
      const r = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'GET',
          path,
          headers: { host: `127.0.0.1:${port}`, accept: 'text/html' },
        },
        (upRes) => {
          upRes.resume(); // 丢掉身体（**不是**缓冲）
          resolve({ status: upRes.statusCode ?? 0, headers: upRes.headers ?? {} });
        },
      );
      r.on('error', reject);
      r.end();
    });
  }

  /**
   * 用进程令牌换 DSH 自己那把 cookie。
   * ⚠️ `/?token=` **会 303**（`81-HARNESS-ENTRY.md` §三）⇒ **要跟**（跟着找 set-cookie）。
   */
  async function exchangeToken(port, token) {
    let path = `/?token=${encodeURIComponent(token)}`;
    for (let hop = 0; hop < 4; hop += 1) {
      const r = await oneGet(port, path);
      const cookie = pickDshAuth(r.headers['set-cookie']);
      if (cookie) return cookie;
      const loc = r.headers.location;
      if (r.status >= 300 && r.status < 400 && typeof loc === 'string') {
        try {
          const u = new URL(loc, `http://127.0.0.1:${port}`);
          if (u.host === `127.0.0.1:${port}`) {
            path = `${u.pathname}${u.search}`;
            continue;
          }
        } catch {
          /* 认不出来就不跟 */
        }
      }
      break;
    }
    throw new Error('没换到 dsh 自己那把 cookie（那个进程令牌可能不认）');
  }

  /**
   * 起（或复用）**某一间**的那台 `dsh web`。
   *
   * 🔴 **一次只开一间**：`currentId` 已经是这一间 ⇒ 复用；不是 ⇒ **先把旧的收掉**
   *    （`killChild()`）再起。⇒ 句柄/内存不随房间数涨。
   * ⚠️ `gen` 那一道：换房间时在飞的那次启动落地后会**自己收掉**，不会把新那台盖掉。
   */
  async function ensure(room) {
    if (closed) throw new Error('开发者中继已经关了');
    // ★ 已经有一台活着 ⇒ 永远照常服务（冷却只管"要不要**再起一台**"）
    if (upstream) return upstream;
    // 🔴 **冷却期：不许再起新的**（有在飞的启动就让它接着飞 —— 那是同一台）
    if (!starting && cooldownLeft() > 0) throw cooldownError();
    if (currentId !== room.id) {
      killChild(); // 换房间：旧的收掉（"一次只开一间"）
      currentId = room.id;
      currentCwd = room.cwd;
    }
    if (!starting) {
      const myGen = gen;
      const p = (async () => {
        // 🔴 **先等上一台真的退干净**（换房间那条路的内存峰值就在这儿 ——
        //    见 `DEV_EXIT_WAIT_MS`：两台的峰值叠在一起会被内核 OOM 杀掉新的那台）。
        await tearing;
        // 🔴 **`spawnWeb` 这一步也在 `try` 里面**（2026-09-25 真机 + 判据一起抓到的）：
        //    它原来在 `try` **外面** ⇒ "起不来"那一条路（超时 / 一启动就被杀）
        //    **走不到**下面那个 `catch` ⇒ 那台失败的 `dsh web` **没人收** ⇒
        //    它赖在容器里占着 ~348MB，而中继自己以为"什么都没有在跑"。
        let hit = null;
        try {
          // 🔴 **先扫孤儿**（B43 第二版）：盒里除了中继自己起的那台，**不该**有别的
          //    `--profile web`。留着就是下一次 OOM 的来源。见 `sweepOrphanWebs()`。
          await sweepOrphanWebs();
          // 🔴 **再看这一层腾不腾得出地方**：不够就等（有上限），到点还不够就
          //    **如实 503**（不硬起、也不把它说成"没起来"）。见 `waitForMemory()`。
          await waitForMemory();
          hit = await spawnWeb(room);
          const cookie = await exchangeToken(hit.port, hit.token);
          if (myGen !== gen) {
            // 这期间被换掉了 ⇒ 刚起来的这一台**不留**（不然盒里就有两台了）。
            // ⚠️ 收的是**我这一台**（`hit.child`），不是 `child` —— 后者现在
            //    可能已经指向**新那一间**的进程了。
            signalChild(hit.child, 'SIGTERM');
            const superseded = new Error('这一台刚起来就被换掉了');
            superseded.code = 'DEV_SUPERSEDED';
            throw superseded;
          }
          // ⚠️ **令牌与 cookie 都不进日志**（只说端口、房间与"通了"）
          say(`盒里那台 dsh web 起来了（127.0.0.1:${hit.port}，房间 ${room.name}，只听回环；cookie 已存住）`);
          upstream = { port: hit.port, cookie };
          lastFailure = null; // ★ 成功一次就把冷却清掉
          return upstream;
        } catch (err) {
          // 🔴 **失败的那一台要被真的收掉**（不留孤儿赖着内存）：按**句柄**收
          //    （全局那个 `child` 可能已经指向新的一间），再走一遍 `killChild()`。
          //    ⚠️ 内存闸那一档（`DEV_NO_MEMORY`）**本来就没起过台**，什么都不用收。
          if (err?.code !== 'DEV_NO_MEMORY') {
            signalChild(err?.child ?? hit?.child, 'SIGKILL');
            killChild();
          }
          // 🔴 **记下失败时刻**（冷却用它）。⚠️ "刚起来就被换掉了"不算失败 ——
          //    那是换房间把在飞的那台收掉；记了会让**新那一间**白等一段冷却。
          if (err?.code !== 'DEV_SUPERSEDED') {
            lastFailure = { at: Date.now(), code: err?.code ?? null, message: err?.message ?? String(err) };
          }
          throw err;
        }
      })();
      starting = p;
      // ⚠️ **只清"还是它自己"的那一个**：换房间时 `killChild()` 已经把 `starting` 清掉、
      //    新那一台的启动可能已经放进来了 —— 无条件清会把**新那台**的状态抹掉
      //    ⇒ 下一条请求会**又起一台**（那就是"两个进程"）。
      const settle = () => {
        if (starting === p) starting = null;
      };
      void p.then(settle, settle);
    }
    return starting;
  }

  /** 把房间清单那一页发出去（**它自己不起任何 DSH**）。 */
  function sendRoomsPage(res) {
    const body = devRoomsHtml({ rooms: listRooms(), current: currentId });
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
    return undefined;
  }

  /**
   * 把一条 `/h…` 请求反代到那台 `dsh web`。**不缓冲**（两头 `pipe`）。
   *
   * ★ **房间那一步在反代之前**（契约 109）：
   *    · `/__rooms` ⇒ 清单页（**不碰任何 DSH 进程**）；
   *    · `/?room=<id>` ⇒ 记下这一间 ＋ `302` 到 `/`（那一间的那台在下一条请求里懒起）；
   *    · 还没选过（`currentId === null`）⇒ `/` 给清单、别的路径如实说一句。
   *
   * @param {string} relPath 已经剥掉 `/h` 前缀的路径（`/`、`/api/x?y=1`…）
   */
  async function handle(req, res, relPath) {
    const path0 = typeof relPath === 'string' && relPath.startsWith('/') ? relPath : `/${relPath ?? ''}`;
    // ⚠️ 只借它取 pathname/searchParams（`relPath` 是**相对**的，给个假 origin）
    const url = new URL(path0, 'http://127.0.0.1');

    // ── ★ 房间清单（`/__rooms` 永远给；`/` 还没选过也给）──
    if (url.pathname === DEV_ROOMS_PATH) return sendRoomsPage(res);

    // ── ★ 选一间：`/?room=<id>` ⇒ 记下来 ＋ 302 到 `/` ──
    //   ⚠️ **只在 `/` 与清单页上认这个参数**（别的地方带 `room=` 是别人自己的事）。
    const want = url.searchParams.get(DEV_ROOM_QUERY);
    if (want !== null && want !== '' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const room = findRoom(want);
      if (!room) {
        say(`开发者入口：点了不认识的一间（${String(want).slice(0, 40)}）⇒ 拒`);
        return devUnavailable(res, 404, '没有这一间。回房间清单看一眼。');
      }
      if (currentId !== room.id) {
        // 🔴 **冷却期里不许"换"**：换了就要起新的一台，而冷却正是为了不起。
        //    ⚠️ 顺序也重要：**先看冷却、再收旧的** —— 反了的话，冷却期里点一下
        //       就会把**现在正跑着的那台**收掉，然后 503（用户白丢一台）。
        if (cooldownLeft() > 0) {
          say(`开发者入口：还在冷却（${cooldownLeft()}ms）⇒ 不换间、也不起新的`);
          return devUnavailable(res, 503, DEV_FAIL_COOLDOWN_TEXT);
        }
        killChild(); // 换房间 ⇒ 旧的收掉（"一次只开一间"）
        currentId = room.id;
        currentCwd = room.cwd;
      }
      // 302 到**干净**的 `/`（把这个参数抹掉，免得它留在界面地址里）
      res.writeHead(302, {
        location: '/',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end();
      return undefined;
    }

    // ── ★ 还没选过哪一间 ──
    if (currentId === null) {
      // 首页 ⇒ **先给房间清单**（契约 109 §"先给一个房间清单"）
      if (url.pathname === '/' || url.pathname === '/index.html') return sendRoomsPage(res);
      return devUnavailable(res, 409, '先回房间清单选一间。');
    }

    // ── ★ 那一间还在吗（工作区可能被删了）──
    const room = findRoom(currentId);
    if (!room) {
      say(`开发者入口：现在这一间（${currentId}）不在清单里了 ⇒ 回清单页`);
      dropCurrent();
      return sendRoomsPage(res);
    }

    let up;
    try {
      up = await ensure(room);
    } catch (err) {
      // 🔴 **内存不够是一句不同的话**（不是"没起来"）：那一台**根本没起**
      //    （我们主动没起），硬起只会被内核杀掉。⇒ **503 ＋ 一句人话**。
      if (err?.code === 'DEV_NO_MEMORY' || err?.lastCode === 'DEV_NO_MEMORY') {
        say(`盒里那一间现在腾不出地方（房间 ${room.name}）：${err?.message ?? err} ⇒ 503（不硬起）`);
        return devUnavailable(res, 503, DEV_NO_MEMORY_TEXT);
      }
      // 🔴 **刚失败过 ⇒ 冷却期里不许再起新的**（入口那条 WebSocket 会自动重连 ——
      //    不冷却就是一个开着的标签页把盒子拖进 spawn 风暴）。**如实 503 ＋ 人话**。
      if (err?.code === 'DEV_COOLDOWN') {
        say(`盒里那一间刚没起来（房间 ${room.name}）：${err?.message ?? err} ⇒ 503（冷却中，不重复起）`);
        return devUnavailable(res, 503, DEV_FAIL_COOLDOWN_TEXT);
      }
      say(`盒里那台 dsh web 没起来（房间 ${room.name}）：${err?.message ?? err}`);
      return devUnavailable(res, 502, '那台界面现在没起来，等会儿再试。');
    }

    const headers = { ...req.headers };
    for (const h of HOP_BY_HOP) delete headers[h];
    // ★ **剥掉浏览器那份 cookie**，替它带上 DSH 自己那把（里层那把锁归壳拿着）
    delete headers.cookie;
    headers.cookie = up.cookie;
    // ★ 那道 `/api` 栅栏按**回环**放行：Host / Origin / Sec-Fetch-Site 都要改写成回环
    headers.host = `127.0.0.1:${up.port}`;
    if (headers.origin !== undefined) headers.origin = `http://127.0.0.1:${up.port}`;
    if (typeof headers.referer === 'string') {
      headers.referer = headers.referer.replace(/^https?:\/\/[^/]+/u, `http://127.0.0.1:${up.port}`);
    }
    headers['sec-fetch-site'] = 'same-origin';

    const path = path0;
    // ★ **那一页本体**（只有它）要在顶上明写"在这儿说话的不是琥珀"（契约 109 §八）。
    //   ⚠️ 只认顶层那两份文档；别的 HTML（界面自己的子页 / 资源）一个字节都不碰。
    const isDoc =
      (req.method === 'GET' || req.method === 'HEAD') &&
      (url.pathname === '/' || url.pathname === '/index.html');
    //   ⚠️ 要 `identity`：压缩过的字节没法安全地插一行（认不出就不插 —— 见 `injectDevBanner`）。
    if (isDoc) headers['accept-encoding'] = 'identity';

    let answered = false;
    const fail = (err) => {
      if (answered) return;
      answered = true;
      say(`转给盒里那台 dsh web 失败：${err?.message ?? err}`);
      if (!res.headersSent) devUnavailable(res, 502, '刚才断了一下，等会儿再试。');
      else res.destroy();
    };

    const up_req = httpRequest(
      { host: '127.0.0.1', port: up.port, method: req.method, path, headers },
      (upRes) => {
        answered = true;
        const out = { ...upRes.headers };
        delete out['transfer-encoding'];
        // 🔴 **里层那把锁的 cookie 不许给浏览器**（壳替它拿着）
        delete out['set-cookie'];
        if (typeof out.location === 'string') {
          out.location = out.location.replace(
            new RegExp(`^https?://127\\.0\\.0\\.1:${up.port}`, 'u'),
            '',
          );
        }
        // ★ 顶层文档 ⇒ **插那一条**（其余一律原样流式转出去）
        const enc = String(out['content-encoding'] ?? '');
        const canInject =
          isDoc &&
          (upRes.statusCode ?? 0) === 200 &&
          String(out['content-type'] ?? '').includes('text/html') &&
          (enc === '' || enc === 'identity');
        if (!canInject) {
          res.writeHead(upRes.statusCode ?? 502, out);
          upRes.pipe(res); // 流式（别缓冲）
          return;
        }
        // ⚠️ 只缓**那一页文档**（很小），而且**封顶**：超了就"边写边转发"，一个字节都不丢。
        const chunks = [];
        let n = 0;
        let bail = false;
        const head0 = () => {
          const o = { ...out };
          delete o['content-length'];
          res.writeHead(upRes.statusCode ?? 502, o);
        };
        upRes.on('data', (c) => {
          if (bail) return void res.write(c);
          chunks.push(c);
          n += c.length;
          if (n > DEV_BANNER_MAX_BYTES) {
            bail = true;
            head0();
            for (const x of chunks) res.write(x);
            chunks.length = 0;
          }
        });
        upRes.on('error', fail);
        upRes.on('end', () => {
          if (bail) return void res.end();
          const raw = Buffer.concat(chunks);
          const withBanner = injectDevBanner(raw.toString('utf8'));
          if (withBanner === null) {
            // 认不出那一页 ⇒ **原样**（这一条是"如实"，不是"功能"：宁可没有，也不能弄坏它）
            say('开发者入口：那一页认不出 <body> ⇒ 那条提示这次没插进去（页面照常）');
            head0();
            return void res.end(raw);
          }
          const buf = Buffer.from(withBanner, 'utf8');
          const o = { ...out };
          o['content-length'] = String(buf.length);
          res.writeHead(upRes.statusCode ?? 502, o);
          res.end(buf);
        });
      },
    );
    up_req.on('error', fail);
    req.on('error', () => {
      try {
        up_req.destroy();
      } catch {
        /* 已经没了 */
      }
    });
    req.pipe(up_req); // 请求体也流式
    return undefined;
  }

  /**
   * 把一次 `/h…` 的**升级**反代到那台 `dsh web`。
   *
   * 主数据通道就是它（`/api/remote.mux`）—— 少了这一条，界面能打开但**一个会话都列不出来**。
   *
   * ⚠️ 与 `handle` 同一个道理，改为"**原样搬字节**"而不是用 `ws` 客户端再连一次：
   *    用 `ws` 就等于**把协议实现两遍**（子协议、扩展、掩码、关闭握手…），
   *    每一处细节都可能跟盒里那台不一致。⇒ 这里只写请求行 + 头，
   *    **握手交给上游自己**完成；之后两边都是裸字节，直接对拷。
   *
   * 🔴 只有 `trusted === true`（容器里那条 `0600` UDS）才会走到这儿 —— 闸在 `server.js`。
   *
   * @param {import('node:net').Socket} socket 面向浏览器那条
   * @param {Buffer} head 握手之前已经读出来的字节（**必须原样转给上游**）
   * @param {string} relPath 已经剥掉 `/h` 前缀的路径（`/api/remote.mux`）
   */
  function handleUpgrade(req, socket, head, relPath) {
    const path = typeof relPath === 'string' && relPath.startsWith('/') ? relPath : `/${relPath ?? ''}`;
    // ★ **先要知道开的是哪一间**（契约 109）：没选过 ⇒ 握手阶段如实拒。
    const room = currentId === null ? null : findRoom(currentId);
    if (!room) {
      rejectUpgradeSocket(socket, 503, 'Service Unavailable', '先回房间清单选一间。');
      return undefined;
    }
    ensure(room)
      .then((up) => {
        const headers = { ...req.headers };
        for (const h of UPGRADE_HOP_BY_HOP) delete headers[h];
        // ★ **剥掉浏览器那份 cookie**，替它带上 DSH 自己那把（里层那把锁归壳拿着）
        delete headers.cookie;
        headers.cookie = up.cookie;
        // ★ 那道 `/api` 栅栏按**回环**放行：Host / Origin / Sec-Fetch-Site 都要改写成回环
        headers.host = `127.0.0.1:${up.port}`;
        if (headers.origin !== undefined) headers.origin = `http://127.0.0.1:${up.port}`;
        if (typeof headers.referer === 'string') {
          headers.referer = headers.referer.replace(/^https?:\/\/[^/]+/u, `http://127.0.0.1:${up.port}`);
        }
        headers['sec-fetch-site'] = 'same-origin';

        const sock = connectFn({ host: '127.0.0.1', port: up.port });
        let dead = false;
        const done = () => {
          if (dead) return;
          dead = true;
          try {
            socket.destroy();
          } catch {
            /* 已经没了 */
          }
          try {
            sock.destroy();
          } catch {
            /* 已经没了 */
          }
        };
        socket.on('error', done);
        socket.on('close', done);
        sock.on('error', (err) => {
          say(`转给盒里那台 dsh web 的升级失败：${err?.message ?? err}`);
          done();
        });
        sock.on('close', done);

        // 请求行 + 头（**逐字节**搬），`head` 是握手之前已经读出来的那一段。
        const lines = [`${req.method} ${path} HTTP/1.1`];
        for (const [name, value] of Object.entries(headers)) {
          if (value === undefined) continue;
          for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`);
        }
        sock.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head && head.length > 0) sock.write(head);
        // ★ **双向管道**：握手之后两头都是裸字节
        socket.pipe(sock);
        sock.pipe(socket);
      })
      .catch((err) => {
        // **握手阶段**如实拒 + 人话（不是先 101 再关）
        if (err?.code === 'DEV_NO_MEMORY' || err?.lastCode === 'DEV_NO_MEMORY') {
          say(`盒里那一间现在腾不出地方（升级）：${err?.message ?? err} ⇒ 503（不硬起）`);
          rejectUpgradeSocket(socket, 503, 'Service Unavailable', DEV_NO_MEMORY_TEXT);
          return;
        }
        if (err?.code === 'DEV_COOLDOWN') {
          say(`盒里那一间刚没起来（升级）：${err?.message ?? err} ⇒ 503（冷却中，不重复起）`);
          rejectUpgradeSocket(socket, 503, 'Service Unavailable', DEV_FAIL_COOLDOWN_TEXT);
          return;
        }
        say(`盒里那台 dsh web 没起来（升级）：${err?.message ?? err}`);
        rejectUpgradeSocket(socket, 502, 'Service Unavailable', '那台界面现在没起来，等会儿再试。');
      });
    return undefined;
  }

  return {
    handle,
    handleUpgrade,
    /**
     * 🔴 **让开这一间**（B46）：聊天那条路在某一间起一轮之前问一句
     * "这一间你正开着吗"，开着就**走 `dropCurrent()` 那条路收掉那台**。
     * ⚠️ **只收正开着的这一间**；别的房间、宿主侧（没有这个中继）什么都不做。
     */
    yieldRoom,
    /**
     * 起（或复用）**某一间**那台（给判据/排障用）。
     * ⚠️ 不给 `id` 就用**现在选的那一间**；没选过 ⇒ 抛。
     */
    openRoom(id = null) {
      const r = id === null ? (currentId === null ? null : findRoom(currentId)) : findRoom(id);
      if (!r) throw new Error('没有这一间（或者还没选）');
      return ensure(r);
    },
    /** 现在有哪些房间（**每次现取**）。 */
    rooms() {
      return listRooms();
    },
    /**
     * 收掉盒里**别的** `--profile web`（**不是现在这一台**）—— 给排障/运维用。
     *
     * ⚠️ 与 `ensure()` 里那一步是**同一个函数**：`sweepOrphans` 关着（默认）⇒
     *    这里**一台都不动**（宿主上跑它 = 空操作，这是刻意的）。
     */
    sweepOrphanWebs,
    /** 现在什么状态（**不含任何秘密**；给横幅/排障用）。 */
    state() {
      return {
        running: Boolean(child),
        port: upstream?.port ?? null,
        ready: Boolean(upstream),
        // ★ 现在这一台开的是哪一间（排障第一眼要看的就是它）
        room: currentId,
        cwd: currentCwd,
        /** 现在这一台那个 pid（排障用；没有 ⇒ `null`）。 */
        pid: pidOf(child),
      };
    },
    /** 收干净（`server.close()` 之后兜底 —— 不许留孤儿）。 */
    shutdown() {
      closed = true;
      dropCurrent();
    },
  };
}
