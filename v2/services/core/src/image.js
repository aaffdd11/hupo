// **图片生成那一条路**（种子梦 Seedream · 火山方舟 · P1-27）。
//
// 主人 2026-09-24 定的（原话）：*"图片用seedream，volcengine的。视频用seedance，
// 也是volcengine的。语音是腾讯云。"*
//
// ── 事实从哪来（**不许猜接口**）────────────────────────────────
//   官方那两页（`ark.volcengine.com/.../image-generation-api`）是**前端渲染**的，
//   抓回来只有一句"火山方舟" ⇒ 正文取自一份第三方速查（GitHub 上的
//   `doubao-seedream-image-skill/references/api-quickref.md`）：
//     · `POST https://ark.cn-beijing.volces.com/api/v3/images/generations`
//     · `Authorization: Bearer <ARK API key>`
//     · 载荷：`{model, prompt, size, response_format, watermark}`
//     · 回的图片 URL **24 小时过期**
//   ⇒ ⚠️ **第三方速查不算权威**：所以
//     ① 端点与模型名**都能配**（环境变量 / `data/asr.env` 那种做法，见下），不写死在逻辑里；
//     ② 真到线上跑一次、把上游的原话记下来（`docs/dev/79-CREDS-TABS.md` §九），
//        以**那次真实回话**为准 —— 这才是"判据打在真那一侧"。
//
// ── 三条纪律（与语音那条一模一样）─────────────────────────────
//   ① 🔴 **钥匙不上屏、不进日志、不进回执**：本模块只回"成没成 + 上游给的图片地址"；
//      任何错误路径都不许把 key 拼进字符串。
//   ② 🔴 **按人取**：用**他自己**那一把（配置页「图片」那一屏填的 `HUPO_IMAGE_KEY`）。
//   ③ **不许假装成功**：上游说什么就说什么（原话翻成人话），没有 URL 就是没成。

/** 默认端点（**可覆盖**：`HUPO_IMAGE_URL`）。 */
export const DEFAULT_IMAGE_URL = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';

/**
 * 默认模型名（**可覆盖**：`HUPO_IMAGE_MODEL`）。
 *
 * ⚠️ 模型名是**会过期的东西**（火山那边按 `-日期` 发版）⇒ 只住这一处、而且能被覆盖，
 *    绝不散落在调用逻辑里。
 */
export const DEFAULT_IMAGE_MODEL = 'doubao-seedream-4-0-250828';

/** 一次最多让上游画多久（毫秒）—— 画图比聊天慢得多，但仍要有上限。 */
export const IMAGE_TIMEOUT_MS = 120_000;

/** 一句提示词最长多少（上游建议中文 ~300 字；这里放宽到 2000 字符防呆，不当内容审查）。 */
export const MAX_PROMPT_CHARS = 2000;

/**
 * 把"他说的一句话"变成上游要的那份载荷（**纯函数**，逐条判）。
 *
 * @returns {{ok:true, body:object} | {ok:false, why:string}}
 */
export function buildImageRequest({ prompt, size = '2K', model = DEFAULT_IMAGE_MODEL } = {}) {
  const p = typeof prompt === 'string' ? prompt.trim() : '';
  if (p.length === 0) return { ok: false, why: 'blank-prompt' };
  if (p.length > MAX_PROMPT_CHARS) return { ok: false, why: 'prompt-too-long' };
  // ⚠️ 只要一个字段是空的就不发 —— 上游会回一个很难看懂的 400，不如我们这边先说清
  const m = typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_IMAGE_MODEL;
  const s = typeof size === 'string' && size.trim() ? size.trim() : '2K';
  return {
    ok: true,
    body: {
      model: m,
      prompt: p,
      size: s,
      // 要 URL（不要 base64）：URL 能直接画在界面上，也省一次搬运
      response_format: 'url',
      // 不要水印（我们自己那点界面装饰已经够了）
      watermark: false,
    },
  };
}

/**
 * 把上游那份 JSON 变成"我们这边要的三样"（**纯函数**）。
 *
 * ⚠️ 认不出就**明说认不出**（连"上游给了几张"一起报）—— 不许当成"成了"。
 *
 * @returns {{ok:true, urls:string[], usage:object|null, created:number|null}
 *          | {ok:false, why:string, upstream?:string}}
 */
