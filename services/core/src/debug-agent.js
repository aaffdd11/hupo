// 调试/监控 agent：**看着这个对话到底好不好**。
//
// 创始人要求：
//   「你另外有个 debug 的 agent，用来监控用户说的和用户看到的反馈，
//    你要去分析合理性并且如果有修改就要变成任务。
//    尤其注意，所有对话要有时间戳。这样你才能看到反馈和响应从时效性来说对不对。」
//
// 所以它看两样东西：
//   1. **用户说了什么** —— `user/echo`（带客户端时钟 clientAt）
//   2. **用户看到了什么** —— `message/start|text|end`（服务端 at）+ `message/seen`（客户端时钟）
//
// 产出两样东西：
//   · **时效性**：纯算，不要钱、每一轮都算（等第一句多久、等结论多久、中间空窗多长）
//   · **合理性**：要判语义，交给一个真 agent —— 但**只在规则触发时才叫它**（省钱也省时）
//
// 发现的问题变成**任务**（data/debug/tasks.json），不是写完就扔的日志。

import fs from 'node:fs';
import path from 'node:path';
import { comfortFindings, personalityBlock, profileFromRows, PersonalityStore } from './personality.js';

// ── 阈值：超过就当"不对劲"，触发模型判断 ────────────────────
// 为什么是这些数：用户的原话是"判据是要多久"。第一句超过 6 秒、
// 整轮超过 30 秒、中间空窗超过 8 秒，人就会开始怀疑它是不是卡住了。
export const THRESHOLDS = {
  firstLineMs: 6000,
  turnEndMs: 30000,
  longestGapMs: 8000,
  conclusionMs: 20000,
};

/** 留客式追问 —— 主人明令禁止的说话方式。 */
const FORBIDDEN_PATTERNS = [
  /要不要我/,
  /需要我(展开|继续|详细|补充)/,
  /还想了解什么/,
  /接下来可以(做什么|怎么)/,
];

/**
 * 把事件流折成"一轮一轮"。
 *
 * 一轮 = 用户说一句（user/echo）→ 到它引发的最后一条 message/end。
 * 主动消息（没有对应 user/echo）单独成轮，origin=proactive。
 */
export function computeTurns(log) {
  const turns = [];
  let cur = null;

  const close = () => {
    if (cur) turns.push(cur);
    cur = null;
  };

  for (const e of log) {
    if (e.type === 'user/echo') {
      close();
      cur = {
        userSeq: e.seq,
        userMessageId: e.messageId,
        userText: e.text,
        userAt: e.at ?? null,
        clientAt: e.clientAt ?? null,
        origin: 'reactive',
        messages: [],
      };
      continue;
    }
    if (!cur) {
      // 主动开口：没有用户输入也能有一轮
      if (e.type === 'message/start') {
        cur = {
          userSeq: null,
          userMessageId: null,
          userText: '',
          userAt: e.at ?? null,
          clientAt: null,
          origin: e.origin ?? 'proactive',
          messages: [],
        };
      } else {
        continue;
      }
    }
    if (e.type === 'message/start') {
      cur.messages.push({
        messageId: e.messageId,
        origin: e.origin ?? 'reactive',
        interrupts: e.interrupts === true,
        startAt: e.at ?? null,
        firstTextAt: null,
        conclusionAt: null,
        endAt: null,
        reason: null,
        text: '',
        sources: 0,
        firstSeenAt: null,
        endedSeenAt: null,
      });
      continue;
    }

    const m = cur.messages[cur.messages.length - 1];
    switch (e.type) {
      case 'message/text':
        if (m) {
          if (m.firstTextAt == null && String(e.text ?? '').trim()) m.firstTextAt = e.at ?? null;
          if (e.block === 'deep' && String(e.text ?? '').trim() && m.conclusionAt == null) {
            m.conclusionAt = e.at ?? null;
          }
          m.text += e.text ?? '';
        }
        break;
      case 'message/end':
        if (m && m.messageId === e.messageId) {
          m.endAt = e.at ?? null;
          m.reason = e.reason ?? null;
          m.sources = Array.isArray(e.sources) ? e.sources.length : 0;
        }
        break;
      case 'message/seen':
        if (m && m.messageId === e.messageId) {
          m.firstSeenAt = e.clientFirstSeenAt ?? null;
          m.endedSeenAt = e.clientEndedSeenAt ?? null;
        }
        break;
      default:
        break;
    }
  }
  close();
  return turns;
}

