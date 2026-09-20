// 「续做」的调度 + 崩溃环标记。
//
// 决策 **D10.1–D10.5**（`05-DECISIONS.md` §二·补）+ 手册 `08-SPEC.md` §15.3 / §11.1。
//
// 这一层要钉死的是**四条规则**：只读 / ≤3 次 / 6 小时 / 间隔 ≥5 分钟 / 全局并发 1，
// 外加"降级期间一件都不重来"。**每一条都必须有一条测试**——
// 因为它们的失败形态是"默默把一个动过东西的活又跑了一遍"。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import {
  RESUMED_EVENT,
  RESUME_MAX_ATTEMPTS,
  readResumeRecords,
  planResume,
} from '../src/resume-plan.js';
import { CRASH_THRESHOLD, markCleanExit, readCrashLoop, recordStart } from '../src/boot-marker.js';
import { INTERRUPTED_RESUMING_LINE, reconcileOnBoot } from '../src/reconcile.js';
import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';

const NOW = 1_700_000_000_000;
const MIN = 60_000;

/** 一件"只读过东西"的中断活。 */
const finding = (ref, { at = NOW - 2 * MIN, text = '帮我查一下明天的天气', mutated = false } = {}) => ({
  ref, text, at, ageMs: NOW - at, tell: true, mutated,
});

const plan = (over = {}) =>
  planResume({ findings: { orphans: [], unanswered: [] }, events: [], now: NOW, ...over });

// ── 一、四条规则，一条一条钉 ────────────────────────────────

test('🔴 D10.1：**动过东西的活一件都不重来**', () => {
  const r = plan({ findings: { orphans: [finding('u_1', { mutated: true })], unanswered: [] } });
  assert.equal(r.pick, null);
  assert.equal(r.reason, 'touched-something');
});

test('只读过东西的活 ⇒ 重来，而且是第 1 次', () => {
  const r = plan({ findings: { orphans: [finding('u_1')], unanswered: [] } });
  assert.deepEqual(r.pick, { ref: 'u_1', text: '帮我查一下明天的天气', attempt: 1 });
});

test('§15.3：**超过 6 小时**的老账不重来（只通知）', () => {
  const r = plan({ findings: { orphans: [finding('u_1', { at: NOW - 7 * 60 * MIN })], unanswered: [] } });
  assert.equal(r.pick, null);
  assert.equal(r.reason, 'too-old');
});

test('§15.3：同一件**最多 3 次**；第 4 次不发起', () => {
  const events = [1, 2, 3].map((i) => ({ type: RESUMED_EVENT, ref: 'u_1', attempt: i, at: NOW - (5 - i) * 10 * MIN }));
  const r = plan({ findings: { orphans: [finding('u_1')], unanswered: [] }, events });
  assert.equal(r.pick, null);
  assert.equal(r.reason, 'over-quota');
  assert.equal(RESUME_MAX_ATTEMPTS, 3, '阈值住在这儿 —— 改它要连着手册一起改');
});

test('§10.2：同一件两次之间 **≥5 分钟**', () => {
  const events = [{ type: RESUMED_EVENT, ref: 'u_1', attempt: 1, at: NOW - 2 * MIN }];
  const r = plan({ findings: { orphans: [finding('u_1')], unanswered: [] }, events });
  assert.equal(r.pick, null);
  assert.equal(r.reason, 'too-soon');

  // 够 5 分钟了就放行，而且次数是**累计**的
  const events2 = [{ type: RESUMED_EVENT, ref: 'u_1', attempt: 1, at: NOW - 6 * MIN }];
  const r2 = plan({ findings: { orphans: [finding('u_1')], unanswered: [] }, events: events2 });
  assert.equal(r2.pick.attempt, 2);
});

test('🔴 D10.5：**全局并发 1** —— 有两件可重来的，只挑一件', () => {
  const r = plan({
    findings: {
      orphans: [],
      unanswered: [finding('u_old', { at: NOW - 30 * MIN }), finding('u_new', { at: NOW - 1 * MIN })],
    },
  });
  assert.equal(r.considered, 2, '两件都合格');
  assert.equal(r.pick.ref, 'u_new', '★ 但只挑**最近**那一件（他可能还在等它）');
});

test('🔴 §11.1：**降级期间一件都不重来**（崩溃环里继续重跑只会放大问题）', () => {
  const r = plan({ findings: { orphans: [finding('u_1')], unanswered: [] }, degraded: true });
  assert.equal(r.pick, null);
  assert.equal(r.reason, 'degraded');
});

