// 导出（批 3 欠的最后一件 · 契约 `docs/dev/30-EXPORT.md`）。
//
// 这一篇守契约 §五 里**服务端这一侧**的每一条：
//   ① 🔴 **回收站里的不算，而且末尾那行条数对得上**（正 + 负 + 恢复 + 真删）
//   ② 🔴 **文案过禁用词闸**（含"记录" —— ⑳ 踩过一次）
//   ③ **一段文字、不是表**：没有 markdown 表格 / 链接 / 加粗；时间戳只在跨天时出现一次
//   ④ **纯函数**：`renderExport` / `exportItems` 逐条对表（手册纪律 3：纯函数进 unit）
//   ⑤ **空对话** ⇒ 空串（那句实话由客户端说；服务端**不许**编一个空框）
//   ⑥ 只读口：`GET /api/export` 要令牌、不要 `confirm`

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { Auth } from '../src/auth.js';
import { SayService } from '../src/say.js';
import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';
import { Trash } from '../src/trash.js';
import { createServer } from '../src/server.js';
import {
  MEMORY_NOTE, WHO_IT, WHO_ME, buildExport, exportItems, renderExport, trashNote,
} from '../src/export.js';

// 用**本地时间**构造那几刻：跨天那一行读的就是本地时区，写死 UTC 会让这条闸看时区脸色。
const at = (day, hour = 12) => new Date(2026, 8, day, hour).getTime();

const T_A = '甲说的话'; const A_A = '甲的回答';
const T_B = '乙说的话'; const B_B = '乙的回答';
const T_C = '丙说的话'; const C_C = '丙的回答';

/**
 * 三轮、跨两天。`ids` 分别是每一轮的 `[用户那句, 回答]`。
 *
 * ⚠️ `message/text` **必须带 `seqInBlock`**（真日志里就是这么落的，
 *    `message-writer.js` 的 `chunk()`）——没有它，"重发的那一份"去重就无从谈起。
 */
