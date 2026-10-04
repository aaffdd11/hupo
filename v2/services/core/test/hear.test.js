// **听懂那一层**（V2.0 第一件 · 主人 2026-10-04：
//   *"我需要一个快速的模型，就是不需要思考的，它纯的就是去理解用户说的每一句话到底有什么意思……
//     这个 AI 的目的是完善这个文本，完善完文本以后，他觉得 ok 了，他就会输入到文本框里面，
//     并且自动发送；如果不 ok，他就会询问用户。"*）。
//
// ── 这一份钉什么（H1–H6）───────────────────────────────────
//   H1 **四条地基逐字在提示词里**（不许替他多要 / 想要更多要问出来 / 一次一件 / 别追求完美）
//   H2 回执解析：认得出那些形状、认不出就**如实说认不出**（绝不猜）
//   H3 `hearText`：空话 / 太长 / 没接上路 / 路上抛了 / 那边没回 —— 每一档都有自己的人话
//   H4 前面问过答过的**真进提示词**，而且**按上限截**（最多两轮）
//   H5 那条 HTTP 口：有令牌 200 且四样齐 · 没令牌拒 · 太长 400 · 没接上路 502
//   H6 🔴 **这一层没有手**：调一次之后，时间线**一条不多**、盘上**一个字节不变**

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test, { after } from 'node:test';

import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { HEAR_RULES, MAX_HEAR_CHARS, MAX_HISTORY, buildHearPrompt, hearText, parseHearReply } from '../src/hear.js';

const NOW = 1_800_000_000_000;

const open = new Set();
after(async () => {
  for (const close of open) {
    try {
      await close();
    } catch {
      /* 关不干净不影响结论 */
    }
  }
  open.clear();
});
function guard(fn) {
  const g = async () => {
    open.delete(g);
    await fn();
  };
  open.add(g);
  return g;
}

const tmp = (tag = 'hupo-hear-') => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), tag));

/** 一句话的四样，长什么样（模型该回的那个形状）。 */
const GOOD = JSON.stringify({
  heard: '帮我把上周的账整理一下。',
  ask: null,
  fact: '',
  scene: 'do',
});

// ════════════════════════════════════════════════════════════
// H1 —— 四条地基**逐字**在提示词里
// ════════════════════════════════════════════════════════════
test('H1 🔴 四条地基逐字在提示词里（改口径只许改那一处）', () => {
  const p = buildHearPrompt({ text: '帮我看一下上周的账' });
  for (const rule of HEAR_RULES) {
    assert.ok(p.includes(rule), `★ 这条规矩没进提示词：${rule}`);
  }
  // 负向对照：**把某一条从提示词里抹掉**，上面那个循环就必须红
  // （不然那一圈只是"看起来在查"，改了口径也照样绿）
  const missing = buildHearPrompt({ text: '帮我看一下上周的账' }).replace(HEAR_RULES[0], '（这条被删了）');
  assert.equal(
    HEAR_RULES.some((r) => !missing.includes(r)),
    true,
    '★ 负向对照：少一条必须抓得住',
  );
  // ★ 2026-10-04 主人定的口径：**只去解决语义不对的地方，语义对了就行了**
  //   （这一句是这一层的地基 —— 单独立几条，免得哪天改提示词把它冲掉）
  assert.ok(p.includes('只管语义'), '★ 口径：只解决语义不对的地方');
  assert.ok(p.includes('语义已经对了 ⇒ **一个字都不用改**'), '★ 语义对了就不许再动');
  assert.ok(p.includes('口语碎') && p.includes('不算**问题'), '★ 字面不完美不许当问他的理由');
  // 要它**只回 JSON**（多一句话就可能解析失败 ⇒ 他就得重说一遍）
  assert.match(p, /只回一个 JSON/);
  assert.match(p, /"heard"/);
  assert.match(p, /"scene"/);
  // 他这一句原话进得去
  assert.ok(p.includes('帮我看一下上周的账'));
});

