// 会话记录目录的清理：**哪些能删、照计划真删**。
//
// ── 为什么要有这个文件（欠账第 9 条）────────────────────────
//
// `docs/dev/07-TIMEOUT.md` §6.6：`$DSH_HOME/sessions/` **只涨不降，没有上限**。
// 每换一个 agent 实例就多一条记录（`会话名.bootId.第几个实例`，见
// `agent-runtime.js#nextDshSessionId`），而 v2 **不使用 DSH 的 resume**
// （每次新起一个 agent、靠 recap 喂记忆）⇒ 旧记录基本是死重量。
//
// 手册依据：**N9「任何存储都要能回答『这条怎么删干净』」**。
// 配套纪律（`store.js` 立下的）：**删数据这件事从不静默**——
// 计划要能打印、跳过要说理由、失败要上抛。
//
// ── 这个文件里"读盘"和"纯逻辑"分得很清 ────────────────────
//
//   · `planPrune`   —— **纯函数**，输入是目录项的数组，输出计划。**不碰磁盘**，
//                     所以那几条"绝不删"的规矩可以离线一条一条钉死（进硬闸）。
//   · `scanEntries` / `measureTree` —— 读盘，只读。
//   · `applyPrune`  —— **真删**，而且只删"计划里点过名、且现在还没变"的那些。
//
// ⚠️ **三者必须一起看**：`planPrune` 判断的依据（mtime / 大小）是
// `measureTree` 量出来的；`applyPrune` 删之前**用同一个量法再量一遍**。
// 两边量法要是不一样，"mtime 没变"这句话就是假的。
//
// ── ⚠️ 关于"正在跑的那一份"（最危险的一件事）──────────────
//
// 需求里说"mtime 还很新 ⇒ 可能正在用"，这**不够**：
//   · `main.<bootId>.<n>` 这个目录的 **mtime 只在目录项变化时更新**，
//     而 DSH 是**往 `session.v3.jsonl.zstd` 里原地追加**的
//     （实测：目录 mtime 16:20、里面的文件 16:23 —— 目录比文件还旧）。
//     ⇒ 只 stat 目录会把一个**正在写的**记录看成"三分钟没动过"。
//     ⇒ 所以本文件量的 mtime 是**整棵树里最新的那个 mtime**（见 `measureTree`）。
//   · 但"最新"仍然是**推断**。真正确定的信号是 `session.lock` 上的 **flock**：
//     实测（本机，跑着的那一份 vs 已结束的一份）——
//     `flock -n <活的那份>/session.lock` ⇒ 拿不到（exit 1）；
//     `flock -n <死的那份>/session.lock` ⇒ 拿得到（exit 0）。
//     ⇒ 见 `probeLock`。这是**额外的**一层，不是唯一的一层。
//
// 三层保护，缺一层都还能活：① 新近保护窗 ② 保底条数 ③ 锁探测 / 删前重核。

import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { spawnSync } from 'node:child_process';

// ── 阈值 ───────────────────────────────────────────────────
// 手册纪律一：**数值只住在代码常量里**（写进文档的那一刻它就开始过期）。
// 每一条都写清"为什么是这个量级"。

/**
 * 「新近保护窗」：比这个还新的，**一份都不删**。
 *
 * 30 分钟 = **10 倍单轮硬收口**（`config.turnDeadlineMs` 默认 180_000ms）。
 * 取 10 倍的理由：一轮在跑、超时收口、紧接着重试——这一段里那份记录一直在被写；
 * 窗口要盖得住"一轮 + 收口 + 重试"整条链，而不只是盖住一轮。
 * 再放大（比如 24 小时）就等于"每天都清不掉当天新产生的那批"，欠账原样还。
 */
export const NEW_RECENT_PROTECT_MS = 30 * 60_000;

/**
 * 「保底条数」：按 mtime 从新到旧排在最前面的这几份，**哪怕很旧也留着**。
 *
 * 5 = **进程上限 + 1**（`config.agentMaxProcesses` 默认 4）。
 * 理由：同时最多只有 4 个 agent 活着，所以"活着的那几个"一定落在最新的几份里；
 * 保底比它多一份，是给"活着的那个恰好卡在保护窗之外"留的余量。
 * 另一半理由是排障：出问题时主人要看的是**最近几次**的记录，一份不剩就很难查。
 */
