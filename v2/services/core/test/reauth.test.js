// **"这一步要你重新登一次"**（账 #39 的前一半 · `src/reauth.js`）。
//
// ⚠️ 这一条防的是：**一个被盗的令牌就能删掉一个人所有的东西**（而注销不可逆）。
//    所以判据要盯两头：① 刚登录过 ⇒ 放行；② 旧令牌 ⇒ 拦住 —— 而且
//    **续期不许把 `iat` 刷新**（不然这条规则是空的：攻击者续一次期就绕过去了）。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import test from 'node:test';
import { DEFAULT_REAUTH_WINDOW_MS, reauthOk } from '../src/reauth.js';

const NOW = 1_800_000_000_000;

test('刚登录过 ⇒ 放行；过了窗口 ⇒ 拦住', () => {
  assert.equal(reauthOk({ iat: NOW, now: NOW }), true);
  assert.equal(reauthOk({ iat: NOW - DEFAULT_REAUTH_WINDOW_MS, now: NOW }), true, '正好在窗口边上');
  assert.equal(reauthOk({ iat: NOW - DEFAULT_REAUTH_WINDOW_MS - 1, now: NOW }), false, '过了一毫秒就不行');
  assert.equal(reauthOk({ iat: NOW - 86_400_000, now: NOW }), false, '一天前登录的 ⇒ 请重登');
});

test('🔴 fail-closed：读不出 `iat` / 窗口配坏 ⇒ **一律不放行**', () => {
  for (const bad of [undefined, null, NaN, '1000', {}]) {
    assert.equal(reauthOk({ iat: bad, now: NOW }), false, String(bad));
  }
  assert.equal(reauthOk({ iat: NOW, now: NOW, windowMs: 0 }), false);
  assert.equal(reauthOk({ iat: NOW, now: NOW, windowMs: -1 }), false);
  assert.equal(reauthOk({}), false);
});

test('⚠️ `iat` 在未来（时钟偏差）**按"刚刚签发"算** —— 不然用户会卡在重登里出不来', () => {
  assert.equal(reauthOk({ iat: NOW + 5000, now: NOW }), true);
});

test('🔴 续期**不许**刷新 `iat`（这条要是反的，整条规则就是空的）', () => {
  // ⚠️ 为什么钉"代码形状"而不是跑一遍：`renew()` 的语义是"**同一个 `iat`、只把 `exp` 往前挪**"，
  //    而这条语义正是 reauth 规则的地基 —— 它一变，这里就该红。
  //    （真跑一遍也行，但那要一个能签发的 Auth；形状这一条更直接、也不依赖别的。）
  const src = nodeFs.readFileSync(new URL('../src/auth.js', import.meta.url), 'utf8');
  assert.match(
    src,
    /renew\(token\)[\s\S]{0,600}?issue\(\{ sub: payload\.sub, iat, jti: payload\.jti \}\)/,
    '续期必须把**原来的** `iat` 传回去（否则旧令牌续一次期就能绕过"再确认"）',
  );
  assert.ok(
    !/renew\(token\)[\s\S]{0,600}?issue\(\{ sub: payload\.sub, jti: payload\.jti \}\)/.test(src),
    '不许出现"不传 iat"的那种写法（那等于把 iat 刷成现在）',
  );
});
