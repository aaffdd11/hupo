// **阶段 4：一对一交付，只建登记面**（契约 `docs/dev/99-STAGE4-DELIVERY.md`
// §三 · `docs/dev/91-TRIPLE-CONTRACT.md` §六 · `docs/dev/92-TRIPLE-PLAN.md` §③ 阶段 4）。
//
// ── 这一份钉什么（判据 S4-1…S4-9，每条都带反例）──────────────
//   §S4-1 四步都留痕：请求→同意→登记交付→撤回，四条**盘上都查得到、能列**（只在内存 ⇒ 红）。
//   §S4-2 🔴 无同意 ⇒ 交付失败（fail-closed；助手自己判断"他会同意" ⇒ 红）。
//   §S4-3 🔴 同意只读**他当轮自己说的那句话**：请求里带 `agreed:true` 不算。
//   §S4-4 🔴 同意逐项：哪一份 · 哪个形状版本 · 哪个范围，**三项都要有**
//          （一次泛泛的"行吧"放全部数据出去 ⇒ 红）。
//   §S4-5 🔴 回执如实：文案里**不许**出现"已删除／已经给到对方／对方那边有了"这类断言；
//          要说清**这边真的做了什么**（扫 `DELIVERY_COPY`，照 `time-words` 扫 `WORK_COPY` 同款）。
//   §S4-6 🔴 撤回后新请求 ⇒ 拒，而且撤回本身落盘。
//   §S4-7 🔴 请求必须指 `shapeVersion`，没有 ⇒ 拒（形状对不上不许静默算对）。
//   §S4-8 🔴 算不出就如实标「不可算」：'对方那份还在不在'今天没有信号 ⇒ 只许写**不可算**。
//   §S4-9 🔴 四步是唯一的路：这一阶段**没有任何一条路能把数据包字节带出去**
//          （共享库／制品口／交付由阶段 3 的闸管住；这里补"随装复制"那一条）。
//
// 🔴 **判据打在真调那条路上**（V13）：`Delivery` / `assertOutboundAllowed` / `published.publish()`
//    / `mirrorArtifactIntoWorkspace` —— 不是这一份自己算一遍。
// 🔴 **文案断言只认字面**（`'不可算'`、禁用词）：不许用 `UNKNOWN` 那种常量去比常量
//    （那样把常量改坏，判据还是绿的 —— 那就成了恒真）。
//
// ⚠️ 风格照仓库现有测试：不起进程；盘上用真临时目录；正例与反例成对出现。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentRuntime } from '../src/agent-runtime.js';
import { Apps } from '../src/apps.js';
import {
  COPY_DELIVER,
  Delivery,
  DeliveryError,
  DELIVERY_COPY,
  EV_CONSENT,
  EV_DELIVER,
  EV_REQUEST,
  EV_REVOKE,
  NEEDS_CONSENT_LINE,
  otherSideFact,
  parseConsent,
  personaKeyOf,
  receiptFor,
} from '../src/delivery.js';
import { DATA_DIRNAME, PACK_FILENAME, assertOutboundAllowed } from '../src/outbound.js';
import { Published } from '../src/published.js';
import { Store } from '../src/store.js';
import { ScopeView, Timeline } from '../src/timeline.js';
import { AppWorkspaces, mirrorArtifactIntoWorkspace, snapshotWorkspace } from '../src/workspace.js';
import { Worlds } from '../src/worlds.js';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const SRC = nodePath.resolve(HERE, '..', 'src');

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});

