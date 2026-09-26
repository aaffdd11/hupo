// **B38** 的判据：收工的每一步都有上限（卡住 ⇒ 点名 ＋ 继续），整条也有总上限。
//
// 🔴 这四条（Z1–Z4）都是**可以反着验**的：把上限去掉、把那句点名删掉、
//    把顺序换个位、把总上限拿掉 —— 各自的测试当场红（变异读数见 `77-BLOCKERS.md` B38）。
//
// ⚠️ 测试里**不许**用真 `process.exit`：注入一个假的，把退出码收回来判。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import test from 'node:test';

import { SHUTDOWN_STEPS, STEP_CAP_MS, TOTAL_CAP_MS, runShutdown } from '../src/shutdown-budget.js';

/**
 * 🔴 **加预算之前那条顺序** —— 从 `serve.js` 尾部（`for (const sig of ['SIGTERM','SIGINT'])`）
 * 逐字抄下来，**故意写死在测试里**（不从被测模块读）：这样"有人顺手换了个顺序"当场就红。
 */
const TODAYS_ORDER = [
  'dispatchers', // await worlds.shutdownDispatchers()
  'runtime', // await runtime.shutdown()
  'server', // await close()
  'turn-status', // turnStatus.stop()
  'trash-sweep', // clearInterval(trashSweep)
  'disk-watch', // diskWatch.stop()
  'sockets', // worlds.closeSockets()
  'channel', // channel.close()
  'migrate', // await appsMigrate?.close() ＋ 删掉那条套接字
  'clean-exit', // worlds.markCleanExitAll()
  'serve-lock', // clearServeLock(cfg.dataDir)
];

/** 一个**永不返回**的步骤（"卡住"的形状）。 */
const never = () => new Promise(() => {});

/** 所有步骤都好好收的一套 hooks（顺手记下谁被走过）。 */
function okHooks(seen, over = {}) {
  return {
    ...Object.fromEntries(TODAYS_ORDER.map((id) => [id, () => seen.push(id)])),
    ...over,
  };
}

/** 跑一次收工，把读数都收回来（日志 / 退出码 / 报告）。 */
async function run(hooks, opts = {}) {
  const lines = [];
  let code = null;
  const report = await runShutdown({
    hooks,
    log: (m) => lines.push(String(m)),
    exit: (c) => {
      code = c;
    },
    stepCapMs: 60,
    totalCapMs: 5000,
    ...opts,
  });
  return { report, code, text: lines.join('\n') };
}

test('🔴 Z1 某一步永不返回 ⇒ 到了上限**照样往下走完并退出**（不许挂在那儿等）', async () => {
  const seen = [];
  const { report, code } = await run(okHooks(seen, { server: never }));
  assert.equal(code, 0, '上限到了也要退（不是一直等）');
  assert.deepEqual(report.stalled, ['server'], '卡住的是哪一步要记下来');
  assert.deepEqual(
    seen,
    TODAYS_ORDER.filter((id) => id !== 'server' && id !== 'clean-exit'),
    '那一步之后**一步都不许少**（收尾不能被一步挂住一起带走）；' +
      '只有"我好好走了"那句故意不打（没等完就不许说）',
  );
});

test('🔴 Z2 那一步卡住时要**点名**（人话一句，不是对象）—— 正常那次不许打这句', async () => {
  const stuck = await run(okHooks([], { server: never }));
  assert.match(stuck.text, /收工卡在「停止接新连接（HTTP\/WS 那个口）」/, '要点出**是这一步**');
  assert.match(stuck.text, /记一笔，接着往下收/, '要说清"我没等它，但也没掐它"');
  assert.match(stuck.text, /没善终/, '要如实说这次不算善终');

  // 反例：顺顺当当收完时**不许**出现这些字样（不然它就成噪音，谁都不看）
  const clean = await run(okHooks([]));
  assert.ok(!/收工卡在|总上限/.test(clean.text), clean.text);
  assert.match(clean.text, /收工 ✓ 走完了/);
});

test('🔴 Z3 正常收工：顺序与今天**逐字一样**（加个上限不许顺手换位）', async () => {
  const seen = [];
  const { report, code } = await run(okHooks(seen));
  assert.deepEqual(seen, TODAYS_ORDER, '真正被走到的顺序');
  assert.deepEqual(report.order, TODAYS_ORDER, '表里的顺序');
  assert.deepEqual(
    SHUTDOWN_STEPS.map((s) => s.id),
    TODAYS_ORDER,
    '⚠️ 顺序**就是契约**：这一步换位 ⇒ 这条当场红',
  );
  assert.equal(report.clean, true);
  assert.equal(code, 0);
});

