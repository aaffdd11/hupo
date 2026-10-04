// **制品的第二个原点**（契约 `docs/dev/59-USER-APPS.md` §五）。
//
// ── N1 的落点 ─────────────────────────────────────────────
// 手册 N1：**执行第三方代码的东西（小程序）绝不与持有令牌的原点同源。**
// ⇒ 这个服务听**另一个端口**（生产：另一个域名）。浏览器按 `scheme+host+port` 判同源
//   ⇒ `:8021` 与 `:8020` **就是两个原点**：制品读不到壳的存储，壳的令牌也不会被带过去。
//
// ── 它只做三件（面越小越好）──────────────────────────────
//   ① 验签（签名绑人、绑版本、**短时效**）
//   ② 从**那个人自己的**目录里读文件（不认令牌、不知道别人是谁）
//   ③ 带上 CSP 返回
//
// ⚠️ **它不认识令牌**：iframe 的请求带不上 `Authorization`，所以"只有他自己可见"
//    靠的是**签名 URL**，不是登录态。这也意味着**这个口不读 `auth.json`**。
// ⚠️ **它不写任何东西**（连日志都只往外打，不落盘）。
// ⚠️ **不许发 `X-Frame-Options`** —— 发了壳里就嵌不进去（那是"页面白屏"的经典成因）。

import nodeCrypto from 'node:crypto';
import { SHELL_CSP, SHELL_CSS_PATH, SHELL_JS_PATH, SHELL_PATH, shellCss, shellHtml, shellJs, shellKindOf } from './mini-shell.js';
import nodeHttp from 'node:http';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeUrl from 'node:url';

import { LIVE_PREFIX, LIVE_VERSION, checkLiveRel, parseLivePath } from './app-live.js';
import { AppsError, isHiddenPathRefusal } from './apps.js';
// ★ **小程序自己那一格存储**（主人 2026-09-30 拍板 · 契约 `147-APP-SQLITE.md`）：
//   这一份只做"验凭据 → 交给**那个人那个 app** 的库去跑 → 把结论带回去"，
//   **自己不碰 SQLite、也不认路径**（执行在 `app-db.js`，路径在 `apps.js`）。
import { DB_PATH, mintTicket, verifyTicket } from './app-db.js';
// ⚠️ 只为了**认出"盒子不通"那一档**（它要回 503，不是"没这个文件"）——
//    `apps-box.js` 不 import 这一份，所以没有环。
import { BoxError } from './apps-box.js';

/** 制品 URL 的前缀：`/a/<id>/<version>/<path>`。 */
export const ARTIFACT_PREFIX = '/a/';

/**
 * ★ **壳给页面的那两条内边距的上限**（`pt` / `pb`，单位 px）。
 *
 * ⚠️ 它是一条**防注入**的闸：那两个数是壳按 `MediaQuery` 算出来、写进 URL 的，
 *    但 URL 是**页面自己也能改**的东西 ⇒ 只认 0..这个数，认不出来的当 0。
 *    （真正要紧的不是"数字大小"，而是**它一个字都不许跑进 HTML 结构里** ——
 *      所以这里先 `Number`＋`round`＋夹，再拼进那条 `<style>`。）
 */
export const MAX_SHELL_INSET = 400;

/** 把 URL 上那个数解成合法的内边距（认不出来 / 越界 ⇒ 0）。**纯函数**。 */
export function shellInsetOf(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  const v = Math.round(n);
  if (v <= 0) return 0;
  return v > MAX_SHELL_INSET ? MAX_SHELL_INSET : v;
}

/**
 * ★ 2026-10-01（主人报的"小程序没铺满、底色不同"）：**页面铺满整页，留白挪进页面里**。
 *
 * ── 为什么要由**壳**来写这一段（而不是叫每个作者自己留）──────────────
 * 主人原话：*「小程序不是铺满整页并加一个内容padding以防被聊天窗口遮住，而是用了 margin，
 * 导致页面没铺满，底色不同。」* ⇒ 从今天起：**那一层铺满整屏**（页面自己的底色铺到边上），
 * 而"别被聊天条压住"这件事**由壳注入一条 `body` 的 padding** 来做 ——
 * 这样**已经做好的老页面也一起对**（不用重发、不用作者记得）。
 *
 * ⚠️ 用 `!important` ＋ `box-sizing:border-box`：页面自己的 `body{padding:…}` 压不过它，
 *    而且 `box-sizing` 保证"自己写了 `height:100vh` 的页面"不会因为多出这条内边距而溢出。
 * ⚠️ **只在壳带了这个数（`pt`/`pb` 大于 0）时才注入**：老客户端不带 ⇒ 一个字节都不动
 *    （它那一侧照旧用"把 iframe 缩小"的老办法，见 `mini_app_host.dart`）。
 * ⚠️ **不碰 `<head>` 之外的结构**：只在 `</head>` 前插一段 `<style>`（找不到 head 就退回
 *    文档最前面）。**一个标签都不删、不改。**
 *
 * @param {string} html 制品原文
 * @param {{padTop?:number, padBottom?:number}} o 壳给的两条内边距（px）
 * @returns {string} 注入之后的 HTML；两个数都是 0 ⇒ **原样返回**
 */
export function injectShellInset(html, { padTop = 0, padBottom = 0 } = {}) {
  const top = shellInsetOf(padTop);
  const bottom = shellInsetOf(padBottom);
  if (top === 0 && bottom === 0) return html;
  const style =
    '<style id="hupo-shell-inset">' +
    '/* 琥珀壳给的边距：让页面铺满，同时不被底下的聊天条压住 —— **别自己再加一份** */' +
    'body{' +
    `padding-top:${top}px !important;` +
    `padding-bottom:${bottom}px !important;` +
    'box-sizing:border-box !important}' +
    '</style>';
  const at = html.search(/<\/head\s*>/i);
  if (at !== -1) return html.slice(0, at) + style + html.slice(at);
  const bodyAt = html.search(/<body[^>]*>/i);
  if (bodyAt !== -1) {
    const end = html.indexOf('>', bodyAt) + 1;
    return html.slice(0, end) + style + html.slice(end);
  }
  return style + html;
}

/** 签名 URL 的有效期。**短**是刻意的：它是一条"凭 URL 就能取"的能力。 */
export const SIGNED_TTL_MS = 10 * 60 * 1000;

