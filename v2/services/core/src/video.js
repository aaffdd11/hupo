// **视频生成那一条路**（Seedance · 火山方舟 · 主人 2026-10-01 定）。
//
// 主人原话（2026-10-01）：*"帮我把语音，图像，视频，全部用豆包大模型来配置。
// 也就是语音识别，用豆包，图片生成用seedrean，视频用seedance。"*
// ⇒ 这一份就是视频那一样：**Seedance**（同一个火山方舟的 key）。
//
// ── 事实从哪来（**不许猜接口**）────────────────────────────────
//   官方那两页（`docs.volcengine.com/docs/ark/create-video-generation-task-api`）是
//   **前端渲染**的，抓回来是空壳 ⇒ 形状取自镜像/第三方速查 ＋ 社区样例：
//     · `POST {base}/contents/generations/tasks`（`base` 默认 = 方舟 v3）
//       `Authorization: Bearer <ARK API key>`
//       载荷：`{model, content:[{type:'text', text:'<提示词> --ratio 16:9 --duration 5 …'}]}`
//     · 回 `{id}`（**刚建好那几秒可能只有 id，没有 status**）
//     · 查：`GET {base}/contents/generations/tasks/{id}`
//       ⇒ `{status: queued|running|succeeded|failed|cancelled|expired, content:{video_url}}`
//     · 出来的视频地址**有效期 24 小时**；任务 id **留 7 天**
//   ⇒ ⚠️ **第三方不算权威**：所以 ① 端点与模型名**都能配**（env）；
//      ② 真跑一次、把上游原话记下来（`scripts/check-ark-video.mjs`）——**以那次为准**。
//
// ── 四条纪律（与图片那条一模一样）────────────────────────────
//   ① 🔴 **钥匙不上屏、不进日志、不进回执**：本模块只回"成没成 + 任务 id + 视频地址"；
//   ② 🔴 **按人取**：用**他自己**那一把（配置页「视频」那一屏填的 `HUPO_VIDEO_KEY`）；
//   ③ 🔴 **他明说才许生成**（`asksToMakeVideo`）：视频比图片贵得多，这一条更要硬；
//   ④ **不许假装成功**：上游说什么就说什么；还在跑就说"还在跑"。

/** 默认端点**基址**（**可覆盖**：`HUPO_VIDEO_BASE`）。 */
export const DEFAULT_VIDEO_BASE = 'https://ark.cn-beijing.volces.com/api/v3';

/** 默认模型名（**可覆盖**：`HUPO_VIDEO_MODEL`）。 */
export const DEFAULT_VIDEO_MODEL = 'doubao-seedance-1-0-pro-250528';

/** 建任务那一步最多等多久（毫秒）—— 建任务是**快**的，慢的是生成。 */
export const VIDEO_CREATE_TIMEOUT_MS = 60_000;

/** 查一次任务最多等多久。 */
export const VIDEO_QUERY_TIMEOUT_MS = 30_000;

/** 一句提示词最长多少（与图片那条同一个量级；不当内容审查）。 */
export const MAX_VIDEO_PROMPT_CHARS = 2000;

/** 默认宽高比 / 时长（秒）。⚠️ 这两个是**钱**：时长越长越贵。 */
export const DEFAULT_VIDEO_RATIO = '16:9';
export const DEFAULT_VIDEO_DURATION = 5;

/**
 * 任务 id 只认这个形状（**纯函数**）。
 *
 * 🔴 为什么要有它：这个 id 会被拼进**查任务那条 URL** ⇒ 上游回一个带 `/`、`?`、空白的
 *    id 就等于让我们去请求**另一个地址**（那是注入的形状）。⇒ 只认 `[A-Za-z0-9._-]`，
 *    长度也夹住；认不出来就**当没有 id**（不必猜、不必修）。
 */
export function safeVideoTaskId(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (t.length < 6 || t.length > 80) return null;
  return /^[A-Za-z0-9._-]+$/.test(t) ? t : null;
}

