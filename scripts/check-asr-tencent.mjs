#!/usr/bin/env node
// **腾讯云「混元 ASR」（`hy-asr-3.0-preview`）接得上吗** —— 一条自测命令。
//
// 契约/背景：`docs/dev/69-ASR-ROUTES.md`。官方文档：
//   · 混元 ASR（内测版）  https://cloud.tencent.com/document/product/1093/135476
//   · 实时语音识别（WebSocket） https://cloud.tencent.com/document/product/1093/48982
//
// ── 为什么是"你自己跑" ────────────────────────────────────
// 它要 **AppID + SecretID + SecretKey** 三样，而**密钥不许进聊天、不许进文件、不许进日志**
// （`AGENTS.md` §六 第 1 条）。⇒ 这个脚本**只从环境变量读**，你把它设在自己那条命令里：
//
//   TENCENT_APPID=… TENCENT_SECRET_ID=… TENCENT_SECRET_KEY=… \
//     node scripts/check-asr-tencent.mjs
//
//   想真送一段音频（16k 单声道 PCM，裸数据、无文件头）：
//     … node scripts/check-asr-tencent.mjs --pcm /path/to/16k.pcm
//   想先只看签名算得对不对（不联网）：`--selftest`
//
// ⚠️ 它**打印的东西里没有密钥**（只报长度与掩码）；输出可以直接贴出来。
// ⚠️ 判据是**腾讯那边的回话**（握手 `code:0` = 通了），不是我们自己说通就通。
//
// 退出码：0 通了 · 2 服务端回错（含鉴权失败）· 3 环境不具备（少凭据 / 少依赖 / 音频文件不对）

import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodeProcess from 'node:process';
import WebSocket from '../v2/services/core/node_modules/ws/index.js';

const argv = nodeProcess.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};

const APPID = nodeProcess.env.TENCENT_APPID ?? '';
const SECRET_ID = nodeProcess.env.TENCENT_SECRET_ID ?? '';
const SECRET_KEY = nodeProcess.env.TENCENT_SECRET_KEY ?? '';
const PCM = valueOf('--pcm');
/** ⚠️ 内测版：**只支持 16k 单声道 PCM、且不超过 1 分钟**（文档原话）。 */
const ENGINE = nodeProcess.env.TENCENT_ASR_ENGINE ?? 'Hy-ASR-3.0-preview';

/** 掩码（**永不打全**）：只说"有没有、多长"。 */
const mask = (s) => (s ? `长度 ${s.length}` : '（没设）');

/**
 * **签名原文 + 签名**（照文档 §签名生成 那三步）。
 *
 * ① 除 `signature` 外的参数**按字典序排序**、拼成
 *    `asr.cloud.tencent.com/asr/v2/<appid>?<排序后的查询串>`（**不含 `wss://`**）；
 * ② `signature = Base64(HMAC-SHA1(SecretKey, 签名原文))`；
 * ③ 把 signature **urlencode** 之后拼到 URL 末尾。
 *
 * @returns {{origin: string, signature: string, url: string}}
 */
export function signAsrUrl({ appid, secretId, secretKey, params, now = Date.now() }) {
  const all = {
    engine_model_type: ENGINE,
    // 有效期：给 60 秒够握手用（文档要求 expired > timestamp）
    expired: Math.floor(now / 1000) + 60,
    filter_empty_result: 0,
    needvad: 1,
    nonce: Math.floor(now / 1000),
    secretid: secretId,
    timestamp: Math.floor(now / 1000),
    voice_format: 1, // 1 = pcm
    // ⚠️ `voice_id` **由调用方给**（每次连接必须是一个新的 UUID，文档要求）——
    //    不放这儿生成，否则这个函数就不纯了：同一个输入两次算出两个不同的签名
    //    （自测当场抓到过这件事）。
    voice_id: params?.voice_id ?? nodeCrypto.randomUUID(),
    ...params,
  };
  const sorted = Object.keys(all).sort();
  const query = sorted.map((k) => `${k}=${all[k]}`).join('&');
  const origin = `asr.cloud.tencent.com/asr/v2/${appid}?${query}`;
  const signature = nodeCrypto.createHmac('sha1', secretKey).update(origin).digest('base64');
  return { origin, signature, url: `wss://${origin}&signature=${encodeURIComponent(signature)}` };
}

