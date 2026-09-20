import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';
import { HEARTBEAT_MS, STALE_MS, computeBusy, createTurnStatus, readStatus, shouldWait, statusPath } from '../src/turn-status.js';

const tmp = () => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-ts-'));

test('🔴 手上有没有话：**三个来源缺一不可**', () => {
  assert.equal(computeBusy({ openMessageId: null, pending: 0, turns: 0 }), false);
  assert.equal(computeBusy({ openMessageId: 'm1' }), true, '它正在说');
  assert.equal(computeBusy({ pending: 2 }), true, '话还没变成轮');
  // ⚠️ 这一条是实测补上的：轮已经宣布、一个字都还没说（spawn + 喂背景那段）
  assert.equal(computeBusy({ turns: 1 }), true, '轮在飞，哪怕它还没开口');
  assert.equal(computeBusy({}), false);
});

test('🔴 读不懂就当"不知道"，**不许**猜成"不忙"（猜错的方向是把话切了）', () => {
  assert.equal(readStatus('这不是 JSON'), null);
  assert.equal(readStatus('{"busy":true}'), null, '没有 updatedAt 也没法判断新旧');
  assert.equal(readStatus('{}'), null);
});

test('🔴 陈了的状态不许再等：服务可能已经死了，等它就是永远卡住', () => {
  const now = 1_000_000;
  const fresh = readStatus(JSON.stringify({ busy: true, updatedAt: now - 100 }), { now });
  assert.equal(shouldWait({ status: fresh }), true);
  const stale = readStatus(JSON.stringify({ busy: true, updatedAt: now - STALE_MS - 1 }), { now });
  assert.equal(stale.stale, true);
  assert.equal(shouldWait({ status: stale }), false, '陈的 busy 不能拿来永远等');
  const idle = readStatus(JSON.stringify({ busy: false, updatedAt: now }), { now });
  assert.equal(shouldWait({ status: idle }), false);
  assert.equal(shouldWait({ status: null }), false);
});

test('心跳：状态变了就落盘，闲着就一条都不写', () => {
  const dir = tmp();
  try {
    const file = statusPath(dir);
    let t = 1000;
    let state = { openMessageId: null, pending: 0 };
    const w = createTurnStatus({ file, snapshot: () => state, now: () => t, fs: nodeFs });
    w.tick();
    const first = nodeFs.statSync(file).mtimeMs;
    assert.equal(JSON.parse(nodeFs.readFileSync(file, 'utf8')).busy, false);
    // 闲着再跳几次 ⇒ 文件不该被重写（mtime 不变）
    t += HEARTBEAT_MS; w.tick();
    t += HEARTBEAT_MS; w.tick();
    assert.equal(nodeFs.statSync(file).mtimeMs, first, '闲着不该一秒一写');
    // 忙起来 ⇒ 立刻写，而且之后每次心跳都要刷新（不然会被当成"陈的"）
    state = { openMessageId: 'm1', pending: 0 };
    t += HEARTBEAT_MS; w.tick();
    const busyAt = JSON.parse(nodeFs.readFileSync(file, 'utf8'));
    assert.equal(busyAt.busy, true);
    assert.equal(busyAt.updatedAt, t);
    t += HEARTBEAT_MS; w.tick();
    assert.equal(JSON.parse(nodeFs.readFileSync(file, 'utf8')).updatedAt, t, '忙着的时候必须一直刷新');
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('心跳写不进去也不许抛（它只是维护用的旁路信息）', () => {
  const w = createTurnStatus({
    file: '/proc/不可能写进去/status.json',
    snapshot: () => ({ openMessageId: 'm1' }),
    fs: { mkdirSync: () => { throw new Error('不行'); }, writeFileSync: () => { throw new Error('不行'); } },
  });
  assert.doesNotThrow(() => w.tick());
});

test('start/stop 不泄漏定时器', () => {
  const dir = tmp();
  try {
    const w = createTurnStatus({ file: statusPath(dir), snapshot: () => ({}) });
    w.start(); w.start();
    w.stop(); w.stop();
    assert.ok(true, '重复 start/stop 不该炸');
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});
