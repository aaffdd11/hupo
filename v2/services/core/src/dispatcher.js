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

import { RECAP_DEFAULTS, buildRecap } from './recap.js';
import { TurnTranslator } from './session-translate.js';

export class Dispatcher {
  #timeline;
  #runtime;
  #scopeId;
  #translator;
  #store;
  #recapOptions;
  /** 已经挂过监听的那个实例。**永不清空**——见 `#ensureAgent()`。 */
  #wiredAgent = null;
  #lastError = null;
  #recapFedTo = null;
  #lastRecap = null;

  constructor({ timeline, runtime, scopeId = null, store, recap = {} }) {
    if (!store) {
      // ⚠️ **不许默认没有 recap 就悄悄开工。**
      //    没有 store ⇒ 每次重启的用户体验都是"它失忆了"，
      //    而那种故障**看起来只是"它有点笨"**，没人会去查配置。
      throw new Error('Dispatcher 需要 store（跨重启接记忆靠它读日志）');
    }
    this.#timeline = timeline;
    this.#runtime = runtime;
    this.#scopeId = scopeId;
    this.#store = store;
    this.#recapOptions = { ...RECAP_DEFAULTS, ...recap };
    this.#translator = new TurnTranslator({ timeline, scopeId });
  }

  get translator() {
    return this.#translator;
  }

  get lastError() {
    return this.#lastError;
  }

  /** 上一次喂回去的那段背景（诊断用；`null` = 还没喂过）。 */
  get lastRecap() {
    return this.#lastRecap;
  }

  /**
   * 造**这一轮要喂的背景**。
   *
   * ⚠️ 读的是**日志**，不是内存（不变量 N6：事件流才是权威）。
   *    内存里那份会在重启时归零，而那正是需要它的时刻。
   *
   * ⚠️ 这里用**全量读**，不做"只读尾部多少字节"的优化。理由是刻意的：
   *    按字节开窗口**会静默地把记忆截短**——而那种故障看起来只是
   *    "它有点笨"，没人会去查。宁可慢一点、可测量。
   *    代价实测：起 agent 本来就要 ~1.1 秒（`initialize`），
   *    解析几万行 JSON 是几十毫秒。**等日志真的长到有影响时，
   *    它必须和写路径一起改**（`store.js` 文件头记着：改 append 为异步
   *    就必须同时改取号方式，不能只改一半）。
   */
  #recapText(excludeMessageId) {
    const events = this.#store.readAll(this.#timeline.id);
    const built = buildRecap(events, { ...this.#recapOptions, excludeMessageId });
    this.#lastRecap = built.text === '' ? null : built.text;
    return built.text;
  }

  /** 取 agent，并在**换了实例**时把它的三类事件接到翻译层上。 */
  /**
   * 取 agent，并在**换了实例**时把它的三类事件接到翻译层上。
   *
   * ⚠️ **每次都问 runtime，自己不留缓存。**
   *    早先是"第一次取到就攥住不放"，于是有一条很阴的路：
   *    实例被 `dispose()` 之后，如果没人回调 `onEvict`，
   *    这里手里那个**已经死掉的**对象会一直被当成"还是它"——
   *    连"背景喂过没有"都会判错（新进程其实什么都不记得）。
   *    runtime 的表才是权威：它删了，这里下一次就拿到**新的**。
   *
   * ⚠️ 但**监听只能挂一次**——同一个实例重复挂就会重复翻译，
   *    用户看到两条一样的回答。所以按**实例身份**比一下再挂。
   */
  #ensureAgent() {
    const id = this.#timeline.id;
    const agent = this.#runtime.agent(id);
    if (agent === this.#wiredAgent) return agent;
    this.#wiredAgent = agent;

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
      // 那个实例没了 ⇒ 下一个实例要重新喂背景。
      // ⚠️ `#wiredAgent` **不动**：它是"挂过监听的那个"，不是"活着的那个"。
      //    动了它，同一个实例就会被**挂两遍**监听，用户看到两条一样的回答。
      this.#recapFedTo = null;
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
   * ★ **跨重启接记忆就在这儿**：agent 是**每次重启新起的**（SDK 只能 create，
   *   不能 resume），所以**对每一个 agent 实例，第一次投递时**把时间线尾部
   *   那一段按来源分节喂回去。此后不再喂——这个进程自己记得。
   *
   * ⚠️ **背景是单独一个内容块**，不和主人的话拼成一个字符串。
   *    拼在一起的话，模型分不清"哪句是背景、哪句是现在这句"——
   *    而分得清正是分节的全部意义。
   *
   * @param {string} text
   * @param {object} [o]
   * @param {string} [o.messageId]
   *        这句话在日志里的 id。**必须给**——`/api/say` 是先落盘再投递的，
   *        所以此刻它已经在日志里了；不排掉它会**出现两遍**。
   * @returns {Promise<{delivered: boolean, messageId?: string, error?: string, recapped?: boolean}>}
   */
  async deliver(text, { messageId = null } = {}) {
    const agent = this.#ensureAgent();

    // 只对"还没喂过的那个实例"喂一次。按**实例**记，不按"启动过没有"记——
    // 进程死掉 / 被淘汰之后 `#ensureAgent()` 会给出**新的**实例，
    // 那时它同样什么都不记得，同样需要背景。
    const needsRecap = this.#recapFedTo !== agent;
    let blocks = [{ type: 'text', text }];
    if (needsRecap) {
      // ★ **先记账再投**：并发的两次投递不许各喂一遍背景。
      //    喂失败（agent 起不来）时下面会把它撤回来，下次补上。
      this.#recapFedTo = agent;
      try {
        const recap = this.#recapText(messageId);
        if (recap !== '') blocks = [{ type: 'text', text: recap }, ...blocks];
      } catch (err) {
        // 读日志失败**不该拦着人说话**——但必须说出来（不许静默）
        this.#lastError = `背景没读出来：${err?.message ?? err}`;
        this.#recapFedTo = null;
      }
    }

    try {
      const r = await agent.prompt(blocks);
      this.#lastError = null;
      return { delivered: true, messageId: r?.messageId, recapped: needsRecap };
    } catch (err) {
      if (needsRecap) this.#recapFedTo = null; // 没喂成 ⇒ 下次补
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
    this.#recapFedTo = null;
  }

  /** 收工：先把话说圆，再放 agent 走。 */
  async shutdown() {
    this.#translator.forceClose('failed');
    this.#recapFedTo = null;
  }
}
