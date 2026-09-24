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

  /**
   * 已经登记过的**用户 id**（去重）。
   *
   * ⚠️ 用途只有一个：**开机把每个人的世界都热一遍**（对账 / 回收站 / 崩溃环都按人算，
   *    见 `worlds.js`）。**不要**拿它当"在线用户"——这里没有在线这个概念。
   * ⚠️ 一个 id 可能被两个号绑（正常：一个主人身份），所以要**去重**。
   */
  ids() {
    const out = [];
    for (const rec of this.#byPhone.values()) {
      const id = rec?.id;
      if (typeof id === 'string' && id.length > 0 && !out.includes(id)) out.push(id);
    }
    return out;
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

  /**
   * **绑**：把这个号的身份定成 `id`（幂等）。见 `bindPhone` 的说明。
   * ⚠️ 一个 `id` 不许被两个号占用（否则"谁是谁"就没有意义了）。
   */
  bind(phone, id, { now = Date.now } = {}) {
    const p = normalizePhone(phone);
    if (!p) throw new Error('手机号不像手机号');
    if (typeof id !== 'string' || id === '') throw new Error('id 必填');
    const had = this.#byPhone.get(p);
    if (had?.id === id) return { ...had, changed: false };
    for (const [other, rec] of this.#byPhone) {
      if (other !== p && rec.id === id) throw new Error(`id ${id} 已经被另一个手机号占着`);
    }
    // ⚠️ **重新绑定时要保住 `dev`**（开发者模式那个开关，契约 `docs/dev/82-DEV-MODE.md` §三）：
    //    丢了它 = 主人一绑号就把某个人的开发者入口**静默关掉**。
    const rec = {
      id,
      createdAt: had?.createdAt ?? now(),
      ...(had?.dev === true ? { dev: true } : {}),
    };
    this.#byPhone.set(p, rec);
    this.#save();
    return { ...rec, changed: true };
  }

  /** **删一个号**（只给清理与注销用）。返回删掉没有。 */
  /**
   * `id → 手机号`（反查）。
   *
   * ⚠️ 为什么需要：注销那一条路上，我们手上只有令牌里的 `sub`（= 用户 id），
   *    而要删的是"那个手机号那一行"。**不许反过来拿 id 去扫全表猜**。
   * @returns {string|null}
   */
  phoneOf(id) {
    for (const [phone, rec] of this.#byPhone) {
      if (rec?.id === id) return phone;
    }
    return null;
  }

  /**
   * **这个用户是不是开发者**（契约 `docs/dev/82-DEV-MODE.md` §三）。
   *
   * 🔴 **调用方必须每个请求现查**，不许在启动时查一次存起来 ——
   *    "开关一关就当场进不去"（判据 D4）全靠这一条。
   * ⚠️ 内存里查（`setDev` 写的是同一份），所以同进程翻开关**当场生效**。
   *
   * @param {string} id 用户 id（令牌里的 `sub`）
   * @returns {boolean}
   */
  isDev(id) {
    if (typeof id !== 'string' || id === '') return false;
    for (const rec of this.#byPhone.values()) {
      if (rec?.id === id) return rec.dev === true;
    }
    return false;
  }

  /**
   * **翻开发者开关**（只有主人能调 —— 那是 `server.js` 那道闸的事）。
   *
   * 写盘照本文件现有那套（先 `.tmp` 再 `rename`，`0600`）：**要么看到旧的、要么看到新的**。
   * ⚠️ 关掉时是**删掉那个字段**（不是写 `dev:false`）—— 记录形状与"没标过"逐字一致，
   *    下一个人不用去猜两种"没开"有什么区别。
   *
   * @param {string} phone
   * @param {boolean} on
   * @returns {{ok:boolean, why?:string, id?:string, changed?:boolean, on?:boolean}}
   */
  setDev(phone, on) {
    const p = normalizePhone(phone);
    if (!p) return { ok: false, why: 'bad-phone' };
    const rec = this.#byPhone.get(p);
    if (!rec) return { ok: false, why: 'no-user' };
    const want = on === true;
    const had = rec.dev === true;
    if (want === had) return { ok: true, id: rec.id, changed: false, on: want };
    if (want) rec.dev = true;
    else delete rec.dev;
    this.#save();
    return { ok: true, id: rec.id, changed: true, on: want };
  }

  /** 按**用户 id** 删（注销用）。@returns {boolean} 真删掉了才 true */
  removeById(id) {
    const phone = this.phoneOf(id);
    return phone ? this.remove(phone) : false;
  }

  remove(phone) {
    const p = normalizePhone(phone);
    if (!p || !this.#byPhone.has(p)) return false;
    this.#byPhone.delete(p);
    this.#save();
    return true;
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

/**
 * 把一个手机号**绑到指定的用户 id**（幂等）。
 *
 * ⚠️ 它的用途只有一个：**把主人自己那个号绑到原来那个账号**（`owner`）。
 *    没有它的话，"先用口令登录过的那份数据"与"后来用手机号进来的那个人"
 *    会是**两个身份** —— 而今天数据还没按用户分，看起来一样，**将来一分就分家**。
 */
export function bindPhone(users, phone, id, { now = Date.now } = {}) {
  return users.bind(phone, id, { now });
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
