// **一个小程序一个独立的 SQLite**（主人 2026-09-30 拍板 · 契约 `docs/dev/147-APP-SQLITE.md`）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   · **D1 三条动作真的能跑**：建表 / 写 / 读回来（**真** `node:sqlite`，不是假的）；
//   · **D2 跨 app 那条路是堵死的**：`ATTACH` / `DETACH` **两种写法都拒**
//     （文本守卫一道、`setAuthorizer` 一道）；
//   · **D3 一条 SQL 卡不死服务**：失控查询到点被 **`SIGKILL`**，而且**杀完库还能用**
//     （这是"子进程而不是 worker"那条结论的判据 —— `worker.terminate()` 拦不住它）；
//   · **D4 上限是真的**：字节上限（`max_page_count` ⇒ "存储满了"）、行数截断**如实说**、
//     结果太大如实拒、频率闸 429；
//   · **D5 三道闸**：制品**没声明** 403 · 看的人**没允许** 403 · 语句不合规 400；
//   · **D6 两端同一个凭据**：入口签名换票、票绑 app、过期不算、篡改不算；
//   · **D7 那条口只在 `/db` 上**（别的 POST 照旧 405）、跨源预检答得上、
//     制品 CSP 从 `connect-src 'none'` 变成 **`connect-src 'self'`**（两端一致的地基）。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeHttp from 'node:http';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import test from 'node:test';

import {
  DB_FULL_TEXT,
  DB_MAX_ROWS,
  DB_TIMEOUT_TEXT,
  DB_TOO_BIG_TEXT,
  DB_TOO_MANY_TEXT,
  DB_NOT_GRANTED_TEXT,
  DB_DECLARED_TEXT,
  checkAppDb,
  guardParams,
  guardSql,
  mintTicket,
  runDbChild,
  verifyTicket,
} from '../src/app-db.js';
import { Apps } from '../src/apps.js';
import { createAppServer, cspFor, entryUrl } from '../src/app-serve.js';

const KEY = Buffer.from('d'.repeat(64), 'hex');
const NOW = 1_800_000_000_000;

function tmpdir() {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-appdb-'));
}

// ── D1 · 语言那一层（纯函数，不碰盘）────────────────────────────

test('D1 守卫：一次只许一条，引号与注释里的分号不算', () => {
  assert.equal(guardSql('SELECT 1').ok, true);
  assert.equal(guardSql('SELECT 1;').ok, true, '结尾那个分号可以有');
  // 🔴 反例：两条语句（这是"一条 SQL 干两件事"的入口）
  assert.equal(guardSql('SELECT 1; DROP TABLE t').ok, false);
  // 🔴 字符串里的分号**不许**被误伤
  assert.equal(guardSql("INSERT INTO t VALUES ('a;b')").ok, true);
  // 🔴 注释里的分号也不许
  assert.equal(guardSql('SELECT 1 -- a;b\n').ok, true);
  assert.equal(guardSql('SELECT /* a;b */ 1').ok, true);
  // 空 / 太长 / 不是字符串
  assert.equal(guardSql('   ').ok, false);
  assert.equal(guardSql('SELECT 1'.repeat(2000)).ok, false);
  assert.equal(guardSql(123).ok, false);
  // 引号没闭合 ⇒ 认不出来 ⇒ 拒（不猜）
  assert.equal(guardSql("SELECT 'abc").ok, false);
});

test('D1 守卫：跨库与危险关键字当场拒（词边界，不误伤列名）', () => {
  for (const bad of [
    "ATTACH DATABASE '/tmp/x.sqlite' AS o",
    "attach database 'x' as y",
    'DETACH DATABASE o',
    'VACUUM',
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    'load_extension("x")',
    'SELECT readfile("/etc/passwd")',
  ]) {
    assert.equal(guardSql(bad).ok, false, `该拒：${bad}`);
  }
  // 🔴 反例：`attachment` 这种列名不许被误伤（用词边界，不用 includes）
  assert.equal(guardSql('SELECT attachment FROM t').ok, true);
});

