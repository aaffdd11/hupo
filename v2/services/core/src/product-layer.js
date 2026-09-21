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

 *   `same`     这一台就是当前那一版
 *   `fallback` 它跑的是**镜像里那份兜底**（宿主压根没给它挂产品层，或者挂的目录里没有）
 *   `stale`    它跑的是**另一个版本**（产品层翻过了，它还没重开）
 *   `unknown`  宿主自己读不到当前那一版 ⇒ **不敢叫任何人重开**（叫了就是让它们去挂一个不存在的东西）
 *
 * @returns {{verdict:'same'|'fallback'|'stale'|'unknown', reload:boolean, line:string}}
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
      verdict: 'fallback',
      reload: true,
      line: `这一台跑的是**镜像里那份兜底**（自报「${r || '空'}」），不是产品层 ${current}`,
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
