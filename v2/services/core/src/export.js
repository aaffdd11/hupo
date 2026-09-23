// 导出：把这条对话的**可见**那一段，折成一段能直接粘走的文字
// （批 3 欠的最后一件 · 契约 `docs/dev/30-EXPORT.md`）。
//
// 它守三件事，每一件都能在契约里找到出处：
//
//   ① **形态是文字，不是表**（§一 / §四）：一段纯文字、`\n\n` 分段、
//      不带 markdown；`我：` / `它：` 一人一行到几行，按时间顺序；
//      **时间戳只在跨天时出现一次**（逐条写时间就成了表）。
//   ② ⚠️ **导不出"它记在脑子里的那一层"，而且必须如实说出来**（§二）：
//      那层是 DSH 的会话记录，按整段整份存，我们既读不成文字也抽不出单独一句
//      （`28-DELETE.md` §五）。不说这句，用户会以为"导出 = 把它记得的全拿出来"
//      —— 那就是**页面在说假话**。
//   ③ ⚠️ **回收站里那些不算进来，但末尾要如实报条数**（§三）：
//      用户说过"删掉"，就不能装作没删过（把内容抄出来）；
//      也不能装作没有（不提一句）——只说**条数**，不说内容。
//      `N = 0` 时那一行**不出现**（没删过就不该冒出一句"有 0 条"）。
//
// ── 为什么是纯函数、且住在服务端 ───────────────────────────────
// 契约 §六：服务端只要一个**只读**的取数口 + **纯函数渲染**。
// 渲染是纯函数 ⇒ 它进得了 `test/unit` 被逐条钉住（手册纪律 3），
// 而"哪一条被删过"只有服务端手里的回收站知道（`trash.list()`）。
// 客户端拿到的是**成品文字**，它只负责显示与复制 —— 不重算一遍。

/** 说话人标签。**用户看得懂的两个词**（不写编号、不写"轮"那种内部概念）。 */
export const WHO_ME = '我：';
export const WHO_IT = '它：';

/**
 * 跨天那一行（§四：时间戳只在跨天时出现一次）。
 *
 * ⚠️ 用**这台机器**（服务端）的本地时区。理由：导出是服务端拼的，
 *    而"哪一天"在用户那一侧本来就是用他手上的钟看的；这台机器与他在同一处。
 *    真要跨时区，那也是"这一天是哪一天"的口径问题，不该在导出这一件里另立一套。
 */
