// **发布前的"真跑一次"（分级）**（`D4.24` · **A2** · 2026-10-03 主人定）。
//
// ── 口径（签字页 `docs/dev/161-OWNER-DECISIONS-11.md` A2 原文摘要）────────
//   "发布**必须真跑过**，但**分级**：只要求'**能跑起来的最小判据**'（**入口必崩 ⇒ 拒**），
//    **不做全量回归**。"
//
// ── 这一份问的是什么、不问什么（**分级**就写在这儿）──────────────────
//   问：**这一版起得来吗** —— 入口那一份的脚本**真在 JS 引擎里跑一遍**：
//     ① 入口文件在制品里（不在 ⇒ 拒）；
//     ② 每一段**本制品自己的**脚本**编译得过**（语法错 ⇒ 必崩 ⇒ 拒）；
//     ③ 它在**一个最小的浏览器壳**里**顶层的执行不抛**（抛 ⇒ 必崩 ⇒ 拒）；
//     ④ 它**不把发布这条路拖住**（每段脚本一个**硬时间预算**，超了当场判"起不来"）。
//   **不问**：画面对不对、点了有没有反应、数据存不存得进、全量回归 —— 那些**不是**最小判据。
//
// ── 三条纪律（照 `app-lint.js` 那一套，但这一份**会拦**）───────────────
//   ① 🔴 **不做全量回归、不碰盘、不联网、不起子进程**：跑的是一个 `node:vm` 上下文，
//      里面**没有** `require`／`process`／`fs`／`child_process`／网络；而且每段脚本
//      都带**硬超时**（`RUN_TIMEOUT_MS`）⇒ 结构上**跑不长**（判据 A2-③ 钉这一条）。
//   ② 🔴 **不过度拒**：壳子按"最小但够用"铺（DOM／`fetch`／`ask`／定时器都有桩），
//      只有**真会崩**的几类才拒：语法错 · 顶层抛 · 超时 · 入口／本地脚本缺失。
//      定时器／动画回调**不真跑**（那是"跑起来之后"的事，不属于最小判据）。
//   ③ **理由看得见**：拒的时候点名**哪个文件、哪一行、什么错**（N11：驳回要说清为什么）。
//
// ⚠️ **它替不了真浏览器**：这一份证的是"**能起来 / 入口必崩**"，
//    不是"在主人屏幕上是什么样"。真机那一侧归 `scripts/check-web-browser.mjs`（V13）。

import nodeVm from 'node:vm';

/** 每一段脚本的**硬时间预算**（超了 ⇒ 判"起不来"）。⚠️ 数值只住代码。 */
export const RUN_TIMEOUT_MS = 250;

/** 一次发布最多允许几段脚本（防呆，也给"跑不长"一个结构上限）。 */
export const RUN_MAX_SCRIPTS = 24;

/** 最小真跑拒了的那一类错误（`published.publish` 把它翻成看得见的拒绝码）。 */
export class EntryRunError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'EntryRunError';
    this.detail = detail;
  }
}

/** 拒的那几类（**只有这几类** —— 别的都不拦，见文件头纪律②）。 */
export const RUN_FAILURES = Object.freeze({
  ENTRY_MISSING: 'entry-missing',
  SYNTAX: 'syntax',
  THROW: 'throw',
  TIMEOUT: 'timeout',
  MISSING_SCRIPT: 'missing-script',
  TOO_MANY_SCRIPTS: 'too-many-scripts',
});

const SCRIPT_BLOCK_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const HAS_SRC_RE = /\bsrc\s*=/i;

/** 取一个属性的值（双引号／单引号／裸值三种写法）。 */
function attrOf(attrs, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(attrs);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? '';
}

/** 把制品里的字节变成正文（`files` 的值可能是 `Buffer`，也可能是串）。 */
function toText(v) {
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return '';
}

