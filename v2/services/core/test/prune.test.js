// 会话记录目录的清理：**哪些能删、照计划真删**。
//
// 欠账第 9 条（`docs/dev/07-TIMEOUT.md` §6.6：`$DSH_HOME/sessions/` 只涨不降）+
// 手册不变量 **N9「任何存储都要能回答『这条怎么删干净』」**。
//
// ⚠️ 这一层是**删数据**，所以测试的重点不是"它删得对不对"，而是
//    **"它会不会删到不该删的"**——下面每一条 🔴 都是那个形状：
//      · 正在跑的那一份（新近保护窗 / 锁）
//      · 保底要留的那几份（排障要看的）
//      · 计划定了之后又被写过的那些（"正在被写"的唯一信号）
//      · 计划之外的路径（目录穿越）
//
// 量法只有一套（`measureTree` = 整棵树里最新的 mtime）：扫的时候用它、
// 删之前重核也用它。**两边不一样的话，"没变"这句话就是假的。**

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import {
  MAX_AGE_MS,
  MAX_KEEP_COUNT,
  MAX_TOTAL_BYTES,
  MIN_KEEP_COUNT,
  NEW_RECENT_PROTECT_MS,
  applyPrune,
  formatBytes,
  measureTree,
  planPrune,
  probeLock,
  scanEntries,
  summarize,
} from '../src/prune.js';

const HERE = nodePath.dirname(new URL(import.meta.url).pathname);
const REPO = nodePath.resolve(HERE, '..', '..', '..', '..');
const CLI = nodePath.join(REPO, 'scripts', 'prune-sessions.mjs');

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 一条目录项（纯数据，给 `planPrune` 用）。 */
const entry = (name, { ageMs = 0, sizeBytes = 1000 } = {}) => ({
  name,
  path: `/tmp/sessions/${name}`,
  mtimeMs: NOW - ageMs,
  sizeBytes,
});

/** 关掉那两条"绝不删"、放大容量线 —— 用来单独看**一条**规矩在做什么。 */
const ONLY = { now: NOW, protectMs: 0, minKeep: 0, maxAgeMs: MAX_AGE_MS, maxBytes: 0, maxCount: 0 };

/** 真刀真枪的临时目录树。 */
function tmpRoot() {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-prune-'));
}

/** 造一条像 DSH 那样的记录目录：`session.lock` + `session.v3.jsonl.zstd`。 */
function makeSessionDir(root, name, { bytes = 200, ageMs = 0 } = {}) {
  const dir = nodePath.join(root, name);
  nodeFs.mkdirSync(dir, { recursive: true });
  const lock = nodePath.join(dir, 'session.lock');
  const rec = nodePath.join(dir, 'session.v3.jsonl.zstd');
  nodeFs.writeFileSync(lock, '');
  nodeFs.writeFileSync(rec, Buffer.alloc(bytes, 7));
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    for (const p of [dir, lock, rec]) nodeFs.utimesSync(p, t, t);
  }
  return dir;
}

// ── 一、两条"绝不删" ───────────────────────────────────────

test('🔴 新近保护窗内的一份都不许删（正在跑的那个可能就在里面）', () => {
  const entries = [
    entry('live', { ageMs: 1 * MIN }), // 还在被写
    entry('old_1', { ageMs: 10 * DAY }),
    entry('old_2', { ageMs: 20 * DAY }),
  ];
  const plan = planPrune({ ...ONLY, protectMs: 30 * MIN, entries });

  assert.deepEqual(plan.remove.map((e) => e.name), ['old_2', 'old_1']);
  assert.ok(!plan.remove.some((e) => e.name === 'live'), '★ 窗口里的一份都不许进 remove');
  assert.equal(plan.protectedRecent, 1);
});

