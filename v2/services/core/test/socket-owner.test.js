// 本地通道**交给谁**（`src/socket-owner.mjs`）—— 2026-09-24 真机事故的判据。
//
// 🔴 事故形状（主人的 u2 号在对话里要一个天气小程序，报"放不上去"）：
//    盒子里的**服务是 root 起的**，干活的 **agent 是 uid 1000**；
//    那两条本地通道按"进程自己的 uid + 0600"建出来 ⇒ 属主 root ⇒ agent **连不上**。
//    真机上以 uid 1000 复现过：`/data/apps.sock` 与 `/data/ledger.sock` 都是 EACCES。
//
// ⚠️ 所以这一份要钉住的**不是**"会不会 chown"，而是这条**边界**：
//    ① 宿主机（没有那两条 env）**一个字节都不许动** —— 那是"别把主人的世界改坏"；
//    ② 盒子里**必须**交给 agent，而且**准入仍是 0600**（不许拿 0666 当修法）；
//    ③ 交不出去（不是 root / chown 报错）**不许抛**，但**必须留一句能查的话**。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentOwnerFromEnv,
  handSocketToAgent,
  shouldHandToAgent,
} from '../src/socket-owner.mjs';

/** 假的 fs：只记"有没有 chown、chown 成什么"，一个真文件都不碰。 */
function fakeFs({ throwOnChown = null } = {}) {
  const calls = [];
  return {
    calls,
    chownSync(p, uid, gid) {
      calls.push({ p, uid, gid });
      if (throwOnChown) throw throwOnChown;
    },
  };
}

const BOX_ENV = { HUPO_AGENT_UID: '1000', HUPO_AGENT_GID: '1000' };

test('宿主上（没有那两条 env）什么都不做 —— 阴性对照', () => {
  const fs = fakeFs();
  const r = handSocketToAgent('/data/apps.sock', { env: {}, uid: 0, fs });
  assert.equal(r.done, false);
  assert.equal(fs.calls.length, 0, '宿主上 chown 一次都不许发生');
  assert.match(r.why, /没配/);
});

test('不是 root 就不动（交不出去不可怕，乱动才可怕）', () => {
  const fs = fakeFs();
  const r = handSocketToAgent('/data/apps.sock', { env: BOX_ENV, uid: 1001, fs });
  assert.equal(r.done, false);
  assert.equal(fs.calls.length, 0);
  assert.match(r.why, /不是 root/);
});

test('盒子里（root + 配了）⇒ 交给 1000:1000', () => {
  const fs = fakeFs();
  const r = handSocketToAgent('/data/apps.sock', { env: BOX_ENV, uid: 0, fs });
  assert.equal(r.done, true);
  assert.deepEqual(fs.calls, [{ p: '/data/apps.sock', uid: 1000, gid: 1000 }]);
});

test('uid 本来就是他的 ⇒ 不多此一举（宿主上主人那格正是这种）', () => {
  const fs = fakeFs();
  const r = handSocketToAgent('/data/apps.sock', {
    env: { HUPO_AGENT_UID: '0', HUPO_AGENT_GID: '0' },
    uid: 0,
    fs,
  });
  // 0 是"没配"（不是"交给 root"）—— 这一条是**负向**的：绝不许 chown 到 root
  assert.equal(r.done, false);
  assert.equal(fs.calls.length, 0);
});

test('env 写坏了（空 / 不是数）⇒ 当没配，不许猜', () => {
  for (const env of [
    { HUPO_AGENT_UID: '', HUPO_AGENT_GID: '' },
    { HUPO_AGENT_UID: 'agent', HUPO_AGENT_GID: '1000' },
    { HUPO_AGENT_UID: '1000' },
    { HUPO_AGENT_UID: '-1', HUPO_AGENT_GID: '1000' },
  ]) {
    assert.equal(agentOwnerFromEnv(env), null, JSON.stringify(env));
    assert.equal(shouldHandToAgent({ env, uid: 0 }).hand, false, JSON.stringify(env));
  }
});

test('chown 失败：不抛，但必须留一句能查的话（静默降级就是这个仓库最忌的形状）', () => {
  const said = [];
  const fs = fakeFs({ throwOnChown: Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }) });
  const r = handSocketToAgent('/data/ledger.sock', {
    env: BOX_ENV,
    uid: 0,
    fs,
    log: (m) => said.push(m),
  });
  assert.equal(r.done, false);
  assert.equal(r.why, 'EPERM');
  assert.equal(said.length, 1);
  assert.match(said[0], /EACCES|连不上/);
});
