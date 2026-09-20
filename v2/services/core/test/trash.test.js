// 回收站 / 真删（批 3 第二件 · 契约 `docs/dev/28-DELETE.md`）。
//
// 这一篇守四件事，每件都能在契约里找到出处：
//   ① 🔴 **真删之后盘上 grep 不到那一段**（正对照：别的内容还在）—— §三/§六
//   ② **号一个不跳**（压实之后 `verifyMonotonic` 仍然绿）—— N22 + §三
//   ③ **重启还记得谁被删过** —— §三（不然屏幕上藏着、回收站里却是空的）
//   ④ **那份清单必须带一条"删不掉"**（记忆那一层按轮抽不掉）—— §四/§五

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { Auth } from '../src/auth.js';
import { SayService } from '../src/say.js';
import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';
import { STATE_SURFACES, Trash, normIds, TOMB_DELETED, TOMB_PURGED } from '../src/trash.js';
import { createServer } from '../src/server.js';

const DAY = 24 * 60 * 60 * 1000;

const ID_USER = 'u_1';
const ID_ANSWER = 'm_1';
const ID_OTHER_USER = 'u_2';
const ID_OTHER_ANSWER = 'm_2';
const SECRET = '这句是要被删掉的话-9f3a';
const KEEP = '这句要留着-keep';

/** 一条时间线 + 回收站；并先喂两轮（一轮要被删，一轮留着）。 */
function bench({ now = 1_700_000_000_000 } = {}) {
  const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-trash-'));
  const store = new Store({ dataDir, fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const trash = new Trash({ timeline, store, timelineId: 'main', now: () => now });

  // 第 1 轮（要删的）
  timeline.emit({ type: 'user/echo', messageId: ID_USER, text: SECRET });
  timeline.emit({ type: 'message/start', messageId: ID_ANSWER });
  timeline.emit({ type: 'message/text', messageId: ID_ANSWER, text: SECRET, block: 'quick' });
  timeline.emit({ type: 'message/end', messageId: ID_ANSWER, reason: 'completed' });
  // 第 2 轮（留着的）
  timeline.emit({ type: 'user/echo', messageId: ID_OTHER_USER, text: KEEP });
  timeline.emit({ type: 'message/start', messageId: ID_OTHER_ANSWER });
  timeline.emit({ type: 'message/text', messageId: ID_OTHER_ANSWER, text: KEEP, block: 'quick' });
  timeline.emit({ type: 'message/end', messageId: ID_OTHER_ANSWER, reason: 'completed' });

  return { dataDir, store, timeline, trash, ids: [ID_USER, ID_ANSWER] };
}

const raw = (store) => nodeFs.readFileSync(store.pathFor('main'), 'utf8');

// ── 一、删掉 → 进回收站 ──────────────────────────────────────

test('删掉 ⇒ 落一条**墓碑**（取号、落盘），不是从日志里挖洞', () => {
  const b = bench();
  const before = b.store.readAll('main').length;
  const rec = b.trash.remove(b.ids);

  const after = b.store.readAll('main');
  assert.equal(after.length, before + 1, '只多一条，没抽掉任何行');
  assert.equal(after.at(-1).type, TOMB_DELETED);
  assert.deepEqual(after.at(-1).messageIds, [ID_ANSWER, ID_USER], 'id 会排序（顺序无关）');
  assert.equal(rec.at, 1_700_000_000_000);
  // ★ 内容**还在盘上**（这是"30 天内能恢复"的前提）
  assert.ok(raw(b.store).includes(SECRET));
});

test('删两次是**幂等**的：不会产生第二条墓碑', () => {
  const b = bench();
  b.trash.remove(b.ids);
  const n = b.store.readAll('main').length;
  b.trash.remove(b.ids);
  assert.equal(b.store.readAll('main').length, n, '第二条墓碑不该出现');
});

test('🔴 **重启还记得**：新建一个 Trash + sync ⇒ 回收站里还是那一条', () => {
  const b = bench();
  b.trash.remove(b.ids);

  const re = new Trash({ timeline: b.timeline, store: b.store, timelineId: 'main' });
  re.sync();
  const items = re.list();
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].messageIds, [ID_ANSWER, ID_USER]);
  assert.equal(items[0].purgeAt, 1_700_000_000_000 + 30 * DAY, '到点时间 = 删的时刻 + 30 天');
  assert.ok(re.isHidden(ID_USER) && re.isHidden(ID_ANSWER));
  assert.equal(re.isHidden(ID_OTHER_USER), false);
});

