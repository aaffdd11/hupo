// A1·「**发现就报**」：造 app 的那一轮，主目录**多了文件**就说出来
// （契约 `docs/dev/83-APP-WORKSPACE.md` §四 A1 · 主人 2026-09-25 认可）。
//
// ── 它补的是哪一条缝 ────────────────────────────────────────
// "造 app ⇒ 文件只落进它自己的工作区"是**硬的**：`app_create` 由**服务端**写进
// `<dir>/workspaces/<scope>/`（A1 已证）。
//
// 🔴 **但**：模型在**主房间**那一轮里**另外**用通用写文件 / 执行命令写相对路径时，
//    那些会落 `<dir>/main` —— DSH 的 cwd 是**启动时定死**的，一轮中途换不了
//    ⇒ 服务端**拦不住**通用文件写（这是工具进程那一侧的能力，不是我们这条口）。
//
// ⇒ 所以这一条是"**检测不阻止，但绝不许它静默发生**"：
//     这一轮**确实调过 `app_create`（或装/建那条路）**、而且主目录**多出了新文件**
//     ⇒ ① 记一行账（审计日志）② 用**现成**那条"讲给他听"的通道说一句（`Notice`）。
//
// ── 🔴 不许误报（这一条的反例比正例更要紧）────────────────────
// **没造 app 的一轮**里，主目录多了文件**很正常**（那本来就是主房间自己的工作目录，
// 是主人在那儿让它干活的地方）⇒ **一个字的报告都不许有**。
// 造了 app 但主目录**没多出**文件的干净一轮 ⇒ 同样**零报告**。
//
// ── 怎么比 ──────────────────────────────────────────────────
// 比的是**路径清单**（递归；**只读目录项，一个字节的内容都不读** —— N5 那条
// "别把用户的东西读来读去"的纪律）。差集 = 后一份里**多出来**的路径。
// 报告只列**前几个**（`MAIN_LEAK_MAX_PATHS`），别把一整棵树刷进日志。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

/**
 * 报告里**最多列几个**路径。
 *
 * ⚠️ 它是"别把整棵树刷进日志"那句话的落点，**不是**容量规划：
 *    多出来的数量本身照样如实报（`leakReport().total`）。
 */
export const MAIN_LEAK_MAX_PATHS = 5;

/** 审计那一行的 `what`（**一处出处**：写盘的人与判据读的是同一个字）。 */
export const MAIN_LEAK_WHAT = '小程序的文件落进了主目录';

/**
 * 递归列出一棵树里所有**非目录**项的相对路径（**只记路径**）。
 *
 * ⚠️ 读不到 / 不是目录 ⇒ `[]`（不抛）：比对本身是旁路，
 *    它坏掉不许把一轮带走（调用方也会把它翻成一行警告）。
 * ⚠️ **软链接不跟进去**（`withFileTypes` 认它是软链接、不是目录）——
 *    既不递归，也照样把它**当一条路径报出来**（它就是模型写下的东西）。
 */
