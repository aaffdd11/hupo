#!/usr/bin/env node
// **语音那条路（豆包大模型流式语音识别）的真读数探针**。
//
// 为什么要有它（与 `check-ark-image.mjs` / `check-ark-video.mjs` 同一个理由，但**更急**）：
//   `src/asr-doubao.js` 那一套帧格式是**照官方那页抄的**，而"抄的"不算验过 ——
//   规矩是**以真跑一次的回话为准**（`docs/dev/79-CREDS-TABS.md` §九）。
//   这个脚本就是那一次：它跟**真那个上游**建连、发真帧、把上游回的每一帧**原话说出来**。
//
// ⚠️ **它一个字符都不打印钥匙**（App ID / Access Token 都不打；上游原话里若出现那两串，
//    先抹掉再打印）。输出可以直接贴给主人。
//
// 用法：
//   node scripts/check-asr-doubao.mjs --selftest            # 不联网：帧形状 8 条（随时能跑）
//   node scripts/check-asr-doubao.mjs                       # 干跑：只说"会发什么"，**不连**
//   DOUBAO_ASR_APPID=… DOUBAO_ASR_TOKEN=… \
//     node scripts/check-asr-doubao.mjs --spend             # 真连（发 2 秒合成音）：按秒算钱 ⇒ 要点这个头
//   … --spend --pcm /path/to/16k.pcm --seconds 4            # 让真人的声音进去（16k 单声道 s16le）
//   node scripts/check-asr-doubao.mjs --spend --fake        # 🔴 **假凭据连真上游**（不花钱）：看它怎么拒我们
//   node scripts/check-asr-doubao.mjs --handshake            # 🔴 **只探"哪几个建连头是必须的"**（假值；缺钥匙也能跑）
//   … --resource volc.seedasr.sauc.duration                 # 换资源 id（2.0 那条）
//
// 🔴 **`--fake` 那一条本身就是一次真读数**：它证明"端点对不对、建连头它吃不吃" ——
//    上游若回**错误帧**（而不是直接掐线），说明帧与头它都读懂了。**缺钥匙也能跑这一条。**
//
// ⚠️ **合成音不是人话**（默认静音）⇒ 它只证"通了"，**不证"听得准"**。
//    要证听得准：拿真人的话喂 `--pcm`（语料在 `test/corpus/voice-4x20.json`）。

import nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import nodeProcess from 'node:process';
import { pathToFileURL } from 'node:url';
import * as nodeZlib from 'node:zlib';

import {
  createDoubaoUpstream,
  decodeServerFrame,
  doubaoConfigFromEnv,
  encodeAudioFrame,
  encodeFullClientRequest,
  DEFAULT_RESOURCE_ID,
  DOUBAO_ASR_URL,
} from '../v2/services/core/src/asr-doubao.js';
import { safeAsrMessage } from '../v2/services/core/src/asr.js';

// ⚠️ `ws` 是**服务端那份 `package.json`** 的依赖（这个脚本住仓库根的 `scripts/`，
//    从这儿直接 `import 'ws'` 解析不到）⇒ 以服务端那个目录为基准去找它。
const requireFromCore = createRequire(new URL('../v2/services/core/src/asr-doubao.js', import.meta.url));
const WebSocket = requireFromCore('ws');

const args = nodeProcess.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d = null) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

if (has('--help') || has('-h')) {
  console.log('用法：node scripts/check-asr-doubao.mjs [--selftest] [--handshake] [--spend] [--fake] [--pcm <16k.pcm>] [--seconds N] [--resource <id>] [--url <wss://…>]');
  nodeProcess.exit(0);
}

const SPEND = has('--spend');
const FAKE = has('--fake');
const PCM_PATH = val('--pcm', null);
const SECONDS = Math.max(1, Math.min(20, Number(val('--seconds', '2')) || 2));

/** 假凭据（`--fake`）：**长得像真的就危险** —— 明摆着是假的，且永不出现在真配置里。 */
export const FAKE_CREDS = { appid: '0000000000', token: 'fake-token-not-a-real-one' };

/** 🔴 抹掉钥匙：上游原话里若回显了我们发过去的那两串（或它的地址），先抠掉再打印。**纯函数**。 */
export function maskSecrets(text, { appid = '', token = '' } = {}) {
  let s = safeAsrMessage(text);
  for (const v of [appid, token]) {
    const t = String(v ?? '').trim();
    if (t.length >= 8) s = s.split(t).join('（钥匙已隐去）');
  }
  return s;
}

