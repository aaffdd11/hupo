// **开发者模式**（契约 `docs/dev/82-DEV-MODE.md` · 主人 2026-09-24 定稿）。
//
// 一句话：把某个（被标成 `dev` 的）用户盒子里那台 `dsh web` 露到
// `dsh<手机号>.<HUPO_DEV_BASE>` 上，**盒子不开端口**（容器内只听回环），
// **外层用琥珀的登录锁**（App 里点一下 ⇒ 短时效签名链接 ⇒ 种第一方 cookie）。
//
// ── 两侧的活（别读成一套）───────────────────────────────────
//   · **宿主这一侧**（`createDevHostRelay`）：按 `Host` 认出开发者域名 ⇒
//     `/__enter` 验签种 cookie；其余路径要第一方 cookie（**验签 + 现查 dev**）⇒
//     经 `proxyFor(tenant)` 把请求送进容器，**路径加 `/h` 前缀**、**剥掉浏览器 cookie**。
//   · **盒子这一侧**（`createDevWebRelay` · 只在 `trusted === true` 的请求上）：
//     路径以 `/h` 开头 ⇒ 懒起 `dsh --profile web --patch <模型那条> --host 127.0.0.1 --port 0 --no-open`，
//     从 stdout 解析端口与进程令牌 ⇒ `GET /?token=` 换 DSH 自己的 cookie 存住 ⇒
//     之后每条上游请求都**替浏览器**带上它，并把 `Host`/`Origin` 改写成回环
//     （那道 `/api` 栅栏按回环放行，正反例都实测过 —— `81-HARNESS-ENTRY.md` §四）。
//
// ── 三条不许破 ─────────────────────────────────────────────
//   ① 🔴 **签名分域**：`/__enter` 的 payload 是 `d|<sub>|<exp>`，cookie 是 `dh|<sub>|<exp>`；
//      拿**制品**那条签名（`<sub>|<id>|<version>|<exp>`）或别处的签名来用 ⇒ **一律不过**（判据 D5）。
//   ② 🔴 **每个请求现查 `dev`**（`users.isDev`）：关掉就**当场**拒，不是等重启（判据 D4）。
//   ③ 🔴 **不缓冲**：请求体与响应体两头都 `pipe`（`dsh web` 的界面全走普通 HTTP）。
//
// ⚠️ **绝不用 root 跑 DSH、绝不用容器真实的 `DSH_HOME` 做探针**（`81-HARNESS-ENTRY.md` §9.3
//    那次事故）。这一份里的 spawn 走 `childEnv()` + `cfg.agentUid/Gid`（"换手"那条安全设计）。

import nodeCrypto from 'node:crypto';
import nodeHttp from 'node:http';
import { spawn as nodeSpawn } from 'node:child_process';

// ⚠️ 只借**纯函数**（与 `harness-session.mjs` 同一个做法）：
//    `childEnv()` 摘掉密钥；`harnessArgs()` 保证 `--patch` **写在 `--profile` 后面**。
import { childEnv } from './agent-runtime.js';
import { harnessArgs } from './harness-session.mjs';
// ⚠️ 只借**掩码**那一个纯函数：手机号是个人信息，**日志里只许出现掩码形态**
//    （与 `users.js` / `audit.js` 同一条纪律）。
import { maskPhone } from './audit.js';

/** 第一方 cookie 的名字（外层那把锁）。 */
export const DEV_COOKIE = 'hupo-dev';
/** 换 cookie 的那条路径。 */
export const DEV_ENTER_PATH = '/__enter';
/**
 * **要一条签名链接**那条（契约 `docs/dev/82-DEV-MODE.md` §六 D6）。
 *
 * ⚠️ 它和 `HARNESS_PATH` 一样是**常量**（不是散在 `server.js` 里的字符串字面量）：
 *    路径只有这一处出处，改的时候不会漏掉一半。
 */
