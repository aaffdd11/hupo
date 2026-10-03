// **读侧的同一道闸**（`D4.24` · 2026-10-03 主人点头「加」）—— 事实记录
// `docs/dev/164-READ-SIDE-HIDDEN-GATE.md`；来由是 `docs/dev/158` §五·1 那一笔
// （阶段 6 只在**写侧**加了断言，**读侧没加**）。
//
// ── 这一份钉什么（判据 ①②③ ＋ 负向对照）────────────────────
//   ① 🔴 **含隐藏路径的包 ⇒ 读被拒**，理由明确（就是 `apps.js` 那条规则的原文）
//      且**可审计**（`<world>/hupo/apps/audit.jsonl` 有一条）；
//      **负向对照**：同一个包里合法的那个文件**照旧读得出**（不是"一律拒"），
//      而且**干净包照旧 200**（真 HTTP，不是纯函数自说自话）。
//   ② 🔴 **读侧只有一处**：唯一取字节的那条路是 `Apps.read()`，隐藏路径闸就在它里面、
//      而且**跑在读第一个字节之前**（源码级扫描）。
//   ③ 🔴 **与写侧同规则**：同一个路径 `write` 拒的理由 === `read` 拒的理由
//      （两处调的是**同一个** `refuseHiddenRelPath`）；
//      **负向对照**：把路径改合法（`.data/` → `data/`）⇒ 放行。
//   ④ 租户那条路（字节在**盒子里**）：盒里的拒绝**原样带回宿主** ⇒ 制品口回的是
//      那条看得见的 403，**不是假 404**（`code='hidden-path'` 一路不过夜）。
//
// 🔴 纪律：**不碰线上、不碰真数据目录**（全部在临时目录里用真代码）。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeNet from 'node:net';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Apps, HIDDEN_PATH_CODE, isHiddenPathRefusal, rootHashOf, sha256hex } from '../src/apps.js';
import { Auth } from '../src/auth.js';
import { createAppServer, entryUrl } from '../src/app-serve.js';
import { createBoxApps } from '../src/apps-box.js';
import { createServer } from '../src/server.js';
import { AppWorkspaces } from '../src/workspace.js';

const NOW = 1_800_000_000_000;
const KEY = Buffer.from('c'.repeat(64), 'hex');
const SRC = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '../src');

const open = new Set();
after(async () => {
  for (const close of open) {
    try { await close(); } catch { /* 关不干净不影响结论 */ }
  }
  open.clear();
});
function guard(fn) {
  const g = async () => { open.delete(g); await fn(); };
  open.add(g);
  return g;
}

function tmp(tag = 'hupo-read-hidden-') {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), tag));
}

const OK = Object.freeze({
  id: 'dice', title: '掷骰子', icon: 'dice', entry: 'index.html',
  files: { 'index.html': '<!doctype html><p>掷</p>' },
});

const HIDDEN = '.data/a.json';
const HIDDEN_BODY = '{"secret":1}';

/**
 * **造一个"老包里带隐藏路径"的制品**（写侧那道闸之前写进去的那种）。
 *
 * ⚠️ 写侧 `apps.create()` **今天会拒** `.data/…` ⇒ 只能先造一个干净版本、
 *    再**手工往盘上补**（这正是"闸之前写进去的老包"在今天的形状）。
 * @returns {{dir:string, apps:Apps, manifest:object}}
 */
function plantHidden(dir, id = 'dice') {
  const fs = nodeFs;
  const apps = new Apps({ dir, sub: 'u1' });
  apps.create({ ...OK, id });
  const vdir = apps.versionDir(id, 1);
  fs.mkdirSync(nodePath.join(vdir, '.data'), { recursive: true });
  fs.writeFileSync(nodePath.join(vdir, HIDDEN), HIDDEN_BODY);
  const mpath = nodePath.join(vdir, 'manifest.json');
  fs.chmodSync(mpath, 0o644); // 版本目录里的文件是只读的（版本不可变）—— 手工补时要先放开
  const man = JSON.parse(fs.readFileSync(mpath, 'utf8'));
  man.files.push({ path: HIDDEN, sha256: sha256hex(Buffer.from(HIDDEN_BODY)), bytes: Buffer.from(HIDDEN_BODY).length });
  man.rootHash = rootHashOf(man.files.map((f) => ({ path: f.path, sha256: f.sha256 })));
  fs.writeFileSync(mpath, `${JSON.stringify(man, null, 2)}\n`);
  return { dir, apps, manifest: man };
}