/** 这一帧的"长相"（只读 header；语义仍以 `decodeServerFrame` 为准）。**纯函数**。 */
export function describeFrame(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? []);
  const names = { 0b0001: 'full-client-request', 0b0010: 'audio-only', 0b1001: 'server-response', 0b1111: 'error' };
  if (buf.length < 4) return `太短（${buf.length} 字节）`;
  const type = (buf[1] >> 4) & 0x0f;
  const flags = buf[1] & 0x0f;
  const comp = buf[2] & 0x0f;
  const gz = comp === 0b0001 ? 'gzip' : comp === 0b0000 ? '不压缩' : `压缩 0b${comp.toString(2)}`;
  return `${names[type] ?? `type 0b${type.toString(2).padStart(4, '0')}`} · flags 0b${flags.toString(2).padStart(4, '0')} · ${gz} · ${buf.length} 字节`;
}

/** 合成音：`seconds` 秒的 16k 单声道 s16le **静音**（不是人话）。**纯函数**。 */
export const silencePcm = (seconds) => Buffer.alloc(Math.round(seconds * 16000) * 2);

// ── `--selftest`：不联网，把"我们发的/我们认的"逐条钉一遍 ──────────────────
export function runSelftest() {
  const rows = [];
  const add = (name, fn) => {
    try {
      fn();
      rows.push([true, name]);
    } catch (err) {
      rows.push([false, `${name} ⇒ ${err?.message ?? err}`]);
    }
  };
  const ok = (cond, why) => {
    if (!cond) throw new Error(why);
  };

  add('S1 凭据：两样齐了才算"配了"；老 `TENCENT_*` 一个都不读', () => {
    ok(doubaoConfigFromEnv({ DOUBAO_ASR_APPID: 'a'.repeat(10), DOUBAO_ASR_TOKEN: 't'.repeat(20) }).configured === true, '两样齐了却说不算配');
    ok(doubaoConfigFromEnv({ TENCENT_APPID: 'x', TENCENT_SECRET_ID: 'y', TENCENT_SECRET_KEY: 'z' }).configured === false, '还在读腾讯那三样');
    ok(doubaoConfigFromEnv({ DOUBAO_ASR_APPID: 'x' }).configured === false, '只有 App ID 也算配了？');
  });

  add('S2 请求参数帧：header 那几格 ＋ 长度大端 ＋ 正文是 gzip 的 JSON（pcm/16000/16/单声道）', () => {
    const f = encodeFullClientRequest({ audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 }, request: { model_name: 'bigmodel' } });
    ok(f[0] === 0x11 && f[1] === 0x10 && f[2] === 0x11 && f[3] === 0x00, `header 不对：[${[...f.slice(0, 4)].map((b) => b.toString(16))}]`);
    ok(f.readUInt32BE(4) === f.length - 8, '长度字段与正文对不上');
    const j = JSON.parse(nodeZlib.gunzipSync(f.slice(8)).toString('utf8'));
    ok(j.audio.rate === 16000 && j.audio.channel === 1 && j.audio.bits === 16, '音频参数不对');
    ok(j.request.model_name === 'bigmodel', '模型名不对');
  });

  add('S3 音频帧：PCM **一个字节都不改**；"最后一包"是 flags 0b0010 且空正文', () => {
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const f = encodeAudioFrame(pcm);
    ok(f[1] === 0x20, `普通包 flags 不对：0x${f[1].toString(16)}`);
    ok(f.slice(8).equals(pcm), '音频被改过了');
    const last = encodeAudioFrame(Buffer.alloc(0), { last: true });
    ok(last[1] === 0x22 && last.length === 8, '最后一包不对');
  });

  add('S4 解回帧：压缩与不压缩都认，半句/定稿/段号都对', () => {
    const body = { result: { text: '今天天气', utterances: [{ text: '今天天气怎么样', definite: true }, { text: '嗯' }] }, logid: 'L1' };
    const mk = (gzip) => {
      const p = gzip ? nodeZlib.gzipSync(Buffer.from(JSON.stringify(body))) : Buffer.from(JSON.stringify(body));
      const size = Buffer.alloc(4);
      size.writeUInt32BE(p.length, 0);
      return Buffer.concat([Buffer.from([0x11, 0x90, gzip ? 0x11 : 0x10, 0x00]), size, p]);
    };
    for (const gzip of [true, false]) {
      const ev = decodeServerFrame(mk(gzip));
      ok(ev.kind === 'result', `${gzip ? '压缩' : '不压缩'}那一份没解出来：${ev.why ?? ev.kind}`);
      ok(ev.text === '今天天气' && ev.definite === '今天天气怎么样' && ev.index === 0, `字段对不上：${JSON.stringify(ev)}`);
    }
  });

  add('S5 错误帧**两种形状都认**（错误码 ＋ 大小 ＋ 正文；错误码 ＋ JSON 正文）', () => {
    const mkErr = (payload) => {
      const size = Buffer.alloc(4);
      size.writeUInt32BE(payload.length, 0);
      const code = Buffer.alloc(4);
      code.writeUInt32BE(45000001, 0);
      return Buffer.concat([Buffer.from([0x11, 0xf0, 0x00, 0x00]), code, size, payload]);
    };
    const a = decodeServerFrame(mkErr(Buffer.from('{"message":"invalid token"}')));
    ok(a.kind === 'error' && a.code === 45000001 && a.message === 'invalid token', `JSON 形状没认出来：${JSON.stringify(a)}`);
    const b = decodeServerFrame(mkErr(Buffer.from('plain text error')));
    ok(b.kind === 'error' && b.message === 'plain text error', `裸文本形状没认出来：${JSON.stringify(b)}`);
  });

  add('S6 认不出的回帧 ⇒ **如实说认不出**（不抛、不假装成了）', () => {
    ok(decodeServerFrame(Buffer.from([0x00])).kind === 'unknown', '太短那种没说认不出');
    ok(decodeServerFrame(Buffer.from([0x11, 0x90, 0x00, 0x00, 0, 0, 0, 4, 1, 2, 3, 4])).why === 'not-json', '正文不是 JSON 那种没说认不出');
    ok(describeFrame(Buffer.from([0x00, 0x11])).startsWith('太短'), '长相那一栏没说太短');
  });

  add('S7 🔴 上游原话里的钥匙与地址**先抹掉再打印**', () => {
    const appid = '1234567890';
    const token = 'super-secret-token-value';
    const out = maskSecrets(`auth failed for ${appid} token=${token} see wss://openspeech.bytedance.com/api/v3/sauc/bigmodel?x=1`, { appid, token });
    ok(!out.includes(appid), 'App ID 漏出去了');
    ok(!out.includes(token), 'Token 漏出去了');
    ok(!out.includes('openspeech.bytedance.com'), '上游地址漏出去了');
  });

  add('S8 合成音与分包的算术：字节数 = 秒 × 16000 × 2（16k 单声道 s16le）', () => {
    ok(silencePcm(2).length === 64000, `2 秒应当是 64000 字节，实测 ${silencePcm(2).length}`);
    ok(silencePcm(1).length === 32000, '1 秒应当 32000 字节');
  });

  console.log('▶ 语音那条路（豆包 ASR）探针自测 —— **不联网**，只钉形状');
  let bad = 0;
  for (const [pass, name] of rows) {
    console.log(`  ${pass ? '✅' : '✗ '} ${name}`);
    if (!pass) bad += 1;
  }
  console.log(bad === 0 ? `\n✅ 自测 ${rows.length} 条全过（**这不代表上游收我们的帧** —— 那要靠 \`--spend\` 那一次真读数）` : `\n✗ 自测挂了 ${bad} 条`);
  return bad === 0 ? 0 : 1;
}