/**
 * "客户端说的时间"可不可信。
 *
 * 为什么需要：客户端回报"我看到了"时用的是**它自己的钟**。如果那个钟是在
 * 页面刷新之后才记的（补发被当成了"刚看到"），算出来就会离谱 ——
 * 实测出现过"用户等了 14 秒"，而服务端记录只有 2.7 秒。
 *
 * 判据：客户端口径最多只能比服务端口径**多一点点**（网络 + 渲染）。
 * 多出 [SKEW_TOLERANCE_MS] 以上就说明这条回报的参照点不对，丢掉不采。
 */
const SKEW_TOLERANCE_MS = 5000;

/**
 * 建了但一直没完成的任务。
 *
 * 为什么单列一条规则：`task/created` 是因为"这件事比我想的久，我单独拿去做"，
 * 正常情况下很快会有 `task/completed`。**长期挂着不完成 = 那件活被打断了** ——
 * 最典型的就是 agent 在改东西的中途把自己重启了（2026-09-14 真实事故：
 * 主人让改浮窗，代码改对了，然后它重启服务把自己杀掉，任务永远挂在那里，
 * 主人等了半小时什么都没等到）。
 *
 * 这种"静默失败"最危险，因为它看起来像"还在做"。
 */
export function stuckTasks(log, { now = Date.now(), graceMs = 5 * 60 * 1000 } = {}) {
  const open = new Map();
  for (const e of log) {
    if (e.type === 'task/created') open.set(e.taskId, e);
    else if (e.type === 'task/completed') open.delete(e.taskId);
  }
  const out = [];
  for (const [taskId, e] of open) {
    const ageMs = now - (e.at ?? now);
    if (ageMs < graceMs) continue;
    out.push({
      taskId,
      title: e.title ?? '',
      ageMs,
      severity: 'high',
      kind: 'reasonableness',
      what: `「${String(e.title ?? '').slice(0, 20)}」这件事说"我单独拿去做"已经 ${Math.round(ageMs / 60000)} 分钟了，一直没回来`,
      why: '要么是被打断了（例如中途重启了自己），要么是后台那件活失败了没兜底 —— 两种都是静默失败，用户以为还在做',
    });
  }
  return out;
}

