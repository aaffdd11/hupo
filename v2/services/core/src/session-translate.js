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
import { isReadOnlyTool } from './tools.js';

/** 被截断时补的那句话。**必须是人话**，而且要说清"我没说完"。 */
const TRUNCATED_LINE = '这条我说太长了，被长度限制截断，剩下的我没说完。';
const INTERRUPTED_LINE = '这条我没说完就断了。';
const EMPTY_LINE = '这次我没能给出结论，你再说一次。';

/**
 * 卡住时补的那两句话（超时硬收口）。
 *
 * ⚠️ **必须说清"怎么办"**——手册 N11：拒绝要给人话 + **可重试**，不是静默。
 * ⚠️ **不许出现内部词**（工具 / 超时 / 服务 / 连接 / 卡死这些都不是人话）。
 */
const DEADLINE_EMPTY_LINE = '这件事我卡住了，没能给你答复。你可以再说一次。';
const DEADLINE_PARTIAL_LINE = '这条我卡住了，后面没说完。你可以让我接着说。';
/**
 * 第三种：**用户说了，但那一轮根本没轮到**。
 *
 * 实测（`/tmp/probe-queue.mjs`）：一轮还没结束时再发一句，DSH **接受并排队**
 * （`agent/inbox/spliced {target:"next-turn"}`），等这一轮结束它才变成下一轮。
 * ⇒ 超时踢掉进程时，**排队那句会跟着一起没**，而用户还在等。
 *    所以必须**逐条**给它一个交代（N19）。
 */
const DEADLINE_QUEUED_LINE = '你刚才那句我没来得及做，就卡住了。再说一次吧。';

/** 给测试用：这三句是**用户能看到的话**，所以文案本身也是验收对象。 */
export const DEADLINE_LINES = Object.freeze({
  empty: DEADLINE_EMPTY_LINE,
  partial: DEADLINE_PARTIAL_LINE,
  queued: DEADLINE_QUEUED_LINE,
});

export class TurnTranslator extends EventEmitter {
  #timeline;
  #scopeId;
  #turns = new Map(); // **turn 号** → 这一轮的账
  #lastTitle = null;
  #reasoningSeen = 0;
  /** 已经报过"动过东西"的轮号（一轮只报一次） */
  #mutatedTurns = new Set();

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
      case 'tool/call':
        this.#onToolCall(data);
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

  /**
   * 一次工具调用。
   *
   * ⚠️ 我们**只关心"它会不会改东西"这一个布尔**（决策 D10.1/D10.2），
   *    不关心工具叫什么、更不关心参数是什么。
   *    ⇒ 报出去的事件里**没有工具名、没有参数**——那些是内部词，
   *      而事件是**要落盘、会被 replay 给客户端**的（D7 的边界在这儿）。
   *
   * ⚠️ **一轮只报一次**：第一次碰上"会改东西"的工具就报，之后不再报。
   *    判据是"整轮**有没有**碰过写类工具"，不是"碰了几次"。
   */
  #onToolCall(data) {
    const turn = data?.turn;
    if (typeof turn !== 'number') return;
    if (this.#mutatedTurns.has(turn)) return;
    if (isReadOnlyTool(data?.name)) return;
    this.#mutatedTurns.add(turn);
    // 派给外面（dispatcher 知道这一轮是主人哪句话引起来的，它去落盘）
    this.emit('mutated', { turn });
  }

