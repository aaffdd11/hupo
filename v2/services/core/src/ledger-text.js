// 账本的**出口**：把那几笔折成一段能直接粘走的文字
// （批 4 · 契约 `docs/dev/31-LEDGER.md` v2 §八 第 3 件）。
//
// 形态照抄 ㉑ 那一件（`export.js`）定下来的规矩：
//
//   ① **一段文字，不是表**：不带 markdown、不带表格线、不带列对齐
//      —— 主人要的是"能粘进微信的一段话"（`04-ROADMAP.md` 批 4 原话）。
//   ② **口径只有一处**：合计走 `ledger.js` 的 `foldTotals()`，
//      **本文件不许自己再算一遍**（抄第二份 = 迟早两个答案）。
//   ③ ⚠️ **排除掉的东西必须说出来**：含税说不清的、没说钱的，
//      都要在末尾**明说有几条没算进来**（D6.9）。
//      只排除不报数就是"悄悄少算"——而那正是这一批最该防的错法。
//   ④ **纯函数**：进 `test/unit` 被逐条钉住（手册纪律 3）。
//      服务端那一侧渲染好、MCP 那侧只是**转述**，它不重算。
//
// ⚠️ 用词过禁用词闸：不出现"记录""时间线""条目"这一族（那是一条闸，不是文风）。

import { foldTotals } from './ledger.js';

/** 没写钱的那一笔怎么念。 */
export const NO_PRICE_WORD = '没说钱';

/** 空账本那句实话（**不许给一个空框** —— 与 `export.js` §四 同一条规矩）。 */
export function emptyLine(month = null) {
  return month ? `${month} 这个月一条都没有。` : '账上还一条都没有。';
}

/**
 * 一笔一行。
 *
 * ⚠️ **单价和这一笔的总额都要写**：只写总额的话，"一台一千二"这个信息就没了；
 *    只写单价的话，主人一眼看不出这笔一共多少。两个都写，粘出去别人才看得懂。
 * ⚠️ 分隔符用**全角**竖线：它是"一句话里的停顿"，不是表格的竖线。
 */
export function entryLine(r) {
  const qty = r?.qty ?? 0;
  const hasPrice = r?.unitPrice !== null && r?.unitPrice !== undefined;
  const money = hasPrice
    ? `单价 ${r.unitPrice}，共 ${Math.round(qty * r.unitPrice * 100) / 100}`
    : NO_PRICE_WORD;
  return `${r?.date ?? ''} ${r?.kind ?? ''} ${qty}${r?.unit ?? ''}｜${money}`;
}

/** 末尾那几句：合计 + **没算进来的各有多少条**。 */
export function totalsLine(t) {
  const parts = [`一共 ${t?.total ?? 0}`];
  if ((t?.notCounted ?? 0) > 0) parts.push(`有 ${t.notCounted} 条含不含税说不清，没有算进来`);
  if ((t?.noPrice ?? 0) > 0) parts.push(`有 ${t.noPrice} 条${NO_PRICE_WORD}，也没有算进来`);
  return `${parts.join('；')}。`;
}

/**
 * 把账目渲染成一段能粘走的文字。
 *
 * @param {object[]} records  `Ledger.list()` 给的那些
 * @param {object} [o]
 * @param {string|null} [o.month]  `YYYY-MM` = 只看这个月；null = 全部
 * @returns {string}
 */
export function renderLedger(records, { month = null } = {}) {
  const all = Array.isArray(records) ? records : [];
  const list = month ? all.filter((r) => String(r?.date ?? '').startsWith(month)) : all;
  if (list.length === 0) return emptyLine(month);
  // ⚠️ 合计按**筛出来的那一小段**重折（月份过滤之后口径不能还是全部的）
  const t = month ? foldTotals(list) : foldTotals(all);
  return `${list.map(entryLine).join('\n')}\n\n${totalsLine(t)}`;
}
