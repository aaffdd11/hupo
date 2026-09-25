// **按 app 的运行记录（用量账）** —— 契约 `docs/dev/93-OUTBOUND-USAGE.md` §四／§五 ·
// 主人 2026-09-25 第 8 条（`docs/dev/96-OWNER-DECISIONS.md`）。
//
// ── 它解决什么 ────────────────────────────────────────────
// 主人要的是："每个小程序要有一个运行记录，它的消耗……token 消耗量大概是日均消耗是什么曲线
// 这些也是要保存的。"（93 §〇 逐字）。
//
// 🔴 **它不是访问日志**（主人点名的那句"我觉得不是访问日志"是**禁令**，93 §〇）：
//    这个文件里**只许有量** —— token 三格、次数、张数、秒数、按天。
//    **不许**出现任何 prompt／answer／文件名／URL／谁在什么时候打开了什么。
//    判据 4.1.1：往工作区塞一个哨兵再跑一轮 ⇒ 这个文件里**零命中**。
//
// ── 三格 token ＋ 一个对外数 ───────────────────────────────
// 93 F6（`08-SPEC.md` §13.5）：token 计数**没有用户维度**、**cache read 占绝对主导**、
// 而且**没有价格表** ⇒ 记账必须拆三格（`uncachedInput` / `output` / `cacheRead`），
// 且 `cacheRead` **不进任何阈值判断**（它几乎免费，会把阈值淹没）。
//
// 🔴 主人第 8 条：**都算到这个 app（含它触发的子任务）**，内部另存拆分**备查**，
//    但**对外只一个数**。⇒ 一个对外的数 = `uncachedInput + output`（`oneNumber()`）；
//    拆开的那三格照样落盘，只给查账用。
//
// ── 它住哪（**贴现有布局，不新造第二套**）──────────────────
// `<dir>/hupo/apps/<id>/usage.jsonl` —— 与 `audit.jsonl` / `grant.json` / `ask.json`
// **同一格**（93 §4.2）。⚠️ 它就是"这个 app 的账"那一格；再开一个 `hupo/usage/…`
// 就是第二套账，两套必然漂。
//
// ── 日均与曲线 ────────────────────────────────────────────
// 🔴 **读取时算，不另存第二份**（93 §4.1；`AGENTS.md` §5.0：同一份数字不许有两处）。
//
// ── 真相在哪一侧（主人第 7 条）─────────────────────────────
// 🔴 **用量的真相在运营方这一侧**（模型调用经我们中转 ⇒ 无法造假）。
//    盒里这一份是 **app 维度**的账；**以运营方实测为准**。
//    两份对不上要有**可查的偏差信号**（`reconcileUsage()`）—— **不许静默取一个**。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

/** 记录形状的版本（加字段要能分辨）。 */
export const USAGE_SCHEMA = 1;

/** 一笔账的**口径标记**（93 §4.1：一行要说清它是哪一种）。 */
export const USAGE_KINDS = Object.freeze({
  agentTurn: 'agent-turn',
  ask: 'ask',
  image: 'image',
  voice: 'voice',
});

/** 这一格文件名。**只有这一处**写它。 */
export const USAGE_FILENAME = 'usage.jsonl';

/** 写不进去时那一行痕（F10：事实不能静默）。 */
export const USAGE_FAILURES_FILENAME = 'usage-failures.jsonl';

/**
 * **没写进账 ⇒ 明说**（`note()` 的返回值）。
 * 93 §4.5.5：写失败要留痕，而且**不许挡住那一轮**（同 `#audit` 的取舍）。
 */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * **"一天"的口径只有一处**（93 §4.1）：与 `apps.js` 的 `askQuota` 逐字一致
 * （`new Date(at).toISOString().slice(0, 10)`）。⚠️ 再定义第二个"一天" ⇒
 * 曲线与配额对不上。
 */
export function dayOf(at) {
  return new Date(at).toISOString().slice(0, 10);
}

/** 一个 scope 该记到哪个 app 那一格：空 ⇒ 主线（主线也有它自己的账）。 */
export function scopeForUsage(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s === '' ? 'main' : s;
}

/** 三格 token ＋ 次数的空账。 */
export function emptyCounters() {
  return { uncachedInput: 0, output: 0, cacheRead: 0, calls: 0, images: 0, voiceSeconds: 0 };
}

