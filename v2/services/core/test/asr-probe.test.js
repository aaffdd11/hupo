// **语音那条路的真读数探针**（`scripts/check-asr-doubao.mjs`）自己的判据。
//
// 为什么探针也要有判据：它是**主人/我唯一会拿去看真上游怎么回话**的那件东西 ——
//   它自己坏了（比如把钥匙打印出来、或者把端点写死在脚本里）比没探针更坏。
//   而它平时**不该联网**（联网那一次要花钱、要真钥匙）⇒ 这里只跑**不联网**的那几条。
//
// 守的几条：
//   ① `--selftest` 8 条必须全过（帧形状：header / 长度 / gzip / 最后一包 / 两种错误帧 / 认不出）
//   ② 🔴 **一个字节的钥匙都不许出现在输出里**（连"给了几位"之外的值都不许）
//   ③ 干跑（不带 `--spend`）**绝不建连** ⇒ 打得开、退得掉、不花钱
//   ④ 没钥匙还想真连 ⇒ **当场退 3**，不许去连
//   ⑤ 端点**可覆盖**（不许把地址写死在脚本里 —— 换上游是常见动作）
//   ⑥ 它读的必须是**产品那一份实现**（`src/asr-doubao.js`），不是自己另写一套
//
// ⚠️ 这里**不验**"上游收不收我们的帧" —— 那只能靠真钥匙跑 `--spend`；
//    缺钥匙时唯一的真读数是 `--spend --fake`（见 `docs/dev/152-VOICE-DOUBAO.md` §四·补）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeServerFrame, encodeAudioFrame } from '../src/asr-doubao.js';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const CORE = nodePath.resolve(HERE, '..');
const ROOT = nodePath.resolve(CORE, '..', '..', '..');
const PROBE = nodePath.join(ROOT, 'scripts', 'check-asr-doubao.mjs');

/** 跑一次探针。**环境里可能真存在的钥匙一律摘干净**（判据里只许用假凭据）。 */
function run(argv = [], extraEnv = {}) {
  const env = { ...process.env };
  for (const k of [
    'DOUBAO_ASR_APPID', 'DOUBAO_ASR_TOKEN', 'DOUBAO_ASR_RESOURCE', 'DOUBAO_ASR_URL', 'HUPO_ASR_URL',
    'TENCENT_APPID', 'TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY',
  ]) delete env[k];
  Object.assign(env, extraEnv);
  const r = spawnSync(process.execPath, [PROBE, ...argv], { encoding: 'utf8', env, cwd: ROOT, timeout: 60000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const FAKE_APPID = 'a'.repeat(10);
const FAKE_TOKEN = 't'.repeat(24);

test('① `--selftest` 8 条全 ✅ 且退 0（**不联网**）', () => {
  const r = run(['--selftest']);
  assert.equal(r.code, 0, `自测没全绿：\n${r.out}`);
  const passed = (r.out.match(/^ {2}✅ /gm) ?? []).length;
  assert.equal(passed, 8, `应当 8 条 ✅，实测 ${passed} 条：\n${r.out}`);
  assert.ok(!/^ {2}✗ /m.test(r.out), `自测里有挂的：\n${r.out}`);
});

test('🔴 ② 输出里**一个字符的钥匙都没有**（只有"给了几位"那种长度）', () => {
  const env = { DOUBAO_ASR_APPID: FAKE_APPID, DOUBAO_ASR_TOKEN: FAKE_TOKEN };
  for (const argv of [['--selftest'], []]) {
    const r = run(argv, env);
    assert.ok(!r.out.includes(FAKE_APPID), `App ID 漏进输出（${argv.join(' ') || '干跑'}）`);
    assert.ok(!r.out.includes(FAKE_TOKEN), `Token 漏进输出（${argv.join(' ') || '干跑'}）`);
  }
});

test('③ 干跑：打得开、退得掉、**不建连**（没说 `--spend` 就不许碰网络）', () => {
  const r = run();
  assert.equal(r.code, 0, `干跑退了 ${r.code}：\n${r.out}`);
  assert.match(r.out, /干跑/, '没写清这是干跑');
  assert.match(r.out, /--spend/, '没告诉人怎么真连');
  assert.match(r.out, /App ID \*\*没有\*\*/, '没凭据时没说"没有"');
});

test('④ 没钥匙还想真连 ⇒ 退 3，而且**不去连**', () => {
  const r = run(['--spend']);
  assert.equal(r.code, 3, `应当是 3（没给钥匙），实测 ${r.code}：\n${r.out}`);
  assert.match(r.out, /没给钥匙/, `没说清缺什么：\n${r.out}`);
});

test('⑤ 端点**可覆盖**（不许把地址写死）', () => {
  const r = run(['--url', 'wss://example.invalid/asr']);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes('wss://example.invalid/asr'), `干跑没认 --url：\n${r.out}`);
  const r2 = run([], { DOUBAO_ASR_URL: 'wss://another.invalid/x' });
  assert.ok(r2.out.includes('wss://another.invalid/x'), `干跑没认环境变量那条（换上游用的）：\n${r2.out}`);
});

test('⑥ 它读的是**产品那一份实现**：同一段 PCM，两边的帧逐字节一样', () => {
  const pcm = Buffer.from([9, 8, 7, 6, 5, 4, 3, 2]);
  const f = encodeAudioFrame(pcm);
  assert.equal(f[0], 0x11);
  assert.equal(f[1], 0x20, '普通音频包的 flags 变了');
  assert.ok(f.slice(8).equals(pcm), '产品那份编码器不再"原样"送音频了');
  assert.equal(decodeServerFrame(Buffer.alloc(2)).kind, 'unknown', '认不出的帧必须如实说认不出');
  // 而且探针**自己的自测**是照着这份实现判的 ⇒ 实现变了它先红
  const r = run(['--selftest']);
  assert.equal(r.code, 0, `自测挂了：\n${r.out}`);
});