export const MIN_KEEP_COUNT = 5;

/**
 * 「保留时长」：超过这个岁数的，清掉。
 *
 * 7 天。这份记录的唯一用途是**排障**（"上次它为什么卡住"）。
 * 按超时那条路算，最密的情况也是一轮 180 秒才多一份 ⇒ 一周攒不出多少；
 * 而"上周三那次为什么卡"基本不会再有人去翻。
 * ⚠️ 时间这一条**必须**有：只按容量删的话，一个安静的仓库里垃圾会躺到天荒地老。
 */
export const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * 「容量上限」：所有记录加起来超过这个数，**从最旧开始删到线以内**。
 *
 * 512 MiB。实测一份 20–450 KB（`session.v3.jsonl.zstd`，现在这一组 41 份 ≈ 816 KB）
 * ⇒ 512 MiB 够躺**上千份**，远超"排障要看最近几次"的需要；
 * 而它同时是**真的有界**的：不设这条，"一天跑了一万次"会在当天之内把盘吃掉，
 * 那些记录一条都不算超时。
 *
 * ⚠️ 别把它当成"保护整块盘"（盘多大不归这里管）——它是"这个目录不该无限长"的那条线。
 */
export const MAX_TOTAL_BYTES = 512 * 1024 ** 2;

/**
 * 「条数上限」：目录项条数本身也要有上限。
 *
 * 300。这条比容量那条**先咬到**（300 × 450 KB ≈ 132 MB），因为条数的代价
 * 不在字节上：每份至少一个目录（一块 4 KB 起）、一次 readdir、一棵 lstat 树；
 * 条数上万之后 `ls` 和扫描都会明显变慢，而那时候容量可能还没到线。
 * 300 份 ≈ 一个月的正常量级 —— 排障要看的那几次一定还在里面。
 */
export const MAX_KEEP_COUNT = 300;

/** 一个会话记录目录的标记文件名（DSH 实测：`session.lock` + `session.v3.jsonl.zstd`）。 */
export const SESSION_MARKER_PREFIX = 'session.';

/** 锁文件名。探测"有人在用吗"要看它。 */
export const LOCK_NAME = 'session.lock';

/** `measureTree` 最多往下走几层（DSH 是扁平的两层：项目分组 / 一条记录）。 */
export const MAX_SCAN_DEPTH = 4;

// ── 一、纯逻辑：该删哪些 ───────────────────────────────────

/**
 * 算一份清理计划。**纯函数，不碰磁盘**（所以能进硬闸，一条一条钉）。
 *
 * @param {object} o
 * @param {Array<{name: string, path?: string, mtimeMs: number, sizeBytes?: number}>} o.entries
 *        目录项。`mtimeMs` 应当是**整棵树里最新的那个 mtime**（见 `measureTree`）。
 * @param {number} [o.now]          现在（测试注入，保证可重复）
 * @param {number} [o.protectMs]    新近保护窗
 * @param {number} [o.minKeep]      保底条数
 * @param {number} [o.maxAgeMs]     保留时长
 * @param {number} [o.maxBytes]     容量上限（≤0 或非数 = 关掉这一条）
 * @param {number} [o.maxCount]     条数上限（≤0 或非数 = 关掉这一条）
 * @returns {{keep: Array, remove: Array, freedBytes: number}}
 *          `remove` **从最旧开始**排（真要删就按这个顺序删）。
 *          另外带回几个诊断数：`protectedRecent` / `protectedFloor` /
 *          `protectedUnknown` / `totalBytes` / `scanned`。
 *
 * ⚠️ **mtime 读不出来的那几项一律留着。** 删除是**不可逆的那一侧**，
 * "不知道它多新"绝不能当成"它很旧"。它们进 `keep`，并单独计数。
 */
