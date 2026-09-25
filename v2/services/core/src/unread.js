// **未读**（契约 `docs/dev/100-DISPATCHER-D.md` §二② · 判据 **D-6**）。
//
// 手册 `02-ARCHITECTURE.md` §3.5 三件配套里的第 ② 件：
//
//   > **未读标记**（桌面上 A 的图标带小点）——"**动作可静默，事实不能静默**"
//   > 最轻的落实。
//
// 这一期做的是**服务端那半**（客户端那个点由客户端做）：**能查、能清、落盘**。
//
// ── 怎么算"有未读"（口径只有这一处）──────────────────────────
//   · 日志是**一条**（P-l），每个 scope 只是事件上的标签 ⇒ "那一间到哪了"
//     就是**盘上那一间最后一条事件的 `seq`**；
//   · 用户**打开过那一间**（连流 / 切焦点 / 明确上报"看过了"）⇒ 记下那一刻的 `seq`；
//   · `最后一条的 seq > 记下的那个 seq` ⇒ **有未读**。
//
//   ⚠️ **不许用"上次看的时间"**：`at` 是各事件自己带的钟，而排序权威是 `seq`
//      （`timeline.js` 顶上那条）。拿时间比会在钟歪掉时静默说错话。
//
//   ⚠️ **没有事件的 scope 一律不算**（新开的空房间不该带点）——
//      这是"动作可静默"那半：没有东西可看的时候不要吵他。
//
// ── 🔴 挂在哪一间（§6.2）──────────────────────────────────────
//   转交续写的事件 `scopeId` 打**发起那一间**（可见那一间）⇒ 未读点自然也挂在
//   那一间的图标上（他回到 A 就看到整条答案）。**不许**挂到干活者那一间。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { eventInScope } from './timeline.js';
import { MAIN_SCOPE } from './worlds.js';

/** 这一格存哪（**跟人走**）。 */
export function unreadPath(dir) {
  return nodePath.join(dir, 'unread.json');
}

/**
 * 盘上那条日志里**每一间**最后一条事件的号（纯函数 · 判据的正身）。
 * @param {Array<object>} events 一条日志的全量（`store.readAll('main')`）
 * @returns {Map<string, number>} scope → 最大 `seq`
 */
export function maxSeqByScope(events) {
  const out = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e.seq !== 'number') continue;
    // 认法是**唯一那一处**（`timeline.eventInScope`）——别处不许再写一份
    for (const scope of scopeKeysOf(e)) {
      const had = out.get(scope);
      if (had === undefined || e.seq > had) out.set(scope, e.seq);
    }
  }
  return out;
}

/**
 * 这条事件算在哪些 scope 头上。
 * ⚠️ 主线那一条**同时**算 `main` 这一间（盘上老事件没有 `scopeId` 字段 ⇒
 *    "没有标签"就是主线）—— 不然"主对话"那个图标永远不会有点。
 */
function scopeKeysOf(event) {
  const tag = event?.scopeId;
  if (tag === undefined || tag === null || tag === '') return [MAIN_SCOPE];
  return [String(tag)];
}

/**
 * 某一间**有没有未读**（纯函数：`events` + `lastRead` 进，布尔出）。
 *
 * @param {object} o
 * @param {Array<object>} o.events 那条日志的全量
 * @param {Record<string, number>} [o.lastRead] `scope → 他看到过的最大号`
 * @param {string} o.scope
 * @returns {{unread: boolean, lastSeq: number, lastReadSeq: number}}
 */
export function scopeUnread({ events, lastRead = {}, scope } = {}) {
  const key = typeof scope === 'string' && scope !== '' ? scope : MAIN_SCOPE;
  let lastSeq = 0;
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e.seq !== 'number') continue;
    if (!eventInScope(e, key)) continue;
    if (e.seq > lastSeq) lastSeq = e.seq;
  }
  const seen = lastRead?.[key];
  const lastReadSeq = typeof seen === 'number' && Number.isFinite(seen) ? seen : 0;
  // 没有事件的 scope 不算未读（空房间不带点）
  return { unread: lastSeq > 0 && lastSeq > lastReadSeq, lastSeq, lastReadSeq };
}

