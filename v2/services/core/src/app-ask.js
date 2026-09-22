// **小程序问一句**（乙-4b · 契约 `docs/dev/59-USER-APPS.md` §七·补三）。
//
// ── 它是什么 ──────────────────────────────────────────────
// 主人定了调子：*"b 在小程序里如果用到 apikey，则用的就是 b 自己的。"*
// ⇒ **花这个动作必须发生在 b 自己的环境里**：
//    · 租户 ⇒ 他那个盒子里的小代理握着钥匙（`127.0.0.1:8787`），**在盒子里花**；
//    · 主人 ⇒ 他那台机器上（这一批**还没接上**，见 §八 的账）。
//
// 🔴 **制品永远拿不到钥匙**：页面只会说"我要问一句"，花的是**它所在的这个环境**的钥匙。
//    ⇒ 甲发的小程序被乙装上之后，花的是**乙**的钥匙 —— 因为它在**乙的环境**里跑。
//
// ⚠️ **它走的是"直连模型"，不是 agent**：没有工具、没有工作目录、改不了任何东西。
//    理由：`policy`（来源分级 → 能力档）**本轮不建**（`02-ARCHITECTURE.md` §八），
//    今天没有"只读档" ⇒ 把**别人写的话**丢给一个**全权执行体**是这个项目最怕的形状。
//    ⇒ 「直连模型」是今天唯一安全的形状。

/** 盒里那个小代理默认听哪儿（`hupo-model-proxy.yml` 把 dsh 也指到这儿）。 */
export const DEFAULT_PROXY_BASE = 'http://127.0.0.1:8787';

/**
 * 这一次该问哪个地址。
 *
 * ⚠️ **每次调用时读环境**，不是模块加载时定死 —— 定死的话，同一个进程里
 *    第二次换地址就不生效了（判据 `app-ask.test.js` 当场抓到过）。
 */
export function proxyBaseNow(env = process.env) {
  return env.HUPO_APP_ASK_BASE ?? DEFAULT_PROXY_BASE;
}

/** 问一句最多等多久。 */
export const ASK_TIMEOUT_MS = 30_000;

/** 用哪个模型名（**只住这一处**；换模型只改这儿）。 */
export const ASK_MODEL = process.env.HUPO_APP_ASK_MODEL ?? 'deepseek-chat';

/** 一次问话最多给多少字（防呆：页面的输入框不该把整本书塞进来）。 */
export const MAX_ASK_CHARS = 2000;

/** 拿回来的回答最多留多少字（**别把一整篇塞回一个 iframe**）。 */
export const MAX_ANSWER_CHARS = 4000;

/**
 * 请**本机的代理**替我们问一句（它握着钥匙，我们拿不到、也不需要）。
 *
 * @param {object} o
 * @param {string} o.prompt
 * @param {string} [o.base]
 * @param {string} [o.model]
 * @param {typeof fetch} [o.fetchImpl]
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{ok:true,text:string} | {ok:false,error:string}>}  **绝不抛**
 */
export async function askViaLocalProxy({
  prompt,
  base = null,
  model = ASK_MODEL,
  fetchImpl = globalThis.fetch,
  timeoutMs = ASK_TIMEOUT_MS,
} = {}) {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!text) return { ok: false, error: '没说要问什么' };
  if (text.length > MAX_ASK_CHARS) return { ok: false, error: '这一句太长了' };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`${(base ?? proxyBaseNow()).replace(/\/+$/u, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: 'user', content: text }],
      }),
      signal: ctl.signal,
    });
    if (!r.ok) {
      // ⚠️ **没有钥匙时如实说**（代理回 503），别把它说成"我问不出来"
      if (r.status === 503) return { ok: false, error: '这台设备上还没放钥匙' };
      return { ok: false, error: `问不出去（${r.status}）` };
    }
    const j = await r.json();
    const got = j?.choices?.[0]?.message?.content;
    if (typeof got !== 'string' || got.trim() === '') return { ok: false, error: '那边没有回话' };
    const cut = got.length > MAX_ANSWER_CHARS ? got.slice(0, MAX_ANSWER_CHARS) : got;
    return { ok: true, text: cut };
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, error: '等太久了，没等到回话' };
    // ⚠️ 主人那一份**今天还没接上**（他那台没有盒子，本机也没有代理）⇒ 如实说，
    //    别写成"我问不出来"（那是两件事：一件是我们没接上，一件是模型没答）。
    return { ok: false, error: '这台设备上还没接上问话那条路' };
  } finally {
    clearTimeout(timer);
  }
}
