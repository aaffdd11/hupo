// **派活**（job）—— 契约 `docs/dev/102-APP-BIRTH-SCOPE.md`（主人 2026-09-25 拍「乙」）。
//
// ── 它是什么（照契约 §一 那四步，一句一句落）────────────────────
//
//   主进程（他聊天的那一条）
//     │  他说："帮我做一个 X 的 app"
//     ├─ ①【派活】调度器把这件活交给**一个子进程**（那一间＝一个新的工作区／图标）
//     │      · 建工作区、建会话（cwd ＝ 那个工作区）
//     │      · 把**任务与由来**一起交过去
//     ├─ ②【子进程干活】它在那间里做 X（写文件、`app_create` 都**它自己**调）
//     ├─ ③【回报】它做完 ⇒ 做一份**总结**，**扔回主进程**
//     │      · 主进程里出现一条**人话**：做了什么 · 叫什么 · 在哪儿看
//     └─ ④【主进程侧的简登记】有哪些小程序／工作区 ＋ 各自最后一条总结
//            · ⚠️ **它是索引，不是日志副本**：那段对话仍在它自己那一间
//
// ── 与 **转交**（`handoff.js` / N16）的分界（契约 §三）──────────
//   · **转交** = 交给**已经存在**的一间（目标必须已存在 · **不建**）；
//   · **派活** = 让调度器**新建**一间，把那件活交过去。
//   两条路各自可判，`handoff_to` 那套一个字都不动。
//
// ── 四条不许破（契约 §一）────────────────────────────────────
//   ① 焦点跟他走（`84-C` 已建，这一层不碰）；
//   ② 活在哪间干、就在哪间留痕（子进程那段是**它自己**的对话，主进程不复制）；
//   ③ 回报必须是**总结**（人话），不是把子进程那段倒进主进程；
//   ④ 登记是**简单的**（谁·什么·在哪·最后一条总结）——它是**索引**，可重建。
//
// 🔴 **名字从子进程的总结里来**（B20）：租户那份 app 的名字在**他盒子里**，
//    宿主查不到（`whereTitle` 那一半对租户恒 `null`）⇒ P3 那句"叫什么"**不许**
//    依赖宿主侧的 `titleOfApp`，只能用它自己交回来的那个名字。
//
// 🔴 **一条日志、一套号**（P-l）：这里产出的两帧（`job/start` / `job/report`）
//    落在**那条**可见日志上（主进程那一间的视图），**不新开日志、不另起号**。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { REFUSED_APP_IDS } from './apps.js';
import { safeScope } from './workspace.js';
import { workResultLine } from './work-words.js';
import { MAIN_SCOPE } from './worlds.js';

/** 派活那两帧的事件类型（**产品事件**，落在那一条日志上）。 */
export const JOB_START = 'job/start';
export const JOB_REPORT = 'job/report';

/**
 * ★ **"现在该看哪一间"那一帧**（契约 `102` 追加的 ⑤：派活之后界面自己切过去）。
 *
 * 🔴 **它是瞬态**（`Timeline.emitTransient`）：**不落盘、不占号**，
 *    而且 `sinceSeq=0` 的补发只走 `store.readAll()` ⇒ **重连时永远不会重放它**
 *    （"补发历史时乱切房间"那条反例结构上不可能）。
 *
 * 🔴 **字段叫 `scope`，不叫 `scopeId`**：服务端那条流的实时路由是
 *    `server.js` 的 `eventInScope(event, focus)`，而它**看的就是 `scopeId` 字段**
 *    ⇒ 带 `scopeId=<新那一间>` 会被"当前焦点是主线"的那条连接**直接丢掉**，
 *    而那正是最该收到它的人。不带 `scopeId` ⇒ 按主线那一档路由（他刚在主对话里派完活）。
 */
export const SCOPE_OPEN = 'scope/open';

/** 那一帧的形状（**只有一处**，推送与判据都用它）。 */
export function scopeOpenEvent({ scope, at = Date.now() } = {}) {
  return { type: SCOPE_OPEN, scope: String(scope), at };
}


/** 登记那个文件叫什么（`<dir>/jobs.jsonl`）。**只有这一处**。 */
export const JOB_FILE = 'jobs.jsonl';

