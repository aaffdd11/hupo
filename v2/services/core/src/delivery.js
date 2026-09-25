// **一对一索要数据包**那条路：**只建登记面，不建真传输**
// （契约 `docs/dev/99-STAGE4-DELIVERY.md` · `91-TRIPLE-CONTRACT.md` §六 ·
//   `92-TRIPLE-PLAN.md` §③ 阶段 4）。
//
// ── 这一版建什么（就四件，一步不多）────────────────────────
//
//   ① 索要 `delivery/request`  B 说清：要哪一份 · 哪个形状版本 · 哪个范围 · 拿去做什么
//   ② 同意 `delivery/consent`  **只读他当轮自己说的那句话**（逐项：份 / 形状版本 / 范围）
//   ③ 交付 `delivery/deliver`  **只登记"该交了"** —— 真搬运不在这一阶段
//   ④ 撤回 `delivery/revoke`   给的人随时能撤；撤回后**未来的请求一律拒**
//
// ── 🔴 最要紧的一条诚实边界（S4-5／S4-8）───────────────────
// **"落了一条【交付】记录" ≠ "对方收到了"。**
// 这一阶段**没有传输** ⇒ 任何回执**只许说这边真的做了什么**：
// "记下了要给你这份"／"你同意了"／"这一版还没有把东西送过去的路"。
// **不许**说"已经给他了""对方那边有了"——那是**声明 ≠ 事实**（`92` 纪律）。
// "对方那份还在不在"**今天没有任何信号** ⇒ 只能如实写 **`不可算`**，
// **绝不**给一个确定的答案（S4-8）。
// ⇒ 全篇对用户说的话只有一处出处：下面那张 `DELIVERY_COPY`（判据扫它，照
//    `work-words.js` 的 `WORK_COPY` 同款做法：**文案集中一处、判据扫它**）。
//
// ── 落哪（P-l：一条可见日志、一套号）──────────────────────
// 四条记录**落在这个人自己那条可见日志**上（`world.timeline` 底下那把 `Timeline`，
// 也就是 `main.jsonl`）：`Timeline.emit` 取号 ＋ `store.append` 落盘，
// **只追加**、写失败上抛（`store.js` 的契约）。
// 🔴 **不是第二条日志**：多作用域**只是事件上的 `scopeId` 标签**（传给 `scope`），
//    号仍然是一套 —— 手册 `05-DECISIONS.md` **P-l** /
//    `test/scope-single-log.test.js` 的 F1 判的就是这一条。
// ⚠️ 为什么不像 `worklog.js` 那样另起一条文件：那是**内部账**（不占号、用户看不到）；
//    这四条是**这条路上发生过什么**的登记面，必须与可见时间线同一条、同一套号（99 §二）。
//
// ── 🔴 两条结构性的"不许"────────────────────────────────
//   ① **记录里不许写手机号**：`from`/`to` 只收**人格 key**（`personaKeyOf` 由 `sub` 推，
//      与 `published.authorHashOf` **同一个函数** —— 不新造）。看着像手机号的输入**当场拒**。
//   ② **这一版一条字节都带不出去**：本模块**不读 `.data/`／`.exp/` 那一格**
//      （S4-9 的源码级判据就钉这一条）。交付只写一条**记录**，不复制任何内容 ——
//      "随装复制"那一条由 `workspace.read()`（跳过 `.` 开头的路径）与
//      `outbound.js` 的裁决兜着，这里不重复实现第二套搬运。

import { authorHashOf } from './published.js';

/** 四步各自的事件名（`type` 用 `delivery/xxx` 这样的名字 · 99 §二）。 */
export const EV_REQUEST = 'delivery/request';
export const EV_CONSENT = 'delivery/consent';
export const EV_DELIVER = 'delivery/deliver';
export const EV_REVOKE = 'delivery/revoke';

/** 这条路上的全部事件名（`list()` 只认这四种 —— 别的类型一概不看）。 */
export const DELIVERY_TYPES = Object.freeze([EV_REQUEST, EV_CONSENT, EV_DELIVER, EV_REVOKE]);

