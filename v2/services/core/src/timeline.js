// 可见时间线：**取号**与**推送**的唯一入口。
//
// 契约（手册 `08-SPEC.md` §5.1 / §5.2，决策 P-l 甲 + P-g）：
//
//   ┌ 事件种类 ┬ 取号 ┬ 落盘 ┬ 上时间线 ┐
//   │ 持久事件 │  ✅  │  ✅  │    ✅    │  message/* task/* user/echo timeline/marker
//   │ 控制帧   │  ❌  │  ❌  │    ❌    │  client/reload
//   │ UI 状态  │  ❌  │  ❌  │    ❌    │  本地应声
//   └──────────┴─────┴─────┴──────────┘
//
//   - **只有一个取号函数**（`#nextSeq`），全模块再无第二处 `++seq`。
//   - **持久事件的号 = 那条日志已落盘最大 + 1**，**写盘成功之后才推订阅者**。
//   - **瞬态一律不取号** ⇒ 磁盘上不会出现空洞（不变量 N22 成立）。
//   - 重启时从磁盘取 max ⇒ 编号**单调**。
//
// "一条可见时间线 = 一条日志"（P-l 甲）：
//   多作用域**只是事件上的 `scopeId` 标签**，不是并列的计数器。
//
// ★ **2026-09-25 更正**（契约 `docs/dev/84-DISPATCHER-FOCUS.md` §六）：
//   这个文件头那句话一直是对的，但**实现**曾经走了相反的路 ——
//   `worlds.js` 给每个 scope 各建了一条 `Timeline`（各一份 `scope-<id>.jsonl`、
//   各一套号）。现在收回来了，落点是下面两件东西：
//
//     · `Timeline` —— **每个用户一条**（就是那条日志、就是那套号）；
//     · `ScopeView` —— 同一把 `Timeline` 上的一层**带标签的视图**：
//       它把这一间的事件盖上 `scopeId`，读的时候只挑属于这一间的事件。
//
//   ⚠️ 所以"一条 WS 连接"与"焦点路由"是 C 期的事，这里**不做**：
//      这一层只保证**同一个文件、同一套号**。

import { StoreError } from './store.js';

/** 主线那个房间的名字。**与 `worlds.js` 的 `MAIN_SCOPE` 逐字一致**（不动历史字节）。 */
export const MAIN_SCOPE_LABEL = 'main';

/**
 * 这条事件**属于**哪个 scope（`scopeId` 只是事件上的标签 · P-l）。
 *
 * 认法两条，别处不许再写一份：
 *   · 某个房间 ⇒ 标签**逐字**等于它；
 *   · 主线 ⇒ 标签**没有 / 是 `main`**（盘上老事件没有这个字段 ⇒ 主线逐字不变）。
 *
 * @param {object} event
 * @param {string} scope
 */
export function eventInScope(event, scope) {
  const tag = event?.scopeId;
  if (scope === MAIN_SCOPE_LABEL) return tag === undefined || tag === null || tag === MAIN_SCOPE_LABEL;
  return tag === scope;
}

export class Timeline {
  #id;
  #store;
  #clock;
  #seq = 0;
  #subs = new Set();
  /**
   * scope 键 → 当前未收口的那条消息（N22）。
   *
   * ⚠️ 为什么是**按 scope 各记一份**：一条日志现在装着所有房间，而
   *    N22 的本意是"**一条对话里**同一时刻最多一条未收口"（消息不许交叉）。
   *    收成全局一份的话，甲房间正说着、用户切到乙房间说一句 ⇒ 乙那条
   *    `beginMessage` 会当场抛 —— 那是把一条正确的不变量用错了地方。
   */
  #opens = new Map();
  #onSubscriberError;

  /**
   * @param {object} o
   * @param {string} o.id
   * @param {import('./store.js').Store} o.store
   * @param {() => number} [o.clock]
   * @param {(err: Error, event: object) => void} [o.onSubscriberError]
   *        订阅者自己抛错时调用。**不许静默吞**——但也不该拖垮时间线。
   */
  constructor({ id, store, clock = Date.now, onSubscriberError }) {
    if (!id) throw new StoreError('timeline id 必填');
    if (!store) throw new StoreError('store 必填');
    this.#id = id;
    this.#store = store;
    this.#clock = clock;
    this.#onSubscriberError = onSubscriberError ?? (() => {});
    this.#seq = this.#resumeSeq();
  }