function bench({ now = at(21) } = {}) {
  const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-export-'));
  const store = new Store({ dataDir, fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const trash = new Trash({ timeline, store, timelineId: 'main', now: () => now });

  const turn = (uid, utext, aid, atext, when) => {
    timeline.emit({ type: 'user/echo', messageId: uid, text: utext, at: when });
    timeline.emit({ type: 'message/start', messageId: aid, at: when });
    timeline.emit({ type: 'message/text', messageId: aid, block: 'quick', seqInBlock: 1, text: atext, at: when });
    timeline.emit({ type: 'message/end', messageId: aid, reason: 'completed', at: when });
  };
  turn('u_a', T_A, 'm_a', A_A, at(21, 9));
  turn('u_b', T_B, 'm_b', B_B, at(21, 15));
  turn('u_c', T_C, 'm_c', C_C, at(22, 10));

  return {
    dataDir, store, timeline, trash,
    idsA: ['u_a', 'm_a'], idsB: ['u_b', 'm_b'], idsC: ['u_c', 'm_c'],
  };
}

const raw = (b) => b.store.readAll('main');

// ── ④ 纯函数：折条 / 渲染 ────────────────────────────────────

test('折条：一轮 = 一条用户的话 + 整条回答（不是每段正文一条）', () => {
  const b = bench();
  const items = exportItems(raw(b));
  assert.equal(items.length, 6, '三轮 × 两句');
  assert.deepEqual(items.slice(0, 2).map((i) => [i.who, i.text]), [['me', T_A], ['it', A_A]]);
  assert.equal(items[0].seq < items[1].seq, true, '按时间顺序');
});

test('`quick` + `deep` 是同一个气泡 ⇒ 拼成一条（协议 R2）', () => {
  const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-export-q-'));
  const store = new Store({ dataDir, fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const when = at(21, 9);
  timeline.emit({ type: 'message/start', messageId: 'm_a', at: when });
  timeline.emit({ type: 'message/text', messageId: 'm_a', block: 'quick', seqInBlock: 1, text: A_A, at: when });
  timeline.emit({ type: 'message/text', messageId: 'm_a', block: 'deep', seqInBlock: 2, text: '详细的那些字。', at: when });
  timeline.emit({ type: 'message/end', messageId: 'm_a', reason: 'completed', at: when });

  const items = exportItems(store.readAll('main'));
  assert.equal(items.length, 1, '同一个气泡只许一条');
  assert.equal(items[0].text, `${A_A}\n详细的那些字。`);
});

test('🔴 时间戳**只在跨天时出现一次**，不逐条写（逐条写就是表）', () => {
  const b = bench();
  const text = renderExport(exportItems(raw(b)));
  const dates = text.match(/—— \d+月\d+日 ——/g) ?? [];
  assert.equal(dates.length, 2, '两天 ⇒ 两条日期行，六句话不许多带');
  assert.equal(dates.filter((d) => d.includes('9月21日')).length, 1);
  assert.equal(dates.filter((d) => d.includes('9月22日')).length, 1);
});

test('一段纯文字：没有 markdown 表格 / 链接 / 加粗', () => {
  const text = renderExport(exportItems(raw(bench())));
  assert.ok(!text.includes('|'), '不许画表（`|` 是表格语法）');
  assert.ok(!/\[[^\]]*\]\(/.test(text), '不许有 markdown 链接');
  assert.ok(!text.includes('**'), '不许有加粗语法');
  assert.ok(!text.includes('```'), '不许有代码块语法');
  assert.ok(text.includes(`${WHO_ME}${T_A}`) && text.includes(`${WHO_IT}${A_A}`));
});

test('⚠️ §二：**"导不出它记忆那一层"这句话必须出现在导出里**', () => {
  const text = renderExport(exportItems(raw(bench())));
  assert.ok(text.includes(MEMORY_NOTE), '少了这句 = 用户以为"导出 = 把它记得的全拿出来"');
  // 而且它是**成品文字里的一整段**，不是被并进某句话尾巴上的碎片
  assert.ok(text.split('\n\n').includes(MEMORY_NOTE));
});

// ── ① 🔴 回收站里的不算 + 条数对得上 ─────────────────────────

test('🔴 回收站里的**一个字节都不许出现**，而且末尾条数对得上', () => {
  const b = bench();
  b.trash.remove(b.idsB);
  b.trash.remove(b.idsC);

  const { text, hiddenCount } = buildExport(raw(b), {
    hiddenIds: b.trash.list().flatMap((t) => t.messageIds),
    hiddenCount: b.trash.list().length,
  });

  for (const w of [T_B, B_B, T_C, C_C]) {
    assert.ok(!text.includes(w), `★ 回收站里的「${w}」不许出现在导出里`);
  }
  for (const w of [T_A, A_A]) {
    assert.ok(text.includes(w), `★ 没被删的「${w}」必须还在（否则"没出现"是假绿）`);
  }
  assert.equal(hiddenCount, 2);
  assert.ok(text.includes(trashNote(2)), '★ 末尾要如实报条数');
});

test('★ 负向对照：**不喂 `hiddenIds` 的话，被删的那些本来会出现**', () => {
  // 少了这条对照，"它们没出现"可能只是因为别的原因（比如整段没渲染出来）。
  const b = bench();
  b.trash.remove(b.idsB);
  const wrong = renderExport(exportItems(raw(b)), { hiddenCount: 1 });
  assert.ok(wrong.includes(T_B), '不筛的话它就在（⇒ 上面那条断言是**筛**在起作用）');
});

test('🔴 条数 **N 对得上**：造 N 条进回收站 ⇒ 报 N；N = 0 时那一行不出现', () => {
  for (let n = 0; n <= 3; n += 1) {
    const b = bench();
    const all = [b.idsA, b.idsB, b.idsC];
    for (let i = 0; i < n; i += 1) b.trash.remove(all[i]);
    const bin = b.trash.list();
    const text = buildExport(raw(b), {
      hiddenIds: bin.flatMap((t) => t.messageIds),
      hiddenCount: bin.length,
    }).text;
    assert.equal(bin.length, n);
    if (n === 0) {
      assert.ok(!text.includes('没有算进来'), '★ 一条都没删过 ⇒ 这行不许出现');
    } else {
      assert.ok(text.includes(trashNote(n)), `★ N=${n} 时报的必须是 ${n}`);
    }
  }
});

test('§三 第三行：**恢复回来的算**（它是活的）', () => {
  const b = bench();
  b.trash.remove(b.idsB);
  assert.ok(!buildExport(raw(b), {
    hiddenIds: b.trash.list().flatMap((t) => t.messageIds),
    hiddenCount: b.trash.list().length,
  }).text.includes(T_B));

  b.trash.restore(b.idsB);
  const bin = b.trash.list();
  const { text } = buildExport(raw(b), {
    hiddenIds: bin.flatMap((t) => t.messageIds),
    hiddenCount: bin.length,
  });
  assert.ok(text.includes(T_B), '★ 拿回来的必须重新算进来');
  assert.ok(!text.includes('没有算进来'), '拿回来之后就不该再说"有东西没算进来"');
});

test('§三 第二行：**已经真删**的当然不算（内容没了，也不报数）', () => {
  const b = bench();
  b.trash.remove(b.idsB);
  b.trash.purge(b.idsB);
  const bin = b.trash.list();
  assert.equal(bin.length, 0);
  const { text } = buildExport(raw(b), {
    hiddenIds: bin.flatMap((t) => t.messageIds),
    hiddenCount: bin.length,
  });
  assert.ok(!text.includes(T_B), '真删了就不该在');
  assert.ok(!text.includes('没有算进来'), '真删不算"你说过要删掉的"那一行（§三：当然不算）');
});

test('🔴 恢复之后**不许印两遍**（重发那一份要按同一把钥匙去重）', () => {
  const b = bench();
  b.trash.remove(b.idsA);
  b.trash.restore(b.idsA); // 盘上现在有两份内容（新号、`at` 原值）
  const items = exportItems(raw(b));
  const mine = items.filter((i) => i.text === T_A);
  assert.equal(mine.length, 1, '★ 恢复过的那句话只许出现一次');
  assert.equal(items.filter((i) => i.text === A_A).length, 1);
});

// ── ⑤ 空对话 ─────────────────────────────────────────────────

test('⑤ 空对话 ⇒ **空串**（那句实话由客户端说；服务端不许编一个空框）', () => {
  assert.equal(renderExport(exportItems([])), '');
  assert.equal(buildExport([]).text, '');
  assert.equal(renderExport([]), '');
});

test('⑨ 一个字都没有、但**有东西被删过** ⇒ 只报条数（那是唯一该说话的情形）', () => {
  assert.equal(renderExport([], { hiddenCount: 2 }), trashNote(2));
});

// ── ② 禁用词闸（服务端这一侧）────────────────────────────────

test('🔴 导出里不许出现内部词（含"记录" —— ⑳ 踩过一次）', () => {
  const b = bench();
  b.trash.remove(b.idsB); // 让条数那行也一起被扫到
  const bin = b.trash.list();
  const text = buildExport(raw(b), {
    hiddenIds: bin.flatMap((t) => t.messageIds),
    hiddenCount: bin.length,
  }).text;
  for (const w of [
    '工作区', '客户端', '云端', '服务器', '调度器', '时间线', '作用域', '会话',
    '工具', '搜索', '上下文', '系统提示', '模型', '口令', '记录', '轮',
    'messageId', 'seq', 'tombstone',
  ]) {
    assert.ok(!text.includes(w), `导出里不许出现内部词「${w}」`);
  }
});

// ── ⑥ HTTP 那一层（只读口）───────────────────────────────────
//
// ⚠️ 每个起过监听的用例都在断言**之前**把 `close` 挂进 `t.after`。
//    为什么：用例在 `await close()` 之前断言失败时，那个监听会一直挂着
//    ⇒ node 的测试进程**永不退出** ⇒ "红"变成"挂到超时"（`server.test.js` 记过这一条）。
const openServers = new Set();
after(async () => {
  for (const close of openServers) {
    try {
      await close();
    } catch {
      // 关不干净不影响结论：判据是断言，不是"关得优雅"
    }
  }
  openServers.clear();
});

async function serve(t, b, { withTrash = true } = {}) {
  const authDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-export-auth-'));
  const auth = new Auth({ dataDir: authDir, lockAfter: 3, lockMs: 60_000 });
  const password = '导出用的密码啦';
  auth.setPassword(password);
  const say = new SayService({ timeline: b.timeline, store: b.store, timelineId: 'main' });
  const { listen, close } = createServer({
    timeline: b.timeline, store: b.store, auth, say, trash: withTrash ? b.trash : null,
    webRoot: null, buildId: 't',
  });
  const guarded = async () => {
    openServers.delete(guarded);
    await close();
  };
  openServers.add(guarded);
  t?.after(guarded);
  const addr = await listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const { token } = await (await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })).json();
  return { origin, token, close: guarded };
}

test('`GET /api/export` 把被删的筛掉、把条数报出来', async (t) => {
  const b = bench();
  b.trash.remove(b.idsB);
  b.trash.remove(b.idsC);
  const before = raw(b).length;
  const s = await serve(t, b);
  const r = await fetch(`${s.origin}/api/export`, {
    headers: { authorization: `Bearer ${s.token}` },
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.hiddenCount, 2);
  assert.ok(j.text.includes(T_A) && !j.text.includes(T_B), '只读口也得守住 §三');
  assert.ok(j.text.includes(trashNote(2)));
  // 只读就是只读：盘上一个字节都没动
  assert.equal(raw(b).length, before, '导出不许往盘上写东西');
  await s.close();
});

test('导出**要令牌**（那是用户自己的话，不是公开的）', async (t) => {
  const b = bench();
  const s = await serve(t, b);
  const r = await fetch(`${s.origin}/api/export`);
  assert.equal(r.status, 401);
  await s.close();
});

test('没开回收站的部署也导得出（只是没有"被删掉的那几条"要报）', async (t) => {
  const b = bench();
  const s = await serve(t, b, { withTrash: false });
  const r = await fetch(`${s.origin}/api/export`, {
    headers: { authorization: `Bearer ${s.token}` },
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.hiddenCount, 0);
  assert.ok(j.text.includes(T_A));
  await s.close();
});

test('没设口令 ⇒ 503（fail-closed，和别的受保护路由同一条规矩）', async (t) => {
  const b = bench();
  const authDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-export-ns-'));
  const auth = new Auth({ dataDir: authDir });
  const { listen, close } = createServer({
    timeline: b.timeline, store: b.store, auth,
    say: new SayService({ timeline: b.timeline, store: b.store, timelineId: 'main' }),
    trash: b.trash, webRoot: null, buildId: 't',
  });
  const guarded = async () => {
    openServers.delete(guarded);
    await close();
  };
  openServers.add(guarded);
  t.after(guarded);
  const addr = await listen(0);
  const r = await fetch(`http://127.0.0.1:${addr.port}/api/export`);
  assert.equal(r.status, 503);
});
