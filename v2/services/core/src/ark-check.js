// **"这把钥匙能不能用" —— 不花钱的那一次自检**（v3.0 · 主人 2026-10-07 定的）。
//
// ── 为什么要有它 ────────────────────────────────────────────
// 配置页「图片」那一屏有「试一张」：**真画一张**（花钱、几十秒）。视频那一屏
// **不能照抄那个形状**：视频**又慢又贵**，而他点这一下往往只是想确认"这把钥匙对不对"。
// ⇒ 主人 2026-10-07 当场选的：**只验钥匙和路，不花钱**（`docs/dev/219-V3-IMAGE-VIDEO.md` §一）。
//
// ── 它凭什么不花钱 ─────────────────────────────────────────
// **拿一个根本不存在的名字去问**（`PREFLIGHT_MODEL`）：那一趟进不了业务
// ⇒ **不会画、不会做、也不会计费**。而**鉴权在路由之前**（`79-CREDS-TABS.md` §9.6 实测：
// 连一条根本不存在的路径也回同一个 401）⇒ 回话**不是鉴权类**，就说明"这把钥匙它认了"。
//
// ⚠️ **如实说清它证不了什么**：它**证不了"名字对不对、参数对不对"** ——
//    那必须真跑一次（`219` §五）。所以界面上那句话只说"这把钥匙它认了"，不说"能出片"。
//
// ── 三条纪律（与 `image.js` / `video.js` 那两条一模一样）──────
//   ① 🔴 **钥匙只进请求头**：返回值、日志、回执里一个字符都没有；
//   ② 🔴 **按人取**（`ark-check-use.js`：`credsFor` ＋ `sharedKeyOf`，与真那条路同一个规则）；
//   ③ 🔴 **不假装**：认不出就如实说，绝不把"没连上"说成"钥匙不行"（那两句必须分得开）。

import { DEFAULT_IMAGE_URL, buildImageRequest } from './image.js';
import { DEFAULT_VIDEO_BASE, buildVideoRequest, videoTasksUrl } from './video.js';

/** 编出来的名字：它**不可能**成功 ⇒ 这一趟**不花钱**。 */
export const PREFLIGHT_MODEL = 'hupo-preflight-definitely-not-a-real-model';

/** 自检最多等多久（毫秒）—— 自检是**快**的（两趟都是一句话的请求）。 */
export const ARK_CHECK_TIMEOUT_MS = 20_000;

/** 自检发出去的那句话（不是给人看的作品，只是把请求发出去）。 */
const PROBE_PROMPT = '这是一次自检，不必真的生成';

/**
 * 这三句是**鉴权那一层**的原话（实测）。
 *
 * 🔴 **这条规则只住这一处**：`scripts/check-ark-image.mjs` 与 `check-ark-video.mjs`
 *    的 `explainAuth()` 都从这里取（它们只负责把代号翻成给开发者看的那句话）。
 *    ⚠️ 别在脚本里再抄一遍正则 —— 抄了两处，迟早有一处漂。
 *
 * @returns {'missing'|'bad-shape'|'not-exist'|null}
 */
export function authClassOf(text) {
  const t = String(text ?? '');
  if (/API key or AK\/SK in the request is missing or invalid/i.test(t)) return 'missing';
  if (/API key format is incorrect/i.test(t)) return 'bad-shape';
  if (/API key doesn[’']?t exist/i.test(t)) return 'not-exist';
  return null;
}

/** 超时的那个 `signal`（判据里给了假 `fetch` ⇒ 这一行不参与）。 */
function timeoutSignal(ms) {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

/**
 * 打一趟"不可能成功"的请求，只回答一件事：**它到没到业务那一层**。
 *
 * ⚠️ 三种结局**必须分得开**：`reached`（到了业务）/ `auth`（被鉴权挡下）/ `why`（压根没连上）。
 */
async function probe({ url, body, key, fetch, timeoutMs }) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        // ⚠️ 钥匙只在这一行（这个对象**不许**被日志打出来）
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: timeoutSignal(timeoutMs),
    });
  } catch (err) {
    const code = err?.code ?? err?.name ?? '';
    return { reached: false, why: code === 'TimeoutError' || code === 'AbortError' ? 'timeout' : 'unreachable' };
  }
  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  }
  const cls = authClassOf(text);
  // 🔴 鉴权类（原话认得出来，或状态码就是 401/403）⇒ 这一条**没到业务**
  if (cls !== null || res.status === 401 || res.status === 403) {
    return { reached: false, auth: cls ?? 'status', status: res.status };
  }
  // 别的状态码（400 / 404 / 429 / 5xx…）⇒ **鉴权这一层过了**（名字是编的 ⇒ 业务当然拒它）
  return { reached: true, status: res.status };
}

