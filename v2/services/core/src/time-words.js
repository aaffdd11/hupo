// **时间话术的闸与账**（契约 `docs/dev/88-P1-TIME-WAIT.md` §二.4 / §四 T3 / §四 T5）。
//
// ── 三条硬规矩（一条都不许打折）────────────────────────────
//   ① 🔴 **没有落盘依据就不许说时间词**：`很快 / 比平常久 / 通常 / 一会儿 / N 分钟`
//      这类话，凡是**我们自己说出去的**，必须带一个能复算的**依据 id**
//      （`elapsed:` 实测已等 / `duration:` 同类样本分位 / `promise:` 已落盘的承诺）。
//      没有依据 ⇒ **闸抛**（不是"提醒一下"）。
//   ② 🔴 **说了就落一行承诺行**，到点没做完 ⇒ **必须再报一次**（也落盘）。
//   ③ 🔴 **统计用第 90 分位，而且删失（被超时/被杀那轮）也要算**：
//      只对 `completed` 求分位 = **把长尾删掉再说分位**（`87` §③.7 点名的做法）。
//
// ── ⚠️ 一条**诚实的边界**（写在这里，别假装它不存在）────────────
// 模型正文（`assistant/message` 里的 `text`）**不经过这道闸**：
//   · 那句是模型自己说的，不是我们拼出来的；重写它是另一件事（且会动"他看到的字"）；
//   · 我们**能做且已经做**的是：**我们自己说的每一句**都过闸；模型正文原样转发。
// ⇒ 所以"扫模型正文"这一条**没有做成一道闸**，它是**未做**（见落地报告 §⑥）。
//    这里不写一句"已覆盖模型正文"来让判据好看 —— 那是这个项目最贵的那种假话。

import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { StoreError } from './store.js';

/**
 * **时间 / 频度 / 比较级**词表（住代码，不进文档 —— 手册纪律 1）。
 *
 * ⚠️ 每一条都配一个**反例**（`test/time-words.test.js` 里跑正负对照）：
 *    普通名词（"今天""名字"）不许命中，`已经等了 12 秒` 这种**有数**的命中。
 */
export const TIME_WORD_PATTERNS = Object.freeze([
  // 时间承诺类
  { id: 'soon', re: /很快|马上|立刻|立即|一会儿|稍等|稍后|马上就好|快了/ },
  // 频度类
  { id: 'usual', re: /通常|平常|一般情况|经常|总是|向来|一贯/ },
  // 比较级类
  { id: 'longer', re: /久了|久一点|久了点|比.{0,6}久|花的时间更长|更久/ },
  // 带量词的时间 —— **有数**（`已经等了 12 秒`）也要过闸：数本身就是依据
  { id: 'quantity', re: /\d+\s*(秒|分钟|分|小时|天|周|个月)/ },
  // 倒计时 / 到期时刻
  { id: 'deadline', re: /还有.{0,6}(就|能)|再等.{0,6}(秒|分钟|小时)/ },
]);

/** 这一段话里有没有时间词。 */
export function hasTimeClaim(text) {
  return scanTimeWords(text).length > 0;
}

/**
 * 扫一遍。**纯函数**（判据直接喂正反例）。
 * @param {string} text
 * @returns {{id:string, match:string, index:number}[]}
 */
export function scanTimeWords(text) {
  if (typeof text !== 'string' || text === '') return [];
  const hits = [];
  for (const p of TIME_WORD_PATTERNS) {
    const re = new RegExp(p.re.source, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      hits.push({ id: p.id, match: m[0], index: m.index });
      if (m.index === re.lastIndex) re.lastIndex += 1; // 防空转
    }
  }
  hits.sort((a, b) => a.index - b.index);
  return hits;
}

/** 依据 id 的三种来源（**只有这三种算数**）。 */
export const EVIDENCE_KINDS = Object.freeze(['elapsed', 'duration', 'promise', 'registry']);

/**
 * **依据 id 认得出来吗**。认不出 ⇒ `null`（N10：不猜）。
 *
 *   `elapsed:<ms>`              实测已等了多久（计时器量出来的，不是猜的）
 *   `duration:p90:<scope>:<ms>` 同类活的历史分位（`durationStats` 算出来的）
 *   `promise:<id>`              已经**落盘**的那行承诺（`PromiseBook`）
 *   `registry:<key>`            一张**代码里**写得出来的口径表（`registry` 里必须有）
 */
export function evidenceFor(id, { registry = {} } = {}) {
  if (typeof id !== 'string' || id === '') return null;
  const parts = id.split(':');
  const kind = parts[0];
  if (!EVIDENCE_KINDS.includes(kind)) return null;
  if (kind === 'elapsed') {
    if (parts.length !== 2 || parts[1] === '') return null;
    const ms = Number(parts[1]);
    if (!Number.isFinite(ms) || ms < 0) return null;
    return { kind, id, ms };
  }
  if (kind === 'duration') {
    const [, stat, scope, raw] = parts;
    const ms = Number(raw);
    if (stat !== 'p90' || !scope || !Number.isFinite(ms) || ms < 0 || parts.length !== 4) return null;
    return { kind, id, stat, scope, ms };
  }
  if (kind === 'promise') {
    const promiseId = parts.slice(1).join(':');
    return promiseId ? { kind, id, promiseId } : null;
  }
  // registry
  const key = parts.slice(1).join(':');
  if (!key || !registry[key]) return null;
  return { kind, id, key, entry: registry[key] };
}

