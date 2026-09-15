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

import fs from 'node:fs';

import { AgentRuntime } from './agent-runtime.js';
import { DebugAgent, ruleFindings, stuckTasks } from './debug-agent.js';
import { comfortFindings, personalityBlock, PersonalityStore } from './personality.js';
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

/**
 * 被打断的活**接着做完**的边界（见 #reconcileTasks）。
 *
 * 为什么要有上限：处理层可以被无限重启，但一件活不能无限重派 ——
 * 试三次还做不成，说明它不是"被打断"，是**根本做不到**（缺权限、缺信息、
 * 或者主人要的东西本身有问题）。那时候要如实收口，不能假装还在做。
 */
const RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_RESUME_ATTEMPTS = 3;
/**
 * 开机最多接着做几件 —— **全进程合计**，不是每会话。
 *
 * ⚠ 旧实现是 `slice(0, 2)`，而 `#reconcileTasks` 是**按会话**调的：
 * 于是"最多 2 件"实际是"每个会话最多 2 件" —— 10 个会话有残留任务时开机会起 20 个 agent，
 * 每个 ~172MB，直接把 1G 顶爆。拍板第 10 条改成全进程合计 1 件。
 */
const MAX_RESUME_TOTAL = Number(process.env.CONCIERGE_MAX_RESUME_TOTAL || 1);
/** 续做前看内存：占用比 ≥ 这个值就不续做（过一会儿再看）。与准入闸同阈值。 */
const MEMORY_GATE_RATIO = Number(process.env.CONCIERGE_MEMORY_GATE || 0.75);
/** 被闸拦下时隔多久再看一次 —— 不烧活、也不假装在做。 */
const RESUME_RETRY_MS = Number(process.env.CONCIERGE_RESUME_RETRY_MS || 5 * 60 * 1000);
/** 重试次数上限：12 × 5 分钟 = 1 小时，仍在 6 小时窗口内。 */
const RESUME_RETRY_MAX = 12;

/**
 * 本进程所在 cgroup 的内存占用比（0~1）。读不到 / 没有限额 ⇒ 返回 0（不拦）。
 *
 * 为什么读 cgroup 而不是 `process.memoryUsage()`：真正会顶爆 1G 的是**整个 cgroup**
 * （调度器 + 所有 agent + 构建），单个 Node 进程的 RSS 看不出这件事。
 * 为什么限定"本服务自己的 cgroup"：跑测试或手工起服务时进程不在 concierge 的 cgroup 里，
 * 那时的比例毫无意义，拿它拦续做只会让行为随机。
 */
export function memoryPressure() {
  try {
    const line = fs
      .readFileSync('/proc/self/cgroup', 'utf8')
      .split('\n')
      .find((l) => l.startsWith('0::'));
    const rel = line ? line.slice(3).trim() : '';
    if (!/concierge/i.test(rel)) return 0;
    const base = `/sys/fs/cgroup${rel}`;
    const cur = Number(fs.readFileSync(`${base}/memory.current`, 'utf8').trim());
    const maxRaw = fs.readFileSync(`${base}/memory.max`, 'utf8').trim();
    if (!Number.isFinite(cur) || maxRaw === 'max') return 0;
    const max = Number(maxRaw);
    if (!Number.isFinite(max) || max <= 0) return 0;
    return cur / max;
  } catch {
    return 0; // 读不到就不拦 —— 宁可少拦一次，也不要因为读文件失败就不续做
  }
}

/**
 * 续做的开场白：**把主人的原话再给一遍**。
 *
 * 为什么不用"你刚才做到哪了"这种问法：处理层是**无状态**的（它读的是工作区里
 * 真实的文件和状态），所以不需要恢复内存 —— 只要原话给它，它自己会接着干。
 * 这也是为什么事件记录里必须存**原文**（旧记录只存了 24 字的标题）。
 */
function resumePrompt(task) {
  return [
    `【接着做完】你之前接了下面这件事，做到一半被打断了（这是第 ${task.attempts + 1} 次接手）。`,
    `主人的原话：「${task.prompt}」`,
    '接着把它做完。做完直接说结果 —— 用你自己的话，一句结论，不要复述这段说明。',
    '如果这件事要改代码、改系统、重启服务：先把改动做完并验证生效，再回来说结果。',
  ].join('\n');
}

