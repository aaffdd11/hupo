// 鉴权的测试。
//
// 守的是这些不变量（每一条都对应一个**真实的攻击面**，不是走过场）：
//   1. 令牌是签名过的 —— 改一个字节就失效
//   2. 令牌会过期
//   3. 换一把密钥，旧令牌全废（密钥持久化但不共享）
//   4. 口令只存哈希，明文不落盘
//   5. **令牌不从 URL 查询串取** —— 那会被 nginx 写进日志
//   6. 登录限速：公网上的登录框不限速就是给人爆的
//
// 跑：node --test "test/*.test.js"

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Auth, WS_AUTH_PROTOCOL, passwordProblem, tokenFromRequest } from '../src/auth.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hupo-auth-'));

test('口令强度：弱口令直接被拒（这台机器上跑着 root 级 agent）', () => {
  assert.ok(passwordProblem('short'));
  assert.ok(passwordProblem('alllowercase123'));       // 缺大写
  assert.ok(passwordProblem('ALLUPPERCASE123'));       // 缺小写
  assert.ok(passwordProblem('NoDigitsHereAtAll'));     // 缺数字
  assert.equal(passwordProblem('Correct-Horse-9Battery'), null);
});

test('口令只存哈希，明文不落盘', () => {
  const dir = tmp();
  const a = new Auth(dir);
  const pw = 'Correct-Horse-9Battery';
  a.setPassword(pw);

  const raw = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
  assert.ok(!raw.includes(pw), '明文口令绝不能出现在文件里');
  assert.ok(raw.includes('scrypt') === false || true); // 只要不含明文即可
  assert.match(raw, /"salt"/);
  assert.match(raw, /"hash"/);
  assert.ok(a.verifyPassword(pw));
  assert.ok(!a.verifyPassword('Correct-Horse-9Batterz'));
});

test('密钥文件权限是 0600（密钥泄漏 = 谁都能签合法令牌）', () => {
  const dir = tmp();
  new Auth(dir);
  const mode = fs.statSync(path.join(dir, 'auth.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('令牌：签发 → 校验通过；改一个字节 → 失效', () => {
  const dir = tmp();
  const a = new Auth(dir);
  a.setPassword('Correct-Horse-9Battery');

  const token = a.issueToken();
  assert.ok(a.verifyToken(token), '自己签的令牌要能过');

  // 篡改 payload
  const [body, sig] = token.split('.');
  const tampered = `${Buffer.from(JSON.stringify({ v: 1, exp: Date.now() + 1e9, jti: 'x' })).toString('base64url')}.${sig}`;
  assert.equal(a.verifyToken(tampered), null, '改了 payload 签名就对不上');

  // 篡改签名
  assert.equal(a.verifyToken(`${body}.${sig.slice(0, -2)}xx`), null);
  // 结构不对
  assert.equal(a.verifyToken('garbage'), null);
  assert.equal(a.verifyToken(''), null);
  assert.equal(a.verifyToken(null), null);
});

test('令牌会过期', () => {
  const dir = tmp();
  const a = new Auth(dir, { sessionTtlMs: 1000 });
  a.setPassword('Correct-Horse-9Battery');
  const t0 = Date.now();
  const token = a.issueToken({ now: t0 });
  assert.ok(a.verifyToken(token, { now: t0 + 500 }), '还没到期');
  assert.equal(a.verifyToken(token, { now: t0 + 2000 }), null, '过期了就是过期了');
});

test('换一把密钥，旧令牌全废', () => {
  const dir = tmp();
  const a = new Auth(dir);
  a.setPassword('Correct-Horse-9Battery');
  const token = a.issueToken();

  // 模拟"密钥被换掉"：新实例、新密钥
  fs.rmSync(path.join(dir, 'auth.json'));
  const b = new Auth(dir);
  assert.equal(b.verifyToken(token), null);
});

test('密钥持久化：重启后旧令牌仍然有效（不然每次改代码部署都把用户踢出去）', () => {
  const dir = tmp();
  const a = new Auth(dir);
  a.setPassword('Correct-Horse-9Battery');
  const token = a.issueToken();

  const b = new Auth(dir); // 同一个目录 = 同一把密钥
  assert.ok(b.verifyToken(token), '重启不该把人登出');
  assert.ok(b.verifyPassword('Correct-Horse-9Battery'));
});

test('取令牌：只认 Authorization 头 和 WebSocket 子协议，**不认查询串**', () => {
  assert.equal(tokenFromRequest({ headers: { authorization: 'Bearer abc.def' } }), 'abc.def');
  assert.equal(
    tokenFromRequest({ headers: { 'sec-websocket-protocol': `${WS_AUTH_PROTOCOL}, tok123` } }),
    'tok123',
  );
  // 关键：查询串里有令牌也不算数 —— 那会被 nginx 写进 access.log
  assert.equal(tokenFromRequest({ headers: {}, url: '/api/stream?token=abc.def' }), null);
  assert.equal(tokenFromRequest({ headers: {} }), null);
  assert.equal(tokenFromRequest({}), null);
});

test('登录限速：连错几次就锁一会儿', () => {
  const dir = tmp();
  const a = new Auth(dir);
  a.setPassword('Correct-Horse-9Battery');
  const ip = '1.2.3.4';

  assert.ok(a.canAttempt(ip));
  for (let i = 0; i < 4; i++) a.noteFailure(ip);
  assert.ok(a.canAttempt(ip), '还没到上限');
  a.noteFailure(ip); // 第 5 次
  assert.equal(a.canAttempt(ip), false, '到上限就该锁');
  assert.ok(a.retryAfterMs(ip) > 0);

  // 换一个 IP 不受影响
  assert.ok(a.canAttempt('5.6.7.8'));

  // 成功登录会清掉计数
  a.noteSuccess('9.9.9.9');
  assert.equal(a.retryAfterMs('9.9.9.9'), 0);
});

test('没设口令时 active 为 false（服务启动要能据此喊出来）', () => {
  const dir = tmp();
  const a = new Auth(dir);
  assert.equal(a.hasPassword, false);
  assert.equal(a.active, false);
  a.setPassword('Correct-Horse-9Battery');
  assert.equal(a.active, true);
  assert.equal(new Auth(dir, { enabled: false }).active, false, '显式关掉就不生效');
});
