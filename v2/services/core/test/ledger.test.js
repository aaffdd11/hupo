// 账本本体（批 4 · 契约 `docs/dev/31-LEDGER.md` v2 §7.5）。
//
// 这一篇守的是**第一份持久化的用户数据**那几条底线：
//   ① 🔴 **只追加**：改一条 = 新增一条；**本模块根本没有"改"的入口**
//   ② 🔴 **校验不过 ⇒ 盘上一个字节都不动**（不是"写一半再回滚"）
//   ③ 🔴 **含税说不清的不进合计，而且明说有几条未计入**（D6.9）
//   ④ 🔴 **删除与 ⑲ 同语义**：30 天 / 可恢复 / 真删要压实；**恢复之后合计不变**（§7.4）
//   ⑤ **纯函数**：同一句话说两次 ⇒ 逐字段 diff = 0（D6.3 / D6.10，时钟注入）
//   ⑥ **回显里必须有钱数和日期**（D6.5：钱数 / 日期 / 名字不确认不写）
//   ⑦ 文案不许出现内部词（这是缺陷，不是文风问题）

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';
import { TRASH_TTL_MS } from '../src/trash.js';
import {
  EV_ENTRY, FIELDS, LEDGER_TTL_MS, MAX_ENTRIES_PER_DAY, MAX_SAID_CHARS,
  Ledger, LedgerError, dateOf, normalizeFields, problemsLine, renderEcho,
} from '../src/ledger.js';

const AT = new Date(2026, 8, 21, 10, 0).getTime(); // 2026-09-21 10:00 本地
const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});

/** 一条正常的账目（每个用例按需覆盖一两项）。 */
const OK = Object.freeze({
  kind: '装空调', qty: 3, unit: '台', unitPrice: 1200, tax: false, date: '2026-08-20',
});
const SAID = '帮我把上周装了三台空调记一下，一台一千二，不含税';

function bench({ now = () => AT, ids } = {}) {
  const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-ledger-'));
  tmpDirs.push(dataDir);
  const store = new Store({ dataDir, fsync: false });
  const timeline = new Timeline({ id: 'ledger', store, clock: now });
  let n = 0;
  const newId = () => (ids ? ids[n++ % ids.length] : `e${++n}`);
  const ledger = new Ledger({ store, timeline, now, newId }).sync();
  return { dataDir, store, timeline, ledger };
}

// ── ⑤ 纯函数 + 逐字段 diff = 0（D6.3 / D6.10）──────────────────

test('🔴 同一句话两次 ⇒ **逐字段 diff = 0**（时钟注入，不真等 7 天）', () => {
  const raw = '把 9 月 3 日那 2 小时现场支持记上，一小时 800，含税';
  const a = normalizeFields(OK);
  const b = normalizeFields({ ...OK });
  assert.equal(a.ok, true);
  assert.deepEqual(a.fields, b.fields, '同一份输入两次，六个字段必须一模一样');
  for (const f of FIELDS) {
    assert.equal(a.fields[f], b.fields[f], `字段 ${f} 漂了`);
  }
  void raw;
  // 打乱键的顺序也不该影响结果（纯函数，不是"看它先看到哪个键"）
  const shuffled = { date: OK.date, tax: OK.tax, unitPrice: OK.unitPrice, unit: OK.unit, qty: OK.qty, kind: OK.kind };
  assert.deepEqual(normalizeFields(shuffled).fields, a.fields);
});

test('回显是纯函数：同一个 fields 两次一模一样（主人看到的那句话不会飘）', () => {
  assert.equal(renderEcho(OK), renderEcho({ ...OK }));
});

// ── ② 校验：逐项说清哪一项（D6.5）────────────────────────────

test('六个字段逐项校验：缺哪一项就说哪一项，**不是笼统"格式不对"**', () => {
  const cases = [
    [{ ...OK, kind: '' }, 'kind', '事项'],
    [{ ...OK, qty: '三' }, 'qty', '数量'],
    [{ ...OK, qty: 0 }, 'qty', '数量'],
    [{ ...OK, unit: '' }, 'unit', '单位'],
    [{ ...OK, unitPrice: -1 }, 'unitPrice', '单价'],
    [{ ...OK, tax: '大概吧' }, 'tax', '含税'],
    [{ ...OK, date: '2026-02-30' }, 'date', '日期'],
    [{ ...OK, date: '八月二十号' }, 'date', '日期'],
  ];
  for (const [raw, field, label] of cases) {
    const r = normalizeFields(raw);
    assert.equal(r.ok, false, `${field} 这一项该被判不过：${JSON.stringify(raw)}`);
    assert.equal(r.fields, null, '不过的时候**不许**给出半份字段');
    assert.ok(r.problems.some((p) => p.field === field), `要点名是 ${field}`);
    const line = problemsLine(r.problems);
    assert.ok(line.includes(label), `那句人话里要有「${label}」：${line}`);
  }
});