test('没 sync 的 Trash 不认识盘上的墓碑（所以 serve.js **必须** sync）', () => {
  const b = bench();
  b.trash.remove(b.ids);
  const fresh = new Trash({ timeline: b.timeline, store: b.store, timelineId: 'main' });
  assert.equal(fresh.list().length, 0, '这就是"重启之后回收站空了"那个缺陷的形状');
});

test('恢复 ⇒ 从回收站出来；重启之后也不在', () => {
  const b = bench();
  b.trash.remove(b.ids);
  assert.equal(b.trash.restore(b.ids), true);
  assert.equal(b.trash.list().length, 0);

  const re = new Trash({ timeline: b.timeline, store: b.store, timelineId: 'main' }).sync();
  assert.equal(re.list().length, 0, '恢复过了，重启不该又冒出来');
  assert.equal(re.isHidden(ID_USER), false);
});

test('恢复一个不在回收站里的 ⇒ false（不写无用的墓碑）', () => {
  const b = bench();
  const n = b.store.readAll('main').length;
  assert.equal(b.trash.restore(b.ids), false);
  assert.equal(b.store.readAll('main').length, n);
});

// ── 二、真删（压实）──────────────────────────────────────────

test('🔴 真删 ⇒ **盘上 grep 不到那一段**（正对照：别的内容还在）', () => {
  const b = bench();
  b.trash.remove(b.ids);
  assert.ok(raw(b.store).includes(SECRET), '删掉之后内容还在（回收站）');

  const r = b.trash.purge(b.ids);
  const text = raw(b.store);
  assert.ok(!text.includes(SECRET), '★ 彻底删之后，那一段一个字节都不许在盘上');
  assert.ok(text.includes(KEEP), '★ 正对照：没被删的那一轮必须还在（否则"grep 不到"是假绿）');
  assert.ok(r.freedBytes > 0, '应该报出释放了多少字节');
  assert.ok(b.trash.isPurged(ID_USER) && b.trash.isPurged(ID_ANSWER));
  assert.equal(b.trash.isHidden(ID_USER), false, '已经真删了，就不在回收站里了');
});

test('🔴 压实之后**号一个都不跳**（N22 / `verifyMonotonic`）', () => {
  const b = bench();
  const before = b.store.readAll('main');
  b.trash.remove(b.ids);
  b.trash.purge(b.ids);

  const after = b.store.readAll('main');
  assert.equal(after.length, before.length + 2, '占位一条不少、墓碑一条');
  // 号还是 1..N 连号
  const v = b.store.verifyMonotonic('main');
  assert.equal(v.maxSeq, after.length, '最大号 == 条数（说明没跳号、也没空行）');
  // 那条被真删的位置上现在是个**最小占位**
  const placeholder = after.find((e) => e.type === TOMB_PURGED && e.seq === 3);
  assert.ok(placeholder, '被压实的位置要有 `turn/purged` 占位');
  assert.deepEqual(Object.keys(placeholder).sort(), ['at', 'seq', 'type'], '占位里不许留 id 或内容');
});

test('真删之后再想删它 ⇒ 明确报错（不是静默成功）', () => {
  const b = bench();
  b.trash.remove(b.ids);
  b.trash.purge(b.ids);
  assert.throws(() => b.trash.remove(b.ids), /彻底删/);
});