/**
 * 总结里"做了什么"那半句最多留多少字（**住代码，不写文档** · 手册纪律 1）。
 * ⚠️ 它只影响**主进程那条提醒**的长度：完整那段仍在子进程那一间里。
 */
export const JOB_SUMMARY_MAX = 160;

/** 那一格存哪（**跟人走**：每个用户一本登记）。 */
export function jobsPath(dir) {
  return nodePath.join(dir, JOB_FILE);
}

/**
 * 派活**被拒**时给模型/人的那几句话。
 *
 * ⚠️ 它们是**模型读到的**（会被它转述给人）⇒ **不许出现内部词**
 *    （工作区 / 客户端 / 云端 / 口令 / 连接 / 工具名…），而且要说清"那就别派"。
 */
export const JOB_LINES = Object.freeze({
  self: '这件事就在这儿做，不用另开一处。',
  nested: '这种事只在主对话里说；你在这儿接着做你手上的事就行。',
  badName: '那个短名不成（只许小写字母、数字、短横，例如 math-drill）。你想一个再来；我这边什么都没动。',
  reserved: '那个名字桌面上本来就有，不能拿去当新的一处。你想一个别的再来；我什么都没动。',
  exists: '那个名字下已经有一处了，我没有再建一个。要是这件事本来就是那一处在管的，用另一条路交给它。',
  noBook: '这一台还没接上派活那本登记，派不了。',
  failed: '另开那一处没成。这件事我就在这儿接着做，做完告诉你。',
  noOpen: '这一处没有等着交回来的活。',
  noWords: '交回来得说清两样：它叫什么、做成了什么。',
  /** 派成了 ⇒ 给模型的那句（它会转述）。 */
  started: '好，这件事我另开一处专门做，做完把结果告诉你。',
  /** 收下了那份总结 ⇒ 给子进程的那句。 */
  done: '好，我把结果告诉他了。',
  /** `job_list` 一条都没有时的兜底。 */
  empty: '你手上现在还没有交过总结的东西。',
});

/**
 * **这次派活许不许发**（裁决本体 · 纯函数 · 不碰盘、不碰时钟）。
 *
 * @param {object} o
 * @param {string} o.by            发起那一间（**只有主进程那一间能派**）
 * @param {string} o.where         提议的新那一间的短名
 * @param {boolean} o.targetExists 那个短名**现在已经有主了吗**
 * @returns {{ok:true, where:string} | {ok:false, reason:string, text:string}}
 */
export function decideJobStart({ by, where, targetExists = false } = {}) {
  const who = by === null || by === undefined || by === '' ? MAIN_SCOPE : String(by);
  // ★ 派活是**主进程那一间**的动作（契约 §一 第①步："我说要做一个 APP"）。
  //   子进程里再派一层会把"谁在做什么"变成一棵说不清的树 ⇒ 不做。
  if (who !== MAIN_SCOPE) return { ok: false, reason: 'nested', text: JOB_LINES.nested };
  const w = safeScope(where);
  if (!w || w === MAIN_SCOPE) return { ok: false, reason: 'badName', text: JOB_LINES.badName };
  if (REFUSED_APP_IDS.includes(w)) return { ok: false, reason: 'reserved', text: JOB_LINES.reserved };
  // ★ 与 N16 那条正好相反：**派活是新建** ⇒ 已经有一处了就不建（那是"转交"那件事）。
  if (targetExists === true) return { ok: false, reason: 'exists', text: JOB_LINES.exists };
  return { ok: true, where: w };
}

/**
 * **交给子进程的那份任务书**（"他让我做 X" ＋ 他说的那句原话）。
 *
 * ⚠️ 它只进子进程那一轮的投递（`Session.deliverJob`）——
 *    **不许**抄进主进程那一间（契约 §一 ②：主进程里没有这段过程）。
 * ⚠️ 里面**不许**出现主人看不见的内部 id 当"名字"：`where` 只是它干活的短名
 *    （和它 `HUPO_SCOPE` 拿到的是同一个值），成品叫什么由**它自己**在总结里说。
 */
