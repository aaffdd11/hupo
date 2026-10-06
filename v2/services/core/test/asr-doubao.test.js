// **豆包大模型流式语音识别：帧那一层**（主人 2026-10-01：*「语音识别，用豆包」*）。
//
// ── 这一份钉什么（都是纯函数 / 真字节，不联网）──────────────
//   ① 🔴 **我们发出去的帧是那一套二进制协议**（4 字节 header ＋ [sequence] ＋ 长度 ＋ payload）：
//      version/header size、消息类型、JSON ＋ gzip 那几格都对得上；
//   ② 🔴 **音频是原样套帧**（PCM 一个字节都不许动；"最后一包"用 flags=0b0010）；
//   ③ 🔴 **上游的回帧解得出**（`result.text` 半句 / `utterances[].definite` 定稿 /
//      gzip 与不压缩两种 / **错误帧两种形状都认**）；
//   ④ 🔴 **凭据只从环境变量来，而且名字是豆包那一套**（`DOUBAO_ASR_APPID` / `DOUBAO_ASR_TOKEN`）；
//      **建连头里**那三样（App-Key / Access-Key / Resource-Id / Connect-Id）一个都不少；
//   ⑤ **认不出来的回帧如实说认不出**（不许当成"识别结果"）。

import assert from 'node:assert/strict';
import * as nodeZlib from 'node:zlib';
import test from 'node:test';

import {
  AUDIO_CHUNK_BYTES,
  DEFAULT_MODEL_NAME,
  DEFAULT_RESOURCE_ID,
  DOUBAO_ASR_URL,
  createDoubaoUpstream,
  createSegmentTracker,
  decodeServerFrame,
  FLUSH_QUIET_MS,
  doubaoConfigFromEnv,
  doubaoHeaders,
  encodeAudioFrame,
  encodeFullClientRequest,
  newConnectId,
} from '../src/asr-doubao.js';

/** 造一帧"上游回话"（照协议）。`start` = 当前这一句的 `start_time`（认"换句了"靠它）。 */
function serverFrame({ text = '', definite = null, index = 0, start = 0, gzip = true, errCode = null, message = '' } = {}) {
  if (errCode !== null) {
    const body = Buffer.from(message, 'utf8');
    const head = Buffer.alloc(8);
    head.writeUInt32BE(errCode, 0);
    head.writeUInt32BE(body.length, 4);
    return Buffer.concat([Buffer.from([0x11, 0xf0, 0x00, 0x00]), head, body]);
  }
  const utts = [];
  for (let i = 0; i < index; i += 1) utts.push({ text: `s${i}`, definite: true });
  if (definite !== null) utts.push({ text: definite, definite: true, start_time: start, end_time: start + 1 });
  else if (text !== '') utts.push({ text, definite: false, start_time: start, end_time: start + 1 });
  const json = Buffer.from(JSON.stringify({ result: { text, utterances: utts } }), 'utf8');
  const payload = gzip ? nodeZlib.gzipSync(json) : json;
  const header = Buffer.from([0x11, 0x90, gzip ? 0x11 : 0x10, 0x00]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, size, payload]);
}

test('D1 🔴 凭据：名字是豆包那一套；两样齐了才算配好（另一条路是"换上游"）', () => {
  assert.equal(doubaoConfigFromEnv({}).configured, false);
  assert.equal(doubaoConfigFromEnv({ DOUBAO_ASR_APPID: '1' }).configured, false, '少 token ⇒ 不算配');
  const ok = doubaoConfigFromEnv({ DOUBAO_ASR_APPID: '123', DOUBAO_ASR_TOKEN: 'tok' });
  assert.equal(ok.configured, true);
  assert.equal(ok.resource, DEFAULT_RESOURCE_ID, '资源 id 没给 ⇒ 用默认那个');
  assert.equal(ok.url, DOUBAO_ASR_URL);
  // ⚠️ 老那三个 `TENCENT_*` **不再读**（甲：完全换成豆包）
  assert.equal(doubaoConfigFromEnv({ TENCENT_APPID: '1', TENCENT_SECRET_ID: '2', TENCENT_SECRET_KEY: '3' }).configured, false);
  // 换上游那个口照旧（判据里的桩 / 自托管）
  assert.equal(doubaoConfigFromEnv({ HUPO_ASR_URL: 'ws://127.0.0.1:9/' }).configured, true);
});

