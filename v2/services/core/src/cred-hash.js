// **凭据哈希**（D4.24 · A3·补 · 2026-10-03 定）：把一个身份（`sub`）换成
// 一个**同一个部署里稳定、能对账、又推不回明文**的假名，专门给审计账用。
//
// ── 为什么不是裸 `sha256(sub)` ─────────────────────────────
// 🔴 `sub` 是**可枚举**的（`u1`/`u2`/…，见 `users.js` 的 `u${n}`；盘上 `data/users/`
//    就摆着 `u1` `u2` `u3`）⇒ `sha256("u1")` 谁都能算出来 ——
//    那种"哈希"等于把明文换个写法，**反推只要一秒钟**（`90` §5.3 已经点过这一条）。
// ⇒ 必须是**带密钥**的（HMAC）：同一把键 ⇒ 同一身份每次都落到同一个值（能对账）；
//    手里没有那把键 ⇒ 推不回（判据：换一把键，同一个人的值就变）。
//
// ── 键从哪来 ───────────────────────────────────────────────
//   生产由 `serve.js` 把**制品的签名键**（`appsSignKey`，0600、跨重启稳定）接上；
//   审计与入口签名**共用一把键、两种用途** ⇒ 用消息前缀做**域分离**，
//   一份用途的输出不许顶替另一份。
//
// ⚠️ **没接线时**（单测 / 老调用方 `new Apps({dir, sub})`）退化成一个**常量键**：
//    值仍然稳定、也不是明文，但常量谁都能知道 ⇒ 理论上可穷举反推。
//    ⇒ 所以生产**必须**把真键接上；`test/app-entry-identity.test.js` 有一条判据钉这个接线。

import nodeCrypto from 'node:crypto';

/** 域分隔前缀：把"凭据哈希"与入口签名的 payload（`sub|id|version|exp`）分开。 */
export const CRED_HASH_DOMAIN = 'hupo-cred-v1';

/**
 * 没接线时用的退化键（**常量**）。
 *
 * 🔴 它只是"别让没接线的调用方炸掉"的兜底，**不是**一条安全边界 ——
 *    生产的键由 `serve.js` 用 `appsSignKey` 接上（见本文件卷首）。
 */
export const CRED_HASH_FALLBACK_KEY = 'hupo-cred-fallback-key-v1';

/**
 * 算一个身份的凭据哈希（十六进制，64 位）。
 *
 * @param {string|null|undefined} sub 身份（`owner` / `u1` / …）；空 ⇒ `null`（不许编一个出来）
 * @param {Buffer|string|null} [key]  凭据键（生产 = `appsSignKey`；不给 ⇒ 退化键）
 * @returns {string|null} 稳定假名；`sub` 为空 ⇒ `null`
 */
export function credHashOf(sub, key = null) {
  if (sub === null || sub === undefined || sub === '') return null;
  const k = key === null || key === undefined || key === '' ? CRED_HASH_FALLBACK_KEY : key;
  return nodeCrypto
    .createHmac('sha256', k)
    .update(`${CRED_HASH_DOMAIN}|${String(sub)}`)
    .digest('hex');
}
