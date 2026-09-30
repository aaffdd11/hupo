// **小程序定时任务**（契约 `docs/dev/148-APP-FULL-SET.md` §四 · 主人："这些功能都要有"）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   · **T1** 清单的形状：上限、间隔下限、名字/"让它干什么"的长度、重名 —— 一律**拒**（不是夹住）；
//   · **T2** 到期判定：**新声明的这次就跑**（他当场看得到它会动）；跑过之后**要等够间隔**；
//   · **T3** 🔴 **注册制**：没声明（或**他关掉了**）⇒ **一件都不跑**；
//   · **T4** 🔴 **每天上限**（所有任务合起来算）⇒ 跑满就不跑；**跨天重新数**；
//   · **T5** 🔴 **串行**：一次只给一件；
//   · **T6** 🔴 **先记再跑**：账记不上 ⇒ **那一趟不许跑**；跑完账上要有 `lastAt/nextAt/day/n`；
//   · **T7** 🔴 **间隔兜底**：万一 `everyMs` 丢了 ⇒ 按**下限**算（**绝不许**变成"每个 tick 都跑"）。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';

import { Apps, PERMISSIONS, TASKS_PERMISSION } from '../src/apps.js';
import {
  MAX_TASKS_PER_APP,
  MIN_TASK_EVERY_MS,
  TASKS_PER_DAY,
  checkTaskList,
  createTaskRunner,
  dueTasks,
  nextTaskState,
} from '../src/app-tasks.js';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;

function tmpdir() {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-tasks-'));
}

// ── T1 · 清单的形状 ─────────────────────────────────────────

test('T1 清单只认规矩的：重名 / 间隔太短 / 太长 / 太多 / 缺东西 ⇒ **拒**（不许偷偷夹住）', () => {
  const good = checkTaskList([{ id: 'morning', title: '每天看一眼', everyMinutes: 60, prompt: '看看今天有什么' }]);
  assert.equal(good.ok, true);
  assert.deepEqual(good.tasks, [{ id: 'morning', title: '每天看一眼', everyMs: HOUR, prompt: '看看今天有什么' }]);
  assert.deepEqual(checkTaskList(undefined), { ok: true, tasks: [] });

  const bad = [
    'not-array',
    [{ id: 'A Bad', title: 'x', everyMinutes: 60, prompt: 'p' }], // id 形状
    [{ id: 'a', title: '', everyMinutes: 60, prompt: 'p' }], // 没名字
    [{ id: 'a', title: 'x', everyMinutes: 60, prompt: '' }], // 没说要干什么
    [{ id: 'a', title: 'x', everyMinutes: 5, prompt: 'p' }], // 🔴 太频（5 分钟）
    [{ id: 'a', title: 'x', everyMinutes: 60.5, prompt: 'p' }], // 不是整数分钟
    [{ id: 'a', title: 'x', everyMinutes: 60, prompt: 'p' }, { id: 'a', title: 'y', everyMinutes: 60, prompt: 'q' }], // 重名
    Array.from({ length: MAX_TASKS_PER_APP + 1 }, (_, i) => ({ id: `t${i}`, title: 'x', everyMinutes: 60, prompt: 'p' })),
    [{ id: 'a', title: 'x'.repeat(41), everyMinutes: 60, prompt: 'p' }],
    [{ id: 'a', title: 'x', everyMinutes: 60, prompt: 'y'.repeat(501) }],
  ];
  for (const one of bad) {
    assert.equal(checkTaskList(one).ok, false, `该拒：${JSON.stringify(one).slice(0, 80)}`);
  }
  // ⚠️ 下限就是下限（刚好等于 ⇒ 可以）
  const edge = checkTaskList([{ id: 'a', title: 'x', everyMinutes: MIN_TASK_EVERY_MS / 60_000, prompt: 'p' }]);
  assert.equal(edge.ok, true, '正好卡在下限上 ⇒ 收下');
});

test('T1 清单能**往返**：`meta()` 交回来的那一份（`everyMs`）再喂回 register 也要收下', () => {
  // 🔴 这条钉的是"装上来 / 复制一份 / 迁移"那条路：它们喂进去的是**读出来那一份**
  const stored = { id: 'morning', title: '每天看一眼', everyMs: HOUR, prompt: '看看今天有什么' };
  const got = checkTaskList([stored]);
  assert.equal(got.ok, true, '归一过的形状必须收（不然装带任务的小程序会当场报错）');
  assert.deepEqual(got.tasks, [stored]);
  // 反例：间隔太小照样拒（`everyMs` 这一路也不许绕过下限）
  assert.equal(checkTaskList([{ ...stored, everyMs: 1000 }]).ok, false);
});