/**
 * **只探建连头**：拿**假值**试几组组合，看真上游分别怎么回。
 *
 * 🔴 为什么这是一条**真读数**（缺钥匙也能跑）：上游若对"少头"回 400、对"头齐了但不对"回 401，
 *    那 400/401 这条分界**本身就是证据** —— 它说明**头名它认**（不认的话两种都是 400）。
 *    ⚠️ 但它**不证明**钥匙对不对（假钥匙当然是 401）—— 那要真钥匙那一次。
 *    ⚠️ 它**只用假值**，一个字节真凭据都不发（`AGENTS.md` §六：破坏性探针只用假 id）。
 */
async function runHandshake() {
  const url = val('--url', null) ?? DOUBAO_ASR_URL;
  const resource = val('--resource', null) ?? DEFAULT_RESOURCE_ID;
  const A = { 'X-Api-App-Key': FAKE_CREDS.appid };
  const K = { 'X-Api-Access-Key': FAKE_CREDS.token };
  const R = { 'X-Api-Resource-Id': resource };
  const C = { 'X-Api-Connect-Id': '11111111-2222-3333-4444-555555555555' };
  const cases = [
    ['一个头都不带', {}],
    ['只有 App Key', { ...A }],
    ['App Key ＋ Access Key', { ...A, ...K }],
    ['App Key ＋ Access Key ＋ Connect-Id', { ...A, ...K, ...C }],
    ['App Key ＋ Access Key ＋ Resource-Id', { ...A, ...K, ...R }],
    ['四样都在', { ...A, ...K, ...R, ...C }],
  ];
  console.log('▶ 建连头这一关（豆包 ASR）—— **假值**探哪几个头是必须的');
  console.log(`  端点     ${url}\n  资源     ${resource}`);
  const rows = [];
  for (const [name, headers] of cases) {
    const r = await new Promise((resolve) => {
      let ws;
      try {
        ws = new WebSocket(url, { headers, handshakeTimeout: 10000 });
      } catch (err) {
        resolve(`起不来：${String(err?.message ?? err).slice(0, 60)}`);
        return;
      }
      const t = setTimeout(() => {
        try { ws.terminate(); } catch { /* 没了 */ }
        resolve('10 秒没回音');
      }, 12000);
      ws.on('open', () => { clearTimeout(t); try { ws.close(); } catch { /* 没了 */ } resolve('**连上了**（说明这一组头它收）'); });
      ws.on('unexpected-response', (_req, res) => { clearTimeout(t); try { res.resume(); } catch { /* 没了 */ } resolve(`HTTP ${res.statusCode}`); });
      ws.on('error', (err) => { clearTimeout(t); resolve(`底层报错：${String(err?.message ?? err).replace(/wss?:\/\/\S+/g, '（地址隐去）').slice(0, 70)}`); });
    });
    rows.push([name, r]);
    console.log(`  ${r.startsWith('HTTP') ? '·' : '!'} ${name.padEnd(34)} ${r}`);
  }
  const byName = Object.fromEntries(rows);
  const basic = byName['App Key ＋ Access Key'];
  const withRes = byName['App Key ＋ Access Key ＋ Resource-Id'];
  console.log('\n  ⇒ 读法：**少了 Resource-Id 会被挡在门外**（400），带上它才轮到"钥匙对不对"（401）');
  console.log(`     实测：${basic}（不带 Resource-Id） · ${withRes}（带）`);
  console.log('  ⇒ ⚠️ 401 **不代表**钥匙对 —— 假钥匙本来就该 401；真钥匙那一次要让 `--spend` 去证');
  return 0;
}

