// **磁盘巡检接线**的判据（P2-12 · 主人 2026-09-25 拍板「① 接线」）。
//
// 守的几条：
//   ① 🔴 **周期与手册对表**（手册 §11.4b：定时任务、5 分钟一次）—— 手册改了这条就红；
//   ② 三项各自能采到（磁盘 / inode / fd），也各自能"算不出来"；
//   ③ 🔴 **算不出来 ⇒ `unknown`**（**绝不当成 ok** —— 那就是"看起来有闸"）；
//   ④ 🔴 **不改运行时**：88/92/95 三档**只告警**，不删一个文件、不清盘、不拒活；
//   ⑤ 定时器 `unref()` ＋ `stop()` 真的把定时器清掉（不拖住收工）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

import {
  PROC_FD_DIR,
  PROC_LIMITS_FILE,
  SAMPLE_INTERVAL_MS,
  describeGrade,
  gradeSample,
  percentUsed,
  readFdLimit,
  sampleUsage,
  startDiskWatch,
} from '../src/disk-watch.js';

const SPEC = nodePath.resolve(import.meta.dirname, '../../../..', 'docs/handbook/08-SPEC.md');

test('① 🔴 周期与手册对表：手册写"5 分钟一次" ⇒ 常量就是它（手册改了这条就红）', () => {
  const spec = nodeFs.readFileSync(SPEC, 'utf8');
  const line = spec.split('\n').find((l) => /\|\s*\*\*磁盘守护\*\*\s*\|/.test(l));
  assert.ok(line, '手册里找不到「磁盘守护」那一行 —— 表改名了就要回来改这条闸');
  assert.ok(line.includes('5 分钟'), `手册那一行说的周期不是 5 分钟：${line.trim()}`);
  assert.equal(SAMPLE_INTERVAL_MS, 5 * 60 * 1000, '★ 周期住代码，而且是手册那一个数');
});

test('② 三项都采得到：磁盘 / inode / fd（纯读，不写盘）', () => {
  const writes = [];
  const fake = {
    statfsSync: () => ({ bsize: 4096, blocks: 1000, bfree: 50, bavail: 50, files: 2000, ffree: 400 }),
    readdirSync: () => new Array(900).fill('x'),
    readFileSync: () => 'Max open files            1000                 1048576              files\n',
    rmSync: (...a) => writes.push(['rm', ...a]),
    unlinkSync: (...a) => writes.push(['unlink', ...a]),
    writeFileSync: (...a) => writes.push(['write', ...a]),
  };
  const s = sampleUsage({ fs: fake, dataDir: '/whatever', now: () => 123 });
  assert.equal(s.at, 123);
  assert.equal(s.disk.percent, 95);
  assert.equal(s.inode.percent, 80, '2000 个 inode 用掉 1600 ⇒ 80%');
  assert.equal(s.fd.percent, 90, '1000 个上限用掉 900 ⇒ 90%');
  assert.deepEqual(writes, [], '★ 采样必须**只读**（一个字节都不许写/删）');
});

test('③ 🔴 算不出来 ⇒ `unknown`（磁盘 / inode / fd 三项各自独立）', () => {
  // ① 磁盘读不出来：inode 也一起没有（同一次 statfs）
  const boom = { statfsSync: () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); }, readdirSync: () => [], readFileSync: () => '' };
  const s1 = sampleUsage({ fs: boom, dataDir: '/x' });
  assert.equal(s1.disk.percent, null);
  assert.equal(s1.inode.percent, null);
  assert.match(s1.disk.why, /读不出来/);
  assert.equal(gradeSample(s1).disk.grade, 'unknown');
  assert.notEqual(gradeSample(s1).disk.grade, 'ok');

  // ② inode 总数是 0（有些文件系统不报）⇒ unknown，但磁盘那项照旧算得出
  const noInode = {
    statfsSync: () => ({ bsize: 4096, blocks: 1000, bfree: 500, bavail: 500, files: 0, ffree: 0 }),
    readdirSync: () => [],
    readFileSync: () => 'Max open files            1000                 1048576              files\n',
  };
  const s2 = sampleUsage({ fs: noInode, dataDir: '/x' });
  assert.equal(s2.disk.percent, 50);
  assert.equal(s2.inode.percent, null);
  assert.equal(gradeSample(s2).inode.grade, 'unknown');

  // ③ fd 上限 `unlimited` ⇒ 认不出（不许拿 0 去算）
  assert.equal(readFdLimit('Max open files            unlimited            unlimited            files\n'), null);
  assert.equal(readFdLimit('别的一行\n'), null);
  assert.equal(readFdLimit(''), null);
  const s3 = sampleUsage({
    fs: { statfsSync: () => ({ bsize: 4096, blocks: 1000, bfree: 500, files: 100, ffree: 50 }), readdirSync: () => [], readFileSync: () => 'Max open files            unlimited            unlimited            files\n' },
    dataDir: '/x',
  });
  assert.equal(s3.fd.percent, null);
  assert.equal(gradeSample(s3).fd.grade, 'unknown');
});