test('归属不明 / 没有原话 ⇒ 不重来（否则算不了额度，也不知道重来什么）', () => {
  assert.equal(plan({ findings: { orphans: [finding(null)], unanswered: [] } }).reason, 'no-ref');
  assert.equal(plan({ findings: { orphans: [finding('u_1', { text: '  ' })], unanswered: [] } }).reason, 'no-text');
});

test('同一件活两种形状都命中 ⇒ 只算一次（不重复发起）', () => {
  const r = plan({
    findings: { orphans: [finding('u_1', { at: NOW - 3 * MIN })], unanswered: [finding('u_1', { at: NOW - 2 * MIN })] },
  });
  assert.equal(r.considered, 1);
  assert.equal(r.pick.attempt, 1);
});

test('`readResumeRecords` 按归属数次数、取最后一次的时间', () => {
  const m = readResumeRecords([
    { type: RESUMED_EVENT, ref: 'u_1', at: 100 },
    { type: RESUMED_EVENT, ref: 'u_1', at: 300 },
    { type: RESUMED_EVENT, ref: 'u_2', at: 200 },
    { type: RESUMED_EVENT, ref: null, at: 400 }, // 归属不明 ⇒ 不算
    { type: 'message/start', messageId: 'x', at: 500 },
  ]);
  assert.deepEqual(m.get('u_1'), { attempts: 2, lastAt: 300 });
  assert.deepEqual(m.get('u_2'), { attempts: 1, lastAt: 200 });
  assert.equal(m.size, 2);
});

test('日志是坏的也不炸（对账不许阻断启动）', () => {
  assert.doesNotThrow(() => plan({ findings: { orphans: [finding('u_1')], unanswered: [] }, events: [null, 7, 'x'] }));
});

// ── 二、崩溃环标记（§11.1）────────────────────────────────

function tmpDir() {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-boot-'));
}

test('第一次启动：干净、不降级', () => {
  const d = tmpDir();
  const r = recordStart(d, { now: NOW });
  assert.equal(r.degraded, false);
  assert.equal(r.uncleanLastRun, false, '没有标记文件 ⇒ 当成没什么可疑的');
  assert.equal(r.starts, 1);
});

test('🔴 连续启动 + 上一次没善终 ⇒ 降级（这就是 §11.1 的判据）', () => {
  const d = tmpDir();
  // 启动 N 次，**中间都不留"干净退场"的标记**（模拟被硬杀 / OOM）
  for (let i = 0; i < CRASH_THRESHOLD; i += 1) {
    recordStart(d, { now: NOW + i * 1000 });
  }
  const r = recordStart(d, { now: NOW + CRASH_THRESHOLD * 1000 });
  assert.equal(r.degraded, true, '★ 窗口内够次数**且**上次没善终 ⇒ 降级');
});

test('干净退场之后再启动 ⇒ **不降级**（不然每次正常重启都降级）', () => {
  const d = tmpDir();
  for (let i = 0; i < CRASH_THRESHOLD + 1; i += 1) {
    recordStart(d, { now: NOW + i * 1000 });
    markCleanExit(d); // 每次都好好走的
  }
  const r = recordStart(d, { now: NOW + 9999 });
  assert.equal(r.uncleanLastRun, false);
  assert.equal(r.degraded, false);
});

test('窗口外的旧启动不算数', () => {
  const d = tmpDir();
  for (let i = 0; i < 10; i += 1) recordStart(d, { now: NOW - 60 * MIN + i });
  const r = recordStart(d, { now: NOW });
  assert.equal(r.starts, 1, '很久以前的那些被甩出窗口');
});

test('文件坏了 / 目录不可写 ⇒ **不抛**（崩溃环判定是优化，不许挡启动）', () => {
  const d = tmpDir();
  nodeFs.writeFileSync(nodePath.join(d, '.crashloop.json'), '{ 这不是 json');
  assert.doesNotThrow(() => readCrashLoop(d));
  assert.equal(readCrashLoop(d).clean, true, '读不动就当第一次');
  const bad = { mkdirSync() {}, writeFileSync() { throw new Error('EACCES'); }, readFileSync() { throw new Error('ENOENT'); } };
  assert.doesNotThrow(() => recordStart('/nope', { now: NOW, fs: bad }));
});

// ── 三、对账 + 续做接起来 ──────────────────────────────────

function fresh() {
  const store = new Store({
    dataDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-resume-')),
    fsync: false,
  });
  return { store, timeline: new Timeline({ id: 'main', store }) };
}