test('窗的边界：正好等于窗口的删得掉，比窗口新一分钟的删不掉', () => {
  // 把"超时"那条关掉（maxAgeMs: 0）⇒ 删不删**只看窗口**这一条规矩
  const at = planPrune({
    ...ONLY,
    protectMs: 30 * MIN,
    maxAgeMs: 0,
    entries: [entry('at_edge', { ageMs: 30 * MIN })],
  });
  assert.equal(at.remove.length, 1, '正好卡在窗口上 ⇒ 不算"比窗口还新"');

  const inside = planPrune({
    ...ONLY,
    protectMs: 30 * MIN,
    maxAgeMs: 0,
    entries: [entry('inside', { ageMs: 30 * MIN - 1 })],
  });
  assert.equal(inside.remove.length, 0);
});

test('🔴 保底条数**哪怕很旧也不许删**（一份不剩就没法排障了）', () => {
  // 全部都很老（远超保留时长），只看保底
  const entries = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'].map((n, i) =>
    entry(n, { ageMs: 400 * DAY + i * MIN }),
  );
  const plan = planPrune({ ...ONLY, minKeep: 3, entries });

  assert.deepEqual(plan.keep.map((e) => e.name), ['n1', 'n2', 'n3'], '最新的 3 份留下');
  assert.deepEqual(plan.remove.map((e) => e.name), ['n6', 'n5', 'n4'], '其余从最旧开始');
  assert.equal(plan.protectedFloor, 3);
});

test('默认的那两个数就是"进程上限 + 1"与"10 倍单轮收口"——改它要连着理由一起改', () => {
  assert.equal(MIN_KEEP_COUNT, 5, '默认保底 5 = agentMaxProcesses(4) + 1');
  assert.equal(NEW_RECENT_PROTECT_MS, 30 * MIN, '默认窗 30 分钟 = 10 × turnDeadlineMs(180s)');
  assert.ok(MAX_AGE_MS > 0 && MAX_TOTAL_BYTES > 0 && MAX_KEEP_COUNT > 0);
});

// ── 二、两条"该删的" ───────────────────────────────────────

test('超时的删掉，而且**从最旧开始**', () => {
  const entries = [
    entry('d1', { ageMs: 1 * DAY }),
    entry('d9', { ageMs: 9 * DAY }),
    entry('d8', { ageMs: 8 * DAY }),
  ];
  const plan = planPrune({ ...ONLY, maxAgeMs: 7 * DAY, entries });

  assert.deepEqual(plan.remove.map((e) => e.name), ['d9', 'd8'], '★ 最旧的先走');
  assert.deepEqual(plan.keep.map((e) => e.name), ['d1']);
});

test('超容量的删到线以内，也是**从最旧开始**', () => {
  const entries = [1, 2, 3, 4, 5].map((i) => entry(`c${i}`, { ageMs: i * HOUR, sizeBytes: 100 }));
  const plan = planPrune({ ...ONLY, maxBytes: 250, entries });

  assert.deepEqual(plan.remove.map((e) => e.name), ['c5', 'c4', 'c3']);
  assert.equal(plan.freedBytes, 300);
  assert.equal(plan.totalBytes, 500);
});

test('超条数也删（"一天跑了一万次"是条数问题）', () => {
  const entries = [1, 2, 3, 4].map((i) => entry(`n${i}`, { ageMs: i * HOUR, sizeBytes: 1 }));
  const plan = planPrune({ ...ONLY, maxCount: 2, entries });
  assert.deepEqual(plan.remove.map((e) => e.name), ['n4', 'n3']);
  assert.equal(plan.keep.length, 2);
});

test('容量没超 + 时间没超 ⇒ 什么都不删（这条最容易写反）', () => {
  const entries = [1, 2, 3, 4, 5, 6, 7].map((i) => entry(`ok${i}`, { ageMs: i * HOUR, sizeBytes: 10 }));
  const plan = planPrune({ ...ONLY, maxBytes: 10_000, maxCount: 100, entries });

  assert.deepEqual(plan.remove, []);
  assert.equal(plan.freedBytes, 0);
  assert.equal(plan.keep.length, 7, '一份都不许动');
});

