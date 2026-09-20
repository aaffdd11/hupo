// 账本出口那一段文字（批 4 · 契约 `docs/dev/31-LEDGER.md` v2 §八 第 3 件）。
//
// 它是**纯函数**，所以进得了 unit（手册纪律 3）。守的几条：
//   ① 🔴 **含税说不清 / 没说钱的都要说出来有几条**（D6.9）——
//      只排除不报数就是"悄悄少算"
//   ② 🔴 **合计的口径只有一处实现**：这里不许自己再算一遍
//      （抄第二份 = 迟早两个答案；这一条用**结构**钉住，不靠自觉）
//   ③ **一段文字不是表**：没有 markdown、没有表格线、没有列对齐
//   ④ 空账本给的是**一句实话**，不是空框
//   ⑤ 只看某个月时，合计按**筛出来的那一段**重折，不是全部的合计

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { foldTotals } from '../src/ledger.js';
import { NO_PRICE_WORD, emptyLine, entryLine, renderLedger, totalsLine } from '../src/ledger-text.js';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const CORE = nodePath.resolve(HERE, '..');

const rec = (over = {}) => ({
  entryId: 'x', seq: 1, at: 0, kind: '装空调', qty: 3, unit: '台',
  unitPrice: 1200, tax: false, date: '2026-08-20', said: '…', ...over,
});

test('🔴 含税说不清的不进合计，而且**明说有几条没算进来**', () => {
  const text = renderLedger([
    rec({ tax: false, qty: 1, unitPrice: 100 }),
    rec({ tax: true, qty: 2, unitPrice: 50 }),
    rec({ tax: 'unknown', qty: 9, unitPrice: 999 }),
  ]);
  assert.ok(text.includes('一共 200'), text);
  assert.ok(text.includes('有 1 条含不含税说不清，没有算进来'), text);
});

test('🔴 没说钱的那几条也要说（它们是"记了事没记钱"，不是 0 元）', () => {
  const text = renderLedger([
    rec({ unitPrice: null, qty: 5 }),
    rec({ qty: 1, unitPrice: 30 }),
  ]);
  assert.ok(text.includes(`有 1 条${NO_PRICE_WORD}`), text);
  assert.ok(text.includes('一共 30'), text);
  assert.ok(text.includes(NO_PRICE_WORD), '那一笔自己那行也要写清楚');
});

test('一笔一行，而且**不是表**：没有 markdown、没有表格线、没有列对齐', () => {
  const text = renderLedger([rec()]);
  assert.equal(text.split('\n')[0], '2026-08-20 装空调 3台｜单价 1200，共 3600');
  for (const bad of ['|', '-|-', '**', '##', '```', '  ']) {
    assert.ok(!text.includes(bad), `出口里出现了像表格/markdown 的东西：「${bad}」\n${text}`);
  }
});

test('空账本 ⇒ **一句实话**，不是空框', () => {
  assert.equal(renderLedger([]), emptyLine(null));
  assert.equal(renderLedger([]), '账上还一条都没有。');
  assert.equal(renderLedger([], { month: '2026-08' }), '2026-08 这个月一条都没有。');
});

test('只看某个月：合计按**筛出来的那一段**折，不是全部的合计', () => {
  const all = [
    rec({ date: '2026-07-31', qty: 1, unitPrice: 1000 }),
    rec({ date: '2026-08-20', qty: 1, unitPrice: 10 }),
  ];
  const aug = renderLedger(all, { month: '2026-08' });
  assert.ok(aug.includes('一共 10'), aug);
  assert.ok(!aug.includes('2026-07-31'), '别的月份那一笔不该出现');
  assert.ok(renderLedger(all).includes('一共 1010'));
});

test('小数钱数不留浮点尾巴', () => {
  const text = renderLedger([rec({ qty: 1, unitPrice: 0.1 }), rec({ qty: 1, unitPrice: 0.2 })]);
  assert.ok(text.includes('一共 0.3'), text);
});

test('账目里带内部身份也不会漏到文字里', () => {
  const text = renderLedger([rec({ entryId: 'e-9f3a-秘密身份' })]);
  assert.ok(!text.includes('e-9f3a'), text);
});

test('🔴 **合计的口径只有一处实现**：出口这段文字不许自己再算一遍', () => {
  const src = nodeFs.readFileSync(nodePath.join(CORE, 'src', 'ledger-text.js'), 'utf8');
  assert.match(src, /import\s*\{[^}]*foldTotals[^}]*\}\s*from\s*'\.\/ledger\.js'/,
    '它必须**import** 那份口径，而不是自己写一份');
  assert.ok(!/tax\s*===\s*'unknown'/.test(src), '自己判含税 = 抄了第二份口径');

  // ⚠️ MCP 那一侧同理：它只该**转述**服务端渲染好的文字。
  const mcp = nodeFs.readFileSync(nodePath.join(CORE, 'src', 'mcp-ledger-server.mjs'), 'utf8');
  assert.ok(!/unitPrice\s*\*/.test(mcp), 'MCP 那一侧不许自己算钱 —— 那是第二个答案');
  assert.ok(!/tax\s*===\s*'unknown'/.test(mcp), 'MCP 那一侧不许自己判含税');
  assert.match(mcp, /r\.text/, '它该直接用服务端给的那段文字');
});

test('🔴 出口的文案过禁用词闸', () => {
  const text = renderLedger([
    rec({ tax: 'unknown' }), rec({ unitPrice: null }), rec(),
  ]);
  for (const w of [
    '工作区', '客户端', '云端', '时间线', '会话', '口令', '记录', '轮',
    'entryId', 'seq', 'ledger', 'tombstone',
  ]) {
    assert.ok(!text.includes(w), `出口里出现了内部词「${w}」：${text}`);
  }
});

test('每句话都能单独拿出来看（拼装的那两处也是纯函数）', () => {
  assert.equal(entryLine(rec()), '2026-08-20 装空调 3台｜单价 1200，共 3600');
  assert.equal(totalsLine(foldTotals([rec()])), '一共 3600。');
  assert.equal(totalsLine({ total: 0, notCounted: 2, noPrice: 1 }),
    '一共 0；有 2 条含不含税说不清，没有算进来；有 1 条没说钱，也没有算进来。');
});