export function jobPacketText({ where, why } = {}) {
  const w = String(where ?? '').trim();
  const y = String(why ?? '').trim();
  return [
    '【新的一处】主人让你在这里做一件东西。这件事做完之前，别的事先放一放。',
    y ? `他要的是：${y}` : '',
    y ? `他原话是这么说的：「${y}」` : '',
    w ? `你这一处的短名是 ${w}（做东西的时候拿它当短名）。` : '',
    '做完之后，把它叫什么、做成了什么，用一句人话说清楚交回去。'
      + '别把过程抄一遍，只说你做成了什么、它在哪儿能打开。',
  ]
    .filter((s) => s !== '')
    .join('\n');
}

/**
 * **扔回主进程的那条人话总结**：做了什么 · 叫什么 · 在哪儿看。
 *
 * 🔴 **"叫什么"用的是子进程交回来的那个名字**（`name`）——**不是**宿主侧的
 *    `whereTitle`（B20：租户那份 app 的名字在他盒子里，宿主查不到）。
 * ⚠️ "做了什么"那半句过 `workResultLine`：带没依据的时间词就**不重复它**
 *    （契约 88 §二.4 同一条纪律；名字与"在哪看"照旧留着，不许因为半句没了就整条不发）。
 */
export function jobSummaryText({ name, summary } = {}, { hasTimeClaim = () => false } = {}) {
  const n = String(name ?? '').trim();
  const s = workResultLine(String(summary ?? ''), { max: JOB_SUMMARY_MAX, hasTimeClaim }).trim();
  if (n === '') return s === '' ? '做完了。' : `做完了。${s}`;
  const head = s === '' ? '做完了。' : `做完了。${s}`;
  return `${head}它叫「${n}」，在「${n}」里看。`;
}

/**
 * **从那一条日志里重扫出登记**（纯函数 · P5 的"能从日志重建"那一半）。
 *
 * 认的两帧就是上面那两个类型；同 `where` **后一条说了算**（追加式推进，
 * 与 `handoff.js` / `worklog.js` 那条路同形）。
 *
 * @param {Array<object>} events 那条日志的全量（`store.readAll('main')`）
 * @returns {Map<string, object>} `where` → `{where, id, status, why, name, summary, at}`
 */
export function jobRowsFromEvents(events) {
  const out = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e.type !== 'string') continue;
    if (e.type !== JOB_START && e.type !== JOB_REPORT) continue;
    const where = typeof e.where === 'string' ? e.where.trim() : '';
    if (where === '') continue;
    const had = out.get(where) ?? {
      where,
      id: null,
      status: null,
      why: null,
      name: null,
      summary: null,
      at: null,
    };
    if (typeof e.id === 'string' && e.id !== '') had.id = e.id;
    if (typeof e.at === 'number') had.at = e.at;
    if (e.type === JOB_START) {
      had.status = 'started';
      if (typeof e.why === 'string' && e.why.trim() !== '') had.why = e.why.trim();
    } else {
      had.status = 'reported';
      if (typeof e.name === 'string' && e.name.trim() !== '') had.name = e.name.trim();
      if (typeof e.summary === 'string' && e.summary.trim() !== '') had.summary = e.summary.trim();
    }
    out.set(where, had);
  }
  return out;
}

/**
 * **主进程侧那份简登记**（一个人一本 · 落 `<dir>/jobs.jsonl`）。
 *
 * 🔴 **它是索引，不是第二份日志**（契约 §一 ④ / P5）：
 *    · 一段对话**一个字都不进去**（那段仍在它自己那一间）；
 *    · 每条只记：谁（`where`）· 什么（`name`）· 在哪看（`name`）· 最后一条总结；
 *    · **删掉它 ⇒ 重扫那条日志又对得上**（`rebuild()`；文件不在时构造就自动重扫）。
 *
 * 形状（一行一条 JSON；同 `where` 后一条说了算）：
 *
 *   {"type":"job","id":"j_…","at":…,"where":"math-drill","status":"started","why":"…"}
 *   {"type":"job","id":"j_…","at":…,"where":"math-drill","status":"reported",
 *    "name":"算数小练","summary":"…"}
 */
export class JobBook {
  #dir;
  #file;
  #log;
  #store;
  #listScopes;
  #rows = new Map();
  #order = [];
  #seq = 0;

