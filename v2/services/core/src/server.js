// HTTP + WebSocket 服务面。手册 `08-SPEC.md` §2.1 / §2.2。
//
// 三条最容易做错、这里刻意写死的：
//
//   1. **fail-closed**：没设口令 ⇒ 除三个公开路由外**一律 503**。
//      不是跳登录页、不是放行——是明确拒绝。默认放行 = 一次忘记设口令
//      就等于把整台机器公开发布，而**一切看起来都在正常工作**。
//   2. **令牌只从 Authorization 头 / WS 子协议来，绝不从 URL 来**
//      （URL 会进日志、进 Referer、进浏览器历史）。
//   3. **WS 上没有令牌时，在握手阶段就拒**（401），
//      不要"先连上再关"——那会给爬虫留下一个可以站着的连接。

import http from 'node:http';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { WebSocketServer } from 'ws';

import { PUBLIC_ROUTES, clientIp, tokenFromRequest } from './auth.js';
import { SayError } from './say.js';
import { ADMIT_RATIO, readAdmission } from './admission.js';
import { CATCHUP_RENDER, markCatchUp, planResume } from './resume.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.bin': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
};

// ── 过程四档（决策 D7 / 契约 `docs/dev/26-PROCESS-LEVELS.md`）────────────
//
// ⚠️ **`level` 是连接级的**：每条 WS 连接各自一份（从 query 取），
//    不是进程级开关，也不是全局设置——一台设备选了"推理原文"**不许**
//    改变另一台设备看到的东西。
//
// 四档是**累加的梯子**（契约 §三那张表）：
//
//   quiet      只说出口的话（`message/*`）——**连 `message/status` 都不发**
//   doing ✅    + `message/status`（`process_words.dart` 翻成人话）
//   steps       + `step/*`
//   reasoning   + `reasoning/*`（⚠️ 只有主人；默认关）
//
// ⚠️ **过程事件（`step/*` · `reasoning/*`）一律是瞬态的**——
//    由 `session-translate.js` 走 `emitTransient()` 发出来（不占号、不落盘），
//    这里的闸**只决定"发给哪条连接"**，与落盘无关。
//    两层分开是有意的：如果由这里决定落不落盘，那"某个连接的档位"
//    就会影响磁盘上的内容——那正是泄露闸要挡的形状。
//    见 `session-translate.js` 文件头与契约 §二。

/** 认得的四档。**不在这个表里的 query 一律当默认档**，不许把连接拒掉。 */
export const PROCESS_LEVELS = Object.freeze(['quiet', 'doing', 'steps', 'reasoning']);

/** 不带 `level` 时的档（契约：默认 `doing`）。 */
export const DEFAULT_PROCESS_LEVEL = 'doing';

/**
 * 各档额外放行哪些事件（`message/*` 每档都发，不在这张表里）。
 *
 * ⚠️ `quiet` 是空集，**包括 `message/status`** —— "安静档要真的安静"，
 *    少挡这一条就等于这一档没做（契约 §四点名要验）。
 */
const LEVEL_EXTRA_TYPES = Object.freeze({
  quiet: new Set(),
  doing: new Set(['message/status']),
  steps: new Set(['message/status', 'step/start', 'step/end']),
  // 累加：`reasoning` 档**也**收步骤（它是梯子最上面那一阶）
  reasoning: new Set(['message/status', 'step/start', 'step/end', 'reasoning/delta']),
});

/** 每一档都发的那几样：它**说出口的话**。 */
const ALWAYS_TYPES = new Set(['message/start', 'message/text', 'message/end']);

/**
 * 从 query 解出这一条连接的档。
 *
 * ⚠️ **认不出来 ⇒ 默认档，不报错、更不许拒连接**（契约 §三）：
 *    客户端版本比服务端新/旧都会出现不认识的档，那时正确的行为是
 *    "按默认档服务"，而不是把用户挡在门外（N10 的另一面：
 *    宁可少说，不能不说）。
 *
 * @param {URLSearchParams|string|null} params
 * @returns {'quiet'|'doing'|'steps'|'reasoning'}
 */
export function parseLevel(params) {
  let raw = null;
  if (typeof params === 'string') {
    try {
      raw = new URLSearchParams(params).get('level');
    } catch {
      raw = null;
    }
  } else if (params && typeof params.get === 'function') {
    raw = params.get('level');
  }
  if (typeof raw !== 'string') return DEFAULT_PROCESS_LEVEL;
  const level = raw.trim();
  return PROCESS_LEVELS.includes(level) ? level : DEFAULT_PROCESS_LEVEL;
}

/**
 * 这条连接收不收这个事件。**纯函数**（好把它单独钉住）。
 *
 * @param {object} event  时间线上推出来的事件
 * @param {object} o
 * @param {string} o.level 这一条连接的档
 * @param {boolean} [o.dev] `dev=1` 那条**附加**通道（见 `onStream` 里的说明）
 */