export function dayLabel(at) {
  const d = new Date(at);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 那一天的分隔行。**它是段落，不是表头**。 */
export const dayLine = (at) => `—— ${dayLabel(at)} ——`;

/**
 * ⚠️⚠️ **§二 那句"必须如实说"的话。**
 *
 * 为什么非有不可：导出的是**这条对话里说过的话**，不是"它记得的全部"。
 * 它记在脑子里的那一层是 DSH 的会话记录 —— 按整段对话**整份**存，
 * 我们读不成文字、抽不出单独一句（`28-DELETE.md` §五把这条边界写死了）。
 * 不写这句 ⇒ 用户以为"导出 = 把它记得的全拿出来" ⇒ **说假话**。
 * 它和删除清单里那条 `verdict:"cannot"` 是**同一件事的两面**，口径不许打架：
 * 那边说"要等这段对话的记忆被重建才会消失"，这边说"没写在这儿"。
 *
 * ⚠️ 用词：说"记忆"、说"这条对话"。**不许出现"记录"**（⑳ 踩过一次）
 *    和"时间线"（禁用词表里的内部词）—— 见 `test/export.test.js` 的扫描。
 */
export const MEMORY_NOTE =
  '（这儿只是这条对话里你我互相说过的话。它自己记在记忆里的那一层不在里面'
  + ' —— 记忆是按整段对话整份存的，单独哪一句抽不出来。）';

/**
 * ⚠️⚠️ **§三 那一行：只说条数、不说内容。**
 *
 * `n` = 回收站里有多少条（一次"删掉"算一条）。`n = 0` 时调用方**不许**拼这一行。
 * ⚠️ 内容**一个字节都不许出现**：用户说过"删掉"，那就不能在导出里再抄一遍
 *    —— 那等于"删了又没删"，比不删更坏（他以为拿走了，其实还在他粘出去的纸上）。
 *
 * 🔴 **量词必须是"次"，不能是"条"**（2026-09-23 修，账 #46）：
 *    `n` 数的是**删除次数**（回收站里一条记录 = 一次"删掉"），而"**N 条**"读起来
 *    是"几句话 / 几轮" —— **那是另一件事**：`POST /api/trash/remove` 一次可以删好几轮。
 *    今天两者**恰好相等**，只因为客户端**一次只删一轮**（`turnMessageIds` ⇒ 一次 `remove`）——
 *    靠一个巧合撑着的真话，哪天多选删除一上来就变成假话。
 *    ⇒ 说"次"，就是它数的那件事（**判据钉在 `test/export.test.js`**）。
 */
export const trashNote = (n) => `（你删过 ${n} 次；删掉的那些没有算进来）`;

/** 认得出、但**不是用户的话**的事件（墓碑 / 分隔线 / 通知…）—— 不进导出。 */
const NOT_WORDS = new Set([
  'turn/deleted', 'turn/restored', 'turn/purged',
  'timeline/marker', 'notice', 'client/reload', 'title',
]);

/**
 * 把服务端事实折成"一条一条的话"（按时间顺序）。
 *
 * 一条 = 一次发言：
 *   · `user/echo` ⇒ 我；
 *   · `message/start` → `message/text`* → `message/end` ⇒ 它（**整条消息**一条，
 *     不是每段正文一条 —— `quick` 快答 + `deep` 深答是同一个气泡，协议 R2）。
 *
 * ⚠️ **去重**（这一步不做的话，恢复过的那句话会出现两遍）：
 *    "从回收站拿回来"是把那一轮的内容**按原样重新追加**（新号、`at` 原值，
 *    见 `28-DELETE.md` §8.3）⇒ 同一个 `messageId` 的内容在盘上有**两份**。
 *    客户端按 `(messageId, block, seqInBlock)` 去重（那是它那一侧的闸）；
 *    这里也得按同一把钥匙去重，否则导出里同一句话印两遍。
 *    认不出来的（老日志里没有 `seqInBlock`）退化成"按事件号"，宁可不去重也不误并。
 *
 * @param {object[]} events  日志里的事件（按 `seq` 升序；本函数会自己再排一次）
 * @param {object} [opts]
 * @param {Iterable<string>|Set<string>} [opts.hiddenIds]
 *        **现在藏在回收站里**的那些 `messageId`（§三：用户说过"删掉"的不算）。
 * @returns {{seq:number, at:number|null, who:'me'|'it', text:string}[]}
 */
export function exportItems(events, { hiddenIds = [] } = {}) {
  const hidden = hiddenIds instanceof Set ? hiddenIds : new Set(hiddenIds ?? []);
  const out = [];
  const open = new Map(); // messageId → 还没收口的那条
  const seen = new Set(); // 去重钥匙（见上）

  const push = (item, at) => {
    const text = item.parts.join('\n').trim();
    if (text === '') return; // 一个字都没有（只调了工具 / 只说了推理）⇒ 不进
    out.push({ seq: item.seq, at: item.at ?? at ?? null, who: item.who, text });
  };
  const openMessage = (e) => {
    const key = e.messageId ?? `#${e.seq}`;
    let m = open.get(key);
    if (!m) {
      m = { seq: e.seq, at: e.at ?? null, who: 'it', parts: [] };
      open.set(key, m);
    }
    if (m.at == null && typeof e.at === 'number') m.at = e.at;
    return m;
  };

  for (const e of events) {
    if (!e || typeof e.type !== 'string' || NOT_WORDS.has(e.type)) continue;
    const id = typeof e.messageId === 'string' && e.messageId !== '' ? e.messageId : null;

    // ★ §三：用户说过"删掉"的，**不算进来**。放在最前面 —— 后面的分类都别再看到它。
    if (id !== null && hidden.has(id)) continue;

    if (e.type === 'user/echo') {
      if (typeof e.text !== 'string' || e.text.trim() === '') continue;
      const key = `me:${id ?? `#${e.seq}`}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ seq: e.seq, at: e.at ?? null, who: 'me', text: e.text.trim() });
      continue;
    }

    if (e.type === 'message/start') {
      openMessage(e);
      continue;
    }

    if (e.type === 'message/text') {
      if (typeof e.text !== 'string' || e.text === '') continue;
      const sib = e.seqInBlock;
      const key = sib === undefined
        ? `it:${id ?? `#${e.seq}`}:${e.block ?? ''}:#${e.seq}`
        : `it:${id ?? `#${e.seq}`}:${e.block ?? ''}:${sib}`;
      if (seen.has(key)) continue;
      seen.add(key);
      openMessage(e).parts.push(e.text);
      continue;
    }

    if (e.type === 'message/end') {
      const key = e.messageId ?? `#${e.seq}`;
      const m = open.get(key);
      if (m) {
        open.delete(key);
        push(m, e.at);
      }
      continue;
    }
    // 其它类型安静跳过（认不出来就不说 —— 不许凭猜把东西塞进用户要粘走的那段）
  }

  // 没收口的（进程被杀 / 被淘汰）也要留住 —— 那正是用户最想拿回去的一类
  for (const m of open.values()) push(m);

  out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return out;
}

/**
 * 把"一条一条的话"拼成**一段能粘进微信的文字**（契约 §四）。
 *
 * @param {{at:number|null, who:'me'|'it', text:string}[]} items
 * @param {object} [opts]
 * @param {number} [opts.hiddenCount]
 *        回收站里有几条（§三）。**只用来报数**，内容一个字都不许从这里漏出来。
 * @returns {string} 空串 = **没东西可导**（调用方给那一句实话，别给空框 —— §四）。
 */
export function renderExport(items, { hiddenCount = 0 } = {}) {
  const list = Array.isArray(items) ? items : [];
  const n = Number.isFinite(hiddenCount) && hiddenCount > 0 ? Math.floor(hiddenCount) : 0;
  const paras = [];
  let lastDay = null;

  for (const it of list) {
    const text = typeof it?.text === 'string' ? it.text.trim() : '';
    if (text === '') continue;
    // 时间戳**只在跨天时出现一次**（逐条写就成了表 —— §四）
    if (typeof it.at === 'number') {
      const day = dayLabel(it.at);
      if (day !== lastDay) {
        paras.push(dayLine(it.at));
        lastDay = day;
      }
    }
    paras.push((it.who === 'me' ? WHO_ME : WHO_IT) + text);
  }

  if (paras.length === 0) {
    // 一个字都没有。**唯一该说话的情形**是"有东西被删过"——那时报条数（§三）；
    // 否则交给调用方说那句"这条对话还是空的"（§四：不给空框）。
    return n > 0 ? trashNote(n) : '';
  }

  // ⚠️ §二：这句必须出现在导出里（不是可选装饰）。
  paras.push(MEMORY_NOTE);
  // ⚠️ §三：末尾如实报条数；`n = 0` 时这一行不出现。
  if (n > 0) paras.push(trashNote(n));
  return paras.join('\n\n');
}

/**
 * 取数口用的那一下：读事件 → 折条 → 渲染。
 *
 * @param {object[]} events
 * @param {object} [opts]
 * @param {Iterable<string>} [opts.hiddenIds]  回收站里的 id（§三）
 * @param {number} [opts.hiddenCount]          回收站里有几条（§三）
 * @returns {{text:string, hiddenCount:number}}
 */
export function buildExport(events, { hiddenIds = [], hiddenCount = 0 } = {}) {
  const items = exportItems(events, { hiddenIds });
  const n = Math.max(0, Math.floor(Number(hiddenCount) || 0));
  const text = renderExport(items, { hiddenCount: n });
  return { text, hiddenCount: n };
}
