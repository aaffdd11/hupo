// **跟着账号走的偏好（今天只有壁纸）**（主人 2026-10-04 定：*"壁纸不要按设备存"* ·
//   契约 `docs/dev/183-WALLPAPER-ACCOUNT.md`）。
//
// ── 这一份钉什么（一句话）──────────────────────────────────
//   ① `/api/prefs` 写得进、读得回；**按人分**（甲的壁纸绝不进乙那一份）；
//   ② 🔴 **"从没记过"（`null`）与"他明确选了不设"（`''`）是两件事** ——
//      分不开的话，客户端分不清"要不要拿本机那份顶上去"；
//   ③ 🔴 **形状不对一律 400**（`../../etc/passwd` / 超长串 / 对象 ⇒ 都不许存进去）；
//   ④ 🔴 **进程重启之后还在**（落盘，不是内存里的一格）；
//   ⑤ 没令牌 ⇒ 拒（这一格是**他**的）。
//
// ⚠️ 形状照 `test/creds.test.js`：真 `createServer` ＋ 真 HTTP ＋ 真临时目录。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test, { after } from 'node:test';

import { Auth } from '../src/auth.js';
import { checkWallpaperId, prefsFileFor, readUserPrefs, writeUserPrefs } from '../src/prefs-store.js';
import { createServer } from '../src/server.js';

const NOW = 1_800_000_000_000;

const dirs = [];
function tmp() {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-prefs-'));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) {
    try {
      nodeFs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 尽力 */
    }
  }
});

/** 起一台真服务（只带 prefs 那两条口，别的都最小）。 */
async function boot(t, { dataDir = tmp() } = {}) {
  const auth = new Auth({ dataDir, now: () => NOW });
  auth.setPassword('这一份判据只用令牌');
  const s = createServer({
    auth,
    now: () => NOW,
    webRoot: null,
    log: () => {},
    prefs: {
      read: (sub) => readUserPrefs(dataDir, sub),
      write: (sub, patch) => writeUserPrefs(dataDir, sub, patch, { now: () => NOW }),
    },
  });
  t.after(() => s.close());
  const addr = await s.listen(0);
  return { dataDir, origin: `http://127.0.0.1:${addr.port}`, auth, srv: s };
}

const getPrefs = (o, token) =>
  fetch(`${o.origin}/api/prefs`, { headers: { authorization: `Bearer ${token}` } });
const postPrefs = (o, token, body) =>
  fetch(`${o.origin}/api/prefs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// ════════════════════════════════════════════════════════════
// P1 —— 纯的那两个（形状校验 · 读不到当"没记过"）
// ════════════════════════════════════════════════════════════
test('P1 `checkWallpaperId`：只认 `\'\'` 与 `wp-<数字>`；别的**一律不认**（含路径那类）', () => {
  assert.equal(checkWallpaperId(''), '', '不设 = 空串（合法的选择，不是"没记过"）');
  assert.equal(checkWallpaperId('wp-01'), 'wp-01');
  assert.equal(checkWallpaperId('wp-28'), 'wp-28');
  assert.equal(checkWallpaperId('wp-9999'), 'wp-9999', '★ 只认形状不认范围：换一包壁纸时中心不必跟着改');
  for (const bad of ['wp-', 'wp-1x', 'WP-01', 'wp-01;rm -rf /', '../../etc/passwd', 'x'.repeat(17), 7, null, undefined, {}, [], true]) {
    assert.equal(checkWallpaperId(bad), null, `★ 这个不许认：${JSON.stringify(bad)}`);
  }
});

test('P1 读：没有那一份 / 坏文件 ⇒ **`wallpaper: null`**（＝"从没记过"，不抛）', () => {
  const d = tmp();
  assert.deepEqual(readUserPrefs(d, 'u1'), { wallpaper: null, updatedAt: null }, '★ 没写过 ⇒ null');
  const f = prefsFileFor(d, 'u1');
  assert.ok(f, '前提：这个 sub 是合法的');
  nodeFs.mkdirSync(nodePath.dirname(f), { recursive: true });
  nodeFs.writeFileSync(f, '{ 这不是 JSON');
  assert.deepEqual(readUserPrefs(d, 'u1'), { wallpaper: null, updatedAt: null }, '★ 坏了也当没记过（不许抛）');
  nodeFs.writeFileSync(f, JSON.stringify({ wallpaper: 'not-a-id' }));
  assert.deepEqual(readUserPrefs(d, 'u1'), { wallpaper: null, updatedAt: null }, '★ 值认不出来 ⇒ 当没记过');
  assert.equal(prefsFileFor(d, '../evil'), null, '★ 野 sub 不许拼出路径');
});