test('单价可以空（没说钱就不许编一个 0 出来）', () => {
  const r = normalizeFields({ ...OK, unitPrice: undefined });
  assert.equal(r.ok, true);
  assert.equal(r.fields.unitPrice, null);
  assert.equal(normalizeFields({ ...OK, unitPrice: '' }).fields.unitPrice, null);
  assert.equal(normalizeFields({ ...OK, unitPrice: 0 }).fields.unitPrice, 0, '0 与"没说"是两件事');
});

test('含税三态收得下：true / false / 说不清', () => {
  assert.equal(normalizeFields({ ...OK, tax: true }).fields.tax, true);
  assert.equal(normalizeFields({ ...OK, tax: false }).fields.tax, false);
  assert.equal(normalizeFields({ ...OK, tax: 'unknown' }).fields.tax, 'unknown');
  assert.equal(normalizeFields({ ...OK, tax: '说不清' }).fields.tax, 'unknown');
});

test('数字写成字符串也收（模型偶尔会包一层引号）', () => {
  const r = normalizeFields({ ...OK, qty: '3', unitPrice: '1200' });
  assert.equal(r.ok, true);
  assert.equal(r.fields.qty, 3);
  assert.equal(r.fields.unitPrice, 1200);
});

// ── ① 只追加 ─────────────────────────────────────────────────

test('🔴 写一条 = 盘上多一行；再写一条 = 再多一行（**旧的那条还在**）', () => {
  const b = bench({ ids: ['e1', 'e2'] });
  const one = b.ledger.write(OK, { said: SAID });
  const two = b.ledger.write({ ...OK, kind: '修空调' }, { said: SAID });
  assert.equal(one.entryId, 'e1');
  assert.equal(two.entryId, 'e2');

  const rows = b.store.readAll('ledger');
  assert.equal(rows.length, 2, '两条都在盘上');
  assert.deepEqual(rows.map((r) => r.type), [EV_ENTRY, EV_ENTRY]);
  assert.deepEqual(rows.map((r) => r.seq), [1, 2]);
  assert.equal(rows[0].kind, '装空调', '第一条**不许**被第二条改掉');
  b.store.verifyMonotonic('ledger'); // 号不跳
});

test('🔴 本模块**没有"改"的入口**（D6.7 是结构上的，不是纪律上的）', () => {
  const banned = ['update', 'edit', 'set', 'change', 'modify', 'replace', 'patch'];
  const names = Object.getOwnPropertyNames(Ledger.prototype);
  for (const n of banned) {
    assert.ok(!names.includes(n), `账本不许有 ${n}() —— 改一条只能靠"再记一条"`);
  }
});

test('🔴 **校验不过 ⇒ 盘上一个字节都不动**', () => {
  const b = bench();
  assert.throws(() => b.ledger.write({ ...OK, qty: '三' }, { said: SAID }), LedgerError);
  assert.throws(() => b.ledger.write(OK, { said: '' }), LedgerError);
  assert.equal(b.store.readAll('ledger').length, 0, '失败不许留下半条');
  assert.equal(b.store.lastEvent('ledger'), null);
});

test('出处（原话）不能是空的，也不能长到没边（D6.4 无出处不写）', () => {
  const b = bench();
  const err = (() => { try { b.ledger.write(OK, { said: '   ' }); } catch (e) { return e; } })();
  assert.ok(err instanceof LedgerError);
  assert.ok(err.problems.some((p) => p.field === 'said'));
  assert.equal(b.ledger.write(OK, { said: 'x'.repeat(MAX_SAID_CHARS) }).entryId.length > 0, true);
  assert.throws(() => b.ledger.write(OK, { said: 'x'.repeat(MAX_SAID_CHARS + 1) }), LedgerError);
});

test('propose **只算不写**（盘上零条），而且给出回显', () => {
  const b = bench();
  const p = b.ledger.propose(OK, { said: SAID });
  assert.equal(p.ok, true);
  assert.ok(p.echo.includes('1200'), '回显里必须有钱数');
  assert.ok(p.echo.includes(OK.date), '回显里必须有日期');
  assert.equal(b.store.readAll('ledger').length, 0, 'propose 一个字节都不许写');

  const bad = b.ledger.propose({ ...OK, date: '八月二十号' }, { said: SAID });
  assert.equal(bad.ok, false);
  assert.ok(bad.problemsText.includes('日期'));
  assert.equal(b.store.readAll('ledger').length, 0);
});