/** 算每一轮的时效性数字。**纯计算，不花钱**，所以每轮都能算。 */
export function computeTimeliness(turns) {
  const rows = [];
  for (const t of turns) {
    const msgs = t.messages.filter((m) => m.startAt != null);
    if (!msgs.length) continue;

    const first = msgs[0];
    const last = msgs[msgs.length - 1];
    const marks = msgs.flatMap((m) => [m.startAt, m.firstTextAt, m.conclusionAt, m.endAt]).filter((x) => x != null);

    // 中间最长空窗：相邻标记之间的最大间隔（用户会以为卡住的就是这一段）
    let longestGapMs = 0;
    for (let i = 1; i < marks.length; i++) {
      longestGapMs = Math.max(longestGapMs, marks[i] - marks[i - 1]);
    }

    const firstTextAt = msgs.map((m) => m.firstTextAt).find((x) => x != null) ?? null;
    const conclusionAt = msgs.map((m) => m.conclusionAt).find((x) => x != null) ?? null;
    const endAt = last.endAt;
    // 客户端看到的时刻（同一把钟，所以能和 clientAt 相减）
    const seenFirst = msgs.map((m) => m.firstSeenAt).find((x) => x != null) ?? null;
    const seenEnd = msgs.map((m) => m.endedSeenAt).find((x) => x != null) ?? null;

    const firstLineMs = firstTextAt && t.userAt ? firstTextAt - t.userAt : null;
    const turnEndMs = endAt && t.userAt ? endAt - t.userAt : null;
    const rawSeenFirst = seenFirst && t.clientAt ? seenFirst - t.clientAt : null;
    const rawSeenEnd = seenEnd && t.clientAt ? seenEnd - t.clientAt : null;
    const believable = (clientMs, serverMs) => {
      if (clientMs == null) return null;
      if (serverMs != null && clientMs - serverMs > SKEW_TOLERANCE_MS) return null;
      return clientMs;
    };

    rows.push({
      userAt: t.userAt,
      userText: t.userText,
      origin: t.origin,
      /** 用户说完 → 第一句话（**服务端**口径） */
      firstLineMs,
      /** 用户说完 → 他**看到**第一句（客户端口径，最贴近体感） */
      firstLineSeenMs: believable(rawSeenFirst, firstLineMs),
      conclusionMs: conclusionAt && t.userAt ? conclusionAt - t.userAt : null,
      turnEndMs,
      endedSeenMs: believable(rawSeenEnd, turnEndMs),
      longestGapMs,
      messages: msgs.length,
      tools: 0,
      reason: last.reason,
      text: msgs.map((m) => m.text).join(''),
      sources: msgs.reduce((a, m) => a + m.sources, 0),
    });
  }

  const pick = (key) => rows.map((r) => r[key]).filter((x) => typeof x === 'number');
  const percentile = (arr, p) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
  };

  return {
    turns: rows,
    summary: {
      turns: rows.length,
      firstLineMsP50: percentile(pick('firstLineMs'), 0.5),
      firstLineSeenMsP50: percentile(pick('firstLineSeenMs'), 0.5),
      turnEndMsP50: percentile(pick('turnEndMs'), 0.5),
      turnEndMsWorst: pick('turnEndMs').length ? Math.max(...pick('turnEndMs')) : null,
      longestGapMsWorst: pick('longestGapMs').length ? Math.max(...pick('longestGapMs')) : null,
    },
  };
}

/** 规则检查：**不要钱**，先用它决定要不要叫模型。 */
export function ruleFindings(timeliness) {
  const out = [];
  for (const r of timeliness.turns) {
    // 时间戳补齐之前写的旧事件没有 endAt / firstTextAt，量不出东西 ——
    // 对它们下判断只会产生假问题，直接跳过。
    if (r.turnEndMs == null && r.firstLineMs == null) continue;

    const who = r.userText ? `「${r.userText.slice(0, 18)}」` : '（它自己开的一轮）';

    if (r.firstLineMs != null && r.firstLineMs > THRESHOLDS.firstLineMs) {
      out.push({
        severity: r.firstLineMs > 12000 ? 'high' : 'medium',
        kind: 'timeliness',
        what: `${who} 等了 ${r.firstLineMs}ms 才听到第一句话`,
        why: `超过 ${THRESHOLDS.firstLineMs}ms 用户会怀疑没接住`,
      });
    }
    if (r.turnEndMs != null && r.turnEndMs > THRESHOLDS.turnEndMs) {
      out.push({
        severity: 'medium',
        kind: 'timeliness',
        what: `${who} 整轮用了 ${r.turnEndMs}ms`,
        why: `超过 ${THRESHOLDS.turnEndMs}ms 就该考虑挪成独立的事（说"我拿去做"）`,
      });
    }
    if (r.longestGapMs > THRESHOLDS.longestGapMs) {
      out.push({
        severity: 'medium',
        kind: 'timeliness',
        what: `${who} 中间有 ${r.longestGapMs}ms 完全没有输出`,
        why: `空窗超过 ${THRESHOLDS.longestGapMs}ms，用户会以为卡住了`,
      });
    }
    for (const re of FORBIDDEN_PATTERNS) {
      if (re.test(r.text)) {
        out.push({
          severity: 'high',
          kind: 'reasonableness',
          what: `${who} 的回答里出现了留客式追问：${r.text.match(re)[0]}`,
          why: '主人明令禁止：不留人、不追问',
        });
        break;
      }
    }
    if (r.reason === 'failed') {
      out.push({
        severity: 'high',
        kind: 'reasonableness',
        what: `${who} 这一轮没给出结论`,
        why: '失败必须有合法收尾，且要查清为什么失败',
      });
    }
    // 已经报过"没给出结论"的就不用再报"一句话都没说" —— 同一条毛病报两次是噪音
    if (!r.text.trim() && r.reason !== 'failed') {
      out.push({
        severity: 'high',
        kind: 'reasonableness',
        what: `${who} 一句话都没说`,
        why: 'R：绝不能沉默',
      });
    }
  }
  return out;
}

