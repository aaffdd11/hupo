// 调度器：**只管节奏**。
//
// ⚠ 2026-09-14 架构转向。以前这里编排"接收层 → 分类 → 专家 → 反馈层"四次模型调用，
// 等于把一个人劈成四个分身还让它们互相复述。现在处理层是**一个真 DSH agent**，
// 它自己会先应一声、自己会用工具查、自己会 spawn subagent、自己会说结论。
//
// 所以这个文件只剩下三件事：
//
//   ① **把用户的话交给 agent**（一个会话一个常驻 agent 进程）
//   ② **把 agent 的事件翻译成产品协议**（交给 session-translate.js）
//   ③ **控制节奏**：这一轮太久就挪出当前对话（"我单独拿去做，完了跟你说"），
//      到点必须收口，任何失败都要有合法收尾 —— 用户永远不该面对一个空屏。
//
// 产品纪律一条没变（见 packages/protocol/PROTOCOL.md）：
//   不是一对一 / 每段都是整句 / 绝不沉默 / 主动开口是允许的。

import { AgentRuntime } from './agent-runtime.js';
import { DebugAgent, ruleFindings, stuckTasks } from './debug-agent.js';
import {
  Conversation,
  MessageWriter,
  newId,
  restoreConversation,
  timelineContext,
} from './conversation.js';
import { TurnTranslator } from './session-translate.js';

/**
 * 开发模式埋点：记录一个内部步骤的开始/结束/出错。
 *
 * 这些**不是产品事件** —— 只在开发者模式下推给卡片看。
 */
function devStep(conv, phase, status, extra = {}) {
  conv.emitDev({ type: 'dev/step', phase, status, ...extra });
}

/**
 * "这一轮太久了"时替 agent 说的那句过渡话。
 *
 * 为什么是固定串而不是再调一次模型：agent 正在这一轮里干活，SDK 协议没有
 * "往它嘴里插一句"的能力（再发一个 prompt 只会排到下一轮）。
 * 所以这句和「（已停下）」一样，属于**产品的固定话术**，语气与人格保持一致。
 */
const HANDOFF_LINE = '这件事比我想的久，我单独拿去做，完了跟你说。';

/** 一轮真的彻底失败时，必给用户一个合法收尾（不留白）。 */
const FAILED_LINE = '这条我没能给出结论，你再说一次，或者换个说法，我重来。';

/**
 * 拼"跨重启接记忆"的那一整段：**时间流水 + 这一句输入**。
 *
 * 单独拎出来是为了能被测试钉住（见 test/timeline-context.test.js）——
 * 这段文字是**喂给 agent 的**，它长什么样直接决定 agent 会不会往回补对话。
 */
export function recapPrompt(timeline, text) {
  return [
    '【以下是这个会话**按时间**记下的事件流水（原样摘录，不是总结，也不是配对好的一问一答）。',
    '每一行开头是它发生的时间。它只用来让你知道"刚才说到哪了"：',
    '不要回应它、不要复述它、不要总结它、不要替它补没说过的话。】',
    timeline,
    '【流水结束】',
    '',
    `主人现在说：${text}`,
  ].join('\n');
}

/** 从可能带 markdown 围栏的文本里抠出 JSON。 */
function parseLooseJson(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return { topic: '', conclusions: [], open: [], observations: [], raw: s };
  try {
    const o = JSON.parse(s.slice(start, end + 1));
    return {
      topic: String(o.topic ?? ''),
      conclusions: Array.isArray(o.conclusions) ? o.conclusions.map(String) : [],
      open: Array.isArray(o.open) ? o.open.map(String) : [],
      observations: Array.isArray(o.observations) ? o.observations.map(String) : [],
      raw: s,
    };
  } catch {
    return { topic: '', conclusions: [], open: [], observations: [], raw: s };
  }
}

