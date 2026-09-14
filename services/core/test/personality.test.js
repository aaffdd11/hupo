// 个性适配层（personality.js）的测试。
//
// 守四件事：
//   1. 画像从对话流里**纯统计**出来 —— 短句指令派/长段细问派/客气程度都要算对
//   2. "舒不舒服"的机械规则能抓出真问题（篇幅不配、太客套、空夸迎合）
//   3. 画像持久化：本会话优先、全局兜底、过期不采；**探针会话不算主人**
//   4. 任务簿按类别去重：迎合/个性适配 与老类别分得清
//
// 跑：node --test "test/*.test.js"

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  comfortFindings,
  median,
  personalityBlock,
  PersonalityStore,
  profileFromRows,
  topBigrams,
} from '../src/personality.js';
import { TaskBook } from '../src/debug-agent.js';

/** 造 timeliness.turns 风格的行。 */
function row(userText, text, origin = 'reactive') {
  return { userText, text, origin };
}

test('median：中位数不要求长度、不排序破坏原数组', () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 9]), 9); // 偶数取上中位（floor(len/2)）
  assert.equal(median([3, 1, 2]), 2);
});

test('profileFromRows：短句指令派 —— 画像要能认出主人的说话形状', () => {
  const rows = [
    row('查一下天气', '（第一句）今天上海多云，最高 28 度。'),
    row('帮我订', '好，这就去订。'),
    row('改一下', '已改。'),
    row('跑测试', '测试全过。'),
    row('推上去', '推好了。'),
    row('快点', '在办了。'),
  ];
  const p = profileFromRows(rows, 'c_main');
  assert.equal(p.user.turns, 6);
  assert.ok(p.user.medianLen < 14, `短句派中位数 ${p.user.medianLen}`);
  assert.ok(p.flags.terse, '该是 terse');
  assert.ok(p.user.imperativeRatio > 0.45, `指令派比例 ${p.user.imperativeRatio}`);
  assert.ok(p.flags.imperativeHeavy, '该是 imperativeHeavy');
  assert.ok(p.advice.some((a) => a.includes('先给结论')), '建议里该有"先给结论"');
});

test('profileFromRows：长段细问派 + 情绪', () => {
  const rows = [];
  for (let i = 0; i < 8; i++) {
    rows.push(
      row(
        '你刚才说的那个方案，我想跟你确认一下具体是怎么个流程，第一步要做什么，第二步要做什么，中间会不会有什么风险需要提前注意的吗？',
        '流程是：第一步……第二步……中间的风险是……'
      )
    );
  }
  const p = profileFromRows(rows, 'c_main');
  assert.ok(p.flags.longWind, `该是 longWind（中位数 ${p.user.medianLen}）`);
  assert.ok(p.flags.questionHeavy, `该是 questionHeavy（比例 ${p.user.questionRatio}）`);
});

test('comfortFindings：主人短句、助手长篇 —— 要报"篇幅不配"', () => {
  const rows = [];
  for (let i = 0; i < 6; i++) {
    rows.push(
      row(
        '查一下',
        '关于这个问题，我先梳理一下背景，然后从三个层面展开说明：首先第一点是它的来龙去脉，其次第二点是它的影响因素，再其次第三点是它跟别的部分的关联，最后我再总结一下重点，希望能帮到你。'
      )
    );
  }
  const p = profileFromRows(rows, 'c_main');
  const f = comfortFindings(p);
  assert.ok(f.some((x) => x.kind === 'style-fit' && x.what.includes('短句')), JSON.stringify(f));
});

test('comfortFindings：主人不用敬语、助手堆客套 —— 要报"太客套"', () => {
  const rows = [];
  for (let i = 0; i < 6; i++) {
    rows.push(row('查一下', '尊敬的您，很荣幸为您服务，敬请稍候，由衷感谢您的信任。'));
  }
  const p = profileFromRows(rows, 'c_main');
  const f = comfortFindings(p);
  assert.ok(f.some((x) => x.kind === 'style-fit' && x.what.includes('客套')), JSON.stringify(f));
});