test('D1 参数只认 null / 字符串 / 数字 / 布尔（认不出来就拒，不悄悄转）', () => {
  assert.deepEqual(guardParams([null, 'a', 1, 2.5, true, false]), {
    ok: true,
    params: [null, 'a', 1, 2.5, true, false],
  });
  assert.deepEqual(guardParams(undefined), { ok: true, params: [] });
  for (const bad of [[{}], [[]], [() => {}], [NaN], [Infinity], [Buffer.from('x')], 'not-array']) {
    assert.equal(guardParams(bad).ok, false, `该拒：${String(bad)}`);
  }
});

test('D5 三道闸：没声明 403 · 没允许 403 · 动作/语句不认 400', () => {
  const base = { declared: true, granted: true, op: 'all', sql: 'SELECT 1', params: [] };
  assert.equal(checkAppDb(base).ok, true);
  const d = checkAppDb({ ...base, declared: false });
  assert.deepEqual([d.ok, d.status, d.text], [false, 403, DB_DECLARED_TEXT]);
  const g = checkAppDb({ ...base, granted: false });
  assert.deepEqual([g.ok, g.status, g.text], [false, 403, DB_NOT_GRANTED_TEXT]);
  assert.equal(checkAppDb({ ...base, op: 'drop' }).status, 400);
  assert.equal(checkAppDb({ ...base, sql: 'SELECT 1; SELECT 2' }).status, 400);
  // 声明与授予**都**要（缺一个就拒）—— 顺序：先声明后授予
  assert.equal(checkAppDb({ declared: false, granted: false, op: 'all', sql: 'SELECT 1' }).error, 'not-declared');
});

// ── D2 / D3 / D4 · 真库那几条（每条都开一次真子进程）──────────────

test('D1 真库：建表 → 写 → 读回来（参数绑定）', async () => {
  const dir = tmpdir();
  const file = nodePath.join(dir, 'data.sqlite');
  const r1 = await runDbChild({ file, op: 'run', sql: 'CREATE TABLE t(a TEXT, b INTEGER)' });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const r2 = await runDbChild({ file, op: 'run', sql: 'INSERT INTO t VALUES (?, ?)', params: ['甲', 7] });
  assert.equal(r2.ok, true);
  assert.equal(r2.changes, 1);
  const r3 = await runDbChild({ file, op: 'all', sql: 'SELECT a, b FROM t' });
  assert.deepEqual(r3.rows, [{ a: '甲', b: 7 }]);
  // 库真的落在那个文件上（不是内存里）
  assert.equal(nodeFs.existsSync(file), true);
  assert.ok(nodeFs.statSync(file).size > 0);
  nodeFs.rmSync(dir, { recursive: true, force: true });
});

test('D2 跨库那条路堵死：ATTACH / DETACH 两道都拒（文本一道 + authorizer 一道）', async () => {
  const dir = tmpdir();
  const file = nodePath.join(dir, 'data.sqlite');
  await runDbChild({ file, op: 'run', sql: 'CREATE TABLE t(a TEXT)' });
  // ① 文本守卫那一道
  const g = guardSql("ATTACH DATABASE '/etc/passwd' AS o");
  assert.equal(g.ok, false);
  // ② authorizer 那一道（**绕过守卫也过不去**：这里直接调 runDbChild，
  //    它不做文本守卫 ⇒ 验的正是"最后那道防线"）
  const r = await runDbChild({ file, op: 'all', sql: 'SELECT 1', params: [] });
  assert.equal(r.ok, true, '正常语句要能跑（对照组）');
  const att = await runDbChild({ file, op: 'run', sql: "ATTACH DATABASE '/tmp/nope.sqlite' AS o" });
  assert.equal(att.ok, false, 'ATTACH 必须被拒');
  // PRAGMA 只放行 user_version（迁移要用），别的拒
  const uv = await runDbChild({ file, op: 'get', sql: 'PRAGMA user_version' });
  assert.equal(uv.ok, true, 'user_version 要放行');
  // 🔴 **而且它要能写**（§三 那条迁移约定靠的就是这个）：写 3、读回来还是 3
  const uvSet = await runDbChild({ file, op: 'run', sql: 'PRAGMA user_version = 3' });
  assert.equal(uvSet.ok, true, JSON.stringify(uvSet));
  const uvBack = await runDbChild({ file, op: 'get', sql: 'PRAGMA user_version' });
  assert.equal(uvBack.rows[0].user_version, 3, '迁移版本要真的存住了');
  const jm = await runDbChild({ file, op: 'get', sql: 'PRAGMA journal_mode', maxBytes: 1 });
  assert.equal(jm.ok, false, '别的 PRAGMA 要拒');
  nodeFs.rmSync(dir, { recursive: true, force: true });
});