/**
 * 🔴 **算不出来就说"不可算"**（S4-8）。
 *
 * 今天**没有任何一条信号**能从这边看到"对方那份还在不在"（没有传输、没有对端回执）。
 * ⇒ 这个字面就是那种问题的**唯一合法答案**，而且是**集中一处**的
 * （改文案 / 变异验证都只动这里）。
 */
export const UNKNOWN = '不可算';

/** 认不出"他同意了"时跟他说的话（**fail-closed**，照 `apps-consent.js` 的保守默认）。 */
export const NEEDS_CONSENT_LINE =
  '这一份我没记成交付：得你亲口说一句同意，而且要说到是哪一份、哪个版本、哪个范围。'
  + '（别人在请求里写什么都不算。）';

/** 一条"原话"最长多少字（防呆，不是容量规划；同 `ledger.js` 的 `MAX_SAID_CHARS` 量级）。 */
export const MAX_SAY_CHARS = 200;

/** 中国大陆手机号的形状：**只是"看着像"**，用来把人挡在账外（不是身份校验）。 */
const PHONE_LIKE_RE = /^1[3-9]\d{9}$/;

export class DeliveryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeliveryError';
  }
}

const str = (v) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim());

/**
 * **人格 key**：由"这是谁"推出来，**不是手机号**。
 *
 * 🔴 直接复用 `published.authorHashOf` —— 共享库的作者署名用的就是它
 *    （`worlds.js` 里 `用户 ${authorHashOf(userId).slice(0,4)}`）。
 *    自己再写一个哈希就是"同一个东西两处实现"，两边一定会漂。
 */
export function personaKeyOf(owner) {
  return authorHashOf(owner);
}

/** `from`/`to` 的校验：**必须是人格 key**，看着像手机号的当场拒（99 §二）。 */
function personaKey(v, what) {
  const s = str(v);
  if (s === '') throw new DeliveryError(`${what}没说是谁 —— 这一条不记`);
  if (PHONE_LIKE_RE.test(s)) {
    throw new DeliveryError(`${what}不能是手机号 —— 账上只记人格 key（用 personaKeyOf 推一个）`);
  }
  return s;
}

/** 一项"逐项同意"的取值：非空就算有（空 ⇒ 这一项没说到）。 */
const item = (v) => str(v);

/**
 * 同意／拒绝的说法（都只看**他当轮那句话**）。
 *
 * ⚠️ 只留"对人说同意"的说法；`行吧`／`好吧` 单独一个**不算坏事** ——
 *    它们**过不了逐项那一关**（见 [`parseConsent`]：三项必须**逐字出现在他那句话里**）。
 */
const AGREE = /(同意|答应|可以给|给你|准了|批准|授权|没问题|行[,，]?\s*给|好吧[,，]?\s*给)/;
/** 明确回绝 / 收回的说法：**先查它**（`不同意` 里也有 `同意` 两个字，顺序错了会放行）。 */
const REFUSE = /(不[同意答应]|别给|不用给|不给|不要给|收回|撤回|拒绝|算了)/;

/**
 * 🔴 **从他当轮那句话里读出一次"逐项同意"**（S4-3／S4-4）——
 * **纯函数**，只认 `said`（服务端自己记的当轮输入）。
 *
 * 三条同时成立才给得出结果：
 *   ① `said` 是一句非空的话，里面有"同意"的说法，而且**没有**回绝的说法；
 *   ② 三项（份 / 形状版本 / 范围）**都非空**；
 *   ③ 三项**逐字出现在他那句话里** —— 这一条就是"**只读他当轮自己说的那句话**"：
 *      请求里带什么字段、`agreed:true` 之类，**一个字都进不来**
 *      （它们不会出现在 `said` 里）。
 *
 * ⚠️ 认不出 ⇒ `null`（**fail-closed**：宁可多问一句，不许多放一份）。
 *
 * @param {{said:unknown, packId:unknown, shapeVersion:unknown, range:unknown}} o
 * @returns {{packId:string, shapeVersion:string, range:string, said:string}|null}
 */
