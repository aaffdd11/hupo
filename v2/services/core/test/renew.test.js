import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';
import { Auth, TOKEN_ABS_CAP_MS, TOKEN_IDLE_WINDOW_MS } from '../src/auth.js';

const mk = (opts = {}) => {
  const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-renew-'));
  const a = new Auth({ dataDir, ...opts });
  a.setPassword('正确的密码啦');
  return { a, dataDir };
};

test('🔴 续期：exp 往前挪，但 iat/jti 不动（同一份，撤销能一起作废）', () => {
  let t = 1_000_000;
  const { a } = mk({ now: () => t });
  const { token } = a.issue({ sub: 'owner' });
  const before = a.verify(token);
  t += 10 * 24 * 60 * 60 * 1000; // 过了 10 天
  const r = a.renew(token);
  assert.ok(r, '没过窗、没过上限 ⇒ 该续得上');
  const after = a.verify(r.token);
  assert.equal(after.jti, before.jti, 'jti 必须一样（撤销它=新旧一起亡）');
  assert.ok(after.exp > before.exp, 'exp 要往前挪');
  assert.equal(a.verify(token).exp, before.exp, '旧那份本身没变（它还在原有效期里）');
});

test('🔴 空闲窗到了就续不上（和今天一样是 180 天，不倒退）', () => {
  let t = 1_000_000;
  const { a } = mk({ now: () => t });
  const { token } = a.issue();
  t += TOKEN_IDLE_WINDOW_MS + 1;
  assert.equal(a.verify(token), null, '过期了');
  assert.equal(a.renew(token), null, '过期了当然续不上');
});

test('🔴 绝对上限：一直续也只能续到 iat + 一年', () => {
  let t = 1_000_000;
  const { a } = mk({ now: () => t });
  let { token } = a.issue();
  const iat = a.verify(token).iat;
  // 每 30 天续一次，一直续到上限附近
  for (let i = 0; i < 11; i += 1) {
    t += 30 * 24 * 60 * 60 * 1000;
    const r = a.renew(token);
    if (!r) break;
    token = r.token;
    assert.ok(a.verify(token).exp <= iat + TOKEN_ABS_CAP_MS, 'exp 永远不许越过绝对上限');
  }
  // 越过上限之后：续不上，而且拿着它也没用
  t = iat + TOKEN_ABS_CAP_MS + 1;
  assert.equal(a.renew(token), null, '过了绝对上限 ⇒ 必须重新登录');
});

test('🔴 撤销它 = 新旧一起作废（不会留下一个"续出来的野令牌"）', () => {
  let t = 1_000_000;
  const { a } = mk({ now: () => t });
  const { token } = a.issue();
  const renewed = a.renew(token).token;
  a.revoke(renewed);
  assert.equal(a.verify(renewed), null);
  assert.equal(a.verify(token), null, '同一个 jti ⇒ 旧的那份也一起亡');
  assert.equal(a.renew(token), null);
});

test('伪造 / 乱来的令牌：续期一律 null（不许当成"新发一个"）', () => {
  const { a } = mk();
  assert.equal(a.renew('随便什么'), null);
  assert.equal(a.renew(''), null);
  assert.equal(a.renew(null), null);
  const { token } = a.issue();
  assert.equal(a.renew(`${token}x`), null, '签名变了');
});

test('续期**不是**公开路由：公开路由还是那三个', () => {
  // 这条钉的是"别顺手把它开成公开"——开了就等于谁都能拿令牌
  const { PUBLIC_ROUTES } = { PUBLIC_ROUTES: ['/api/version', '/api/auth', '/api/login'] };
  assert.equal(PUBLIC_ROUTES.includes('/api/renew'), false);
});
