// **宿主 ↔ 容器那条通道**（多租户 ②-4）：把"这个人的 key"送进他的容器。
//
// ── 它解决什么 ────────────────────────────────────────────
// key 必须住在容器里的 **tmpfs**（`/run/hupo/creds.yaml`，root 0600），
// 而**宿主写不进容器的 tmpfs**（`37-MULTITENANT.md` §12.1 那五步里的第 ③ 步）。
// ⇒ 反过来：**容器开机时连出来**，从宿主这里领走它那一份配置。
// 这同时就是主人要的那个形状：**容器起来是个空壳 → 等着 → 配置到了才启动真正的服务**。
//
// ── 🔴 身份靠什么（这一条是实测之后改的，很重要）──────────────
// 原计划是"反向 UDS + `SO_PEERCRED`，交给内核"。**实测：纯 Node 拿不到它** ——
// `net.Socket` 上没有 `getPeerCredentials`，`process.binding('pipe_wrap').Pipe.prototype`
// 上也只有一个 `fchmod`（2026-09-21 在 Node v24.15.0 上量的）。
// ⇒ 那条路要么写原生插件，要么退回"谁连上就算谁"（**那是不可接受的**）。
//
// ✅ **改成用"挂载表"当边界**（权限席的原话："**挂载表就是边界**"）：
//    宿主**每个租户各听一个套接字**（`<dir>/<userId>.sock`），而**每个租户的容器
//    只挂它自己那一个**。⇒ 乙的容器**在文件系统里根本看不见**甲的套接字
//    （两个 mount namespace）⇒ 身份 = "**你连的是哪个套接字**"，
//    而这由**内核的挂载命名空间**保证，不需要 `SO_PEERCRED`、也不需要令牌。
//
// ⚠️ **代价要说清**：这样一来，**挂载表写错 = 边界没了**（乙挂到了甲的套接字）。
//    ⇒ 这与 `39-PERMISSIONS.md` §5.7 那条"mount 表必须 `strict`"是**同一件事**，
//      不是新引入的风险。判据里有一条专门验"看不见别人的"。

import nodeFs from 'node:fs';
import nodeNet from 'node:net';
import nodePath from 'node:path';
import { Duplex } from 'node:stream';

/** 协议版本。**一旦上线就冻结**（手册 §2.1 纪律 2）。 */
export const CHANNEL_VERSION = 1;

/**
 * 一个租户一个套接字。
 *
 * @param {string} dir
 * @param {string} userId
 */
export function channelPathFor(dir, userId) {
  // ⚠️ userId 进路径前必须校验（和 `tenants.safeUserId` 同一套理由：防穿越）
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(userId ?? ''))) {
    throw new Error(`userId 不能当文件名：${JSON.stringify(userId)}`);
  }
  // 🔴 **一个租户一个目录，套接字放在目录里面**（2026-09-21 改的，实测逼出来的）：
  //    套接字每次重启都要**先删再建**（新 inode），而容器挂的是**那一个文件**
  //    ⇒ 宿主一重启，挂载点就指着**已经被删掉的旧 inode** ⇒ 容器**永远重连不上**。
  //    改成挂**目录**之后，目录的 inode 是稳的，里面的套接字换了也不影响。
  // ⚠️ 边界没变：**每个租户只挂自己那一个目录**（里面只有他自己的套接字）。
  return nodePath.join(dir, userId, 'channel.sock');
}

/**
 * 宿主这一侧的通道：**每个租户一个套接字，谁连上就按"连的是哪一个"认人**。
 *
 * ⚠️ 它**只发配置、不收别的**；收到的每一行都只用于判断"容器现在到哪一步了"。
 * ⚠️ **key 绝不进日志**（`log()` 只拿得到 userId 与状态）。
 */
