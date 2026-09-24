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

import { Apps } from './apps.js';
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
import { Ledger, LEDGER_TIMELINE_ID } from './ledger.js';
import { LedgerSocket, ledgerSocketPath } from './ledger-socket.js';
import { Notice, UNDO_RESTORE } from './notice.js';
import { SayService } from './say.js';
import { Tenants, OWNER_ID } from './tenants.js';
import { Timeline } from './timeline.js';
import { Trash } from './trash.js';
import { markCleanExit, recordStart } from './boot-marker.js';
import { reconcileOnBoot } from './reconcile.js';

/**
 * **主线那个房间的名字**（不属于任何 app 的对话 —— 契约 `83-APP-WORKSPACE.md` §三·2）。
 *
 * ⚠️ 它**永远是 `'main'`**：盘上已有的事件里 `scopeId` 写的就是它，
 *    动它等于动历史字节（协议字段一旦上线就冻结）。
 */
export const MAIN_SCOPE = 'main';

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
 * ⚠️ 主线的日志必须**逐字不变**（`main.jsonl`）：盘上已有的事件、跨重启的取号、
 *    客户端还记得的号，全都挂在那个名字上。
 * ⚠️ 别的 scope 加前缀，是为了**构造上不可能撞上主线**。
 *
 * ⚠️ 日志**不放进工作区**：工作区是"这个 app 的源码与产物"，
 *    往里塞一条对话记录会让"迁移时内容逐字节不变"（A6）变成一句难验的话。
 */
