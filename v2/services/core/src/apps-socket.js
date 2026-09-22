// 小程序那几条工具的**本地通道**（乙-2 · 契约 `docs/dev/59-USER-APPS.md` §二）。
//
// ── 它和账本那条是同一个形状（照抄它，别自创）────────────────
// 模型那一侧看到的是几条 MCP 工具，那些工具跑在**另一个进程**里（dsh 拉起的 stdio 服务器）。
// 那个进程**不许自己写盘** —— 校验、取版本号、落盘、审计全都要走**服务端这一个写入者**。
// ⇒ 两边之间要一条通道，就是这个。
//
// ── 为什么是 Unix domain socket ──────────────────────────
// MCP 那头唯一的传值口是配置里的 `env`，而 DSH 会把匹配 `/KEY|PASSWORD|SECRET|TOKEN/i`
// 的名字和所有 `DSH_*` **清洗掉** ⇒ 要传令牌就只能把令牌写进**仓库里那份配置**（破纪律）。
// 域套接字没有这个问题：**准入靠文件权限**（0600），没有秘密可以泄露。
//
// ⚠️ 它是**本机内部**的一条口（只在文件系统上、不听端口）。
// ⚠️ 协议是**一行一条 JSON**：`{op,…}` → `{ok,…}`；任何一条坏输入**只让那一条失败**。

import nodeFs from 'node:fs';
import nodeNet from 'node:net';
import nodePath from 'node:path';

import { AppsError } from './apps.js';

/** 小程序那条口放哪。**跟着那个人的目录走**（`<他那一格>/apps.sock`）。 */
export function appsSocketPath(dir) {
  return nodePath.join(dir, 'apps.sock');
}

/** 一行最长多少（防呆，不是容量规划）：正常请求几 KB。 */
const MAX_LINE_BYTES = 512 * 1024;

/**
 * 把一条请求变成一条回答。**纯同步**（制品那套操作全是同步的）。
 *
 * ⚠️ 这里**只做能做的事**：`create` / `list`（还有 `rollback`，给以后用）。
 *    `publish` / `install` / `grant` 那几件**还没实现** ⇒ 这里给一句**明确的"还没做"**，
 *    **绝不许**回一个"成了"（那就是这个项目最忌的假话：工具说做完了、其实没做）。
 *
 * @param {import('./apps.js').Apps} apps
 * @param {object} req
 * @returns {object} 永远 `{ok:true,…}` 或 `{ok:false,error,…}`（**绝不抛**）
 */
export function handleAppsOp(apps, req) {
  const op = req?.op;
  if (typeof op !== 'string') return { ok: false, error: '没说要做什么' };
  try {
    switch (op) {
      case 'create': {
        const a = req.app ?? {};
        const m = apps.create({
          id: a.id,
          title: a.title,
          icon: a.icon,
          entry: a.entry,
          files: a.files,
          permissions: a.permissions ?? [],
          createdBy: 'agent',
          createdTurn: Number.isInteger(req.turn) ? req.turn : null,
        });
        return { ok: true, id: m.id, version: m.version, title: m.title, rootHash: m.rootHash };
      }
      case 'list':
        return { ok: true, apps: apps.list() };
      case 'rollback':
        return { ok: true, version: apps.rollback(req.id, req.version) };
      case 'publish':
      case 'unpublish':
      case 'install':
      case 'uninstall':
      case 'grant':
      case 'revoke':
        return { ok: false, error: `这件事还没做：${op}（它要等"发现/权限"那两批）` };
      default:
        return { ok: false, error: `认不出这条请求：${op}` };
    }
  } catch (err) {
    if (err instanceof AppsError) return { ok: false, error: err.message };
    return { ok: false, error: `没做成：${err?.message ?? err}` };
  }
}

/** 那条口（听一个域套接字）。 */
export class AppsSocket {
  #apps;
  #path;
  #log;
  #server = null;
  #ready = null;

  /**
   * @param {object} o
   * @param {import('./apps.js').Apps} o.apps
   * @param {string} o.socketPath
   * @param {(m:string)=>void} [o.log]
   */
  constructor({ apps, socketPath, log = () => {} }) {
    if (!apps) throw new AppsError('apps 必填');
    if (!socketPath) throw new AppsError('socketPath 必填');
    this.#apps = apps;
    this.#path = socketPath;
    this.#log = log;
  }

  get path() {
    return this.#path;
  }

  /**
   * 开始听。
   * ⚠️ **先删旧的套接字文件**（上次没善终会留下它，而 `listen()` 撞上报的是 `EADDRINUSE`
   *    ——那句话看起来像"端口被占"）。
   * ⚠️ 权限 **0600**：准入就是它。
   */
  listen() {
    if (this.#server) return this;
    nodeFs.mkdirSync(nodePath.dirname(this.#path), { recursive: true, mode: 0o700 });
    try {
      nodeFs.unlinkSync(this.#path);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    const server = nodeNet.createServer((conn) => this.#onConnection(conn));
    server.on('error', (err) => {
      this.#log(`[apps] 本地通道出错：${err?.message ?? err}`);
    });
    // ⚠️ 文件一出生就得是 0600（不能"先按 umask 建、回头再 chmod"：那个窗口里谁都能连）
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
          this.#log(`[apps] 本地通道权限没设上：${err?.message ?? err}`);
        }
        resolve();
      });
    });
    this.#server = server;
    return this;
  }

  /** 通道真的开始听了（测试与启动用它**避免猜时机**）。 */
  ready() {
    return this.#ready ?? Promise.resolve();
  }

  close() {
    const s = this.#server;
    this.#server = null;
    return new Promise((resolve) => {
      if (!s) {
        resolve();
        return;
      }
      s.close(() => resolve());
    });
  }

  #onConnection(conn) {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > MAX_LINE_BYTES) {
        // 一行太长：**回一句再断开**（不许把内存吃光）
        conn.end(`${JSON.stringify({ ok: false, error: '这一行太长了' })}\n`);
        buf = '';
        return;
      }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let req = null;
        try {
          req = JSON.parse(line);
        } catch {
          conn.write(`${JSON.stringify({ ok: false, error: '这一行不是 JSON' })}\n`);
          continue;
        }
        // ⚠️ **一条坏输入只让那一条失败**（`handleAppsOp` 自己保证不抛）
        conn.write(`${JSON.stringify(handleAppsOp(this.#apps, req))}\n`);
      }
    });
    conn.on('error', (err) => this.#log(`[apps] 连接出错：${err?.message ?? err}`));
  }
}
