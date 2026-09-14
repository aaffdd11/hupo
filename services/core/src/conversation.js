// 会话：事件日志 + 订阅者 + 单调 seq。
//
// seq 由**会话自己**管理（不是全局），因为客户端续传的游标是"这个会话里的位置"。
// 事件全部留在内存日志里，断线重连时按 sinceSeq 补发。

export class Conversation {
  /**
   * @param {string} id
   * @param {import('./store.js').Store} [store] 给了就落盘（监听者要读记录，必须持久）
   */
  constructor(id, store = null) {
    this.id = id;
    this.store = store;
    this.seq = 0;
    /** @type {object[]} 完整事件日志（用于续传） */
    this.log = [];
    /** @type {Set<(event:object)=>void>} 产品事件订阅者 */
    this.subscribers = new Set();
    /** @type {Set<(event:object)=>void>} **开发模式**订阅者（只在 ?dev=1 时才有） */
    this.devSubscribers = new Set();
    /** 后台活动记录（开发卡片用）：最近 N 条 */
    this.devSteps = [];
    /** 消息 id → 文本累积（用于诊断与"用户实际看到了什么"） */
    this.messages = new Map();
    /** 正在做的事 */
    this.tasks = new Map();
    /** 处理队列：用户连续发言时排队，不并发抢话 */
    this.queue = [];
    this.busy = false;
  }

  /**
   * 记录并广播一个事件；seq 与**时间戳**在这里统一分配。
   *
   * ⚠ `at` 是**每一个**事件都必须有的，不是"重要事件才带"。
   * 为什么：没有时间戳就看不出"反馈和响应从时效性来说对不对" ——
   * 用户等了多久才看到第一句、中间空窗多长、哪一步慢，全靠它。
   * 所以放在这里统一加，这样**将来新加的事件也不可能漏掉时间戳**。
   * 调用方自己给了 `at`（例如带上客户端时钟）就以调用方为准。
   */
  emit(event) {
    const withSeq = { at: Date.now(), ...event, seq: ++this.seq };
    this.log.push(withSeq);
    this.store?.append(this.id, withSeq);
    for (const send of this.subscribers) {
      try {
        send(withSeq);
      } catch {
        // 单个订阅者出错不影响其他订阅者
      }
    }
    return withSeq;
  }

  /**
   * 订阅会话事件。
   *
   * ⚠ 语义（踩过坑，别再改回去）：**产品事件永远订上**，`dev` 只是**额外**再订开发事件。
   *
   * 之前这里写的是 `if (dev) { devSubscribers.add(send); return; }` ——
   * 于是开发者模式一开，这条连接就**只收开发事件、收不到任何产品事件**：
   * 用户能看到历史（补发不走订阅，是直接调的），但之后说什么都没有回应。
   * 开发者模式又是**默认开**的 ⇒ 整个应用对所有人都是"哑"的。
   */
  /**
   * 发一个**只在现场**的事件：占一个 seq，但不进日志、不落盘、不参与续传。
   *
   * 用途：像「客户端该刷新了」这种信号 —— 它描述的是**此刻的这一刻**，
   * 迟到就没有意义了（刚连上来的客户端应该自己去 /api/version 对一次，而不是收到一堆旧的刷新令）。
   */
  emitTransient(event) {
    const withSeq = { at: Date.now(), ...event, seq: ++this.seq };
    for (const send of this.subscribers) {
      try {
        send(withSeq);
      } catch {
        // 单个订阅者出错不影响其他订阅者
      }
    }
    return withSeq;
  }

  subscribe(send, { dev = false } = {}) {
    this.subscribers.add(send);
    if (dev) this.devSubscribers.add(send);
    return () => {
      this.subscribers.delete(send);
      this.devSubscribers.delete(send);
    };
  }

  /**
   * 发一个**开发事件**：只给开启了开发者模式的连接。
   *
   * 分开通道的原因：这些事件描述的是**内部实现**（分类、专家、检索…），
   * 产品界面不需要、也不该依赖它们。将来要隐藏开发者模式时，
   * 服务端这边直接不发即可，产品协议一行不用改。
   */
  emitDev(event) {
    const withAt = { at: Date.now(), ...event };
    this.devSteps.push(withAt);
    if (this.devSteps.length > 60) this.devSteps.shift();
    for (const send of this.devSubscribers) {
      try {
        send(withAt);
      } catch {
        // 忽略单个订阅者错误
      }
    }
  }