export class TenantChannel {
  #dir;
  #keyFor;
  #log;
  #servers = new Map(); // userId → net.Server
  /** userId → 已经连着的那些连接（"key 晚到"时要主动推给它们） */
  #conns = new Map();
  #seen = []; // 最近几条状态（给横幅/排障用，**不含 key**）
  /** userId(=租户名) → 声明过"我能跑隧道"的那些连接 */
  #tunnelConns = new Map();
  /** 隧道 id → 那一头的 Duplex */
  #tunnels = new Map();
  #nextTunnelId = 1;
  /**
   * **哪几台容器自己说"我这儿有钥匙"**（2026-09-21 加）。
   *
   * ⚠️ 为什么要它：宿主只在**内存**里记"送过没有"，一重启就忘 ——
   *    而钥匙**真的在容器里**（tmpfs）。⇒ 容器连上来时报一句，宿主就**不该再问用户要**。
   *    （主人报的"刷新后又要我输入 apikey"就是这么来的。）
   */
  #keyKnown = new Set();

  /**
   * @param {object} o
   * @param {string} o.dir                    套接字放哪个目录
   * @param {(userId:string)=>(string|null)} o.keyFor  **这个人的 key**；`null` = 还没有
   * @param {(m:string)=>void} [o.log]
   */
  constructor({ dir, keyFor, log = () => {} }) {
    if (!dir) throw new Error('TenantChannel 需要 dir');
    if (typeof keyFor !== 'function') throw new Error('TenantChannel 需要 keyFor(userId)');
    this.#dir = dir;
    this.#keyFor = keyFor;
    this.#log = log;
  }

  get dir() {
    return this.#dir;
  }

