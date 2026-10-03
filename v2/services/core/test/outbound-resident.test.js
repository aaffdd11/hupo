// 92 §③ **阶段 6**：把"出界那一刻搜哨兵"做成**发布路径自带的常驻断言**
// （契约 `docs/dev/92-TRIPLE-PLAN.md` §③ 阶段 6 · 事实记录 `docs/dev/158-RESIDENT-OUTBOUND-ASSERT.md`）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   §6-1  ★  正对照：干净的清单 ⇒ 过，返回的留痕逐条对得上（证明断言不是空转）
//   §6-2  🔴 **差分负向对照**：同一份清单，只把多出来那一条的路径从 `assets/…` 换成
//          `.data/…` ⇒ **从过变拒**（红的必须是"隐藏路径"，不是"清单被动过"）
//   §6-3  🔴 隐藏判**每一段**（`assets/.hidden/x.js` 也拒）
//   §6-4  🔴 越界路径（`../` / 绝对路径）⇒ 拒
//   §6-5  🔴 **多了**（字节里有一份没申报的）⇒ 拒
//   §6-6  🔴 **少了**（清单声明了、字节里没有）⇒ 拒
//   §6-7  🔴 **换过**（字节与清单那一条 sha 不符）⇒ 拒
//   §6-8  🔴 清单与它登记的起点对不上 ⇒ 拒
//   §6-9  🔴 路径重复 / 空路径 / 清单不是对象 / 没有文件表 ⇒ 拒（fail-closed）
//   §6-10 ★  同一处规则：断言**复用** `apps.js` 的 `checkRelPath` / `refuseHiddenRelPath`（不另抄一份）
//   §6-11 ★  真盘上架上一次 ⇒ 审计账里那一条**带 seal**（digest == rootHash）
//   §6-12 🔴 **夹带**：真盘上把清单改成多一条 `.data/…`（字节真在、hash 也对）⇒ 发布**必须红**
//          ＋ 共享库**零残留**（连根都没建出来）
//   §6-13 ★  差分对照：同样的改法、只把那条路径换成不隐藏的 ⇒ **过**
//   §6-14 🔴 假 `apps`（清单由测试直接给）：`published.publish` **自己**拒 —— 不是靠
//          `apps.create` 的写入侧闸，也不是靠 `apps.read`
//   §6-15 🔴 接线：`published.js` 真的调了它，而且跑在**第一次写盘之前**（源码级）

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { Apps, rootHashOf, sha256hex } from '../src/apps.js';
import { OutboundError, assertOutboundBytes } from '../src/outbound.js';
import { Published } from '../src/published.js';
import { AppWorkspaces } from '../src/workspace.js';

const HERE = nodePath.dirname(new URL(import.meta.url).pathname);
const SRC = nodePath.resolve(HERE, '..', 'src');

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});

function tmp(prefix = 'hupo-resident-') {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const APP = { title: '新闻', icon: 'dice', entry: 'index.html' };

/** ★ A16：制品里必须有外联申报（读不到 ⇒ 上架拒）；这一份验的是**出界那一刻**。 */
const DECL = JSON.stringify({
  schema: 1,
  outbound: [],
  declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '探针，没人用过' },
});

const BASE = { 'index.html': '<p>第一版</p>', 'outbound.json': DECL };

function world() {
  const dir = tmp();
  const apps = new Apps({ dir, sub: 'u1' });
  const workspaces = new AppWorkspaces({ dir, log: () => {} });
  const published = new Published({ dir });
  return { dir, apps, workspaces, published, shared: (id) => nodePath.join(dir, 'published-apps', id) };
}

