// **磁盘巡检的接线**（P2-12 · 主人 2026-09-25 拍板「① 接线」）。
//
// ── 它接的是什么 ──────────────────────────────────────────
// 手册 `08-SPEC.md` §11.4b 那张表：**定时任务 · 5 分钟一次 ·
// 80% 告警 / 88% 自动清 / 92% 拒新重活 / 95% 优雅拒绝新会话**。
// 规则那一半**早就有了**（`src/disk-grade.js` ＋ 4 条判据，含"与手册逐条对表"）
// ⇒ 这一步只做**接线**：周期采样**磁盘 / inode / fd**，按那张表**分级**。
//
// 🔴 ── 三条不许破 ────────────────────────────────────────
//   ① **不改运行时**：这一版**只分级、只告警**。手册上 88 那一档写着"自动清"、
//      92/95 写着"拒活"，而主人拍的是"**不改运行时（不拒活、不清盘）**" ⇒
//      这个模块**不删一个文件、不写一个文件、不拦一次活、不拒一次新会话**。
//      判据的反例就在 `test/disk-watch.test.js`：往注入的 `fs` 里塞一个
//      "一删就抛"的 `rmSync` ⇒ 巡检跑完**一次都不许碰它**。
//   ② **算不出来就说算不出来**：拿不到用量 ⇒ 那一项 `unknown`，
//      **绝不许**当成 `ok`（`disk-grade.js` 顶上那条，同款）。
//   ③ **周期与阈值住代码**：周期是这个常量（手册说"5 分钟一次"，判据与手册对表）；
//      四档阈值**只在** `disk-grade.js` 里有一处（这里连数字都不抄）。
//
// ⚠️ **它住在服务进程里**（`serve.js` 起一个定时器）⇒ 定时器必须 `unref()`，
//    否则它会拖住进程退出（清爽收工）。

import nodeFs from 'node:fs';

import { diskGrade, usedPercentOf } from './disk-grade.js';

/**
 * 多久采一次。**手册写"5 分钟一次"**（`08-SPEC.md` §11.4b）——
 * 数值只住这一处，判据拿手册那一行与它对表（改了手册或改了这里 ⇒ 红）。
 */
export const SAMPLE_INTERVAL_MS = 5 * 60 * 1000;

/** 默认从哪儿读 fd 数（本进程的）。 */
export const PROC_FD_DIR = '/proc/self/fd';
/** 默认从哪儿读 fd 上限。 */
export const PROC_LIMITS_FILE = '/proc/self/limits';

/** 占比（0–100）；拿不到 ⇒ `null`（**不是 0**）。 */
export function percentUsed({ total, free } = {}) {
  const t = Number.isFinite(total) ? total : NaN;
  const f = Number.isFinite(free) ? free : NaN;
  if (!(t > 0) || !(f >= 0) || f > t) return null;
  return ((t - f) / t) * 100;
}

/**
 * **采一次**（磁盘 / inode / fd）。纯读，**不写任何东西**。
 *
 * ⚠️ 每一项各自独立：磁盘读得到、inode 读不到 ⇒ 只有 inode 是 `unknown`，
 *    不许因为一项失败就把整趟丢掉（那就成了"因为看不见而当成没事"）。
 *
 * @param {object} [o]
 * @param {import('node:fs')} [o.fs]
 * @param {string} o.dataDir        看哪一块盘（数据目录所在的文件系统）
 * @param {string} [o.fdDir]        数 fd 的目录（默认 `/proc/self/fd`）
 * @param {string} [o.limitsFile]   读 fd 上限的文件（默认 `/proc/self/limits`）
 * @param {()=>number} [o.now]
 * @returns {{at:number, disk:object, inode:object, fd:object}}
 */
export function sampleUsage({
  fs = nodeFs,
  dataDir,
  fdDir = PROC_FD_DIR,
  limitsFile = PROC_LIMITS_FILE,
  now = Date.now,
} = {}) {
  const sample = {
    at: now(),
    disk: { totalBytes: null, freeBytes: null, percent: null, why: '' },
    inode: { total: null, free: null, percent: null, why: '' },
    fd: { open: null, limit: null, percent: null, why: '' },
  };

  // ── 磁盘 ＋ inode：一次 `statfs`
  try {
    const st = fs.statfsSync(dataDir);
    sample.disk.totalBytes = st.bsize * st.blocks;
    sample.disk.freeBytes = st.bsize * st.bfree;
    sample.disk.percent = usedPercentOf({ totalBytes: sample.disk.totalBytes, freeBytes: sample.disk.freeBytes });
    if (sample.disk.percent === null) sample.disk.why = '这一块盘报出来的数字对不上（算不出来）';
    sample.inode.total = st.files;
    sample.inode.free = st.ffree;
    sample.inode.percent = percentUsed({ total: st.files, free: st.ffree });
    if (sample.inode.percent === null) sample.inode.why = '这个文件系统没报 inode 总数（算不出来）';
  } catch (err) {
    const why = `读不出来（${err?.code ?? err?.message ?? err}）`;
    sample.disk.why = why;
    sample.inode.why = why;
  }

  // ── fd：数一数 `/proc/self/fd`，再读一下软上限
  try {
    sample.fd.open = fs.readdirSync(fdDir).length;
  } catch (err) {
    sample.fd.why = `fd 数不出来（${err?.code ?? err?.message ?? err}）`;
  }
  try {
    sample.fd.limit = readFdLimit(fs.readFileSync(limitsFile, 'utf8'));
  } catch (err) {
    sample.fd.why = sample.fd.why || `fd 上限读不出来（${err?.code ?? err?.message ?? err}）`;
  }
  if (sample.fd.open !== null && sample.fd.limit !== null) {
    sample.fd.percent = percentUsed({ total: sample.fd.limit, free: sample.fd.limit - sample.fd.open });
    if (sample.fd.percent === null) sample.fd.why = 'fd 数比上限还大（算不出来）';
  }
  return sample;
}

