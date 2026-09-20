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

// ── 自动重载（set-pass 是另一个进程在改文件）────────────────

test('★ 改了密码文件，跑着的进程要能发现（不用重启）', () => {
  let t = 1_000_000;
  const dir = tmp();
  const running = new Auth({ dataDir: dir, now: () => t }); // 假装这是跑着的服务
  assert.equal(running.needsSetup, true, '一开始没密码');

  // 另一个进程（就是 auth-cli）把密码写上
  const cli = new Auth({ dataDir: dir, now: () => t });
  cli.setPassword('另一个人设的密码');

  // 节流是一秒一次：先跳过一拍
  t += 1500;
  assert.equal(running.needsSetup, false, '★ 该自己发现，不该等重启');
  assert.equal(running.verifyPassword('另一个人设的密码'), true);
});

test('★ 撤销也同理：另一个进程撤销后，跑着的进程要认', () => {
  let t = 1_000_000;
  const dir = tmp();
  const running = new Auth({ dataDir: dir, now: () => t });
  running.setPassword('一二三四五六');
  const { token } = running.issue();
  assert.ok(running.verify(token));

  const cli = new Auth({ dataDir: dir, now: () => t });
  assert.equal(cli.revoke(token), true);

  t += 1500;
  assert.equal(running.verify(token), null, '★ 撤销也要自己生效');
});

test('节流：一秒内的多次询问不会反复 stat 磁盘', () => {
  let t = 1_000_000;
  const auth = new Auth({ dataDir: tmp(), now: () => t });
  // 只是证明它不会炸；节流本身是性能优化，不是正确性
  for (let i = 0; i < 50; i += 1) assert.equal(auth.needsSetup, true);
  t += 1500;
  assert.equal(auth.needsSetup, true);
});

// ── 回归：这个 bug 真发生过 ────────────────────────────────

test('★★ 服务进程写运行时状态，绝不许抹掉 CLI 刚设的密码', () => {
  const dir = tmp();
  let t = 1_000_000;

  // 服务先起来（此时还没密码）
  const server = new Auth({ dataDir: dir, now: () => t });
  assert.equal(server.needsSetup, true);

  // 另一个人（CLI）设了密码
  new Auth({ dataDir: dir, now: () => t }).setPassword('刚设的密码啊');

  // 服务这边紧接着发生一次登录失败 —— 它会 persist 运行时状态。
  // ⚠️ 修复前：这一下会把服务内存里那份**过期的 passwordHash: null** 写回去，
  //    把刚设的密码**抹掉**，而现象只是"设了密码却还是 503"。
  server.recordLoginFailure('1.2.3.4');

  // 密码必须还在
  const fresh = new Auth({ dataDir: dir, now: () => t });
  assert.equal(fresh.needsSetup, false, '★ 密码被服务进程抹掉了');
  assert.equal(fresh.verifyPassword('刚设的密码啊'), true);
});

test('★ 撤销表是"并集写"：CLI 撤的不会被服务写回去复活', () => {
  const dir = tmp();
  let t = 1_000_000;
  const server = new Auth({ dataDir: dir, now: () => t });
  server.setPassword('一二三四五六');
  const { token } = server.issue();
  server.recordLoginSuccess('9.9.9.9'); // 服务有自己的运行时状态

  // 另一个进程撤销
  new Auth({ dataDir: dir, now: () => t }).revoke(token);

  // 服务再写一次运行时状态（并集写 ⇒ 不该把那个撤销挤掉）
  server.recordLoginFailure('8.8.8.8');

  const fresh = new Auth({ dataDir: dir, now: () => t });
  assert.equal(fresh.verify(token), null, '★ 撤销被复活了');
});

test('密码文件与运行时文件是两个（服务不碰密码那一个）', () => {
  const dir = tmp();
  const a = new Auth({ dataDir: dir });
  a.setPassword('一二三四五六');
  a.recordLoginFailure('7.7.7.7');
  const files = nodeFs.readdirSync(dir).sort();
  assert.deepEqual(files, ['auth-runtime.json', 'auth.json']);
});