function num(v) {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * **把上游那份 `usage` 拆成三格**（纯函数；认不出 ⇒ 全 0 ＋ `known:false`）。
 *
 * 认两种常见的形状（**不猜**）：
 *   · OpenAI / DeepSeek 系：`prompt_tokens` · `completion_tokens` ·
 *     `prompt_cache_hit_tokens`（= cache read）／`prompt_cache_miss_tokens`（= uncached）
 *   · Anthropic 系：`input_tokens` · `output_tokens` · `cache_read_input_tokens`
 *   · ★ **这台 DSH 自己那份**（`session.event` 的 `assistant/message.data.usage`，
 *     实测形状）：`inputTokens` · `outputTokens` · `cacheReadTokens` · `totalTokens`
 *     · `reasoningTokens`。⚠️ 实测 `totalTokens = inputTokens + outputTokens + cacheReadTokens`
 *     ⇒ `inputTokens` **不含** cache read（uncached 就是它），**不许**再减一次。
 *
 * ⚠️ 认不出 ⇒ **如实全 0**，并把 `known:false` 交给调用方 —— 不许拿"总数"当"没缓存"填进去
 *    （那会把一个几乎免费的量算成要花钱的量，正好是 F6 禁止的那种口径混用）。
 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...emptyCounters(), known: false };
  }
  const pick = (...names) => {
    for (const n of names) {
      const v = raw[n];
      if (Number.isFinite(v) && v >= 0) return v;
    }
    return null;
  };
  // ⚠️ **两种形状的"输入"含义不同**，不许混着减：
  //   · OpenAI／DeepSeek：`prompt_tokens` **含**缓存命中 ⇒ uncached = prompt − hit
  //   · Anthropic：`input_tokens` **不含**缓存（缓存另算）⇒ uncached = input_tokens
  //   · DSH（camelCase）：同 Anthropic ⇒ uncached = inputTokens
  const promptTokens = pick('prompt_tokens');
  const inputTokens = pick('input_tokens');
  const dshInputTokens = pick('inputTokens');
  const output = pick('completion_tokens', 'output_tokens', 'outputTokens');
  const cacheRead = pick('prompt_cache_hit_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'cacheReadTokens');
  const cacheMiss = pick('prompt_cache_miss_tokens');
  const known = promptTokens !== null || inputTokens !== null || dshInputTokens !== null
    || output !== null || cacheRead !== null;
  let uncachedInput = 0;
  if (cacheMiss !== null) uncachedInput = cacheMiss;
  else if (promptTokens !== null) uncachedInput = Math.max(0, promptTokens - (cacheRead ?? 0));
  else if (inputTokens !== null) uncachedInput = inputTokens;
  else if (dshInputTokens !== null) uncachedInput = dshInputTokens;
  return {
    uncachedInput: num(uncachedInput),
    output: num(output ?? 0),
    cacheRead: num(cacheRead ?? 0),
    calls: 1,
    images: 0,
    voiceSeconds: 0,
    known,
  };
}

/**
 * 🔴 **对外的那一个数**（主人第 8 条）：`uncachedInput + output`。
 *
 * ⚠️ `cacheRead` **不进这个数**、也**不进任何阈值**（93 F6／判据 4.1.2）——
 *    它占绝对主导而几乎免费，混进去就成了"看着很贵、其实没花多少"的假曲线。
 */
export function oneNumber(rec) {
  return num(rec?.uncachedInput) + num(rec?.output);
}

/**
 * 一条**只记量**的记录。所有字段都是数或枚举，**没有任何正文**。
 *
 * @param {object} o
 * @param {number} o.at
 * @param {string} o.kind     `USAGE_KINDS` 之一（认不出 ⇒ 拒，fail-closed）
 * @param {string} o.scopeId  这一笔算在哪个 scope 头上（app 的 id，或主线 `main`）
 * @param {object} [o.usage]  上游那份 usage（会过 `normalizeUsage`）
 * @param {number} [o.calls]
 * @param {number} [o.images]
 * @param {number} [o.voiceSeconds]
 * @param {string} [o.source] `box`（盒里这一份）／`operator`（运营方实测）
 * @param {number|null} [o.turn]
 */
export function usageRow({
  at,
  kind,
  scopeId,
  usage = null,
  calls = null,
  images = 0,
  voiceSeconds = 0,
  source = 'box',
  turn = null,
} = {}) {
  if (!Object.values(USAGE_KINDS).includes(kind)) {
    throw new UsageError(`认不出这一笔账是哪种（${String(kind).slice(0, 20)}）—— 不记`);
  }
  const n = usage ? normalizeUsage(usage) : emptyCounters();
  const row = {
    schema: USAGE_SCHEMA,
    at: Number.isFinite(at) ? at : Date.now(),
    day: dayOf(Number.isFinite(at) ? at : Date.now()),
    kind,
    scopeId: scopeForUsage(scopeId),
    source: source === 'operator' ? 'operator' : 'box',
    uncachedInput: n.uncachedInput,
    output: n.output,
    cacheRead: n.cacheRead,
    calls: calls === null ? (usage ? 1 : 0) : num(calls),
    images: num(images),
    voiceSeconds: num(voiceSeconds),
  };
  if (Number.isInteger(turn)) row.turn = turn;
  return row;
}

