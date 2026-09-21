// **一人一份世界**那条闸（多租户第二步 · 契约 `docs/dev/37-MULTITENANT.md` §三/§四）。
//
// 主人 2026-09-21 的原话是这一篇的判据来源：
//   > "应该进去又是一个独立的 copy 啊，**应该是一个空白的**。"
//
// 所以这里守三件事：
//   ① 🔴 **新用户是空白的** —— 他看不到任何别人的东西；
//   ② 🔴 **甲写的东西乙读不到**（**带负向对照**：甲自己读得到）；
//   ③ 🔴 **`owner` 那份原地不动** —— 主人已有的对话不许因为这次改造而搬家。
//   外加两条结构性的：**同一个用户两次拿到同一份**（不许每次新建）、
//   **userId 不许当路径使**（`../` 那类必须被挡）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { OWNER_ID, Tenants, safeUserId } from '../src/tenants.js';

function bench() {
  const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-tenants-'));
  const t = new Tenants({ dataDir });
  return { dataDir, t };
}

test('🔴 owner 的数据**原地不动**（还在 data/ 根下那条 main.jsonl）', () => {
  const { dataDir, t } = bench();
  const me = t.get(OWNER_ID);
  assert.equal(me.dir, dataDir, '★ owner 不许被迁到子目录里');
  assert.equal(me.store.pathFor('main'), nodePath.join(dataDir, 'main.jsonl'));
  assert.equal(me.fresh, false);
});

test('🔴 新用户 ⇒ 自己一格，而且是**空的**', () => {
  const { dataDir, t } = bench();
  const him = t.get('u9');
  assert.equal(him.dir, nodePath.join(dataDir, 'users', 'u9'));
  assert.equal(him.fresh, true, '★ 第一次来要是"全新的"（客户端要靠它说"正在给它安个家"）');
  assert.deepEqual(him.timeline ? him.store.readAll('main') : null, [], '★ 新号进去必须是空白的');
});

test('🔴 甲写的东西，乙读不到（带负向对照）', () => {
  const { t } = bench();
  const a = t.get('u1');
  const b = t.get('u2');
  a.timeline.emit({ type: 'user/echo', messageId: 'm_a', text: '甲的悄悄话' });

  // 负向对照：甲自己读得到（否则下面"乙读不到"可能只是根本没写进去）
  assert.equal(a.store.readAll('main').length, 1, '对照：甲自己那条要在');
  assert.equal(b.store.readAll('main').length, 0, '★ 乙的线里不许有甲的东西');
  // 盘上也是两份文件
  assert.ok(nodeFs.existsSync(nodePath.join(a.dir, 'main.jsonl')));
  assert.ok(!nodeFs.existsSync(nodePath.join(b.dir, 'main.jsonl')));
});

test('🔴 同一个用户两次拿到的是**同一份**（不许每次新建）', () => {
  const { t } = bench();
  const first = t.get('u1');
  first.timeline.emit({ type: 'user/echo', messageId: 'm1', text: '第一句' });
  const again = t.get('u1');
  assert.equal(again, first, '★ 必须是同一个对象（否则取号会从头开始、写进两条线）');
  assert.equal(again.timeline.seq, 1, '★ 号要接着数');
  assert.equal(t.size, 1);
});

test('🔴 取号是**各人各数**的（甲的 3 号不影响乙的 1 号）', () => {
  const { t } = bench();
  const a = t.get('u1');
  const b = t.get('u2');
  a.timeline.emit({ type: 'user/echo', messageId: 'a1' });
  a.timeline.emit({ type: 'user/echo', messageId: 'a2' });
  assert.equal(b.timeline.seq, 0, '★ 乙还没说过话，号就该是 0');
  b.timeline.emit({ type: 'user/echo', messageId: 'b1' });
  assert.equal(b.timeline.seq, 1);
  assert.equal(a.timeline.seq, 2, '甲的号不许被乙带跑');
});

test('🔴 userId 不许当路径使（`../` 那类必须被挡）', () => {
  const { t } = bench();
  for (const bad of ['../evil', 'a/b', '..', '', '有中文', null, 'x'.repeat(65)]) {
    assert.equal(safeUserId(bad), null, `这不该算 userId：${JSON.stringify(bad)}`);
    assert.throws(() => t.get(bad), /不能当目录名/, `这不该能取到世界：${bad}`);
  }
});

test('🔴 `dirFor` **自己**也要挡路径穿越（它是公开的，不能只靠 `get` 里那道）', () => {
  const { t } = bench();
  for (const bad of ['../evil', 'a/b', '..']) {
    assert.throws(() => t.dirFor(bad), /不能当目录名/, `dirFor 放过了：${bad}`);
  }
  // 正向对照：正常 id 它得给得出路径（否则上面那些"抛错"可能只是它什么都不认）
  assert.ok(t.dirFor('u1').endsWith(nodePath.join('users', 'u1')));
});

test('重启之后：新用户那一格还在（不因为重开进程就换地方）', () => {
  const { dataDir, t } = bench();
  t.get('u1').timeline.emit({ type: 'user/echo', messageId: 'm1', text: '说过的' });
  const again = new Tenants({ dataDir }); // 相当于重启
  const him = again.get('u1');
  assert.equal(him.fresh, false, '★ 回来过的人不是"全新的"');
  assert.equal(him.store.readAll('main').length, 1, '★ 他说过的话还在');
});

test('新用户那一格是 0700（别人的东西别人读不到）', () => {
  const { dataDir, t } = bench();
  t.get('u1');
  const dir = nodePath.join(dataDir, 'users', 'u1');
  assert.equal(nodeFs.statSync(dir).mode & 0o777, 0o700);
});

test('forget 只丢内存，不删盘上的东西', () => {
  const { t } = bench();
  const a = t.get('u1');
  a.timeline.emit({ type: 'user/echo', messageId: 'm1' });
  assert.equal(t.forget('u1'), true);
  assert.equal(t.size, 0);
  assert.equal(t.get('u1').store.readAll('main').length, 1, '★ 盘上的东西不许被顺手删掉');
});
