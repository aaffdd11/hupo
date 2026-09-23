// **腾讯云混元 ASR 的签名**（`wss://asr.cloud.tencent.com/asr/v2/<appid>`）。
//
// 🔴 **`SecretKey` 只住在服务端**：这个模块算出来的 URL 里带着签名，
//    它只在**服务端到腾讯云**那一跳上用；**不许**下发给浏览器
//    （否则等于把密钥借出去，浏览器上谁都能拿去用我们的额度）。
//
// 这一段原来长在 `scripts/check-asr-tencent.mjs`（自测脚本）里 —— 2026-09-23
// 搬到这里，**因为自测脚本和真正转发的那条路必须是同一份实现**：
// 脚本自己算得对、而产品这条路另写一遍，那正是本项目栽过的
// "判据打在另一侧"（`docs/dev/16-STREAM.md` · 手册 §13.3 V13）。
// ⇒ 现在脚本 `import` 这一份，**判据只有一处**。
//
// 签名三步（照官方文档 §签名生成）：
//   ① 除 `signature` 外的参数**按字典序**拼成
//      `asr.cloud.tencent.com/asr/v2/<appid>?<排序后的查询串>`（**不含 `wss://`**）；
//   ② `signature = Base64(HMAC-SHA1(SecretKey, 签名原文))`；
//   ③ 把 `signature` **urlencode** 之后拼到 URL 末尾。
//
// ⚠️ **纯函数**：同一个输入必须算出同一个签名。
//    所以 `voice_id`（每次连接必须换新）**由调用方给**，不在这里生成 ——
//    自测脚本当场抓到过这个不纯（同输入两个签名）。

import nodeCrypto from 'node:crypto';

/**
 * 混元 ASR（内测版）那个引擎名。**唯一一处** —— 自测脚本、转发、文档都从这儿取。
 * ⚠️ 名字对不上服务端会直接拒（`code` 非 0），自测脚本会把原话打出来。
 */
export const DEFAULT_ASR_ENGINE = 'Hy-ASR-3.0-preview';

/**
 * 算签名原文与签名。
 *
 * @param {object} o
 * @param {string} o.appid      腾讯云 AppID（**不是** SecretId）
 * @param {string} o.secretId
 * @param {string} o.secretKey  ⚠️ 不许进日志、不许进文件
 * @param {string} [o.engine]   引擎名，默认 {@link DEFAULT_ASR_ENGINE}
 * @param {object} o.params     业务参数，**必须含 `voice_id`**（每次连接换新）
 * @param {number} [o.now]      毫秒时间戳（注入，便于判据）
 * @returns {{origin: string, signature: string, url: string}}
 */
export function signAsrUrl({
  appid,
  secretId,
  secretKey,
  engine = DEFAULT_ASR_ENGINE,
  params = {},
  now = Date.now(),
}) {
  const sec = Math.floor(now / 1000);
  const voiceId = params.voice_id;
  // ⚠️ **明着抛**，不要"没有就随便生成一个"：那会让这个函数不纯，
  //    而不纯的签名函数没法判（同输入两次算出两个签名）。
  if (!voiceId) throw new Error('signAsrUrl 要一个 voice_id（每次连接换新的 UUID）');
  const all = {
    engine_model_type: engine,
    // 有效期：给 60 秒够握手用（文档要求 expired > timestamp）
    expired: sec + 60,
    filter_empty_result: 0,
    needvad: 1,
    nonce: sec,
    secretid: secretId,
    timestamp: sec,
    voice_format: 1, // 1 = pcm
    ...params,
    voice_id: voiceId,
  };
  const sorted = Object.keys(all).sort();
  const query = sorted.map((k) => `${k}=${all[k]}`).join('&');
  const origin = `asr.cloud.tencent.com/asr/v2/${appid}?${query}`;
  const signature = nodeCrypto.createHmac('sha1', secretKey).update(origin).digest('base64');
  return { origin, signature, url: `wss://${origin}&signature=${encodeURIComponent(signature)}` };
}

/** 每次连接都要一个新的（文档要求）。**放在调用方**，好让上面那个函数保持纯。 */
export const newVoiceId = () => nodeCrypto.randomUUID();
