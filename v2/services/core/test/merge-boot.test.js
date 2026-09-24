// **T6：合并迁移必须与"盒子重开"绑在一起**（契约 `docs/dev/88-P1-TIME-WAIT.md` §四 T6）。
//
// 为什么这一条是硬约束（`00-PROGRESS.md` #123 的实测记录）：
//   `merge-scope-logs.mjs` 会把那条日志**重新编号**（main 120 条 ＋ scope 4 条
//   ⇒ 124 条连续）。而 `store.append` **只管写**，`seq` 是 `Timeline` **在内存里**
//   定的 ⇒ 盒子**跑着**的时候并，它下一条会从**旧号**起、与重编号后的号**撞**，
//   下次开机 `verifyMonotonic` 判非单调 —— 现场看起来只是"日志有点怪"。
//
// 这一份钉四条：
//   ① `isStoreHot`：锁活着 / `status.json` 在刷 ⇒ 热（**认不出 ⇒ 也算热**）。
//   ② **热状态合并 ⇒ 拒绝**（`--apply` 不带 `--at-boot` 也拒绝）—— 一个字节都不动。
//   ③ **撞号的四步现场**：并之前建的 `Timeline` 并完再 append ⇒ 非单调；并之后新建的 ⇒ 顺。
//   ④ `bootMergeIfPending`（开机幂等那一步）**可重跑**：第二次全 `skipped`。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';

import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';
import { isStoreHot, serveLockPath, writeServeLock } from '../src/serve-lock.js';
import {
  MAIN_LOG,
  bootMergeIfPending,
  mainLogPath,
  mergeScopeLogs,
  sha256hex,
} from '../../../../scripts/merge-scope-logs.mjs';

const tmp = () => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-t6-'));
const shaOf = (p) => sha256hex(nodeFs.readFileSync(p));

/** 旧布局：主线 ＋ 两个各自从 1 起编号的 scope 文件。 */
function makeOldLayout(dir = tmp()) {
  const main = [
    { type: 'user/echo', messageId: 'm1', text: '主线一', at: 1000, seq: 1 },
    { type: 'message/end', messageId: 'r1', reason: 'completed', at: 2000, seq: 2 },
  ];
  const alpha = [
    { type: 'user/echo', messageId: 'a1', text: '甲一', scopeId: 'alpha', at: 1500, seq: 1 },
    { type: 'message/text', messageId: 'ra', block: 'deep', text: '甲那半句', at: 2500, seq: 2 },
  ];
  const beta = [{ type: 'user/echo', messageId: 'b1', text: '乙一', scopeId: 'beta', at: 1200, seq: 1 }];
  const write = (name, evs) =>
    nodeFs.writeFileSync(nodePath.join(dir, name), evs.map((e) => `${JSON.stringify(e)}\n`).join(''));
  write(MAIN_LOG, main);
  write('scope-alpha.jsonl', alpha);
  write('scope-beta.jsonl', beta);
  return { dir, main, alpha, beta };
}

test('T6① `isStoreHot`：锁活着 / 状态在刷 ⇒ 热；**读不懂 ⇒ 也当热**（宁可不并）', () => {
  const dir = tmp();
  // 冷：什么都没有
  assert.equal(isStoreHot(dir).hot, false);
  // 热：锁在、pid 活着
  writeServeLock(dir, { pid: process.pid });
  assert.equal(isStoreHot(dir).hot, true);
  assert.match(isStoreHot(dir).why, /serve\.lock/);
  nodeFs.unlinkSync(serveLockPath(dir));
  // 热：状态文件还在刷
  nodeFs.writeFileSync(nodePath.join(dir, 'status.json'), `${JSON.stringify({ busy: true, updatedAt: Date.now() })}\n`);
  assert.equal(isStoreHot(dir).hot, true);
  // 冷：状态文件已经陈了（服务可能已经不在了）
  nodeFs.writeFileSync(
    nodePath.join(dir, 'status.json'),
    `${JSON.stringify({ busy: true, updatedAt: Date.now() - 60_000 })}\n`,
  );
  assert.equal(isStoreHot(dir).hot, false);
  // ⚠️ 认不出（坏文件）⇒ **当热**（拒绝并最多晚一步；撞号是永久坏一条日志）
  nodeFs.writeFileSync(nodePath.join(dir, 'status.json'), '这不是 JSON');
  assert.equal(isStoreHot(dir).hot, true);
});

