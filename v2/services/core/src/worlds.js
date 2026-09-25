// **一人一份完整的世界**：把原来那一串单例，按 userId 各配一份。
//
// ── 它解决什么 ────────────────────────────────────────────
// `tenants.js` 只解决了"**数据**分开取"（`main.jsonl` 按人落不同的目录）。
// 但服务里那一串东西——时间线 / 通知限频账 / 回收站 / 账本 / 派发器 / agent 那个进程池键——
// **原来全是单例**。只有数据分开是**不够的**，实测有两种串号：
//
//   ① 🔴 **所有人撞同一个 agent**：派发器原来拿 `timeline.id` 当进程池的键，
//      而每个人的 timeline 都叫 `'main'` ⇒ `runtime.get('main')` 对谁都是同一个 agent
//      ⇒ **甲说的话进乙的窗口**（静默串号，两边日志都"正常"）。
//      见 `38-ISOLATION-SPLIT.md` §三①。⇒ 这一层用 **`u1/main`** 当键（`agentKeyFor`）。
//   ② 🔴 **DSH_HOME 是全局的**：`cfg.dshHome` 一份给所有人 ⇒ 会话记录互相看得见。
//      N21：DSH 的会话键是**绝对路径编码**的 ⇒ 换 home 就是换账号。⇒ 按人给。
//
// ── 三条不许破 ────────────────────────────────────────────
//   ① 🔴 **`owner` 那一位原地不动**：他的 `DSH_HOME`（`~/.dsh`）、工作目录、数据目录
//      都**保持今天的值**。会话键是绝对路径编码的 ⇒ 动它 = 他的助手失忆（N21）。
//   ② 🔴 **不许有"当前用户"全局**：身份只能靠参数传进来。
//   ③ **新用户是空白的**：目录不存在就是空的，**不许继承任何东西**。
//
// ⚠️ **这一层是同进程的过渡层，不是安全边界**（控制面原话）：
//    它证明的是"服务内部不串号"，**证明不了跨 uid 的边界**——
//    那要靠每租户一个 OS 用户 + 容器（`39-PERMISSIONS.md`）。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { Apps, APPS_REL, REFUSED_APP_IDS, REMOVED_DIRNAME } from './apps.js';
import { readReclaimedSeqs } from './reclaim.js';
import { AppWorkspaces, checkScope, scopeDirFor, safeScope, workspacesRoot } from './workspace.js';
import { AppsSocket, appsSocketPath } from './apps-socket.js';
import { appendAudit, auditLine, auditPath } from './audit.js';
import { makeDrawImage } from './image-use.js';
import {
  MainLeakWatch,
  MAIN_LEAK_WHAT,
  leakAuditDetail,
  leakNoticeText,
} from './main-leak.js';
import { Published, authorHashOf } from './published.js';
import { Dispatcher } from './dispatcher.js';
import { loadReviewPolicy } from './review.js';
import { createDshReviewAgent } from './review-agent.js';
import { USAGE_KINDS, UsageLedger } from './usage.js';
import { Ledger, LEDGER_TIMELINE_ID } from './ledger.js';
import { LedgerSocket, ledgerSocketPath } from './ledger-socket.js';
// ★ **P2-8 出网留痕**（主人 2026-09-25「② 先只做留痕」）：一个人一本，只记域名/时间/量。
import { EgressLog } from './egress-log.js';
// ★ **阶段 4：一对一交付的登记面**（99）：四条记录落在那条可见日志上（P-l），
//   一人一个对象（和他的世界同一条日志、同一套号）。
import { Delivery } from './delivery.js';
import { Notice, UNDO_RESTORE } from './notice.js';
import { SayService } from './say.js';
import { Tenants, OWNER_ID } from './tenants.js';
import { ScopeView, Timeline } from './timeline.js';
import { Trash } from './trash.js';
import { markCleanExit, recordStart } from './boot-marker.js';
import { reconcileOnBoot } from './reconcile.js';
// ★ P1（契约 `docs/dev/88-P1-TIME-WAIT.md`）：**逐件落盘**的活账 ＋ 承诺账。
//   一人一份（和通知那本账同一条理由：它是"这个人的事"）。
import { WorkLog } from './worklog.js';
import { PromiseBook } from './time-words.js';
// ★ **D 期**（契约 `docs/dev/100-DISPATCHER-D.md`）：转交（N16）、焦点告知（D-9）、
//   未读（D-6）。三本账都**一个人一份**（和上面那几本同一条理由）。
import { HandoffBook } from './handoff.js';
import { FocusBook } from './focus-book.js';
import { UnreadBook } from './unread.js';
// ★ **派活那本简登记**（契约 `docs/dev/102-APP-BIRTH-SCOPE.md`）：一个人一本，
//   落 `<dir>/jobs.jsonl`；它是**索引**（谁·什么·在哪·最后一条总结），
//   删掉它能从**那一条日志**重扫回来（`JobBook.rebuild`）。
import { JobBook } from './job.js';

/**
 * **主线那个房间的名字**（不属于任何 app 的对话 —— 契约 `83-APP-WORKSPACE.md` §三·2）。
 *
 * ⚠️ 它**永远是 `'main'`**：盘上已有的事件里 `scopeId` 写的就是它，
 *    动它等于动历史字节（协议字段一旦上线就冻结）。
 */
export const MAIN_SCOPE = 'main';

/**
 * **桌面上的内置磁贴**（设置 / 发现 /「我自己那台」）。
 *
 * 🔴 这几个字符串与客户端 `v2/apps/mobile/lib/models/app_spec.dart` 的
 *    `builtInSettingsId` / `builtInDiscoverId` / `builtInHarnessId`
 *    **逐字一致**（一个字对不上 = 客户端拿着一个服务端不认识的 scope 去连 ⇒ 404）。
 *
 * ★ 主人 2026-09-25 定的（`docs/dev/77-BLOCKERS.md` 的 **B16**）：
 *   原来按"内置磁贴是界面、不是他做的 app ⇒ 不单独分房间"办，主人回的是
 *   **「要分家」** ⇒ **桌面上的每个图标都要有自己的房间**。
 *   ⇒ 这三家和 `/api/apps` 里那些小程序**同一套不变量**：
 *     自己一条 timeline、自己的 `agentKey`、自己的 cwd `<dir>/workspaces/<id>/`；
 *   ⇒ **但不许被 app 占用**（与 `main` 同一条规矩：它们已经是别人的房间了）。
 */
export const BUILTIN_SCOPES = Object.freeze(['settings', 'discover', 'harness']);

/** 这是不是桌面上的内置那一格（**认不出 ⇒ `false`**，不许猜）。 */
export function isBuiltinScope(raw) {
  const s = safeScope(raw);
  return s !== null && BUILTIN_SCOPES.includes(s);
}

/**
 * **app 不许占用的那些 id**：`main`（主线那个房间）＋ 内置那三个。
 *
 * ⚠️ 与 `main` 的唯一区别：内置那几个**本身是合法房间**（桌面上就有那个图标），
 *    而 `main` 不是"另一个房间"，它就是主线本身。
 * 🔴 **名单的唯一出处是 `apps.js` 的 `REFUSED_APP_IDS`**（那边是闸的落点）——
 *    这里不再抄一份，抄了就会漂。下面 `BUILTIN_SCOPES` 只描述"哪些是房间"。
 */
export const RESERVED_APP_SCOPES = REFUSED_APP_IDS;

// ⚠️ **闸不在这里**（2026-09-26 收口）：保留 id 那道闸只有一份 ——
//    `apps.refuseReservedAppId`，叫它的地方是**两个写入漏斗**：
//    ① 制品库那一侧 `apps.create`（老路 / 装上 / 迁移最后都汇到这里）；
//    ② 工作区那一侧 `AppWorkspaces.ensure/write`（它建在写制品**之前**，
//       不在那儿叫一次，一个保留 id 会先在盘上留一个空工作区）。
//    ⇒ 原来这里那个只为"当 app"而生的 `UserWorkspaces` 子类**删掉了**：
//      闸搬进 `AppWorkspaces` 本身 ⇒ 谁 new 都是同一份逻辑，不会再漏一条路。
// ⚠️ 内置那三个**本身是合法房间**：它们的目录走下面 `roomFor` 的 `mkdir ＋ hand`，
//    **不走 `ensure`** —— 所以"ensure 拒内置 id"拒的是"当 app"，不是"当房间"。

