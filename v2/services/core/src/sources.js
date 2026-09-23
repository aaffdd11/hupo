// **出处**（「它替你查过的东西，是哪来的」）。
//
// 契约：`docs/dev/67-SOURCES.md`。协议：`message/end.sources` 是**冻结字段**
// （`message-writer.js` 的 `end()`）：`[{title, url}]`。
//
// ── 为什么单独一个模块（不是塞进 `session-translate.js`）─────────
// 这三个函数是**纯的**：给什么算什么，不碰盘、不碰网、不看时间。
// ⇒ 它们能被 `test/unit` 直接喂（项目纪律 3 的同一条道理，服务端这侧就是
//   `test/*.test.js` 里的纯函数组）。
//
// ── 三条规矩（每条都有判据钉着）──────────────────────────────
// ① 🔴 **只认"查过"那两件工具**：`web_search`（查）与 `web_fetch`（打开一页看）。
//    别的工具产出的**不是出处** —— 读一个本机文件、跑一条命令，把它说成"来源"
//    就是让用户以为那句话是从那儿来的。
// ② 🔴 **工具名 / 入参 / 查询词一个字节都不许进 `sources`**：
//    `sources` 会**画在屏幕上**，而屏幕上不许出现内部词（`AGENTS.md` §六 第 4 条）。
//    ⇒ 这里只挑 `url` 与 `title` 两个字段，别的一律丢。
// ③ **坏载荷 ⇒ 空数组**：宁可不显示，也不显示一条我们没核对过的"来源"（N10：不许猜）。
//
// ⚠️ 上游给什么（实测 dsh 的工具输出 schema · `@deepseek-ai/dsh-tool-web`）：
//    · `web_search` 的 `tool/result.meta` = `{ sources: [{url, title?, snippet?, publishedAt?}],
//      truncated, answer? }`
//    · `web_fetch`  的 `tool/result.meta` = `{ url, statusCode, truncated }`（**没有 title**）
//    ⇒ `snippet` / `publishedAt` / `answer` / `statusCode` **都不是**我们协议里的字段，
//      这一版**一律不带出去**（协议只冻结了 `{title, url}` 两个）。

/** 一条消息**最多**带几条出处。上限住代码里（客户端也只看前几条）。 */
export const MAX_SOURCES = 8;

/** 认这两件工具（见规矩 ①）。 */
const SOURCE_TOOLS = new Set(['web_search', 'web_fetch']);

/**
 * 出处上**给人看的名字**：有标题用标题，没有就用域名（去掉 `www.`）。
 *
 * ⚠️ 这条规矩是**跟着 dsh 自己那条来的**（它的 `sourceLabel()` 就是"title，否则 hostname"）——
 *    两边同一个口径，屏幕上就不会出现"同一个来源两个名字"。
 * ⚠️ 拿不到域名（坏 URL）⇒ **原样把 URL 还回去**（宁可难看，也不编一个名字）。
 *
 * @param {string} url
 * @param {string} [title]
 * @returns {string}
 */
export function sourceLabel(url, title) {
  if (typeof title === 'string' && title.trim() !== '') return title.trim();
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url;
  }
}

/** 一条来源 → `{title, url}`；**不合法就 `null`**（规矩 ③）。 */
function normalizeSource(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  // 只认 http(s)：别的（file:、javascript:、data:…）一律不算出处 —— 它们不该被点开
  if (!/^https?:\/\//iu.test(url)) return null;
  return { title: sourceLabel(url, raw.title), url };
}

/**
 * 从一条工具结果里取出处。
 *
 * @param {unknown} name 工具名（`tool/result` 上**没有**名字，要从 `tool/call` 那条配 —— 见调用处）
 * @param {unknown} meta `tool/result.meta`
 * @returns {{title: string, url: string}[]} **可能为空**（认不出 / 不是那两件工具 / 坏载荷）
 */
export function sourcesFromToolResult(name, meta) {
  if (typeof name !== 'string' || !SOURCE_TOOLS.has(name)) return [];
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return [];

  const out = [];
  const push = (raw) => {
    const one = normalizeSource(raw);
    if (!one) return;
    if (out.some((s) => s.url === one.url)) return; // 同一页查两次 ⇒ 只算一条
    if (out.length >= MAX_SOURCES) return;
    out.push(one);
  };

  if (name === 'web_search') {
    const list = Array.isArray(meta.sources) ? meta.sources : [];
    for (const s of list) push(s);
  } else {
    push({ url: meta.url, title: meta.title });
  }
  return out;
}