/**
 * 从 `/proc/self/limits` 的正文里取 **`Max open files` 那一行的软上限**（纯函数）。
 * ⚠️ 认不出 ⇒ `null`（**不猜**）。⚠️ `unlimited` 也算认不出（那不是一个能算占比的数）。
 *
 * @param {string} text
 * @returns {number|null}
 */
export function readFdLimit(text) {
  const line = String(text ?? '').split('\n').find((l) => /^Max open files\b/.test(l.trim()));
  if (!line) return null;
  const m = line.trim().match(/\s(\d+)\s/); // 形如 `Max open files  1024  1048576  files`
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 三项各自分级（**阈值只在 `disk-grade.js` 里**）。
 *
 * @returns {{disk:object, inode:object, fd:object}} 每一项是 `diskGrade()` 的返回值
 */
export function gradeSample(sample) {
  return {
    disk: diskGrade(sample?.disk?.percent),
    inode: diskGrade(sample?.inode?.percent),
    fd: diskGrade(sample?.fd?.percent),
  };
}

/** 给人看的一句话（日志/告警用）。**不含内部词**，只有资源名与百分数。 */
export function describeGrade(resource, g) {
  if (!g) return `${resource}：认不出`;
  if (g.grade === 'unknown') return `${resource}：**算不出来**（不当成"没事"）`;
  return `${resource} ${g.percent.toFixed(1)}% ⇒ ${g.grade}（手册这一档写着：${g.action}）`;
}

/**
 * **起一个巡检**（周期采样 + 分级告警）。
 *
 * 🔴 **它只报警，不动手**：手册上 88/92/95 三档写着"清 / 拒活 / 拒新会话"，
 *    而 P2-12 明说"不改运行时" ⇒ 这里**只**把级别与"手册上这一档该做什么"
 *    说出来（`log` / `onGrade`），**一次动作都不执行**。要做动作，
 *    是**另一件要单独拍板的事**（那会改运行时行为）。
 *
 * @param {object} [o]
 * @param {string} o.dataDir
 * @param {import('node:fs')} [o.fs]
 * @param {(m:string)=>void} [o.log]
 * @param {(e:object)=>void} [o.onGrade]  每一档非 ok 各回调一次（**回调失败不影响别的**）
 * @param {number} [o.intervalMs]         默认住 `SAMPLE_INTERVAL_MS`（测试可注入小值）
 * @param {typeof setInterval} [o.setIntervalFn]
 * @param {typeof clearInterval} [o.clearIntervalFn]
 * @param {typeof sampleUsage} [o.sampleFn]
 * @param {()=>number} [o.now]
 * @returns {{tick:()=>object|null, stop:()=>void, last:()=>object|null, intervalMs:number}}
 */
export function startDiskWatch({
  dataDir,
  fs = nodeFs,
  log = () => {},
  onGrade = null,
  intervalMs = SAMPLE_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  sampleFn = sampleUsage,
  now = Date.now,
} = {}) {
  let last = null;

  /** 采一次 + 分级告警。**采不出来也只记一句**，绝不抛给调用方。 */
  function tick() {
    let sample;
    try {
      sample = sampleFn({ fs, dataDir, now });
    } catch (err) {
      log(`  ⚠️ 巡检这一趟没采成：${err?.message ?? err}`);
      return null;
    }
    last = sample;
    const graded = gradeSample(sample);
    for (const [resource, g] of Object.entries(graded)) {
      if (g.grade === 'ok') continue;
      // 🔴 这一行就是"分级告警"本体 —— **没有动作**（见文件头 ①）。
      try {
        log(`  ⚠️ ${describeGrade(resource, g)}`);
      } catch {
        /* 日志坏了不许把巡检带走 */
      }
      if (typeof onGrade === 'function') {
        try {
          onGrade({ resource, ...g, at: sample.at ?? now() });
        } catch {
          /* 旁路：告警回调出事不许影响别的资源、更不许影响服务 */
        }
      }
    }
    return sample;
  }

  const timer = setIntervalFn(tick, intervalMs);
  // ⚠️ 不 `unref` 的话，这个定时器会拖住进程退出（收工就卡在这儿）。
  timer?.unref?.();
  // 起手先采一次：不然"刚出事的头 5 分钟"是盲的。
  tick();

  return {
    tick,
    intervalMs,
    last: () => last,
    stop() {
      try {
        clearIntervalFn(timer);
      } catch {
        /* 已经没了 */
      }
    },
  };
}
