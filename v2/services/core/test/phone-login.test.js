// **手机号 + 验证码**那条登录路（多租户第一步 · 契约 `docs/dev/37-MULTITENANT.md` §三/§六）。
//
// 这一篇守四件事，每一件都是"错了就会出人命"的那一类：
//   ① 🔴 **临时码关着 ⇒ 任何码都进不去**（默认就是关的）；
//   ② 🔴 **新手机号 = 新用户**（"新手机号它就会新开一台容器"的第一步）；
//   ③ 🔴 **老手机号还是**同一个人**（不许每次登录都发一个新身份）；
//   ④ 🔴 **手机号不许落进日志**（它是个人信息）—— 只许出现脱敏形态。
//
// ⚠️ 口令那条老路**仍然在**（`server.test.js` 里守着）—— 这一篇只管新那条。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { Auth } from '../src/auth.js';
import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';
import { SayService } from '../src/say.js';
import { Users, maskPhone, normalizePhone } from '../src/users.js';
import { createServer } from '../src/server.js';

const PHONE_A = '13800000001';
const PHONE_B = '13900000002';

const dirs = [];
after(() => {
  for (const d of dirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});

async function boot({ devCode = '', log = () => {} } = {}) {
  const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-phone-'));
  dirs.push(dataDir);
  const store = new Store({ dataDir, fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const auth = new Auth({ dataDir });
  auth.setPassword('这台机器的口令'); // ⚠️ 口令仍然是"这台机器设过没有"的那道闸
  const users = new Users({ dataDir });
  const say = new SayService({ timeline, store, timelineId: 'main' });
  const { listen, close } = createServer({
    timeline, store, auth, say, users, devCode, buildId: 't', log,
  });
  const addr = await listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  return { origin, dataDir, users, auth, close };
}

const login = async (origin, body) => {
  const r = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

// ── 纯函数 ───────────────────────────────────────────────────

test('手机号：只认 11 位的大陆号；脱敏只露前三后四', () => {
  assert.equal(normalizePhone('13800000001'), '13800000001');
  assert.equal(normalizePhone('138 0000 0001'), '13800000001');
  assert.equal(normalizePhone('138-0000-0001'), '13800000001');
  for (const bad of ['1380000000', '23800000001', '11000000000', '', 'abc', null]) {
    assert.equal(normalizePhone(bad), null, `这不该算手机号：${bad}`);
  }
  // ⚠️ 脱敏：中间四位打码 —— 日志里只许出现这个形态
  assert.equal(maskPhone(PHONE_A), '138****0001');
});

// ── ① 关着的时候，谁都进不去 ─────────────────────────────────

test('🔴 临时码**没开** ⇒ 503「还没接短信」，而且**不许**建用户', async () => {
  const s = await boot({ devCode: '' });
  try {
    const r = await login(s.origin, { phone: PHONE_A, code: '123456' });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'no-sms');
    assert.equal(s.users.size, 0, '★ 进不去就不该建用户');
  } finally {
    await s.close();
  }
});

test('🔴 开着但码不对 ⇒ 401，而且**不许**建用户', async () => {
  const s = await boot({ devCode: '123456' });
  try {
    const r = await login(s.origin, { phone: PHONE_A, code: '000000' });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'bad-code');
    assert.equal(s.users.size, 0);
  } finally {
    await s.close();
  }
});

test('手机号不像手机号 ⇒ 400（不是 500，也不是"码错了"）', async () => {
  const s = await boot({ devCode: '123456' });
  try {
    const r = await login(s.origin, { phone: '12345', code: '123456' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'bad-phone');
  } finally {
    await s.close();
  }
});

// ── ②③ 新号建人、老号还是他 ─────────────────────────────────

test('🔴 新手机号 ⇒ 建一个新用户，而且令牌里的 sub 就是它', async () => {
  const s = await boot({ devCode: '123456' });
  try {
    const r = await login(s.origin, { phone: PHONE_A, code: '123456' });
    assert.equal(r.status, 200);
    assert.equal(r.body.isNew, true, '★ 第一次进来要是"新用户"（客户端要靠它提示建容器）');
    assert.match(r.body.token, /\./);
    const claim = s.auth.verify(r.body.token);
    assert.ok(claim, '令牌要验得过');
    assert.notEqual(claim.sub, 'owner', '★ 不许再硬写 owner（那是单用户时代的写法）');
    assert.equal(claim.sub, s.users.get(PHONE_A).id);
  } finally {
    await s.close();
  }
});

test('🔴 同一个手机号第二次 ⇒ **还是同一个人**（不换身份）', async () => {
  const s = await boot({ devCode: '123456' });
  try {
    const first = await login(s.origin, { phone: PHONE_A, code: '123456' });
    const second = await login(s.origin, { phone: PHONE_A, code: '123456' });
    assert.equal(second.body.isNew, false);
    assert.equal(
      s.auth.verify(second.body.token).sub,
      s.auth.verify(first.body.token).sub,
      '★ 同一个号两次登录必须是同一个 sub（否则每次进来都是新容器）',
    );
    assert.equal(s.users.size, 1);
  } finally {
    await s.close();
  }
});

test('两个手机号 ⇒ 两个用户，id 不一样', async () => {
  const s = await boot({ devCode: '123456' });
  try {
    await login(s.origin, { phone: PHONE_A, code: '123456' });
    await login(s.origin, { phone: PHONE_B, code: '123456' });
    assert.equal(s.users.size, 2);
    assert.notEqual(s.users.get(PHONE_A).id, s.users.get(PHONE_B).id);
  } finally {
    await s.close();
  }
});

// ── ④ 手机号是个人信息 ───────────────────────────────────────

test('🔴 用户表 0600；而且 `users.json` 里的手机号**不脱敏**（它必须能查）', async () => {
  const s = await boot({ devCode: '123456' });
  try {
    await login(s.origin, { phone: PHONE_A, code: '123456' });
    const file = nodePath.join(s.dataDir, 'users.json');
    assert.equal(nodeFs.statSync(file).mode & 0o777, 0o600, '★ 里面是手机号 ⇒ 只有本人能读');
    assert.ok(nodeFs.readFileSync(file, 'utf8').includes(PHONE_A));
  } finally {
    await s.close();
  }
});

test('⚠️ 日志里**不许**出现完整手机号（只许脱敏形态）', async () => {
  const lines = [];
  const s = await boot({ devCode: '123456', log: (m) => lines.push(String(m)) });
  try {
    await login(s.origin, { phone: PHONE_A, code: '123456' });
    const all = lines.join('\n');
    assert.ok(!all.includes(PHONE_A), `日志里出现了完整手机号：${all.slice(0, 200)}`);
  } finally {
    await s.close();
  }
});

// ── 老那条路还在 ─────────────────────────────────────────────

test('口令那条老路**没被踢开**（老客户端还在用）', async () => {
  const s = await boot({ devCode: '123456' });
  try {
    const r = await login(s.origin, { password: '这台机器的口令' });
    assert.equal(r.status, 200);
    assert.equal(s.auth.verify(r.body.token).sub, 'owner');
  } finally {
    await s.close();
  }
});