/** 真连：走**生产那一跳**（`createDoubaoUpstream`），顺手把原始帧的长相撸下来看。 */
async function runSpend() {
  const env = FAKE ? { ...FAKE_CREDS, resource: DEFAULT_RESOURCE_ID, url: DOUBAO_ASR_URL } : doubaoConfigFromEnv(nodeProcess.env);
  if (!FAKE && !env.configured) {
    console.error('✗ 没给钥匙：DOUBAO_ASR_APPID=… DOUBAO_ASR_TOKEN=…（或 `--fake` 用假凭据看它怎么拒）');
    return 3;
  }
  const cfg = { ...env, url: val('--url', null) ?? env.url, resource: val('--resource', null) ?? env.resource ?? DEFAULT_RESOURCE_ID };
  const pcm = PCM_PATH ? nodeFs.readFileSync(PCM_PATH) : silencePcm(SECONDS);
  const src = PCM_PATH ? `真音频 ${PCM_PATH}` : `合成音（静音 ${SECONDS} 秒 —— 这不是人话，只证"通了"）`;

  console.log('▶ 语音那条路（豆包大模型流式语音识别）—— **真连**');
  console.log(`  端点     ${cfg.url}`);
  console.log(`  资源     ${cfg.resource}`);
  console.log(`  凭据     ${FAKE ? '**假凭据（--fake，不花钱）**' : '环境变量那两样（值不打印）'}`);
  console.log(`  音频     ${src} · ${pcm.length} 字节 · ${Math.round((pcm.length / 2 / 16000) * 1000)} 毫秒`);

  const events = [];
  const raw = [];
  let done = false;
  /** 只看一眼原始帧（语义仍由 `decodeServerFrame` 定）—— 不改它的行为。 */
  class TapWS extends WebSocket {
    emit(event, ...rest) {
      if (event === 'message') raw.push(rest[0]);
      return super.emit(event, ...rest);
    }
  }
  const up = createDoubaoUpstream({ config: cfg, WebSocketImpl: TapWS, log: () => {} });
  up.open({
    onReady: () => events.push(['ready', '上游接了（第一帧回来了）']),
    onPartial: (p) => events.push(['partial', p.text]),
    onFinal: (p) => events.push(['final', p.text]),
    onEnd: () => {
      events.push(['end', '（整段说完了）']);
      done = true;
    },
    onError: (e) => {
      events.push([`error:${e.kind}`, `${e.code ?? ''} ${maskSecrets(e.message, cfg)}`.trim()]);
      done = true;
    },
  });
  const chunk = 3200; // 200ms
  for (let off = 0; off < pcm.length && !done; off += chunk) {
    up.audio(pcm.slice(off, off + chunk));
    await new Promise((r) => setTimeout(r, 200));
  }
  up.finish();
  const deadline = Date.now() + 12000;
  while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  up.close();

  console.log(`\n  上游回帧（原始长相，${raw.length} 帧）：`);
  if (raw.length === 0) console.log('    （一帧都没回）');
  for (const f of raw) {
    const ev = decodeServerFrame(f);
    const tail = ev.kind === 'result' ? `⇒ 字「${ev.text}」${ev.definite !== null ? `（定稿「${ev.definite}」）` : ''}${ev.logid ? ` · logid ${ev.logid}` : ''}`
      : ev.kind === 'error' ? `⇒ 错误码 ${ev.code}：${maskSecrets(ev.message, cfg)}`
        : `⇒ 认不出（${ev.why}）`;
    console.log(`    · ${describeFrame(f)}  ${tail}`);
  }
  console.log('\n  我们的四个事件：');
  if (events.length === 0) console.log('    （一个都没有）');
  for (const [k, v] of events) console.log(`    · ${k}${v ? `：${v}` : ''}`);

  const ready = events.some(([k]) => k === 'ready');
  const errs = events.filter(([k]) => k.startsWith('error:'));
  const words = events.filter(([k, v]) => (k === 'partial' || k === 'final') && v).map(([, v]) => v);
  console.log(`\n  握手     ${ready ? '✅ 它接了' : '✗ 没握上手'}`);
  console.log(`  字       ${words.length ? words.join(' / ') : '（没有字 —— 静音本来就该没有字）'}`);

  // ⚠️ "连都没连上"（DNS / 网络 / 地址写错）与"上游拒了我们"**必须分开说** ——
  //    混成一句会让人以为是钥匙不对，然后拿着好钥匙去查错地方（老那套栽过一次）。
  if (errs.some(([k]) => k === 'error:connect' || k === 'error:upstream')) {
    console.log('\n⇒ **没连上**（不是"上游拒了"）：上面那句是底层原话 ⇒ 如实说：这一趟没验出来');
    return 5;
  }
  if (errs.length) {
    console.log('\n⇒ 上游**拒了**。⚠️ 这一条也是**真读数**：它说明端点与建连头**它读得懂**（回的是错误帧而不是掐线）');
    return 4;
  }
  if (!ready) {
    console.log('\n⇒ 没握上手、也没拿到错误帧 —— 如实说：这一趟没验出来');
    return 5;
  }
  console.log('\n✅ 这一趟通了（⚠️ 合成音不是人话 ⇒ 只说"通了"，不说"听得准"；要听人话：--pcm）');
  return 0;
}

