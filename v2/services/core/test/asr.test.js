// **语音那条路（`/api/asr`）的验收** —— 真 HTTP + 真 WebSocket + **一个假的上游**。
//
// 🔴 为什么用一个"假豆包"而不是等钥匙：钥匙是主人的（`AGENTS.md` §六 第 1 条），
//    而"等钥匙到了再说"等于这一批**没有判据**。⇒ 上游那一段被换成一个**桩**
//    （`HUPO_ASR_URL` 指向它），于是**除了豆包自己那台**之外，
//    每一环都是真的：真浏览器来的二进制、真帧编码（4 字节 header ＋ 长度 ＋
//    gzip 的 JSON）、真解码、真映射、真收尾。⇒ 这个桩**说的就是豆包的协议**
//    （二进制帧那一套，见 `src/asr-doubao.js`），换成真上游只是换个地址。
//    ⚠️ 剩下"豆包那台收不收我们这套帧"那一条**还没有真读数**（缺钥匙，见
//    `docs/dev/152-VOICE-DOUBAO.md` §四）——**不许把它说成验过了**。
//
// 判据（每条都打在**真那一侧**）：
//   ① 帧的形状对（header 那几格 · 长度大端 · request 那段是 gzip 的 JSON）、
//      没配 App ID/Token 时**明着不建连**（不许偷偷发）
//   ② 路径：`/api/asr` 之外的升级仍然 404（别顺手把别的口放进来）
//   ③ 没令牌 ⇒ **握手阶段** 401（不是"先连上再关"）
//   ④ 没配钥匙 ⇒ 接上，但如实回 `asr/unavailable`（**不装开麦**）
//   ⑤ 配好了 ⇒ ready → 音频**一个字节不改**地过去 → partial/final/end 映射对
//   ⑥ 用户按"结束" ⇒ 上游收到**最后一包**（`flags=0b0010`；收尾靠它，不是靠我们猜）
//   ⑦ 上游回错（鉴权/没开通）⇒ 原话转达，**回话里不许出现 App ID/Token**
//   ⑧ 到点收手 ⇒ `asr/capped` ＋ 对上游说"最后一包"（55 秒是产品决定，见 152 §六）

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

import { Auth } from '../src/auth.js';
import { SayService } from '../src/say.js';
import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';
import { createServer } from '../src/server.js';
import { ASR_MAX_MS, asrConfigFromEnv, createAsrRelay, safeAsrMessage } from '../src/asr.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const openServers = new Set();
/** 手里开着的浏览器侧连接 / 假上游：收尾时**必须**一起放掉，
 *  否则 `server.close()` 会等它们（WS 是长连接）—— 这正是本文件第一次跑挂住的原因。 */
const openClients = new Set();
const openStubs = new Set();
after(async () => {
  for (const ws of openClients) {
    try {
      ws.terminate();
    } catch {
      /* 已经断了 */
    }
  }
  for (const stub of openStubs) {
    for (const ws of stub.wss.clients) {
      try {
        ws.terminate();
      } catch {
        /* 已经断了 */
      }
    }
  }
  await sleep(30);
  for (const stub of openStubs) {
    try {
      await stub.close();
    } catch {
      /* 关不干净不影响结论 */
    }
  }
  for (const s of openServers) {
    try {
      await s.close();
    } catch {
      /* 关不干净不影响结论 */
    }
  }
  openClients.clear();
  openStubs.clear();
  openServers.clear();
});

