// **磁盘分级**的判据（手册 `08-SPEC.md` §十一：80 告警 / 88 清 / 92 拒新重活 / 95 优雅拒绝新会话）。
//
// 守的几条：
//   ① 🔴 **阈值与手册逐条对表**（两边都读：手册那张表 ⇄ 代码这份常量）—— 手册改了它就得红；
//   ② 边界：79.9/80、87.9/88、91.9/92、94.9/95 各在哪一级（差一点就是另一级）；
//   ③ 🔴 **算不出来就说算不出来**（null/NaN/负数/超 100 ⇒ `unknown`，**绝不当成 ok**）；
//   ④ 用户会看到那两句**不许有内部词**（`会话` 这种词他自己不用）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { DISK_STEPS, DISK_WORDS, diskGrade, usedPercentOf } from '../src/disk-grade.js';

const SPEC = nodePath.resolve(import.meta.dirname, '../../../..', 'docs/handbook/08-SPEC.md');

test('① 🔴 阈值与手册那张表**逐条对得上**（手册改了这条就红）', () => {
  const spec = nodeFs.readFileSync(SPEC, 'utf8');
  const line = spec.split('\n').find((l) => /\|\s*\*\*磁盘分级\*\*\s*\|/.test(l));
  assert.ok(line, '手册里找不到「磁盘分级」那一行 —— 表改名了就要回来改这条闸');
  // 手册那一行写的是：**80 告警 / 88 清 / 92 拒新重活 / 95 优雅拒绝新会话**
  for (const [n, word] of [[80, '告警'], [88, '清'], [92, '拒新重活'], [95, '优雅拒绝新会话']]) {
    assert.ok(line.includes(String(n)), `手册那一行里没有 ${n}：${line.trim()}`);
    assert.ok(line.includes(word), `手册那一行里没有「${word}」：${line.trim()}`);
    assert.ok(DISK_STEPS.some((s) => s.at === n), `代码少了一档 ${n}（手册有）`);
  }
  // 负向对照：反过来也不许多（手册只列了四档）
  assert.equal(DISK_STEPS.length, 4, `手册四档、代码也是四档（现在是 ${DISK_STEPS.length}）`);
});

test('② 边界逐档对表（差一点就是另一级）', () => {
  const at = (p) => diskGrade(p).grade;
  assert.equal(at(0), 'ok');
  assert.equal(at(79.9), 'ok');
  assert.equal(at(80), 'warn', '★ 80 就是告警那一档（下含）');
  assert.equal(at(87.9), 'warn');
  assert.equal(at(88), 'clean');
  assert.equal(at(91.9), 'clean');
  assert.equal(at(92), 'refuse-heavy');
  assert.equal(at(94.9), 'refuse-heavy');
  assert.equal(at(95), 'refuse-new');
  assert.equal(at(100), 'refuse-new');
});

test('③ 🔴 算不出来 ⇒ `unknown`（**绝不当成 ok**）', () => {
  for (const bad of [null, undefined, NaN, '80', {}, [], -1, 100.1, Infinity]) {
    const g = diskGrade(bad);
    assert.equal(g.grade, 'unknown', `这个输入该是"算不出来"：${JSON.stringify(bad)}`);
    assert.equal(g.percent, null);
    assert.notEqual(g.grade, 'ok');
  }
  // 百分比那个也算得出/算不出分得开
  assert.equal(usedPercentOf({ totalBytes: 100, freeBytes: 20 }), 80);
  assert.equal(usedPercentOf({ totalBytes: 100, freeBytes: 0 }), 100);
  assert.equal(usedPercentOf({ totalBytes: 0, freeBytes: 0 }), null, '总容量 0 ⇒ 算不出来');
  assert.equal(usedPercentOf({ totalBytes: 100, freeBytes: 200 }), null, '剩的比总的多 ⇒ 数据不对，不许硬算');
  assert.equal(usedPercentOf({}), null);
  assert.equal(usedPercentOf(), null);
  // 而"真的用满了"是 100 ⇒ 拒新会话（不是 unknown）
  assert.equal(diskGrade(usedPercentOf({ totalBytes: 100, freeBytes: 0 })).grade, 'refuse-new');
});

test('④ 用户会看到的那两句：**不许有内部词**，而且说清"你那些还在"', () => {
  const shown = Object.values(DISK_WORDS).filter((w) => w !== '');
  assert.ok(shown.length >= 2, '至少"拒重活"与"拒新的话"两句要对用户说');
  for (const w of shown) {
    for (const bad of ['会话', '工作区', '客户端', '云端', '口令', '时间线', '工具', '模型']) {
      assert.equal(w.includes(bad), false, `「${w}」里有内部词「${bad}」`);
    }
  }
  const last = DISK_WORDS['refuse-new'];
  assert.ok(last.includes('先不接新的话'), '最后那一档要说清"先不接新的话"');
  assert.ok(last.includes('你现在这些都在'), '★ 要说清"已有的不会被丢"（不然他以为东西没了）');
  // 前三档**不打扰他**（没有话要说）
  assert.equal(DISK_WORDS.ok, '');
  assert.equal(DISK_WORDS.warn, '');
  assert.equal(DISK_WORDS.clean, '');
});