export function parseConsent({ said, packId, shapeVersion, range } = {}) {
  const text = str(said);
  if (text === '') return null; // 没有"他说的那句话"就没有同意这回事
  if (REFUSE.test(text)) return null; // "不同意""别给"先挡住
  if (!AGREE.test(text)) return null; // 认不出"他同意了" ⇒ 拒
  const items = { packId: item(packId), shapeVersion: item(shapeVersion), range: item(range) };
  for (const v of Object.values(items)) if (v === '') return null; // 逐项：三项都要有
  for (const v of Object.values(items)) if (!text.includes(v)) return null; // 而且要是他自己说的
  return { ...items, said: text.slice(0, MAX_SAY_CHARS) };
}

// ── 文案表（**对用户说的话只有这一处出处** · S4-5／S4-8）────────────
//
// 🔴 每一条都只说**这边真的做了什么**：
//    · 说"记下了"；不说"已经给他了"；
//    · 交付那条**明说没有送过去的路**（这就是这一阶段的全部真相）；
//    · 撤回那条**把"对方那份还在不在"如实标成 `不可算`**（没有信号）。
// 🔴 不许出现："已删除 / 对方收到了 / 对方那边有了 / 已经给到对方"这一族断言 ——
//    `test/delivery-stage4.test.js` 的 S4-5 逐字扫这张表（照 `time-words` 扫 `WORK_COPY`）。

/** 一条记录的**回执**文案（`type` → 那句人话）。 */
export const COPY_REQUEST = '记下了：你要这一份。';
export const COPY_CONSENT = '你同意了这一份，这边记下了。';
export const COPY_DELIVER = '记下了要给你这份；这一版还没有把东西送过去的路。';
export const COPY_REVOKE = '你说了以后不给这一份了，这边记下了。';
/** 撤回之后"未来"那句（新请求会被拒时说的）。 */
export const COPY_REVOKE_FUTURE = '以后不给了。';
/** 🔴 撤回之后"对面那份"那句：**只许说不可算**（S4-8）。 */
export const COPY_REVOKE_OTHER = `以前交出去的那一份还在不在对方那边，${UNKNOWN}。`;
/** 这一阶段换来的是**留痕，不是保护**（91 §6.4.4：不许写成"保证不再扩散"）。 */
export const COPY_TRACE_ONLY = '这边能承诺的只有留痕：谁给的、哪一版、什么范围。';

/**
 * **我们自己的文案表**（判据扫的就是它 ＋ 它生成的每一句）。
 * ⚠️ 与 `WORK_COPY` 同款：文案一处集中，判据扫表。
 */
export const DELIVERY_COPY = Object.freeze([
  { id: 'request-recorded', type: EV_REQUEST, text: COPY_REQUEST },
  { id: 'consent-recorded', type: EV_CONSENT, text: COPY_CONSENT },
  { id: 'deliver-registered', type: EV_DELIVER, text: COPY_DELIVER },
  { id: 'revoke-recorded', type: EV_REVOKE, text: COPY_REVOKE },
  { id: 'revoke-future-refused', type: null, text: COPY_REVOKE_FUTURE },
  { id: 'revoke-other-side', type: null, text: COPY_REVOKE_OTHER },
  { id: 'trace-only', type: null, text: COPY_TRACE_ONLY },
]);

/** 按 id 取一句文案（取不到 ⇒ 抛：表里没有的话**不许**说给用户听）。 */
export function receiptLine(id) {
  const hit = DELIVERY_COPY.find((c) => c.id === id);
  if (!hit) throw new DeliveryError(`文案表里没有这一条（${String(id)}）`);
  return hit.text;
}

/**
 * 🔴 **"对方那份还在不在"这个事实**（S4-8）——**今天算不出来**。
 *
 * 这一阶段**没有传输**、也**没有对端的任何回执** ⇒ 这边**一条信号都没有**。
 * ⇒ 如实返回 `不可算`，并**把"为什么算不出"一起说出来**（"没有信号"本身要能给人看）。
 * ⚠️ 这个函数**永远**是可算的：可算的那个值就是"不可算" —— 判据要的就是"不许给确定答案"。
 *
 * @returns {{what:string, value:string, computable:boolean, why:string, line:string}}
 */
