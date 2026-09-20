// 认证。手册 `08-SPEC.md` §15.5「鉴权九条」的落地。
//
//   1. **fail-closed**：没设口令 ⇒ 除三个公开路由外**一律 503**
//      （不是"放行"，也不是"跳到登录页"——是明确拒绝服务）
//   2. **XFF 取最后一跳**（不是第一跳）
//   3. **登录失败计数落盘**（重启不清零）
//   4. 令牌带主体标识；**撤销表独立落盘**
//   5. ⚠️ 访问别人的资源返回 **404，不是 403**（403 会泄露"它存在"这个事实）
//   6. **令牌不许放 URL**
//   7. 限速
//   8. 登录审计 `{at, result, ip}`
//   9. **公开路由只有三个**，其余全要令牌
//
// 为什么 fail-closed 是硬要求：默认放行的话，一次"忘了设口令"的部署
// 就等于把整台机器（含 shell）公开发布出去——而部署者不会察觉，
// 因为**一切看起来都在正常工作**。
//
// ⚠️ **两个文件，各有各的主人**（这条是被一个真 bug 逼出来的）：
//
//   auth.json          {secret, passwordHash}   ← **只有 CLI 写**（set-pass）
//   auth-runtime.json  {revoked, failures}      ← 跑着的服务写
//
// 为什么必须分开：原先只有一个文件，于是——
// 服务的进程在启动时读到"还没密码"，之后**每次登录失败**都会 persist 一次，
// 把它内存里那份**过期的 passwordHash: null 写回去**，
// **把 CLI 刚设的密码抹掉**。
// ⇒ 根因不是"重载不及时"，是**两个进程共用一个文件、各写各的**。
//   分开之后，**服务根本不碰 passwordHash**，所以不可能再覆盖它。

import crypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

/** 只有这三个不需要令牌。加任何一个都要问一句"它真的必须公开吗"。 */
export const PUBLIC_ROUTES = Object.freeze(['/api/version', '/api/auth', '/api/login']);

const SCRYPT_KEYLEN = 64;
const DEFAULT_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 天（决策：TTL 由 30 天延长）
const DEFAULT_LOCK_AFTER = 8;
const DEFAULT_LOCK_MS = 15 * 60 * 1000;

export class Auth {
  #dataDir;
  #fs;
  #now;
  #tokenTtlMs;
  #lockAfter;
  #lockMs;
  #secret;
  #passwordHash;
  #revoked = new Set();
  #failures = new Map(); // ip → { count, until }
  #audit = [];
  #mtime = 0;
  #lastCheck = 0;

  /**
   * @param {object} o
   * @param {string} o.dataDir
   * @param {object} [o.fs]
   * @param {() => number} [o.now]
   * @param {number} [o.tokenTtlMs]
   * @param {string|null} [o.passwordHash] 直接给（测试用）；不给则从 data/auth.json 读
   */
  constructor({ dataDir, fs = nodeFs, now = Date.now, tokenTtlMs, lockAfter, lockMs, passwordHash }) {
    this.#dataDir = dataDir;
    this.#fs = fs;
    this.#now = now;
    this.#tokenTtlMs = tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.#lockAfter = lockAfter ?? DEFAULT_LOCK_AFTER;
    this.#lockMs = lockMs ?? DEFAULT_LOCK_MS;
    this.#fs.mkdirSync(this.#dataDir, { recursive: true });
    const state = this.#load();
    this.#mtime = this.#statMtime();
    this.#lastCheck = 0;
    this.#secret = state.secret;
    this.#revoked = new Set(state.revoked ?? []);
    this.#passwordHash = passwordHash !== undefined ? passwordHash : (state.passwordHash ?? null);
    this.#failures = new Map(Object.entries(state.failures ?? {}));
  }

  // ── 状态落盘 ─────────────────────────────────────────────

  #statePath() {
    return nodePath.join(this.#dataDir, 'auth.json');
  }

  /** 易变的那部分（撤销表 / 失败计数）单独一个文件——**服务只写这个**。 */
  #runtimePath() {
    return nodePath.join(this.#dataDir, 'auth-runtime.json');
  }

