// 落盘契约的验收 —— 对应手册 `08-SPEC.md` §5.2 的 **V-a**：
//   「盘满/只读时 `emit` **抛错**，**订阅者一条都没收到**，
//     且**调用点不需要自己 try**」
//
// 这一条是"唯一会永久丢数据"的根的守门测试。
// 旧实现（`store.js:22-28`）`catch { /* 忽略 */ }` 会**全部挂掉**。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';

import { Store, StoreError } from '../src/store.js';
import { collector, failingFs, tempStore } from './helpers.js';

test('追加一条：盘上多一行 JSON，字段原样', () => {
  const { store } = tempStore();
  store.append('main', { type: 'user/echo', seq: 1, at: 111, text: '你好' });

  const lines = nodeFs.readFileSync(store.pathFor('main'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { type: 'user/echo', seq: 1, at: 111, text: '你好' });
});

test('★ 盘满时必须抛（不能吞）—— write 失败', () => {
  const store = new Store({ dataDir: '/nowhere', fs: failingFs({ at: 'write' }), fsync: false });
  assert.throws(
    () => store.append('main', { type: 'user/echo', seq: 1 }),
    (err) => {
      assert.ok(err instanceof StoreError, '应该是 StoreError');
      assert.match(err.message, /落盘失败/);
      return true;
    },
  );
});

test('★ 盘满时必须抛 —— open 失败也要抛', () => {
  const store = new Store({ dataDir: '/nowhere', fs: failingFs({ at: 'open' }), fsync: false });
  assert.throws(() => store.append('main', { type: 'x' }), StoreError);
});

test('★ fsync 失败也算落盘失败（"写进页缓存"不等于落盘）', () => {
  const store = new Store({ dataDir: '/nowhere', fs: failingFs({ at: 'fsync' }) });
  assert.throws(() => store.append('main', { type: 'x' }), /落盘失败/);
});

test('★ close 失败不许掩盖真正的失败原因', () => {
  // open 成功、write 失败、close 也失败 ⇒ 报出来的必须是**写失败**
  const fs = failingFs({ at: 'write' });
  const orig = fs.closeSync;
  fs.closeSync = () => {
    const e = new Error('关闭也炸了');
    throw e;
  };
  fs.openSync = () => 7;
  const store = new Store({ dataDir: '/nowhere', fs, fsync: false });
  assert.throws(
    () => store.append('main', { type: 'x' }),
    (err) => {
      assert.match(err.message, /ENOSPC|落盘失败/);
      assert.doesNotMatch(err.message, /关闭也炸了/, '真正的原因被 close 的错误掩盖了');
      return true;
    },
  );
  assert.ok(orig);
});

test('没有日志时 lastEvent 返回 null（不是抛）', () => {
  const { store } = tempStore();
  assert.equal(store.lastEvent('main'), null);
});

test('lastEvent 取到最后一条', () => {
  const { store } = tempStore();
  store.append('main', { type: 'a', seq: 1 });
  store.append('main', { type: 'b', seq: 2 });
  store.append('main', { type: 'c', seq: 3 });
  assert.equal(store.lastEvent('main').type, 'c');
});

test('空文件时 lastEvent 返回 null', () => {
  const { store } = tempStore();
  nodeFs.writeFileSync(store.pathFor('main'), '');
  assert.equal(store.lastEvent('main'), null);
});

test('坏记录要抛，不许静默跳过（默默跳过等于隐瞒数据损坏）', () => {
  const { store } = tempStore();
  nodeFs.writeFileSync(store.pathFor('main'), '{"type":"a","seq":1}\n{这不是JSON}\n');
  assert.throws(() => store.readAll('main'), /坏记录/);
});

test('verifyMonotonic：连续则通过', () => {
  const { store } = tempStore();
  for (const seq of [1, 2, 3]) store.append('main', { type: 'x', seq });
  assert.deepEqual(store.verifyMonotonic('main'), { count: 3, maxSeq: 3 });
});

test('★ verifyMonotonic：跳号必须被抓出来（N22 磁盘无空洞）', () => {
  const { store } = tempStore();
  store.append('main', { type: 'x', seq: 1 });
  store.append('main', { type: 'x', seq: 3 }); // 少了 2
  assert.throws(() => store.verifyMonotonic('main'), /编号不连续/);
});

test('★ verifyMonotonic：落盘却没号也要抓（持久的必须有号）', () => {
  const { store } = tempStore();
  store.append('main', { type: 'client/reload' }); // 没有 seq
  assert.throws(() => store.verifyMonotonic('main'), /没有 seq/);
});

test('timelineId 里不许有路径字符（防目录穿越）', () => {
  const { store } = tempStore();
  assert.throws(() => store.pathFor('../escape'), /不安全字符/);
  assert.throws(() => store.pathFor('a/b'), /不安全字符/);
});