export const DEV_HARNESS_PATH = '/api/dev-harness';
/** **翻标记**那条（只有 `owner` 能调）。 */
export const DEV_MODE_PATH = '/api/dev-mode';
/** 进容器这条路的前缀：`/api/x` → `/h/api/x`、`/` → `/h/`。 */
export const DEV_PATH_PREFIX = '/h';
/** 签名链接的有效期（**短**是刻意的：它是一条"凭 URL 就能进"的能力）。 */
export const DEV_LINK_TTL_MS = 10 * 60 * 1000;
/** cookie 会话的有效期（一天）。 */
export const DEV_COOKIE_TTL_MS = 24 * 60 * 60 * 1000;
/** 收 `dsh web` 的宽限：先 `SIGTERM`，到点还活着就 `SIGKILL`。 */
export const DEV_KILL_GRACE_MS = 2000;

/** 签名分域：换 cookie 的短链接。 */
export const DEV_ENTER_DOMAIN = 'd';
/** 签名分域：cookie 里的那个无状态会话。 */
export const DEV_COOKIE_DOMAIN = 'dh';

/** hop-by-hop：两头都不许原样带过去。 */
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/**
 * 日志前把**进程令牌**抹掉。
 *
 * ⚠️ 为什么要有它：`dsh web` 那一行里带着 `?token=…`（**那是一条能力，不是给日志看的**），
 *    而它的 stdout/stderr 尾巴会被拼进错误信息。进程令牌 / cookie 值一律不许进日志。
 */