test('T1 两个入口都拒：坏清单**连写都写不进去**；写了任务却没说要用 ⇒ 也拒', () => {
  const dir = tmpdir();
  const apps = new Apps({ dir, sub: 'u1', now: () => NOW });
  const badTask = { id: 'a', title: 'x', everyMinutes: 5, prompt: 'p' };
  assert.throws(
    () => apps.register({ id: 'a1', title: 'A', entry: 'index.html', permissions: [TASKS_PERMISSION], tasks: [badTask] }),
    /分钟/,
  );
  assert.throws(
    () =>
      apps.create({
        id: 'a2', title: 'A', icon: 'dice', entry: 'index.html', files: { 'index.html': '<p>x</p>' },
        permissions: [TASKS_PERMISSION], tasks: [badTask],
      }),
    /分钟/,
  );
  // 有任务、没那一格权限 ⇒ 拒
  assert.throws(
    () => apps.register({ id: 'a3', title: 'A', entry: 'index.html', tasks: [{ id: 'a', title: 'x', everyMinutes: 60, prompt: 'p' }] }),
    /一起给/,
  );
  assert.equal(apps.list().length, 0);
  assert.ok(PERMISSIONS.includes(TASKS_PERMISSION), '白名单里要有 tasks');
  nodeFs.rmSync(dir, { recursive: true, force: true });
});

// ── T2/T3/T4/T5/T7 · 到期判定（纯函数）──────────────────────────

test('T2 新声明的这次就跑；跑过之后要等够间隔；没到点 ⇒ 不跑', () => {
  const tasks = [{ id: 't', title: 'x', everyMs: HOUR }];
  assert.deepEqual(dueTasks({ tasks, state: {}, now: NOW, allowed: true }).map((t) => t.id), ['t'], '没跑过 ⇒ 该跑');
  const ran = { t: { lastAt: NOW, nextAt: NOW + HOUR, day: '2027-01-15', n: 1 } };
  assert.deepEqual(dueTasks({ tasks, state: ran, now: NOW + 1, allowed: true }), [], '刚跑过 ⇒ 不跑');
  assert.deepEqual(dueTasks({ tasks, state: ran, now: NOW + HOUR, allowed: true }).map((t) => t.id), ['t'], '到点 ⇒ 跑');
});

test('T3 🔴 他关掉了 / 没声明 ⇒ 一件都不跑', () => {
  const tasks = [{ id: 't', title: 'x', everyMs: HOUR }];
  assert.deepEqual(dueTasks({ tasks, state: {}, now: NOW, allowed: false }), []);
  assert.deepEqual(dueTasks({ tasks: [], state: {}, now: NOW, allowed: true }), []);
  // 读不出来（`allowed` 不是 true）也**不许**跑（fail-closed）
  assert.deepEqual(dueTasks({ tasks, state: {}, now: NOW, allowed: undefined }), []);
});

test('T4 🔴 每天上限：跑满就不跑；**跨天重新数**', () => {
  const tasks = [{ id: 'a', title: 'x', everyMs: HOUR }, { id: 'b', title: 'y', everyMs: HOUR }];
  const day = '2027-01-15';
  const state = { a: { lastAt: 1, nextAt: 0, day, n: TASKS_PER_DAY }, b: { lastAt: 1, nextAt: 0, day, n: 0 } };
  assert.deepEqual(dueTasks({ tasks, state, now: NOW, allowed: true }), [], '今天跑满了 ⇒ 一件都不跑');
  // 跨天：`day` 不是今天 ⇒ 今天从 0 算起
  const next = { a: { lastAt: 1, nextAt: 0, day: '2027-01-14', n: TASKS_PER_DAY } };
  assert.deepEqual(dueTasks({ tasks: [tasks[0]], state: next, now: NOW, allowed: true }).map((t) => t.id), ['a'], '新的一天 ⇒ 又能跑');
});

test('T5 串行：一次只给一件（哪怕两件都到期）', () => {
  const tasks = [{ id: 'a', title: 'x', everyMs: HOUR }, { id: 'b', title: 'y', everyMs: HOUR }];
  const got = dueTasks({ tasks, state: {}, now: NOW, allowed: true });
  assert.equal(got.length, 1, '一次只给一件');
  // 显式放开 limit 才给两件（判据用；调度器永远用 1）
  assert.equal(dueTasks({ tasks, state: {}, now: NOW, allowed: true, limit: 2 }).length, 2);
});

test('T7 🔴 间隔丢了 ⇒ 按下限算（**绝不许**变成"每个 tick 跑一遍"）', () => {
  const st = nextTaskState({ entry: null, at: NOW, everyMs: 0 });
  assert.equal(st.nextAt, NOW + MIN_TASK_EVERY_MS, '垃圾间隔 ⇒ 兜到下限');
  assert.equal(nextTaskState({ entry: null, at: NOW, everyMs: -5 }).nextAt, NOW + MIN_TASK_EVERY_MS);
  assert.equal(nextTaskState({ entry: null, at: NOW, everyMs: HOUR }).nextAt, NOW + HOUR, '正常间隔照旧');
  // 到期那一路也一样兜
  const tasks = [{ id: 't', title: 'x', everyMs: 0 }];
  const state = { t: { lastAt: NOW, nextAt: 0, day: '2027-01-15', n: 1 } };
  assert.deepEqual(dueTasks({ tasks, state, now: NOW + 1000, allowed: true }), [], '刚跑过 1 秒 ⇒ 不许再跑');
});

