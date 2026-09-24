// **P1 时间话术：有口径才说 · 承诺要落盘 · 到点没完必须再报 · 删失也要算**
// （契约 `docs/dev/88-P1-TIME-WAIT.md` §二.4 · §四 T3 / T5）。
//
// 每一组都带**反例的正身**：
//   T3① 时间/频度/比较级必须配**依据 id**（没有 ⇒ 闸抛；有 ⇒ 过）。
//   T3② **我们的文案表**逐条扫：凡命中时间词的条目必须声明依据；删依据 ⇒ 红。
//   T3③ 分位：**含删失**的第 90 分位；把删失去掉 ⇒ 样本变少/分位变短；
//        把 timeout 改成 completed ⇒ 只算做完的那一份**必须变**（`87` §③.7 的判据）。
//   T5  承诺行 ＋ 到点没完 ⇒ **必须再报一次**；删 `promiseId` ⇒ **不可查**（不许静默过）。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';

import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';
import { Dispatcher } from '../src/dispatcher.js';
import { WorkLog } from '../src/worklog.js';
import { FAILED_LINES, NOTICE_TEXTS } from '../src/notice.js';
import { WORK_COPY } from '../src/work-words.js';
import {
  MIN_SAMPLES,
  PROMISE_LATE,
  PROMISE_LOG,
  PromiseBook,
  assertBackedText,
  durationEvidence,
  durationStats,
  evidenceFor,
  evidenceKindOf,
  hasTimeClaim,
  percentile,
  recheckPromises,
  scanTimeWords,
} from '../src/time-words.js';

const tmp = () => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-time-'));

test('T3① 时间词扫得准（正反例逐条对表）', () => {
  // 命中：承诺类 / 频度类 / 比较级类 / 带数的时间
  for (const s of [
    '这一步通常很快。',
    '马上就好。',
    '比平常久了一点。',
    '这件事比我说久了点，还在做。',
    '已经等了 12 秒',
    '再等几分钟就行',
  ]) {
    assert.equal(hasTimeClaim(s), true, `该命中：${s}`);
  }
  // 不命中：我们的正常话（**不许误报** —— 误报会逼着人往话里塞没用的依据）
  for (const s of [
    '我去做，做完叫你。',
    '做完了。',
    '那件还在做。',
    '这件事我没做完，你回头看一眼。',
    '已经停了，没做完。',
  ]) {
    assert.equal(hasTimeClaim(s), false, `不该命中：${s} —— ${JSON.stringify(scanTimeWords(s))}`);
  }
});

test('T3① 没有依据的时间词**闸抛**；给了依据才放行', () => {
  // 反例：有时间词、没依据 ⇒ 抛
  assert.throws(() => assertBackedText('马上就好', {}), /没有能复算的依据/);
  // 正对照：有真依据（实测已等 12 秒）⇒ 过
  const ok = assertBackedText('已经等了 12 秒', { evidence: 'elapsed:12000' });
  assert.equal(ok.hits.length, 1);
  assert.equal(ok.evidence.kind, 'elapsed');
  // 承诺那句：依据是**那行落盘的承诺**
  const late = assertBackedText('这件事比我说久了点，还在做', { evidence: 'promise:p_1' });
  assert.equal(late.evidence.kind, 'promise');
  // 认不出的依据 id ⇒ 一样抛（**不许**拿一个乱字符串糊过去）
  assert.throws(() => assertBackedText('马上就好', { evidence: '我保证' }), /没有能复算的依据/);
  assert.equal(evidenceFor('elapsed:'), null);
  assert.equal(evidenceFor('duration:p90:main:1200').kind, 'duration');
  assert.equal(evidenceFor('duration:avg:main:1200'), null, '只有 p90 这一种统计口径');
});