// ── ③ 合计：含税说不清的口径（D6.9）──────────────────────────

test('🔴 含税说不清的不进合计，而且**明说有几条未计入**', () => {
  const b = bench({ ids: ['a', 'b', 'c'] });
  b.ledger.write({ ...OK, qty: 1, unitPrice: 100, tax: false }, { said: SAID });   // 计
  b.ledger.write({ ...OK, qty: 2, unitPrice: 50, tax: true }, { said: SAID });     // 计
  b.ledger.write({ ...OK, qty: 9, unitPrice: 999, tax: 'unknown' }, { said: SAID }); // **不计**

  const t = b.ledger.totals();
  assert.equal(t.total, 200, '100 + 2×50');
  assert.equal(t.counted, 2);
  assert.equal(t.notCounted, 1, '那一条要说出来，不许装作没有');
});

test('没说钱的那几条：不算进合计，但单独报数（它们是"记了事没记钱"）', () => {
  const b = bench({ ids: ['a', 'b'] });
  b.ledger.write({ ...OK, unitPrice: null, qty: 5 }, { said: SAID });
  b.ledger.write({ ...OK, qty: 1, unitPrice: 30 }, { said: SAID });
  const t = b.ledger.totals();
  assert.equal(t.total, 30);
  assert.equal(t.noPrice, 1);
});

test('小数钱数不会长出浮点尾巴（0.1 + 0.2 那类）', () => {
  const b = bench({ ids: ['a', 'b'] });
  b.ledger.write({ ...OK, qty: 1, unitPrice: 0.1 }, { said: SAID });
  b.ledger.write({ ...OK, qty: 1, unitPrice: 0.2 }, { said: SAID });
  assert.equal(b.ledger.totals().total, 0.3);
});

// ── ④ 删除：与 ⑲ 同语义 ───────────────────────────────────────

test('🔴 回收站留多久 = **和 ⑲ 同一个数**（import 来的，不许各写一份）', () => {
  assert.equal(LEDGER_TTL_MS, TRASH_TTL_MS);
  assert.equal(bench().ledger.ttlDays, Math.round(TRASH_TTL_MS / 86400000));
});

test('删一条 ⇒ 它不在列表里、也不在合计里；**盘上那份还在**（还没真删）', () => {
  const b = bench({ ids: ['a'] });
  const r = b.ledger.write(OK, { said: SAID });
  b.ledger.remove([r.entryId]);
  assert.deepEqual(b.ledger.list(), []);
  assert.equal(b.ledger.totals().total, 0);
  assert.equal(b.ledger.listBin().length, 1);
  assert.ok(b.store.readAll('ledger').some((e) => e.entryId === 'a'), '回收站不等于真删');
});

test('🔴 **拿回来之后合计不变**（§7.4：恢复**不重发内容**）', () => {
  const b = bench({ ids: ['a'] });
  const r = b.ledger.write(OK, { said: SAID });
  const before = b.ledger.totals().total;
  b.ledger.remove([r.entryId]);
  assert.equal(b.ledger.restore([r.entryId]), true);
  assert.equal(b.ledger.totals().total, before, '拿回来合计要跟原来一模一样');
  const rows = b.store.readAll('ledger').filter((e) => e.type === EV_ENTRY);
  assert.equal(rows.length, 1, '恢复**不许**在盘上再抄一份内容（抄了就会算重）');
  assert.equal(b.ledger.list().length, 1);
});

test('删除是幂等的：删两次只有一条墓碑', () => {
  const b = bench({ ids: ['a'] });
  const r = b.ledger.write(OK, { said: SAID });
  b.ledger.remove([r.entryId]);
  b.ledger.remove([r.entryId]);
  assert.equal(b.store.readAll('ledger').filter((e) => e.type === 'ledger/deleted').length, 1);
});

test('🔴 真删 ⇒ 内容**真的不在盘上**了，而且号一个都没跳', () => {
  const b = bench({ ids: ['a', 'b'] });
  const r1 = b.ledger.write({ ...OK, kind: '不该留在盘上的事' }, { said: SAID });
  b.ledger.write(OK, { said: SAID });
  b.ledger.remove([r1.entryId]);
  b.ledger.purge([r1.entryId]);

  const text = nodeFs.readFileSync(nodePath.join(b.dataDir, 'ledger.jsonl'), 'utf8');
  assert.ok(!text.includes('不该留在盘上的事'), '真删之后盘上不许还有那几个字');
  b.store.verifyMonotonic('ledger'); // 压实保留 seq ⇒ 号连续
  assert.equal(b.ledger.list().length, 1);
  assert.equal(b.ledger.isPurged(r1.entryId), true);
});

