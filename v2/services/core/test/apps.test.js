// 制品库与制品口（乙-1 · 契约 `docs/dev/59-USER-APPS.md`）。
//
// 这一篇守的是**"别人的代码要跑在你的机器上"之前那几道**：
//   ① 🔴 **版本不可变**：同版本重发 ⇒ 拒
//   ② 🔴 **校验不过 ⇒ 盘上一个字节都不动**
//   ③ 🔴 **读回来的每个字节都要对得上 hash**
//   ④ 🔴 **路径不许越界**（制品内容是模型写的，这一道最要紧）
//   ⑤ 🔴 **按人分**：一个人的制品库里绝不会有另一个人的东西
//   ⑥ 🔴 **签名**：过期 / 换人 / 换版本 / 换内容 ⇒ 全拒
//   ⑦ 🔴 **不许发 `X-Frame-Options`**、必须带 CSP（否则壳里嵌不进去 / 没锁住）
//   ⑧ 权限白名单现在是**空的**：制品在乙-1 什么能力都拿不到

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeHttp from 'node:http';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import {
  Apps, AppsError, ICONS, MAX_FILES, MAX_FILE_BYTES, checkRelPath, rootHashOf,
} from '../src/apps.js';
import {
  SIGNED_TTL_MS, appsBaseOf, createAppServer, entryUrl, parseArtifactPath, signEntry, verifyEntry,
} from '../src/app-serve.js';
import { fontMirrorRel } from '../src/server.js';

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});

function tmp() {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-apps-'));
  tmpDirs.push(d);
  return d;
}

const KEY = Buffer.from('0123456789abcdef0123456789abcdef');

/** 一份最小的制品（一个 HTML 文件）。 */
const OK = Object.freeze({
  id: 'dice',
  title: '掷骰子',
  icon: 'dice',
  entry: 'index.html',
  files: { 'index.html': '<!doctype html><meta charset="utf-8"><button>掷</button>' },
});

// ── ① 制品库本身 ────────────────────────────────────────────

test('建一版：清单字段齐、rootHash 与文件一致', () => {
  const apps = new Apps({ dir: tmp(), sub: 'u1' });
  const m = apps.create({ ...OK });
  assert.equal(m.schema, 1);
  assert.equal(m.id, 'dice');
  assert.equal(m.version, 1);
  assert.equal(m.entry, 'index.html');
  assert.equal(m.permissions.length, 0, '乙-1 的制品不许带任何权限');
  assert.equal(m.files.length, 1);
  assert.equal(m.rootHash, rootHashOf([{ path: 'index.html', sha256: m.files[0].sha256 }]));
  assert.equal(apps.current('dice'), 1);
  assert.equal(apps.list().length, 1);
  // 读得回来，内容一字不差
  const got = apps.read('dice', 1, 'index.html');
  assert.match(got.content.toString('utf8'), /掷/);
  assert.match(got.contentType, /text\/html/);
});

test('🔴 rootHash 与写入顺序无关（同内容 ⇒ 同一个 hash）', () => {
  const a = new Apps({ dir: tmp() });
  const b = new Apps({ dir: tmp() });
  const filesA = { 'index.html': '<p>a</p>', 'a.js': '1', 'b.css': '2' };
  const filesB = { 'b.css': '2', 'index.html': '<p>a</p>', 'a.js': '1' };
  const ma = a.create({ ...OK, files: filesA });
  const mb = b.create({ ...OK, files: filesB });
  assert.equal(ma.rootHash, mb.rootHash);
});

test('🔴 版本不可变：同版本重发 ⇒ 拒', () => {
  const apps = new Apps({ dir: tmp() });
  apps.create({ ...OK });
  apps.create({ ...OK, title: '掷骰子 2' }); // v2
  apps.rollback('dice', 1);                  // 指针回到 v1
  assert.equal(apps.current('dice'), 1);
  // 现在 current=1 ⇒ 下一个版本号是 2，而 v2 已经存在 ⇒ 必须拒
  assert.throws(() => apps.create({ ...OK, title: '又想写 v2' }), AppsError);
  assert.equal(apps.current('dice'), 1, '拒了就不许动指针');
});

test('🔴 校验不过 ⇒ 盘上一个字节都不动（不是"写一半再回滚"）', () => {
  const dir = tmp();
  const apps = new Apps({ dir });
  assert.throws(() => apps.create({ ...OK, files: { 'index.html': '<p>x</p>', '../evil.html': '<p>y</p>' } }), AppsError);
  assert.equal(nodeFs.existsSync(nodePath.join(dir, 'hupo', 'apps', 'dice')), false, '一个目录都不该建出来');
  assert.equal(apps.list().length, 0);
});

