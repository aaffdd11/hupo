// 进程级兜底 —— 对应手册 `08-SPEC.md` §5.2 第 3 层与 §11.1：
//   「用**不落盘的通知通道**发一条人话，然后**有界退出**」
//   「5 分钟内 ≥3 次启动 且 有 oom-kill ⇒ 降级；连续 10 分钟无崩溃才恢复」

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Timeline } from '../src/timeline.js';
import { Store } from '../src/store.js';
import {
  CrashLoopGuard,
  HUMAN_LINES,
  installProcessGuard,
} from '../src/process-guard.js';
import { collector, failingFs, tempTimeline } from './helpers.js';

function withGuard({ fs = null } = {}) {
  const store = fs ? new Store({ dataDir: '/nowhere', fs, fsync: false }) : tempTimeline().store;
  const timeline = new Timeline({ id: 'main', store });
  const c = collector();
  timeline.subscribe(c.fn);

  const exits = [];
  const logs = [];
  const uninstall = installProcessGuard({
    timeline,
    exit: (code) => exits.push(code),
    log: (...a) => logs.push(a.join(' ')),
  });
  const fire = (kind, err) => {
    const handlers = process.listeners(kind);
    handlers.at(-1)(err);
  };
  return { timeline, c, exits, logs, uninstall, fire };
}

test('★ 未捕获异常 ⇒ 发一条人话（瞬态）+ 退出', () => {
  const { c, exits, uninstall, fire } = withGuard();
  fire('uncaughtException', new Error('炸了'));
  uninstall();

  const notice = c.got.find((e) => e.type === 'error');
  assert.ok(notice, '必须发出一条通知');
  assert.equal(notice.seq, undefined, '⚠️ 通知必须走瞬态——不落盘，盘满时才发得出去');
  assert.equal(notice.text, HUMAN_LINES.generic);
  assert.deepEqual(exits, [1], '必须有界退出');
});

test('★ unhandledRejection 也接', () => {
  const { c, exits, uninstall, fire } = withGuard();
  fire('unhandledRejection', new Error('promise 没接住'));
  uninstall();
  assert.ok(c.got.some((e) => e.type === 'error'));
  assert.deepEqual(exits, [1]);
});

test('★ 盘满的错要用"可能没记下来"那句（用户能做的事不一样）', () => {
  const { c, uninstall, fire } = withGuard();
  fire('uncaughtException', new Error('ENOSPC: no space left on device'));
  uninstall();
  assert.equal(c.got.find((e) => e.type === 'error').text, HUMAN_LINES.disk);
  assert.match(HUMAN_LINES.disk, /可能没记下来/);
});

test('★ 盘满时通知仍能发出去（因为瞬态不写盘）', () => {
  const { c, exits, uninstall, fire } = withGuard({ fs: failingFs() });
  fire('uncaughtException', new Error('落盘失败（main）：ENOSPC'));
  uninstall();
  assert.ok(c.got.some((e) => e.type === 'error'), '盘满时通知必须仍出得去');
  assert.deepEqual(exits, [1]);
});

test('★ 连通知都发不出去，也必须退出（不许卡住）', () => {
  const timeline = {
    emitTransient() {
      throw new Error('通知通道也炸了');
    },
  };
  const exits = [];
  const uninstall = installProcessGuard({
    timeline,
    exit: (code) => exits.push(code),
    log: () => {},
  });
  process.listeners('uncaughtException').at(-1)(new Error('双炸'));
  uninstall();
  assert.deepEqual(exits, [1]);
});

test('卸载之后不再接管', () => {
  const { exits, uninstall, fire } = withGuard();
  uninstall();
  const before = process.listeners('uncaughtException').length;
  assert.equal(process.listeners('uncaughtException').length, before);
  assert.deepEqual(exits, []);
  assert.equal(typeof fire, 'function');
});

test('★ 崩溃环：连续重启 + OOM ⇒ 降级；否则不降级', () => {
  const g = new CrashLoopGuard({ windowMs: 60_000, threshold: 3 });
  assert.equal(g.recordStart({ oomKilledLastRun: true }), false, '第 1 次不该降级');
  assert.equal(g.recordStart({ oomKilledLastRun: true }), false, '第 2 次不该降级');
  assert.equal(g.recordStart({ oomKilledLastRun: true }), true, '第 3 次且 OOM ⇒ 降级');
  assert.equal(g.degraded, true);
});

test('★ 崩溃环：有重启但没有 OOM ⇒ 不降级', () => {
  const g = new CrashLoopGuard({ windowMs: 60_000, threshold: 3 });
  g.recordStart({ oomKilledLastRun: false });
  g.recordStart({ oomKilledLastRun: false });
  assert.equal(g.recordStart({ oomKilledLastRun: false }), false);
});

test('★ 崩溃环：窗口滑出去之后重新计数', () => {
  let t = 0;
  const g = new CrashLoopGuard({ windowMs: 60_000, threshold: 3, now: () => t });
  g.recordStart({ oomKilledLastRun: true });
  g.recordStart({ oomKilledLastRun: true });
  t = 10 * 60_000; // 十分钟后
  assert.equal(g.recordStart({ oomKilledLastRun: true }), false, '旧的启动记录该滑出去了');
});

test('★ 恢复：连续无崩溃够久 ⇒ 解除降级', () => {
  let t = 0;
  const g = new CrashLoopGuard({ windowMs: 60_000, threshold: 2, now: () => t });
  g.recordStart({ oomKilledLastRun: true });
  g.recordStart({ oomKilledLastRun: true });
  assert.equal(g.degraded, true);

  assert.equal(g.recordHealthy(10 * 60_000), true, '还没到点，仍降级');
  t = 11 * 60_000;
  assert.equal(g.recordHealthy(10 * 60_000), false, '够久了，恢复');
});

test('降级那句话是人话，且不推卸（原文照抄）', () => {
  assert.equal(
    HUMAN_LINES.degraded,
    '刚才我连着重启了几次，先把手上这件事放一放，你现在说什么我都接。',
  );
});