/** 归一化一个制品内的相对路径（`a//b`、`a/./b` 都收，`..` 越界 ⇒ `null`）。 */
export function normalizeRelPath(rel) {
  const s = String(rel ?? '').replace(/\\/g, '/');
  if (s.includes('\0')) return null;
  const parts = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.length === 0 ? null : parts.join('/');
}

/** 一个 `<script src=…>` 指的是制品里那一份，还是外面（外面的一律**不跑、也不拦**）。 */
function resolveSrc(entryRel, src) {
  const s = String(src ?? '').trim();
  if (s === '') return { kind: 'empty' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//')) return { kind: 'external' };
  const dir = entryRel.includes('/') ? entryRel.slice(0, entryRel.lastIndexOf('/')) : '';
  const joined = dir === '' ? s : `${dir}/${s}`;
  const norm = normalizeRelPath(joined);
  if (norm === null) return { kind: 'escape' };
  return { kind: 'local', path: norm };
}

/**
 * 从入口那一份里挑出**要跑的**脚本。
 *
 * 分类（照浏览器）：
 *   · `type` 空 / `text/javascript` / `application/javascript` ⇒ **经典脚本**（跑）
 *   · `type="module"` ⇒ **模块**（**不跑**，如实记 `module` —— 最小壳里没有模块加载器）
 *   · 别的 `type`（`application/json` 那种数据块）⇒ **数据**（不跑）
 */
export function extractScripts(html) {
  const out = [];
  let i = 0;
  SCRIPT_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = SCRIPT_BLOCK_RE.exec(String(html ?? ''))) !== null) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    const type = (attrOf(attrs, 'type') ?? '').trim().toLowerCase();
    const src = HAS_SRC_RE.test(attrs) ? (attrOf(attrs, 'src') ?? '') : null;
    let kind;
    if (type === '' || type === 'text/javascript' || type === 'application/javascript') kind = 'classic';
    else if (type === 'module') kind = 'module';
    else kind = 'data';
    out.push({ index: i++, kind, src, body });
  }
  return out;
}

// ── 最小浏览器壳（**只铺够用的**；定时器／动画回调不真跑）──────────────
const noop = () => {};

function storageThatThrows(what) {
  const boom = () => {
    const e = new Error(`${what} 在不透明源里用不了（SecurityError）`);
    e.name = 'SecurityError';
    throw e;
  };
  return { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0 };
}

/** 一个元素桩：未知成员一律给个空函数（页面里的 DOM 写法五花八门，不给它崩的理由）。 */
function makeElement(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    style: {},
    dataset: {},
    attributes: {},
    children: [],
    childNodes: [],
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
    appendChild: (c) => c,
    append: noop,
    prepend: noop,
    removeChild: noop,
    insertBefore: (c) => c,
    replaceChild: (c) => c,
    remove: noop,
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
    removeAttribute: noop,
    hasAttribute: () => false,
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    getElementsByClassName: () => [],
    closest: () => null,
    contains: () => false,
    focus: noop,
    blur: noop,
    click: noop,
    scrollIntoView: noop,
    animate: () => ({ finished: Promise.resolve() }),
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
    getContext: () => null,
    toDataURL: () => '',
    cloneNode: () => makeElement(tag),
    textContent: '',
    innerText: '',
    innerHTML: '',
    value: '',
    checked: false,
    disabled: false,
  };
  return el;
}