// ════════════════════════════════════════════════════════════
// H2 —— 回执解析
// ════════════════════════════════════════════════════════════
test('H2 回执解析：包着 ```json / 前后多说一句 都认；认不出**如实说认不出**', () => {
  const a = parseHearReply(GOOD);
  assert.equal(a.ok, true);
  assert.equal(a.heard, '帮我把上周的账整理一下。');
  assert.equal(a.ask, null);
  assert.equal(a.scene, 'do');

  const fenced = parseHearReply('```json\n' + GOOD + '\n```');
  assert.equal(fenced.ok, true, '包一层 ``` 也要认（模型很爱这么干）');
  const chatty = parseHearReply('好的，我看看：' + GOOD + ' 就这样。');
  assert.equal(chatty.ok, true, '前面多说一句也要认');

  // 认不出的三种：不是 JSON / 空 / 没有 heard
  assert.equal(parseHearReply('我没听清').ok, false);
  assert.equal(parseHearReply('').ok, false);
  assert.equal(parseHearReply('{"ask":"是上周吗？"}').ok, false, '★ 没有 heard ⇒ 不算听出来了');
  assert.equal(parseHearReply('{"heard":"   "}').ok, false, '★ 空白的 heard 也不算');
  assert.equal(parseHearReply(null).ok, false, '绝不抛');

  // `ask` 的几种"没有"都归一成 null
  for (const v of ['', '   ', 'null', 'NULL']) {
    assert.equal(parseHearReply(JSON.stringify({ heard: '嗯。', ask: v })).ask, null, `「${v}」应该是"不用问"`);
  }
  // 认不出的 scene ⇒ chat（**fail-soft**：不乱追问，也不假装要造东西）
  assert.equal(parseHearReply(JSON.stringify({ heard: '嗯。', scene: '随便' })).scene, 'chat');
  // 太长 ⇒ 截断（字多一点不是"没听懂"）
  const longAsk = parseHearReply(JSON.stringify({ heard: '嗯。', ask: '问'.repeat(400) }));
  assert.ok(longAsk.ask.length <= 120, '问回去那一句要有上限');
  const longHeard = parseHearReply(JSON.stringify({ heard: '啊'.repeat(2000) }));
  assert.ok(longHeard.heard.length <= 600);
});

// ════════════════════════════════════════════════════════════
// H3 —— `hearText`：每一档都有自己的人话
// ════════════════════════════════════════════════════════════
test('H3 `hearText`：空话 / 太长 / 没接上路 / 路上抛了 / 那边没回 —— 逐档如实说', async () => {
  const never = async () => {
    throw new Error('不该走到这儿');
  };
  assert.equal((await hearText({ text: '   ', ask: never })).ok, false);
  assert.equal((await hearText({ text: '好'.repeat(MAX_HEAR_CHARS + 1), ask: never })).ok, false);
  const noRoad = await hearText({ text: '你好' });
  assert.equal(noRoad.ok, false);
  assert.match(noRoad.error, /还没接上/, '★ 没接上路是"我们这边"的事，不许说成"没听懂"');
  const threw = await hearText({ text: '你好', ask: async () => { throw new Error('网断了'); } });
  assert.equal(threw.ok, false);
  assert.match(threw.error, /网断了/);
  const refused = await hearText({ text: '你好', ask: async () => ({ ok: false, error: '这台设备上还没放钥匙' }) });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, '这台设备上还没放钥匙', '★ 那边给的人话照抄回去');
  const bad = await hearText({ text: '你好', ask: async () => ({ ok: true, text: '我不会' }) });
  assert.equal(bad.ok, false);

  // 好的一条：四样都带回来，而且**用量也带回来**（给记账那一处用）
  const usage = { prompt_tokens: 12, completion_tokens: 3 };
  const good = await hearText({ text: '把上周的账理一下', ask: async () => ({ ok: true, text: GOOD, usage }) });
  assert.equal(good.ok, true);
  assert.equal(good.heard, '帮我把上周的账整理一下。');
  assert.deepEqual(good.usage, usage);
  assert.equal((await hearText({ text: '你好', ask: async () => ({ ok: true, text: GOOD }) })).usage, null);
});

// ════════════════════════════════════════════════════════════
// H4 —— 前面问过答过的真进提示词，而且按上限截
// ════════════════════════════════════════════════════════════
test('H4 前面问过答过的进提示词；**最多两轮**（再多也不看）', async () => {
  let seen = '';
  const ask = async ({ prompt }) => {
    seen = prompt;
    return { ok: true, text: GOOD };
  };
  await hearText({
    text: '上周的账',
    history: [
      { ask: '是上周还是上个月？', answer: '上周' },
      { ask: '要不要按天分开？', answer: '要' },
      { ask: '要发给谁吗？', answer: '不用' },
    ],
    ask,
  });
  assert.ok(seen.includes('是上周还是上个月？') && seen.includes('上周'), '★ 问过的要带上');
  assert.ok(seen.includes('要不要按天分开？'));
  assert.equal(seen.includes('要发给谁吗？'), false, `★ 超过 ${MAX_HISTORY} 轮的**不看**（不吹毛求疵）`);
  // 坏账（缺一半）不许进提示词 —— 别把"我问了但没答案"当成他答过
  await hearText({ text: '嗯', history: [{ ask: '问了吗' }, { answer: '答了' }], ask });
  assert.equal(seen.includes('问了吗'), false);
});