/**
 * agent 那个**进程池的键**：`<userId>/<scope>`（主线是 `<userId>/main`）。
 *
 * ⚠️ 它**不是** `scopeId`：`scopeId` 是写到事件里的字段（盘上已有的是 `'main'`），
 *    动它等于动历史字节。见 `dispatcher.js` 里 `#agentKey` 的说明。
 *
 * 🔴 **scope 是键的一部分**（2026-09-25，契约 §三·3）：一个 icon 一个 cwd
 *    ⇒ 一个 scope 一个 agent 会话。少了 scope，同一个人的两个 app
 *    会挤进**同一个** agent 窗口 ⇒ 两个房间的话糊在一起
 *    （和"甲说的话进乙的窗口"是同一个形状，只是这次发生在**同一个人**身上）。
 */
export function agentKeyFor(userId, scope = MAIN_SCOPE) {
  return `${userId}/${scope}`;
}

/**
 * 一个 scope 的**对话日志**叫什么（`<dir>/<这个名字>.jsonl`）。
 *
 * 🔴 **2026-09-25 收回**（契约 `docs/dev/84-DISPATCHER-FOCUS.md` §六 · 判据 F1）：
 *    改前这里给每个 scope 一个不同的名字（`scope-<id>`）⇒ **每 scope 一份日志**。
 *    手册 `05-DECISIONS.md` **P-l** 定的是「**一条可见时间线 = 一条日志**；
 *    多作用域只是事件上的标签，不是并列的计数器」。
 *    ⇒ 现在**所有 scope 都是那一条日志**（`main.jsonl`），
 *      "这一间是谁"住在事件上的 `scopeId` 标签里（`ScopeView` 负责盖与挑）。
 *
 * ⚠️ 这个函数留着是因为"日志叫什么"只有一处出处；它**不再**随 scope 变。
 * @returns {string} 永远是 `main`（那条日志）
 */
export function scopeTimelineId(_scope = MAIN_SCOPE) {
  return 'main';
}

/**
 * ★ **`103` §七（D3.11）：这条日志的"号的地板"** —— 回收留痕里最大的那个号。
 *
 * 🔴 为什么需要它：某一间被回收时，它的行**可能正好是尾巴** ⇒ 重写之后盘上最大号
 *    变小。重启时 `Timeline` 只看盘上最后一条 ⇒ 会把**已经拿走的号再发一遍**
 *    （而"复用号 = 客户端游标错位"正是架构 §5.1·补点名要避免的）。
 * ⇒ 建那条日志时把留痕里的最大号当**取号下限**。
 *
 * ⚠️ 读不到留痕（没有 / 坏了）⇒ `0` ⇒ 逐字是回收之前的行为。
 * @param {string} dir 这个人世界的根
 * @returns {number}
 */
function reclaimSeqFloor(dir) {
  try {
    const seqs = readReclaimedSeqs({ removedRoot: nodePath.join(dir, APPS_REL, REMOVED_DIRNAME) });
    return seqs.length > 0 ? seqs[seqs.length - 1] : 0;
  } catch {
    return 0; // 留痕读不动不许把建世界带走（那时校验器会如实红）
  }
}

/**
 * 从 query / URLSearchParams 里解出 scope（**连接级的**，照 `level` 那个先例）。
 *
 * ⚠️ **认不出来 / 不给 ⇒ 主线**（`'main'`）—— 老客户端一个字节都不用改。
 *    这条和 `parseLevel` 同一条纪律：协议**只加可选字段**，缺了就是老行为。
 */
export function parseScope(params) {
  let raw = null;
  if (typeof params === 'string') {
    try {
      raw = new URLSearchParams(params).get('scope');
    } catch {
      raw = null;
    }
  } else if (params && typeof params.get === 'function') {
    raw = params.get('scope');
  }
  if (typeof raw !== 'string') return MAIN_SCOPE;
  const s = raw.trim();
  return s === '' ? MAIN_SCOPE : s;
}

/**
 * ★ **一个 scope 的"人话名字"**（P1：完成提醒里"去哪看"那半句用它）。
 *
 * 🔴 **只有一个出处**：那一版制品里的 `manifest.json` 的 `title`
 *    （`apps.list()` 也是从那儿取的）。**不许**另抄一份名字表。
 * ⚠️ **`apps.current(id)` 给的是版本号**（见 `apps.js`）——
 *    写成 `current(id)?.title` 会**恒 `undefined`**（这就是修前那一行）。
 * ⚠️ **认不出 / 取不到 / 这一格坏了 ⇒ `null`**（调用方据此**不带**那半句）；
 *    **绝不**把内部 id 当名字返回（`06` 禁用词那条）。
 *
 * @param {{current:(id:string)=>number|null, manifest:(id:string,v:number)=>object|null}} apps
 * @param {string} id
 * @returns {string|null}
 */
export function titleOfApp(apps, id) {
  try {
    const v = apps?.current?.(id);
    if (!Number.isInteger(v) || v < 1) return null;
    const t = apps?.manifest?.(id, v)?.title;
    return typeof t === 'string' && t.trim() !== '' ? t : null;
  } catch {
    return null; // 坏一版制品不许把"开房间"这条主流程带走
  }
}

/** 每个人的世界长什么样（给文档与测试一个准确的形状）。 */
export const WORLD_SHAPE = Object.freeze([
  'userId', 'dir', 'cfg', 'agentKey', 'scopeId',
  'store', 'timeline', 'notice', 'say', 'trash', 'ledger', 'ledgerSocket', 'apps', 'workspaces', 'appsSocket', 'published', 'delivery', 'dispatcher', 'boot',
]);

export class Worlds {
  #cfg;
  #runtime;
  #tenants;
  #log;
  #warn;
  /** 这台部署开不开回收站。**关掉时 `world.trash` 是 `null`**（路由一律 404）。 */
  #wantTrash;
  /** 见构造参数 `onAuthFailure`（上游说"钥匙不对"时叫一声）。 */
  #onAuthFailure = null;
  /** userId → 世界 */
  #worlds = new Map();
  /**
   * `userId\u0000scope` → **房间**（一个 scope = 一个 cwd = 一条会话 · 契约 §三·3）。
   *
   * ⚠️ 房间**不是**"另一个人的世界"：它和主人那份世界共用 `dir` / `DSH_HOME` /
   *    制品库 / 本地通道，**只有两样不同** —— 工作目录、agent 进程池的键。
   *    ⚠️ **时间线不再不同**（契约 84 §三·2）：所有房间共用那**一条日志**，
   *      "是哪一间"住在事件上的 `scopeId` 标签里（`room.timeline` 是那层视图）。
   */
  #rooms = new Map();
  /**
   * `userId\u0000scope` → `ScopeView`（同一把 `Timeline` 上"这一间"的视图）。
   *
   * ⚠️ 视图**不是日志**：一条日志一把 `Timeline`，视图只是"盖标签 / 挑标签"。
   *    缓存它是为了让"同一间"每次拿到**同一个对象**（`roomFor` 幂等）。
   */
  #views = new Map();
  /** agentKey → 世界 / 房间（`onEvict` 与 `cfgForAgentKey` 回来时要知道该找谁） */
  #byAgentKey = new Map();
  #now;
  #makeTrash;
  /** 共享的小程序库（乙-3）。**一个部署一份**（不是按人一份）。 */
  #published;
  /**
   * ★ **预审规则**（96 第 3b 条）：产品层那份（只读挂载＋指纹），
   * **一个部署一份**。`undefined` = 还没读过；`null` = 读过但读不到（fail-closed）。
   */
  #reviewPolicyCache;

