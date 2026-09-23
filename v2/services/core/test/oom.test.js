// **"它是不是被挤掉的"要有证据**（账 #33 的后半 · 2026-09-23）。
//
// 这一份钉三件事：
//   ① `oom.js` 读的是**内核自己的计数**（cgroup `memory.events`），不是拿 `SIGKILL` 猜；
//   ② **读不到就不许说**（文件不在 / 解析不了 ⇒ 一律 `false`，退回那句含糊的话）；
//   ③ 调度器那一边：**只有 `oom:true` 才换那句"被挤掉了"**，否则还是原来那句。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createOomWatcher, ownMemoryEventsPath, readOomEvents } from '../src/oom.js';
import { FAILED_LINES } from '../src/notice.js';
import { Dispatcher } from '../src/dispatcher.js';
import { collector, tempTimeline } from './helpers.js';

// ── ① 路径：不能写死 `/sys/fs/cgroup/memory.events`（本机那一条**不存在**）──

test('路径从 `/proc/self/cgroup` 里那条 `0::` 算出来（本机的形状就是这样）', () => {
  const readFile = (p) => {
    assert.equal(p, '/proc/self/cgroup');
    return '0::/user.slice/user-1001.slice/user@1001.service/app.slice/x.scope\n';
  };
  assert.equal(
    ownMemoryEventsPath({ readFile }),
    '/sys/fs/cgroup/user.slice/user-1001.slice/user@1001.service/app.slice/x.scope/memory.events',
  );
});

test('🔴 认不出路径 ⇒ `null`（宁可没有这一档，也不许瞎读一个文件当证据）', () => {
  assert.equal(ownMemoryEventsPath({ readFile: () => 'no-cgroup-line\n' }), null);
  assert.equal(
    ownMemoryEventsPath({
      readFile: () => {
        throw new Error('读不了');
      },
    }),
    null,
  );
  // `0::/` ⇒ 我们就在挂载根上：路径算**根**那一份；⚠️ 本机那个文件**不存在**
  // ⇒ 走到"读不到"那一条（`readOomEvents` 返回 `null`）⇒ 上层闭嘴。**不许猜**。
  assert.equal(ownMemoryEventsPath({ readFile: () => '0::/\n' }), '/sys/fs/cgroup/memory.events');
});

// ── ② 读数：认不出 ⇒ `null`（调用方据此闭嘴）──────────────

test('读得到就是两个数（本机实测那份文件里就叫 `oom`）', () => {
  const got = readOomEvents('/x/memory.events', {
    readFile: () => 'low 0\nhigh 0\nmax 0\noom 3\noom_kill 1\n',
  });
  assert.deepEqual(got, { oom: 3, oomKill: 1 });
});

test('🔴 读不到 / 解析不出 ⇒ `null`（**不许**当成 0 然后假装"没 OOM 过"）', () => {
  assert.equal(readOomEvents(null), null);
  assert.equal(readOomEvents('/nope', { readFile: () => { throw new Error('ENOENT'); } }), null);
  // 只有别的行、没有那两个键 ⇒ 也算读不出来（返回 0/0 与 null 的区别在于：
  // 前者会被当成"证据说没涨过"，后者让调用方**闭嘴**）
  const weird = readOomEvents('/x', { readFile: () => 'low 0\nhigh 0\n' });
  assert.deepEqual(weird, { oom: 0, oomKill: 0 }, '缺键当 0（保守：那样永远判不出 OOM）');
});

// ── ③ 窗口：涨了才算，没涨 / 读不到都不算 ──────────────────

const watcherWith = (seq) => {
  let i = 0;
  return createOomWatcher({
    readFile: (p) => {
      if (p === '/proc/self/cgroup') return '0::/x.scope\n';
      const v = seq[Math.min(i, seq.length - 1)];
      i += 1;
      if (v == null) throw new Error('读不了');
      return v;
    },
  });
};

test('🔴 这段时间里**内核真的 OOM 过** ⇒ `true`', () => {
  const w = watcherWith(['oom 0\noom_kill 0\n', 'oom 1\noom_kill 1\n']);
  w.markStart();
  assert.equal(w.changed(), true);
});

test('负向对照：**没涨** ⇒ `false`（别的 SIGKILL 不许冒充 OOM）', () => {
  const w = watcherWith(['oom 2\noom_kill 2\n', 'oom 2\noom_kill 2\n']);
  w.markStart();
  assert.equal(w.changed(), false);
});

test('负向对照：**读不到** ⇒ `false`（读不到就不许说）', () => {
  const w = watcherWith(['oom 0\n', null]);
  w.markStart();
  assert.equal(w.changed(), false, '第二次读不到 ⇒ 不许说"被挤掉了"');
  const never = watcherWith([null, 'oom 9\n']);
  never.markStart();
  assert.equal(never.changed(), false, '第一次就读不到 ⇒ 没有基线，不许说');
  assert.equal(never.available, false);
});

test('没划窗口就问 ⇒ `false`（不许拿上一次的窗口冒充这一次）', () => {
  const w = watcherWith(['oom 0\n', 'oom 5\n']);
  assert.equal(w.changed(), false);
});

// ── ④ 调度器那一侧：**有证据才换那句**──────────────────────

/** 一个假 runtime（只要 `agent()` 与 `stop()`）——调度器只调这两个。 */
function stubRuntime() {
  const agent = new EventEmitter();
  agent.prompt = async () => ({ messageId: 'm_1' });
  return { agent: () => agent, stop: async () => {}, _agent: agent };
}

/** 起一轮、然后让那个进程"没了"，返回**用户能看到的那句话**。 */
async function sayOnExit(exitInfo) {
  const { store, timeline } = tempTimeline();
  const c = collector();
  timeline.subscribe(c.fn);
  const runtime = stubRuntime();
  const d = new Dispatcher({
    timeline,
    runtime,
    scopeId: 'main',
    agentKey: 'u1/main',
    store,
    recap: {},
  });
  await d.deliver('你好'); // 先挂上监听（`#ensureAgent` 才接线）
  // ⚠️ **得先有一轮开着**（真机上进程是**在一轮里**没的）：`forceClose` 只往
  //    "还没收口的那一轮"里写那句话。没有开着的一轮 ⇒ 它写哪儿都写不进去。
  runtime._agent.emit('session-event', { event: { type: 'turn/start', data: { turn: 1 } } });
  runtime._agent.emit('exit', exitInfo);
  return c.got
    .filter((e) => e.type === 'message/text')
    .map((e) => e.text)
    .join('');
}

test('🔴 内核说"真的 OOM 过" ⇒ 屏幕上就是"被挤掉了"那句', async () => {
  const text = await sayOnExit({
    code: null,
    signal: 'SIGKILL',
    wasReady: true,
    oom: true,
    reason: '进程退出 code=null',
  });
  assert.equal(text, FAILED_LINES.oom);
});

test('🔴 负向对照：**没有证据**（`oom:false` / 字段不在）⇒ 还是原来那句', async () => {
  // ⚠️ 拿 `SIGKILL` 当 OOM 的代价：用户会以为"是内存不够"，而真正的原因可能是别的 ——
  //    这个项目里"猜"就等于说假话（N10）。
  for (const info of [
    { code: null, signal: 'SIGKILL', wasReady: true, oom: false, reason: 'x' },
    { code: 1, signal: null, wasReady: true, reason: 'x' },
  ]) {
    const text = await sayOnExit(info);
    assert.notEqual(text, FAILED_LINES.oom, '没证据就不许说"被挤掉了"');
    assert.ok(text.length > 0, '但**不能留白**（收口必须有话说）');
  }
});