export class Dispatcher {
  /**
   * @param {object} cfg
   * @param {import('./store.js').Store} [store] 给了就落盘，重启后记录还在
   * @param {{ runtime?: import('./agent-runtime.js').AgentRuntime }} [opts]
   *   runtime 可注入（测试用：不用真起 dsh 进程）
   */
  constructor(cfg, store = null, { runtime } = {}) {
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
    /** @type {Map<string, string>} 会话 → 正在续做的那件任务（这一轮结束要收口） */
    this.resumed = new Map();
    /** 本进程已经派出去了几件续做（**全进程合计**，见 MAX_RESUME_TOTAL） */
    this._resumedTotal = 0;
    /** @type {Map<string, number>} 会话 → 被内存/预算闸拦下后重试过几次 */
    this._resumeRetry = new Map();
    /** @type {Set<NodeJS.Timeout>} 重试定时器（关服务时要清掉） */
    this._resumeTimers = new Set();
    /** 降级启动（跳过续做）时为 true —— 见构造器里的说明 */
    this.degraded = false;

    this.runtime = runtime ?? new AgentRuntime(cfg);
    /** agent 进程状态的推送定时器（开发者模式才真正算） */
    this._telemetryTimer = null;
    /**
     * 监控层：读"用户说了什么 + 用户看到了什么 + 时间戳"，判合理性与时效性。
     * 用**另一个** agent 会话，绝不碰用户那条。
     */
    this.debug = new DebugAgent(cfg, this.runtime, store);
    /** 主人说话画像：新 agent 会话开场时注入（让人舒服，不迎合 —— 见 personality.js） */
    this.personality = new PersonalityStore(cfg.dataDir);
    /** 每个会话上一次叫 debug agent 审查的时间（防止同一个毛病每轮都叫模型） */
    this._debugCooldown = new Map();

    if (store) {
      // 降级启动：上次是被 OOM 打断的（或正处在崩溃环里）⇒ **不续做**，只服务对话。
      // 不这么做的话闭环是：起不来 → RestartSec 后重启 → 对账把同一件重活重派 → 又 OOM。
      // 由 hupo-crash-guard 决定（5 分钟内 ≥3 次启动、且上次日志里有 oom-kill）。
      const degraded = process.env.CONCIERGE_SKIP_RESUME === '1';
      this.degraded = degraded;
      if (degraded) {
        console.warn('[调度器] 降级启动：跳过续做（CONCIERGE_SKIP_RESUME=1）');
      }
      for (const { conversationId } of store.list()) {
        const conv = restoreConversation(conversationId, store);
        this.conversations.set(conversationId, conv);
        if (degraded) {
          // 不续做，但也不能把"还有件事在处理"永远挂着 —— created/completed 必须配对
          for (const t of this.#openTasks(conv)) {
            conv.emit({ type: 'task/completed', taskId: t.taskId, reason: 'degraded-start' });
          }
        } else {
          // 启动时对账：上次被打断的任务要收口，不能永远挂着（见 #reconcileTasks）
          this.#reconcileTasks(conv);
        }
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
    const first = !this.seeded.has(conv.id);
    this.seeded.add(conv.id);

    const timeline = timelineContext(conv.log);
    let base = timeline ? recapPrompt(timeline, text) : text;

    // 主人说话画像：新 agent 进程的第一条 prompt 里带上（进程生命周期里它自己会记住）。
    // 画像只调"怎么说话"，不调结论 —— 迎合/造假的边界由人格硬规则管（见 personality.js）。
    if (first) {
      const block = personalityBlock(this.personality.get(conv.id));
      if (block) base = `${block}\n\n${base}`;
    }
    return base;
  }

  /**
   * 重启对账：**被打断的活接着做完，而不是宣布失败**。
   *
   * ⚠ 2026-09-15 纠偏。主人原话：「接收到系统修改任务，并没有修改系统。」
   *
   * 旧行为（错的）：服务一重启，正在做的那件事就报一句"我断了，可能没做完"，
   * 然后**活真的没了**。实测：15:02 主人让它做一个天气小程序，15:02:42 它说
   * "我单独拿去做"，15:08 服务重启（为了部署别的改动），那件活当场蒸发 ——
   * 主人要的东西一样没做出来，只收到一句"我断了"。
   *
   * 根因：**活的命挂在处理层进程上**。分配器（永续）只在记录里写了
   * "有这么一件事"，没有任何"接着做"的机制。
   *
   * 现在按架构分工来：
   *   · **分配器永续** —— 它记得每一件没做完的活（原话、试过几次）
   *   · **处理层可死可重启** —— 进程没了不要紧，分配器重新派一个新的去做
   *   · **做完交回分配器** —— 那一轮结束就收口（见 #onTurnEnd）
   *
   * 只有三种情况才真放弃：太久（6 小时）、试太多次（3 次）、或者连原话都没存下来。
   * 放弃也要收口 —— 界面上那句"还有件事在处理"是客户端从事件记录重建的，
   * 配对不能破（否则用户一直等一件不会回来的事）。
   */
  #reconcileTasks(conv) {
    const open = this.#openTasks(conv);
    if (!open.length) return;

    const now = Date.now();
    const resumable = [];
    let abandoned = 0;
    let recentAbandoned = 0;

    for (const t of open) {
      const ageMs = now - (t.at ?? now);
      const attempts = this.#resumeAttempts(conv, t.taskId);
      const canResume =
        ageMs <= RESUME_WINDOW_MS &&
        attempts < MAX_RESUME_ATTEMPTS &&
        String(t.prompt ?? '').trim();
      if (canResume) {
        resumable.push({ ...t, attempts });
      } else {
        // 真放弃：太久、试太多次、或者连"主人要什么"都没存下来
        conv.emit({ type: 'task/completed', taskId: t.taskId, reason: 'interrupted' });
        abandoned += 1;
        if (ageMs <= RESUME_WINDOW_MS) recentAbandoned += 1;
      }
    }

    // 只挑最近的几件接着做（开机一瞬间起一堆 agent 进程会把内存顶爆）。
    // 两道闸：① 全进程合计预算（**不是每会话**）② 内存占用比。
    // 预算与阈值可被 cfg 覆盖（测试用；生产走常量 / 环境变量）
    const budget = Number(this.cfg.maxResumeTotal ?? MAX_RESUME_TOTAL);
    const gate = Number(this.cfg.memoryGateRatio ?? MEMORY_GATE_RATIO);
    const pressure = memoryPressure();
    const room = Math.max(0, budget - this._resumedTotal);
    let gated = '';
    let picks = [];
    if (room <= 0) {
      gated = `全局续做预算已用完（${budget} 件）`;
    } else if (pressure >= gate) {
      gated = `内存占用 ${Math.round(pressure * 100)}% ≥ ${Math.round(gate * 100)}%`;
    } else {
      picks = resumable.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, room);
    }

    // 被闸拦下的活：**不烧掉、也不假装在做** —— 过一会儿再看一次（有次数上限）。
    // 这样既不会在内存紧张时把服务顶爆，也不会因为"开机那一刻恰好很满"就丢掉主人的活。
    if (gated && resumable.length) {
      const tried = this._resumeRetry.get(conv.id) ?? 0;
      if (tried < RESUME_RETRY_MAX) {
        this._resumeRetry.set(conv.id, tried + 1);
        const timer = setTimeout(() => this.#reconcileTasks(conv), RESUME_RETRY_MS);
        timer.unref?.();
        this._resumeTimers.add(timer);
        devStep(conv, '对账', 'info', {
          detail: `暂不续做（${gated}），${Math.round(RESUME_RETRY_MS / 60000)} 分钟后再看一次`,
        });
      } else {
        // 重试也超了：如实收口，不能让主人一直等一件不会自己回来的事
        for (const t of resumable) {
          conv.emit({ type: 'task/completed', taskId: t.taskId, reason: 'deferred' });
          abandoned += 1;
          recentAbandoned += 1;
        }
      }
    }

    if (picks.length) {
      // 先说一句：主人得知道这件事**没有烂在那儿**
      const w = new MessageWriter(conv, {
        messageId: newId('m'),
        agent: 'dispatcher',
        origin: 'proactive',
        re: [],
      });
      w.chunk('deep', '对了，之前那件事我接着做完，完了跟你说。', false);
      w.end();
      for (const t of picks) this.#resume(conv, t);
    }

    if (recentAbandoned) {
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

    devStep(conv, '对账', 'info', {
      detail: `接着做 ${picks.length} 件 ｜ 放弃 ${abandoned} 件`,
    });
  }

  /**
   * 从事件记录里读出**还没做完的活** —— 这就是"分配器永续"的那份账。
   *
   * `prompt` 是主人的**原话**：旧记录里没有（那时只存了 24 字标题），
   * 所以往回找这条任务之前最后一句 `user/echo` 兜底。
   */
  #openTasks(conv) {
    const open = new Map();
    let lastUserText = '';
    for (const e of conv.log) {
      if (e.type === 'user/echo') {
        lastUserText = String(e.text ?? '');
      } else if (e.type === 'task/created') {
        open.set(e.taskId, {
          taskId: e.taskId,
          title: e.title ?? '',
          at: e.at ?? null,
          prompt: String(e.prompt ?? lastUserText ?? ''),
        });
      } else if (e.type === 'task/completed') {
        open.delete(e.taskId);
      }
    }
    return [...open.values()];
  }

  /**
   * 这件活**真正**续做过几次（防止"做不成"的活无限重派）。
   *
   * ⚠ 要减掉 `resume-excused`：进程被 OOM 杀掉、上游挂了 —— 这些**不是活的问题**，
   * 不该算进那 3 次额度。不然主人收到的是"可能没做完"，
   * 而真相是机器把它杀了两遍（实测踩过的假话）。
   */
  #resumeAttempts(conv, taskId) {
    const resumed = conv.log.filter((e) => e.type === 'task/resumed' && e.taskId === taskId).length;
    const excused = conv.log.filter((e) => e.type === 'task/resume-excused' && e.taskId === taskId).length;
    return Math.max(0, resumed - excused);
  }