export function planPrune({
  entries = [],
  now = Date.now(),
  protectMs = NEW_RECENT_PROTECT_MS,
  minKeep = MIN_KEEP_COUNT,
  maxAgeMs = MAX_AGE_MS,
  maxBytes = MAX_TOTAL_BYTES,
  maxCount = MAX_KEEP_COUNT,
} = {}) {
  const list = Array.isArray(entries) ? entries : [];

  const known = [];
  const unknown = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const mtimeMs = Number(e.mtimeMs);
    const size = Number(e.sizeBytes);
    const norm = {
      ...e,
      mtimeMs,
      sizeBytes: Number.isFinite(size) && size > 0 ? size : 0,
    };
    if (Number.isFinite(mtimeMs)) known.push(norm);
    else unknown.push(norm);
  }

  // 新的在前。⚠️ 同一毫秒要用**名字**打破平局——不然同一份输入两次跑出来的
  // 计划可能不一样（"删哪几份"就成了掷骰子，事后没法复核）。
  known.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    const an = String(a.name ?? '');
    const bn = String(b.name ?? '');
    return an < bn ? -1 : an > bn ? 1 : 0;
  });

  // ── 两条"绝不删" ──
  const mark = known.map((e, i) => {
    if (e.mtimeMs > now - protectMs) return 'recent'; // 正在用的那个可能就在这儿
    if (i < minKeep) return 'floor'; // 再旧也留几条，便于排障
    return null;
  });
  const protectedRecent = mark.filter((m) => m === 'recent').length;
  const protectedFloor = mark.filter((m) => m === 'floor').length;

  // 候选：从最旧开始（`known` 是新的在前，所以反着走）
  const candidates = [];
  for (let i = known.length - 1; i >= 0; i -= 1) {
    if (mark[i] === null) candidates.push(known[i]);
  }

  // 容量按**整批**算（留着的那几份也占地方），未知项算进来（它确实在盘上）
  const totalBytes = [...known, ...unknown].reduce((n, e) => n + e.sizeBytes, 0);
  let bytes = totalBytes;
  let count = known.length + unknown.length;
  const wantBytes = Number.isFinite(maxBytes) && maxBytes > 0;
  const wantCount = Number.isFinite(maxCount) && maxCount > 0;

  const remove = [];
  for (const e of candidates) {
    const tooOld = now - e.mtimeMs > maxAgeMs;
    const tooBig = (wantBytes && bytes > maxBytes) || (wantCount && count > maxCount);
    if (!tooOld && !tooBig) continue;
    remove.push(e);
    bytes -= e.sizeBytes;
    count -= 1;
  }

  const gone = new Set(remove.map((e) => e));
  const keep = known.filter((e) => !gone.has(e)).concat(unknown);

  return {
    keep,
    remove,
    freedBytes: remove.reduce((n, e) => n + e.sizeBytes, 0),
    scanned: list.length,
    protectedRecent,
    protectedFloor,
    protectedUnknown: unknown.length,
    totalBytes,
  };
}

// ── 二、只读：量一个目录、扫一个根 ─────────────────────────

/**
 * 量一棵树：**整棵树里最新的 mtime** + 所有文件大小之和。
 *
 * ⚠️ 为什么 mtime 取"最新"而不是"目录自己的"：见文件头——
 * DSH 往文件里**原地追加**，目录 mtime 会落后于文件。取最新的那个，
 * "这份还在被写吗"才有意义。
 *
 * ⚠️ **不跟符号链接**（读到链接就抛）：跟出去就可能把"删这一份"变成
 * "删到 link 指着的另一处"。宁可这一份扫不动 ⇒ 不候选 ⇒ 不删。
 */
/**
 * 一个工作目录对应 DSH 里哪一组会话记录。
 *
 * ⚠️ 盘上是**两层**：`$DSH_HOME/sessions/<项目>-<路径slug>--/<一条记录>/`。
 *    顶层那层是**按项目分的组** ⇒ **组目录永远不是候选**，而"清哪一组"必须显式选。
 *    （2026-09-21 实测：不分组地清，会连**别的项目**和**这个 GUI 自己的**可 resume 记录一起删。）
 */
export function groupSlugFor(dir) {
  const parts = nodePath.resolve(dir).split(nodePath.sep).filter((s) => s !== '');
  return `--${parts.join('-')}--`;
}