test('容量按**整批**算：留着的那几份也占地方（不然永远删不完）', () => {
  const entries = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => entry(`p${i}`, { ageMs: i * MIN, sizeBytes: 100 }));
  // 保底 3 份（300）；容量线 550 ⇒ 还要从最旧的开始再删掉 3 份
  const plan = planPrune({ ...ONLY, minKeep: 3, maxBytes: 550, entries });
  assert.equal(plan.remove.length, 3);
  assert.ok(plan.totalBytes - plan.freedBytes <= 550);
});

// ── 三、"不知道"一律当成"不许删" ───────────────────────────

test('🔴 mtime 读不出来的 ⇒ **留着**（删除是不可逆的那一侧）', () => {
  const plan = planPrune({
    ...ONLY,
    entries: [
      { name: 'mystery', path: '/tmp/x', mtimeMs: Number.NaN, sizeBytes: 999 },
      entry('old', { ageMs: 99 * DAY }),
    ],
  });
  assert.ok(plan.keep.some((e) => e.name === 'mystery'), '不知道多新 ⇒ 不删');
  assert.equal(plan.protectedUnknown, 1);
  assert.deepEqual(plan.remove.map((e) => e.name), ['old']);
});

test('同一毫秒用名字打破平局 ⇒ 同一份输入跑两次计划一样（事后能复核）', () => {
  const entries = [
    { name: 'b', path: '/tmp/b', mtimeMs: NOW - 9 * DAY, sizeBytes: 1 },
    { name: 'a', path: '/tmp/a', mtimeMs: NOW - 9 * DAY, sizeBytes: 1 },
    { name: 'c', path: '/tmp/c', mtimeMs: NOW - 9 * DAY, sizeBytes: 1 },
  ];
  const p1 = planPrune({ ...ONLY, entries });
  const p2 = planPrune({ ...ONLY, entries });
  assert.deepEqual(p1.remove.map((e) => e.name), p2.remove.map((e) => e.name));
  assert.deepEqual(p1.remove.map((e) => e.name), ['c', 'b', 'a'], '最旧在前，同名次按名字');
});

test('空计划 / 空输入 / 乱输入 ⇒ 不抛，返回空计划', () => {
  for (const bad of [[], null, undefined, 'nope', 7]) {
    const plan = planPrune({ entries: bad, now: NOW });
    assert.deepEqual(plan.remove, []);
    assert.equal(plan.freedBytes, 0);
  }
});

// ── 四、真删：三道闸 ───────────────────────────────────────

test('🔴 删之前 mtime 变了 ⇒ 跳过（"正在被写"就这一个可观察信号）', () => {
  const root = tmpRoot();
  const dir = makeSessionDir(root, 'rec', { bytes: 128 });
  const scan = scanEntries({ root });
  assert.equal(scan.entries.length, 1);

  const now = Date.now() + 99 * DAY; // 让"超时"这条成立
  const plan = planPrune({ entries: scan.entries, now, protectMs: 0, minKeep: 0, maxAgeMs: MAX_AGE_MS });
  assert.equal(plan.remove.length, 1, '计划里本来是要删的');

  // 计划定了之后，它还**又被写了一次**（模拟那一轮还在跑）
  const rec = nodePath.join(dir, 'session.v3.jsonl.zstd');
  const later = new Date(Date.now() + 5000);
  nodeFs.utimesSync(rec, later, later);

  const out = applyPrune(plan.remove, { root });
  assert.equal(out.removed.length, 0);
  assert.deepEqual(out.skipped.map((s) => s.reason), ['changed']);
  assert.ok(nodeFs.existsSync(dir), '★ 必须还在');

  // 重新扫一遍（mtime 已经进计划了）⇒ 这一次才删
  const again = planPrune({
    entries: scanEntries({ root }).entries,
    now,
    protectMs: 0,
    minKeep: 0,
    maxAgeMs: MAX_AGE_MS,
  });
  const out2 = applyPrune(again.remove, { root });
  assert.deepEqual(out2.removed.map((e) => e.name), ['rec']);
  assert.ok(!nodeFs.existsSync(dir), '这一次真的删掉了');

  nodeFs.rmSync(root, { recursive: true, force: true });
});

