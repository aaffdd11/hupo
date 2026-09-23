// **宿主 ↔ 容器那条通道**（多租户 ②-4）：把"这个人的 key"送进他的容器。
//
// ── 它解决什么 ────────────────────────────────────────────
// key 必须直接进到**那个人的容器里**（`<HUPO_DATA>/creds.yaml`，卷 · root 0600 —— `key-path.mjs`），
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
  /** 见构造参数 `onKeyBad`（容器说"那把钥匙不灵了"）。 */
  #onKeyBad = null;
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
   * **每台容器自报的版本指纹**（2026-09-21 加 · 契约 `docs/dev/45-TENANT-UPDATE.md` §二）。
   *
   * ⚠️ 为什么要有它：容器原来**不知道自己跑的是哪一版** ⇒ 一台可以在旧代码上
   *    静默跑几个月，而两边都以为没事。这个 Map 就是"当前事实"的落脚处。
   */
  #builds = new Map();
  /** 宿主侧那个回调（见构造参数 `onBuild`）。 */
  #onBuild = null;
  /**
   * 容器**自报"有钥匙了"**时的回调（2026-09-22 加 · 契约 `46-KEY-DELIVERY.md` §四）。
   *
   * ⚠️ 为什么需要它：钥匙现在可以在**盒子里**被放进来（`put-key.mjs`），
   *    也可以由主人**投递**进来。这两种情况下宿主那本"这把用不了"的旧账得清掉 ——
   *    不然用户明明换了一把好的，界面上还挂着"刷新一下重新填"。
   */
  #onKeyUp = null;

  /**
   * @param {object} o
   * @param {string} o.dir                    套接字放哪个目录
   * @param {(userId:string)=>(string|null)} o.keyFor  **这个人的 key**；`null` = 还没有
   * @param {(m:string)=>void} [o.log]
   */
  constructor({ dir, keyFor, log = () => {}, onKeyBad = null, onBuild = null, onKeyUp = null }) {
    if (!dir) throw new Error('TenantChannel 需要 dir');
    if (typeof keyFor !== 'function') throw new Error('TenantChannel 需要 keyFor(userId)');
    this.#dir = dir;
    this.#keyFor = keyFor;
    this.#log = log;
    this.#onKeyBad = onKeyBad;
    this.#onBuild = onBuild;
    this.#onKeyUp = onKeyUp;
  }

  /** 每台自报的版本（`userId → 指纹`）。**算出来的，不是记出来的**。 */
  get builds() {
    return new Map(this.#builds);
  }

  get dir() {
    return this.#dir;
  }

  /**
   * **正在替几个租户支着耳朵**（横幅要如实报这个数）。
   *
   * ⚠️ 它必须是**算出来的**、不是记出来的（2026-09-21 改）：租户通道多了
   *    "按需开一条"这条路（`43-AUTO-PROVISION.md`）⇒ 谁要是在别处自己加个计数器，
   *    横幅报的数与真实情况必然会漂 —— 而横幅正是主人开机看的那一眼。
   */
  get listeningCount() {
    return this.#servers.size;
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
    // 🔴 **这里不再念"容器连进来了"**（2026-09-23 修，账 #54）。
    //
    //    为什么：**这条连接不一定是容器**。容器里那个"等钥匙"的轮询
    //    （`tenant-shell.mjs` 的 `watchForKey`）每 60 秒开一条**新连接**来问一次
    //    （问完就断、过 5 秒再来）—— 那**只是一次例行询问**，不是"一台容器起来了"。
    //    原来那行把每一次都念成"容器连进来了" ⇒ 两个租户还没填钥匙时
    //    `serve.log` **每 60 秒长两行**，把真错误淹掉（查事故时第一眼什么也看不出来）。
    //    ⇒ 现在**按"它是谁"分别念**：真的容器数据面（下面 `tunnel-ready` 那一支）才念；
    //      轮询（`hello` + `role:'tenant-shell'`）不念 —— 容器自己的日志里
    //      已经有那句实话（"还没等到 key —— 用户还没在网页上填"）。
    //    ⚠️ 判据钉在 `test/tenant-channel.test.js`：**两种连接各连一次，看哪一条留痕**。

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
      case 'key-bad': {
        // 🔴 **容器说"那一把钥匙上游不认"**（2026-09-21 加）。
        //    为什么必须由它来说：`turn/end` 那句 `code:'AUTH'` 只有
        //    **盒子里的调度器**看得见，而"让用户能重新填"要宿主做。
        //    ⇒ 收到就把"这一台有钥匙"这条记忆撤掉，并叫一声（宿主据此标成用不了）。
        //    ⚠️ 这一条里**没有任何凭据**，只有"不灵了"这个事实。
        this.#keyKnown.delete(userId);
        this.#record(userId, 'key-bad');
        this.#log(`  ⚠️ ${userId} 那边说那把钥匙用不了 —— 撤掉"有钥匙"这条记忆`);
        try {
          this.#onKeyBad?.(userId, 'rejected');
        } catch (err) {
          this.#log(`  ⚠️ key-bad 回调出错：${err?.message ?? err}`);
        }
        return;
      }
      case 'tunnel-ready': {
        // ★ 容器自报"我这儿有没有钥匙" ⇒ 记下来（**它是这个事实的来源**）
        if (msg?.hasKey === true) {
          const first = !this.#keyKnown.has(userId);
          this.#keyKnown.add(userId);
          // ★ **它说"有"** ⇒ 中心那本"这把不灵了"的账跟着清掉（`46-KEY-DELIVERY.md` §四）。
          //   ⚠️ 只在**从没有变成有**的时候叫（每次重连都叫会刷屏，而且没有新信息）。
          if (first) {
            try {
              this.#onKeyUp?.(userId);
            } catch (err) {
              this.#log(`  ⚠️ key-up 回调出错：${err?.message ?? err}`);
            }
          }
        } else {
          this.#keyKnown.delete(userId);
          // 🔴 **它说"没有" ⇒ 宿主内存里那份就是错的**（2026-09-21 加）。
          //    为什么必须清：宿主那本账是**内存**，它自己重启会忘、而用户
          //    **不该因为宿主忘了就被再问一次钥匙**（这正是主人报过的那个 bug）；
          //    反过来，容器**真的**没有钥匙（重启过 / 那把被撤了）时，
          //    宿主还留着 ⇒ 用户看着"有钥匙"，其实模型那条路不通。
          //    ⇒ **说"有"的那一方对**，两边都不留一个"我以为是"。
          //    ⚠️ `absent`（不是 `rejected`）：我们**不知道**那把坏没坏。
          try {
            this.#onKeyBad?.(userId, 'absent');
          } catch (err) {
            this.#log(`  ⚠️ absent 回调出错：${err?.message ?? err}`);
          }
        }
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
        //   ⚠️ 它**只说"连上了、钥匙等它自报"**（2026-09-21 修过一次）：`#keyFor` 是
        //      **宿主自己的记忆**，刚重启时是空的，而容器可能还揣着钥匙 ⇒
        //      这里替它下结论就是**日志在说假话**。
        //   ⚠️ 这一行**从 `#onConn` 搬过来的**（2026-09-23，账 #54）：只有报了这一帧的
        //      连接才是**真的容器数据面**；"等钥匙"的轮询不报这一帧，也就不该留这一行。
        this.#log(`  通道 ${userId}：容器连进来了（有没有钥匙，等它自报）`);
        this.#log(`  ✓ ${userId} 的隧道通了（数据面走这条）· 钥匙：${msg?.hasKey === true ? '有' : '还没有'}`);

        // ★ **版本指纹**（契约 `docs/dev/45-TENANT-UPDATE.md` §二/§三）：
        //   自报的那一版对不对，由宿主这边比 —— 比完**该说话就说话**，
        //   不一致就**告诉它重开**（退不退由它自己定：先把手上那轮说完）。
        //   ⚠️ 决定权在 `serve.js`（`onBuild` 是它给的纯函数比较）；
        //      这里只负责"发那一帧、并把话记下来"。
        const bid = typeof msg?.buildId === 'string' ? msg.buildId : '';
        this.#builds.set(userId, bid || 'dev');
        if (this.#onBuild) {
          let verdict = null;
          try {
            verdict = this.#onBuild(userId, bid || 'dev');
          } catch (err) {
            this.#log(`  ⚠️ 比版本那一步出错：${err?.message ?? err}`);
          }
          if (verdict?.line) {
            const head = verdict.reload ? '⚠️' : '·';
            this.#log(`  ${head} ${userId}：${verdict.line}`);
          }
          if (verdict?.reload === true) {
            // ⚠️ 那一帧**只有类型、没有内容**（见 `tenant-tunnel-agent.mjs` 里那段）。
            this.#send(conn, { v: CHANNEL_VERSION, type: 'reload' });
            this.#record(userId, 'reload-asked', { build: bid || 'dev' });
          }
        }
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
  /**
   * **主动叫某一台重开**（契约 `docs/dev/45-TENANT-UPDATE.md` §三）。
   *
   * ⚠️ 为什么不能只靠 `tunnel-ready` 那一次比：那条隧道是**长连接**，
   *    一直连着就不会再报 ⇒ **翻完 `current` 正在跑的那几台谁都不知道**。
   *    ⇒ 宿主得能**现推**一帧（内容仍然**一个字段都不带**）。
   *
   * @returns {boolean} 推出去了没有（那台现在没连着就 `false` —— **不许假装发了**）
   */
  requestReload(userId) {
    const set = this.#tunnelConns.get(userId);
    if (!set || set.size === 0) return false;
    for (const conn of set) this.#send(conn, { v: CHANNEL_VERSION, type: 'reload' });
    this.#record(userId, 'reload-asked');
    return true;
  }

  pushKey(userId, key) {
    let n = 0;
    for (const conn of this.#conns.get(userId) ?? []) {
      this.#send(conn, { state: 'ready', key });
      n += 1;
    }
    // ⚠️ **要如实报"推出去了几条"**（2026-09-22 加）：投递那条路靠它判断
    //    "那台现在通不通" —— 报个恒真的数就会在**没送到**的时候把主人的文件删掉。
    return n;
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
