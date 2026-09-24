// **这个数据目录现在有人攥着吗** —— 迁移脚本必须问的那一句。
//
// 契约：`docs/dev/88-P1-TIME-WAIT.md` §四 **T6**（合并与重开绑定）。
//
// ── 它挡的是哪一起事故（`00-PROGRESS.md` #123 的实测记录）──────────
// 日志合并迁移（`scripts/merge-scope-logs.mjs`）会把那条日志**重新编号**
// （`main` 120 条 ＋ scope 4 条 ⇒ 124 条连续）。而 `store.append` **只管写**，
// `seq` 是 `Timeline` **在内存里**定的（`store.js` 的注释与 #123 都写着）。
// ⇒ 盒子**跑着的时候**合并：合并把号改成 1..124，而内存里那个 `Timeline`
//    还以为是 120 ⇒ 它下一条会写 **121**，与并进来的 121+ **撞号**，
//    下次开机 `verifyMonotonic` 判非单调 —— 而现场看起来只是"日志有点怪"。
//
// ⇒ 所以合并**只能在没人握着那条日志的时候**做：
//     ① 盒子重开（服务停着）—— 开机幂等那一步（`bootMergeIfPending`）；
//     ② 或者"并完必须触发盒子重开"这条硬约束（`merge-scope-logs.mjs --at-boot`）。
//
// ⚠️ **锁只是判据的一半**：它还看 `status.json` 新不新（服务忙着时每秒刷）。
//    两个都不在 ⇒ 冷。**认不出就当成热**（宁可不并，也不许撞号）——
//    这个方向是刻意的：拒绝并最多是"迁移晚一步"，撞号是**永久坏一条日志**。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { readStatus, STALE_MS } from './turn-status.js';

/** 那条锁叫什么（在数据目录下面）。 */
export const SERVE_LOCK = 'serve.lock';

export function serveLockPath(dataDir) {
  return nodePath.join(dataDir, SERVE_LOCK);
}

/**
 * 服务起来时写一把锁（**写不进去也不许挡住启动** —— 它只是迁移用的判据）。
 * @returns {boolean} 写上去了没有
 */
export function writeServeLock(dataDir, { fs = nodeFs, pid = process.pid, now = Date.now } = {}) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(serveLockPath(dataDir), `${JSON.stringify({ pid, at: now() })}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** 读那把锁。读不到 / 坏了 ⇒ `null`（**不猜**）。 */
export function readServeLock(dataDir, { fs = nodeFs } = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(serveLockPath(dataDir), 'utf8'));
    const pid = Number(j?.pid);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return { pid, at: Number.isFinite(Number(j?.at)) ? Number(j.at) : null };
  } catch {
    return null;
  }
}

/** 干净退场时把锁撤掉。 */
export function clearServeLock(dataDir, { fs = nodeFs } = {}) {
  try {
    fs.unlinkSync(serveLockPath(dataDir));
    return true;
  } catch {
    return false;
  }
}

/** 那个 pid 还活着吗（`kill(pid, 0)`）。⚠️ `EPERM` = 活着（只是不归我管）。 */
export function pidAlive(pid, { kill = process.kill } = {}) {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * 这个数据目录是不是**热的**（有服务正攥着内存里的 `Timeline`）。
 *
 * 判据（任一条成立 ⇒ 热）：
 *   ① `serve.lock` 在，而且那个 pid **活着**；
 *   ② `status.json` 还在刷（`updatedAt` 比 `staleMs` 新）。
 *
 * ⚠️ **认不出 ⇒ 热**（`null`/读不懂也算热）—— 见文件头：这个方向的错最便宜。
 */
export function isStoreHot(
  dataDir,
  { fs = nodeFs, now = Date.now, staleMs = STALE_MS, kill = process.kill } = {},
) {
  const lock = readServeLock(dataDir, { fs });
  if (lock && pidAlive(lock.pid, { kill })) {
    return { hot: true, why: `serve.lock 说 pid ${lock.pid} 还活着` };
  }
  // 锁不在 / pid 已经没了 ⇒ 再看状态文件新不新
  let text = null;
  try {
    text = fs.readFileSync(nodePath.join(dataDir, 'status.json'), 'utf8');
  } catch {
    text = null;
  }
  if (text === null) {
    return { hot: false, why: '既没有活着的锁，也没有状态文件 ⇒ 冷' };
  }
  const st = readStatus(text, { now: now(), staleMs });
  if (st === null) return { hot: true, why: '状态文件读不懂 ⇒ 当成热（宁可不并）' };
  if (st.stale) return { hot: false, why: `状态文件已经陈了（${st.ageMs}ms）⇒ 冷` };
  return { hot: true, why: `状态文件还在刷（${st.ageMs}ms 前）⇒ 服务还在` };
}