function makeDocument() {
  return {
    readyState: 'complete',
    title: '',
    cookie: '',
    documentElement: makeElement('html'),
    head: makeElement('head'),
    body: makeElement('body'),
    createElement: (t) => makeElement(t),
    createElementNS: (_ns, t) => makeElement(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    getElementById: () => makeElement(),
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    getElementsByClassName: () => [],
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
    write: noop,
    writeln: noop,
    open: noop,
    close: noop,
  };
}

/** 铺一个最小的壳。**没有** `require`／`process`／`fs`／网络真句柄。 */
function makeSandbox() {
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop, debug: noop, trace: noop },
    document: makeDocument(),
    location: {
      href: 'https://apps.stalkerai.cn/', search: '', hash: '', pathname: '/', origin: 'https://apps.stalkerai.cn',
    },
    navigator: { userAgent: 'hupo-min-run', language: 'zh-CN', onLine: true },
    history: { pushState: noop, replaceState: noop, back: noop, forward: noop, go: noop },
    screen: { width: 0, height: 0 },
    innerWidth: 0,
    innerHeight: 0,
    devicePixelRatio: 1,
    // ⚠️ 不透明源 ⇒ **碰了就抛**（这正是"入口必崩"的一类；`app-lint` 也在报它）
    localStorage: storageThatThrows('localStorage'),
    sessionStorage: storageThatThrows('sessionStorage'),
    indexedDB: { open: () => { const e = new Error('indexedDB 在不透明源里用不了（SecurityError）'); e.name = 'SecurityError'; throw e; } },
    // 平台那几条口：给桩，**不真发请求**（真跑一次只判"起得来"）
    fetch: () => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    }),
    XMLHttpRequest: class { open() {} send() {} setRequestHeader() {} addEventListener() {} abort() {} },
    WebSocket: class { constructor() { this.readyState = 0; } send() {} close() {} addEventListener() {} },
    ask: () => Promise.resolve(''),
    alert: noop,
    confirm: () => true,
    prompt: () => null,
    // 定时器／动画：**只登记、不真跑**（那是"起来之后"的事，不属于最小判据）
    setTimeout: () => 0,
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
    queueMicrotask: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop, removeEventListener: noop }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
    URLSearchParams,
    URL,
    TextEncoder,
    TextDecoder,
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

/** 从错误里挖出"哪一行"（`vm` 的 stack 里有 `<文件名>:<行>`）。 */
function lineOf(err, filename) {
  const stack = String(err?.stack ?? '');
  const re = new RegExp(`${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`);
  const m = re.exec(stack);
  return m ? Number.parseInt(m[1], 10) : null;
}

