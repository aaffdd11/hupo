// 地基演示：**一条消息进来 → 落盘 → 推出去**。
//
// 跑法：`npm run demo`（在 v2/services/core 下）
//
// 它现场演四件事，都是手册里点名的判据：
//   1. 持久事件：取号 → 落盘 → **成功之后**订阅者才收到
//   2. 瞬态事件：**不取号、不落盘**，所以磁盘上没有空洞
//   3. **盘满时**：`emit` 抛、**订阅者一条都没收到**、号**退回去**（V-a）
//   4. 出事时进程级兜底用**瞬态通道**说一句人话（盘满时它仍发得出去）

import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { Store } from './store.js';
import { Timeline } from './timeline.js';
import { MessageWriter } from './message-writer.js';
import { installProcessGuard, CrashLoopGuard, HUMAN_LINES } from './process-guard.js';

const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-v2-demo-'));
const store = new Store({ dataDir, fsync: false }); // 演示里不要每次 fsync

let failures = 0;
const timeline = new Timeline({
  id: 'main',
  store,
  // 订阅者自己抛错：不拖垮时间线，但**必须报出来**（不许静默吞）
  onSubscriberError: (err, event) => {
    failures += 1;
    console.log(`  ! 订阅者出错（${event.type}）：${err.message}`);
  },
});

console.log('══ 1. 持久事件：取号 → 落盘 → 才推 ══');
const seen = [];
timeline.subscribe((e) => {
  seen.push(e.type);
  const tag = typeof e.seq === 'number' ? `seq=${e.seq}` : '瞬态（无号）';
  const body = e.text ? `  「${e.text}」` : '';
  console.log(`  订阅者收到：${e.type.padEnd(16)} ${tag}${body}`);
});

timeline.emit({ type: 'user/echo', messageId: 'u_demo_1', text: '帮我把这周工时记一下' });

const w = new MessageWriter({ timeline, agent: 'agent', origin: 'reactive' });
w.start();
w.chunk('quick', '收到，我记一下。');
w.chunk('deep', '这周 7 小时，2800 元。');
w.sources = [{ title: '工时账', url: 'https://example.invalid/ledger' }];
w.end();

console.log('\n══ 2. 瞬态事件：不取号、不落盘 ══');
timeline.emitTransient({ type: 'client/reload' });
timeline.emitTransient({ type: 'message/status', messageId: w.messageId, state: 'working' });

console.log('\n══ 3. 未收口保护：同一时刻最多一条（N22）══');
const w2 = new MessageWriter({ timeline, agent: 'agent', origin: 'proactive' });
w2.start();
try {
  const w3 = new MessageWriter({ timeline, agent: 'agent', origin: 'proactive' });
  w3.start();
  console.log('  ✗ 不该走到这里');
} catch (err) {
  console.log(`  ✓ 拦住了：${err.message}`);
}

console.log('\n══ 4. 收口之后不许再写（事故"消息不许交叉"的成因）══');
try {
  w.chunk('deep', '（这句不该写进去）');
  console.log('  ✗ 不该走到这里');
} catch (err) {
  console.log(`  ✓ 拦住了：${err.message}`);
}
w2.end();

console.log('\n══ 5. 盘满时会怎样（验收 V-a）══');
{
  const before = timeline.seq;
  const gotBefore = seen.length;
  // 换一个"写什么都说没空间"的 fs
  const fullFs = {
    mkdirSync: () => {},
    openSync: () => 7,
    writeSync: () => {
      const e = new Error('ENOSPC: no space left on device');
      e.code = 'ENOSPC';
      throw e;
    },
    fsyncSync: () => {},
    closeSync: () => {},
    statSync: () => ({ size: 0 }),
    readFileSync: () => '',
  };
  const fullStore = new Store({ dataDir, fs: fullFs, fsync: false });
  const full = new Timeline({ id: 'main', store: fullStore });
  full.subscribe((e) => seen.push(`完整${e.type}`));
  try {
    full.emit({ type: 'user/echo', messageId: 'u_demo_2', text: '这句会失败' });
    console.log('  ✗ 不该走到这里：盘满竟然没抛');
  } catch (err) {
    console.log(`  ✓ 抛出来了：${err.message}`);
  }
  console.log(`  ✓ 订阅者一条都没收到：${seen.length === gotBefore ? '是' : '否 ← 不对'}`);
  console.log(`  ✓ 号退回去了：${full.seq === 0 ? `是（还是 ${full.seq}）` : `否 ← 不对（变成 ${full.seq}）`}`);
  console.log(`  （原时间线的号不受影响，仍是 ${timeline.seq}，之前是 ${before}）`);

  console.log('\n══ 6. 出事谁接：用瞬态通道说人话（盘满时它仍发得出去）══');
  const said = [];
  full.subscribe((e) => {
    if (e.type === 'error') said.push(e.text);
  });
  const uninstall = installProcessGuard({
    timeline: full,
    exit: () => {}, // 演示里不真退出
    log: () => {},
  });
  const handler = process.listeners('uncaughtException').at(-1);
  handler(new Error('ENOSPC: 落盘失败'));
  uninstall();
  console.log(`  ✓ 对用户说的是：「${said.at(-1) ?? '（什么都没说 ← 不对）'}」`);
  console.log('  （注意它走的是瞬态通道——盘满时普通通道自己也写不进去）');
}

console.log('\n══ 7. 崩溃环判定（连续重启 + OOM ⇒ 降级）══');
{
  const g = new CrashLoopGuard({ windowMs: 60_000, threshold: 3 });
  console.log(`  第 1 次启动：降级=${g.recordStart({ oomKilledLastRun: true })}`);
  console.log(`  第 2 次启动：降级=${g.recordStart({ oomKilledLastRun: true })}`);
  console.log(`  第 3 次启动：降级=${g.recordStart({ oomKilledLastRun: true })} ← 进降级`);
  console.log(`  降级时对用户说：「${HUMAN_LINES.degraded}」`);
}

console.log('\n══ 8. 磁盘上到底落了什么 ══');
const events = store.readAll('main');
for (const e of events) {
  console.log(`  seq=${String(e.seq).padStart(2)}  ${e.type}`);
}
const check = store.verifyMonotonic('main');
console.log(`  ✓ 编号连续无空洞：${check.count} 条，最大 ${check.maxSeq}`);
console.log(`  ✓ 瞬态事件没进日志：${events.some((e) => e.type === 'client/reload') ? '否 ← 不对' : '是'}`);

console.log('\n══ 9. 重启：从磁盘取 max 继续 ══');
{
  const fresh = new Store({ dataDir, fsync: false });
  const restarted = new Timeline({ id: 'main', store: fresh });
  console.log(`  重启后从 ${restarted.seq} 开始`);
  const e = restarted.emit({ type: 'user/echo', messageId: 'u_demo_3', text: '重启之后' });
  console.log(`  ✓ 下一条是 ${e.seq}（单调，不回头）`);
}

console.log(`\n日志在：${dataDir}`);
