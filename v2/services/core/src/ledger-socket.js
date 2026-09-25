// 账本那条**本地通道**（批 4 · 契约 `docs/dev/31-LEDGER.md` v2 §7.2）。
//
// ── 它是干什么的 ──────────────────────────────────────────
// 模型那一侧拿到的是几条 MCP 工具；那些工具跑在**另一个进程**里（dsh 拉起的
// MCP stdio 服务器）。那个进程**不许自己写盘** —— 写盘、取号、校验、审计
// 全都要走**服务端这一个写入者**。所以两边之间要有一条通道，就是这个。
//
// ── 为什么是 Unix domain socket，而不是"HTTP + 令牌" ──────
// MCP 那头唯一的传值口是配置文件里的 `env`，而 DSH 会把父环境里
// 匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的名字**和所有 `DSH_*`** 清洗掉
// ⇒ 要传令牌就只能**把令牌写进那份配置**，而那份配置**在仓库里** ⇒ 破纪律。
// 域套接字没有这个问题：**准入靠文件权限**（0600），没有秘密可以泄露。
//
// ⚠️ **它是本机内部的一条口**：只在本地文件系统上，不听任何端口。
// ⚠️ 协议是**一行一条 JSON**：`{op,…}` → `{ok,…}`。任何一条坏输入
//    **只让那一条失败**，不许把服务带下去。

import nodeFs from 'node:fs';
import nodeNet from 'node:net';
import nodePath from 'node:path';

import { LedgerError } from './ledger.js';
import { renderLedger } from './ledger-text.js';
import { handSocketToAgent } from './socket-owner.mjs';

/** 账本套接字放哪。**跟着 dataDir 走**（它和账本日志是一对）。 */
export function ledgerSocketPath(dataDir) {
  return nodePath.join(dataDir, 'ledger.sock');
}

/** 一行最长多少。它是**防呆**（不是容量规划）：正常的请求几百字节。 */
const MAX_LINE_BYTES = 64 * 1024;

/**
 * 把一条请求变成一条回答。**纯同步**（账本那套操作全是同步的）——
 * 这一点很重要：它让"取号 + 落盘"之间**不可能**插进另一条写。
 *
 * @param {import('./ledger.js').Ledger} ledger
 * @param {object} req
 * @param {{dispatcher?: () => object|null}} [ctx]
 *        ★ **P1 §三④ 那条出口**（`docs/dev/88-P1-TIME-WAIT.md`）：这个人的**活账**
 *        挂在**调度器**上（`WorkLog.live()` / `Dispatcher.workReport()`），而调度器
 *        是 `worlds.js` 后建的 ⇒ 这里收一个**惰性取**的函数（`() => dispatcher`），
 *        造这条通道的时候还拿不到它。
 *        ⚠️ **没给 / 取不到 ⇒ 如实说"没接上"**（`{ok:false}`），**不许**编一句空答案。
 * @returns {object}  永远是 `{ok:true,…}` 或 `{ok:false,error,…}`（**绝不抛**）
 */