/** 认得出是 Seedance 出来的视频地址吗（纯函数；查任务那条回执里用）。 */
export function videoUrlOf(raw) {
  if (typeof raw !== 'string') return null;
  const u = raw.trim();
  if (!/^https:\/\//.test(u)) return null;
  // ⚠️ 只收 http(s)（`data:`/`file:`/`javascript:` 一律不当成"视频地址"）
  return u.length <= 2000 ? u : null;
}

/**
 * 把"他说的一句话"变成上游要的那份载荷（**纯函数**）。
 *
 * ⚠️ 参数走**正文里的文本后缀**（火山那套 `--ratio` / `--duration` / `--resolution` /
 *    `--watermark`）。⚠️ 这一条**还没在真上游验过**（见文件头那段）⇒ 真跑那一次
 *    （`scripts/check-ark-video.mjs`）回来之后，以它的回话为准改这一处。
 *
 * @returns {{ok:true, body:object} | {ok:false, why:string}}
 */
export function buildVideoRequest({
  prompt,
  model = DEFAULT_VIDEO_MODEL,
  ratio = DEFAULT_VIDEO_RATIO,
  duration = DEFAULT_VIDEO_DURATION,
  watermark = false,
} = {}) {
  const p = typeof prompt === 'string' ? prompt.trim() : '';
  if (p.length === 0) return { ok: false, why: 'blank-prompt' };
  if (p.length > MAX_VIDEO_PROMPT_CHARS) return { ok: false, why: 'prompt-too-long' };
  const m = typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_VIDEO_MODEL;
  const r = typeof ratio === 'string' && /^[0-9]{1,2}:[0-9]{1,2}$/.test(ratio.trim()) ? ratio.trim() : DEFAULT_VIDEO_RATIO;
  const d = Number.isFinite(Number(duration)) && Number(duration) > 0 ? Math.round(Number(duration)) : DEFAULT_VIDEO_DURATION;
  const flags = [`--ratio ${r}`, `--duration ${d}`, `--watermark ${watermark ? 'true' : 'false'}`];
  return { ok: true, body: { model: m, content: [{ type: 'text', text: `${p} ${flags.join(' ')}` }] } };
}

/**
 * 把"查任务"那份回执读成我们这边要的几样（**纯函数**）。
 *
 * ⚠️ **认不出就明说认不出**：`{id}` 只有 id（上游说刚建好那几秒就是这样）⇒ 那是
 *    `unknown`，**不是** `failed`（别把"还没登记好"说成"做坏了"）。
 *
 * @returns {{ok:true, status:string, videoUrl:string|null, lastFrameUrl:string|null, error:object|null, raw:object}
 *          | {ok:false, why:string}}
 */
export function parseVideoTask(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, why: 'not-json' };
  const st = typeof raw.status === 'string' ? raw.status.trim() : '';
  const err = raw.error && typeof raw.error === 'object' ? raw.error : null;
  // ⚠️ **没有 status 又有 error** ⇒ 那一条请求整个被拒了（不是某个任务失败）
  if (st === '' && err !== null) {
    return { ok: false, why: 'upstream-error', text: String(err.message ?? err.code ?? '').slice(0, 300) };
  }
  const content = raw.content && typeof raw.content === 'object' ? raw.content : {};
  return {
    ok: true,
    // ⚠️ 没有 status ⇒ `unknown`（**不许**当成 failed；调用方按"再等等"处理）
    status: st === '' ? 'unknown' : st,
    videoUrl: videoUrlOf(content.video_url),
    lastFrameUrl: videoUrlOf(content.last_frame_url),
    // ⚠️ `status: failed` 那种也**照样**带着 error 详情出去（调用方要用它说人话）
    error: err,
    raw,
  };
}

/**
 * **建一条视频任务**（`fetch` 注入 ⇒ 判据里不联网、不花钱）。
 *
 * @returns {Promise<{ok:true, taskId:string, ms:number} | {ok:false, why:string, text?:string, ms?:number}>}
 */