/** 干跑：只说"会发什么"，一个字节都不发。 */
function dryRun() {
  const cfg = doubaoConfigFromEnv(nodeProcess.env);
  const pcm = PCM_PATH ? null : silencePcm(SECONDS);
  console.log('▶ 语音那条路（豆包 ASR）—— **干跑**（不连、不花钱）');
  console.log(`  端点     ${val('--url', null) ?? cfg.url}`);
  console.log(`  资源     ${val('--resource', null) ?? cfg.resource}`);
  console.log(`  凭据     App ID ${cfg.appid ? `给了（${cfg.appid.length} 位，值不打印）` : '**没有**'} · Access Token ${cfg.token ? `给了（${cfg.token.length} 位，值不打印）` : '**没有**'}`);
  console.log('  会发什么 ① 请求参数帧（gzip 的 JSON：pcm/16000/16/单声道 ＋ model_name）');
  console.log(`           ② ${pcm ? Math.ceil(pcm.length / 3200) : 'N'} 包音频（每包 ≤3200 字节 ＝ 200ms，原样）＋ 最后一包（flags 0b0010）`);
  console.log(`  音频来源 ${PCM_PATH ? `真音频 ${PCM_PATH}` : `合成音（静音 ${SECONDS} 秒）`}`);
  console.log('\n  ⇒ 要真连：加 `--spend`（按秒算钱）；只想看它怎么拒：`--spend --fake`（不花钱）');
  return 0;
}

if (nodeProcess.argv[1] && import.meta.url === pathToFileURL(nodeProcess.argv[1]).href) {
  let code = 0;
  if (has('--selftest')) code = runSelftest();
  else if (has('--handshake')) code = await runHandshake();
  else if (SPEND) code = await runSpend();
  else code = dryRun();
  nodeProcess.exit(code);
}
