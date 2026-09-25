// **转交（handoff）** —— 手册 `02-ARCHITECTURE.md` §3.5 那三件里的第一件
// （契约 `docs/dev/100-DISPATCHER-D.md`；不变量 **N16**；决策 **D10.4**）。
//
// ── 这一层是什么 ────────────────────────────────────────────
// 手册 §3.5 的目标态（**照抄，不改**）：
//
//   A 正在回答（同一条消息，同一个气泡）
//     ├─ ① A 调用 handoff_to(scope, reason)     ← ⚠️ **工具调用**，不是自然语言
//     ├─ ② A 那条消息**不收口**，状态置 handoff  → 客户端显示"马上说完"
//     ├─ ③ 调度器组装交接包 → 交给 B
//     └─ ④ B 接着往**同一条消息**里写
//
// 这个文件只放两样东西：
//   · `decideHandoff()` —— **裁决本体**（纯函数：能反着验、不碰盘、不碰时钟）；
//   · `HandoffBook`     —— 那本**落盘的账**（谁转给谁 / 哪条消息 / 为什么）。
//
// ── 三条硬规矩（§三 的 D-1/D-2/D-3，每条都带反例）────────────
//   1. **只有工具调用能发起**（D-1）：正文里写"我转给某一间"**不算** ——
//      这条不在这个文件里实现，而是**结构上成立**：`record()` 只可能从
//      MCP 那条工具口（`op:'handoff'`）进来，正文那条路（`session-translate`）
//      里根本没有这个函数的入口。检测关键词 = "自然语言当控制面"，明确不做。
//   2. **一轮最多一次 ＋ 禁回环**（D-2 · 手册 N16 点名 `A→B→A`）：
//      同一条 `messageId` 只许有一条转交记录（⇒ 一轮一次），
//      而且**已经在这次转交链上出现过的作用域**不许再当目标（⇒ 回环被拒）。
//   3. **目标必须已存在**（D-3）：**不建** —— 认不出就拒，绝不"顺手建一个"。
//
// ── 🔴 标签语义（§6.2，别走样）────────────────────────────────
//   转交续写的事件 `scopeId` 打**发起那一间**（用户看得见的那一间）：
//   前后半段同一个标签 ⇒ 视图不裂、客户端一个气泡。
//   "谁在干活"**另加一个字段** `byScope`，**只**用于审计/用量 ——
//   **不许**拿干活者当可见标签。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

/**
 * 这条账认不出的那几种，各自一句**能给模型看**的话。
 *
 * ⚠️ 它们是**模型读到的**（会被它转述给人），所以：**不许出现内部词**
 *    （工具名 / scope id / 机制名都不行），而且要说清"那就别转"。
 */
export const HANDOFF_LINES = Object.freeze({
  self: '这一间就是你自己那一间，不用转。接着说你的。',
  twice: '这条消息已经转出去过了，一次只说一次。接着说你的。',
  loop: '这一间刚才就是这条消息的发起处，转回去只会转圈。接着说你的。',
  missing: '没有那一间，我没有替你新建。接着说你的。',
  noMessage: '这会儿没有一条正在说的消息可以转，先接着说完这一条。',
});

/**
 * 转交**被拒**时抛这个。`reason` 是机器认的档（判据打在上面），
 * `text` 是给人/模型看的人话（`HANDOFF_LINES` 里那几句）。
 */
export class HandoffError extends Error {
  constructor(reason, text, status = 409) {
    super(text ?? reason);
    this.name = 'HandoffError';
    this.reason = reason;
    this.text = text ?? reason;
    this.status = status;
  }
}

/**
 * **这条转交许不许发**（裁决本体 · 纯函数 · N16）。
 *
 * @param {object} o
 * @param {string} o.by        **发起那一间**（谁在说这句话）
 * @param {string} o.target    **想转给哪一间**（用户/模型给的）
 * @param {boolean} o.targetExists 那一间**现在存在吗**（由 `Worlds` 说了算）
 * @param {string|null} [o.messageId] 这次转交挂在哪条消息上
 * @param {Array<object>} [o.records] 这条消息上**已经有过**的转交记录
 *        （`HandoffBook.byMessage()` 给的那几条；空 = 这是头一次）
 * @returns {{ok: true} | {ok: false, reason: string, text: string}}
 */
export function decideHandoff({ by, target, targetExists, messageId = null, records = [] } = {}) {
  const t = typeof target === 'string' ? target.trim() : '';
  const b = typeof by === 'string' ? by.trim() : '';
  if (t === '' || t === b) return { ok: false, reason: 'self', text: HANDOFF_LINES.self };
  // ★ **一轮最多一次**（N16 前半）：**这一间**在这条消息上已经转出去过一次了。
  //   ⚠️ 认的是"发起处"是不是自己（`r.scopeId === b`）—— 别人转的不算我头上。
  if (records.some((r) => r?.scopeId === b)) {
    return { ok: false, reason: 'twice', text: HANDOFF_LINES.twice };
  }
  // ★ **禁回环**（N16 后半 · 手册点名 `A→B→A`）：**想去的那一间**在这条消息上
  //   已经当过发起处 ⇒ 转过去就是转圈。`records` 就是那条链的凭据。
  //   ⚠️ 这一条要排在"目标存不存在"**前面**：回环是**语义**问题，
  //      换一个存在的房也照样是回环。
  if (records.some((r) => r?.scopeId === t)) {
    return { ok: false, reason: 'loop', text: HANDOFF_LINES.loop };
  }
  // ★ **目标必须已存在**（N16 末句 · D-3）：**不建**。
  if (targetExists !== true) return { ok: false, reason: 'missing', text: HANDOFF_LINES.missing };
  return { ok: true };
}