function tmp(prefix = 'hupo-d4-') {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** 两个人（**人格 key**，不是手机号）：`GIVER` 给的那一方，`ASKER` 要的那一方。 */
const GIVER = personaKeyOf('u1');
const ASKER = personaKeyOf('u2');

/**
 * 一套**真的**登记面：真 `Store` ＋ 真 `Timeline`（那条可见日志）＋ 真 `ScopeView`。
 * ⚠️ 与 `worlds.js` 里那条接线**同一个形状**（一个人一条日志、一套号）。
 */
function registry() {
  const dataDir = tmp();
  const store = new Store({ dataDir, fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const view = new ScopeView({ timeline, scope: 'main' });
  const delivery = new Delivery({
    timeline: view,
    viewFor: (scope) => new ScopeView({ timeline, scope }),
  });
  return { dataDir, store, timeline, view, delivery, logPath: store.pathFor('main') };
}

/** 盘上那条日志的原文（**逐字节**：查"有没有写手机号"要用它）。 */
const logText = (r) => (nodeFs.existsSync(r.logPath) ? nodeFs.readFileSync(r.logPath, 'utf8') : '');
/** 盘上那条日志的全部事件。 */
const logEvents = (r) => r.store.readAll('main');

/** 一次合法的三步（请求→同意→交付）＋ 可选的第四步（撤回）。 */
function chain(r, { scope = 'main', packId = '新闻', shapeVersion = '2', range = '最近一个月' } = {}) {
  r.delivery.request({
    from: GIVER, to: ASKER, packId, shapeVersion, range,
    why: '我想要那份新闻数据', scope,
  });
  r.delivery.consent({
    req: { from: GIVER, to: ASKER, packId, shapeVersion, range },
    said: `行，那份${packId}第 ${shapeVersion} 版，${range}的，给你。`,
    scope,
  });
  r.delivery.deliver({ from: GIVER, to: ASKER, packId, shapeVersion, range, scope });
}

const caught = (fn) => {
  try { fn(); return null; } catch (err) { return err; }
};
const isDeliveryError = (e) => e instanceof DeliveryError;

// ════════════════════════════════════════════════════════════════
// §S4-1 四步都留痕
// ════════════════════════════════════════════════════════════════

test('🔴 S4-1 四步都留痕：请求→同意→登记交付→撤回，盘上四条都查得到、能列', () => {
  const r = registry();
  chain(r);
  r.delivery.revoke({
    from: GIVER, to: ASKER, packId: '新闻', shapeVersion: '2',
    why: '以后别给了，这一份撤回',
  });

  // ① 四步都在，而且顺序就是走的顺序
  assert.deepEqual(
    r.delivery.list().map((x) => x.type),
    [EV_REQUEST, EV_CONSENT, EV_DELIVER, EV_REVOKE],
    '🔴 少任何一条 ⇒ 红',
  );
  // ② 每条都带 谁对谁 / 哪一份 / 形状版本 / 范围 / 为什么 / at
  for (const rec of r.delivery.list()) {
    assert.equal(rec.from, GIVER);
    assert.equal(rec.to, ASKER);
    assert.equal(rec.packId, '新闻');
    assert.equal(rec.shapeVersion, '2');
    assert.equal(typeof rec.why, 'string');
    assert.equal(typeof rec.at, 'number');
    assert.equal(typeof rec.seq, 'number');
    assert.equal(rec.chainId, r.delivery.list()[0].chainId, '★ 四步是一条链（同一个 chainId）');
  }
  assert.equal(r.delivery.list({ type: EV_CONSENT })[0].range, '最近一个月', '★ 同意逐项，范围也记下来');
  assert.equal(r.delivery.list({ type: EV_REVOKE })[0].why.length > 0, true, '★ 撤回也要有他的原话');

  // ③ **在盘上**（不是只在内存里）：原文里有四种 type；另起一个对象照样读得回来
  const text = logText(r);
  for (const t of [EV_REQUEST, EV_CONSENT, EV_DELIVER, EV_REVOKE]) {
    assert.ok(text.includes(`"type":"${t}"`), `🔴 ${t} 必须在盘上（只在内存里 ⇒ 红）`);
  }
  const reread = new Delivery({
    timeline: new ScopeView({ timeline: new Timeline({ id: 'main', store: r.store }), scope: 'main' }),
  });
  assert.deepEqual(
    reread.list().map((x) => x.type),
    [EV_REQUEST, EV_CONSENT, EV_DELIVER, EV_REVOKE],
    '🔴 换个对象（重启）读不到 ⇒ 说明只写了内存',
  );

  // ④ **P-l：同一条可见日志、同一套编号**（多作用域只是标签）
  const seqs = logEvents(r).filter((e) => typeof e?.seq === 'number').map((e) => e.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), '🔴 号必须是一条线（1..N，不跳、不各起一套）');
  assert.deepEqual(
    nodeFs.readdirSync(r.dataDir).filter((n) => /^scope-.*\.jsonl$/.test(n)),
    [],
    '🔴 不许另起 scope 日志（P-l：一条可见日志）',
  );
});

test('🔴 S4-1 多作用域**只是事件上的标签**：房间里的那条带 scopeId，号还是同一套', () => {
  const r = registry();
  // 主线一条、房间里一条（同一条日志、同一套号）
  r.delivery.request({ from: GIVER, to: ASKER, packId: '新闻', shapeVersion: '2', why: '主线要的' });
  r.delivery.request({
    from: GIVER, to: ASKER, packId: '新闻', shapeVersion: '2', why: '房间里要的', scope: 'alpha',
  });
  const all = r.delivery.list();
  assert.equal(all.length, 2, '★ 两个作用域的四步记录**都在这一个人的账上**');
  assert.equal(all[0].scopeId, 'main');
  assert.equal(all[1].scopeId, 'alpha');
  assert.deepEqual(all.map((x) => x.seq), [1, 2], '🔴 不是每间各从 1 起');
  // 房间视图读得到自己那条，主线视图读不到它
  const alphaView = new ScopeView({ timeline: r.timeline, scope: 'alpha' });
  assert.equal(alphaView.readAll().filter((e) => e.type === EV_REQUEST).length, 1);
  assert.equal(r.view.readAll().filter((e) => e.type === EV_REQUEST).length, 1);
});

test('🔴 记录里不许写手机号：只记人格 key（拿手机号进去 ⇒ 当场拒）', () => {
  const r = registry();
  assert.notEqual(personaKeyOf('13800000000'), '13800000000', '★ 人格 key 是哈希出来的');
  const bad = caught(() => r.delivery.request({
    from: '13800000000', to: ASKER, packId: '新闻', shapeVersion: '2', why: '要一份',
  }));
  assert.ok(isDeliveryError(bad), '🔴 手机号当身份 ⇒ 必须拒');
  assert.equal(r.delivery.list().length, 0, '★ 拒的时候盘上零残留');

  // 正对照：用**人格 key** 走完整条链，日志原文里一个手机号都不许有
  const giver = personaKeyOf('13800000000');
  r.delivery.request({ from: giver, to: ASKER, packId: '新闻', shapeVersion: '2', why: '要一份' });
  assert.equal(logText(r).includes('13800000000'), false, '🔴 账上不许出现手机号');
  assert.ok(logText(r).includes(giver), '★ 记的是人格 key');
});

// ════════════════════════════════════════════════════════════════
// §S4-2 🔴 无同意 ⇒ 交付失败（fail-closed）
// ════════════════════════════════════════════════════════════════

test('🔴 S4-2 没有可识别的【同意】⇒ 交付失败；助手自己判断"他会同意"也不行', () => {
  const r = registry();
  r.delivery.request({
    from: GIVER, to: ASKER, packId: '新闻', shapeVersion: '2', range: '最近一个月', why: '要一份',
  });

  // ① 只有请求 ⇒ 交付必须失败
  const e1 = caught(() => r.delivery.deliver({
    from: GIVER, to: ASKER, packId: '新闻', shapeVersion: '2', range: '最近一个月',
  }));
  assert.ok(isDeliveryError(e1), '🔴 无同意 ⇒ 交付失败（fail-closed）');
  assert.match(e1.message, /同意/);
  assert.equal(r.delivery.list({ type: EV_DELIVER }).length, 0, '🔴 失败的交付不许落记录');

  // ② 助手"自己觉得他会同意"（带 agreed / 一句注释）⇒ 一样失败
  const e2 = caught(() => r.delivery.deliver({
    from: GIVER, to: ASKER, packId: '新闻', shapeVersion: '2', range: '最近一个月',
    agreed: true, note: '他应该会同意',
  }));
  assert.ok(isDeliveryError(e2), '🔴 助手自己判断 ⇒ 红');
  assert.equal(r.delivery.list({ type: EV_DELIVER }).length, 0);

  // ③ 正对照（证明不是"这条路根本走不通"）：真有同意 ⇒ 交付成立
  r.delivery.consent({
    req: { from: GIVER, to: ASKER, packId: '新闻', shapeVersion: '2', range: '最近一个月' },
    said: '行，那份新闻第 2 版，最近一个月的，给你。',
  });
  r.delivery.deliver({ from: GIVER, to: ASKER, packId: '新闻', shapeVersion: '2', range: '最近一个月' });
  assert.equal(r.delivery.list({ type: EV_DELIVER }).length, 1, '★ 有同意就交得出去（登记一条）');
});

test('🔴 S4-2 拒的时候给的是**人话**（不是内部词），而且说清该怎么办', () => {
  assert.match(NEEDS_CONSENT_LINE, /亲口说一句同意/);
  assert.doesNotMatch(NEEDS_CONSENT_LINE, /delivery|consent|token|scope/i, '内部词不许上屏');
});

// ════════════════════════════════════════════════════════════════
// §S4-3 🔴 同意只读"他当轮自己说的那句话"
// ════════════════════════════════════════════════════════════════

test('🔴 S4-3 请求里带 `agreed:true` 不算：`said` 是空的 ⇒ 同意不成立', () => {
  const r = registry();
  // 请求里塞满"他已经同意了"的字段 —— 一个都不许被当成同意
  r.delivery.request({
    from: GIVER, to: ASKER, packId: '新闻', shapeVersion: '2', range: '最近一个月',
    why: '要一份', agreed: true, approved: true, said: '他同意了',
  });
  const req = {
    from: GIVER, to: ASKER, packId: '新闻', shapeVersion: '2', range: '最近一个月',
    agreed: true, said: '他同意了',
  };
  for (const said of ['', null, undefined, '他同意了']) {
    const e = caught(() => r.delivery.consent({ req, said }));
    assert.ok(isDeliveryError(e), `🔴 said=${JSON.stringify(said)} 时不许成立（请求里的字段不算）`);
  }
  assert.equal(r.delivery.list({ type: EV_CONSENT }).length, 0, '★ 盘上一条同意都不许有');

  // **反例的正身**：纯函数只认 `said`（把 agreed 塞进 items 也过不了）
  assert.equal(parseConsent({ said: '', packId: '新闻', shapeVersion: '2', range: '最近一个月' }), null);
  assert.equal(parseConsent({ said: '行吧', packId: '新闻', shapeVersion: '2', range: '最近一个月' }), null);
  assert.notEqual(
    parseConsent({ said: '行，那份新闻第 2 版，最近一个月的，给你。', packId: '新闻', shapeVersion: '2', range: '最近一个月' }),
    null,
    '★ 正对照：他真说了那三项 ⇒ 认得出',
  );
});

// ════════════════════════════════════════════════════════════════
// §S4-4 🔴 同意逐项
// ════════════════════════════════════════════════════════════════

test('🔴 S4-4 三项（份 / 形状版本 / 范围）缺一不可；泛泛的"行吧"不放任何数据出去', () => {
  const r = registry();
  r.delivery.request({
    from: GIVER, to: ASKER, packId: '新闻', shapeVersion: '2', range: '最近一个月', why: '要一份',
  });
  const req = { from: GIVER, to: ASKER, packId: '新闻', shapeVersion: '2', range: '最近一个月' };

  // ①②③ 缺哪一项都不成立（而且三项必须**逐字出现在他那句话里**）
  const cases = [
    { name: '泛泛一句"行吧"', said: '行吧' },
    { name: '说了份、没说形状版本与范围', said: '行，那份新闻给你。' },
    { name: '说了份与范围、没说形状版本', said: '行，那份新闻最近一个月的给你。' },
    { name: '没说清是那份', said: '行，第 2 版最近一个月的给你。' },
  ];
  for (const c of cases) {
    const e = caught(() => r.delivery.consent({ req, said: c.said }));
    assert.ok(isDeliveryError(e), `🔴 ${c.name} ⇒ 必须拒`);
  }
  assert.equal(r.delivery.list({ type: EV_CONSENT }).length, 0);

  // ④ **泛泛的同意不许覆盖别的**：同意只管他说的那一项组合
  r.delivery.consent({ req, said: '行，那份新闻第 2 版，最近一个月的，给你。' });
  for (const other of [
    { range: '最近一年', why: '范围对不上' },
    { packId: '别的包', why: '份对不上' },
    { shapeVersion: '9', why: '形状版本对不上' },
  ]) {
    const e = caught(() => r.delivery.deliver({
      from: GIVER, to: ASKER, packId: '新闻', shapeVersion: '2', range: '最近一个月', ...other,
    }));
    assert.ok(isDeliveryError(e), `🔴 ${other.why} 也交得出去 ⇒ 红`);
  }
  assert.equal(r.delivery.list({ type: EV_DELIVER }).length, 0, '★ 一条都不许溜出去');
  // 正对照
  r.delivery.deliver({ from: GIVER, to: ASKER, packId: '新闻', shapeVersion: '2', range: '最近一个月' });
  assert.equal(r.delivery.list({ type: EV_DELIVER }).length, 1);
});

// ════════════════════════════════════════════════════════════════
// §S4-5 🔴 回执如实（这一阶段的核心）
// ════════════════════════════════════════════════════════════════

/**
 * 那些**断言了做不到的事**的说法。它们出现一次，就是"页面在说假话"。
 * ⚠️ 这张表**只认字面**（不是拿常量比常量）—— S4-5 的反例就是把文案改成这里面的词。
 */
const FORBIDDEN = /(已删除|已经删除|删干净|删掉了|已经删|对方收到|对方那边已|对方那边有|对方拿到|对方已经拿到|已经给到|已经给对方|已经送到|他收到了)/;

test('🔴 S4-5 文案表里**没有**"已删除／已经给到对方／对方那边有了"这类断言，而且说清了这边做了什么', () => {
  // ① 扫**文案表本身**（一处集中，判据扫它 —— 照 `time-words` 扫 `WORK_COPY` 同款）
  assert.ok(DELIVERY_COPY.length >= 4, '文案表要在');
  for (const c of DELIVERY_COPY) {
    assert.doesNotMatch(c.text, FORBIDDEN, `🔴 文案「${c.id}」在说做不到的事：${c.text}`);
    assert.doesNotMatch(c.text, /保证不再扩散|保证删掉/, `🔴 版权只换留痕，不许写成保护：${c.id}`);
  }
  // ② 交付那条必须**明说这边真的做了什么 ＋ 还没有送过去的路**
  assert.match(COPY_DELIVER, /记下/, '★ 要说清这边做了什么（记下了）');
  assert.match(COPY_DELIVER, /没有把东西送过去的路/, '🔴 这一阶段没有传输，必须如实说');
  // ③ 真路生成的回执也要过同一把尺（不是只扫表）
  const seen = new Set();
  for (const type of [EV_REQUEST, EV_CONSENT, EV_DELIVER, EV_REVOKE]) {
    const rec = { type };
    const got = receiptFor(rec);
    seen.add(got.line);
    assert.doesNotMatch(got.line, FORBIDDEN, `🔴 ${type} 的回执在说假话：${got.line}`);
    assert.ok(DELIVERY_COPY.some((c) => c.text === got.line), '★ 回执只能来自那张表（不许另写一句）');
  }
  assert.equal(seen.size, 4, '★ 四步各有各的话（不许一句糊过去）');

  // ④ 反例的正身：这把尺**不是恒真**
  assert.match('已经删干净了', FORBIDDEN);
  assert.match('对方那边已经有了', FORBIDDEN);
  assert.match('已经给到对方了', FORBIDDEN);
  assert.doesNotMatch(COPY_DELIVER, FORBIDDEN, '★ 正对照：我们那句是干净的');
});

test('🔴 S4-5 真跑一遍：四步的回执都能从记录算出来，而且都不含那类断言', () => {
  const r = registry();
  chain(r);
  r.delivery.revoke({
    from: GIVER, to: ASKER, packId: '新闻', shapeVersion: '2', why: '撤回，以后别给了',
  });
  const lines = r.delivery.list().map((rec) => receiptFor(rec).line);
  assert.equal(lines.length, 4);
  for (const line of lines) assert.doesNotMatch(line, FORBIDDEN, `🔴 ${line}`);
  assert.match(lines[2], /记下了要给你这份/);
  assert.match(lines[3], /以后不给/);
});

// ════════════════════════════════════════════════════════════════
// §S4-6 🔴 撤回后新请求 ⇒ 拒，且撤回落盘
// ════════════════════════════════════════════════════════════════

test('🔴 S4-6 撤回落盘；撤回之后**新的请求一律拒**，也不再交付', () => {
  const r = registry();
  chain(r);
  const consented = r.delivery.list({ type: EV_CONSENT }).length;
  assert.equal(consented, 1);

  r.delivery.revoke({
    from: GIVER, to: ASKER, packId: '新闻', shapeVersion: '2', range: '最近一个月',
    why: '撤回，以后别给了',
  });
  assert.equal(r.delivery.list({ type: EV_REVOKE }).length, 1, '🔴 撤回必须落盘（不是界面上一个开关）');
  assert.ok(logText(r).includes(EV_REVOKE));

  // 新请求 ⇒ 拒（**一律**：换个范围也拒）
  for (const range of ['最近一个月', '最近一年', null]) {
    const e = caught(() => r.delivery.request({
      from: GIVER, to: ASKER, packId: '新闻', shapeVersion: '2', range, why: '再要一份',
    }));
    assert.ok(isDeliveryError(e), `🔴 撤回之后（range=${range}）还收得下新请求`);
  }
  // 撤回**撤销**了原来的同意：拿旧的同意也交不出去
  const e = caught(() => r.delivery.deliver({
    from: GIVER, to: ASKER, packId: '新闻', shapeVersion: '2', range: '最近一个月',
  }));
  assert.ok(isDeliveryError(e), '🔴 撤回之后还交得出去 ⇒ 红');
  assert.equal(r.delivery.list({ type: EV_REQUEST }).length, 1, '★ 拒的请求一条都不许落');
  assert.equal(r.delivery.list({ type: EV_DELIVER }).length, 1, '★ 撤回前那一条还在（只追加）');

  // 正对照：**别的**份不受影响（撤回是逐份的，不是一刀全禁）
  r.delivery.request({ from: GIVER, to: ASKER, packId: '别的包', shapeVersion: '2', why: '要这个' });
  assert.equal(r.delivery.list({ type: EV_REQUEST }).length, 2);
});

// ════════════════════════════════════════════════════════════════
// §S4-7 请求必须指形状版本
// ════════════════════════════════════════════════════════════════

test('🔴 S4-7 请求没有 `shapeVersion` ⇒ 拒（盘上零残留）；给得出声明 ⇒ 对不上也拒', () => {
  const r = registry();
  for (const shapeVersion of [undefined, null, '', '   ']) {
    const e = caught(() => r.delivery.request({
      from: GIVER, to: ASKER, packId: '新闻', shapeVersion, why: '要一份',
    }));
    assert.ok(isDeliveryError(e), `🔴 shapeVersion=${JSON.stringify(shapeVersion)} 也放过去了`);
    assert.match(e.message, /形状版本/);
  }
  assert.equal(r.delivery.list().length, 0, '🔴 拒的请求盘上零残留');

  // **形状对不上不许静默算对**：声明说 2，请求说 9 ⇒ 拒
  const strict = new Delivery({
    timeline: r.view,
    shapeOf: (packId) => (packId === '新闻' ? '2' : null),
  });
  const bad = caught(() => strict.request({
    from: GIVER, to: ASKER, packId: '新闻', shapeVersion: '9', why: '要一份',
  }));
  assert.ok(isDeliveryError(bad), '🔴 形状对不上却静默算对 ⇒ 红');
  // 正对照：对得上 ⇒ 过
  strict.request({ from: GIVER, to: ASKER, packId: '新闻', shapeVersion: '2', why: '要一份' });
  assert.equal(r.delivery.list({ type: EV_REQUEST }).length, 1);
});

// ════════════════════════════════════════════════════════════════
// §S4-8 🔴 算不出就如实标「不可算」
// ════════════════════════════════════════════════════════════════

test('🔴 S4-8 "对方那份还在不在"今天没有信号 ⇒ 只许写「不可算」，不许给确定答案', () => {
  // ① 事实那一半：**可算的那个值就是"不可算"**，而且把"为什么"一起说出来
  const fact = otherSideFact();
  assert.equal(fact.value, '不可算', '🔴 必须逐字是"不可算"（改了它这条就红）');
  assert.equal(fact.computable, false);
  assert.match(fact.why, /没有.*信号/, '★ 要说清为什么算不出');

  // ② 走完整条链、撤回之后，回执里仍然是"不可算"（**没有因为"走完了"就变成确定答案**）
  const r = registry();
  chain(r);
  r.delivery.revoke({
    from: GIVER, to: ASKER, packId: '新闻', shapeVersion: '2', why: '撤回，以后别给了',
  });
  const revokeRec = r.delivery.list({ type: EV_REVOKE })[0];
  const got = receiptFor(revokeRec);
  assert.ok(got.otherSide, '★ 撤回那条要带上"对面那份怎么办"');
  assert.equal(got.otherSide.value, '不可算');
  assert.match(got.otherSide.line, /不可算/);
  assert.doesNotMatch(got.otherSide.line, /已删除|已经不在|对方那边已有|还在对方那边。/);

  // ③ **不许**在盘上留下一个"对面收到了"的确定记录（四步里没有对端回执这一种）
  for (const rec of r.delivery.list()) {
    assert.doesNotMatch(JSON.stringify(rec), /对方收到|对方那边有|已经给到/, '🔴 记录里也不许有对端的确定说法');
  }
  // 反例的正身：拿一个确定答案去比 ⇒ 当场红
  assert.notEqual('还在', '不可算');
  assert.notEqual('已经删掉了', '不可算');
});

// ════════════════════════════════════════════════════════════════
// §S4-9 🔴 四步是唯一的路（这一阶段没有任何一条路能把字节带出去）
// ════════════════════════════════════════════════════════════════

/** 去掉注释（判据只认**代码**里的字，不认解释里的 —— 照 `outbound-defaults.test.js`）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

test('🔴 S4-9 登记面**不搬字节**（源码级）：`delivery.js` 不碰 `.data`／`.exp`、不读写文件', () => {
  const code = stripComments(nodeFs.readFileSync(nodePath.join(SRC, 'delivery.js'), 'utf8'));
  const seg = /(^|[^A-Za-z0-9_$?.])\.(exp|data)(?![A-Za-z0-9_$])/g;
  assert.deepEqual([...code.matchAll(seg)].map((m) => m[0].trim()), [], '🔴 登记面不许读那两格');
  assert.doesNotMatch(code, /\b(EXP_DIRNAME|DATA_DIRNAME|readPacks|PACK_FILENAME)\b/, '🔴 连常量名都不许出现');
  assert.doesNotMatch(code, /readFileSync|writeFileSync|createReadStream|nodeFs/, '🔴 它只写记录，不碰文件内容');
  // 反例的正身：这把尺不是恒真
  assert.notEqual(stripComments("nodeFs.readFileSync(nodePath.join(scopeDir, '.data', 'x'))").match(seg), null);
  assert.match(stripComments("import { DATA_DIRNAME } from './outbound.js';"), /DATA_DIRNAME/);
});

test('🔴 S4-9 四步的登记只有这一处：`delivery/*` 那几个事件名只出现在 `delivery.js`', () => {
  const hits = [];
  for (const name of nodeFs.readdirSync(SRC)) {
    if (!name.endsWith('.js') || name === 'delivery.js') continue;
    const code = stripComments(nodeFs.readFileSync(nodePath.join(SRC, name), 'utf8'));
    if (/['"]delivery\/(request|consent|deliver|revoke)['"]/.test(code)) hits.push(name);
  }
  assert.deepEqual(hits, [], '🔴 冒出第二个写这四种记录的地方 ⇒ 红');
  // 反例的正身
  assert.match(stripComments("timeline.emit({ type: 'delivery/request' })"), /'delivery\/request'/);
});

test('🔴 S4-9 "随装复制"那一条：装上／复制过去的那一份里**不许出现数据包字节**', () => {
  const SENTINEL = 'stage4-sentinel-DO-NOT-SHIP-9f3a';
  const wA = tmp();
  const appsA = new Apps({ dir: wA, sub: 'u1' });
  const wsA = new AppWorkspaces({ dir: wA, log: () => {} });
  const published = new Published({ dir: wA });

  // A 造一份 app：**走真路** —— 工作区里放内容 ⇒ `snapshotWorkspace` 读工作区成制品
  //   （`workspaces.read()` 跳过 `.` 开头的路径，就是"随装复制"不带数据包字节的第一道结构）
  wsA.ensure('news', { title: '新闻', entry: 'index.html' });
  wsA.write('news', {
    'index.html': '<p>第一版</p>',
    'outbound.json': JSON.stringify({ schema: 1, outbound: [], declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '测试' } }),
  });
  snapshotWorkspace({ apps: appsA, workspaces: wsA, id: 'news', title: '新闻', icon: 'dice' });
  // 工作区里再放一格数据包（`.data/secret/`：声明 + **一段真字节**）—— 它**不是**制品
  const scopeA = wsA.dirFor('news');
  const packDir = nodePath.join(scopeA, DATA_DIRNAME, 'secret');
  nodeFs.mkdirSync(packDir, { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(packDir, PACK_FILENAME),
    `${JSON.stringify({ schema: 1, outbound: 'one-to-one', items: [{ path: 'payload.json', share: true }] })}\n`,
  );
  nodeFs.writeFileSync(nodePath.join(packDir, 'payload.json'), `${SENTINEL}\n`);

  // ① 出界闸：数据包（one-to-one）**一条都不许出** —— 上架／交付两条口都试
  for (const route of ['publish', 'deliver', 'artifact']) {
    const out = assertOutboundAllowed({ route, apps: appsA, workspaces: wsA, id: 'news' });
    assert.deepEqual(out.share, [], `🔴 ${route} 口把数据包带出去了：${JSON.stringify(out.share)}`);
  }
  // ② 真上架：共享库那一版里没有那段字节、也没有那格路径
  const idx = published.publish(appsA, { id: 'news', authorSub: 'u1' });
  const verDir = nodePath.join(published.dir, 'published-apps', 'news', 'versions', String(idx.version));
  assert.equal(dirText(verDir).includes(SENTINEL), false, '🔴 共享库里出现了数据包字节');
  assert.equal(
    nodeFs.existsSync(nodePath.join(verDir, DATA_DIRNAME)),
    false,
    '🔴 制品里不许有 `.data/` 那一格',
  );

  // ③ **随装复制**：另一个人装上去（复制进他自己的制品库 ＋ 镜像进工作区）⇒ 一样零命中
  const wB = tmp();
  const appsB = new Apps({ dir: wB, sub: 'u2' });
  const wsB = new AppWorkspaces({ dir: wB, log: () => {} });
  published.installInto(appsB, 'news');
  mirrorArtifactIntoWorkspace({ apps: appsB, workspaces: wsB, id: 'news' });
  assert.equal(dirText(wB).includes(SENTINEL), false, '🔴 装上／复制过去的那一份里出现了数据包字节');
  assert.equal(
    nodeFs.existsSync(nodePath.join(wsB.dirFor('news'), DATA_DIRNAME)),
    false,
    '🔴 随装复制不许把 `.data/` 带过去',
  );

  // ④ **登记面本身不搬字节**：走完四步，两个世界的工作区都没有多出那段字节
  const r = registry();
  chain(r);
  r.delivery.revoke({ from: GIVER, to: ASKER, packId: '新闻', shapeVersion: '2', why: '撤回' });
  assert.equal(r.delivery.list().length, 4, '★ 四步都登记了（正对照：不是"什么都没发生"）');
  assert.equal(dirText(wB).includes(SENTINEL), false, '🔴 走完四步之后字节还是不许过去');
  assert.equal(dirText(wA).includes(SENTINEL), true, '★ 正对照：哨兵原本是在的（上面那条不是空跑）');
});

/** 一个目录下所有文件的字节拼起来（查哨兵用的）。 */
function dirText(dir) {
  let out = '';
  const walk = (d) => {
    for (const e of nodeFs.readdirSync(d, { withFileTypes: true })) {
      const p = nodePath.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try { out += nodeFs.readFileSync(p, 'utf8'); } catch { /* 读不到就不算 */ }
      }
    }
  };
  walk(dir);
  return out;
}

// ════════════════════════════════════════════════════════════════
// 接线：世界与房间拿到的是**同一个登记面**（一个人一本账）
// ════════════════════════════════════════════════════════════════

test('★ 接线：`world.delivery` 真的落在那个人的可见日志上；房间与主线共用它', async () => {
  const dataDir = tmp('hupo-d4-worlds-');
  const cfg = {
    dataDir,
    dshHome: nodePath.join(dataDir, '__owner_dsh__'),
    agentCwd: nodePath.join(dataDir, '__owner_cwd__'),
    ledgerSocketPath: nodePath.join(dataDir, 'ledger.sock'),
    dshBin: 'unused',
    agentProfile: 'sdk',
    agentProvider: 'fake',
    agentModel: 'fake',
    agentEffort: 'low',
    agentMaxTokens: 512,
    agentBootTimeoutMs: 20000,
    agentMaxProcesses: 4,
    agentIdleEvictMs: 60000,
    personaPath: null,
    recap: {},
    turnDeadlineMs: 5000,
  };
  nodeFs.mkdirSync(cfg.dshHome, { recursive: true });
  nodeFs.mkdirSync(cfg.agentCwd, { recursive: true });
  let worlds = null;
  const runtime = new AgentRuntime({
    cfg,
    cfgFor: (key) => worlds.cfgForAgentKey(key),
    spawnFn: () => { throw new Error('这个用例不该起 agent'); },
  });
  worlds = new Worlds({ cfg, runtime, log: () => {}, warn: () => {} });
  try {
    const world = worlds.worldFor('u1');
    assert.ok(world.delivery instanceof Delivery, '🔴 世界必须挂上登记面');
    world.workspaces.ensure('alpha', { title: 'alpha', entry: 'index.html' });
    const room = worlds.roomFor('u1', 'alpha');
    assert.equal(room.delivery, world.delivery, '🔴 一个用户一本账（房间不许另起一个）');

    const giver = personaKeyOf('u1');
    const asker = personaKeyOf('u2');
    world.delivery.request({ from: giver, to: asker, packId: '新闻', shapeVersion: '2', why: '要一份' });
    world.delivery.request({
      from: giver, to: asker, packId: '新闻', shapeVersion: '2', why: '房间里要的', scope: 'alpha',
    });
    // 真落盘：那个人的 `main.jsonl` 里有两条，带 tag 的那条有 scopeId
    const raw = nodeFs.readFileSync(world.store.pathFor('main'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const reqs = raw.filter((e) => e.type === EV_REQUEST);
    assert.equal(reqs.length, 2);
    assert.deepEqual(reqs.map((e) => e.scopeId ?? 'main'), ['main', 'alpha']);
    assert.deepEqual(reqs.map((e) => e.seq), [reqs[0].seq, reqs[0].seq + 1], '★ 同一套号');
  } finally {
    await worlds.shutdownDispatchers();
    await runtime.shutdown();
    worlds.closeSockets();
  }
});
