// 认证的验收 —— 手册 `08-SPEC.md` §15.5「鉴权九条」

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { Auth, PUBLIC_ROUTES, clientIp, tokenFromRequest } from '../src/auth.js';

function tmp() {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-auth-'));
}

test('★ fail-closed：没设口令时，任何令牌都不认', () => {
  const auth = new Auth({ dataDir: tmp() });
  assert.equal(auth.needsSetup, true);
  assert.equal(auth.verify('随便什么'), null);
  assert.equal(auth.verifyPassword('随便什么'), false);
  assert.throws(() => auth.issue(), /还没设口令/);
});

test('★ 公开路由只有三个（加任何一个都要问一句"它真的必须公开吗"）', () => {
  assert.deepEqual([...PUBLIC_ROUTES], ['/api/version', '/api/auth', '/api/login']);
});

test('口令：scrypt 加盐，验得对、验错拒', () => {
  const auth = new Auth({ dataDir: tmp() });
  auth.setPassword('正确的密码啦');
  assert.equal(auth.needsSetup, false);
  assert.equal(auth.verifyPassword('正确的密码啦'), true);
  assert.equal(auth.verifyPassword('错的'), false);
});

test('口令哈希两次不一样（有盐）', () => {
  const a = Auth.hashPassword('同一个密码');
  const b = Auth.hashPassword('同一个密码');
  assert.notEqual(a, b);
  assert.match(a, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
});

test('口令太短要拒，且报出实际位数', () => {
  const auth = new Auth({ dataDir: tmp() });
  assert.throws(() => auth.setPassword('123'), /太短.*3 位/);
});

test('口令长度按码点数：一个 emoji 算一位，不是两位', () => {
  const auth = new Auth({ dataDir: tmp() });
  // 5 个 emoji = 5 个码点（UTF-16 长度是 10）⇒ 仍该被拒
  assert.throws(() => auth.setPassword('🔒🔒🔒🔒🔒'), /太短.*5 位/);
  auth.setPassword('🔒🔒🔒🔒🔒🔒');
  assert.equal(auth.verifyPassword('🔒🔒🔒🔒🔒🔒'), true);
});

test('令牌：签发 → 验过', () => {
  const auth = new Auth({ dataDir: tmp() });
  auth.setPassword('正确的密码啦');
  const { token, sub } = auth.issue({ sub: 'owner' });
  const claim = auth.verify(token);
  assert.ok(claim);
  assert.equal(claim.sub, 'owner');
  assert.equal(sub, 'owner');
});

test('令牌：改一个字节就失效', () => {
  const auth = new Auth({ dataDir: tmp() });
  auth.setPassword('正确的密码啦');
  const { token } = auth.issue();
  const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
  assert.equal(auth.verify(tampered), null);
});

test('令牌：过期就不认', () => {
  let t = 1_000_000;
  const auth = new Auth({ dataDir: tmp(), now: () => t, tokenTtlMs: 1000 });
  auth.setPassword('正确的密码啦');
  const { token } = auth.issue();
  assert.ok(auth.verify(token));
  t += 1001;
  assert.equal(auth.verify(token), null);
});

test('★ 撤销表独立落盘，重启后仍失效', () => {
  const dir = tmp();
  const auth = new Auth({ dataDir: dir });
  auth.setPassword('正确的密码啦');
  const { token } = auth.issue();
  assert.ok(auth.verify(token));
  assert.equal(auth.revoke(token), true);
  assert.equal(auth.verify(token), null);

  const restarted = new Auth({ dataDir: dir });
  assert.equal(restarted.verify(token), null, '重启后撤销必须还在');
});

test('★ 登录失败计数落盘，重启不清零', () => {
  const dir = tmp();
  const auth = new Auth({ dataDir: dir, lockAfter: 3, lockMs: 60_000 });
  auth.setPassword('正确的密码啦');
  auth.recordLoginFailure('1.2.3.4');
  auth.recordLoginFailure('1.2.3.4');
  assert.equal(auth.isLocked('1.2.3.4'), false, '两次还没到阈值');
  auth.recordLoginFailure('1.2.3.4');
  assert.equal(auth.isLocked('1.2.3.4'), true, '第三次该锁');

  const restarted = new Auth({ dataDir: dir, lockAfter: 3, lockMs: 60_000 });
  assert.equal(restarted.isLocked('1.2.3.4'), true, '重启后锁定必须还在');
});

test('锁定到期自动解除，且剩余时间可算（D2：要给剩余时间）', () => {
  let t = 1000;
  const auth = new Auth({ dataDir: tmp(), now: () => t, lockAfter: 1, lockMs: 60_000 });
  auth.setPassword('正确的密码啦');
  auth.recordLoginFailure('1.2.3.4');
  assert.equal(auth.isLocked('1.2.3.4'), true);
  assert.equal(auth.lockRemainingMs('1.2.3.4'), 60_000);
  t += 60_001;
  assert.equal(auth.isLocked('1.2.3.4'), false);
  assert.equal(auth.lockRemainingMs('1.2.3.4'), 0);
});

test('登录成功清掉失败计数', () => {
  const auth = new Auth({ dataDir: tmp(), lockAfter: 3 });
  auth.setPassword('正确的密码啦');
  auth.recordLoginFailure('1.2.3.4');
  auth.recordLoginFailure('1.2.3.4');
  auth.recordLoginSuccess('1.2.3.4');
  auth.recordLoginFailure('1.2.3.4');
  assert.equal(auth.isLocked('1.2.3.4'), false);
});

test('审计只记事实：{at, result, ip}，不含口令也不含令牌', () => {
  const auth = new Auth({ dataDir: tmp() });
  auth.setPassword('正确的密码啦');
  auth.recordLoginFailure('9.9.9.9');
  auth.recordLoginSuccess('9.9.9.9');
  const log = auth.auditLog;
  assert.equal(log.length, 2);
  assert.deepEqual(Object.keys(log[0]).sort(), ['at', 'ip', 'result']);
  assert.equal(log[0].result, 'fail');
  assert.equal(log[1].result, 'ok');
  const text = JSON.stringify(log);
  assert.doesNotMatch(text, /正确的密码/);
});

test('auth.json 坏了要抛，不许悄悄新建（那会作废所有人的登录态）', () => {
  const dir = tmp();
  nodeFs.writeFileSync(nodePath.join(dir, 'auth.json'), '{坏的');
  assert.throws(() => new Auth({ dataDir: dir }), /auth.json 读不了或坏了/);
});

// ── XFF：取最后一跳 ───────────────────────────────────────

test('★ XFF 取最后一跳（取第一跳会被一个 HTTP 头绕过限速）', () => {
  const req = {
    headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' },
    socket: { remoteAddress: '127.0.0.1' },
  };
  assert.equal(clientIp(req), '3.3.3.3');
});

test('XFF 只有一跳时就用它', () => {
  const req = { headers: { 'x-forwarded-for': '9.9.9.9' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientIp(req), '9.9.9.9');
});

test('没有 XFF 时退回 socket 地址', () => {
  const req = { headers: {}, socket: { remoteAddress: '10.0.0.5' } };
  assert.equal(clientIp(req), '10.0.0.5');
});

// ── 令牌来源 ──────────────────────────────────────────────

test('★ 令牌从 Authorization 头取', () => {
  assert.equal(tokenFromRequest({ headers: { authorization: 'Bearer abc.def' } }), 'abc.def');
  assert.equal(tokenFromRequest({ headers: { authorization: 'bearer abc.def' } }), 'abc.def');
});

test('★ 令牌**绝不**从 URL 取（URL 会进日志、进 Referer、进浏览器历史）', () => {
  const req = { headers: {}, url: '/api/say?token=abc.def' };
  assert.equal(tokenFromRequest(req), null);
});
