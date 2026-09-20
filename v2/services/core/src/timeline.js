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

import { StoreError } from './store.js';

export class Timeline {
  #id;
  #store;
  #clock;
  #seq = 0;
  #subs = new Set();
  #open = null; // 当前未收口的那条消息（N22：同一时刻最多一条）
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
    return this.#open?.messageId ?? null;
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

  /** @internal 由 MessageWriter 调用 */
  beginMessage(writer) {
    if (this.#open) {
      throw new StoreError(
        `同一时刻最多一条未收口：${this.#open.messageId} 还没收口，${writer.messageId} 不能开始`,
      );
    }
    this.#open = writer;
  }

  /** @internal 由 MessageWriter 调用 */
  endMessage(writer) {
    if (this.#open === writer) this.#open = null;
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
