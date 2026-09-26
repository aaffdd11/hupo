// **工具行**：把 DSH 的 `tool/call` / `tool/result` 投影成"人看得懂的一行"（契约 `docs/dev/116`）。
//
// ── 它治的是什么（主人 2026-09-26 定的形状）────────────────────
//   *"首先全部开放，聊天窗口的设计也要重做。"*
//   ⇒ 聊天窗口要像 DSH 的窗口那样**把这条会话摊开**：每一次工具调用
//     都要有自己的行（**名字 · 一句话标题 · 成败 · 输出摘要**），而不是被压成
//     "在查资料 / 在写"这一个词（那是改前的形状：`session-translate.js` 只发类别）。
//   ⚠️ 这是**产品形状的改变**：`D1.1`（界面上不许出现内部词）在**聊天窗口内**被主人放开。
//
// ── 三条不许破 ───────────────────────────────────────────────
//   ① 🔴 **有界**：标题/入参/输出都截断，并且**如实报** `bytes` / `truncated`
//      —— 一次 `bash` 的输出可能是几十万字，落进那条可见日志就是灾难。
//   ② 🔴 **不解析出新的意思**：标题只从入参里**取现成的字段**（`description` /
//      `command` / `path` / `query` / `url`），取不到就 `null`（**不发明**、不猜）。
//   ③ **纯函数**：不碰盘、不碰时钟、不认识任何全局 —— 好让它进 `test/unit` 被逐字钉住。
//
// ⚠️ 工具名是**原样**发出去的（`bash` / `write` / `web_search` …）——
//    这是主人点名要的"全部开放"；界面上怎么呈现（等宽小字、灰色标签）是客户端的事。

/** 一行标题最多多少字（人看的一行，不是模型上下文）。 */
export const MAX_TITLE_CHARS = 120;
/** 入参摘要最多多少字（`…` 之外还会如实报原始字节数）。 */
export const MAX_ARGS_CHARS = 2000;
/** 输出摘要最多多少字。 */
export const MAX_EXCERPT_CHARS = 4000;
/** 系统提示词最多留多少字（它可能很长；超了如实说"截了"）。 */
export const MAX_SYSTEM_PROMPT_CHARS = 4000;

/** 子代理那几件工具（`subagent` / `subagent_*`）—— 与 DSH 的判定逐字一致。 */
export function isSubagentTool(name) {
  const n = typeof name === 'string' ? name : '';
  return n === 'subagent' || n.startsWith('subagent_');
}

/** 空白折成单空格（标题/摘要都是"一行"）。 */
export function oneLine(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\s+/gu, ' ').trim();
}

/** 截断，并在截断时明确说"截了"（调用方拿到 `truncated`）。 */
export function clip(text, max) {
  const s = typeof text === 'string' ? text : text === null || text === undefined ? '' : String(text);
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max), truncated: true };
}