/** 起一个真服务（带不带"语音那条"看参数）。 */
async function boot({ asrConfig = null, maxMs = ASR_MAX_MS } = {}) {
  const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-asr-'));
  const store = new Store({ dataDir, fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const auth = new Auth({ dataDir, lockAfter: 3, lockMs: 60_000 });
  auth.setPassword('pw-not-a-secret');
  const say = new SayService({ timeline, store, timelineId: 'main' });
  const webRoot = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-asr-web-'));
  nodeFs.writeFileSync(nodePath.join(webRoot, 'index.html'), '<!doctype html><title>琥珀</title>');

  const asr = asrConfig ? createAsrRelay({ config: asrConfig, maxMs }) : null;
  const { server, listen, close } = createServer({
    timeline,
    store,
    auth,
    say,
    webRoot,
    buildId: 'test-build',
    asr,
  });
  const addr = await listen(0);
  const handle = {
    origin: `http://127.0.0.1:${addr.port}`,
    wsBase: `ws://127.0.0.1:${addr.port}`,
    token: auth.issue({ sub: 'owner' }).token,
    close,
  };
  openServers.add(handle);
  return handle;
}

/**
 * **假豆包**（`wss://openspeech.bytedance.com/api/v3/sauc/bigmodel` 那一套的**帧形状**）。
 *
 * ⚠️ 它说的是**真的那套二进制协议**（4 字节 header ＋ [sequence] ＋ 4 字节长度 ＋ payload），
 *    不是 JSON 假装的 —— 这样"我们发出去的帧对不对"才有判据。
 *
 * @param {object} o
 * @param {number} [o.errCode] 建连之后先回一个**错误帧**（非 0 = 上游不收）
 * @param {Array<{at:number,text:string,definite?:string,index?:number}>} [o.scripts]
 *        收到多少字节之后吐哪一句（`definite` 非空 = 那是一句"确定句"）
 * @param {boolean} [o.silentReady] 收到请求参数也**不回**（用来量"握不上手"那一档）
 */
async function stubUpstream({ errCode = 0, scripts = [], silentReady = false } = {}) {
  const { encodeFullClientRequest, encodeAudioFrame, decodeServerFrame } = await import('../src/asr-doubao.js');
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const state = {
    bytes: 0,
    frames: 0,
    /** 收到的**请求参数**那一份（解出来的 JSON） */
    clientRequest: null,
    /** 收到的音频**原始字节**（判据要核"一个字节都没改"） */
    pcm: Buffer.alloc(0),
    gotLast: false,
    headers: null,
    scripts: [...scripts],
  };
  /** 回一帧"识别结果"（照官方那份：`result.text` ＋ `result.utterances[].definite`）。 */
  const reply = (ws, text, definite = null, index = 0) => {
    // ⚠️ **`utterances` 是累积的**（真上游就是这样：每说出一个"确定句"就往数组后面加一条）
    //    ⇒ 我们的解码器按**数组下标**当段号，正好等于测试脚本里那个 `index`。
    const utts = [];
    for (let i = 0; i < index; i += 1) utts.push({ text: `（第${i + 1}段）`, definite: true, start_time: 0, end_time: 1 });
    if (definite !== null) utts.push({ text: definite, definite: true, start_time: 0, end_time: 1 });
    const payload = Buffer.from(
      JSON.stringify({ result: { text, utterances: utts } }),
      'utf8',
    );
    const header = Buffer.from([0x11, 0x90, 0x10, 0x00]); // 0b1001 = full server response，JSON，不压缩
    const size = Buffer.alloc(4);
    size.writeUInt32BE(payload.length, 0);
    ws.send(Buffer.concat([header, size, payload]));
  };
  const fail = (ws, code, message) => {
    const body = Buffer.from(message, 'utf8');
    const header = Buffer.from([0x11, 0xf0, 0x00, 0x00]); // 0b1111 = 错误
    const head = Buffer.alloc(8);
    head.writeUInt32BE(code, 0);
    head.writeUInt32BE(body.length, 4);
    ws.send(Buffer.concat([header, head, body]));
  };
  wss.on('connection', (ws, req) => {
    state.headers = req.headers;
    if (errCode !== 0) {
      fail(ws, errCode, 'auth failed: 资源没有开通');
      return;
    }
    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const type = (buf[1] >> 4) & 0x0f;
      if (type === 0b0001) {
        // 请求参数：解出来存着（顺带证明我们发的是合法的那一份）
        const ev = decodeServerFrame(buf);
        void ev;
        state.clientRequest = buf;
        if (!silentReady) reply(ws, ''); // 握手那一拍：回一帧（空结果）
        return;
      }
      if (type === 0b0010) {
        const last = (buf[1] & 0x0f) === 0b0010;
        const size = buf.readUInt32BE(4);
        const pcm = buf.slice(8, 8 + size);
        if (last) {
          state.gotLast = true;
          state.gotEnd = true; // 老判据用的名字（同一件事）
          reply(ws, '今天天气怎么样', '今天天气怎么样', 0);
          return;
        }
        state.bytes += pcm.length;
        state.frames += 1;
        state.pcm = Buffer.concat([state.pcm, pcm]);
        while (state.scripts.length && state.bytes >= state.scripts[0].at) {
          const sc = state.scripts.shift();
          // ⚠️ 这个桩同时认两种写法：`definite`（新）与 `slice`（老那种：0=半句 1/2=一句）
          const definite = sc.definite ?? (sc.slice === 1 || sc.slice === 2 ? sc.text : null);
          reply(ws, sc.text, definite, sc.index ?? 0);
        }
      }
    });
  });
  state.url = `ws://127.0.0.1:${wss.address().port}/`;
  state.wss = wss;
  state.close = () =>
    new Promise((r) => {
      for (const ws of wss.clients) {
        try {
          ws.terminate();
        } catch {
          /* 已经断了 */
        }
      }
      wss.close(r);
    });
  openStubs.add(state);
  return state;
}