export function scopeTimelineId(scope = MAIN_SCOPE) {
  return scope === MAIN_SCOPE ? 'main' : `scope-${scope}`;
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

/** 每个人的世界长什么样（给文档与测试一个准确的形状）。 */
export const WORLD_SHAPE = Object.freeze([
  'userId', 'dir', 'cfg', 'agentKey', 'scopeId',
  'store', 'timeline', 'notice', 'say', 'trash', 'ledger', 'ledgerSocket', 'apps', 'workspaces', 'appsSocket', 'published', 'dispatcher', 'boot',
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
   * `userId\u0000scope` → **房间**（一个 scope = 一个 cwd = 一条对话 · 契约 §三·3）。
   *
   * ⚠️ 房间**不是**"另一个人的世界"：它和主人那份世界共用 `dir` / `DSH_HOME` /
   *    制品库 / 本地通道，**只有三样不同** —— 工作目录、时间线、agent 进程池的键。
   */
  #rooms = new Map();
  /** agentKey → 世界 / 房间（`onEvict` 与 `cfgForAgentKey` 回来时要知道该找谁） */
  #byAgentKey = new Map();
  #now;
  #makeTrash;
  /** 共享的小程序库（乙-3）。**一个部署一份**（不是按人一份）。 */
  #published;

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

    const timeline = new Timeline({
      id: 'main',
      store: t.store,
      onSubscriberError: (err, event) => {
        this.#warn(`[timeline] 订阅者出错（${event.type}）：${err?.message ?? err}`);
      },
    });
    const notice = new Notice({
      timeline,
      store: t.store,
      timelineId: 'main',
      log: (m) => this.#warn(m),
    });
    const say = new SayService({ timeline, store: t.store, timelineId: 'main' });
    const trash = this.#wantTrash
      ? this.#makeTrash({ timeline, store: t.store, timelineId: 'main' }).sync()
      : null;

    // 账本**另起一条日志**（`<dir>/ledger.jsonl`），所以它有自己的 Timeline
    const ledgerTimeline = new Timeline({ id: LEDGER_TIMELINE_ID, store: t.store });
    const ledger = new Ledger({ store: t.store, timeline: ledgerTimeline }).sync();

    // ★ **小程序制品库**（乙-1 · 契约 `docs/dev/59-USER-APPS.md`）：**按人一份**，
    //   落在**他自己那一格**下面（`<dir>/hupo/apps/`）—— 这就是"只有他自己可见"的落点。
    //   ⚠️ 它**不认识令牌**；它是"谁的世界"由这里定，路由那边按 `claim.sub` 取。
    const apps = new Apps({ dir: t.dir, sub: t.userId });
    // ★ **子工作区**（契约 `83-APP-WORKSPACE.md` §三·1）：**按人一份**，
    //   落在 `<dir>/workspaces/`（**与主目录平行** —— 手册 §2.2 第二条）。
    //   ⚠️ 这里是"服务端那一刀"的落点：造 app 时**服务端**建目录，不靠模型记得。
    const workspaces = new AppWorkspaces({ dir: t.dir, log: (m) => this.#warn(m) });
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
        // ★ **画一张图**（P1-27 后半）：工具只递请求，真正去花他那把钥匙的是这里。
        //   ⚠️ 与 `/api/image`（配置页那个「试一张」）**同一套规则**（`image-use.js`）。
        drawImage: makeDrawImage({ dataDir: t.dir, log: (m) => this.#warn(`  ${m}`) }),
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
    const mainLeak = new MainLeakWatch({
      dir: paths.agentCwd,
      log: (m) => this.#warn(`  ⚠️ ${t.userId} 的主目录没比成：${m}`),
      onLeak: (report) => this.#tellMainLeak(t, notice, report),
    });

    dispatcher = new Dispatcher({
      timeline,
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
      // ★ 见上面那段：只挂在**主线**这个调度器上
      mainLeak,
    });

    // ★ 账本那条本地通道：**套接字路径由这个人的目录派生** ⇒ 天然跟人走
    //   （契约 §7.2：模型那侧的工具经它过来，写盘只有这一处）。
    const ledgerSocket = new LedgerSocket({
      ledger,
      socketPath: paths.ledgerSocketPath,
      log: (m) => this.#warn(m),
    }).listen();

    // ★ 开机那几件（**按人各算一份**）：崩溃环、对账。
    const boot = recordStart(t.dir);
    const reconciled = reconcileOnBoot({
      timeline,
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
      timeline,
      notice,
      say,
      trash,
      ledger,
      ledgerSocket,
      apps,
      workspaces,
      appsSocket,
      published: this.#published,
      dispatcher,
      boot: { ...boot, reconciled },
    };
    this.#worlds.set(t.userId, world);
    this.#byAgentKey.set(world.agentKey, world);
    if (t.fresh) this.#log(`  ✚ 新的人来了：${t.userId}（他自己的那一格是空的）`);
    return world;
  }

  /**
   * **取一个 scope 的房间**（一个 icon = 一个工作区 = 一条对话 · 契约 §三·3）。
   *
   * `main` 就是主人那个世界本身（**逐字不变**）；别的 scope 现建一个房间：
   *   · `agentCwd` = `<dir>/workspaces/<scope>`（DSH 按 cwd 给会话分组 ⇒ 判据 A2）；
   *   · `timeline` = 自己那条日志（`scope-<scope>.jsonl`）⇒ 对话分家（判据 A3）；
   *   · `agentKey` = `<userId>/<scope>` ⇒ 自己的 agent 窗口。
   *
   * ⚠️ **scope 必须已经存在**（工作区目录在，或者制品库里有这个 app）：
   *    不然一个随手的字符串就能在盘上拉出一条日志来。
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
    if (!world.workspaces.has(id) && world.apps.current(id) === null) {
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

    const timeline = new Timeline({
      id: scopeTimelineId(id),
      store: world.store,
      onSubscriberError: (err, event) => {
        this.#warn(`[timeline] 订阅者出错（${event.type}）：${err?.message ?? err}`);
      },
    });
    // ★ 这一间里的对话**只写这一条日志**：`user/echo` 带上真的 scope
    //   （主线那边**不带**这个字段 —— 老事件盘上没有它，主线行为逐字不变）。
    const say = new SayService({
      timeline,
      store: world.store,
      timelineId: scopeTimelineId(id),
      scopeId: id,
    });
    const dispatcher = new Dispatcher({
      timeline,
      runtime: this.#runtime,
      onAuthFailure: this.#onAuthFailure ? () => this.#onAuthFailure(userId) : null,
      // ★ **写到事件里的那个字段**：盘上已有的主线是 `'main'`，
      //   而这一间里的事件从此带**真的** scope（契约 §三·3）。
      scopeId: id,
      // 🔴 进程池的键里**带 scope** ⇒ 一个 app 一个 agent 窗口
      agentKey: agentKeyFor(userId, id),
      store: world.store,
      recap: world.cfg.recap,
      turnDeadlineMs: world.cfg.turnDeadlineMs,
      // ⚠️ 通知那本账**只挂在主线上**：过程/通知两条通道的互斥是"一个人一份"的账，
      //   一间一个会让同一件事在两处各记一次（那正是它要防的）。
      notice: null,
    });

    // ★ **房间里那份 cfg**：`DSH_HOME` / 本地通道还是这个人的，
    //   **只有工作目录换成那个工作区** —— 这就是"模型写的东西落在它自己家里"。
    const cfg = { ...world.cfg, agentCwd: paths.agentCwd };
    const room = {
      userId,
      dir: world.dir,
      cfg,
      agentKey: agentKeyFor(userId, id),
      scopeId: id,
      store: world.store,
      timeline,
      say,
      dispatcher,
      apps: world.apps,
      workspaces: world.workspaces,
      world,
    };
    this.#rooms.set(key, room);
    this.#byAgentKey.set(room.agentKey, room);
    return room;
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
    for (const w of this.allRooms()) {
      pending += w.dispatcher?.pendingDeliveries ?? 0;
      turns += w.dispatcher?.armedDeadlines ?? 0;
      // ⚠️ `openMessageId` 只有第一个非空的有意义（它是"某一条没收口的气泡"）——
      //    `computeBusy` 只判它**在不在**，所以取谁的不影响"忙不忙"
      openMessageId ??= w.timeline?.openMessageId ?? null;
    }
    return { openMessageId, pending, turns };
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

  /** 优雅退出：每个人的派发器（**含每个房间的**）先把手上的话收圆。 */
  async shutdownDispatchers() {
    for (const w of this.allRooms()) {
      try {
        await w.dispatcher?.shutdown();
      } catch (err) {
        this.#warn(`  ⚠️ ${w.userId} 的派发器没收干净：${err?.message ?? err}`);
      }
    }
  }
}
