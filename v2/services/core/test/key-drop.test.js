// **本机投递一把钥匙**（契约 `docs/dev/46-KEY-DELIVERY.md` §三.2）——
// 认名字、读文件、送到才删、认不出留证据。
//
// ⚠️ 这一组里最要紧的两条：
//   · **认不出的一律拒绝并留证据**（那里面可能是一把真钥匙，静默删掉就是丢东西）；
//   · **送到才删**（中心内存不落盘 ⇒ "读到就删"会在宿主重启时把没送到的弄丢）。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';
import { DROP_SUFFIX, REJECT_DIR, checkKeyText, createKeyDrop, resolveDropName } from '../src/key-drop.js';

const tmp = () => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-drop-'));

/** 一台假机器：两台容器 + 三个号。 */
const WORLD = {
  tenantNames: ['hupo-a', 'hupo-b'],
  userIdOfTenant: (t) => ({ 'hupo-a': 'u1', 'hupo-b': 'u2' })[t] ?? null,
  tenantOfUser: (u) => ({ u1: 'hupo-a', u2: 'hupo-b', u9: null })[u] ?? null,
  userIdOfPhone: (p) => ({ 13800000000: 'u1', 13900000000: 'u2' })[p] ?? null,
};
const R = (name) => resolveDropName(name, WORLD);

test('认三种名字：租户名 / 编号 / 登记过的手机号', () => {
  assert.deepEqual(R('hupo-a.key'), { ok: true, how: 'tenant', userId: 'u1', tenant: 'hupo-a' });
  assert.deepEqual(R('u2.key'), { ok: true, how: 'user', userId: 'u2', tenant: 'hupo-b' });
  assert.deepEqual(R('13800000000.key'), { ok: true, how: 'phone', userId: 'u1', tenant: 'hupo-a' });
});

test('🔴 认不出的一律拒绝，而且**说清是哪种认不出**（调用方要据此留证据）', () => {
  // 带路径（穿越）
  for (const bad of ['../hupo-a.key', 'x/hupo-a.key', '..\\hupo-a.key']) {
    const r = R(bad);
    assert.equal(r.ok, false, bad);
  }
  // 没有后缀 / 后缀不对
  assert.match(R('hupo-a').why, /后缀/);
  assert.match(R('hupo-a.txt').why, /后缀/);
  // 隐藏文件（`.` 开头）不当投递
  assert.equal(R('.hidden.key').ok, false);
  assert.equal(R('.key').ok, false);
  // 名字里有不认识的字符
  assert.match(R('hupo a.key').why, /字符/);
  // 认不出的名字 / 没登记的手机号：**理由要分开**（一个指"换个名字"，一个指"先让他登录一次"）
  assert.match(R('nobody.key').why, /认不出这是谁/);
  assert.match(R('13700000000.key').why, /还没登记过/);
  // 「像手机号但没登记」**不许**顺手建一个新号
  assert.equal(R('13700000000.key').ok, false);
});

test('钥匙文本：空的 / 不可打印的 / 超长一律拒；好的放行', () => {
  assert.equal(checkKeyText('').ok, false);
  assert.equal(checkKeyText('   ').ok, false);
  assert.equal(checkKeyText('sk-abc\u0007def').ok, false, '控制字符');
  assert.equal(checkKeyText('sk-中文').ok, false, '非 ASCII');
  assert.equal(checkKeyText('x'.repeat(5000)).ok, false, '太长');
  assert.deepEqual(checkKeyText('  sk-abc123  '), { ok: true, key: 'sk-abc123' }, '两头空白要去掉');
});

test('🔴 送到才删：那一台还没说"我拿到了"之前，文件**必须还在**', () => {
  const dir = tmp();
  nodeFs.writeFileSync(nodePath.join(dir, `hupo-a${DROP_SUFFIX}`), 'sk-realkey\n');
  const delivered = [];
  const d = createKeyDrop({
    dir,
    deliver: (uid, key) => {
      delivered.push([uid, key]);
      return { ok: true, pushed: 1 };
    },
    resolve: R,
    pollMs: 100000, // 手动 tick，不引真定时器
  });
  d.tick();
  assert.deepEqual(delivered, [['u1', 'sk-realkey']], '认出来了、也推了（两头的空白去掉）');
  assert.ok(nodeFs.existsSync(nodePath.join(dir, `hupo-a${DROP_SUFFIX}`)), '**还没确认就不能删**');
  d.confirmed('u1');
  assert.equal(nodeFs.existsSync(nodePath.join(dir, `hupo-a${DROP_SUFFIX}`)), false, '它说拿到了 ⇒ 这时才删');
});

