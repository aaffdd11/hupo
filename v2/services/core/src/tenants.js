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
