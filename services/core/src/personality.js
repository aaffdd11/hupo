// 个性适配层：观察主人怎么说话，让"助手"说得让人舒服 —— 但不迎合、不造假。
//
// 主人的原话（2026-09-15）：
//   「根据用户个性要改善对话方式。不是迎合，而是让人舒服。不是造假，而是客观讲理。」
//
// 所以这一层做三件事：
//   1. 从对话流里**纯计算**主人的说话画像（正则 + 统计，不要钱，每一轮都更新）
//   2. 画像持久化到 data/personality/（不进仓库），agent 新会话开始时注入上下文
//   3. 从画像算出"舒不舒服"的**机械规则**（篇幅不配 / 太客套 / 空夸迎合），
//      交给监控 agent 判语义、落任务 —— 和时效性、编造同一套管道
//
// ⚠ 边界：这是"懂他"，不是"顺他"。画像只影响**怎么说话**（长短、直接度、
// 客套程度、节奏），**永远不改变结论**。他说错就说错，观点不合就讲理，
// 数字和事实必须有出处 —— 这些在人格硬规则里管着，这一层不碰。

import fs from 'node:fs';
import path from 'node:path';

/** 探针会话（browser-check / watch / bench / e2e）不是主人 —— 画像不能被它们污染。 */
const PROBE_RE = /^(c_probe|c_watch|c_bench|c_e2e|c_smoke)/;

/** 空夸/附和式漂亮话 —— 不是"同意"，是"没有新信息的讨好"。 */
export const PRAISE_PATTERNS = [
  /说得太对/, /说的太对/, /讲得太对/, /完全正确/, /说得对极了/, /太有道理/, /非常有道理/,
  /您真(是)?(太)?(厉害|棒|睿智|专业|懂)/, /太棒了/, /好主意/, /这个想法(真)?(很好|非常好|不错)/,
  /英雄所见略同/, /您太(专业|懂行|有眼光)/, /眼光(真|太)(好|独到)/, /一针见血/, /字字珠玑/,
];

/** 客套标记 —— 主人不用敬语时，这些就是"端着"。 */
const FORMAL_PATTERNS = [/很荣幸/, /感谢您的信任/, /尊敬的/, /请您/, /敬请/, /由衷/, /承蒙/, /不吝/];

/** 转折词 —— 空夸之后有"但/不过"的，说明有实质内容，不算纯讨好。 */
const TURN_PATTERNS = [/但/, /不过/, /可是/, /然而/, /只是/];

/** 指令式开头 —— 主人是"指令派"还是"提问派"。 */
const IMPERATIVE_RE =
  /^(帮我|给我|你(去|帮我)?|查|改|做|写|找|发|看|把|删|加|跑|重启|部署|推|升级|打开|关闭|告诉|处理|修|弄)/;

const QUESTION_RE = /(吗|呢|怎么|为什么|多少|什么|哪|几|如何|是不是|能不能|可不可以)[？?]?$/;

/** 主人情绪标记（粗略，只用来挑说话节奏，不下判断）。 */
const IMPATIENT_RE = /快|赶紧|马上|立刻|急|等不了|还没好|怎么还|卡死|糊弄/;
const NEG_RE = /烦|气死|烂|太差|又(没|不)|怎么(又|还)|太慢|不对|错了|不行/;
const POS_RE = /不错|很好|棒|赞|谢谢|对[了啦]|搞定|好使/;

const STOPWORDS = new Set(
  [
    '这个', '那个', '什么', '怎么', '就是', '一个', '一下', '现在', '我们', '你们',
    '可以', '知道', '然后', '所以', '因为', '如果', '还是', '已经', '没有', '不是',
    '东西', '事情', '问题', '时候',
  ]
);

/**
 * 高频二字词（主人常提的话题/措辞）。
 * 为什么用词频不用模型：纯计算、零成本、每轮可跑；模型只看最终画像。
 */
