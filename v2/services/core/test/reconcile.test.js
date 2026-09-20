// 开机对账。手册 `08-SPEC.md` §15.3 · §事故一 · §事故二 · N19 · N7 · N11。
//
// 这一批修的是**事故一**：那行"还有件事在处理"从 15:31 挂到 16:39——
// 因为**没人补那个"结束"**。进程连同那件活一起被杀，记录里就永远缺一半。
//
// 分成两层测：
//   一、`findInterrupted` 是**纯函数** —— 拿手写的事件数组离线验
//   二、`reconcileOnBoot` 走**真的 Store + Timeline**（会落盘、会取号）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import {
  INTERRUPTED_LINE,
  INTERRUPTED_TOUCHED_LINE,
  RECONCILE_WINDOW_MS,
  findInterrupted,
  reconcileOnBoot,
} from '../src/reconcile.js';
import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

/** 一轮：主人说一句 → 它开口 → （可选）说一句 → （可选）收口 */
function turn(seq, { messageId = `m_${seq}`, at = NOW, text = '收到，我去查。', end = true, endAt = at + 3000 } = {}) {
  const out = [
    { type: 'user/echo', messageId: `u_${seq}`, text: '帮我查个东西', seq, at: at - 100 },
    { type: 'message/start', messageId, agent: 'agent', origin: 'reactive', re: [], seq: seq + 1, at },
  ];
  if (text) out.push({ type: 'message/text', messageId, block: 'quick', seqInBlock: 1, text, seq: seq + 2, at: at + 10 });
  if (end) out.push({ type: 'message/end', messageId, reason: 'completed', sources: [], seq: seq + 99, at: endAt });
  return out;
}

function flat(...chunks) {
  return chunks.flat().sort((a, b) => a.seq - b.seq);
}

/** 抓**最后一条**消息的正文（对账那条新起的气泡）。 */
function noticeText(store) {
  const evs = store.readAll('main');
  const starts = evs.filter((e) => e.type === 'message/start');
  if (starts.length === 0) return '';
  const id = starts[starts.length - 1].messageId;
  return evs.filter((e) => e.type === 'message/text' && e.messageId === id).map((e) => e.text).join('');
}

function fresh() {
  const store = new Store({
    dataDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-recon-')),
    fsync: false,
  });
  return { store, timeline: new Timeline({ id: 'main', store }) };
}

// ── 一、纯函数 ──────────────────────────────────────────────

test('对账：说完了的一轮 ⇒ 什么都不用收', () => {
  const r = findInterrupted(flat(turn(1)), { now: NOW });
  assert.deepEqual(r.orphans, []);
  assert.deepEqual(r.unanswered, []);
  assert.equal(r.tell, false);
});

test('🔴 对账：开了口没收口 ⇒ 一定被抓出来（事故一）', () => {
  const { orphans: open } = findInterrupted(flat(turn(1, { end: false })), { now: NOW + 120_000 });
  assert.equal(open.length, 1);
  assert.equal(open[0].messageId, 'm_1');
  assert.equal(open[0].tell, true, '两分钟前的事 ⇒ 要告诉他');
});

test('🔴 措辞那一条：**不许**留下没说的话（`tell` 决定说不说，收口都要收）', () => {
  // 手册 §15.3：只对最近 6 小时内的说话；更早的**悄悄清掉**
  const fresh6h = findInterrupted(flat(turn(1, { end: false })), { now: NOW + 5 * HOUR });
  assert.equal(fresh6h.orphans[0].tell, true, '5 小时前 ⇒ 还在窗口里');

  const old = findInterrupted(flat(turn(1, { end: false })), { now: NOW + 7 * HOUR });
  assert.equal(old.orphans.length, 1, '★ 旧账**照样要收口**（不然界面上那个气泡永远开着）');
  assert.equal(old.orphans[0].tell, false, '★ 但**不出声**（他多半已经不在等这件事了）');
});

test('对账：多轮里只有没收口的那一轮被抓', () => {
  const { orphans: open } = findInterrupted(
    flat(turn(1), turn(10, { end: false }), turn(20)),
    { now: NOW + 60_000 },
  );
  assert.deepEqual(open.map((o) => o.messageId), ['m_10']);
});

