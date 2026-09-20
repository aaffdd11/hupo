// 工时账 —— **账本本体**（批 4 · 契约 `docs/dev/31-LEDGER.md` v2 §7.5）。
//
// 它是**第一份持久化的用户数据**，所以这里的规矩比别处严：
//
//   ① **只追加**（D6.7）：改一条 = **新增一条**，旧的那条永久留在盘上。
//      本模块**没有任何"改"的入口** —— 这是结构上的，不是纪律上的。
//   ② **字段冻结**（§4.5）：`kind / qty / unit / unitPrice / tax / date`
//      六个字段的**语义**一旦写进账本就不再改；要改就是**新增字段**。
//   ③ **校验在宿主**（契约 §7.3）：模型只能"提一条要写的"，
//      写不写、写成什么，由这里说了算。不过 ⇒ **不写**，并**说清哪一项**。
//      ⚠️ **能验的只有形状**：宿主验不了"原话里到底说没说这个数"（那是理解不是校验）
//      —— 出处那一层由 D6.5 的**回显确认**兜着，本模块不假装能替它。
//   ④ **删除与 ⑲ 同语义**（契约 §7.4）：30 天、可恢复、真删要压实。
//      ⚠️ **唯一的一处不同**：`restore` **不重发内容**（账本没有"客户端游标"这一层，
//      重发会让同一个 `entryId` 在盘上出现两份 ⇒ 合计会算重）。
//
// ── 为什么参数是"注入"的 ───────────────────────────────────
// `store` / `timeline` / `now` / `newId` 全部从构造函数进来。理由是**它要能测**：
// 判据 D6.3 要求"同一句话两次 ⇒ 逐字段 diff = 0" —— 时钟与 id 一注入，
// 这条判据就不再需要"真等 7 天"，也不需要为了让 UUID 稳定去 mock 模块。

import nodeCrypto from 'node:crypto';

import { TRASH_TTL_MS } from './trash.js';

/** 一条账本 = 一条日志（与可见时间线同一个形状，**不是同一条日志**）。 */
export const LEDGER_TIMELINE_ID = 'ledger';

export const EV_ENTRY = 'ledger/entry';
export const TOMB_DELETED = 'ledger/deleted';
export const TOMB_RESTORED = 'ledger/restored';
export const TOMB_PURGED = 'ledger/purged';

/**
 * ⚠️ **与 ⑲ 是同一个数**，import 来的，**不许在这儿抄一份**。
 * 抄一份的那天起，两边会各自漂 —— 而"回收站留多久"是**用户已经被告知过**的数。
 */
export const LEDGER_TTL_MS = TRASH_TTL_MS;

export const TOMBS = Object.freeze([TOMB_DELETED, TOMB_RESTORED, TOMB_PURGED]);

// ── 额度（**数值只住在这里**：维护纪律 1）──────────────────────
// 它们不写进手册：手册里的数会过期，而这几个数是"防呆"，量级对就够。
/** 一条账目的"原话"最长多少字。它同时是**出处**，太长了日志会涨得没边。 */
export const MAX_SAID_CHARS = 200;
/** 事项名的上限。 */
export const MAX_KIND_CHARS = 60;
/** 单位的上限（"台""小时"这种，不该长）。 */
export const MAX_UNIT_CHARS = 12;
/** 单条数量上限：再大就不是"记一笔"，是打错了。 */
export const MAX_QTY = 1_000_000;
/** 单条单价上限（单位：元）。 */
export const MAX_UNIT_PRICE = 10_000_000;
/** 一天最多记几条。防的是"某个循环里疯狂调用"这一类，不是正常使用。 */
export const MAX_ENTRIES_PER_DAY = 200;

/** 六个冻结字段（顺序就是回显的顺序）。 */
export const FIELDS = Object.freeze(['kind', 'qty', 'unit', 'unitPrice', 'tax', 'date']);

/**
 * 给人看的字段名。**必须是主人看得懂的词**，
 * 而且**不许出现内部词**（"记录""写入""时间线"这一族 —— 那是一条闸，不是文风）。
 */
