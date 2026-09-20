// 编号契约的验收 —— 对应手册 `08-SPEC.md` §5.1、§5.2 的 **V-f**：
//   「重启后取号**单调**；**瞬态不进日志** ⇒ 磁盘无空洞」
// 以及 §5.1 的表格：持久事件取号+落盘+上时间线；控制帧与 UI 状态都 ❌。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';
import { collector, failingFs, tempStore, tempTimeline } from './helpers.js';

test('持久事件逐个 +1，从 1 开始', () => {
  const { timeline } = tempTimeline();
  assert.equal(timeline.seq, 0);
  assert.equal(timeline.emit({ type: 'a' }).seq, 1);
  assert.equal(timeline.emit({ type: 'b' }).seq, 2);
  assert.equal(timeline.emit({ type: 'c' }).seq, 3);
  assert.equal(timeline.seq, 3);
});

test('每条持久事件都带 at（协议 R11：每事件有时间戳）', () => {
  const { timeline } = tempTimeline();
  const e = timeline.emit({ type: 'a' });
  assert.equal(typeof e.at, 'number');
});

test('★ 瞬态事件不取号、不落盘', () => {
  const { store, timeline } = tempTimeline();
  timeline.emit({ type: 'persisted' }); // seq 1
  const t = timeline.emitTransient({ type: 'client/reload' });

  assert.equal(t.seq, undefined, '瞬态不该有 seq');
  assert.equal(timeline.seq, 1, '瞬态不该让号前进');

  const onDisk = store.readAll('main');
  assert.deepEqual(
    onDisk.map((e) => e.type),
    ['persisted'],
    '瞬态不该进日志',
  );
});

test('★ 瞬态夹在中间，磁盘编号仍然连续（无空洞）', () => {
  const { store, timeline } = tempTimeline();
  timeline.emit({ type: 'a' }); //                                             1
  timeline.emitTransient({ type: 'client/reload' }); //                        瞬态
  timeline.emit({ type: 'message/status', state: 'working' }); //              2  ← 瞬态没占号
  timeline.emitTransient({ type: 'client/reload' }); //                        瞬态
  timeline.emit({ type: 'b' }); //                                             3

  assert.deepEqual(store.verifyMonotonic('main'), { count: 3, maxSeq: 3 });
  assert.deepEqual(
    store.readAll('main').map((e) => e.seq),
    [1, 2, 3],
  );
});

test('★ 盘满：抛 + 订阅者一条都没收到 + 号退回（验收 V-a）', () => {
  const fs = failingFs({ at: 'write' });
  const store = new Store({ dataDir: '/nowhere', fs, fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const c = collector();
  timeline.subscribe(c.fn);

  assert.throws(() => timeline.emit({ type: 'user/echo', text: '会失败' }), /落盘失败/);
  assert.deepEqual(c.got, [], '订阅者一条都不该收到');
  assert.equal(timeline.seq, 0, '号必须退回去，否则下一个事件在盘上就是跳号的');
});

test('★ 盘满之后号不前进：恢复后下一个仍是 1（不留洞）', () => {
  const { dataDir, store } = tempStore();
  const timeline = new Timeline({ id: 'main', store });
  timeline.emit({ type: 'a' }); // 1

  const broken = new Timeline({ id: 'main', store: new Store({ dataDir, fs: failingFs(), fsync: false }) });
  assert.throws(() => broken.emit({ type: 'b' }));

  const next = timeline.emit({ type: 'c' });
  assert.equal(next.seq, 2, '失败那次不该吃掉 2');
  assert.deepEqual(store.verifyMonotonic('main'), { count: 2, maxSeq: 2 });
});

test('★ 重启：从磁盘取 max 继续，编号单调', () => {
  const { dataDir, store } = tempTimeline();
  const t1 = new Timeline({ id: 'main', store });
  t1.emit({ type: 'a' });
  t1.emit({ type: 'b' });
  t1.emitTransient({ type: 'client/reload' }); // 不落盘

  const t2 = new Timeline({ id: 'main', store: new Store({ dataDir, fsync: false }) });
  assert.equal(t2.seq, 2, '重启后应从已落盘最大继续');
  assert.equal(t2.emit({ type: 'c' }).seq, 3);
  assert.equal(t2.emit({ type: 'd' }).seq, 4);
});

test('★ 一条可见时间线 = 一条日志：两条线互不影响（P-l 甲）', () => {
  const { dataDir, store } = tempStore();
  const a = new Timeline({ id: 'a', store });
  const b = new Timeline({ id: 'b', store: new Store({ dataDir, fsync: false }) });

  assert.equal(a.emit({ type: 'x' }).seq, 1);
  assert.equal(a.emit({ type: 'x' }).seq, 2);
  assert.equal(b.emit({ type: 'x' }).seq, 1, 'b 有自己的计数器');
  assert.equal(b.emit({ type: 'x' }).seq, 2);

  assert.deepEqual(store.verifyMonotonic('a'), { count: 2, maxSeq: 2 });
  assert.deepEqual(store.verifyMonotonic('b'), { count: 2, maxSeq: 2 });
});

test('事件必须有 type', () => {
  const { timeline } = tempTimeline();
  assert.throws(() => timeline.emit({}), /必须有 type/);
  assert.throws(() => timeline.emitTransient({}), /必须有 type/);
});

test('订阅者能退订', () => {
  const { timeline } = tempTimeline();
  const c = collector();
  const off = timeline.subscribe(c.fn);
  timeline.emit({ type: 'a' });
  off();
  timeline.emit({ type: 'b' });
  assert.deepEqual(c.types(), ['a']);
});

test('★ 订阅者自己抛错：不拖垮时间线，但必须报出来（不许静默吞）', () => {
  const errors = [];
  const { timeline } = tempTimeline('main', {
    onSubscriberError: (err, e) => errors.push(`${e.type}:${err.message}`),
  });
  const c = collector();
  timeline.subscribe(() => {
    throw new Error('订阅者炸了');
  });
  timeline.subscribe(c.fn); // 后面这个必须照样收到

  timeline.emit({ type: 'a' });
  assert.deepEqual(c.types(), ['a'], '一个坏订阅者不该影响别人');
  assert.deepEqual(errors, ['a:订阅者炸了'], '但错误必须被报出来');
});

test('落盘失败时，坏订阅者也不会被通知（顺序：先落盘，再推）', () => {
  const store = new Store({ dataDir: '/nowhere', fs: failingFs(), fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  let called = 0;
  timeline.subscribe(() => {
    called += 1;
  });
  assert.throws(() => timeline.emit({ type: 'a' }));
  assert.equal(called, 0);
});
