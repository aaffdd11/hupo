// **逐件落盘的"手上还有哪些活"**（契约 `docs/dev/88-P1-TIME-WAIT.md` §一.1 / §二.2 / §二.3）。
//
// ── 它替掉的是什么 ────────────────────────────────────────
// 改前"进程里还有哪件活"只有一个**全局 busy 布尔**（`turn-status.js`）：
// 它只回答"**现在**手上有没有话"，答不了"**是哪几件**、什么时候开的、
// 是谁让做的、做完了没有"。于是：
//   · 硬杀 → 重启之后**答不出**"那件怎么样了"（`87` §⑤.6 点名的第一件该做的事）；
//   · 并行/挂起无处可查（`86` §五 的挂起/并行正落在这一层）；
//   · 通知无法逐件收口（不知道哪件该提醒）。
//
// ── 三条不许破（契约 §二）────────────────────────────────
//   ① 🔴 **一件活只有三种结局**：做完（`done`）／被明确取消（`cancelled`）／
//      挂着等（`waiting` / `running`）。**没有"消失"** —— 被硬杀、超时、进程退了，
//      都要**落一条收口**（`stopped`，人话是"已停"），不许让记录留在半空里。
//   ② 🔴 **逐件可查**：每件记 `(scopeId, turn/ref, 状态, 起止时间, 票)`，
//      重启后逐件答得出"还在 / 已停 / 做完了"。
//   ③ 🔴 **配对键是 `(agentGeneration, turn)`**（契约 §二.1）：轮号在每个进程里
//      从 1 重来，单靠 `turn` 会跨进程串号；所以配对键里必须带**进程代号**。
//
// ── 为什么另起一条日志（不并进 `main.jsonl`）──────────────────
// 这是**内部账**，不是"他看到的字"：
//   · 手册 `02-ARCHITECTURE.md` §四 与决策 **P-l** 管的是**对用户可见**的那一条
//     时间线；本账不进 `Timeline`，所以不占号、不改 `/api/timeline` 的语义
//     （契约 §五.2 明确**不改**它的既有语义）；
//   · `00-PROGRESS.md` #123 实测：`store.append` 写的 `seq` 由内存 `Timeline` 决定，
//     往同一条日志里热并会**撞号** —— 内部账另起一条文件，从构造上避开那个坑。
// ⇒ 它落在 `<数据目录>/pending.jsonl`，append-only，写失败**上抛**（`store.js` 的契约）。
//
// ── 它是"判断"还是"记录" ──────────────────────────────────
// 盘上那份是**记录**（append-only，可复算）；内存那份只是它的索引。
// 所以 `seed()` 永远可以从盘上把账重建出来 —— 重启不需要额外状态。

import nodeFs from 'node:fs';

/** 这本账住在哪个文件（`Store.pathFor(WORK_LOG)` ⇒ `pending.jsonl`）。 */
export const WORK_LOG = 'pending';

/** 开口（也用来把票绑到轮上）。 */
export const WORK_OPEN = 'work/open';
/** 收口（三种结局之一）。 */
export const WORK_CLOSE = 'work/close';

/** 一件活能停在哪儿。**开着的只有前两个**。 */
export const WORK_STATES = Object.freeze({
  /** 投出去了、还没变成轮（`deliver` 收下了）。 */
  waiting: 'waiting',
  /** 轮已经开了，正在做。 */
  running: 'running',
  /** 做完了。 */
  done: 'done',
  /** **他明说**别做了（唯一合法的"停"）。 */
  cancelled: 'cancelled',
  /** 断了 / 超时 / 被硬杀 —— "已停"，**不是"没发生过"**。 */
  stopped: 'stopped',
});

/** 开着的两个状态。 */
export const OPEN_STATES = Object.freeze([WORK_STATES.waiting, WORK_STATES.running]);
/** 收口的三个结局（契约 §二.2 的三种结局，`stopped` 是"挂着"的诚实收口）。 */
export const CLOSED_OUTCOMES = Object.freeze([
  WORK_STATES.done,
  WORK_STATES.cancelled,
  WORK_STATES.stopped,
]);

/** 这件活是开着的吗。 */
export function isOpen(state) {
  return OPEN_STATES.includes(state);
}

/** 这张票的键（没绑轮之前的身份）。 */
export function ticketId(scopeId, ref) {
  return `t:${scopeId}:${ref}`;
}