export function otherSideFact() {
  return {
    what: '对方那份还在不在',
    value: UNKNOWN,
    computable: false,
    why: '这边没有对方那边的信号（这一版没有传输、也没有对端回执）',
    line: COPY_REVOKE_OTHER,
  };
}

/**
 * 一条记录 → 给用户看的回执（**只有这一处出口**）。
 *
 * @param {object} rec `list()` 里那一条
 * @returns {{line:string, otherSide:object|null}} `otherSide` 只有撤回那条带（S4-8）
 */
export function receiptFor(rec) {
  switch (rec?.type) {
    case EV_REQUEST:
      return { line: receiptLine('request-recorded'), otherSide: null };
    case EV_CONSENT:
      return { line: receiptLine('consent-recorded'), otherSide: null };
    case EV_DELIVER:
      return { line: receiptLine('deliver-registered'), otherSide: null };
    case EV_REVOKE:
      return { line: receiptLine('revoke-recorded'), otherSide: otherSideFact() };
    default:
      throw new DeliveryError(`认不出这是哪一步（${String(rec?.type)}）—— 这一句不给用户看`);
  }
}

/** 一条链的名字（四步共用；**不是随机 id**，省得模型还要把它念回来）。 */
export function chainKeyOf({ from, to, packId, shapeVersion }) {
  return `d:${from}:${to}:${packId}:${shapeVersion}`;
}

/**
 * 四步的**登记面**（一步一条记录，落在那条可见日志上）。
 *
 * @param {object} o
 * @param {object} o.timeline  这个人的时间线（`ScopeView`；`base` 就是那条 `Timeline`）
 * @param {(scope:string)=>object} [o.viewFor] 按作用域取视图（多作用域**只是标签**）
 * @param {()=>number} [o.now]
 * @param {(packId:string)=>string|null} [o.shapeOf]
 *        可选：这一份**声明**的形状版本（给得出就**交叉核**，对不上 ⇒ 拒 —— S4-7 的"不许静默算对"）。
 *        ⚠️ 今天**没有生产者**（98 B22）⇒ 不给这个钩子时只能查"请没请求形状版本"那一半。
 */
export class Delivery {
  #timeline;
  #log;
  #viewFor;
  #now;
  #shapeOf;

  constructor({ timeline, viewFor = null, now = Date.now, shapeOf = null }) {
    if (!timeline) throw new DeliveryError('delivery 要一条时间线（四条记录落在可见日志上）');
    this.#timeline = timeline;
    // 🔴 读**整条日志**（所有作用域一起）：P-l 说多作用域只是标签，不是另一本账。
    this.#log = typeof timeline.base?.readAll === 'function' ? timeline.base : timeline;
    this.#viewFor = typeof viewFor === 'function' ? viewFor : null;
    this.#now = now;
    this.#shapeOf = typeof shapeOf === 'function' ? shapeOf : null;
  }