function classify(err) {
  if (err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return RUN_FAILURES.TIMEOUT;
  if (err instanceof SyntaxError) return RUN_FAILURES.SYNTAX;
  return RUN_FAILURES.THROW;
}

function makeFailure({ kind, entry, file = null, line = null, error = null, scripts = 0, executed = 0, skipped = [], ms = 0 }) {
  const where = file ? `${file}${line ? ` 第 ${line} 行` : ''}` : entry;
  return {
    ok: false,
    kind,
    entry,
    file,
    line,
    scripts,
    executed,
    skipped,
    ms,
    error: error ? String(error?.message ?? error) : null,
    message: error ? `${where}：${String(error?.message ?? error)}` : where,
  };
}

/**
 * **真跑一次（最小判据）**：入口那一份的脚本，在这个最小的壳里**真编译、真执行**。
 *
 * @param {object} o
 * @param {Record<string,string|Buffer>} o.files 这一版的**全部字节**（真正要出去的那些）
 * @param {string} o.entry 入口（制品内相对路径）
 * @returns {{ok:boolean, kind?:string, entry:string, file:string|null, line:number|null,
 *   error:string|null, message:string, scripts:number, executed:number,
 *   skipped:Array<{index:number,why:string}>, ms:number}}
 *   ⚠️ `ok:false` ⇒ 调用方**拒**（`kind` 说清是哪一类，`message` 点名哪个文件哪一行）。
 */
export function runEntryOnce({ files = {}, entry = 'index.html' } = {}) {
  const t0 = Date.now();
  const entryRel = normalizeRelPath(entry);
  if (entryRel === null) {
    return makeFailure({ kind: RUN_FAILURES.ENTRY_MISSING, entry: String(entry), ms: Date.now() - t0 });
  }
  const raw = Object.prototype.hasOwnProperty.call(files, entryRel) ? files[entryRel] : undefined;
  if (raw === undefined) {
    return makeFailure({ kind: RUN_FAILURES.ENTRY_MISSING, entry: entryRel, ms: Date.now() - t0 });
  }
  const scripts = extractScripts(toText(raw));
  if (scripts.length > RUN_MAX_SCRIPTS) {
    return makeFailure({
      kind: RUN_FAILURES.TOO_MANY_SCRIPTS, entry: entryRel, scripts: scripts.length, ms: Date.now() - t0,
    });
  }
  const ctx = nodeVm.createContext(makeSandbox());
  const skipped = [];
  let executed = 0;
  for (const s of scripts) {
    if (s.kind === 'module') { skipped.push({ index: s.index, why: 'module' }); continue; }
    if (s.kind === 'data') { skipped.push({ index: s.index, why: 'data' }); continue; }
    let code = s.body;
    let name = `${entryRel}#script-${s.index}`;
    if (s.src !== null) {
      const r = resolveSrc(entryRel, s.src);
      if (r.kind === 'external' || r.kind === 'empty') { skipped.push({ index: s.index, why: 'external' }); continue; }
      if (r.kind === 'escape') {
        return makeFailure({
          kind: RUN_FAILURES.MISSING_SCRIPT, entry: entryRel, file: s.src,
          error: new Error('这一份脚本指到制品外面去了'), scripts: scripts.length, executed, skipped, ms: Date.now() - t0,
        });
      }
      if (!Object.prototype.hasOwnProperty.call(files, r.path)) {
        return makeFailure({
          kind: RUN_FAILURES.MISSING_SCRIPT, entry: entryRel, file: r.path,
          error: new Error('制品里没有这一份脚本'), scripts: scripts.length, executed, skipped, ms: Date.now() - t0,
        });
      }
      code = toText(files[r.path]);
      name = r.path;
    }
    try {
      // 🔴 **真编译 ＋ 真执行**，而且带**硬时间预算**（结构上跑不长）
      new nodeVm.Script(code, { filename: name }).runInContext(ctx, { timeout: RUN_TIMEOUT_MS });
      executed += 1;
    } catch (err) {
      return makeFailure({
        kind: classify(err),
        entry: entryRel,
        file: name,
        line: lineOf(err, name),
        error: err,
        scripts: scripts.length,
        executed,
        skipped,
        ms: Date.now() - t0,
      });
    }
  }
  return {
    ok: true,
    kind: null,
    entry: entryRel,
    file: null,
    line: null,
    error: null,
    message: executed === 0 ? '入口没有要跑的脚本（起来了）' : `入口的 ${executed} 段脚本都跑过了`,
    scripts: scripts.length,
    executed,
    skipped,
    ms: Date.now() - t0,
  };
}

/** 一条**给模型看的人话**（`published.publish` 拒的时候用它，N11：要说清为什么）。 */
export function describeRunFailure(run) {
  const what = {
    [RUN_FAILURES.ENTRY_MISSING]: '入口那一份在制品里找不到',
    [RUN_FAILURES.SYNTAX]: '入口的脚本有语法错 ⇒ 打开就是白屏',
    [RUN_FAILURES.THROW]: '入口的脚本一加载就抛错 ⇒ 打开就是白屏',
    [RUN_FAILURES.TIMEOUT]: '入口的脚本一加载就卡住（跑不完）',
    [RUN_FAILURES.MISSING_SCRIPT]: '入口引的本地脚本在制品里没有',
    [RUN_FAILURES.TOO_MANY_SCRIPTS]: '入口的脚本太多了',
  }[run?.kind] ?? '入口起不来';
  const where = run?.file ? `（${run.file}${run.line ? ` 第 ${run.line} 行` : ''}）` : '';
  const detail = run?.error ? `：${run.error}` : '';
  return `这一版真跑了一次，起不来 —— ${what}${where}${detail}`;
}