test('★ D2·补 🔴 **新版鉴权**：给了 API Key ⇒ `X-Api-Key` ＋ 资源 ＋ 请求号（**不发旧版那两样**）', () => {
  // 主人 2026-10-01 贴的官方文档：实时语音识别的请求头就是这三样
  // （`X-Api-Key` 从控制台 >「API Key 管理」拿）。
  const h = doubaoHeaders({ apiKey: 'ark-api-key-x', resource: 'volc.seedasr.sauc.duration', connectId: 'uuid-1' });
  assert.equal(h['X-Api-Key'], 'ark-api-key-x');
  assert.equal(h['X-Api-Resource-Id'], 'volc.seedasr.sauc.duration');
  assert.equal(h['X-Api-Request-Id'], 'uuid-1', '新版要 X-Api-Request-Id（随机 UUID）');
  // 🔴 负向对照：新版**不许**再发旧版那两个头（发出去就是两套鉴权混着来）
  assert.equal('X-Api-App-Key' in h, false);
  assert.equal('X-Api-Access-Key' in h, false);
  assert.equal('X-Api-Connect-Id' in h, false);
  // 环境变量那一层：只有一把 API Key 也算"配了"
  assert.equal(doubaoConfigFromEnv({ DOUBAO_ASR_API_KEY: 'k' }).configured, true);
  assert.equal(doubaoConfigFromEnv({ DOUBAO_ASR_API_KEY: 'k' }).apiKey, 'k');
  // 旧版那一对**照旧认**（老账号）
  assert.equal(doubaoConfigFromEnv({ DOUBAO_ASR_APPID: 'a', DOUBAO_ASR_TOKEN: 't' }).configured, true);
  assert.equal(doubaoConfigFromEnv({ DOUBAO_ASR_API_KEY: 'k', DOUBAO_ASR_APPID: 'a', DOUBAO_ASR_TOKEN: 't' })
    .configured, true);
});

test('D2 建连头：钥匙只在这一处进请求（四样都在）', () => {
  const h = doubaoHeaders({ appid: '1234567890', token: 'tok-abc', resource: 'volc.seedasr.sauc.duration', connectId: 'cid-1' });
  assert.equal(h['X-Api-App-Key'], '1234567890');
  assert.equal(h['X-Api-Access-Key'], 'tok-abc');
  assert.equal(h['X-Api-Resource-Id'], 'volc.seedasr.sauc.duration');
  assert.equal(h['X-Api-Connect-Id'], 'cid-1');
  // 每次连接一个新 UUID（官方要求；只用来排错）
  assert.notEqual(newConnectId(), newConnectId());
  assert.match(newConnectId(), /^[0-9a-f-]{36}$/);
});

test('D3 🔴 请求参数那一帧：header 那几格对得上，正文是 gzip 过的 JSON', () => {
  const body = { user: { uid: 'hupo' }, audio: { format: 'pcm' }, request: { model_name: DEFAULT_MODEL_NAME } };
  const buf = encodeFullClientRequest(body);
  assert.equal(buf[0], 0x11, 'version 1 ＋ header size 4×1');
  assert.equal((buf[1] >> 4) & 0x0f, 0b0001, '消息类型 = full client request');
  assert.equal(buf[1] & 0x0f, 0b0000, 'flags = 没有 sequence');
  assert.equal((buf[2] >> 4) & 0x0f, 0b0001, '序列化 = JSON');
  assert.equal(buf[2] & 0x0f, 0b0001, '压缩 = gzip');
  const size = buf.readUInt32BE(4);
  assert.equal(size, buf.length - 8, '长度字段 = payload 的字节数（大端）');
  assert.deepEqual(JSON.parse(nodeZlib.gunzipSync(buf.slice(8)).toString('utf8')), body);
  // 不压缩那一档也能造（判据里要能试）
  const plain = encodeFullClientRequest(body, { gzip: false });
  assert.equal(plain[2] & 0x0f, 0b0000);
  assert.deepEqual(JSON.parse(plain.slice(8).toString('utf8')), body);
});

test('D4 🔴 音频帧：PCM 原样套进去；"最后一包"用 flags=0b0010', () => {
  const pcm = Buffer.alloc(AUDIO_CHUNK_BYTES, 7);
  const a = encodeAudioFrame(pcm);
  assert.equal((a[1] >> 4) & 0x0f, 0b0010, '消息类型 = audio only');
  assert.equal(a[1] & 0x0f, 0b0000);
  assert.equal(a.readUInt32BE(4), pcm.length);
  assert.deepEqual(a.slice(8), pcm, '★ PCM 一个字节都不许动');
  const last = encodeAudioFrame(Buffer.alloc(0), { last: true });
  assert.equal(last[1] & 0x0f, 0b0010, '★ 最后一包那一格是 0b0010');
  assert.equal(last.readUInt32BE(4), 0);
});