test('🔴 有人锁着的那一份跳过（比 mtime 更确定的信号）', () => {
  const root = tmpRoot();
  makeSessionDir(root, 'locked_one');
  makeSessionDir(root, 'free_one');
  const scan = scanEntries({ root });
  const now = Date.now() + 99 * DAY;
  const plan = planPrune({ entries: scan.entries, now, protectMs: 0, minKeep: 0, maxAgeMs: MAX_AGE_MS });
  assert.equal(plan.remove.length, 2);

  // 注入的"锁探测"：`locked_one` 有人用着。**不做真的删**（rm 也注入）
  const calls = [];
  const out = applyPrune(plan.remove, {
    root,
    rm: (p) => calls.push(p),
    isLocked: (lockPath) => (String(lockPath).includes('locked_one') ? true : false),
  });

  assert.deepEqual(out.removed.map((e) => e.name), ['free_one']);
  assert.deepEqual(out.skipped.map((s) => s.reason), ['locked']);
  assert.deepEqual(calls, [nodePath.join(root, 'free_one')], '只对没锁的那个动手');
  assert.ok(nodeFs.existsSync(nodePath.join(root, 'locked_one')));

  nodeFs.rmSync(root, { recursive: true, force: true });
});

test('🔴 只删传进来的那些路径：名字里带 `..` 也穿不出去（防目录穿越）', () => {
  const root = tmpRoot();
  const inside = makeSessionDir(root, 'inside');
  const outside = tmpRoot(); // 另一个目录，绝不该被碰

  const calls = [];
  const out = applyPrune(
    [
      { name: '../../etc/passwd', path: inside, mtimeMs: measureTree(inside).mtimeMs, sizeBytes: 1 },
      { name: '偷来的', path: outside, mtimeMs: 0, sizeBytes: 1 }, // 不在 root 底下
      { name: '没给路径' }, // 连 path 都没有 ⇒ 不猜
      { name: '相对路径', path: 'rel/x', mtimeMs: 0, sizeBytes: 1 },
    ],
    { root, rm: (p) => calls.push(p) },
  );

  assert.deepEqual(calls, [inside], '★ 只有 root 底下那一个被交给 rm');
  assert.deepEqual(
    out.skipped.map((s) => s.reason).sort(),
    ['no-path', 'not-absolute', 'outside'],
  );
  // ⚠️ 名字里的 `..` **没有**参与拼路径（拼了的话 calls 就会是 /etc/passwd 之类）
  assert.ok(!calls.some((p) => p.includes('..')));

  nodeFs.rmSync(root, { recursive: true, force: true });
  nodeFs.rmSync(outside, { recursive: true, force: true });
});

test('删之前那一份已经不在了 / 量不动了 ⇒ 跳过（不抛）', () => {
  const root = tmpRoot();
  const out = applyPrune([{ name: 'ghost', path: nodePath.join(root, 'ghost'), mtimeMs: 1, sizeBytes: 1 }], {
    root,
  });
  assert.deepEqual(out.skipped.map((s) => s.reason), ['gone']);
  nodeFs.rmSync(root, { recursive: true, force: true });
});

test('rm 抛错 ⇒ 记成 error，接着处理后面的（一个删不掉不该拖垮整批）', () => {
  const root = tmpRoot();
  const a = makeSessionDir(root, 'a');
  const b = makeSessionDir(root, 'b');
  const items = scanEntries({ root }).entries;
  const out = applyPrune(items, {
    root,
    rm: (p) => {
      if (p.endsWith('/a')) throw new Error('EACCES：别问，就是不让删');
      nodeFs.rmSync(p, { recursive: true, force: true });
    },
  });

  assert.deepEqual(out.skipped.map((s) => s.reason), ['error']);
  assert.deepEqual(out.removed.map((e) => e.name), ['b'], '后一个照样做了');
  assert.ok(nodeFs.existsSync(a));
  nodeFs.rmSync(root, { recursive: true, force: true });
});