export function measureTree(dir, { fs = nodeFs, depth = 0 } = {}) {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) throw new Error(`是符号链接，不跟着走：${dir}`);
  let mtimeMs = Number(st.mtimeMs) || 0;
  let sizeBytes = st.isFile() ? Number(st.size) || 0 : 0;
  if (!st.isDirectory() || depth >= MAX_SCAN_DEPTH) return { mtimeMs, sizeBytes };

  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = nodePath.join(dir, d.name);
    if (d.isSymbolicLink()) continue; // 同上：不跟
    if (d.isDirectory()) {
      const sub = measureTree(p, { fs, depth: depth + 1 });
      mtimeMs = Math.max(mtimeMs, sub.mtimeMs);
      sizeBytes += sub.sizeBytes;
    } else if (d.isFile()) {
      const s = fs.lstatSync(p); // 读不到就抛 ⇒ 整份不候选（安全的那一侧）
      mtimeMs = Math.max(mtimeMs, Number(s.mtimeMs) || 0);
      sizeBytes += Number(s.size) || 0;
    }
  }
  return { mtimeMs, sizeBytes };
}

/** 这个目录像不像"一份会话记录"：里面有 `session.*` 这样的文件。 */
function looksLikeSession(dir, fs) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .some((d) => d.isFile() && String(d.name).startsWith(SESSION_MARKER_PREFIX));
  } catch {
    return false;
  }
}

/**
 * 扫一个根目录，产出 `planPrune` 的输入。**只读，不删任何东西。**
 *
 * ⚠️ 盘上的真实形状是**两层**（实测）：
 * ```
 * $DSH_HOME/sessions/<项目>-<slug>--/<一条记录>/{session.lock, session.v3.jsonl.zstd}
 * ```
 * 顶层那些是**按项目分的组**（`--home-deploy-proj-bunny--`…），
 * 组目录本身**永远不是候选**——它是"别人的目录"，不是一份记录。
 * 所以：直接子目录里有 `session.*` 的当记录；否则当分组，再往下取一层。
 *
 * @returns {{entries: Array, unreadable: Array<{name, reason}>, missing: boolean}}
 *          `missing` = 这个根根本不存在（**不抛**：没有东西可清不是错误）。
 */
export function scanEntries({ root, fs = nodeFs } = {}) {
  const out = { entries: [], unreadable: [], missing: false };
  if (!root) return out;

  let kids;
  try {
    kids = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') out.missing = true;
    else out.unreadable.push({ name: String(root), reason: String(err?.message ?? err) });
    return out;
  }

  const add = (name, full) => {
    try {
      const m = measureTree(full, { fs });
      const lockPath = nodePath.join(full, LOCK_NAME);
      out.entries.push({
        name,
        path: full,
        mtimeMs: m.mtimeMs,
        sizeBytes: m.sizeBytes,
        lockPath: fs.existsSync(lockPath) ? lockPath : null,
      });
    } catch (err) {
      // 扫不动 ⇒ **不进计划**（进不了计划就删不到它）。但要说出来，不静默。
      out.unreadable.push({ name, reason: String(err?.message ?? err) });
    }
  };

  for (const d of kids) {
    if (!d.isDirectory() || String(d.name).startsWith('.')) continue; // 文件 / 链接 / 隐藏项都不候选
    const p = nodePath.join(root, d.name);
    if (looksLikeSession(p, fs)) {
      add(String(d.name), p);
      continue;
    }
    // 不是记录 ⇒ 当成"一层分组"，再取一层
    let subs;
    try {
      subs = fs.readdirSync(p, { withFileTypes: true });
    } catch (err) {
      out.unreadable.push({ name: String(d.name), reason: String(err?.message ?? err) });
      continue;
    }
    for (const c of subs) {
      if (!c.isDirectory() || String(c.name).startsWith('.')) continue;
      const cp = nodePath.join(p, c.name);
      if (!looksLikeSession(cp, fs)) continue;
      add(`${d.name}/${c.name}`, cp);
    }
  }
  return out;
}

// ── 三、真删 ───────────────────────────────────────────────

/** 默认的删除动作（可注入）。 */
export function defaultRm(p) {
  nodeFs.rmSync(p, { recursive: true, force: true });
}