  /**
   * 把产品层那份预审规则读出来（**缓存一次**）。
   *
   * 🔴 读不到就返回 `null` ⇒ 上架时的预审 **escalate**（不自动放行）。
   *    ⚠️ 这**不是**"跳过预审"：跳过等于让"自己审自己"成立（96 第 3b 条）。
   */
  #reviewPolicy() {
    if (this.#reviewPolicyCache !== undefined) return this.#reviewPolicyCache;
    try {
      this.#reviewPolicyCache = loadReviewPolicy({ codeRoot: this.#cfg.codeRoot });
    } catch (err) {
      this.#warn(`  ⚠️ 预审规则读不出来（${err?.message ?? err}）⇒ 上架前的预审一律不自动放行`);
      this.#reviewPolicyCache = null;
    }
    return this.#reviewPolicyCache;
  }

  /**
   * @param {object} o
   * @param {object} o.cfg                 全局配置（每人的那份是在它基础上改几处派生的）
   * @param {object} o.runtime             `AgentRuntime`（**共用一个进程池**，键按人不同）
   * @param {Tenants} [o.tenants]          数据取用层
   * @param {(m:string)=>void} [o.log]     正常日志
   * @param {(m:string)=>void} [o.warn]    警告日志
   * @param {boolean} [o.trash]            开不开回收站（默认开）
   * @param {number} [o.now]
   */
  constructor({
    cfg,
    runtime,
    tenants = null,
    log = () => {},
    warn = (m) => console.warn(m),
    trash = true,
    now = Date.now,
    /** 见 `Dispatcher` 的同名参数：上游说"钥匙不对"时叫一声。 */
    onAuthFailure = null,
  }) {
    if (!cfg) throw new Error('Worlds 需要 cfg');
    if (!runtime) throw new Error('Worlds 需要 runtime（agent 那个进程池）');
    this.#cfg = cfg;
    this.#runtime = runtime;
    this.#tenants = tenants ?? new Tenants({ dataDir: cfg.dataDir });
    this.#log = log;
    this.#warn = warn;
    this.#wantTrash = trash;
    // ★ 共享的小程序库（乙-3）：**一个部署一份**（所有人共享那一个目录）
    this.#published = new Published({ dir: this.#cfg.dataDir });
    this.#now = now;
    // ⚠️ **这一行原来漏了**（2026-09-21）：参数加了、往下传的那一行也加了，
    //    就是**没存下来** ⇒ `#onAuthFailure` 永远是 `null` ⇒ 整条链子静默断掉。
    //    而两条单测都是**直接打 `Dispatcher`** 的 ⇒ **全绿**。
    //    ⇒ 教训：接线的每一段都要有一条闸**从外面**打进来（见下面那条 Worlds 级的用例）。
    this.#onAuthFailure = onAuthFailure;
    this.#makeTrash = (o) => new Trash(o);
  }

  get tenants() {
    return this.#tenants;
  }

  /** 已经取过几个人（**不是"在线人数"**）。 */
  get size() {
    return this.#worlds.size;
  }

  /** 已经建过几个房间（**主线不算**）。 */
  get roomCount() {
    return this.#rooms.size;
  }