export const FIELD_LABELS = Object.freeze({
  kind: '事项',
  qty: '数量',
  unit: '单位',
  unitPrice: '单价',
  tax: '含税',
  date: '日期',
});

export class LedgerError extends Error {
  /**
   * @param {string} message
   * @param {object} [o]
   * @param {{field:string, why:string}[]} [o.problems] **哪一项没听准**（逐项，不是笼统）
   */
  constructor(message, { problems } = {}) {
    super(message);
    this.name = 'LedgerError';
    this.problems = problems ?? [];
  }
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 数字：**收数字，也收"看起来就是数字"的字符串**（模型偶尔会把它包成字符串）。 */
function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** `YYYY-MM-DD` 且**真的是那一天**（2 月 30 日这种要挡住）。 */
function toDate(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return s;
}

/** 含税三态：`true | false | 'unknown'`（D6.9 的口径就建在第三态上）。 */
function toTax(v) {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'unknown' || s === '说不清' || s === '不知道') return 'unknown';
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return undefined; // 认不出来 —— 与"明确是 null"要区分开
}

/**
 * **纯函数**：把模型报上来的东西折成 6 个冻结字段。
 *
 * 同一个输入**永远给同一个输出**（D6.3 的判据就架在这条上）。
 * 返回 `{ok, fields, problems}` —— `problems` 里逐项说清**哪一项没听准**（D6.5）。
 *
 * @param {object} raw  模型报的字段
 * @returns {{ok:boolean, fields:object|null, problems:{field:string,why:string}[]}}
 */
export function normalizeFields(raw) {
  const problems = [];
  const src = isPlainObject(raw) ? raw : {};
  const out = {};

  // 事项
  const kind = typeof src.kind === 'string' ? src.kind.trim() : '';
  if (kind === '') problems.push({ field: 'kind', why: '没听清是哪件事' });
  else if (kind.length > MAX_KIND_CHARS) {
    problems.push({ field: 'kind', why: `太长了（最多 ${MAX_KIND_CHARS} 个字）` });
  } else out.kind = kind;

  // 数量
  const qty = toNumber(src.qty);
  if (qty === null) problems.push({ field: 'qty', why: '没听清是多少' });
  else if (qty <= 0) problems.push({ field: 'qty', why: '要一个正数' });
  else if (qty > MAX_QTY) problems.push({ field: 'qty', why: '这个数太大了，像是听错了' });
  else out.qty = qty;

  // 单位
  const unit = typeof src.unit === 'string' ? src.unit.trim() : '';
  if (unit === '') problems.push({ field: 'unit', why: '没听清单位（台 / 小时 / 件…）' });
  else if (unit.length > MAX_UNIT_CHARS) problems.push({ field: 'unit', why: '这个单位太长了' });
  else out.unit = unit;

  // 单价（**可空** —— 没提钱就不该编一个）
  if (src.unitPrice === null || src.unitPrice === undefined || src.unitPrice === '') {
    out.unitPrice = null;
  } else {
    const p = toNumber(src.unitPrice);
    if (p === null) problems.push({ field: 'unitPrice', why: '没听清是多少钱' });
    else if (p < 0) problems.push({ field: 'unitPrice', why: '钱数不能是负的' });
    else if (p > MAX_UNIT_PRICE) problems.push({ field: 'unitPrice', why: '这个钱数太大了，像是听错了' });
    else out.unitPrice = p;
  }

  // 含税（三态；认不出来**不猜**）
  const tax = toTax(src.tax);
  if (tax === undefined) problems.push({ field: 'tax', why: '含不含税没听准（要"含税""不含税"或"说不清"）' });
  else out.tax = tax;

  // 日期
  const date = toDate(src.date);
  if (date === null) problems.push({ field: 'date', why: '没听准是哪一天（要 2026-08-20 这样）' });
  else out.date = date;

  return { ok: problems.length === 0, fields: problems.length === 0 ? out : null, problems };
}

/**
 * 把一项没听准折成一句人话。**逐项说**，不写"格式不对"。
 * （D6.5 的原话：钱数 / 日期 / 名字**不确认不写**。）
 */
