// **D5.10 那条硬闸的尺**（四类各 20 条 · 句子级命中率 <90% 不上线）。
//
// 守的几条：
//   ① 语料文件**真的是那个形状**（四类 × 20、不重复、非空）—— 手册定死的，不许缩水；
//   ② 🔴 **"整句对得上"才算命中**（不许"包含就算" —— 那会把 80 条集体变容易）；
//   ③ 归一：标点/空白/全角/大小写不许影响判命中；**近义替换不许做**；
//   ④ 算分：总的与分类都报；**没有读数 ⇒ 不许说通过**；
//   ⑤ 判定：总命中率 ≥90% 才算过（`<90% 不上线`）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

import {
  CORPUS_CATEGORIES,
  PASS_RATE,
  PER_CATEGORY,
  isHit,
  normalizeForCompare,
  scoreCorpus,
  validateCorpus,
} from '../src/voice-corpus.js';

const CORPUS_FILE = nodePath.join(import.meta.dirname, 'corpus', 'voice-4x20.json');

// ── ① 语料本身 ─────────────────────────────────────────────
test('① 🔴 语料就是手册要的那个形状：四类 × 20、不重复、非空', () => {
  const corpus = JSON.parse(nodeFs.readFileSync(CORPUS_FILE, 'utf8'));
  const v = validateCorpus(corpus);
  assert.equal(v.ok, true, `语料不合法：${v.why}`);
  assert.equal(v.total, CORPUS_CATEGORIES.length * PER_CATEGORY);
  // 负向对照：少一条 ⇒ 校验必须抓住（不然"四类各 20 条"就成了口头承诺）
  const fewer = { sentences: corpus.sentences.slice(0, 79) };
  assert.equal(validateCorpus(fewer).ok, false);
  // 换一类 ⇒ 也要抓住
  const wrongCat = JSON.parse(JSON.stringify(corpus));
  wrongCat.sentences[0].category = '别的';
  assert.equal(validateCorpus(wrongCat).ok, false);
  // 重复一句 ⇒ 也要抓住
  const dup = JSON.parse(JSON.stringify(corpus));
  dup.sentences[1].text = dup.sentences[0].text;
  assert.equal(validateCorpus(dup).ok, false);
});

test('① 语料是**人话**（那位不会拼音的用户说的那种短句）', () => {
  const corpus = JSON.parse(nodeFs.readFileSync(CORPUS_FILE, 'utf8'));
  for (const s of corpus.sentences) {
    assert.ok(s.text.length <= 20, `太长了一句（他说的都是短句）：${s.text}`);
    assert.equal(/[a-zA-Z]/.test(s.text), false, `里头有英文：${s.text}`);
  }
});

// ── ②③ 尺本身 ─────────────────────────────────────────────
test('② 🔴 **整句对得上**才算命中（包含不算、缺字不算）', () => {
  assert.equal(isHit('今天天气怎么样', '今天天气怎么样'), true);
  assert.equal(isHit('今天天气怎么样', '今天天气怎么样。'), true, '标点不影响');
  assert.equal(isHit('今天天气怎么样', ' 今天天气怎么样 '), true, '空白不影响');
  assert.equal(isHit('今天天气怎么样', '今天天气怎么样呀对了明天呢'), false, '★ 多出来的不算命中');
  assert.equal(isHit('今天天气怎么样', '今天天气'), false, '★ 缺字不算');
  assert.equal(isHit('今天天气怎么样', '明天天气怎么样'), false);
  assert.equal(isHit('今天天气怎么样', ''), false);
  assert.equal(isHit('', ''), false, '两边都空 ⇒ 不算命中（不许把"没听到"算成对）');
});

test('③ 归一：全角/大小写/标点都归一，但**不做近义替换**', () => {
  assert.equal(normalizeForCompare('ＡＢＣ１２３'), 'abc123');
  assert.equal(normalizeForCompare('几路车？'), '几路车');
  assert.equal(normalizeForCompare('去，火车站'), '去火车站');
  // 近义不算命中（那条口径之外的事）
  assert.equal(isHit('去火车站坐几路车', '去火车站乘几路车'), false);
});

// ── ④⑤ 算分 ───────────────────────────────────────────────
test('④⑤ 算分：分类 + 总的都报；≥90% 才算过；<90% 明确不过', () => {
  const mk = (hitCount, total) => Array.from({ length: total }, (_, i) => ({
    category: '天气',
    expected: `第${i}句`,
    got: i < hitCount ? `第${i}句` : '听错了',
  }));
  const perfect = scoreCorpus(mk(20, 20));
  assert.equal(perfect.rate, 1);
  assert.equal(perfect.pass, true);

  // 18/20 = 90% ⇒ 刚好过（"<90% 不上线"）
  const edge = scoreCorpus(mk(18, 20));
  assert.equal(edge.rate, 0.9);
  assert.equal(edge.pass, true, `90% 该算过（门槛是 <90% 才不过）：${edge.rate}`);

  // 17/20 = 85% ⇒ 不过
  const under = scoreCorpus(mk(17, 20));
  assert.equal(under.pass, false);
  assert.equal(under.misses.length, 3, '没中的那几句要列出来（他要能看见是哪句）');

  // ④ 🔴 **一条读数都没有 ⇒ 不许说通过**（"看起来有闸"那种形状）
  const none = scoreCorpus([]);
  assert.equal(none.total, 0);
  assert.equal(none.pass, false, '★ 没跑就是没跑，不许算成过');

  // 分类要看得出"哪一类差"（报告里要能一眼看到）
  const mixed = scoreCorpus([
    ...Array.from({ length: 20 }, (_, i) => ({ category: '天气', expected: `w${i}`, got: `w${i}` })),
    ...Array.from({ length: 20 }, (_, i) => ({ category: '药', expected: `y${i}`, got: i < 10 ? `y${i}` : 'x' })),
  ]);
  assert.equal(mixed.byCategory['天气'].rate, 1);
  assert.equal(mixed.byCategory['药'].rate, 0.5);
  assert.deepEqual(mixed.weak, ['药'], '低于门槛的那一类要点名');
  assert.equal(mixed.pass, false, '总命中率 30/40 = 75% ⇒ 不过');
  assert.equal(PASS_RATE, 0.9);
});
