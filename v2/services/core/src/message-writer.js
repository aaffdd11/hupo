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
//
// ── ★ D 期（契约 `docs/dev/100-DISPATCHER-D.md` §6.2）：**接别人的那条** ──
// 手册 §3.5 要的是"**B 接着往同一条消息里写**"（客户端**一个气泡**），
// 所以转交**不是**换手那条路（那条要"先收口"），而是：
//
//     A 那条**不收口**（`handoff(messageId)` —— 只打一个状态，不 `end`），
//     B 用**同一个 `messageId`** 继续 `chunk()`，最后由 B `end()`。
//
// 🔴 两条不许走样：
//   ① **`scopeId` 仍是发起那一间**（用户可见的那一间）⇒ 视图不裂；
//   ② **谁在干活另说**（`byScope`）：只用于审计 / 用量，**不许**当可见标签。

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
  #byScope = null;
  #sources = [];
  #started = false;
  #ended = false;
  #text = '';
  #chunks = 0;

  constructor({ timeline, messageId, agent, origin, re = [], scopeId = null, byScope = null }) {
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
    this.#byScope = typeof byScope === 'string' && byScope !== '' ? byScope : null;
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
  /** ★ **谁在干活**（审计/用量归因）——`null` = 就是它自己那一间（老行为）。 */
  get byScope() {
    return this.#byScope;
  }
  /**
   * ★ 记下**真正的干活者**（转交续写时由调度器叫）。
   * 🔴 **它不改 `scopeId`** —— 可见标签永远是发起那一间（`100` §6.2）。
   */
  set byScope(scope) {
    this.#byScope = typeof scope === 'string' && scope !== '' ? scope : null;
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
        // ⚠️ `byScope` **只在转交续写时才有**（它不是老字段，也不许有默认值）：
        //    没有它 ⇒ 事件的形状与改前**逐字一样**。
        ...(this.#byScope ? { byScope: this.#byScope } : {}),
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
      // ⚠️ **只给变异验证用的后门**（`HUPO_MUT_TAG`）：把一个**故意错的**
      //    可见标签强加上去，用来证明判据 D-4 那条"标签不许打成干活者"**不是恒真**
      //    （见 `docs/dev/100-DISPATCHER-D.md` §三 的"每条都要变异验证"）。
      //    不设这个环境变量 ⇒ **一个字节都不加**（正常运行与改前逐字一样）。
      ...(process.env.HUPO_MUT_TAG ? { scopeId: process.env.HUPO_MUT_TAG } : {}),
      block,
      seqInBlock: this.#chunks,
      text,
      ...(this.#byScope ? { byScope: this.#byScope } : {}),
    });
    return this;
  }

  /**
   * ★ **转交**：这条消息**不收口**，但要让界面知道"活已经交给别人了"。
   *
   * 🔴 它与"**挪走**"**不是一回事**（决策 D10.4）：
   *    挪走 = **先收口**、后面的话**另起一条**；
   *    转交 = **不收口**、后面的话**进同一条**（`100` §6.2 / D-8）。
   *    ⇒ 所以这里**绝不**调 `end()`。
   *
   * @param {object} [o]
   * @param {string} [o.reason] 为什么转（模型给的理由；**不保证**有）
   * @param {string} [o.to] 转给哪一间（**审计用**：它带内部 id，界面不许直接显示）
   * @returns {boolean} 真发了才是 true（已经收口的那条 ⇒ false，不硬发）
   */
  handoff({ reason = null, to = null, scopeId = undefined } = {}) {
    if (this.#ended) return false;
    if (!this.#started) this.start();
    // 🔴 **可见标签**：优先用调用方明确给的那一间（= 发起那一间 · §6.2）；
    //   没给就退回本对象自己那个（主线时它是 `null` ⇒ 事件上不带字段，
    //   与盘上老事件的形状**逐字一致**）。
    const tag = scopeId !== undefined ? scopeId : this.#scopeId;
    this.#timeline.emit({
      type: 'message/handoff',
      messageId: this.#messageId,
      reason: typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : null,
      // ⚠️ `to` 是**内部 id**：它是给审计/排障看的（与服务端那本 `HandoffBook` 对齐），
      //    客户端**不许**把它显示出来（`06` 禁用词那条）。
      to: typeof to === 'string' && to !== '' ? to : null,
      // 主线不带这个字段（与 `message/start` 同一条规矩）
      ...(tag ? { scopeId: tag } : {}),
      ...(this.#byScope ? { byScope: this.#byScope } : {}),
    });
    return true;
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
      ...(this.#byScope ? { byScope: this.#byScope } : {}),
    });
    this.#ended = true;
    this.#timeline.endMessage(this);
    return true;
  }
}