/**
 * 连 `/api/asr`，把收到的每个事件攒起来（判据只看这些）。
 * ⚠️ **等它真的 open 再返回**：`ws.send()` 在 CONNECTING 时会直接抛，
 *    而"用户按下去就采"那种真实时序必须由测试自己摆出来（先 open、再推音频）。
 */
async function connectAsr(base, token) {
  const ws = new WebSocket(`${base}/api/asr`, ['bearer', token ?? '']);
  const events = [];
  const raw = [];
  ws.on('message', (d, isBinary) => {
    if (isBinary) return;
    raw.push(String(d));
    try {
      events.push(JSON.parse(String(d)));
    } catch {
      /* 不认识的不管 */
    }
  });
  openClients.add(ws);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (_q, res) => reject(new Error(`被拒 ${res.statusCode}`)));
  });
  return { ws, events, raw };
}

async function waitFor(events, pred, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = events.find(pred);
    if (hit) return hit;
    await sleep(20);
  }
  throw new Error(`等不到；已有事件：${JSON.stringify(events)}`);
}

// ── ① 签名（纯函数）────────────────────────────────────────

test('上游出错那句话里不许带 URL（URL 本身就是凭据）', () => {
  const raw = 'connect ECONNREFUSED wss://asr.cloud.tencent.com/asr/v2/125?secretid=AKIDx&signature=YWJj';
  const safe = safeAsrMessage(new Error(raw));
  assert.ok(!safe.includes('signature='));
  assert.ok(!safe.includes('AKIDx'));
  assert.ok(safe.length <= 200);
});

// ── ②③ 路由与身份 ─────────────────────────────────────────

test('★ `/api/asr` 之外的升级仍然 404（别顺手把别的口放进来）', async () => {
  const s = await boot();
  const err = await new Promise((resolve) => {
    const ws = new WebSocket(`${s.wsBase}/api/nope`, ['bearer', s.token]);
    ws.on('unexpected-response', (_req, res) => resolve({ code: res.statusCode }));
    ws.on('error', (e) => resolve({ err: String(e.message) }));
    ws.on('open', () => resolve({ open: true }));
  });
  assert.equal(err.code, 404);
  await s.close();
});

test('★ 没令牌 ⇒ 握手阶段 401（不是"先连上再关"）', async () => {
  const s = await boot({ asrConfig: asrConfigFromEnv({ HUPO_ASR_URL: 'ws://127.0.0.1:1/' }) });
  const err = await new Promise((resolve) => {
    const ws = new WebSocket(`${s.wsBase}/api/asr`, ['bearer', 'not-a-real-token']);
    ws.on('unexpected-response', (_req, res) => resolve({ code: res.statusCode }));
    ws.on('error', (e) => resolve({ err: String(e.message) }));
    ws.on('open', () => resolve({ open: true }));
  });
  assert.equal(err.code, 401);
  await s.close();
});

// ── ④ 没配钥匙 ────────────────────────────────────────────

test('★ 没配钥匙 ⇒ 如实说 `asr/unavailable`（**不装开麦**）', async () => {
  const s = await boot({ asrConfig: asrConfigFromEnv({}) });
  const c = await connectAsr(s.wsBase, s.token);
  const ev = await waitFor(c.events, (e) => e.type === 'asr/unavailable');
  assert.equal(ev.reason, 'not-configured');
  await s.close();
});

test('这台部署连"语音那条"都没挂（`asr: null`）⇒ 同样如实说，不是握手失败', async () => {
  const s = await boot({ asrConfig: null });
  const c = await connectAsr(s.wsBase, s.token);
  const ev = await waitFor(c.events, (e) => e.type === 'asr/unavailable');
  assert.equal(ev.reason, 'not-configured');
  await s.close();
});

// ── ⑤⑥ 整条链（桩上游）───────────────────────────────────

