// **一条会话什么时候该"翻一页"**（2026-10-06 · 主人：*「响应依然很慢」* ·
// 契约 `docs/dev/209-SESSION-ROTATE.md`）。
//
// ── 为什么要有它（量出来的，不是猜的）───────────────────────
//   他那一轮 23:14 的用量账：第一次模型调用 `uncachedInput 480,440` ＋ `cacheRead 8,960`
//   ⇒ **约 49 万 token 的上下文**。而那一轮从"话进来"到"第一个字"是 **19.6 秒**，
//   其中 **16.4 秒**就是那一次调用 —— 上游的 prompt 缓存过了（上一轮在 2 小时 23 分前）
//   ⇒ 整条上下文**现传**。
//
//   那 49 万 token 是哪来的：主对话那条 DSH 会话压缩后 **2.5 MB**、解开 **8.4 MB / 1679 行**
//   （261 条 assistant 消息 · 216 次工具调用 · 73 轮）—— 而我们每一轮都 `resume` 同一条
//   ⇒ **整条历史每一轮重发一遍**（聊得越久，第一段字越慢）。
//
// ⇒ 这一份就回答一件事：**这一轮的上下文多大 ⇒ 要不要翻页**。
//   翻页 = 把这一间的会话换成**下一条新的**（旧的那条文件原样留着，见 `rotateSessionFor`），
//   而"接得上"靠的是本来就有的那套：新实例第一次投递时把那段时间线（最近 40 句）喂回去。
//
// ── 三条纪律 ──────────────────────────────────────────────
//   ① **纯函数**（进 `test/unit` 那一档的速度；不碰盘、不认识人、不抛）；
//   ② **判据是"上一轮真的用了多少"**（上游回来的 usage），**不是**文件大小那种近似
//      —— 文件大小要解压才知道，而 usage 每一轮都在手边；
//   ③ 🔴 **认不出来 ⇒ 不翻**（`known === false` / 没有数 ⇒ 什么都不做）：
//      宁可不翻，也不许凭一个猜出来的数把对话换了。

import { normalizeUsage } from './usage.js';

/**
 * **什么时候翻页**：一轮的上下文超过这么多 token 就翻。
 *
 * 来历（`208` 那次真读数）：49 万 token ⇒ 冷传 16.4 秒。按这个比例，
 * 12 万 token 大致落在 **4 秒**上下，而"最近 40 句"那套记忆只占其中很小一块
 * ⇒ 翻页之后第一段字回到 **1~3 秒**那一档。
 * ⚠️ 数是**代码里的常量**（手册那条纪律：数值只住代码与决策记录里），
 *    要调就调这里；`cfg.sessionRotateTokens` 能给判据换一个小值。
 */
export const SESSION_ROTATE_PROMPT_TOKENS = 120_000;

/** 翻页失败之后的冷却（别每一轮都去撞同一件坏事）。 */
export const SESSION_ROTATE_RETRY_MS = 5 * 60 * 1000;

/**
 * 这一笔上游 usage 说明**这一轮的上下文有多大**（token）。
 *
 * 🔴 它就是 `uncachedInput + cacheRead`：两半合起来才是"送进去的全部"。
 *    （`cacheRead` 那个字段平时不进任何阈值 —— 那是**记账**那条线的规矩
 *      见 `usage.js` 的 `oneNumber()`；这里量的是**上下文体量**，两半都要算。）
 *
 * @param {object|null|undefined} raw 上游回来的 usage（形状见 `normalizeUsage`）
 * @returns {number|null} `null` = 认不出来（**不许猜 0**）
 */
export function promptTokensOf(raw) {
  // ① **已经是归一过的那三格**（`normalizeUsage()` 的产物，也是时间线上 `turn/usage`
  //    那条事件的 `usage`）—— 重启之后"上一轮多大"就是从它读回来的。
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const pick2 = (...names) => {
      for (const n of names) if (Number.isFinite(raw[n])) return raw[n];
      return null;
    };
    // ⚠️ `input` 是 **DSH 那个形状**（`inputTokens` ＝ **不含缓存**那半，
    //    与 `Anthropic` 同口径）—— 时间线上 `turn/usage` 那条事件里的 `usage`
    //    就是 `foldUsage()` 折出来的 `{input, output, cacheRead, …}`（见 `tool-rows.js`）。
    //    🔴 **漏认它就会只算一半**（只算 cacheRead）⇒ 小上下文的那几轮会被低估。
    // ⚠️ **只认这两种形状里那几个键**：`cacheReadTokens` 那种**原始**写法留给下面
    //    `normalizeUsage` 那一支（否则两半各取一个、口径就混了 —— 判据当场抓到过）。
    const u = pick2('uncachedInput', 'input');
    const c = pick2('cacheRead');
    if (u !== null || c !== null) return (u ?? 0) + (c ?? 0);
  }
  // ② 上游回来的**原始**形状（snake_case / camelCase 两种写法见 `normalizeUsage`）
  const n = normalizeUsage(raw);
  if (!n || n.known !== true) return null;
  return n.uncachedInput + n.cacheRead;
}

/**
 * 该不该翻页。
 *
 * @param {object} o
 * @param {number|null|undefined} o.promptTokens 上一轮那一次调用的上下文（`promptTokensOf`）
 * @param {number} [o.limit]
 * @returns {boolean}
 */
export function shouldRotateSession({ promptTokens, limit = SESSION_ROTATE_PROMPT_TOKENS } = {}) {
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) return false;
  const cap = Number.isFinite(limit) && limit > 0 ? limit : SESSION_ROTATE_PROMPT_TOKENS;
  return promptTokens > cap;
}