export function levelAllows(event, { level, dev = false } = {}) {
  const type = event?.type;
  if (typeof type !== 'string') return false;
  if (ALWAYS_TYPES.has(type)) return true;
  if (LEVEL_EXTRA_TYPES[level]?.has(type)) return true;
  // ★ `dev=1` 与 `level` **并存**（不是别名）：见 `onStream` 里那段为什么。
  if (dev && type.startsWith('step/')) return true;
  return false;
}

/** 这两个**不许长缓存**，否则用户看到的是几小时前的界面。 */
/**
 * 文件名里带**内容指纹**的，才允许长缓存。
 *
 * ⚠️ 这里是踩过一个坑之后改的（2026-09-21）：
 *    早先的规则是"入口文件 `no-cache`、其余一律 `immutable`（一年）"，
 *    而注释里想的是"带 hash 的产物可以长缓存"——**可 Flutter web 的产物
 *    文件名里根本没有 hash**：`main.dart.js`、`flutter_bootstrap.js`、
 *    `assets/**`、`canvaskit/**` 全是固定名字。
 *    ⇒ 浏览器把旧的那份当成"一年内不用再问"，
 *      **于是每次部署对已经来过的人等于没部署**。
 *      （现场：主人平板上没有新加的按钮，而服务端产物早就换了。）
 *
 * ⇒ 规则改成"**看名字**"：只有**真的**带指纹的才长缓存，其余一律回来问一句。
 *    `no-cache` 不是"不缓存"，是"用之前先问"——配合下面的 `Last-Modified`，
 *    没改就是 304，只花一次往返。
 */
// ⚠️ 别写成"点 + 十六进制 + **一个**扩展名" —— 真实的产物名是
//    `main.<hash>.dart.js`（**两个点**），那样写一条都匹配不到（我第一版就写错了）。
const CONTENT_HASHED = /[.\-][0-9a-f]{8,}\./i;

/** 该给哪个 cache-control。**判据是文件名，不是"它是不是入口"。** */
export function cacheControlFor(relPath) {
  return CONTENT_HASHED.test(relPath)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
}