// ── 五、扫描：盘上真实的"两层"形状 ─────────────────────────

test('扫得懂"项目分组 / 一条记录"两层，而且**组目录本身永远不是候选**', () => {
  const root = tmpRoot();
  nodeFs.mkdirSync(nodePath.join(root, '--home-deploy-hupo-workspace--'), { recursive: true });
  nodeFs.mkdirSync(nodePath.join(root, '--home-deploy-proj-bunny--'), { recursive: true });
  makeSessionDir(root, '--home-deploy-hupo-workspace--/main.aaa.1');
  makeSessionDir(root, '--home-deploy-hupo-workspace--/main.aaa.2');
  makeSessionDir(root, '--home-deploy-proj-bunny--/main.bbb.1');
  nodeFs.mkdirSync(nodePath.join(root, '--home-deploy-hupo-workspace--/attachments'), { recursive: true });
  nodeFs.writeFileSync(nodePath.join(root, '--home-deploy-hupo-workspace--/attachments/a.txt'), 'x');

  const scan = scanEntries({ root });
  const names = scan.entries.map((e) => e.name).sort();
  assert.deepEqual(names, [
    '--home-deploy-hupo-workspace--/main.aaa.1',
    '--home-deploy-hupo-workspace--/main.aaa.2',
    '--home-deploy-proj-bunny--/main.bbb.1',
  ]);
  assert.ok(!names.includes('--home-deploy-hupo-workspace--'), '★ 组目录不候选（那是"别人的目录"）');

  nodeFs.rmSync(root, { recursive: true, force: true });
});

test('根目录底下直接就是记录（有人把 --dir 指到某一组）⇒ 也认', () => {
  const root = tmpRoot();
  makeSessionDir(root, 'main.aaa.1');
  const scan = scanEntries({ root });
  assert.deepEqual(scan.entries.map((e) => e.name), ['main.aaa.1']);
  nodeFs.rmSync(root, { recursive: true, force: true });
});

test('符号链接不跟（跟出去就可能删到别处）；读不动的进 unreadable 而不是进计划', () => {
  const root = tmpRoot();
  const elsewhere = tmpRoot();
  makeSessionDir(elsewhere, 'precious');
  nodeFs.symlinkSync(elsewhere, nodePath.join(root, 'link-to-elsewhere'));

  const scan = scanEntries({ root });
  assert.deepEqual(scan.entries, [], '链接不是候选');
  assert.ok(nodeFs.existsSync(nodePath.join(elsewhere, 'precious')), '也不可能被动到');

  nodeFs.rmSync(root, { recursive: true, force: true });
  nodeFs.rmSync(elsewhere, { recursive: true, force: true });
});

test('量法取的是**整棵树里最新的 mtime**（DSH 原地追加，目录 mtime 是落后的）', () => {
  const root = tmpRoot();
  const dir = makeSessionDir(root, 'rec');
  const old = new Date(Date.now() - 10 * DAY);
  const fresh = new Date(Date.now() - 1 * MIN);
  nodeFs.utimesSync(dir, old, old); // 目录很旧
  nodeFs.utimesSync(nodePath.join(dir, 'session.v3.jsonl.zstd'), fresh, fresh); // 文件刚被写

  const m = measureTree(dir);
  assert.ok(m.mtimeMs >= fresh.getTime() - 1000, '★ 不许报目录那个旧的 mtime');
  assert.equal(m.sizeBytes, nodeFs.statSync(nodePath.join(dir, 'session.lock')).size + 200);

  nodeFs.rmSync(root, { recursive: true, force: true });
});