/** 任务簿：发现问题就落成任务，不是写完就扔的日志。 */
export class TaskBook {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'debug');
    this.file = path.join(this.dir, 'tasks.json');
    fs.mkdirSync(this.dir, { recursive: true });
    this.tasks = this._read();
  }

  _read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  _write() {
    fs.writeFileSync(this.file, JSON.stringify(this.tasks, null, 2));
  }

  list({ status } = {}) {
    return status ? this.tasks.filter((t) => t.status === status) : this.tasks;
  }

  /**
   * 任务指纹。
   *
   * 为什么不能拿标题直接比：同一个毛病，debug agent 每次的措辞都不一样
   *（"空窗 9477ms" / "中间有 9477ms 完全没有输出" / "到结论之间最长空窗 9477ms"）——
   * 精确匹配挡不住改写，任务簿一下就堆了几十条同义条目（实测踩过）。
   *
   * 所以先把"措辞"磨掉：去掉数字、去掉引用的用户原话、压平空白，只留问题的骨架。
   * 代价是"不同的数字"会并成一条 —— 但那本来就是**同一个问题**（它只是又发生了一次），
   * 合并后 seenCount 会累加，反而更准。
   */
  /**
   * 问题**类别**：从措辞里认出"这是哪一类毛病"。
   *
   * 为什么光去重数字还不够：同一类毛病，机械规则说「中间有 11792ms 完全没有输出」，
   * debug agent 说「第一句 959ms 就出来了，但之后到结论之间空窗 11792ms」——
   * 措辞差得远，指纹挡不住，任务簿里就堆了三条一样的（实测）。
   * 按类别立项才稳：**一类毛病 = 一条任务**，seenCount 累加说明它反复发生。
   */
  static issueClass(text) {
    const t = String(text ?? '');
    if (/空窗|没有输出|没输出|干等|一直没(有)?(回|响应)/.test(t)) return 'gap';
    if (/第一句|首句|第一句话/.test(t)) return 'firstline';
    if (/整轮|一轮用(了|时)/.test(t)) return 'turnlen';
    if (/来源|出处|引用|数据来自/.test(t)) return 'sources';
    if (/矛盾|不一致|对不上|自相|前后/.test(t)) return 'consistency';
    if (/要不要我|留客|追问|挽留/.test(t)) return 'pushy';
    if (/没给出结论|没结果|只有开场白|只输出|当结论|没有结论/.test(t)) return 'noconclusion';
    if (/编造|幻觉|不实|凭空|没查就|凭记忆/.test(t)) return 'fabrication';
    if (/迎合|奉承|讨好|谄媚|空夸|顺着他说|漂亮话/.test(t)) return 'flattery';
    if (/说话方式|篇幅|长短|短句|长篇|太客套|太啰嗦|太简短|贴合|习惯|敬语/.test(t)) return 'style-fit';
    return 'other';
  }

  static key(title, kind = '') {
    return `${kind}:${TaskBook.issueClass(title)}`;
  }

  static keyLegacy(title) {
    return String(title)
      .replace(/「[^」]*」/g, '「…」') // 引用的用户原话
      .replace(/\d+/g, '#') // 具体数字
      .replace(/[，。；：、,.;:!?！？\s]+/g, '') // 标点空白
      .slice(0, 48);
  }

  add({ title, detail, severity = 'medium', kind = 'debug', conversationId = null }) {
    const key = TaskBook.key(title, kind);
    const existing = this.tasks.find((t) => t.status === 'open' && t.key === key);
    if (existing) {
      existing.seenCount = (existing.seenCount ?? 1) + 1;
      existing.lastSeenAt = new Date().toISOString();
      // 保留最近一次的具体描述（数字是新的，比旧的更有用）
      existing.detail = detail;
      existing.title = title;
      this._write();
      return { task: existing, created: false };
    }
    const task = {
      id: `dbg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      key,
      title,
      detail,
      severity,
      kind,
      conversationId,
      status: 'open',
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      seenCount: 1,
    };
    this.tasks.push(task);
    this._write();
    return { task, created: true };
  }

  complete(id) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return null;
    t.status = 'done';
    t.doneAt = new Date().toISOString();
    this._write();
    return t;
  }
}

/**
 * 从 agent 的回复里抠出**第一个完整的 JSON 对象**。
 *
 * 为什么不用 indexOf('{')…lastIndexOf('}')：agent 经常在 JSON 后面再补一段
 * 说明文字（里面还带花括号），那样切出来的就不是合法 JSON —— 实测把审查整个搞崩过。
 * 这里按括号配对扫描，取第一个配平的对象。
 */
export function extractJsonObject(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const DEBUG_PERSONA = `你是一个**挑剔的调试员**，专门审查"助手"刚才这一轮回答好不好。
你不是助手本人，不要回答用户的问题，只做审查。

你会拿到三样东西：
1. 每一轮的**时效性数字**（用户说完到第一句话、到结论、中间最长空窗，单位毫秒）
2. 每一轮的**原文**（用户说了什么、助手说了什么）
3. 主人的**说话画像**（从对话里统计出来的：长短、直接度、客套程度、情绪基调）

按这个顺序判：
- **时效性**：用户等得是不是太久？中间有没有让人以为卡住的空窗？数字摆在那里，直接引用。
- **合理性**：回答对得上用户问的吗？有没有编造、有没有把"我去查"当结果交出去？
  有没有留客式追问（「要不要我…」）？有没有该查却没查就凭记忆答的？
- **个性适配**：说话的**长短、直接度、客套程度**跟主人的习惯配不配？
  主人要短你写长、主人直接你绕圈、主人不用敬语你堆客套 —— 都算。
- **迎合**：有没有用空夸、附和的漂亮话讨好（「您说得太对了」后面却没有新东西）？
  有没有不敢说不同意见、顺着说？
- **客观**：有没有为了好听而软化事实、含糊数字？结论有没有出处？

主人的原话：「不是迎合，而是让人舒服。不是造假，而是客观讲理。」—— 按这个标准判。

输出**严格 JSON**，不要别的东西：
{
  "verdict": "一句话总评",
  "problems": [
    { "severity": "high|medium|low", "kind": "timeliness|reasonableness|style-fit|flattery",
      "what": "具体是什么问题（引用原文或数字）",
      "fix": "该怎么改（要具体到能动手：改哪个环节/加什么约束）" }
  ]
}
没毛病就输出空的 problems 数组。**不要为了凑数编问题。**`;

/**
 * 监控层本体。
 *
 * @param {object} cfg
 * @param {import('./agent-runtime.js').AgentRuntime} runtime 用另一个 agent 会话，不碰用户那条
 * @param {import('./store.js').Store} [store]
 */
export class DebugAgent {
  constructor(cfg, runtime, store = null) {
    this.cfg = cfg;
    this.runtime = runtime;
    this.store = store;
    this.tasks = new TaskBook(cfg.dataDir);
    /** 主人说话画像（纯计算，每轮更新；不进仓库） */
    this.personalities = new PersonalityStore(cfg.dataDir);
    /** 最近一次分析结果（按会话） */
    this.latest = new Map();
  }

  /** 纯算，不叫模型。每轮都能跑。 */
  measure(conv) {
    const turns = computeTurns(conv.log);
    return computeTimeliness(turns);
  }

  /** 更新主人说话画像（纯计算，随时可跑，不花钱）。 */
  updateProfile(conversationId, timeliness) {
    return this.personalities.update(profileFromRows(timeliness.turns, conversationId));
  }

  /**
   * 跑一次审查。
   *
   * @param {import('./conversation.js').Conversation} conv
   * @param {{ force?: boolean }} [opts] force=true 时即使规则没触发也叫模型
   */
  async review(conv, { force = false } = {}) {
    const timeliness = this.measure(conv);
    // 主人说话画像：每轮都更新，开新 agent 会话时会注入它的上下文
    const profile = this.updateProfile(conv.id, timeliness);
    const comfort = comfortFindings(profile);
    // 「我单独拿去做」却一直没回来 —— 这种静默失败一定要报，
    // 它看起来像"还在做"，用户会一直等（2026-09-14 真实事故）
    const findings = [...ruleFindings(timeliness), ...stuckTasks(conv.log), ...comfort];

    let judged = null;
    // 只在"规则说有问题"或明确要求时才叫模型 —— 每一轮都叫太贵也太慢
    if (force || findings.length) {
      judged = await this.#judge(conv.id, timeliness, findings, profile);
    }

    const report = {
      conversationId: conv.id,
      analyzedAt: new Date().toISOString(),
      timeliness,
      ruleFindings: findings,
      judgment: judged,
      personality: { profile, comfort },
      tasks: [],
    };

    // 该改的就变成任务
    const label = (kind) =>
      ({ timeliness: '时效', 'style-fit': '个性', flattery: '迎合', reasonableness: '回答' })[kind] ?? '回答';
    const candidates = [
      ...findings.map((f) => ({
        title: `${label(f.kind)}：${f.what}`.slice(0, 120),
        detail: `${f.why}\n\n原文/数字：${f.what}`,
        severity: f.severity,
        kind: f.kind,
      })),
      ...(judged?.problems ?? []).map((p) => ({
        title: `${label(p.kind)}：${p.what}`.slice(0, 120),
        detail: `${p.fix}`,
        severity: p.severity ?? 'medium',
        kind: p.kind ?? 'reasonableness',
      })),
    ];
    for (const c of candidates) {
      const { task, created } = this.tasks.add({ ...c, conversationId: conv.id });
      report.tasks.push({ id: task.id, created, title: task.title });
    }

    this.latest.set(conv.id, report);
    this.#append(report);
    return report;
  }

  /** 叫 debug agent 判语义。它用的是**另一个**会话，不污染用户那条。 */
  async #judge(conversationId, timeliness, findings, profile = null) {
    const agent = this.runtime.agent(`debug:${conversationId}`);
    const rows = timeliness.turns.slice(-8).map((r) => ({
      用户说: r.userText || '（它自己开的一轮）',
      第一句话毫秒: r.firstLineMs,
      用户看到第一句毫秒: r.firstLineSeenMs,
      结论毫秒: r.conclusionMs,
      整轮毫秒: r.turnEndMs,
      最长空窗毫秒: r.longestGapMs,
      回答了: r.text.slice(0, 300),
      来源条数: r.sources,
    }));
    const prompt = [
      DEBUG_PERSONA,
      '',
      '── 时效性数字（毫秒）──',
      JSON.stringify(timeliness.summary, null, 2),
      '',
      '── 每一轮 ──',
      JSON.stringify(rows, null, 2),
      '',
      '── 主人的说话画像 ──',
      personalityBlock(profile) ?? '（样本还太少，暂无画像）',
      '',
      '── 机械规则已经报出来的问题 ──',
      JSON.stringify(findings, null, 2),
    ].join('\n');

    try {
      const raw = await agent.ask(prompt, { timeoutMs: 120000 });
      const o = extractJsonObject(raw);
      if (!o) return { verdict: raw.slice(0, 200), problems: [] };
      return {
        verdict: String(o.verdict ?? ''),
        problems: Array.isArray(o.problems)
          ? o.problems.map((p) => ({
              severity: String(p.severity ?? 'medium'),
              kind: String(p.kind ?? 'reasonableness'),
              what: String(p.what ?? ''),
              fix: String(p.fix ?? ''),
            }))
          : [],
      };
    } catch (err) {
      return { verdict: `（审查失败：${err?.message ?? err}）`, problems: [] };
    }
  }

  /** 把每次分析追加落盘，便于回看趋势。 */
  #append(report) {
    try {
      const file = path.join(this.cfg.dataDir, 'debug', `${report.conversationId}.jsonl`);
      fs.appendFileSync(file, `${JSON.stringify(report)}\n`);
    } catch {
      /* 落盘失败不影响主流程 */
    }
  }
}