test('D5 🔴 回帧：半句 / 定稿 / gzip 与不压缩，都解得对', () => {
  const p = decodeServerFrame(serverFrame({ text: '今天', gzip: true }));
  assert.equal(p.kind, 'result');
  assert.equal(p.text, '今天');
  assert.equal(p.definite, null, '没有确定句 ⇒ 只是半句');
  const f = decodeServerFrame(serverFrame({ text: '今天天气', definite: '今天天气', index: 0, gzip: false }));
  assert.equal(f.text, '今天天气');
  assert.equal(f.definite, '今天天气');
  assert.equal(f.index, 0);
  // ⚠️ 这个 `index` 是**上游数组下标**（`utterances` 里最后那条确定句的位置）。
  //    🔴 **真上游那个数组里只有当前这一句**（2026-10-06 真读数）⇒ 它实际总是 0，
  //       而"段号"是**我们自己发的**（`createSegmentTracker`，见 D8）。
  const f2 = decodeServerFrame(serverFrame({ text: '今天天气挺好', definite: '挺好', index: 1 }));
  assert.equal(f2.definite, '挺好');
  assert.equal(f2.index, 1);
  // 当前那一句也照原样带出来（`start` = 上游给的 `start_time`）
  const u = decodeServerFrame(serverFrame({ text: '今天', index: 0, start: 4522 }));
  assert.deepEqual(u.utterances, [{ text: '今天', definite: false, start: 4522, end: 4523 }],
      '★ 当前这一句的 start_time 要带出来 —— 认"换句了"全靠它');
});

// ── ★ 2026-10-06：把"一段一段"接成"整段"（主人报的"前半段被砍掉"那个根）──
//
// ⚠️ 下面这些帧的形状是**照真读数抄的**（真连豆包 · 6.6 秒 · 两句 · 中间停顿）：
//    `result.text` 与 `result.utterances` **只有当前这一句** —— 说第二句时第一句
//    就不在里面了（不是累积）。⇒ 桩/判据都必须照这个形状喂。

/** 造一帧**真形状**的上游回话（只有当前这一句）。`start`/`end` = 这一句占的那段音频（毫秒）。 */
const said = (text, { definite = false, start = 0, end = start + 1 } = {}) => ({
  text,
  utterances: text === '' && !definite ? [] : [{ text, definite, start, end }],
});

test('★ D8 🔴 换句了（`start_time` 变了）⇒ 上一句攒住、段号自己往前走，整段接得起来', () => {
  const t = createSegmentTracker();
  assert.deepEqual(t.push(said('今天')), { partial: { text: '今天', index: 0 } });
  // 同一句里字是**累积的** ⇒ 还是 0 号段（替换，不是接一串重复）
  assert.deepEqual(t.push(said('今天天气')), { partial: { text: '今天天气', index: 0 } });
  // 🔴 换句（`start_time` 变了）⇒ 段号必须往前走；不然客户端按段替换会把上一句顶掉
  assert.deepEqual(t.push(said('怎么样', { start: 5000 })), { partial: { text: '怎么样', index: 1 } });
  assert.equal(t.whole(), '今天天气怎么样', '★ 整段 = 前面几段 ＋ 正在长的这一段');
  // 第二句说定了 ⇒ 定稿带的是 1 号段；整段照旧
  assert.deepEqual(t.push(said('怎么样', { definite: true, start: 5000 })),
      { partial: { text: '怎么样', index: 1 }, final: { text: '怎么样', index: 1 } });
  assert.equal(t.whole(), '今天天气怎么样');
  // 第三句 ⇒ 2 号段
  assert.equal(t.push(said('好的', { start: 9000 })).partial.index, 2);
  assert.equal(t.whole(), '今天天气怎么样好的');
});

test('★ D9 同一句又回一次：一模一样 ⇒ 当回声丢掉；又准了一点 ⇒ 替换（不许接成两遍）', () => {
  const t = createSegmentTracker();
  t.push(said('今天', { definite: true }));
  assert.deepEqual(t.push(said('今天', { definite: true })), {}, '★ 同一段重复回话 ⇒ 什么都不发');
  assert.equal(t.whole(), '今天', '★ 更不许攒成"今天今天"');
  // 上游把最后那句又准了一点（标点/字更全）⇒ 替换那一段、再发一次定稿
  assert.deepEqual(t.push(said('今天天气。', { definite: true })),
      { final: { text: '今天天气。', index: 0 } });
  assert.equal(t.whole(), '今天天气。');
});