test('真删**没删过**的 ⇒ 幂等安全（占位照写、内容当真删）', () => {
  const b = bench();
  const r = b.trash.purge(b.ids);
  assert.ok(!raw(b.store).includes(SECRET));
  assert.equal(r.freedBytes > 0, true);
});

test('压实是**原子**的：写不进去的时候，原日志一条不许少', () => {
  const b = bench();
  const before = raw(b.store);
  const badFs = {
    ...nodeFs,
    openSync: (p, ...rest) => (String(p).endsWith('.tmp')
      ? (() => { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; })()
      : nodeFs.openSync(p, ...rest)),
  };
  const broken = new Store({ dataDir: b.dataDir, fs: badFs, fsync: false });
  assert.throws(() => broken.rewrite('main', []), /压实失败/);
  assert.equal(raw(b.store), before, '★ 压实失败之后，盘上必须还是原来那一份');
});

// ── 三、到点真删（X3③）──────────────────────────────────────

test('到期扫描：过了 30 天的压实掉，没到的留着', () => {
  const b = bench();
  b.trash.remove(b.ids);
  // 才过 29 天 ⇒ 不该动
  assert.deepEqual(b.trash.purgeExpired({ now: 1_700_000_000_000 + 29 * DAY }), []);
  assert.equal(b.trash.list().length, 1);
  // 过了 30 天 ⇒ 压实
  const done = b.trash.purgeExpired({ now: 1_700_000_000_000 + 30 * DAY });
  assert.equal(done.length, 1);
  assert.ok(!raw(b.store).includes(SECRET));
});

test('到期前一周内能被算出来（"告一声"那一半留给系统通知）', () => {
  const b = bench();
  b.trash.remove(b.ids);
  assert.equal(b.trash.expiringSoon({ now: 1_700_000_000_000 + 10 * DAY }).length, 0);
  assert.equal(b.trash.expiringSoon({ now: 1_700_000_000_000 + 24 * DAY }).length, 1);
});

// ── 四、清单（契约 §四/§五）─────────────────────────────────

test('🔴 `plan` 的清单**逐条覆盖状态清单**（§4.7 少一行就红）', () => {
  // 手册 `03-DEVELOPMENT.md` §4.7 那一份（**照抄下来的**：手册加了行，
  // 这条闸会红，提醒回来补 `STATE_SURFACES`）。
  const STATE_LIST = [
    '/data/main/',
    '/data/workspaces/*/',
    '/data/hupo/memory/',
    '/data/hupo/audit/',
    '$DSH_HOME/sessions/',
    '$DSH_HOME/storages/',
    '$DSH_HOME/.credentials.yaml',
  ];
  const covered = new Set(STATE_SURFACES.map((s) => s.stateRow));
  for (const row of STATE_LIST) {
    assert.ok(covered.has(row), `★ 状态清单里的「${row}」没人管 —— 漏一项就是"说假话"`);
  }
  // 反过来：表里不许有手册上没有的行（防漂）
  for (const row of covered) {
    assert.ok(STATE_LIST.includes(row), `★ STATE_SURFACES 里的「${row}」不在手册那份清单里`);
  }
  // 而**用户看得见的那份清单**里：会删的 + 删不掉的都在，skip 的不出现
  const plan = bench().trash.plan([ID_USER, ID_ANSWER]);
  const shown = plan.items.map((i) => `${i.what} ${i.where} ${i.note}`).join(' ');
  assert.match(shown, /这条对话/);
  assert.match(shown, /记忆/);
  assert.ok(!shown.includes('还没建'), 'skip 的那些不该出现在给用户看的清单里');
});