test('对账：同一条 id 再次开口 ⇒ 重新计时，不算"旧的没收口"', () => {
  const events = flat(
    { type: 'message/start', messageId: 'm_x', at: NOW - 10 * HOUR, seq: 1 },
    { type: 'message/end', messageId: 'm_x', reason: 'completed', seq: 2, at: NOW - 10 * HOUR + 1 },
    { type: 'message/start', messageId: 'm_x', at: NOW - 60_000, seq: 3 },
  );
  const { orphans: open } = findInterrupted(events, { now: NOW });
  assert.equal(open.length, 1);
  assert.equal(open[0].tell, true, '★ 用的是**最后一次开口**的时间，不是第一次');
});

test('对账：认得出"主人最后说的那句"（出那声时要知道在说哪件事）', () => {
  // ⚠️ 这句话原先挂在未收口的气泡上（`orphans[].userText`）。
  //    补上"问了没人答"那条路之后，它搬到 `unanswered` 那边了 ——
  //    因为**最可靠的那份原话就在 `user/echo` 里**，不必从旁边推断。
  const events = flat(
    { type: 'user/echo', messageId: 'u_a', text: '帮我订一张明天的票', seq: 1, at: NOW - 5000 },
    { type: 'message/start', messageId: 'm_a', at: NOW - 4000, seq: 2 },
  );
  const r = findInterrupted(events, { now: NOW });
  assert.equal(r.orphans.length, 1, '气泡确实没开口完');
  assert.equal(r.unanswered[0].text, '帮我订一张明天的票', '★ 原话在这儿');
});

test('对账：兜底的顺序是"老的先收"（日志读起来顺着时间）', () => {
  const { orphans: open } = findInterrupted(
    flat(turn(100, { messageId: 'm_new', at: NOW - 1000, end: false }),
         turn(1, { messageId: 'm_old', at: NOW - 60_000, end: false })),
    { now: NOW },
  );
  assert.deepEqual(open.map((o) => o.messageId), ['m_old', 'm_new']);
});

test('对账：坏事件不炸（日志里可能有别的东西）', () => {
  const { orphans: open } = findInterrupted(
    [null, {}, { type: 'message/start' }, { type: 'message/end', messageId: 42 },
     { type: 'message/status', turn: 1, state: 'started' }],
    { now: NOW },
  );
  assert.deepEqual(open, []);
});

// ── 二、真 Store + 真 Timeline ──────────────────────────────

test('🔴 开机对账：把没收口的收掉，并**另起一条**告诉用户（先收口、再另起）', () => {
  const { store, timeline } = fresh();
  // 造一个"上一个进程被硬杀"的现场
  timeline.emit({ type: 'user/echo', messageId: 'u_1', text: '用 bash 跑 sleep 60' });
  const w = new (class {
    constructor() { this.messageId = 'm_orphan'; }
  })();
  timeline.emit({ type: 'message/start', messageId: 'm_orphan', agent: 'agent', origin: 'reactive', re: [] });
  timeline.emit({ type: 'message/text', messageId: 'm_orphan', block: 'quick', seqInBlock: 1, text: '收到，跑着。' });
  // ⚠️ 到这里进程没了 —— 没有 message/end

  const before = timeline.seq;
  const r = reconcileOnBoot({ timeline, store, now: Date.now() });

  assert.equal(r.ok, true);
  assert.equal(r.closed, 1, '那一条必须被收口');
  assert.equal(r.told, 1, '而且要对用户说一句');

  const evs = store.readAll('main').slice(before);
  assert.equal(evs[0].type, 'message/end', '★ **先**收口');
  assert.equal(evs[0].messageId, 'm_orphan');
  assert.equal(evs[0].reason, 'failed', '它是没善终的 —— 别记成 completed');

  assert.equal(evs[1].type, 'message/start', '★ **再**另起一条（反了就是"消息交叉"）');
  const said = evs.filter((e) => e.type === 'message/text').map((e) => e.text).join('');
  assert.equal(said, INTERRUPTED_LINE);
  assert.ok(evs.some((e) => e.type === 'message/end' && e.messageId === evs[1].messageId));

  // 时间线上不该再有未收口的
  assert.equal(timeline.openMessageId, null);
});