test('★ D10 没有 `start_time` 的引擎 ⇒ 退回"共同前缀"那一条（补个句号不算换句）', () => {
  const t = createSegmentTracker();
  t.push({ text: '我们出去走走' });
  // 补了句号 ⇒ 同一句（不许当成新的一句）
  assert.deepEqual(t.push({ text: '我们出去走走吧。' }), { partial: { text: '我们出去走走吧。', index: 0 } });
  assert.equal(t.whole(), '我们出去走走吧。');
  // 完全换了内容 ⇒ 新的一句
  assert.equal(t.push({ text: '明天见' }).partial.index, 1);
  assert.equal(t.whole(), '我们出去走走吧。明天见');
});

test('★ D12 🔴 上游把**同一句重新划一遍**（起点还往前挪了）⇒ 不许接成两遍', () => {
  // 🔴 真读数原样（2026-10-06 真连豆包，跑第二遍才露出来的那一族）：
  //      #50 4522-4602 「我们」      ← 先给一小条
  //      #56 4382-5322 「我们出去」   ← 同一句的修订（起点**往前**挪了、区间叠着）
  //    ⇒ 照"起点变了就是新句"会接成「我们我们出去…」（把同一段话说两遍）。
  const t = createSegmentTracker();
  assert.deepEqual(t.push(said('我们', { start: 4522, end: 4602 })), { partial: { text: '我们', index: 0 } });
  assert.deepEqual(t.push(said('我们出去', { start: 4382, end: 5322 })),
      { partial: { text: '我们出去', index: 0 } }, '★ 叠着 ⇒ 是修订，段号不许往前推');
  assert.equal(t.whole(), '我们出去', '★ 同一个字不许攒成两遍');
  // 这一句说定；下一句从它的**终点之后**开始 ⇒ 那才是真的换句
  assert.deepEqual(t.push(said('我们出去走走吧。', { definite: true, start: 4382, end: 6282 })),
      { partial: { text: '我们出去走走吧。', index: 0 }, final: { text: '我们出去走走吧。', index: 0 } });
  assert.deepEqual(t.push(said('明天见', { start: 6282, end: 7000 })), { partial: { text: '明天见', index: 1 } });
  assert.equal(t.whole(), '我们出去走走吧。明天见');
  // 负向对照：下一句**和上一句时间叠着、字也不像** ⇒ 绝不并进上一句（那会丢一句）
  const t2 = createSegmentTracker();
  t2.push(said('我们出去走走吧。', { definite: true, start: 4382, end: 6282 }));
  assert.deepEqual(t2.push(said('明天见', { start: 6000, end: 7000 })), { partial: { text: '明天见', index: 1 } });
  assert.equal(t2.whole(), '我们出去走走吧。明天见', '★ 说定的那一句一个字都不许被顶掉');
});

test('★ D11 空字不许把已经听到的擦掉（收尾帧不带 result 那一族）', () => {
  const t = createSegmentTracker();
  t.push(said('今天天气'));
  assert.deepEqual(t.push(said('')), {}, '空帧 ⇒ 什么都不发');
  assert.equal(t.whole(), '今天天气', '★ 一个字都不许丢');
  // 空的定稿 ⇒ 把当前这句收住，不是把它擦掉
  assert.deepEqual(t.push(said('', { definite: true })),
      { partial: { text: '今天天气', index: 0 }, final: { text: '今天天气', index: 0 } });
  assert.equal(t.whole(), '今天天气');
});

test('D6 🔴 错误帧：两种形状都认得出（并且把它那句原话带出来）', () => {
  const e1 = decodeServerFrame(serverFrame({ errCode: 4003, message: 'requested resource not granted' }));
  assert.equal(e1.kind, 'error');
  assert.equal(e1.code, 4003);
  assert.match(e1.message, /resource not granted/);
  // 另一种形状：错误码 ＋ JSON 正文
  const body = Buffer.from(JSON.stringify({ message: 'auth failed' }), 'utf8');
  const head = Buffer.alloc(8);
  head.writeUInt32BE(4010, 0);
  head.writeUInt32BE(body.length, 4);
  const e2 = decodeServerFrame(Buffer.concat([Buffer.from([0x11, 0xf0, 0x00, 0x00]), head, body]));
  assert.equal(e2.code, 4010);
  assert.equal(e2.message, 'auth failed');
});