  /**
   * @param {object} o
   * @param {string} o.dir   这个人那一格（`world.dir`）
   * @param {object} [o.store] 那条日志（给不出来 ⇒ 登记文件是**唯一**能读的，`rebuild` 仍可手调）
   * @param {() => {apps: Array<object>, workspaces: Array<string>}} [o.listScopes]
   *        盘上"有哪些小程序／工作区"（**唯一出处是那两处**，这里只取、不另存）
   * @param {(m:string)=>void} [o.log]
   */
  constructor({ dir, store = null, listScopes = null, log = () => {} } = {}) {
    if (!dir) throw new Error('JobBook 需要 dir');
    this.#dir = dir;
    this.#file = jobsPath(dir);
    this.#log = log;
    this.#store = store;
    this.#listScopes = typeof listScopes === 'function' ? listScopes : null;
    const loaded = this.#loadFile();
    // ★ **登记不在 ⇒ 重扫那条日志**（P5：删掉登记，重扫一遍又对得上）。
    if (!loaded && this.#store) this.#adopt(this.rebuild());
    return this;
  }

  get path() {
    return this.#file;
  }

  /** 盘上那份登记（一行一条；坏行跳过 —— **不许把整本账带走**）。 */
  #loadFile() {
    let raw = '';
    try {
      raw = nodeFs.readFileSync(this.#file, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') this.#log(`派活那本登记没读出来：${err?.message ?? err}`);
      return false;
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec || typeof rec.where !== 'string' || rec.where === '') continue;
      this.#merge(rec);
    }
    return true;
  }