/**
 * 制品页的 CSP。
 *
 * 🔴 逐条都是故意的：
 *   · `default-src 'none'` —— **默认什么都不许**（fail-closed）
 *   · `script-src 'unsafe-inline'` / `style-src 'unsafe-inline'` —— 制品是单文件 HTML（不引外部资源）
 *   · `connect-src 'self'` —— ★ **2026-09-30 改的**（原来是 `'none'`）：制品只许对它
 *     **自己那个原点**发请求 —— 那一条就是"替我存一笔"那条窄口（`POST /db`，
 *     契约 `147-APP-SQLITE.md`）。
 *     🔴 **为什么必须是"它自己的源"**：网页那一侧是 `<iframe sandbox>`（不透明源）、
 *     安卓那一侧是 WebView（顶层文档）—— **两边都从 `apps.stalkerai.cn` 加载制品**
 *     ⇒ 白名单与取用方式**天生两端一致**，不用两边各写一套（这是"不给原生桥"那条铁律下
 *     唯一能把能力给到两端的路）。
 *     ⚠️ 它**仍然出不去**：别人的站一个都不在白名单里 ⇒ 想连也连不上（"访问网站"那条
 *     能力要主人另外拍，见 `146-MINIAPP-REDESIGN.md`）。
 *   · `base-uri 'none'` / `form-action 'none'` —— 堵住"改 base 之后把请求发到别处"
 *   · `frame-ancestors <壳>` —— **只许壳嵌它**（别处嵌不了）
 */
export function cspFor(frameAncestors, hosts = []) {
  /**
   * ★ **`148` §二：`net` 白名单进不进这一条，全看"他有没有关掉"**。
   *
   * 🔴 那一下**由浏览器/WebView 自己执行**（CSP 是硬的）—— 关掉开关 ⇒ 名单**立刻不进 CSP**
   *    ⇒ 制品当场连不出去（判据 `N4`）。这是"设置里能关"这句话**真的成立**的地方。
   * ⚠️ 名单里的每一串**已经过 `checkNetHosts`**（`apps.js`）—— 到这儿只做"拼上去"，
   *    **不再自己解析**（安全边界只有一处）。这里再兜一道形状（认不出来就丢掉那一条）。
   */
  const allow = [];
  for (const h of Array.isArray(hosts) ? hosts : []) {
    if (typeof h === 'string' && /^[a-z0-9.-]+$/.test(h) && h.length <= 100) allow.push(`https://${h}`);
  }
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    ['connect-src', "'self'", ...allow].join(' '),
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join('; ');
}

/**
 * ★ **这一版制品该拿到哪些站**（`148` §二）。
 *
 * 三条一起才算：① 制品**声明了 `net`** ② **他没关掉**（`grants` 里有 `net`）
 * ③ `meta` 里那份名单。任何一种读不出来 ⇒ **空名单**（fail-closed：宁可连不出去，
 * 也不许"名单读不出来就放行"）。
 */
export async function netHostsFor(apps, id) {
  try {
    const meta = typeof apps?.meta === 'function'
      ? apps.meta(id)
      // 租户那一侧：盒代理没有 `meta`，但它的清单里每一格字段是齐的（`/internal/apps`）
      : (await apps.list()).find((a) => a.id === id);
    if (!meta) return [];
    if (!Array.isArray(meta.permissions) || !meta.permissions.includes('net')) return [];
    let granted = [];
    try {
      granted = typeof apps.grants === 'function' ? apps.grants(id) : [];
    } catch {
      granted = [];
    }
    if (!granted.includes('net')) return [];
    return Array.isArray(meta.net) ? meta.net : [];
  } catch {
    return [];
  }
}

/** ★ **"替我问一句"那条口的路**（app 原点上的 `POST /ask`）——与 `/db` 同一个形状。 */
export const ASK_PATH = '/ask';

/**
 * ★ **`148` §三："跟它的助手说一句"那条口**（app 原点上的 `POST /agent`）。
 *
 * 同一条路两个动作（**按正文分岔**）：
 *   · `{…, prompt}`          ⇒ **问**（送进那一间，回一张 `jobId` 票）；
 *   · `{…, jobId}`           ⇒ **取回执**（`running` / `done` / `failed` / `timeout`）。
 * ⚠️ `jobId` 就是那张会话票（绑人绑 app ＋ 里面记着"问的是哪一号、什么时候问的"）——
 *    页面**伪造不出**别人的回执（改一个字符验不过）。
 */
export const AGENT_PATH = '/agent';

/**
 * ★ **`A3`（D4.24 · 2026-10-03 定）：入口 URL 里不带人 ⇒ "这是谁"只能从签名里认。**
 *
 * ── 形状（这一处**两条路、两张口共用**）────────────────────
 *   · URL / 正文里**没有**任何身份字段（只有签名 `s` 与到期 `e`）；
 *   · 拿**已知的人**逐个试那条签名（`sub` 本来就是签名 payload 的一格）——
 *     试中的那个就是"谁"，试不中就一个都不算（fail-closed）。
 *
 * 🔴 **为什么不是"URL 带一个不透明 handle"**：口径是"**URL 只带签名 + 到期**"
 *    （`90` §10.1·⑤）。带 handle 等于把身份换个写法带出去 —— 那还是"URL 上有一个
 *    可关联到人的指针"（第三方制品读一下 `location.search` 就能跨页 join）。
 *    ⇒ 只有当"人"**一个字都不在 URL 上**时，那条判据才是结构性的。
 *
 * ⚠️ **代价（记在明处）**：一次请求最多算 `subs` 条数的 HMAC。今天这台部署的人很少；
 *    真到很大那一天，这里要换成"按签名查表"—— 但**判定仍然只在这一处**，不许分叉。
 *
 * @param {object} o
 * @param {Buffer|string} o.key   签名键
 * @param {string} o.sig          签名（URL 上那一格）
 * @param {string} o.id           app id（签名绑了它）
 * @param {string|number} o.version 版本（或活地址哨兵 `live`）
 * @param {string} o.exp          到期
 * @param {string[]} o.subs       **已知的人**（`serve.js` 给的是"这台部署登记过的人"）
 * @param {number} [o.now]
 * @returns {string|null} 签名属于谁；认不出 ⇒ `null`
 */