/** 盘上那份的指纹（相对路径 → sha256）。 */
function treeDigest(root) {
  const out = new Map();
  const walk = (rel) => {
    let es = [];
    try { es = nodeFs.readdirSync(nodePath.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of es.sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.set(`${next}/`, 'dir'); walk(next); continue; }
      out.set(next, nodeFs.readFileSync(nodePath.join(root, next)).toString('base64'));
    }
  };
  walk('');
  return out;
}

// ════════════════════════════════════════════════════════════
// ① 隐藏路径 ⇒ 读被拒（理由明确、可审计）；负向对照：合法文件照旧读得出
// ════════════════════════════════════════════════════════════
test('① 含隐藏路径的包 ⇒ `Apps.read` 拒，理由明确且留一条审计；负向对照：干净文件照旧读得出', () => {
  const dir = tmp();
  const { apps } = plantHidden(dir);

  let err = null;
  try { apps.read('dice', 1, HIDDEN); } catch (e) { err = e; }
  assert.ok(err, '前提：隐藏路径必须被拒（不然这条判据是空的）');
  assert.equal(isHiddenPathRefusal(err), true, '拒的形状：`code = hidden-path`（制品口据此分开回）');
  assert.equal(err.code, HIDDEN_PATH_CODE);
  assert.match(err.message, /制品里不许有以 "\." 开头的文件/, '理由是人话');
  assert.ok(err.message.includes(HIDDEN), `理由里要点名那条路径：${err.message}`);

  // ── 可审计：那一行真的落进 `<world>/hupo/apps/audit.jsonl`
  const audit = nodeFs.readFileSync(nodePath.join(dir, 'hupo/apps/audit.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const hit = audit.find((l) => l.what === 'hidden-path-refused');
  assert.ok(hit, '🔴 被拒要留一条审计（否则"谁拒的、拒了什么"查不到）');
  assert.equal(hit.id, 'dice');
  assert.equal(hit.path, HIDDEN);
  assert.equal(hit.version, 1);
  assert.equal(typeof hit.at, 'number');

  // ── 负向对照：**同一个包**里合法的那个文件照旧读得出（不是"一律拒"）
  const clean = apps.read('dice', 1, 'index.html');
  assert.equal(clean.content.toString('utf8'), '<!doctype html><p>掷</p>');

  // ── 负向对照：没有隐藏路径的**另一个**包照旧读得出
  const dir2 = tmp();
  const apps2 = new Apps({ dir: dir2, sub: 'u1' });
  apps2.create({ ...OK, id: 'clean-app', files: { 'index.html': '<p>干净</p>' } });
  assert.equal(apps2.read('clean-app', 1, 'index.html').content.toString('utf8'), '<p>干净</p>');
});

// ════════════════════════════════════════════════════════════
// ③ 与写侧同规则：同一个路径，两处拒的**话逐字相同**；改合法 ⇒ 放行
// ════════════════════════════════════════════════════════════
test('③ 写侧拒的理由 === 读侧拒的理由（同一处规则）；负向对照：路径改合法 ⇒ 放行', () => {
  const dir = tmp();
  const apps = new Apps({ dir, sub: 'u1' });

  // 写侧：把带隐藏路径的包交给 `create()` ⇒ 拒
  let writeErr = null;
  try {
    apps.create({ ...OK, id: 'w', files: { 'index.html': '<p>x</p>', [HIDDEN]: HIDDEN_BODY } });
  } catch (e) { writeErr = e; }
  assert.ok(writeErr, '前提：写侧必须拒 `.data/…`（不然这条判据是空的）');

  const { apps: readApps } = plantHidden(dir, 'r');
  let readErr = null;
  try { readApps.read('r', 1, HIDDEN); } catch (e) { readErr = e; }

  assert.equal(readErr.message, writeErr.message, '🔴 两处规则不许漂：拒的话必须逐字相同（同一个函数）');
  assert.equal(readErr.code, writeErr.code);

  // ── 负向对照：把同一条路径改合法（`.data/` → `data/`）⇒ 放行
  const dir2 = tmp();
  const apps2 = new Apps({ dir: dir2, sub: 'u1' });
  apps2.create({ ...OK, id: 'legal', files: { 'index.html': '<p>ok</p>', 'data/a.json': HIDDEN_BODY } });
  assert.equal(apps2.read('legal', 1, 'data/a.json').content.toString('utf8'), HIDDEN_BODY);
});

// ════════════════════════════════════════════════════════════
// ② 读侧只有一处：唯一取字节的路 = `Apps.read()`，闸在它里面、跑在第一个字节之前
// ════════════════════════════════════════════════════════════
test('② 源码级：隐藏路径闸在**唯一取字节那条路**里，而且跑在读盘之前', () => {
  const src = nodeFs.readFileSync(nodePath.join(SRC, 'apps.js'), 'utf8');
  const at = src.indexOf('  read(id, version, rel) {');
  assert.ok(at > 0, '前提：`Apps.read()` 这个方法在（不然扫描是空的）');
  const body = src.slice(at, at + 2600);
  const gate = body.indexOf('refuseHiddenRelPath(rel);');
  assert.ok(gate > 0, '🔴 读侧那条路必须过这道闸（拔掉它 ⇒ 变异红，见 `scripts/check-read-side-assert.sh`）');
  assert.ok(
    body.indexOf('readFileSync') === -1 || gate < body.indexOf('readFileSync'),
    '🔴 闸必须跑在**读第一个字节之前**',
  );
  // 取字节那条路在本仓只有这一处（`版本目录 + rel` 的拼法只有这一处）
  const joinFetch = src.match(/nodePath\.join\(this\.versionDir\([^)]*\), rel\)/g) ?? [];
  assert.equal(joinFetch.length, 1, `🔴 "版本目录 + rel"的取字节拼法只许有一处（实测 ${joinFetch.length}）`);
});

// ════════════════════════════════════════════════════════════
// ① 真 HTTP：隐藏路径 ⇒ 403 ＋ 能查的理由（不是白屏、不是假 404）；干净包 ⇒ 200
// ════════════════════════════════════════════════════════════
async function bootOrigin(t, resolveApps) {
  const origin = createAppServer({
    resolveApps,
    key: KEY,
    frameAncestors: "'self'",
    subsOf: () => ['u1'],
    now: () => NOW,
    log: () => {},
  });
  await new Promise((res, rej) => { origin.once('error', rej); origin.listen(0, '127.0.0.1', res); });
  t.after(guard(() => new Promise((r) => origin.close(() => r()))));
  return `http://127.0.0.1:${origin.address().port}`;
}

test('① 真制品口：隐藏路径 ⇒ 403 ＋ 点名理由；负向对照：干净包 ⇒ 200', async (t) => {
  const dir = tmp();
  const { apps } = plantHidden(dir);
  const cleanDir = tmp();
  const clean = new Apps({ dir: cleanDir, sub: 'u1' });
  clean.create({ ...OK, id: 'clean-app', files: { 'index.html': '<p>干净</p>' } });

  const base = await bootOrigin(t, (sub) => (sub === 'u1' ? { read: (id, v, rel) => (id === 'clean-app' ? clean.read(id, v, rel) : apps.read(id, v, rel)) } : null));
  const good = entryUrl({ base: 'https://apps.example', key: KEY, sub: 'u1', id: 'dice', version: 1, entry: 'index.html', now: NOW });
  const q = new URL(good).searchParams;
  const sig = `e=${q.get('e')}&s=${q.get('s')}`;

  // ── ① 隐藏路径：403（**不是 404**）＋ 明确理由 ＋ 机器可分的头
  const r = await fetch(`${base}/a/dice/1/${HIDDEN}?${sig}`);
  assert.equal(r.status, 403, '🔴 读侧那道闸拒了 ⇒ 403，不是假 404、不是白屏');
  assert.equal(r.headers.get('x-hupo-refusal'), 'hidden-path', '机器也分得出来是哪一档');
  const text = await r.text();
  assert.ok(text.includes('琥珀的制品口'), '要说清**谁**拒的');
  assert.ok(text.includes(HIDDEN), '要说清拒的是**哪条路径**');
  assert.ok(text.includes('为什么'), '要说清为什么');
  assert.ok(text.includes('怎么办'), '要说清**该怎么办**');
  assert.equal(r.status === 404, false);

  // ── 负向对照：同一个 app 的干净入口 ⇒ 200（不是"一律拒"）
  const ok = await fetch(`${base}/a/dice/1/index.html?${sig}`);
  assert.equal(ok.status, 200, '负向对照：同一个包里合法的那个文件照旧 200');
  assert.equal(await ok.text(), '<!doctype html><p>掷</p>');

  // ── 负向对照：干净包 ⇒ 200
  const good2 = entryUrl({ base: 'https://apps.example', key: KEY, sub: 'u1', id: 'clean-app', version: 1, entry: 'index.html', now: NOW });
  const q2 = new URL(good2).searchParams;
  const ok2 = await fetch(`${base}/a/clean-app/1/index.html?e=${q2.get('e')}&s=${q2.get('s')}`);
  assert.equal(ok2.status, 200, '负向对照：干净包照旧 200');
});

// ════════════════════════════════════════════════════════════
// ④ 租户那条路（字节在盒子里）：拒绝**过隧道也看得见**，不是假 404
// ════════════════════════════════════════════════════════════
test('④ 租户的字节在盒子里：盒里的拒绝原样带回 ⇒ 制品口回那条看得见的 403', async (t) => {
  const boxDir = tmp();
  plantHidden(boxDir);

  // 起一台"盒子"：真的服务，只在 0600 UDS 上接内部口
  const uds = nodePath.join(tmp('hupo-readhidden-box-'), 'local-api.sock');
  const authDir = tmp('hupo-readhidden-auth-');
  const auth = new Auth({ dataDir: authDir });
  auth.setPassword('盒子里的口令');
  const worlds = { worldFor: (sub) => (sub === 'owner' ? { userId: 'owner', dir: boxDir, apps: new Apps({ dir: boxDir, sub: 'owner' }), workspaces: new AppWorkspaces({ dir: boxDir }) } : null) };
  const box = createServer({
    auth, worlds, trustedSub: 'owner', apps: { base: 'http://127.0.0.1:9', key: KEY },
    now: () => NOW, webRoot: null, buildId: 'read-hidden-box', log: () => {},
  });
  t.after(guard(box.close));
  await box.listen(0);
  await box.listenTrusted(uds);

  const boxApps = createBoxApps({ sub: 'u1', dial: () => nodeNet.connect(uds) });
  const base = await bootOrigin(t, () => boxApps);

  const good = entryUrl({ base: 'https://apps.example', key: KEY, sub: 'u1', id: 'dice', version: 1, entry: 'index.html', now: NOW });
  const q = new URL(good).searchParams;
  const r = await fetch(`${base}/a/dice/1/${HIDDEN}?e=${q.get('e')}&s=${q.get('s')}`);
  assert.equal(r.status, 403, '🔴 租户那条路也必须是"看得见的 403"，不许退回假 404');
  assert.equal(r.headers.get('x-hupo-refusal'), 'hidden-path');
  const text = await r.text();
  assert.ok(text.includes(HIDDEN), '理由里要有那条路径（盒里那条规则的原话带回宿主）');
  assert.ok(text.includes('制品口') || text.includes('为什么'));
});

// ════════════════════════════════════════════════════════════
// ④ 零残留提醒：判据本身**不许动别人的东西**（这一份读的时候不改盘）
// ════════════════════════════════════════════════════════════
test('④ 读（含被拒的那一次）不改制品的字节：跑前跑后逐文件指纹一致', () => {
  const dir = tmp();
  const { apps } = plantHidden(dir);
  const before = treeDigest(dir);
  try { apps.read('dice', 1, HIDDEN); } catch { /* 预期 */ }
  apps.read('dice', 1, 'index.html');
  const after0 = treeDigest(dir);
  // 审计是**追加**的（`audit.jsonl` 会变），其余逐字节一致
  const keys = new Set([...before.keys(), ...after0.keys()]);
  for (const k of keys) {
    if (k === 'hupo/apps/audit.jsonl') continue;
    assert.equal(after0.get(k), before.get(k), `读不许改盘：( ${k} )`);
  }
});