/**
 * **日均与曲线**（纯函数 · **读取时算**，93 §4.1）。
 *
 * @param {Array<object>} rows
 * @returns {{days:Array<object>, totals:object, dailyAverage:object, firstDay:string|null, lastDay:string|null, rows:number}}
 */
export function aggregate(rows = []) {
  const byDay = new Map();
  const totals = { ...emptyCounters(), ones: 0 };
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const day = typeof r.day === 'string' && r.day ? r.day : dayOf(r.at);
    let d = byDay.get(day);
    if (!d) {
      d = { day, ...emptyCounters(), ones: 0 };
      byDay.set(day, d);
    }
    const u = { uncachedInput: num(r.uncachedInput), output: num(r.output), cacheRead: num(r.cacheRead) };
    const calls = num(r.calls);
    const images = num(r.images);
    const voice = num(r.voiceSeconds);
    for (const k of ['uncachedInput', 'output', 'cacheRead']) {
      d[k] += u[k];
      totals[k] += u[k];
    }
    d.calls += calls;
    d.images += images;
    d.voiceSeconds += voice;
    totals.calls += calls;
    totals.images += images;
    totals.voiceSeconds += voice;
    const one = u.uncachedInput + u.output;
    d.ones += one;
    totals.ones += one;
  }
  const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const n = days.length;
  const dailyAverage = {
    ones: n === 0 ? 0 : Math.round(totals.ones / n),
    calls: n === 0 ? 0 : totals.calls / n,
    images: n === 0 ? 0 : totals.images / n,
    voiceSeconds: n === 0 ? 0 : totals.voiceSeconds / n,
    voiceMinutes: n === 0 ? 0 : totals.voiceSeconds / n / 60,
    days: n,
  };
  return {
    days,
    totals,
    dailyAverage,
    firstDay: n === 0 ? null : days[0].day,
    lastDay: n === 0 ? null : days[n - 1].day,
    rows: rows.length,
  };
}

/** 偏离门槛：**只住这里**（93 F4：文档不写数值）。实测日均超过申报量级这么多 ⇒ 算偏离。 */
export const USAGE_DEVIATION_RATIO = 3;
/** 量太小时不用比例（否则"申报 1、实测 2"也会被叫成偏离）。 */
export const USAGE_DEVIATION_MIN_ONES = 1000;

/**
 * **申报的量级 vs 实测的日均**（纯函数）。
 *
 * ⚠️ 主人第 7 条：申报是**预告**，对不上**进评级** —— 所以这里只产出**信号**，
 *    不替上架闸下"拒"的结论（上架闸按评级那一档办）。
 * ⚠️ 读不出任一侧 ⇒ `unknown`（**不许安静地绿**）。
 */
export function usageDeviation({ measured, declared } = {}) {
  const m = Number.isFinite(measured) && measured >= 0 ? measured : null;
  const d = Number.isFinite(declared) && declared >= 0 ? declared : null;
  if (m === null || d === null) {
    return { verdict: 'unknown', measured: m, declared: d, ratio: USAGE_DEVIATION_RATIO };
  }
  const ceiling = Math.max(d * USAGE_DEVIATION_RATIO, d + USAGE_DEVIATION_MIN_ONES);
  return {
    verdict: m <= ceiling ? 'ok' : 'deviation',
    measured: m,
    declared: d,
    ceiling,
    ratio: USAGE_DEVIATION_RATIO,
  };
}

/**
 * 🔴 **盒里那份 vs 运营方那份**（主人第 7 条）。
 *
 * **以运营方实测为准**（模型调用经我们中转 ⇒ 无法造假）；盒里这份是 app 维度的账。
 * 两份对不上 ⇒ **可查的偏差信号**（写进审核记录），**不许静默取一个**。
 *
 * @returns {{authoritative:'operator', verdict:'match'|'deviation'|'unknown',
 *            box:number|null, operator:number|null, signal:string}}
 */
export function reconcileUsage({ box = null, operator = null } = {}) {
  const b = Number.isFinite(box) && box >= 0 ? box : null;
  const o = Number.isFinite(operator) && operator >= 0 ? operator : null;
  if (b === null || o === null) {
    return {
      authoritative: 'operator',
      verdict: 'unknown',
      box: b,
      operator: o,
      signal: b === null ? '盒里那份读不到（这一条如实报，不当成 0）' : '运营方那份读不到（这一条如实报，不当成 0）',
    };
  }
  const d = usageDeviation({ measured: o, declared: b });
  return {
    authoritative: 'operator',
    verdict: d.verdict === 'deviation' ? 'deviation' : 'match',
    box: b,
    operator: o,
    signal:
      d.verdict === 'deviation'
        ? `盒里记的是 ${b}、运营方实测是 ${o} —— 以运营方为准，偏差进评级`
        : `两份对得上（盒里 ${b}、运营方 ${o}）`,
  };
}