export function topBigrams(texts, top = 8) {
  const freq = new Map();
  for (const t of texts) {
    const s = String(t).replace(/[^\u4e00-\u9fa5a-zA-Z]/g, '');
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      if (STOPWORDS.has(g)) continue;
      freq.set(g, (freq.get(g) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([w]) => w);
}

export function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * 从一轮轮对话里算画像。纯函数，无副作用。
 *
 * @param {Array<{userText:string, text:string, origin:string}>} rows timeliness.turns 的行
 * @param {string} conversationId
 * @param {{ now?: number }} [opts]
 */
export function profileFromRows(rows, conversationId, { now = Date.now() } = {}) {
  const window = rows.slice(-60); // 只看最近一段：人的习惯会变，旧数据别压过新习惯
  const userRows = window.filter((r) => r.origin === 'reactive' && String(r.userText ?? '').trim());
  const asstRows = window.filter((r) => String(r.text ?? '').trim().length > 0);

  const userTexts = userRows.map((r) => r.userText);
  const userLens = userTexts.map((t) => t.length);
  const asstTexts = asstRows.map((r) => r.text);
  const asstLens = asstTexts.map((t) => t.length);

  const ratio = (rowsArr, re) =>
    rowsArr.length ? rowsArr.filter((t) => re.test(t)).length / rowsArr.length : 0;

  const user = {
    turns: userRows.length,
    avgLen: userLens.length ? Math.round(userLens.reduce((a, b) => a + b, 0) / userLens.length) : null,
    medianLen: median(userLens),
    questionRatio: ratio(userTexts, QUESTION_RE),
    imperativeRatio: ratio(userTexts, IMPERATIVE_RE),
    formalRatio: ratio(userTexts, /您|请|麻烦|谢谢/),
    impatienceRatio: ratio(userTexts, IMPATIENT_RE),
    negRatio: ratio(userTexts, NEG_RE),
    posRatio: ratio(userTexts, POS_RE),
    topWords: topBigrams(userTexts),
  };

  const asst = {
    turns: asstRows.length,
    avgLen: asstLens.length ? Math.round(asstLens.reduce((a, b) => a + b, 0) / asstLens.length) : null,
    medianLen: median(asstLens),
    formalMatches: asstTexts.map((t) => FORMAL_PATTERNS.filter((re) => re.test(t)).length).reduce((a, b) => a + b, 0),
    praiseHits: asstTexts.filter((t) => PRAISE_PATTERNS.some((re) => re.test(t))).length,
  };

  const flags = {
    terse: user.medianLen != null && user.medianLen < 14,
    longWind: user.medianLen != null && user.medianLen > 60,
    imperativeHeavy: user.imperativeRatio > 0.45,
    questionHeavy: user.questionRatio > 0.5,
    formal: user.formalRatio >= 0.3,
    impatient: user.impatienceRatio > 0.2,
    appreciative: user.posRatio >= 0.4,
    negative: user.negRatio > 0.25,
  };

  // 画像转成"怎么说话"的具体建议 —— 只调方式，不调结论
  const advice = [];
  if (flags.terse) advice.push('主人说话很短、直接要结果 —— 你也短：先给结论，再补一句理由，别铺背景。');
  if (flags.longWind) advice.push('主人习惯写长段、问得细 —— 你也答得细一点，别一句打发。');
  if (flags.imperativeHeavy) advice.push('主人多是直接下指令 —— 应下来就去做，少问"要不要"。');
  if (flags.questionHeavy) advice.push('主人爱提问 —— 答完就停，别反问、别留钩子。');
  if (flags.formal) advice.push('主人客气（用"您/请"）—— 你客气一点，但别堆敬语。');
  else advice.push('主人不用客套 —— 你也不用，直接说话。');
  if (flags.impatient) advice.push('主人容易急 —— 开场一句就说在办什么，减少铺垫。');
  if (flags.appreciative) advice.push('主人满意时会直接夸 —— 你如实说结果就行，不用额外讨夸。');
  if (flags.negative) advice.push('主人抱怨的时候，先承认问题再给办法，别急着解释。');

  return { conversationId, at: now, user, assistant: asst, flags, advice };
}

/**
 * "舒不舒服"的机械规则 —— 纯计算，和时效性规则同一条管道。
 * 命中只是**嫌疑**，具体判语义交给监控 agent。
 */
export function comfortFindings(profile) {
  const out = [];
  if (!profile) return out;
  const { user, assistant } = profile;

  if (
    user.medianLen != null && user.medianLen < 14 &&
    assistant.medianLen != null && assistant.medianLen > 80
  ) {
    out.push({
      severity: 'medium',
      kind: 'style-fit',
      what: `主人平均 ${user.avgLen} 字、短句直接要结果，你的回答却平均 ${assistant.avgLen} 字`,
      why: '篇幅不配会让短句派的人读得累：先给结论，细节放后面',
    });
  }
  if (
    user.medianLen != null && user.medianLen > 60 &&
    assistant.medianLen != null && assistant.medianLen < 30
  ) {
    out.push({
      severity: 'low',
      kind: 'style-fit',
      what: `主人平均 ${user.avgLen} 字、问得细，你的回答平均只有 ${assistant.avgLen} 字`,
      why: '长段细问的人一句话打发不掉：答细一点，别偷懒',
    });
  }
  if (user.turns >= 5 && user.formalRatio < 0.1 && assistant.formalMatches >= 2) {
    out.push({
      severity: 'medium',
      kind: 'style-fit',
      what: `主人不用敬语（您/请 比例 ${Math.round(user.formalRatio * 100)}%），你的回答却出现了 ${assistant.formalMatches} 处客套`,
      why: '主人怎么说话，你就怎么说话；端着敬语反而不舒服',
    });
  }

  if (assistant.praiseHits > 0) {
    out.push({
      severity: 'medium',
      kind: 'flattery',
      what: `回答里出现了 ${assistant.praiseHits} 处空夸式漂亮话（「说得太对」「太棒了」这类）`,
      why: '主人的原话：「不是迎合，而是让人舒服。」空夸没有新信息 —— 同意就给理由，不同意就直说，舒服不靠顺着他',
    });
  }
  return out;
}

/**
 * 画像 → 注入 agent 上下文的开场块。
 * 只出现一次（新会话的第一条 prompt），之后就靠它自己的上下文记忆。
 */
export function personalityBlock(profile) {
  if (!profile) return null;
  const { user, advice } = profile;
  const bits = [];
  if (user.turns >= 5) {
    const style =
      (user.medianLen < 14 ? '短句直接' : user.medianLen > 60 ? '长段细问' : '中等篇幅') +
      (user.imperativeRatio > 0.45 ? '、指令派' : user.questionRatio > 0.5 ? '、提问派' : '');
    bits.push(`主人说话：${style}，平均 ${user.avgLen} 字，${user.turns} 轮观察。`);
  }
  if (user.topWords?.length) bits.push(`他常提的：${user.topWords.slice(0, 8).join('、')}。`);
  if (advice.length) bits.push('所以你要：' + advice.join(''));
  bits.push(
    '底线：这是让你"懂他"，不是让你"顺他"。他说错就直说错，观点不合就客观讲理；' +
      '数字和事实必须有出处；绝不用空夸和附和换舒服。舒服来自靠谱。'
  );
  return '── 主人的说话习惯（监控 agent 从对话里观察到的，不是猜测）──\n' + bits.join('\n');
}

/**
 * 画像持久化：每个会话一份 + 一份全局最新（同一主人，新会话也适用）。
 * 全部在 data/personality/ 下 —— 被 .gitignore 挡住，不进仓库。
 */
export class PersonalityStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'personality');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  #file(id) {
    return path.join(this.dir, `${String(id).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
  }

  /** 探针会话不算主人。 */
  #skip(conversationId) {
    return PROBE_RE.test(String(conversationId ?? ''));
  }

  update(profile) {
    if (!profile || this.#skip(profile.conversationId)) return profile;
    try {
      fs.writeFileSync(this.#file(profile.conversationId), JSON.stringify(profile, null, 2));
      fs.writeFileSync(path.join(this.dir, 'global.json'), JSON.stringify(profile, null, 2));
    } catch {
      /* 画像写不进不影响对话 */
    }
    return profile;
  }

  /**
   * 取画像：先取本会话的；没有就用全局最新的（超过 30 天的不采 —— 旧画像会给人错建议）。
   */
  get(conversationId, { maxAgeMs = 30 * 24 * 3600 * 1000, now = Date.now() } = {}) {
    const read = (f) => {
      try {
        return JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch {
        return null;
      }
    };
    const fresh = (p) => p && now - (p.at ?? 0) <= maxAgeMs;
    const own = read(this.#file(conversationId));
    if (fresh(own)) return own;
    const global = read(path.join(this.dir, 'global.json'));
    return fresh(global) ? global : null;
  }
}