test('目录不存在 / 空目录 ⇒ 不抛，返回空计划（"没东西可清"不是错）', () => {
  const missing = scanEntries({ root: nodePath.join(tmpRoot(), '根本没有这个目录') });
  assert.equal(missing.missing, true);
  assert.deepEqual(missing.entries, []);

  const emptyRoot = tmpRoot();
  const empty = scanEntries({ root: emptyRoot });
  assert.equal(empty.missing, false);
  assert.deepEqual(empty.entries, []);
  assert.deepEqual(planPrune({ entries: empty.entries, now: NOW }).remove, []);

  nodeFs.rmSync(emptyRoot, { recursive: true, force: true });
});

// ── 六、锁探测 ─────────────────────────────────────────────

test('锁探测三态：拿得到锁=没人用、拿不到=正在用、问不了=不知道（不许说成"没人用"）', () => {
  assert.equal(probeLock('/tmp/x/session.lock', { run: () => ({ status: 0 }) }), false);
  assert.equal(probeLock('/tmp/x/session.lock', { run: () => ({ status: 1 }) }), true);
  assert.equal(probeLock('/tmp/x/session.lock', { run: () => ({ error: new Error('ENOENT') }) }), null);
  assert.equal(probeLock('/tmp/x/session.lock', { run: () => ({ status: 9 }) }), null);
  assert.equal(
    probeLock('/tmp/x/session.lock', {
      run: () => {
        throw new Error('起不来');
      },
    }),
    null,
  );
  assert.equal(probeLock(null), null, '没有锁文件就别探（flock 会凭空造一个出来）');
});