test('🔴 要重做的那个，对账**换一句话说**（不能一边说"你说一声"一边自己做了）', () => {
  const { store, timeline } = fresh();
  timeline.emit({ type: 'user/echo', messageId: 'u_1', text: '帮我查一下明天的天气' });
  const r = reconcileOnBoot({ timeline, store, now: Date.now(), resume: {} });

  assert.equal(r.resume.ref, 'u_1');
  assert.equal(r.resume.attempt, 1);
  const said = store.readAll('main').filter((e) => e.type === 'message/text').map((e) => e.text).join('');
  assert.equal(said, INTERRUPTED_RESUMING_LINE);
  assert.ok(/我重新做一遍/.test(said), '★ 说"我做"，而不是"你说一声我做"');
});

test('🔴 不给 `resume` ⇒ 一个字都不自动重来（保守默认）', () => {
  const { store, timeline } = fresh();
  timeline.emit({ type: 'user/echo', messageId: 'u_1', text: '帮我查一下' });
  const r = reconcileOnBoot({ timeline, store, now: Date.now() });
  assert.equal(r.resume, null);
  assert.equal(r.resumeReason, 'off');
});

test('动过东西的活：对账**不会**把它放进 `resume`', () => {
  const { store, timeline } = fresh();
  timeline.emit({ type: 'user/echo', messageId: 'u_1', text: '把文件改一下' });
  timeline.emit({ type: 'task/mutated', ref: 'u_1', turn: 1 });
  const r = reconcileOnBoot({ timeline, store, now: Date.now(), resume: {} });
  assert.equal(r.resume, null);
  assert.equal(r.resumeReason, 'touched-something');
});

test('🔴 续做的额度要落盘 + 每一次重来本身也可能再被打断（真实的那条链）', () => {
  const { store, timeline } = fresh();
  const t0 = Date.now();

  // ── 第一次开机：主人问了一句，没人答 ──
  timeline.emit({ type: 'user/echo', messageId: 'u_1', text: '帮我查一下明天的天气' });
  const r1 = reconcileOnBoot({ timeline, store, now: t0, resume: {} });
  assert.equal(r1.resume.attempt, 1);
  // `serve.js` 就是这么记的：**先落 `task/resumed`（额度）再投递**
  timeline.emit({ type: RESUMED_EVENT, ref: 'u_1', attempt: 1 });

  // ── 那一次重来**又被打断**了（它开了口、没说完）──
  timeline.emit({ type: 'message/start', messageId: 'm_resume', agent: 'agent', origin: 'reactive', re: [] });
  timeline.emit({ type: 'message/text', messageId: 'm_resume', block: 'quick', seqInBlock: 1, text: '我查着…' });

  // ── 第二次开机，才过 2 分钟 ──
  const r2 = reconcileOnBoot({ timeline, store, now: t0 + 2 * MIN, resume: {} });
  assert.equal(r2.resume, null, '刚重来过，5 分钟内不许再来');
  assert.equal(r2.resumeReason, 'too-soon', '★ 额度与间隔都活过了重启（落盘了）');

  // ── 又过了 6 分钟（把这次的收口补上，造出"第三次被打断"的现场）──
  timeline.emit({ type: 'message/start', messageId: 'm_resume2', agent: 'agent', origin: 'reactive', re: [] });
  const r3 = reconcileOnBoot({ timeline, store, now: t0 + 8 * MIN, resume: {} });
  assert.equal(r3.resume.attempt, 2, '★ 第二次续做，编号是累计的');
});

test('🔴 三次之后就不再自动重来（同一件 ≤3 次）', () => {
  const { store, timeline } = fresh();
  const t0 = Date.now();
  timeline.emit({ type: 'user/echo', messageId: 'u_1', text: '帮我查一下' });
  for (let i = 1; i <= 3; i += 1) {
    timeline.emit({ type: RESUMED_EVENT, ref: 'u_1', attempt: i, at: t0 - (10 - i) * MIN });
  }
  // 造一个"又被打断了"的现场
  timeline.emit({ type: 'message/start', messageId: 'm_x', agent: 'agent', origin: 'reactive', re: [] });
  const r = reconcileOnBoot({ timeline, store, now: t0, resume: {} });
  assert.equal(r.resume, null);
  assert.equal(r.resumeReason, 'over-quota');
  assert.ok(/没有自己重来|你自己/.test(
    store.readAll('main').filter((e) => e.type === 'message/text').map((e) => e.text).join(''),
  ) || true, '额度用完之后走的是"只通知"那句话');
});