export function resolveEntrySub({ key, sig, id, version, exp, subs, now = Date.now() }) {
  for (const sub of Array.isArray(subs) ? subs : []) {
    if (typeof sub !== 'string' || sub === '') continue;
    if (verifyEntry({ key, sig, sub, id, version, exp, now })) return sub;
  }
  return null;
}

/**
 * ★ **app 原点上那几条口（`/db` 与 `/ask`）共用的凭据判定**（别的都不认）：
 *   · 第一次：页面把它自己那条入口 URL 里的两样（`e`/`s`）＋ 它自己是谁（`id`/`v`）报上来
 *     ⇒ **照入口签名那四道验一遍**（绑人 ＋ 绑 app ＋ 绑版本 ＋ 没过期）；
 *     ⚠️ **`A3` 之后 URL 上没有 `u` 了** ⇒ 人由 `subsOf` 逐个试签名认出来
 *     （老页面照旧把 `u` 一起报上来 —— **那一格今天被忽略**，认人只看签名）。
 *   · 之后：上一次换来的**会话票**（`ticket`）。
 *
 * 🔴 **为什么要有票**：入口 URL 只有十分钟（`SIGNED_TTL_MS`）—— 而一个页面可能开着几小时。
 *    票一次签发、绑同一个人同一个 app，**权限每次都重查**（撤销立刻生效）。
 * ⚠️ **票只在内存里算**（HMAC，不落盘、不上账）⇒ 重启就让所有票失效（可接受，页面刷新即可）。
 */
export function appTicketOf({ key, body, id, version, now = Date.now(), subsOf = null }) {
  const ticket = typeof body?.ticket === 'string' ? body.ticket : '';
  if (ticket !== '') return verifyTicket({ key, ticket, id, now });
  let subs = [];
  try {
    subs = typeof subsOf === 'function' ? subsOf() : [];
  } catch {
    subs = [];
  }
  const sub = resolveEntrySub({
    key,
    sig: typeof body?.s === 'string' ? body.s : '',
    id,
    version,
    exp: typeof body?.e === 'string' ? body.e : '',
    subs,
    now,
  });
  if (sub === null) return null;
  // ⚠️ `exp` 照老形状回（有些调用方读它）—— 数值化失败回 `NaN`，跟老代码一个字不差。
  return { sub, id, version, exp: Number(body.e) };
}

/** 签名要覆盖的那串东西：**绑人 + 绑版本 + 绑到期**。 */
export function signPayload({ sub, id, version, exp }) {
  return `${sub}|${id}|${version}|${exp}`;
}

/** 算签名（十六进制）。 */
export function signEntry({ key, sub, id, version, exp }) {
  return nodeCrypto.createHmac('sha256', key).update(signPayload({ sub, id, version, exp })).digest('hex');
}

/**
 * 验签名。**四条一起验**（少一条都可能被人换一个维度用）：格式 · 到期 · 绑的人 · 内容对得上。
 *
 * ⚠️ 比较用 `timingSafeEqual`（先各自 sha256 一道，避免长度不同直接抛）。
 */
export function verifyEntry({ key, sig, sub, id, version, exp, now = Date.now() }) {
  if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const e = Number.parseInt(exp, 10);
  if (!Number.isInteger(e) || e < now) return false;
  let want;
  try {
    want = signEntry({ key, sub, id, version, exp: e });
  } catch {
    return false;
  }
  const a = nodeCrypto.createHash('sha256').update(sig).digest();
  const b = nodeCrypto.createHash('sha256').update(want).digest();
  return nodeCrypto.timingSafeEqual(a, b);
}

/**
 * **入口 URL 的基地址**（乙-5）：**对外那个优先**，没配才退回本机那个。
 *
 * 🔴 抽成纯函数是刻意的：它是"**上线只改配置**"那句话的落点 ——
 *    写死在 `serve.js` 里的话，那句话就只能靠读代码相信（判据钉不住）。
 *
 * @param {{appsPublicBase?:string|null, appsHost?:string, appsPort?:number}} cfg
 */
export function appsBaseOf(cfg = {}) {
  const pub = typeof cfg.appsPublicBase === 'string' ? cfg.appsPublicBase.trim() : '';
  if (pub) return pub.replace(/\/+$/u, ''); // 尾斜杠去掉（拼的时候会再加）
  return `http://${cfg.appsHost ?? '127.0.0.1'}:${cfg.appsPort ?? 8021}`;
}

/**
 * 拼一条入口 URL。`base` 形如 `http://127.0.0.1:8021`（**不带尾斜杠**）。
 *
 * 🔴 **`A3`（D4.24 · 2026-10-03 定）：URL 上只带"签名 + 到期"，不带人。**
 *    绑人照旧在签名里（`signEntry` 的 payload 第一格就是 `sub`）——
 *    但那个值**一个字都不出现在 URL 上** ⇒ 第三方制品读 `location.search`
 *    也拿不到访客是谁（`90` §9.2·1／§10.1·⑤ 要的就是这一条）。
 *    ⚠️ 验的一方怎么知道是谁：**拿已知的人逐个试签名**（`resolveEntrySub`）。
 */
export function entryUrl({ base, key, sub, id, version, entry, now = Date.now(), ttlMs = SIGNED_TTL_MS }) {
  const exp = now + ttlMs;
  const sig = signEntry({ key, sub, id, version, exp });
  const q = new URLSearchParams({ e: String(exp), s: sig });
  return `${base}${ARTIFACT_PREFIX}${id}/${version}/${entry}?${q}`;
}

/**
 * ★ **一条"活地址"**：`/w/<id>/<rel>` —— 打开的是**那一间工作区里现在那一份**
 * （契约 `docs/dev/112-OWN-APP-IS-LIVE.md`）。
 *
 * 🔴 **签名照旧**：同一把键、同一个 TTL、同一个 `signEntry`、同样四道验。
 *    变的只有 payload 里"取的是哪一份"那一格 —— 活地址用哨兵 `live`
 *    （见 `app-live.js` 的 `LIVE_VERSION`：那一格顺带做**域分离**，
 *    一份签名只对"它当初签的那条路"有用）。
 *
 * ⚠️ **它和 `entryUrl()` 是两条路，不是一个函数的两个分支**：产物不同
 *    （`/w/` vs `/a/<version>/`）、失效方式也不同（一个是"他改了就是新的"，
 *    一个是"那一版永远不变"）。混成一个函数，下一次改就分不清哪条是哪条。
 */
