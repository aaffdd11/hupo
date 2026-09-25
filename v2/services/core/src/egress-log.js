// **出网留痕**（P2-8 · 主人 2026-09-25 拍板「② 先只做出网留痕」）。
//
// ── 这一条要回答什么 ──────────────────────────────────────
// 盒里那个 agent **能往任意地址发请求**（93 §2.1 O3 · 账 #65；手册读起来像"出不去"）。
// 主人拍的是：**先不改网络**（它照旧能出网），只做**留痕** ——
// 记「**它往哪发**」（**域名 / 时间 / 量**）**可查**。
//
// 🔴 ── 四条不许破 ────────────────────────────────────────
//   ① **不改网络**：这个模块不认识 socket、不装代理、不改任何路由 ——
//      它只是把**已经发生的**那一次请求的目标域名记下来。
//   ② 🔴 **不记正文**：不落 URL 的路径与查询串、不落标题、不落摘要、
//      不落查询词、不落返回的字节内容 —— **只落域名与量**。
//      判据的反例就在 `test/egress-log.test.js`：把私密哨兵塞进 URL 的
//      path/query 与 `title`/`snippet` ⇒ 记录里**零命中**。
//   ③ **认不出来就不记**（不猜）：不是那两件工具、URL 是坏的、meta 是坏的 ⇒ 空数组。
//   ④ **写不进去不许挡住那一轮**（F10 同款）：`note()` 只记不抛，
//      失败留在 `errors` 里（"事实不能静默"）。
//
// ── 记哪些面 ──────────────────────────────────────────────
// 今天 agent 真正出网的工具就那两件（`tools.js:37-38` 的只读白名单）：
//   · `web_fetch`  ⇒ 记**请求的目标域名**（`role:'target'`）＋ HTTP 状态 ＋ 字节数（有就记）
//   · `web_search` ⇒ 记**查到的那几个站在哪个域名**（`role:'result'`）＋ 条数
// ⚠️ 这是**量**的账，不是访问日志：没有"谁在什么时候打开了哪一页"那种东西。
//
// ⚠️ **别把它和 93 §4.1 那条"用量记录不记 URL/域名"读成一条**：
//    93 §4.1 管的是**按 app 的用量记录**（那张表是给上架/结算看的）；
//    P2-8 是主人后来单独拍的**出网留痕**（2026-09-25），落点与用途都不同
//    （这条住 `<dir>/hupo/egress.jsonl`，是**平台自己的眼睛**）。
//    文档升版时要把这一句如实写进去（`docs/**` 这一批不动）。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

/** 文件叫什么（**只有这一处**写这个名字）。 */
export const EGRESS_FILE = 'egress.jsonl';
/** 放在世界根目录下的哪个相对路径（与制品库同级的 `hupo/` 那一格）。 */
export const EGRESS_REL = nodePath.join('hupo', EGRESS_FILE);

/** 哪些工具算"出网"（`tools.js` 那两件只读的白名单）。 */
export const EGRESS_TOOLS = Object.freeze(['web_search', 'web_fetch']);

/** 留痕文件放在哪。 */
export function egressPath(worldDir) {
  return nodePath.join(worldDir, EGRESS_REL);
}

/** 一条记录的**角色**：target = 请求发给谁；result = 查到的内容来自哪个域名。 */
export const EGRESS_ROLES = Object.freeze({ target: 'target', result: 'result' });

/**
 * **只取域名**（P2-8 的"域名"那一格）。
 * 🔴 路径、查询串、端口以外的东西**一律丢掉** —— 它们可能带正文。
 * 拿不到 ⇒ `null`（**不猜**）。
 */