  #readJson(file, { required = false } = {}) {
    try {
      const parsed = JSON.parse(this.#fs.readFileSync(file, 'utf8'));
      if (required && !parsed.secret) throw new Error('缺 secret');
      return parsed;
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      // 读到了但坏了 —— **必须抛**，不能悄悄新建一个（那会把所有人的登录态作废）
      throw new Error(`${nodePath.basename(file)} 读不了或坏了：${err.message}`);
    }
  }

  #load() {
    let state = this.#readJson(this.#statePath(), { required: true });
    if (!state) {
      // 第一次跑：生成密钥，写 auth.json（只有 CLI 与这一次会写它）
      state = { secret: crypto.randomBytes(32).toString('hex'), passwordHash: null };
      this.#writeStateFile(state);
    }
    const runtime = this.#readJson(this.#runtimePath()) ?? {};
    return {
      secret: state.secret,
      passwordHash: state.passwordHash ?? null,
      revoked: runtime.revoked ?? [],
      failures: runtime.failures ?? {},
    };
  }

  #writeStateFile(state) {
    const file = this.#statePath();
    this.#fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
    try {
      this.#fs.chmodSync?.(file, 0o600);
    } catch {
      /* 有些 fs 不支持，忽略 */
    }
    this.#mtime = this.#statMtime();
  }

  /**
   * 写运行时状态（撤销表 / 失败计数）。
   *
   * ⚠️ **撤销表是"并集"写**：CLI 可能刚在另一个进程里撤销了一个令牌，
   *    如果直接拿内存里那份覆盖，那个撤销会被**复活**。
   *    （密码不在这里——服务根本不碰它，所以不可能抹掉。）
   */
  #persistRuntime() {
    const disk = this.#readJson(this.#runtimePath()) ?? {};
    const revoked = new Set([...(disk.revoked ?? []), ...this.#revoked]);
    this.#revoked = revoked;
    this.#fs.writeFileSync(
      this.#runtimePath(),
      JSON.stringify(
        { revoked: [...revoked], failures: Object.fromEntries(this.#failures) },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }

  /**
   * 只写 `passwordHash` 那半（CLI 专用）。
   * **先读再写，保住 secret**；而且**只写这两个键**——
   * 读-改-写会把旧版本遗留的键（revoked/failures）一起带进来，
   * 那些键属于运行时文件，留在这里只会让人分不清谁归谁。
   */
  #persistPassword() {
    const prev = this.#readJson(this.#statePath(), { required: true }) ?? {};
    this.#writeStateFile({
      secret: prev.secret ?? this.#secret,
      passwordHash: this.#passwordHash,
    });
  }

  #statMtime() {
    try {
      const a = this.#fs.statSync(this.#statePath()).mtimeMs;
      let b = 0;
      try {
        b = this.#fs.statSync(this.#runtimePath()).mtimeMs;
      } catch {
        /* 还没有运行时文件 */
      }
      return a + b; // 两个都要盯
    } catch {
      return 0;
    }
  }

  /**
   * 磁盘上的鉴权状态变了吗？变了就重载。
   *
   * 为什么必须有这个：`set-pass` 是**另一个进程**在改文件，
   * 而跑着的服务在启动时就把状态读进内存了。
   * 没有这一步，改完密码**必须重启服务**才生效——
   * 那不只是麻烦：它会让人以为"设了密码但还是 503"，然后去怀疑别的地方。
   *
   * 节流到一秒一次：`needsSetup` 在**每个请求**上都会被问一次。
   */
  #maybeReload() {
    const now = this.#now();
    if (now - this.#lastCheck < 1000) return;
    this.#lastCheck = now;
    const m = this.#statMtime();
    if (m === this.#mtime) return;
    this.#mtime = m;
    const state = this.#load();
    this.#secret = state.secret;
    this.#revoked = new Set(state.revoked ?? []);
    this.#passwordHash = state.passwordHash ?? null;
    this.#failures = new Map(Object.entries(state.failures ?? {}));
  }

  // ── 口令 ────────────────────────────────────────────────

  static hashPassword(password, { salt = crypto.randomBytes(16) } = {}) {
    const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
    return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
  }

  /** **还没设口令** ⇒ 服务必须 fail-closed。 */
  get needsSetup() {
    this.#maybeReload();
    return this.#passwordHash === null;
  }

  setPassword(password) {
    const text = String(password ?? '');
    // 按**码点**数，不按 UTF-16 单元——否则一个 emoji 会被算成"两位"，
    // 而一个汉字只算一位。（长度是策略，但数错就是数错。）
    const len = [...text].length;
    if (len < 6) {
      throw new Error(`口令太短（至少 6 位，现在 ${len} 位）`);
    }
    this.#passwordHash = Auth.hashPassword(text);
    this.#persistPassword(); // ← 只写密码那半。**绝不碰运行时文件**
  }

  verifyPassword(password) {
    this.#maybeReload();
    if (this.needsSetup) return false;
    const [, saltHex, hashHex] = this.#passwordHash.split('$');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  // ── 登录失败计数（**落盘**，重启不清零）─────────────────

  isLocked(ip) {
    const rec = this.#failures.get(ip);
    if (!rec) return false;
    if (rec.until && rec.until > this.#now()) return true;
    if (rec.until && rec.until <= this.#now()) {
      this.#failures.delete(ip);
      this.#persistRuntime();
    }
    return false;
  }

  lockRemainingMs(ip) {
    const rec = this.#failures.get(ip);
    if (!rec?.until) return 0;
    return Math.max(0, rec.until - this.#now());
  }

  recordLoginFailure(ip) {
    const rec = this.#failures.get(ip) ?? { count: 0, until: 0 };
    rec.count += 1;
    if (rec.count >= this.#lockAfter) {
      rec.until = this.#now() + this.#lockMs;
      rec.count = 0;
    }
    this.#failures.set(ip, rec);
    this.#persistRuntime();
    this.#log({ result: 'fail', ip });
    return this.isLocked(ip);
  }

  recordLoginSuccess(ip) {
    this.#failures.delete(ip);
    this.#persistRuntime();
    this.#log({ result: 'ok', ip });
  }

  // ── 令牌 ────────────────────────────────────────────────

  #b64(buf) {
    return Buffer.from(buf).toString('base64url');
  }

  #sign(payloadB64) {
    return crypto.createHmac('sha256', this.#secret).update(payloadB64).digest('base64url');
  }

  issue({ sub = 'owner' } = {}) {
    if (this.needsSetup) throw new Error('还没设口令，不许发令牌');
    const payload = { sub, iat: this.#now(), exp: this.#now() + this.#tokenTtlMs, jti: crypto.randomUUID() };
    const body = this.#b64(JSON.stringify(payload));
    return { token: `${body}.${this.#sign(body)}`, expiresAt: payload.exp, sub };
  }

  /** @returns {{sub: string, exp: number, jti: string}|null} */
  verify(token) {
    // ⚠️ fail-closed：没设口令时**任何令牌都不认**
    if (this.needsSetup) return null;
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expect = this.#sign(body);
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (typeof payload.exp !== 'number' || payload.exp <= this.#now()) return null;
    if (this.#revoked.has(payload.jti)) return null;
    return payload;
  }

  revoke(token) {
    const payload = this.verify(token);
    if (!payload) return false;
    this.#revoked.add(payload.jti);
    this.#persistRuntime();
    return true;
  }

  // ── 审计 ────────────────────────────────────────────────

  #log(entry) {
    this.#audit.push({ at: this.#now(), ...entry });
  }

  /** 登录审计（`{at, result, ip}`）。只记事实——**不记口令、不记令牌**。 */
  get auditLog() {
    return [...this.#audit];
  }
}

/**
 * 客户端 IP：**取 XFF 的最后一跳**。
 *
 * ⚠️ 取第一跳是错的：那是客户端可以随手伪造的头，
 * 于是"按 IP 限速/锁号"会被一个 HTTP 头绕过去。
 * 最后一跳是**离我们最近的那个代理**填的，只有它能改。
 */
export function clientIp(req, { trustProxy = true } = {}) {
  if (trustProxy) {
    const xff = req.headers?.['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim() !== '') {
      const hops = xff.split(',').map((s) => s.trim()).filter(Boolean);
      if (hops.length > 0) return hops.at(-1);
    }
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

/** 从 Authorization 头取令牌。**绝不从 URL 取**（第 6 条）。 */
export function tokenFromRequest(req) {
  const h = req.headers?.authorization;
  if (typeof h === 'string' && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  return null;
}