export function handleLedgerOp(ledger, req, ctx = null) {
  const op = req?.op;
  if (typeof op !== 'string') return { ok: false, error: '没说要做什么' };
  try {
    switch (op) {
      case 'propose':
        return { ok: true, ...ledger.propose(req.fields, { said: req.said }) };
      case 'write': {
        const rec = ledger.write(req.fields, { said: req.said });
        return { ok: true, entry: rec, echo: null };
      }
      // ── ★ **"那件怎么样了"**（P1 §三④）────────────────────────────
      //
      // 为什么这条口在**账本**这一支：契约 §二.1 那句 —— **票＝欠条**。
      // "哪几件还挂着"本来就是这本账的事，另开一条 MCP 反而要动**能力层**
      // （那是 `strict`，动一次要主人补一条重建清单）。
      //
      // ⚠️ 人话**在服务端拼**（`Dispatcher.workReport()` → `workAnswerLine` ＋
      //    `workWhereWords`）：这样"在哪一间"那半句用的是**那一间的名字**，
      //    而模型手上拿到的是**人话**——它没有理由（也没有机会）把内部 id 抄给用户。
      case 'work': {
        const d = (() => {
          try {
            return ctx?.dispatcher?.() ?? null;
          } catch {
            return null;
          }
        })();
        if (!d || typeof d.workReport !== 'function') {
          return { ok: false, error: '这一台还没接上"活账"，问不出那几件' };
        }
        const ref = typeof req.ref === 'string' && req.ref !== '' ? req.ref : null;
        const scope = typeof req.scope === 'string' && req.scope !== '' ? req.scope : null;
        if (ref) {
          const text = d.workReport({ scope, ref });
          if (text === null || text === undefined) return { ok: false, error: '这本账里没有这一件' };
          return { ok: true, count: 1, items: [{ scopeId: scope, ref, text }], text };
        }
        // ⚠️ **把"问话那一间"带进去**：那一间的**正在跑的那一轮**要被排掉
        //    （它就是这句提问自己），见 `Dispatcher.workList` 的说明。
        const items = typeof d.workList === 'function' ? d.workList({ excludeScope: scope }) : [];
        if (items.length === 0) return { ok: true, count: 0, items: [], text: '现在没有挂着的活。' };
        return { ok: true, count: items.length, items, text: items.map((it) => it.text).join('\n') };
      }
      // ── ★ **转交**（D 期 · 契约 `docs/dev/100-DISPATCHER-D.md` §6.1 · 判据 D-1）──
      //
      // 🔴 **这就是"只有工具调用能发起转交"那条判据的结构性落点**（D-1）：
      //    转交的**入口只有这一条**（模型那条 MCP 工具 `handoff_to` 递进来），
      //    正文那条路（`session-translate`）里根本没有这个函数的出口
      //    ⇒ "正文里说一句我转给某一间"**结构上不可能**变成转交。
      //    ⚠️ 所以这里**绝不**读 `said` / `text` 去猜关键词（那正是"自然语言当控制面"）。
      //
      // ⚠️ 裁决（目标存在 / 一轮一次 / 禁回环）**全在调度器那边**
      //    （`Dispatcher.handoffTo` → `handoff.js` 的纯函数）：这里只转发。
      //    这个文件**不碰盘**那条规矩照旧（`HandoffBook` 由 `worlds.js` 建）。
      case 'handoff': {
        const d = (() => {
          try {
            return ctx?.dispatcher?.() ?? null;
          } catch {
            return null;
          }
        })();
        if (!d || typeof d.handoffTo !== 'function') {
          return { ok: false, error: '这一台还没接上转交那本账，转不了' };
        }
        const target = typeof req.target === 'string' ? req.target.trim() : '';
        if (target === '') return { ok: false, error: '没说要转给哪一间' };
        // ★ **发起那一间**以调度器给的那份为准（`HUPO_SCOPE` 只是"这一轮在哪间"）；
        //   模型那一侧**不许**自己声称"我是哪一间"（那会变成自选身份）。
        const by = typeof req.scope === 'string' && req.scope !== '' ? req.scope : null;
        // ⚠️ `messageId`：这条工具口**不用**从模型那边要（它不该知道我们的气泡 id）——
        //    调度器取"这一间现在那条开口的"（N22 保证最多一条）。
        const r = d.handoffTo({
          by,
          target,
          messageId: null,
          reason: typeof req.reason === 'string' && req.reason.trim() !== '' ? req.reason.trim() : null,
        });
        if (r?.ok) {
          return {
            ok: true,
            target,
            id: r.id ?? null,
            duplicate: r.duplicate === true,
            // ⚠️ 给模型的人话：**不许**出现内部 id / 机制名（`06` 禁用词那一条）。
            text: r.duplicate === true ? '这件事已经转过去了，我接着说。' : '好的，我把它转过去。',
          };
        }
        // ⚠️ 拒了**也是一条正常回答**（模型要能照着它回一句人话）——
        //    判据要的正是"拒"，所以这里把**档**（`reason`）也如实带回去。
        return { ok: false, error: String(r?.error ?? '转不了'), reason: r?.error, text: r?.text };
      }
      case 'list': {
        // ⚠️ **文字在服务端渲染**（契约 §八 第 3 件）：口径只有一处
        //    （`foldTotals`）⇒ MCP 那一侧**只转述、不重算**。
        //    在那边再算一遍的话，"含税说不清算不算"就会有两个答案。
        const items = ledger.list();
        return {
          ok: true,
          items,
          totals: ledger.totals(),
          text: renderLedger(items, { month: req.month ?? null }),
        };
      }
      case 'bin':
        return { ok: true, items: ledger.listBin(), ttlDays: ledger.ttlDays };
      case 'delete': {
        // ⚠️ 两条路：内部那边可以直接给身份（`entryIds`）；**模型那一侧只给"人话"**
        //    （`match`），由这里解析成身份。见 `Ledger.find()` 的说明。
        if (Array.isArray(req.entryIds) && req.entryIds.length > 0) {
          return { ok: true, bin: ledger.remove(req.entryIds) };
        }
        const hits = ledger.find(req.match ?? {});
        if (hits.length === 0) return { ok: false, error: '账上没找到这一笔' };
        if (hits.length > 1) {
          return {
            ok: false,
            error: `有 ${hits.length} 笔都对得上，得先说清是哪一笔`,
            candidates: hits.map((r) => ({ date: r.date, kind: r.kind, qty: r.qty, unit: r.unit })),
          };
        }
        return { ok: true, bin: ledger.remove([hits[0].entryId]) };
      }
      case 'find':
        return { ok: true, items: ledger.find(req.match ?? {}) };
      case 'restore':
        return { ok: true, restored: ledger.restore(req.entryIds) };
      case 'purge':
        return { ok: true, ...ledger.purge(req.entryIds) };
      default:
        return { ok: false, error: `认不出这条请求：${op}` };
    }
  } catch (err) {
    // ⚠️ **校验不过是一条正常回答，不是崩溃**：把"哪一项没听准"原样带回去
    //    （D6.5）。别的异常也**只让这一条失败**。
    if (err instanceof LedgerError) {
      return { ok: false, error: err.message, problems: err.problems ?? [] };
    }
    return { ok: false, error: String(err?.message ?? err) };
  }
}