  /** 最近的状态（**不含 key**）。 */
  get recent() {
    return [...this.#seen];
  }

  /**
   * 给**一个**租户开一条通道。可以重复调（已经开过就返回同一个）。
   *
   * ⚠️ 之所以要**显式按租户开**、而不是"一个大套接字认人"：
   *    只有"一个租户一个套接字"，才能让**挂载表**成为边界（见文件头那段）。
   */
  listenFor(userId) {
    const had = this.#servers.get(userId);
    if (had) return had;

    nodeFs.mkdirSync(this.#dir, { recursive: true, mode: 0o755 });
    // ⚠️ 每个租户自己那一个目录（**容器挂的就是它**）
    nodeFs.mkdirSync(nodePath.dirname(channelPathFor(this.#dir, userId)), {
      recursive: true,
      mode: 0o755,
    });
    const sock = channelPathFor(this.#dir, userId);
    try {
      nodeFs.unlinkSync(sock); // 上次没收干净（重启之后 listen 会 EADDRINUSE）
    } catch {
      /* 不存在是正常的 */
    }

    const server = nodeNet.createServer((conn) => this.#onConn(userId, conn));
    server.listen(sock, () => {
      // ⚠️ 0666：容器里那个"壳"以**租户的身份**连进来，跟宿主不是一个 uid。
      //    这样放开**是安全的**，因为**只有那一个容器挂得到这个路径**
      //    （别的容器看不见它）—— 安全性来自挂载表，不来自这个权限位。
      //    ⚠️ 反过来说：**挂载表写错了，这一位就兜不住**（见文件头那条代价）。
      try {
        nodeFs.chmodSync(sock, 0o666);
      } catch (err) {
        this.#log(`  ⚠️ 通道 ${userId} 的权限没设成：${err?.message ?? err}`);
      }
      this.#log(`  通道 ${userId} 在听：${sock}`);
    });
    server.on('error', (err) => this.#log(`  ⚠️ 通道 ${userId} 出错：${err?.message ?? err}`));
    this.#servers.set(userId, server);
    return server;
  }

  #record(userId, state, extra = {}) {
    this.#seen.push({ userId, state, at: Date.now(), ...extra });
    if (this.#seen.length > 50) this.#seen.shift();
  }

  #onConn(userId, conn) {
    /**
     * ⚠️ 这一行**只说"谁连上了、当时有没有 key"**，**不说 key 是什么**：
     *    日志是这个项目里最容易漏的地方（`AGENTS.md` §六.1）。
     */
    const key = this.#keyFor(userId);
    const hasKey = typeof key === 'string' && key.length > 0;
    this.#record(userId, hasKey ? 'ready' : 'waiting');
    // ⚠️ **这一行不许说"容器有没有 key"**（2026-09-21 修）：`#keyFor` 是**宿主自己的记忆**，
    //    而宿主刚重启时它是**空的** —— 容器却可能还揣着钥匙（key 在容器的 tmpfs 里）。
    //    原来这里写"⇒ 还没有 key（让它等）"，于是**日志在说假话**：
    //    横幅说没有，一秒后 `tunnel-ready` 报了 `hasKey:true`。
    //    key 到底有没有，**只有容器知道** ⇒ 这里只报"连上了"，真相等它自报（见 `tunnel-ready`）。
    this.#log(`  通道 ${userId}：容器连进来了（有没有钥匙，等它自报）`);

    // ⚠️ **登记这条连接**：key 常常是**晚到**的（用户过一会儿才在网页上填），
    //    那时容器还连着在等 ⇒ `pushKey()` 要能直接推给它，不用等它重连。
    const set = this.#conns.get(userId) ?? new Set();
    set.add(conn);
    this.#conns.set(userId, set);
    conn.on('close', () => {
      set.delete(conn);
      if (set.size === 0) this.#conns.delete(userId);
    });

    conn.setEncoding('utf8');
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        this.#onLine(userId, conn, line);
      }
    });
    conn.on('error', () => {
      /* 容器没了就是没了，不该把宿主带走 */
    });

    // ★ 容器一连上就先把它要的东西给它：**不等它问**
    //   （少一次往返，也少一个"该谁先说话"的歧义）
    this.#send(conn, hasKey ? { state: 'ready', key } : { state: 'waiting' });
  }

  #onLine(userId, conn, line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.#send(conn, { state: 'error', why: 'bad-json' });
      return;
    }
    if (msg?.v !== CHANNEL_VERSION) {
      // ⚠️ 版本不对**要说清**，别让它自己猜（协议字段一旦上线就冻结）
      this.#send(conn, { state: 'error', why: 'bad-version' });
      return;
    }
    switch (msg?.type) {
      case 'hello':
        // 已经在上面的 `#onConn` 里答过了；这里只记一笔它自报的版本
        this.#record(userId, 'hello', { role: msg?.role ?? null });
        return;
      case 'need-key': {
        // 容器说"我还没拿到 key，再给我一次"（它自己会退避重试）
        const key = this.#keyFor(userId);
        if (typeof key === 'string' && key.length > 0) {
          this.#send(conn, { state: 'ready', key });
        } else {
          this.#send(conn, { state: 'waiting' });
        }
        return;
      }
      case 'ready':
        this.#record(userId, 'up');
        this.#log(`  ✓ ${userId} 的容器起来了`);
        return;
      case 'tunnel-ready': {
        // ★ 容器自报"我这儿有没有钥匙" ⇒ 记下来（**它是这个事实的来源**）
        if (msg?.hasKey === true) this.#keyKnown.add(userId);
        else this.#keyKnown.delete(userId);
        // 容器说"我这条连接能跑隧道" ⇒ 数据面就从这儿走
        const set = this.#tunnelConns.get(userId) ?? new Set();
        set.add(conn);
        this.#tunnelConns.set(userId, set);
        conn.on('close', () => {
          set.delete(conn);
          if (set.size === 0) this.#tunnelConns.delete(userId);
        });
        this.#record(userId, 'tunnel');
        // ★ 这一行才是**真话**：钥匙到底有没有，由容器自报的那条消息决定（`hasKey`）。
        this.#log(`  ✓ ${userId} 的隧道通了（数据面走这条）· 钥匙：${msg?.hasKey === true ? '有' : '还没有'}`);
        return;
      }
      case 'data': {
        const tun = this.#tunnels.get(msg?.id);
        if (tun && typeof msg.b64 === 'string') tun.push(Buffer.from(msg.b64, 'base64'));
        return;
      }
      case 'close': {
        const tun = this.#tunnels.get(msg?.id);
        if (tun) {
          this.#tunnels.delete(msg.id);
          tun.push(null); // 对面关了 ⇒ 让读的一头知道
        }
        return;
      }
      case 'error':
        // ⚠️ **照实记，但不含 key**：`msg.why` 是容器自己写的一句话
        this.#record(userId, 'error', { why: String(msg?.why ?? '').slice(0, 200) });
        this.#log(`  ⚠️ ${userId} 的容器报错：${String(msg?.why ?? '').slice(0, 200)}`);
        return;
      default:
        this.#send(conn, { state: 'error', why: 'unknown-type' });
    }
  }

