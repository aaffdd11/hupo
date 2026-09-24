// **D5.10 那条硬闸的语料与算法**（四类各 20 条 · 句子级命中率 <90% 不上线）。
//
// 依据：手册 `04-ROADMAP.md:189` / `05-DECISIONS.md` **D5.10** ——
//   四类问题（**天气 / 药 / 公交 / 发消息**）各 20 条，**句子级**命中率 <90% **不上线**。
//   ⚠️ 四类**不是我们选的**，是手册定死的；语料在 `test/corpus/voice-4x20.json`。
//
// ── 这一份为什么是纯函数 ────────────────────────────────────
//   "哪一句算命中"和"命中率怎么算"这两条规则**只许住一处**：
//     · 装置（`scripts/check-voice-corpus.mjs`）用它；
//     · `test/unit` 用它；
//     · 将来别的路（本地模型 / 安卓）也要用**同一把尺** —— 不然三条路的读数没法比。
//
// ⚠️ **读数只对"真的跑了音频"才算**：没有音频 ⇒ 装置必须说"没跑"，
//    绝不许回一个 0% 或 100%（那是这个项目最忌的"看起来有闸"）。

/** 手册定死的四类（顺序照手册）。 */
export const CORPUS_CATEGORIES = Object.freeze(['天气', '药', '公交', '发消息']);

/** 每类几条（手册：各 20 条）。 */
export const PER_CATEGORY = 20;

/** 门槛（手册：<90% 不上线）。 */
export const PASS_RATE = 0.9;

/**
 * **比对前的归一**（纯函数）。
 *
 * 为什么要有它：识别出来的是"带标点、可能全角"的一串 —— 而语料是光秃秃的一句话。
 * ⇒ 去空白、去标点（中英）、全角转半角、英文小写。
 * ⚠️ **不做"近义替换"**：那是"句子级命中"这个口径之外的事（做了就等于把尺放松）。
 */
export function normalizeForCompare(text) {
  if (typeof text !== 'string') return '';
  let t = text;
  // 全角 → 半角（英文、数字、常见标点）
  t = t.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  t = t.replace(/\u3000/g, ' ');
  // 去标点（中英）+ 去空白
  t = t.replace(/[.,!?;:'"`()\[\]{}<>~@#$%^&*_+=|\\/\-—–…、。，！？；：""''（）《》【】〈〉·]/g, '');
  t = t.replace(/\s+/g, '');
  return t.toLowerCase();
}

/**
 * **这一句算不算命中**（纯函数）。
 *
 * 口径：**整句**对得上才算 —— 归一之后**相等**。
 * ⚠️ **不许"包含就算"**：识别出"今天天气怎么样呀对了明天…"里含了那一句，不算。
 *    （D5.10 要的是"句子级命中"，不是"里边出现过"。真放松了这条口径，
 *      四类 80 条会集体变容易，那道闸就白设了。）
 */
export function isHit(expected, got) {
  const a = normalizeForCompare(expected);
  const b = normalizeForCompare(got);
  return a.length > 0 && a === b;
}

/**
 * 校验一份语料**是不是手册要的那个形状**（四类 × 20、不重复、非空）。
 * @returns {{ok:boolean, why:string, total:number}}
 */
export function validateCorpus(corpus) {
  const rows = Array.isArray(corpus?.sentences) ? corpus.sentences : null;
  if (!rows) return { ok: false, why: '语料不是 {sentences:[…]} 那个形状', total: 0 };
  const byCat = new Map(CORPUS_CATEGORIES.map((c) => [c, 0]));
  const seen = new Set();
  for (const r of rows) {
    if (!r || typeof r.id !== 'string' || typeof r.text !== 'string' || r.text.trim() === '') {
      return { ok: false, why: '有一条缺 id / text（或者 text 是空的）', total: rows.length };
    }
    if (!byCat.has(r.category)) return { ok: false, why: `认不出的类：${r.category}`, total: rows.length };
    byCat.set(r.category, byCat.get(r.category) + 1);
    if (seen.has(r.text)) return { ok: false, why: `有重复的一句：${r.text}`, total: rows.length };
    seen.add(r.text);
  }
  for (const [c, n] of byCat) {
    if (n !== PER_CATEGORY) return { ok: false, why: `「${c}」是 ${n} 条，手册要 ${PER_CATEGORY} 条`, total: rows.length };
  }
  return { ok: true, why: '', total: rows.length };
}

/**
 * 算分（纯函数）。
 *
 * ⚠️ **读数怎么用**：
 *   · `overall` 是**总的命中率**（80 条里对了几句）；
 *   · `byCategory` 是**分类报数**（用来找"哪一类特别差"）；
 *   · `pass` 的判据是**总命中率 ≥90%**（D5.10 那句话的读法）。
 *     ⚠️ 这个读法（"总"还是"每类都要"）**手册没写死** ⇒ 我在 `77-BLOCKERS.md` 记了一条
 *        "口径要主人确认"；在那之前**按更宽松的那个读**（总），但**分类照报**，
 *        哪一类低于 90% 单独标出来（`weak`），让他一眼看得见。
 *
 * @param {{category:string, expected:string, got:string}[]} results
 */
export function scoreCorpus(results) {
  const rows = Array.isArray(results) ? results : [];
  const byCategory = {};
  for (const c of CORPUS_CATEGORIES) byCategory[c] = { total: 0, hit: 0, rate: 0 };
  let total = 0;
  let hit = 0;
  const misses = [];
  for (const r of rows) {
    const c = byCategory[r?.category] ? r.category : null;
    if (!c) continue;
    const h = isHit(r.expected, r.got);
    byCategory[c].total += 1;
    total += 1;
    if (h) {
      byCategory[c].hit += 1;
      hit += 1;
    } else {
      misses.push({ category: c, expected: r.expected, got: r.got });
    }
  }
  for (const c of CORPUS_CATEGORIES) {
    const b = byCategory[c];
    b.rate = b.total === 0 ? 0 : b.hit / b.total;
  }
  const rate = total === 0 ? 0 : hit / total;
  const weak = CORPUS_CATEGORIES.filter((c) => byCategory[c].total > 0 && byCategory[c].rate < PASS_RATE);
  return { total, hit, rate, byCategory, misses, weak, pass: total > 0 && rate >= PASS_RATE };
}
