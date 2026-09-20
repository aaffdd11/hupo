// 一条消息的生命周期：`start → text* → end`。
//
// 契约（手册 `08-SPEC.md` §5.1 / `02-ARCHITECTURE.md` §5）：
//   1. **顺序固定**：`start → text* → end`。没有 start 就 chunk，自动补 start。
//   2. ⚠️ **`chunk()` 必须先查 `ended`**——旧实现（`conversation.js:204`）不查，
//      于是**谁还攥着旧 writer，谁就能把内容写回一条已经收口的消息里**，
//      用户看到"时间倒流"（这正是事故"消息不许交叉"的成因）。
//      ⇒ 这里直接**抛错**，不留隐性约定。
//   3. **`end()` 幂等**：重复调用不产生第二条收尾事件。
//   4. **`end()` 带最终来源**：`end.sources` 是权威版本，覆盖 `start` 上带的
//      （协议 R8；因为工具往往在收尾前才返回）。
//   5. **同一时刻最多一条未收口**（不变量 N22）——由 `Timeline` 强制，
//      本类在 `start`/`end` 时向它登记。
//
// 换手（handoff）的正确姿势：**先 `end()` 旧的那条，再 `new` 一条**。
// 旧实现里 `cur.writer = new MessageWriter(...)` 直接换引用，
// 而 dispatcher 手里还攥着旧的 `info` —— 那个 bug 见 `07-APPENDIX.md` §一「收口失效」。

import { StoreError } from './store.js';

let counter = 0;

/** 消息 id。前缀 `m_` = 服务端生成（协议身份字段约定）。 */
export function newMessageId() {
  counter += 1;
  return `m_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export class MessageWriter {
  #timeline;
  #messageId;
  #agent;
  #origin;
  #re;
  #scopeId;
  #sources = [];
  #started = false;
  #ended = false;
  #text = '';
  #chunks = 0;

  constructor({ timeline, messageId, agent, origin, re = [], scopeId = null }) {
    if (!timeline) throw new StoreError('timeline 必填');
    if (!agent) throw new StoreError('agent 必填（谁在说）');
    if (!['reactive', 'proactive'].includes(origin)) {
      throw new StoreError(`origin 只能是 reactive / proactive，收到 ${origin}`);
    }
    this.#timeline = timeline;
    this.#messageId = messageId ?? newMessageId();
    this.#agent = agent;
    this.#origin = origin;
    this.#re = re;
    this.#scopeId = scopeId;
  }

  get messageId() {
    return this.#messageId;
  }
  get started() {
    return this.#started;
  }
  get ended() {
    return this.#ended;
  }
  /** 到目前为止说出口的正文。 */
  get text() {
    return this.#text;
  }
  /** 最终来源。收尾时写入 `message/end`。 */
  get sources() {
    return this.#sources;
  }
  set sources(list) {
    this.#sources = Array.isArray(list) ? list : [];
  }

  start() {
    if (this.#started) throw new StoreError(`${this.#messageId} 已经开过口`);
    if (this.#ended) throw new StoreError(`${this.#messageId} 已经收口，不能再开口`);
    this.#timeline.beginMessage(this); // 可能抛：已有未收口的（N22）
    try {
      this.#timeline.emit({
        type: 'message/start',
        messageId: this.#messageId,
        agent: this.#agent,
        origin: this.#origin,
        re: this.#re,
        scopeId: this.#scopeId,
      });
    } catch (err) {
      // ⚠️ 落盘失败 ⇒ 这条消息**没开成口**，必须把登记撤掉。
      //    不撤的话，时间线上会永久留着一个"未收口"的幽灵，
      //    之后**每一条消息都开不了口**——而现场看起来只是"它不理我了"。
      //    （这正是 N7「不拿不真实的状态污染记录」的形状：
      //      状态先写下去，失败时忘了收回来。）
      this.#timeline.endMessage(this);
      throw err;
    }
    this.#started = true;
  }

  /**
   * 追加一段正文。
   * @param {'quick'|'deep'} block  快答 / 深答（同一个气泡，协议 R2）
   */
  chunk(block, text) {
    if (this.#ended) {
      // ⚠️ 这一条是硬拦，不是提醒：见文件头契约 2。
      throw new StoreError(`${this.#messageId} 已收口，不能再往上写（时间倒流）`);
    }
    if (!this.#started) this.start();
    this.#chunks += 1;
    this.#text += text;
    this.#timeline.emit({
      type: 'message/text',
      messageId: this.#messageId,
      block,
      seqInBlock: this.#chunks,
      text,
    });
    return this;
  }

  /** 收口。**幂等**——重复调用返回 false，不产生第二条收尾事件。 */
  end(reason = 'completed') {
    if (this.#ended) return false;
    if (!this.#started) this.start(); // 一句话没说就收口，也要有 start，否则界面留白
    this.#timeline.emit({
      type: 'message/end',
      messageId: this.#messageId,
      reason,
      sources: this.#sources, // 权威版本（协议 R8）
    });
    this.#ended = true;
    this.#timeline.endMessage(this);
    return true;
  }
}
