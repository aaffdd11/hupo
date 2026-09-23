// **产品层**（宿主这一侧读它）—— 契约 `docs/dev/45-TENANT-UPDATE.md`。
//
// 产品（调度器 `src/` + 人格 + 能力 + 代理 patch）**不在镜像里**，而是宿主上一个目录
// （`/srv/hupo/tenant-code/<指纹>/`），建容器时**只读**挂进 `/app/code`。
// ⇒ 改进产品 = 写文件 + 让那一台重开一次。
//
// ── 这一份只做两件事 ───────────────────────────────────────
//   ① **读**当前那一版（`current/manifest.json`）；
//   ② **比**"某一台自报的版本"与"当前这一版"，并给出**要不要叫它重开**。
//
// ⚠️ **它不自己算指纹**：算指纹的地方**只有一处**（`scripts/build-tenant-code.sh`）。
//    两处算 = 一定会漂 —— 这个项目已经栽过两次（`3.req.cancel`、仓库根算错一级），
//    两次都是"两边单测全绿、而东西对不上"。
// ⚠️ **读不到就是读不到**（返回 `null`），不许猜一个默认值糊过去。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

/** 产品层目录（`--root` 可覆盖，测试用）。 */
export const DEFAULT_CODE_ROOT = '/srv/hupo/tenant-code';

/** 兜底那一份（镜像里的）自报的版本就是它。 */
export const FALLBACK_BUILD = 'dev';

/**
 * 读当前那一版。**读不到返回 `null`**（不抛）。
 *
 * @param {object} [o]
 * @param {string} [o.root]
 * @param {import('node:fs')} [o.fs]
 * @returns {{fingerprint:string, builtAt:string|null, gitRev:string|null, dir:string}|null}
 */
export function readProductLayer({ root = process.env.HUPO_CODE_ROOT ?? DEFAULT_CODE_ROOT, fs = nodeFs } = {}) {
  const link = nodePath.join(root, 'current');
  let dir = link;
  try {
    dir = fs.realpathSync(link); // 软链 → 真目录（`current` 指到哪一版）
  } catch {
    return null; // 还没翻过任何一版
  }
  let man;
  try {
    man = JSON.parse(fs.readFileSync(nodePath.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
  const fp = man?.fingerprint;
  if (typeof fp !== 'string' || !fp) return null;
  return {
    fingerprint: fp,
    builtAt: typeof man?.builtAt === 'string' ? man.builtAt : null,
    gitRev: typeof man?.gitRev === 'string' ? man.gitRev : null,
    dir,
  };
}

/**
 * 一台自报的版本 vs 当前那一版。**纯函数**（`test/unit` 里真验）。
 *
 * 三种"不一样"，而且**每一种都要说出来**（这是这套东西最该防的状态：
 * 一台悄悄跑着旧的，而两边都以为没事）：

 *   `same`        这一台就是当前那一版
 *   `unversioned` 🔴 它**自报不出产品层的版本**（报的是空 / `dev`）——
 *                 要么挂载没进去、要么那一版里没有 `manifest.json`。
 *                 ⚠️ **2026-09-23（账 #42）之前**这一档叫 `fallback`，意思是
 *                 "它跑的是**镜像里那份兜底**"；**兜底已经拿掉**（镜像里不再有 `src/`，
 *                 认不到产品层直接起不来）⇒ 那个意思已经不成立，名字与话都跟着改。
 *   `stale`       它跑的是**另一个版本**（产品层翻过了，它还没重开）
 *   `unknown`     宿主自己读不到当前那一版 ⇒ **不敢叫任何人重开**（叫了就是让它们去挂一个不存在的东西）
 *
 * @returns {{verdict:'same'|'unversioned'|'stale'|'unknown', reload:boolean, line:string}}
 */
export function compareTenantBuild({ reported, current }) {
  if (!current) {
    return {
      verdict: 'unknown',
      reload: false,
      line: '读不到当前产品层（宿主上还没翻过任何一版）——先跑 scripts/build-tenant-code.sh',
    };
  }
  const r = typeof reported === 'string' ? reported : '';
  if (!r || r === FALLBACK_BUILD) {
    return {
      verdict: 'unversioned',
      reload: true,
      // ⚠️ 这句要说**两种**可能（挂载没进去 / 那一版里没有 manifest），
      //    不许再写"跑的是镜像里那份兜底" —— 那份兜底 2026-09-23 已经拿掉了。
      line: `这一台**自报不出产品层的版本**（自报「${r || '空'}」）—— 要么挂载没进去，要么那一版里没有 manifest.json（当前那一版是 ${current}）`,
    };
  }
  if (r !== current) {
    return {
      verdict: 'stale',
      reload: true,
      line: `这一台跑的是 ${r}，当前是 ${current}`,
    };
  }
  return { verdict: 'same', reload: false, line: `这一台跑的就是当前那一版（${current}）` };
}

/**
 * 多久扫一遍"有没有哪台还在旧版上"。
 *
 * 🔴 **为什么非要有这个扫描**（2026-09-21 真机才看出来的）：
 *    "比版本"原来只挂在 **`tunnel-ready`** 上 —— 而那条隧道是**长连接**，
 *    一直连着就不会再报一次。⇒ **翻完 `current`，正在跑的那几台谁都不知道**
 *    （要等宿主重启、或者它自己断线重连）。那等于这条功能只在"碰巧重连"时成立。
 *    ⇒ 宿主自己**隔一会儿比一遍**，不一致就把那一帧发过去（发重了没害处：
 *      容器那边只认一次，而且它只在**空闲**时才真的退）。
 */
export const ROLLOUT_SWEEP_MS = 30_000;

/**
 * 扫一遍：哪些租户该被叫一声。**纯函数**。
 *
 * @param {object} o
 * @param {Iterable<[string, string]>} o.reports  租户 → 它自报的版本
 * @param {string|null} o.current                 当前产品层的版本
 * @returns {Array<{tenant:string, verdict:string, line:string}>}
 */
export function planRollout({ reports, current }) {
  const out = [];
  for (const [tenant, reported] of reports ?? []) {
    const v = compareTenantBuild({ reported, current });
    if (v.reload) out.push({ tenant, verdict: v.verdict, line: v.line });
  }
  return out;
}

/**
 * "哪台、为哪一版，已经**说过**了" —— 只管**日志**，不管发不发。
 *
 * ⚠️ 为什么要分开：那一帧**发重了没害处**（容器只认一次），但**日志刷屏有害处**
 *    —— 每 30 秒报一遍同一件事，真正的新消息就被淹掉了（这个项目最忌那个）。
 */
export function createNagBook() {
  const seen = new Map();
  return {
    /** @returns {boolean} 这一条**要不要打出来**（同一台 + 同一版只说一次） */
    take(tenant, fp) {
      const key = `${tenant}\u0000${fp ?? ''}`;
      if (seen.has(key)) return false;
      seen.set(key, true);
      return true;
    },
    /** 它报上了当前这一版 ⇒ 把这台的记录清掉（下一版还要能提醒）。 */
    forget(tenant) {
      for (const k of [...seen.keys()]) if (k.startsWith(`${tenant}\u0000`)) seen.delete(k);
    },
    get size() {
      return seen.size;
    },
  };
}