  #merge(rec) {
    const had = this.#rows.get(rec.where);
    if (had) {
      Object.assign(had, rec, { where: rec.where });
    } else {
      this.#rows.set(rec.where, { ...rec });
      this.#order.push(rec.where);
    }
    if (typeof rec.id === 'string' && rec.id !== '') this.#seq += 1;
  }

  #append(rec) {
    nodeFs.mkdirSync(this.#dir, { recursive: true });
    nodeFs.appendFileSync(this.#file, `${JSON.stringify(rec)}\n`);
  }

  /** 把一批重扫出来的行**装进**内存（构造时登记不在那条路用它）。 */
  #adopt(rows) {
    for (const r of rows) {
      if (!this.#rows.has(r.where)) {
        this.#rows.set(r.where, { ...r });
        this.#order.push(r.where);
      }
    }
  }

  /** 全部记录（按 `where` 排序；诊断 / 判据用）。 */
  all() {
    return [...this.#rows.values()]
      .map((r) => ({ ...r }))
      .sort((a, b) => String(a.where).localeCompare(String(b.where)));
  }

  forScope(where) {
    const r = this.#rows.get(String(where));
    return r ? { ...r } : null;
  }

  /** **还开着的那些活**（派出去、还没交回总结）。 */
  open() {
    return this.all().filter((r) => r.status === 'started');
  }

  /** 这一间还开着的那件（没有 ⇒ `null`）。 */
  openFor(where) {
    const r = this.forScope(where);
    return r && r.status === 'started' ? r : null;
  }

  /** ★ 派活那一刻记一行（**索引**：谁 · 为什么 · 什么时候）。 */
  recordStart({ id = null, where, why = null, at = Date.now() } = {}) {
    const wid = String(where);
    const jid = typeof id === 'string' && id !== '' ? id : `j_${at.toString(36)}_${(this.#seq + 1).toString(36)}`;
    const rec = {
      type: 'job',
      id: jid,
      at,
      where: wid,
      status: 'started',
      why: typeof why === 'string' && why.trim() !== '' ? why.trim() : null,
    };
    this.#append(rec);
    this.#merge(rec);
    return { ...rec };
  }

  /** ★ 子进程交回总结那一刻记一行（同 `id`／同 `where` 推进到 `reported`）。 */
  recordReport({ id = null, where, name, summary, at = Date.now() } = {}) {
    const wid = String(where);
    const had = this.#rows.get(wid);
    const jid = typeof id === 'string' && id !== '' ? id : (had?.id ?? `j_${at.toString(36)}_${(this.#seq + 1).toString(36)}`);
    const rec = {
      type: 'job',
      id: jid,
      at,
      where: wid,
      status: 'reported',
      name: typeof name === 'string' && name.trim() !== '' ? name.trim() : null,
      summary: typeof summary === 'string' && summary.trim() !== '' ? summary.trim() : null,
    };
    this.#append(rec);
    this.#merge(rec);
    return { ...rec };
  }

  /** 盘上"有哪些小程序／工作区"（**只取，不另存**）。 */
  #scopes() {
    const o = (() => {
      try {
        return this.#listScopes?.() ?? null;
      } catch (err) {
        this.#log(`派活登记：盘上那两处没读出来（${err?.message ?? err}）`);
        return null;
      }
    })();
    const workspaces = Array.isArray(o?.workspaces) ? o.workspaces : [];
    const apps = Array.isArray(o?.apps) ? o.apps : [];
    return { workspaces, apps };
  }

  /**
   * **登记里列得出**（P5 的正面）：有哪些小程序／工作区 ＋ 各自最后一条总结。
   * 没交过总结的那些也列出来（`status: null`）——"他有哪些工作区"本来就该答得出。
   */
  list({ apps = null, workspaces = null } = {}) {
    const disk = this.#scopes();
    const ws = Array.isArray(workspaces) ? workspaces : disk.workspaces;
    const ap = Array.isArray(apps) ? apps : disk.apps;
    const rows = new Map(this.#rows);
    const add = (id, title) => {
      const wid = String(id);
      if (wid === '' || wid === MAIN_SCOPE) return;
      const had = rows.get(wid);
      if (had) {
        if (!had.title && title) rows.set(wid, { ...had, title });
        return;
      }
      rows.set(wid, { where: wid, id: null, status: null, why: null, name: null, summary: null, at: null, title: title ?? null });
    };
    for (const id of ws) add(id, null);
    for (const a of ap) add(a?.id, typeof a?.title === 'string' ? a.title : null);
    for (const [k, v] of rows) if (!v.title) rows.set(k, { ...v, title: null });
    return [...rows.values()]
      .map((r) => ({ ...r }))
      .sort((a, b) => String(a.where).localeCompare(String(b.where)));
  }

  /**
   * ★ **从日志重扫一遍**（P5：删掉登记 ⇒ 重扫一遍又对得上）。
   *
   * @param {Array<object>} [events] 那条日志的全量；不给就用 `store` 读
   * @returns {Array<object>} 与 `list()` 同形的那些行
   */
  rebuild(events = null) {
    let evs = events;
    if (!Array.isArray(evs)) {
      try {
        evs = this.#store?.readAll?.('main') ?? [];
      } catch (err) {
        this.#log(`派活登记重扫：日志没读出来（${err?.message ?? err}）`);
        evs = [];
      }
    }
    const disk = this.#scopes();
    const rows = new Map(jobRowsFromEvents(evs));
    const add = (id, title) => {
      const wid = String(id);
      if (wid === '' || wid === MAIN_SCOPE) return;
      if (!rows.has(wid)) {
        rows.set(wid, { where: wid, id: null, status: null, why: null, name: null, summary: null, at: null, title: title ?? null });
      } else if (title) {
        rows.set(wid, { ...rows.get(wid), title });
      }
    };
    for (const id of disk.workspaces) add(id, null);
    for (const a of disk.apps) add(a?.id, typeof a?.title === 'string' ? a.title : null);
    for (const [k, v] of rows) if (!v.title) rows.set(k, { ...v, title: null });
    return [...rows.values()]
      .map((r) => ({ ...r }))
      .sort((a, b) => String(a.where).localeCompare(String(b.where)));
  }

  /**
   * ★ **给主进程那条会话的几句人话**（`job_list` 那条口用它）。
   * 🔴 **不带内部短名上屏**（`06` 禁用词那条）：能拿到的名字就用名字，
   *    拿不到的就只说"还有一处没起名的"。
   */
  humanLines() {
    const rows = this.list().filter((r) => r.status !== null || r.title);
    if (rows.length === 0) return { count: 0, text: JOB_LINES.empty, items: [] };
    const items = rows.map((r) => {
      const shown = r.name || r.title || null;
      if (r.status === 'started' && !r.summary) {
        return {
          where: r.where,
          text: shown ? `「${shown}」还在做，做完告诉你` : '有一处还在做，做完告诉你',
        };
      }
      const what = r.summary ? `：${r.summary}` : '';
      return shown
        ? { where: r.where, text: `「${shown}」${what}` }
        : { where: r.where, text: `还有一处还没起名${what}` };
    });
    return { count: items.length, text: items.map((i) => `- ${i.text}`).join('\n'), items };
  }
}
