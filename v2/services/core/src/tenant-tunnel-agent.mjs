// **容器侧的隧道**：把宿主转发进来的连接，接到**本机那个服务**上
// （多租户 ②-4b 后半 · 数据面 · `docs/dev/34-CONTAINER.md` §11.5 选项乙）。
//
// ── 为什么是"隧道"而不是"开个端口" ────────────────────────
// 另一条路是每租户一个回环端口（`-p 127.0.0.1:<port>:8080`）。**没走它**，因为
// **回环是拓扑不是准入**：宿主上**任何** uid 都能连到那个口 ⇒ 甲的口乙够得着
// （这个项目已经否过一次那条路）。
// ⇒ 走"经同一条通道做字节隧道"：**不开口、不暴露回环**，身份还是"你连的是哪个套接字"。
//
// ── 它做什么 ──────────────────────────────────────────────
// 连上宿主的通道，说一声"我这条连接能跑隧道"，然后：
//   收到 `open`  ⇒ 连本机的 `HUPO_LOCAL_TARGET`（默认 `127.0.0.1:8080`）
//   收到 `data`  ⇒ 把字节写进那条连接
//   本机回了字节 ⇒ 按 `data` 发回去
//   任一边关   ⇒ 发 `close`
//
// ⚠️ **它只连回环**：目标是容器**自己**的调度器，绝不许拿它当跳板去连别的地址
//    （`open` 帧里的地址**一概不认** —— 那是宿主说了算的东西，而这一层不该被它放大）。
// ⚠️ **它不解析内容**：隧道就是搬字节，HTTP 语义在两头。

import nodeFs from 'node:fs';
import nodeNet from 'node:net';

/** 容器里那个服务听在哪。 */
export const DEFAULT_LOCAL_TARGET = '127.0.0.1:8080';

/** 一帧多大（base64 之前）。太大伤延迟，太小费帧头。 */
const CHUNK = 32 * 1024;

/**
 * 跑隧道代理（**一直在重连**：宿主的服务重启不该让容器里的隧道永久断掉）。
 *
 * @param {object} o
 * @param {string} o.socketPath
 * @param {string} [o.localTarget]
 * @param {(m:string)=>void} [o.log]
 */
export function runTunnelAgent({
  socketPath,
  localTarget = process.env.HUPO_LOCAL_TARGET ?? DEFAULT_LOCAL_TARGET,
  log = (m) => console.log(m),
  reconnectMs = 3000,
} = {}) {
  // ⚠️ 目标可以是 **UDS 路径**（`/run/hupo/local-api.sock` · 选项甲）或者 `host:port`。
  //    前者只连本机那条 **`0600`、只有 root 开得开**的口 —— 身份由内核保证。
  const isUnix = String(localTarget).startsWith('/');
  const [host, portStr] = isUnix ? ['', ''] : String(localTarget).split(':');
  const port = Number.parseInt(portStr ?? '8080', 10);
  let stopped = false;
  let conn = null;
  let buf = '';
  const tunnels = new Map(); // id → net.Socket

  const send = (obj) => {
    try {
      conn?.write(`${JSON.stringify(obj)}\n`);
    } catch {
      /* 对面没了 */
    }
  };

  const openTunnel = (id) => {
    // ⚠️ **目标写死**（只连本机那个服务）：`open` 帧里就算带了地址也不认。
    const sock = isUnix ? nodeNet.connect(localTarget) : nodeNet.connect(port, host);
    tunnels.set(id, sock);
    sock.on('data', (d) => {
      for (let i = 0; i < d.length; i += CHUNK) {
        send({ v: 1, type: 'data', id, b64: d.subarray(i, i + CHUNK).toString('base64') });
      }
    });
    sock.on('close', () => {
      tunnels.delete(id);
      send({ v: 1, type: 'close', id });
    });
    sock.on('error', () => {
      tunnels.delete(id);
      send({ v: 1, type: 'close', id });
    });
  };

  const onLine = (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 一行坏话不该把自己弄死
    }
    const id = msg?.id;
    if (msg?.type === 'open') {
      if (!tunnels.has(id)) openTunnel(id);
      return;
    }
    if (msg?.type === 'data') {
      const sock = tunnels.get(id);
      if (sock && typeof msg.b64 === 'string') sock.write(Buffer.from(msg.b64, 'base64'));
      return;
    }
    if (msg?.type === 'close') {
      const sock = tunnels.get(id);
      tunnels.delete(id);
      try {
        sock?.destroy();
      } catch {
        /* 已经没了 */
      }
    }
  };

  const connect = () => {
    if (stopped) return;
    conn = nodeNet.connect(socketPath);
    conn.setEncoding('utf8');
    conn.on('connect', () => {
      send({ v: 1, type: 'tunnel-ready' });
      log(`  隧道通了（→ ${localTarget}）`);
    });
    conn.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        onLine(line);
      }
    });
    const retry = () => {
      conn = null;
      for (const [, s] of tunnels) {
        try {
          s.destroy();
        } catch {
          /* 已经没了 */
        }
      }
      tunnels.clear();
      if (stopped) return;
      const t = setTimeout(connect, reconnectMs);
      t.unref?.();
    };
    conn.on('close', retry);
    conn.on('error', () => {
      /* 交给 close */
    });
  };

  connect();
  return {
    stop() {
      stopped = true;
      try {
        conn?.destroy();
      } catch {
        /* 已经没了 */
      }
      conn = null;
    },
    get tunnels() {
      return tunnels.size;
    },
  };
}

// ── 直接跑 ────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const sock = process.env.HUPO_CHANNEL ?? '';
  if (!sock || !nodeFs.existsSync(sock)) {
    console.log('  · 没有通道（HUPO_CHANNEL）—— 隧道这层不启动');
    process.exit(0);
  }
  runTunnelAgent({ socketPath: sock });
}