test('② `percentUsed` 只在拿得到真数字时才算（总 0 / 负数 / 剩的比总的多 ⇒ null）', () => {
  assert.equal(percentUsed({ total: 100, free: 20 }), 80);
  assert.equal(percentUsed({ total: 100, free: 0 }), 100);
  assert.equal(percentUsed({ total: 0, free: 0 }), null);
  assert.equal(percentUsed({ total: 100, free: 200 }), null);
  assert.equal(percentUsed({}), null);
  assert.equal(percentUsed(), null);
});

test('🔴 不改运行时（反例）：95% 只告警 —— **不删文件、不清盘、不拒活**', () => {
  const touched = [];
  const fakeFs = {
    statfsSync: () => ({ bsize: 4096, blocks: 1000, bfree: 20, bavail: 20, files: 1000, ffree: 10 }),
    readdirSync: () => new Array(990).fill('x'),
    readFileSync: () => 'Max open files            1000                 1048576              files\n',
    // 一碰就记账：删/写/改都算"动了运行时"
    rmSync: (...a) => touched.push(['rm', ...a]),
    rmdirSync: (...a) => touched.push(['rmdir', ...a]),
    unlinkSync: (...a) => touched.push(['unlink', ...a]),
    writeFileSync: (...a) => touched.push(['write', ...a]),
    appendFileSync: (...a) => touched.push(['append', ...a]),
    mkdirSync: (...a) => touched.push(['mkdir', ...a]),
    truncateSync: (...a) => touched.push(['truncate', ...a]),
  };
  const lines = [];
  const grades = [];
  const watch = startDiskWatch({
    dataDir: '/x',
    fs: fakeFs,
    log: (m) => lines.push(m),
    onGrade: (e) => grades.push(e),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });
  // 三档都越过了（磁盘 98、inode 99、fd 99）
  assert.deepEqual(grades.map((g) => g.grade), ['refuse-new', 'refuse-new', 'refuse-new']);
  assert.equal(touched.length, 0, `★ 巡检**一个动作都不许做**：${JSON.stringify(touched)}`);
  // 告警里说清了"手册上这一档该做什么"，但**没有真的做**
  assert.ok(lines.some((l) => l.includes('手册这一档写着')), `告警要说清是哪一档：${lines.join(' | ')}`);
  watch.stop();
});

test('④ 分级：80/88/92/95 四档各自报对（阈值只在 disk-grade.js）', () => {
  const at = (pct) => gradeSample({ disk: { percent: pct }, inode: { percent: null }, fd: { percent: null } }).disk.grade;
  assert.equal(at(79), 'ok');
  assert.equal(at(80), 'warn');
  assert.equal(at(88), 'clean');
  assert.equal(at(92), 'refuse-heavy');
  assert.equal(at(95), 'refuse-new');
  assert.match(describeGrade('磁盘', gradeSample({ disk: { percent: 88 }, inode: {}, fd: {} }).disk), /88\.0%/);
  assert.match(describeGrade('inode', gradeSample({ disk: {}, inode: { percent: null }, fd: {} }).inode), /算不出来/);
});

test('⑤ 定时器：起手先采一次、周期到了再采、`stop()` 真的清掉', () => {
  let cb = null;
  const cleared = [];
  const timer = { unref() { this.unrefed = true; } };
  const captured = [];
  const watch = startDiskWatch({
    dataDir: '/x',
    fs: {
      statfsSync: () => ({ bsize: 1, blocks: 100, bfree: 50, files: 100, ffree: 50 }),
      readdirSync: () => [],
      readFileSync: () => 'Max open files            1000                 1048576              files\n',
    },
    log: () => {},
    onGrade: null,
    setIntervalFn: (fn, ms) => { cb = fn; captured.push(ms); return timer; },
    clearIntervalFn: (t) => cleared.push(t),
  });
  assert.equal(timer.unrefed, true, '★ 必须 unref（不拖住收工）');
  assert.deepEqual(captured, [SAMPLE_INTERVAL_MS]);
  assert.ok(watch.last()?.at, '起手就该采过一次（不然头 5 分钟是盲的）');
  const first = watch.last().at;
  cb?.();
  assert.ok(watch.last().at >= first, '周期到了再采一次');
  watch.stop();
  assert.deepEqual(cleared, [timer]);
});

test('⑥ fd 起手读的就是本进程那两处（默认值只此一处）', () => {
  assert.equal(PROC_FD_DIR, '/proc/self/fd');
  assert.equal(PROC_LIMITS_FILE, '/proc/self/limits');
  // 真机这一趟：采得到就说采得到，采不到就如实 unknown（不假装）
  const s = sampleUsage({ dataDir: process.cwd() });
  assert.ok(s.fd.open === null || (Number.isInteger(s.fd.open) && s.fd.open >= 0));
  if (s.fd.limit !== null) assert.equal(gradeSample(s).fd.grade !== undefined, true);
});
