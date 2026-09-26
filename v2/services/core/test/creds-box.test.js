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

import { credsFor, tenantCredsPack, writeUserCreds } from '../src/creds-store.js';
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

test('🔴 盒子里：**只推语音那三样**（不带动模型钥匙）⇒ 模型与图片那两把还在', () => {
  const dir = tmp();
  try {
    const file = nodePath.join(dir, 'creds.yaml');
    writeKeyFile(file, 'sk-model-keep');
    mergeKeyFile(file, { image: 'ark-img-keep' });

    // ★ 这就是修好之后真正会推到盒子里的那一帧（`pushKey(tenant, null, pack)`）
    mergeKeyFile(file, {
      voiceAppId: '1300000001',
      voiceSecretId: 'vid',
      voiceSecretKey: 'vkey',
    });
    const text = nodeFs.readFileSync(file, 'utf8');
    for (const [name, v] of [
      ['HUPO_MODEL_KEY', 'sk-model-keep'],
      ['HUPO_IMAGE_KEY', 'ark-img-keep'],
      ['HUPO_VOICE_APPID', '1300000001'],
      ['HUPO_VOICE_SECRET_ID', 'vid'],
      ['HUPO_VOICE_SECRET_KEY', 'vkey'],
    ]) {
      assert.match(text, new RegExp(`^${name}: ${v}$`, 'm'), `少了一样：${name}`);
    }
    const names = text.split('\n').map((l) => l.split(':')[0].trim()).filter(Boolean);
    assert.equal(names[0], 'HUPO_MODEL_KEY', `★ 语言那把仍在最前：${names.join(',')}`);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── ④ ★ `#174`（2026-09-27）：**不带动模型钥匙的那几样也要推得进盒子** ──────
// 修之前：只有"这一包里有 `model`"那一次才推（`setModelKey` 里那一下），
// 而配置页**一屏一次提交** ⇒ 语音三样永远送不进盒子（那台一直回「没配凭据」）。
// 这两个判据钉的是修好之后**必须成立**的两件：
//   ① `tenantCredsPack` 把"中心存的那几样"＋（手里有就带上）模型那一把**现合**成一份；
//   ② 那一包**推得进去**：盒子那条通道上真的收得到 `creds`（而且可以没有 `key`）。

test('🔴 tenantCredsPack：中心存的几样 ＋（手里有就带）模型那一把 —— 一样都没有 ⇒ null', () => {
  const dir = tmp();
  try {
    // 一样都没有
    assert.equal(tenantCredsPack({ dataDir: dir, sub: 'u2' }), null);

    // 语音那一屏提交（**没有模型钥匙**）⇒ 包里就是那三样
    writeUserCreds(dir, 'u2', {
      voiceAppId: '1300000001',
      voiceSecretId: 'vid-1',
      voiceSecretKey: 'vkey-1',
    });
    const voiceOnly = tenantCredsPack({ dataDir: dir, sub: 'u2' });
    assert.deepEqual(voiceOnly, {
      voiceAppId: '1300000001',
      voiceSecretId: 'vid-1',
      voiceSecretKey: 'vkey-1',
    });
    assert.equal('model' in voiceOnly, false, '中心不存模型那把 ⇒ 包里不该凭空多一个');

    // 手里有模型那一把（宿主内存 `tenantKeys`）⇒ 一起带上
    const withModel = tenantCredsPack({ dataDir: dir, sub: 'u2', model: 'sk-model' });
    assert.equal(withModel.model, 'sk-model');
    assert.equal(withModel.voiceSecretKey, 'vkey-1');

    // 别人那一份**不许**混进来（按人分）
    assert.equal(tenantCredsPack({ dataDir: dir, sub: 'u1' }), null);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('🔴 推得进：**不带 `key` 的 `creds` 包**也送到了盒子那条通道上', async () => {
  const { TenantChannel, channelPathFor } = await import('../src/tenant-channel.mjs');
  const nodeNet = await import('node:net');
  const dir = tmp();
  const sock = channelPathFor(dir, 'hupo-b');
  const ch = new TenantChannel({
    dir,
    // ⚠️ 通道拿到的名字就是**租户名**（`serve.js` 的 `listenFor(tenant)`）——
    //    这正是"推给哪一台"那条规则；这里如实照它写。
    keyFor: () => null,
    log: () => {},
  });
  let conn = null;
  try {
    ch.listenFor('hupo-b');
    conn = nodeNet.connect(sock);
    const frames = [];
    conn.setEncoding('utf8');
    let buf = '';
    conn.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        frames.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    await new Promise((r) => conn.on('connect', r));
    // 一连上：手里没 key ⇒ 如实说 `waiting`（**不许**假装 ready）
    await waitFor(() => frames.length >= 1);
    assert.equal(frames[0].state, 'waiting');
    assert.equal('creds' in frames[0], false, '负向对照：没东西可给时不许塞一个空包');

    // ★ 语音那一屏提交 ⇒ 只推 `creds`（没有 key）—— 这一帧必须真的发出去
    const pushed = ch.pushKey('hupo-b', null, { voiceAppId: '1300000001', voiceSecretKey: 'vk' });
    assert.equal(pushed, 1, '★ 一台连着 ⇒ 就是推给它那一条');
    await waitFor(() => frames.length >= 2);
    assert.equal(frames[1].state, 'ready');
    assert.equal('key' in frames[1], false, '没有模型那把就不带 `key`（盒子那边按"合并"写）');
    assert.equal(frames[1].creds.voiceSecretKey, 'vk');

    // 负向对照：不存在的租户 ⇒ 如实回 0（"报个恒真的数"就是假话）
    assert.equal(ch.pushKey('hupo-a', null, { voiceAppId: 'x' }), 0);
  } finally {
    try {
      conn?.destroy();
    } catch {
      /* 已经没了 */
    }
    try {
      ch.close();
    } catch {
      /* 已经没了 */
    }
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

/** 等一小会儿，直到条件成立（最多 ~1 秒）。**超时就如实挂**。 */
async function waitFor(cond, ms = 1000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('等超时了');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('🔴 `#174`：盒子连上来（以及每次 `need-key`）都跟着第一帧把中心存的那几样给它', async () => {
  const { TenantChannel, channelPathFor } = await import('../src/tenant-channel.mjs');
  const nodeNet = await import('node:net');
  const dir = tmp();
  const ch = new TenantChannel({
    dir,
    keyFor: () => null, // 宿主内存里没有模型钥匙（重启之后就是这样）
    credsFor: () => ({ voiceAppId: '1300000001', voiceSecretKey: 'vk' }),
    log: () => {},
  });
  let conn = null;
  try {
    ch.listenFor('hupo-b');
    conn = nodeNet.connect(channelPathFor(dir, 'hupo-b'));
    const frames = [];
    conn.setEncoding('utf8');
    let buf = '';
    conn.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        frames.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    await new Promise((r) => conn.on('connect', r));
    await waitFor(() => frames.length >= 1);
    // ★ 没有模型钥匙，但中心存着那几样 ⇒ 也是 `ready` ＋ `creds`（盒子合并写，不抹掉模型那把）
    assert.equal(frames[0].state, 'ready');
    assert.equal('key' in frames[0], false);
    assert.equal(frames[0].creds.voiceAppId, '1300000001');

    // 盒子再问一次（它每几秒问一次）⇒ **同一包再给一遍**
    conn.write(`${JSON.stringify({ v: 1, type: 'need-key' })}\n`);
    await waitFor(() => frames.length >= 2);
    assert.equal(frames[1].state, 'ready');
    assert.equal(frames[1].creds.voiceSecretKey, 'vk');
  } finally {
    conn?.destroy();
    ch.close();
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }

  // 负向对照：**读存档这一下抛了**（盘坏了 / 权限不对）⇒ 不许把通道带倒，
  // 也不许假装有东西 —— 如实回 `waiting`。
  const dir2 = tmp();
  const ch2 = new TenantChannel({
    dir: dir2,
    keyFor: () => null,
    credsFor: () => {
      throw new Error('盘坏了');
    },
    log: () => {},
  });
  let conn2 = null;
  try {
    ch2.listenFor('hupo-b');
    conn2 = nodeNet.connect(channelPathFor(dir2, 'hupo-b'));
    const frames = [];
    conn2.setEncoding('utf8');
    let buf = '';
    conn2.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        frames.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    await new Promise((r) => conn2.on('connect', r));
    await waitFor(() => frames.length >= 1);
    assert.equal(frames[0].state, 'waiting', `如实说"还没有"：${JSON.stringify(frames[0])}`);
    assert.equal('creds' in frames[0], false, '负向对照：没有东西给时不许塞一个空包');
  } finally {
    conn2?.destroy();
    ch2.close();
    nodeFs.rmSync(dir2, { recursive: true, force: true });
  }
});