export function problemsLine(problems) {
  const list = Array.isArray(problems) ? problems : [];
  if (list.length === 0) return '';
  return list
    .map((p) => `${FIELD_LABELS[p.field] ?? p.field}：${p.why}`)
    .join('；');
}

/** 含税那一栏给人看的说法。 */
export function taxWord(tax) {
  if (tax === true) return '含税';
  if (tax === false) return '不含税';
  return '含不含税说不清';
}

/**
 * **回显**（D6.5）：把 6 个字段说回给主人听，让他点头。
 *
 * ⚠️ 钱数与日期**必须在里面**（那两项听错了最贵）。
 * ⚠️ 用词过禁用词闸：不出现"记录""写入""时间线"这一族（有一条测试扫它）。
 */
export function renderEcho(fields) {
  const f = isPlainObject(fields) ? fields : {};
  const parts = [
    `${f.kind ?? ''}`,
    `${f.qty ?? ''}${f.unit ?? ''}`,
  ];
  if (f.unitPrice !== null && f.unitPrice !== undefined) parts.push(`单价 ${f.unitPrice}`);
  parts.push(taxWord(f.tax));
  parts.push(`${f.date ?? ''}`);
  return `我听到的是：${parts.join('，')}`;
}

/**
 * **合计的那条口径**（D6.9）——**纯函数，只有这一处实现**。
 *
 * ⚠️ 为什么把它单独拎出来：出口那段文字（`ledger-text.js`）和服务端都要用同一个口径。
 *    抄第二份的那天起，"含税说不清算不算"就会有两个答案 ——
 *    而这个数的错法很安静：账面看起来只是"少算了一点"。
 *
 * 三条同时成立：**没钱的单列**（它们是"记了事没记钱"，不是 0 元）；
 * **含税说不清的排除并报数**（只排除不报数 = 悄悄少算）；**小数不留浮点尾巴**。
 *
 * @param {{qty:number, unitPrice:number|null, tax:boolean|string}[]} records
 * @returns {{total:number, counted:number, notCounted:number, noPrice:number}}
 */
export function foldTotals(records) {
  let total = 0;
  let counted = 0;
  let notCounted = 0;
  let noPrice = 0;
  for (const r of Array.isArray(records) ? records : []) {
    if (r.unitPrice === null || r.unitPrice === undefined) {
      noPrice += 1;
      continue;
    }
    if (r.tax === 'unknown') {
      notCounted += 1;
      continue;
    }
    total += r.qty * r.unitPrice;
    counted += 1;
  }
  // 浮点相加会给 0.30000000000000004 这种尾巴 ⇒ 只保留到分。
  return { total: Math.round(total * 100) / 100, counted, notCounted, noPrice };
}

export class Ledger {
  #store;
  #timeline;
  #timelineId;
  #now;
  #newId;
  #ttlMs;
  /** key → `{entryIds, at, seq}`（**在回收站里的**） */
  #bin = new Map();
  /** 已经真删掉的 id（内容不在盘上了） */
  #purged = new Set();

  /**
   * @param {object} o
   * @param {import('./store.js').Store} o.store
   * @param {import('./timeline.js').Timeline} o.timeline 账本自己那一条（**注入**）
   * @param {string} [o.timelineId]
   * @param {() => number} [o.now]
   * @param {() => string} [o.newId]
   * @param {number} [o.ttlMs]
   */
  constructor({
    store,
    timeline,
    timelineId = LEDGER_TIMELINE_ID,
    now = Date.now,
    newId = () => nodeCrypto.randomUUID(),
    ttlMs = LEDGER_TTL_MS,
  }) {
    if (!store) throw new LedgerError('store 必填');
    if (!timeline) throw new LedgerError('timeline 必填（账本自己那一条）');
    this.#store = store;
    this.#timeline = timeline;
    this.#timelineId = timelineId;
    this.#now = now;
    this.#newId = newId;
    this.#ttlMs = ttlMs;
  }

  get ttlMs() {
    return this.#ttlMs;
  }