test('🔴 幂等（**事故二的教训**）：第二次开机**一句话都不该多说**', () => {
  // 事故二：7 句一模一样的「我已经升级好了。」每次重启说一句，
  // 因为判据里缺了"他确实被打断"这一条。
  // 我们的判据是"磁盘上有一条没收口的气泡" —— **那就是被打断本身** ⇒ 收干净就没了。
  const { store, timeline } = fresh();
  timeline.emit({ type: 'message/start', messageId: 'm_x', agent: 'agent', origin: 'reactive', re: [] });

  const first = reconcileOnBoot({ timeline, store, now: Date.now() });
  assert.equal(first.told, 1);

  const second = reconcileOnBoot({ timeline, store, now: Date.now() });
  assert.equal(second.closed, 0, '★ 第二次没有可收的');
  assert.equal(second.told, 0, '★ 而且**一个字都不多说**');

  const third = reconcileOnBoot({ timeline, store, now: Date.now() });
  assert.equal(third.told, 0, '第三次也一样');
});

test('对账：干净退场的（没有未收口）⇒ 一个字都不说', () => {
  const { store, timeline } = fresh();
  timeline.emit({ type: 'user/echo', messageId: 'u_1', text: '你好' });
  const w = new (class { constructor() { this.messageId = 'm_1'; } })();
  timeline.emit({ type: 'message/start', messageId: 'm_1', agent: 'agent', origin: 'reactive', re: [] });
  timeline.emit({ type: 'message/end', messageId: 'm_1', reason: 'completed', sources: [] });

  const r = reconcileOnBoot({ timeline, store, now: Date.now() });
  assert.deepEqual([r.closed, r.told], [0, 0]);
});

test('🔴 太旧的账：**照样收口，但不打扰用户**', () => {
  const { store, timeline } = fresh();
  timeline.emit({ type: 'message/start', messageId: 'm_old', agent: 'agent', origin: 'reactive', re: [] });
  const r = reconcileOnBoot({ timeline, store, now: Date.now() + RECONCILE_WINDOW_MS + HOUR });

  assert.equal(r.closed, 1, '★ 收口（不然那个气泡永远开着）');
  assert.equal(r.told, 0, '★ 但不出声');
  const evs = store.readAll('main');
  assert.ok(evs.some((e) => e.type === 'message/end' && e.messageId === 'm_old'));
  assert.ok(!evs.some((e) => e.type === 'message/text' && e.text === INTERRUPTED_LINE), '没多说一句');
});

