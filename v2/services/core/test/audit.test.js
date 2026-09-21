// **给主人看的那一笔账**（账 #39 的后一半 · `src/audit.js`）。
//
// ⚠️ 这一行**是要给人读的**（主人一眼看出"谁把哪一台收掉了"），所以三条要钉死：
//   ① 形状固定（时间 · 事件 · 租户 · 用户 · 掩码手机 · 说明）——
//      **特权侧（shell）写的是同一个形状**，判据里有一条跨产物的闸比它；
//   ② **手机号只写掩码**（`139****3333`），拿不到就写 `—`；
//   ③ **钥匙一个字符都不许有**（它压根不该出现在这条路上）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { AUDIT_FILE, auditLine, auditPath, maskPhone, stamp } from '../src/audit.js';

test('形状固定：`[时间] 事件 · 租户 · 用户 · 手机 · 说明`', () => {
  const line = auditLine({
    at: new Date(2026, 8, 22, 3, 7, 5).getTime(),
    what: '收到请求',
    tenant: 'hupo-t3',
    userId: 'u3',
    phone: '13900003333',
    detail: '已投给特权侧，等它真收',
  });
  assert.equal(line, '[2026-09-22 03:07:05] 收到请求 · hupo-t3 · u3 · 139****3333 · 已投给特权侧，等它真收');
  assert.ok(!line.includes('\n'), '一行就是一行');
});

test('🔴 手机号只写掩码；拿不到就写 `—`（不许拿别的东西冒充）', () => {
  assert.equal(maskPhone('13900003333'), '139****3333');
  assert.equal(maskPhone(''), '—');
  assert.equal(maskPhone(null), '—');
  assert.equal(maskPhone('12345'), '—', '太短的不当手机号');
  assert.equal(maskPhone('u3'), '—', '用户 id 不是手机号');
  const l = auditLine({ what: '拒了', userId: 'u3', detail: 'unknown' });
  assert.ok(!l.includes('13900003333'), '原文绝不出现');
  assert.match(l, / · — · /, '拿不到就 —');
});

test('缺字段一律写 `—`（不许出现 `undefined` / `null` 这种字）', () => {
  const l = auditLine({ what: '拒了', detail: null });
  assert.equal(l.includes('undefined'), false);
  assert.equal(l.includes('null'), false);
  assert.match(l, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 拒了 · — · — · — · —$/);
});

test('没给 what ⇒ **当场报错**（不许悄悄写一行没头没脑的账）', () => {
  assert.throws(() => auditLine({ detail: 'x' }), /what/);
});

test('时间戳是本地墙上时间（主人看的那个钟）', () => {
  const at = new Date(2026, 0, 2, 9, 8, 7).getTime();
  assert.equal(stamp(at), '2026-01-02 09:08:07');
});

test('审计文件放在数据目录里，名字只有一处出处', () => {
  assert.equal(AUDIT_FILE, 'audit.log');
  assert.equal(auditPath('/x/y'), '/x/y/audit.log');
});

test('🔴 钥匙一个字符都不许进这一行（负向对照：塞进去就应该被看得见）', () => {
  const clean = auditLine({ what: '收到请求', userId: 'u3', detail: '已投给特权侧' });
  assert.equal(/sk-[A-Za-z0-9]{8,}/.test(clean), false);
  // 负向对照：真的塞一个进去 ⇒ 那个检查器抓得住（不然上面那条是空转）
  const dirty = auditLine({ what: '收到请求', userId: 'u3', detail: 'key=sk-abcdefgh1234' });
  assert.equal(/sk-[A-Za-z0-9]{8,}/.test(dirty), true);
});