test('🔴 路径安全：越界 / 绝对 / 反斜杠 / 空段 / 非法字符 一律拒', () => {
  for (const bad of [
    '../x.html', 'a/../../x.html', '/etc/passwd', 'a\\b.html', 'a//b.html', './a.html',
    'a/./b.html', 'a b.html', 'a;b.html', 'a\u0000.html', '', 'x'.repeat(200),
  ]) {
    assert.throws(() => checkRelPath(bad), AppsError, `这个路径该被拒：${JSON.stringify(bad)}`);
  }
  // 对照：正常路径必须过
  for (const good of ['index.html', 'a/b.js', 'x_y-z.1.css']) {
    assert.equal(checkRelPath(good), good);
  }
});

test('🔴 hash 对不上 ⇒ 读就抛（不是"尽力画"）', () => {
  const dir = tmp();
  const apps = new Apps({ dir });
  apps.create({ ...OK });
  const f = nodePath.join(apps.versionDir('dice', 1), 'index.html');
  nodeFs.chmodSync(f, 0o644);
  nodeFs.writeFileSync(f, '<p>被人动过了</p>');
  assert.throws(() => apps.read('dice', 1, 'index.html'), /对不上/);
});

test('限额：文件太多 / 单文件太大 / 未知权限 ⇒ 拒', () => {
  const apps = new Apps({ dir: tmp() });
  const many = {};
  for (let i = 0; i <= MAX_FILES; i += 1) many[`f${i}.txt`] = 'x';
  assert.throws(() => apps.create({ ...OK, files: { ...many, 'index.html': 'x' } }), /文件太多/);
  const big = { 'index.html': 'x'.repeat(MAX_FILE_BYTES + 1) };
  assert.throws(() => apps.create({ ...OK, files: big }), /太大/);
  // ⚠️ 乙-4 起 `ask` 是**允许声明**的（声明 ≠ 能用：还要看的人授予），
  //    但**不认识的名字**照样拒 —— 而且拒了之后盘上不许留东西。
  const withAsk = apps.create({ ...OK, id: 'withask', permissions: ['ask'] });
  assert.deepEqual(withAsk.permissions, ['ask']);
  assert.throws(() => apps.create({ ...OK, id: 'bad', permissions: ['root'] }), /不认识|还不给/);
});

test('图标与 id 都走白名单；入口必须在文件里', () => {
  const apps = new Apps({ dir: tmp() });
  assert.throws(() => apps.create({ ...OK, icon: 'nope' }), /图标/);
  assert.throws(() => apps.create({ ...OK, id: 'Bad_Id' }), /id/);
  assert.throws(() => apps.create({ ...OK, id: '../evil' }), /id/);
  assert.throws(() => apps.create({ ...OK, entry: 'nope.html' }), /入口文件不在/);
  assert.equal(ICONS.includes('dice'), true);
});

test('🔴 按人分：一个人的清单里绝不会有另一个人的东西', () => {
  const a = new Apps({ dir: tmp(), sub: 'u1' });
  const b = new Apps({ dir: tmp(), sub: 'u2' });
  a.create({ ...OK });
  assert.equal(a.list().length, 1);
  assert.equal(b.list().length, 0, '★ 乙不该看见甲的制品');
  assert.throws(() => b.read('dice', 1, 'index.html'), AppsError);
});

test('审计：create 与 rollback 各留一行，而且**只追加**', () => {
  const dir = tmp();
  const apps = new Apps({ dir, sub: 'u1' });
  const file = nodePath.join(dir, 'hupo', 'apps', 'audit.jsonl');
  apps.create({ ...OK, createdBy: 'agent', createdTurn: 7 });
  const n1 = nodeFs.readFileSync(file, 'utf8').trim().split('\n').length;
  apps.create({ ...OK, title: 'v2' });
  apps.rollback('dice', 1);
  const lines = nodeFs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, n3(n1), '只追加：不覆盖前面的');
  assert.equal(lines[0].what, 'create');
  assert.equal(lines[0].by, 'agent');
  assert.equal(lines[0].turn, 7, '★ 可倒查：哪一轮造的');
  assert.equal(lines.at(-1).what, 'rollback');
  assert.equal(lines.at(-1).sub, 'u1');
});

function n3(n1) { return n1 + 2; }