/**
 * 照计划**真删**。
 *
 * 三道闸，缺一道都不删：
 *   ① **只删传进来的那个 `path`**。⚠️ 绝不用 `path.join(root, item.name)` 现拼——
 *      名字是外部数据（盘上的目录名），拿它拼路径就是**目录穿越**的入口。
 *      没给 `path` 的项直接跳过，不猜。
 *   ② `path` 必须在 `root` 底下（给了 `root` 的话）。防的是"计划被掉包"。
 *   ③ **删之前再量一遍**：mtime 和计划里不一样 ⇒ **它还在被写** ⇒ 跳过。
 *      这是"正在用的那一份"唯一能在删的瞬间被抓住的信号。
 *      另外还支持注入 `isLocked`（见 `probeLock`）——那一层比 mtime 更确定。
 *
 * @param {Array} removeList  `planPrune().remove`（带 `path` 与 `mtimeMs`）
 * @param {object} o
 * @param {Function} [o.rm]       删除动作，`(path) => void`。测试注入假的。
 * @param {string}   [o.root]     允许删的根（给了就做包含性校验）
 * @param {Function} [o.measure]  量法，默认 `measureTree`（**必须和扫的时候同一套**）
 * @param {Function} [o.isLocked] `(lockPath|null) => true|false|null`；null = 不知道
 * @param {object}   [o.fs]
 * @returns {{removed: Array, skipped: Array<{name, path?, reason, detail?}>, freedBytes: number}}
 *          `reason` 是给排障看的代号：`no-path` / `not-absolute` / `outside` /
 *          `locked` / `changed` / `gone` / `unreadable` / `error`。
 */
export function applyPrune(
  removeList,
  { rm = defaultRm, root = null, measure = measureTree, isLocked = null, fs = nodeFs } = {},
) {
  const list = Array.isArray(removeList) ? removeList : [];
  const rootAbs = root ? nodePath.resolve(String(root)) : null;
  const removed = [];
  const skipped = [];

  const skip = (item, reason, detail) =>
    skipped.push({ name: item?.name ?? '?', path: item?.path, reason, ...(detail ? { detail } : {}) });

  for (const item of list) {
    if (!item || typeof item.path !== 'string' || item.path === '') {
      skip(item, 'no-path'); // 没给可核对的路径 ⇒ 不猜（防目录穿越的第一条）
      continue;
    }
    if (!nodePath.isAbsolute(item.path)) {
      skip(item, 'not-absolute');
      continue;
    }
    const p = nodePath.resolve(item.path);
    if (rootAbs && p !== rootAbs && !p.startsWith(rootAbs + nodePath.sep)) {
      skip(item, 'outside');
      continue;
    }

    // ③ 删之前先问"有人在用吗"（锁最确定；探测不了就是 null = 不知道）
    if (typeof isLocked === 'function') {
      let locked = null;
      try {
        locked = isLocked(item.lockPath ?? null);
      } catch {
        locked = null; // 探测本身出错 ⇒ 只当"不知道"，不让它变成"可以删"
      }
      if (locked === true) {
        skip(item, 'locked');
        continue;
      }
    }

    // ③ 再量一遍：量法必须和扫的时候同一套，否则"没变"这句话没意义
    let nowStat;
    try {
      nowStat = measure(p, { fs });
    } catch (err) {
      skip(item, err?.code === 'ENOENT' ? 'gone' : 'unreadable', String(err?.message ?? err));
      continue;
    }
    if (Number(nowStat.mtimeMs) !== Number(item.mtimeMs)) {
      skip(item, 'changed'); // ★ 它刚又被写了 ⇒ 很可能正被用着
      continue;
    }

    try {
      rm(p);
      removed.push(item);
    } catch (err) {
      skip(item, 'error', String(err?.message ?? err));
    }
  }

  return {
    removed,
    skipped,
    freedBytes: removed.reduce((n, e) => n + (Number(e.sizeBytes) || 0), 0),
  };
}

// ── 四、锁探测（"正在用吗"最确定的那个信号）────────────────

/** 默认怎么跑 `flock`。抽出来是为了测试能注入。 */
export function defaultFlockRun(file, args, opts) {
  return spawnSync(file, args, opts);
}