test('T3② **我们自己的文案表**逐条扫：命中时间词 ⇒ 必须有依据；删依据 ⇒ 红', () => {
  // 文案表 = 后台那四句（`work-words.js`）＋ 通知那几张（`notice.js`）
  const tables = [
    ...WORK_COPY.map((e) => ({ id: `work:${e.id}`, text: e.text, evidence: e.evidence })),
    ...Object.entries(NOTICE_TEXTS).map(([k, text]) => ({ id: `notice:${k}`, text, evidence: null })),
    ...Object.entries(FAILED_LINES).map(([k, text]) => ({ id: `failed:${k}`, text, evidence: null })),
  ];
  const offenders = [];
  for (const e of tables) {
    if (!hasTimeClaim(e.text)) continue;
    if (!e.evidence) offenders.push(e.id);
  }
  // 🔴 契约 `88` §二.4：**没有落盘口径不许说时间词**。这张表里一个都不许有。
  assert.deepEqual(offenders, [], `这几条有时间词却没依据：${offenders.join('、')}`);

  // 反例的正身：**给一条加上时间词** ⇒ 上面那条判据立刻红
  const poisoned = [...tables, { id: 'work:poisoned', text: '这件事通常很快。', evidence: null }];
  const bad = poisoned.filter((e) => hasTimeClaim(e.text) && !e.evidence).map((e) => e.id);
  assert.deepEqual(bad, ['work:poisoned']);

  // 有依据的那两条：声明的依据**认得出来**
  for (const e of WORK_COPY.filter((x) => x.evidence)) {
    const kind = evidenceKindOf(e);
    assert.ok(['elapsed', 'duration', 'promise'].includes(kind), `${e.id} 的依据种类：${kind}`);
  }
});

test('T3③ 分位：**含删失**的第 90 分位（删掉删失 ⇒ 会变；改标签 ⇒ 会变）', () => {
  const done = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((ms) => ({ ms, censored: false }));
  // 被超时/被杀那几轮：量到的是**下限**（它们卡在超时线上）
  const censored = [1900, 1950, 2000].map((ms) => ({ ms, censored: true }));
  const all = [...done, ...censored];

  const s = durationStats(all);
  assert.equal(s.n, 13);
  assert.equal(s.censored, 3, '删失样本**也在样本里**（T3：删失也要算）');
  assert.ok(s.p90 >= s.completedP90, `含删失的 p90（${s.p90}）不许小于只算做完的（${s.completedP90}）`);
  assert.equal(s.p90, percentile(all.map((x) => x.ms), 0.9));

  // 🔴 反例：**只对 completed 求分位**（把长尾删掉再说分位）
  const dropped = durationStats(done);
  assert.equal(dropped.censored, 0);
  assert.ok(dropped.p90 < s.p90, `删掉删失之后分位必须变短：${dropped.p90} < ${s.p90}`);
  assert.notEqual(s.censored, dropped.censored, '删失的条数要如实带着');

  // 🔴 `87` §③.7 的判据：把一批 timeout **改成 completed** ⇒ 那一份必须变
  const relabeled = durationStats(all.map((x) => ({ ms: x.ms, censored: false })));
  assert.equal(durationStats(all).completedP90, percentile(done.map((x) => x.ms), 0.9));
  assert.notEqual(
    relabeled.completedP90,
    s.completedP90,
    '把 timeout 当 completed 必须看得出来（否则"删失"这个标记白加了）',
  );
  assert.ok(relabeled.completedP90 > s.completedP90, '长的那几轮进来 ⇒ 分位变长');

  // 样本不足 ⇒ 只说"样本不足"，**不许报数**（保守档）
  const few = durationStats(done.slice(0, MIN_SAMPLES - 1));
  assert.equal(few.enough, false);
  assert.equal(durationEvidence('main', few), null, '样本不足 ⇒ 给不出依据 id（那就别说时间）');
  assert.ok(durationEvidence('main', s), '样本够了 ⇒ 依据 id 给得出');
});

