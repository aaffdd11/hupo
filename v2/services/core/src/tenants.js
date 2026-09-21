// **一人一份世界**：按 userId 取那一份数据（多租户第二步 · 契约 `docs/dev/37-MULTITENANT.md` §三/§四）。
//
// ── 它解决什么 ────────────────────────────────────────────
// 在这之前，整个服务是**单实例**搭的：一条 `data/main.jsonl`、一个账本、一个回收站
// ⇒ **谁登录进来都读到同一份**（主人 2026-09-21 实测指出的问题：
//   "应该进去又是一个独立的 copy 啊，应该是一个空白的"）。
//
// 这一层把"哪一份"变成**按 userId 取**：
//
//     owner  → `data/`            （**主人现有那份，原地不动** —— 不许搬家）
//     别人   → `data/users/<uid>/` （**全新的、空白的**）
//
// ── 四条不许破 ────────────────────────────────────────────
//   ① 🔴 **不许有"当前用户"全局**：身份**只能靠参数传**（一次 `await` 就是串号）；
//   ② 🔴 **`owner` 那份原地不动**：主人已有的对话不许因为这次改造而搬家或消失；
//   ③ **一个新用户拿到的是空白的**：目录不存在就是空的，**不许去"继承"任何东西**；
//   ④ **userId 进目录名之前必须校验**（`..` / `/` 那类会跑出根外 —— 这是路径穿越）。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { Store } from './store.js';
import { Timeline } from './timeline.js';

/** 一个人的 id 长什么样。**进目录名之前一定要过这一关**（防路径穿越）。 */
export function safeUserId(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null;
}

/** `owner` 是**第一个用户**（主人自己）：他的数据在 `data/` 根下，不搬。 */
export const OWNER_ID = 'owner';

export class Tenants {
  #root;
  #fs;
  #makeStore;
  #makeTimeline;
  /** userId → {userId, dir, store, timeline} —— **同一个用户两次拿到的是同一份** */
  #cache = new Map();

  /**
   * @param {object} o
   * @param {string} o.dataDir           根数据目录
   * @param {object} [o.fs]
   * @param {(o:{dataDir:string,fsync:boolean}) => Store} [o.makeStore]
   * @param {(o:{id:string, store:Store}) => Timeline} [o.makeTimeline]
   */
  constructor({ dataDir, fs = nodeFs, makeStore = null, makeTimeline = null }) {
    if (!dataDir) throw new Error('dataDir 必填');
    this.#root = dataDir;
    this.#fs = fs;
    this.#makeStore = makeStore ?? ((o) => new Store({ ...o, fs }));
    this.#makeTimeline = makeTimeline ?? ((o) => new Timeline(o));
  }

  get root() {
    return this.#root;
  }

  /** 已经取过几个人。 */
  get size() {
    return this.#cache.size;
  }

  /**
   * 这个人的数据在哪。
   * ⚠️ `owner` = 根目录（**原地不动**）；别人 = 根下面自己的一格。
   */
  dirFor(userId) {
    const id = safeUserId(userId);
    if (!id) throw new Error(`userId 不能当目录名：${JSON.stringify(userId)}`);
    return id === OWNER_ID ? this.#root : nodePath.join(this.#root, 'users', id);
  }

  /**
   * **取**这个人的世界（没有就在内存里建一个；目录按需要创建）。
   * ⚠️ 新用户拿到的是**空白** —— 这里**不会**去读任何别人的东西。
   *
   * @returns {{userId:string, dir:string, fresh:boolean, store:Store, timeline:Timeline}}
   */
  get(userId) {
    const id = safeUserId(userId);
    if (!id) throw new Error(`userId 不能当目录名：${JSON.stringify(userId)}`);
    const had = this.#cache.get(id);
    if (had) return had;

    const dir = this.dirFor(id);
    let fresh = false;
    if (id !== OWNER_ID && !this.#fs.existsSync(dir)) {
      this.#fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); // 别人的东西别人读
      fresh = true; // ★ 他**第一次**来 ⇒ 这一份是全新的
    }
    const store = this.#makeStore({ dataDir: dir, fsync: true });
    // ⚠️ 时间线 id 仍然是 `main`：**一人一份目录**已经把两个人分开了，
    //    再在 id 上加用户，只会让"哪条日志是哪条时间线"变得难查。
    const timeline = this.#makeTimeline({ id: 'main', store });
    const world = { userId: id, dir, fresh, store, timeline };
    this.#cache.set(id, world);
    return world;
  }

