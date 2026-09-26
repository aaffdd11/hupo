// **工具行 / 每轮用量 / 系统提示词**：契约 `docs/dev/116` 的**服务端那一半**。
//
// ── 这一份钉什么（主人 2026-09-26：*"首先全部开放"*）────────────────
//   `session-translate.js` 把 DSH 的 `tool/call` · `tool/result` · `system/message`
//   投影成**持久事件**（有号、落盘、翻页与重连都拿得到）：工具名、一句话标题、
//   有界入参、有界输出摘要、每轮用量、模型看到的系统提示词。
//
// ── 每条判据都带反着验 ───────────────────────────────────────
//   🔴 **有界**：超了要**截断**并且**如实说**（`bytes` / `truncated`）——
//      一次 `bash` 的输出可以几十万字，落进那条可见日志就是灾难。
//   🔴 **用量宁可不画也不许给半个**（DSH 那条规矩：任何一次尝试没报准 ⇒ 整块 null）。
//   🔴 **认不出不许猜**：标题取不到 ⇒ `null`（客户端那一行就只画工具名）。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_ARGS_CHARS,
  MAX_EXCERPT_CHARS,
  MAX_SYSTEM_PROMPT_CHARS,
  MAX_TITLE_CHARS,
  clip,
  foldUsage,
  isSubagentTool,
  oneLine,
  parseArgs,
  resultExcerpt,
  toolArgsSummary,
  toolTitleFor,
} from '../src/tool-rows.js';

// ══ 一、标题（只取现成字段，取不到 ⇒ null）══════════════════════

test('🔴 标题：`description` 优先，然后 command / path / query / url —— 取不到就是 null（不猜）', () => {
  assert.equal(toolTitleFor('bash', JSON.stringify({ description: '把这一半提交掉', command: 'git add -A' })), '把这一半提交掉');
  assert.equal(toolTitleFor('bash', JSON.stringify({ command: 'git status' })), 'git status');
  assert.equal(toolTitleFor('read', JSON.stringify({ path: '/a/b/c.md' })), '/a/b/c.md');
  assert.equal(toolTitleFor('web_search', JSON.stringify({ query: '奥数 年级 模块' })), '奥数 年级 模块');
  assert.equal(toolTitleFor('web_fetch', JSON.stringify({ url: 'https://x.example/a' })), 'https://x.example/a');
  // 反例：认不出 / 空 / 不是对象 ⇒ null（**不许**编一个"查看文件"之类）
  assert.equal(toolTitleFor('bash', '{}'), null);
  assert.equal(toolTitleFor('bash', 'not json at all'), null);
  assert.equal(toolTitleFor('bash', undefined), null);
  assert.equal(toolTitleFor('bash', JSON.stringify({ description: '   ' })), null);
  assert.equal(parseArgs('[]'), null, '数组也不算「一张参数表」');
});

test('🔴 标题与入参都有界：超了要截断，而且**如实报**原字节数', () => {
  const long = 'x'.repeat(500);
  const title = toolTitleFor('bash', JSON.stringify({ description: long }));
  assert.equal(title.length, MAX_TITLE_CHARS, `标题该裁到 ${MAX_TITLE_CHARS}`);
  const args = toolArgsSummary('x'.repeat(MAX_ARGS_CHARS + 500));
  assert.equal(args.text.length, MAX_ARGS_CHARS);
  assert.equal(args.truncated, true, '★ 截了就要说');
  assert.ok(args.bytes > MAX_ARGS_CHARS, '★ 原始字节数要如实给（不是裁完那个数）');
  assert.equal(toolArgsSummary(long).truncated, false, '反例：没超就不许说截了');
  // 反例（正对照）：没超 ⇒ `truncated:false`、一个字节不少
  const short = toolArgsSummary('{"a":1}');
  assert.equal(short.text, '{"a":1}');
  assert.equal(short.truncated, false);
  assert.equal(short.bytes, 7);
  // 空白折一行（标题/摘要都是"一行"）
  assert.equal(oneLine('a\n\n  b\tc '), 'a b c');
});

// ══ 二、输出摘要（从 DSH 的 message 里把文字取出来）══════════════