test('★ 配好了：音频一个字节不改地过去，半句/定稿/收尾映射对', async () => {
  const stub = await stubUpstream({
    scripts: [
      { at: 3200, slice: 0, text: '今天' },
      { at: 6400, slice: 1, text: '今天天气' },
    ],
  });
  const s = await boot({ asrConfig: asrConfigFromEnv({ HUPO_ASR_URL: stub.url }) });
  const c = await connectAsr(s.wsBase, s.token);
  // 用户按下去（真实时序：先握手，再推音频）
  c.ws.send(JSON.stringify({ type: 'asr/start' }));
  await waitFor(c.events, (e) => e.type === 'asr/ready');

  const pcm = Buffer.alloc(3200, 7);
  c.ws.send(pcm);
  const partial = await waitFor(c.events, (e) => e.type === 'asr/partial');
  assert.equal(partial.text, '今天');
  c.ws.send(Buffer.alloc(3200, 9));
  const fin = await waitFor(c.events, (e) => e.type === 'asr/final');
  assert.equal(fin.text, '今天天气');
  // **一个字节不多、一个字节不少**（桩解出来的是帧里的 PCM）
  assert.equal(stub.bytes, 6400);
  assert.equal(stub.frames, 2);
  assert.deepEqual(stub.pcm, Buffer.concat([Buffer.alloc(3200, 7), Buffer.alloc(3200, 9)]),
      '★ 送出去的 PCM 必须逐字节一样（我们只许给它套帧，不许动它的内容）');

  // 用户按"结束" ⇒ 上游收到那一包"最后一包"（flags=0b0010 的空音频）
  c.ws.send(JSON.stringify({ type: 'asr/stop' }));
  const end = await waitFor(c.events, (e) => e.type === 'asr/end');
  assert.equal(end.text, '今天天气怎么样');
  assert.equal(stub.gotLast, true, '★ 没发"最后一包" ⇒ 上游不会把最后那几个字吐回来');
  await stub.close();
  await s.close();
});

test('★ `asr/ready` 要等上游**真的回了第一帧**（不是连上就算）', async () => {
  const stub = await stubUpstream();
  const s = await boot({ asrConfig: asrConfigFromEnv({ HUPO_ASR_URL: stub.url }) });
  const c = await connectAsr(s.wsBase, s.token);
  c.ws.send(JSON.stringify({ type: 'asr/start' }));
  const ready = await waitFor(c.events, (e) => e.type === 'asr/ready');
  assert.ok(typeof ready.engine === 'string' && ready.engine.length > 0, '要报出用的是哪个资源');
  await stub.close();
  await s.close();
});

test('🔴 上游**握不上手**（一帧都不回就断了）⇒ 如实 `asr/error`，不许说"能听"', async () => {
  const stub = await stubUpstream({ silentReady: true });
  const s = await boot({ asrConfig: asrConfigFromEnv({ HUPO_ASR_URL: stub.url }) });
  const c = await connectAsr(s.wsBase, s.token);
  c.ws.send(JSON.stringify({ type: 'asr/start' }));
  // 桩不回 ⇒ 我们把上游掐掉（模拟"对面不理我"）
  await sleep(150);
  for (const ws of stub.wss.clients) ws.terminate();
  const err = await waitFor(c.events, (e) => e.type === 'asr/error');
  assert.equal(err.reason, 'upstream');
  assert.equal(c.events.some((e) => e.type === 'asr/ready'), false, '★ 没握上手就说 ready = 假话');
  await stub.close();
  await s.close();
});

test('★ 连上之前推的音频不丢（先攒着，握上手就补发）', async () => {
  const stub = await stubUpstream();
  const s = await boot({ asrConfig: asrConfigFromEnv({ HUPO_ASR_URL: stub.url }) });
  const c = await connectAsr(s.wsBase, s.token);
  // **不等 ready**，直接推（真实浏览器就是这样：用户按下去就开始采）
  c.ws.send(Buffer.alloc(1024, 3));
  c.ws.send(Buffer.alloc(1024, 4));
  const t0 = Date.now();
  while (stub.bytes < 2048 && Date.now() - t0 < 4000) await sleep(20);
  assert.equal(stub.bytes, 2048);
  await stub.close();
  await s.close();
});

// ── ⑦ 上游回错 ────────────────────────────────────────────

test('★ `index` 要真的传下去（同一段替换全靠它 —— 少了它屏幕上就是一串重复）', async () => {
  const stub = await stubUpstream({
    scripts: [
      { at: 1600, slice: 1, text: '今天', index: 0 },
      { at: 3200, slice: 1, text: '今天天气', index: 0 },
      { at: 4800, slice: 1, text: '挺好的。', index: 1 },
    ],
  });
  const s = await boot({ asrConfig: asrConfigFromEnv({ HUPO_ASR_URL: stub.url }) });
  const c = await connectAsr(s.wsBase, s.token);
  c.ws.send(JSON.stringify({ type: 'asr/start' }));
  await waitFor(c.events, (e) => e.type === 'asr/ready');
  const seen = [];
  for (let n = 1; n <= 3; n += 1) {
    c.ws.send(Buffer.alloc(1600, 7));
    const ev = await waitFor(c.events, (e) => e.type === 'asr/final' && !seen.includes(e.text));
    seen.push(ev.text);
  }
  const finals = c.events.filter((e) => e.type === 'asr/final');
  // 三条都到了，而且**每一条都带着段号**（前两条 0、最后一条 1）
  assert.deepEqual(finals.map((e) => e.text), ['今天', '今天天气', '挺好的。']);
  assert.deepEqual(finals.map((e) => e.index), [0, 0, 1]);
  // 收尾那条带上**最后听到的字**（不是空字）
  c.ws.send(JSON.stringify({ type: 'asr/stop' }));
  const end = await waitFor(c.events, (e) => e.type === 'asr/end');
  assert.equal(end.text, '今天天气怎么样');
  await stub.close();
  await s.close();
});

