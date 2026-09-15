// HTTP + WebSocket 服务。
//
// 上行：POST /api/say
// 下行：GET /api/stream（WebSocket，带 conversationId 与 sinceSeq）
//
// 无框架，只用 node:http 与 ws。

import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';

import { Auth, WS_AUTH_PROTOCOL, tokenFromRequest } from './auth.js';
import { ClientBuild } from './client-build.js';
import { loadConfig } from './config.js';
import { Dispatcher } from './dispatcher.js';
import { newId } from './conversation.js';
import { Store, toTranscript, renderTranscript } from './store.js';

export function createServer(cfg = loadConfig()) {
  /**
   * 本次进程启动的标识与时刻。
   *
   * 用途：客户端**重连**时我们要能判断"它上一次连的是不是这个进程"——
   * 不是的话就说明服务重启过，该跟它说一声"我已经升级好了"。
   * 判据放在服务端（用事件时间戳比），客户端不需要自己记任何东西。
   */
  const serverInfo = { startedAt: Date.now(), bootId: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` };
  const store = new Store(cfg.dataDir);
  const dispatcher = new Dispatcher(cfg, store);
  /**
   * 鉴权。
   *
   * ⚠ 没设口令时 `auth.active === false`，所有校验都放行 —— 这是为了让部署
   * 不中断（先上线、再设口令）。**启动日志会明确喊出来**，不能让它悄悄裸奔。
   */
  const auth = new Auth(cfg.dataDir, { enabled: cfg.authEnabled !== false });
  const server = http.createServer((req, res) => {
    // ⚠ 一个请求处理里抛出的异常**绝不能打死整个服务**。
    // 踩过两次：一次是 spawn ENOENT，一次是 handleHttp 里的作用域错误 ——
    // 都是一个请求把进程带走、systemd 反复重启，用户看到的是"整个应用没反应"。
    Promise.resolve()
      .then(() => handleHttp(req, res, dispatcher, clientBuild, serverInfo, auth))
      .catch((err) => {
        console.error(`处理 ${req.method} ${req.url} 出错：`, err);
        try {
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          }
          res.end(JSON.stringify({ error: 'internal' }));
        } catch {
          /* 连回包都失败了，只能算了 */
        }
      });
  });
  const wss = new WebSocketServer({
    noServer: true,
    // 浏览器不能给 WebSocket 设自定义头，所以令牌走子协议传。
    // 服务端必须**回一个**客户端请求过的子协议，否则浏览器会断开。
    handleProtocols: (protocols) => (protocols.has(WS_AUTH_PROTOCOL) ? WS_AUTH_PROTOCOL : false),
  });

  /** 优雅关闭：先断开所有 WebSocket，否则 server.close() 永远等不到回调。 */
  async function shutdown() {
    clientBuild.stop();
    for (const ws of wss.clients) {
      try {
        ws.close(1001, 'server shutting down');
      } catch {
        // 忽略
      }
    }
    await new Promise((resolve) => {
      server.close(() => resolve());
      // 兜底：1.5 秒内没关完就强制返回（systemd 还在等）
      setTimeout(resolve, 1500);
    });
  }

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/stream') {
      socket.destroy();
      return;
    }
    // ⚠ WebSocket 这条**必须单独堵**：它是实时读的全部通道，
    //   只堵 HTTP 等于把门锁了却把窗户开着。
    if (auth.active && !auth.verifyToken(tokenFromRequest(req))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conversationId = url.searchParams.get('conversationId') || 'c_default';
      const sinceSeq = Number(url.searchParams.get('sinceSeq') || 0);
      // ?dev=1 时额外订阅**开发事件**（后台在做什么）
      const dev = url.searchParams.get('dev') === '1';
      const conv = dispatcher.conversation(conversationId);
      // 页面一打开就把这个会话的 agent 起好（冷启动 2.7–5.1s，不该让用户等）
      dispatcher.warm(conversationId);

      // 这个客户端是**重连**回来的、而且它上一次连的不是这个进程 ⇒ 服务重启过，
      // 跟它说一声"我已经升级好了"（只会在重启后的第一次重连说一遍）
      // 只有**断线重连**才值得说"我已经升级好了"。
      // 页面刚打开就说这句是莫名其妙的 —— 用户没被打断过。
      const interrupted = url.searchParams.get('interrupted') === '1';
      if (interrupted) {
        dispatcher.noticeReconnect(conversationId, sinceSeq, serverInfo.startedAt);
      }

      const send = (event) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
      };
      // 一条连接只订阅一次：**产品事件一定有**，`dev` 只是额外再订开发事件。
      // 历史教训：曾经把 dev 写成"单独订阅"并把产品订阅挤掉 ⇒
      // 开发者模式一开，这条连接就只剩开发事件，用户说什么都没有回应。
      const unsubscribe = conv.subscribe(send, { dev });

      // 断线续传：把漏掉的事件补上
      conv.replay(sinceSeq, send);
      if (dev) conv.replayDev(send);

      ws.on('close', unsubscribe);
      ws.on('error', unsubscribe);
    });
  });

  /**
   * 客户端构建指纹：部署了新版本就通知在线客户端刷新。
   *
   * 为什么由服务端发起：**前端是哑的**，它只负责接收和回应；
   * "系统变了要不要刷新"是服务端知道的事，不该让客户端去猜。
   */
  const clientBuild = new ClientBuild(path.join(cfg.clientRoot, 'client-build.json'), {
    onReload: ({ buildId, previous }) => {
      let notified = 0;
      for (const conv of dispatcher.conversations.values()) {
        // 只在现场推、不进日志：迟到就没有意义的信号
        conv.emitTransient({ type: 'client/reload', reason: 'build-changed', buildId, previous });
        notified += 1;
      }
      console.log(`客户端有新构建 ${previous} → ${buildId}，已通知 ${notified} 个在线会话刷新`);
    },
  });
  clientBuild.start();
  // 让开发者模式能看到 agent 进程的活体状态（几个、在干什么、吃多少内存）
  dispatcher.startAgentTelemetry();

  return { server, dispatcher, cfg, store, clientBuild, auth, shutdown };
}

async function handleHttp(req, res, dispatcher, clientBuild, serverInfo, auth) {
  const url = new URL(req.url, 'http://localhost');
  const json = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  // ── 公开路由（只有这三个，其余全部要令牌）──────────────────
  //
  // ⚠ 白名单要短。每往里加一条，就是给没登录的人多开一扇窗。
  //   这里刻意**不包括**任何能读到对话、能发指令、能看调试数据的东西。

  // ① 客户端启动时问"要不要登录、我现在算不算登录了"
  if (req.method === 'GET' && url.pathname === '/api/auth') {
    // ⚠ `required` 现在**恒为 true**：没设口令时服务端不再放行，而是回 503（见下面 fail-closed）。
    //   所以客户端永远该显示登录页；`needsSetup` 用来告诉它"服务端还没设口令，去设置"。
    return json(200, {
      required: true,
      needsSetup: !auth.hasPassword,
      authenticated: auth.active ? Boolean(auth.verifyToken(tokenFromRequest(req))) : false,
    });
  }

  // ② 登录。公网上的登录框，**必须限速**。
  if (req.method === 'POST' && url.pathname === '/api/login') {
    if (!auth.active) return json(409, { error: 'auth-disabled' });
    const ip = clientIp(req);
    if (!auth.canAttempt(ip)) {
      return json(429, { error: 'too-many-attempts', retryAfterMs: auth.retryAfterMs(ip) });
    }
    const body = await readJson(req).catch(() => ({}));
    if (!auth.verifyPassword(body?.password)) {
      const { locked } = auth.noteFailure(ip);
      return json(401, { error: 'bad-password', locked });
    }
    auth.noteSuccess(ip);
    return json(200, { token: auth.issueToken() });
  }

  // ③ 版本：**没登录也要能用**（客户端靠它判断要不要刷新自己）。
  //    但没登录只给构建指纹，不给 bootId / startedAt 这类内部状态。
  if (req.method === 'GET' && url.pathname === '/api/version') {
    const authed = !auth.active || Boolean(auth.verifyToken(tokenFromRequest(req)));
    return json(200, {
      ...clientBuild.snapshot(),
      protocol: 1,
      ...(authed
        ? { bootId: serverInfo.bootId, startedAt: new Date(serverInfo.startedAt).toISOString() }
        : {}),
      // 服务端此刻的时钟。客户端拿它划一条线：**只有连上之后产生的消息**
      // 才回报"我看到了" —— 否则刷新页面时会把历史消息也回报一遍，
      // 用的是新会话的钟，算出来的感知延迟全是假的。
      serverNow: Date.now(),
    });
  }

  // ── 从这里往下全部要令牌 ─────────────────────────────────
  //
  // ⚠ 这是 **fail-closed**：口令没设 / `data/auth.json` 被删 / 开关被关，
  //   一律按安全默认**拒绝**，不是放行。
  //   旧写法是 `auth.active && !verify`，而 `auth.active = enabled && hasPassword` ——
  //   于是"忘了设口令"= 全部 API 裸奔（读全部对话 / 以主人身份下指令 / 读调试数据 /
  //   实时读所有消息，四条路同时打开），而这条链路的尽头是一个挂着**免密 sudo** 的 agent。
  //   这个洞在本项目**真实出现过**（v6 附十就是补它的）。
  if (!auth.active) {
    return json(503, {
      error: 'auth-not-configured',
      message: '服务端没有设置访问口令，已按安全默认拒绝全部请求。请先在服务端设置口令。',
      needsSetup: true,
    });
  }
  if (!auth.verifyToken(tokenFromRequest(req))) {
    return json(401, { error: 'unauthorized' });
  }

  // 健康检查（运维用）
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(200, { ok: true, conversations: dispatcher.conversations.size });
  }

  // 会话列表
  if (req.method === 'GET' && url.pathname === '/api/conversations') {
    const list = [...dispatcher.conversations.values()].map((c) => {
      const lastText = [...c.messages.values()].at(-1) || '';
      const lastUser = [...c.log].reverse().find((e) => e.type === 'user/echo');
      return {
        conversationId: c.id,
        title: lastUser?.text?.slice(0, 20) || '新对话',
        lastText: lastText.slice(0, 40),
        updatedAt: c.log.at(-1)?.at || Date.now(),
        unread: 0,
      };
    });
    return json(200, list);
  }

  // 读某个会话的完整记录（人话稿）—— 监听者与调试用
  const eventsMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/events$/);
  if (req.method === 'GET' && eventsMatch) {
    const conv = dispatcher.conversation(decodeURIComponent(eventsMatch[1]));
    return json(200, { conversationId: conv.id, events: conv.log, turns: toTranscript(conv.log) });
  }

  // 对某个会话做总结（监听者，按需调用）
  const summaryMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/summary$/);
  if (req.method === 'GET' && summaryMatch) {
    const conv = dispatcher.conversation(decodeURIComponent(summaryMatch[1]));
    const turns = toTranscript(conv.log);
    const summary = await dispatcher.summarize(conv.id, renderTranscript(turns));
    return json(200, { conversationId: conv.id, turns: turns.length, summary });
  }

  // 用户发言
  if (req.method === 'POST' && url.pathname === '/api/say') {
    const body = await readJson(req);
    if (!body?.text || typeof body.text !== 'string') {
      return json(400, { error: 'text is required' });
    }
    const conversationId = body.conversationId || 'c_default';
    const messageId = body.messageId || newId('u');
    // 客户端自报的"我什么时候按的发送"（它自己的时钟）。
    // 服务端的 at 只能说明"什么时候到服务器"，算不出**用户等了多久才看到反馈**。
    dispatcher.say({ conversationId, messageId, text: body.text, clientAt: body.clientAt });
    return json(202, { accepted: true, messageId });
  }

  // ── 监控层（debug agent）的出口 ────────────────────────────
  // 最近一次审查报告（时效性数字 + 机械规则 + agent 判断 + 变出来的任务）
  if (req.method === 'GET' && url.pathname === '/api/debug/report') {
    const cid = url.searchParams.get('conversationId') || 'c_main';
    const cached = dispatcher.debug.latest.get(cid);
    const conv = dispatcher.conversation(cid);
    return json(200, cached ?? { conversationId: cid, timeliness: dispatcher.debug.measure(conv) });
  }

  // 任务簿：debug agent 发现该改的东西就落在这里，不是写完就扔的日志
  if (req.method === 'GET' && url.pathname === '/api/debug/tasks') {
    const status = url.searchParams.get('status');
    return json(200, {
      tasks: dispatcher.debug.tasks.list(status ? { status } : {}),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/debug/analyze') {
    const body = await readJson(req).catch(() => ({}));
    const cid = body?.conversationId || 'c_main';
    const conv = dispatcher.conversation(cid);
    const report = await dispatcher.debug.review(conv, { force: body?.force === true });
    return json(200, report);
  }

  // 手动收口一件**产品**任务（页面上"还有件事在处理"那条）
  const taskDone = url.pathname.match(/^\/api\/tasks\/([^/]+)\/done$/);
  if (req.method === 'POST' && taskDone) {
    const body = await readJson(req).catch(() => ({}));
    const ok = dispatcher.completeTask(
      body?.conversationId || 'c_main',
      decodeURIComponent(taskDone[1]),
      body?.reason || 'completed',
    );
    return json(ok ? 200 : 409, { completed: ok });
  }

  const doneMatch = url.pathname.match(/^\/api\/debug\/tasks\/([^/]+)\/done$/);
  if (req.method === 'POST' && doneMatch) {
    const task = dispatcher.debug.tasks.complete(decodeURIComponent(doneMatch[1]));
    return task ? json(200, task) : json(404, { error: 'task not found' });
  }

  // 客户端回报"我什么时候看到的"——监控层要拿它算**感知延迟**
  if (req.method === 'POST' && url.pathname === '/api/receipt') {
    const body = await readJson(req);
    if (!body?.messageId) return json(400, { error: 'messageId is required' });
    const conv = dispatcher.conversation(body.conversationId || 'c_default');
    conv.emit({
      type: 'message/seen',
      messageId: body.messageId,
      // 都是**客户端时钟**：同一个钟内部相减，不受两端时钟偏差影响
      clientFirstSeenAt: Number(body.clientFirstSeenAt) || null,
      clientEndedSeenAt: Number(body.clientEndedSeenAt) || null,
      clientAt: Number(body.clientAt) || null,
    });
    return json(200, { ok: true });
  }

  // 中止（客户端点"停下"）
  if (req.method === 'POST' && url.pathname.startsWith('/api/message/') && url.pathname.endsWith('/cancel')) {
    const messageId = url.pathname.slice('/api/message/'.length, -'/cancel'.length);
    const body = await readJson(req).catch(() => ({}));
    const conv = body?.conversationId
      ? dispatcher.conversation(body.conversationId)
      : [...dispatcher.conversations.values()].find((c) => c.messages.has(messageId));
    if (!conv) return json(404, { error: 'conversation not found' });
    // ⚠ SDK 协议没有"取消这一轮"的能力 —— 只能不再把 agent 的话放给用户
    const cancelled = dispatcher.cancel(conv.id);
    return json(cancelled ? 200 : 409, { cancelled });
  }

  json(404, { error: 'not found' });
}

/**
 * 取客户端 IP —— **取最后一跳**。
 *
 * ⚠ 旧写法取第一跳（`split(',')[0]`），而 nginx 的 `$proxy_add_x_forwarded_for`
 * 会把**客户端自带的值前置**、把真实对端追加在最后 —— 于是拿到的是**攻击者自己填的字符串**。
 * 攻击者每次请求换一个 `X-Forwarded-For: 1.2.3.4`，限速器每次都看到"新 IP"，
 * "5 次锁 15 分钟"当场失效，公网口令框变成可无限爆破的靶子。
 */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) {
    const hops = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}
