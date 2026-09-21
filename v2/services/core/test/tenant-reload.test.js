// **"该重开了"**（契约 `docs/dev/45-TENANT-UPDATE.md` §三）——
// 容器这一侧那个决定：**什么时候**退。
//
// ⚠️ 这一组最容易做错的两头，都在下面各有一条：
//   · 退得太早 ⇒ **切掉正在说的那一轮**（这条功能唯一要防的事）；
//   · 认得太早 ⇒ **开机死循环**（还没报到就退，宿主手上还挂着上一轮的"重开"）。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';
import { createReloader } from '../src/tenant-reload.mjs';

const tmp = () => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-reload-'));

/** 夹具：注入时钟 + 一个能随时改写的 `status.json` + 记下"退了没有"。 */
function fixture({ busy = false, stale = false, missing = false, text = null, maxWaitMs = 180_000 } = {}) {
  const dir = tmp();
  const file = nodePath.join(dir, 'status.json');
  const state = { now: 1_000_000 };
  const exited = [];
  const logs = [];
  const write = (o = {}) => {
    const b = o.busy ?? busy;
    if (missing) {
      try {
        nodeFs.unlinkSync(file);
      } catch {
        /* 本来就不在 */
      }
      return;
    }
    if (text !== null) {
      nodeFs.writeFileSync(file, text);
      return;
    }
    const updatedAt = (o.stale ?? stale) ? state.now - 60_000 : state.now;
    nodeFs.writeFileSync(
      file,
      JSON.stringify({ busy: b, openMessageId: b ? 'm1' : null, pending: 0, turns: 0, updatedAt }),
    );
  };
  write();
  const r = createReloader({
    statusFile: file,
    exit: (code) => exited.push(code),
    log: (m) => logs.push(m),
    now: () => state.now,
    pollMs: 1,
    maxWaitMs,
  });
  return { r, state, exited, logs, write, file };
}

test('🔴 还没跟宿主报过到 ⇒ **不认**这句话（不这么写就是开机死循环）', () => {
  const f = fixture();
  assert.equal(f.r.please(), false);
  assert.deepEqual(f.exited, [], '一开机就退 ⇒ 退完又报、报完又叫，永远起不来');
  assert.ok(f.logs.some((l) => l.includes('还没跟它报过到')), '要说清为什么不认');
});

test('报过到了、手上也没话 ⇒ 立刻退（`exit(0)`：成功退出，靠单元 `Restart=always` 拉回来）', () => {
  const f = fixture({ busy: false });
  f.r.arm();
  assert.equal(f.r.please(), true);
  assert.deepEqual(f.exited, [0]);
  assert.ok(f.logs.some((l) => l.includes('没有没说完的话')));
});

test('🔴 手上还有话 ⇒ **不退**，等它说完', () => {
  const f = fixture({ busy: true });
  f.r.arm();
  f.r.please();
  assert.deepEqual(f.exited, [], '它正在说 —— 这时候退就是把那一轮切了');
  assert.ok(f.logs.some((l) => l.includes('等手上这轮说完')));
  // 说完了 ⇒ 下一拍就退（把状态改成"不忙"，再敲一次时钟）
  f.write({ busy: false });
  f.r.please(); // 已经在等的时候再叫一次**不该**重置任何东西
  assert.deepEqual(f.exited, [], '定时器还没跑到那就不能退（真实机器上是 1 秒一拍）');
});

test('⚠️ 状态是**陈的**（服务可能已经死了）⇒ 不等 —— 等一个死掉的服务比切一轮话更坏', () => {
  const f = fixture({ busy: true, stale: true });
  f.r.arm();
  f.r.please();
  assert.deepEqual(f.exited, [0]);
});

test('⚠️ 状态文件**不在** ⇒ 不忙（那个服务还没写过它）⇒ 退', () => {
  const f = fixture({ missing: true });
  f.r.arm();
  f.r.please();
  assert.deepEqual(f.exited, [0]);
});

test('⚠️ 状态**读不懂** ⇒ 照这个项目的既有规矩"不知道就不等"（`shouldWait` 定的）⇒ 退', () => {
  // ⚠️ 这一条是**跟既有的 `turn-status.js` 对齐**，不是我另立一套：
  //    `readStatus` 读不懂返回 `null`，`shouldWait` 对 `null` 明说"不等"。
  //    理由在那一份里写着：等一个已经不在的服务，比切一轮话更坏。
  const f = fixture({ text: '{这不是 JSON' });
  f.r.arm();
  f.r.please();
  assert.deepEqual(f.exited, [0]);
});

test('⚠️ 一直忙 ⇒ **到上限照样退**（不然这一台永远在旧代码上）', () => {
  const f = fixture({ busy: true, maxWaitMs: 0 });
  f.r.arm();
  f.r.please();
  assert.deepEqual(f.exited, [0]);
  assert.ok(f.logs.some((l) => l.includes('等太久')));
});

test('重复叫它重开 ⇒ 只认一次（宿主每次重连都会说一遍，别攒成一串）', () => {
  const f = fixture({ busy: true });
  f.r.arm();
  assert.equal(f.r.please(), true);
  assert.equal(f.r.please(), false, '第二次该说"已经在等了"');
});

test('没给它状态文件路径 ⇒ **当场报错**（不许悄悄什么都不做）', () => {
  assert.throws(() => createReloader({}), /statusFile/);
});

// ── 顺带钉住"钥匙在不在"那条看门（契约 `46-KEY-DELIVERY.md` §四）──────

test('🔴 基线是"最后报给宿主的那句话"，不是"第一拍看到的样子"', async () => {
  const { keyPresenceChanged } = await import('../src/tenant-tunnel-agent.mjs');
  const fake = (exists) => ({ existsSync: () => exists });
  // 还没报到 ⇒ 不比（等 announce 自己记上）
  assert.deepEqual(keyPresenceChanged({ announced: null, fs: fake(true) }), { changed: false, now: true });
  // 报过"没有"、现在有了 ⇒ 要提示
  assert.deepEqual(keyPresenceChanged({ announced: false, fs: fake(true) }), { changed: true, now: true });
  // 报过"有"、现在还在 ⇒ 不提示（别刷屏）
  assert.deepEqual(keyPresenceChanged({ announced: true, fs: fake(true) }), { changed: false, now: true });
  // 报过"有"、现在没了 ⇒ 要提示
  assert.deepEqual(keyPresenceChanged({ announced: true, fs: fake(false) }), { changed: true, now: false });
  // ⚠️ 真机栽过的那个形状：钥匙在"报到"和"第一拍"之间出现 ——
  //    拿"第一拍"当基线就会算成"没变"，于是**永远不提示宿主**（页面一直说没有钥匙）。
  assert.equal(keyPresenceChanged({ announced: false, fs: fake(true) }).changed, true);
});