// ════════════════════════════════════════════════════════════
// H5/H6 —— 那条 HTTP 口（真 `createServer`）
// ════════════════════════════════════════════════════════════
async function boot(t, { hearAsk = null } = {}) {
  const dir = tmp();
  const auth = new Auth({ dataDir: tmp('hupo-hear-auth-'), now: () => NOW });
  auth.setPassword('这一份判据只用令牌');
  // ⚠️ **一个"像世界的东西"**：`/api/hear` 一个字段都不该碰它 —— H6 就是要这条证据
  const timelineCalls = [];
  const timeline = {
    readAll: () => [],
    emit: (e) => timelineCalls.push(e),
    emitTransient: (e) => timelineCalls.push(e),
  };
  const worlds = { worldFor: () => ({ userId: 'u1', timeline }) };
  const s = createServer({
    auth,
    worlds,
    hearAsk,
    now: () => NOW,
    webRoot: null,
    log: () => {},
  });
  t.after(guard(s.close));
  const addr = await s.listen(0);
  return { origin: `http://127.0.0.1:${addr.port}`, token: auth.issue({ sub: 'u1' }).token, timelineCalls };
}

const post = (origin, token, body) =>
  fetch(`${origin}/api/hear`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('H5 那条口：有令牌 200 且四样齐 · 没令牌拒 · 太长 400 · 那边不成 502', async (t) => {
  const b = await boot(t, { hearAsk: async () => ({ ok: true, text: GOOD }) });
  const ok = await post(b.origin, b.token, { text: '把上周的账理一下' });
  assert.equal(ok.status, 200, await ok.clone().text());
  const j = await ok.json();
  assert.deepEqual(Object.keys(j).sort(), ['ask', 'fact', 'heard', 'scene'], '★ 四样一个不多一个不少');
  assert.equal(j.heard, '帮我把上周的账整理一下。');

  const anon = await post(b.origin, null, { text: '你好' });
  assert.ok(anon.status === 401 || anon.status === 403, `没令牌要拒（实际 ${anon.status}）`);

  const long = await post(b.origin, b.token, { text: '好'.repeat(MAX_HEAR_CHARS + 1) });
  assert.equal(long.status, 400);
  const blank = await post(b.origin, b.token, { text: '   ' });
  assert.equal(blank.status, 400);
  const broken = await post(b.origin, b.token, '不是 JSON');
  assert.equal(broken.status, 400);

  // 那边不通 ⇒ **如实说"我们这边没接上"**，而不是 200 + 编一句话
  const b2 = await boot(t, { hearAsk: async () => ({ ok: false, error: '这台设备上还没放钥匙' }) });
  const bad = await post(b2.origin, b2.token, { text: '你好' });
  assert.equal(bad.status, 502);
  assert.equal((await bad.json()).text, '这台设备上还没放钥匙');
});

test('H6 🔴 这一层**没有手**：调一次之后，时间线一条不多、盘上一个字节不变', async (t) => {
  const fired = [];
  const b = await boot(t, {
    hearAsk: async ({ prompt }) => {
      fired.push(prompt);
      return { ok: true, text: JSON.stringify({ heard: '帮我把上周的账整理一下。', ask: '是上周吗？', scene: 'do' }) };
    },
  });
  const r = await post(b.origin, b.token, { text: '上周的账', history: [{ ask: '哪一段？', answer: '上周' }] });
  assert.equal(r.status, 200);
  assert.equal(fired.length, 1, '★ 只问了一次（一次请求 = 一次问话）');
  assert.ok(fired[0].includes('哪一段？'), '★ 前面那轮问答真的进了提示词');
  const j = await r.json();
  assert.equal(j.ask, '是上周吗？', '★ 不确定就问回去（而不是自己把它写进 heard）');
  // 🔴 它没有手：这一条口**只回话**。那份世界（`timeline`）一个事件都不该多 ——
  //    这一条判据量的是**唯一那条能"留下东西"的路**（写事件 ⇒ 落盘 ⇒ 他能看见）。
  assert.deepEqual(b.timelineCalls, [], '★ 一个事件都不许发（它没有手）');
});