test('D3 失控查询到点被 SIGKILL，而且杀完库还能用', async () => {
  const dir = tmpdir();
  const file = nodePath.join(dir, 'data.sqlite');
  await runDbChild({ file, op: 'run', sql: 'CREATE TABLE t(a INTEGER)' });
  // 塞一点行进去（一条语句写完，不用递归）
  const values = Array.from({ length: 400 }, (_, i) => `(${i})`).join(',');
  const seed = await runDbChild({ file, op: 'run', sql: `INSERT INTO t(a) VALUES ${values}` });
  assert.equal(seed.ok, true);
  // 🔴 **判据要钉住"那个进程真的死了"**，不是只钉"它回了一句超时"：
  //    上一版只验 `error === 'timeout'` ⇒ **把 kill 那一行删掉照样绿**（变异②抓到的），
  //    而那样的真实后果是：那个子进程继续烧 CPU 到天荒地老，页面却已经收到"先不查了"。
  //    ⇒ 这一版自己接住那个子进程，超时之后**去 /proc 看它还在不在**。
  const kids = [];
  const spawnRecorded = (...args) => {
    const c = nodeSpawn(...args);
    kids.push(c);
    return c;
  };
  // 四路自连接 = 400^4 = 2.56e10 次扫描 ⇒ 900ms 内跑不完
  const t0 = Date.now();
  const r = await runDbChild({
    file,
    op: 'all',
    sql: 'SELECT count(*) AS n FROM t a, t b, t c, t d',
    timeoutMs: 700,
    spawnImpl: spawnRecorded,
  });
  const spent = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timeout');
  assert.equal(r.text, DB_TIMEOUT_TEXT);
  assert.ok(spent < 3000, `到点就该停（实际 ${spent}ms）`);
  assert.equal(kids.length, 1, '这一条只该起一个子进程');
  const kid = kids[0];
  // 给它一点时间被内核收走（SIGKILL 是异步的）
  let alive = true;
  let sig = null;
  for (let i = 0; i < 40; i += 1) {
    sig = kid.signalCode;
    try {
      process.kill(kid.pid, 0);
    } catch {
      alive = false;
      break;
    }
    await new Promise((s) => setTimeout(s, 50));
  }
  assert.equal(alive, false, '🔴 到点了那个子进程必须**真的没了**（不是回一句话就算）');
  assert.equal(sig, 'SIGKILL', `要的是 SIGKILL（实际 ${sig}）`);
  // 🔴 **杀完还得能用**（热日志恢复）：这一条是"敢用 SIGKILL"的前提
  const after = await runDbChild({ file, op: 'get', sql: 'SELECT count(*) AS n FROM t' });
  assert.equal(after.ok, true, JSON.stringify(after));
  assert.equal(after.rows[0].n, 400);
  nodeFs.rmSync(dir, { recursive: true, force: true });
});

