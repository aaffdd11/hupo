// HTTP + WebSocket 服务面。手册 `08-SPEC.md` §2.1 / §2.2。
//
// 三条最容易做错、这里刻意写死的：
//
//   1. **fail-closed**：没设口令 ⇒ 除三个公开路由外**一律 503**。
//      不是跳登录页、不是放行——是明确拒绝。默认放行 = 一次忘记设口令
//      就等于把整台机器公开发布，而**一切看起来都在正常工作**。
//   2. **令牌只从 Authorization 头 / WS 子协议来，绝不从 URL 来**
//      （URL 会进日志、进 Referer、进浏览器历史）。
//   3. **WS 上没有令牌时，在握手阶段就拒**（401），
//      不要"先连上再关"——那会给爬虫留下一个可以站着的连接。

import http from 'node:http';
import { reauthOk } from './reauth.js';
import { appendAudit, auditLine } from './audit.js';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { WebSocketServer } from 'ws';

import { PUBLIC_ROUTES, clientIp, tokenFromRequest } from './auth.js';
import { SayError } from './say.js';
// ⚠️ 只借它**校验手机号形状**（`/api/send-code` 用）；模块本身不碰用户表
import { normalizePhone } from './users.js';
import { ADMIT_RATIO, readAdmission } from './admission.js';
import { CATCHUP_RENDER, markCatchUp, planBackfill, planResume } from './resume.js';
import { buildExport } from './export.js';
import { MAX_ANSWER_CHARS, askViaLocalProxy } from './app-ask.js';
import { SIGNED_TTL_MS, entryUrl } from './app-serve.js';
import { ASR_PATH } from './asr.js';
import { isCredField } from './creds.mjs';

/// **看起来像"一个文件"的路径**（P1-14）：这些后缀一律**不回 SPA 兜底**，
/// 而是如实 404 —— 拿 HTML 冒充 JS/CSS/字体/wasm，是把"缺文件"变成"白屏"。
const LOOKS_LIKE_ASSET =
  /\.(js|mjs|css|json|wasm|map|png|jpe?g|gif|svg|ico|woff2?|ttf|otf|txt|webmanifest)$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.bin': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
};

// ── 过程四档（决策 D7 / 契约 `docs/dev/26-PROCESS-LEVELS.md`）────────────
//
// ⚠️ **`level` 是连接级的**：每条 WS 连接各自一份（从 query 取），
//    不是进程级开关，也不是全局设置——一台设备选了"推理原文"**不许**
//    改变另一台设备看到的东西。
//
// 四档是**累加的梯子**（契约 §三那张表）：
//
//   quiet      只说出口的话（`message/*`）——**连 `message/status` 都不发**
//   doing ✅    + `message/status`（`process_words.dart` 翻成人话）
//   steps       + `step/*`
//   reasoning   + `reasoning/*`（⚠️ 只有主人；默认关）
//
// ⚠️ **过程事件（`step/*` · `reasoning/*`）一律是瞬态的**——
//    由 `session-translate.js` 走 `emitTransient()` 发出来（不占号、不落盘），
//    这里的闸**只决定"发给哪条连接"**，与落盘无关。
//    两层分开是有意的：如果由这里决定落不落盘，那"某个连接的档位"
//    就会影响磁盘上的内容——那正是泄露闸要挡的形状。
//    见 `session-translate.js` 文件头与契约 §二。

/** 认得的四档。**不在这个表里的 query 一律当默认档**，不许把连接拒掉。 */
export const PROCESS_LEVELS = Object.freeze(['quiet', 'doing', 'steps', 'reasoning']);

/** 不带 `level` 时的档（契约：默认 `doing`）。 */
export const DEFAULT_PROCESS_LEVEL = 'doing';

/**
 * ⚠️ **只有"过程"这一路随档位变**（契约 §三那张表说的就是这一路）。
 *
 * 这道闸**踩过坑**（2026-09-21，`server.test.js` 的「WS 实时」当场变红）：
 * 早先的写法是**白名单**——只放行 `message/*` 加本档那几样，
 * 于是**默认档**把 `user/echo`、`turn/*`、`title` 一起挡掉了。
 * 补发那一路**不走这道闸**（见 `onStream`），所以 replay 的测试全绿、
 * 只有"连上之后新说的一句"那条红 ⇒ 判据：
 *
 *   **默认档（`doing`）必须等于"加四档之前的行为"。**
 *
 * ⇒ 所以这里记的是**过程事件的清单**，而不是"要放行的清单"：
 *    不是过程事件的一律发。反过来写（白名单）的代价是——
 *    以后每加一种时间线事件都得记得回来补一笔，漏一次就是
 *    "某一档静默丢事件"，而那种缺陷在客户端看起来像"服务端没反应"。
 */
export const PROCESS_TYPES = Object.freeze([
  'message/status',
  'step/start',
  'step/end',
  'reasoning/delta',
]);

/**
 * 各档**额外**放行哪些过程事件（累加的梯子）。
 *
 * ⚠️ `quiet` 是空集，**包括 `message/status`** —— "安静档要真的安静"，
 *    少挡这一条就等于这一档没做（契约 §四点名要验）。
 */
const LEVEL_EXTRA_TYPES = Object.freeze({
  quiet: new Set(),
  doing: new Set(['message/status']),
  steps: new Set(['message/status', 'step/start', 'step/end']),
  // 累加：`reasoning` 档**也**收步骤（它是梯子最上面那一阶）
  reasoning: new Set(['message/status', 'step/start', 'step/end', 'reasoning/delta']),
});

/**
 * 从 query 解出这一条连接的档。
 *
 * ⚠️ **认不出来 ⇒ 默认档，不报错、更不许拒连接**（契约 §三）：
 *    客户端版本比服务端新/旧都会出现不认识的档，那时正确的行为是
 *    "按默认档服务"，而不是把用户挡在门外（N10 的另一面：
 *    宁可少说，不能不说）。
 *
 * @param {URLSearchParams|string|null} params
 * @returns {'quiet'|'doing'|'steps'|'reasoning'}
 */
export function parseLevel(params) {
  let raw = null;
  if (typeof params === 'string') {
    try {
      raw = new URLSearchParams(params).get('level');
    } catch {
      raw = null;
    }
  } else if (params && typeof params.get === 'function') {
    raw = params.get('level');
  }
  if (typeof raw !== 'string') return DEFAULT_PROCESS_LEVEL;
  const level = raw.trim();
  return PROCESS_LEVELS.includes(level) ? level : DEFAULT_PROCESS_LEVEL;
}

/**
 * 这条连接收不收这个事件。**纯函数**（好把它单独钉住）。
 *
 * ⚠️ **它只管过程事件**（`PROCESS_TYPES`）：其它事件（用户自己的回声、
 *    轮的边界、标题……）一律 `true` —— 档位调的是"过程说多少"，
 *    不是"时间线还剩什么"。见 `PROCESS_TYPES` 上面那段踩坑记录。
 *
 * @param {object} event  时间线上推出来的事件
 * @param {object} o
 * @param {string} o.level 这一条连接的档
 * @param {boolean} [o.dev] `dev=1` 那条**附加**通道（见 `onStream` 里的说明）
 */
export function levelAllows(event, { level, dev = false } = {}) {
  const type = event?.type;
  if (typeof type !== 'string') return false;
  // ★ **不是过程事件 ⇒ 与档位无关**，照旧发。
  //   默认档的行为 = 加四档之前的行为，靠的就是这一行。
  if (!PROCESS_TYPES.includes(type)) return true;
  if (LEVEL_EXTRA_TYPES[level]?.has(type)) return true;
  // ★ `dev=1` 与 `level` **并存**（不是别名）：见 `onStream` 里那段为什么。
  if (dev && type.startsWith('step/')) return true;
  return false;
}

/** 这两个**不许长缓存**，否则用户看到的是几小时前的界面。 */
/**
 * 文件名里带**内容指纹**的，才允许长缓存。
 *
 * ⚠️ 这里是踩过一个坑之后改的（2026-09-21）：
 *    早先的规则是"入口文件 `no-cache`、其余一律 `immutable`（一年）"，
 *    而注释里想的是"带 hash 的产物可以长缓存"——**可 Flutter web 的产物
 *    文件名里根本没有 hash**：`main.dart.js`、`flutter_bootstrap.js`、
 *    `assets/**`、`canvaskit/**` 全是固定名字。
 *    ⇒ 浏览器把旧的那份当成"一年内不用再问"，
 *      **于是每次部署对已经来过的人等于没部署**。
 *      （现场：主人平板上没有新加的按钮，而服务端产物早就换了。）
 *
 * ⇒ 规则改成"**看名字**"：只有**真的**带指纹的才长缓存，其余一律回来问一句。
 *    `no-cache` 不是"不缓存"，是"用之前先问"——配合下面的 `Last-Modified`，
 *    没改就是 304，只花一次往返。
 */
// ⚠️ 别写成"点 + 十六进制 + **一个**扩展名" —— 真实的产物名是
//    `main.<hash>.dart.js`（**两个点**），那样写一条都匹配不到（我第一版就写错了）。
const CONTENT_HASHED = /[.\-][0-9a-f]{8,}\./i;

/** 该给哪个 cache-control。**判据是文件名，不是"它是不是入口"。** */
export function cacheControlFor(relPath) {
  return CONTENT_HASHED.test(relPath)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
}