test('🔴 读日志坏掉 ⇒ **不许阻断启动**（手册 §15.3 把这条写死了）', () => {
  // 对账是"补救"。它自己坏掉不该让**整套服务**起不来 ——
  // 那样用户面对的不是"一句没说的话"，而是"什么都用不了"。
  const badStore = {
    readAll() {
      throw new Error('读取失败（main）：磁盘坏了');
    },
  };
  const { timeline } = fresh();
  let r;
  assert.doesNotThrow(() => {
    r = reconcileOnBoot({ timeline, store: badStore });
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /磁盘坏了/);
  assert.equal(r.closed, 0);
});

test('对账那条话必须**是人话**：说清"可能"、说清"不知道做到哪"、给出下一步', () => {
  assert.ok(INTERRUPTED_LINE.includes('可能没做完'), '★ 不能断言"没做完"（我们不知道）');
  assert.ok(/不知道/.test(INTERRUPTED_LINE), '★ 要说清"我不知道做到哪儿了"');
  assert.ok(/重新来一遍/.test(INTERRUPTED_LINE), '★ 不能说"接着做"（我们不知道接着哪儿）');
  // 不许出现内部词
  for (const w of ['工作区', '口令', '客户端', '云端', '服务器', '调度器', '时间线', '会话', '工具', '系统提示']) {
    assert.ok(!INTERRUPTED_LINE.includes(w), `出现了内部词「${w}」`);
  }
});

// ── ② 问了没人答（**进程死在开口之前**）────────────────────
//
// ⚠️ 这是一个补上的洞：气泡是它**说第一句话**的时候才建的（writer 懒建），
//    所以"死在开口之前"这条路上，盘上**只有主人自己那句话**。
//    只查未收口的气泡的话，对账什么都发现不了 —— **那正是事故一**。

test('🔴 对账：主人问了、还没出第一个字就被杀 ⇒ **必须发现**', () => {
  const events = [
    { type: 'user/echo', messageId: 'u_1', text: '帮我查一下明天的天气', seq: 1, at: NOW - 60_000 },
  ];
  const r = findInterrupted(events, { now: NOW });
  assert.equal(r.orphans.length, 0, '确实没有气泡（还没开口）');
  assert.equal(r.unanswered.length, 1, '★ 但"问了没人答"必须抓到');
  assert.equal(r.unanswered[0].text, '帮我查一下明天的天气');
  assert.equal(r.tell, true, '一分钟前 ⇒ 要告诉他');
});

test('对账：答完的那句不算"没人答"', () => {
  const r = findInterrupted(flat(turn(1)), { now: NOW + 1000 });
  assert.deepEqual(r.unanswered, []);
});

test('对账：连着问两句、只答了第一句 ⇒ 只抓第二句', () => {
  const events = flat(
    turn(1), // u_1 + 答完
    { type: 'user/echo', messageId: 'u_9', text: '那后天呢', seq: 200, at: NOW - 30_000 },
  );
  const r = findInterrupted(events, { now: NOW });
  assert.deepEqual(r.unanswered.map((u) => u.text), ['那后天呢']);
});

test('对账：太旧的"没人答"也一样 —— 不出声，但**还是要收**', () => {
  const events = [
    { type: 'user/echo', messageId: 'u_1', text: '很久以前问的', seq: 1, at: NOW - 9 * HOUR },
  ];
  const r = findInterrupted(events, { now: NOW });
  assert.equal(r.unanswered.length, 1);
  assert.equal(r.tell, false, '超过 6 小时 ⇒ 不打扰他');
  // ⚠️ 注意：这一种**没有气泡可收**（它还没开口）——
  //    所以"收"这件事对它来说就是"不出声、也不留一个永远等不到回答的现场"。
  //    它不会被误当成"还有一个气泡开着"，因为盘上确实没有。
});

test('🔴 开口说了一半就被杀（① 和 ② 同时命中）⇒ **只说一声**', () => {
  // 这是最常见的那种打断：它先应了一声、然后被杀了。
  // 两次命中（未收口的气泡 + 没人答的话）说的是**同一件事** ⇒ 说不该说两遍。
  const { store, timeline } = fresh();
  timeline.emit({ type: 'user/echo', messageId: 'u_1', text: '跑个东西' });
  timeline.emit({ type: 'message/start', messageId: 'm_1', agent: 'agent', origin: 'reactive', re: [] });
  timeline.emit({ type: 'message/text', messageId: 'm_1', block: 'quick', seqInBlock: 1, text: '收到，跑着。' });

  const r = reconcileOnBoot({ timeline, store, now: Date.now() });
  assert.equal(r.closed, 1, '气泡要收');
  assert.equal(r.unanswered, 1, '那句也确实没人答');
  assert.equal(r.told, 1, '★ 但**只说一声**（同一次打断不该讲两遍）');
});

test('🔴 死了在开口之前 ⇒ 没有气泡可收，但那句话要说出来', () => {
  const { store, timeline } = fresh();
  timeline.emit({ type: 'user/echo', messageId: 'u_1', text: '帮我查一下明天的天气' });

  const r = reconcileOnBoot({ timeline, store, now: Date.now() });
  assert.equal(r.closed, 0, '没有气泡');
  assert.equal(r.told, 1, '★ 但他得听见一声 —— 不然就是一直等');
  assert.equal(noticeText(store), INTERRUPTED_LINE);
});

test('🔴 这样也不会重复唠叨（事故二）', () => {
  const { store, timeline } = fresh();
  timeline.emit({ type: 'user/echo', messageId: 'u_1', text: '帮我查一下' });
  assert.equal(reconcileOnBoot({ timeline, store, now: Date.now() }).told, 1);
  assert.equal(reconcileOnBoot({ timeline, store, now: Date.now() }).told, 0, '★ 第二次不说了');
});

// ── ③ 「动过东西没有」—— 决策 D10.1 ────────────────────────
//
// 「续做」= 重新派一遍 ⇒ 会把副作用再做一遍。所以**动过东西的活不许自动重来**，
// 而且对主人要说实话：「它可能已经改过东西了，所以我没有自己重来」。

test('🔴 动过东西的活被认出来（归属到主人那句话）', () => {
  const events = flat(
    { type: 'user/echo', messageId: 'u_1', text: '把那个文件改一下', seq: 1, at: NOW - 90_000 },
    { type: 'task/mutated', ref: 'u_1', turn: 1, seq: 2, at: NOW - 85_000 },
    { type: 'message/start', messageId: 'm_1', at: NOW - 80_000, seq: 3 },
  );
  const r = findInterrupted(events, { now: NOW });
  assert.equal(r.orphans[0].mutated, true);
  assert.equal(r.anyMutated, true);
});

test('只读过东西的活**不算**动过（不然"只读"就没意义了）', () => {
  const events = flat(
    { type: 'user/echo', messageId: 'u_1', text: '查一下天气', seq: 1, at: NOW - 90_000 },
    { type: 'message/start', messageId: 'm_1', at: NOW - 80_000, seq: 2 },
  );
  const r = findInterrupted(events, { now: NOW });
  assert.equal(r.orphans[0].mutated, false);
  assert.equal(r.anyMutated, false);
});

test('🔴 归属不明的那条（`ref: null`）⇒ **保守算动过**（不许往危险方向猜）', () => {
  const events = flat(
    { type: 'user/echo', messageId: 'u_1', text: '干点什么', seq: 1, at: NOW - 90_000 },
    { type: 'task/mutated', ref: null, turn: 1, seq: 2, at: NOW - 85_000 },
    { type: 'message/start', messageId: 'm_1', at: NOW - 80_000, seq: 3 },
  );
  const r = findInterrupted(events, { now: NOW });
  assert.equal(r.anyMutated, true, '★ 认不出归属时，宁可当它动过');
});

test('🔴 对账那句话说清了"动过东西、我没敢自己重来"', () => {
  const { store, timeline } = fresh();
  timeline.emit({ type: 'user/echo', messageId: 'u_1', text: '把文件改一下' });
  timeline.emit({ type: 'task/mutated', ref: 'u_1', turn: 1 });
  timeline.emit({ type: 'message/start', messageId: 'm_1', agent: 'agent', origin: 'reactive', re: [] });
  timeline.emit({ type: 'message/text', messageId: 'm_1', block: 'quick', seqInBlock: 1, text: '正在改…' });

  const r = reconcileOnBoot({ timeline, store, now: Date.now() });
  assert.equal(r.told, 1);
  assert.equal(r.mutated, 1);
  // ⚠️ 只取**对账那条新消息**的正文 —— 上一条是它自己说的"正在改…"，
  //    把全盘的 message/text 串起来会把它也串进来。
  const said = noticeText(store);
  assert.equal(said, INTERRUPTED_TOUCHED_LINE);
  assert.ok(/改过东西/.test(said), '要说清它动过东西');
  assert.ok(/没有自己重来/.test(said), '★ 而且要说清**为什么**没自动重来');
});

test('🔴 只说"重新来一遍"是不够的 —— 那一版**不能**用在动过东西的活上', () => {
  // 两句话必须是不同的：一句让人放心重来，一句让人**先去看一眼**。
  assert.notEqual(INTERRUPTED_LINE, INTERRUPTED_TOUCHED_LINE);
  assert.ok(!INTERRUPTED_LINE.includes('改过东西'));
  for (const w of ['工作区', '口令', '客户端', '云端', '服务器', '调度器', '时间线', '会话', '工具', '系统提示']) {
    assert.ok(!INTERRUPTED_TOUCHED_LINE.includes(w), `那句话里出现了内部词「${w}」`);
  }
  assert.ok(INTERRUPTED_TOUCHED_LINE.includes('可能没做完'), '照样只说"可能"');
});