  /**
   * 发一份**只在现场**的开发快照（不进 devSteps、不补发给后连的人）。
   *
   * 为什么跟 emitDev 分开：`devSteps` 是**流水**（有前后顺序、按顺序补发），
   * 而进程状态是**快照**（只有"现在"有意义）。把快照塞进流水，
   * 新连上来的人会收到一堆过期的进程状态。
   */
  emitDevSnapshot(payload) {
    if (this.devSubscribers.size === 0) return; // 没人在看就别算
    const withAt = { at: Date.now(), ...payload };
    for (const send of this.devSubscribers) {
      try {
        send(withAt);
      } catch {
        // 忽略单个订阅者错误
      }
    }
  }

  /** 新订阅者进来时，把它错过的活动补上。 */
  replayDev(send) {
    for (const step of this.devSteps) send(step);
  }

  /** 续传：把 sinceSeq 之后的事件补发给一个订阅者。 */
  replay(sinceSeq, send) {
    for (const event of this.log) {
      if (event.seq > sinceSeq) send(event);
    }
  }
}

/** 从已落盘的事件恢复一个会话（重启后记录不丢）。 */
export function restoreConversation(id, store) {
  const events = store.read(id);
  const conv = new Conversation(id, store);
  for (const e of events) {
    conv.log.push(e);
    if (typeof e.seq === 'number' && e.seq > conv.seq) conv.seq = e.seq;
    if (e.type === 'message/text') {
      conv.messages.set(e.messageId, (conv.messages.get(e.messageId) || '') + e.text);
    }
  }
  return conv;
}

/** 事件构造辅助：文字消息的发送器。 */
export class MessageWriter {
  /**
   * @param {Conversation} conv
   * @param {object} opts
   * @param {string} opts.messageId
   * @param {string} opts.agent     内部哪个 agent 说的
   * @param {'reactive'|'proactive'} [opts.origin]
   * @param {string[]} [opts.re]
   * @param {boolean} [opts.interrupts]
   */
  constructor(conv, { messageId, agent, origin = 'reactive', re = [], interrupts = false, sources = [] }) {
    this.conv = conv;
    this.messageId = messageId;
    this.agent = agent;
    this.origin = origin;
    this.re = re;
    this.interrupts = interrupts;
    /** 这条消息依据的**可核查来源**（真的搜过才有）。让用户能自己去看。 */
    this.sources = sources;
    this.blockSeq = { quick: 0, deep: 0 };
    this.started = false;
    this.ended = false;
    this.text = '';
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.conv.emit({
      type: 'message/start',
      messageId: this.messageId,
      origin: this.origin,
      re: this.re,
      interrupts: this.interrupts,
      agent: this.agent,
      ...(this.sources?.length ? { sources: this.sources } : {}),
      at: Date.now(),
    });
  }

  status(state) {
    this.start();
    this.conv.emit({ type: 'message/status', messageId: this.messageId, state });
  }

  chunk(block, text, isFinal = false) {
    if (!text && !isFinal) return;
    this.start();
    this.text += text;
    this.conv.emit({
      type: 'message/text',
      messageId: this.messageId,
      block,
      seqInBlock: this.blockSeq[block]++,
      text,
      final: isFinal,
    });
    this.conv.messages.set(this.messageId, this.text);
  }

  error(code, message) {
    this.start();
    this.conv.emit({ type: 'error', messageId: this.messageId, code, message });
  }

  end(reason = 'completed') {
    if (this.ended) return;
    this.ended = true;
    this.start();
    // 来源可能**晚于** message/start 才知道（"收到，我先去查…"先发出去了，
    // 工具跑完才拿到 sources）。所以结束事件里带一份**最终**来源，客户端以它为准。
    this.conv.emit({
      type: 'message/end',
      messageId: this.messageId,
      reason,
      ...(this.sources?.length ? { sources: this.sources } : {}),
    });
  }
}