  /** 已经开始的那些人的 id（给横幅/清理用）。 */
  ids() {
    return [...this.#cache.keys()];
  }

  /** 把某个人的世界从内存里丢掉（**不删盘上的东西**）。 */
  forget(userId) {
    const id = safeUserId(userId);
    return id ? this.#cache.delete(id) : false;
  }
}

// ════════════════════════════════════════════════════════════════════════
// **租户命名模板**（契约 `docs/dev/43-AUTO-PROVISION.md` §三 A2）
//
// 🔴 这一段的全部意义：**"自动开一台"时，服务侧与特权侧必须推出逐字相同的名字。**
//    服务侧（这里）要知道租户名才能提前去听通道；特权侧（root 的 shell）
//    要知道用户名/uid/home 才能真把人建出来。**两处各写一份常数 = 一定会漂。**
//    ⇒ 数字住在 `tenant-template.conf`，两边都读它。
//
// ⚠️ 职责边界：这里**只算名字**，**一行特权都不碰**（建人/建卷/起容器全在 shell 那侧）。
// ════════════════════════════════════════════════════════════════════════

/** 模板文件（**唯一权威**）。 */
export const TENANT_TEMPLATE_FILE = 'tenant-template.conf';

/**
 * 文件缺失/读不到时的样子：**自动开一台那条路关着**。
 *
 * ⚠️ 这里**不猜默认值**：猜出来的名字与 shell 那侧可能不一致，
 *    而那种不一致的表现是"容器起来了、服务却在听另一个通道"——
 *    看起来像"容器没起来"。⇒ 宁可这条路关着，并且**如实说**。
 */
export const NO_TENANT_TEMPLATE = Object.freeze({
  namePrefix: '',
  uidBase: 0,
  maxTenants: 0,
  ok: false,
});

/** 只认这三个键。多一个都算错（防"悄悄加旋钮"）。 */
const TEMPLATE_KEYS = Object.freeze(['name_prefix', 'uid_base', 'max_tenants']);

/**
 * 解析模板文本。**纯函数**（逐档钉在 `test/unit`）。
 * @param {string} text
 * @returns {{namePrefix:string, uidBase:number, maxTenants:number, ok:boolean}}
 */
export function parseTenantTemplate(text) {
  const out = { namePrefix: '', uidBase: 0, maxTenants: 0, ok: false };
  const seen = new Set();
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) throw new Error(`租户模板这一行看不懂：${line}`);
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (!TEMPLATE_KEYS.includes(key)) {
      // 🔴 **多一个键就是错**：不然别人往这儿加一个"想想的旋钮"，
      //    而 shell 那侧根本不认它 ⇒ 两边又漂了，而且看不出来。
      throw new Error(`租户模板里有不认识的键：${key}`);
    }
    if (seen.has(key)) throw new Error(`租户模板里 ${key} 写了两遍`);
    seen.add(key);
    if (key === 'name_prefix') {
      if (!/^[a-z][a-z0-9-]{0,16}$/.test(value)) throw new Error(`name_prefix 不合法：${value}`);
      out.namePrefix = value;
    } else {
      const n = Number.parseInt(value, 10);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${key} 不合法：${value}`);
      if (key === 'uid_base') out.uidBase = n;
      else out.maxTenants = n;
    }
  }
  out.ok =
    out.namePrefix !== '' &&
    out.uidBase > 0 &&
    out.maxTenants > 0 &&
    seen.has('name_prefix') &&
    seen.has('uid_base') &&
    seen.has('max_tenants');
  return out;
}

/**
 * 读模板。**读不到就返回"这条路关着"**（不抛）——
 * 因为它是"自动开一台"这个**附加**能力，不该把主人的服务挡在门外。
 * ⚠️ 但**内容写错**要抛：那是代码/配置错误，不是"缺个功能"。
 */
export function readTenantTemplate({ fs = nodeFs, file = null } = {}) {
  const path = file ?? nodePath.join(import.meta.dirname, '..', TENANT_TEMPLATE_FILE);
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch {
    return { ...NO_TENANT_TEMPLATE };
  }
  return parseTenantTemplate(text);
}

/**
 * `u<N>` → `N`。**认不出就是 `null`**（`owner` / `u0` / `u-1` / `u01` / `u99999` 都认不出）。
 * ⚠️ 用户 id 是 `users.js` 发的（`u1`、`u2`… **不复用**），所以这个正则只管"长得像不像"。
 */
export function userIdNumber(userId) {
  const m = /^u([1-9][0-9]{0,2})$/.exec(typeof userId === 'string' ? userId.trim() : '');
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * `u<N>` → 租户名（`hupo-t<N>`）。**纯函数**。
 * 超出上限 ⇒ `null`（**不许**推出一个"上限外"的名字 —— 见 A4）。
 * ⚠️ 静态表里的那两台（`u1→hupo-a`）**不走这里**：`tenantOf()` 里**表优先**。
 */
export function tenantNameFor(userId, tpl) {
  const t = tpl ?? NO_TENANT_TEMPLATE;
  const n = userIdNumber(userId);
  if (!t?.ok || n === null || n > t.maxTenants) return null;
  return `${t.namePrefix}${n}`;
}

/** `u<N>` → 他那个 OS 用户的 uid（特权侧必须推出同一个数）。**纯函数**。 */
export function tenantUidFor(userId, tpl) {
  const t = tpl ?? NO_TENANT_TEMPLATE;
  const n = userIdNumber(userId);
  if (!t?.ok || n === null || n > t.maxTenants) return null;
  return t.uidBase + n;
}

/**
 * 这个号**该不该**去申请一台。
 * @returns {'local'|'mapped'|'provisionable'|'full'|'unknown'}
 */
export function tenancyFor(userId, { map = null, tpl = NO_TENANT_TEMPLATE } = {}) {
  if (userId === OWNER_ID) return 'local';
  if (map && map.has(userId)) return 'mapped';
  const n = userIdNumber(userId);
  if (n === null) return 'unknown';
  if (n > (tpl?.maxTenants ?? 0)) return 'full';
  return tpl?.ok ? 'provisionable' : 'full';
}
