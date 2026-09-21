// **钥匙文件住哪** —— 这条规则**只有这一处**（契约 `docs/dev/46-KEY-DELIVERY.md` §二）。
//
// ── 为什么单立一个模块 ────────────────────────────────────
// 2026-09-21 真机当场栽的：我把这条规则写在**入口** `entry.mjs` 里，而
// **入口是镜像里生成的东西**（`build-tenant-image.sh` 写进 `$R/app/entry.mjs`），
// **不属于产品层** ⇒ 那条改动**根本没生效**：
// 容器里那个服务的 env 仍然是旧的 tmpfs 路径（`HUPO_KEY_FILE=/run/hupo/creds.yaml`），
// 而 `put-key`（另一个进程）按新规则写进了卷里 ⇒ **放钥匙的说放好了、用钥匙的还在看 tmpfs**。
// ⇒ 规矩：**"钥匙住哪"住在产品层**，而且**只有这一处**。
//    （凡是要改容器行为的，都得是产品层能改的东西 —— 不然每次都要重造镜像。）
//
// ── 规则 ──────────────────────────────────────────────────
//     `HUPO_KEY_PATH` 给了就听它；否则 **`<HUPO_DATA>/creds.yaml`**（= 卷里）。
//
// 🔴 **故意不读 `HUPO_KEY_FILE`**：那是**镜像里的旧 env**，指的是 tmpfs。
//    认它一次，就等于把钥匙写回一个"重建容器就没了"的地方 —— 那正是这一篇要消灭的事。

import nodePath from 'node:path';

/** 显式覆盖用的名字（**新起的** —— 旧名字指的是 tmpfs，不许再用）。 */
export const KEY_PATH_ENV = 'HUPO_KEY_PATH';

/** 容器里那个数据目录（卷）。 */
export const DATA_ENV = 'HUPO_DATA';

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {string} 钥匙文件的绝对路径
 */
export function keyFileFor(env = process.env) {
  return env[KEY_PATH_ENV] ?? nodePath.join(env[DATA_ENV] ?? '/data', 'creds.yaml');
}

/**
 * **那条旧的 tmpfs 路径**（镜像里那条 env 指的就是它）。
 *
 * ⚠️ 它在这里**只有一个用途**：认出来、**并且不认它**（见 `adoptKeyFile`）。
 *    镜像里那个旧入口会把 `keyFile: '/run/hupo/creds.yaml'` **显式传进来**，
 *    而"显式的值优先"会把规则顶掉 ⇒ 钥匙写进 tmpfs ⇒ 容器日志说"拿到凭据了"，
 *    而**卷里没有那个文件**（2026-09-21 真机连栽两层，第二层就是这个）。
 */
export const LEGACY_TMPFS_KEY_FILE = '/run/hupo/creds.yaml';

/**
 * 定夺最后用哪个文件：**产品层说了算**。
 *
 *  - 没给 / 给的是那条旧路径 ⇒ 按规则算（`keyFileFor()`）；
 *  - 给了别的 ⇒ 听它的（那是调用方**显式**的选择，测试与将来换布局都要这个口子）。
 */
export function adoptKeyFile(candidate, env = process.env) {
  const c = typeof candidate === 'string' ? candidate.trim() : '';
  if (!c || c === LEGACY_TMPFS_KEY_FILE) return keyFileFor(env);
  return c;
}