export class Dispatcher {
  /**
   * @param {object} cfg
   * @param {import('./store.js').Store} [store] 给了就落盘，重启后记录还在
   */
  constructor(cfg, store = null) {
    this.cfg = cfg;
    this.store = store;
    /** @type {Map<string, Conversation>} */
    this.conversations = new Map();
    /** @type {Map<string, TurnTranslator>} 每个会话一个翻译器 */
    this.translators = new Map();
    /** @type {Map<string, string[]>} 会话 → 还没被回应的用户消息 id（用于溯源） */
    this.pending = new Map();
    /** @type {Map<string, object>} messageId → 这一轮的状态（计时器、是否已挪走） */
    this.turns = new Map();
    /** @type {Map<string, string>} 会话 → 用户最近一句（挪成独立任务时的标题） */
    this.lastUserText = new Map();
    /** @type {Set<string>} 已经喂过"前情背景"的会话（每个进程生命周期只喂一次） */
    this.seeded = new Set();

    this.runtime = new AgentRuntime(cfg);
    /** agent 进程状态的推送定时器（开发者模式才真正算） */
    this._telemetryTimer = null;
    /**
     * 监控层：读"用户说了什么 + 用户看到了什么 + 时间戳"，判合理性与时效性。
     * 用**另一个** agent 会话，绝不碰用户那条。
     */
    this.debug = new DebugAgent(cfg, this.runtime, store);
    /** 每个会话上一次叫 debug agent 审查的时间（防止同一个毛病每轮都叫模型） */
    this._debugCooldown = new Map();

    if (store) {
      for (const { conversationId } of store.list()) {
        const conv = restoreConversation(conversationId, store);
        this.conversations.set(conversationId, conv);
        // 启动时对账：上次被打断的任务要收口，不能永远挂着（见 #reconcileTasks）
        this.#reconcileTasks(conv);
      }
    }
  }

  conversation(id) {
    let conv = this.conversations.get(id);
    if (!conv) {
      conv = new Conversation(id, this.store);
      this.conversations.set(id, conv);
    }
    return conv;
  }

  /**
   * 用户说了一句话。
   *
   * **不等待整轮完成就返回** —— 事件是流式推给客户端的。
   */
  say({ conversationId, messageId, text, clientAt = null }) {
    const conv = this.conversation(conversationId);
    conv.emit({
      type: 'user/echo',
      messageId,
      text,
      at: Date.now(),
      // 客户端自己时钟下的发送时刻；算"用户等了多久"要用它
      clientAt: clientAt ?? null,
    });

    const pend = this.pending.get(conversationId) ?? [];
    pend.push(messageId);
    this.pending.set(conversationId, pend);
    /** 这一轮在办什么事（挪成独立任务时给用户看的标题用）。 */
    this.lastUserText.set(conversationId, text);

    const agent = this.#wire(conv);
    devStep(conv, 'turn', 'start', { detail: '交给 agent' });
    agent.prompt(this.#withRecap(conv, text)).catch((err) => this.#fail(conv, err));
  }

  /**
   * 跨重启把"记忆"接回去。
   *
   * 为什么需要：DSH 的 SDK **只能 create 不能 resume**（同名会话日志已存在就报错），
   * 所以服务每次重启，agent 那边都是一个全新的会话 —— 它会忘记你们之前聊过什么。
   * 而我们自己的事件日志是全的，于是把**按时间记下来的流水**给它看一眼，
   * 一次性、只喂一次。
   *
   * ⚠ 给的是**流水**，不是"补出来的对话"（主人 2026-09-14 纠正）：
   * 曾经这里是折成一问一答的摘要，还只留了快答那半句 ——
   * 于是 agent 看到的是一份**缺结论的、补出来的对话**，只能自己往回补。
   * 主人的原话：「不能补齐，反馈完全按时间来说话。」
   * 所以现在给的是原样事件 + 每条自己的时间戳，不配对、不归纳、不补空。
   *
   * 只喂一次：喂过之后这一整个进程生命周期里它就都记得了。
   */
  #withRecap(conv, text) {
    if (this.seeded.has(conv.id)) return text;
    this.seeded.add(conv.id);

    const timeline = timelineContext(conv.log);
    if (!timeline) return text; // 全新会话，没什么可接的

    return recapPrompt(timeline, text);
  }