test('D7 认不出来的回帧 ⇒ 如实说认不出（不许当成识别结果）', () => {
  assert.deepEqual(decodeServerFrame(Buffer.alloc(2)), { kind: 'unknown', why: 'too-short' });
  assert.equal(decodeServerFrame(Buffer.from([0x11, 0x90, 0x10, 0x00, 0, 0, 0, 3, 1, 2, 3])).kind, 'unknown', 'JSON 解不开');
  // gzip 那一格写着压缩、但正文不是 gzip ⇒ 认不出（**不抛**）
  const bogus = Buffer.concat([Buffer.from([0x11, 0x90, 0x11, 0x00]), (() => { const s = Buffer.alloc(4); s.writeUInt32BE(3, 0); return s; })(), Buffer.from([1, 2, 3])]);
  assert.deepEqual(decodeServerFrame(bogus), { kind: 'unknown', why: 'gunzip' });
});

// ── ★ 2026-10-07：收尾那一份"整段"不许被截尾（主人："前面的话会被清除"）──────

/** 一条**假的上游 WS**（只记它被喂了什么、能手动回帧）。 */
class _FakeWS {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = _FakeWS.CONNECTING;
    this.handlers = {};
    this.sent = [];
    _FakeWS.instances.push(this);
  }
  on(ev, fn) {
    (this.handlers[ev] ??= []).push(fn);
  }
  emit(ev, ...a) {
    for (const f of this.handlers[ev] ?? []) f(...a);
  }
  send(buf) {
    this.sent.push(buf);
  }
  close() {
    this.readyState = 3;
    this.emit('close', 1000, '');
  }
  /** 造一条"连上了" */
  connect() {
    this.readyState = _FakeWS.OPEN;
    this.emit('open');
  }
  reply(buf) {
    this.emit('message', buf);
  }
}

function _upstreamForTest() {
  _FakeWS.instances = [];
  const evs = [];
  const up = createDoubaoUpstream({
    config: { configured: true, apiKey: 'k', resource: DEFAULT_RESOURCE_ID, url: DOUBAO_ASR_URL },
    WebSocketImpl: _FakeWS,
    log: () => {},
  });
  up.open({
    onReady: () => evs.push(['ready']),
    onPartial: (p) => evs.push(['partial', p.text]),
    onFinal: (p) => evs.push(['final', p.text]),
    onEnd: () => evs.push(['end']),
    onError: (e) => evs.push(['error', e?.message ?? '']),
  });
  return { up, evs, ws: _FakeWS.instances[0] };
}

test('★ D9 🔴 发完"最后一包"之后：**第一帧不算吐完**（等它安静下来才算）', async () => {
  const { up, evs, ws } = _upstreamForTest();
  ws.connect();
  ws.reply(serverFrame({})); // 握手那一拍
  assert.equal(evs.some(([k]) => k === 'ready'), true, '握上手才算 ready');
  up.audio(Buffer.alloc(AUDIO_CHUNK_BYTES, 3));
  up.finish();
  // 按停之后回来的**第一帧**——真机上它常常只是半句（实测：「我们」）
  ws.reply(serverFrame({ text: '我们', start: 0 }));
  assert.equal(evs.some(([k]) => k === 'end'), false,
    '🔴 第一帧就收尾 ⇒ 那一份"整段"被截在半句上（屏幕上原本对的字会被它顶掉）');
  // 真正的定稿那一帧到了 ⇒ 安静下来之后收一次
  ws.reply(serverFrame({ text: '我们出去走走吧。', definite: '我们出去走走吧。', start: 0 }));
  await new Promise((r) => setTimeout(r, FLUSH_QUIET_MS + 250));
  const ends = evs.filter(([k]) => k === 'end');
  assert.equal(ends.length, 1, '安静下来之后**只收一次**');
  // 🔴 负向对照：把它改回"第一帧就到站"那种写法 ⇒ 上面那条断言当场假
  assert.equal(evs.filter(([k]) => k === 'partial').length >= 2, true,
    '两帧都要出字（第一帧半句、第二帧定稿）—— 判据量的就是"第二帧有没有等到"');
});

test('★ D9·补 🔴 引擎一直吐个不停 ⇒ 到上限也必须收场（不许把用户挂在那儿）', async () => {
  const { up, evs, ws } = _upstreamForTest();
  ws.connect();
  ws.reply(serverFrame({}));
  up.finish();
  // 每 100ms 来一帧（比 `FLUSH_QUIET_MS` 密）⇒ 静音钟永远推后，只有上限那个钟能收场
  for (let i = 0; i < 8; i += 1) {
    ws.reply(serverFrame({ text: `第${i}句`, start: i * 100, index: i }));
    await new Promise((r) => setTimeout(r, 100));
    if (evs.some(([k]) => k === 'end')) break;
  }
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(evs.some(([k]) => k === 'end'), true, '上限那一个钟必须留着 —— 不然界面永远挂在"收尾中"');
});