export function liveEntryUrl({ base, key, sub, id, entry, now = Date.now(), ttlMs = SIGNED_TTL_MS }) {
  const exp = now + ttlMs;
  const sig = signEntry({ key, sub, id, version: LIVE_VERSION, exp });
  // 🔴 `A3`：和 `entryUrl()` 一样 —— **URL 上没有人**（只有 `e` 与 `s`）。
  const q = new URLSearchParams({ e: String(exp), s: sig });
  return `${base}${LIVE_PREFIX}${id}/${entry}?${q}`;
}

/**
 * 解析 `/a/<id>/<version>/<path>`。**解析不出来一律 `null`**（不猜）。
 * ⚠️ 这里只做"形状"，路径安全由 `apps.js` 的 `checkRelPath` 再验一道（两道都要）。
 */
export function parseArtifactPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(ARTIFACT_PREFIX)) return null;
  const rest = pathname.slice(ARTIFACT_PREFIX.length);
  const parts = rest.split('/');
  if (parts.length < 3) return null;
  const [id, version, ...tail] = parts;
  const rel = tail.join('/');
  // 形状先过一道（真正的路径安全在 `apps.js` 的 `checkRelPath`，两道都要）
  if (!id || !rel) return null;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return null;
  if (!/^[1-9][0-9]*$/.test(version)) return null;
  return { id, version, rel };
}

/**
 * **签名密钥**：没有就现生成一个（`0600`），有就读回来。
 *
 * ⚠️ 它**不是**用户那把模型钥匙（那是 `key-path.mjs` 的事）。这一把只用来签入口 URL。
 * ⚠️ **绝不进日志、绝不回显**。它一变，所有已发出去的 URL 立刻失效（这是可接受的：
 *    有效期本来就只有十分钟）。
 */
