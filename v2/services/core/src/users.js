// **用户表**：手机号 → 用户身份（多租户的第一步 · 契约 `docs/dev/37-MULTITENANT.md` §三）。
//
// ── 它负责什么 ────────────────────────────────────────────
//   ① 手机号 = 账号。第一次见到的号**当场建一个用户**（主人 2026-09-21 的说法：
//      "新手机号它就会新开一台容器"）；
//   ② 给每个用户一个**稳定的 id** —— 令牌里的 `sub` 用它，将来容器/目录也用它。
//
// ── 四条不许破 ────────────────────────────────────────────
//   ① 🔴 **手机号是个人信息**：这个文件**0600**、落在 `data/`（`.gitignore` 里）、
//      **绝不进仓库、绝不进日志**；
//   ② **写盘原子**：先写 `.tmp` 再 `rename`（断电只会看到"旧的"或"新的"）；
//   ③ **失败上抛**，不吞（同 `store.js` 那条规矩：吞掉就等于悄悄丢账号）；
//   ④ **id 不重复、不复用**：删了账号也不把号让给别人。
//
// ⚠️ 它**不是**认证：认证在 `auth.js`（令牌）。这里只管"这个号是谁"。

import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

/** 手机号长什么样：只收**中国大陆手机号**（11 位、1 开头、第二位 3-9）。 */
export function normalizePhone(raw) {
  const s = typeof raw === 'string' ? raw.replace(/[\s-]/g, '') : '';
  return /^1[3-9]\d{9}$/.test(s) ? s : null;
}

export class Users {
  #file;
  #fs;
  /** phone → {id, createdAt} */
  #byPhone = new Map();
  #next = 1;

  constructor({ dataDir, fs = nodeFs }) {
    if (!dataDir) throw new Error('dataDir 必填');
    this.#fs = fs;
    this.#file = nodePath.join(dataDir, 'users.json');
    this.#load();
  }

  get path() {
    return this.#file;
  }

  /** 一共有几个用户（横幅要如实报这个数）。 */
  get size() {
    return this.#byPhone.size;
  }

  #load() {
    let text;
    try {
      text = this.#fs.readFileSync(this.#file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return; // 还没有用户 = 正常的第一次
      throw err; // 别的读失败要上抛（吞了就等于把用户弄丢）
    }
    const j = JSON.parse(text);
    for (const [phone, rec] of Object.entries(j?.users ?? {})) {
      this.#byPhone.set(phone, rec);
      // 下一个号接着最大的那个，**不复用**（删过号的也不还回去）
      const n = Number.parseInt(String(rec?.id ?? '').replace(/^u/, ''), 10);
      if (Number.isFinite(n) && n >= this.#next) this.#next = n + 1;
    }
  }

  #save() {
    const users = {};
    for (const [phone, rec] of this.#byPhone) users[phone] = rec;
    const text = `${JSON.stringify({ version: 1, users }, null, 2)}\n`;
    const tmp = `${this.#file}.tmp`;
    this.#fs.writeFileSync(tmp, text, { mode: 0o600 });
    this.#fs.renameSync(tmp, this.#file); // 原子
    try {
      this.#fs.chmodSync(this.#file, 0o600); // ⚠️ 里面有手机号
    } catch { /* 尽力 */ }
  }

  /** 这个号是谁；没有就 `null`（**不建**）。 */
  get(phone) {
    const p = normalizePhone(phone);
    return p ? (this.#byPhone.get(p) ?? null) : null;
  }

  /**
   * **见到就建**（主人 2026-09-21：新手机号 ⇒ 新开一台容器）。
   *
   * @returns {{id:string, createdAt:number, created:boolean}}
   */
  ensure(phone, { now = Date.now, newId = null } = {}) {
    const p = normalizePhone(phone);
    if (!p) throw new Error('手机号不像手机号');
    const had = this.#byPhone.get(p);
    if (had) return { ...had, created: false };
    const id = newId ?? `u${this.#next}`;
    this.#next += 1;
    const rec = { id, createdAt: now() };
    this.#byPhone.set(p, rec);
    this.#save();
    return { ...rec, created: true };
  }
}

/** 给人看的脱敏手机号（**日志/横幅里只许出现这个形态**）。 */
export function maskPhone(phone) {
  const p = normalizePhone(phone);
  return p ? `${p.slice(0, 3)}****${p.slice(7)}` : '（不是手机号）';
}

/** 一个稳定的用户 id（测试用；生产走 `ensure` 的自增）。 */
export function userIdFromPhone(phone) {
  const p = normalizePhone(phone) ?? String(phone ?? '');
  return `u_${nodeCrypto.createHash('sha256').update(p).digest('hex').slice(0, 12)}`;
}
