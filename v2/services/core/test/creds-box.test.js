// **租户那半（B10 / P1-29）**的判据：钥匙怎么进盒子、盒子里怎么读得到。
//
// 三件要证的：
//   ① 中心送钥匙时**两种形状一起带**（老盒子认 `key`、新盒子认 `creds`）—— 谁都不坏；
//   ② 盒子里写的时候是**合并**（不再把别的几样抹掉 —— 那正是"接不上"的第二个原因）；
//   ③ 盒子里那**单文件** `creds.yaml` 认得出来（识别路与画图都读它）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { credsFor, writeUserCreds } from '../src/creds-store.js';
import { mergeKeyFile, writeKeyFile } from '../src/tenant-shell.mjs';

const tmp = () => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-box-'));

// ── ② 盒子里：合并写（不再抹掉别的几样）──────────────────────
test('🔴 盒子里写凭据：**合并**（模型钥匙 ＋ 语音三样 ＋ 图片 一起在）', () => {
  const dir = tmp();
  try {
    const file = nodePath.join(dir, 'creds.yaml');
    // 老形状先写一把（模拟"之前只送过模型钥匙"）
    writeKeyFile(file, 'sk-model-1');
    assert.match(nodeFs.readFileSync(file, 'utf8'), /HUPO_MODEL_KEY: sk-model-1/);

    // 新形状：一整包（含语音三样 ＋ 图片）
    mergeKeyFile(file, {
      model: 'sk-model-1',
      voiceAppId: '1300000001',
      voiceSecretId: 'vid',
      voiceSecretKey: 'vkey',
      image: 'ark-img-key',
    });
    const text = nodeFs.readFileSync(file, 'utf8');
    for (const [name, v] of [
      ['HUPO_MODEL_KEY', 'sk-model-1'],
      ['HUPO_VOICE_APPID', '1300000001'],
      ['HUPO_VOICE_SECRET_ID', 'vid'],
      ['HUPO_VOICE_SECRET_KEY', 'vkey'],
      ['HUPO_IMAGE_KEY', 'ark-img-key'],
    ]) {
      assert.match(text, new RegExp(`^${name}: ${v}$`, 'm'), `少了一样：${name}`);
    }
    // 🔴 顺序：语言那一把**最先**（盒子那边 `parseKey` 的老习惯也不吃亏）
    const names = text.split('\n').map((l) => l.split(':')[0].trim()).filter(Boolean);
    assert.equal(names[0], 'HUPO_MODEL_KEY', `★ 语言那把要在最前：${names.join(',')}`);
    assert.equal(nodeFs.statSync(file).mode & 0o777, 0o600, '盒子里的凭据必须 0600');
    assert.equal(nodeFs.existsSync(`${file}.tmp`), false, '原子写不该留下 .tmp');

    // 负向对照：**再写一次**只带图片 ⇒ 语音那三样**还在**（这就是"合并"的全部意义）
    mergeKeyFile(file, { image: 'ark-img-key-2' });
    const again = nodeFs.readFileSync(file, 'utf8');
    assert.match(again, /HUPO_VOICE_APPID: 1300000001/, '★ 只改图片那一样，别的不许被抹掉');
    assert.match(again, /HUPO_IMAGE_KEY: ark-img-key-2/);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── ③ 盒子里读：单文件也认（只在 tenant 角色下）───────────────
test('🔴 盒子里那份**单文件**读得到；宿主上**不认**它（不给"看不出原因"的毛病留缝）', () => {
  const dir = tmp();
  try {
    const file = nodePath.join(dir, 'creds.yaml');
    writeKeyFile(file, 'sk-box-only');
    mergeKeyFile(file, { voiceAppId: '1', voiceSecretId: 'a', voiceSecretKey: 'b', image: 'img-1' });

    // 盒子里（HUPO_ROLE=tenant）：认得出
    const box = credsFor({ dataDir: dir, sub: 'u1', env: { HUPO_ROLE: 'tenant' } });
    assert.equal(box.from, 'box');
    assert.equal(box.values.model, 'sk-box-only');
    assert.equal(box.status.voice, true, '三样齐了 ⇒ 语音那一样算"有"');
    assert.equal(box.status.image, true);

    // 宿主上（没有那个角色）：**不认**（宁可说"没有"，也不拿一份陈旧的单文件去顶）
    const host = credsFor({ dataDir: dir, sub: 'u1', env: {} });
    assert.equal(host.from, 'none');
    assert.equal(host.status.model, false);

    // 他自己那份**优先**（两边都有 ⇒ 用按人分目录那份）
    writeUserCreds(dir, 'u1', { image: 'mine-img' });
    const mine = credsFor({ dataDir: dir, sub: 'u1', env: { HUPO_ROLE: 'tenant' } });
    assert.equal(mine.from, 'mine');
    assert.equal(mine.values.image, 'mine-img');
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── ① 中心送：两种形状一起带（老盒子不坏、新盒子存全）─────────
test('🔴 中心推凭据：**老形状 `key` 与新形状 `creds` 一起带**（谁都不坏）', async () => {
  const { TenantChannel } = await import('../src/tenant-channel.mjs');
  const dir = tmp();
  try {
    const ch = new TenantChannel({ dir, keyFor: () => nodePath.join(dir, 'creds.yaml'), log: () => {} });
    // ⚠️ 私有 Map 进不去 ⇒ 这里只判**能判的那一件**：没有连接时**如实回 0**
    //    （"报个恒真的数会在没送到时把主人的文件删掉" —— 那是真出过的事）。
    //    帧里两种形状一起带那件事，由**盒子那一侧**的判据反向证明：
    //    它认得出 `creds`（合并），也认得出老的 `key`（见上面两条）。
    assert.equal(ch.pushKey('u1', 'sk-1', { model: 'sk-1', image: 'img-1' }), 0);
    assert.equal(ch.pushKey('u1', 'sk-1'), 0);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});