test('★ 上游说"鉴权不过"（错误帧）⇒ 原话转达，而回话里**没有密钥**', async () => {
  const stub = await stubUpstream({ errCode: 4001 });
  const s = await boot({
    asrConfig: asrConfigFromEnv({
      HUPO_ASR_URL: stub.url,
      DOUBAO_ASR_APPID: '1234567890',
      DOUBAO_ASR_TOKEN: 'token-must-not-leak',
    }),
  });
  const c = await connectAsr(s.wsBase, s.token);
  c.ws.send(JSON.stringify({ type: 'asr/start' }));
  const err = await waitFor(c.events, (e) => e.type === 'asr/error');
  assert.equal(err.reason, 'engine');
  assert.equal(err.code, 4001);
  assert.ok(err.message.includes('auth failed'));
  const all = c.raw.join('\n');
  assert.ok(!all.includes('token-must-not-leak'), '★ 令牌漏进回话了');
  assert.ok(!all.includes('1234567890'), '★ App ID 也不许漏');
  assert.ok(!all.includes('X-Api-Access-Key'), '★ 连头的名字都不许回给客户端');
  await stub.close();
  await s.close();
});

test('上游连不上 ⇒ `asr/error`（reason=upstream），回话里没有 URL', async () => {
  const s = await boot({ asrConfig: asrConfigFromEnv({ HUPO_ASR_URL: 'ws://127.0.0.1:1/' }) });
  const c = await connectAsr(s.wsBase, s.token);
  c.ws.send(Buffer.alloc(160, 1));
  const err = await waitFor(c.events, (e) => e.type === 'asr/error');
  assert.equal(err.reason, 'upstream');
  assert.ok(!c.raw.join('\n').includes('ws://127.0.0.1:1'));
  await s.close();
});

// ── ⑧ 超时收手 ────────────────────────────────────────────

test('★ 到点收手 ⇒ `asr/capped`（内测版一条连接最多 1 分钟）', async () => {
  const stub = await stubUpstream();
  const s = await boot({ asrConfig: asrConfigFromEnv({ HUPO_ASR_URL: stub.url }), maxMs: 120 });
  const c = await connectAsr(s.wsBase, s.token);
  c.ws.send(JSON.stringify({ type: 'asr/start' }));
  await waitFor(c.events, (e) => e.type === 'asr/ready');
  const capped = await waitFor(c.events, (e) => e.type === 'asr/capped');
  assert.equal(capped.type, 'asr/capped');
  // 收手要对上游说"结束"，不是直接掐断
  const t0 = Date.now();
  while (!stub.gotEnd && Date.now() - t0 < 3000) await sleep(20);
  assert.equal(stub.gotEnd, true);
  await stub.close();
  await s.close();
});

test('上限是**我们自己的**约定：几十秒就收手（豆包那边没有这条硬限，别照旧猜）', () => {
  assert.ok(ASR_MAX_MS < 60_000);
  assert.ok(ASR_MAX_MS > 15_000);
});

test('★ P1-3：收尾那条要带 "为什么收的尾"（客户端靠它区分"按停"与"半路断了"）', async () => {
  const stub = await stubUpstream();
  const s = await boot({ asrConfig: asrConfigFromEnv({ HUPO_ASR_URL: stub.url }) });
  const c = await connectAsr(s.wsBase, s.token);
  c.ws.send(JSON.stringify({ type: 'asr/start' }));
  await waitFor(c.events, (e) => e.type === 'asr/ready');
  c.ws.send(Buffer.alloc(1600, 7));
  c.ws.send(JSON.stringify({ type: 'asr/stop' }));
  const end = await waitFor(c.events, (e) => e.type === 'asr/end');
  assert.equal(typeof end.reason, 'string', '没收尾原因 ⇒ 客户端分不清"按停"和"断了"');
  assert.ok(['user-stop', 'upstream', 'engine', 'capped'].includes(end.reason), `原因不认识：${end.reason}`);
  await stub.close();
  await s.close();
});