export class TimeWordError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeWordError';
  }
}

/**
 * **说一句带时间词的话之前必须过它**（闸）。
 *
 * @param {string} text
 * @param {object} [o]
 * @param {string|null} [o.evidence] 依据 id（没有就必须没有时间词）
 * @param {object} [o.registry]
 * @returns {{ok:true, hits:object[], evidence:object|null}}
 * @throws {TimeWordError} 有时间词却没有（或认不出）依据
 */
export function assertBackedText(text, { evidence = null, registry = {} } = {}) {
  const hits = scanTimeWords(text);
  if (hits.length === 0) return { ok: true, hits, evidence: null };
  const ev = evidenceFor(evidence, { registry });
  if (!ev) {
    throw new TimeWordError(
      `这句里有时间词（${hits.map((h) => h.match).join('、')}）却没有能复算的依据` +
      `（依据 id：${evidence ?? '没有'}）—— 契约 88 §二.4：没有落盘口径不许说`,
    );
  }
  return { ok: true, hits, evidence: ev };
}

/** 文案表里这一条声明的依据**是哪一种**（`null` = 它本来就不该有时间词）。 */
export function evidenceKindOf(entry) {
  const raw = entry?.evidence;
  if (!raw) return null;
  if (EVIDENCE_KINDS.includes(raw)) return raw;
  return String(raw).split(':')[0];
}

// ════════════════════════════════════════════════════════════
// ② 承诺行：说了就落盘，到点没完必须再报一次（T5）
// ════════════════════════════════════════════════════════════

/** 承诺账住哪儿（另起一条文件，理由同 `worklog.js`）。 */
export const PROMISE_LOG = 'promises';
export const PROMISE_MADE = 'promise/made';
export const PROMISE_KEPT = 'promise/kept';
export const PROMISE_LATE = 'promise/late';

/**
 * **复算**：每一行承诺现在是什么下场。**纯函数**（判据构造反例用）。
 *
 * @param {object} o
 * @param {object[]} o.promises  承诺事件（`promise/*`）
 * @param {object[]} o.works     活记录（`WorkLog.all()`）
 * @param {number} [o.now]
 * @returns {{kept:object[], late:object[], unfulfilled:object[], unmatchable:object[], pending:object[]}}
 */
export function recheckPromises({ promises = [], works = [], now = Date.now() } = {}) {
  const made = new Map();
  for (const e of promises) {
    if (e?.type === PROMISE_MADE && typeof e.id === 'string') {
      made.set(e.id, { ...e, kept: false, late: false });
    } else if (e?.type === PROMISE_KEPT && made.has(e.id)) {
      made.set(e.id, { ...made.get(e.id), kept: true, keptAt: e.at ?? null });
    } else if (e?.type === PROMISE_LATE && made.has(e.id)) {
      made.set(e.id, { ...made.get(e.id), late: true, lateAt: e.at ?? null });
    }
  }
  const byId = new Map(works.map((w) => [w.id, w]));
  const byRef = new Map();
  for (const w of works) if (w.ref) byRef.set(`${w.scopeId ?? 'main'}\u0000${w.ref}`, w);

  const out = { kept: [], late: [], unfulfilled: [], unmatchable: [], pending: [] };
  for (const p of made.values()) {
    // 认领这件活：先用 `workId`，再退回票
    const w = p.workId ? byId.get(p.workId) : byRef.get(`${p.scopeId ?? 'main'}\u0000${p.ref}`);
    // 🔴 **删掉 `promiseId` ⇒ 不可查**（T5 的反例）：账上那条活的 `promiseId`
    //    与这行承诺对不上 ⇒ 不许静默过。
    if (!w || w.promiseId !== p.id) {
      out.unmatchable.push({ ...p, why: '找不到对得上的那件活（承诺挂在哪件上不可查）' });
      continue;
    }
    if (p.kept) { out.kept.push(p); continue; }
    if (p.late) { out.late.push(p); continue; }
    if (typeof p.dueAt === 'number' && p.dueAt <= now) {
      out.unfulfilled.push({ ...p, workState: w.state, why: '到点了还没做完，也没有再报一次' });
      continue;
    }
    out.pending.push(p);
  }
  const total = out.kept.length + out.late.length + out.unfulfilled.length;
  return {
    ...out,
    /** **兑现率可复算**：兑现 = 做完之前到（kept）或到点再报了（late）。 */
    rate: total === 0 ? null : (out.kept.length + out.late.length) / total,
  };
}