const toBuf = (c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8'));

/** 手搭一份清单（纯函数那一半用它 —— 测试可以喂任意形状）。 */
function manifestOf(entries, { id = 'news', version = 1, rootHash } = {}) {
  const files = Object.entries(entries).map(([p, c]) => {
    const buf = toBuf(c);
    return { path: p, sha256: sha256hex(buf), bytes: buf.length };
  });
  return {
    schema: 1, id, version, files,
    rootHash: rootHash === undefined ? rootHashOf(files) : rootHash,
  };
}

const bufMap = (entries) => Object.fromEntries(Object.entries(entries).map(([p, c]) => [p, toBuf(c)]));

/** 只会红的那些形状 → 一条出错路径（用 `assert.throws` 的校验器）。 */
const redFor = (frag) => (err) => {
  assert.ok(err instanceof OutboundError, `应该是 OutboundError，实际 ${err?.name}：${err?.message}`);
  assert.match(String(err.message), frag, `文案里该点出「${frag}」：${err.message}`);
  return true;
};

// ════════════════════════════════════════════════════════════════
// §6-1…§6-9 断言本体（纯函数；这一半不碰盘）
// ════════════════════════════════════════════════════════════════

test('★ §6-1 正对照：干净的清单 ⇒ 过，留痕逐条对得上', () => {
  const man = manifestOf(BASE);
  const seal = assertOutboundBytes({ route: 'publish', id: 'news', manifest: man, files: bufMap(BASE) });
  assert.equal(seal.count, 2);
  assert.equal(seal.digest, man.rootHash);
  assert.equal(seal.bytes, toBuf(BASE['index.html']).length + toBuf(BASE['outbound.json']).length);
  assert.deepEqual(seal.files.map((f) => f.path).sort(), ['index.html', 'outbound.json']);
  // 留痕里的每一条 sha256 必须与清单里那一条**逐字**相同
  for (const f of seal.files) {
    assert.equal(f.sha256, man.files.find((r) => r.path === f.path).sha256);
  }
});

test('🔴 §6-2 差分负向对照：同一份清单，只把多出来那条路径换成 `.data/…` ⇒ 从过变拒', () => {
  const clean = { ...BASE, 'assets/ok.json': '{"ok":true}' };
  const hidden = { ...BASE, '.data/ok.json': '{"ok":true}' };
  // 正的那一半
  assertOutboundBytes({ route: 'publish', manifest: manifestOf(clean), files: bufMap(clean) });
  // 只改路径那一个字符串 ⇒ 必须拒
  assert.throws(
    () => assertOutboundBytes({ route: 'publish', manifest: manifestOf(hidden), files: bufMap(hidden) }),
    redFor(/\.data\/ok\.json/),
    '🔴 只把路径换成 `.data/` 之后仍然过了 ⇒ 这条断言压的不是"隐藏路径"',
  );
});

test('🔴 §6-3 隐藏判**每一段**：`assets/.hidden/x.js` 同样拒', () => {
  const entries = { ...BASE, 'assets/.hidden/x.js': 'x' };
  assert.throws(
    () => assertOutboundBytes({ route: 'publish', manifest: manifestOf(entries), files: bufMap(entries) }),
    redFor(/assets\/\.hidden\/x\.js/),
  );
});

test('🔴 §6-4 越界路径（`..` / 绝对路径）⇒ 拒', () => {
  for (const bad of ['../outside.txt', '/etc/passwd']) {
    const entries = { ...BASE, [bad]: 'x' };
    assert.throws(
      () => assertOutboundBytes({ route: 'publish', manifest: manifestOf(entries), files: bufMap(entries) }),
      (e) => e instanceof OutboundError,
      `🔴 越界路径 ${bad} 居然过了`,
    );
  }
});

test('🔴 §6-5 「多了」：字节里有一份没申报的 ⇒ 拒（清单是干净的）', () => {
  const man = manifestOf(BASE);
  const files = { ...bufMap(BASE), 'sneak.txt': '夹带进来的' };
  assert.throws(
    () => assertOutboundBytes({ route: 'publish', manifest: man, files }),
    redFor(/sneak\.txt/),
  );
});

test('🔴 §6-6 「少了」：清单声明了、字节里没有 ⇒ 拒', () => {
  const man = manifestOf(BASE);
  const files = bufMap(BASE);
  delete files['outbound.json'];
  assert.throws(
    () => assertOutboundBytes({ route: 'publish', manifest: man, files }),
    redFor(/outbound\.json/),
  );
});

test('🔴 §6-7 「换过」：字节与清单那一条 sha 不符 ⇒ 拒', () => {
  const man = manifestOf(BASE);
  const files = bufMap(BASE);
  files['index.html'] = toBuf('<p>换掉的内容</p>'); // 清单说 A、字节是 B
  assert.throws(
    () => assertOutboundBytes({ route: 'publish', manifest: man, files }),
    redFor(/index\.html/),
  );
});

test('🔴 §6-8 清单与它登记的起点对不上 ⇒ 拒', () => {
  const man = manifestOf(BASE, { rootHash: 'a'.repeat(64) });
  assert.throws(
    () => assertOutboundBytes({ route: 'publish', manifest: man, files: bufMap(BASE) }),
    redFor(/可核起点/),
  );
});

test('🔴 §6-9 fail-closed：重复路径 / 空路径 / 清单不是对象 / 没有文件表 ⇒ 都拒', () => {
  const man = manifestOf(BASE);
  const dup = { ...man, files: [...man.files, { ...man.files[0] }] };
  assert.throws(() => assertOutboundBytes({ route: 'publish', manifest: dup, files: bufMap(BASE) }), redFor(/不止一次/));

  const empty = manifestOf({ ...BASE, '': 'x' });
  assert.throws(() => assertOutboundBytes({ route: 'publish', manifest: empty, files: { ...bufMap(BASE), '': toBuf('x') } }), redFor(/空的/));

  assert.throws(() => assertOutboundBytes({ route: 'publish', manifest: null }), redFor(/清单读不出来/));
  assert.throws(() => assertOutboundBytes({ route: 'publish', manifest: { id: 'news' } }), redFor(/文件表/));
  assert.throws(() => assertOutboundBytes({ route: 'publish', manifest: man, files: [] }), redFor(/字节表/));
});

test('★ §6-10 同一处规则：断言**复用** `apps.js` 的路径闸（不另抄一份）', () => {
  const code = nodeFs.readFileSync(nodePath.join(SRC, 'outbound.js'), 'utf8');
  assert.match(code, /import\s*\{[\s\S]*?refuseHiddenRelPath[\s\S]*?\}\s*from\s*'\.\/apps\.js'/u, '隐藏路径那条规则必须从 apps.js 引进来');
  assert.match(code, /refuseHiddenRelPath\s*\(/u, '引了就要用');
  assert.match(code, /checkRelPath\s*\(/u, '越界路径那条也要复用');
});

// ════════════════════════════════════════════════════════════════
// §6-11…§6-13 真盘：真 `Apps` ＋ 真 `Published`
// ════════════════════════════════════════════════════════════════

test('★ §6-11 真上架一次 ⇒ 审计账那一条**带 seal**（digest == rootHash）', () => {
  const w = world();
  w.apps.create({ id: 'news', ...APP, files: BASE });
  const man = w.apps.manifest('news', 1);
  w.published.publish(w.apps, { id: 'news', authorSub: 'u1', authorName: '甲' });

  const audit = nodePath.join(w.dir, 'published-apps', 'audit.jsonl');
  const lines = nodeFs.readFileSync(audit, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const pub = lines.find((l) => l.what === 'publish');
  assert.ok(pub, '前提：审计账里该有 publish 那一行');
  assert.equal(pub.outbound?.sealed, true, '🔴 留痕里必须写着"出界那一刻核过"');
  assert.equal(pub.outbound.digest, man.rootHash, '留痕那把 digest 必须是登记的起点');
  assert.equal(pub.outbound.files, man.files.length);
  assert.equal(pub.outbound.share, 0, '没有声明可分享的条目 ⇒ 0');
  // 负向对照：没装过就不许有 install 那一行（留痕不是"随手多写几条"）
  assert.equal(lines.some((l) => l.what === 'install'), false);
});

/**
 * 真盘上把那一版的清单改成"多一条"（字节真在、hash 也对、`rootHash` 也重算）。
 *
 * ⚠️ 版本目录里的文件是 **0444**（版本不可变 ⇒ 只读，`apps.js` 的 `writeAtomic`）——
 *    所以探针要先 `chmod` 才写得动。**这本身就是"版本不可变"那道闸还在的证据**。
 */
function plantExtra(w, id, rel, body) {
  const m = w.apps.manifest(id, 1);
  const vdir = w.apps.versionDir(id, 1);
  const buf = toBuf(body);
  const rec = { path: rel, sha256: sha256hex(buf), bytes: buf.length };
  const files = [...m.files, rec];
  const mfile = nodePath.join(vdir, 'manifest.json');
  nodeFs.chmodSync(mfile, 0o644);
  nodeFs.writeFileSync(
    mfile,
    `${JSON.stringify({ ...m, files, rootHash: rootHashOf(files) }, null, 2)}\n`,
  );
  nodeFs.mkdirSync(nodePath.dirname(nodePath.join(vdir, rel)), { recursive: true });
  nodeFs.writeFileSync(nodePath.join(vdir, rel), buf);
  return { manifest: { ...m, files, rootHash: rootHashOf(files) } };
}

test('🔴 §6-12 夹带：清单里多一条 `.data/…` ⇒ 发布**必须红**，共享库零残留', () => {
  const w = world();
  w.apps.create({ id: 'news', ...APP, files: BASE });
  plantExtra(w, 'news', '.data/secret.json', '{"sentinel":"PROBE-DATA-SENTINEL-do-not-ship"}');

  assert.throws(
    () => w.published.publish(w.apps, { id: 'news', authorSub: 'u1' }),
    redFor(/\.data\/secret\.json/),
    '🔴 夹带了两格字节的包居然上架成功',
  );
  assert.equal(nodeFs.existsSync(w.shared('news')), false, '🔴 拒了却留下了探针目录');
  assert.equal(
    nodeFs.existsSync(nodePath.join(w.dir, 'published-apps')),
    false,
    '🔴 拒了却把共享库根建出来了（连审计账都不该有）',
  );
});

test('★ §6-13 差分对照：同样的改法、路径换成不隐藏的 ⇒ **过**', () => {
  const w = world();
  w.apps.create({ id: 'news', ...APP, files: BASE });
  plantExtra(w, 'news', 'assets/extra.json', '{"ok":true}');
  const idx = w.published.publish(w.apps, { id: 'news', authorSub: 'u1' });
  assert.equal(idx.id, 'news');
  assert.ok(
    nodeFs.existsSync(nodePath.join(w.shared('news'), 'versions', '1', 'assets', 'extra.json')),
    '正对照：不隐藏的那一条该照走',
  );
});

// ════════════════════════════════════════════════════════════════
// §6-14 假 `apps`：拒的必须是 `published.publish` **自己**
// ════════════════════════════════════════════════════════════════

/** 一个只提供 `publish` 要的那几样的假制品库（清单/字节由测试直接给）。 */
function fakeApps({ dir, entries, id = 'news' }) {
  const man = manifestOf(entries, { id });
  return {
    dir, fs: nodeFs, sub: 'u1',
    list: () => [{ id, title: APP.title, icon: APP.icon, entry: APP.entry, version: 1, rootHash: man.rootHash, permissions: [] }],
    current: () => 1,
    manifest: () => man,
    lineage: () => [],
    read: (i, v, rel) => ({ content: toBuf(entries[rel]), contentType: 'text/html' }),
  };
}

test('🔴 §6-14 假 `apps` 喂一份带 `.data/…` 的清单 ⇒ `published.publish` 自己拒', () => {
  const dir = tmp();
  const published = new Published({ dir });
  const fake = fakeApps({ dir, entries: { ...BASE, '.data/a.json': '{"x":1}' } });
  assert.throws(
    () => published.publish(fake, { id: 'news', authorSub: 'u1' }),
    redFor(/\.data\/a\.json/),
    '🔴 写入侧闸（apps.create）被绕开了，`published.publish` 这一层没接住',
  );
  assert.equal(nodeFs.existsSync(nodePath.join(dir, 'published-apps')), false, '拒了就不许碰盘');

  // 正对照：同一套假 apps，把那条路径换成不隐藏的 ⇒ 过
  const dir2 = tmp();
  const pub2 = new Published({ dir: dir2 });
  const ok = pub2.publish(fakeApps({ dir: dir2, entries: { ...BASE, 'assets/a.json': '{"x":1}' } }), { id: 'news', authorSub: 'u1' });
  assert.equal(ok.id, 'news');
});

// ════════════════════════════════════════════════════════════════
// §6-15 接线：跑在**第一次写盘之前**
// ════════════════════════════════════════════════════════════════

test('🔴 §6-15 `published.js` 真的调了它，而且跑在第一次写盘之前（源码级）', () => {
  const code = nodeFs
    .readFileSync(nodePath.join(SRC, 'published.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  const at = code.indexOf('assertOutboundBytes');
  assert.ok(at > 0, '🔴 唯一写入者必须调那条常驻断言（不然它只是一段没人用的代码）');
  const write = code.indexOf("nodePath.join(this.appDir(id), 'versions'");
  assert.ok(write > 0, '前提：找得到"复制进共享库"那一处写盘');
  assert.ok(at < write, '🔴 断言必须跑在**第一次写盘之前**（拒的时候一个字节都不许动）');
});