test('D4 上限是真的：字节满了说满了 · 行数截断如实说 · 结果太大如实拒', async () => {
  const dir = tmpdir();
  const file = nodePath.join(dir, 'data.sqlite');
  // ① 字节上限：只给很小的一格（8KiB），塞一条大字符串 ⇒ SQLite 自己顶回来
  await runDbChild({ file, op: 'run', sql: 'CREATE TABLE t(a TEXT)', maxBytes: 8192 });
  const big = 'x'.repeat(20_000);
  const full = await runDbChild({ file, op: 'run', sql: 'INSERT INTO t VALUES (?)', params: [big], maxBytes: 8192 });
  assert.equal(full.ok, false);
  assert.equal(full.error, 'full');
  assert.equal(full.text, DB_FULL_TEXT);
  // ② 行数截断：**截了就说截了**（不静默）
  const file2 = nodePath.join(dir, 'b.sqlite');
  await runDbChild({ file: file2, op: 'run', sql: 'CREATE TABLE t(a INTEGER)' });
  await runDbChild({ file: file2, op: 'run', sql: 'INSERT INTO t(a) VALUES (1),(2),(3)' });
  const cut = await runDbChild({ file: file2, op: 'all', sql: 'SELECT a FROM t', maxRows: 2 });
  assert.equal(cut.ok, true);
  assert.equal(cut.rows.length, 2);
  assert.equal(cut.truncated, true, '截断了必须说');
  const whole = await runDbChild({ file: file2, op: 'all', sql: 'SELECT a FROM t', maxRows: DB_MAX_ROWS });
  assert.equal(whole.truncated, false);
  // ③ 结果太大：如实拒（**不是**悄悄截一半）
  const tooBig = await runDbChild({ file: file2, op: 'all', sql: 'SELECT a FROM t', maxResultBytes: 20 });
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.error, 'too-big');
  assert.equal(tooBig.text, DB_TOO_BIG_TEXT);
  nodeFs.rmSync(dir, { recursive: true, force: true });
});

test('D1 BigInt 转成字符串（JSON 塞不进去的那种值不许把它噎死）', async () => {
  const dir = tmpdir();
  const file = nodePath.join(dir, 'data.sqlite');
  await runDbChild({ file, op: 'run', sql: 'CREATE TABLE t(a INTEGER)' });
  await runDbChild({ file, op: 'run', sql: 'INSERT INTO t VALUES (?)', params: [42] });
  const r = await runDbChild({ file, op: 'all', sql: 'SELECT a FROM t' });
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].a, 42);
  nodeFs.rmSync(dir, { recursive: true, force: true });
});

// ── D6 · 票（入口签名换票，票绑 app）────────────────────────────

test('D6 票：换来的能用 · 换了 app 不算 · 过期不算 · 改一个字符不算', () => {
  const ticket = mintTicket({ key: KEY, sub: 'u1', id: 'coin', version: 'live', now: NOW, ttlMs: 60_000 });
  const ok = verifyTicket({ key: KEY, ticket, id: 'coin', now: NOW + 1000 });
  assert.equal(ok.sub, 'u1');
  assert.equal(ok.id, 'coin');
  // 🔴 票绑的是**那一个 app**：拿它去开另一个 app 不算
  assert.equal(verifyTicket({ key: KEY, ticket, id: 'dice', now: NOW + 1000 }), null);
  // 到期不算
  assert.equal(verifyTicket({ key: KEY, ticket, id: 'coin', now: NOW + 61_000 }), null);
  // 改一个字符不算
  const tampered = `${ticket.slice(0, -1)}${ticket.endsWith('a') ? 'b' : 'a'}`;
  assert.equal(verifyTicket({ key: KEY, ticket: tampered, id: 'coin', now: NOW + 1000 }), null);
  // 换一把键不算
  assert.equal(verifyTicket({ key: Buffer.from('e'.repeat(64), 'hex'), ticket, id: 'coin', now: NOW + 1000 }), null);
  // 形状不对 ⇒ null（不抛）
  assert.equal(verifyTicket({ key: KEY, ticket: 'x', id: 'coin', now: NOW }), null);
  assert.equal(verifyTicket({ key: KEY, ticket: 123, id: 'coin', now: NOW }), null);
});

// ── D5 + 那一格库真的按人按 app 分开（`Apps` 那一层）──────────────

function makeApps(dir, sub) {
  return new Apps({ dir, sub, now: () => NOW });
}

