// **语音那条路（`/api/asr`）的验收** —— 真 HTTP + 真 WebSocket + **一个假的上游**。
//
// 🔴 为什么用一个"假腾讯云"而不是等钥匙：钥匙是主人的（`AGENTS.md` §六 第 1 条），
//    而"等钥匙到了再说"等于这一批**没有判据**。⇒ 上游那一段被换成一个**桩**
//    （`HUPO_ASR_URL` 指向它），于是**除了腾讯云自己那台**之外，
//    每一环都是真的：真浏览器来的二进制、真签名调用点、真映射、真收尾。
//    剩下"腾讯收不收我们的签名"那一条，由 `scripts/check-asr-tencent.mjs`
//    （主人自己跑）钉住 —— 两半合起来才是完整的一条路。
//
// 判据（每条都打在**真那一侧**）：
//   ① 签名是纯的（同输入同签名）、`voice_id` 缺了要**明着抛**（不许偷偷生成）
//   ② 路径：`/api/asr` 之外的升级仍然 404（别顺手把别的口放进来）
//   ③ 没令牌 ⇒ **握手阶段** 401（不是"先连上再关"）
//   ④ 没配钥匙 ⇒ 接上，但如实回 `asr/unavailable`（**不装开麦**）
//   ⑤ 配好了 ⇒ ready → 音频**一个字节不改**地过去 → partial/final/end 映射对
//   ⑥ 用户按"结束" ⇒ 上游收到 `{"type":"end"}`（收尾靠它，不是靠我们猜）
//   ⑦ 上游回错（鉴权/没开通）⇒ 原话转达，**回话里不许出现密钥/签名 URL**
//   ⑧ 超时收手 ⇒ `asr/capped`（内测版一条连接最多 1 分钟）

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
import { DEFAULT_ASR_ENGINE, signAsrUrl } from '../src/asr-sign.js';

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
 * **假腾讯云**：同一套线上协议的形状（先握手 `code`，再 `result.slice_type`，最后 `final:1`）。
 * @param {object} o
 * @param {number} [o.code] 握手回的 code（非 0 = 服务端不收）
 * @param {Array<{slice:number,text:string}>} [o.scripts] 收到多少字节之后吐哪一句
 */
async function stubUpstream({ code = 0, scripts = [] } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const state = {
    bytes: 0,
    frames: 0,
    texts: [],
    gotEnd: false,
    ws: null,
    /** 每收到这么多字节就吐一句（`slice` 0=半句 1=一句话 2=整段） */
    scripts: [...scripts],
  };
  wss.on('connection', (ws) => {
    state.ws = ws;
    ws.send(JSON.stringify({ code, message: code === 0 ? 'success' : 'auth failed: secretid 不对', voice_id: 'v', message_id: 'm' }));
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        state.bytes += data.length;
        state.frames += 1;
        while (state.scripts.length && state.bytes >= state.scripts[0].at) {
          const s = state.scripts.shift();
          ws.send(JSON.stringify({
            code: 0,
            result: { slice_type: s.slice, voice_text_str: s.text, index: s.index ?? 0 },
            final: 0,
          }));
        }
        return;
      }
      state.texts.push(String(data));
      if (String(data).includes('"end"')) {
        state.gotEnd = true;
        ws.send(JSON.stringify({ code: 0, result: { slice_type: 2, voice_text_str: '今天天气怎么样' }, final: 1 }));
      }
    });
  });
  state.url = `ws://127.0.0.1:${wss.address().port}/`;
  state.wss = wss;
  // ⚠️ **先 terminate 再关**：`wss.close()` 会等客户端自己走，
  //    而中继那条上游要等到"到点收手"（55 秒）才会断 ——
  //    这条测试第一次跑就是这样卡了 55 秒（同 `server.close()` 那个坑）。
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

