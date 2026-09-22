// **`GET /api/apps` 那条路由**（乙-1 · 契约 `docs/dev/59-USER-APPS.md`）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   ① 🔴 **只有当前用户可见**：拿甲的令牌，清单里**绝不会有乙的制品**（负向对照）
//   ② 🔴 **身份只从令牌来**：URL / body / 头里报谁都不算数
//   ③ **入口 URL 是现签的**：绑人、绑版本、**有到期**；拿着它为别人取 ⇒ 取不到
//   ④ 没开这条路（没给 `apps`）⇒ 404，而不是"返回一个空清单"（**不说假话**）
//   ⑤ 坏制品不炸清单（跳过那一条，别的还在）

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test, { after } from 'node:test';

import { Apps } from '../src/apps.js';
import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { verifyEntry } from '../src/app-serve.js';

const open = new Set();
after(async () => {
  for (const s of open) {
    try { await s.close(); } catch { /* 关不干净不影响结论 */ }
  }
  open.clear();
});

const NOW = 1_800_000_000_000;
const KEY = Buffer.from('a'.repeat(64), 'hex');

/** 一个假的"按人取世界"：只给那两个人的那一格。 */
function makeWorlds(dirs) {
  const worlds = new Map();
  for (const [sub, dir] of Object.entries(dirs)) {
    worlds.set(sub, { userId: sub, dir, apps: new Apps({ dir, sub }) });
  }
  return { worldFor: (sub) => worlds.get(sub) ?? null };
}

async function boot(t, { dirs, apps = { base: 'http://127.0.0.1:9999', key: KEY } } = {}) {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-apps-route-'));
  const auth = new Auth({ dataDir: dir, now: () => NOW });
  auth.setPassword('测试用的口令');
  const built = { ...dirs };
  const { listen, close } = createServer({
    auth,
    worlds: makeWorlds(built),
    apps,
    now: () => NOW,
    webRoot: null,
    buildId: 'apps-route-test',
    log: () => {},
  });
  const guarded = async () => { open.delete(guarded); await close(); };
  open.add(guarded);
  t?.after(guarded);
  const addr = await listen(0);
  return { origin: `http://127.0.0.1:${addr.port}`, auth, worlds: makeWorlds(built) };
}

const list = (origin, token) =>
  fetch(`${origin}/api/apps`, { headers: { authorization: `Bearer ${token}` } });

function tmp() {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-apps-dir-'));
}

const OK = Object.freeze({
  id: 'dice', title: '掷骰子', icon: 'dice', entry: 'index.html',
  files: { 'index.html': '<!doctype html><p>掷</p>' },
});

test('🔴 只有当前用户可见：甲的清单里绝不会有乙的制品（负向对照）', async (t) => {
  const dirA = tmp();
  const dirB = tmp();
  const a = new Apps({ dir: dirA, sub: 'u1' });
  a.create({ ...OK, id: 'mia', title: '甲的' });
  const b = new Apps({ dir: dirB, sub: 'u2' });
  b.create({ ...OK, id: 'bob', title: '乙的' });

  const s = await boot(t, { dirs: { u1: dirA, u2: dirB } });
  const tokenA = s.auth.issue({ sub: 'u1' }).token;
  const tokenB = s.auth.issue({ sub: 'u2' }).token;

  const ja = await (await list(s.origin, tokenA)).json();
  const jb = await (await list(s.origin, tokenB)).json();
  assert.deepEqual(ja.apps.map((x) => x.id), ['mia']);
  assert.deepEqual(jb.apps.map((x) => x.id), ['bob']);
  assert.equal(ja.apps.some((x) => x.id === 'bob'), false, '★ 甲不许看见乙的制品');
});

test('🔴 入口 URL 是现签的：绑人 + 绑版本 + 有到期；拿去给别人取也过不了签名', async (t) => {
  const dirA = tmp();
  new Apps({ dir: dirA, sub: 'u1' }).create({ ...OK });
  const s = await boot(t, { dirs: { u1: dirA } });
  const token = s.auth.issue({ sub: 'u1' }).token;
  const j = await (await list(s.origin, token)).json();
  const one = j.apps[0];
  assert.match(one.entryUrl, /^http:\/\/127\.0\.0\.1:9999\/a\/dice\/1\/index\.html\?/);
  assert.equal(one.expiresAt > NOW, true, '要有一个到期时间');

  const url = new URL(one.entryUrl);
  const exp = url.searchParams.get('e');
  const sig = url.searchParams.get('s');
  // 这条签名是给甲的
  assert.equal(verifyEntry({ key: KEY, sig, sub: 'u1', id: 'dice', version: 1, exp, now: NOW }), true);
  // 换成乙 ⇒ 同一串签名过不了（绑人）
  assert.equal(verifyEntry({ key: KEY, sig, sub: 'u2', id: 'dice', version: 1, exp, now: NOW }), false);
  // 换个版本 ⇒ 也过不了（绑版本）
  assert.equal(verifyEntry({ key: KEY, sig, sub: 'u1', id: 'dice', version: 2, exp, now: NOW }), false);
});

test('没开这条路 ⇒ 404（不是"返回一个空清单"）', async (t) => {
  const dirA = tmp();
  new Apps({ dir: dirA, sub: 'u1' }).create({ ...OK });
  const s = await boot(t, { dirs: { u1: dirA }, apps: null });
  const token = s.auth.issue({ sub: 'u1' }).token;
  assert.equal((await list(s.origin, token)).status, 404);
});

test('坏制品不炸整个清单（跳过那一条）', async (t) => {
  const dirA = tmp();
  const a = new Apps({ dir: dirA, sub: 'u1' });
  a.create({ ...OK, id: 'good', title: '好的' });
  a.create({ ...OK, id: 'broken', title: '坏的' });
  const mf = nodePath.join(a.versionDir('broken', 1), 'manifest.json');
  nodeFs.chmodSync(mf, 0o644);
  nodeFs.writeFileSync(mf, '{ 不是 JSON');
  const s = await boot(t, { dirs: { u1: dirA } });
  const token = s.auth.issue({ sub: 'u1' }).token;
  const j = await (await list(s.origin, token)).json();
  assert.deepEqual(j.apps.map((x) => x.id), ['good']);
});

test('两个人都空 ⇒ 都是空清单（对照：这条路真的在答，不是没挂）', async (t) => {
  const s = await boot(t, { dirs: { u1: tmp(), u2: tmp() } });
  const token = s.auth.issue({ sub: 'u1' }).token;
  const r = await list(s.origin, token);
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).apps, []);
});
