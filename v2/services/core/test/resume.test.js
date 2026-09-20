// 续传与补发的验收 —— 手册 `08-SPEC.md` §2.2 / §2.3，决策 **P-h**

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CATCHUP_RENDER, markCatchUp, planResume } from '../src/resume.js';

const log = [
  { type: 'user/echo', seq: 1 },
  { type: 'message/start', seq: 2 },
  { type: 'message/text', seq: 3 },
  { type: 'message/end', seq: 4 },
];

test('sinceSeq = 0（第一次打开）⇒ 全量历史，但**不标** catchUp', () => {
  const r = planResume({ events: log, sinceSeq: 0 });
  assert.equal(r.frames.length, 4);
  assert.equal(r.catchUp, false, '★ 首次打开不是"断线补发"——那是历史本身');
  assert.equal(r.reset, false);
  assert.equal(r.maxSeq, 4);
});

test('★ sinceSeq > 0（断线重连）⇒ 才标 catchUp', () => {
  const r = planResume({ events: log, sinceSeq: 2 });
  assert.deepEqual(r.frames.map((e) => e.seq), [3, 4]);
  assert.equal(r.catchUp, true);
});

test('已是最新 ⇒ 没有帧，但仍算补发段（因为确实连过）', () => {
  const r = planResume({ events: log, sinceSeq: 4 });
  assert.deepEqual(r.frames, []);
  assert.equal(r.catchUp, true);
});

test('★ 客户端的号跑到我们前面 ⇒ reset（不能"什么都不发"）', () => {
  const r = planResume({ events: log, sinceSeq: 99 });
  assert.equal(r.reset, true);
  assert.deepEqual(r.frames, []);
});

test('空日志：sinceSeq=0 ⇒ 没有帧、不标补发', () => {
  const r = planResume({ events: [], sinceSeq: 0 });
  assert.deepEqual(r.frames, []);
  assert.equal(r.catchUp, false);
  assert.equal(r.reset, false);
  assert.equal(r.maxSeq, 0);
});

test('空日志 + 客户端有号 ⇒ reset', () => {
  const r = planResume({ events: [], sinceSeq: 3 });
  assert.equal(r.reset, true);
});

test('瞬时事件（没有 seq）不参与补发', () => {
  const withTransient = [...log, { type: 'client/reload' }, { type: 'message/status' }];
  const r = planResume({ events: withTransient, sinceSeq: 0 });
  assert.equal(r.frames.length, 4);
  assert.ok(r.frames.every((e) => typeof e.seq === 'number'));
});

test('sinceSeq 非法要抛（负数 / 小数 / 非数）', () => {
  assert.throws(() => planResume({ events: log, sinceSeq: -1 }), /非负整数/);
  assert.throws(() => planResume({ events: log, sinceSeq: 1.5 }), /非负整数/);
  assert.throws(() => planResume({ events: log, sinceSeq: Number.NaN }), /非负整数/);
});

test('★ markCatchUp 必须浅拷贝：不许把标记写进磁盘对象', () => {
  const original = { type: 'message/end', seq: 4 };
  const marked = markCatchUp(original, true);
  assert.equal(marked.catchUp, true);
  assert.equal(marked.seq, 4);
  assert.equal(original.catchUp, undefined, '★ 原对象被改了 = 把"补发"写进了日志');
});

test('不补发时原样返回，不做多余拷贝', () => {
  const original = { type: 'message/end', seq: 4 };
  assert.equal(markCatchUp(original, false), original);
});

test('★ 补发段不参与"谁还没收口"的排队（P-2 是客户端渲染规则）', () => {
  assert.equal(CATCHUP_RENDER.style, 'history');
  assert.equal(CATCHUP_RENDER.participatesInQueue, false);
});