test('comfortFindings：空夸式漂亮话 —— 要报"迎合"（主人的原话：不是迎合）', () => {
  const rows = [];
  for (let i = 0; i < 6; i++) {
    rows.push(row('今天天气？', '您说得太对了！'));
  }
  const p = profileFromRows(rows, 'c_main');
  const f = comfortFindings(p);
  const fl = f.find((x) => x.kind === 'flattery');
  assert.ok(fl, JSON.stringify(f));
  assert.ok(fl.why.includes('不是迎合'), '理由要引用主人的原话');
});

test('profileFromRows：客气的主人不应被误报客套', () => {
  const rows = [];
  for (let i = 0; i < 6; i++) {
    rows.push(row('麻烦您帮我查一下天气，谢谢您。', '好的，上海今天多云。'));
  }
  const p = profileFromRows(rows, 'c_main');
  assert.ok(p.flags.formal, '该是 formal');
  const f = comfortFindings(p);
  assert.ok(!f.some((x) => x.what.includes('客套')), '客气的主人用敬语是贴合的，不该报');
});

test('personalityBlock：只给说话建议，并带"不迎合不造假"底线', () => {
  const rows = [row('查一下', '好。'), row('快点', '在办。'), row('改', '改好。')];
  const block = personalityBlock(profileFromRows(rows, 'c_main'));
  assert.ok(block.includes('主人的说话习惯'), block);
  assert.ok(block.includes('不是让他"顺他"') || block.includes('懂他'), '要有不迎合的底线');
  assert.equal(personalityBlock(null), null);
});

test('PersonalityStore：本会话优先、全局兜底、过期不采', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hupo-personality-'));
  const store = new PersonalityStore(dir);

  const pMain = profileFromRows([row('查一下', '好。')], 'c_main', { now: Date.now() });
  store.update(pMain);
  assert.equal(store.get('c_main').conversationId, 'c_main');

  // 新会话没有自己的画像 → 兜底用全局最新
  assert.equal(store.get('c_other').conversationId, 'c_main');

  // 超过 30 天不采
  const old = profileFromRows([row('查一下', '好。')], 'c_main', { now: Date.now() - 31 * 24 * 3600 * 1000 });
  store.update(old);
  assert.equal(store.get('c_main'), null, '过期画像不能用');
  assert.equal(store.get('c_other'), null);
});

test('PersonalityStore：探针会话不算主人，绝不污染画像', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hupo-personality-'));
  const store = new PersonalityStore(dir);
  store.update(profileFromRows([row('冒烟', '好。')], 'c_probe', { now: Date.now() }));
  store.update(profileFromRows([row('冒烟', '好。')], 'c_watch_x1', { now: Date.now() }));
  store.update(profileFromRows([row('冒烟', '好。')], 'c_bench', { now: Date.now() }));
  assert.equal(store.get('c_probe'), null);
  assert.equal(store.get('c_watch_x1'), null);
  assert.equal(store.get('c_bench'), null);
  assert.equal(store.get('c_main'), null, '全局也不该被探针污染');
});

test('TaskBook.issueClass：迎合/个性适配 与老类别分得清，按类去重', () => {
  assert.equal(TaskBook.issueClass('回答里出现空夸「说得太对」，没有新信息'), 'flattery');
  assert.equal(TaskBook.issueClass('主人说话短，回答却长篇大论'), 'style-fit');
  assert.equal(TaskBook.issueClass('中间有 9477ms 完全没有输出'), 'gap');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hupo-tasks-'));
  const book = new TaskBook(dir);
  const a = book.add({ title: '迎合：空夸「说得太对」', detail: 'x', kind: 'reasonableness' });
  const b = book.add({ title: '迎合：又出现「太棒了」', detail: 'y', kind: 'reasonableness' });
  assert.equal(a.created, true);
  assert.equal(b.created, false, '同类毛病要并成一条，seenCount 累加');
  assert.equal(b.task.seenCount, 2);
});

test('topBigrams：过滤停用词、只留实词', () => {
  const words = topBigrams(['帮我部署一下', '部署部署部署']);
  assert.ok(words.includes('部署'), JSON.stringify(words));
});