/**
 * **未读那本账**（`scope → 他看到过的最大号` · 一个人一份 · 落盘）。
 *
 * ⚠️ 它**不另起日志**：事实（哪一间到哪了）在**那条日志**上，这里只记
 *    "他看到了哪一号"。所以它很小，而且与 `main.jsonl` 不可能对不上。
 */
export class UnreadBook {
  #dir;
  #file;
  #log;
  #store;
  #timelineId;
  #lastRead = Object.create(null);

  /**
   * @param {object} o
   * @param {string} o.dir
   * @param {import('./store.js').Store} o.store
   * @param {string} [o.timelineId] 那条日志的 id（默认 `main`）
   */
  constructor({ dir, store, timelineId = 'main', log = () => {} } = {}) {
    if (!dir) throw new Error('UnreadBook 需要 dir');
    if (!store) throw new Error('UnreadBook 需要 store（事实在那条日志上）');
    this.#dir = dir;
    this.#log = log;
    this.#store = store;
    this.#timelineId = timelineId;
    this.#file = unreadPath(dir);
    this.#load();
  }

  get path() {
    return this.#file;
  }

  #load() {
    try {
      const raw = nodeFs.readFileSync(this.#file, 'utf8');
      const obj = JSON.parse(raw);
      const t = obj?.lastRead;
      if (t && typeof t === 'object') {
        for (const [k, v] of Object.entries(t)) {
          if (typeof v === 'number' && Number.isFinite(v)) this.#lastRead[k] = v;
        }
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') this.#log(`未读那本账没读出来：${err?.message ?? err}`);
    }
  }

  #save() {
    const tmp = `${this.#file}.tmp`;
    try {
      nodeFs.mkdirSync(this.#dir, { recursive: true });
      nodeFs.writeFileSync(tmp, `${JSON.stringify({ v: 1, lastRead: this.#lastRead })}\n`);
      nodeFs.renameSync(tmp, this.#file);
    } catch (err) {
      // 旁路：存不下去不许把用户那一轮带走（下一次上报会再写一遍）
      this.#log(`未读那本账没存下去：${err?.message ?? err}`);
    }
  }

  /** 那条日志的全量（读盘 —— 重启之后事实还在）。 */
  events() {
    try {
      return this.#store.readAll(this.#timelineId);
    } catch (err) {
      this.#log(`未读：日志没读出来（${err?.message ?? err}）`);
      return [];
    }
  }

  /** 记下**他看到过哪一号**（`seq` 缺省 = 现在这一间最后一条）。 */
  markRead(scope, seq = null) {
    const key = typeof scope === 'string' && scope !== '' ? scope : MAIN_SCOPE;
    let n = seq;
    if (!Number.isFinite(n)) {
      n = maxSeqByScope(this.events()).get(key) ?? 0;
    }
    this.#lastRead[key] = Math.max(this.#lastRead[key] ?? 0, Number(n));
    this.#save();
    return this.#lastRead[key];
  }

  /** 这一间有没有未读（**D-6 的正面判据**）。 */
  unreadOf(scope) {
    return scopeUnread({ events: this.events(), lastRead: this.#lastRead, scope });
  }

  /**
   * **哪些图标该带点**（一次算全 —— 服务端答得出"有未读"）。
   * @returns {Array<{scopeId: string, lastSeq: number, lastReadSeq: number}>}
   */
  list() {
    const events = this.events();
    const out = [];
    for (const [scope, lastSeq] of maxSeqByScope(events)) {
      const r = scopeUnread({ events, lastRead: this.#lastRead, scope });
      if (r.unread) out.push({ scopeId: scope, lastSeq, lastReadSeq: r.lastReadSeq });
    }
    return out;
  }

  /** 盘上那份（判据 / 排障用）。 */
  raw() {
    return { v: 1, lastRead: { ...this.#lastRead } };
  }
}