export function listFiles(root, { fs = nodeFs } = {}) {
  const out = [];
  if (typeof root !== 'string' || root === '') return out;
  const walk = (rel) => {
    const here = rel === '' ? root : nodePath.join(root, rel);
    let entries;
    try {
      entries = fs.readdirSync(here, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const next = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(next);
      else out.push(next);
    }
  };
  walk('');
  return out.sort();
}

/** 后一份里**多出来**的那些路径（顺序按 `after` 出现的顺序，去重）。 */
export function addedPaths(before, after) {
  const had = new Set(Array.isArray(before) ? before : []);
  const seen = new Set();
  const out = [];
  for (const p of Array.isArray(after) ? after : []) {
    if (had.has(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * 把一次发现收拾成一份报告（**纯函数**：判据直接钉它）。
 *
 * @param {object} o
 * @param {string[]} [o.apps]   这一轮造过哪个（id；给**账**用，可能不止一个）
 * @param {string[]} [o.titles] 它们**叫什么**（给**他看的那句话**用；缺 ⇒ 退回 id）
 * @param {string[]} [o.paths]  多出来的那些路径（**全部**，不只是要列出来的）
 * @param {number} [o.max]      最多列几个
 * @returns {{apps:string[], titles:string[], paths:string[], shown:string[], total:number, more:number}}
 */
export function leakReport({ apps = [], titles = null, paths = [], max = MAIN_LEAK_MAX_PATHS } = {}) {
  const all = [...new Set(Array.isArray(paths) ? paths : [])];
  const n = Number.isSafeInteger(max) && max >= 0 ? max : MAIN_LEAK_MAX_PATHS;
  const shown = all.slice(0, n);
  const ids = [...new Set(Array.isArray(apps) ? apps : [])].filter((x) => typeof x === 'string' && x !== '');
  // ⚠️ 给他看的那句话**不许露出内部那个 slug**（`city-weather` 那类）——
  //    有名字就用名字，没有才退回 id（N10：认不出也别编）。
  const names = (Array.isArray(titles) ? titles : [])
    .map((x, i) => (typeof x === 'string' && x.trim() !== '' ? x : ids[i]))
    .filter((x) => typeof x === 'string' && x !== '');
  return {
    apps: ids,
    titles: names,
    paths: all,
    shown,
    total: all.length,
    more: Math.max(0, all.length - shown.length),
  };
}

/**
 * **讲给他听**的那句话（走 `Notice`；客户端照抄）。
 *
 * ⚠️ 用词纪律（`test/notice.test.js` ⑤ 那张表）：**不许有内部词** ——
 *    工作区 / 会话 / 时间线 / 客户端 / 工具… 一个都不许出现。
 *    这里只说"我另外写了几个文件，它们没在那个小程序里"。
 * ⚠️ 提到那个小程序时用**它的名字**（没有才退回 id）—— 不给他看内部 slug。
 */
export function leakNoticeText(report) {
  const r = report ?? {};
  const names = (Array.isArray(r.titles) && r.titles.length > 0 ? r.titles : r.apps) ?? [];
  const shown = Array.isArray(r.shown) ? r.shown : [];
  const total = Number.isSafeInteger(r.total) ? r.total : shown.length;
  const more = Number.isSafeInteger(r.more) ? r.more : 0;
  const who = names.length > 0 ? `做「${names.join('、')}」的时候` : '做那个小程序的时候';
  const tail = more > 0 ? `（还有 ${more} 个）` : '';
  return (
    `${who}，我另外还写了 ${total} 个文件：${shown.join('、')}${tail}`
    + ' —— 它们没在那个小程序里。我把这件事记下来了。'
  );
}

/**
 * **审计那一行**的正文（谁 / 哪个 app / 多出来哪些路径）。
 *
 * ⚠️ 它的形状是 `audit.js` 那套（` · ` 分隔），这里只给 `detail` 那一格。
 */
export function leakAuditDetail(report) {
  const r = report ?? {};
  const apps = Array.isArray(r.apps) ? r.apps : [];
  const shown = Array.isArray(r.shown) ? r.shown : [];
  const total = Number.isSafeInteger(r.total) ? r.total : shown.length;
  const more = Number.isSafeInteger(r.more) ? r.more : 0;
  const who = apps.length > 0 ? `app=${apps.join(',')} ` : '';
  const tail = more > 0 ? `（还有 ${more} 个未列）` : '';
  return `${who}多出 ${total} 个文件：${shown.join('、')}${tail}`;
}

/**
 * **一轮前后比一次主目录**。
 *
 * 时序（三处都要走到 `finish`：正常结束 / 失败 / 超时）：
 *
 *     turn-start   → `start()`   记一份主目录清单
 *     （这一轮里）  → `noteBuilt()` 每造一个 app 记一笔
 *     turn 收口     → `finish()`  再记一份、比差集、**该报才报**
 *
 * ⚠️ 只在**主线那个调度器**上挂它：房间里的 cwd **就是**它自己的工作区，
 *    相对路径写在那儿本来就是对的 —— 那儿不该报任何东西。
 */
export class MainLeakWatch {
  #dir;
  #fs;
  #log;
  #onLeak;
  #max;
  /** 这一轮开始时的清单（`null` = 现在没在一轮里 / 没接上）。 */
  #before = null;
  /** 这一轮里造过的 app（**空 = 这一轮没造东西 ⇒ 一个字都不许报**）。 */
  #built = [];

  /**
   * @param {object} o
   * @param {string} o.dir            **主目录**（主线那个 cwd）
   * @param {object} [o.fs]
   * @param {(m:string)=>void} [o.log] 比对 / 上报坏掉时的警告（**不许静默**）
   * @param {(report:object)=>void} [o.onLeak] 发现了 ⇒ 交给它（写账 + 讲给他听）
   * @param {number} [o.max]
   */
  constructor({ dir, fs = nodeFs, log = () => {}, onLeak = null, max = MAIN_LEAK_MAX_PATHS } = {}) {
    this.#dir = typeof dir === 'string' && dir !== '' ? dir : null;
    this.#fs = fs;
    this.#log = log;
    this.#onLeak = onLeak;
    this.#max = max;
  }

  /** 接上了没有（没接上 ⇒ 整条判据不存在，其它行为一个字不变）。 */
  get watching() {
    return this.#dir !== null;
  }

  /** 这一轮记下的 app 数（诊断用）。 */
  get builtCount() {
    return this.#built.length;
  }

  /** 这一轮开始了：记一份主目录的清单。 */
  start() {
    if (!this.#dir) return null;
    this.#before = null;
    this.#built = [];
    try {
      this.#before = listFiles(this.#dir, { fs: this.#fs });
    } catch (err) {
      this.#log(`主目录没列出来（${this.#dir}）：${err?.message ?? err}`);
    }
    return this.#before;
  }

  /**
   * **这一轮里真造了一个 app**（`app_create` / 装上来那条路）。
   * ⚠️ 不在某一轮里（没有起点清单）⇒ 记了也没用（**不当回事**，返回 `false`）。
   *
   * @param {{id?:string,title?:string}|string} info id（有名字就一起给 —— 给他看时用它）
   */
  noteBuilt(info) {
    if (!this.#dir || this.#before === null) return false;
    const id = typeof info === 'string' ? info : info?.id;
    if (typeof id !== 'string' || id === '') return false;
    const title = typeof info === 'object' && info !== null && typeof info.title === 'string' ? info.title : '';
    this.#built.push({ id, title });
    return true;
  }

  /**
   * **这一轮收口了**（正常 / 失败 / 超时三处都调这儿）：再记一份、比差集。
   *
   * 🔴 **三件事缺一不可**：起点清单在、这一轮造过 app、主目录**真多出**了文件。
   *    少任何一件 ⇒ 返回 `null` 且**一个字的报告都没有**。
   *
   * @param {object} [o]
   * @param {number|null} [o.turn]   收口的是第几轮（给排障 / 判据看）
   * @param {string|null} [o.reason] 怎么收的（`completed` / `failed` / `timeout`…）
   * @returns {object|null} 报告（没发现 ⇒ `null`）
   */
  finish({ turn = null, reason = null } = {}) {
    const before = this.#before;
    const built = this.#built;
    // ⚠️ **先清账再干活**：上报里万一出错，也不许让下一轮接到这一轮的起点
    this.#before = null;
    this.#built = [];
    if (!this.#dir || before === null || built.length === 0) return null;

    let after;
    try {
      after = listFiles(this.#dir, { fs: this.#fs });
    } catch (err) {
      this.#log(`主目录没列出来（${this.#dir}）：${err?.message ?? err}`);
      return null;
    }
    const added = addedPaths(before, after);
    if (added.length === 0) return null;

    const report = {
      dir: this.#dir,
      turn,
      reason,
      ...leakReport({
        apps: built.map((b) => b.id),
        titles: built.map((b) => b.title),
        paths: added,
        max: this.#max,
      }),
    };
    // ⚠️ 上报是**旁路**：它坏掉不许把这一轮带走（那一轮正在收口）。
    //    但**必须说出来**（`log`）—— 静默失败正是这一条要挡的那种事。
    try {
      this.#onLeak?.(report);
    } catch (err) {
      this.#log(`发现"文件落错地方"了，但没报出去：${err?.message ?? err}`);
    }
    return report;
  }
}