test('重启还记得：sync() 之后回收站与真删都还在', () => {
  const b = bench({ ids: ['a', 'b'] });
  const r1 = b.ledger.write(OK, { said: SAID });
  const r2 = b.ledger.write({ ...OK, kind: '另一件' }, { said: SAID });
  b.ledger.remove([r1.entryId]);
  b.ledger.purge([r2.entryId]);

  const next = new Ledger({ store: b.store, timeline: b.timeline, now: () => AT, newId: () => 'x' }).sync();
  assert.equal(next.isHidden(r1.entryId), true);
  assert.equal(next.isPurged(r2.entryId), true);
  assert.deepEqual(next.list(), [], '一条也不该冒出来');
});

test('到点就真删（时钟注入，不真等 30 天）', () => {
  const b = bench({ ids: ['a'] });
  const r = b.ledger.write(OK, { said: SAID });
  b.ledger.remove([r.entryId]);
  assert.deepEqual(b.ledger.purgeExpired({ now: AT + LEDGER_TTL_MS - 1 }), [], '差一毫秒还不许动');
  const done = b.ledger.purgeExpired({ now: AT + LEDGER_TTL_MS });
  assert.equal(done.length, 1);
  assert.equal(b.ledger.isPurged(r.entryId), true);
});

// ── 去重 / 上限 ───────────────────────────────────────────────

test('🔴 同一个 entryId 出现两次 ⇒ 只算一条（后写的赢）', () => {
  const b = bench();
  b.timeline.emit({ type: EV_ENTRY, entryId: 'dup', ...OK, kind: '先写的', said: SAID, at: AT });
  b.timeline.emit({ type: EV_ENTRY, entryId: 'dup', ...OK, kind: '后写的', said: SAID, at: AT });
  const list = b.ledger.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, '后写的');
  assert.equal(b.ledger.totals().total, 3600, '3 台 × 1200 —— 只算一遍（算两遍会是 7200）');
});

test('没有 entryId 的行直接跳过（宁可少一条，也不凭猜塞一条进来）', () => {
  const b = bench();
  b.timeline.emit({ type: EV_ENTRY, ...OK, said: SAID, at: AT });
  assert.deepEqual(b.ledger.list(), []);
});

test('一天条数到上限 ⇒ 明说"到上限了"，而且**一条都没多写**', () => {
  const b = bench();
  for (let i = 0; i < MAX_ENTRIES_PER_DAY; i += 1) b.ledger.write(OK, { said: SAID });
  const rows = b.store.readAll('ledger').length;
  assert.throws(
    () => b.ledger.write(OK, { said: SAID }),
    (e) => e instanceof LedgerError && e.message.includes('上限'),
  );
  assert.equal(b.store.readAll('ledger').length, rows, '拒绝之后盘上不许多一行');
});

test('dateOf 用的是本地那一天的日期', () => {
  assert.equal(dateOf(new Date(2026, 8, 21, 23, 59).getTime()), '2026-09-21');
  assert.equal(dateOf(new Date(2026, 0, 1, 0, 0).getTime()), '2026-01-01');
});

// ── ⑦ 文案闸 ─────────────────────────────────────────────────

test('🔴 账本给主人看的每一句都不许出现内部词', () => {
  const b = bench();
  const lines = [
    renderEcho(OK),
    problemsLine([{ field: 'date', why: '没听准是哪一天（要 2026-08-20 这样）' }]),
    (() => { try { b.ledger.write({ ...OK, qty: '三' }, { said: SAID }); } catch (e) { return e.message; } })(),
    (() => { try { b.ledger.write(OK, { said: '' }); } catch (e) { return e.message; } })(),
    (() => { try { b.ledger.remove([]); } catch (e) { return e.message; } })(),
  ];
  for (const line of lines) {
    for (const w of [
      '工作区', '客户端', '云端', '服务器', '调度器', '时间线', '作用域', '会话',
      '工具', '搜索', '上下文', '系统提示', '模型', '口令', '记录', '轮',
      'entryId', 'seq', 'tombstone', 'ledger',
    ]) {
      assert.ok(!String(line).includes(w), `账本文案里出现了内部词「${w}」：${line}`);
    }
  }
});