  /**
   * **开一条到那个租户的"虚拟 socket"**（数据面 · ②-4b 后半）。
   *
   * 返回一个 `Duplex`：写进去的字节会经通道送到容器，容器接上它**本机那个服务**；
   * 对面回的字节从这头读出来。
   * ⇒ `http.request({ createConnection: () => sock })` 和 `ws` 的 `createConnection`
   *   **都能直接用它**，于是 HTTP 与 WebSocket **走同一套**，不用写两份。
   *
   * ⚠️ 没有隧道就返回 `null` —— **调用方必须如实回 503**，不许假装通了。
   */
  openSocket(userId) {
    const set = this.#tunnelConns.get(userId);
    const conn = set ? [...set].at(-1) : null;
    if (!conn) return null;
    const id = this.#nextTunnelId++;

    const self = this;
    const sock = new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        for (let i = 0; i < b.length; i += 32 * 1024) {
          self.#send(conn, {
            v: CHANNEL_VERSION,
            type: 'data',
            id,
            b64: b.subarray(i, i + 32 * 1024).toString('base64'),
          });
        }
        cb();
      },
      final(cb) {
        self.#send(conn, { v: CHANNEL_VERSION, type: 'close', id });
        cb();
      },
      destroy(err, cb) {
        self.#tunnels.delete(id);
        self.#send(conn, { v: CHANNEL_VERSION, type: 'close', id });
        cb(err);
      },
    });
    this.#tunnels.set(id, sock);
    this.#send(conn, { v: CHANNEL_VERSION, type: 'open', id });
    return sock;
  }

  /**
   * **那个租户的隧道通着吗**（只查，**不分配**隧道 id）。
   * ⚠️ 别拿 `openSocket()` 去当探测：它**有副作用**（分配 id、发一帧 `open`）。
   */
  hasTunnel(userId) {
    const set = this.#tunnelConns.get(userId);
    return Boolean(set && set.size > 0);
  }

  /**
   * **那一台容器自己说它有没有钥匙**（不是宿主记的"送过没有"）。
   * ⚠️ 宿主重启之后，这张表靠容器连上来时**重新报一遍** ⇒ 用户不会被重复问。
   */
  hasKeyFor(userId) {
    return this.#keyKnown.has(userId);
  }

  /** 有几个租户的隧道通着（给横幅/排障用）。 */
  get tunnelCount() {
    return this.#tunnelConns.size;
  }

  #send(conn, obj) {
    try {
      conn.write(`${JSON.stringify({ v: CHANNEL_VERSION, ...obj })}\n`);
    } catch {
      /* 对面没了就算了 */
    }
  }

  /** 这个人的 key **刚刚**才有的 ⇒ 主动推给已经连着的容器（不用等它重连）。 */
  pushKey(userId, key) {
    for (const conn of this.#conns.get(userId) ?? []) {
      this.#send(conn, { state: 'ready', key });
    }
  }

  close() {
    for (const [, sock] of this.#tunnels) {
      try {
        sock.destroy();
      } catch {
        /* 已经没了 */
      }
    }
    this.#tunnels.clear();
    for (const set of this.#conns.values()) {
      for (const conn of set) {
        try {
          conn.destroy();
        } catch {
          /* 对面早就没了 */
        }
      }
    }
    this.#conns.clear();
    for (const [userId, server] of this.#servers) {
      try {
        server.close();
      } catch {
        /* 关不干净不影响结论 */
      }
      try {
        nodeFs.unlinkSync(channelPathFor(this.#dir, userId));
      } catch {
        /* 已经没了 */
      }
    }
    this.#servers.clear();
  }
}
