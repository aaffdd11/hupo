// **听懂那一层**（V2.0 第一件 · 主人 2026-10-04）。
//
// ── 它是什么（一句话）─────────────────────────────────────
//   用户说完一句（语音 → 文字）之后，**在真发出去之前**，先让一个**不吃思考的快速模型**
//   读一遍：① 我听到的是不是他的意思（同音错字、断句）② 有没有哪一处不问他就会理解错
//   ③ 这一句像是要干什么（随口聊 / 干件事 / 要一个小程序）。
//   ⇒ 拿回来四样：`heard`（理顺版原话）· `ask`（要问回去的一句，或没有）· `fact`（不确定什么，
//      给我们看的）· `scene`（像是要干什么）。
//
// ── 四条地基（主人 2026-10-04 原话 ＋ 这一层的安全边界）────
//   ① 🔴 **只许"听他说的"，不许"替他多要"** —— `heard` 里不许出现他没说过的要求；
//      想要更多（"要不要存数据？"）**必须走 `ask` 问出来**，他答了才算他的意思
//      （这一条保住 `D4.25`"他明说才许写"那条闸的意义）。
//   ② **一次问一件** · 问的话短到能在电话里听懂 · **不含内部词**（禁用词那一套照旧）。
//   ③ **最多两轮**（`MAX_HISTORY`）—— 主人：*"不要吹毛求疵，不要太完美，
//      就是大概的意思对、这个是通顺的，他就可以往下走。"*
//   ④ 🔴 **这一层没有手**：它**只回话**，不落盘、不发消息、不动任何东西。
//      它就是一条"读一遍、答一句"的口 —— 判据里有一条专门钉这个（`test/hear.test.js` H6）。
//
// ⚠️ **它不是什么**：不是 agent、不带工具、不进时间线、不替用户按发送。
//    真正"发出去"那一下永远在**客户端**（他看得见那一份文本之后）。

/** 用哪个模型（**不吃思考**的那一档；与 `app-ask` 同一把钥匙那条路）。 */
export const HEAR_MODEL = process.env.HUPO_HEAR_MODEL ?? 'deepseek-chat';

/** 一句话最多多少字（防呆：语音转文字不该有几百字）。 */
export const MAX_HEAR_CHARS = 1000;

/** 最多问几轮（`history` 的长度上限）。 */
export const MAX_HISTORY = 2;

/** 他答的那一句 / 问回去那一句的上限。 */
export const MAX_ANSWER_CHARS = 300;
export const MAX_ASK_CHARS = 120;

/** 理顺版原话的上限（超了就截，不报错 —— 它只是字）。 */
export const MAX_HEARD_CHARS = 600;

/** 这一句像是要干什么。认不出来的（模型乱填 / 老回执）一律当 `chat`。 */
export const SCENES = Object.freeze(['chat', 'do', 'make-app']);

/**
 * **四句话就是这一层的全部规矩**（提示词与判据共用一处 —— 两处写就会漂）。
 * ⚠️ 判据会**逐字**检查它们在提示词里（`test/hear.test.js` H1），
 *    改口径只许改这里。
 */
export const HEAR_RULES = Object.freeze([
  '你**只管语义**：只有"意思会理解错"的地方才动手 —— 听错了一个字、指代不明（"那个东西"）、缺了不问就没法办的那一件事',
  '语义已经对了 ⇒ **一个字都不用改**：`heard` 就照他原话（没标点、语序颠倒、说话重复、口语碎 —— 都**不算**问题，也不许拿来当问他的理由）',
  '想问更多（要不要存数据 / 要不要每天提醒 / 给谁看），**必须放进 ask 问出来**，不许自己写进 heard；**一次只问一件**，短句、口语、不要内部词',
  '意思对了就停：`ask` 给 null —— **不许**为了字面漂亮、更完整、更规范再问',
]);

/**
 * **拼提示词**（`text` ＝ 这一次听到的原话；`history` ＝ 前面问过的几轮问答）。
 *
 * ⚠️ 要它**只回一个 JSON**：多一句话都可能让解析失败（而失败就得让他重说一遍，
 *    那正是这一层要免掉的事）。
 */