export function createServer({
  timeline,
  store,
  auth,
  say,
  dispatcher = null,
  webRoot = null,
  buildId = 'dev',
  now = Date.now,
  log = () => {},
  /** 准入闸。默认读这台机器的 cgroup；测试注入一个"一定拒"的就行。 */
  admit = readAdmission,
}) {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      // 兜底：HTTP 层自己不许把异常漏出去变成未捕获
      log(`[http] 未处理异常：${err?.stack ?? err}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
      else res.destroy();
    });
  });

  // ── HTTP ────────────────────────────────────────────────

  async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // 公开路由：**只有这三个**
    if (path === '/api/version' && req.method === 'GET') {
      return sendJson(res, 200, { buildId, serverNow: now() });
    }
    if (path === '/api/auth' && req.method === 'GET') {
      // 客户端靠这个决定"显示登录页"还是"直接进"
      return sendJson(res, 200, { needsSetup: auth.needsSetup });
    }
    if (path === '/api/login' && req.method === 'POST') {
      return handleLogin(req, res);
    }

    // 其余 /api/* 一律要令牌；**没设口令时 fail-closed**
    if (path.startsWith('/api/')) {
      if (auth.needsSetup) {
        return sendJson(res, 503, {
          error: 'not-setup',
          text: '这台机器还没设密码，先设好再用。',
        });
      }
      const token = tokenFromRequest(req);
      const claim = token ? auth.verify(token) : null;
      if (!claim) return sendJson(res, 401, { error: 'unauthorized' });

      // ★ **续期**（决策 A）：用现在这个令牌换一个新的，`exp` 往前挪。
      //   ⚠️ 它**不是**公开路由（`PUBLIC_ROUTES` 仍然只有三个）：没有有效令牌就拿不到新的。
      if (path === '/api/renew' && req.method === 'POST') {
        const r = auth.renew(tokenFromRequest(req));
        if (!r) return sendJson(res, 401, { error: 'expired' });
        return sendJson(res, 200, { token: r.token, expiresAt: r.expiresAt });
      }
      if (path === '/api/say' && req.method === 'POST') return handleSay(req, res, claim);
      if (path === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, timelineId: timeline.id, seq: timeline.seq });
      }
      if (path === '/api/audit' && req.method === 'GET') {
        return sendJson(res, 200, { entries: auth.auditLog });
      }
      return sendJson(res, 404, { error: 'not-found' });
    }

    // 静态：Flutter web
    if (webRoot) return serveStatic(req, res, path);
    return sendJson(res, 404, { error: 'not-found' });
  }

  async function handleLogin(req, res) {
    const ip = clientIp(req);
    if (auth.isLocked(ip)) {
      const left = Math.ceil(auth.lockRemainingMs(ip) / 1000);
      // 手册 D2：**要给剩余时间**，不是只说"试得太频繁了"
      return sendJson(res, 429, { error: 'locked', retryAfterSec: left });
    }
    let body;
    try {
      body = await readJson(req, 4096);
    } catch {
      return sendJson(res, 400, { error: 'bad-json' });
    }
    const ok = auth.verifyPassword(body?.password);
    if (!ok) {
      const locked = auth.recordLoginFailure(ip);
      return sendJson(res, 401, { error: 'bad-password', locked });
    }
    auth.recordLoginSuccess(ip);
    const { token, expiresAt } = auth.issue({ sub: 'owner' });
    return sendJson(res, 200, { token, expiresAt });
  }

  async function handleSay(req, res, claim) {
    let body;
    try {
      body = await readJson(req, 64 * 1024);
    } catch (err) {
      return sendJson(res, 400, { error: 'bad-json' });
    }
    try {
      // ★ **准入闸**（手册 §9.1）：满了就明确拒绝，而且要在**落盘之前**判。
      //   ⚠️ 重发（duplicate）**不判**：那一句早就落盘了，拿"忙"拒它会让界面说假话
      //      （显示"没发出去"，而服务端其实收下了，那一轮还在跑）。
      //   ⚠️ 拒了 ⇒ **什么都没写**（`say.say()` 根本没被调用）——这就是
      //      §9.1 那句"不建空 jsonl 文件"的落点。
      if (!say.isDuplicate(body?.messageId)) {
        const adm = admit();
        if (!adm.ok) {
          log(`[准入] 拒了一句（内存 ${Math.round((adm.ratio ?? 0) * 100)}% ≥ ${Math.round(ADMIT_RATIO * 100)}%）`);
          return sendJson(res, 429, { error: 'busy' });
        }
      }

      const result = say.say({
        messageId: body?.messageId,
        text: body?.text,
        clientAt: body?.clientAt,
      });
      // ⚠️ **只有真落盘了才交给 agent**。
      //    重复（duplicate）**绝不能**再投一次——
      //    那正是"重发 = agent 干两遍"（评审 E2）。
      if (!result.duplicate && dispatcher) {
        // 投递是异步的（`session/prompt` 立刻返回，答案从事件流回来），
        // 所以**不等它**——等它会把 HTTP 响应也拖住。
        dispatcher.deliver(body?.text, { messageId: body?.messageId }).catch((err) => {
          log(`[dispatch] 投递失败：${err?.message ?? err}`);
        });
      }
      return sendJson(res, 200, {
        ok: true,
        duplicate: result.duplicate,
        seq: result.event?.seq ?? null,
        sub: claim.sub,
      });
    } catch (err) {
      if (err instanceof SayError) return sendJson(res, err.status, { error: err.message });
      throw err;
    }
  }

  // ── 静态文件 ────────────────────────────────────────────

  function serveStatic(req, res, path) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'method-not-allowed' });
    }
    const rel = path === '/' ? '/index.html' : path;
    // 防目录穿越
    const target = nodePath.normalize(nodePath.join(webRoot, rel));
    if (!target.startsWith(nodePath.resolve(webRoot))) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    let file = target;
    let stat = nodeFs.existsSync(file) ? nodeFs.statSync(file) : null;
    if (!stat || stat.isDirectory()) {
      // SPA 回退：不认识的路径交回 index.html
      file = nodePath.join(webRoot, 'index.html');
      stat = nodeFs.existsSync(file) ? nodeFs.statSync(file) : null;
      if (!stat) return sendJson(res, 404, { error: 'not-found' });
    }
    const ext = nodePath.extname(file).toLowerCase();
    const relFile = `/${nodePath.relative(webRoot, file)}`;
    const cc = cacheControlFor(relFile);
    // HTTP 的日期只到秒 ⇒ 比较时也要落到秒，否则"同一秒内的改动"会被误判成 304
    const lastModified = new Date(Math.floor(stat.mtimeMs / 1000) * 1000).toUTCString();

    // ★ **回来问一句**的时候，没改就只回 304（不带 body）。
    const ims = Date.parse(req.headers['if-modified-since'] ?? '');
    if (!Number.isNaN(ims) && Math.floor(stat.mtimeMs / 1000) * 1000 <= ims) {
      res.writeHead(304, { 'cache-control': cc, 'last-modified': lastModified });
      return res.end();
    }

    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': cc,
      'last-modified': lastModified,
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    nodeFs.createReadStream(file).pipe(res);
  }

  // ── WebSocket ───────────────────────────────────────────

  /**
   * 拒绝一次 WS 升级。
   *
   * ⚠️ 要带 **body 与 content-type**：裸的 `HTTP/1.1 401` 客户端什么也读不到，
   * 排障时**分不清是"没令牌"还是"中间有人挡了"**（nginx 也会回 401/503）。
   * 带上 JSON 之后，"这个响应到底出自我这儿还是出自代理"一眼可辨。
   */
  function rejectUpgrade(socket, status, reason, payload) {
    const body = JSON.stringify(payload);
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\n` +
        'content-type: application/json; charset=utf-8\r\n' +
        `content-length: ${Buffer.byteLength(body)}\r\n` +
        'connection: close\r\n' +
        '\r\n' +
        body,
    );
    socket.destroy();
  }

  const wss = new WebSocketServer({
    noServer: true,
    // 只认 `bearer` 这一个子协议名；**回显的是名字，不是令牌**
    // （默认行为是回显第一个，虽然这里也安全，但显式写出来免得后人改坏）
    handleProtocols: (protocols) => (protocols.has('bearer') ? 'bearer' : false),
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/api/stream') {
      return rejectUpgrade(socket, 404, 'Not Found', { error: 'not-found' });
    }
    if (auth.needsSetup) {
      return rejectUpgrade(socket, 503, 'Service Unavailable', {
        error: 'not-setup',
        text: '这台机器还没设密码，先设好再用。',
      });
    }
    // 令牌走**子协议**：`['bearer', <token>]`（手册 §2.1）
    const proto = req.headers['sec-websocket-protocol'];
    let token = null;
    if (typeof proto === 'string') {
      const parts = proto.split(',').map((s) => s.trim());
      const i = parts.indexOf('bearer');
      if (i !== -1) token = parts[i + 1] ?? null;
    }
    const claim = token ? auth.verify(token) : null;
    if (!claim) {
      // ⚠️ 在**握手阶段**拒，不要"先连上再关"
      return rejectUpgrade(socket, 401, 'Unauthorized', { error: 'unauthorized' });
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      onStream(ws, url, claim);
    });
  });

  function onStream(ws, url, claim) {
    const rawSince = url.searchParams.get('sinceSeq');
    const sinceSeq = rawSince === null ? 0 : Number.parseInt(rawSince, 10);
    const devMode = url.searchParams.get('dev') === '1';
    // ★ **按连接**解一次档（契约 §二·2）；不认识的当默认档，不拒连接
    const level = parseLevel(url.searchParams);

    // 补发（手册 §2.2，决策 P-h）
    let plan;
    try {
      plan = planResume({ events: store.readAll(timeline.id), sinceSeq });
    } catch {
      ws.close(1008, 'bad-sinceSeq');
      return;
    }
    if (plan.reset) {
      // 客户端的号跑到我们前面去了 ⇒ 明确要它从头来，
      // **不能**什么都不发（那会把它永远停在一个不存在的世界上）
      ws.send(JSON.stringify({ type: 'client/reset', reason: 'cursor-ahead' }));
    } else {
      for (const frame of plan.frames) {
        ws.send(JSON.stringify(markCatchUp(frame, plan.catchUp)));
      }
    }
    ws.send(JSON.stringify({
      type: 'client/hello',
      serverNow: now(),
      maxSeq: plan.maxSeq,
      catchUpRendering: CATCHUP_RENDER,
    }));

    // 实时
    const off = timeline.subscribe((event) => {
      // 这一条连接收不收它（四档 + `dev` 那条附加通道）—— 见 `levelAllows`
      if (!levelAllows(event, { level, dev: devMode })) return;
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    });

    const beat = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'client/ping', at: now() }));
    }, 25_000);
    beat.unref?.();

    ws.on('close', () => {
      off();
      clearInterval(beat);
      log(`[stream] 断开（${claim.sub}）`);
    });
    ws.on('error', (err) => log(`[stream] 出错：${err?.message ?? err}`));
  }

  // ── 工具 ────────────────────────────────────────────────

  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  }

  function readJson(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('body 太大'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  return {
    server,
    webRoot,
    /** ⚠️ 只在 127.0.0.1 上听。对外由 VPS 那条隧道走（stcp 不占公网端口）。 */
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    close() {
      // ⚠️ `server.close()` 会等所有连接自己断开。WS 是长连接，
      //    所以必须先**主动**结束它们——否则关闭会一直挂着
      //    （测试里表现为超时，生产里表现为"停不下来"）。
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          /* 已经断了 */
        }
      }
      // keep-alive 的空闲连接也会让 close() 等下去
      server.closeIdleConnections?.();
      return new Promise((resolve) => {
        wss.close(() => {
          server.close(() => resolve());
          server.closeIdleConnections?.();
        });
      });
    },
  };
}