test('坏版本不炸整个清单（跳过那一个）', () => {
  const dir = tmp();
  const apps = new Apps({ dir });
  apps.create({ ...OK });
  apps.create({ ...OK, id: 'dice2', title: '第二个' });
  // 把 dice2 的清单弄坏
  const mf = nodePath.join(apps.versionDir('dice2', 1), 'manifest.json');
  nodeFs.chmodSync(mf, 0o644);
  nodeFs.writeFileSync(mf, '{ 这不是 JSON');
  const list = apps.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'dice');
});

test('回滚：内容回到旧版本，而且还能再滚回来', () => {
  const apps = new Apps({ dir: tmp() });
  apps.create({ ...OK });
  apps.create({ ...OK, files: { 'index.html': '<p>第二版</p>' } });
  assert.match(apps.read('dice', 2, 'index.html').content.toString(), /第二版/);
  apps.rollback('dice', 1);
  assert.equal(apps.current('dice'), 1);
  assert.match(apps.read('dice', 1, 'index.html').content.toString(), /button/);
  assert.throws(() => apps.rollback('dice', 9), AppsError, '不存在的版本不许回滚');
});

// ── ② 制品口（第二个原点）──────────────────────────────────

test('签名：好消息能过，四条坏消息全拒', () => {
  const now = 1_790_000_000_000;
  const exp = now + SIGNED_TTL_MS;
  const sig = signEntry({ key: KEY, sub: 'u1', id: 'dice', version: 1, exp });
  assert.equal(verifyEntry({ key: KEY, sig, sub: 'u1', id: 'dice', version: 1, exp, now }), true);
  // 换人
  assert.equal(verifyEntry({ key: KEY, sig, sub: 'u2', id: 'dice', version: 1, exp, now }), false);
  // 换版本
  assert.equal(verifyEntry({ key: KEY, sig, sub: 'u1', id: 'dice', version: 2, exp, now }), false);
  // 过期
  assert.equal(verifyEntry({ key: KEY, sig, sub: 'u1', id: 'dice', version: 1, exp, now: exp + 1 }), false);
  // 换密钥（签名被别人伪造）
  assert.equal(verifyEntry({ key: Buffer.from('f'.repeat(32)), sig, sub: 'u1', id: 'dice', version: 1, exp, now }), false);
  // 形状不对
  assert.equal(verifyEntry({ key: KEY, sig: 'nope', sub: 'u1', id: 'dice', version: 1, exp, now }), false);
});

test('路径解析：只认 /a/<id>/<版本>/<路径>', () => {
  assert.deepEqual(parseArtifactPath('/a/dice/1/index.html'), { id: 'dice', version: '1', rel: 'index.html' });
  assert.deepEqual(parseArtifactPath('/a/dice/1/x/y.js'), { id: 'dice', version: '1', rel: 'x/y.js' });
  for (const bad of ['/', '/a/', '/a/dice', '/a/dice/1', '/other/dice/1/x.html', '/a//1/x.html']) {
    assert.equal(parseArtifactPath(bad), null, `这个该解析不出来：${bad}`);
  }
});