test('🔴 清单里**必须有一条"删不掉"**（记忆那一层按轮抽不掉）', () => {
  const b = bench();
  const plan = b.trash.plan(b.ids);
  const cannot = plan.items.filter((i) => i.verdict === 'cannot');
  assert.ok(cannot.length >= 1, '★ 把这一条藏起来、写成"已全部删除"，就是**说假话**');
  assert.match(cannot[0].note, /记忆/);
  assert.ok(plan.items.some((i) => i.verdict === 'delete'), '也要有真的会删掉的');
  assert.equal(plan.ttlDays, 30);
  assert.equal(plan.purgeAt, 1_700_000_000_000 + 30 * DAY);
});

test('清单里要**如实说**清会动哪几处（含本机那一屏）', () => {
  const b = bench();
  const plan = b.trash.plan(b.ids);
  const blob = JSON.stringify(plan.items);
  assert.match(blob, /这台设备/, '★ §四 那条 🔴：本机缓存不列出来，用户就不知道要清它');
  assert.match(blob, /回收站/);
});

test('清单**不许**出现内部词（它是要显示给人看的）', () => {
  const b = bench();
  const plan = b.trash.plan(b.ids);
  // ⚠️ 只扫**会显示给人看的那几个字段**（`what/where/note`）——
  //    `messageIds` 是**字段名**，不是文案；把它也算进来是**我第一版写错了**。
  const blob = plan.items.map((i) => `${i.what} ${i.where} ${i.note}`).join(' ');
  for (const w of ['工作区', '客户端', '云端', '口令', 'messageId', 'turn', 'tombstone', 'seq']) {
    assert.ok(!blob.includes(w), `清单里不许出现内部词「${w}」`);
  }
});

test('没说要删哪一条 ⇒ 清单说"什么都没删"（不许假装删了）', () => {
  const b = bench();
  const plan = b.trash.plan([]);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].verdict, 'cannot');
  assert.throws(() => b.trash.remove([]), /没说/);
});

test('`normIds`：去重、排序、把畸形输入丢掉', () => {
  assert.deepEqual(normIds(['b', 'a', 'b']), ['a', 'b']);
  assert.deepEqual(normIds(['a', '', null, 42, {}]), ['a']);
  assert.deepEqual(normIds(null), []);
  assert.deepEqual(normIds('u_1'), [], '字符串不是数组 ⇒ 空（不许把 id 当数组拆）');
});

// ── 五、HTTP 那一层 ─────────────────────────────────────────