  /** 这一间写事件用的视图（没接 `viewFor` ⇒ 用注入的那一个）。 */
  #view(scope) {
    const s = str(scope);
    if (s === '' || s === 'main') return this.#timeline;
    if (!this.#viewFor) {
      throw new DeliveryError(`没接多作用域那一半，写不进「${s}」`);
    }
    return this.#viewFor(s);
  }

  /** 落一条（**只追加**；写失败由 `Timeline.emit` 上抛）。 */
  #emit(scope, event) {
    const full = this.#view(scope).emit({ ...event, at: this.#now() });
    return full;
  }

  /**
   * 折出这条路上的全部记录（**读盘**，不是读内存 —— "只在内存里 ⇒ 红"）。
   *
   * ⚠️ 读的是**这个人那一条日志的全部**（含各作用域），认不出的行直接跳过
   *    （宁可少一条，也不凭猜塞一条进来 —— 同 `ledger.list()`）。
   */
  list({ from = null, to = null, packId = null, type = null, chain = null } = {}) {
    const f = from === null ? null : str(from);
    const t = to === null ? null : str(to);
    const p = packId === null ? null : str(packId);
    const out = [];
    for (const e of this.#log.readAll()) {
      if (!DELIVERY_TYPES.includes(e?.type)) continue;
      const rec = {
        seq: e.seq ?? null,
        at: e.at ?? null,
        type: e.type,
        chainId: e.chainId ?? null,
        from: e.from ?? null,
        to: e.to ?? null,
        packId: e.packId ?? null,
        shapeVersion: e.shapeVersion ?? null,
        range: e.range ?? null,
        why: e.why ?? '',
        scopeId: e.scopeId ?? 'main',
      };
      if (f !== null && rec.from !== f) continue;
      if (t !== null && rec.to !== t) continue;
      if (p !== null && rec.packId !== p) continue;
      if (type !== null && rec.type !== type) continue;
      if (chain !== null && rec.chainId !== chain) continue;
      out.push(rec);
    }
    out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    return out;
  }

  /** 🔴 撤回以后**一律拒**（S4-6）：只看（谁对谁 · 份 · 形状版本），**范围不看**（契约 6.3.4"一律"）。 */
  #revoked({ from, to, packId, shapeVersion }) {
    return this.list({ from, to, packId, type: EV_REVOKE }).some(
      (r) => str(r.shapeVersion) === str(shapeVersion),
    );
  }

  /**
   * ① **索要**（`delivery/request`）。
   *
   * 🔴 **必须指形状版本**（S4-7）：`shapeVersion` 空 ⇒ **拒**，盘上零残留。
   * 🔴 **撤回后新请求 ⇒ 拒**（S4-6）。
   */
  request({ from, to, packId, shapeVersion, range = null, why = '', scope = 'main' } = {}) {
    const f = personaKey(from, '给的人');
    const t = personaKey(to, '要的人');
    const p = item(packId);
    if (p === '') throw new DeliveryError('没说清要哪一份 —— 这一条不记');
    const v = item(shapeVersion);
    if (v === '') {
      throw new DeliveryError('没说清要哪个形状版本 —— 这一条不记（形状对不上的值不许静默算）');
    }
    const say = str(why);
    if (say === '') throw new DeliveryError('没留下是谁的哪句话要的 —— 这一条不记');
    // ★ 形状版本**交叉核**（给得出声明时）：对不上 ⇒ 拒，**不许**静默算对
    if (this.#shapeOf) {
      const declared = this.#shapeOf(p);
      if (declared !== null && declared !== undefined && str(declared) !== v) {
        throw new DeliveryError(
          `这一份声明的形状版本是 ${str(declared)}，你说的 ${v} 对不上 —— 不记（对不上就不许算）`,
        );
      }
    }
    if (this.#revoked({ from: f, to: t, packId: p, shapeVersion: v })) {
      throw new DeliveryError(`${COPY_REVOKE_FUTURE}这一份他已经说了不给 —— 新的请求一律拒。`);
    }
    const chainId = chainKeyOf({ from: f, to: t, packId: p, shapeVersion: v });
    return this.#emit(scope, {
      type: EV_REQUEST,
      chainId,
      from: f,
      to: t,
      packId: p,
      shapeVersion: v,
      range: range === null || range === undefined || str(range) === '' ? null : str(range),
      why: say.slice(0, MAX_SAY_CHARS),
    });
  }

  /**
   * ② **同意**（`delivery/consent`）。
   *
   * 🔴 只读 `said` —— **服务端自己记的"他当轮那句话"**；`req` 里带 `agreed:true`
   *    或任何字段都**不算**（S4-3），三项还必须**逐字出现在他那句话里**（S4-4）。
   * 🔴 没有可识别的同意 ⇒ **拒**（S4-2 的上游，照 `apps-consent.js` 的保守默认）。
   * ⚠️ 同意必须**答一条真请求**：盘上没有对得上的【请求】⇒ 拒（不然就是一张空白授权）。
   */
  consent({ req = {}, said = '', scope = 'main' } = {}) {
    const f = personaKey(req?.from, '给的人');
    const t = personaKey(req?.to, '要的人');
    const parsed = parseConsent({
      said,
      packId: req?.packId,
      shapeVersion: req?.shapeVersion,
      range: req?.range,
    });
    if (!parsed) throw new DeliveryError(NEEDS_CONSENT_LINE);
    const hit = this.list({ from: f, to: t, packId: parsed.packId, type: EV_REQUEST }).some(
      (r) => str(r.shapeVersion) === parsed.shapeVersion,
    );
    if (!hit) {
      throw new DeliveryError(
        '这一份没见着对应的请求，我不敢把你的话当成同意 —— 先说要哪一份、哪个版本。',
      );
    }
    const chainId = chainKeyOf({
      from: f, to: t, packId: parsed.packId, shapeVersion: parsed.shapeVersion,
    });
    return this.#emit(scope, {
      type: EV_CONSENT,
      chainId,
      from: f,
      to: t,
      packId: parsed.packId,
      shapeVersion: parsed.shapeVersion,
      range: parsed.range,
      // `why` = **他那句话的原话**（落盘 ⇒ 将来对账看得出同意是打哪句话来的）
      why: parsed.said,
    });
  }

  /**
   * ③ **交付（只登记"该交了"）**。
   *
   * 🔴 **无同意 ⇒ 失败**（S4-2，fail-closed）：盘上找不到**逐项对得上**的【同意】⇒ 抛。
   * 🔴 撤回过的 ⇒ 也拒（撤回**撤销**了同意）。
   * 🔴 **这一版不搬字节**：只落一条记录；`.data/`／`.exp/` 一个字节都不读（S4-9）。
   */
  deliver({ from, to, packId, shapeVersion, range = null, scope = 'main' } = {}) {
    const f = personaKey(from, '给的人');
    const t = personaKey(to, '要的人');
    const p = item(packId);
    const v = item(shapeVersion);
    if (p === '' || v === '') throw new DeliveryError('没说清交付哪一份、哪个形状版本 —— 不记');
    const g = range === null || range === undefined || str(range) === '' ? '' : str(range);
    if (this.#revoked({ from: f, to: t, packId: p, shapeVersion: v })) {
      throw new DeliveryError('这一份他已经说了不给 —— 交付不成立。');
    }
    const ok = this.list({ from: f, to: t, packId: p, type: EV_CONSENT }).some(
      (r) => str(r.shapeVersion) === v && str(r.range) === g,
    );
    if (!ok) throw new DeliveryError(NEEDS_CONSENT_LINE);
    const chainId = chainKeyOf({ from: f, to: t, packId: p, shapeVersion: v });
    return this.#emit(scope, {
      type: EV_DELIVER,
      chainId,
      from: f,
      to: t,
      packId: p,
      shapeVersion: v,
      range: g === '' ? null : g,
      why: '',
    });
  }

  /**
   * ④ **撤回**（`delivery/revoke`）。
   *
   * 🔴 **撤回这件事本身落盘**（S4-6）：它就是一条记录，不是界面上一个开关。
   * 🔴 撤回之后：**未来的请求一律拒**（`request()` 查它）、**不再交付**（`deliver()` 查它）。
   * ⚠️ 它**不删**对面已经拿到的那一份 —— 物理上收不回（91 §6.4 顶上那句话），
   *    所以回执里**只许说不可算**（S4-8）。
   */
  revoke({ from, to, packId, shapeVersion, range = null, why = '', scope = 'main' } = {}) {
    const f = personaKey(from, '给的人');
    const t = personaKey(to, '要的人');
    const p = item(packId);
    const v = item(shapeVersion);
    if (p === '' || v === '') throw new DeliveryError('没说清撤回哪一份、哪个形状版本 —— 不记');
    const say = str(why);
    if (say === '') throw new DeliveryError('没留下是谁的哪句话要撤的 —— 这一条不记');
    const chainId = chainKeyOf({ from: f, to: t, packId: p, shapeVersion: v });
    return this.#emit(scope, {
      type: EV_REVOKE,
      chainId,
      from: f,
      to: t,
      packId: p,
      shapeVersion: v,
      range: range === null || range === undefined || str(range) === '' ? null : str(range),
      why: say.slice(0, MAX_SAY_CHARS),
    });
  }
}