test('⚠️ 那台连不上 ⇒ 文件留着，而且下回还接着试', () => {
  const dir = tmp();
  const p = nodePath.join(dir, `hupo-b${DROP_SUFFIX}`);
  nodeFs.writeFileSync(p, 'sk-x');
  let tries = 0;
  const d = createKeyDrop({
    dir,
    deliver: () => {
      tries += 1;
      return { ok: false, why: '那一台现在不通' };
    },
    resolve: R,
    pollMs: 100000,
  });
  d.tick();
  d.tick();
  assert.equal(tries, 2, '没送到就得接着试');
  assert.ok(nodeFs.existsSync(p), '文件不许删（中心内存不落盘 ⇒ 删了就真丢了）');
});

test('🔴 认不出的**挪走留证据**，不许静默删掉', () => {
  const dir = tmp();
  const bad = nodePath.join(dir, 'whatever.key');
  nodeFs.writeFileSync(bad, 'sk-x');
  const logs = [];
  const d = createKeyDrop({ dir, deliver: () => ({ ok: true }), resolve: R, log: (m) => logs.push(m), pollMs: 100000 });
  d.tick();
  assert.equal(nodeFs.existsSync(bad), false, '原位置没有了');
  assert.ok(nodeFs.existsSync(nodePath.join(dir, REJECT_DIR, 'whatever.key')), '但它在 .rejected/ 里原样躺着');
  assert.ok(logs.some((l) => l.includes('认不出')), '而且要说出为什么');
});

test('⚠️ 认得出、但里面不是一把钥匙 ⇒ 也挪走留证据（别当成"没看见"）', () => {
  const dir = tmp();
  nodeFs.writeFileSync(nodePath.join(dir, `hupo-a${DROP_SUFFIX}`), '这不是钥匙\u0007');
  let delivered = 0;
  const d = createKeyDrop({ dir, deliver: () => { delivered += 1; return { ok: true }; }, resolve: R, pollMs: 100000 });
  d.tick();
  assert.equal(delivered, 0, '不许把垃圾当钥匙推给容器');
  assert.ok(nodeFs.existsSync(nodePath.join(dir, REJECT_DIR, `hupo-a${DROP_SUFFIX}`)));
});

test('等回执期间**不刷屏**（每次扫都催不是本事）', () => {
  const dir = tmp();
  nodeFs.writeFileSync(nodePath.join(dir, `hupo-a${DROP_SUFFIX}`), 'sk-x');
  let n = 0;
  const d = createKeyDrop({ dir, deliver: () => { n += 1; return { ok: true, pushed: 1 }; }, resolve: R, pollMs: 100000, repushMs: 30000 });
  d.tick(1000);
  d.tick(2000);
  d.tick(3000);
  assert.equal(n, 1, '还没到重试点，就别催');
});

test('🔴 等不到回执要**有界重试**（不然推送丢在重连/容器重建那一下，就永远等下去了）', () => {
  // ⚠️ 2026-09-21 真机当场栽的：第一次推送时那一台还在旧代码上（写进了 tmpfs），
  //    而"送过就算数"的写法把它记成已推送 ⇒ 文件不删、钥匙不进容器、谁都不报错。
  const dir = tmp();
  nodeFs.writeFileSync(nodePath.join(dir, `hupo-b${DROP_SUFFIX}`), 'sk-y');
  let n = 0;
  const logs = [];
  const d = createKeyDrop({
    dir,
    deliver: () => { n += 1; return { ok: true, pushed: 1 }; },
    resolve: R,
    log: (m) => logs.push(m),
    pollMs: 100000,
    repushMs: 30000,
  });
  d.tick(1000);
  assert.equal(n, 1);
  d.tick(20000);
  assert.equal(n, 1, '没到 30 秒不催');
  d.tick(32000);
  assert.equal(n, 2, '到点再送一次');
  assert.ok(logs.some((l) => l.includes('又送了一次')), '而且要说出来');
  const w = d.waitingFor;
  assert.equal(w.length, 1);
  assert.equal(w[0].tries, 2);
  assert.ok(nodeFs.existsSync(nodePath.join(dir, `hupo-b${DROP_SUFFIX}`)), '还是没删（它没确认）');
});