export class LedgerSocket {
  #ledger;
  #path;
  #log;
  #ctx;
  #server = null;
  #ready = null;

  /**
   * @param {object} o
   * @param {import('./ledger.js').Ledger} o.ledger
   * @param {string} o.socketPath
   * @param {(m:string)=>void} [o.log]
   * @param {{dispatcher?: () => object|null}} [o.ctx]
   *        ★ P1 §三④ 那条出口要的东西（见 `handleLedgerOp` 的 `ctx` 说明）。
   *        ⚠️ 缺省 `null` ⇒ `work` 那条如实回"没接上"（**fail-closed**，
   *        不许因为"忘了接"就变成一句空答案）。
   */
  constructor({ ledger, socketPath, log = () => {}, ctx = null }) {
    if (!ledger) throw new LedgerError('ledger 必填');
    if (!socketPath) throw new LedgerError('socketPath 必填');
    this.#ledger = ledger;
    this.#path = socketPath;
    this.#log = log;
    this.#ctx = ctx;
  }

  get path() {
    return this.#path;
  }

  /**
   * 开始听。
   *
   * ⚠️ **先把旧的套接字文件删掉**：上一次没善终时它会留在盘上，
   *    而 `listen()` 撞上它报的是 `EADDRINUSE` —— 那句话看起来像"端口被占"，
   *    实际是"上次的自己没清干净"。
   * ⚠️ 权限 **0600**：这条口只有本用户能连（准入就是它）。
   */
  listen() {
    if (this.#server) return this;
    nodeFs.mkdirSync(nodePath.dirname(this.#path), { recursive: true });
    try {
      nodeFs.unlinkSync(this.#path);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    const server = nodeNet.createServer((conn) => this.#onConnection(conn));
    server.on('error', (err) => {
      // 听着的时候出错（例如文件被人删了）：**说出来**，但不许把服务带走。
      this.#log(`[ledger] 本地通道出错：${err?.message ?? err}`);
    });
    // ⚠️ **文件一出生就得是 0600**，不能"先按 umask 建出来、回头再 chmod"：
    //    那个窗口里它是 775，而同机任何用户都能连上来问一句。
    //    ⇒ 建的时候把 umask 收紧（`listen()` 绑定是同步发生的），
    //      并在 'listening' 之后再 chmod 一道（兜底：umask 那一下要是没赶上）。
    const prev = process.umask(0o177);
    try {
      server.listen(this.#path);
    } finally {
      process.umask(prev);
    }
    this.#ready = new Promise((resolve) => {
      server.once('listening', () => {
        try {
          nodeFs.chmodSync(this.#path, 0o600);
        } catch (err) {
          this.#log(`[ledger] 本地通道权限没设上：${err?.message ?? err}`);
        }
        // 🔴 **盒子里还得把它交给 agent**（同 `apps.sock` 那条）：服务是 root 起的、
        //    agent 是 uid 1000 ⇒ 0600 属主 root 会让它连不上（真机 EACCES）。
        //    规则只住在 `socket-owner.mjs`；宿主上这条是空操作。
        handSocketToAgent(this.#path, { log: (m) => this.#log(`[ledger] ${m}`) });
        resolve();
      });
    });
    this.#server = server;
    return this;
  }

  /** 通道真的开始听了（测试与启动横幅用它**避免猜时机**）。 */
  ready() {
    return this.#ready ?? Promise.resolve();
  }

  close() {
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    try {
      server.close();
    } catch { /* 尽力 */ }
    try {
      nodeFs.unlinkSync(this.#path);
    } catch { /* 已经不在就算了 */ }
  }

  #onConnection(conn) {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > MAX_LINE_BYTES) {
        // 认不出来的东西堆太长了：回一句、断开。**不许把内存吃光。**
        this.#reply(conn, { ok: false, error: '这条请求太长了' });
        conn.destroy();
        return;
      }
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() === '') continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          this.#reply(conn, { ok: false, error: '这条请求读不懂' });
          continue;
        }
        this.#reply(conn, handleLedgerOp(this.#ledger, req, this.#ctx));
      }
    });
    // ⚠️ 连上来又断掉是正常的（那边每次只问一句就挂断）——不报错。
    conn.on('error', () => {});
  }

  #reply(conn, obj) {
    try {
      conn.write(`${JSON.stringify(obj)}\n`);
    } catch { /* 对面挂了就算了 */ }
  }
}
