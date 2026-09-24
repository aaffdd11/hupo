// **D5.10 那条硬闸的装置**：把四类各 20 条的语料音频真的喂进识别路，按同一把尺算分。
//
// 用法：
//   node scripts/check-voice-corpus.mjs --audio-dir <目录>     # <id>.wav（16k 单声道 PCM16）
//   node scripts/check-voice-corpus.mjs                        # 没给音频 ⇒ **明说"没跑"**（退出码 3）
//
// 退出码：0 = 过（总命中率 ≥90%）· 1 = 没过 · 3 = **没跑**（没有/不齐的音频、或格式不对）
//
// 🔴 **绝不许把"没跑"说成"过"**（这个项目最忌"看起来有闸"）。所以：
//   · 一条音频都没有 ⇒ 直接 3；
//   · 有的有、有的没有 ⇒ 只算有的那些，并且**明说少了几条**（读数按"实际跑过的"算，
//     但结论里必须带"不齐"这两个字 —— 不齐的读数**不能**当成 D5.10 的结论）。
//
// ⚠️ 音频**不入库**：D5.10 要的是**主人自己的声音**。本机 TTS 不可用
//   （espeak 没有中文词典，也没有 ffmpeg/sox 重采样）⇒ **不许拿合成音顶**（见 `77-BLOCKERS.md`）。

import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { Auth } from '../v2/services/core/src/auth.js';
import { CORPUS_CATEGORIES, PASS_RATE, isHit, scoreCorpus, validateCorpus } from '../v2/services/core/src/voice-corpus.js';
import WebSocket from '../v2/services/core/node_modules/ws/index.js';

const CORE = nodePath.resolve(import.meta.dirname, '..', 'v2', 'services', 'core');
const argv = process.argv.slice(2);
const argOf = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const AUDIO_DIR = argOf('--audio-dir');
const BASE = argOf('--base', 'http://127.0.0.1:8020');
const DATA = argOf('--data', nodePath.join(CORE, 'data'));

const corpus = JSON.parse(nodeFs.readFileSync(nodePath.join(CORE, 'test', 'corpus', 'voice-4x20.json'), 'utf8'));
const v = validateCorpus(corpus);
if (!v.ok) {
  console.error(`✗ 语料不合法：${v.why}`);
  process.exit(3);
}

if (!AUDIO_DIR || !nodeFs.existsSync(AUDIO_DIR)) {
  console.error('✗ **没跑**：没有语料音频（给 `--audio-dir <目录>`，里面放 <id>.wav，16k 单声道 PCM16）');
  console.error(`  语料 ${v.total} 条已就位（四类各 ${v.total / CORPUS_CATEGORIES.length} 条），缺的就是**声音**。`);
  console.error('  ⚠️ 这些音频要**主人自己念**（D5.10 要的是他的声音；本机 TTS 不可用，不许合成音顶）。');
  process.exit(3);
}

/** 读一个 16k 单声道 PCM16 的 wav（顺手校验格式 —— 格式不对就不许测，免得读数是垃圾）。 */
function readWav(file) {
  const b = nodeFs.readFileSync(file);
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, why: '不是 wav' };
  }
  const rate = b.readUInt32LE(24);
  const ch = b.readUInt16LE(22);
  const bits = b.readUInt16LE(34);
  if (rate !== 16000 || ch !== 1 || bits !== 16) {
    return { ok: false, why: `要 16k 单声道 16 位，这个是 ${rate}Hz/${ch}声道/${bits}位` };
  }
  // 找 data 块
  let off = 12;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'data') return { ok: true, pcm: b.subarray(off + 8, off + 8 + size) };
    off += 8 + size + (size % 2);
  }
  return { ok: false, why: '没有 data 块' };
}

/** 把一段 PCM 喂给那条识别路，把最终的句子收回来。 */
function recognize(pcm, token) {
  return new Promise((resolve) => {
    const url = BASE.replace(/^http/, 'ws') + '/api/asr';
    const ws = new WebSocket(url, ['bearer', token]);
    let finals = [];
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch { /* 已经没了 */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, why: '超时' }), 30000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'asr/start' }));
      // 按 ~40ms 一块推（模拟真流；一次全推上游可能丢）
      let i = 0;
      const step = 16000 * 2 * 0.04;
      const tick = setInterval(() => {
        if (i >= pcm.length) {
          clearInterval(tick);
          ws.send(JSON.stringify({ type: 'asr/stop' }));
          return;
        }
        ws.send(pcm.subarray(i, Math.min(i + step, pcm.length)));
        i += step;
      }, 40);
    });
    ws.on('message', (b) => {
      let j = null;
      try { j = JSON.parse(b.toString()); } catch { return; }
      if (j.type === 'asr/final' && typeof j.text === 'string') finals.push(j.text);
      if (j.type === 'asr/end') {
        if (typeof j.text === 'string' && j.text.trim() !== '') finals.push(j.text);
        clearTimeout(timer);
        finish({ ok: true, text: finals.join('') });
      }
      if (j.type === 'asr/unavailable' || j.type === 'asr/error') {
        clearTimeout(timer);
        finish({ ok: false, why: j.reason ?? j.type, text: finals.join('') });
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); finish({ ok: false, why: `连不上：${e?.message ?? e}` }); });
  });
}

const auth = new Auth({ dataDir: DATA });
const { token } = auth.issue({ sub: 'owner' });

const rows = [];
let missing = 0;
let badFormat = 0;
for (const s of corpus.sentences) {
  const file = nodePath.join(AUDIO_DIR, `${s.id}.wav`);
  if (!nodeFs.existsSync(file)) {
    missing += 1;
    continue;
  }
  const w = readWav(file);
  if (!w.ok) {
    badFormat += 1;
    console.error(`  ✗ ${s.id} 的音频格式不对（${w.why}）`);
    continue;
  }
  const r = await recognize(w.pcm, token);
  rows.push({ category: s.category, expected: s.text, got: r.text ?? '' });
  const hit = isHit(s.text, r.text ?? '');
  console.log(`  ${hit ? '✓' : '✗'} ${s.id} 〔${s.category}〕${s.text}${hit ? '' : `  ← 听成「${(r.text ?? '').trim()}」`}`);
}

const score = scoreCorpus(rows);
console.log('');
console.log(`── 读数（实跑 ${score.total} 条${missing ? ` · **缺 ${missing} 条音频**` : ''}${badFormat ? ` · 格式不对 ${badFormat} 条` : ''}）`);
for (const c of CORPUS_CATEGORIES) {
  const b = score.byCategory[c];
  console.log(`   ${c.padEnd(4)} ${b.hit}/${b.total}${b.total ? `  ${(b.rate * 100).toFixed(0)}%${b.rate < PASS_RATE ? ' ⚠️ 低于门槛' : ''}` : '  （没跑）'}`);
}
console.log(`   总体   ${score.hit}/${score.total}  ${(score.rate * 100).toFixed(1)}%   （门槛 ≥${PASS_RATE * 100}%）`);

if (score.total === 0) {
  console.error('✗ **没跑**：一条有效音频都没有 ⇒ 没有读数。');
  process.exit(3);
}
if (missing > 0 || badFormat > 0) {
  console.log('⚠️ **不齐** —— 这个读数**不能**当成 D5.10 的结论（那条闸要四类各 20 条齐全）。');
}
console.log(score.pass ? '✅ 过（按总命中率）' : `❌ 没过（<${PASS_RATE * 100}%）`);
process.exit(score.pass ? 0 : 1);