test('🔴 输出摘要：content 块拼起来；认不出的形状原样给一小段；超了截断并如实说', () => {
  const msg = { content: [{ type: 'text', text: '第一行' }, { type: 'text', text: '第二行' }] };
  assert.deepEqual(resultExcerpt(msg), { excerpt: '第一行\n第二行', bytes: 19, truncated: false });
  assert.equal(resultExcerpt('就是一个字符串').excerpt, '就是一个字符串');
  // 认不出的对象 ⇒ JSON 一小段（**不抛**、不猜语义）
  assert.match(resultExcerpt({ weird: true }).excerpt, /\{.*weird/);
  // 超长 ⇒ 截断 + 如实报
  const huge = { content: [{ type: 'text', text: 'y'.repeat(MAX_EXCERPT_CHARS + 100) }] };
  const cut = resultExcerpt(huge);
  assert.equal(cut.excerpt.length, MAX_EXCERPT_CHARS);
  assert.equal(cut.truncated, true);
  assert.ok(cut.bytes > MAX_EXCERPT_CHARS);
  // 反例：空 ⇒ 什么都没有（不是"空字符串也算一条"）
  assert.deepEqual(resultExcerpt(null), { excerpt: null, bytes: 0, truncated: false });
});

// ══ 三、每轮用量（宁可不画，也不许给半个）══════════════════════

test('🔴 用量：每一次都报准才求和；**任何一次缺 / 不精确 ⇒ 整块 null**（DSH 那条规矩）', () => {
  const ok = foldUsage([
    { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0, reasoningTokens: 5 },
    { inputTokens: 5, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, reasoningTokens: 1 },
  ]);
  assert.equal(ok.complete, true);
  assert.deepEqual(ok.usage, { input: 105, output: 22, cacheRead: 11, cacheWrite: 0, reasoning: 6 });
  // 反例①：有一次没有 usage ⇒ 整块 null（不许"少算一次"）
  assert.deepEqual(foldUsage([{ inputTokens: 1, outputTokens: 1 }, null]), { usage: null, complete: false });
  // 反例②：可选桶只有一次有 ⇒ 那一桶 null（不给半个和），主桶照旧求和
  const half = foldUsage([
    { inputTokens: 1, outputTokens: 1, cacheReadTokens: 3 },
    { inputTokens: 1, outputTokens: 1 },
  ]);
  assert.equal(half.usage.cacheRead, null, '★ 缓存桶要么每次都有、要么整块 null');
  assert.equal(half.usage.input, 2);
  // 反例③：推理 > 输出 ⇒ 自相矛盾 ⇒ 整块 null
  assert.deepEqual(
    foldUsage([{ inputTokens: 1, outputTokens: 1, reasoningTokens: 9 }]),
    { usage: null, complete: false },
  );
  // 反例④：负数 / 非安全整数 ⇒ null
  assert.equal(foldUsage([{ inputTokens: -1, outputTokens: 1 }]).usage, null);
  assert.equal(foldUsage([{ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }, { inputTokens: 2, outputTokens: 1 }]).usage, null);
  // 反例⑤：一次都没有 ⇒ null（不是 0）
  assert.deepEqual(foldUsage([]), { usage: null, complete: false });
});

// ══ 四、子代理那两件 ════════════════════════════════════════

test('🔴 `subagent` / `subagent_*` 才算子代理（与 DSH 的判定逐字一致）', () => {
  assert.equal(isSubagentTool('subagent'), true);
  assert.equal(isSubagentTool('subagent_task'), true);
  assert.equal(isSubagentTool('send_message'), false);
  assert.equal(isSubagentTool('list_agents'), false);
  assert.equal(isSubagentTool('subagentx'), false);
  assert.equal(isSubagentTool(undefined), false);
});

// ══ 五、`clip` 那一处唯一出处 ═══════════════════════════════

test('🔴 `clip`：没超就原样，超了就截 —— 两处标志都要对', () => {
  assert.deepEqual(clip('abc', 5), { text: 'abc', truncated: false });
  assert.deepEqual(clip('abcdef', 3), { text: 'abc', truncated: true });
  assert.deepEqual(clip(null, 3), { text: '', truncated: false });
  assert.equal(MAX_SYSTEM_PROMPT_CHARS > 0, true);
});
