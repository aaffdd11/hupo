// **"用他自己那把钥匙去画一张图"** —— 只住这一处（P1-27 后半）。
//
// ⚠️ 为什么单立一份：这条路**有两个入口**，而"用谁的钥匙、失败了说什么"这条规则
//    **只许住一处**（两处各写一份 = 迟早漂）：
//      · `serve.js` 的 `POST /api/image`（配置页那个「试一张」）；
//      · 小程序那条通道上的 `draw` op（助手在聊天里画 —— 同一个 `generateImage`）。
//
// 🔴 三条不许破：
//   ① 钥匙**只往上游去**：返回值里没有它，日志里也没有；
//   ② **他自己那把优先**（`data/creds/<他>.yaml` 的 `HUPO_IMAGE_KEY`）——
//      没有就是"没填"，**不许**偷偷用别人那份（多租户要防的第一件事）；
//   ③ 失败**说人话**（`imageErrorWords`），而且**认不出就如实说认不出**。

import { readUserCreds } from './creds-store.js';
import { DEFAULT_IMAGE_MODEL, DEFAULT_IMAGE_URL, generateImage, imageErrorWords } from './image.js';

/**
 * 造一个 `drawImage(userId, prompt)`。
 *
 * @param {object} o
 * @param {string} o.dataDir
 * @param {object} [o.env]   进程环境（端点/模型名在那上面可配）
 * @param {Function} [o.fetch]  注入用（判据里换掉它 ⇒ 不联网、不花钱）
 * @param {(m:string)=>void} [o.log]  **只收"谁、成没成、多久"** —— 绝不含钥匙
 * @returns {(userId:string, prompt:string) => Promise<{ok:boolean, urls?:string[], why?:string, text?:string, ms?:number}>}
 */
export function makeDrawImage({ dataDir, env = process.env, fetch = globalThis.fetch, log = () => {} } = {}) {
  return async function drawImage(userId, prompt) {
    const mine = readUserCreds(dataDir, userId).values;
    const key = typeof mine.image === 'string' ? mine.image.trim() : '';
    if (key === '') {
      return { ok: false, why: 'no-key', text: imageErrorWords({ why: 'no-key' }) };
    }
    const r = await generateImage({
      key,
      prompt,
      model: env.HUPO_IMAGE_MODEL || DEFAULT_IMAGE_MODEL,
      url: env.HUPO_IMAGE_URL || DEFAULT_IMAGE_URL,
      size: env.HUPO_IMAGE_SIZE || '2K',
      fetch,
    });
    if (!r.ok) {
      log(`🖼 ${userId} 画图没成（${r.why}${r.ms ? ` · ${r.ms}ms` : ''}）`);
      return { ok: false, why: r.why, text: imageErrorWords(r), ms: r.ms };
    }
    log(`🖼 ${userId} 画好了：${(r.urls ?? []).length} 张（${r.ms}ms）`);
    return { ok: true, urls: r.urls, ms: r.ms };
  };
}
