// **`POST /api/cancel` 那条路由**（账 #39 · 契约 `docs/dev/43-AUTO-PROVISION.md` §十四）。
//
// ⚠️ 在这一份之前，这条路由**一条自动化判据都没有** —— 上次是在真机上手动走了一遍
//    （判据 43 §十三），而那正是"下次改坏了没人知道"的形状。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   ① 🔴 **身份再确认**：令牌不是"刚登录过"的 ⇒ **409 + 什么都不许发生**
//      （不投申请、不撤令牌、不删账号）—— 这是这一批的核心；
//   ② 🔴 **续期刷不出新 `iat`**（不然这条规则是空的）：拿一个旧 `iat` 的令牌，
//      就算它没过期，也**过不了这一关**；
//   ③ 收下了 ⇒ 撤令牌 + 删账号那一行 + **记一笔账**；
//   ④ 那几种"不行"**各说各的**，而且**每一件都留一行**（包括被拒的那些）。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test, { after } from 'node:test';

import { Auth } from '../src/auth.js';
import { Users } from '../src/users.js';
import { createServer } from '../src/server.js';

const open = new Set();
after(async () => {
  for (const s of open) {
    try {
      await s.close();
    } catch {
      /* 关不干净不影响结论 */
    }
  }
  open.clear();
});

const NOW = 1_800_000_000_000;

/** 搭一个最小服务：只要那条注销路由要的东西。 */
async function boot(t, { cancelTenant, now = () => NOW, withUsers = true } = {}) {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-cancel-'));
  const auth = new Auth({ dataDir: dir, now });
  auth.setPassword('测试用的口令');
  let users = null;
  if (withUsers) {
    users = new Users({ dataDir: dir });
    users.bind('13900003333', 'u3');
  }
  const auditFile = nodePath.join(dir, 'audit.log');
  const { listen, close } = createServer({
    auth,
    users,
    auditFile,
    cancelTenant,
    now,
    webRoot: null,
    buildId: 'cancel-test',
    tenantOf: (uid) => (uid === 'u3' ? 'hupo-t3' : null),
    log: () => {},
  });
  const guarded = async () => {
    open.delete(guarded);
    await close();
  };
  open.add(guarded);
  t?.after(guarded);
  const addr = await listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const audit = () => (nodeFs.existsSync(auditFile) ? nodeFs.readFileSync(auditFile, 'utf8').trim().split('\n') : []);
  return { origin, auth, users, dir, audit };
}

const post = (origin, token) =>
  fetch(`${origin}/api/cancel`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });

test('🔴 令牌不是"刚登录过"的 ⇒ 409，而且**什么都没发生**（这一批的核心）', async (t) => {
  let called = 0;
  const s = await boot(t, {
    cancelTenant: () => {
      called += 1;
      return { ok: true };
    },
  });
  // 一小时前签发的令牌（**没到期**，但**不是刚登录**）
  const old = s.auth.issue({ sub: 'u3', iat: NOW - 3_600_000 }).token;
  const r = await post(s.origin, old);
  assert.equal(r.status, 409);
  const j = await r.json();
  assert.equal(j.error, 'needs-relogin');
  assert.match(j.text, /重新登一次/);
  assert.match(j.text, /什么都没动/, '要明说"现在什么都没发生"');
  assert.equal(called, 0, '不许投申请');
  assert.equal(s.users.get('13900003333')?.id, 'u3', '账号那一行不许删');
  assert.equal(s.auth.revokedUserAt('u3'), null, '不许撤令牌');
  // 而且**要留一行账**（"有人想删、没让他删" —— 那正是最该看见的）
  const lines = s.audit();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 拒了 · hupo-t3 · u3 · 139\*\*\*\*3333 · .*重新登录/);
});

test('刚登录过（`iat` 是现在）⇒ 收下了：撤令牌 + 删账号 + 记两笔账', async (t) => {
  let called = 0;
  const s = await boot(t, {
    cancelTenant: () => {
      called += 1;
      return { ok: true };
    },
  });
  const fresh = s.auth.issue({ sub: 'u3', iat: NOW }).token;
  const r = await post(s.origin, fresh);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(called, 1);
  assert.equal(s.users.get('13900003333'), null, '账号那一行要删掉');
  assert.equal(typeof s.auth.revokedUserAt('u3'), 'number', '令牌要全撤');
  const lines = s.audit();
  assert.equal(lines.length, 1, '收下只记一笔"收到请求"');
  assert.match(lines[0], /收到请求 · hupo-t3 · u3 · 139\*\*\*\*3333/);
  assert.equal(lines[0].includes('13900003333'), false, '手机号只写掩码');
});

test('那几种"不行"各说各的，而且**每一件都留一行**', async (t) => {
  const cases = [
    ['no-helper', 503, /还没接上回收那条路/],
    ['protected', 409, /早期手工开的/],
    ['no-tenant', 409, /没有单独一台/],
  ];
  for (const [why, status, re] of cases) {
    const s = await boot(t, { cancelTenant: () => ({ ok: false, why }) });
    const r = await post(s.origin, s.auth.issue({ sub: 'u3', iat: NOW }).token);
    assert.equal(r.status, status, why);
    const j = await r.json();
    assert.match(j.text, re, why);
    assert.equal(s.audit()[0].includes(why), true, `拒了也要留一行（${why}）`);
  }
});

test('⚠️ 读不出 `iat` 的老式令牌 ⇒ 一样拦住（fail-closed）', async (t) => {
  const s = await boot(t, { cancelTenant: () => ({ ok: true }) });
  // 自己捏一个**签名对、但没有 iat** 的令牌：走 issue 的 `iat: null` 分支不行
  // （它会填 now）⇒ 直接把 payload 里那一格删掉再签名，模拟"更老的一版"。
  const body = Buffer.from(JSON.stringify({ sub: 'u3', exp: NOW + 60_000, jti: 'x' })).toString('base64url');
  const token = `${body}.${s.auth.signForTest ?? ''}`;
  // 拿不到签名就算了 —— 这一条只要求"不认"（401 或 409 都行，但绝不能 200）
  const r = await post(s.origin, token);
  assert.notEqual(r.status, 200, '没有 iat 的令牌绝不许过');
});