export function buildHearPrompt({ text, history = [] } = {}) {
  const past = (Array.isArray(history) ? history : [])
    .filter((h) => h && typeof h.ask === 'string' && typeof h.answer === 'string')
    .slice(0, MAX_HISTORY)
    .map((h, i) => `${i + 1}. 我问：「${h.ask}」　他答：「${h.answer}」`)
    .join('\n');
  return [
    '你在帮一个语音助手"听清"用户刚说的一句话。他不打字，只用嘴说。',
    '',
    '规矩（一句话：**只解决语义不对的地方，语义对了就行了**）：',
    ...HEAR_RULES.map((r, i) => `${i + 1}. ${r}`),
    '',
    ...(past ? ['前面已经问过并答过的：', past, ''] : []),
    `他这一次说的是（语音转文字，可能有错字、可能断句乱）：「${text}」`,
    '',
    '只回一个 JSON，不要任何别的字。形状：',
    '{"heard":"他这一句（语义没错就照原话）","ask":"要问回去的一句，不用问就给 null",',
    ' "fact":"你在不确定什么（几个字，给我们看的）","scene":"chat 或 do 或 make-app"}',
    '',
    'scene 怎么给：随口聊两句 ⇒ chat；要他去做一件事 ⇒ do；要一个小程序/应用/游戏 ⇒ make-app。',
  ].join('\n');
}

/** 从模型那段话里抠出 JSON（它有时会包一层 ```json，或者前面多说一句）。 */
function pickJson(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return null;
  const cands = [];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cands.push(fence[1]);
  cands.push(s);
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i !== -1 && j > i) cands.push(s.slice(i, j + 1));
  for (const c of cands) {
    try {
      const j2 = JSON.parse(c.trim());
      if (j2 && typeof j2 === 'object' && !Array.isArray(j2)) return j2;
    } catch {
      /* 换下一个 */
    }
  }
  return null;
}

/** 截到上限（**不报错**：字多一点不是"没听懂"）。 */
function cut(s, n) {
  const t = String(s).trim();
  return t.length > n ? t.slice(0, n) : t;
}

/**
 * **解析回执**（纯函数，判据打的就是它）。
 *
 * @returns {{ok:true, heard:string, ask:string|null, fact:string, scene:string}
 *          | {ok:false, error:string}}  **绝不抛**
 */
export function parseHearReply(raw) {
  const j = pickJson(raw);
  if (!j) return { ok: false, error: '那边没有回成一句话' };
  const heard = typeof j.heard === 'string' ? j.heard.trim() : '';
  if (heard === '') return { ok: false, error: '没听出他说的是什么' };
  const askRaw = typeof j.ask === 'string' ? j.ask.trim() : '';
  const ask = askRaw === '' || askRaw.toLowerCase() === 'null' ? null : cut(askRaw, MAX_ASK_CHARS);
  const fact = typeof j.fact === 'string' ? cut(j.fact, 60) : '';
  const scene = SCENES.includes(j.scene) ? j.scene : 'chat';
  return { ok: true, heard: cut(heard, MAX_HEARD_CHARS), ask, fact, scene };
}

/**
 * **听一遍**：把这一句交给那份快模型，拿回四样。
 *
 * @param {object} o
 * @param {string} o.text           他这一次说的（语音转文字）
 * @param {Array} [o.history]       前面问过并答过的（最多 `MAX_HISTORY` 轮）
 * @param {(o:object)=>Promise<object>} [o.ask]  "问一句"那条路（默认 `askViaLocalProxy`；
 *                                 判据注入假的，生产走盒内代理）
 * @returns {Promise<object>} 同 `parseHearReply`；**绝不抛**
 */
export async function hearText({ text, history = [], ask = null } = {}) {
  const said = typeof text === 'string' ? text.trim() : '';
  if (said === '') return { ok: false, error: '没有听到话' };
  if (said.length > MAX_HEAR_CHARS) return { ok: false, error: '这一句太长了' };
  const hist = (Array.isArray(history) ? history : []).slice(0, MAX_HISTORY);
  const askFn = typeof ask === 'function' ? ask : null;
  if (!askFn) return { ok: false, error: '这台设备上还没接上问话那条路' };
  let r = null;
  try {
    r = await askFn({ prompt: buildHearPrompt({ text: said, history: hist }), model: HEAR_MODEL });
  } catch (err) {
    // ⚠️ 注入进来的那条路自己抛了 ⇒ 如实说"没接上"，别让它把这一轮带走
    return { ok: false, error: err?.message ?? '这台设备上还没接上问话那条路' };
  }
  if (!r?.ok) return { ok: false, error: r?.error ?? '那边没有回话' };
  const parsed = parseHearReply(r.text);
  if (!parsed.ok) return parsed;
  // ★ **用量一并带回去**（给知道 appId 的调用点记账用；认不出就是 `null`，**不许**拿 0 充数）
  return { ...parsed, usage: r.usage ?? null };
}