/** **一对一轮**的键：`(scopeId, agentGeneration, turn)`。 */
export function turnId(scopeId, generation, turn) {
  return `r:${scopeId}:${generation}:${turn}`;
}

/** `(agentGeneration, turn)` 的字符串键（配对用，**不许**靠顺序）。 */
export function pairKey(generation, turn) {
  return `${generation}\u0000${turn}`;
}

/** 一件活的对外回答（**机器名**；人话在 `work-words.js`）。 */
export function answerStateOf(rec) {
  if (!rec) return 'unknown';
  if (rec.state === WORK_STATES.running) return 'running';
  if (rec.state === WORK_STATES.waiting) return 'waiting';
  if (rec.state === WORK_STATES.done) return 'done';
  if (rec.state === WORK_STATES.cancelled) return 'cancelled';
  if (rec.state === WORK_STATES.stopped) return 'stopped';
  return 'unknown';
}

/** 一份"这份账现在长什么样"的摘要（诊断 / 判据用）。 */
export function summarize(items) {
  const out = { total: 0, open: 0, running: 0, waiting: 0, done: 0, cancelled: 0, stopped: 0 };
  for (const r of items) {
    out.total += 1;
    if (isOpen(r.state)) out.open += 1;
    if (out[r.state] !== undefined) out[r.state] += 1;
  }
  return out;
}

/**
 * 从盘上那份账**复算**"有没有票没配对"。
 *
 * ⚠️ 这是**纯函数**（只吃事件，不碰 IO）—— 判据直接喂它构造的两种反例：
 *   · 删掉一条收口行 ⇒ 那件活的票**有票无收口**；
 *   · 删掉一条开口行 ⇒ 那件活**查无此件**（对外一个字的账都没有）。
 *
 * @param {object} o
 * @param {object[]} [o.timelineEvents] 可见时间线的事件（找 `user/echo` 当票）
 * @param {object[]} [o.workEvents]     本账的事件（`work/open` / `work/close`）
 * @returns {{paired: number, open: number, unclosed: object[], noRecord: object[], orphan: object[]}}
 */
export function auditWork({ timelineEvents = [], workEvents = [] } = {}) {
  const tickets = [];
  for (const e of timelineEvents) {
    if (e?.type === 'user/echo' && typeof e.messageId === 'string' && e.messageId !== '') {
      tickets.push({ ref: e.messageId, scopeId: e.scopeId ?? 'main' });
    }
  }
  const items = replayWork(workEvents);
  const byRef = new Map();
  for (const r of items.values()) {
    if (r.ref) byRef.set(`${r.scopeId}\u0000${r.ref}`, r);
  }

  const unclosed = [];
  const noRecord = [];
  let paired = 0;
  for (const t of tickets) {
    const r = byRef.get(`${t.scopeId}\u0000${t.ref}`);
    if (!r) {
      noRecord.push({ ref: t.ref, scopeId: t.scopeId, why: '这张票在本账里查无此件' });
      continue;
    }
    if (isOpen(r.state)) {
      unclosed.push({ ref: t.ref, scopeId: t.scopeId, id: r.id, state: r.state, why: '有票无收口' });
      continue;
    }
    paired += 1;
  }

  const knownRefs = new Set(tickets.map((t) => `${t.scopeId}\u0000${t.ref}`));
  const orphan = [];
  for (const r of items.values()) {
    if (!r.ref) continue; // 无票自发轮：**合法**，归属就是 `null`（契约 T1 的反例正身）
    if (!knownRefs.has(`${r.scopeId}\u0000${r.ref}`)) {
      orphan.push({ id: r.id, ref: r.ref, scopeId: r.scopeId, why: '本账有这件活，可见日志里没有那张票' });
    }
  }

  const open = [...items.values()].filter((r) => isOpen(r.state)).length;
  return { paired, open, unclosed, noRecord, orphan };
}

/**
 * **纯重放**：一串 `work/open` / `work/close` → 一件活一张记录。
 *
 * 后到的事件覆盖先到的（`open` 可以再来一次：票绑到轮上时就是再来一次）。
 * 收口是**终态**：已经收口的不许被后来的 `open` 复活。
 */