/** 起一个制品口，拿到 base 与关掉它的办法。 */
async function startServe({ dir, key = KEY, frameAncestors = 'http://127.0.0.1:8020', now } = {}) {
  const apps = new Apps({ dir, sub: 'u1' });
  const srv = createAppServer({
    resolveApps: (sub) => (sub === 'u1' ? apps : null),
    key,
    frameAncestors,
    now,
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { apps, srv, base, close: () => new Promise((r) => srv.close(r)) };
}

function get(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request(url, { method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('制品口：好消息 200 + 内容对 + 带 CSP + **没有 X-Frame-Options**', async () => {
  const dir = tmp();
  const { apps, base, close } = await startServe({ dir });
  apps.create({ ...OK });
  const url = entryUrl({ base, key: KEY, sub: 'u1', id: 'dice', version: 1, entry: 'index.html' });
  const r = await get(url);
  assert.equal(r.status, 200);
  assert.match(r.body.toString(), /掷/);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.headers['content-security-policy'], /default-src 'none'/);
  assert.match(r.headers['content-security-policy'], /connect-src 'none'/);
  assert.match(r.headers['content-security-policy'], /frame-ancestors http:\/\/127\.0\.0\.1:8020/);
  assert.equal(r.headers['x-frame-options'], undefined, '🔴 发了它壳里就嵌不进去');
  assert.equal(r.headers['cache-control'], 'no-store');
  await close();
});

test('🔴 制品口：伪造 / 过期 / 换人 一律 403（而且连目录都不看）', async () => {
  const dir = tmp();
  const { apps, base, close } = await startServe({ dir });
  apps.create({ ...OK });
  const good = entryUrl({ base, key: KEY, sub: 'u1', id: 'dice', version: 1, entry: 'index.html' });
  const exp = Date.now() + SIGNED_TTL_MS;
  const cases = [
    `${base}/a/dice/1/index.html?u=u1&e=${exp}&s=${'0'.repeat(64)}`,          // 假签名
    `${base}/a/dice/1/index.html?u=u2&e=${exp}&s=${signEntry({ key: KEY, sub: 'u1', id: 'dice', version: 1, exp })}`, // 换人
    `${base}/a/dice/1/index.html?u=u1&e=${exp}&s=${signEntry({ key: KEY, sub: 'u1', id: 'dice', version: 2, exp })}`, // 换版本
    `${base}/a/dice/1/index.html?u=u1&e=${Date.now() - 1000}&s=${signEntry({ key: KEY, sub: 'u1', id: 'dice', version: 1, exp: Date.now() - 1000 })}`, // 过期
    `${base}/a/dice/1/index.html`,                                            // 没签名
  ];
  for (const u of cases) {
    const r = await get(u);
    assert.equal(r.status, 403, `这条该被拒：${u}`);
  }
  assert.equal((await get(good)).status, 200, '对照：真签名必须过');
  await close();
});

test('🔴 制品口：路径穿越拿不到东西（签名有效也不行）', async () => {
  const dir = tmp();
  const { apps, base, close } = await startServe({ dir });
  apps.create({ ...OK });
  const exp = Date.now() + SIGNED_TTL_MS;
  const sig = signEntry({ key: KEY, sub: 'u1', id: 'dice', version: 1, exp });
  const r = await get(`${base}/a/dice/1/../../../../etc/passwd?u=u1&e=${exp}&s=${sig}`);
  assert.equal(r.status === 404 || r.status === 403, true, '穿越路径必须拿不到');
  await close();
});

test('制品口：别的用户的那一格取不到（按人分）', async () => {
  const dir = tmp();
  const { base, close } = await startServe({ dir });
  const exp = Date.now() + SIGNED_TTL_MS;
  const sig = signEntry({ key: KEY, sub: 'u2', id: 'dice', version: 1, exp });
  const r = await get(`${base}/a/dice/1/index.html?u=u2&e=${exp}&s=${sig}`);
  assert.equal(r.status, 403, '★ resolveApps 说没有那个人 ⇒ 拒');
  await close();
});

test('制品口：405 / 404 / HEAD', async () => {
  const dir = tmp();
  const { apps, base, close } = await startServe({ dir });
  apps.create({ ...OK });
  assert.equal((await get(`${base}/a/dice/1/index.html`, 'POST')).status, 405);
  assert.equal((await get(`${base}/nope`)).status, 404);
  const url = entryUrl({ base, key: KEY, sub: 'u1', id: 'dice', version: 1, entry: 'index.html' });
  const h = await get(url, 'HEAD');
  assert.equal(h.status, 200);
  assert.equal(h.body.length, 0, 'HEAD 不该有 body');
  assert.match(String(h.headers['content-length']), /^[1-9]/);
  await close();
});

test('乙-4：授予要落盘、只认白名单、撤了就空；卸载是**软删**（能拿回来）', () => {
  const dir = tmp();
  const apps = new Apps({ dir, sub: 'u1' });
  apps.create({ ...OK, permissions: ['ask'] });
  assert.deepEqual(apps.grants('dice'), [], '没授予过 ⇒ 空（fail-closed）');
  assert.deepEqual(apps.setGrants('dice', ['ask']), ['ask']);
  assert.deepEqual(apps.grants('dice'), ['ask'], '授予要落盘（重启之后还在）');
  assert.throws(() => apps.setGrants('dice', ['root']), /不认识/);
  assert.deepEqual(apps.setGrants('dice', []), [], '撤了就空');
  assert.deepEqual(apps.grants('dice'), []);
  assert.throws(() => apps.setGrants('nope', ['ask']), /不在你这儿/);

  // 卸载：清单里没了，但盘上还在（软删）
  apps.remove('dice');
  assert.deepEqual(apps.list().map((a) => a.id), []);
  const kept = nodeFs.readdirSync(nodePath.join(dir, 'hupo', 'apps', '.removed'));
  assert.equal(kept.length, 1, '★ 挪进 .removed（不是真删）');
  // 审计里要留一行
  const audit = nodeFs.readFileSync(nodePath.join(dir, 'hupo', 'apps', 'audit.jsonl'), 'utf8');
  assert.match(audit, /"what":"remove"/);
  assert.match(audit, /"what":"grant"/);
});

test('🔴 上线只改配置：对外地址优先，没配才退回本机那个（尾斜杠要去掉）', () => {
  // 本机（默认）
  assert.equal(appsBaseOf({ appsHost: '127.0.0.1', appsPort: 8021 }), 'http://127.0.0.1:8021');
  // 配了对外域名 ⇒ 用它（迁移那天就改这一处）
  assert.equal(
    appsBaseOf({ appsPublicBase: 'https://apps.example', appsHost: '127.0.0.1', appsPort: 8021 }),
    'https://apps.example',
  );
  // 尾斜杠 / 空串 / 只有空格 ⇒ 都不许拼出 `//a/...` 那种地址
  assert.equal(appsBaseOf({ appsPublicBase: 'https://apps.example/' }), 'https://apps.example');
  assert.equal(appsBaseOf({ appsPublicBase: '   ' , appsPort: 9 }), 'http://127.0.0.1:9');
  assert.equal(appsBaseOf({ appsPublicBase: null, appsPort: 9 }), 'http://127.0.0.1:9');
  // 拼出来的入口 URL 必须真的以它为前缀（这条是"上线只改配置"的最后一段）
  const u = entryUrl({
    base: appsBaseOf({ appsPublicBase: 'https://apps.example' }),
    key: KEY, sub: 'u1', id: 'dice', version: 1, entry: 'index.html', now: 1,
  });
  assert.match(u, /^https:\/\/apps\.example\/a\/dice\/1\/index\.html\?/);
});

// ── 字体镜像那条路（2026-09-23）────────────────────────────────
//
// 🔴 它是个**代理**（服务端替用户去 gstatic 取字体）⇒ **路径必须过白名单**：
//    写松一点就是一个任意 SSRF 的口。这一节钉的就是"哪些过得去、哪些过不去"。

test('🔴 字体镜像只认白名单路径（它是个代理，不能变成任意取件的口）', async () => {
  const { createServer } = await import('../src/server.js');
  const { listen, close } = createServer({ webRoot: null, buildId: 'font-test', log: () => {} });
  const addr = await listen(0);
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    // 形状不对 / 家族不在白名单 / 想跑出去 ⇒ 一律 404
    for (const bad of [
      '/fonts/',
      '/fonts/notosanssc/v37/x.woff2',            // 缺一段？不，这是合法形状，下面单独验
      '/fonts/evil/v37/x.woff2',                  // 家族不在白名单
      '/fonts/notosanssc/../../etc/passwd',       // 穿越
      '/fonts/notosanssc/v37/../../../secret.txt',
      '/fonts//v37/x.woff2',
      '/fonts/notosanssc/v37/x.exe',              // 后缀不在白名单
      '/fonts/notosanssc/37/x.woff2',             // 版本号形状不对
      '/fonts/https://evil.example/x.woff2',
    ]) {
      if (bad === '/fonts/notosanssc/v37/x.woff2') continue; // 那个是合法的（下面验 200/404 都行）
      const r = await fetch(`${base}${bad}`);
      assert.equal(r.status, 404, `这条该被拒：${bad}`);
    }
    // 🔴 **拿真实的名字判**（第一版用一个短假名字 ⇒ 把我自己的长度上限 80 漏过去了，
    //    而线上真名字是 96 字符 ⇒ 一个都过不去、中文全 404）。
    const real = 'notosanssc/v37/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaG9_FnYkldv7JjxkkgFsFSSOPMOkySAZ73y9ViAt3acb8NexQ2w.118.woff2';
    assert.equal(fontMirrorRel(`/fonts/${real}`), real, '★ 真实长度的文件名必须过白名单');
    // 不存在的文件 ⇒ 上游给 404（**不是**因为我们把路径拒了）
    const okPath = await fetch(`${base}/fonts/notosanssc/v37/${'a'.repeat(96)}.woff2`);
    assert.equal(okPath.status, 404);
    // POST 不许
    const post = await fetch(`${base}/fonts/notosanssc/v37/x.woff2`, { method: 'POST' });
    assert.equal(post.status, 405);
  } finally {
    await close();
  }
});
