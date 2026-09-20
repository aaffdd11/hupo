// 系统通知（批 3 第三件 · 契约 `docs/dev/29-NOTICE.md`）。
//
// 五条闸（任务书列的那五条）：
//   ① `notice` 取号落盘、瞬态不落盘
//   ② `notice/urgent` **只准**用于写盘失败（有负向对照：别的情形用了就红）
//   ③ 限频真的生效（R1.2 的"通知疲劳"）
//   ④ **双通道那条**：同一个 `(turn, kind)` 不许既有过程通道、又有通知
//   ⑤ 文案里不许出现内部词
//
// ⚠️ ④ 是这一件最难的那条（手册 R1.2 点名批 3 必须合并双通道），
//    所以它**打在真的东西上**：真的 `TurnTranslator` / 真的 `Dispatcher` /
//    真的 `reconcileOnBoot`，不是拿一个假账本自说自话。

import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';

import { Dispatcher } from '../src/dispatcher.js';
import { TurnTranslator } from '../src/session-translate.js';
import { installProcessGuard } from '../src/process-guard.js';
import { reconcileOnBoot } from '../src/reconcile.js';
import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';
import { Trash, TRASH_TTL_MS } from '../src/trash.js';
import {
  FAILED_LINES,
  NOTICE,
  NOTICE_DEDUP_WINDOW_MS,
  NOTICE_KINDS,
  NOTICE_TEXTS,
  NOTICE_URGENT,
  Notice,
  UNDO_RESTORE,
  failedLine,
  isWriteFailure,
  subjectOf,
} from '../src/notice.js';
import { collector, failingFs, tempTimeline } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

/** 一个假 runtime（只要 `agent()` 与 `stop()`）——调度器只调这两个。 */
function stubRuntime() {
  const agent = new EventEmitter();
  agent.prompt = async () => ({ messageId: 'm_1' });
  return { agent: () => agent, stop: async () => {}, _agent: agent };
}

// ══ ① 取号落盘 vs 瞬态不落盘 ════════════════════════════════

test('① `notice` 取号、落盘 —— 时间线里那一条就是它', () => {
  const { store, timeline } = tempTimeline();
  const c = collector();
  timeline.subscribe(c.fn);
  const notice = new Notice({ timeline, store, timelineId: 'main', now: () => T0 });

  const ev = notice.notice({ kind: 'crash' });

  assert.equal(ev.type, NOTICE);
  assert.equal(ev.kind, 'crash');
  assert.equal(ev.text, NOTICE_TEXTS.crash, '文案由服务端给（客户端照抄）');
  assert.equal(ev.at, T0);
  assert.equal(typeof ev.seq, 'number', '★ 必须取号 —— 它就是时间线里那一条');
  assert.deepEqual(c.got.map((e) => e.seq), [ev.seq], '落盘成功才推订阅者');
  const onDisk = store.readAll('main').filter((e) => e.type === NOTICE);
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].seq, ev.seq);
  assert.equal(onDisk[0].kind, 'crash');
});

test('① 瞬态那条**不取号、不落盘**（它只在写盘失败时用，见 ②）', () => {
  const { store, timeline } = tempTimeline();
  const c = collector();
  timeline.subscribe(c.fn);
  const notice = new Notice({ timeline, store, timelineId: 'main' });

  const ev = notice.noticeUrgent({ cause: new Error('落盘失败（main）：ENOSPC') });

  assert.equal(ev.type, NOTICE_URGENT);
  assert.equal(ev.kind, 'disk-full');
  assert.equal(ev.seq, undefined, '★ 瞬态**不占号**（不然盘上会有空洞）');
  assert.equal(c.got.length, 1, '但它**推**出去了 —— 盘满时这是唯一能出去的路');
  assert.equal(store.readAll('main').filter((e) => e.type === NOTICE_URGENT).length, 0);
});