/**
 * **那一本账**：只追加，没有"改"的入口（照 `ledger.js` 的①）。
 *
 * ⚠️ 它**不自己算路径**：`<id>` 那一格由 `Apps.appDir()` 说了算（布局只有一处出处）。
 */
export class UsageLedger {
  /**
   * @param {object} o
   * @param {{appDir:(id:string)=>string, fs?:object}} o.apps 制品库（借它的布局与 fs）
   * @param {()=>number} [o.now]
   * @param {(m:string)=>void} [o.log]
   */
  constructor({ apps, now = Date.now, log = () => {} }) {
    if (!apps || typeof apps.appDir !== 'function') throw new UsageError('用量账要一个制品库（借它的布局）');
    this.apps = apps;
    this.fs = apps.fs ?? nodeFs;
    this.now = now;
    this.log = log;
    /** 写失败了几笔（诊断用；**不许挡住主流程**）。 */
    this.failures = 0;
  }

  fileFor(scopeId) {
    return nodePath.join(this.apps.appDir(scopeForUsage(scopeId)), USAGE_FILENAME);
  }

  /**
   * **记一笔**。**绝不抛**（93 §4.5.5：记账失败不许把那一轮挡掉）。
   *
   * @returns {{ok:boolean, row?:object, error?:string}}
   */
  note(scopeId, patch = {}) {
    let row;
    try {
      row = usageRow({
        at: patch.at ?? this.now(),
        kind: patch.kind,
        scopeId: scopeForUsage(scopeId),
        usage: patch.usage ?? null,
        calls: patch.calls ?? null,
        images: patch.images ?? 0,
        voiceSeconds: patch.voiceSeconds ?? 0,
        source: patch.source ?? 'box',
        turn: patch.turn ?? null,
      });
    } catch (err) {
      // 口径认不出 ⇒ 不记，但也不许把调用方弄挂（如实回一句）
      return { ok: false, error: err?.message ?? String(err) };
    }
    const file = this.fileFor(row.scopeId);
    try {
      this.fs.mkdirSync(nodePath.dirname(file), { recursive: true, mode: 0o755 });
      this.fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o644 });
      return { ok: true, row };
    } catch (err) {
      this.failures += 1;
      const why = err?.message ?? String(err);
      this.log(`用量记不进去（${row.scopeId} · ${row.kind}）：${why}`);
      // 🔴 F10：**写失败要留痕**（另开一行痕；它再失败就只剩日志，但绝不挡主流程）
      try {
        this.fs.appendFileSync(
          nodePath.join(nodePath.dirname(file), USAGE_FAILURES_FILENAME),
          `${JSON.stringify({ at: row.at, day: row.day, scopeId: row.scopeId, kind: row.kind, why: String(why).slice(0, 200) })}\n`,
          { mode: 0o644 },
        );
      } catch {
        /* 盘都写不动了，只能靠日志 */
      }
      return { ok: false, error: why };
    }
  }

  /** 盘上那串记录（读不到 ⇒ 空数组，**不猜**）。坏行**跳过并计数**（不许安静地绿）。 */
  rows(scopeId) {
    const file = this.fileFor(scopeId);
    let raw;
    try {
      raw = this.fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of String(raw).split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j && typeof j === 'object' && !Array.isArray(j)) out.push(j);
      } catch {
        /* 坏行跳过；它的存在由 `badLines()` 如实报出来 */
      }
    }
    return out;
  }

  /** 坏了几行（读不出来也要说得出"这条曲线不完整"）。 */
  badLines(scopeId) {
    const file = this.fileFor(scopeId);
    let raw;
    try {
      raw = this.fs.readFileSync(file, 'utf8');
    } catch {
      return 0;
    }
    let bad = 0;
    for (const line of String(raw).split('\n')) {
      if (!line.trim()) continue;
      try {
        JSON.parse(line);
      } catch {
        bad += 1;
      }
    }
    return bad;
  }

  /** **读取时算**的日均与曲线（93 §4.1：不另存第二份）。 */
  summary(scopeId) {
    const rows = this.rows(scopeId);
    return { ...aggregate(rows), scopeId: scopeForUsage(scopeId), badLines: this.badLines(scopeId) };
  }

  /** 上架要交的那份摘要（93 §6.1；**只从记录复算**，不带身份）。 */
  submittedSummary(scopeId) {
    const s = this.summary(scopeId);
    return {
      schema: USAGE_SCHEMA,
      scopeId: s.scopeId,
      rows: s.rows,
      days: s.days,
      totals: s.totals,
      dailyAverage: s.dailyAverage,
      firstDay: s.firstDay,
      lastDay: s.lastDay,
      badLines: s.badLines,
    };
  }
}
