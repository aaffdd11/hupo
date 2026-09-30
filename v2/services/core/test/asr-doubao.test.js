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
  decodeServerFrame,
  doubaoConfigFromEnv,
  doubaoHeaders,
  encodeAudioFrame,
  encodeFullClientRequest,
  newConnectId,
} from '../src/asr-doubao.js';

/** 造一帧"上游回话"（照协议）。 */
function serverFrame({ text = '', definite = null, index = 0, gzip = true, errCode = null, message = '' } = {}) {
  if (errCode !== null) {
    const body = Buffer.from(message, 'utf8');
    const head = Buffer.alloc(8);
    head.writeUInt32BE(errCode, 0);
    head.writeUInt32BE(body.length, 4);
    return Buffer.concat([Buffer.from([0x11, 0xf0, 0x00, 0x00]), head, body]);
  }
  const utts = [];
  for (let i = 0; i < index; i += 1) utts.push({ text: `s${i}`, definite: true });
  if (definite !== null) utts.push({ text: definite, definite: true });
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
  // 第 2 句 ⇒ 段号 1（`utterances` 是累积的）
  const f2 = decodeServerFrame(serverFrame({ text: '今天天气挺好', definite: '挺好', index: 1 }));
  assert.equal(f2.definite, '挺好');
  assert.equal(f2.index, 1);
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