export function replayWork(workEvents = []) {
  const items = new Map();
  for (const e of workEvents) {
    if (e?.type === WORK_OPEN && typeof e.id === 'string') {
      const had = items.get(e.id);
      if (had && !isOpen(had.state)) continue; // 收了口的不许复活
      items.set(e.id, {
        ...(had ?? {}),
        id: e.id,
        scopeId: e.scopeId ?? had?.scopeId ?? 'main',
        ref: e.ref ?? had?.ref ?? null,
        ticket: e.ticket ?? had?.ticket ?? null,
        generation: e.generation ?? had?.generation ?? null,
        turn: e.turn ?? had?.turn ?? null,
        state: e.state ?? WORK_STATES.waiting,
        // ⚠️ 起止时间**第一次开口时定死**：绑轮那一次不许把 `startedAt` 往后挪
        //    （挪了算出来的耗时就是假的）。
        startedAt: had?.startedAt ?? e.at ?? null,
        closedAt: null,
        outcome: null,
        reason: null,
        promiseId: e.promiseId ?? had?.promiseId ?? null,
      });
      continue;
    }
    if (e?.type === WORK_CLOSE && typeof e.id === 'string') {
      const had = items.get(e.id);
      if (!had) continue; // 收一条没见过的口 = 坏账；上面 `auditWork` 会报出来
      if (!isOpen(had.state)) continue; // 幂等：重复收口不覆盖第一次
      const outcome = CLOSED_OUTCOMES.includes(e.outcome) ? e.outcome : WORK_STATES.stopped;
      items.set(e.id, { ...had, state: outcome, outcome, closedAt: e.at ?? null, reason: e.reason ?? null });
    }
  }
  return items;
}

/**
 * 本账。**写一行就是落一次盘**（`store.append` 失败照抛 —— 那正是我们要的）。
 */
export class WorkLog {
  #store;
  #timelineId;
  #now;
  #log;
  /** id → 记录（内存索引；盘上那份才是权威）。 */
  #items = new Map();
  /** `${scopeId}\u0000${ref}` → id（票 → 活）。 */
  #byRef = new Map();
  /** `${scopeId}\u0000${generation}\u0000${turn}` → id（配对键 → 活）。 */
  #byTurn = new Map();

  /**
   * @param {object} o
   * @param {import('./store.js').Store} o.store
   * @param {string} [o.timelineId] 另起的那条文件（默认 `pending`）
   * @param {() => number} [o.now]
   * @param {(m:string)=>void} [o.log]
   */
  constructor({ store, timelineId = WORK_LOG, now = Date.now, log = () => {} }) {
    if (!store) throw new Error('WorkLog 需要 store（逐件落盘靠它）');
    this.#store = store;
    this.#timelineId = timelineId;
    this.#now = now;
    this.#log = log;
    this.seed();
  }

  /** 从盘上把账重建出来（重启第一步）。**读不懂照抛**（坏账不许静默吞）。 */
  seed() {
    const events = this.#store.readAll(this.#timelineId);
    this.#items = replayWork(events);
    this.#reindex();
    return this;
  }