test('① 落盘失败**必须上抛**，而且订阅者一条都收不到（验收 V-a）', () => {
  const store = new Store({ dataDir: '/nowhere', fs: failingFs(), fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const c = collector();
  timeline.subscribe(c.fn);
  const notice = new Notice({ timeline });

  assert.throws(() => notice.notice({ kind: 'crash' }), /落盘失败/);
  assert.deepEqual(c.got, [], '★ 推订阅者必须在落盘成功之后 —— 一条都不许漏出去');
  assert.equal(timeline.seq, 0, '★ 号要退回去（盘上没落，号就不该前进）');
});

test('① 认不出的 `kind` 直接抛（两半的接口是冻结的）', () => {
  const { store, timeline } = tempTimeline();
  const notice = new Notice({ timeline, store });
  assert.throws(() => notice.notice({ kind: '我编的' }), /认不出的通知种类/);
  assert.deepEqual([...NOTICE_KINDS], ['resumed', 'not-resumed', 'expiring', 'crash', 'failed']);
});

test('① `undo` 只允许契约 §五 那三种形状（动作名是两半的接口）', () => {
  const { store, timeline } = tempTimeline();
  const notice = new Notice({ timeline, store });
  const ids = { messageIds: ['u_1', 'm_1'] };

  assert.throws(
    () => notice.notice({ kind: 'expiring', undo: { label: '拿回来', action: '乱写的动作', ...ids } }),
    /认不出的撤销动作/,
  );
  assert.throws(
    () => notice.notice({ kind: 'expiring', undo: { label: '拿回来', action: UNDO_RESTORE.action } }),
    /哪一条/,
  );
  // 没有 undo 的通知（续做那两条）不许**凭空多出**一个 undo 键
  const ev = notice.notice({ kind: 'crash' });
  assert.equal('undo' in ev, false, '续做/崩溃那几条**没有**撤销（契约 §5.1）');
});

// ══ ② `/urgent` 只准用于写盘失败（**负向对照不能省**）════════

test('🔴 ② 负向对照：不是写盘失败就**不许**走瞬态（拿它当省事的快捷通道 ⇒ 红）', () => {
  const { store, timeline } = tempTimeline();
  const notice = new Notice({ timeline, store });

  // 认得出它不是写盘失败的三种给法，**全都得抛**
  assert.throws(() => notice.noticeUrgent({ cause: new Error('随便什么错') }), /只准用于/);
  assert.throws(() => notice.noticeUrgent({}), /只准用于/, '不给 cause ⇒ 抛（不许"忘了给"）');
  assert.throws(
    () => notice.noticeUrgent({ cause: new Error('ENOSPC'), kind: 'crash' }),
    /只有 disk-full/,
    '瞬态的 kind 只有 disk-full 一种（契约 §五）',
  );
});

test('② `isWriteFailure`：认得出落盘失败（含 cause 链），别的错认不出来', () => {
  assert.equal(isWriteFailure(new Error('ENOSPC: no space left on device')), true);
  assert.equal(isWriteFailure(new Error('落盘失败（main）：ENOSPC')), true);
  assert.equal(
    isWriteFailure(new Error('落盘失败（main）：EFBIG', { cause: Object.assign(new Error('x'), { code: 'EFBIG' }) })),
    true,
  );
  assert.equal(isWriteFailure(new Error('某个普通的 bug')), false);
  assert.equal(isWriteFailure(undefined), false, '不给东西 ⇒ 认不出来 ⇒ 不许走瞬态');
});

test('🔴 ② 盘满那条链路：默认落盘失败 ⇒ 退回瞬态，而且那一条**自己说清**', () => {
  const store = new Store({ dataDir: '/nowhere', fs: failingFs(), fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const c = collector();
  timeline.subscribe(c.fn);
  const notice = new Notice({ timeline });

  const ev = notice.noticeOrUrgent({ kind: 'crash' }); // 契约 §三① 的默认路径

  assert.equal(ev.type, NOTICE_URGENT);
  assert.equal(ev.kind, 'disk-full');
  assert.equal(ev.seq, undefined);
  // ★ 例外**不许伪装成正常**：这条必须自己说清"我没能记下来"
  //   （⚠️ 契约 §三① 的例句用的是"写进时间线"，而**"时间线"是禁用词**
  //     ——见 `notice.js` 的文案表，取实质不用字面。）
  assert.match(ev.text, /盘满/);
  assert.match(ev.text, /没能记下来/);
});

test('② 盘满**不是**普通错误 → `noticeOrUrgent` 照抛（它只兜住盘满那一种）', () => {
  const timeline = {
    emit() {
      throw new Error('别的问题，不是盘满');
    },
    emitTransient() {
      throw new Error('不该走到这儿');
    },
  };
  const notice = new Notice({ timeline });
  assert.throws(() => notice.noticeOrUrgent({ kind: 'crash' }), /别的问题/);
});

test('🔴 ② P-k / 欠账 #22：进程级兜底那一路**有渠道**了（盘满时瞬态那条自己说清）', () => {
  const store = new Store({ dataDir: '/nowhere', fs: failingFs(), fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const c = collector();
  timeline.subscribe(c.fn);
  const notice = new Notice({ timeline });

  const uninstall = installProcessGuard({ timeline, notice, exit: () => {}, log: () => {} });
  process.listeners('uncaughtException').at(-1)(new Error('落盘失败（main）：ENOSPC'));
  uninstall();

  const urgent = c.got.find((e) => e.type === NOTICE_URGENT);
  assert.ok(urgent, '★ 盘满时用户看得见的那条通知必须出得去（#22 的渠道）');
  assert.equal(urgent.kind, 'disk-full');
  assert.match(urgent.text, /没能记下来/);
  assert.equal(urgent.seq, undefined, '瞬态——不写盘，所以盘满时才发得出去');
  // 既有的诊断帧**留着**（客户端不渲染它，探针与日志在用；改造它不在这一件里）
  assert.ok(c.got.some((e) => e.type === 'error'), '原来那条诊断帧不许被这一件弄丢');
});

// ══ ③ 限频 ═════════════════════════════════════════════════

test('③ 同一个 `kind` + 同一个主体，窗口内只喊一次', () => {
  const { store, timeline } = tempTimeline();
  const notice = new Notice({ timeline, store, now: () => T0 });

  assert.ok(notice.notice({ kind: 'crash' }));
  assert.equal(notice.notice({ kind: 'crash' }), null, '★ 第二次闭嘴（R1.2 的通知疲劳）');
  assert.equal(store.readAll('main').filter((e) => e.type === NOTICE).length, 1, '而且是**没落盘**地闭嘴');
  // 换一个 kind ⇒ 是另一件事，要说
  assert.ok(notice.notice({ kind: 'resumed' }), '不同 kind 不受影响');
});

test('③ 主体按"撤销那一组 id"认，而且**顺序无关**（同一件事传成两种顺序还是同一件）', () => {
  const { store, timeline } = tempTimeline();
  const notice = new Notice({ timeline, store, now: () => T0 });
  const undo = (ids) => ({ ...UNDO_RESTORE, messageIds: ids });

  assert.ok(notice.notice({ kind: 'expiring', undo: undo(['u_1', 'm_1']) }));
  assert.equal(
    notice.notice({ kind: 'expiring', undo: undo(['m_1', 'u_1']) }),
    null,
    '★ 同一组 id ⇒ 同一件事',
  );
  assert.ok(
    notice.notice({ kind: 'expiring', undo: undo(['u_2', 'm_2']) }),
    '另一条过期 ⇒ 是另一件事，要说',
  );
});

test('③ 窗口过了才允许再说一次（不是永远闭嘴）', () => {
  const { store, timeline } = tempTimeline();
  const early = new Notice({ timeline, store, now: () => T0 });
  assert.ok(early.notice({ kind: 'crash' }));

  const insideWindow = new Notice({ timeline, store, now: () => T0 + NOTICE_DEDUP_WINDOW_MS - 1 });
  assert.equal(insideWindow.notice({ kind: 'crash' }), null, '窗口内 ⇒ 还是不说');

  const later = new Notice({ timeline, store, now: () => T0 + NOTICE_DEDUP_WINDOW_MS + 1 });
  assert.ok(later.notice({ kind: 'crash' }), '★ 窗口过了 ⇒ 允许再说一次');
});

test('③ **重启不许把同一件事再说一遍**（限频账从盘上恢复）', () => {
  const { store, timeline } = tempTimeline();
  const first = new Notice({ timeline, store, now: () => T0 });
  assert.ok(first.notice({ kind: 'crash' }));

  // 新进程、同一个数据目录（这正是崩溃环的形状：反复重启）
  const second = new Notice({ timeline, store, now: () => T0 + 1000 });
  assert.equal(second.notice({ kind: 'crash' }), null, '★ 重启之后也不许再喊一遍');

  // 窗口滑出去 + 新进程 ⇒ 才允许再说
  const third = new Notice({ timeline, store, now: () => T0 + NOTICE_DEDUP_WINDOW_MS + 1 });
  assert.ok(third.notice({ kind: 'crash' }));
});

test('③ `subjectOf`：有撤销就用那一组 id，没有就用那句话本身', () => {
  assert.equal(subjectOf({ kind: 'expiring', text: 'x', undo: { messageIds: ['b', 'a'] } }), 'a\u0000b');
  assert.equal(subjectOf({ kind: 'crash', text: '那句话' }), '那句话');
});

// ══ ④ 双通道那条（契约 §二 §三②）═══════════════════════════

test('🔴 ④ 真调度器：`message/status` 在账本上记成**过程通道**的', async () => {
  const { store, timeline } = tempTimeline();
  const c = collector();
  timeline.subscribe(c.fn);
  const notice = new Notice({ timeline, store });
  const runtime = stubRuntime();
  const dispatcher = new Dispatcher({ timeline, runtime, store, notice, turnDeadlineMs: 0 });

  await dispatcher.deliver('帮我查个东西', { messageId: 'u_1' });
  runtime._agent.emit('session-event', { event: { type: 'turn/start', data: { turn: 1 } } });

  assert.ok(
    c.got.some((e) => e.type === 'message/status' && e.turn === 1 && e.seq === undefined),
    '「它正在做…」还是走过程通道（瞬态、不落盘）',
  );
  assert.equal(notice.channelOf(1, 'started'), 'process', '★ 账本上记着：这一轮的"开始"走过过程通道');
});

test('🔴 ④ 一轮出事了 ⇒ 通知**不许**再说一遍同一件事（这就是那条闸）', () => {
  const { store, timeline } = tempTimeline();
  const notice = new Notice({ timeline, store });
  const translator = new TurnTranslator({ timeline, scopeId: 'main', notice });

  translator.handle({ event: { type: 'turn/start', data: { turn: 1 } } });
  translator.handle({ event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'crashed' } } } });

  // 收口落在消息通道上（半句 + 标成失败）
  const ends = store.readAll('main').filter((e) => e.type === 'message/end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, 'failed');
  assert.equal(notice.channelOf(1, 'failed'), 'process', '★ 账本上记着：这一轮出事已经说过了');

  // ★★ 那一条闸：同一个 `(turn, kind)` 再走通知 ⇒ **抛**，一个字都不落盘
  const before = store.readAll('main').length;
  assert.throws(() => notice.notice({ kind: 'failed', turn: 1 }), /两条通道/);
  assert.equal(store.readAll('main').length, before, '撞上闸就**不许落盘**（不是"落了再说"）');

  // 正对照：判据是**同一个 (turn, kind)**，不是"这一类永远不许说"
  assert.ok(notice.notice({ kind: 'failed' }), '不带轮号（另一件事）照说');
  assert.ok(notice.notice({ kind: 'not-resumed', turn: 7 }), '别的轮 / 别的 kind 照说');

  // ★ 反过来也挡得住：通知先说了，过程通道就不许再说同一件事
  //   （`#claim()` 是对称的 —— 谁后说谁闭嘴）
  notice.notice({
    kind: 'expiring',
    turn: 9,
    undo: { ...UNDO_RESTORE, messageIds: ['u_9', 'm_9'] },
  });
  assert.throws(() => notice.processSaid({ turn: 9, kind: 'expiring' }), /两条通道/);
});

test('🔴 ④ 「续做·动过东西」那条**只产生一条**：通知替掉了气泡，不是两条都发', () => {
  const { store, timeline } = tempTimeline();
  const notice = new Notice({ timeline, store });
  timeline.emit({ type: 'user/echo', messageId: 'u_1', text: '把那个文件改一下' });
  timeline.emit({ type: 'task/mutated', ref: 'u_1', turn: 1 });
  timeline.emit({ type: 'message/start', messageId: 'm_1', agent: 'agent', origin: 'reactive', re: [] });
  timeline.emit({ type: 'message/text', messageId: 'm_1', block: 'quick', seqInBlock: 1, text: '正在改…' });

  const bubblesBefore = store.readAll('main').filter((e) => e.type === 'message/start').length;
  const r = reconcileOnBoot({ timeline, store, now: Date.now(), notice });

  const evs = store.readAll('main');
  const notices = evs.filter((e) => e.type === NOTICE);
  assert.equal(r.noticed, 'not-resumed');
  assert.equal(notices.length, 1, '★ 同一件事只产生**一条**');
  assert.equal(notices[0].kind, 'not-resumed');
  assert.equal(notices[0].text, NOTICE_TEXTS['not-resumed']);
  assert.equal(
    evs.filter((e) => e.type === 'message/start').length,
    bubblesBefore,
    '★ 不许**再起一条气泡**说同一件事（那就是双通道）',
  );
});

test('🔴 ④ 「续做·自动重来」那条走 `resumed`（而不是气泡）', () => {
  const { store, timeline } = tempTimeline();
  const notice = new Notice({ timeline, store });
  // 只读过东西、死在开口之前（没有气泡）⇒ 可以自动重来
  timeline.emit({ type: 'user/echo', messageId: 'u_1', text: '帮我查一下明天的天气' });

  const r = reconcileOnBoot({
    timeline,
    store,
    now: Date.now(),
    notice,
    resume: { degraded: false },
  });

  assert.ok(r.resume, '计划里确实要重来');
  assert.equal(r.noticed, 'resumed');
  const notices = store.readAll('main').filter((e) => e.type === NOTICE);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'resumed');
  assert.equal(store.readAll('main').filter((e) => e.type === 'message/start').length, 0, '没有气泡');
});

test('④ 不给 `notice` ⇒ 行为与加通知之前**一模一样**（老调用方不受影响）', () => {
  const { store, timeline } = tempTimeline();
  timeline.emit({ type: 'user/echo', messageId: 'u_1', text: '帮我查一下' });
  const r = reconcileOnBoot({ timeline, store, now: Date.now() });
  assert.equal(r.told, 1);
  assert.equal(r.noticed, null);
  assert.equal(store.readAll('main').filter((e) => e.type === NOTICE).length, 0);
  assert.equal(store.readAll('main').filter((e) => e.type === 'message/start').length, 1, '照旧走气泡');
});

// ══ ⑤ 五个来源 ═════════════════════════════════════════════

test('⑤ 回收站到期前一周：`expiring` + **撤销是真能用的**（⑲ 留下的那笔账）', () => {
  const { store, timeline } = tempTimeline();
  const now = T0;
  const trash = new Trash({ timeline, store, now: () => now });
  timeline.emit({ type: 'user/echo', messageId: 'u_1', text: '删掉这个' });
  timeline.emit({ type: 'message/start', messageId: 'm_1', agent: 'agent', origin: 'reactive', re: [] });
  // 差一天到期（30 天前删的，提前一周就该告一声）
  trash.remove(['u_1', 'm_1'], { now: now - (TRASH_TTL_MS - DAY) });
  trash.sync();

  const soon = trash.expiringSoon({ now });
  assert.equal(soon.length, 1, '⑲ 留下的那个口算得出"快到期了"');

  const notice = new Notice({ timeline, store, now: () => now });
  const ev = notice.notice({
    kind: 'expiring',
    undo: { ...UNDO_RESTORE, messageIds: soon[0].messageIds },
  });
  assert.equal(ev.kind, 'expiring');
  assert.equal(ev.text, NOTICE_TEXTS.expiring);
  assert.equal(ev.undo.label, '拿回来');
  assert.equal(ev.undo.action, 'trash/restore');
  assert.deepEqual(ev.undo.messageIds, ['m_1', 'u_1']);
  assert.equal(trash.restore(ev.undo.messageIds), true, '★ 撤销指的是一条**真的能用**的路');
});

test('⑤ 崩溃那条：文案是契约 §5.1 那一句（用户那一眼）', () => {
  const { store, timeline } = tempTimeline();
  const notice = new Notice({ timeline, store });
  const ev = notice.noticeOrUrgent({ kind: 'crash' });
  assert.equal(ev.type, NOTICE);
  assert.equal(ev.kind, 'crash');
  assert.equal(ev.text, NOTICE_TEXTS.crash);
  assert.equal('undo' in ev, false);
});

test('⑤ 失败五类：每一类都有话说，认不出来就用兜底那句（**不猜**）', () => {
  for (const key of ['upstream', 'oom', 'ours', 'unfinished', 'waiting']) {
    assert.equal(typeof FAILED_LINES[key], 'string');
    assert.ok(FAILED_LINES[key].length > 0, `${key} 得有话说`);
  }
  assert.equal(failedLine('upstream'), FAILED_LINES.upstream);
  assert.equal(failedLine('我编的'), FAILED_LINES.unknown, '认不出来 ⇒ 兜底（N10：不许猜）');
  assert.equal(FAILED_LINES.unknown, NOTICE_TEXTS.failed);
});

test('⑤ ⚠️ 明说：「失败五类」那一类**接不上**（分类器不存在），接口先摆着', () => {
  // 这条测试的意义是**把"没接上"钉在闸里**，而不是假装接上了：
  // 契约 §5.1 说 `failed` 的文案"按那一类给"，而 D10.3 只列了五类的名字，
  // 代码里**没有分类器**（`10-RECONCILE.md` §6.1 明说上游不通 / OOM 认不出来）。
  // ⇒ 今天没有任何一条路会产生 `failed` 通知；一旦有人接上，这条会红，
  //    那时把它改成"真有一条路"的断言。
  assert.equal(
    NOTICE_KINDS.includes('failed'),
    true,
    'kind 在接口表里（客户端那半边照它建）',
  );
  assert.deepEqual(Object.keys(FAILED_LINES).sort(), ['oom', 'ours', 'unfinished', 'unknown', 'upstream', 'waiting']);
});

// ══ ⑤′ 文案闸（禁用词）════════════════════════════════════

test('🔴 ⑤ 文案里**不许出现内部词**（这是缺陷，不是文风问题）', () => {
  // 这一份是 `apps/mobile/lib/models/forbidden_words.dart` 那张表的镜像
  // （界面上的话和这里的话**是同一批话**，只是从服务端发出去）。
  const forbidden = [
    '工作区', '口令', '暗号', '客户端', '云端', '服务器', '调度器', '时间线',
    '作用域', '会话', '工具', '搜索', '上下文', '系统提示', '模型',
    'web_search', 'web_fetch', 'tool-fs', 'bash', 'subagent',
    '连接', '第 1 个', '序号',
  ];
  const lines = [
    ...Object.entries(NOTICE_TEXTS).map(([k, v]) => [`NOTICE_TEXTS.${k}`, v]),
    ...Object.entries(FAILED_LINES).map(([k, v]) => [`FAILED_LINES.${k}`, v]),
    ['UNDO_RESTORE.label', UNDO_RESTORE.label],
  ];
  for (const [where, text] of lines) {
    for (const w of forbidden) {
      assert.ok(!text.includes(w), `${where} 里出现了内部词「${w}」：${text}`);
    }
  }
});

test('🔴 ⑤ 时间线上那条通知**整行**都不许漏内部词（连 `undo` 一起扫）', () => {
  const { store, timeline } = tempTimeline();
  const notice = new Notice({ timeline, store });
  const ev = notice.notice({
    kind: 'expiring',
    undo: { ...UNDO_RESTORE, messageIds: ['u_1', 'm_1'] },
  });
  const line = JSON.stringify(ev);
  for (const w of ['工作区', '客户端', '云端', '口令', '连接', '工具', '调度器', '时间线', '会话']) {
    assert.ok(!line.includes(w), `落盘那一行里出现了内部词「${w}」：${line}`);
  }
});

test('⑤ 契约 §5.1 那几句是**照抄**的（改口气就会两半对不上）', () => {
  // ⚠️ 这两句 2026-09-21 **有意改过口气**（不是文字漂移），改的理由在下面：
  //    · `resumed`：原来写的是「重新做了一遍」（过去式），而这条是在
  //      **决定重做那一刻**发的（和 `task/resumed` 同时机）⇒ 投递失败时就成了
  //      盘上的假话。改成**只说正在做的那一步**，和仓库里既有的那句气泡
  //      （`reconcile.js` 的 `INTERRUPTED_RESUMING_LINE`）同一个口气。
  //    · `not-resumed`：原来丢了「你看一眼，要不要再做一遍」——
  //      而 D10.1"只通知、不自动重来"的**全部意义**就是让主人自己决定。
  assert.equal(NOTICE_TEXTS.resumed, '你被打断的那件事，我重新做一遍');
  assert.equal(
    NOTICE_TEXTS['not-resumed'],
    '那件事可能改过东西，我没有自己做 —— 你看一眼，要不要再做一遍',
  );
  assert.equal(NOTICE_TEXTS.expiring, '有一条过几天会彻底删掉');
  assert.equal(NOTICE_TEXTS.crash, '刚才出了点事，我已经重来了');
  // ⚠️ 约束 4：**不承诺时间**（所以是"过几天"，不是"7 天后"）
  assert.ok(!/\d\s*(天|小时|分钟)/.test(NOTICE_TEXTS.expiring));
});