// ════════════════════════════════════════════════════════════
// P2 —— 那两条 HTTP 口（真服务）
// ════════════════════════════════════════════════════════════
test('P2 🔴 写完读得回；`null`（没记过）与 `\'\'`（不设）**分得开**；落盘跨进程还在', async (t) => {
  const dataDir = tmp();
  const o = await boot(t, { dataDir });
  const token = o.auth.issue({ sub: 'u1' }).token;

  let r = await getPrefs(o, token);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { wallpaper: null }, '★ 一次都没写过 ⇒ null（不是空串）');

  r = await postPrefs(o, token, { wallpaper: 'wp-07' });
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { ok: true, wallpaper: 'wp-07' });

  r = await getPrefs(o, token);
  assert.deepEqual(await r.json(), { wallpaper: 'wp-07' }, '★ 写得进、读得回');

  // 他明确选了"不设" ⇒ **空串**（与上面那个 null 必须分得开）
  r = await postPrefs(o, token, { wallpaper: '' });
  assert.equal(r.status, 200);
  r = await getPrefs(o, token);
  assert.deepEqual(await r.json(), { wallpaper: '' }, '★ "他选了不设" ≠ "没记过"');

  // 🔴 **落盘**：换一台服务实例（同一个 dataDir）读，还是那一份
  await postPrefs(o, token, { wallpaper: 'wp-12' });
  const again = new (await import('../src/prefs-store.js')).readUserPrefs(dataDir, 'u1');
  assert.equal(again.wallpaper, 'wp-12', '★ 进程重启之后还在（不是内存里的一格）');
  assert.equal(again.updatedAt, NOW);
});

test('P2 🔴 按人分：甲写的那一张，乙读不到（各写一次也不互相盖）', async (t) => {
  const o = await boot(t);
  const a = o.auth.issue({ sub: 'u1' }).token;
  const b = o.auth.issue({ sub: 'u2' }).token;
  await postPrefs(o, a, { wallpaper: 'wp-03' });
  assert.deepEqual(await (await getPrefs(o, b)).json(), { wallpaper: null }, '★ 乙那格还是"没记过"');
  await postPrefs(o, b, { wallpaper: 'wp-21' });
  assert.equal((await (await getPrefs(o, a)).json()).wallpaper, 'wp-03', '★ 乙写的不许盖掉甲的');
  assert.equal((await (await getPrefs(o, b)).json()).wallpaper, 'wp-21');
});

test('P2 🔴 形状不对 ⇒ 400，而且**一个字节都不许落盘**；没令牌 ⇒ 拒', async (t) => {
  const dataDir = tmp();
  const o = await boot(t, { dataDir });
  const token = o.auth.issue({ sub: 'u1' }).token;

  for (const bad of ['../../etc/passwd', 'wp-', 'x'.repeat(40), 7, null, {}, []]) {
    const r = await postPrefs(o, token, { wallpaper: bad });
    assert.equal(r.status, 400, `★ 这个形状要拒：${JSON.stringify(bad)}`);
  }
  const miss = await postPrefs(o, token, {});
  assert.equal(miss.status, 400, '★ 连字段都没有 ⇒ 拒（不许当成"不设"）');
  assert.deepEqual(await (await getPrefs(o, token)).json(), { wallpaper: null }, '★ 拒了那么多次，那一格仍然是空的');

  const anon = await fetch(`${o.origin}/api/prefs`);
  assert.ok(anon.status === 401 || anon.status === 403, `没令牌要拒（实际 ${anon.status}）`);
  const anonPost = await fetch(`${o.origin}/api/prefs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallpaper: 'wp-01' }),
  });
  assert.ok(anonPost.status === 401 || anonPost.status === 403, '没令牌不许写');
});

test('P2 没接线（不给 prefs）⇒ 那两条口 404（F 不许假装有）', async (t) => {
  const dataDir = tmp();
  const auth = new Auth({ dataDir, now: () => NOW });
  auth.setPassword('这一份判据只用令牌');
  const s = createServer({ auth, now: () => NOW, webRoot: null, log: () => {} });
  t.after(() => s.close());
  const addr = await s.listen(0);
  const token = auth.issue({ sub: 'u1' }).token;
  const r = await fetch(`http://127.0.0.1:${addr.port}/api/prefs`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(r.status, 404, '★ 没接线就不是 200 —— 不许假装有这一格');
});