/**
 * 把流式文本切成"段"。
 *
 * ⚠ 关键纪律：**只在标点处切，绝不从词中间劈开**。
 * 之前用"25 字硬切"把「起床点」切成了「起床」+「点」，读起来是坏的。
 *
 * 实测支撑（评审结论 3.1）：中文自然句 p50 约 24 字 —— 所以正常情况
 * 标点很快就会到，不需要靠硬切。只有极长的无标点串才用长度兜底。
 */
export function makeSegmenter(onSegment, { softMax = 25, hardMax = 120 } = {}) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      let guard = 0;
      while (guard++ < 200) {
        const cut = findCut(buffer, softMax, hardMax);
        if (cut <= 0) break;
        const seg = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut);
        if (seg) onSegment(seg);
      }
    },
    flush() {
      const rest = buffer.trim();
      buffer = '';
      if (rest) onSegment(rest);
    },
  };
}

/** 找切点：优先句末标点；其次软上限内的逗号；都没有就等（或超长兜底）。 */
function findCut(text, softMax, hardMax) {
  const hard = ['。', '！', '？', '…', '；', '\n'];
  for (let i = 0; i < text.length; i++) {
    if (hard.includes(text[i])) return i + 1;
  }
  // 够长了：退到软上限之内的最后一个逗号（逗号处切也是完整的停顿）
  if (text.length >= softMax) {
    const window = text.slice(0, Math.max(softMax, 40));
    const soft = Math.max(
      window.lastIndexOf('，'),
      window.lastIndexOf('、'),
      window.lastIndexOf(','),
      window.lastIndexOf('：'),
    );
    if (soft > 0) return soft + 1;
  }
  // 极长且始终没有标点：才允许兜底硬切（正常中文不会走到这里）
  if (text.length >= hardMax) return hardMax;
  return 0;
}

/**
 * 把事件日志还原成**一条按时间排的流水**，喂给 agent 当"刚才说到哪了"。
 *
 * 没有它：追问指代（「那再帮我改一下」）无法解析，模型只能瞎猜或编。
 *
 * ⚠ 为什么不"折成一问一答"（主人 2026-09-14 纠正，别再改回去）：
 * 折轮 = **往回补对话** —— 把"用户说过的话"和"助手回过的话"拼成一对一对，
 * 拼不上的地方只能丢或猜。实测两个后果：
 *   · 只取快答 ⇒ **结论被丢掉**，agent 只看到自己说过"收到，我去查…"，
 *     以为没答过，于是又答一遍（这就是"补齐"的来路）
 *   · agent 读到的不是发生过的事实，而是一份**补出来的对话**，于是跟着补
 * 主人的原话：「不能补齐，反馈完全按时间来说话。」
 * 所以这里只做一件事：**按时间顺序，原样列出发生过的事件**，
 * 不配对、不归纳、不补空。每条都带自己的时间戳。
 *
 * @param {object[]} log 会话事件日志
 * @param {number} maxTurns 最多回溯几条用户发言
 */
export function timelineContext(log, maxTurns = 8) {
  const events = [];
  for (const e of log) {
    const text = String(e.text ?? '');
    if (!text.trim()) continue;
    if (e.type === 'user/echo') {
      events.push({ who: '主人', at: e.at ?? null, text: text.trim() });
    } else if (e.type === 'message/text') {
      events.push({ who: '你', at: e.at ?? null, text: text.trim() });
    }
  }
  if (!events.length) return '';

  // 当前这句输入（最后一条用户发言）不算背景，它由调用方单独接在后面
  let cut = events.length;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].who === '主人') {
      cut = i;
      break;
    }
  }
  const before = events.slice(0, cut);
  if (!before.length) return '';

  // 再往前只留最近 maxTurns 条用户发言
  let start = 0;
  let seen = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    if (before[i].who === '主人') {
      seen++;
      if (seen >= maxTurns) {
        start = i;
        break;
      }
    }
  }

  return before
    .slice(start)
    .map((e) => `${clock(e.at)}  ${e.who}：${e.text}`)
    .join('\n');
}

/** 流水里的时间戳（本地钟）。只用来看先后和间隔，不做别的判断。 */
function clock(at) {
  if (!at) return '--:--:--';
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const newId = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