  get id() {
    return this.#id;
  }

  /** 已发出的最大号（= 已落盘最大）。 */
  get seq() {
    return this.#seq;
  }

  /** 当前未收口的那条消息 id；没有则为 null。 */
  get openMessageId() {
    for (const w of this.#opens.values()) return w.messageId;
    return null;
  }

  /**
   * **某个 scope 那条对话**当前未收口的消息 id（没有 ⇒ null）。
   *
   * ⚠️ 有了它，`ScopeView` 才能报"**我这一间**有没有没收口的气泡"，
   *    而不被别的房间正说着的消息顶掉。
   */
  openMessageIdOf(scopeKey = '') {
    return this.#opens.get(scopeKey)?.messageId ?? null;
  }

  /** 全量读（**不过滤**；要按 scope 过滤用 `ScopeView.readAll()`）。 */
  readAll() {
    return this.#store.readAll(this.#id);
  }

  /** 最后一条已落盘事件（重启取号的依据，也是"这条日志存不存在"的依据）。 */
  lastEvent() {
    return this.#store.lastEvent(this.#id);
  }

  /** 重启取 max。磁盘上没有日志 ⇒ 从 0 开始。 */
  #resumeSeq() {
    const last = this.#store.lastEvent(this.#id);
    if (!last) return 0;
    if (typeof last.seq !== 'number') {
      throw new StoreError(
        `时间线 ${this.#id} 的最后一条没有 seq——日志可能被外部改过`,
      );
    }
    return last.seq;
  }

