// **排队那一帧的形状与认法**（契约 `docs/dev/117-QUEUE-VISIBLE.md`）。
//
// ── 它是给谁看的 ─────────────────────────────────────────────
// 主人在琥珀还在做上一件事的时候又发了一句 —— 服务端**早就**把那一句**排队**了
// （`dispatcher.js` 的 `#delivered` 票；DSH 实测 `agent/inbox/spliced {target:"next-turn"}`），
// 可屏幕上**一个字都没有**：他既看不见自己还排着什么，也撤不掉。
// 这一帧把那本账**如实报出来**（`queue/changed`），并给一条**撤掉一句**的回程
// （客户端→服务端 `{"t":"unsay","messageId":"m_…"}`）。
//
// ── 为什么单独一个模块 ──────────────────────────────────────
// 这一帧的**形状**（服务端推的那份）与**认法**（客户端→服务端那一帧）**只许有一处** ——
// 否则"推的那份"和"认的那份"各写一遍，迟早漂（`app-events.js` / `tool-rows.js` 顶上
// 同一条纪律：形状的唯一出处）。
//
// ── 🔴 三条硬规矩 ──────────────────────────────────────────
//   ① **瞬态**（`emitTransient`：不占号、不落盘、重连**不重放**）。
//      队列本身是**进程内、按房间**的：进程 / host 一重启就没了 —— 这是**如实的
//      行为，不是缺陷**（DSH 自己的文档也写着：控制面那个基线**不能跨宿主重启重建**）。
//      ⇒ 重连 / 刷新之后"现在还有什么在排队"只能靠 `client/hello` 那一刻的**快照**
//      （见 `server.js` 里发 `client/hello` 那一段）。
//   ② **`text` 是主人自己的原话**，截到 [QUEUE_TEXT_MAX] 个字符，截了就如实标
//      `truncated:true` —— **不发明、不摘要、不翻译**。
//   ③ **只有带 `messageId` 的票进得来**：没有 id 的既画不出也撤不掉
//      （撤那一帧就是按 `messageId` 认的）⇒ 报它反而是给一个按不动的按钮。

/** 事件名（上行 / 下行都只从这儿来）。 */
export const QUEUE_CHANGED = 'queue/changed';

/**
 * 一条排队消息里**说的那段话**最多留多少**字符**（不是字节）。
 *
 * ⚠️ 按**码点**数（`Array.from` 走的是迭代器）：按 UTF-16 码元切会把一个 emoji
 *    从中间劈开，而那半个代理项**连 JSON 都编不回去**（它就是一个坏字符串）。
 */
export const QUEUE_TEXT_MAX = 200;

/**
 * 把一段话截到 [QUEUE_TEXT_MAX] 个字符。
 *
 * ⚠️ **只截，不改**：返回的是原话的**前缀**（一个字都不许换、不许摘要）。
 * @returns {{text: string, truncated: boolean}}
 */
export function clipQueueText(raw) {
  const s = typeof raw === 'string' ? raw : '';
  const chars = Array.from(s);
  if (chars.length <= QUEUE_TEXT_MAX) return { text: s, truncated: false };
  return { text: chars.slice(0, QUEUE_TEXT_MAX).join(''), truncated: true };
}

/**
 * 一张票 → 一帧里那个 item。
 *
 * 🔴 **不认识的 / 已经认领的 / 没有 `messageId` 的 ⇒ `null`**（不进这一帧）：
 *    队列是"还没轮到它跑"的那些话，认领过的那张票已经不在队里了。
 * @param {object} t `dispatcher.js` 里那本 `#delivered` 的一张票
 */
export function queueItemOf(t) {
  if (!t || t.claimed === true) return null;
  const messageId = typeof t.messageId === 'string' ? t.messageId : '';
  if (messageId === '') return null;
  const { text, truncated } = clipQueueText(t.text);
  return {
    messageId,
    text,
    // ⚠️ `at` 认不出 ⇒ `null`（**不拿现在充一个** —— 那是编一个时间）。
    at: Number.isFinite(t.at) ? t.at : null,
    truncated,
  };
}

/**
 * 一帧的形状（**推送与判据都用它**）。
 *
 * 🔴 `count` **从 `items` 数出来**，不接受调用方另给一个数：
 *    两边一旦对不上，屏幕上那个"2 条"就会和它下面的一行不一致 —— 那是页面在说假话。
 * @param {object} o
 * @param {Array<object>} [o.items]
 */
export function queueChangedEvent({ items = [] } = {}) {
  const list = Array.isArray(items) ? items : [];
  return { type: QUEUE_CHANGED, items: list, count: list.length };
}

/**
 * 客户端→服务端那一帧：`{"t":"unsay","messageId":"m_…"}`。
 *
 * ⚠️ **认不出 ⇒ `null`**（调用方**安静忽略** —— 与 `focus` / `job-answer` 同一条纪律：
 *    认不出的帧不许把连接带走，也不许回一句我们编的话）。
 * ⚠️ `messageId` 空 / 不是字符串 ⇒ `null`（没有 id 就无从撤起）。
 */
export function parseUnsayFrame(raw) {
  let obj;
  try {
    obj = JSON.parse(typeof raw === 'string' ? raw : String(raw));
  } catch {
    return null; // 不是 JSON
  }
  if (!obj || typeof obj !== 'object') return null;
  if (obj.t !== 'unsay') return null;
  const messageId = typeof obj.messageId === 'string' ? obj.messageId.trim() : '';
  if (messageId === '') return null;
  return { messageId };
}