  get ttlDays() {
    return Math.round(this.#ttlMs / (24 * 60 * 60 * 1000));
  }

  /**
   * 从盘上重建"谁被删过、谁已经真删了"。
   * ⚠️ 不 sync 的话，重启之后回收站是空的 —— 而账本里那些条**还藏着**，
   *    主人会以为永远拿不回来了。
   */
  sync() {
    this.#bin.clear();
    this.#purged.clear();
    for (const e of this.#store.readAll(this.#timelineId)) {
      const ids = normEntryIds(e?.entryIds);
      if (ids.length === 0) continue;
      if (e.type === TOMB_DELETED) this.#bin.set(keyOf(ids), { entryIds: ids, at: e.at ?? this.#now(), seq: e.seq });
      else if (e.type === TOMB_RESTORED) this.#bin.delete(keyOf(ids));
      else if (e.type === TOMB_PURGED) {
        this.#bin.delete(keyOf(ids));
        for (const id of ids) this.#purged.add(id);
      }
    }
    return this;
  }

  isHidden(entryId) {
    for (const t of this.#bin.values()) if (t.entryIds.includes(entryId)) return true;
    return false;
  }

  isPurged(entryId) {
    return this.#purged.has(entryId);
  }

  /** 回收站里有什么（**只报 id 与到期时刻，不把内容再抄一遍**）。 */
  listBin() {
    const items = [];
    for (const t of this.#bin.values()) {
      items.push({
        entryIds: [...t.entryIds],
        at: t.at,
        purgeAt: t.at + this.#ttlMs,
        preview: `${t.entryIds.length} 条`,
      });
    }
    items.sort((a, b) => a.at - b.at);
    return items;
  }

  /**
   * **只算不写**（契约 §7.3 的 `ledger_propose`）：校验 + 回显，**盘上一个字节都不动**。
   *
   * @returns {{ok:boolean, echo:string|null, fields:object|null, problems:{field,why}[], problemsText:string}}
   */
  propose(raw, { said = '' } = {}) {
    const { ok, fields, problems } = normalizeFields(raw);
    const saidProblem = checkSaid(said);
    const all = saidProblem ? [...problems, saidProblem] : problems;
    if (!ok || saidProblem) {
      return { ok: false, echo: null, fields: null, problems: all, problemsText: problemsLine(all) };
    }
    return { ok: true, echo: renderEcho(fields), fields, problems: [], problemsText: '' };
  }

  /**
   * **写一条**（契约 §7.3 的 `ledger_write`）。校验不过 ⇒ **抛**，盘上一个字节都不动。
   *
   * ⚠️ 这是本模块**唯一的写入口**，而且没有"改"的兄弟（D6.7：只追加）。
   */
  write(raw, { said = '' } = {}) {
    const { ok, fields, problems } = normalizeFields(raw);
    const saidProblem = checkSaid(said);
    const all = saidProblem ? [...problems, saidProblem] : problems;
    if (!ok || saidProblem) {
      throw new LedgerError(
        `这一条没有记下来：${problemsLine(all) || '有两项没听准'}`,
        { problems: all },
      );
    }
    const last = this.lastEvent();
    const entryId = this.#newId();
    if (typeof entryId !== 'string' || entryId === '') {
      throw new LedgerError('生不出这条账目的身份，什么都没写');
    }
    // ⚠️ 一天条数上限：**只在真的写之前查**，而且报的是人话。
    const today = this.countWrittenOn(dateOf(this.#now()));
    if (today >= MAX_ENTRIES_PER_DAY) {
      throw new LedgerError(
        `今天已经记了 ${today} 条，到上限了（最多 ${MAX_ENTRIES_PER_DAY} 条）。再记要等明天。`,
      );
    }
    const full = this.#timeline.emit({
      type: EV_ENTRY,
      entryId,
      ...fields,
      said: String(said).trim(),
      at: this.#now(),
    });
    void last;
    return { entryId, seq: full.seq, at: full.at, ...fields };
  }

  /** 盘上最后一条（本模块自己用；也给测试看"只追加"有没有真的追加）。 */
  lastEvent() {
    return this.#store.lastEvent(this.#timelineId);
  }

  /**
   * 某一天**写进来**几条（按写入时刻算，**不是**按账目上那个业务日期）。
   *
   * ⚠️ 这两个日期是两件事：`at` = "什么时候记的"，`date` = "这笔账算哪一天的"。
   *    上限防的是"某个循环里疯狂调用"，所以要按 **`at`** 数 ——
   *    按业务日期数的话，一个人把三个月前的账一口气补进来就会被误挡。
   */
  countWrittenOn(date) {
    return this.list().filter((r) => dateOf(r.at) === date).length;
  }

  /**
   * 折成"一条一条的账目"。
   *
   * ⚠️ **按 `entryId` 去重**（同一个 id 出现两次时，**后写的赢**）：恢复/重放会让它出现两次，
   *    不去重就会把同一笔算两遍。认不出 id 的行**直接跳过**（宁可少一条，也不凭猜塞一条进来）。
   *
   * @param {object} [o]
   * @param {boolean} [o.includeHidden] 连回收站里的一起给（默认 **false**：主人说过"删掉"的）
   */
  list({ includeHidden = false } = {}) {
    const byId = new Map();
    for (const e of this.#store.readAll(this.#timelineId)) {
      if (e?.type !== EV_ENTRY) continue;
      const id = typeof e.entryId === 'string' && e.entryId !== '' ? e.entryId : null;
      if (id === null) continue;
      byId.set(id, {
        entryId: id,
        seq: e.seq,
        at: e.at ?? null,
        kind: e.kind,
        qty: e.qty,
        unit: e.unit,
        unitPrice: e.unitPrice ?? null,
        tax: e.tax,
        date: e.date,
        said: e.said ?? '',
      });
    }
    const out = [];
    for (const [id, r] of byId) {
      if (this.#purged.has(id)) continue;
      if (!includeHidden && this.isHidden(id)) continue;
      out.push(r);
    }
    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));
    return out;
  }

  /**
   * **按"人说得出的那几项"找一笔**（`date` + `kind`，可选 `qty` / `unit`）。
   *
   * ⚠️ 为什么不让模型拿着 `entryId` 来删（这是**刻意的一刀**）：
   *    `entryId` 是**内部身份** —— 模型既拿不到它（`ledger_list` 那段文字里没有，
   *    也不该有），也不该把它念给主人听（内部词上屏 = 缺陷）。
   *    ⇒ 工具那一层按**主人说得出的话**找；身份这一层在这里解决。
   *
   * ⚠️ 找不唯一就**不猜**：把候选全给出去，让调用方去问清楚
   *    （认错一笔 = 删错账，那是这一批最贵的一类错）。
   */
  find({ date, kind, qty, unit } = {}) {
    const k = typeof kind === 'string' ? kind.trim() : '';
    return this.list().filter((r) => {
      if (date && r.date !== date) return false;
      if (k && !String(r.kind ?? '').includes(k) && !k.includes(String(r.kind ?? ''))) return false;
      if (qty !== undefined && qty !== null && Number(qty) !== r.qty) return false;
      if (unit && r.unit !== unit) return false;
      return true;
    });
  }

  /**
   * **合计**（D6.9）：含税说不清的那些**不进合计**，并且**明说有几条未计入**。
   *
   * ⚠️ 这两件事必须同时成立 —— 只排除不报数，就是"悄悄少算"；
   *    只报数不排除，就是把一个不知道含不含税的数和别的加在一起。
   *
   * @returns {{total:number, counted:number, notCounted:number, noPrice:number}}
   */
  totals() {
    return foldTotals(this.list());
  }

  /**
   * **删一条**：进回收站（落墓碑）。**与 ⑲ 同语义**（契约 §7.4）。
   * ⚠️ 幂等：同一条删两次不会产生两条墓碑。
   */
  remove(entryIds, { now = this.#now() } = {}) {
    const ids = normEntryIds(entryIds);
    if (ids.length === 0) throw new LedgerError('没说删哪一条');
    const k = keyOf(ids);
    const already = this.#bin.get(k);
    if (already) return already;
    for (const id of ids) {
      if (this.#purged.has(id)) throw new LedgerError('这一条已经彻底删掉了');
    }
    const full = this.#timeline.emit({ type: TOMB_DELETED, entryIds: ids, at: now });
    const rec = { entryIds: ids, at: now, seq: full.seq };
    this.#bin.set(k, rec);
    return rec;
  }

  /**
   * **拿回来**。
   *
   * ⚠️⚠️ 与 ⑲ 的 `restore` **有一处刻意的不同**：**不重发内容**。
   *    ⑲ 重发是因为**客户端有游标**（删掉时清了本机缓存，重连只补比游标新的）；
   *    账本**没有客户端游标这一层**，内容本来就还在盘上 ⇒ 落一条撤销墓碑就够了。
   *    重发反而会让同一个 `entryId` 在盘上出现两份 —— 而账本要算**合计**，
   *    那就得靠去重兜着；能不制造这种情况就不制造。
   */
  restore(entryIds) {
    const ids = normEntryIds(entryIds);
    if (ids.length === 0) throw new LedgerError('没说拿回来哪一条');
    const k = keyOf(ids);
    if (!this.#bin.has(k)) return false;
    this.#timeline.emit({ type: TOMB_RESTORED, entryIds: ids });
    this.#bin.delete(k);
    return true;
  }

  /**
   * **真删**：把内容从盘上压实掉（`Store.rewrite`）。
   *
   * ⚠️ **必须从头到尾同步**（`readAll` → 压实 → `emit` 中间不许有 `await`）：
   *    否则别人在这期间写的那一条会被这次重写抹掉 —— 那是**永久丢数据**。
   *    与 `trash.js` 的 `purge` 是同一条理由。
   */
  purge(entryIds, { now = this.#now() } = {}) {
    const ids = normEntryIds(entryIds);
    if (ids.length === 0) throw new LedgerError('没说彻底删哪一条');
    const gone = new Set(ids);
    const before = this.#store.readAll(this.#timelineId);
    let freed = 0;
    const after = [];
    for (const e of before) {
      const mine = typeof e?.entryId === 'string' && gone.has(e.entryId);
      const tomb = TOMBS.includes(e?.type) && normEntryIds(e.entryIds).some((id) => gone.has(id));
      if (!mine && !tomb) {
        after.push(e);
        continue;
      }
      // ⚠️ **保留 seq**：号一个都不许跳（N22）
      const placeholder = { type: TOMB_PURGED, seq: e.seq, at: e.at };
      freed += JSON.stringify(e).length - JSON.stringify(placeholder).length;
      after.push(placeholder);
    }
    this.#store.rewrite(this.#timelineId, after);
    const full = this.#timeline.emit({ type: TOMB_PURGED, entryIds: ids, at: now });
    this.#bin.delete(keyOf(ids));
    for (const id of ids) this.#purged.add(id);
    return { freedBytes: Math.max(0, freed), seq: full.seq };
  }

  /** 到点就真删（回收站里的 `at + ttl` 过了）。给定时扫描用。 */
  purgeExpired({ now = this.#now() } = {}) {
    const due = [];
    for (const t of this.#bin.values()) if (t.at + this.#ttlMs <= now) due.push(t.entryIds);
    return due.map((ids) => ({ entryIds: ids, ...this.purge(ids, { now }) }));
  }
}

/** 出处那一栏的校验（**原话不能是空的** —— D6.4"无出处不写"）。 */
function checkSaid(said) {
  const s = typeof said === 'string' ? said.trim() : '';
  if (s === '') return { field: 'said', why: '没留下是哪句话让你记的' };
  if (s.length > MAX_SAID_CHARS) {
    return { field: 'said', why: `那句话太长了（最多 ${MAX_SAID_CHARS} 个字）` };
  }
  return null;
}

function normEntryIds(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const v of list) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (s === '' || out.includes(s)) continue;
    out.push(s);
  }
  return out.sort();
}

const keyOf = (ids) => ids.join('\u0000');

/** 本地日期 `YYYY-MM-DD`（"今天记了几条"用的就是它）。 */
export function dateOf(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