  /** 这一轮动过东西吗？（给测试与诊断用） */
  turnTouchedSomething(turn) {
    return this.#mutatedTurns.has(turn);
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
   * **换了一个 agent 进程** ⇒ 把轮账清空。
   *
   * ⚠️ 为什么必须有：**轮号在每个进程里都从 1 重新开始。**
   *    上一个进程的第 1 轮如果因为什么原因没被收干净（收了尾但漏删、
   *    或者将来多轮并行），新进程的第 1 轮就会**接到那条陈账上**——
   *    于是新的一轮被当成旧的那轮，收口收错地方。
   *    进程换了，轮账就该是空的——这是构造上成立的，不靠"记得清理"。
   */
  reset() {
    this.#turns.clear();
    this.#mutatedTurns.clear(); // 轮号在新进程里从 1 重来 ⇒ 这份账也是新的
  }

  /**
   * **一轮超时**：收掉这一轮，而且**保证留下话**。
   *
   * 手册 N19「挂起必有收尾」——不许留下永远"马上说完"的气泡。
   *
   * ⚠️ 两种情形**都必须有交代**，第二种最容易漏：
   *   ① **已经说了一半** ⇒ 补一句"卡住了"、标失败收尾。气泡要收口。
   *   ② **一句都没说** ⇒ **主动说一句**。
   *      早先这里（`forceClose`）是"没有 writer 就删掉、什么都不说"——
   *      于是用户等到天荒地老（手册事故一：那行"还有件事在处理"挂了 **68 分钟**）。
   *
   * ⚠️ 收尾理由是 **`timeout`**，不是 `failed`——
   *    `message/end.reason` 是时间线上"为什么结束"的**记录**（N4 记忆有出处、
   *    N7 不拿不真实的状态污染记录）。卡住和断线是两件事，记成一样就查不出来了。
   *    客户端对这一档是安全的：它按 `reason !== 'completed'` 判失败
   *    （`bubbles.dart:121`），**不认识的新值自然落到"失败"那一档**。
   *
   * @param {number} turn
   * @returns {boolean} 真的收了口才 true；那一轮早已收口（只是慢）⇒ false
   */
  turnDeadline(turn) {
    const rec = this.#turns.get(turn);
    if (!rec) return false;
    this.#turns.delete(turn);

    if (rec.writer && !rec.writer.ended) {
      // ① 说了一半
      rec.writer.chunk('deep', DEADLINE_PARTIAL_LINE);
      rec.writer.end('timeout');
    } else if (!rec.writer) {
      // ② 一句都没说 —— **不许留白**
      const w = new MessageWriter({
        timeline: this.#timeline,
        agent: 'agent',
        origin: 'reactive',
        scopeId: this.#scopeId,
      });
      w.chunk('deep', DEADLINE_EMPTY_LINE);
      w.end('timeout');
    }
    this.emit('turn-deadline', { turn });
    return true;
  }

  /**
   * **一条没轮到的话**：用户说了，但那一轮压根没开始。
   *
   * 用在超时硬收口上：我们把 agent 卸了，排队里那些话就再也没有下一轮了。
   * **不许让它们静默消失**——用户看到的会是一个永远等不到回答的气泡。
   */
  turnUndelivered({ reason = 'timeout' } = {}) {
    const w = new MessageWriter({
      timeline: this.#timeline,
      agent: 'agent',
      origin: 'reactive',
      scopeId: this.#scopeId,
    });
    w.chunk('deep', DEADLINE_QUEUED_LINE);
    w.end(reason);
    return true;
  }

  /**
   * 强制收口：把**所有**还没收尾的轮都收掉。
   *
   * ⚠️ 早先它只找"**有 writer 的那一轮**"（`openTurn`）。于是有这么一类轮
   *    **永远不会被清掉、也永远不会说话**：
   *
   *      一轮开了 → 一个字都还没说 → 进程没了 / 被卸了
   *
   *    它在 `#turns` 里留着（**泄漏**），而屏幕上**什么都没有**——
   *    用户就一直等一条不会来的回答。**这正是 N19 要挡的形状**，
   *    只是它藏在"没有 writer"这条路上，`openTurn` 找不到它。
   *
   * ⚠️ 而且它是**界面那个"它正在做…"的收尾条件**：不清掉，
   *    那行提示会永远挂在那儿（手册 H4：卡住时永久停在"在查资料"，比空白更坏）。
   *
   * @param {string} reason
   * @param {object} [o]
   * @param {string} [o.line] **一句话都没说**时说的那句（有 writer 时补的是
   *        `INTERRUPTED_LINE`，因为用户已经看到半句了）。
   * @returns {number} 收掉了几轮
   */
  forceClose(reason = 'failed', { line = INTERRUPTED_LINE } = {}) {
    let closed = 0;
    for (const [turn, rec] of [...this.#turns]) {
      this.#turns.delete(turn);
      if (rec.writer && !rec.writer.ended) {
        // 用户已经看到半句 ⇒ 补一句"没说完"，别重复它的开头
        rec.writer.chunk('deep', INTERRUPTED_LINE);
        rec.writer.end(reason);
      } else if (!rec.writer) {
        // 一句话都没说 ⇒ **主动交代**（不许留白）
        const w = new MessageWriter({
          timeline: this.#timeline,
          agent: 'agent',
          origin: 'reactive',
          scopeId: this.#scopeId,
        });
        w.chunk('deep', line);
        w.end(reason);
      }
      closed += 1;
    }
    if (closed > 0) this.emit('force-close', { reason, closed });
    return closed;
  }
}