export function hostOf(url) {
  try {
    const h = new URL(String(url)).hostname;
    return h ? h.toLowerCase() : null;
  } catch {
    return null;
  }
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function finiteOrNull(v) {
  return Number.isFinite(v) ? v : null;
}

/**
 * **从一条工具结果里取出网留痕**（纯函数）。
 *
 * @param {unknown} name 工具名（`tool/result` 上没有它，由 `tool/call` 配 —— 见 `session-translate.js`）
 * @param {unknown} meta `tool/result.meta`
 * @returns {Array<{tool:string, role:string, host:string, bytes:number|null, status:number|null, results:number|null}>}
 *   **可能为空**（不是那两件工具 / 坏载荷 / 域名认不出）
 */
export function egressFromToolResult(name, meta) {
  if (typeof name !== 'string' || !EGRESS_TOOLS.includes(name)) return [];
  if (!isPlainObject(meta)) return [];

  if (name === 'web_fetch') {
    const host = hostOf(meta.url);
    if (!host) return [];
    return [{
      tool: 'web_fetch',
      role: EGRESS_ROLES.target,
      host,
      bytes: finiteOrNull(meta.bytes),
      status: finiteOrNull(meta.statusCode),
      results: null,
    }];
  }

  // web_search：结果为**量**（条数），域名 = 内容来自哪几站
  const list = Array.isArray(meta.sources) ? meta.sources : [];
  const out = [];
  for (const s of list) {
    const host = hostOf(s?.url);
    if (!host) continue;
    if (out.some((x) => x.host === host)) continue; // 同一站查两次 ⇒ 只算一条
    out.push({
      tool: 'web_search',
      role: EGRESS_ROLES.result,
      host,
      bytes: null,
      status: null,
      results: list.length,
    });
  }
  return out;
}

/**
 * **出网留痕那本账**（只追加）。
 *
 * ⚠️ 一条记录只有：`at` / `sub` / `tool` / `role` / `host` / `bytes` / `status` / `results`。
 *    **没有正文、没有 URL 的路径与查询串**（见文件头 ②）。
 */
export class EgressLog {
  #file;
  #sub;
  #fs;
  #log;
  #now;
  #errors = [];

  /**
   * @param {object} o
   * @param {string} o.dir   这个人世界的根（`worlds.pathsFor(sub).dir`）
   * @param {string|null} [o.sub]
   * @param {object} [o.fs]
   * @param {(m:string)=>void} [o.log]
   * @param {()=>number} [o.now]
   */
  constructor({ dir, sub = null, fs = nodeFs, log = () => {}, now = Date.now }) {
    if (!dir) throw new Error('EgressLog 需要 dir');
    this.#file = egressPath(dir);
    this.#sub = sub;
    this.#fs = fs;
    this.#log = log;
    this.#now = now;
  }

  get path() {
    return this.#file;
  }

  /** 记账时撞上的错（给排障看；**不抛**）。 */
  get errors() {
    return [...this.#errors];
  }

  /**
   * 记**一条**。失败**只记不抛**（F10：写失败要留痕，但不许挡住那一轮）。
   * @param {object} entry `egressFromToolResult()` 的一条
   * @returns {boolean} 写进去了没有
   */
  note(entry) {
    if (!isPlainObject(entry) || typeof entry.host !== 'string' || entry.host === '') return false;
    const line = JSON.stringify({
      at: this.#now(),
      sub: this.#sub,
      tool: entry.tool ?? null,
      role: entry.role ?? null,
      host: entry.host,
      bytes: finiteOrNull(entry.bytes),
      status: finiteOrNull(entry.status),
      results: finiteOrNull(entry.results),
    });
    try {
      this.#fs.mkdirSync(nodePath.dirname(this.#file), { recursive: true, mode: 0o700 });
      this.#fs.appendFileSync(this.#file, `${line}\n`, { mode: 0o600 });
      return true;
    } catch (err) {
      this.#errors.push(err?.code ?? err?.message ?? String(err));
      this.#log(`  ⚠️ 出网留痕那一行没写进去（${this.#file}）：${err?.code ?? err?.message ?? err}`);
      return false;
    }
  }

  /** 记一批（`egressFromToolResult()` 的输出）。返回**真写进去**的条数。 */
  noteAll(entries) {
    if (!Array.isArray(entries)) return 0;
    let n = 0;
    for (const e of entries) if (this.note(e)) n += 1;
    return n;
  }

  /**
   * 读回来（"可查"那一条）。
   * ⚠️ 坏行**跳过**（只追加的文件里最后一行可能写一半 —— 那不该让整本账读不出来）。
   * @returns {Array<object>}
   */
  read() {
    let text;
    try {
      text = this.#fs.readFileSync(this.#file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 坏行跳过（见上） */
      }
    }
    return out;
  }
}
