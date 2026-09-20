// 开机标记：**上一次是怎么结束的**。手册 `08-SPEC.md` §11.1（崩溃环）。
//
// ── 它解决什么问题 ──────────────────────────────────────────
//
// `CrashLoopGuard` 的判据是"**窗口内启动 ≥3 次 且 上次有 oom-kill**"。
// 但它的状态**在内存里**（`process-guard.js` 的 `#starts`）——
// **每次重启都是一个新的 guard**，所以它**永远看不到重启环**。
// ⇒ 启动次数必须**落在盘上**，这就是这个文件。
//
// ── ⚠️ 我们认不出"oom-kill"，只能认出"没干净地退出" ──────────
//
// §11.1 的原话要读 `journalctl` 里有没有 oom-kill。**这台机器上服务不在 systemd 里**
// （`setsid nohup` 起的，`06-OPERATIONS.md` 说过），所以那条路走不通。
// ⇒ 退一步：**上一次有没有"干净退场"的标记**。
//
//     有标记   ⇒ 上次是收到 SIGTERM 好好走的
//     没标记   ⇒ 上次是**被硬杀的**（OOM / `kill -9` / 断电）
//
// ⚠️ 这是**保守的**读法：把"被硬杀"一律当成该降级的信号。
//    宁可多降级一次（不续做、只服务对话），也不要在一个崩溃环里
//    **反复重跑同一件活**——那正是 §11.1 说"降级期间不续做"的理由：
//    "崩溃环里继续续做只会放大问题"。
//
// ⚠️ 它**不许**因为文件坏了/没权限而挡住启动（同一个模块的 `reconcile.js` 也守这条）。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

/** 崩溃环窗口（§11.1：5 分钟内 ≥3 次启动） */
export const CRASH_WINDOW_MS = 5 * 60_000;
export const CRASH_THRESHOLD = 3;

const FILE = '.crashloop.json';

function pathFor(dataDir) {
  return nodePath.join(dataDir, FILE);
}

/** 读。**读不到 / 坏了 ⇒ 当成"第一次启动"**（不许抛）。 */
export function readCrashLoop(dataDir, { fs = nodeFs } = {}) {
  try {
    const raw = fs.readFileSync(pathFor(dataDir), 'utf8');
    const j = JSON.parse(raw);
    return {
      starts: Array.isArray(j?.starts) ? j.starts.filter((n) => typeof n === 'number') : [],
      // 上一次有没有留下"干净退场"的标记
      clean: j?.clean === true,
    };
  } catch {
    return { starts: [], clean: true }; // 没这个文件 ⇒ 没什么可疑的
  }
}

function write(dataDir, { starts, clean }, fs) {
  // ⚠️ 写不进去也不抛：崩溃环判定是**优化**，它坏掉不该让服务起不来。
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(pathFor(dataDir), `${JSON.stringify({ starts, clean })}\n`);
  } catch {
    /* 记不上就算了 —— banner 会报出来 */
  }
}

/**
 * 记一次启动，并回答"**该不该降级**"。
 *
 * ⚠️ 顺序要紧：**先读上一次的 `clean`，再写这一次的**。
 *    反过来的话，这一次的启动会把"上次是硬杀的"这个事实擦掉。
 *
 * @returns {{degraded: boolean, uncleanLastRun: boolean, starts: number}}
 */
export function recordStart(dataDir, { now = Date.now(), fs = nodeFs } = {}) {
  const prev = readCrashLoop(dataDir, { fs });
  const uncleanLastRun = prev.clean !== true;

  const starts = [...prev.starts, now].filter((t) => now - t < CRASH_WINDOW_MS);
  // ⚠️ 这次写下去 `clean: false` —— 意思不是"这次不干净"，而是
  //    "**这一次还没结束**"。等真干净退场了，`markCleanExit` 会把它翻过来。
  //    所以"下次开机读到 clean=false" = "这一次没善终"，这正是我们要的信号。
  write(dataDir, { starts, clean: false }, fs);

  return {
    degraded: starts.length >= CRASH_THRESHOLD && uncleanLastRun,
    uncleanLastRun,
    starts: starts.length,
  };
}

/** 干净退场（SIGTERM / SIGINT 走完优雅流程之后调）。 */
export function markCleanExit(dataDir, { fs = nodeFs } = {}) {
  const prev = readCrashLoop(dataDir, { fs });
  write(dataDir, { starts: prev.starts, clean: true }, fs);
}