test('D5 Apps.dbExec：没声明 403 · 声明了没允许 403 · 允许了才跑得动', async () => {
  const dir = tmpdir();
  const apps = makeApps(dir, 'u1');
  // ① 先注册一个**没声明** db 的 app
  apps.register({ id: 'coin', title: '硬币', entry: 'index.html' });
  const r1 = await apps.dbExec('coin', { op: 'run', sql: 'CREATE TABLE t(a)' });
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 403);
  assert.equal(r1.text, DB_DECLARED_TEXT);
  // ② 声明了、但主人没允许
  apps.register({ id: 'dice', title: '骰子', entry: 'index.html', permissions: ['db'] });
  const r2 = await apps.dbExec('dice', { op: 'run', sql: 'CREATE TABLE t(a)' });
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 403);
  assert.equal(r2.text, DB_NOT_GRANTED_TEXT);
  // ③ 允许了 ⇒ 跑得动；而且**第二次调用**（同一个库）读得到刚写的东西
  apps.setGrants('dice', ['db']);
  const r3 = await apps.dbExec('dice', { op: 'run', sql: 'CREATE TABLE t(a TEXT)' });
  assert.equal(r3.ok, true, JSON.stringify(r3));
  const r4 = await apps.dbExec('dice', { op: 'run', sql: 'INSERT INTO t VALUES (?)', params: ['甲'] });
  assert.equal(r4.ok, true);
  assert.equal(r4.changes, 1);
  const r5 = await apps.dbExec('dice', { op: 'all', sql: 'SELECT a FROM t' });
  assert.deepEqual(r5.rows, [{ a: '甲' }]);
  // 🔴 **撤销 ⇒ 立刻进不去**（票 / 缓存都不该让它绕过授予）
  apps.setGrants('dice', []);
  const r6 = await apps.dbExec('dice', { op: 'all', sql: 'SELECT a FROM t' });
  assert.equal(r6.ok, false);
  assert.equal(r6.text, DB_NOT_GRANTED_TEXT);
  // 🔴 **一个 app 一个文件**：两个 app 的路径不一样，而且 coin 那份**根本不存在**
  assert.notEqual(apps.dbPath('dice'), apps.dbPath('coin'));
  assert.equal(nodeFs.existsSync(apps.dbPath('coin')), false, '没跑过的那个 app 不许有库');
  assert.equal(nodeFs.existsSync(apps.dbPath('dice')), true);
  nodeFs.rmSync(dir, { recursive: true, force: true });
});

test('D5 两个 app 的库是**两个文件**：写进 A 的东西在 B 里查不到', async () => {
  const dir = tmpdir();
  const apps = makeApps(dir, 'u1');
  for (const id of ['a1', 'b1']) {
    apps.register({ id, title: id, entry: 'index.html', permissions: ['db'] });
    apps.setGrants(id, ['db']);
    await apps.dbExec(id, { op: 'run', sql: 'CREATE TABLE t(v TEXT)' });
    await apps.dbExec(id, { op: 'run', sql: 'INSERT INTO t VALUES (?)', params: [id] });
  }
  const inA = await apps.dbExec('a1', { op: 'all', sql: 'SELECT v FROM t' });
  const inB = await apps.dbExec('b1', { op: 'all', sql: 'SELECT v FROM t' });
  assert.deepEqual(inA.rows, [{ v: 'a1' }]);
  assert.deepEqual(inB.rows, [{ v: 'b1' }]);
  nodeFs.rmSync(dir, { recursive: true, force: true });
});