export async function createVideoTask({
  key,
  prompt,
  model = DEFAULT_VIDEO_MODEL,
  base = DEFAULT_VIDEO_BASE,
  ratio = DEFAULT_VIDEO_RATIO,
  duration = DEFAULT_VIDEO_DURATION,
  fetch = globalThis.fetch,
  timeoutMs = VIDEO_CREATE_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  if (typeof key !== 'string' || key.trim().length === 0) return { ok: false, why: 'no-key' };
  const built = buildVideoRequest({ prompt, model, ratio, duration });
  if (!built.ok) return { ok: false, why: built.why };
  const baseUrl = typeof base === 'string' && base.trim() ? base.trim().replace(/\/+$/, '') : DEFAULT_VIDEO_BASE;
  const started = now();
  let res;
  try {
    res = await fetch(`${baseUrl}/contents/generations/tasks`, {
      method: 'POST',
      headers: {
        // ⚠️ 钥匙只在这一行（这个对象**不许**被日志打出来）
        authorization: `Bearer ${key.trim()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(built.body),
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined,
    });
  } catch (err) {
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
    return {
      ok: false,
      why: res.status === 401 || res.status === 403 ? 'bad-key' : 'upstream-error',
      text: text.slice(0, 300),
      ms,
    };
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, why: 'bad-json', text: text.slice(0, 300), ms };
  }
  const id = safeVideoTaskId(json?.id);
  if (!id) {
    return { ok: false, why: 'no-task-id', text: text.slice(0, 300), ms };
  }
  return { ok: true, taskId: id, ms };
}

/**
 * **查一条视频任务**。
 *
 * @returns {Promise<{ok:true, status:string, videoUrl:string|null, ms:number} | {ok:false, why:string, text?:string, ms?:number}>}
 */
export async function queryVideoTask({
  key,
  taskId,
  base = DEFAULT_VIDEO_BASE,
  fetch = globalThis.fetch,
  timeoutMs = VIDEO_QUERY_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  if (typeof key !== 'string' || key.trim().length === 0) return { ok: false, why: 'no-key' };
  const id = safeVideoTaskId(taskId);
  // 🔴 形状不认 ⇒ **连请求都不发**（别把一个能改地址的 id 拼进 URL）
  if (!id) return { ok: false, why: 'bad-task-id' };
  const baseUrl = typeof base === 'string' && base.trim() ? base.trim().replace(/\/+$/, '') : DEFAULT_VIDEO_BASE;
  const started = now();
  let res;
  try {
    res = await fetch(`${baseUrl}/contents/generations/tasks/${id}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${key.trim()}` },
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined,
    });
  } catch (err) {
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
    return {
      ok: false,
      why: res.status === 401 || res.status === 403 ? 'bad-key' : res.status === 404 ? 'gone' : 'upstream-error',
      text: text.slice(0, 300),
      ms,
    };
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, why: 'bad-json', text: text.slice(0, 300), ms };
  }
  const parsed = parseVideoTask(json);
  if (!parsed.ok) return { ...parsed, ms };
  return { ok: true, status: parsed.status, videoUrl: parsed.videoUrl, ms };
}

/** 给界面看的一句话（**上游的原话翻成人话**，认不出就如实说"看不明白"）。 */
export function videoErrorWords(r) {
  switch (r?.why) {
    case 'no-key':
      return '还没填视频那一把钥匙 —— 在上面填一串，再试一次。';
    case 'blank-prompt':
      return '先写一句"想要什么视频"，我再去生成。';
    case 'prompt-too-long':
      return `那句话太长了（最多 ${MAX_VIDEO_PROMPT_CHARS} 个字），短一点再试。`;
    case 'bad-key':
      return '那一串它说用不了。在这儿换一串就好。';
    case 'timeout':
      return '等得太久了，先停下 —— 等会儿再试一次。';
    case 'unreachable':
      return '这会儿连不上视频那边，等会儿再试。';
    case 'no-task-id':
      return '它回话了，但没给任务号。换一句话再试一次。';
    case 'bad-task-id':
      return '那个任务号看着不对，先不查它。';
    case 'gone':
      return '这个任务它那边已经没有了（任务号只留几天）。';
    case 'bad-json':
      return '它回的我看不懂，等会儿再试一次。';
    case 'upstream-error':
    default:
      return '它说这次做不了。换一句话再试一次。';
  }
}

/**
 * 🔴 **"他明说才许生成"**（与画图那条同一个道理，而且这一样更贵）。
 *
 * 为什么更硬：视频比图片**贵得多**（而且慢）⇒ 助手自己想到的、或者从别处读到的，
 * **只许跟他提一句**，不许自己就去做。闸的位置和 P1-22 一样：
 * **服务端自己看"这一轮他说了什么"**（`dispatcher.turnInput`），请求里写什么都不作数。
 *
 * ⚠️ **保守默认**（宁可误拒）：认不出"他要视频"就拒，并告诉他该怎么说。
 *
 * @param {unknown} turnInput 当轮他自己说的那句话（服务端记的）
 */
export function asksToMakeVideo(turnInput) {
  if (typeof turnInput !== 'string') return false;
  const t = turnInput.trim();
  if (t === '') return false;
  // ⚠️ 第一版只认"视频 ＋ 做/生成"两个词一起出现 —— 判据当场抓住两处：
  //    ① **"帮我查一下这个视频是什么格式"** 被放进来了（有"视频"、有"帮我"）；
  //    ② **"我今天做了个视频梦"** 也被放进来了（有"视频"、有"做"）。
  //    ⇒ 收成**两条形状**（与画图那条同一个道理）：
  //      ① **对我提要求**（ASK）＋ **一个"动手做"的说法**（MAKE）＋ **指得出视频**（VIDEO）；
  //      ② **祈使句开头**（做/生成/来/拍/剪/录制）＋ 指得出视频。
  //    ⚠️ **保守默认**：认不出就拒（宁可多问一句，也别花了他没让花的钱）。
  const VIDEO = /(视频|短片|动画|动图|动起来|录一段)/;
  const MAKE = /(做|制作|生成|来|拍|剪|录制|出)/;
  const ASK = /(帮我|给我|替我|请你|麻烦|能不能|可不可以|可以帮我|我要|我想|我想要|来一段|来一段视频|来个|来一个|出一段)/;
  const IMPERATIVE = /^(做|制作|生成|来|拍|剪|录制)/;
  return (ASK.test(t) && MAKE.test(t) && VIDEO.test(t)) || (IMPERATIVE.test(t) && VIDEO.test(t));
}

/** 拒了的时候跟他说的话（会经模型转述给他，所以是**人话**）。 */
export const NEEDS_ASK_VIDEO =
  '这个我没动手：生成一段视频是**花你的钱**的事（而且比画图贵），得你亲口说一句'
  + '"给我生成一段……的视频"我才做。你要是想要，说一声就行；刚才要是从别处看来的主意，我就不动手了。';