/**
 * **字体镜像的路径白名单**（2026-09-23 加）。
 *
 * 为什么要有这条口：Flutter web 的 CanvasKit 遇到**中文**会去
 * `https://fonts.gstatic.com/s/notosanssc/v37/…woff2` 取**分片字体**（每片约 25KB）。
 * 国内那台经常取不到 ⇒ **页面很慢，甚至一个字都不显示**（实测：屏掉 gstatic 之后
 * 图标在、**中文字全空**）。⇒ 镜像到自己域名下，并把引擎的 `fontFallbackBaseUrl`
 * 指到 `/fonts/`（部署脚本打的那处补丁）。
 *
 * 🔴 **它是个代理 ⇒ 路径必须过白名单**（不然就是个任意 SSRF 的口）：
 *    只认"家族名 + v数字 + 文件名"，家族名在白名单里，且**不许有任何 `..`**。
 *
 * ⚠️ **文件名长度**：真实那份是 base64 样的一大串（实测 **96** 字符）——
 *    第一版封了 80 ⇒ **把一个好文件也拒了**（判据里用的是短名字，所以没抓到；
 *    线上表现是"字体全 404，中文还是不显示"）。⇒ 上限跟着真实值走，判据里**用真名字**。
 */
export function fontMirrorRel(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/fonts/')) return null;
  const rel = pathname.slice('/fonts/'.length);
  if (rel.length > 220 || rel.includes('..') || rel.startsWith('/') || rel.includes('\\')) return null;
  const m = /^([a-z0-9]+)\/(v\d+)\/([A-Za-z0-9_.-]{1,120}\.(?:woff2|ttf|otf))$/u.exec(rel);
  if (!m) return null;
  if (!FONT_FAMILIES.has(m[1])) return null;
  return rel;
}

/** 允许镜像的字体家族（**只加认识的**；加错一个就是给代理开了个口子）。 */
export const FONT_FAMILIES = new Set([
  'notosanssc', 'notosans', 'notosansmono', 'notosanssymbols', 'notosanssymbols2',
  'notoemoji', 'notosansjapanese', 'notosanskr', 'roboto',
]);