  ids() {
    return [...this.#worlds.keys()];
  }

  /** 已建的那些世界（给聚合状态用）。⚠️ **只有主线**，不含房间（`allRooms()` 才是全部）。 */
  all() {
    return [...this.#worlds.values()];
  }

  /** 主线 ＋ 所有房间（聚合状态 / 收工用）。 */
  allRooms() {
    return [...this.#worlds.values(), ...this.#rooms.values()];
  }

  /**
   * ★ **从外面记一笔用量**（语音那一路在 `serve.js` 里收尾时叫它）。
   *
   * ⚠️ **世界没热过 ⇒ 不为了记账去 provision 一个人**（那会有副作用）；
   *    如实回 `{ok:false}`（调用方日志里看得到）。
   * ⚠️ 只记量；不抛（`UsageLedger.note` 自己吞）。
   */
  noteUsage(userId, scopeId, patch = {}) {
    const w = this.#worlds.get(userId);
    if (!w?.usage) return { ok: false, error: '这一位还没热过，账先没记' };
    return w.usage.note(scopeId, patch);
  }

  /**
   * 这个人的数据在哪 / 他的 `DSH_HOME` 和工作目录在哪。
   *
   * 🔴 `owner` 走**今天的原值**（`cfg` 里那三个）—— 他的会话键是绝对路径编码的，
   *    换掉就等于让他失忆（N21）。**不搬**。
   * 别人走**他自己那一格下面**：`<dir>/dsh`（DSH_HOME）与 `<dir>/main`（工作目录）。
   * ⚠️ 工作目录与 `main.jsonl` 是**平行**的（不是它的子目录）——
   *    照手册 §2.1 那条：主目录与 `workspaces/` 必须平行，算错一个相对路径就出事。
   *
   * ★ **按 scope 取**（契约 `83-APP-WORKSPACE.md` §三·1）：主线照旧（上面那些值
   *   **逐字不变**）；某个 app ⇒ 工作目录换成 `<dir>/workspaces/<scope>`
   *   （`DSH_HOME` / 数据目录 / 那两条本地通道**还是这个人那一份**——
   *   硬规则第 3 条是"每人一份 `DSH_HOME`"，不是"每个房间一份"）。
   */
  pathsFor(userId, scope = MAIN_SCOPE) {
    const main = this.#mainPathsFor(userId);
    const s = scope === null || scope === undefined || scope === '' ? MAIN_SCOPE : String(scope);
    if (s === MAIN_SCOPE) return main;
    // ⚠️ 名字进路径之前必须校验（`..` / `/` 那类会跑出根外）
    const id = checkScope(s);
    return { ...main, agentCwd: scopeDirFor(main.dir, id) };
  }

  /** 主线那一份路径（**加 scope 之前的样子，一个字都没动**）。 */
  #mainPathsFor(userId) {
    const dir = this.#tenants.dirFor(userId);
    if (userId === OWNER_ID) {
      return {
        dir,
        dshHome: this.#cfg.dshHome,
        agentCwd: this.#cfg.agentCwd,
        ledgerSocketPath: this.#cfg.ledgerSocketPath,
        // ⚠️ 缺了就从他那一格派生：cfg 有可能是别人手搭的（测试就是），
        //    而"这条口没配"的表现是**整台服务起不来** —— 不值得为它冒那个险。
        appsSocketPath: this.#cfg.appsSocketPath ?? appsSocketPath(dir),
        own: false,
      };
    }
    return {
      dir,
      dshHome: nodePath.join(dir, 'dsh'),
      agentCwd: nodePath.join(dir, 'main'),
      ledgerSocketPath: ledgerSocketPath(dir),
      appsSocketPath: appsSocketPath(dir),
      own: true,
    };
  }

  /**
   * **发现"文件落错地方"了 ⇒ 两件事一起做**（A1·「发现就报」）。
   *
   *   ① 记一行账（审计日志）—— 谁、哪个 app、多出来哪些路径（**最多列前几个**）；
   *   ② 用**现成**那条"讲给他听"的通道说一句（`Notice`：落盘、取号、他看得见）。
   *
   * ⚠️ 两件都是**旁路**：哪一件没做成都要**说出来**（`#warn`），
   *    但**不许把那一轮的收口带走**（它正在 `turn-end` / `force-close` 里）。
   * ⚠️ 它不是"拦下来"：拦不住（见 `main-leak.js` 顶上那段）。
   *    这一条的全部意义是**绝不许它静默发生** —— 所以两件都要做，缺一不算报。
   */
  #tellMainLeak(t, notice, report) {
    // ① 账：与主人那笔账**同一个文件、同一个写入口**（`auditPath(cfg.dataDir)` ——
    //    `serve.js` 给 `server.js` 的也是它 ⇒ "谁干了什么"只有一处能读全）
    appendAudit({
      file: auditPath(this.#cfg.dataDir),
      line: auditLine({
        what: MAIN_LEAK_WHAT,
        userId: t.userId,
        detail: leakAuditDetail(report),
      }),
      fs: nodeFs,
      onError: (m) => this.#warn(m),
    });
    // ② 讲给他听：**现成**那条通道。`kind` 用既有的 `failed`
    //    （"加一个新 kind"要客户端一起动，而这一条不许新造一套）。
    try {
      notice?.notice({ kind: 'failed', text: leakNoticeText(report) });
    } catch (err) {
      this.#warn(`  ⚠️ ${t.userId} 的"文件落错地方"没说出来：${err?.message ?? err}`);
    }
  }

  /**
   * **进程池要起一个 agent 时，按它的键取那一份 `cfg`。**
   *
   * 🔴 这就是"DSH_HOME 按人不同"的落点：`AgentRuntime` 在 spawn 之前问这一句。
   * ⚠️ 三个人共用一份 `cfg` ⇒ 共用一个 `DSH_HOME` ⇒ 会话记录互相看得见（N21）。
   * ⚠️ 查不到就退回全局 cfg：那种情况只可能是"还没建世界就有人要 agent"，
   *    而那时本来就**没有任何人**该起 agent（世界是派发器建出来的）。
   *
   * ★ 房间**也有自己那份 `cfg`**：`agentCwd` 是那个工作区 —— 少了这一句，
   *   同一个人的两个 app 会在**同一个 cwd** 里干活（文件就躺回主目录）。
   */
  cfgForAgentKey(agentKey) {
    const owner = this.#byAgentKey.get(agentKey);
    return owner ? owner.cfg : this.#cfg;
  }

  /**
   * **取**这个人的世界。第一次取的时候把它该做的事情做完（对账 / 崩溃环 / 回收站）。
   *
   * ⚠️ **惰性**是有意的：一个新用户第一次进来时才建他那一格，
   *    而不是开机就给所有人建目录（`tenants.get` 里那条"新用户是空白的"）。
   */
  worldFor(userId) {
    const had = this.#worlds.get(userId);
    if (had) return had;

    // ⚠️ `tenants.get` 会校验 userId 能不能当目录名（防穿越），越界的话在这里就抛
    const t = this.#tenants.get(userId);
    const paths = this.pathsFor(t.userId);

    // 别人那几格：**建出来**（0700）。`owner` 的原样，一个都不建。
    if (paths.own) {
      for (const d of [paths.dshHome, paths.agentCwd]) {
        try {
          nodeFs.mkdirSync(d, { recursive: true, mode: 0o700 });
        } catch (err) {
          throw new Error(`建 ${d} 失败：${err?.message ?? err}`);
        }
      }
    }

    // ★ **一条可见时间线 = 一条日志**（P-l · 契约 84 §三·2）：
    //   这是**这个用户唯一那条** `Timeline`（`main.jsonl`、一套号）。
    //   每个房间拿到的不是新 `Timeline`，而是**它自己那层 `ScopeView`**。
    //
    // ★ **`103` §七（D3.11）：号的"地板"** —— 被回收拿走的号**不许复用**。
    //   某一间的行可能就是**尾巴** ⇒ 回收重写完，盘上最大号会变小；只看盘上
    //   最后一条的话，重启会把已经进了留痕的号**再发一遍**（游标错位的那个病）。
    //   ⇒ 把留痕里的最大号当取号下限（回收自己也会拿这份留痕做自检）。
    const reclaimedFloor = reclaimSeqFloor(t.dir);
    const timeline = new Timeline({
      id: 'main',
      store: t.store,
      seqFloor: reclaimedFloor,
      onSubscriberError: (err, event) => {
        this.#warn(`[timeline] 订阅者出错（${event.type}）：${err?.message ?? err}`);
      },
    });
    // 主线那层视图：**不盖标签**（盘上老事件没有 `scopeId`，主线逐字不变），
    // 读的时候只挑"没有标签 / 标 main"的那些（房间的话不许漏进主线 · A4）。
    const mainView = new ScopeView({ timeline, scope: MAIN_SCOPE });
    const notice = new Notice({
      timeline: mainView,
      store: t.store,
      timelineId: 'main',
      log: (m) => this.#warn(m),
    });
    const say = new SayService({ timeline: mainView, store: t.store, timelineId: 'main' });
    const trash = this.#wantTrash
      ? this.#makeTrash({ timeline: mainView, store: t.store, timelineId: 'main' }).sync()
      : null;

    // 账本**另起一条日志**（`<dir>/ledger.jsonl`），所以它有自己的 Timeline
    const ledgerTimeline = new Timeline({ id: LEDGER_TIMELINE_ID, store: t.store });
    const ledger = new Ledger({ store: t.store, timeline: ledgerTimeline }).sync();

    // ★ **阶段 4：一对一交付的登记面**（`docs/dev/99-STAGE4-DELIVERY.md`）。
    //   🔴 它**不另起日志**：四条记录落在**上面那条可见日志**上（P-l：同一条日志、
    //      同一套号，多作用域只是事件上的 `scopeId` 标签）——
    //      所以注入的是 `mainView`，房间那一间由 `viewFor` 现取。
    //   🔴 它**只登记、不搬运**：这一版没有任何一条路把数据包的字节带出去。
    const delivery = new Delivery({
      timeline: mainView,
      viewFor: (scope) => this.#viewFor(t.userId, scope),
    });

    // ★ **小程序制品库**（乙-1 · 契约 `docs/dev/59-USER-APPS.md`）：**按人一份**，
    //   落在**他自己那一格**下面（`<dir>/hupo/apps/`）—— 这就是"只有他自己可见"的落点。
    //   ⚠️ 它**不认识令牌**；它是"谁的世界"由这里定，路由那边按 `claim.sub` 取。
    //
    // ★ **`103` §七：真回收的上下文**（决策 D3.11 · **一处实现** `src/reclaim.js`）：
    //   `Apps.remove()` 除了软删制品那一格，还要把**那一间的工作区 / 那一间的对话 /
    //   助手那边的会话记录**一起搬进同一个回收处，并写 `reclaimed.json`（号洞留痕）。
    //   🔴 宿主那条路与盒里那条路**都走这里**（两条路都只调 `remove()`，见 `server.js`）
    //      —— 不许两处各抄一遍。
    //   ⚠️ 传**函数**（用到时才取）：`workspaces` / `unread` / `work` 在下面才建，
    //      而 `remove()` 一定发生在 `worldFor()` 返回**之后** ⇒ 读得到。
    const apps = new Apps({
      dir: t.dir,
      sub: t.userId,
      reclaim: () => ({
        dir: t.dir,
        dshHome: paths.dshHome,
        store: t.store,
        timelineId: 'main',
        cwdFor: (scope) => workspaces.dirFor(scope),
        workspaces,
        unread,
        work,
        sub: t.userId,
        log: (m) => this.#warn(m),
      }),
    });
    // ★ **子工作区**（契约 `83-APP-WORKSPACE.md` §三·1）：**按人一份**，
    //   落在 `<dir>/workspaces/`（**与主目录平行** —— 手册 §2.2 第二条）。
    //   ⚠️ 这里是"服务端那一刀"的落点：造 app 时**服务端**建目录，不靠模型记得。
    //   ⚠️ 保留 id 那道闸**不在这层**（`UserWorkspaces` 已删）：它住 `apps.js`，
    //      由 `AppWorkspaces.ensure/write` 与 `apps.create` 两个写入漏斗共用一个函数
    //      （见上面 `RESERVED_APP_SCOPES` 那段说明）。
    const workspaces = new AppWorkspaces({ dir: t.dir, log: (m) => this.#warn(m) });
    // ★ **用量账（93 §五）**：**按 app（scopeId）记 token**，含它触发的子任务；
    //   落 `<dir>/hupo/apps/<id>/usage.jsonl`（**贴现有布局，不新造第二套**）。
    //   ⚠️ 它只记量（token 三格／次数／张数／秒数），**不记任何访问日志**。
    const usage = new UsageLedger({ apps, log: (m) => this.#warn(`  ${m}`) });
    // ★ **P2-8：出网留痕**（主人 2026-09-25）—— 盒里那个 agent **能往任意地址发请求**
    //   （93 §2.1 O3 · 账 #65），而手册读起来像"出不去"。主人拍的是**先不改网络**、
    //   只留痕：记「它往哪发」（**域名 / 时间 / 量**）**可查**。
    //   🔴 **不记正文**（不落 URL 的路径与查询串、不落标题/摘要/查询词）；
    //   🔴 落 `<dir>/hupo/egress.jsonl`（与制品库同级，**不进工作区、不进制品**）。
    const egress = new EgressLog({ dir: t.dir, sub: t.userId, log: (m) => this.#warn(m) });

    // ★ **真的预审 agent**（96 第 1／3／4 条）：把源码与申报喂给盒里那台 DSH，
    //   按产品层规则出总结／风险／评级。
    //   🔴 以前这里是 `this.#cfg.reviewAgent ?? null` ⇒ **一律 escalate**（审核等于没跑）；
    //      现在**默认接真实现**（要换成假的，注入 `cfg.reviewAgent` 即可）。
    //   🔴 `guardDir` = **这个 app 的工作区**：评审只许看不许写，跑完逐文件核 sha。
    //   🔴 `usage` = **预审吃的是用户自己的算力**（96 第 3 条）⇒ 记到这个 app 头上。
    const reviewCfg = { ...this.#cfg, dshHome: paths.dshHome };
    const reviewAgent = typeof this.#cfg.reviewAgent === 'function'
      ? this.#cfg.reviewAgent
      : createDshReviewAgent({
        cfg: reviewCfg,
        usage,
        who: 'pre',
        guardDir: (id) => scopeDirFor(t.dir, id),
        log: (m) => this.#warn(`  ${m}`),
      });
    // ★ **运营方那一侧的复评**（96 第 1 条 · **宿主侧**）：独立再读一遍整份源码。
    //   ⚠️ `HUPO_ROLE=tenant` 的盒里**没有它** —— 盒里跑的是**用户自己**的 agent
    //      （那一次是预审，第 3 条）；运营方的 agent 在宿主那一侧。
    //   ⚠️ 它的算力**不记到用户头上**（那是平台的账）⇒ `usage:null`。
    const operatorAgent = typeof this.#cfg.operatorReviewAgent === 'function'
      ? this.#cfg.operatorReviewAgent
      : (this.#cfg.operatorReview === true
        ? createDshReviewAgent({
          cfg: reviewCfg,
          usage: null,
          who: 'operator',
          log: (m) => this.#warn(`  ${m}`),
        })
        : null);
    // ⚠️ **调度器建在这下面**（它要 timeline 那几样），而"造东西那条闸"（P1-22）
    //   要看**这一轮他说了什么** —— 那句话住在调度器里。
    //   ⇒ 先空着，等它建好再指过来（`ctx.turnInput` 是个**取值函数**，调的时候才读）。
    let dispatcher = null;

    // ★ **模型那几条工具走的通道**（乙-2）：写入只有上面那一个 `Apps` 实例能做，
    //   工具进程只把请求递过来（照账本那条的规矩：**工具进程不写盘**）。
    const appsSocket = new AppsSocket({
      apps,
      socketPath: paths.appsSocketPath,
      log: (m) => this.#warn(m),
      // ★ 发布/下架/装上要看共享库，还要知道"这是谁"（**身份只从这儿来**）
      ctx: {
        published: this.#published,
        sub: t.userId,
        // ★ **服务端那一刀住在这里**（契约 §三·4）：`app_create` 由**服务端**
        //   建工作区、把产物落进去、再从工作区拷一份进制品库。
        //   模型只要把内容交给工具，**一个字都不用记得**。
        workspace: workspaces,
        // ★ **这一轮真造了一个 app**（A1·「发现就报」）：工具那边成功之后叫一声，
        //   调度器把它记在**这一轮**的账上（收口时拿它判"要不要比主目录"）。
        //   ⚠️ 只有"真写下去了"才算 —— 请求里说什么不作数（与 `turnInput` 同一条纪律）。
        onAppBuilt: (info) => {
          try {
            dispatcher?.noteAppBuilt(info);
          } catch (err) {
            this.#warn(`  ⚠️ ${t.userId} 的"造了一个"没记上：${err?.message ?? err}`);
          }
        },
        // ⚠️ 对外显示的名字**按哈希生成**：手机号那种东西**绝不进共享库**
        authorName: `用户 ${authorHashOf(t.userId).slice(0, 4)}`,
        // ★ **他明说才许写**（P1-22）：造东西那条闸要"当轮他自己说的那句话"。
        //   取的是**服务端记的**那一份（`dispatcher.turnInput`）；
        //   还没建好（`null`）⇒ 当作"没有明说"（那正是**开机那几秒**该有的保守行为）。
        turnInput: () => dispatcher?.turnInput ?? null,
        // ★ **按房间取"他这一轮说了什么"**（2026-09-26，契约 102 落地时发现的真缺陷）：
        //   上面那一句答的**只有主线**那一间 ⇒ 他在**某个小程序房间里**说
        //   "帮我做一个…"时，那条闸读到的是主线那份（多半是空的）⇒ **误拒**。
        //   工具那侧把 `HUPO_APPS_SCOPE`（= 它这一轮在哪一间跑）原样带回来，
        //   这里按那个 scope 问调度器要**那一间**的当轮输入。
        //   ⚠️ 认不出 / 取不到 ⇒ `null`（**fail-closed**：宁可拒，不许放过去写盘）。
        turnInputFor: (scope) => {
          try {
            return dispatcher?.turnInputOf?.(scope) ?? null;
          } catch {
            return null;
          }
        },
        // ★ **画一张图**（P1-27 后半）：工具只递请求，真正去花他那把钥匙的是这里。
        //   ⚠️ 与 `/api/image`（配置页那个「试一张」）**同一套规则**（`image-use.js`）。
        drawImage: makeDrawImage({ dataDir: t.dir, log: (m) => this.#warn(`  ${m}`) }),
        // ★ **用量账**（93 §五）：`ask`（server.js）与画图（apps-socket.js）都记到它上面。
        usage,
        // ★ **上架第一步的预审**（96 第 3b／4 条）：规则是**产品层**那份（只读挂载＋指纹），
        //   读不到 / 指纹对不上 ⇒ `null` ⇒ 预审 **fail-closed**（不自动放行）。
        //   ★ `reviewAgent` 现在**默认是真实现**（`createDshReviewAgent`：盒里那台 DSH
        //     读整份源码）；没接上 / 起不来 ⇒ `unavailable` ⇒ **escalate**（不许自动放行）。
        //   ★ `operatorAgent` = **宿主侧**的运营方复评（盒里是 `null`）。
        reviewPolicy: this.#reviewPolicy(),
        reviewAgent,
        operatorAgent,
        // ★ 装上了 ⇒ 往**他自己**的流里推一条（客户端收到就重拉清单，桌面自己长出来）
        onInstalled: (info) => {
          try {
            timeline.emitTransient({ type: 'app/installed', appId: info.id, title: info.title });
          } catch (err) {
            this.#warn(`  ⚠️ ${t.userId} 的"装上了"没喊出去：${err?.message ?? err}`);
          }
        },
      },
    }).listen();

    const cfg = {
      ...this.#cfg,
      dshHome: paths.dshHome,
      agentCwd: paths.agentCwd,
      ledgerSocketPath: paths.ledgerSocketPath,
      appsSocketPath: paths.appsSocketPath,
      appsServerPath: this.#cfg.appsServerPath,
      imageServerPath: this.#cfg.imageServerPath,
    };

    // ★ **A1·「发现就报」**（契约 `83-APP-WORKSPACE.md` §四 · 主人 2026-09-25）：
    //   造 app 的那一轮里，模型若**另外**用通用写文件 / 执行命令写相对路径，
    //   那些会落**主目录**（`<dir>/main`）—— DSH 的 cwd 启动时定死，一轮中途换不了，
    //   服务端**拦不住**。⇒ 拦不住就**不许装看不见**：这一轮前后比一次主目录，
    //   多出东西就 ① 记一行账 ② 用现成那条通道讲给他听（`Notice`）。
    //   ⚠️ **只有主线那个调度器**拿得到它（房间的 cwd 就是它自己的工作区）。
    // ★ P1（契约 `docs/dev/88-P1-TIME-WAIT.md` §一.1 / §四 T2）：
    //   **逐件落盘的活账**（`pending.jsonl`）＋ **承诺账**（`promises.jsonl`）。
    //   🔴 开机第一件事：上一次**还开着的**活，逐件诚实收成"已停"——
    //     硬杀之后逐件答得出"还在/已停/做完了"，而**不是查无此件**。
    //     ⚠️ 开机时**没有任何 agent 活着**（`aliveGenerations: []`）⇒ 全收；
    //        一次开机只做一次，之后新开的活归这一代。
    const work = new WorkLog({ store: t.store, log: (m) => this.#warn(m) });
    const promises = new PromiseBook({ store: t.store });
    // ★ **D 期三本账**（一个人各一份）：
    //   · `handoffs` —— 转交（落盘：D-7"回收前必须在盘上"要它）；
    //   · `focus`    —— 按设备记的焦点（判据 D-9）；
    //   · `unread`   —— 他看到过哪一号（判据 D-6；事实在那条日志上）。
    const handoffs = new HandoffBook({ dir: t.dir, log: (m) => this.#warn(m) });
    const focusBook = new FocusBook({ dir: t.dir, log: (m) => this.#warn(m) });
    const unread = new UnreadBook({ dir: t.dir, store: t.store, timelineId: 'main', log: (m) => this.#warn(m) });
    // ★ **派活那本简登记**（契约 102）：一个人一本，落 `<dir>/jobs.jsonl`。
    //   🔴 它是**索引**，不是第二份日志（契约 §一 ④）：
    //      · "有哪些小程序／工作区"的唯一出处是**盘上那两处**（这里只取，不另存）；
    //      · "各自最后一条总结"住在**那一条日志**的 `job/report` 帧上
    //        ⇒ 登记文件不在时，构造就从日志重扫（P5）。
    const jobs = new JobBook({
      dir: t.dir,
      store: t.store,
      log: (m) => this.#warn(m),
      listScopes: () => ({ apps: apps.list(), workspaces: workspaces.list() }),
    });
    let settled = [];
    try {
      settled = work.settleDead({ aliveGenerations: [] });
    } catch (err) {
      this.#warn(`  ⚠️ ${t.userId} 上一次那几件没收住：${err?.message ?? err}`);
    }

    const mainLeak = new MainLeakWatch({
      dir: paths.agentCwd,
      log: (m) => this.#warn(`  ⚠️ ${t.userId} 的主目录没比成：${m}`),
      onLeak: (report) => this.#tellMainLeak(t, notice, report),
    });

    // ★ **每个用户一个调度器**（E 期 · 契约 84 §三·1 / 判据 F5）：
    //   改前这里是"每间 `roomFor()` 再 `new` 一个"，现在**只有这一处** `new`，
    //   房间走下面的 `dispatcher.addSession(...)` 挂到同一个对象上。
    dispatcher = new Dispatcher({
      timeline: mainView,
      runtime: this.#runtime,
      // ⚠️ 回调里带的是**这个人**（每个世界各一份调度器 ⇒ 不用再传 userId）
      onAuthFailure: this.#onAuthFailure ? () => this.#onAuthFailure(t.userId) : null,
      // ⚠️ 协议字段照旧（`main`）：它是写到事件里的，盘上已有的事件也是它
      scopeId: 'main',
      // 🔴 进程池的键**按人不同** —— 就是这一条在修"甲说的话进乙的窗口"
      agentKey: agentKeyFor(t.userId),
      store: t.store,
      recap: cfg.recap,
      turnDeadlineMs: cfg.turnDeadlineMs,
      notice,
      // ★ 见上面那段：只挂在**主线**那条会话上
      mainLeak,
      // ★ P1：活账 / 承诺账（一个人一本，房间共用）。
      work,
      promises,
      // 长活阈值（住代码；cfg 里给了就按给的，测试要能把它调小）。
      backgroundAfterMs: cfg.backgroundAfterMs,
      // "去哪看"那半句用主线的名字（主线就叫"这儿"，用不上 title）。
      whereTitle: null,
      // ★ **93 §5.2·A：`usage` 从这里接上** —— 翻译层拿到的上游 usage 不再被丢掉，
      //   按**这一间的 `scopeId`** 记一笔（主人第 8 条：含它触发的子任务）。
      //   ⚠️ 只记量、不记内容；回调失败不挡轮（`UsageLedger.note` 自己吞）。
      onUsage: ({ scopeId, turn, usage: u }) => {
        usage.note(scopeId, { kind: USAGE_KINDS.agentTurn, usage: u, scopeId, turn });
      },
      // ★ **P2-8：出网留痕从这里接上** —— 翻译层取出"域名/量"，落进这个人那本账。
      //   🔴 只记域名与量（不记正文）；回调失败不挡轮（`EgressLog.note` 自己吞）。
      onEgress: ({ entries }) => {
        egress.noteAll(entries);
      },
      // ★ **D 期**（契约 `100`）：转交那本账 ＋ "这一间存在吗"那个判据。
      //   🔴 `scopeExists` **只查、不建**（D-3：转交给一间不存在的房 ⇒ 拒，
      //      而且**不许顺手建一个**）——所以这里只问 `workspaces.has` / 制品库，
      //      一个 `mkdir` 都没有。
      handoffs,
      //   ⚠️ **内置那三个**（`BUILTIN_SCOPES`）也算存在（它们桌面上就有图标 ·
      //      见 `roomFor` 那段），别的必须真的在工作区或制品库里。
      //   ★ **存在但还没挂上来**（他还没点开过那个图标）⇒ 由这里把它挂上来
      //     （`roomFor` 自己会校验"真的存在"；不存在的那些已经被 `scopeExists` 拒了）。
      //     ⚠️ 用 `this.roomFor`（**宿主这一个**实例）：`worlds` 这个名字在这一层
      //        并不存在（它只在测试里叫那个名字）——写成它就会 `ReferenceError`，
      //        而那正是"转交悄悄送不出去"的形状。
      loadSession: (scope) => this.roomFor(t.userId, scope)?.session ?? null,
      scopeExists: (scope) => {
        const id = String(scope);
        if (id === MAIN_SCOPE || isBuiltinScope(id)) return true;
        try {
          return workspaces.has(id) || apps.current(id) !== null;
        } catch {
          return false;
        }
      },
      // ★ **D 期**：焦点那本账（设备 → 焦点 · D-9）＋ 未读那本账（D-6）。
      focusBook,
      unread,
      // ★ **派活**（契约 102）：那本简登记 ＋ "建那一间"那一刀。
      //   🔴 与**转交**（`handoffs` / `scopeExists`）是两件事：
      //      转交交给**已有**的一间（`scopeExists` 只查、不建）；
      //      派活**现建**一间 —— `startScope` 先落"服务端那一刀"
      //      （`workspaces.ensure`：目录＋清单），再把它挂成这个人的一条会话
      //      （`roomFor`：cwd＝那个工作区、自己的 agent 键）。两条路互不干扰。
      jobs,
      startScope: (where) => {
        const id = checkScope(where);
        workspaces.ensure(id);
        return this.roomFor(t.userId, id)?.session ?? null;
      },
    });

    // ★ 账本那条本地通道：**套接字路径由这个人的目录派生** ⇒ 天然跟人走
    //   （契约 §7.2：模型那侧的工具经它过来，写盘只有这一处）。
    // ★ **P1 §三④ 那条出口**（`88` §三·④）：`work` 那一条问的是"哪几件还挂着"，
    //   而**活账挂在调度器上**（上面那句 `dispatcher = new Dispatcher(…)` 已经建好了）
    //   ⇒ 这里给一个**惰性取**的函数（收口时它可能已经被换掉/卸下）。
    //   ⚠️ 传的是**函数**不是对象：将来若调度器换成"按需建"，这里也不会拿到一个旧的。
    const ledgerSocket = new LedgerSocket({
      ledger,
      socketPath: paths.ledgerSocketPath,
      log: (m) => this.#warn(m),
      ctx: { dispatcher: () => dispatcher },
    }).listen();

    // ★ 开机那几件（**按人各算一份**）：崩溃环、对账。
    //   ⚠️ 对账传的是**主线那层视图**：一条日志现在也装着房间的事件，
    //      不过滤的话主线的对账会去收**别人房间**里未收口的气泡
    //      （收出来的 `message/end` 还会落在主线上 —— 两处都错）。
    const boot = recordStart(t.dir);
    const reconciled = reconcileOnBoot({
      timeline: mainView,
      store: t.store,
      resume: { degraded: boot.degraded },
      notice,
      log: (m) => this.#warn(m),
    });

    const world = {
      userId: t.userId,
      dir: t.dir,
      fresh: t.fresh,
      cfg,
      agentKey: agentKeyFor(t.userId),
      scopeId: 'main',
      store: t.store,
      // ⚠️ `world.timeline` 是**那层主线视图**，不是裸 `Timeline`：
      //    `id` 还是 `'main'`（那条日志），`seq` 还是那套号，
      //    但 `readAll()` / `subscribe()` 只给主线的事件（A4 靠它）。
      timeline: mainView,
      notice,
      say,
      trash,
      ledger,
      ledgerSocket,
      // ★ **阶段 4：一对一交付的登记面**（99）：一个人一个对象，落在**这条日志**上。
      delivery,
      apps,
      workspaces,
      // ★ **用量账**（93 §五）：`worlds.noteUsage()` 用它接语音那一路的账。
      usage,
      // ★ **P2-8 出网留痕**（一个人一本；`read()` 就是"可查"那一半）。
      egress,
      appsSocket,
      published: this.#published,
      dispatcher,
      // ★ P1：逐件活账 / 承诺账（判据与排障都从这里读）。
      work,
      promises,
      // ★ **D 期三本账**（一个人各一份）：转交 / 焦点（按设备）/ 未读。
      //   ⚠️ 它们**不是**给模型看的：转交走工具口（`ledgerSocket`），
      //      未读与焦点走 HTTP 那两个口（`server.js`）。
      handoffs,
      focusBook,
      unread,
      // ★ **派活那本简登记**（契约 102）：判据与"他有哪些东西"那条出口从这里读。
      jobs,
      // 开机时逐件收成了"已停"的那几件（诊断用；**不是**给用户看的）。
      settledOnBoot: settled.map((r) => ({ scopeId: r.scopeId, ref: r.ref, turn: r.turn })),
      boot: { ...boot, reconciled },
    };
    this.#worlds.set(t.userId, world);
    this.#byAgentKey.set(world.agentKey, world);
    if (t.fresh) this.#log(`  ✚ 新的人来了：${t.userId}（他自己的那一格是空的）`);
    return world;
  }

  /**
   * **取一个 scope 的房间**（一个 icon = 一个工作区 = 一条会话 · 契约 §三·3）。
   *
   * `main` 就是主人那个世界本身（**逐字不变**）；别的 scope 现建一个房间：
   *   · `agentCwd` = `<dir>/workspaces/<scope>`（DSH 按 cwd 给会话分组 ⇒ 判据 A2）；
   *   · `timeline` = 那条日志上**这一间的视图**（盖 / 挑 `scopeId` 标签）——
   *     ⚠️ **不是另一条日志**（契约 84 §三·2）：日志与号仍然是那一条、那一套；
   *   · `agentKey` = `<userId>/<scope>` ⇒ 自己的 agent 窗口；
   *   · `dispatcher` = **这个用户那一个调度器**（不是每间 new 一个 · 判据 F5），
   *     这一间只是它里面的一条会话（`dispatcher.addSession()`）。
   *
   * ⚠️ **scope 必须已经存在**（工作区目录在，或者制品库里有这个 app）：
   *    不然一个随手的字符串就能在盘上拉出一条日志来。
   *    ★ **唯一的例外是内置那三个**（`BUILTIN_SCOPES`，B16）：它们**本来就存在**
   *      —— 桌面上就有那个图标；工作区目录由这里第一次用到时建（B16-2）。
   * @returns {object} 世界（`main`）或房间
   */
  roomFor(userId, scope) {
    const s = scope === null || scope === undefined || scope === '' ? MAIN_SCOPE : String(scope);
    if (s === MAIN_SCOPE) return this.worldFor(userId);
    const id = checkScope(s); // 不合法 / 保留名 ⇒ 抛（调用方翻成人话）
    const key = `${userId}\u0000${id}`;
    const had = this.#rooms.get(key);
    if (had) return had;

    const world = this.worldFor(userId);
    // ★ **内置那三个也是合法房间**（B16「要分家」）：它们**不在** `/api/apps` 里、
    //   盘上也可能还没有工作区，但**桌面上就有那个图标** ⇒ 不许拿
    //   "没有这个工作区"把人挡回去 —— 那样客户端一打开设置就会 404。
    //   ⚠️ 别的 scope 仍然必须**已经存在**（工作区目录在，或者制品库里有这个 app）：
    //      不然一个随手的字符串就能在盘上拉出一条日志来。
    //   ⚠️ 它们**不是"没有工作区"的特例**：下面照样 mkdir ＋ `hand()`（B16-2）。
    const builtin = isBuiltinScope(id);
    if (!builtin && !world.workspaces.has(id) && world.apps.current(id) === null) {
      throw new Error(`没有这个工作区：${id}`);
    }
    const paths = this.pathsFor(userId, id);
    // ⚠️ **cwd 必须真的在**：`spawn` 的 ENOENT 分不清"目录不存在"和"程序找不到"，
    //    而那种失败看起来只是"它不理我了"。制品库里有、工作区还没建的那种
    //    （装上来之前就存在的老 app）在这里补一个空目录 —— **不写骨架**
    //    （工作区里已经有他自己的东西，我们不许替他写一个 index.html 进去）。
    try {
      nodeFs.mkdirSync(paths.agentCwd, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new Error(`建工作区 ${paths.agentCwd} 失败：${err?.message ?? err}`);
    }
    // ⚠️ 盒子里服务是 root、agent 是 1000 ⇒ 刚建的那一格要**交给 agent**
    //    （否则它写不进自己的工作区 —— 和那两条套接字是同一个病）
    world.workspaces.hand(id);

    // ★ **这一间的视图**（不是新日志）：盖标签 / 挑标签都住在这里，
    //   取号与落盘仍然是 `world` 那把 `Timeline` 的（一条线、一套号）。
    const view = this.#viewFor(userId, id);
    // ★ 这一间里的话落进**同一条日志**，只是事件上带真的 scope：
    //   `user/echo` 由 `SayService` 盖，别的（`message/*` 等）由视图盖。
    const say = new SayService({
      timeline: view,
      store: world.store,
      timelineId: scopeTimelineId(id),
      scopeId: id,
    });
    // ★ **挂到这个用户那一个调度器上**（判据 F5）——不再 `new Dispatcher`。
    const session = world.dispatcher.addSession({
      scope: id,
      timeline: view,
      // 🔴 进程池的键里**带 scope** ⇒ 一个 app 一个 agent 窗口
      agentKey: agentKeyFor(userId, id),
      // ★ P1：完成提醒里"去哪看"那半句用**它自己的名字**（认不出 ⇒ 不带那半句，
      //   绝不把内部 id 写上屏）。
      //
      // 🔴 **`current(id)` 给的是版本号，不是 app**（见 `apps.js`）——
      //    原来写成 `current(id)?.title` ⇒ **恒 `undefined`** ⇒
      //    "去哪看"那半句**从来没出来过**（P1 §三② 少半句）。
      //    名字的唯一出处是那一版的 `manifest.json`（`list()` 也是从它取的）。
      // ⚠️ **取不到就 `null`**（这个 app 不在**本机**这一格里 ⇒ 不带那半句）；
      //    而**绝不许**把内部 id 当名字写上屏。
      // ⚠️ 箱子里那份库（租户）这一层**够不着**（要过隧道、而且是异步）⇒
      //    对租户这里如实是 `null` —— 那一半记在 `77-BLOCKERS.md`（B19）。
      whereTitle: titleOfApp(world.apps, id),
      // ⚠️ 通知那本账 /「发现就报」**只挂主线**（见 `Dispatcher.addSession`）。
    });

    // ★ **房间里那份 cfg**：`DSH_HOME` / 本地通道还是这个人的，
    //   **只有工作目录换成那个工作区** —— 这就是"模型写的东西落在它自己家里"。
    const cfg = { ...world.cfg, agentCwd: paths.agentCwd, scope: id };
    const room = {
      userId,
      dir: world.dir,
      cfg,
      agentKey: agentKeyFor(userId, id),
      scopeId: id,
      store: world.store,
      timeline: view,
      say,
      // ⚠️ **与 `world.dispatcher` 是同一个对象**（判据 F5 的反例正是
      //    "两间拿到两个不同的 Dispatcher"）。
      dispatcher: world.dispatcher,
      session,
      apps: world.apps,
      workspaces: world.workspaces,
      // ⚠️ **与 `world.delivery` 是同一个对象**（同 `dispatcher` 那条理由）：
      //    四条记录是**一个人一本账**，多作用域只是标签，不是每间一本。
      delivery: world.delivery,
      world,
    };
    this.#rooms.set(key, room);
    this.#byAgentKey.set(room.agentKey, room);
    return room;
  }

  /**
   * `userId\u0000scope` → **那一间的视图**（同一把 `Timeline` 上）。
   * 缓存 ⇒ 同一间每次拿到**同一个对象**（`roomFor` 幂等、订阅可退）。
   */
  #viewFor(userId, scope) {
    const key = `${userId}\u0000${scope}`;
    const had = this.#views.get(key);
    if (had) return had;
    const world = this.worldFor(userId);
    const view = new ScopeView({ timeline: world.timeline.base, scope });
    this.#views.set(key, view);
    return view;
  }

  /**
   * **进程池里某个 agent 被卸下**时，找到它属于谁、让那间房的派发器收口。
   *
   * ⚠️ 少了这一条，超时/淘汰时的"先收口再卸"会落到**错的**那间房上
   *    （或者根本落不到）。`serve.js` 把它接给 `AgentRuntime` 的 `onEvict`。
   */
  onEvict(sessionId) {
    const owner = this.#byAgentKey.get(sessionId);
    if (!owner) return;
    try {
      owner.dispatcher.onEvict(sessionId);
    } catch (err) {
      this.#warn(`  ⚠️ ${owner.userId} 收口没做成：${err?.message ?? err}`);
    }
  }

  /**
   * 开机把这些人热一遍（对账 / 崩溃环 / 回收站都按人各算一份）。
   * ⚠️ 一个人失败**不许**把开机带走 —— 别人还得用（照开机对账那条规矩）。
   */
  warmUp(userIds, { only = null } = {}) {
    const out = [];
    for (const id of userIds) {
      if (only && id !== only) continue;
      try {
        out.push(this.worldFor(id));
      } catch (err) {
        this.#warn(`  ⚠️ ${id} 那一份世界没起来：${err?.message ?? err}`);
      }
    }
    return out;
  }

  /**
   * **聚合**"手上还有没有没说完的话"（`status.json`）。
   *
   * ⚠️ 一人一份会让重启脚本读不懂（它只有一个文件），所以**聚合成一份**：
   *    **任一忙就算忙**（宁等不切）。见 `38-ISOLATION-SPLIT.md` §三③。
   *
   * ★ **房间也算进来**（契约 `83-APP-WORKSPACE.md`）：某个 app 里那一轮
   *   正跑到一半时重启，也和主人自己那一轮一样不能切。
   */
  busySnapshot() {
    let pending = 0;
    let turns = 0;
    let openMessageId = null;
    /** ★ P1：**逐件**的活（契约 88 §一.1）—— 重启脚本与排障都看得到"是哪几件"。 */
    const items = [];
    // ⚠️ **按人走、不是按房间走**：一个用户只有一个调度器，它自己会把
    //    **每一条会话**的账加起来（`Dispatcher.busy()`）。
    //    照 `allRooms()` 走会把同一个调度器数好几遍（房间与主线共享它）。
    for (const w of this.#worlds.values()) {
      if (w.dispatcher?.busy) {
        const b = w.dispatcher.busy();
        pending += b.pending;
        turns += b.turns;
        openMessageId ??= b.openMessageId;
        items.push(...(b.items ?? []).map((it) => ({ userId: w.userId, ...it })));
        continue;
      }
      // 老调用方（没给 `Dispatcher` 的测试替身）：退回逐房那套
      pending += w.dispatcher?.pendingDeliveries ?? 0;
      turns += w.dispatcher?.armedDeadlines ?? 0;
      openMessageId ??= w.timeline?.openMessageId ?? null;
    }
    return { openMessageId, pending, turns, items };
  }

  /** 每个人的回收站都扫一遍（到期提醒 + 到点真删）。返回干了哪些事（给日志）。 */
  sweepTrash() {
    const done = [];
    for (const w of this.#worlds.values()) {
      if (!w.trash) continue;
      try {
        for (const it of w.trash.expiringSoon()) {
          try {
            w.notice.notice({ kind: 'expiring', undo: { ...UNDO_RESTORE, messageIds: it.messageIds } });
          } catch (err) {
            this.#warn(`  ⚠️ ${w.userId} 到期提醒没发出去：${err?.message ?? err}`);
          }
        }
        for (const r of w.trash.purgeExpired()) {
          done.push({ userId: w.userId, ...r });
        }
      } catch (err) {
        // ⚠️ 一个人扫失败不许影响别人（台账在盘上，下一轮还会再试）
        this.#warn(`  ⚠️ ${w.userId} 的回收站没扫成：${err?.message ?? err}`);
      }
    }
    return done;
  }

  /** 每个人的那条本地通道都关掉（**并把套接字文件删掉**）。 */
  closeSockets() {
    for (const w of this.#worlds.values()) {
      try {
        w.ledgerSocket?.close();
        // ⚠️ **新开的那条口也要跟着关**：漏了它，进程（和测试）就永远不退出。
        w.appsSocket?.close();
      } catch (err) {
        this.#warn(`  ⚠️ ${w.userId} 的本地通道没关干净：${err?.message ?? err}`);
      }
    }
  }

  /** 每个人留一个"这次是好好走的"标记（下次开机才知道上一次是不是被硬杀的）。 */
  markCleanExitAll() {
    for (const w of this.#worlds.values()) {
      try {
        markCleanExit(w.dir);
      } catch (err) {
        this.#warn(`  ⚠️ ${w.userId} 的收工标记没留下：${err?.message ?? err}`);
      }
    }
  }

  /**
   * 优雅退出：**每个用户那一个**调度器先把手上的话收圆。
   *
   * ⚠️ **按人走**（契约 84 §三·1）：房间与主线**共用同一个**调度器
   *    ⇒ 照 `allRooms()` 走会对同一个对象调好几遍 `shutdown()`。
   *    `Dispatcher.shutdown()` 自己会遍历它的**每一条会话**，所以每人一次就够。
   */
  async shutdownDispatchers() {
    for (const w of this.#worlds.values()) {
      try {
        await w.dispatcher?.shutdown();
      } catch (err) {
        this.#warn(`  ⚠️ ${w.userId} 的派发器没收干净：${err?.message ?? err}`);
      }
    }
  }
}