/**
 * `session.lock` 上有没有别人的锁。三态，**不许把"不知道"说成"没人用"**。
 *
 * 实测（本机）：
 * ```
 * flock -n <正在跑的那份>/session.lock true   → exit 1（拿不到 = 有人在用）
 * flock -n <已经结束的那份>/session.lock true → exit 0（拿得到 = 没人用）
 * ```
 * 所以 `0 ⇒ false`、`1 ⇒ true`、其它（没有 `flock` 这个命令、文件没了…）⇒ `null`。
 *
 * ⚠️ `null` 在 `applyPrune` 里**不拦**删除：它只是**多出来的**一层，
 * 上面的保护窗 / 保底条数 / 删前重核不依赖它。但要**说出来**
 * （CLI 会打"锁探测用不了"），不能让人以为"查过锁了"。
 *
 * ⚠️ 只在**已经有** `session.lock` 的目录上探测：`flock` 打开文件时带 O_CREAT，
 * 对着一份没有锁文件的旧记录跑，会在人家的目录里**凭空造一个文件**出来。
 */
export function probeLock(lockPath, { run = defaultFlockRun } = {}) {
  if (!lockPath || typeof lockPath !== 'string') return null;
  let res;
  try {
    res = run('flock', ['-n', lockPath, 'true'], { stdio: 'ignore' });
  } catch {
    return null;
  }
  if (!res || res.error) return null; // 没有 flock 这个命令 ⇒ 不知道
  if (res.status === 0) return false;
  if (res.status === 1) return true;
  return null;
}

// ── 五、给人看的那一句 ─────────────────────────────────────

/** 字节数说成人话（`8.3 MB`）。 */
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let x = v;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  const s = i === 0 ? String(Math.round(x)) : String(Math.round(x * 10) / 10);
  return `${s} ${units[i]}`;
}

/**
 * 给**主人**看的一句话。
 *
 * ⚠️ **不许含内部词**（`docs/handbook/07-APPENDIX.md` §2.2 的禁用词表：
 * 工作区 / 口令 / 客户端 / 云端 / 服务器 / 调度器 / 时间线 / 作用域 / **会话** /
 * 工具 / 搜索 / 上下文 / 系统提示 / 模型 / 工具名…）。
 * 表里连"会话"都禁——所以这里说"**记录**"。
 * 这一条有测试（拿 `lib/models/forbidden_words.dart` 那张表来扫）。
 *
 * ⚠️ `applied` 这个开关不是装饰：真删完之后还说"现在还没动它们"就是**在说假话**。
 *    同一句话要能同时说清"这只是计划"和"已经做了"两种状态。
 *    ⚠️ 而且**真做的时候要用真做出来的那个数**（`done`）——"计划清 3 份"和
 *    "真动了 2 份"是两个数（有一份正被写着，跳过了）。混着说就是假话。
 *
 * @param {object} plan
 * @param {object} [o]
 * @param {boolean} [o.applied] 已经真删过了吗
 * @param {{removed: number, freedBytes: number, liveSkipped: number}} [o.done]
 *        真删的结果（只说 `applied: true` 而不给 `done` = "一份都没删掉"）
 */
export function summarize(plan, { applied = false, done = null } = {}) {
  const remove = Array.isArray(plan?.remove) ? plan.remove : [];
  if (!applied) {
    const freed = Number(plan?.freedBytes) || 0;
    if (remove.length === 0) return '现在没有该清的旧记录，一份都不用动。';
    return `${remove.length} 份旧记录可以清掉，能腾出 ${formatBytes(freed)}；现在还没动它们。`;
  }
  const count = Math.max(0, Number(done?.removed) || 0);
  const live = Math.max(0, Number(done?.liveSkipped) || 0);
  const freed = Number(done?.freedBytes) || 0;
  if (count === 0) {
    return live > 0 ? `这次一份都没清——有 ${live} 份还在用着。` : '这次没有该清的旧记录。';
  }
  const tail = live > 0 ? `；另有 ${live} 份还在用着，没动它` : '';
  return `清掉了 ${count} 份旧记录，腾出 ${formatBytes(freed)}${tail}。`;
}