export function createServer({
  timeline = null,
  store = null,
  auth,
  say = null,
  dispatcher = null,
  /** 回收站（批 3 第二件）。`null` = 这台部署没开这条路（路由一律 404）。 */
  trash = null,
  /**
   * **语音那条**（`/api/asr` 的中继，`src/asr.js` 建的）。
   *
   * `null` = 这台部署没有这条路 ⇒ 那条 WS **仍然接上**，但**如实回一句"没配"**
   * （见 `onAsr`）。它跟聊天那条分开，是因为音频要**二进制帧**，
   * 而聊天那条的协议已经冻结了 —— 不往里面塞新东西。
   */
  asr = null,
  /**
   * 多租户：**按 `claim.sub` 取那个人的世界**（`worlds.js`）。
   *
   * ⚠️ 它和上面那几个单例**只能给一边**：
   *    * 给了 `worlds` ⇒ 每个请求按令牌里的 `sub` 取（多租户，生产走这条）；
   *    * 不给 ⇒ 五个单例对所有人是同一份（**单租户**，所有既有测试走这条）。
   * ⇒ 合起来只有**一条**取值路径（`worldFor`），不是两套逻辑在跑。
   *
   * ⚠️ **身份只能从令牌来**（`claim.sub`），**不许从 URL / body / 头里读**：
   *    那些都是请求方可控的，读它们等于"报个别人的名字就能看别人的东西"。
   */
  worlds = null,
  /**
   * **制品入口 URL 怎么拼**（乙-1 · 契约 `docs/dev/59-USER-APPS.md`）。
   *
   * 形如 `{ base, key }`：`base` = 第二个原点的根（`http://127.0.0.1:8021`，生产是那个域名），
   * `key` = 签名密钥。**给了才挂 `/api/apps`**（没给 ⇒ 那条路由 404，同回收站那条规矩）。
   * ⚠️ `key` 只在这个进程里用，**不许进日志**。
   */
  apps = null,
  /**
   * **字体镜像的磁盘缓存目录**（`/fonts/…` 那条口；`null` = 不落盘，每次去取）。
   * ⚠️ 它**必须显式传进来**：`createServer` 这一层**没有 `cfg`**
   *    （第一版在路由里写了 `cfg.dataDir` ⇒ 直接抛 ⇒ 那条口回 500，判据当场抓到）。
   */
  fontCacheDir = null,
  webRoot = null,
  buildId = 'dev',
  now = Date.now,
  log = () => {},
  /** 准入闸。默认读这台机器的 cgroup；测试注入一个"一定拒"的就行。 */
  admit = readAdmission,
  /** 用户表（手机号 → 用户）。`null` = 这台部署还没开手机号登录。 */
  users = null,
  /**
   * **给主人看的那一笔账**写哪（账 #39 · `audit.js`）。`null` = 不记
   * （单租户的老测试就是这样；多租户那条路由 `serve.js` 传 `auditPath(dataDir)`）。
   */
  auditFile = null,
  /** 临时验证码。**空串 = 关**（默认就是关）。 */
  devCode = '',
  /**
   * **数据面**（多租户 ②-4b 后半）：把这个人的请求**转发到他自己的容器**去。
   *
   * `proxyFor(sub)` → 一个"能给 http.request 当 socket 用"的 Duplex，或者 `null`
   * （那台容器的隧道没通）。`null` 时**如实回 503**，不许假装通了。
   */
  proxyFor = null,
  /**
   * **可信的本地监听**（多租户 ②-4b 后半 · 选项甲）：容器里那条
   * `/run/hupo/local-api.sock`（**`0600` root · 在 `0700` 的 `/run/hupo` 里**）——
   * 只有 root 开得开它，而隧道代理就是 root。
   *
   * ⇒ 从这条听进来的请求**已经由宿主验过身份了**，所以这里：
   *    * **不查令牌**、**也不受 `fail-closed` 影响**（容器里本来就没设口令）；
   *    * 身份固定成 `trustedSub`（容器里那个租户就是 `owner` —— 见 `34-CONTAINER.md` §8.4）。
   *
   * 🔴 **安全性来自内核**：不是"我们信它"，是"**别人开不开这个文件**"由文件权限说了算。
   */
  trustedSub = 'owner',
  /** `userId → 租户名`；不在表里的（例如主人）走**本机**那条路。 */
  tenantOf = () => null,
  /**
   * **这个人的空间到哪一步了**（契约 `38-ISOLATION-SPLIT.md` §8.3）。
   *
   * 返回 `{kind:'local'}`（主人：本机那份、直接聊）
   * 或 `{kind:'tenant', state:'preparing'|'ready', hasKey:boolean}`。
   * ⚠️ **取不到就当"就绪"**（老客户端没有这个字段也能用 —— 兼容那条纪律）。
   */
  tenantStatusOf = () => ({ kind: 'local' }),
  /** 这个 `sub` 是不是"主人那一份"（宿主上直接服务的那种）。 */
  isLocalUser = () => false,
  /**
   * 🔴 **他自己要注销 ⇒ 请特权侧把他那一台回收掉**（2026-09-22）。
   *
   * ⚠️ 返回 `{ok, why}`；`why` 会被翻译成**人话**（下面是那张表）——
   *    **内部代号不许直接回给界面**。
   */
  cancelTenant = null,
  /**
   * **他要一台，就替他申请一台**（契约 `docs/dev/43-AUTO-PROVISION.md`）。
   *
   * 🔴 调用它 = **产生副作用**（投一张申请），所以它**只在登录那一刻**被调，
   *    **不**在 `/api/space` 那种"只查"的路上被调（那条路要能随便刷）。
   * ⚠️ 返回 `{ok, why}`；调用方**不许**把 `why` 之外的任何东西回给客户端
   *    （尤其不许回路径）。
   */
  ensureTenant = null,
  /**
   * **用户填了自己的模型凭据**（多租户 ②-4b）。`null` = 这台部署没开这条路（路由 404）。
   *
   * ⚠️ 约定：`setModelKey(userId, key)`，返回值里**不含 key**；调用方**不许**把它写日志。
   */
  setModelKey = null,
  /**
   * **配置页那四样**（主人 2026-09-24 定的形状 · 契约 `docs/dev/79-CREDS-TABS.md`）。
   *
   * ⚠️ 约定：`setCreds(userId, patch)`，`patch` 是**短名 → 值**（`src/creds.mjs` 的
   *    `CRED_FIELDS`）；返回 `{ok, why, creds?}`，**里面绝不含值**。
   *    `field === 'model'` 那一条走**各人本来那条路**（租户：推给盒子；主人：DSH 那份凭据）——
   *    那件事住在 `serve.js`（只有它知道谁是主人、谁是租户）。
   */
  setCreds = null,
  /** **那四样有没有**（只看存在与否，**永远不回值**）。`credStatusOf(userId)`。 */
  credStatusOf = null,
}) {
  /**
   * 🔴 **这一个函数是"我是谁"与服务对象之间唯一的接缝。**
   * ⚠️ 单租户时它返回**同一个对象**（所以旧行为逐字不变）；多租户时按人取。
   */
  const shared = { timeline, store, say, dispatcher, trash };
  const worldFor = worlds ? (sub) => worlds.worldFor(sub) : () => shared;

  const server = http.createServer((req, res) => {
    handleRequest(req, res, false).catch((err) => {
      // 兜底：HTTP 层自己不许把异常漏出去变成未捕获
      log(`[http] 未处理异常：${err?.stack ?? err}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
      else res.destroy();
    });
  });

  // ── HTTP ────────────────────────────────────────────────

  /**
   * **记一行账**（账 #39）：谁想收哪一台、收没成、为什么。
   * ⚠️ 它是**旁路**：写不进去要说一声，但**不许把动作带走**。
   * ⚠️ **手机号只写掩码**（`auditLine` 里做），**钥匙从不出现**。
   */
  const audit = (what, userId, { tenant = null, detail = null } = {}) => {
    if (!auditFile) return false;
    let phone = null;
    try {
      phone = users?.phoneOf?.(userId) ?? null;
    } catch {
      /* 查不到就写 `—` */
    }
    let tName = tenant;
    try {
      tName = tenant ?? tenantOf(userId) ?? null;
    } catch {
      /* 同上 */
    }
    return appendAudit({
      file: auditFile,
      line: auditLine({ at: now(), what, tenant: tName, userId, phone, detail }),
      fs: nodeFs,
      onError: (m) => log(m),
    });
  };

  async function handleRequest(req, res, trusted = false) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // 公开路由：**只有这三个**
    if (path === '/api/version' && req.method === 'GET') {
      return sendJson(res, 200, { buildId, serverNow: now() });
    }
    if (path === '/api/auth' && req.method === 'GET') {
      // 客户端靠这个决定"显示登录页"还是"直接进"
      return sendJson(res, 200, { needsSetup: auth.needsSetup });
    }
    if (path === '/api/login' && req.method === 'POST') {
      return handleLogin(req, res);
    }
    // ★ **要一个验证码**（主人 2026-09-21：登录那一屏要有这个按钮，
    //   而**码本身永远不回给界面** —— 验证码是掩码，不许写在屏上）。
    //   ⚠️ 它必须**公开**（用户还没登录）。
    if (path === '/api/send-code' && req.method === 'POST') {
      let body;
      try {
        body = await readJson(req, 4 * 1024);
      } catch {
        return sendJson(res, 400, { error: 'bad-json' });
      }
      const phone = typeof body?.phone === 'string' ? body.phone.trim() : '';
      if (!users || !normalizePhone(phone)) return sendJson(res, 400, { error: 'bad-phone' });
      // ⚠️ **如实说**：这台部署**还没有短信通道** ⇒ 回 503 + 一句人话。
      //    🔴 **绝不把码回给界面**（哪怕只是"临时码"）—— 写在屏上就等于没验证码。
      //    ⚠️ 接上真短信通道时：**必须同时加一个按手机号的限频**
      //      （不然这个公开口就是一条免费短信的刷子）。
      return sendJson(res, 503, {
        error: 'no-sms',
        text: '还没接短信，现在拿不到码。接上就能用了。',
      });
    }

    // 其余 /api/* 一律要令牌；**没设口令时 fail-closed**
    if (path.startsWith('/api/')) {
      // ★ **可信本地那条路**（选项甲）：身份已经由**宿主**验过了，
      //   而"只有 root 能开这个套接字"是**内核**保证的（`0600` + `0700` 的父目录）。
      //   ⇒ 不查令牌、也不吃 `fail-closed`（容器里本来就没口令）。
      let claim;
      if (trusted) {
        claim = { sub: trustedSub, trusted: true };
      } else {
        if (auth.needsSetup) {
          return sendJson(res, 503, {
            error: 'not-setup',
            text: '这台机器还没设密码，先设好再用。',
          });
        }
        const token = tokenFromRequest(req);
        claim = token ? auth.verify(token) : null;
      }
      if (!claim) return sendJson(res, 401, { error: 'unauthorized' });

      // ★ **续期**（决策 A）：用现在这个令牌换一个新的，`exp` 往前挪。
      //   ⚠️ 它**不是**公开路由（`PUBLIC_ROUTES` 仍然只有三个）：没有有效令牌就拿不到新的。
      if (path === '/api/renew' && req.method === 'POST') {
        // ⚠️ 可信那条路**没有令牌可续**（身份是宿主给的）⇒ 如实说，别去动宿主的撤销表
        if (trusted) return sendJson(res, 404, { error: 'not-found' });
        const r = auth.renew(tokenFromRequest(req));
        if (!r) return sendJson(res, 401, { error: 'expired' });
        return sendJson(res, 200, { token: r.token, expiresAt: r.expiresAt });
      }
      // ── ★ **数据面**：这个人在容器里 ⇒ 请求**转发进他的容器** ──────────
      // ⚠️ **只转发"属于他自己那一份"的路由**：账号/续期/审计/填 key 都是**中心**的事
      //    （它们在宿主上做，不进容器）。
      // ⚠️ 隧道没通 ⇒ **503 + 一句人话**，**不许**偷偷在本机替他答
      //    （那会让他看到"一个不属于他的世界"—— 比报错坏得多）。
      const tenant = tenantOf(claim.sub);
      // 🔴 **宿主只服务主人那一份**：别人（有租户的走他那台容器；没分配到的**如实说没准备好**）。
      //    ⚠️ 少了这一条，"还没分到空间的新号"会落到**宿主上**被本机那个世界接着 ——
      //      而 `local` 的语义是**主人**，那是多租户要防的第一件事。
      if (!tenant && !isLocalUser(claim.sub) && path.startsWith('/api/')) {
        const space = tenantStatusOf(claim.sub);
        if (space.kind === 'tenant') {
          return sendJson(res, 503, {
            error: 'space-not-ready',
            text: '你那台还在准备，稍等一下再试。',
          });
        }
      }
      if (tenant && TENANT_ROUTES.some((p) => path === p || path.startsWith(`${p}/`))) {
        // 🔴 `/api/app-ask` 在这条路上要**先过闸再转发**：
        //    匣子里那份目录与中心这一份**不是同一个**（中心是 `data/users/<id>/`，
        //    匣子里是它自己的 `/data`）⇒ 闸只能由**中心**（权威那份）来判；
        //    而"花"必须发生在**匣子里**（钥匙在那儿）。
        //    转发时带一个头，告诉匣子"闸已经过了，你只管花"。
        let askBody = null;
        if (path === '/api/app-ask') {
          const w = worldFor(claim.sub);
          let body;
          try {
            body = await readJson(req, 16 * 1024);
          } catch {
            return sendJson(res, 400, { error: '这一条看不懂' });
          }
          const gate = checkAppAsk(w?.apps, body?.appId);
          if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
          // 转发的是**重写过的**请求：一个"闸过了"的头（跨进程只认头，不认内存里的字段）
          // + 重新给一份身体（刚才 `readJson` 已经把它读掉了）。
          req.headers['x-hupo-app-ask-checked'] = '1';
          askBody = JSON.stringify(body ?? {});
          req.headers['content-type'] = 'application/json';
        }
        const sock = proxyFor ? proxyFor(tenant) : null;
        if (!sock) {
          return sendJson(res, 503, {
            error: 'tenant-not-ready',
            text: '你那台还在准备，稍等一下再试。',
          });
        }
        return proxyToTenant(sock, req, res, { body: askBody });
      }

      // ★ **按身份取世界**（多租户那一步）：从这里往下，一律用 `W`，
      //   **不许**再直接摸上面那几个单例 —— 那正是"甲看到乙"的来源。
      //   ⚠️ `sub` 只来自**验过签的令牌**（`claim`），不读 URL / body / 头。
      const W = worldFor(claim.sub);
      if (path === '/api/say' && req.method === 'POST') return handleSay(req, res, claim, W);
      if (path === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, timelineId: W.timeline.id, seq: W.timeline.seq });
      }
      if (path === '/api/audit' && req.method === 'GET') {
        return sendJson(res, 200, { entries: auth.auditLog });
      }
      // ── 导出（批 3 欠的最后一件 · 契约 `docs/dev/30-EXPORT.md`）──────────
      // ⚠️ **只读**：它只是把用户自己的话还给他，不是破坏性动作 ⇒ **不要 `confirm`**
      //    （和 `/api/trash/plan` 同一条规矩：能白看的东西不许有门槛）。
      // ⚠️ 回收站里那些**不算进来**，但**条数要如实报**（契约 §三）——
      //    `trash.list()` 是唯一知道"谁被删过"的地方，所以这道闸打在这儿。
      // ⚠️ 没开回收站的部署也照样导得出（只是没有"被删掉的那几条"要报）。
      // ── 把这个人签过的令牌**全部**撤掉（"别处还登着" / 注销那一步）──────
      // ⚠️ 身份只从令牌来；撤的是**这个 `sub`**（不是请求里给的任何东西）。
      // ⚠️ 回执里**不说**撤了几个（我们本来也不知道）。
      if (path === '/api/revoke-all' && req.method === 'POST') {
        if (trusted) return sendJson(res, 404, { error: 'not-found' });
        auth.revokeUser(claim.sub);
        return sendJson(res, 200, { ok: true });
      }

      // ── "我的空间到哪一步了"（契约 `38` §8.3：等待屏靠它）──────────────
      // ⚠️ **只读**、**不带 key**、**不分配任何隧道**（探测不许有副作用）。
      // ── **小程序问一句**（乙-4b）────────────────────────────
      // 🔴 花的是**看的人自己的钥匙**：
      //    · 租户 ⇒ 上面那段转发把它送进**他自己的盒子**，由盒里的代理花（这一份代码
      //      在盒子里也跑，走的是"本机代理"那条同样的路）；
      //    · 主人 ⇒ 走到这儿，本机那个代理**这一批还没接上** ⇒ **如实说**（见 §八）。
      // ⚠️ 四道闸，缺一不可：这一条在他这儿 · 清单里**声明了** `ask` · 他**授予了** · 配额还有。
      if (path === '/api/app-ask' && req.method === 'POST') {
        const w = worldFor(claim.sub);
        let body;
        let left = null;
        if (req.headers['x-hupo-app-ask-checked'] === '1') {
          // ★ **匣子这一侧**：闸在中心那边已经过了（那一份才是权威的；
          //    匣子里这份目录跟中心不是同一个，它自己也判不了）
          try {
            body = await readJson(req, 16 * 1024);
          } catch {
            return sendJson(res, 400, { error: '这一条看不懂' });
          }
        } else {
          if (!w?.apps) return sendJson(res, 404, { error: '这台部署还没开小程序' });
          try {
            body = await readJson(req, 16 * 1024);
          } catch {
            return sendJson(res, 400, { error: '这一条看不懂' });
          }
          const gate = checkAppAsk(w.apps, body?.appId);
          if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
          left = gate.left;
        }
        const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
        const r = await askViaLocalProxy({ prompt });
        if (!r.ok) return sendJson(res, 502, { error: r.error });
        return sendJson(res, 200, {
          text: r.text,
          left: left === null ? null : left - 1,
          max: MAX_ANSWER_CHARS,
        });
      }

      // ── 「发现」：大家发出来的小程序（乙-3）──────────────────
      // 🔴 **只读**：这一屏没有任何"装 / 发 / 改"的动作（那些都在对话里做）。
      if (path === '/api/discover' && req.method === 'GET') {
        const w = worldFor(claim.sub);
        if (!w?.published) return sendJson(res, 404, { error: '这台部署还没开小程序' });
        let list = [];
        try {
          list = w.published.discover();
        } catch (err) {
          log(`共享库读不出来：${err?.message ?? err}`);
          return sendJson(res, 500, { error: '共享库读不出来' });
        }
        // ⚠️ 对外**不给 authorHash**（客户端不需要它，少给一样少一样）
        return sendJson(res, 200, {
          apps: list.map(({ authorHash, ...rest }) => rest),
        });
      }

      // ── 我的小程序清单（乙-1）──────────────────────────────
      // 🔴 **按 `claim.sub` 取那个人自己的那一格**（同 timeline 那条规矩）：
      //    身份只能从令牌来，**不许从 URL / body / 头里读**。
      if (path === '/api/apps' && req.method === 'GET') {
        const w = worldFor(claim.sub);
        if (!apps || !w?.apps) return sendJson(res, 404, { error: '这台部署还没开小程序' });
        let items = [];
        try {
          items = w.apps.list();
        } catch (err) {
          log(`清单读不出来（${claim.sub}）：${err?.message ?? err}`);
          return sendJson(res, 500, { error: '清单读不出来' });
        }
        // ⚠️ **入口 URL 现签**（绑人 + 绑版本 + 短时效），清单里存的不是它 ——
        //    存下来的 URL 一定会过期，而过期了还摆在界面上就是"点了没反应"。
        return sendJson(res, 200, {
          apps: items.map((a) => ({
            ...a,
            entryUrl: entryUrl({
              base: apps.base,
              key: apps.key,
              sub: claim.sub,
              id: a.id,
              version: a.version,
              entry: a.entry,
              // ⚠️ **必须吃这个进程的时钟**（`now`），不许用墙上时间：`entryUrl` 里那个
              //    默认值会让"签名里的到期"和"报出去的到期"差一截（判据当场抓到过）。
              now: now(),
            }),
            expiresAt: now() + SIGNED_TTL_MS,
          })),
        });
      }

      if (path === '/api/space' && req.method === 'GET') {
        // ★ **那四样有没有**（配置页那四个 tab）：**只有有没有，没有值**。
        //   ⚠️ 加字段是安全的（协议纪律：**加不破**，老客户端忽略它）。
        const creds = credStatusOf ? credStatusOf(claim.sub) : null;
        const space = tenantStatusOf(claim.sub);
        return sendJson(res, 200, creds ? { ...space, creds } : space);
      }

      // ── 配置页那四样（主人 2026-09-24：*"配置页用来配置模型，语言大模型apikey，
      //    语音大模型，图片生成，视频生成"*）────────────────────────────
      //
      // ⚠️ **老的 `/api/model-key` 一字不动**（协议冻结：老客户端还在跑）——
      //    这一条是**加**出来的，一次能写多字段（语音那三样必须一次写完，
      //    不然会有"填了两样"的半截状态）。
      // ⚠️ 回执里**只有"有没有"**，绝不回值；也**不校验它长得像不像钥匙**
      //    （我们不是它的裁判，真伪由上游说了算）。
      if (path === '/api/creds' && req.method === 'POST') {
        if (!setCreds) return sendJson(res, 404, { error: 'not-found' });
        let body;
        try {
          body = await readJson(req, 8 * 1024);
        } catch {
          return sendJson(res, 400, { error: 'bad-json' });
        }
        const given = body?.creds;
        if (!given || typeof given !== 'object' || Array.isArray(given)) {
          return sendJson(res, 400, { error: 'bad-shape', text: '没看懂要存哪几样。' });
        }
        const patch = {};
        for (const [field, raw] of Object.entries(given)) {
          if (!isCredField(field)) {
            return sendJson(res, 400, { error: 'bad-field', text: '有一项我不认识，先别存。' });
          }
          if (typeof raw !== 'string' || raw.length > 4096) {
            return sendJson(res, 400, { error: 'bad-value', text: '那一串太长或者不像一串钥匙。' });
          }
          const v = raw.trim();
          if (v.length === 0) return sendJson(res, 400, { error: 'blank-key' });
          // 能被 HTTP 头带走的字符（和 `/api/model-key`、`put-key.mjs` 同一条规矩）
          if (/[^\x20-\x7e]/.test(v)) return sendJson(res, 400, { error: 'bad-key-chars' });
          patch[field] = v;
        }
        if (Object.keys(patch).length === 0) return sendJson(res, 400, { error: 'blank-key' });
        const r = setCreds(claim.sub, patch);
        if (!r?.ok) {
          return sendJson(res, r?.status ?? 409, {
            error: r?.why ?? 'cannot-set',
            ...(r?.text ? { text: r.text } : {}),
          });
        }
        return sendJson(res, 200, { ok: true, creds: r?.creds ?? null });
      }

      // ── 用户填自己的模型凭据（多租户 ②-4b）──────────────────────────
      // ⚠️ **身份只从令牌来**（`claim.sub`）：A 填的 key 只能进 A 那台容器。
      // ⚠️ 回执里**不带 key**，也**不校验它长得像不像 key**（我们不是它的裁判，
      //    真伪由上游说了算）；只卡"非空、且是能被 HTTP 头带走的字符串"。
      if (path === '/api/model-key' && req.method === 'POST') {
        if (!setModelKey) return sendJson(res, 404, { error: 'not-found' });
        let body;
        try {
          body = await readJson(req, 4 * 1024);
        } catch {
          return sendJson(res, 400, { error: 'bad-json' });
        }
        const key = typeof body?.key === 'string' ? body.key.trim() : '';
        if (key.length === 0) return sendJson(res, 400, { error: 'blank-key' });
        // 能被 HTTP 头带走的字符（和 dsh 那条 `assertUsableApiKey` 同一条规矩）
        if (/[^\x20-\x7e]/.test(key)) return sendJson(res, 400, { error: 'bad-key-chars' });
        const r = setModelKey(claim.sub, key);
        if (!r?.ok) return sendJson(res, 409, { error: r?.why ?? 'cannot-set' });
        return sendJson(res, 200, { ok: true });
      }

      // ── 🔴 **注销：他自己要把这台机器上的那一份收回去**（2026-09-22）──────
      // ⚠️ **这是不可逆的**，所以：① 身份只从令牌来（**只能注销自己**）；
      //   ② 特权侧收不掉时**如实说**，不许回一句"好了"；③ 账号那一行跟着删
      //   （不删的话他下次登录会**又建一台**出来 —— 那就白回收了）。
      // ⚠️ 它不是公开路由（`PUBLIC_ROUTES` 没它），也没有 `trusted` 那一版：
      //   容器里那条可信口**没有令牌**，注销是**中心**的事。
      if (path === '/api/cancel' && req.method === 'POST') {
        if (trusted) return sendJson(res, 404, { error: 'not-found' });
        if (!cancelTenant) return sendJson(res, 404, { error: 'not-found' });
        // 🔴 **身份再确认**（账 #39 的前一半 · `reauth.js`）：
        //    注销**不可逆**，而这条路原来**只认令牌** ⇒ 一个被盗的令牌就能
        //    删掉一个人所有的东西。⇒ 要求"**最近真的登录过**"（看令牌的 `iat`，
        //    而**续期不会刷新 `iat`** ⇒ 旧令牌刷不过去）。
        //    ⚠️ 在这一步**什么都没发生**（没投申请、没撤令牌、没删账号）——
        //      判据里有一条专门盯这个。
        // ⚠️ **把服务自己的时钟传进去**（`now()` 是注入的：测试要能造"旧令牌"，
        //    而少了这一句它就用**真实墙上时间**去比 —— 判据会时灵时不灵）。
        if (!reauthOk({ iat: claim?.iat, now: now() })) {
          audit('拒了', claim?.sub, { detail: '要重新登录一次（令牌不是刚签的）' });
          return sendJson(res, 409, {
            error: 'needs-relogin',
            text: '为了确认是你，这一步得先重新登一次。登完再点一遍就好 —— 现在什么都没动。',
          });
        }
        const r = cancelTenant(claim.sub);
        // ⚠️ **拒了也记一笔**（"有人想删、没让他删" 正是最该看见的一行）
        if (!r?.ok) audit('拒了', claim.sub, { detail: r?.why ?? 'unknown' });
        else audit('收到请求', claim.sub, { detail: '已投给特权侧，等它真收' });
        if (!r?.ok) {
          // **每一种"不行"都说清是哪一种**（混成一句会让人一直重试）
          const why = r?.why ?? 'unknown';
          const table = {
            'no-helper': '这台机器还没接上回收那条路，先别动。',
            'protected': '你这一台是我们早期手工开的，得找我来收。',
            local: '你自己这一份就在这台机器上，没有单独一台要收。',
            'no-tenant': '你名下现在没有单独一台，不用收。',
            'bad-id': '你这一份的编号我看不懂，先别动。',
          };
          const status = why === 'no-helper' ? 503 : 409;
          return sendJson(res, status, {
            error: why,
            text: table[why] ?? '没能给你收掉，等会儿再试一次。',
          });
        }
        // ★ 收掉了：**令牌全撤 + 账号那一行也删**
        //   ⚠️ 顺序：先请特权侧收（上面那一步已经投出去了），再抹自己这边的账 ——
        //     反过来的话，他会以为"注销了"而容器还在（那就是**假话**）。
        auth.revokeUser(claim.sub);
        let forgot = false;
        try {
          forgot = users ? users.removeById(claim.sub) : false;
        } catch (err) {
          // 删不掉要**说出来**（下一次登录会又建一台 —— 那是能看见的后果）
          log(`  ⚠️ 注销时账号那一行没删掉（${claim.sub}）：${err?.message ?? err}`);
        }
        return sendJson(res, 200, {
          ok: true,
          forgot,
          text: '已经在收了。你那台盒子会在一会儿之内停掉，位置也就腾出来了。',
        });
      }

      // ── **往前取一页**（批 C：老消息往上翻着加载 · 契约 `docs/dev/64-CHAT-REDESIGN.md` §三）──
      // ⚠️ 与 `/api/export` 同族：**只读**、要令牌、走**用户自己那一份**
      //    （所以也在 `TENANT_ROUTES` 里 —— 租户用户的那一份在盒子里答）。
      // ⚠️ 给的是**原始带号事件**（含墓碑），客户端按它本来那套规则去重/隐藏：
      //    这里替它筛 = 两处口径（见 `resume.js` 的 `planBackfill` 顶上那三条）。
      if (path === '/api/timeline' && req.method === 'GET') {
        const q = new URL(req.url, 'http://x').searchParams;
        const before = Number.parseInt(q.get('before') ?? '', 10);
        const limit = Number.parseInt(q.get('limit') ?? '', 10);
        if (!Number.isInteger(before) || before < 0) {
          return sendJson(res, 400, { error: 'bad-before' });
        }
        const page = planBackfill({
          events: W.store.readAll(W.timeline.id),
          before,
          limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, BACKFILL_MAX) : BACKFILL_PAGE,
        });
        return sendJson(res, 200, page);
      }
      if (path === '/api/export' && req.method === 'GET') {
        const bin = W.trash ? W.trash.list() : [];
        return sendJson(res, 200, buildExport(W.store.readAll(W.timeline.id), {
          hiddenIds: bin.flatMap((t) => t.messageIds),
          // ⚠️ **这个数 = 删除次数**，而它**恰好等于"删掉的轮数"** ——
          //    因为客户端**一次只删一轮**（`turnMessageIds(id)` ⇒ 一次 remove 调用）。
          //    🔴 **别顺手把它"修"成别的东西**（2026-09-22 我差点改错）：改成
          //    `sum(messageIds.length)` 数的是**消息条数**（一轮两条 ⇒ 会翻倍）。
          //    ⚠️ 真正的缺口是：**API 允许一次删多轮**（我做验真钥匙的探针时一次删了 3 轮），
          //    那时末尾那句会**少报**（说"1 条"）—— 现在 UI 走不到那条路，
          //    记在账 #46 上（哪天真做多选删除，就得把"轮数"存进回收站里）。
          hiddenCount: bin.length,
        }));
      }
      // ── 回收站（批 3 第二件 · 契约 `docs/dev/28-DELETE.md` §8.2）────────
      // ⚠️ 键是 `messageIds`（不是轮号）：盘上没有轮号，见契约 §三·补。
      if (W.trash) {
        if (path === '/api/trash' && req.method === 'GET') {
          return sendJson(res, 200, { items: W.trash.list(), ttlDays: W.trash.ttlDays });
        }
        if (path === '/api/trash/plan' && req.method === 'POST') {
          // ⚠️ **只读**：少 `confirm` 也能调 —— "先看清单"这一步不许有门槛。
          let body;
          try {
            body = await readJson(req, 16 * 1024);
          } catch {
            return sendJson(res, 400, { error: 'bad-json' });
          }
          return sendJson(res, 200, W.trash.plan(body?.messageIds));
        }
        if (path === '/api/trash/remove' && req.method === 'POST') {
          return handleTrashWrite(req, res, 'remove', W);
        }
        if (path === '/api/trash/restore' && req.method === 'POST') {
          let body;
          try {
            body = await readJson(req, 16 * 1024);
          } catch {
            return sendJson(res, 400, { error: 'bad-json' });
          }
          return sendJson(res, 200, { ok: W.trash.restore(body?.messageIds) });
        }
        if (path === '/api/trash/purge' && req.method === 'POST') {
          return handleTrashWrite(req, res, 'purge', W);
        }
      }
      return sendJson(res, 404, { error: 'not-found' });
    }

    // 静态：Flutter web
    // ★ **字体镜像**（`/fonts/…`）：白名单之外一律 404（它是个代理，路径必须严）
    if (path.startsWith('/fonts/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { error: 'method-not-allowed' });
      }
      const rel = fontMirrorRel(path);
      if (!rel) return sendJson(res, 404, { error: 'not-found' });
      return serveFontMirror(req, res, rel);
    }
    if (webRoot) return serveStatic(req, res, path);
    return sendJson(res, 404, { error: 'not-found' });
  }

  /**
   * 两个**破坏性**动作（删掉 / 彻底删）。
   *
   * ⚠️ `confirm:true` 是**必须的**：删是破坏性动作，**不许一个手滑的请求就能触发**
   *    （契约 §8.2）。少它一律 400，而且**什么都不做**。
   */
  /**
   * **属于"用户自己那一份"的路由** —— 这些在容器里答。
   * ⚠️ 别的（`/api/renew`、`/api/audit`、`/api/model-key`）是**中心**的事，**不进容器**：
   *    续期/审计用的是宿主的密钥与吊销表；填 key 是"中心当管道"那一步。
   */
  // ⚠️ `/api/app-ask` 也走这条：**花这个动作必须发生在 b 自己的盒子里**
  //    （盒里那个小代理握着钥匙；中心这一侧拿不到、也不需要）。
  // 往前取一页：默认多少条、最多多少条（**住代码里**；客户端也能提，但这里封顶）
const BACKFILL_PAGE = 50;
const BACKFILL_MAX = 200;

// 🔴 **读的是「他自己那一份世界」的路由，必须进这张表**（否则宿主会替他那台盒子答 ——
//    2026-09-23 真栽过：`/api/timeline` 只写了路由、忘了进表 ⇒ 每一个有容器的用户
//    「往上翻」永远得到空页 ⇒ 屏幕说「没有更早的了」，而盒子里明明有。见 `test/tenant-routes.test.js`）
const TENANT_ROUTES = ['/api/say', '/api/health', '/api/export', '/api/trash', '/api/app-ask', '/api/timeline'];

  /**
   * 把一条 HTTP 请求**原样**转进那个人的容器，并把响应**流式**带回来。
   *
   * ⚠️ 用 `createConnection` 把"通道那条隧道"当成 socket 塞给 `http.request`
   *    ⇒ HTTP 的序列化/解析**不用自己写**（也就少一整类"自己写解析器写错"的事）。
   */
  function proxyToTenant(sock, req, res, { body = null } = {}) {
    const headers = { ...req.headers };
    // hop-by-hop 的头不许原样带过去
    for (const h of ['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade']) {
      delete headers[h];
    }
    // ⚠️ **必须有上限**（2026-09-21 实测）：隧道那头要是没回话，
    //    这个请求会**一直挂着**，而客户端看到的是"转圈"或空响应 ——
    //    那是本项目最忌的"看起来在跑"。到点**如实说"它没应"**。
    const deadline = setTimeout(() => {
      try {
        up.destroy();
      } catch {
        /* 已经没了 */
      }
      if (!res.headersSent) {
        sendJson(res, 504, { error: 'tenant-timeout', text: '你那台刚才没应，等会儿再试。' });
      }
    }, 20_000);
    deadline.unref?.();

    const up = http.request(
      {
        createConnection: () => sock,
        method: req.method,
        path: req.url,
        headers,
      },
      (upRes) => {
        clearTimeout(deadline);
        const out = { ...upRes.headers };
        delete out['transfer-encoding'];
        res.writeHead(upRes.statusCode ?? 502, out);
        upRes.pipe(res); // 流式（别缓冲）
      },
    );
    up.on('error', (err) => {
      clearTimeout(deadline);
      // ⚠️ 隧道断了要说**实话**，别回一个笼统的 500
      log(`[tenant] 转发失败：${err?.message ?? err}`);
      if (!res.headersSent) {
        sendJson(res, 502, { error: 'tenant-unreachable', text: '你那台刚才断了一下。' });
      } else {
        res.destroy();
      }
    });
    if (body !== null) {
      // ⚠️ 身体已经被读过一遍（例如问一句那条路要先解析）⇒ **重新给一份**，
      //    并把长度按这一份算（不然对面会一直等一个永远不来的身体）。
      const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
      headers['content-length'] = String(buf.length);
      up.end(buf);
    } else {
      req.pipe(up);
    }
    return undefined;
  }

  async function handleTrashWrite(req, res, kind, W) {
    let body;
    try {
      body = await readJson(req, 16 * 1024);
    } catch {
      return sendJson(res, 400, { error: 'bad-json' });
    }
    if (body?.confirm !== true) return sendJson(res, 400, { error: 'confirm-required' });
    try {
      if (kind === 'remove') {
        const r = W.trash.remove(body?.messageIds);
        return sendJson(res, 200, {
          ok: true, messageIds: r.messageIds, purgeAt: r.at + W.trash.ttlMs,
        });
      }
      const r = W.trash.purge(body?.messageIds);
      return sendJson(res, 200, { ok: true, freedBytes: r.freedBytes });
    } catch (err) {
      // 认不出来的输入 / 已经彻底删过 / 压实失败 —— 都要**说清哪一种**，别回一个笼统的 500
      log(`[trash] ${kind} 失败：${err?.message ?? err}`);
      return sendJson(res, 400, { error: 'trash-failed', reason: err?.message ?? String(err) });
    }
  }

  async function handleLogin(req, res) {
    const ip = clientIp(req);
    if (auth.isLocked(ip)) {
      const left = Math.ceil(auth.lockRemainingMs(ip) / 1000);
      // 手册 D2：**要给剩余时间**，不是只说"试得太频繁了"
      return sendJson(res, 429, { error: 'locked', retryAfterSec: left });
    }
    let body;
    try {
      body = await readJson(req, 4096);
    } catch {
      return sendJson(res, 400, { error: 'bad-json' });
    }
    // ★ **手机号 + 验证码**（多租户的第一个入口 · 契约 §三/§六）。
    //   ⚠️ 与口令那条**并存**：老客户端还在这条路上，不许一脚踢开。
    const phone = typeof body?.phone === 'string' ? body.phone.trim() : '';
    if (phone !== '') {
      if (!devCode) {
        // 没开临时码、也还没接短信 ⇒ **如实说没这条路**（不是"码错了"）
        return sendJson(res, 503, { error: 'no-sms', text: '还没接短信，先别用手机号登录。' });
      }
      const code = typeof body?.code === 'string' ? body.code.trim() : '';
      if (code !== devCode) {
        const locked = auth.recordLoginFailure(ip);
        return sendJson(res, 401, { error: 'bad-code', locked });
      }
      let who;
      try {
        who = users.ensure(phone); // 第一次见到的号 ⇒ **当场建一个用户**
      } catch {
        return sendJson(res, 400, { error: 'bad-phone' });
      }
      auth.recordLoginSuccess(ip);
      // ★ **新号（以及"上次没开成"的老号）在这一刻拿到他那一台的申请**
      //   （契约 `43-AUTO-PROVISION.md` §四）。
      //   ⚠️ 放在**登录**而不是 `/api/space`：那条路是"只查"，要能随便刷 ——
      //      在它里面投申请就等于"刷一下页面就多一张申请"。
      //   ⚠️ 失败了**不许**把登录挡掉：人先进得来，状态照实说。
      //   ⚠️ 这里的返回值**只用来记日志**，一个字段都不回给客户端。
      try {
        const asked = ensureTenant ? ensureTenant(who.id) : null;
        if (asked && !asked.ok && asked.why !== 'mapped' && asked.why !== 'local') {
          log(`  ⚠️ ${who.id} 那台没申请成（${asked.why}）—— 状态会如实说是哪一档`);
        }
      } catch (err) {
        log(`  ⚠️ 申请那一步抛了：${err?.message ?? err}（登录照常）`);
      }
      try {
        const { token, expiresAt } = auth.issue({ sub: who.id });
        // ★ 登录回执**带上"他那台到哪一步了"**（`38` §8.3）：
        //   客户端靠它决定"进聊天"还是"先看等待屏 / 填 key 屏"。
        //   ⚠️ 这是个**新增字段**：老客户端不认识它 ⇒ **缺字段按"就绪"兼容**
        //      （所以不认识它的客户端行为**逐字不变**）。
        return sendJson(res, 200, {
          token,
          expiresAt,
          isNew: who.created,
          space: tenantStatusOf(who.id),
        });
      } catch (err) {
        // ⚠️ 这台机器还没设过口令 ⇒ `issue()` 会拒绝（fail-closed）。**如实说**。
        return sendJson(res, 503, { error: 'not-setup', text: String(err?.message ?? err) });
      }
    }

    const ok = auth.verifyPassword(body?.password);
    if (!ok) {
      const locked = auth.recordLoginFailure(ip);
      return sendJson(res, 401, { error: 'bad-password', locked });
    }
    auth.recordLoginSuccess(ip);
    const { token, expiresAt } = auth.issue({ sub: 'owner' });
    return sendJson(res, 200, { token, expiresAt });
  }

  async function handleSay(req, res, claim, W) {
    let body;
    try {
      body = await readJson(req, 64 * 1024);
    } catch (err) {
      return sendJson(res, 400, { error: 'bad-json' });
    }
    try {
      // ★ **准入闸**（手册 §9.1）：满了就明确拒绝，而且要在**落盘之前**判。
      //   ⚠️ 重发（duplicate）**不判**：那一句早就落盘了，拿"忙"拒它会让界面说假话
      //      （显示"没发出去"，而服务端其实收下了，那一轮还在跑）。
      //   ⚠️ 拒了 ⇒ **什么都没写**（`say.say()` 根本没被调用）——这就是
      //      §9.1 那句"不建空 jsonl 文件"的落点。
      if (!W.say.isDuplicate(body?.messageId)) {
        const adm = admit();
        if (!adm.ok) {
          log(`[准入] 拒了一句（内存 ${Math.round((adm.ratio ?? 0) * 100)}% ≥ ${Math.round(ADMIT_RATIO * 100)}%）`);
          return sendJson(res, 429, { error: 'busy' });
        }
      }

      const result = W.say.say({
        messageId: body?.messageId,
        text: body?.text,
        clientAt: body?.clientAt,
      });
      // ⚠️ **只有真落盘了才交给 agent**。
      //    重复（duplicate）**绝不能**再投一次——
      //    那正是"重发 = agent 干两遍"（评审 E2）。
      if (!result.duplicate && W.dispatcher) {
        // 投递是异步的（`session/prompt` 立刻返回，答案从事件流回来），
        // 所以**不等它**——等它会把 HTTP 响应也拖住。
        W.dispatcher.deliver(body?.text, { messageId: body?.messageId }).catch((err) => {
          log(`[dispatch] 投递失败：${err?.message ?? err}`);
        });
      }
      return sendJson(res, 200, {
        ok: true,
        duplicate: result.duplicate,
        seq: result.event?.seq ?? null,
        sub: claim.sub,
      });
    } catch (err) {
      if (err instanceof SayError) return sendJson(res, err.status, { error: err.message });
      throw err;
    }
  }

  // ── 静态文件 ────────────────────────────────────────────

  /** 字体镜像：先看磁盘缓存，没有就去 gstatic 取一次（**服务端这一侧取得到**）。 */
  async function serveFontMirror(req, res, rel) {
    const cached = fontCacheDir ? nodePath.join(fontCacheDir, rel) : null;
    const send = (buf) => {
      res.writeHead(200, {
        'content-type': 'font/woff2',
        // ⚠️ 路径里带版本与内容哈希 ⇒ 可以长缓存（同"带指纹的产物"那条规矩）
        'cache-control': 'public, max-age=31536000, immutable',
        'content-length': buf.length,
        'x-content-type-options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : buf);
    };
    try {
      if (cached && nodeFs.existsSync(cached)) return send(nodeFs.readFileSync(cached));
    } catch { /* 读不出来就往下走（去取一份新的） */ }
    try {
      const up = await fetch(`https://fonts.gstatic.com/s/${rel}`);
      if (!up.ok) return sendJson(res, 404, { error: 'not-found' });
      const buf = Buffer.from(await up.arrayBuffer());
      try {
        if (cached) {
          nodeFs.mkdirSync(nodePath.dirname(cached), { recursive: true, mode: 0o755 });
          nodeFs.writeFileSync(cached, buf, { mode: 0o644 });
        }
      } catch { /* 存不下就每次去取，不算错 */ }
      return send(buf);
    } catch (err) {
      log(`[fonts] 取不到 ${rel}：${err?.message ?? err}`);
      return sendJson(res, 404, { error: 'not-found' });
    }
  }

  function serveStatic(req, res, path) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'method-not-allowed' });
    }
    const rel = path === '/' ? '/index.html' : path;
    // 防目录穿越
    const target = nodePath.normalize(nodePath.join(webRoot, rel));
    if (!target.startsWith(nodePath.resolve(webRoot))) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    let file = target;
    let stat = nodeFs.existsSync(file) ? nodeFs.statSync(file) : null;
    if (!stat || stat.isDirectory()) {
      // ★ P1-14（2026-09-24）：**"看起来像文件"的路径不许回 index.html**。
      //
      // 为什么：SPA 回退对**任何**不认识的路径都回 index.html（200）。
      // 于是一个坏掉的/旧的入口请求（`/main.<旧指纹>.dart.js`）会拿到**一段 HTML**，
      // 浏览器把它当 JS 解析 ⇒ **整页白屏**，而服务器日志里一片 200 ——
      // 把"缺个文件"变成了"白屏"，**把病因藏起来了**。
      // （2026-09-24 那场白屏就是这么被藏住的：`curl /main.deadbeef0000.dart.js` 回 **200**。）
      // ⇒ 带"资源扩展名"的路径**如实回 404**（负向对照：真入口仍然 200）。
      if (LOOKS_LIKE_ASSET.test(path)) {
        return sendJson(res, 404, { error: 'not-found', text: '这个文件不在了' });
      }
      // SPA 回退：不认识的路径交回 index.html（**只有页面路由**走这条）
      file = nodePath.join(webRoot, 'index.html');
      stat = nodeFs.existsSync(file) ? nodeFs.statSync(file) : null;
      if (!stat) return sendJson(res, 404, { error: 'not-found' });
    }
    const ext = nodePath.extname(file).toLowerCase();
    const relFile = `/${nodePath.relative(webRoot, file)}`;
    const cc = cacheControlFor(relFile);
    // HTTP 的日期只到秒 ⇒ 比较时也要落到秒，否则"同一秒内的改动"会被误判成 304
    const lastModified = new Date(Math.floor(stat.mtimeMs / 1000) * 1000).toUTCString();

    // ★ **预压缩的那一份优先**（2026-09-23 实测加上的）。
    //   为什么：这条路的上行只有 ~3.4 Mbps，而 `main.dart.js` 2.7MB、`canvaskit.wasm` 6.9MB
    //   都是**原样发**的 ⇒ 首屏几十秒。预压之后 br 只剩 23%/31%（实测），
    //   而"现场压"只能 gzip、还白花 CPU ⇒ 部署时压一次（`scripts/precompress.mjs`）。
    //   ⚠️ 一定要 `vary`：不然中间任何一层缓存都可能把 br 的那份发给不收 br 的客户端。
    const pick = pickEncoding(req.headers['accept-encoding']);
    let sendFile = file;
    let sendStat = stat;
    let encoding = null;
    if (pick) {
      const cand = `${file}.${pick === 'br' ? 'br' : 'gz'}`;
      try {
        const st2 = nodeFs.statSync(cand);
        // ⚠️ 压缩那份比源新才算数（源改了而没重压 ⇒ 宁可发原文）
        if (st2.isFile() && st2.mtimeMs >= stat.mtimeMs) {
          sendFile = cand;
          sendStat = st2;
          encoding = pick;
        }
      } catch {
        /* 没预压过就用原文 */
      }
    }

    const baseHeaders = {
      'cache-control': cc,
      'last-modified': lastModified,
      vary: 'accept-encoding',
    };

    // ★ **回来问一句**的时候，没改就只回 304（不带 body）。
    const ims = Date.parse(req.headers['if-modified-since'] ?? '');
    if (!Number.isNaN(ims) && Math.floor(stat.mtimeMs / 1000) * 1000 <= ims) {
      res.writeHead(304, baseHeaders);
      return res.end();
    }

    res.writeHead(200, {
      ...baseHeaders,
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': sendStat.size,
      ...(encoding ? { 'content-encoding': encoding } : {}),
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    nodeFs.createReadStream(sendFile).pipe(res);
  }

  /**
   * 客户端收哪种压缩（**br 优先**：实测比 gz 再小一截）。
   *
   * ⚠️ 只做最基本的那点解析：`gzip, deflate, br` 这种；带 `q=0` 的算"不要"。
   *    复杂的权重排序不值得写 —— 我们要发的那两份是部署时就压好的，二选一而已。
   */
  function pickEncoding(header) {
    const raw = String(header ?? '').toLowerCase();
    if (!raw) return null;
    const wanted = new Set();
    for (const part of raw.split(',')) {
      const [name, ...params] = part.trim().split(';');
      const q = params.find((x) => x.trim().startsWith('q='));
      if (q && Number.parseFloat(q.split('=')[1]) === 0) continue;
      wanted.add(name.trim());
    }
    if (wanted.has('br')) return 'br';
    if (wanted.has('gzip')) return 'gzip';
    return null;
  }

  // ── WebSocket ───────────────────────────────────────────

  /**
   * 拒绝一次 WS 升级。
   *
   * ⚠️ 要带 **body 与 content-type**：裸的 `HTTP/1.1 401` 客户端什么也读不到，
   * 排障时**分不清是"没令牌"还是"中间有人挡了"**（nginx 也会回 401/503）。
   * 带上 JSON 之后，"这个响应到底出自我这儿还是出自代理"一眼可辨。
   */
  function rejectUpgrade(socket, status, reason, payload) {
    const body = JSON.stringify(payload);
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\n` +
        'content-type: application/json; charset=utf-8\r\n' +
        `content-length: ${Buffer.byteLength(body)}\r\n` +
        'connection: close\r\n' +
        '\r\n' +
        body,
    );
    socket.destroy();
  }

  const wss = new WebSocketServer({
    noServer: true,
    // 只认 `bearer` 这一个子协议名；**回显的是名字，不是令牌**
    // （默认行为是回显第一个，虽然这里也安全，但显式写出来免得后人改坏）
    handleProtocols: (protocols) => (protocols.has('bearer') ? 'bearer' : false),
  });

  // **`/api/asr` 那条**（语音本体 · 2026-09-23）：另开一条连接、另带一套帧
  // （**二进制帧 = 音频**），这样聊天那条已经冻结的协议**一个字都不用动**。
  const asrWss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has('bearer') ? 'bearer' : false),
  });

  /**
   * WS 的握手处理。**抽成函数**是因为它有两条听入口：
   * 普通那条（要令牌）与**可信本地那条**（容器里 · 身份由内核保证 · 选项甲）。
   */
  function handleUpgrade(req, socket, head, trusted) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const wantAsr = url.pathname === ASR_PATH;
    if (url.pathname !== '/api/stream' && !wantAsr) {
      return rejectUpgrade(socket, 404, 'Not Found', { error: 'not-found' });
    }
    let claim;
    if (trusted) {
      // ⚠️ 可信那条**同一个道理**：不查令牌、也不吃 fail-closed
      //    （少了这一句，容器里的流会因为"没设密码"被 503 —— 而宿主已经验过了）
      claim = { sub: trustedSub, trusted: true };
    } else {
      if (auth.needsSetup) {
        return rejectUpgrade(socket, 503, 'Service Unavailable', {
          error: 'not-setup',
          text: '这台机器还没设密码，先设好再用。',
        });
      }
      // 令牌走**子协议**：`['bearer', <token>]`（手册 §2.1）
      const proto = req.headers['sec-websocket-protocol'];
      let token = null;
      if (typeof proto === 'string') {
        const parts = proto.split(',').map((s) => s.trim());
        const i = parts.indexOf('bearer');
        if (i !== -1) token = parts[i + 1] ?? null;
      }
      claim = token ? auth.verify(token) : null;
      if (!claim) {
        // ⚠️ 在**握手阶段**拒，不要"先连上再关"
        return rejectUpgrade(socket, 401, 'Unauthorized', { error: 'unauthorized' });
      }
      // ── ★ **数据面**：这个人在容器里 ⇒ 把这次升级**原样转进去** ──────────
      const tenant = tenantOf(claim.sub);
      // ⚠️ 升级那条路**同一个道理**：不是主人、又没租户 ⇒ 不许落在宿主上
      if (!tenant && !isLocalUser(claim.sub) && tenantStatusOf(claim.sub).kind === 'tenant') {
        return rejectUpgrade(socket, 503, 'Service Unavailable', {
          error: 'space-not-ready',
          text: '你那台还在准备，稍等一下再试。',
        });
      }
      if (tenant) {
        const sock = proxyFor ? proxyFor(tenant) : null;
        if (!sock) {
          return rejectUpgrade(socket, 503, 'Service Unavailable', {
            error: 'tenant-not-ready',
            text: '你那台还在准备，稍等一下再试。',
          });
        }
        return proxyUpgrade(req, socket, head, sock);
      }
    }
    if (wantAsr) {
      // 音频那条：身份**同一个来源**（验过签的 `claim`），但帧走另一套。
      // ⚠️ `claim` 住在**上面那个块里**，`onAsr` 在外面 ⇒ 必须**显式传进去**
      //    （2026-09-24 踩到：写成闭包里引用 ⇒ `ReferenceError: claim is not defined`，
      //      而且是**运行到那一条连接时**才炸 —— 判据当场抓住）。
      return asrWss.handleUpgrade(req, socket, head, (ws) => onAsr(ws, req, claim));
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      onStream(ws, url, claim);
    });
  }

  /**
   * **`/api/asr`**：把这条连接交给中继（`src/asr.js`）。
   *
   * ⚠️ 这台部署**没配钥匙**也要接上：不接的话浏览器只能看到"握手失败"，
   * 而界面就得猜一个理由（本项目最贵的那类毛病：页面在说假话）。
   * ⇒ 接上，然后**如实说一句"没配"**，由客户端原话转达。
   */
  function onAsr(ws, req = null, claim = null) {
    if (!asr) {
      try {
        ws.send(JSON.stringify({ type: 'asr/unavailable', reason: 'not-configured' }));
      } catch {
        /* 已经没了 */
      }
      try {
        ws.close(1000);
      } catch {
        /* 已经没了 */
      }
      return;
    }
    // 把"是谁、哪台设备"传下去：
    //   · `sub` = **验过签的身份**（上面那个 `claim`），只用来**选哪份凭据**（P1-26）；
    //   · `ua` 只用于日志（某台手机上不行时，这一行是唯一线索）。
    asr.attach(ws, { sub: claim?.sub ?? null, ua: req?.headers?.['user-agent'] ?? '未知设备' });
  }

  /**
   * 🔴 **把一次 WebSocket 升级原样转进隧道**（多租户 · 数据面）。
   *
   * ⚠️ 为什么是"搬字节"而不是"用 `ws` 客户端再连一次"：
   *    用 `ws` 就等于**把协议实现两遍**（子协议、扩展、掩码、关闭握手…），
   *    每一处细节都可能和容器那台不一致。
   *    ⇒ 这里只做一件事：**把客户端的原始请求行与头原样写进隧道**，
   *      让**容器那台自己**完成握手；握手之后两边都是裸字节，直接对拷。
   */
  function proxyUpgrade(req, socket, head, sock) {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    sock.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head && head.length > 0) sock.write(head);

    const done = () => {
      try {
        socket.destroy();
      } catch {
        /* 已经没了 */
      }
      try {
        sock.destroy();
      } catch {
        /* 已经没了 */
      }
    };
    socket.on('error', done);
    socket.on('close', done);
    sock.on('error', done);
    sock.on('close', done);
    socket.pipe(sock);
    sock.pipe(socket);
  }

  server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head, false));

  function onStream(ws, url, claim) {
    // ★ **这条流也是按人取的**（多租户）：补发与订阅都必须走**他那一份**时间线，
    //   否则甲连上来的流会补发出乙的话。身份同样只从验过签的 `claim` 来。
    const W = worldFor(claim.sub);
    const rawSince = url.searchParams.get('sinceSeq');
    const sinceSeq = rawSince === null ? 0 : Number.parseInt(rawSince, 10);
    // ⚠️ **`dev=1` 与 `level` 是并存的，不是别名。** 两个理由：
    //   ① `dev=1` 是一条**附加**通道（代码里原本就这么写着、也这么用着：
    //      "它多收步骤事件，但**不缺**正常事件"）。把它改成 `level=steps`
    //      的别名，`?dev=1&level=reasoning` 就会**静默降档**——调试的人
    //      以为自己在看最上面那一档，其实只拿到步骤。别名会把
    //      "附加"变成"覆盖"，那是对既有行为的破坏。
    //   ② 两者管的**不是同一件事**：`level` 是产品档位（每条连接一份、
    //      主人选的），`dev` 是开发调试通道（跟"这道闸开不开"无关）。
    //      混成一个概念，以后想动调试通道就会碰到产品协议。
    //   并存时的语义：**dev 只加不减** —— 档位不变，步骤事件额外放行。
    const devMode = url.searchParams.get('dev') === '1';
    // ★ **按连接**解一次档（契约 §二·2）；不认识的当默认档，不拒连接
    const level = parseLevel(url.searchParams);

    // 补发（手册 §2.2，决策 P-h）
    let plan;
    try {
      plan = planResume({ events: W.store.readAll(W.timeline.id), sinceSeq });
    } catch {
      ws.close(1008, 'bad-sinceSeq');
      return;
    }
    if (plan.reset) {
      // 客户端的号跑到我们前面去了 ⇒ 明确要它从头来，
      // **不能**什么都不发（那会把它永远停在一个不存在的世界上）
      ws.send(JSON.stringify({ type: 'client/reset', reason: 'cursor-ahead' }));
    } else {
      // ⚠️ 补发这一路**不过档位闸**，而且这是安全的——理由只有一个：
      //    `plan.frames` 全部来自 `store.readAll()`，即**盘上的事件**，
      //    而过程事件（`step/*` · `reasoning/*`）是瞬态的、**永远不在盘上**。
      //    ⇒ 任何档位都能收全量补发：补发里**不可能**有推理原文。
      //    ⚠️ 反过来说：如果哪天有人把 `emitTransient` 换成 `emit`，
      //       这一路就会把推理原文补发给 `sinceSeq=0` 的新连接——
      //       泄露闸（`test/process-level.test.js` 那条 🔴）就是为此存在的。
      for (const frame of plan.frames) {
        ws.send(JSON.stringify(markCatchUp(frame, plan.catchUp)));
      }
    }
    ws.send(JSON.stringify({
      type: 'client/hello',
      serverNow: now(),
      maxSeq: plan.maxSeq,
      catchUpRendering: CATCHUP_RENDER,
    }));

    // 实时
    const off = W.timeline.subscribe((event) => {
      // 这一条连接收不收它（四档 + `dev` 那条附加通道）—— 见 `levelAllows`
      if (!levelAllows(event, { level, dev: devMode })) return;
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    });

    const beat = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'client/ping', at: now() }));
    }, 25_000);
    beat.unref?.();

    ws.on('close', () => {
      off();
      clearInterval(beat);
      log(`[stream] 断开（${claim.sub}）`);
    });
    ws.on('error', (err) => log(`[stream] 出错：${err?.message ?? err}`));
  }

  // ── 工具 ────────────────────────────────────────────────

  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  }

  /**
   * **`ask` 的四道闸**（乙-4b）：这一条在他这儿 · 清单里**声明了** · 他**授予了** · 配额还有。
   *
   * ⚠️ 收成一个函数是刻意的：**中心**与**匣子**用的是同一份判断，
   *    免得两处各写一遍、慢慢分叉。
   * ⚠️ **先记再花**（`bumpAsk`）也在这儿 —— 宁可少花一次，也不许漏账。
   */
  function checkAppAsk(apps, appIdRaw) {
    const appId = typeof appIdRaw === 'string' ? appIdRaw : '';
    if (!apps) return { ok: false, status: 404, error: '这台部署还没开小程序' };
    const mine = apps.list().find((a) => a.id === appId);
    if (!mine) return { ok: false, status: 404, error: '没有这个小程序' };
    if (!(mine.permissions ?? []).includes('ask')) {
      return { ok: false, status: 403, error: '这个小程序没说要问话' };
    }
    if (!apps.grants(appId).includes('ask')) {
      return { ok: false, status: 403, error: '你还没允许它用你的钥匙' };
    }
    const q = apps.askQuota(appId);
    if (!q.ok) return { ok: false, status: 429, error: q.reason };
    apps.bumpAsk(appId);
    return { ok: true, left: q.left };
  }

  function readJson(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('body 太大'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * **额外听一条只有 root 开得开的 UDS**（容器专用 · 选项甲）。
   * ⚠️ 宿主上**不调它** ⇒ 宿主行为逐字不变。
   */
  let trustedServer = null;
  function listenTrusted(socketPath) {
    const s = http.createServer((req, res) => {
      handleRequest(req, res, true).catch((err) => {
        log(`[http/local] 未处理异常：${err?.stack ?? err}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
        else res.destroy();
      });
    });
    // ⚠️ 可信那条也要处理 upgrade（流就是从这儿进来的）
    s.on('upgrade', (req, sock2, head) => handleUpgrade(req, sock2, head, true));
    return new Promise((resolve, reject) => {
      s.once('error', reject);
      s.listen(socketPath, () => {
        // 🔴 **权限就是这条路的全部安全性**：`0600` ⇒ 只有属主（容器里的 root）开得开。
        //    ⚠️ 改宽它 = 把"以这个用户身份说话"的资格递给别人。
        try {
          nodeFs.chmodSync(socketPath, 0o600);
        } catch (err) {
          reject(new Error(`可信套接字的权限没设成 0600：${err?.message ?? err}`));
          return;
        }
        trustedServer = s;
        resolve({ path: socketPath });
      });
    });
  }

  return {
    server,
    webRoot,
    listenTrusted,
    /** ⚠️ 只在 127.0.0.1 上听。对外由 VPS 那条隧道走（stcp 不占公网端口）。 */
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    close() {
      // ⚠️ `server.close()` 会等所有连接自己断开。WS 是长连接，
      //    所以必须先**主动**结束它们——否则关闭会一直挂着
      //    （测试里表现为超时，生产里表现为"停不下来"）。
      //    🔴 **两条 WS 都要终止**：2026-09-23 加 `/api/asr` 时漏了它，
      //       当场被测试抓住 —— 只要有一个语音连接开着，`restart-core.sh` 就会卡住。
      for (const client of [...wss.clients, ...asrWss.clients]) {
        try {
          client.terminate();
        } catch {
          /* 已经断了 */
        }
      }
      // keep-alive 的空闲连接也会让 close() 等下去
      server.closeIdleConnections?.();
      // ⚠️ 可信那条也要关（不然它会把进程留住）
      const closeTrusted = trustedServer
        ? new Promise((r) => trustedServer.close(() => r()))
        : Promise.resolve();
      return Promise.all([
        new Promise((resolve) => {
          wss.close(() => {
            server.close(() => resolve());
            server.closeIdleConnections?.();
          });
        }),
        new Promise((resolve) => asrWss.close(() => resolve())),
        closeTrusted,
      ]).then(() => undefined);
    },
  };
}
