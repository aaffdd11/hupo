// **按用户撤全部令牌**（欠账 · `docs/dev/38-ISOLATION-SPLIT.md` §8.4）。
//
// ── 这条债原来是什么 ──────────────────────────────────────
// `Auth` 原来**只能按 `jti` 撤** —— 也就是"只能撤我知道的那一个令牌"。
// 而注销要撤的是"**这个人签过的所有令牌**"（别处还登着的那些，我不知道它们的 `jti`）
// ⇒ 注销之后**老令牌还能用**（那是"假删除"）。
//
// ── 这一份钉四条 ──────────────────────────────────────────
//   1. 撤了之后，**那个人之前签的**令牌一律不认；
//   2. 🔴 **负向对照**：撤完**重新登进来**的令牌**必须能用**
//      （用 `<` 不用 `<=` —— 否则注销完就把人永久锁在门外了）；
//   3. 撤 A **不许**牵连 B；
//   4. **重启之后仍然不认**（落盘了才算数 —— 只在内存里的话，重启 = 被注销的人又活了）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { Auth } from '../src/auth.js';

function tmp() {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-revoke-'));
}

function authAt(dir) {
  const a = new Auth({ dataDir: dir });
  a.setPassword('test-pass'); // fail-closed：没口令时 `verify` 一律不认
  return a;
}

test('🔴 撤了之后：那个人**之前签的**令牌全不认', () => {
  const dir = tmp();
  const a = authAt(dir);
  const t1 = a.issue({ sub: 'u1' }).token;
  const t2 = a.issue({ sub: 'u1' }).token;
  assert.ok(a.verify(t1) && a.verify(t2), '撤之前两个都该认');

  a.revokeUser('u1');
  assert.equal(a.verify(t1), null, '🔴 老令牌必须不认');
  assert.equal(a.verify(t2), null, '🔴 另一个老令牌也必须不认');
});

test('★ **负向对照**：撤完**重新登进来**的令牌**能用**（不许把人永久锁在门外）', () => {
  const dir = tmp();
  const a = authAt(dir);
  const old = a.issue({ sub: 'u1' }).token;
  a.revokeUser('u1', { now: Date.now() });
  assert.equal(a.verify(old), null);

  // 撤销之后重新签发（`iat` 更大）
  const fresh = a.issue({ sub: 'u1' }).token;
  assert.ok(a.verify(fresh), '★ 重新登进来必须能用 —— 这一条错了就是"注销完进不来了"');
});

test('★ 撤 A **不牵连** B（负向对照：B 的令牌照常认）', () => {
  const dir = tmp();
  const a = authAt(dir);
  const tb = a.issue({ sub: 'u2' }).token;
  a.issue({ sub: 'u1' });
  a.revokeUser('u1');
  assert.ok(a.verify(tb), '★ 撤的是 u1，u2 不该受影响');
});

test('🔴 **落盘**：换一个进程（新 `Auth` 读同一个目录）也仍然不认', () => {
  const dir = tmp();
  const a = authAt(dir);
  const t = a.issue({ sub: 'u1' }).token;
  a.revokeUser('u1');
  assert.equal(a.revokedUserAt('u1') !== null, true);

  // ⚠️ 只在内存里的话，重启 = 被注销的人**又活了** —— 这条就是钉这个
  const b = new Auth({ dataDir: dir });
  assert.equal(b.verify(t), null, '🔴 重启之后也必须不认');
});

test('★ 没撤过的人：`revokedUserAt` 是空的（负向对照，证明上面不是空转）', () => {
  const dir = tmp();
  const a = authAt(dir);
  a.issue({ sub: 'u1' });
  assert.equal(a.revokedUserAt('u1'), null);
  assert.equal(a.revokedUserAt('nobody'), null);
});