export function redactSecrets(s) {
  return String(s ?? '')
    .replace(/([?&]token=)[^\s&'"]+/giu, '$1<已隐去>')
    .replace(/(dsh-auth-[A-Za-z0-9_-]*=)[^\s;'"]+/giu, '$1<已隐去>');
}

// ── Host ───────────────────────────────────────────────────

/** 开发者域名长什么样：`dsh<11 位手机号>.<base>`。 */
export const DEV_HOST_RE = /^dsh(1[3-9]\d{9})$/;

/**
 * 从 `Host` 头里解出手机号。**认不出来一律 `null`**（不猜）。
 *
 * ⚠️ 必须是**整整一个 label**：`evildsh…` / `dsh…evil.com` 都不认。
 * ⚠️ 端口要剥掉（`dsh….stalkerai.cn:8443` 是合法形态）。
 *
 * @param {string} hostHeader
 * @param {string} base 例如 `stalkerai.cn`
 * @returns {string|null}
 */
export function parseDevHost(hostHeader, base) {
  if (typeof hostHeader !== 'string' || typeof base !== 'string') return null;
  let host = hostHeader.trim().toLowerCase();
  if (host === '') return null;
  // 剥端口（IPv6 字面量在域名这条路上不存在，直接按最后一个冒号切）
  const colon = host.lastIndexOf(':');
  if (colon !== -1) host = host.slice(0, colon);
  const b = base.trim().toLowerCase().replace(/^\.+/u, '').replace(/\.+$/u, '');
  if (b === '') return null;
  const suffix = `.${b}`;
  if (!host.endsWith(suffix)) return null;
  const m = DEV_HOST_RE.exec(host.slice(0, -suffix.length));
  return m ? m[1] : null;
}

/** 反过来：`dsh<手机号>.<base>`。 */
export function devHostFor(phone, base) {
  return `dsh${phone}.${String(base ?? '').trim().replace(/^\.+/u, '')}`;
}

// ── 签名（HMAC-SHA256，和制品那条**同一个密钥**，但**分域**）──────

/** 签名真正覆盖的那串东西：**域在最前面**。 */
export function devPayload(domain, sub, exp) {
  return `${domain}|${sub}|${exp}`;
}

/** 算签名（十六进制）。 */
export function devSig({ key, domain, sub, exp }) {
  return nodeCrypto.createHmac('sha256', key).update(devPayload(domain, sub, exp)).digest('hex');
}

/**
 * 验签名。**四条一起验**（格式 · 到期 · 域 · 内容）。
 *
 * ⚠️ 比较用 `timingSafeEqual`（先各自 sha256 一道，避免长度不同直接抛）——
 *    与 `app-serve.js` 那条同一个做法。
 */
export function devSigOk({ key, domain, sig, sub, exp, now = Date.now() }) {
  if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/u.test(sig)) return false;
  if (typeof sub !== 'string' || sub === '') return false;
  const raw = String(exp ?? '');
  if (!/^\d{1,16}$/u.test(raw)) return false;
  const e = Number.parseInt(raw, 10);
  if (!Number.isInteger(e) || e < now) return false;
  let want;
  try {
    want = devSig({ key, domain, sub, exp: e });
  } catch {
    return false;
  }
  const a = nodeCrypto.createHash('sha256').update(sig).digest();
  const b = nodeCrypto.createHash('sha256').update(want).digest();
  return nodeCrypto.timingSafeEqual(a, b);
}

/** `/__enter` 那条链接的验签（域 `d`）。 */
export function verifyDevLink({ key, sig, sub, exp, now = Date.now() }) {
  return devSigOk({ key, domain: DEV_ENTER_DOMAIN, sig, sub, exp, now });
}

/** 拼一条 `/__enter` 链接。`origin` = `https://dsh<手机号>.<base>`（不带尾斜杠）。 */
export function devEntryLink({ origin, key, sub, now = Date.now(), ttlMs = DEV_LINK_TTL_MS }) {
  const exp = now + ttlMs;
  const s = devSig({ key, domain: DEV_ENTER_DOMAIN, sub, exp });
  const q = new URLSearchParams({ u: sub, e: String(exp), s });
  return { url: `${String(origin).replace(/\/+$/u, '')}${DEV_ENTER_PATH}?${q}`, expiresAt: exp };
}

// ── cookie 会话（**无状态**：会话本身就是 HMAC）──────────────────

/** 值 = `<sub>.<exp>.<sig>`（域 `dh`）。 */
export function devCookieValue({ key, sub, exp }) {
  return `${sub}.${exp}.${devSig({ key, domain: DEV_COOKIE_DOMAIN, sub, exp })}`;
}

/** 验 cookie；不过一律 `null`（不猜、不说为什么）。 */
export function verifyDevCookie({ key, value, now = Date.now() }) {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [sub, exp, sig] = parts;
  if (!devSigOk({ key, domain: DEV_COOKIE_DOMAIN, sig, sub, exp, now })) return null;
  return { sub, exp: Number.parseInt(exp, 10) };
}

/** `Set-Cookie` 那一行（**第一方** cookie 的三个属性都不许少）。 */
export function devCookieHeader({ value, maxAgeSec }) {
  return `${DEV_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

/** 从 `Cookie` 头里取一个值（重复出现取第一个）。 */
export function readCookie(header, name) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// ── 被扣的人看到的那一屏 ────────────────────────────────────

/** 一句普通话（**不解释技术细节**，也不给界面）。 */
export const DEV_DENY_TEXT = '这个入口现在不给你进。要用的话，在琥珀里点一下"开发者入口"，从那条链接进来。\n';

/** 一律拒（`403`）。**没通过外层 ⇒ 拒，不许先给界面。** */
export function devDeny(res, status = 403) {
  const body = status === 405 ? '这个方法不行。\n' : DEV_DENY_TEXT;
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/** 通了外层、但里层（盒子/隧道）没准备好 —— **如实说**。 */
export function devUnavailable(res, status, text) {
  const body = `${text}\n`;
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

// ── 宿主这一侧：按 Host 分流 ─────────────────────────────────

/**
 * 建宿主这一侧的开发者中继。
 *
 * @param {object} o
 * @param {Buffer|string} o.key    签名密钥（`appsSignKey`，**不进日志**）
 * @param {string} o.base          `HUPO_DEV_BASE`（默认 `stalkerai.cn`）
 * @param {(sock:import('node:stream').Duplex, req, res, path:string)=>void} o.forward
 *        把请求送进容器（宿主那一侧的 `proxyToTenant`）
 * @param {object} o.users         用户表（`isDev` / `get` / `phoneOf`）
 * @param {(sub:string)=>string|null} [o.tenantOf]
 * @param {(tenant:string)=>any} [o.proxyFor]
 */
export function createDevHostRelay({
  key,
  base,
  scheme = 'https',
  users = null,
  tenantOf = () => null,
  proxyFor = null,
  forward,
  now = Date.now,
  linkTtlMs = DEV_LINK_TTL_MS,
  cookieTtlMs = DEV_COOKIE_TTL_MS,
  log = () => {},
}) {
  if (!key) throw new Error('开发者模式需要签名密钥（appsSignKey）');
  if (typeof base !== 'string' || base.trim() === '') throw new Error('开发者模式需要域名后缀（HUPO_DEV_BASE）');
  if (typeof forward !== 'function') throw new Error('开发者模式需要 forward（把请求送进容器那条）');

  /** ⚠️ 日志一律先过 `redactSecrets`（进程令牌 / cookie 值不许进日志）。 */
  const say = (m) => log(redactSecrets(m));

  const devAt = (sub) => {
    try {
      return users?.isDev?.(sub) === true;
    } catch {
      return false;
    }
  };

  return {
    scheme,
    base,
    key,
    /**
     * 这个 `Host` 是不是开发者域名；是就回手机号。
     * ⚠️ **别的 Host 一律不管**（照旧走站点）—— 调用方只在它非 `null` 时接管。
     */
    match(hostHeader) {
      return parseDevHost(hostHeader, base);
    },
    /**
     * 处理一条落在开发者域名上的请求。
     *
     * @returns {Promise<void>}
     */
    async handle(req, res, url) {
      const phone = parseDevHost(req.headers?.host, base);
      const rec = phone ? users?.get?.(phone) ?? null : null;
      const sub = typeof rec?.id === 'string' ? rec.id : null;
      // ★ D1：没被标 `dev` ⇒ 这个域名**一律拒**（连 `/__enter` 都不给机会）
      if (!sub || !devAt(sub)) {
        say(`开发者域名：${phone ? maskPhone(phone) : '（认不出来）'} 没有开发者标记 ⇒ 拒`);
        return devDeny(res);
      }

      const path = url?.pathname ?? '/';

      // ── ★ `/__enter`：短时效签名 ⇒ 种第一方 cookie ⇒ 302 到 `/` ──
      if (path === DEV_ENTER_PATH) {
        if (req.method !== 'GET') return devDeny(res, 405);
        const q = url.searchParams;
        const u = q.get('u') ?? '';
        const e = q.get('e') ?? '';
        const s = q.get('s') ?? '';
        if (!verifyDevLink({ key, sig: s, sub: u, exp: e, now: now() })) {
          // ★ D5：制品那条签名 / 别处的签名走到这儿**一律不过**（域分开了）
          say('开发者域名：/__enter 的签名不过 ⇒ 拒');
          return devDeny(res);
        }
        // 链接必须就是这个域名这个人的（换域名/换人都不行）
        if (u !== sub) return devDeny(res);
        const exp = now() + cookieTtlMs;
        const value = devCookieValue({ key, sub, exp });
        res.writeHead(302, {
          location: '/',
          'set-cookie': devCookieHeader({ value, maxAgeSec: Math.floor(cookieTtlMs / 1000) }),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        res.end();
        return undefined;
      }

      // ── 其余路径：要第一方 cookie（验签 + **现查 dev**）──
      //   ★ D3：没 cookie ⇒ 拒（不是先给界面）
      //   ★ D4：cookie 还在、但标记刚被关掉 ⇒ **当场**拒（`devAt` 是每个请求现查的）
      const sess = verifyDevCookie({
        key,
        value: readCookie(req.headers?.cookie, DEV_COOKIE),
        now: now(),
      });
      if (!sess || sess.sub !== sub || !devAt(sess.sub)) return devDeny(res);

      const tenant = tenantOf(sess.sub);
      if (!tenant) {
        return devUnavailable(res, 503, '你这一份还没有单独一台，暂时进不去。');
      }
      const sock = proxyFor ? proxyFor(tenant) : null;
      if (!sock) {
        return devUnavailable(res, 503, '你那台现在没连上，等会儿再试。');
      }
      // ★ D2：进容器那条路**带 `/h` 前缀**（`/` → `/h/`、`/api/x` → `/h/api/x`），
      //   并把**浏览器那份 cookie 剥掉**（`forward` 里做）—— 里层那把锁归壳拿着。
      const rel = typeof req.url === 'string' && req.url.startsWith('/') ? req.url : `/${req.url ?? ''}`;
      try {
        forward(sock, req, res, `${DEV_PATH_PREFIX}${rel}`);
      } catch (err) {
        say(`开发者域名：转发进容器那一步抛了：${err?.message ?? err}`);
        if (!res.headersSent) devUnavailable(res, 502, '刚才没接上，等会儿再试。');
      }
      return undefined;
    },
  };
}

// ── 盒子这一侧：懒起 `dsh web` 并反代 ────────────────────────

/**
 * **给那个进程的参数**（契约 §四/§五）。
 *
 * 🔴 `--patch` 是**全局选项**，必须写在 `--profile web` **后面** —— 所以这里复用
 *    `harnessArgs()`（那个函数已经被 H5 那一组判据钉住"patch 挨着 profile"）。
 */
export function devWebArgs(cfg = {}) {
  return [
    ...harnessArgs({ ...cfg, agentProfile: 'web' }),
    // ⚠️ **只听回环、端口交给内核挑**（盒子**不开**任何宿主端口 —— 判据 D7）。
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '--no-open',
  ];
}

/**
 * 从 `dsh web` 的 stdout 里解出那一行：`dsh web: http://127.0.0.1:<port>/?token=…`。
 * 认不出来 `null`（**不猜**）。
 */
export function parseDshWebLine(line) {
  const m = /dsh web:\s*http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)/u.exec(String(line ?? ''));
  if (!m) return null;
  return { port: Number.parseInt(m[1], 10), token: m[2] };
}

/** 从 `set-cookie` 里挑出 DSH 自己那把（`dsh-auth-…`），返回 `name=value`。 */
export function pickDshAuth(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const raw of list) {
    const first = String(raw).split(';')[0].trim();
    if (/^dsh-auth/u.test(first)) return first;
  }
  return null;
}

/**
 * 建盒子这一侧的 `dsh web` 反代（**懒起**：第一条 `/h` 请求才起进程）。
 *
 * @param {object} o
 * @param {object} o.cfg   `config.js` 那份（`dshBin` / `agentCwd` / `dshHome` /
 *   `modelPatchPath` / `agentUid` / `agentGid` / `agentBootTimeoutMs`…）
 * @param {Function} [o.spawnFn]   注入用（判据里换成一个假子进程；默认真 spawn）
 * @param {Function} [o.httpRequest] 注入用（判据里换成一个假上游；默认真 `http.request`）
 */
export function createDevWebRelay({
  cfg,
  spawnFn = nodeSpawn,
  httpRequest = nodeHttp.request,
  log = () => {},
  killGraceMs = DEV_KILL_GRACE_MS,
  bootTimeoutMs = null,
} = {}) {
  if (!cfg) throw new Error('开发者中继需要 cfg');
  /** ⚠️ 日志一律先过 `redactSecrets`（进程令牌 / cookie 值不许进日志）。 */
  const say = (m) => log(redactSecrets(m));

  const bootMs =
    Number.isFinite(bootTimeoutMs) && bootTimeoutMs > 0
      ? bootTimeoutMs
      : Number.isFinite(cfg.agentBootTimeoutMs) && cfg.agentBootTimeoutMs > 0
        ? cfg.agentBootTimeoutMs
        : 90_000;

  /** 现在那个进程（`null` = 没起 / 已经没了）。 */
  let child = null;
  /** 起好之后的两个事实：回环端口、DSH 自己那把 cookie（**替浏览器**拿着）。 */
  let upstream = null;
  let starting = null;
  let closed = false;
  let stderrTail = '';

  function killChild() {
    const c = child;
    child = null;
    upstream = null;
    if (!c) return;
    try {
      c.kill('SIGTERM');
    } catch {
      /* 已经没了 */
    }
    const t = setTimeout(() => {
      try {
        c.kill('SIGKILL');
      } catch {
        /* 已经没了 */
      }
    }, killGraceMs);
    t.unref?.();
  }

  /** 起进程，等 stdout 上那一行。 */
  function spawnWeb() {
    const args = devWebArgs(cfg);
    const c = spawnFn(cfg.dshBin, args, {
      cwd: cfg.agentCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // 🔴 **换手**：盒里的服务是 root，而 root 带 CAP_DAC_OVERRIDE
      //    ⇒ 不换手的话那台 DSH 能读钥匙（决策 ①）。换不过去会异步 EPERM ⇒ 大声失败。
      ...(cfg.agentUid !== null && cfg.agentUid !== undefined ? { uid: cfg.agentUid } : {}),
      ...(cfg.agentGid !== null && cfg.agentGid !== undefined ? { gid: cfg.agentGid } : {}),
      // ★ env 走 `childEnv()`（**摘掉密钥**）—— `HUPO_MODEL_TICKET` 是镜像烘死的占位符。
      env: childEnv({ home: cfg.dshHome }),
    });
    child = c;
    if (c?.stdout?.setEncoding) c.stdout.setEncoding('utf8');
    if (c?.stderr?.setEncoding) c.stderr.setEncoding('utf8');
    c?.stderr?.on?.('data', (d) => {
      stderrTail = (stderrTail + String(d)).slice(-2000);
    });
    // 进程自己没了 ⇒ 清掉状态（下一条请求会**重新懒起**，不是永远坏着）
    c?.on?.('exit', () => {
      if (child === c) {
        child = null;
        upstream = null;
      }
    });

    return new Promise((resolve, reject) => {
      let buf = '';
      let done = false;
      const finish = (err, val) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(val);
      };
      const timer = setTimeout(() => finish(new Error(`等 dsh web 报端口超时（${bootMs}ms）`)), bootMs);
      timer.unref?.();
      c?.stdout?.on?.('data', (chunk) => {
        buf += String(chunk);
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const hit = parseDshWebLine(line);
          if (hit) {
            finish(null, hit);
            return;
          }
        }
      });
      c?.on?.('error', (err) => finish(err));
      c?.on?.('exit', (code, signal) => {
        finish(
          new Error(
            `dsh web 起不来（code=${code ?? '—'}${signal ? `，signal=${signal}` : ''}）` +
              `${stderrTail.trim() ? `；它最后说的话：${redactSecrets(stderrTail).trim().slice(-300)}` : ''}`,
          ),
        );
      });
    });
  }

  /** 一条一次性 GET（不跟重定向）。 */
  function oneGet(port, path) {
    return new Promise((resolve, reject) => {
      const r = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'GET',
          path,
          headers: { host: `127.0.0.1:${port}`, accept: 'text/html' },
        },
        (upRes) => {
          upRes.resume(); // 丢掉身体（**不是**缓冲）
          resolve({ status: upRes.statusCode ?? 0, headers: upRes.headers ?? {} });
        },
      );
      r.on('error', reject);
      r.end();
    });
  }

  /**
   * 用进程令牌换 DSH 自己那把 cookie。
   * ⚠️ `/?token=` **会 303**（`81-HARNESS-ENTRY.md` §三）⇒ **要跟**（跟着找 set-cookie）。
   */
  async function exchangeToken(port, token) {
    let path = `/?token=${encodeURIComponent(token)}`;
    for (let hop = 0; hop < 4; hop += 1) {
      const r = await oneGet(port, path);
      const cookie = pickDshAuth(r.headers['set-cookie']);
      if (cookie) return cookie;
      const loc = r.headers.location;
      if (r.status >= 300 && r.status < 400 && typeof loc === 'string') {
        try {
          const u = new URL(loc, `http://127.0.0.1:${port}`);
          if (u.host === `127.0.0.1:${port}`) {
            path = `${u.pathname}${u.search}`;
            continue;
          }
        } catch {
          /* 认不出来就不跟 */
        }
      }
      break;
    }
    throw new Error('没换到 dsh 自己那把 cookie（那个进程令牌可能不认）');
  }

  /** 起（或复用）那台 `dsh web`。 */
  async function ensure() {
    if (closed) throw new Error('开发者中继已经关了');
    if (upstream) return upstream;
    if (!starting) {
      starting = (async () => {
        const hit = await spawnWeb();
        try {
          const cookie = await exchangeToken(hit.port, hit.token);
          // ⚠️ **令牌与 cookie 都不进日志**（只说端口与"通了"）
          say(`盒里那台 dsh web 起来了（127.0.0.1:${hit.port}，只听回环；cookie 已存住）`);
          upstream = { port: hit.port, cookie };
          return upstream;
        } catch (err) {
          killChild();
          throw err;
        }
      })().finally(() => {
        starting = null;
      });
    }
    return starting;
  }

  /**
   * 把一条 `/h…` 请求反代到那台 `dsh web`。**不缓冲**（两头 `pipe`）。
   * @param {string} relPath 已经剥掉 `/h` 前缀的路径（`/`、`/api/x?y=1`…）
   */
  async function handle(req, res, relPath) {
    let up;
    try {
      up = await ensure();
    } catch (err) {
      say(`盒里那台 dsh web 没起来：${err?.message ?? err}`);
      return devUnavailable(res, 502, '那台界面现在没起来，等会儿再试。');
    }

    const headers = { ...req.headers };
    for (const h of HOP_BY_HOP) delete headers[h];
    // ★ **剥掉浏览器那份 cookie**，替它带上 DSH 自己那把（里层那把锁归壳拿着）
    delete headers.cookie;
    headers.cookie = up.cookie;
    // ★ 那道 `/api` 栅栏按**回环**放行：Host / Origin / Sec-Fetch-Site 都要改写成回环
    headers.host = `127.0.0.1:${up.port}`;
    if (headers.origin !== undefined) headers.origin = `http://127.0.0.1:${up.port}`;
    if (typeof headers.referer === 'string') {
      headers.referer = headers.referer.replace(/^https?:\/\/[^/]+/u, `http://127.0.0.1:${up.port}`);
    }
    headers['sec-fetch-site'] = 'same-origin';

    const path = typeof relPath === 'string' && relPath.startsWith('/') ? relPath : `/${relPath ?? ''}`;
    let answered = false;
    const fail = (err) => {
      if (answered) return;
      answered = true;
      say(`转给盒里那台 dsh web 失败：${err?.message ?? err}`);
      if (!res.headersSent) devUnavailable(res, 502, '刚才断了一下，等会儿再试。');
      else res.destroy();
    };

    const up_req = httpRequest(
      { host: '127.0.0.1', port: up.port, method: req.method, path, headers },
      (upRes) => {
        answered = true;
        const out = { ...upRes.headers };
        delete out['transfer-encoding'];
        // 🔴 **里层那把锁的 cookie 不许给浏览器**（壳替它拿着）
        delete out['set-cookie'];
        if (typeof out.location === 'string') {
          out.location = out.location.replace(
            new RegExp(`^https?://127\\.0\\.0\\.1:${up.port}`, 'u'),
            '',
          );
        }
        res.writeHead(upRes.statusCode ?? 502, out);
        upRes.pipe(res); // 流式（别缓冲）
      },
    );
    up_req.on('error', fail);
    req.on('error', () => {
      try {
        up_req.destroy();
      } catch {
        /* 已经没了 */
      }
    });
    req.pipe(up_req); // 请求体也流式
    return undefined;
  }

  return {
    handle,
    ensure,
    /** 现在什么状态（**不含任何秘密**；给横幅/排障用）。 */
    state() {
      return { running: Boolean(child), port: upstream?.port ?? null, ready: Boolean(upstream) };
    },
    /** 收干净（`server.close()` 之后兜底 —— 不许留孤儿）。 */
    shutdown() {
      closed = true;
      killChild();
    },
  };
}