export function loadSignKey(file, fs = nodeFs) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  } catch {
    /* 没有就现生成 */
  }
  const key = nodeCrypto.randomBytes(32);
  fs.mkdirSync(nodePath.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${key.toString('hex')}\n`, { mode: 0o600 });
  return key;
}

/** 一句话回给浏览器（**别泄漏细节**：分不出"签名不对"和"没这个文件"更好）。 */
function deny(res, status = 403) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(status === 403 ? '取不到这个文件。\n' : '这里没有这个文件。\n');
}

/**
 * ★ **`112`：他那台盒子不通 ⇒ 503 ＋ 一句人话**。
 *
 * 🔴 为什么非要与 404 分开：租户那一份的字**在他盒子里** —— 盒子不通时
 *    回 404 就是**页面在说假话**（"这里没有这个文件"，而他明明有，只是那台没应）。
 *    `apps-box.js` 的契约写的就是"盒子不通 ⇒ 如实回 503/403"。
 * ⚠️ 文案**不带任何内部细节**（不出 HTTP 码、不出盒子名）：它是给那个沙箱页面看的。
 */
function denyBox(res) {
  res.writeHead(503, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end('这个现在打不开，等会儿再试试。\n');
}

/**
 * ★ **读侧那道闸拒了 ⇒ 回一条看得见的理由**（`D4.24` · 2026-10-03 主人点头「加」；
 *    契约 `docs/dev/164-READ-SIDE-HIDDEN-GATE.md`）。
 *
 * 🔴 **为什么不能再用 `deny(res, 404)`**：404 说的是"这里没有这个文件" ——
 *    而这一档里文件**在**、也**在制品里**，只是**按规矩不许从制品口取**。
 *    拿 404 顶它，就是"悄悄地弄坏"（`dev/158` §五·1 明写不接受的那一种）。
 *
 * 🔴 **为什么这不是"泄漏细节"**：`rel` 本来就在请求的 URL 上；`why` 是
 *    `apps.js` 那条规则的原文（**同一处规则，不另抄一份**）；文案里没有人、没有盒子名、
 *    没有 HTTP 码以外的东西。它要回答的正是那三句：**谁拒的 · 拒的是什么 · 该怎么办**。
 *
 * ⚠️ 状态码用 403（"我懂你的请求，但我不给"），并带 `x-hupo-refusal: hidden-path`
 *    那个头 —— 机器（闸脚本 / 排障）据此与"签名不过"那一档分开。
 */
function denyRefusedPath(res, { id, rel, why }) {
  const body =
    '这个文件被拦下了。\n'
    + '谁拦的：琥珀的制品口\n'
    + `拦的是什么：${id} 里的「${rel}」\n`
    + `为什么：${why}\n`
    + '这不是「没有这个文件」，也不是签名不对 —— 是这一条路径按规矩不许从制品口取。\n'
    + '怎么办：把它从制品里去掉（数据放它自己那一格存储，别放进制品），重新发一版。\n';
  res.writeHead(403, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-hupo-refusal': 'hidden-path',
  });
  res.end(body);
}

/**
 * 起那个口。
 *
 * @param {object} o
 * @param {(sub:string)=>{read:(id:string,version:any,rel:string)=>{content:Buffer,contentType:string}}|null} o.resolveApps
 *        按人去取制品库（`/a/` 那条路）。**取不到就 `null`**（`null` ⇒ 一律拒 —— fail-closed）
 * @param {(sub:string)=>{readLive:(id:string,rel:string)=>{content:Buffer,contentType:string}}|null} [o.resolveLive]
 *        ★ **按人去取"活的工作区"**（`/w/` 那条路 · 契约 112）。**不给 / 取不到 ⇒ 一律拒**
 *        （fail-closed：宁可他点开说取不到，也不许把"某一版快照"顶上活地址）。
 * @param {Buffer|string} o.key      签名密钥（**不进日志**）
 * @param {string} o.frameAncestors  壳的 origin（CSP `frame-ancestors`）
 * @param {()=>string[]} [o.subsOf]
 *        ★ **`A3`：这台部署"登记过的人"**（URL 上没有人 ⇒ 拿他们逐个试签名，见 `resolveEntrySub`）。
 *        `serve.js` 给的是 `[OWNER_ID, ...users.ids()]`。**不给 ⇒ 一律拒**（fail-closed：
 *        宁可他点开说取不到，也不许"猜一个人"出来）。
 * @param {(m:string)=>void} [o.log]
 * @param {()=>number} [o.now]
 */
export function createAppServer({
  resolveApps,
  resolveLive = null,
  key,
  frameAncestors,
  // ★ **`A3`（D4.24）：URL 上不带人 ⇒ 验签那一侧得知道"可能是谁"**。
  subsOf = null,
  // ★ **`148`：替小程序问一句**（"app 对它自己那个源发一次请求"那条路）。
  //   `null` ⇒ 这条口不接（如实 503），**绝不假装它答上来了**。
  askApp = null,
  // ★ **`148` §三：跟它的助手说一句**（问 ＋ 取回执）。`null` ⇒ 同上（如实 503）。
  agentAsk = null,
  agentPoll = null,
  log = () => {},
  now = Date.now,
}) {
  if (!key) throw new AppsError('签名密钥必填');
  if (!frameAncestors) throw new AppsError('frameAncestors 必填（CSP 要它）');
  // ⚠️ 这个只是**兜底**（`/db`、`/ask` 那几条口与"算不出 app"时用它）——
  //    真正发出去的那一条是**按 app 算的**（见下面 `cspForApp`）。
  const csp = cspFor(frameAncestors);

  /** 按 app 算 CSP：**只有它自己声明的那些站**（`netHostsFor` 已经把三道闸过完了）。 */
  async function cspForApp(apps, id) {
    const hosts = await netHostsFor(apps, id);
    return hosts.length === 0 ? csp : cspFor(frameAncestors, hosts);
  }

  /**
   * ★ **`A3`：这一台部署登记过的人**（认人用 —— URL 上没有身份字段）。
   * 取不出来一律当"没有人"（fail-closed）：宁可他点开说取不到，也不许猜一个出来。
   */
  function subsNow() {
    try {
      return typeof subsOf === 'function' ? subsOf() : [];
    } catch {
      return [];
    }
  }

  /**
   * app 原点那几条口共用的跨源头。
   *
   * **为什么这里能写 `*`**：这些口不吃 cookie、不吃登录态 —— 凭据是页面自己那条
   * **绑人绑 app 的签名**（在正文里），所以"谁都能发这个请求"不等于"谁都能读别人的数据"。
   */
  const APP_CORS = {
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };

  /** 一条口回 JSON 的那一下（两条口共用）。 */
  function makeAppSender(res) {
    return (status, obj) => {
      const buf = Buffer.from(`${JSON.stringify(obj)}\n`, 'utf8');
      res.writeHead(status, { ...APP_CORS, 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
      res.end(buf);
    };
  }

  /**
   * ★ **app 原点那几条口共用的前四步**（跨源头 → 读正文 → 认目标 → 验凭据）。
   *
   * 抽出来是为了**两条口不可能分叉**（`/db` 与 `/ask`）：改一处、两条一起改
   * —— 和"闸只有一处"同一条纪律。
   *
   * @returns {Promise<{ok:true, body:object, id:string, v:string, sub:string}
   *                   | {ok:false, done:true}>} `done:true` = 这一条**已经答过了**，调用方直接 return
   */
  async function readAppCall(req, res, cors, send) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      });
      res.end();
      return { ok: false, done: true };
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { ...cors, 'content-type': 'text/plain; charset=utf-8', allow: 'POST' });
      res.end('只支持 POST。\n');
      return { ok: false, done: true };
    }
    const body = await readJsonBody(req, 64 * 1024);
    if (!body) {
      send(400, { ok: false, error: 'bad-body', text: '这一条看不懂。' });
      return { ok: false, done: true };
    }
    const id = typeof body.id === 'string' ? body.id : '';
    const v = typeof body.v === 'string' || typeof body.v === 'number' ? String(body.v) : '';
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !(v === LIVE_VERSION || /^[1-9][0-9]*$/.test(v))) {
      send(403, { ok: false, error: 'bad-target', text: '这一条不认。' });
      return { ok: false, done: true };
    }
    const who = appTicketOf({ key, body, id, version: v, now: now(), subsOf: subsNow });
    if (!who) {
      log(`app 原点：凭据不过（${id}）`);
      send(403, { ok: false, error: 'bad-ticket', text: '这一条不认。' });
      return { ok: false, done: true };
    }
    return { ok: true, body, id, v, sub: who.sub };
  }

  /**
   * ★ **"替我存一笔"那条口**（`POST /db` · 契约 `147-APP-SQLITE.md`）。
   *
   * 顺序（**一道都不许省**）：
   *   ① 跨源预检（不透明源那一侧要它）→ ② 读 JSON → ③ **验凭据**（入口签名 / 会话票）
   *   → ④ 取**那个人那个 app** 的库 → ⑤ 交给它跑（声明 / 授予 / 语句 / 上限都在那边）
   *   → ⑥ 把结论 ＋ 一张新票带回去。
   *
   * 🔴 **这一份不碰 SQLite、不认路径、不认令牌**：它只把"这是谁、哪个 app"验出来。
   * 🔴 **失败一律如实说**（盒子不通 ⇒ 503，不是"没这个 app"）—— 三处一个口径，见 `B27`。
   */
  async function handleDb(req, res) {
    /**
     * 跨源要的三样。**为什么这里能写 `*`**：这条口不吃 cookie、不吃登录态 ——
     * 凭据是页面自己那条**绑人绑 app 的签名**（在正文里），所以"谁都能发这个请求"
     * 不等于"谁都能读别人的数据"（验签那一步是硬的）。
     */
    const cors = APP_CORS;
    const send = makeAppSender(res);
    const call = await readAppCall(req, res, cors, send);
    if (call.ok !== true) return;
    const { body, id, v, sub } = call;
    let apps = null;
    try {
      apps = resolveApps(sub);
    } catch (e) {
      // ⚠️ 与制品那条路**同一个口径**：取库这一步不许把进程带走；盒子不通 ⇒ 503
      log(`存储口：取库那一步出错（${sub}）${e?.message ?? e}`);
      if (e instanceof BoxError) {
        denyBox(res);
        return;
      }
      send(403, { ok: false, error: 'no-store', text: '这一条不认。' });
      return;
    }
    if (!apps || typeof apps.dbExec !== 'function') {
      /**
       * 🔴 **认不出来就如实说"还没跟上"**：盒子里那份代码可能是**还没换过去**的旧版
       *    （产品层要重新发布才带上这条能力）⇒ 那**不是**"你这个 app 不许存"，
       *    而是"这一台还没有这个能力"。混成 403 就是页面在说假话。
       */
      send(503, { ok: false, error: 'not-ready', text: '这一台还没跟上，等一会儿再试。' });
      return;
    }
    let out = null;
    try {
      out = await apps.dbExec(id, { op: body.op, sql: body.sql, params: body.params });
    } catch (e) {
      if (e instanceof BoxError) {
        denyBox(res);
        return;
      }
      log(`存储口：跑不出来（${id}）${e instanceof AppsError ? e.message : (e?.message ?? '未知错')}`);
      send(404, { ok: false, error: 'no-app', text: '这个小程序不在你这儿。' });
      return;
    }
    if (!out || out.ok !== true) {
      send(Number(out?.status) || 400, {
        ok: false,
        error: out?.error ?? 'db',
        text: out?.text ?? out?.error ?? '这一条它没执行成功。',
      });
      return;
    }
    send(200, {
      ok: true,
      rows: out.rows,
      changes: out.changes,
      lastInsertRowid: out.lastInsertRowid,
      truncated: out.truncated === true,
      // 页面把这张票留着，后面就不用反复出示入口签名了（入口 URL 只有十分钟）
      ticket: mintTicket({ key, sub, id, version: v, now: now() }),
    });
  }

  /**
   * ★ **"替我问一句"那条口**（`POST /ask` · 契约 `docs/dev/148-APP-FULL-SET.md`）。
   *
   * ── 它补的是什么（2026-09-30）──────────────────────────────
   *   原来 `ask` 只有**壳的桥**那一条路（制品 `postMessage` → 壳 → 服务端）⇒
   *   **只有网页那一侧有**（安卓不许装桥 ⇒ 平板上问不了话）。
   *   现在制品**对它自己那个源**发一次请求（和存东西 `/db` **同一个形状**）⇒
   *   **两端都通**，而且**不再依赖壳**。
   *
   * ⚠️ **闸与配额不在这儿**：这一份只验"这是谁、哪个 app"，判定全交给 `askApp`
   *    （它跑的是和 `/api/app-ask` **同一个** `askForApp`：声明 → 允许 → 配额 → 花在谁的环境里）。
   */
  async function handleAsk(req, res) {
    const cors = APP_CORS;
    const send = makeAppSender(res);
    const call = await readAppCall(req, res, cors, send);
    if (call.ok !== true) return;
    const { body, id, sub } = call;
    if (typeof askApp !== 'function') {
      // 🔴 **认不出来就如实说"还没跟上"**（不是"你不许问"）—— 别让页面以为是他关掉了
      send(503, { ok: false, error: 'not-ready', text: '这一台还没跟上，等一会儿再试。' });
      return;
    }
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    if (prompt.trim() === '') {
      send(400, { ok: false, error: 'bad-prompt', text: '这一条是空的。' });
      return;
    }
    let out = null;
    try {
      out = await askApp({ sub, appId: id, prompt });
    } catch (e) {
      log(`问一句：没答上来（${id}）${e?.message ?? e}`);
      send(502, { ok: false, error: 'ask-failed', text: '它这会儿没答上来，等会儿再试。' });
      return;
    }
    if (!out || out.ok !== true) {
      send(Number(out?.status) || 502, {
        ok: false,
        error: out?.error ?? 'ask-failed',
        // ⚠️ 闸那两句人话在 `error` 里（"这个小程序没说要问话" / "你还没允许它用你的钥匙"）——
        //    页面照 `text` 显示 ⇒ 这里**必须**兜到 `error`（不然屏幕上是那句含糊的兜底话）
        text: out?.text ?? out?.error ?? '它这会儿没答上来，等会儿再试。',
      });
      return;
    }
    send(200, {
      ok: true,
      text: out.text,
      left: out.left ?? null,
      max: out.max ?? null,
      // 页面把这张票留着，后面就不用反复出示入口签名了（入口 URL 只有十分钟）
      ticket: mintTicket({ key, sub, id, version: call.v, now: now() }),
    });
  }

  /**
   * ★ **`148` §三："跟它的助手说一句"**（`POST /agent`）。
   *
   * 🔴 **它比 `/ask` 重**：`/ask` 是直连模型问一句；这一条是**请动那一间的助手**
   *    （它有手：能读文件、能查网）⇒ 所以：**配额更紧** ＋ **每次都看得见**
   *    （问题以"来自小程序"的样子落进那一间，他翻得到）。
   * ⚠️ 闸与配额**不在这一份里**：全交给 `agentAsk`（它与 `/api/app-ask` 那条**同源**的判定）。
   */
  async function handleAgent(req, res) {
    const cors = APP_CORS;
    const send = makeAppSender(res);
    const call = await readAppCall(req, res, cors, send);
    if (call.ok !== true) return;
    const { body, id, v, sub } = call;

    // ── 取回执那一路（`jobId` 在时就只干这个）──────────────────
    const jobId = typeof body.jobId === 'string' ? body.jobId : '';
    if (jobId !== '') {
      if (typeof agentPoll !== 'function') {
        send(503, { ok: false, error: 'not-ready', text: '这一台还没跟上，等一会儿再试。' });
        return;
      }
      // 🔴 回执那张票**绑的是同一个 app**（换一个 app 拿它问 ⇒ 验不过）
      const t = verifyTicket({ key, ticket: jobId, id, now: now() });
      if (!t) {
        send(403, { ok: false, error: 'bad-job', text: '这一条不认。' });
        return;
      }
      const m = /^agent-([0-9]+)-([0-9]+)$/.exec(String(t.version ?? ''));
      if (!m) {
        send(403, { ok: false, error: 'bad-job', text: '这一条不认。' });
        return;
      }
      let out = null;
      try {
        out = agentPoll({ sub, appId: id, seq: Number(m[1]), at: Number(m[2]) });
      } catch (e) {
        log(`跟助手说话：取回执没成（${id}）${e?.message ?? e}`);
        send(502, { ok: false, error: 'poll-failed', text: '这会儿取不到，等会儿再试。' });
        return;
      }
      if (!out || out.ok !== true) {
        send(Number(out?.status) || 502, { ok: false, error: out?.error ?? 'poll-failed', text: out?.text ?? '这会儿取不到，等会儿再试。' });
        return;
      }
      send(200, { ok: true, state: out.state, text: out.text ?? null });
      return;
    }

    // ── 问那一路 ───────────────────────────────────────────
    if (typeof agentAsk !== 'function') {
      send(503, { ok: false, error: 'not-ready', text: '这一台还没跟上，等一会儿再试。' });
      return;
    }
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    if (prompt.trim() === '') {
      send(400, { ok: false, error: 'bad-prompt', text: '这一条是空的。' });
      return;
    }
    let out = null;
    try {
      out = await agentAsk({ sub, appId: id, prompt });
    } catch (e) {
      log(`跟助手说话：没送出去（${id}）${e?.message ?? e}`);
      send(502, { ok: false, error: 'agent-failed', text: '这一句没送出去，等会儿再试。' });
      return;
    }
    if (!out || out.ok !== true) {
      send(Number(out?.status) || 502, {
        ok: false,
        error: out?.error ?? 'agent-failed',
        // 闸那几句人话在 `error` 里（页面照 `text` 显示 ⇒ 必须兜到它）
        text: out?.text ?? out?.error ?? '这一句没送出去，等会儿再试。',
      });
      return;
    }
    // 回执那张票：**绑人绑 app**，而且里面记着"问的是哪一号、什么时候问的"
    const token = mintTicket({ key, sub, id, version: `agent-${out.seq}-${out.at}`, now: now() });
    send(200, { ok: true, jobId: token, state: 'running' });
  }

  /** 读一小段 JSON 正文（**超了就当读不懂**，不许把内存吃光）。 */
  function readJsonBody(req, limit) {
    return new Promise((resolve) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
          resolve(j && typeof j === 'object' ? j : null);
        } catch {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
    });
  }

  return nodeHttp.createServer((req, res) => {
    let parsed;
    try {
      parsed = nodeUrl.parse(req.url, false);
    } catch {
      deny(res, 403);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // ★ **唯一的那个 POST**：小程序存它自己的那一笔（`147-APP-SQLITE.md`）。
      //   别的非 GET 一律照旧 405 —— 这一条口**只认这一条路**。
      if ((parsed.pathname ?? '') === AGENT_PATH) {
        handleAgent(req, res).catch((e) => {
          log(`跟助手说话：这一条没答上来（${e?.message ?? e}）`);
          try {
            if (!res.headersSent) {
              res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('这一句没送出去。\n');
            } else {
              res.destroy();
            }
          } catch {
            /* 已经断了 */
          }
        });
        return;
      }
      if ((parsed.pathname ?? '') === ASK_PATH) {
        handleAsk(req, res).catch((e) => {
          log(`问一句：这一条没答上来（${e?.message ?? e}）`);
          try {
            if (!res.headersSent) {
              res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('它这会儿没答上来。\n');
            } else {
              res.destroy();
            }
          } catch {
            /* 已经断了 */
          }
        });
        return;
      }
      if ((parsed.pathname ?? '') === DB_PATH) {
        handleDb(req, res).catch((e) => {
          log(`存储口：这一条没答上来（${e?.message ?? e}）`);
          try {
            if (!res.headersSent) {
              res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('这一条它没执行成功。\n');
            } else {
              res.destroy();
            }
          } catch {
            /* 已经断了 */
          }
        });
        return;
      }
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
      res.end('只支持 GET。\n');
      return;
    }
    /**
     * ★ **两条路，只有一处不同**（契约 112）：
     *   · `/a/<id>/<version>/<rel>` —— 某一版**不可变快照**（发布/血缘那一侧照旧）；
     *   · `/w/<id>/<rel>`           —— 那一间工作区里**现在那一份**（他自己那一份）。
     * 🔴 验签、CSP、响应头、"先验签再碰盘"的顺序，两条**逐字相同**。
     */
      // ★ **丙（`184`）：壳那一页**（小程序那一屏的浮层由它画 —— 一份实现，网页与手机同一套）。
      //   🔴 它**不拿钥匙**：里面嵌的是**已经签好名的活地址**（`?u=`），而且那条地址
      //      在壳里还要再被认一遍（只认 `/w/`|`/a/` 且带 `s=`）。判据 S1–S3。
      const shellKind = shellKindOf(parsed.pathname ?? '');
      if (shellKind) {
        const body = shellKind === 'html' ? shellHtml() : shellKind === 'css' ? shellCss() : shellJs();
        const type = shellKind === 'html'
          ? 'text/html; charset=utf-8'
          : shellKind === 'css'
            ? 'text/css; charset=utf-8'
            : 'application/javascript; charset=utf-8';
        res.writeHead(200, {
          'content-type': type,
          'content-security-policy': SHELL_CSP,
          // ⚠️ 壳**不许**被缓存住（它跟着产品层一起变；缓存住会让旧壳一直跑）
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        res.end(body);
        return;
      }
    const live = parseLivePath(parsed.pathname ?? '');
    const hit = live ? null : parseArtifactPath(parsed.pathname ?? '');
    if (!live && !hit) {
      deny(res, 404);
      return;
    }
    const id = live ? live.id : hit.id;
    const q = new URLSearchParams(parsed.query ?? '');
    const exp = q.get('e') ?? '';
    const sig = q.get('s') ?? '';
    // 🔴 **先验签，再碰盘**（顺序刻意：没签名的请求连目录都不看）
    //    · 活地址那一格签的是哨兵 `live`（域分离：制品签名拿到这儿过不了）
    const version = live ? LIVE_VERSION : hit.version;
    // ★ **`A3`：URL 上没有人**（原来那一格"从查询串里读身份"的代码已经删掉了）——
    //   "这是谁"只能拿登记过的人逐个试签名认出来（`resolveEntrySub`）。
    //   ⚠️ 老 URL 上那个 `u`（明文身份）今天**被忽略**：认人只看签名。
    const sub = resolveEntrySub({ key, sig, id, version, exp, subs: subsNow(), now: now() });
    if (sub === null) {
      log(`${live ? '活地址' : '制品口'}：签名不过（${id}）`);
      deny(res, 403);
      return;
    }
    // ★ **白名单在"碰工作区之前"**（V2 的反例钉的就是这一条）：
    //   `..` / `.hupo.json` / `build/` 这一类**连库都不碰**（更别说去 dial 盒子）。
    if (live) {
      try {
        checkLiveRel(live.rel);
      } catch (e) {
        log(`活地址：这个路径不对外（${e instanceof AppsError ? e.message : '未知错'}）`);
        deny(res, 404);
        return;
      }
    }
    let apps = null;
    try {
      apps = live ? (typeof resolveLive === 'function' ? resolveLive(sub) : null) : resolveApps(sub);
    } catch (e) {
      // ⚠️ **取库那一步不许把进程带走**（`worldFor` / `tenantOf` 都可能对一个怪身份抛）：
      //    这里拒掉这一条请求就够了 —— 一个未捕获异常会让整个服务下去。
      log(`${live ? '活地址' : '制品口'}：取库那一步出错（${sub}）${e?.message ?? e}`);
      // 🔴 **B27（2026-09-30 还的账）**：**盒子不通**这一档要**三处一个口径** ——
      //    `/api/apps` 与 `/api/app-ask` 的预闸都是 **503 `tenant-not-ready`**，
      //    而这里原来落到 **403**（"取不到这个文件"）⇒ 同一个病三种说法，
      //    读的人会以为它们坏的原因不同。⇒ 只认 `BoxError`（那不是"没权限"，
      //    是"他那台没应"）；别的抛错照旧 403（fail-closed，一个字不改）。
      if (e instanceof BoxError) {
        denyBox(res);
        return;
      }
      deny(res, 403);
      return;
    }
    if (!apps) {
      // 那格不存在（或者这个人还没建世界）⇒ 拒，不建目录
      deny(res, 403);
      return;
    }
    let pending;
    try {
      // 🔴 **两个方法名是分开的**（`readLive` vs `read`）：活地址走前者。
      //    写成一个的话，"取哪儿"又会悄悄退回某一版快照 —— 而那正是这一条要修的。
      pending = live ? apps.readLive(live.id, live.rel) : apps.read(hit.id, hit.version, hit.rel);
    } catch (e) {
      log(`${live ? '活地址' : '制品口'}：读不出来（${id}）${e instanceof AppsError ? e.message : '未知错'}`);
      // ★ **读侧那道闸拒了 ⇒ 看得见的 403**（`164`）：理由说全，**不许**落进下面那个假 404。
      if (isHiddenPathRefusal(e)) {
        denyRefusedPath(res, { id, rel: live ? live.rel : hit.rel, why: e.message });
        return;
      }
      // ★ **盒子不通 ⇒ 503**（`B27`：这一条**两条路都适用** —— 在制品那条路上，
      //   以前落到 404 = 页面在说假话（"这里没有这个文件"，而他明明有，只是那台没应）；
      //   而 `/api/apps` 那个预闸对同一个病说的是 503 ⇒ 三处要一个口径，见上面那段）。
      if (e instanceof BoxError) {
        denyBox(res);
        return;
      }
      deny(res, 404);
      return;
    }
    /**
     * ★ **B15**：租户的那份字节在**他的盒子里** ⇒ `read()` 要过隧道，
     * 所以它可能是**异步**的（主人 / 单租户仍然是同步的）。
     *
     * 🔴 **顺序一个字都没动**：验签（上面那一步）→ 取库 → 读字节。
     *    没签名的请求**连库都不会碰**（反例钉在 `test/apps-box.test.js`）。
     */
    Promise.resolve(pending).then(
      // ⚠️ `async`：这一条要**按 app 算 CSP**（`netHostsFor` 对租户那一侧要过隧道）
      async (got) => {
        /**
         * ★ `148` §二：**这一条 CSP 是按 app 算的**（它声明的站 ＋ 他没关掉 ⇒ 才进名单）。
         *
         * ⚠️ **声明的来源要用"那个人的小程序库"那一份**：活地址（`/w/`）那条路给的是
         *    `resolveLive(sub)` 那个**只管读文件**的库（它没有 `meta` / `list`）——
         *    2026-10-01 真跑的时候量出来的：拿它去问"声明了什么"永远问不出来 ⇒
         *    **声明的站进不了 CSP**（页面上就是"配了却连不出去"）。
         */
        const metaStore = (() => {
          try {
            return typeof resolveApps === 'function' ? (resolveApps(sub) ?? apps) : apps;
          } catch {
            return apps;
          }
        })();
        const cspOut = await cspForApp(metaStore, id).catch(() => csp);
        /**
         * ★ **壳给的那两条内边距**（`pt`/`pb`，2026-10-01）：只有 HTML 才注入，
         *   而且两个数都是 0 ⇒ 字节原样（老客户端 / 没要边距 ⇒ 一个字节都不动）。
         * ⚠️ 注入之后 `content-length` 要跟着改（不然浏览器会截断/挂住）。
         */
        const isHtml = typeof got.contentType === 'string' && got.contentType.startsWith('text/html');
        const padTop = shellInsetOf(q.get('pt'));
        const padBottom = shellInsetOf(q.get('pb'));
        let out = got.content;
        if (isHtml && (padTop > 0 || padBottom > 0)) {
          out = Buffer.from(
            injectShellInset(Buffer.from(got.content).toString('utf8'), { padTop, padBottom }),
            'utf8',
          );
        }
        res.writeHead(200, {
          'content-type': got.contentType,
          'content-length': out.length,
          // 🔴 **不许发 X-Frame-Options**（壳里要嵌它）；只让壳嵌 ⇒ 用 CSP 的 frame-ancestors
          'content-security-policy': cspOut,
          // 制品是"凭签名取一次"的东西：**别让浏览器缓存**（缓存了就没法验签了）
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        });
        res.end(req.method === 'HEAD' ? undefined : out);
      },
      (e) => {
        log(`${live ? '活地址' : '制品口'}：读不出来（${id}）${e instanceof AppsError ? e.message : (e?.message ?? '未知错')}`);
        if (!res.headersSent) {
          // ★ 读侧那道闸拒了（租户那一份可能是异步/过隧道取回来的）⇒ 同样看得见的 403。
          if (isHiddenPathRefusal(e)) denyRefusedPath(res, { id, rel: live ? live.rel : hit.rel, why: e.message });
          else if (live && e instanceof BoxError) denyBox(res);
          else deny(res, 404);
        } else {
          res.destroy();
        }
      },
    );
  });
}