/**
 * 验一次：**画图那条路**与**做视频那条路**各问一趟。
 *
 * @param {object} o
 * @param {string} o.key  他自己那把钥匙（**只进请求头，不进任何返回值**）
 * @param {Function} [o.fetch] 注入用（判据里换掉它 ⇒ 不联网、不花钱）
 * @returns {Promise<{ok:boolean, image:'ok'|'no', video:'ok'|'no', why:string|null, text:string, ms:number}>}
 */
export async function checkArkKey({
  key,
  imageUrl = DEFAULT_IMAGE_URL,
  videoBase = DEFAULT_VIDEO_BASE,
  fetch = globalThis.fetch,
  timeoutMs = ARK_CHECK_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  if (typeof key !== 'string' || key.trim() === '') {
    return { ok: false, why: 'no-key', text: arkCheckWords({ why: 'no-key' }), ms: 0 };
  }
  const k = key.trim();
  // ⚠️ 正文用**真那两个构造函数**（与真跑同一份形状）—— 只把名字换成编的
  const img = buildImageRequest({ prompt: PROBE_PROMPT, model: PREFLIGHT_MODEL });
  const vid = buildVideoRequest({ prompt: PROBE_PROMPT, model: PREFLIGHT_MODEL });
  const started = now();
  // 两趟并行（互不相干；串起来白等一趟的时间）
  const [a, b] = await Promise.all([
    probe({ url: imageUrl, body: img.body, key: k, fetch, timeoutMs }),
    probe({ url: videoTasksUrl(videoBase), body: vid.body, key: k, fetch, timeoutMs }),
  ]);
  const ms = now() - started;
  const image = a.reached ? 'ok' : 'no';
  const video = b.reached ? 'ok' : 'no';
  // 🔴 "连不上"与"钥匙不行"是两件事：两趟都没到业务、而且**都不是鉴权类** ⇒ 那才是连不上
  const netDown = !a.reached && !a.auth && !b.reached && !b.auth;
  const why = netDown ? 'unreachable' : image === 'no' && video === 'no' ? 'bad-key' : null;
  const out = { ok: image === 'ok' && video === 'ok', image, video, why, ms };
  return { ...out, text: arkCheckWords(out) };
}

/**
 * 给界面看的那句话（**人话**，没有内部词）。
 *
 * ⚠️ 它**只承诺验到的那件事**：说"这把钥匙它认了"，绝不说"能出片"（那要真跑一次）。
 */
export function arkCheckWords(r) {
  switch (r?.why) {
    case 'no-key':
      return '还没填钥匙 —— 在上面填一串，再验一次。';
    case 'unreachable':
      return '这会儿连不上那边，等会儿再试。';
    case 'bad-key':
      return '这一串它说用不了。在这儿换一串就好。';
    default:
      break;
  }
  const img = r?.image === 'ok';
  const vid = r?.video === 'ok';
  if (img && vid) return '这把钥匙它认了 —— 画图和做视频那两条路都通。（这一步没花钱）';
  if (img) return '画图那条通了；做视频那条它没认。换一串再验，或者跟我说一声。';
  if (vid) return '做视频那条通了；画图那条它没认。换一串再验，或者跟我说一声。';
  return '这一串它说用不了。在这儿换一串就好。';
}