  /**
   * 重启对账：把**永远挂着的任务**收口。
   *
   * 为什么必须有：界面上那句"还有件事在处理"是客户端**从事件记录重建**的
   *（`task/created` 建、`task/completed` 消）。如果整个服务重启 —— agent 连同
   * 那件正在做的活一起被杀 —— 就没人补 `task/completed` 了，
   * 于是这句话会**永远挂在页面上**，用户一直等一件根本不会再回来的事。
   *
   * 2026-09-14 真实事故：agent 改客户端改到一半重启了服务，任务挂着没收口，
   * 主人半小时后还在页面看到"还有件事在处理"，只好来问"现在在发生什么"。
   *
   * 对账的两条原则：
   *   · **一定收口** —— 宁可少显示一条"在处理"，也不能让用户等一个不会来的结果
   *   · **只对最近的说话** —— 几天前断掉的事就没必要突然冒出来说一句
   */
  #reconcileTasks(conv) {
    const open = new Map();
    for (const e of conv.log) {
      if (e.type === 'task/created') open.set(e.taskId, e);
      else if (e.type === 'task/completed') open.delete(e.taskId);
    }
    if (!open.size) return;

    let newest = 0;
    for (const [taskId, e] of open) {
      newest = Math.max(newest, e.at ?? 0);
      conv.emit({ type: 'task/completed', taskId, reason: 'interrupted' });
    }
    devStep(conv, '对账', 'info', { detail: `收口 ${open.size} 件被打断的事` });

