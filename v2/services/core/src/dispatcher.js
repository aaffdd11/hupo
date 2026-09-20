// 调度器的粘合层：用户说了话 → 交给 agent → 把它的话翻成产品事件。
//
// 手册 `02-ARCHITECTURE.md` §四（调度器职责）、`08-SPEC.md` §5.5（淘汰谁回调谁）。
//
// 一头一尾两件事最要紧：
//
//   **投递**：`session/prompt` 是**立刻返回**的（实测 ~35ms），
//   答案从 `session-event` 异步流回来。所以"发出去"和"答出来"是两件事，
//   **不能等 prompt 的返回值当答案**。
//
//   **收尾**：agent 进程死掉 / 被淘汰 / 超时——**都必须收口**。
//   不收的话，用户会永远等一条不会来的回答
//   （手册事故一：那行"还有件事在处理"挂了 68 分钟）。

import { TurnTranslator } from './session-translate.js';

export class Dispatcher {
  #timeline;
  #runtime;
  #scopeId;
  #translator;
  #agent = null;
  #lastError = null;

  constructor({ timeline, runtime, scopeId = null }) {
    this.#timeline = timeline;
    this.#runtime = runtime;
    this.#scopeId = scopeId;
    this.#translator = new TurnTranslator({ timeline, scopeId });
  }

  get translator() {
    return this.#translator;
  }

  get lastError() {
    return this.#lastError;
  }

  /** 惰性取 agent，并把它的三类事件接到翻译层上。 */
  #ensureAgent() {
    if (this.#agent) return this.#agent;
    const id = this.#timeline.id;
    const agent = this.#runtime.agent(id);
    this.#agent = agent;

    agent.on('session-event', (params) => {
      try {
        this.#translator.handle(params);
      } catch (err) {
        // 翻译层抛错不该把 agent 打死；但**必须报出来**（不许静默吞）
        this.#lastError = `翻译出错：${err?.message ?? err}`;
      }
    });

    agent.on('status', ({ status }) => {
      // 状态走**瞬态**通道（决策 P-g：不上时间线、不落盘）
      this.#timeline.emitTransient({ type: 'message/status', messageId: '', state: status });
    });

    agent.on('exit', (info) => {
      this.#agent = null;
      // ★ **进程死了必须收口**——不能让用户等一个不会再来的回答
      this.#translator.forceClose('failed');
      this.#lastError = info?.reason ?? 'agent 退出了';
      this.#timeline.emitTransient({
        type: 'error',
        kind: 'agent-exit',
        text: '刚才我断了，这条没做完。',
      });
    });

    return agent;
  }

  /**
   * 用户说了一句话，把它交给 agent。
   *
   * @returns {Promise<{delivered: boolean, messageId?: string, error?: string}>}
   */
  async deliver(text) {
    const agent = this.#ensureAgent();
    try {
      const r = await agent.prompt(text);
      this.#lastError = null;
      return { delivered: true, messageId: r?.messageId };
    } catch (err) {
      this.#lastError = String(err?.message ?? err);
      // 起不来的时候**也要有个交代**——静默失败等于"它不理我"
      try {
        this.#translator.forceClose('failed');
      } catch {
        /* 没有未收口的，正常 */
      }
      this.#timeline.emitTransient({
        type: 'error',
        kind: 'agent-unavailable',
        text: '我现在接不上活，你这句话我记下了，等我缓过来再说。',
      });
      return { delivered: false, error: this.#lastError };
    }
  }

  /**
   * 淘汰回调（手册 §5.5「谁回调谁」）。
   *
   * runtime **没有翻译层**，它不知道哪条消息还没收口 ⇒ 只能回调这里。
   * 顺序是死的：**先收口，再让它卸**。反了的话用户永远等不到收尾。
   */
  async onEvict(sessionId) {
    if (sessionId !== this.#timeline.id) return;
    this.#translator.forceClose('failed');
    this.#agent = null;
  }

  /** 收工：先把话说圆，再放 agent 走。 */
  async shutdown() {
    this.#translator.forceClose('failed');
    this.#agent = null;
  }
}