export function parseImageResponse(raw) {
  if (raw === null || typeof raw !== 'object') return { ok: false, why: 'not-json' };
  // 上游错了：把它的原话（**不是**请求）带出去，让人看得懂为什么
  if (raw.error) {
    const msg = typeof raw.error === 'object' ? (raw.error.message ?? raw.error.code ?? '') : raw.error;
    return { ok: false, why: 'upstream-error', upstream: String(msg ?? '').slice(0, 300) };
  }
  const data = Array.isArray(raw.data) ? raw.data : [];
  const urls = [];
  for (const d of data) {
    if (d && typeof d.url === 'string' && /^https?:\/\//.test(d.url)) urls.push(d.url);
    // ⚠️ 上游可能回 `b64_json`（我们没要，但别把"有图"当成"没图"）
    else if (d && typeof d.b64_json === 'string' && d.b64_json.length > 0) urls.push('data:image/png;base64,');
  }
  if (urls.length === 0) {
    return { ok: false, why: 'no-image', upstream: `上游回了 ${data.length} 条，但里面没有图片地址` };
  }
  return {
    ok: true,
    urls,
    usage: raw.usage && typeof raw.usage === 'object' ? raw.usage : null,
    created: Number.isFinite(raw.created) ? raw.created : null,
  };
}

/**
 * 真的去要一张图。**`fetch` 是注入的**（判据里换掉它 ⇒ 测试不联网、也不花钱）。
 *
 * @param {object} o
 * @param {string} o.key     他自己的那把钥匙（**只进请求头，不进任何回执**）
 * @param {string} o.prompt
 * @param {string} [o.model]
 * @param {string} [o.size]
 * @param {string} [o.url]
 * @param {Function} [o.fetch]
 * @returns {Promise<{ok:boolean, urls?:string[], why?:string, text?:string, upstream?:string, usage?:object|null, ms?:number}>}
 */
export async function generateImage({
  key,
  prompt,
  model = DEFAULT_IMAGE_MODEL,
  size = '2K',
  url = DEFAULT_IMAGE_URL,
  fetch = globalThis.fetch,
  timeoutMs = IMAGE_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  if (typeof key !== 'string' || key.trim().length === 0) return { ok: false, why: 'no-key' };
  const built = buildImageRequest({ prompt, size, model });
  if (!built.ok) return { ok: false, why: built.why };
  const started = now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        // ⚠️ 钥匙只在这一行出现（这个对象**不许**被日志打出来）
        authorization: `Bearer ${key.trim()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(built.body),
      // ⚠️ 超时用全局那个（判据里给假 fetch ⇒ 这一行不参与）；`AbortSignal` 不在时就不带
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined,
    });
  } catch (err) {
    // 连不上 / 超时：**说清是哪一种**（"没配上"和"上游不理我"是两件事）
    const code = err?.code ?? err?.name ?? '';
    return { ok: false, why: code === 'TimeoutError' || code === 'AbortError' ? 'timeout' : 'unreachable' };
  }
  const ms = now() - started;
  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  }
  if (!res.ok) {
    // 上游原话**可能**很长/带链接 ⇒ 截一段，而且**永不含我们发出去的请求头**
    return { ok: false, why: res.status === 401 || res.status === 403 ? 'bad-key' : 'upstream-error', text: text.slice(0, 300), ms };
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, why: 'bad-json', text: text.slice(0, 300), ms };
  }
  const parsed = parseImageResponse(json);
  if (!parsed.ok) return { ...parsed, ms };
  return { ok: true, urls: parsed.urls, usage: parsed.usage, ms };
}

/**
 * 给界面看的一句话（**上游的原话翻成人话**，认不出就如实说"看不明白"）。
 *
 * ⚠️ 这里**绝不回显钥匙**；上游原话里要是有 URL，只留一句"上游还说了…"（截断）。
 */
export function imageErrorWords(r) {
  switch (r?.why) {
    case 'no-key':
      return '还没填画图那一把钥匙 —— 在上面填一串，再试一次。';
    case 'blank-prompt':
      return '先写一句"想要什么图"，我再去画。';
    case 'prompt-too-long':
      return `那句话太长了（最多 ${MAX_PROMPT_CHARS} 个字），短一点再试。`;
    case 'bad-key':
      return '那一串它说用不了。在这儿换一串就好。';
    case 'timeout':
      return '画得太久了，先停下 —— 等会儿再试一次。';
    case 'unreachable':
      return '这会儿连不上画图那边，等会儿再试。';
    case 'no-image':
      return '它回话了，但里面没有图。换一句话再试一次。';
    case 'bad-json':
      return '它回的我看不懂，等会儿再试一次。';
    case 'upstream-error':
    default:
      return '它说这次画不了。换一句话再试一次。';
  }
}