test('🔴 Z4 各步都卡 ⇒ **总上限**兜底：照样在总上限内退出', async () => {
  const seen = [];
  const t0 = Date.now();
  // ⚠️ 单步上限**故意放大**（这一条验的是总上限那一层，不是单步那一层）
  const { report, code, text } = await run(
    okHooks(seen, { dispatchers: never, runtime: never, server: never, migrate: never }),
    { stepCapMs: 60_000, totalCapMs: 120 },
  );
  const used = Date.now() - t0;
  assert.ok(used < 2000, `总上限必须**真的**兜住（实际用了 ${used} 毫秒）`);
  assert.equal(report.totalHit, true);
  assert.match(text, /总上限/, '总上限到了也要如实说');
  assert.equal(code, 0, '到了总上限也**要走**（只是这次不算善终）');
  assert.equal(report.clean, false);
  // 到了总上限**不许再 await 任何东西**（再等一次就可能再挂一次 ⇒ 永远收不了场）
  for (const s of SHUTDOWN_STEPS) {
    if (s.awaited) assert.ok(!seen.includes(s.id), `总上限之后不许再走 ${s.id}`);
  }
  // 同步那几步**照样走完**：收尾与"有没有善终"无关
  for (const id of ['sockets', 'channel', 'serve-lock']) {
    assert.ok(seen.includes(id), `总上限之后这几步也该走：缺 ${id}`);
  }
});

test('🔴 上限到了 ⇒ **不许**留"这次是好好走的"标记；但那把锁照样撤', async () => {
  const seen = [];
  const { report, text } = await run(okHooks(seen, { server: never }));
  assert.ok(!seen.includes('clean-exit'), '"我好好走了"是一句说出去的话 —— 没做到就不许说');
  assert.ok(seen.includes('serve-lock'), '锁与善终无关：不撤，迁移会一直以为这里热着');
  assert.match(text, /不许说/);
  assert.equal(report.clean, false);
});

test('某一步抛了 ⇒ 记一笔、接着往下收（不许把后面的收尾一起带走）', async () => {
  const seen = [];
  const { report, code, text } = await run(
    okHooks(seen, {
      runtime: () => {
        throw new Error('炸了');
      },
    }),
  );
  assert.equal(code, 0);
  assert.deepEqual(
    report.failed.map((f) => f.id),
    ['runtime'],
  );
  assert.match(text, /把 agent 放走（运行时） 这一步抛了：Error: 炸了/);
  assert.ok(seen.includes('serve-lock'), '抛了一下不等于收尾可以不收');
  assert.ok(!seen.includes('clean-exit'), '抛过就不是善终');
});

test('⚠️ hooks 里缺一步 ⇒ **大声说**（不许静默跳过）', async () => {
  const hooks = okHooks([]);
  delete hooks.channel;
  const { report, text } = await run(hooks);
  assert.deepEqual(
    report.failed.map((f) => f.id),
    ['channel'],
  );
  assert.match(text, /没有「关掉租户通道」这一步/);
  assert.equal(report.clean, false);
});

test('⚠️ 上限的**量级**要按"合法收口本来要多久"来定（不许卡得比正常收口还紧）', () => {
  // `DshAgent.dispose()` 每卸一个 agent 最多等 2 秒；`agentMaxProcesses` 那档最多 4 个
  // ⇒ **合法的收口**本来就可能要 8 秒 —— 单步上限必须宽于它（不然正常收口会被判成"没等完"）。
  const AGENT_DISPOSE_MS = 2000;
  const MAX_AGENTS = 4;
  assert.ok(
    STEP_CAP_MS > AGENT_DISPOSE_MS * MAX_AGENTS,
    `单步上限 ${STEP_CAP_MS} 毫秒太紧：合法的 agent 收口最长可能到 ${AGENT_DISPOSE_MS * MAX_AGENTS} 毫秒`,
  );
  // 总上限要**低于**"三步各自卡满" —— 否则它永远轮不到兜底（那就等于没有）
  assert.ok(TOTAL_CAP_MS < STEP_CAP_MS * 3, '总上限要低于"三步各自卡满"');
});

test('🔴 判据：`serve.js` 走的是**这份**预算（不许又手写一遍没有上限的 await）', () => {
  const src = nodeFs.readFileSync(new URL('../src/serve.js', import.meta.url), 'utf8');
  const at = src.indexOf('runShutdown({');
  assert.ok(at > 0, '收工那条路要走 `runShutdown()`');
  const tail = src.slice(at);
  for (const id of TODAYS_ORDER) {
    assert.match(tail, new RegExp(`(^|[\\s{])'?${id}'?:`, 'm'), `hooks 里缺 \`${id}\``);
  }
  // ⚠️ 旧写法**不许**留着：留一条没上限的 await，这一条就又是空的
  assert.ok(!/await close\(\)/.test(src), '`await close()` 要进 hooks，不留在外面');
  assert.ok(!/process\.exit\(0\)/.test(src), '`process.exit(0)` 归 `runShutdown` 管');
});
