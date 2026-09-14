// 鉴权：**这台机器上跑着一个能执行命令、能动自己代码的 agent，不能谁都能指挥它。**
//
// 设计取舍（每一条都是为了让"公开暴露"这条路走不通，同时不给自己添麻烦）：
//
//   1. **口令不落明文。** 存 scrypt 哈希（Node 自带，不引依赖）。
//   2. **会话令牌是签名过的、无状态的。** 格式 `payload.signature`，HMAC-SHA256。
//      为什么不用"服务端存一张会话表"：那样每次重启服务所有人都会被登出，
//      而这个服务本来就会因为改代码而反复重启 —— 用户会以为鉴权坏了。
//   3. **密钥持久化**（`data/auth.json`，0600），重启不换密钥。
//   4. **HTTP 用 Authorization 头，WebSocket 用子协议**。
//      ⚠ 令牌**绝不能**放 URL 查询串 —— 那会被 nginx 原样写进 access.log，
//       等于把钥匙挂在门口（这条是硬规则，不是偏好）。
//   5. 登录接口**限速**：它在公网上，不限速就是一个可以被爆的口令框。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCRYPT_KEYLEN = 64;
const TOKEN_VERSION = 1;

/** 口令强度要求：这台机器上跑着 root 级权限的 agent，弱口令等于没有口令。 */
export function passwordProblem(password) {
  const pw = String(password ?? '');
  if (pw.length < 12) return '口令至少 12 位';
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw)) {
    return '口令要同时含大写、小写、数字';
  }
  return null;
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

export class Auth {
  /**
   * @param {string} dataDir 密钥与口令哈希存这里
   * @param {{ sessionTtlMs?: number, enabled?: boolean }} [opts]
   */
  constructor(dataDir, { sessionTtlMs = 30 * 24 * 60 * 60 * 1000, enabled = true } = {}) {
    this.file = path.join(dataDir, 'auth.json');
    this.sessionTtlMs = sessionTtlMs;
    /** 关掉之后所有校验都放行 —— 只在本地开发用，**默认开**。 */
    this.enabled = enabled !== false;
    /** 登录失败计数（IP → {count, until}），公网上的登录框必须限速。 */
    this._fails = new Map();
    this._state = this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw?.secret && raw?.password) return raw;
    } catch {
      /* 还没有，下面生成 */
    }
    const fresh = {
      version: TOKEN_VERSION,
      secret: crypto.randomBytes(32).toString('base64url'),
      password: null, // { salt, hash }
      createdAt: new Date().toISOString(),
    };
    this._write(fresh);
    return fresh;
  }

  _write(state = this._state) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // 0600：只有本用户能读。密钥泄漏 = 谁都能签一个合法令牌。
    fs.writeFileSync(this.file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* 有些文件系统不支持，忽略 */
    }
  }

  /** 设了口令没有（没设的话鉴权等于没开，必须让服务启动时能喊出来）。 */
  get hasPassword() {
    return Boolean(this._state.password);
  }

  /** 鉴权是不是**真的在生效**（开着 + 设了口令）。 */
  get active() {
    return this.enabled && this.hasPassword;
  }

  setPassword(password) {
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
    const salt = crypto.randomBytes(16).toString('base64url');
    const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('base64url');
    this._state.password = { salt, hash, setAt: new Date().toISOString() };
    this._write();
    return true;
  }

  verifyPassword(password) {
    const p = this._state.password;
    if (!p) return false;
    const hash = crypto.scryptSync(String(password ?? ''), p.salt, SCRYPT_KEYLEN);
    const want = unb64u(p.hash);
    // 长度不同时 timingSafeEqual 会抛，先挡掉
    if (hash.length !== want.length) return false;
    return crypto.timingSafeEqual(hash, want);
  }

  /** 签一个会话令牌。 */
  issueToken({ now = Date.now() } = {}) {
    const payload = { v: TOKEN_VERSION, exp: now + this.sessionTtlMs, jti: crypto.randomBytes(8).toString('base64url') };
    const body = b64u(JSON.stringify(payload));
    const sig = b64u(crypto.createHmac('sha256', this._state.secret).update(body).digest());
    return `${body}.${sig}`;
  }

  /** 校验令牌。返回 payload（有效）或 null（无效/过期/签名不对）。 */
  verifyToken(token, { now = Date.now() } = {}) {
    if (typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expect = crypto.createHmac('sha256', this._state.secret).update(body).digest();
    let given;
    try {
      given = unb64u(sig);
    } catch {
      return null;
    }
    if (given.length !== expect.length) return null;
    if (!crypto.timingSafeEqual(given, expect)) return null;
    let payload;
    try {
      payload = JSON.parse(unb64u(body).toString('utf8'));
    } catch {
      return null;
    }
    if (payload?.v !== TOKEN_VERSION) return null;
    if (typeof payload.exp !== 'number' || payload.exp < now) return null;
    return payload;
  }

  // ── 登录限速 ──────────────────────────────────────────────
  // 公网上的登录框不限速就是给人爆的。按 IP 记失败次数，超了就锁一会儿。

  canAttempt(ip) {
    const rec = this._fails.get(ip);
    if (!rec) return true;
    if (rec.until && rec.until > Date.now()) return false;
    return true;
  }

  noteFailure(ip, { max = 5, lockMs = 15 * 60 * 1000 } = {}) {
    const rec = this._fails.get(ip) ?? { count: 0, until: 0 };
    rec.count += 1;
    if (rec.count >= max) {
      rec.until = Date.now() + lockMs;
      rec.count = 0;
    }
    this._fails.set(ip, rec);
    return { locked: Boolean(rec.until > Date.now()), lockMs };
  }

  noteSuccess(ip) {
    this._fails.delete(ip);
  }

  /** 还要等多久才能再试（毫秒）。 */
  retryAfterMs(ip) {
    const rec = this._fails.get(ip);
    if (!rec?.until) return 0;
    return Math.max(0, rec.until - Date.now());
  }
}

/**
 * 从 HTTP 请求里取令牌。
 *
 * ⚠ 只认两种地方：`Authorization: Bearer`（HTTP）和 WebSocket 子协议。
 * **刻意不看 URL 查询串** —— 那会被 nginx 写进 access.log。
 */
export function tokenFromRequest(req) {
  const h = req.headers?.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim();

  // WebSocket：浏览器不能设自定义头，所以把令牌塞进子协议里（不进日志）
  const proto = req.headers?.['sec-websocket-protocol'];
  if (typeof proto === 'string') {
    const parts = proto.split(',').map((s) => s.trim());
    const i = parts.indexOf('bearer');
    if (i >= 0 && parts[i + 1]) return parts[i + 1];
  }
  return null;
}

/** WebSocket 握手时要回的那个子协议名。 */
export const WS_AUTH_PROTOCOL = 'bearer';