/** 那本承诺账（append-only，写失败上抛）。 */
export class PromiseBook {
  #store;
  #timelineId;
  #now;

  constructor({ store, timelineId = PROMISE_LOG, now = Date.now }) {
    if (!store) throw new StoreError('PromiseBook 需要 store（承诺必须落盘）');
    this.#store = store;
    this.#timelineId = timelineId;
    this.#now = now;
  }

  #append(event) {
    const full = { ...event, at: event.at ?? this.#now() };
    this.#store.append(this.#timelineId, full);
    return full;
  }

  events() {
    return this.#store.readAll(this.#timelineId);
  }

  /**
   * **落一行承诺**（就在说那句话之前 —— 先落盘再上屏）。
   * @param {object} o
   * @param {string} o.id
   * @param {string} [o.scopeId]
   * @param {string} [o.ref]      哪张票
   * @param {string} [o.workId]   哪件活
   * @param {string} o.text       承诺的那句话（原文）
   * @param {string} o.basis      依据 id
   * @param {number} o.dueAt      说到什么时候
   */
  make({ id, scopeId = 'main', ref = null, workId = null, text, basis, dueAt }) {
    if (!id || !text || !basis) throw new StoreError('承诺要有 id / 原文 / 依据');
    if (!evidenceFor(basis)) throw new TimeWordError(`认不出的依据：${basis}`);
    if (!Number.isFinite(dueAt)) throw new StoreError('承诺要有到期时刻（说话就得有数）');
    return this.#append({ type: PROMISE_MADE, id, scopeId, ref, workId, text, basis, dueAt });
  }

  /** 到点没完 ⇒ **再报一次**（这一行就是"报了"的证据）。 */
  reReport({ id, text = null }) {
    if (!id) throw new StoreError('再报要有承诺 id');
    return this.#append({ type: PROMISE_LATE, id, text });
  }

  /** 到点之前做完了 ⇒ 兑现（不用再报）。 */
  keep({ id }) {
    if (!id) throw new StoreError('兑现要有承诺 id');
    return this.#append({ type: PROMISE_KEPT, id });
  }

  /** 现在这一刻的账（复算，不另存一份）。 */
  fate({ now = this.#now(), works = [] } = {}) {
    return recheckPromises({ promises: this.events(), works, now });
  }
}

// ════════════════════════════════════════════════════════════
// ③ 耗时分位：**删失也要算**（T3 的 §二.4）
// ════════════════════════════════════════════════════════════

/** 少于这么多条 ⇒ 只说"样本不足"，**不许报一个数**（保守档）。 */
export const MIN_SAMPLES = 8;

/** 第 90 分位（最近秩法，升序）。样本为空 ⇒ `null`。 */
export function percentile(samples, p = 0.9) {
  const xs = samples.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const rank = Math.ceil(p * xs.length);
  return xs[Math.max(0, rank - 1)];
}

/**
 * **耗时统计**。
 *
 * 🔴 两条都不许打折：
 *   · `p90` **把删失样本一起算**（被超时/被杀那轮是长尾，删了它 = 系统性地把话说小）；
 *   · `completedP90` 单独给一份"只算做完的"，好让"把 timeout 改成 completed
 *     分位必须变"这条判据有东西可比（`87` §③.7）。
 *   · 样本不足 ⇒ `enough:false`，调用方**不许**报数（保守档）。
 *
 * @param {{ms:number, censored?:boolean}[]} samples
 */
export function durationStats(samples = [], { minSamples = MIN_SAMPLES } = {}) {
  const clean = [];
  let censored = 0;
  for (const s of samples) {
    if (!s || !Number.isFinite(s.ms) || s.ms < 0) continue;
    const c = s.censored === true;
    if (c) censored += 1;
    clean.push({ ms: s.ms, censored: c });
  }
  const all = clean.map((s) => s.ms);
  const completedOnly = clean.filter((s) => !s.censored).map((s) => s.ms);
  return {
    n: clean.length,
    censored,
    minSamples,
    enough: clean.length >= minSamples,
    completedEnough: completedOnly.length >= minSamples,
    /** **含删失**的第 90 分位（保守档：宁多说不少说）。 */
    p90: percentile(all, 0.9),
    /** 只算做完的（判据拿它和 `p90` 比）。 */
    completedP90: percentile(completedOnly, 0.9),
  };
}

/** 给 `PromiseBook.make` 用的一句话：把分位说成一个依据 id。 */
export function durationEvidence(scope, stats) {
  if (!stats || !stats.enough || stats.p90 === null) return null;
  return `duration:p90:${scope}:${Math.round(stats.p90)}`;
}

/** 那条承诺账在哪儿（排障用；没有 ⇒ `null`）。 */
export function promiseLogPath(dataDir, { fs = nodeFs } = {}) {
  const p = nodePath.join(dataDir, `${PROMISE_LOG}.jsonl`);
  try {
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}
