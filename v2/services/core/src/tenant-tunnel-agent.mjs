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
 * @param {()=>void} [o.onReload] 宿主说"有新的一版"（契约 `45-TENANT-UPDATE.md` §三）
 * @param {()=>void} [o.onReady]  报过到了（这一下之后才认"重开"那句话）
 */
/**
 * 🔴 **给"盒子里的服务"一个能跟宿主说句话的口子**（2026-09-21 加）。
 *
 * 为什么需要它：`turn/end` 里那句 `code:'AUTH'`（钥匙不对）**只有容器里的
 * 调度器看得见** —— 而"把那一把标成用不了、让用户能重新填"这件事**得宿主做**
 * （用户那一屏问的是宿主）。没有这个口子，容器知道了也没处说。
 *
 * ⚠️ 它**只在容器里**有用（宿主上那条隧道根本没起 ⇒ `liveSend` 是 `null`）。
 * ⚠️ 发出去的东西**不含任何凭据**：这里只说"那一把不灵了"。
 */
let liveSend = null;
/** 见 `dropTunnel()`。 */
let liveDrop = null;

/**
 * 往宿主那条通道上说一句（不在隧道里、或对面断了 ⇒ 返回 `false`，**不抛**）。
 * @param {object} obj
 * @returns {boolean} 说出去了没有
 */
export function notifyHost(obj) {
  if (!liveSend) return false;
  try {
    liveSend(obj);
    return true;
  } catch {
    return false;
  }
}

/**
 * **把隧道掐一下让它重连**（2026-09-21 加）。
 *
 * 为什么要它：`notifyHost` 是**一次性**的（连接恰好在重连就**丢了** ——
 * 实测栽过一次：容器日志说"我告诉宿主了"，而宿主**什么都没收到**）。
 * 而"这一台现在到底有没有钥匙"这件事**每次重连都会自报一遍**
 * （`tunnel-ready.hasKey`）—— 那是一条**一定会送到**的路。
 * ⇒ 钥匙不灵了就掐一下：三秒后它自己连回来，宿主就听见了真话。
 * ⚠️ 它**不抛**（不在隧道里就什么都不做）。
 */
export function dropTunnel() {
  try {
    liveDrop?.();
    return true;
  } catch {
    return false;
  }
}

export function runTunnelAgent({
  socketPath,
  localTarget = process.env.HUPO_LOCAL_TARGET ?? DEFAULT_LOCAL_TARGET,
  log = (m) => console.log(m),
  reconnectMs = 3000,
  onReload = null,
  onReady = null,
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
  // ★ 把它挂到模块级 ⇒ 盒子里的 `serve.js` 也能用它跟宿主说话（见 `notifyHost`）
  //   ⚠️ **要如实说"发出去了没有"**（2026-09-21 实测栽了一次）：
  //      上一版直接挂 `send`，而它写的是 `conn?.write` —— 连接正好在重连时
  //      **静默写进 `null`**，调用方却以为说成了 ⇒ 那条消息**丢了**，
  //      现象是"宿主什么都没收到，而容器日志说它说了"。
  liveDrop = () => {
    try {
      conn?.destroy();
    } catch {
      /* 已经没了 */
    }
  };
  liveSend = (obj) => {
    if (!conn || conn.destroyed) return false;
    send(obj);
    return true;
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
      return;
    }
    // ★ **"有新的一版，重开一下吧"**（契约 `docs/dev/45-TENANT-UPDATE.md` §三）。
    //   ⚠️ 这一帧**不带任何内容**：它不是一个远程执行口。宿主本来就已经决定
    //      容器跑什么代码（**镜像就是 `deploy` 造的**）⇒ "叫它重开"没有新增能力；
    //      而"带载荷的重开"会新增 —— 所以载荷一个字段都不给。
    //   ⚠️ 退不退由 `createReloader` 决定（手上还有话就先说完）；这里只**转达**。
    if (msg?.type === 'reload') {
      log('  · 宿主说有新的一版（重开的时机由这边定：先把手上那轮说完）');
      try {
        onReload?.();
      } catch (err) {
        log(`  ⚠️ 重开那一步没做成：${err?.message ?? err}`);
      }
    }
  };

  const connect = () => {
    if (stopped) return;
    conn = nodeNet.connect(socketPath);
    conn.setEncoding('utf8');
    conn.on('connect', () => {
      // ★ **顺带报一句"我这儿到底有没有钥匙"**（2026-09-21 主人报的问题：
      //   "为什么刷新后又要我输入 apikey"）。
      //   根因：宿主只在**内存**里记着"送过没有"，它一重启就忘 —— 而钥匙
      //   **真的在容器里**（`/run/hupo/creds.yaml`，tmpfs）。
      //   ⇒ 让**容器**当这个事实的来源：它一说"我有"，宿主就不该再问用户要。
      let hasKey = false;
      try {
        hasKey = nodeFs.existsSync(process.env.HUPO_KEY_FILE ?? '/run/hupo/creds.yaml');
      } catch {
        /* 读不到就当没有 */
      }
      // ★ 自报**版本指纹**（2026-09-21 加 · 契约 `docs/dev/45-TENANT-UPDATE.md` §二）：
      //   宿主据此知道"这一台跑的是哪一版"，也是它决定叫不叫你重开的依据。
      //   ⚠️ 兜底那份（镜像里的）没有 `manifest.json` ⇒ 它就是 `dev`，**如实报**。
      const buildId = process.env.HUPO_BUILD_ID ?? 'dev';
      send({ v: 1, type: 'tunnel-ready', hasKey, buildId });
      log(`  隧道通了（→ ${localTarget}）· 版本 ${buildId}`);
      try {
        onReady?.(); // 报到过了 ⇒ 从现在起认"重开"那句话
      } catch {
        /* 报到的钩子出问题，不该把隧道带走 */
      }
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
      liveSend = null; // 停了就别再往里写（`notifyHost` 会说"没说出去了"）
      liveDrop = null;
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
