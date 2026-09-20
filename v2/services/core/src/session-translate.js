// 翻译层：agent 事件 → 产品事件（`message/*`）。
//
// 手册 `03-DEVELOPMENT.md` §5.3（轮的稳定键）、`08-SPEC.md` §4.4（D7 泄露风险）。
//
// 三条从**实测 + 事故**里来的硬约束：
//
//   ① ⚠️ **`content[].type === 'reasoning'` 绝不许变成用户能看到的话。**
//      实测：`assistant/message` 的 `message.content` 里，
//      **推理原文和正文躺在同一个数组里**：
//        [{type:'reasoning', text:'…'}, {type:'text', text:'你好。'}]
//      不按 type 过滤，**就等于把模型的思维链当正文发给用户**——
//      而它可能含系统提示片段。手册 §4.4 把这条列为"唯一有泄露风险的字段"。
//
//   ② ⚠️ **`turns` 的键是「轮」的编号，不是「当前气泡」的 id。**
//      实测：agent 直接给了 `data.turn`。
//      为什么不能用气泡 id：`handoff()` 会**原地换掉 writer**，
//      而 dispatcher 手里的 `info` 和 `translator.current` **是同一个对象**——
//      于是 `info.writer.messageId` **在它不知情的情况下变了**，
//      收口守卫从此永不匹配（手册 §5.3「收口失效」）。
//      **`turn` 号在一轮内构造上不会变**，所以拿它当键。
//
//   ③ ⚠️ **`turn/end.reason.kind !== 'completed'` ⇒ 这是半句。**
//      实测 reason 有 `kind`。手册附十一记录过一次真实事故：
//      回答被长度上限截断（`max-tokens`），而翻译层**一律写 completed**，
//      用户拿到一个"看起来说完了"的残篇。
//      ⇒ 必须补一句说明，并把它标成**失败收尾**。

import { EventEmitter } from 'node:events';

import { MessageWriter } from './message-writer.js';

/** 被截断时补的那句话。**必须是人话**，而且要说清"我没说完"。 */
const TRUNCATED_LINE = '这条我说太长了，被长度限制截断，剩下的我没说完。';
const INTERRUPTED_LINE = '这条我没说完就断了。';
const EMPTY_LINE = '这次我没能给出结论，你再说一次。';

export class TurnTranslator extends EventEmitter {
  #timeline;
  #scopeId;
  #turns = new Map(); // **turn 号** → 这一轮的账
  #lastTitle = null;
  #reasoningSeen = 0;

  constructor({ timeline, scopeId = null }) {
    super();
    this.#timeline = timeline;
    this.#scopeId = scopeId;
  }

