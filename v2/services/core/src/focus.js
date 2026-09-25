// **焦点**（契约 `docs/dev/84-DISPATCHER-FOCUS.md` §三/§四 · C 期）。
//
// 手册 `02-ARCHITECTURE.md` §四 核心原则 3：**一个 WS 连接是物理约束**
// —— 不能每个会话/房间一条连接。所以客户端发过来的是**焦点**
// （"我正在看哪个图标"），**路由由服务端做**：
//
//   · 焦点那条的输出 ⇒ **现时投给用户**；
//   · 其它条的事件 ⇒ 照常进时间线（那条唯一的日志），**但不实时提醒**。
//
// 这个文件只放**判断**（纯函数，能反着验）。接线在 `server.js`：
// 收帧、按焦点订阅、切焦点补发那一间的历史（**不重连**）。
//
// ⚠️ **协议只加不改**（`03-DEVELOPMENT.md` §三）：`?scope=` 一个字没动，
//    只是语义收窄成"**初始焦点**"（老客户端照旧能连、能收自己那一间）；
//    新帧 `{"t":"focus","scope":"<id>","sinceSeq":<n>}` 是**客户端→服务端**的加项
//    （`sinceSeq` 可省：省了就是"只切焦点、不补发"）。
//
// ── 第 16 条（`96-OWNER-DECISIONS.md`）：**指称与焦点不一致 ⇒ 先反问一句** ──
// 主人拍的是"丙：不确定就先反问一句（你是说 B 那间吗？）"。
// 落在**哪一层**：**调度器的路由判据这一层**（这个文件）——
// 因为路由本来就归服务端（§四），而"这句要送到哪"只有它说了算。
// 规则（`routeTarget`）：
//   · 客户端**没告知过焦点**（老客户端 / 还没连流）⇒ **不比较**，照旧送出（老行为不动）；
//   · 归处提示 **==** 焦点 ⇒ 送出；
//   · 归处提示 **!=** 焦点 ⇒ **不送、不落盘，先反问**。
//     （87 §④.2 那条"指称 vs 焦点"的分歧，96 第 16 条已经替我们拍了：
//      **不许让任何一边静默赢**——那正是"把活送错"或者"把 B 那间的话吞掉"。）

import { MAIN_SCOPE } from './worlds.js';

/** 客户端→服务端那一帧的名字。 */
export const FOCUS_FRAME_T = 'focus';

/**
 * 把任意输入归一成 scope 名。
 * ⚠️ **认不出来 / 空 ⇒ 主线**（和 `worlds.parseScope` 同一条纪律：
 *    协议只加可选字段，缺了就是老行为）。
 */
export function normalizeScope(raw, fallback = MAIN_SCOPE) {
  if (typeof raw !== 'string') return fallback;
  const s = raw.trim();
  return s === '' ? fallback : s;
}

/**
 * 解析**客户端→服务端**那一帧 `{"t":"focus","scope":"<id>","sinceSeq":<n>}`。
 *
 * @param {string|Buffer} raw 这一帧的原文
 * @returns {{scope: string, sinceSeq: number|null}|null}
 *          `null` = **不是焦点帧**（不认识的帧一律安静忽略：协议只加不改，
 *          以后可能还有别的客户端帧，服务端不许因为看不懂就把连接踹了）。
 */
export function parseFocusFrame(raw) {
  let obj = null;
  try {
    const text =
      typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : null;
    if (text === null) return null;
    obj = JSON.parse(text);
  } catch {
    return null; // 不是 JSON：不是我们的帧
  }
  if (!obj || typeof obj !== 'object' || obj.t !== FOCUS_FRAME_T) return null;
  const scope = normalizeScope(obj.scope);
  const n = obj.sinceSeq;
  const sinceSeq = typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
  return { scope, sinceSeq };
}

/**
 * **这一句该不该按提示送出去**（第 16 条的判据本体 · 纯函数）。
 *
 * @param {object} o
 * @param {string} [o.hint]  客户端给的**归处提示**（`/api/say` 的 `scope`）
 * @param {string|null} [o.focus] 这个用户**最近一次被告知的焦点**
 *        （`null` = 没有告知过 ⇒ 不比较）
 * @returns {{deliver: boolean, ask: boolean, focus: string|null, target: string}}
 */
export function routeTarget({ hint, focus } = {}) {
  const target = normalizeScope(hint);
  const f = focus === null || focus === undefined || focus === '' ? null : String(focus);
  if (f === null || f === target) return { deliver: true, ask: false, focus: f, target };
  return { deliver: false, ask: true, focus: f, target };
}

/**
 * 那句反问的**人话**。
 *
 * 🔴 两条不许破：
 *   ① **不写内部 id 上屏**（`06` 禁用词那条）：认不出名字就**不带那半句**
 *      —— 名字的唯一出处是制品库（`apps.list()` 那条的 `title`，
 *      ⚠️ **不是** `apps.current(id)`：那个给的是版本号），这里不另抄一份；
 *   ② **不承诺、不猜**：只问"是不是那一间"，别的什么都不说。
 *
 * @param {object} o
 * @param {string} o.target
 * @param {string|null} o.focus
 * @param {(scope: string) => (string|null)} [o.nameOf]
 */
export function focusAskText({ target, focus, nameOf = () => null } = {}) {
  const name = (s) => {
    if (!s) return null;
    try {
      const t = nameOf(s);
      return typeof t === 'string' && t.trim() !== '' ? t.trim() : null;
    } catch {
      return null;
    }
  };
  const here = name(focus);
  const there = name(target);
  return `你现在看的是${here ? `「${here}」` : '这一间'}，这句话是要送到${
    there ? `「${there}」那间` : '别的那一间'
  }去吗？`;
}
