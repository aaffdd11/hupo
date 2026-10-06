// **会话翻页 ＋ agent 预热**（2026-10-06 · 主人：*「响应依然很慢」* ·
// 契约 `docs/dev/209-SESSION-ROTATE.md`）。
//
// ── 为什么有这一份 ────────────────────────────────────────
//   `208` 量出来的根：主对话那条 DSH 会话 **8.4 MB / 1679 行 ≈ 49 万 token**，
//   而我们**每一轮都 `resume` 同一条** ⇒ 整条历史每轮重发；上一轮隔了 2 小时 23 分
//   ⇒ 上游缓存过期 ⇒ 第一次调用 **16.4 秒**。
//   ⇒ 这一份钉两件事：**什么时候翻页**（纯函数）· **翻页那一步真的换了名字**
//     （旧的那条原样留着，且绝不许撞上别间正在用的 id）。
//
// ⚠️ 另外两条是**源码级**（"接线在不在"）—— 这类事在 VM 上跑不出行为，
//    与 `hearing_open_order_test` 同一条路子。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { promptTokensOf, shouldRotateSession, SESSION_ROTATE_PROMPT_TOKENS } from '../src/session-budget.js';
import { DSH_SESSIONS_FILE, dshSessionIdFor, nextSessionGeneration, readSessions, rotateSessionFor, writeSessions } from '../src/dsh-sessions.mjs';

const ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..');

function tmp() {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-rotate-'));
}

test('★ 量上下文：`uncachedInput + cacheRead`（用他那一轮的真读数）', () => {
  // 真读数（`208` §二 · 那一轮的第一次调用）：
  const real = { prompt_cache_miss_tokens: 480440, prompt_cache_hit_tokens: 8960, completion_tokens: 953 };
  assert.equal(promptTokensOf(real), 489400, '★ 两半都要算：只算一半就量不出"这一轮有多大"');
  // 第二次调用（吃缓存那次）
  assert.equal(promptTokensOf({ prompt_cache_miss_tokens: 957, prompt_cache_hit_tokens: 490240, completion_tokens: 588 }), 491197);
  // ⚠️ DSH（camelCase）那种形状也认
  assert.equal(promptTokensOf({ inputTokens: 1000, cacheReadTokens: 2000, outputTokens: 5 }), 3000);
  // ★ **归一过的那三格也认**（时间线上 `turn/usage` 那条事件的 `usage` 就是这个形状）——
  //   重启之后"上一轮多大"就是从它读回来的（`#seedPromptTokensOnce`）。
  assert.equal(promptTokensOf({ uncachedInput: 900, cacheRead: 100, output: 5, calls: 2, known: true }), 1000);
  // 🔴 **`foldUsage()` 折出来的那个形状**（时间线上 `turn/usage` 的就是它）：
  //    `input` ＝ DSH 的 `inputTokens` ＝ **不含缓存**那半。
  //    漏认它 ⇒ 只会算一半（他那一轮就会从 98 万被读成 49.9 万）。
  assert.equal(promptTokensOf({ input: 481397, output: 1541, cacheRead: 499200, cacheWrite: null, reasoning: null }), 980597);
  // 负向对照：两个半边都认得出（少一个都不行）
  assert.equal(promptTokensOf({ input: 1000, output: 0, cacheRead: null, cacheWrite: null, reasoning: null }), 1000);
  // 🔴 **认不出来 ⇒ `null`**（不许猜 0 —— 猜 0 就永远不会翻页，而它看起来"正常"）
  assert.equal(promptTokensOf(null), null);
  assert.equal(promptTokensOf(undefined), null);
  assert.equal(promptTokensOf('nope'), null);
  assert.equal(promptTokensOf({}), null);
});

test('★ 该不该翻页：超过上限才翻；边界与垃圾值都不翻', () => {
  const limit = 1000;
  assert.equal(shouldRotateSession({ promptTokens: 1000, limit }), false, '正好到上限 ⇒ 不翻（要"超过"）');
  assert.equal(shouldRotateSession({ promptTokens: 1001, limit }), true);
  assert.equal(shouldRotateSession({ promptTokens: 999, limit }), false);
  // 垃圾值 / 没数过 ⇒ 一律不翻（宁可慢，也不许凭猜把对话换了）
  for (const v of [null, undefined, 0, -5, NaN, 'x', {}]) {
    assert.equal(shouldRotateSession({ promptTokens: v, limit }), false, `★ 这个值不许翻页：${String(v)}`);
  }
  // 负向对照：**同一个数、换一个上限** ⇒ 结论跟着变（判据不是恒真）
  assert.equal(shouldRotateSession({ promptTokens: SESSION_ROTATE_PROMPT_TOKENS, limit: SESSION_ROTATE_PROMPT_TOKENS }), false);
  assert.equal(shouldRotateSession({ promptTokens: SESSION_ROTATE_PROMPT_TOKENS + 1, limit: SESSION_ROTATE_PROMPT_TOKENS }), true);
});

test('★ "第几页"：没有那一段就追加 `.1`；有了就加一', () => {
  assert.equal(nextSessionGeneration('main'), 'main.1');
  assert.equal(nextSessionGeneration('owner/main.muh5qpmooajv.1'), 'owner/main.muh5qpmooajv.2');
  assert.equal(nextSessionGeneration('a.b.9'), 'a.b.10');
  // 纯函数：同样的输入给同样的结果
  assert.equal(nextSessionGeneration('x.1'), nextSessionGeneration('x.1'));
  assert.throws(() => nextSessionGeneration(''), /不许猜/u);
});

