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
 * @returns {object}  永远是 `{ok:true,…}` 或 `{ok:false,error,…}`（**绝不抛**）
 */
export function handleLedgerOp(ledger, req) {
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
      case 'list':
        return {
          ok: true,
          items: ledger.list({ includeHidden: req.includeHidden === true }),
          totals: ledger.totals(),
        };
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
  #server = null;
  #ready = null;

  /**
   * @param {object} o
   * @param {import('./ledger.js').Ledger} o.ledger
   * @param {string} o.socketPath
   * @param {(m:string)=>void} [o.log]
   */
  constructor({ ledger, socketPath, log = () => {} }) {
    if (!ledger) throw new LedgerError('ledger 必填');
    if (!socketPath) throw new LedgerError('socketPath 必填');
    this.#ledger = ledger;
    this.#path = socketPath;
    this.#log = log;
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
        this.#reply(conn, handleLedgerOp(this.#ledger, req));
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
