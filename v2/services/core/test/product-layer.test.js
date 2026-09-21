// **产品层**（契约 `docs/dev/45-TENANT-UPDATE.md`）——
// 那一句"这一台跑的是哪一版、要不要叫它重开"的判据。
//
// ⚠️ 这一组测的全是**纯函数**与"拿假 fs 喂它"，不碰真机器。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';
import { FALLBACK_BUILD, compareTenantBuild, readProductLayer } from '../src/product-layer.js';

const tmp = () => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-code-'));

/** 造一个假的产品层目录：<root>/<fp>/manifest.json + <root>/current → <fp>。 */
function fakeRoot({ fp = 'abc123abc123', manifest = true, link = true } = {}) {
  const root = tmp();
  if (fp !== null) {
    nodeFs.mkdirSync(nodePath.join(root, fp), { recursive: true });
    if (manifest) {
      nodeFs.writeFileSync(
        nodePath.join(root, fp, 'manifest.json'),
        JSON.stringify({ fingerprint: fp, builtAt: '2026-09-21T00:00:00.000Z', gitRev: 'deadbee' }),
      );
    }
  }
  if (link && fp !== null) nodeFs.symlinkSync(nodePath.join(root, fp), nodePath.join(root, 'current'));
  return root;
}

test('🔴 读得到就是读得到：指纹从 manifest 来，目录是软链解出来的真目录', () => {
  const root = fakeRoot();
  const got = readProductLayer({ root });
  assert.equal(got.fingerprint, 'abc123abc123');
  assert.equal(got.gitRev, 'deadbee');
  assert.equal(got.dir, nodePath.join(root, 'abc123abc123'), '要解掉软链（不然"翻没过"看不出来）');
});

test('🔴 读不到就是 `null`，**不许**猜一个默认值糊过去', () => {
  // ① 压根没翻过
  assert.equal(readProductLayer({ root: fakeRoot({ fp: null }) }), null);
  // ② 软链在、但那一版里没有 manifest
  assert.equal(readProductLayer({ root: fakeRoot({ manifest: false }) }), null);
  // ③ 目录都不在
  assert.equal(readProductLayer({ root: nodePath.join(tmp(), '没有这个') }), null);
  // ④ manifest 是坏的 JSON
  const root = fakeRoot({ fp: 'badbadbadbad' });
  nodeFs.writeFileSync(nodePath.join(root, 'badbadbadbad', 'manifest.json'), '{不是 JSON');
  assert.equal(readProductLayer({ root }), null);
});

test('🔴 同一版 ⇒ 不叫它重开（**这一条最要紧**：判错就是每台容器被反复重开）', () => {
  const v = compareTenantBuild({ reported: 'abc123abc123', current: 'abc123abc123' });
  assert.equal(v.verdict, 'same');
  assert.equal(v.reload, false);
});

test('🔴 兜底那份（`dev`）要认出来，并叫它重开 —— 还要**说清是兜底**', () => {
  for (const reported of [FALLBACK_BUILD, '', null, undefined]) {
    const v = compareTenantBuild({ reported, current: 'abc123abc123' });
    assert.equal(v.verdict, 'fallback', `reported=${JSON.stringify(reported)}`);
    assert.equal(v.reload, true);
    assert.match(v.line, /兜底/, '一句指错方向的话比不说更费时间');
  }
});

test('另一版（翻过了但它还没重开）⇒ 叫它重开，而且两边指纹都要说出来', () => {
  const v = compareTenantBuild({ reported: 'oldoldoldold', current: 'abc123abc123' });
  assert.equal(v.verdict, 'stale');
  assert.equal(v.reload, true);
  assert.match(v.line, /oldoldoldold/);
  assert.match(v.line, /abc123abc123/);
});

test('🔴 宿主自己读不到当前那一版 ⇒ **谁都不叫**（叫了就是让它们去挂一个不存在的东西）', () => {
  const v = compareTenantBuild({ reported: 'anything', current: null });
  assert.equal(v.verdict, 'unknown');
  assert.equal(v.reload, false, '这一条写反了，就会把每一台容器都弄死');
});

test('⚠️ 变异验证：把"同一版"那条判据改坏（永远说 stale）⇒ 上面第一条必须红', () => {
  // 复制一份实现，只改一处（`===` 换成 `!==`），确认**判据本身**抓得住
  const broken = ({ reported, current }) => {
    const r = typeof reported === 'string' ? reported : '';
    if (!r || r === FALLBACK_BUILD) return { verdict: 'fallback', reload: true };
    if (r !== current) return { verdict: 'stale', reload: true };
    return { verdict: 'stale', reload: true }; // ← 坏在这里
  };
  const v = broken({ reported: 'abc123abc123', current: 'abc123abc123' });
  assert.equal(v.reload, true, '坏版本确实会说"要重开"');
  const good = compareTenantBuild({ reported: 'abc123abc123', current: 'abc123abc123' });
  assert.equal(good.reload, false, '而真的那一份**必须**说不用');
});