// ── T6 · 执行器（注入假的 worlds/apps/deliver）──────────────────

function makeRunner({ items, grants = ['tasks'], state = {}, now = () => NOW, recordFails = false }) {
  const recorded = [];
  const delivered = [];
  const apps = {
    list: async () => items,
    grants: () => grants,
    taskState: () => state,
    recordTask: (id, taskId, at, everyMs) => {
      if (recordFails) throw new Error('盘写不进去');
      recorded.push({ id, taskId, at, everyMs });
      return {};
    },
  };
  const runner = createTaskRunner({
    worlds: { ids: () => ['u1'] },
    appsFor: () => apps,
    deliver: async (o) => {
      delivered.push(o);
    },
    now,
    log: () => {},
  });
  return { runner, recorded, delivered };
}

const ITEM = {
  id: 'jizhang',
  permissions: ['tasks'],
  tasks: [{ id: 'morning', title: '每天看一眼', everyMs: HOUR, prompt: '看看今天花了多少' }],
};

test('T6 执行器：到期的跑一件、**先记再跑**、而且把间隔记进账', async () => {
  const { runner, recorded, delivered } = makeRunner({ items: [ITEM] });
  const r = await runner.tick();
  assert.deepEqual(r.ran, [{ sub: 'u1', appId: 'jizhang', taskId: 'morning' }]);
  assert.deepEqual(recorded, [{ id: 'jizhang', taskId: 'morning', at: NOW, everyMs: HOUR }], '★ 先记再跑，而且带上间隔');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].task.id, 'morning');
});

test('T6 账记不上 ⇒ **那一趟不跑**（宁可少跑，不许"跑了没记"）', async () => {
  const { runner, delivered } = makeRunner({ items: [ITEM], recordFails: true });
  const r = await runner.tick();
  assert.deepEqual(r.ran, [], '没记上 ⇒ 不跑');
  assert.equal(delivered.length, 0);
});

test('T3/T4 执行器：他关掉了 ⇒ 不跑；刚跑过（没到点）⇒ 不跑；没有任务的 app 直接跳过', async () => {
  const off = makeRunner({ items: [ITEM], grants: [] });
  assert.deepEqual((await off.runner.tick()).ran, []);
  assert.equal(off.delivered.length, 0, '关掉 ⇒ 一件都不许跑');

  const justRan = makeRunner({
    items: [ITEM],
    state: { morning: { lastAt: NOW, nextAt: NOW + HOUR, day: '2027-01-15', n: 1 } },
  });
  assert.deepEqual((await justRan.runner.tick()).ran, []);
  assert.equal(justRan.delivered.length, 0);

  const none = makeRunner({ items: [{ id: 'plain', permissions: [], tasks: [] }] });
  assert.deepEqual((await none.runner.tick()).ran, []);
  assert.equal(none.delivered.length, 0);
});

test('T6 账落在盘上：`Apps.recordTask` 写 `tasks.json`，读回来是那一本', () => {
  const dir = tmpdir();
  const apps = new Apps({ dir, sub: 'u1', now: () => NOW });
  apps.register({ id: 'jizhang', title: '记账', entry: 'index.html', permissions: [TASKS_PERMISSION], tasks: [ITEM.tasks[0]] });
  assert.deepEqual(apps.taskState('jizhang'), {}, '还没跑过 ⇒ 空账');
  const st = apps.recordTask('jizhang', 'morning', NOW, HOUR);
  assert.deepEqual(st, { lastAt: NOW, nextAt: NOW + HOUR, day: new Date(NOW).toISOString().slice(0, 10), n: 1 });
  assert.deepEqual(apps.taskState('jizhang').morning, st, '要读得回来');
  // 同一天再记一次 ⇒ n 累加；换一天 ⇒ 从 1 开始
  assert.equal(apps.recordTask('jizhang', 'morning', NOW + HOUR, HOUR).n, 2);
  assert.equal(apps.recordTask('jizhang', 'morning', NOW + 24 * HOUR, HOUR).n, 1, '★ 跨天重新数');
  // 留一行审计
  assert.match(nodeFs.readFileSync(nodePath.join(dir, 'hupo', 'apps', 'audit.jsonl'), 'utf8'), /"what":"task-run"/);
  nodeFs.rmSync(dir, { recursive: true, force: true });
});