    // 打断得不算久才值得说一句；陈年旧账悄悄清掉就行
    if (Date.now() - newest < 6 * 60 * 60 * 1000) {
      const w = new MessageWriter(conv, {
        messageId: newId('m'),
        agent: 'dispatcher',
        origin: 'proactive',
        re: [],
      });
      // 措辞要准：系统只知道"我被断了"，**不知道**那件活到底做完没有
      //（可能是改到一半被杀，也可能改完了只是没来得及回话）。
      // 所以用"可能" —— 断言"没做完"会是假话。
      w.chunk('deep', '对了，之前那件事我断了，可能没做完。', false);
      w.end();
    }
  }

  /** 手动收口一件任务（运维用；正常情况走对账）。 */
  completeTask(conversationId, taskId, reason = 'completed') {
    const conv = this.conversation(conversationId);
    const exists = conv.log.some((e) => e.type === 'task/created' && e.taskId === taskId);
    const done = conv.log.some((e) => e.type === 'task/completed' && e.taskId === taskId);
    if (!exists || done) return false;
    conv.emit({ type: 'task/completed', taskId, reason });
    return true;
  }

  /**
   * 客户端**断线重连**回来了，判断要不要跟它说一句"我已经升级好了"。
   *
   * 判据两条，缺一不可：
   *   · 调用方已确认这是**断线重连**（不是页面刚打开 —— 页面刚打开说这句是莫名其妙的）
   *   · 这个会话的记录里**没有任何一条事件发生在本进程启动之后**
   *     ⇒ 它见过的最后一段历史来自上一个进程 ⇒ 中间服务重启过
   *
   * ⚠ 第一版漏了前半条，结果**每次重启都往用户对话里塞一句**，
   * 一天下来堆了 7 句一模一样的"我已经升级好了。"（实测，用户来问"页面怎么还在说"）。
   * 所以判据必须包含"他确实被打断了"。
   *
   * 说完之后这个会话在本进程里就有"本进程的事件"了，所以**只会说一遍**
   *（多个设备同时重连也只会有第一个触发）。
   *
   * @returns {boolean} 是否真的说了
   */
  noticeReconnect(conversationId, sinceSeq, serverStartedAt) {
    if (sinceSeq <= 0) return false; // 全新打开，不是"重启后回来"
    const conv = this.conversation(conversationId);
    if (conv.log.some((e) => (e.at ?? 0) >= serverStartedAt)) return false; // 这次启动已经跟他说过话
    if (conv.log.length === 0) return false;

    const w = new MessageWriter(conv, {
      messageId: newId('m'),
      agent: 'dispatcher',
      origin: 'proactive',
      re: [],
    });
    w.chunk('deep', '我已经升级好了。', false);
    w.end();
    devStep(conv, '重启', 'info', { detail: '服务重启过，已告知用户' });
    return true;
  }

  /**
   * **预热**：客户端一连上来就把这个会话的 agent 起好。
   *
   * 为什么要单独一个方法：agent 冷启动实测 **2.7–5.1 秒**，
   * 如果等用户说完第一句话才开始起，他就要白等这 5 秒。
   * 页面一打开（WS 连上）就预热，用户说第一句话时进程已经是热的。
   */
  warm(conversationId) {
    const conv = this.conversation(conversationId);
    this.#wire(conv);
  }

  /** 把翻译器接到这个会话的 agent 上（只接一次）。 */
  #wire(conv) {
    const agent = this.runtime.agent(conv.id);
    let translator = this.translators.get(conv.id);
    if (translator) return agent;

    translator = new TurnTranslator(conv, {
      // 这一轮在回应谁：还有没被回应的用户消息就是 reactive，否则是 agent 自己开口
      nextProvenance: () => {
        const pend = this.pending.get(conv.id) ?? [];
        if (pend.length) {
          this.pending.set(conv.id, []);
          return { origin: 'reactive', re: pend.slice(), interrupts: false };
        }
        // agent 自己开的一轮（例如后台那件事做完了回来说结果）
        return { origin: 'proactive', re: [], interrupts: true };
      },
      onTurnStart: (info) => this.#onTurnStart(conv, info),
      onTurnEnd: (info) => this.#onTurnEnd(conv, info),
      devStep: (phase, status, extra) => devStep(conv, phase, status, extra),
    });
    this.translators.set(conv.id, translator);

    agent.on('session-event', (params) => translator.handle(params));

    agent.on('status', ({ status }) => {
      if (status === 'running') conv.emit({ type: 'message/status', messageId: '', state: 'working' });
    });

    agent.on('subagent', (msg) => {
      if (msg.method === 'subagent.started') {
        devStep(conv, 'subagent', 'start', { detail: '派了一个子 agent 去做' });
      } else {
        devStep(conv, 'subagent', 'end', { detail: `子 agent ${msg.params?.status ?? '结束'}` });
      }
    });

    agent.on('exit', ({ code, wasReady, stderrTail }) => {
      // 进程死了：这一轮必须收口，不能让用户等一个不会再来的答案
      const cur = translator.forceClose('failed');
      if (cur) this.#legalClose(conv, FAILED_LINE);
      devStep(conv, 'agent', 'error', {
        detail: wasReady ? `agent 进程退出 code=${code}` : `agent 起不来：${String(stderrTail).slice(-160)}`,
      });
      this.translators.delete(conv.id);
    });

    agent.on('protocol-error', (e) => devStep(conv, 'agent', 'error', { detail: JSON.stringify(e).slice(0, 160) }));

    // 起进程（异步，失败会走上面的 exit / catch）
    agent.start().catch((err) => devStep(conv, 'agent', 'error', { detail: String(err?.message ?? err) }));

    return agent;
  }

  // ── 节奏 ───────────────────────────────────────────────────

  #onTurnStart(conv, info) {
    // 这一轮太久了就挪出当前对话（判据是**要多久**，不是"简单还是复杂"）
    info.handoffTimer = setTimeout(() => {
      if (this.turns.get(info.writer.messageId) !== info) return; // 已经收口了
      if (info.escalated) return;
      info.escalated = true;
      this.#escalate(conv, info);
    }, this.cfg.escalateAfterMs);

    info.deadlineTimer = setTimeout(() => {
      if (this.turns.get(info.writer.messageId) !== info) return;
      const cur = this.translators.get(conv.id)?.forceClose('failed');
      if (cur) this.#legalClose(conv, FAILED_LINE);
      devStep(conv, 'turn', 'error', { detail: `超过单轮上限 ${this.cfg.turnDeadlineMs}ms，强制收口` });
    }, this.cfg.turnDeadlineMs);

    this.turns.set(info.writer.messageId, info);
  }

  #onTurnEnd(conv, info) {
    clearTimeout(info.handoffTimer);
    clearTimeout(info.deadlineTimer);
    this.turns.delete(info.writer.messageId);
    if (info.escalated) {
      conv.emit({ type: 'task/completed', taskId: info.taskId });
    }
    this.#watch(conv);
  }

  /**
   * 监控层：一轮收口后看一眼"这一轮从时效性上对不对"。
   *
   * 分两级，为的是既不漏也不贵：
   *   1. **计量**（纯算，不花钱）→ 每一轮都做，结果直接进开发卡片
   *   2. **判断**（叫 debug agent，花钱）→ 只有规则报出问题时才叫，
   *      而且同一个会话有冷却时间，免得同一个毛病每轮都去问一遍
   */
  #watch(conv) {
    let timeliness;
    try {
      timeliness = this.debug.measure(conv);
    } catch (err) {
      devStep(conv, '监控', 'error', { detail: String(err?.message ?? err).slice(0, 60) });
      return;
    }
    const latest = timeliness.turns[timeliness.turns.length - 1];
    if (latest) {
      const fmt = (v) => (v == null ? '—' : `${v}ms`);
      devStep(conv, '时效', 'info', {
        detail: `首句 ${fmt(latest.firstLineMs)} ｜ 整轮 ${fmt(latest.turnEndMs)} ｜ 空窗 ${fmt(latest.longestGapMs)}`,
      });
    }

    // 说"我单独拿去做"却一直没回来 —— 静默失败，最危险
    const stuck = stuckTasks(conv.log);
    for (const st of stuck) {
      devStep(conv, '监控', 'error', { detail: `任务挂着没完成：${st.title.slice(0, 30)}` });
    }

    const findings = [...ruleFindings(timeliness), ...stuck];
    if (!findings.length) return;

    // 规则说有问题 —— 叫 debug agent 判语义（后台，不挡用户）
    const last = this._debugCooldown.get(conv.id) ?? 0;
    if (Date.now() - last < 60000) return;
    this._debugCooldown.set(conv.id, Date.now());
    this.debug
      .review(conv)
      .then((report) => {
        const n = report.tasks.length;
        devStep(conv, '监控', 'info', {
          detail: `发现 ${report.ruleFindings.length + (report.judgment?.problems?.length ?? 0)} 个问题，${n} 条任务`,
        });
        for (const t of report.tasks) {
          conv.emit({ type: 'debug/task', taskId: t.id, title: t.title, created: t.created });
        }
      })
      .catch((err) => devStep(conv, '监控', 'error', { detail: String(err?.message ?? err).slice(0, 60) }));
  }

  /** 这一轮太久了：说"我单独拿去做"，并把它变成一件**在做的可见的事**。 */
  #escalate(conv, info) {
    const taskId = newId('task');
    info.taskId = taskId;

    // ★ 先把 agent 手上那条气泡**收口**，它后面的话会另起一条。
    //   不收的话答案会写回上面那条气泡里 —— 用户看到"上面的气泡在'我拿去做'
    //   之后还在往后长"，也就是**时间倒流**（主人报的"你在补齐对话"）。
    this.translators.get(conv.id)?.handoff();
    // 标题面向用户，用**用户自己的话**，不是内部任务名
    const userText = this.lastUserText.get(conv.id) ?? '';
    const title = userText.length > 24 ? `${userText.slice(0, 24)}…` : userText || '这件事';

    const w = new MessageWriter(conv, {
      messageId: newId('m'),
      agent: 'dispatcher',
      origin: 'reactive',
      re: [],
    });
    w.chunk('quick', HANDOFF_LINE, false);
    w.end();

    conv.emit({
      type: 'task/created',
      taskId,
      messageId: w.messageId,
      title,
      at: Date.now(),
    });
  }

  /** 失败时补一句合法收尾（复用固定话术，语气与人格一致）。 */
  #legalClose(conv, text) {
    const w = new MessageWriter(conv, {
      messageId: newId('m'),
      agent: 'dispatcher',
      origin: 'reactive',
      re: [],
    });
    w.chunk('deep', text, false);
    w.end();
  }

  #fail(conv, err) {
    devStep(conv, 'turn', 'error', { detail: String(err?.message ?? err).slice(0, 160) });
    const cur = this.translators.get(conv.id)?.forceClose('failed');
    if (!cur) this.#legalClose(conv, FAILED_LINE);
  }

  // ── 中止 ───────────────────────────────────────────────────

  /**
   * 中止调度器当前输出。
   *
   * ⚠ 诚实的边界：SDK 协议**没有**"取消这一轮"的能力，所以 agent 会继续在后台算完；
   * 我们能做的是**不再把它的话放给用户**（已显示的字撤不回来，只追加说明）。
   */
  cancel(conversationId) {
    const conv = this.conversation(conversationId);
    const translator = this.translators.get(conversationId);
    const cur = translator?.forceClose('aborted');
    if (!cur) return false;
    devStep(conv, 'turn', 'info', { detail: '用户中止，agent 后台仍在算完' });
    this.turns.delete(cur.writer.messageId);
    return true;
  }

  /**
   * **监控层**：读对话记录做总结。
   *
   * 它刻意用**另一个** agent 会话（`monitor:<会话>`），不碰用户对话那条会话 ——
   * 「总结我们刚才聊的」这种事如果塞进用户会话，就把元问题写进了正史。
   * 但它仍然是个真 agent（会自己判断、可以调用工具），不是一个裸模型调用。
   */
  async summarize(conversationId, transcriptText) {
    const monitor = this.runtime.agent(`monitor:${conversationId}`);
    const prompt = [
      '你是一个**记录员**。下面是一段对话记录，你的任务是总结它，不要回答记录里的问题。',
      '只输出 JSON，字段固定：',
      '{ "topic": "一句话主题", "conclusions": ["已经定下来的结论"],',
      '  "open": ["还没解决、待办的事"], "observations": ["你注意到的值得记的事"] }',
      '不要编造记录里没有的内容。',
      '',
      '------ 对话记录开始 ------',
      transcriptText,
      '------ 对话记录结束 ------',
    ].join('\n');
    const raw = await monitor.ask(prompt);
    return parseLooseJson(raw);
  }

  // ── 生命周期 ───────────────────────────────────────────────

  async shutdown() {
    clearInterval(this._telemetryTimer);
    this._telemetryTimer = null;
    for (const info of this.turns.values()) {
      clearTimeout(info.handoffTimer);
      clearTimeout(info.deadlineTimer);
    }
    this.turns.clear();
    await this.runtime.shutdown();
  }

  /**
   * 开始把 **agent 进程状态**推给开发者模式。
   *
   * 为什么要有：一个会话一个常驻 agent 进程，每个 150–200MB。
   * 这东西**看不见就会失控** —— 内存涨、僵尸进程、反复重启，页面上一点征兆都没有。
   * 所以让开发卡片能实时看到：几个进程、各自在干什么、吃多少内存、重启了几次。
   *
   * 只在有人开着开发者模式时才真的算（`emitDevSnapshot` 里挡了）。
   */
  startAgentTelemetry(intervalMs = 3000) {
    if (this._telemetryTimer) return;
    const tick = () => {
      try {
        const snap = this.runtime.stats();
        for (const conv of this.conversations.values()) {
          conv.emitDevSnapshot({ type: 'dev/agents', ...snap });
        }
      } catch {
        /* 遥测失败绝不能影响聊天 */
      }
    };
    this._telemetryTimer = setInterval(tick, intervalMs);
    this._telemetryTimer.unref?.();
    tick();
  }

  /** 给健康检查用（不含任何用户内容）。 */
  stats() {
    return this.runtime.stats();
  }
}