  /** 当前有没有一轮还没收口。给淘汰回调判断用。 */
  get openTurn() {
    for (const [turn, t] of this.#turns) if (t.writer && !t.writer.ended) return turn;
    return null;
  }

  get lastTitle() {
    return this.#lastTitle;
  }

  /** 看到过几段推理原文（**只计数，内容一律不落、不推**）。 */
  get reasoningSeen() {
    return this.#reasoningSeen;
  }

  /**
   * 吃一个 `session.event` 通知。
   * @param {object} params  agent 发来的 params（形如 `{event: {...}}`）
   */
  handle(params) {
    const ev = params?.event ?? params;
    const type = ev?.type;
    if (typeof type !== 'string') return;
    const data = ev.data ?? {};

    switch (type) {
      case 'turn/start':
        this.#onTurnStart(data, ev);
        break;
      case 'assistant/message':
        this.#onAssistantMessage(data, ev);
        break;
      case 'turn/end':
        this.#onTurnEnd(data, ev);
        break;
      case 'session/title':
        // 标题**永不进模型输入**（DSH 保证的）。这里只存着给界面用。
        this.#lastTitle = data.title ?? null;
        this.emit('title', this.#lastTitle);
        break;
      case 'step/start':
      case 'step/end':
        // D7 的"在做什么"以后从这里来。**现在不推给用户**——
        // 推了就是"还没做的功能在撒谎"。
        this.emit('step', { phase: type, turn: data.turn, step: data.step });
        break;
      default:
        // 其它（request/*、permission/*、sandbox/*、agent/inbox/*…）安静忽略
        break;
    }
  }

  #onTurnStart(data, ev) {
    const turn = data.turn;
    if (typeof turn !== 'number') return;
    // ★ 键是 turn —— 见文件头 ②
    if (!this.#turns.has(turn)) {
      this.#turns.set(turn, { writer: null, startedAt: ev.time ?? Date.now(), texts: 0 });
    }
    this.emit('turn-start', turn);
  }

  #onAssistantMessage(data, ev) {
    const turn = data.turn;
    const rec = this.#turns.get(turn);
    if (typeof turn !== 'number') return;

    const content = data?.message?.content;
    if (!Array.isArray(content)) return;

    // ① **只取 type === 'text'** —— 推理原文(count)一律不走这条路
    const texts = [];
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') {
        texts.push(block.text);
      } else if (block?.type === 'reasoning') {
        // ⚠️ 只计数。**内容绝不落盘、绝不外推。**
        //    （手册 §4.4：它可能含系统提示片段，一旦进日志，
        //      之后任何新连接 replay 都会拿到。）
        this.#reasoningSeen += 1;
      }
    }
    if (texts.length === 0) return;

    const text = texts.join('');
    if (!rec) return;

    // 一轮里第一段文本 = 快答，后面的 = 深答（协议 R2：同一个气泡）
    for (const piece of texts) {
      if (!rec.writer) {
        rec.writer = new MessageWriter({
          timeline: this.#timeline,
          agent: 'agent',
          origin: 'reactive',
          scopeId: this.#scopeId,
        });
      }
      const block = rec.texts === 0 ? 'quick' : 'deep';
      rec.writer.chunk(block, piece);
      rec.texts += 1;
    }
    this.emit('text', { turn, text, usage: data.usage ?? null });
  }

  #onTurnEnd(data, ev) {
    const turn = data.turn;
    const rec = this.#turns.get(turn);
    if (!rec) return;
    this.#turns.delete(turn); // ★ 用 turn 删 —— 键和存的时候一致

    const kind = data?.reason?.kind ?? 'completed';
    const writer = rec.writer;

    if (!writer) {
      // 一句话都没说。**不许留白**（手册：宁可说一句"没结论"，也不能空着）。
      const w = new MessageWriter({
        timeline: this.#timeline,
        agent: 'agent',
        origin: 'reactive',
        scopeId: this.#scopeId,
      });
      w.chunk('deep', kind === 'completed' ? EMPTY_LINE : INTERRUPTED_LINE);
      w.end('failed');
      this.emit('turn-end', { turn, kind, empty: true });
      return;
    }

    if (kind !== 'completed') {
      // ③ **半句**：补一句说明，并**标成失败收尾**。
      //    绝不许把半句当完整回答（事故三）。
      writer.chunk('deep', kind === 'max-tokens' ? TRUNCATED_LINE : INTERRUPTED_LINE);
      writer.end('failed');
    } else {
      writer.end('completed');
    }
    this.emit('turn-end', { turn, kind, empty: false });
  }

  /**
   * 强制收口（超时 / 进程死掉 / 淘汰前）。
   *
   * ⚠️ 这就是"**先收口再卸**"里的那个收口。
   *    不收的话，用户会永远等一条不会来的回答
   *    （手册事故一："还有件事在处理"一直挂着）。
   */
  forceClose(reason = 'failed') {
    const turn = this.openTurn;
    const rec = turn === null ? null : this.#turns.get(turn);
    if (!rec?.writer) {
      if (turn !== null) this.#turns.delete(turn);
      return false;
    }
    if (!rec.writer.ended) {
      rec.writer.chunk('deep', INTERRUPTED_LINE);
      rec.writer.end(reason);
    }
    this.#turns.delete(turn);
    return true;
  }
}
