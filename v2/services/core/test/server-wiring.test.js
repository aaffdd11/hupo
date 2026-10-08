// **接线闸：`serve.js` 交给 `createServer` 的**每一个键**，`createServer` 都得真的认。**
//
// ── 为什么要有它（2026-10-08 真栽过一次）────────────────────
//   V3.0 第一片（`/api/ark-check`）在 `serve.js` 里传的键名是 `checkKey`，
//   而 `createServer` 解构的是 `checkArkKey`（全文件没有 `checkKey`）
//   ⇒ **那个口恒 404**，而当时**四道闸全绿**：
//     · `route-shape.test.js` 绿 —— 它只看"路径在不在代码里 / 在不在手册里"；
//     · `ark-check.test.js` 的 **K0–K11** 绿 —— 它测的是**纯函数**，不是接线；
//     · 客户端那几条绿 —— 它们喂的是**假回执**（`onCheckArk` 是个假函数）；
//     · 手册接口表也有那一行。
//   ⇒ 合起来就是：**"做完了"这句话在四道闸上都能立住，而那个功能一次都没通**。
//   这正是手册 **V13** 那条纪律的形状（*客户端自己算出来的东西，闸要打在这一侧*）——
//   这里同理：**名字对不上，闸就得打在名字上**，不能指望下游某一道顺手抓到。
//
// ── 它判什么（只判一个方向）────────────────────────────────
//   🔴 **`serve.js` 传的 ⊆ `createServer` 认的。**
//   反方向（`createServer` 有默认值、`serve.js` 没传）**是允许的** ——
//   那正是那些 `= null` 可选件存在的意义（"没接线就不假装有"，见 `prefs` 那条注释）。
//
// ── 它不是万能的（如实说）──────────────────────────────────
//   它只盯**名字**。名字对、值接错了（传了 A 的函数给 B）它看不出来 ——
//   那要靠各功能自己的判据（例如 `ark-check` 那几条真回执的用例）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

const SRC = nodePath.join(import.meta.dirname, '..', 'src');
const SERVER = nodePath.join(SRC, 'server.js');
const SERVE = nodePath.join(SRC, 'serve.js');

/**
 * 从某一行开始，取到**括号配平**为止的那一段（含首尾行）。
 *
 * ⚠️ 为什么要配平而不是"找下一个 `})`"：这两个块里都有**嵌套的对象/箭头函数**，
 *    朴素的找结尾会在第一个内层 `}` 就收手 ⇒ 抽出来的键少一大半，
 *    而"少"在这条闸里表现为**假绿**（那正是它要防的形状）。
 */
function blockFrom(text, startRe, minLines = 20) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => startRe.test(l));
  assert.ok(start >= 0, `找不到这一段的开头：${startRe}（形状改了就要回来改这条闸）`);
  let depth = 0;
  let started = false;
  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    out.push(line);
    for (const ch of line) {
      if (ch === '{' || ch === '(') { depth += 1; started = true; } else if (ch === '}' || ch === ')') depth -= 1;
    }
    if (started && depth <= 0) break;
  }
  assert.ok(out.length >= minLines, `这一段只抽到 ${out.length} 行（至少该有 ${minLines}）—— 多半是配平算错了`);
  return out;
}

/**
 * 这一段里**顶层**（缩进两个空格）的键名。
 *
 * ⚠️ 只认两个空格那一层：内层的键是四个空格，它们**不属于** `createServer` 的入参
 *    （例如 `prefs: { read, write }` 里的 `read`/`write`）。
 * ⚠️ 注释行整个跳过（块里注释很多，而且**故意**写满了 `checkArkKey` 这类词
 *    —— 不跳的话，注释会把一个不存在的键"补"进来 ⇒ 假绿）。
 */
function topKeys(lines) {
  const keys = new Set();
  for (const line of lines) {
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue;
    const m = /^ {2}([A-Za-z_$][\w$]*)\s*(,|:|=)/.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}

function realKeys() {
  const server = nodeFs.readFileSync(SERVER, 'utf8');
  const serve = nodeFs.readFileSync(SERVE, 'utf8');
  return {
    // `createServer` 认的（解构模式里的顶层名字）
    accepts: topKeys(blockFrom(server, /^export function createServer\(\{/)),
    // `serve.js` 真传的（调用时那个对象字面量的顶层键）
    passes: topKeys(blockFrom(serve, /^const \{.*\} = createServer\(\{/)),
  };
}

test('🔴 `serve.js` 传给 `createServer` 的每个键，`createServer` 都得**真的认**', () => {
  const { accepts, passes } = realKeys();
  const unknown = [...passes].filter((k) => !accepts.has(k)).sort();
  assert.deepEqual(
    unknown,
    [],
    `这些键名 \`serve.js\` 传了、而 \`createServer\` **不认**（解构里没有）⇒ 它们被**静默丢掉**：`
    + `${unknown.join('、')}\n`
    + '这种错的样子是"功能恒 404 / 恒不生效，而所有闸全绿"（2026-10-08 的 `checkKey` ↔ `checkArkKey`）。',
  );
});

test('负向对照：抽取器**真的读到东西**（不是空转）', () => {
  const { accepts, passes } = realKeys();
  assert.ok(accepts.size >= 25, `解构里只认出 ${accepts.size} 个名字 —— 抽取规则多半不对了`);
  assert.ok(passes.size >= 15, `调用里只认出 ${passes.size} 个键 —— 抽取规则多半不对了`);
  // 两个已知的、两边都有的键：抽不到就说明形状变了
  for (const k of ['drawImage', 'voiceReadyOf']) {
    assert.ok(accepts.has(k), `解构里应该有 \`${k}\``);
    assert.ok(passes.has(k), `调用里应该有 \`${k}\``);
  }
});

test('负向对照：**把那个 bug 的形状喂给抽取器 ⇒ 必须报出来**', () => {
  // 这一段就是 2026-10-08 那一版的样子（`checkKey`），只是缩小到能读
  const accepts = topKeys(blockFrom(
    'export function createServer({\n  drawImage = null,\n  checkArkKey = null,\n}) {\n  return 1;\n}\n',
    /^export function createServer\(\{/,
    1,
  ));
  const passes = topKeys(blockFrom(
    // ⚠️ 夹具里**只放这两个键**：多一个 `log` 之类的合法键，断言就不再是"精确地抓到那一个"
    'const { listen } = createServer({\n  drawImage,\n  checkKey,\n});\n',
    /^const \{.*\} = createServer\(\{/,
    1,
  ));
  assert.deepEqual([...passes].filter((k) => !accepts.has(k)), ['checkKey'],
    '那个 bug 的形状必须被抽出来 —— 抽不出来说明这条闸是空转的');
  // 顺手钉住"注释不算数"：把同样两个词写进注释里，不许把它们当键
  const commented = topKeys([
    'const { listen } = createServer({',
    '  // checkKey 那种写错的键名',
    '  /* checkArkKey */',
    '});',
  ]);
  assert.deepEqual([...commented], [], '注释里的词不许被当成键（不然这条闸会被注释喂绿）');
});
