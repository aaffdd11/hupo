// **"用他自己那把钥匙，不花钱地验一次"** —— 只住这一处（v3.0 · 主人 2026-10-07）。
//
// 与 `image-use.js` / `video-use.js` 同一条形状、同三条纪律：
//   ① 🔴 **钥匙只往上游去**：返回值里没有它，日志里也没有；
//   ② 🔴 **他自己那把优先**（`data/creds/<他>.yaml`），而且与真那条路**同一个借用规则**
//      —— 视频那栏空着就借图片那把（`creds.mjs` 的 `sharedKeyOf`；两处不各写一份）；
//   ③ **失败说人话**（`ark-check.js` 的 `arkCheckWords`），认不出就如实说认不出。
//
// ⚠️ **为什么单独一个文件**：`ark-check.js` 是**纯的**（只依赖 `image.js` / `video.js`），
//    因为 `scripts/check-ark-*.mjs` 那两个探针要 import 它里面的 `authClassOf()`
//    —— 探针不该被"凭据存哪"这种事拖进来。凭据那一层就住在这里。

import { credsFor } from './creds-store.js';
import { sharedKeyOf } from './creds.mjs';
import { ARK_CHECK_TIMEOUT_MS, arkCheckWords, checkArkKey } from './ark-check.js';
import { DEFAULT_IMAGE_URL } from './image.js';
import { DEFAULT_VIDEO_BASE } from './video.js';

/**
 * 造一个 `checkKey(userId)`。
 *
 * @param {object} o
 * @param {string} o.dataDir
 * @param {object} [o.env]   进程环境（端点在那上面可配）
 * @param {Function} [o.fetch]  注入用（判据里换掉它 ⇒ 不联网、不花钱）
 * @param {(m:string)=>void} [o.log]  **只收"谁、哪两条通没通、多久"** —— 绝不含钥匙
 * @returns {(userId:string) => Promise<{ok:boolean, image:string, video:string, why:string|null, text:string, ms:number}>}
 */
export function makeCheckKey({ dataDir, env = process.env, fetch = globalThis.fetch, log = () => {} } = {}) {
  return async function checkKey(userId) {
    // ⚠️ 用 `credsFor`：盒子里那份是**单文件**（P1-29）
    // 🔴 **`env` 必须一起传下去**（`#174` · 2026-09-27，与 `asr-creds.js` / `image-use.js` 同一个坑）：
    //    "盒子里读那份单文件"那一支只在 `env.HUPO_ROLE === 'tenant'` 时才走，
    //    而 `credsFor` 的 `env` 默认**空对象** ⇒ 不传 = 盒子里永远说"没有钥匙"。
    let mine = {};
    try {
      mine = credsFor({ dataDir, sub: userId, env }).values;
    } catch {
      mine = {};
    }
    const key = sharedKeyOf(mine, 'video');
    if (key === '') {
      const r = { ok: false, image: 'no', video: 'no', why: 'no-key', ms: 0 };
      return { ...r, text: arkCheckWords(r) };
    }
    const r = await checkArkKey({
      key,
      // ⚠️ 端点与真那两条路**同一组 env 名**（`HUPO_IMAGE_URL` / `HUPO_VIDEO_BASE`）——
      //    名字只住 `image.js` / `video.js` 那两个默认值旁边，这里只做"能不能覆盖"
      imageUrl: env.HUPO_IMAGE_URL || DEFAULT_IMAGE_URL,
      videoBase: env.HUPO_VIDEO_BASE || DEFAULT_VIDEO_BASE,
      fetch,
      timeoutMs: ARK_CHECK_TIMEOUT_MS,
    });
    log(`🔎 ${userId} 验钥匙：画图 ${r.image} · 视频 ${r.video}${r.ms ? ` · ${r.ms}ms` : ''}`);
    return r;
  };
}