  /** 唯一的取号点。 */
  #nextSeq() {
    this.#seq += 1;
    return this.#seq;
  }

  /** 订阅。返回退订函数。 */
  subscribe(fn) {
    this.#subs.add(fn);
    return () => this.#subs.delete(fn);
  }

  /**
   * **持久事件**：取号 → 落盘 → 成功后才推。
   *
   * ⚠️ 落盘失败时：把号**退回去**（磁盘上没留下东西，号就不该前进，
   *    否则下一个事件在盘上就是跳号的），然后**原样抛出**。
   *    **订阅者一条都不会收到**——这正是验收 V-a 要的行为。
   *
   * ⚠️ 调用点**不需要自己 try**（手册 §5.2）：抛出会到进程级兜底，
   *    由它发一条人话通知再有序退出。逐处 try 会漏（旧代码有 18 个调用点）。
   */
  emit(event) {
    if (!event?.type) throw new StoreError('事件必须有 type');
    const full = { ...event, seq: this.#nextSeq(), at: event.at ?? this.#clock() };
    try {
      this.#store.append(this.#id, full);
    } catch (err) {
      this.#seq -= 1; // 退号：盘上没落，号就不算数
      throw err;
    }
    this.#publish(full);
    return full;
  }

  /**
   * **瞬态事件**：不取号、不落盘、只推。
   *
   * 它为什么重要：盘满的时候它**仍然能发出去**（因为它不写盘）——
   * 所以"盘满了"这句话本身是用它说的。见 `process-guard.js`。
   */
  emitTransient(event) {
    if (!event?.type) throw new StoreError('事件必须有 type');
    const full = { ...event, at: event.at ?? this.#clock() };
    this.#publish(full);
    return full;
  }

  // ── 未收口的那条消息（不变量 N22）─────────────────────────────

  /** @internal 由 MessageWriter 调用（`scopeKey` 由 `ScopeView` 传进来） */
  beginMessage(writer, scopeKey = '') {
    const open = this.#opens.get(scopeKey);
    if (open) {
      throw new StoreError(
        `同一时刻最多一条未收口：${open.messageId} 还没收口，${writer.messageId} 不能开始`,
      );
    }
    this.#opens.set(scopeKey, writer);
  }

  /** @internal 由 MessageWriter 调用 */
  endMessage(writer, scopeKey = '') {
    if (this.#opens.get(scopeKey) === writer) this.#opens.delete(scopeKey);
  }

  #publish(event) {
    for (const fn of this.#subs) {
      try {
        fn(event);
      } catch (err) {
        // 订阅者是别人写的；他抛错不该让时间线停摆，
        // 但**必须报出去**——静默吞掉就是"系统什么都不说"。
        this.#onSubscriberError(err, event);
      }
    }
  }
}

/**
 * **同一把 `Timeline` 上的一层 scope 视图**（契约 84 §三·2 · P-l）。
 *
 * 一个 `ScopeView` 就是"**这一间**看那条日志的样子"：
 *
 *   · **写**：本间的事件盖上 `scopeId`（主线**不盖** —— 盘上老事件没有它，
 *     主线必须逐字不变）；取号与落盘仍然是那把 `Timeline` 的（**一套号**）。
 *   · **读**：`readAll()` / `subscribe()` 只给属于这一间的事件。
 *   · **未收口**：按 scope 各记一份（见 `Timeline.#opens`）。
 *
 * ⚠️ **它不是第二条日志**：`id` 永远是那把 `Timeline` 的 id（每条日志一个文件）。
 * ⚠️ 它**不是安全边界**（同 `worlds.js` 顶上那段）：过滤是为了"视图不串"，
 *    跨 uid 的隔离要靠容器。
 */
export class ScopeView {
  #timeline;
  #scope;

  /** @param {object} o @param {Timeline} o.timeline @param {string} [o.scope] */
  constructor({ timeline, scope = MAIN_SCOPE_LABEL }) {
    if (!timeline) throw new StoreError('ScopeView 需要 timeline');
    this.#timeline = timeline;
    this.#scope = scope === null || scope === undefined || scope === '' ? MAIN_SCOPE_LABEL : String(scope);
  }

  /** **那条日志**的 id（不是这一间的名字 —— 一条日志）。 */
  get id() {
    return this.#timeline.id;
  }

  /** 这一间叫什么（事件上的标签）。 */
  get scopeId() {
    return this.#scope;
  }

  get isMain() {
    return this.#scope === MAIN_SCOPE_LABEL;
  }

  /**
   * **认它是不是"同一把时间线上的 scope 视图"**。
   * ⚠️ 给那些"要按这一间读、又要兼容裸 `Timeline`"的调用方（例如 `reconcile.js`）。
   */
  get isScopeView() {
    return true;
  }

  /** 底下的那把 `Timeline`（建别的 scope 视图时要用它）。 */
  get base() {
    return this.#timeline;
  }

  get seq() {
    return this.#timeline.seq;
  }

  /** **这一间**未收口的那条消息（别的房间正说着不影响它）。 */
  get openMessageId() {
    return this.#timeline.openMessageIdOf(this.#scope);
  }

  /** 这条事件属不属于这一间。 */
  includes(event) {
    return eventInScope(event, this.#scope);
  }

  /**
   * 写的事件上要不要盖标签。
   * ⚠️ 主线**不盖**（盘上老事件没有 `scopeId`；`message/start` 上那个 `'main'`
   *    是 `MessageWriter` 本来就写的，不从这里来）。
   */
  #tagged(event) {
    if (this.isMain) return event;
    return { ...event, scopeId: this.#scope };
  }

  emit(event) {
    return this.#timeline.emit(this.#tagged(event));
  }

  emitTransient(event) {
    return this.#timeline.emitTransient(this.#tagged(event));
  }

  /** @internal 由 `MessageWriter` 调用 */
  beginMessage(writer) {
    return this.#timeline.beginMessage(writer, this.#scope);
  }

  /** @internal 由 `MessageWriter` 调用 */
  endMessage(writer) {
    return this.#timeline.endMessage(writer, this.#scope);
  }

  /** 只订阅**这一间**的事件。 */
  subscribe(fn) {
    return this.#timeline.subscribe((event) => {
      if (this.includes(event)) fn(event);
    });
  }

  /** 读**这一间**的全部事件（主线 ＝ 不带标签 / 标 `main` 的那些）。 */
  readAll() {
    return this.#timeline.readAll().filter((e) => this.includes(e));
  }

  /** 这一间最后一条已落盘事件。 */
  lastEvent() {
    const all = this.readAll();
    return all.length > 0 ? all[all.length - 1] : null;
  }
}