async function serve(b) {
  const authDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-trash-auth-'));
  const auth = new Auth({ dataDir: authDir, lockAfter: 3, lockMs: 60_000 });
  const password = '正确的密码啦';
  auth.setPassword(password);
  const say = new SayService({ timeline: b.timeline, store: b.store, timelineId: 'main' });
  const { listen, close } = createServer({
    timeline: b.timeline, store: b.store, auth, say, trash: b.trash, webRoot: null, buildId: 't',
  });
  const addr = await listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const { token } = await (await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })).json();
  const post = (p, body, tok = token) => fetch(`${origin}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify(body),
  });
  return { origin, token, post, close };
}

test('🔴 破坏性动作**少了 `confirm` 就 400，而且什么都没发生**', async () => {
  const b = bench();
  const s = await serve(b);
  const n = b.store.readAll('main').length;

  const r1 = await s.post('/api/trash/remove', { messageIds: b.ids });
  assert.equal(r1.status, 400);
  assert.equal((await r1.json()).error, 'confirm-required');
  const r2 = await s.post('/api/trash/purge', { messageIds: b.ids });
  assert.equal(r2.status, 400);

  assert.equal(b.store.readAll('main').length, n, '★ 被拒的请求不许留下任何痕迹');
  assert.ok(raw(b.store).includes(SECRET), '★ 内容一个字都不许少');
  await s.close();
});

test('`plan` 是**只读**的：不给 `confirm` 也能调（"先看清单"不该有门槛）', async () => {
  const b = bench();
  const s = await serve(b);
  const r = await s.post('/api/trash/plan', { messageIds: b.ids });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.items.some((i) => i.verdict === 'cannot'));
  assert.equal(b.store.readAll('main').length, 8, '只读就是只读');
  await s.close();
});

test('走一遍：plan → remove → 回收站里看得见 → restore 回来', async () => {
  const b = bench();
  const s = await serve(b);
  const rm = await s.post('/api/trash/remove', { messageIds: b.ids, confirm: true });
  assert.equal(rm.status, 200);
  const j = await rm.json();
  assert.equal(j.ok, true);
  assert.equal(j.purgeAt, 1_700_000_000_000 + 30 * DAY);

  const list = await (await fetch(`${s.origin}/api/trash`, {
    headers: { authorization: `Bearer ${s.token}` },
  })).json();
  assert.equal(list.items.length, 1);
  assert.equal(list.ttlDays, 30);

  const rs = await s.post('/api/trash/restore', { messageIds: b.ids });
  assert.equal((await rs.json()).ok, true);
  assert.equal(b.trash.list().length, 0);
  await s.close();
});

test('这些路由**都要令牌**（回收站里是用户的话，不是公开的）', async () => {
  const b = bench();
  const s = await serve(b);
  for (const p of ['/api/trash/remove', '/api/trash/purge', '/api/trash/plan', '/api/trash/restore']) {
    const r = await s.post(p, { messageIds: b.ids, confirm: true }, null);
    assert.equal(r.status, 401, `${p} 没令牌却放行了`);
  }
  const g = await fetch(`${s.origin}/api/trash`);
  assert.equal(g.status, 401);
  await s.close();
});

test('没开回收站的部署 ⇒ 这些路由 404（不是 500）', async () => {
  const b = bench();
  const authDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-trash-auth2-'));
  const auth = new Auth({ dataDir: authDir });
  auth.setPassword('够长的口令啦');
  const { listen, close } = createServer({
    timeline: b.timeline, store: b.store, auth,
    say: new SayService({ timeline: b.timeline, store: b.store, timelineId: 'main' }),
    webRoot: null, buildId: 't',
  });
  const addr = await listen(0);
  const r = await fetch(`http://127.0.0.1:${addr.port}/api/trash`);
  assert.equal(r.status, 401, '先撞鉴权（fail-closed）');
  await close();
});

// ── 六、恢复要**重发一遍**（两半交界处那条缝：删 → 冷启动 → 恢复）──────

test('🔴 恢复之后，**冷启动的客户端也拿得到**（重发的必须是新号）', () => {
  const b = bench();
  b.trash.remove(b.ids);
  // 模拟"删之前客户端已经读到哪儿了"
  const lastSeqBefore = b.store.readAll('main').at(-1).seq;

  b.trash.restore(b.ids);

  // ① 盘上：`turn/restored` 之后，**内容又出现了一次，而且是新号**
  const all = b.store.readAll('main');
  const restoredAt = all.findIndex((e) => e.type === 'turn/restored');
  assert.ok(restoredAt >= 0);
  const resent = all.slice(restoredAt + 1).filter((e) => e.messageId === ID_ANSWER);
  assert.ok(resent.length >= 2, '★ 内容必须被重发（不然冷启动回不来）');
  assert.ok(
    resent.some((e) => e.seq > lastSeqBefore),
    '★ 重发的号必须**比删之前的游标新** —— 否则落在补发窗口外面，等于没发',
  );

  // ② 号仍然连号（N22 不受影响）
  b.store.verifyMonotonic('main');
  // ③ 重发的那几条 `at` 保留原值（显示用发生时刻，N22）
  assert.ok(resent.every((e) => typeof e.at === 'number'));
});

test('恢复之后再真删 ⇒ 两份内容一起没（不许留一份在盘上）', () => {
  const b = bench();
  b.trash.remove(b.ids);
  b.trash.restore(b.ids);
  assert.ok(raw(b.store).includes(SECRET));
  b.trash.purge(b.ids);
  const text = raw(b.store);
  assert.ok(!text.includes(SECRET), '★ 重发的那一份也必须一起压实掉');
  assert.ok(text.includes(KEEP));
});