test('T6② **热状态合并 ⇒ 拒绝**：`--apply` 不带 `--at-boot` 也拒绝（一个字节都不动）', () => {
  const { dir } = makeOldLayout();
  const before = shaOf(mainLogPath(dir));

  // 反例一：真并、但**不是开机那一步** ⇒ 拒绝
  const hot1 = mergeScopeLogs({ dir, apply: true, hot: false });
  assert.match(hot1.refused ?? '', /--at-boot|重开/);
  assert.equal(shaOf(mainLogPath(dir)), before, '拒绝了就不许动那条日志');
  assert.equal(nodeFs.existsSync(nodePath.join(dir, 'scope-alpha.jsonl')), true, '旧文件也不许动');

  // 反例二：声明了开机、可是数据目录**还在跑** ⇒ 拒绝
  const hot2 = mergeScopeLogs({ dir, apply: true, atBoot: true, hot: true });
  assert.match(hot2.refused ?? '', /还在跑|撞号/);
  assert.equal(shaOf(mainLogPath(dir)), before, '热的时候一个字节都不许动');

  // 正对照：冷 ＋ 开机那一步 ⇒ 真并成功
  const ok = mergeScopeLogs({ dir, apply: true, atBoot: true, hot: false });
  assert.equal(ok.refused, null);
  assert.equal(ok.merged.length, 2);
  assert.notEqual(shaOf(mainLogPath(dir)), before, '并成功了（正对照）');
  new Store({ dataDir: dir, fsync: false }).verifyMonotonic('main');

  // dry-run **不受影响**（看计划本来就不动盘）
  const { dir: dir2 } = makeOldLayout();
  const dry = mergeScopeLogs({ dir: dir2, hot: true });
  assert.equal(dry.refused, null);
  assert.equal(dry.merged.length, 2, 'dry-run 照旧给计划');
});

test('T6③ **撞号的四步现场**：并之前建的时间线并完再写 ⇒ 非单调；并之后新建的 ⇒ 顺', () => {
  const dir = tmp();
  const store = new Store({ dataDir: dir, fsync: false });
  // ① 先有三条事件（服务在跑）
  const t1 = new Timeline({ id: 'main', store });
  t1.emit({ type: 'user/echo', messageId: 'x1', text: '一' });
  t1.emit({ type: 'user/echo', messageId: 'x2', text: '二' });
  t1.emit({ type: 'user/echo', messageId: 'x3', text: '三' });
  assert.equal(t1.seq, 3);

  // ② **并之前**落一份 scope 文件（旧布局）
  nodeFs.writeFileSync(
    nodePath.join(dir, 'scope-alpha.jsonl'),
    `${JSON.stringify({ type: 'user/echo', messageId: 'a1', text: '甲', scopeId: 'alpha', at: 0, seq: 1 })}\n`,
  );

  // ③ 热并（强行走 `planMerge` 那一步：把号重编成 1..4）
  const report = mergeScopeLogs({ dir, apply: true, atBoot: true, hot: false });
  assert.equal(report.refused, null);
  assert.equal(report.counts.after, 4, `并完 4 条：${JSON.stringify(report.counts)}`);
  assert.ok(report.numberChangesTotal > 0, '一定有号变了');

  // ④ **那个还活着的 `Timeline`** 再写一条 ⇒ 从旧号 3 起 ⇒ 第 4 条写 4
  //    （而盘上第 4 条已经是 4 了）⇒ `verifyMonotonic` 判非单调。
  //    ⚠️ 这就是 #123 那一段"合并必须与重开绑在一起"的**可执行复现**。
  t1.emit({ type: 'user/echo', messageId: 'x4', text: '四' });
  assert.throws(
    () => store.verifyMonotonic('main'),
    /编号不连续/,
    '🔴 热并之后再从旧号写 ⇒ 必撞（所以热并不许做）',
  );

  // 正对照：**并之后新建**的那把时间线从"已落盘最大"取号 ⇒ 顺
  const dir2 = tmp();
  const store2 = new Store({ dataDir: dir2, fsync: false });
  const a = new Timeline({ id: 'main', store: store2 });
  a.emit({ type: 'user/echo', messageId: 'y1', text: '一' });
  a.emit({ type: 'user/echo', messageId: 'y2', text: '二' });
  nodeFs.writeFileSync(
    nodePath.join(dir2, 'scope-alpha.jsonl'),
    `${JSON.stringify({ type: 'user/echo', messageId: 'b1', text: '乙', scopeId: 'alpha', at: 0, seq: 1 })}\n`,
  );
  mergeScopeLogs({ dir: dir2, apply: true, atBoot: true, hot: false });
  const fresh = new Timeline({ id: 'main', store: store2 }); // ← 重开之后才建
  fresh.emit({ type: 'user/echo', messageId: 'y3', text: '三' });
  store2.verifyMonotonic('main'); // 不抛 ⇒ 顺
});

test('T6④ 开机幂等那一步：第一次并、第二次全 skipped（可重跑）', () => {
  const { dir } = makeOldLayout();
  const first = bootMergeIfPending({ dir });
  assert.equal(first.refused, null);
  assert.equal(first.merged.length, 2);
  const after = shaOf(mainLogPath(dir));
  const second = bootMergeIfPending({ dir });
  assert.equal(second.merged.length, 0, JSON.stringify(second));
  assert.equal(shaOf(mainLogPath(dir)), after, '第二次一个字节都不许动');
  // 已经是"一条线"了（幂等）
  new Store({ dataDir: dir, fsync: false }).verifyMonotonic('main');
});