/** 这一格存哪（**跟人走**：每个用户一份世界，各有各的账）。 */
export function handoffsPath(dir) {
  return nodePath.join(dir, 'handoffs.jsonl');
}

/**
 * **转交那本账**（落盘 · 一个人一本）。
 *
 * ⚠️ **为什么必须落盘**：D-7 那一条（"agent 被回收前结果必须在盘上"）要的
 *    就是它 —— 转交的续写要接得上**同一条消息**，而那个凭据不能只在内存里
 *    （agent 会被卸下、服务会重启，重启之后那条消息不能变成"永远不收口"）。
 *
 * 形状（一行一条 JSON）——**只加不改**：
 *
 *   {"type":"handoff","id":…,"at":…,"scopeId":"A","target":"B","messageId":"u_1",
 *    "reason":…,"turn":3,"generation":1,"status":"recorded","byScope":null}
 *   {"type":"handoff","id":…,"at":…,"status":"adopted","byScope":"B"}     ← 后面这几条是**状态推进**
 *   {"type":"handoff","id":…,"at":…,"status":"completed","byScope":"B"}
 *
 * 重建时**同 id 最后一条说了算**（追加式推进 —— 与 `worklog.js` 那条路同形）。
 */
export class HandoffBook {
  #dir;
  #log;
  #file;
  #clock;
  #byId = new Map();
  #order = [];

  /**
   * @param {object} o
   * @param {string} o.dir  这个人的那一格（`world.dir`）
   * @param {() => number} [o.clock]
   * @param {(m: string) => void} [o.log]
   */
  constructor({ dir, clock = Date.now, log = () => {} } = {}) {
    if (!dir) throw new Error('HandoffBook 需要 dir');
    this.#dir = dir;
    this.#log = log;
    this.#file = handoffsPath(dir);
    this.#clock = clock;
    this.#load();
  }

  get path() {
    return this.#file;
  }

  /** 从头读一遍盘（构造时一次；重启之后也是它）。 */
  #load() {
    let raw = '';
    try {
      raw = nodeFs.readFileSync(this.#file, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') this.#log(`转交那本账没读出来：${err?.message ?? err}`);
      return;
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // 半行 / 坏行：跳过（**不许**把整本账带走）
      }
      if (!rec || typeof rec.id !== 'string') continue;
      const had = this.#byId.get(rec.id);
      if (had) {
        // 推进：同 id 后一条说了算（只覆盖状态那几个字段，别的原样保留）
        Object.assign(had, rec);
      } else {
        this.#byId.set(rec.id, rec);
        this.#order.push(rec.id);
      }
    }
  }

  #append(rec) {
    nodeFs.mkdirSync(this.#dir, { recursive: true });
    nodeFs.appendFileSync(this.#file, `${JSON.stringify(rec)}\n`);
  }

  /** 全部记录（按落盘先后）。诊断 / 判据用。 */
  all() {
    return this.#order.map((id) => ({ ...this.#byId.get(id) }));
  }

  /** **这条消息上**已经发生过的转交（`decideHandoff` 要的那份凭据）。 */
  byMessage(messageId) {
    if (typeof messageId !== 'string' || messageId === '') return [];
    return this.all().filter((r) => r.messageId === messageId);
  }

  byId(id) {
    const r = this.#byId.get(id);
    return r ? { ...r } : null;
  }

  /** 已经转出去、**还没被接过去**的那些（一条消息最多一条，但仍按表列）。 */
  pending() {
    return this.all().filter((r) => r.status === 'recorded');
  }

  /**
   * **记一条转交**（`decideHandoff` 放行之后才叫它）。
   *
   * @param {object} o
   * @param {number} [o.now]
   * @returns {object} 落盘的那一条
   */
  record({ scopeId, target, messageId, reason = null, turn = null, generation = null, now = this.#clock() }) {
    const rec = {
      type: 'handoff',
      id: `h_${now.toString(36)}_${(this.#order.length + 1).toString(36)}`,
      at: now,
      // ★ **发起那一间**（用户看得见的那一间 · §6.2）——**不是**干活者。
      scopeId,
      target,
      messageId,
      reason: typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : null,
      turn: Number.isInteger(turn) ? turn : null,
      generation: Number.isInteger(generation) ? generation : null,
      // `recorded` = 还没人接；`adopted` = 目标已经开始往同一条里写；`completed` = 收口了。
      status: 'recorded',
      // 🔴 **谁在干活**（审计/用量归因）——**只**在这里出现，绝不当可见标签（§6.2）。
      byScope: null,
    };
    this.#append(rec);
    this.#byId.set(rec.id, rec);
    this.#order.push(rec.id);
    return { ...rec };
  }

  /**
   * **目标把这条消息接过去**（B 开写）：把 `byScope` 记成**真正的干活者**。
   * ⚠️ `scopeId` **不动** —— 可见标签还是发起那一间（§6.2）。
   */
  adopt({ id, byScope, now = this.#clock() } = {}) {
    const had = this.#byId.get(id);
    if (!had) return null;
    if (had.status === 'recorded') {
      const rec = { type: 'handoff', id, at: now, status: 'adopted', byScope };
      this.#append(rec);
      Object.assign(had, rec);
    }
    return { ...had };
  }

  /** 这条转交收口了（续写那条消息 `message/end` 落盘之后）。 */
  complete({ id, now = this.#clock() } = {}) {
    const had = this.#byId.get(id);
    if (!had) return null;
    if (had.status !== 'completed') {
      const rec = { type: 'handoff', id, at: now, status: 'completed' };
      this.#append(rec);
      Object.assign(had, rec);
    }
    return { ...had };
  }
}