// ── `--selftest`：不联网，只把签名那一步的形状钉住（判据在 `test/`，这儿是给人看的）──
if (has('--selftest')) {
  // ⚠️ 固定 `voice_id`（它每次连接必须换新，但**签名函数本身要纯**：同输入 ⇒ 同签名）
  const fixed = { voice_id: '11111111-2222-3333-4444-555555555555' };
  const base = { appid: '1250000000', secretId: 'AKIDexample', secretKey: 'sk-example', now: 1700000000000, params: fixed };
  const a = signAsrUrl(base);
  const b = signAsrUrl(base);
  const c = signAsrUrl({ ...base, secretKey: 'sk-other' });
  const d = signAsrUrl({ ...base, params: { ...fixed, engine_model_type: '16k_zh' } });
  const checks = [
    ['签名原文不含协议头', !a.origin.startsWith('wss://')],
    ['签名原文参数按字典序', a.origin.includes('engine_model_type=') && a.origin.indexOf('engine_model_type=') < a.origin.indexOf('expired=')],
    ['签名原文里没有 signature', !a.origin.includes('signature')],
    ['同一个输入 ⇒ 同一个签名（除 voice_id 外）', a.signature === b.signature],
    ['换了密钥 ⇒ 签名就变', a.signature !== c.signature],
    ['换了引擎 ⇒ 签名就变', a.signature !== d.signature],
    ['是 base64（结尾可能是 =）', /^[A-Za-z0-9+/]+={0,2}$/.test(a.signature)],
    ['URL 里 signature 被 urlencode 过', a.url.includes('signature=') && !a.url.endsWith('==')],
  ];
  let bad = 0;
  for (const [what, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${what}`);
    if (!ok) bad += 1;
  }
  nodeProcess.exit(bad === 0 ? 0 : 2);
}

// ── 环境检查 ─────────────────────────────────────────────
if (!APPID || !SECRET_ID || !SECRET_KEY) {
  console.error('✗ 少了凭据。要三样（控制台 https://console.cloud.tencent.com/cam/capi）：');
  console.error(`   TENCENT_APPID=${mask(APPID)}  TENCENT_SECRET_ID=${mask(SECRET_ID)}  TENCENT_SECRET_KEY=${mask(SECRET_KEY)}`);
  console.error('   ⚠️ 别把它们贴进聊天/文件/日志 —— 就设在你自己那条命令的环境变量里。');
  nodeProcess.exit(3);
}
console.log(`▶ 引擎 ${ENGINE} · 账号 appid ${mask(APPID)} · secretid ${mask(SECRET_ID)} · secretkey ${mask(SECRET_KEY)}`);

let audio = Buffer.alloc(0);
if (PCM) {
  try {
    audio = nodeFs.readFileSync(PCM);
  } catch (err) {
    console.error(`✗ 读不到那段音频：${err?.message ?? err}`);
    nodeProcess.exit(3);
  }
  if (audio.length % 2 !== 0) {
    console.error('✗ 16k 单声道 PCM 一个采样 2 字节 ⇒ 文件长度得是偶数');
    nodeProcess.exit(3);
  }
  const seconds = audio.length / (16000 * 2);
  console.log(`  音频 ${audio.length} 字节 ≈ ${seconds.toFixed(1)} 秒${seconds > 60 ? '（⚠️ 内测版只支持 1 分钟以内）' : ''}`);
} else {
  // 没给音频 ⇒ 送 **200ms 静音**（6400 字节）走一遍完整流程：证明"签名 + 协议"都通
  audio = Buffer.alloc(6400);
  console.log('  （没给 --pcm ⇒ 送 200ms 静音走一遍流程：能拿到 final=1 就说明这条链是通的）');
}

const { url } = signAsrUrl({ appid: APPID, secretId: SECRET_ID, secretKey: SECRET_KEY });
const ws = new WebSocket(url);
let handshake = null;
let lastText = '';
let sawFinal = false;
const done = (code) => {
  try { ws.close(); } catch { /* 尽力 */ }
  nodeProcess.exit(code);
};
const timer = setTimeout(() => {
  console.error('✗ 15 秒没有收尾（网络？或者服务没开通）');
  done(3);
}, 15000);

ws.on('open', () => {
  console.log('✓ WebSocket 连上了（说明签名这一关过了）');
  // 200ms 一片（16k × 2 字节 × 0.2s = 6400）
  for (let i = 0; i < audio.length; i += 6400) {
    ws.send(audio.subarray(i, Math.min(i + 6400, audio.length)));
  }
  ws.send(JSON.stringify({ type: 'end' }));
});

ws.on('message', (raw) => {
  let j;
  try {
    j = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (handshake === null) {
    handshake = j;
    console.log(`  握手回话：code=${j.code} message=${j.message ?? ''}`);
    if (j.code !== 0) {
      clearTimeout(timer);
      console.error(`✗ 服务端不收（code ${j.code}）—— 这一条要照着 message 去查（鉴权 / 没开通 / 参数）`);
      done(2);
    }
    return;
  }
  if (j.result?.voice_text_str !== undefined) lastText = j.result.voice_text_str;
  if (j.final === 1) {
    sawFinal = true;
    clearTimeout(timer);
    console.log(`✓ 识别流走完了：final=1 · 认出来的字「${lastText}」（静音 ⇒ 空是对的）`);
    console.log('✅ 这条链是通的：凭据能用、签名对、协议对。');
    done(0);
  }
});

ws.on('error', (err) => {
  clearTimeout(timer);
  console.error(`✗ 连不上：${err?.message ?? err}`);
  done(2);
});

ws.on('close', () => {
  if (sawFinal) return;
  clearTimeout(timer);
  console.error('✗ 连接断了，而且没走到 final=1');
  done(2);
});