test('D4 频率闸：一分钟里超过那个数 ⇒ 429（拒绝也要说清是"太快了"）', async () => {
  const dir = tmpdir();
  const apps = makeApps(dir, 'u1');
  apps.register({ id: 'coin', title: '硬币', entry: 'index.html', permissions: ['db'] });
  apps.setGrants('coin', ['db']);
  // ⚠️ 不真跑 240 次子进程（那要八秒）：把这本账直接填满 —— 验的是**那一道闸**本身
  apps.dbCalls.set('coin', Array.from({ length: 240 }, () => NOW));
  const r = await apps.dbExec('coin', { op: 'all', sql: 'SELECT 1' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 429);
  assert.equal(r.text, DB_TOO_MANY_TEXT);
  // 窗口滑过去 ⇒ 又能跑了
  apps.dbCalls.set('coin', Array.from({ length: 240 }, () => NOW - 120_000));
  const r2 = await apps.dbExec('coin', { op: 'all', sql: 'SELECT 1 AS n' });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  nodeFs.rmSync(dir, { recursive: true, force: true });
});

// ── D7 · 那条 HTTP 口（真起一个 app 原点）─────────────────────────

function startAppOrigin(apps) {
  const server = createAppServer({
    resolveApps: () => apps,
    key: KEY,
    frameAncestors: 'https://w.example',
    now: () => NOW,
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function post(port, path, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': payload.length, ...headers },
      },
      (res) => {
        let out = '';
        res.on('data', (d) => {
          out += d;
        });
        res.on('end', () => {
          let j = null;
          try {
            j = JSON.parse(out);
          } catch {
            /* 非 JSON（405 那种） */
          }
          resolve({ status: res.statusCode, headers: res.headers, body: j, raw: out });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('D7 那条口：入口签名换票 ⇒ 用票继续 ⇒ 没凭据 403（回应带跨源头）', async () => {
  const dir = tmpdir();
  const apps = makeApps(dir, 'u1');
  apps.register({ id: 'coin', title: '硬币', entry: 'index.html', permissions: ['db'] });
  apps.setGrants('coin', ['db']);
  const { server, port } = await startAppOrigin(apps);
  try {
    const url = entryUrl({ base: `http://127.0.0.1:${port}`, key: KEY, sub: 'u1', id: 'coin', version: 1, entry: 'index.html', now: NOW });
    const q = new URLSearchParams(url.split('?')[1]);
    // ① 没凭据 ⇒ 403（**而且不是 500 / 不是"跑成功了"**）
    const bad = await post(port, '/db', { id: 'coin', v: '1', op: 'run', sql: 'CREATE TABLE t(a)' });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers['access-control-allow-origin'], '*', '不透明源那一侧要它');
    // ② 拿入口签名换票
    const first = await post(port, '/db', {
      id: 'coin',
      v: '1',
      u: q.get('u'),
      e: q.get('e'),
      s: q.get('s'),
      op: 'run',
      sql: 'CREATE TABLE t(a TEXT)',
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.ok, true);
    assert.equal(typeof first.body.ticket, 'string');
    // ③ 用票继续（页面开着的时候走这条）
    const second = await post(port, '/db', { id: 'coin', v: '1', ticket: first.body.ticket, op: 'run', sql: 'INSERT INTO t VALUES (?)', params: ['甲'] });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const third = await post(port, '/db', { id: 'coin', v: '1', ticket: first.body.ticket, op: 'all', sql: 'SELECT a FROM t' });
    assert.deepEqual(third.body.rows, [{ a: '甲' }]);
    // ④ 票是**这个 app 的**：换一个 id 不算（连 app 都不在 ⇒ 也是拒）
    const other = await post(port, '/db', { id: 'dice', v: '1', ticket: first.body.ticket, op: 'all', sql: 'SELECT 1' });
    assert.equal(other.status, 403);
    // ⑤ 别的 POST 照旧 405（这条口**只有 /db**）
    const elsewhere = await post(port, '/a/coin/1/index.html', {});
    assert.equal(elsewhere.status, 405);
  } finally {
    server.close();
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D7 跨源预检答得上（不透明源那一侧先问 OPTIONS）', async () => {
  const dir = tmpdir();
  const apps = makeApps(dir, 'u1');
  const { server, port } = await startAppOrigin(apps);
  try {
    const res = await new Promise((resolve, reject) => {
      const req = nodeHttp.request(
        { host: '127.0.0.1', port, path: '/db', method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'POST' } },
        (r) => {
          r.resume();
          resolve({ status: r.statusCode, headers: r.headers });
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.equal(res.headers['access-control-allow-methods'], 'POST');
  } finally {
    server.close();
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D7 制品 CSP：`connect-src` 只放**它自己那个源**（两端一致的地基）', () => {
  const csp = cspFor('https://w.example');
  assert.ok(csp.includes("connect-src 'self'"), csp);
  // 🔴 反例：**不许**退回 'none'（那这一条能力就没了），**也不许**放成 '*'（那就变成"能上任何站"）
  assert.ok(!csp.includes("connect-src 'none'"), csp);
  assert.ok(!/connect-src[^;]*\*/.test(csp), csp);
  // 别的几条一个字没动
  assert.ok(csp.includes("default-src 'none'"));
  assert.ok(csp.includes("form-action 'none'"));
  assert.ok(csp.includes("base-uri 'none'"));
  assert.ok(csp.includes('frame-ancestors https://w.example'));
});