  /**
   * 这一轮失败**不是活的问题** ⇒ 不烧续做额度。
   * 由两条路径调用：agent 进程退出/OOM（`exit`）、prompt 被拒（`#fail`）。
   */
  #excuseResume(conv, reason) {
    const taskId = this.resumed.get(conv.id);
    if (!taskId) return;
    conv.emit({ type: 'task/resume-excused', taskId, reason, at: Date.now() });
    devStep(conv, '续做', 'info', { detail: `失败豁免（${reason}）：不消耗重试额度` });
  }

  /**
   * 把一件没做完的活**重新派给处理层**。
   *
   * 分配器永续、处理层可死可重启 —— 这就是两者之间那条线：
   * 分配器记得"有这么一件事、主人是怎么说的、试过几次"，
   * 处理层每次都是新进程，接着做靠的是**原话 + 工作区的真实状态**，不是内存。
   */
  #resume(conv, task) {
    conv.emit({ type: 'task/resumed', taskId: task.taskId, attempts: task.attempts + 1 });
    this.resumed.set(conv.id, task.taskId);
    this._resumedTotal += 1;
    const agent = this.#wire(conv);
    agent.prompt(this.#withRecap(conv, resumePrompt(task))).catch((err) => this.#fail(conv, err));
    devStep(conv, '续做', 'start', {
      detail: `第 ${task.attempts + 1} 次接手：${String(task.title).slice(0, 24)}`,
    });
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
      // ⚠ 先豁免续做额度、再收口：进程被杀**不是活的问题**（OOM / 崩溃），
      //   不该消耗"试三次就放弃"的额度 —— 否则主人收到的是假话。
      this.#excuseResume(conv, `agent-exit:${code ?? 'signal'}`);
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
    // 续做的那件活：这一轮结束 = 处理层把它交回分配器了 ⇒ 收口
    //（用户那边的"还有件事在处理"必须消掉，不能挂着）
    const resumedId = this.resumed.get(conv.id);
    if (resumedId && resumedId !== info.taskId) {
      this.resumed.delete(conv.id);
      // 交回分配器 ⇒ 释放全局续做名额（否则名额只减不加，后面的活永远等不到）
      this._resumedTotal = Math.max(0, this._resumedTotal - 1);
      conv.emit({ type: 'task/completed', taskId: resumedId, reason: 'completed' });
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
    // 主人说话画像：每轮都更新（纯计算不花钱），新 agent 会话开场就用最新版
    const profile = this.debug.updateProfile(conv.id, timeliness);
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

    const findings = [...ruleFindings(timeliness), ...stuck, ...comfortFindings(profile)];
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
      // ⚠ 存**原话**：万一处理层半路被杀，分配器要能拿着这句话重新派一件活出去
      //（只存 24 字标题是不够的 —— 实测丢过"未来 7 天"这种关键限定）
      prompt: userText,
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
    this.#excuseResume(conv, 'prompt-failed');
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
    for (const t of this._resumeTimers ?? []) clearTimeout(t);
    this._resumeTimers?.clear();
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