test('🔴 翻页那一步：映射指到下一条、旧的那条文件原样留着、而且只往上走', () => {
  const dir = tmp();
  const file = nodePath.join(dir, DSH_SESSIONS_FILE);
  const cfg = { sessionMapPath: file };
  // 先按老路落一条（这就是"现在这条会话"）
  const first = dshSessionIdFor({ agentKey: 'u1/main', cfg });
  assert.equal(first, 'main');
  // 造一条"旧会话的文件"（翻页**不许动它**）
  const oldDir = nodePath.join(dir, 'sessions', 'main');
  nodeFs.mkdirSync(oldDir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(oldDir, 'session.v3.jsonl.zstd'), '旧的那条');

  const r1 = rotateSessionFor({ agentKey: 'u1/main', cfg });
  assert.equal(r1.from, 'main');
  assert.equal(r1.to, 'main.1');
  assert.equal(readSessions({ file }).main, 'main.1', '★ 映射要指到新那一条');
  assert.equal(nodeFs.readFileSync(nodePath.join(oldDir, 'session.v3.jsonl.zstd'), 'utf8'), '旧的那条',
    '🔴 翻页**不许删旧的那条**（它是档；删了就再也回不去了）');

  // 再翻一次 ⇒ 往上走，不回退
  const r2 = rotateSessionFor({ agentKey: 'u1/main', cfg });
  assert.equal(r2.from, 'main.1');
  assert.equal(r2.to, 'main.2');

  // 🔴 **别间占着的 id 不许撞**（撞了就是把两间的话并进一条对话）
  const other = dshSessionIdFor({ agentKey: 'u1/aoshu', cfg });
  assert.equal(other, 'aoshu');
  // 手工把别间指到"main 的下一条"上，看它会不会绕开
  const entries = readSessions({ file });
  entries.aoshu = 'main.3';
  writeSessions({ file, entries }); // ⚠️ 用**同一个写入口**（形状只有一处出处）
  const r3 = rotateSessionFor({ agentKey: 'u1/main', cfg });
  assert.notEqual(r3.to, 'main.3', '★ 翻页不许撞上别间正在用的会话 id');
  assert.equal(r3.to, 'main.4', '（绕开之后取下一个空位）');
});

test('★ 三条接线（源码级）：翻页在开口之前 · 焦点进来就预热 · 先卸再换', () => {
  const read = (rel) => nodeFs.readFileSync(nodePath.join(ROOT, rel), 'utf8');
  const disp = read('src/dispatcher.js');
  const rt = read('src/agent-runtime.js');

  // ① **翻页必须在 `#ensureAgent()` 之前**（不然卸不掉那一条 agent）
  const iRot = disp.indexOf('await this.#rotateSessionIfTooLong();');
  const iEnsure = disp.indexOf('const agent = this.#ensureAgent();');
  assert.ok(iRot > 0, '★ `deliver()` 里没接翻页（`#rotateSessionIfTooLong()`）');
  assert.ok(iEnsure > iRot, '🔴 翻页要在 `#ensureAgent()` **之前** —— 反了就卸不掉那条 agent');
  // 反例的正身：把那一行拿掉 ⇒ 这条判据就该假
  assert.equal(disp.split('\n').filter((l) => !l.includes('#rotateSessionIfTooLong();')).join('\n').includes('await this.#rotateSessionIfTooLong();'), false);

  // ② **焦点进来就预热**（`setFocus` 里那一下）
  const iFocus = disp.indexOf('setFocus(scope, device = null) {');
  const iWarm = disp.indexOf('warmAgent?.()', iFocus);
  assert.ok(iFocus > 0 && iWarm > iFocus, '★ `setFocus` 里没有预热那一下（那 3.2 秒就还在他开口那条路上）');

  // ③ **量上下文那一步与"记不记账"无关**：`#noteUsage` 里先量、再问账本
  const iTokens = disp.indexOf('this.#promptTokens = tokens;');
  const iOnUsage = disp.indexOf('if (!this.#onUsage', disp.indexOf('#noteUsage(turn, usage) {'));
  assert.ok(iTokens > 0, '★ `#noteUsage` 里没有把这一轮的上下文量下来 ⇒ 永远不会翻页');
  assert.ok(iOnUsage > iTokens, '🔴 量上下文要**在"有没有账本"那道判断之前**（不接账本也要量）');

  // ④ **重启之后要把"上一轮多大"读回来**（不然第一轮一定撞一次 16 秒）
  assert.ok(disp.includes('#seedPromptTokensOnce()'), '★ 没有"从盘上读回上一轮多大"这一步');
  const iSeed = disp.indexOf('this.#seedPromptTokensOnce();');
  const iThreshold = disp.indexOf('if (!shouldRotateSession(', disp.indexOf('async #rotateSessionIfTooLong()'));
  assert.ok(iSeed > 0 && iThreshold > iSeed, '🔴 读回来那一步要在"够不够大"那道判断**之前**');

  // ⑤ **先卸再换**（`rotateSession` 里两步的顺序）
  const iStop = rt.indexOf('await this.stop(sessionId, { reason });', rt.indexOf('async rotateSession('));
  const iSwap = rt.indexOf('rotateSessionFor({ agentKey: sessionId, cfg })', rt.indexOf('async rotateSession('));
  assert.ok(iStop > 0 && iSwap > iStop, '🔴 必须先卸掉那一条 agent 再换映射（反了 = 它还在往旧会话里写）');
});