test('T5 承诺：说了就落一行；到点没完 ⇒ **必须再报一次**；删 `promiseId` ⇒ 不可查', () => {
  const store = new Store({ dataDir: tmp(), fsync: false });
  const book = new PromiseBook({ store, now: () => 1000 });
  book.make({ id: 'p:1', scopeId: 'main', ref: 'u_1', workId: 't:main:u_1', text: '我几分钟就好', basis: 'duration:p90:main:1200', dueAt: 2000 });

  const works = [{ id: 't:main:u_1', scopeId: 'main', ref: 'u_1', state: 'running', promiseId: 'p:1' }];
  // 到点之前：只是 pending
  const early = recheckPromises({ promises: store.readAll(PROMISE_LOG), works, now: 1500 });
  assert.equal(early.pending.length, 1);
  assert.equal(early.unfulfilled.length, 0);

  // 🔴 反例：**到点了还没再报** ⇒ 报"未兑现"（不许静默过）
  const late = recheckPromises({ promises: store.readAll(PROMISE_LOG), works, now: 2500 });
  assert.equal(late.unfulfilled.length, 1, JSON.stringify(late));
  assert.equal(late.unfulfilled[0].id, 'p:1');
  assert.equal(late.rate, 0, '没兑现也没再报 ⇒ 兑现率 0');

  // 再报一次 ⇒ 算"报了"（兑现率可复算）
  book.reReport({ id: 'p:1', text: '这件事比我说久了点，还在做' });
  const after = recheckPromises({ promises: store.readAll(PROMISE_LOG), works, now: 2500 });
  assert.equal(after.unfulfilled.length, 0);
  assert.equal(after.late.length, 1);
  assert.equal(after.rate, 1);

  // 到点之前做完了 ⇒ kept
  const store2 = new Store({ dataDir: tmp(), fsync: false });
  const book2 = new PromiseBook({ store: store2, now: () => 1000 });
  book2.make({ id: 'p:2', scopeId: 'main', ref: 'u_2', workId: 't:main:u_2', text: 'x', basis: 'elapsed:1000', dueAt: 2000 });
  book2.keep({ id: 'p:2' });
  const kept = recheckPromises({
    promises: store2.readAll(PROMISE_LOG),
    works: [{ id: 't:main:u_2', scopeId: 'main', ref: 'u_2', state: 'done', promiseId: 'p:2' }],
    now: 2500,
  });
  assert.equal(kept.kept.length, 1);
  assert.equal(kept.rate, 1);

  // 🔴 反例：**删掉 `promiseId`**（承诺挂在哪件活上不可查）⇒ 不许静默过
  const unmatchable = recheckPromises({
    promises: store2.readAll(PROMISE_LOG),
    works: [{ id: 't:main:u_2', scopeId: 'main', ref: 'u_2', state: 'running', promiseId: null }],
    now: 1500,
  });
  assert.equal(unmatchable.unmatchable.length, 1, JSON.stringify(unmatchable));
  assert.match(unmatchable.unmatchable[0].why, /不可查/);

  // 日期账在盘上（"可复算"的落点）
  assert.ok(store.readAll(PROMISE_LOG).some((e) => e.type === PROMISE_LATE));
});

test('T5 接线：派发器说了一句承诺 ⇒ 到点自动**再报一次**（落盘 ＋ 一条通知）', async () => {
  const store = new Store({ dataDir: tmp(), fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const work = new WorkLog({ store });
  const promises = new PromiseBook({ store, now: () => Date.now() });
  const handlers = new Map();
  const agent = { on: (t, f) => handlers.set(t, f), prompt: async () => ({}), emit: (t, p) => handlers.get(t)?.(p) };
  const rt = { agent: () => agent, stop: async () => {} };
  // `Notice`：后台那几句的出入口（真账）
  const { Notice } = await import('../src/notice.js');
  const notice = new Notice({ timeline });
  const d = new Dispatcher({
    timeline, runtime: rt, store, scopeId: 'main', agentKey: 'u1/main',
    work, promises, notice, turnDeadlineMs: 0,
  });

  await d.deliver('帮我做一件事', { messageId: 'u_1' });
  agent.emit('session-event', { event: { type: 'turn/start', data: { turn: 1 }, time: 1 } });
  // 承诺 5 秒做完（依据是同类样本分位）—— 到点还没收口 ⇒ 必须再报
  const made = d.mainSession.notePromise({
    ref: 'u_1', text: '这件事通常几分钟', basis: 'duration:p90:main:120000', dueAt: Date.now() + 40,
  });
  assert.ok(made?.id, '承诺要落上账');

  await new Promise((r) => setTimeout(r, 120));
  const events = store.readAll('main');
  assert.ok(events.some((e) => e.type === 'notice' && e.kind === 'work-late'), '到点没完 ⇒ 再报一次（落盘）');
  const late = store.readAll(PROMISE_LOG).filter((e) => e.type === PROMISE_LATE);
  assert.equal(late.length, 1, '再报这件事也要落一行');
});