test('★ 签名是纯的：同输入 ⇒ 同签名（`voice_id` 由调用方给）', () => {
  const o = {
    appid: '1250000000',
    secretId: 'AKIDexample',
    secretKey: 'sk-example',
    params: { voice_id: '11111111-2222-3333-4444-555555555555' },
    now: 1_700_000_000_000,
  };
  const a = signAsrUrl(o);
  const b = signAsrUrl(o);
  assert.equal(a.signature, b.signature);
  // 原文不含协议头、不含 signature，参数按字典序
  assert.ok(!a.origin.startsWith('wss://'));
  assert.ok(!a.origin.includes('signature'));
  assert.ok(a.origin.indexOf('engine_model_type=') < a.origin.indexOf('expired='));
  // URL 里 signature 是 urlencode 过的
  assert.ok(a.url.startsWith(`wss://${a.origin}&signature=`));
  // 默认引擎就是文档里那个
  assert.ok(a.origin.includes(`engine_model_type=${DEFAULT_ASR_ENGINE}`));
});

test('★ 少了 `voice_id` ⇒ 明着抛（不许偷偷生成：那会让它不纯）', () => {
  assert.throws(
    () => signAsrUrl({ appid: '1', secretId: 's', secretKey: 'k', params: {} }),
    /voice_id/,
  );
});

test('换了密钥 / 换了引擎 ⇒ 签名就变（金丝雀：参数真的进了原文）', () => {
  const base = {
    appid: '1250000000',
    secretId: 'AKIDexample',
    secretKey: 'sk-example',
    params: { voice_id: 'v-1' },
    now: 1_700_000_000_000,
  };
  const a = signAsrUrl(base);
  assert.notEqual(a.signature, signAsrUrl({ ...base, secretKey: 'sk-other' }).signature);
  assert.notEqual(a.signature, signAsrUrl({ ...base, engine: '16k_zh' }).signature);
  assert.notEqual(a.signature, signAsrUrl({ ...base, params: { voice_id: 'v-2' } }).signature);
});

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
  // **一个字节不多、一个字节不少**
  assert.equal(stub.bytes, 6400);
  assert.equal(stub.frames, 2);

  // 用户按"结束" ⇒ 上游收到 `{"type":"end"}`
  c.ws.send(JSON.stringify({ type: 'asr/stop' }));
  const end = await waitFor(c.events, (e) => e.type === 'asr/end');
  assert.equal(end.text, '今天天气怎么样');
  assert.equal(stub.gotEnd, true);
  assert.ok(stub.texts.some((t) => t.includes('"end"')));
  await stub.close();
  await s.close();
});

test('★ `asr/ready` 要等上游**握手真的回了 code 0**（不是连上就算）', async () => {
  const stub = await stubUpstream();
  const s = await boot({ asrConfig: asrConfigFromEnv({ HUPO_ASR_URL: stub.url }) });
  const c = await connectAsr(s.wsBase, s.token);
  c.ws.send(JSON.stringify({ type: 'asr/start' }));
  const ready = await waitFor(c.events, (e) => e.type === 'asr/ready');
  assert.equal(ready.engine, DEFAULT_ASR_ENGINE);
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

test('★ 上游说"鉴权不过" ⇒ 原话转达，而回话里**没有密钥**', async () => {
  const stub = await stubUpstream({ code: 4001 });
  const s = await boot({
    asrConfig: asrConfigFromEnv({
      HUPO_ASR_URL: stub.url,
      TENCENT_SECRET_KEY: 'sk-must-not-leak',
      TENCENT_SECRET_ID: 'AKIDmustnotleak',
    }),
  });
  const c = await connectAsr(s.wsBase, s.token);
  c.ws.send(JSON.stringify({ type: 'asr/start' }));
  const err = await waitFor(c.events, (e) => e.type === 'asr/error');
  assert.equal(err.reason, 'engine');
  assert.equal(err.code, 4001);
  assert.ok(err.message.includes('auth failed'));
  const all = c.raw.join('\n');
  assert.ok(!all.includes('sk-must-not-leak'));
  assert.ok(!all.includes('AKIDmustnotleak'));
  assert.ok(!all.includes('signature='));
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

test('默认上限比腾讯那个 1 分钟**小**（提前收手，不让它半路被掐）', () => {
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