  #reindex() {
    this.#byRef.clear();
    this.#byTurn.clear();
    for (const r of this.#items.values()) {
      if (r.ref) this.#byRef.set(`${r.scopeId}\u0000${r.ref}`, r.id);
      if (r.generation !== null && r.turn !== null) {
        this.#byTurn.set(`${r.scopeId}\u0000${r.generation}\u0000${r.turn}`, r.id);
      }
    }
  }

  #append(event) {
    const full = { ...event, at: event.at ?? this.#now() };
    this.#store.append(this.#timelineId, full); // 写失败**上抛**
    return full;
  }

  #put(rec) {
    this.#items.set(rec.id, rec);
    if (rec.ref) this.#byRef.set(`${rec.scopeId}\u0000${rec.ref}`, rec.id);
    if (rec.generation !== null && rec.turn !== null) {
      this.#byTurn.set(`${rec.scopeId}\u0000${rec.generation}\u0000${rec.turn}`, rec.id);
    }
  }

  get size() {
    return this.#items.size;
  }

  all() {
    return [...this.#items.values()];
  }

  get(id) {
    return this.#items.get(id) ?? null;
  }

  /** 票 → 活（`null` = 这张票本账里没有）。 */
  byRef(scopeId, ref) {
    const id = this.#byRef.get(`${scopeId ?? 'main'}\u0000${ref}`);
    return id ? this.#items.get(id) : null;
  }

  /** **配对键** → 活（契约 §二.1：`(agentGeneration, turn)`）。 */
  byTurn(scopeId, generation, turn) {
    const id = this.#byTurn.get(`${scopeId ?? 'main'}\u0000${generation}\u0000${turn}`);
    return id ? this.#items.get(id) : null;
  }

  live() {
    return this.all().filter((r) => isOpen(r.state));
  }

  openTickets() {
    return this.live().filter((r) => r.ref);
  }

  summary() {
    return summarize(this.all());
  }

  /**
   * **投出去一张票**（`deliver` 收下了那句话）。
   * 状态是 `waiting`（还没变成轮）。幂等：同一个 `(scopeId, ref)` 只开一次。
   */
  declare({ scopeId = 'main', ref, ticket = null, state = WORK_STATES.waiting, promiseId = null } = {}) {
    if (!ref) throw new Error('开一件活要有票（哪句话引起来的）');
    const had = this.byRef(scopeId, ref);
    // ⚠️ 开过（无论开着还是已收口）⇒ **原样返回**：盘上那条 `work/open` 已经在了，
    //    再开一次会被重放规则当成"想复活一条收了口的话"而忽略（内存与盘会分家）。
    if (had) return { record: had, created: false, event: null };
    const id = ticketId(scopeId, ref);
    const event = this.#append({
      type: WORK_OPEN,
      id,
      scopeId,
      ref,
      ticket: ticket ?? ref,
      state,
      ...(promiseId ? { promiseId } : {}),
    });
    const rec = {
      id,
      scopeId,
      ref,
      ticket: ticket ?? ref,
      generation: null,
      turn: null,
      state,
      startedAt: event.at,
      closedAt: null,
      outcome: null,
      reason: null,
      promiseId,
    };
    this.#put(rec);
    return { record: rec, created: true, event };
  }

  /**
   * **票绑到轮上**：这一步把配对键 `(agentGeneration, turn)` 变成**落盘的事实**。
   *
   * ⚠️ 为什么要落盘：改前这个归属只在内存的一个 `Map` 里（`#turnOwner`），
   *    重启就没了 ⇒ 答不出"那件活动过东西没有"（`10-RECONCILE.md` §6.1）。
   */
  bind({ scopeId = 'main', ref, generation, turn, state = WORK_STATES.running } = {}) {
    if (!ref) throw new Error('绑轮要有票');
    if (typeof generation !== 'number' || typeof turn !== 'number') {
      throw new Error('绑轮的键是 (agentGeneration, turn) —— 两个都得是数字');
    }
    const had = this.byRef(scopeId, ref);
    const id = had?.id ?? ticketId(scopeId, ref);
    const event = this.#append({
      type: WORK_OPEN,
      id,
      scopeId,
      ref,
      ticket: had?.ticket ?? ref,
      generation,
      turn,
      state,
      ...(had?.promiseId ? { promiseId: had.promiseId } : {}),
    });
    const rec = {
      id,
      scopeId,
      ref,
      ticket: had?.ticket ?? ref,
      generation,
      turn,
      state,
      startedAt: had?.startedAt ?? event.at,
      closedAt: null,
      outcome: null,
      reason: null,
      promiseId: had?.promiseId ?? null,
    };
    this.#put(rec);
    return rec;
  }

  /**
   * **无票自发轮**（助手自己发起的一轮）—— 也逐件落盘，但**归属是 `null`**。
   * ⚠️ 契约 T1 的反例正身：插一条无票自发轮 ⇒ 它的归属必须是 `null`，
   *    **不许**去认领别人的票。
   */
  spontaneous({ scopeId = 'main', generation, turn, state = WORK_STATES.running } = {}) {
    if (typeof generation !== 'number' || typeof turn !== 'number') {
      throw new Error('自发轮也要 (agentGeneration, turn) 才认得出是哪一件');
    }
    const id = turnId(scopeId, generation, turn);
    const event = this.#append({ type: WORK_OPEN, id, scopeId, ref: null, generation, turn, state });
    const rec = {
      id, scopeId, ref: null, ticket: null, generation, turn, state,
      startedAt: event.at, closedAt: null, outcome: null, reason: null, promiseId: null,
    };
    this.#put(rec);
    return rec;
  }

  /** 把 `promiseId` 记到那件活上（T5：删了它 ⇒ "不可查"）。 */
  attachPromise({ scopeId = 'main', ref = null, id = null, promiseId }) {
    const rec = id ? this.get(id) : this.byRef(scopeId, ref);
    if (!rec) throw new Error(`找不到要挂承诺的那件活：${id ?? ref}`);
    const event = this.#append({
      type: WORK_OPEN,
      ...rec,
      promiseId,
    });
    this.#put({ ...rec, promiseId });
    return event;
  }

  /** 收口：三种结局之一。**幂等**（收过的不会被第二次覆盖）。 */
  close({ id, outcome, reason = null } = {}) {
    const rec = this.#items.get(id);
    if (!rec) throw new Error(`收一条没开过的活：${id}`);
    if (!isOpen(rec.state)) return { record: rec, closed: false, event: null };
    const finalOutcome = CLOSED_OUTCOMES.includes(outcome) ? outcome : WORK_STATES.stopped;
    const event = this.#append({ type: WORK_CLOSE, id, outcome: finalOutcome, reason });
    const next = { ...rec, state: finalOutcome, outcome: finalOutcome, closedAt: event.at, reason };
    this.#items.set(id, next);
    return { record: next, closed: true, event };
  }

  /** 按票收口（`turn-end` / 失败 / 取消都走这儿）。 */
  closeByRef({ scopeId = 'main', ref, outcome, reason = null } = {}) {
    const rec = this.byRef(scopeId, ref);
    if (!rec) return { record: null, closed: false, event: null };
    return this.close({ id: rec.id, outcome, reason });
  }

  /**
   * **进程换代 / 硬杀之后的诚实收口**：还开着的那些，凡是**代号已经不在**
   * （进程没了）或**代号不是当前存活那一代**，一律收成 `stopped`（人话"已停"）。
   *
   * ⚠️ 这就是"**没有消失**"的落点：硬杀之后逐件答得出"已停"，而不是查无此件。
   * ⚠️ **只收代号对不上的**：同一代还活着的（进程还在跑）不许乱收。
   *
   * @param {Set<number>|number[]} aliveGenerations 现在还活着的进程代号
   * @returns {object[]} 收掉的记录
   */
  settleDead({ aliveGenerations = [] } = {}) {
    const alive = aliveGenerations instanceof Set ? aliveGenerations : new Set(aliveGenerations);
    const closedNow = [];
    for (const rec of this.live()) {
      // 没绑轮的（还只是票）也一并收：进程换了，它永远等不到下一轮了。
      if (rec.generation !== null && alive.has(rec.generation)) continue;
      const r = this.close({ id: rec.id, outcome: WORK_STATES.stopped, reason: 'process-gone' });
      if (r.closed) closedNow.push(r.record);
    }
    return closedNow;
  }

  /**
   * 每件活的耗时样本（做分位用）。**删失（超时/被杀）也要算**（契约 §二.4）。
   *
   * @returns {{ms:number, censored:boolean, id:string}[]}
   */
  durations() {
    const out = [];
    for (const r of this.#items.values()) {
      if (typeof r.startedAt !== 'number' || typeof r.closedAt !== 'number') continue;
      const ms = r.closedAt - r.startedAt;
      if (!Number.isFinite(ms) || ms < 0) continue;
      if (r.state === WORK_STATES.done) out.push({ ms, censored: false, id: r.id });
      else if (r.state === WORK_STATES.stopped) out.push({ ms, censored: true, id: r.id });
      // `cancelled` 是他让停的，不是这件活自己的耗时 ⇒ 不进样本（如实记在案里）
    }
    return out;
  }

  /**
   * 逐件回答"那件怎么样了"（契约 §三.④）。
   * @returns {object|null} 记录（含 `answerStateOf` 的机器名）；查无此件 ⇒ `null`
   */
  answer({ scopeId = 'main', ref = null, turn = null, generation = null } = {}) {
    const rec = ref
      ? this.byRef(scopeId, ref)
      : (generation !== null && turn !== null ? this.byTurn(scopeId, generation, turn) : null);
    if (!rec) return null;
    return { ...rec, answer: answerStateOf(rec) };
  }
}

/** 本账的文件在不在（排障 / 判据用）。 */
export function workLogPath(dataDir, { fs = nodeFs } = {}) {
  try {
    return fs.existsSync(`${dataDir}/${WORK_LOG}.jsonl`) ? `${dataDir}/${WORK_LOG}.jsonl` : null;
  } catch {
    return null;
  }
}
