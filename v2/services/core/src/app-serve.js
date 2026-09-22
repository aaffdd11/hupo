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
import nodeHttp from 'node:http';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeUrl from 'node:url';

import { AppsError } from './apps.js';

/** 制品 URL 的前缀：`/a/<id>/<version>/<path>`。 */
export const ARTIFACT_PREFIX = '/a/';

/** 签名 URL 的有效期。**短**是刻意的：它是一条"凭 URL 就能取"的能力。 */
export const SIGNED_TTL_MS = 10 * 60 * 1000;

/**
 * 制品页的 CSP。
 *
 * 🔴 逐条都是故意的：
 *   · `default-src 'none'` —— **默认什么都不许**（fail-closed）
 *   · `script-src 'unsafe-inline'` / `style-src 'unsafe-inline'` —— 制品是单文件 HTML（不引外部资源）
 *   · `connect-src 'none'` —— **制品不许自己出网**（它要问话只能走平台那条窄通道，乙-4）
 *   · `base-uri 'none'` / `form-action 'none'` —— 堵住"改 base 之后把请求发到别处"
 *   · `frame-ancestors <壳>` —— **只许壳嵌它**（别处嵌不了）
 */
export function cspFor(frameAncestors) {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join('; ');
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

/** 拼一条入口 URL。`base` 形如 `http://127.0.0.1:8021`（**不带尾斜杠**）。 */
export function entryUrl({ base, key, sub, id, version, entry, now = Date.now(), ttlMs = SIGNED_TTL_MS }) {
  const exp = now + ttlMs;
  const sig = signEntry({ key, sub, id, version, exp });
  const q = new URLSearchParams({ u: sub, e: String(exp), s: sig });
  return `${base}${ARTIFACT_PREFIX}${id}/${version}/${entry}?${q}`;
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
 * 起那个口。
 *
 * @param {object} o
 * @param {(sub:string)=>{read:(id:string,version:any,rel:string)=>{content:Buffer,contentType:string}}|null} o.resolveApps
 *        按人去取制品库。**取不到就 `null`**（`null` ⇒ 一律拒 —— fail-closed）
 * @param {Buffer|string} o.key      签名密钥（**不进日志**）
 * @param {string} o.frameAncestors  壳的 origin（CSP `frame-ancestors`）
 * @param {(m:string)=>void} [o.log]
 * @param {()=>number} [o.now]
 */
export function createAppServer({ resolveApps, key, frameAncestors, log = () => {}, now = Date.now }) {
  if (!key) throw new AppsError('签名密钥必填');
  if (!frameAncestors) throw new AppsError('frameAncestors 必填（CSP 要它）');
  const csp = cspFor(frameAncestors);

  return nodeHttp.createServer((req, res) => {
    let parsed;
    try {
      parsed = nodeUrl.parse(req.url, false);
    } catch {
      deny(res, 403);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
      res.end('只支持 GET。\n');
      return;
    }
    const hit = parseArtifactPath(parsed.pathname ?? '');
    if (!hit) {
      deny(res, 404);
      return;
    }
    const q = new URLSearchParams(parsed.query ?? '');
    const sub = q.get('u') ?? '';
    const exp = q.get('e') ?? '';
    const sig = q.get('s') ?? '';
    // 🔴 **先验签，再碰盘**（顺序刻意：没签名的请求连目录都不看）
    if (!sub || !verifyEntry({ key, sig, sub, id: hit.id, version: hit.version, exp, now: now() })) {
      log(`制品口：签名不过（${hit.id}）`);
      deny(res, 403);
      return;
    }
    const apps = resolveApps(sub);
    if (!apps) {
      // 那格不存在（或者这个人还没建世界）⇒ 拒，不建目录
      deny(res, 403);
      return;
    }
    let got;
    try {
      got = apps.read(hit.id, hit.version, hit.rel);
    } catch (e) {
      log(`制品口：读不出来（${hit.id}）${e instanceof AppsError ? e.message : '未知错'}`);
      deny(res, 404);
      return;
    }
    res.writeHead(200, {
      'content-type': got.contentType,
      'content-length': got.content.length,
      // 🔴 **不许发 X-Frame-Options**（壳里要嵌它）；只让壳嵌 ⇒ 用 CSP 的 frame-ancestors
      'content-security-policy': csp,
      // 制品是"凭签名取一次"的东西：**别让浏览器缓存**（缓存了就没法验签了）
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(req.method === 'HEAD' ? undefined : got.content);
  });
}
