// **"该重开了"** —— 容器这一侧的那个决定（契约 `docs/dev/45-TENANT-UPDATE.md` §三）。
//
// ── 它回答的唯一问题 ──────────────────────────────────────
//   宿主说"有新的一版了"，那**什么时候**退？
//   答案：**手上这一轮说完之后**；等太久就照样退（和宿主重启自己那套一模一样）。
//
// ── 为什么是"容器自己退"，而不是"宿主去重启它" ─────────────
//   宿主（`deploy`）**没有**资格去动别人的 systemd 单元 —— 那正是这套设计一直守住的线。
//   ⇒ 宿主只能**经已有的那条通道说一句"重开吧"**，退不退由容器自己决定。
//   ⚠️ 那句话**不带任何内容**：它不是一个远程执行口。
//      宿主本来就已经决定容器跑什么代码（**镜像就是 `deploy` 造的**），
//      所以"叫它重开"**没有新增任何能力**；而"带载荷的重开"会新增 —— 所以不带。
//
// ── 什么时候**不**该退 ────────────────────────────────────
//   ① **还没跟宿主报过到**（`arm()` 之前）：那时宿主手上可能还挂着上一轮的"要它重开"，
//      一开机就退 ⇒ **开机死循环**。⇒ 报到之后才认这句话。
//   ② **它正在说话**：等它说完（最多等一个上限）。
//
// ⚠️ **"状态读不懂"照这个项目的既有规矩办**：`shouldWait` 对"读不懂 / 陈了"一律
//    **不等**（理由写在 `turn-status.js` 里：等一个已经不在的服务，比切一轮话更坏）。
//    我一开始想在这里反过来（读不懂就按忙算），**最后没那么做** ——
//    一个项目里住两套相反的规矩，下一个人一定会踩。

import nodeFs from 'node:fs';
import { readStatus, shouldWait } from './turn-status.js';

/** 多久看一眼"手上还有没有话"。一轮的边界本来就在秒级。 */
export const DEFAULT_POLL_MS = 1000;

/**
 * 最多等它说多久。**到点照样退**。
 *
 * ⚠️ 理由和 `restart-core.sh` 一字不差：**等一个卡住的服务，比切一轮话更坏**。
 *    对租户来说更明显：一个永远不落地的更新 = 这台**永远在旧代码上**。
 */
export const DEFAULT_MAX_WAIT_MS = 180_000;

/**
 * @param {object} o
 * @param {string} o.statusFile  容器里那份 `status.json`（`turn-status.js` 写的）
 * @param {(code:number)=>void} [o.exit]
 * @param {(m:string)=>void} [o.log]
 * @param {number} [o.pollMs]
 * @param {number} [o.maxWaitMs]
 * @param {()=>number} [o.now]
 * @param {import('node:fs')} [o.fs]
 */
export function createReloader({
  statusFile,
  exit = (code) => process.exit(code),
  log = (m) => console.log(m),
  pollMs = DEFAULT_POLL_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  now = Date.now,
  fs = nodeFs,
} = {}) {
  if (!statusFile) throw new Error('createReloader 需要 statusFile');
  let armed = false;
  let asked = false;
  let askedAt = 0;
  let timer = null;

  /** 手上还有没有没说完的话。**规矩是 `shouldWait` 定的**（见文件头那段）。 */
  const busyNow = () => {
    let text;
    try {
      text = fs.readFileSync(statusFile, 'utf8');
    } catch {
      // ⚠️ 文件**不在** = 那个服务还没写过它 = 还没起来 ⇒ **不忙**（可以退）。
      //    "读不懂"也走同一条路（`readStatus` → `null` → `shouldWait` 说别等）——
      //    这是**刻意的**：与 `turn-status.js` 那套规矩一致，不另立一套。
      return false;
    }
    return shouldWait({ status: readStatus(text, { now: now() }) });
  };

  const tick = () => {
    timer = null;
    if (!asked) return;
    if (!busyNow()) {
      log('  ✓ 手上没有没说完的话 —— 现在重开一次，去拿新的一版');
      return exit(0);
    }
    if (now() - askedAt >= maxWaitMs) {
      log('  ⚠️ 等太久了（它还在忙）—— 照样重开一次；那一轮没说完的，我认了');
      return exit(0);
    }
    timer = setTimeout(tick, pollMs);
    timer.unref?.();
  };

  return {
    /** 跟宿主报到过了（`tunnel-ready` 发出去了）⇒ 从现在起认"重开"这句话。 */
    arm() {
      if (armed) return;
      armed = true;
      if (asked && !timer) tick();
    },
    get armed() {
      return armed;
    },
    /**
     * 宿主说"有新的一版"。
     * @returns {boolean} 认了没有（`false` = 还没报到 / 已经在等它说完）
     */
    please() {
      if (!armed) {
        log('  · 宿主说要重开，可我还没跟它报过到 —— 先不认（防开机死循环）');
        return false;
      }
      if (asked) return false;
      asked = true;
      askedAt = now();
      log('  · 宿主说有新的一版 —— 等手上这轮说完就重开');
      tick();
      return true;
    },
  };
}
