// `POST /api/say` —— 用户说了一句话。
//
// 手册 `08-SPEC.md` §2.1 把 `/api/say` 标成**幂等**，而旧实现**没有去重**
// （评审 E2 实测：`/api/say` 每次调用都 emit + prompt）
// ⇒ **重发 = agent 干两遍**，而且用户看到两遍回答。
//
// 关键点：去重必须**跨重启有效**。
// 客户端会在"它以为没发出去"的时候重发——而那种时刻，
// 服务端**很可能刚重启过**（这正是它没收到回执的原因）。
// 所以"见过的 messageId"是从**日志**重建的，不是内存里的一个 Set。

import { StoreError } from './store.js';

const MAX_TEXT_LEN = 8000;

export class SayService {
  #timeline;
  #store;
  #timelineId;
  #seen = new Set();

  constructor({ timeline, store, timelineId }) {
    if (!timeline || !store) throw new StoreError('timeline 与 store 必填');
    this.#timeline = timeline;
    this.#store = store;
    this.#timelineId = timelineId ?? timeline.id;
    this.#rebuildFromLog();
  }

  /** 从日志重建"见过的 messageId"——这样重启不会让去重失效。 */
  #rebuildFromLog() {
    for (const e of this.#store.readAll(this.#timelineId)) {
      if (e.type === 'user/echo' && e.messageId) this.#seen.add(e.messageId);
    }
  }

  /** 测试用：直接看当前见过多少条。 */
  get seenCount() {
    return this.#seen.size;
  }

  /**
   * @param {object} o
   * @param {string} o.messageId  客户端生成（`u_` 前缀）
   * @param {string} o.text
   * @param {number} [o.clientAt] 客户端自己的钟（**只用来记录，不参与排序**）
   * @returns {{duplicate: boolean, event?: object}}
   */
  /**
   * 这一句**是不是重发**（同一个 `messageId` 之前收过）。
   *
   * ⚠️ 为什么准入闸需要它：**重发绝不能被拒**。
   *    重发的意思是"我没收到你的回执，再说一遍"——那一句**早就落盘了**。
   *    要是拿"忙"把它拒掉，界面上会显示"没发出去"，而服务端其实收下了 ⇒
   *    用户会再发一遍，**界面在说假话**（而且那一轮已经在跑了）。
   */
  isDuplicate(messageId) {
    return typeof messageId === 'string' && this.#seen.has(messageId);
  }

  say({ messageId, text, clientAt }) {
    if (!messageId || typeof messageId !== 'string') {
      throw new SayError('缺 messageId', 400);
    }
    if (typeof text !== 'string' || text.trim() === '') {
      throw new SayError('说不出空话', 400);
    }
    if (text.length > MAX_TEXT_LEN) {
      throw new SayError(`太长了（${text.length} > ${MAX_TEXT_LEN}）`, 413);
    }

    // ★ 幂等：同一个 messageId 只落一次
    if (this.#seen.has(messageId)) {
      return { duplicate: true };
    }

    const event = this.#timeline.emit({
      type: 'user/echo',
      messageId,
      text,
      // ⚠️ 客户端钟**只记录**。排序用服务端的 `at`（每事件由 emit 统一盖）。
      //    混钟当排序键会乱——现网是刻意避免的。
      clientAt: typeof clientAt === 'number' ? clientAt : null,
    });
    this.#seen.add(messageId);
    return { duplicate: false, event };
  }
}

export class SayError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'SayError';
    this.status = status;
  }
}