test('★ 真的拿一个锁来试：锁着的时候探得到，放掉之后就探不到', async (t) => {
  const has = spawnSync('flock', ['--version'], { stdio: 'ignore' });
  if (has.status !== 0) {
    t.skip('这台机器上没有 flock');
    return;
  }
  const root = tmpRoot();
  const lock = nodePath.join(root, 'session.lock');
  nodeFs.writeFileSync(lock, '');
  assert.equal(probeLock(lock), false, '没人用的时候是"没锁"');

  // 用一个真进程把锁拿住（`cat` 会一直读到我们把它的 stdin 关掉为止）
  const holder = spawn('flock', ['-n', lock, 'cat'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const waitFor = async (want) => {
    for (let i = 0; i < 40; i += 1) {
      if (probeLock(lock) === want) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };
  assert.ok(await waitFor(true), '★ 有人锁着的时候必须探到"正在用"');

  holder.stdin.end();
  assert.ok(await waitFor(false), '放掉之后必须探到"没人用"');

  nodeFs.rmSync(root, { recursive: true, force: true });
});

// ── 七、给人看的那一句：过禁用词扫描 ───────────────────────

/**
 * 禁用词表**只有一份**：客户端的 `lib/models/forbidden_words.dart`。
 * 这里现读现抽（抄一份数组会漂）。抽不到足够多就**当场失败**——
 * 那是负向对照：万一抽取逻辑失效，所有"不许包含"的断言都会自动通过。
 */
function forbiddenWords() {
  const file = nodePath.join(REPO, 'v2', 'apps', 'mobile', 'lib', 'models', 'forbidden_words.dart');
  const text = nodeFs.readFileSync(file, 'utf8');
  const out = [];
  const re = /^\s*'([^']+)':/gm;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

test('summarize() 一句话：说得清、不带内部词（拿客户端那张禁用词表来扫）', () => {
  const words = forbiddenWords();
  assert.ok(words.length >= 15, `禁用词表没抽出来（只抽到 ${words.length} 条）——闸会假绿`);
  assert.ok(words.includes('会话') && words.includes('工作区'), '抽出来的得是那张表');

  const plan = planPrune({
    entries: [1, 2, 3, 4, 5, 6, 7].map((i) => entry(`s${i}`, { ageMs: (7 + i) * DAY })),
    now: NOW,
    protectMs: 0,
    minKeep: 0,
    maxAgeMs: MAX_AGE_MS,
  });
  const line = summarize(plan);
  assert.ok(line.length > 0);
  assert.ok(/^7 份/.test(line), `要有几个：${line}`);
  assert.ok(/MB|KB|B/.test(line), `要有能腾多少：${line}`);
  assert.ok(/没动/.test(line), '只是计划的时候要说清"还没动它们"');

  // ⚠️ 真删完之后**不许**还说"还没动它们"——同一句话要能说两种状态
  const done = summarize(plan, {
    applied: true,
    done: { removed: 5, freedBytes: 3 * 1024 * 1024, liveSkipped: 2 },
  });
  assert.ok(/清掉了 5 份/.test(done), done);
  assert.ok(!/没动它们/.test(done), done);
  assert.ok(/2 份还在用着/.test(done), done);
  assert.ok(/3 MB/.test(done), `要报**真做出来的**数（不是计划那个）：${done}`);

  const clean = [
    line,
    summarize({ keep: [], remove: [], freedBytes: 0 }),
    summarize(null),
    done,
    summarize(plan, { applied: true, done: { removed: 7, freedBytes: plan.freedBytes } }),
    summarize({ keep: [], remove: [], freedBytes: 0 }, { applied: true }),
    summarize({ keep: [], remove: [], freedBytes: 0 }, {
      applied: true,
      done: { removed: 0, freedBytes: 0, liveSkipped: 3 },
    }),
  ];
  for (const s of clean) {
    for (const w of words) {
      assert.ok(!s.includes(w), `内部词「${w}」漏进了要显示给主人的话：${s}`);
    }
  }

  // 负向对照：这个扫法本身真的抓得住（不然上面那几条都是空转）
  assert.ok(words.some((w) => `这里有${w}两个字`.includes(w)), '扫描逻辑失效了');
});

// ── 八、端到端：CLI 的承诺 ─────────────────────────────────

test('🔴 CLI 默认**只列出来**（不加 --apply 一个都不许少）', () => {
  const root = tmpRoot();
  for (let i = 0; i < 8; i += 1) makeSessionDir(root, `main.aaa.${i}`, { ageMs: (10 + i) * DAY });

  const dry = spawnSync(process.execPath, [CLI, '--dir', root, '--json'], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  const j = JSON.parse(dry.stdout);
  assert.equal(j.applied, false);
  assert.equal(j.counts.remove, 3, '超出保留时长的那 3 份在计划里');
  assert.equal(j.wouldRemove.length, 3);
  for (let i = 0; i < 8; i += 1) {
    assert.ok(nodeFs.existsSync(nodePath.join(root, `main.aaa.${i}`)), '★ dry-run 一份都不许少');
  }

  const applied = spawnSync(process.execPath, [CLI, '--dir', root, '--apply', '--json'], { encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  const j2 = JSON.parse(applied.stdout);
  assert.equal(j2.counts.remove, 3);
  assert.ok(/^清掉了 3 份/.test(j2.summary), `真删完要说完成时：${j2.summary}`);
  assert.equal(nodeFs.readdirSync(root).length, 5, '保底 5 份留下了');

  nodeFs.rmSync(root, { recursive: true, force: true });
});

test('CLI 对不存在的目录也**不抛**，退出码 0（"没东西可清"不是错）', () => {
  const root = nodePath.join(nodeOs.tmpdir(), `hupo-prune-nope-${Date.now()}`);
  const r = spawnSync(process.execPath, [CLI, '--dir', root, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.scanned, 0);
  assert.equal(j.counts.remove, 0);
  assert.equal(j.summary, '现在没有该清的旧记录，一份都不用动。');
});

test('CLI 参数写错 ⇒ 退出码 2 且说清怎么用（不是静默地什么都没干）', () => {
  const r = spawnSync(process.execPath, [CLI, '--没有这个参数'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.ok(/用法/.test(r.stderr), r.stderr);
});

// ── 九、小工具 ─────────────────────────────────────────────

test('formatBytes：0 不写成 "NaN B"，量级要能看懂', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(Number.NaN), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(1024 * 1024 * 8.3), '8.3 MB');
});