/** 入参（DSH 给的是**原样字符串**）⇒ 认得出就解析，认不出返回 `null`（不猜）。 */
export function parseArgs(raw) {
  // ⚠️ 数组**不算**"一张参数表"（判据当场抓到过：`[]` 会被当成参数，
  //    结果标题那一格去按索引找字段 —— 一个都找不到，白跑一趟）
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const j = JSON.parse(raw);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

/**
 * **一句话标题**：只从现成的字段里取（`description` / `command` / `path` / `query` / `url`）。
 *
 * @returns {string|null} `null` = 取不到（客户端那一行就只画工具名）
 */
export function toolTitleFor(name, argsRaw) {
  const a = parseArgs(argsRaw);
  if (!a) return null;
  const pick = (v) => {
    if (typeof v !== 'string') return null;
    const s = oneLine(v);
    return s === '' ? null : s;
  };
  const candidates = [
    a.description,           // 我们的 bash/read/write 那几件都带这一格
    a.summary,
    a.title,
    a.command,               // bash 的命令本身
    a.query,                 // web_search
    a.pattern,               // grep/glob
    a.path, a.file_path,     // read/write/edit
    a.url,                   // web_fetch
    a.id, a.jobId,           // job_output / job_kill
  ];
  for (const c of candidates) {
    const s = pick(c);
    if (s !== null) return clip(s, MAX_TITLE_CHARS).text;
  }
  return null;
}

/**
 * **入参摘要**：原样那串（裁到 `MAX_ARGS_CHARS`）。
 *
 * ⚠️ 不做美化、不做二次序列化 —— 见文件头 ②。
 */
export function toolArgsSummary(raw) {
  if (raw === null || raw === undefined) return { text: null, bytes: 0, truncated: false };
  const s = typeof raw === 'string' ? raw : safeJson(raw);
  const bytes = Buffer.byteLength(s, 'utf8');
  const c = clip(s, MAX_ARGS_CHARS);
  return { text: c.text, bytes, truncated: c.truncated };
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * **结果摘要**：从 DSH 的 `tool/result.message` 里把文字取出来（有界）。
 *
 * 形状（实测）：`{content: [{type:'text', text}, …]}`；`message` 也可能是**字符串**
 * （认不出的一律 `JSON.stringify` 一段）—— 认不出**不猜**，原样给一小段。
 *
 * @returns {{excerpt:string|null, bytes:number, truncated:boolean}}
 */
export function resultExcerpt(message) {
  if (message === null || message === undefined) return { excerpt: null, bytes: 0, truncated: false };
  let full = '';
  if (typeof message === 'string') {
    full = message;
  } else if (Array.isArray(message?.content)) {
    const parts = [];
    for (const block of message.content) {
      if (typeof block?.text === 'string') parts.push(block.text);
      else if (block !== null && block !== undefined) parts.push(safeJson(block));
    }
    full = parts.join('\n');
  } else if (typeof message?.text === 'string') {
    full = message.text;
  } else {
    full = safeJson(message);
  }
  const bytes = Buffer.byteLength(full, 'utf8');
  const c = clip(full, MAX_EXCERPT_CHARS);
  return { excerpt: c.text, bytes, truncated: c.truncated };
}

/**
 * **一轮的用量**（DSH 的规矩：**任何一次尝试没报准 ⇒ 整块不画**，绝不给出半个总数）。
 *
 * @param {Array<object|null>} usages 这一轮每一次 `assistant/message` 带的那一份
 * @returns {{usage:object|null, complete:boolean}}
 */
export function foldUsage(usages) {
  const list = Array.isArray(usages) ? usages : [];
  if (list.length === 0) return { usage: null, complete: false };
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  let hasCacheRead = true;
  let hasCacheWrite = true;
  let hasReasoning = true;
  for (const u of list) {
    const input = intOf(u?.inputTokens ?? u?.input);
    const output = intOf(u?.outputTokens ?? u?.output);
    // 🔴 安全整数才收；认不出 ⇒ 整轮作废（不许"尽力算"）
    if (input === null || output === null) return { usage: null, complete: false };
    sum.input += input;
    sum.output += output;
    const cr = intOf(u?.cacheReadTokens ?? u?.cacheRead);
    const cw = intOf(u?.cacheWriteTokens ?? u?.cacheWrite);
    const rt = intOf(u?.reasoningTokens ?? u?.reasoning);
    if (cr === null) hasCacheRead = false;
    else sum.cacheRead += cr;
    if (cw === null) hasCacheWrite = false;
    else sum.cacheWrite += cw;
    if (rt === null) hasReasoning = false;
    else sum.reasoning += rt;
  }
  if (!Number.isSafeInteger(sum.input) || !Number.isSafeInteger(sum.output)) {
    return { usage: null, complete: false };
  }
  // 推理不许超过输出（DSH 同一条：`reasoningTokens <= outputTokens`）
  if (hasReasoning && sum.reasoning > sum.output) return { usage: null, complete: false };
  return {
    usage: {
      input: sum.input,
      output: sum.output,
      cacheRead: hasCacheRead ? sum.cacheRead : null,
      cacheWrite: hasCacheWrite ? sum.cacheWrite : null,
      reasoning: hasReasoning ? sum.reasoning : null,
    },
    complete: true,
  };
}

function intOf(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
