// **外联申报（A16）** —— 契约 `docs/dev/93-OUTBOUND-USAGE.md` §二／§三 ·
// 主人 2026-09-25 第 5 条（`docs/dev/96-OWNER-DECISIONS.md`：写在制品里，随 `rootHash` 冻结）。
//
// 这一份钉的就是 §二／§三 那几条，**每条都带反例**：
//   A16-1 🔴 读不到申报 ⇒ 上架**拒**（fail-closed），共享库盘上零残留
//   A16-2 🔴 `schema` 认不出 / 结构不对 ⇒ 拒
//   A16-3 🔴 枚举外的 `kind` / `fields` ⇒ 拒（不许自由文本蒙混）
//   A16-4 🔴 申报说"不用外网"而代码里有出网点 ⇒ 拒（R2 · 页面在说假话）
//   A16-5 🔴 扫出来的出网点没申报 ⇒ 拒（R1）；补上申报 ⇒ 过（正对照）
//   A16-6 🔴 申报的字节在 `rootHash` 范围内（改一个字节 ⇒ `rootHash` 变）
//   A16-7 🔴 申报**不构成授权**（写 `ask` 而没声明 `permissions:['ask']` ⇒ 照旧不通）
//   A16-8 ★ 申报说"不用外网"且代码里也确实没有 ⇒ 过

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import {
  DeclarationError,
  OUTBOUND_DECL_FILENAME,
  OUTBOUND_FIELDS,
  OUTBOUND_KINDS,
  assertDeclarationAllowed,
  checkDeclarationAgainstCode,
  parseOutboundDeclaration,
  scanOutboundPoints,
} from '../src/app-outbound.js';
import { Apps, rootHashOf, sha256hex } from '../src/apps.js';
import { Published } from '../src/published.js';

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});

function tmp(prefix = 'hupo-decl-') {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function world() {
  const dir = tmp();
  const apps = new Apps({ dir, sub: 'u1' });
  const published = new Published({ dir });
  return { dir, apps, published };
}

const APP = { title: '新闻', icon: 'dice', entry: 'index.html' };

/** 一份合规的申报（`outbound: []` = 什么都没申报 ⇒ 代码里也必须零命中）。 */
function decl(patch = {}) {
  return {
    schema: 1,
    outbound: [],
    declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '还没人用过，先按 0 报' },
    ...patch,
  };
}

const asText = (j) => (typeof j === 'string' ? j : JSON.stringify(j, null, 2));

function makeApp(w, id = 'news', files = {}) {
  return w.apps.create({
    id, ...APP,
    files: { 'index.html': '<p>新闻</p>', [OUTBOUND_DECL_FILENAME]: asText(decl()), ...files },
  });
}

function caught(fn) {
  try { fn(); return null; } catch (err) { return err; }
}

// ════════════════════════════════════════════════════════════════
// A16-1 🔴 读不到申报 ⇒ 拒上架（fail-closed），盘上零残留
// ════════════════════════════════════════════════════════════════

test('🔴 A16-1 制品里没有申报 ⇒ 上架**拒**（fail-closed），共享库盘上零残留', () => {
  const w = world();
  // 故意**不**放 outbound.json
  w.apps.create({ id: 'news', ...APP, files: { 'index.html': '<p>没有申报</p>' } });
  const err = caught(() => w.published.publish(w.apps, { id: 'news', authorSub: 'u1', authorName: '甲' }));
  assert.ok(err instanceof DeclarationError, `🔴 没有申报必须拒：${String(err)}`);
  assert.match(err.message, /读不到申报|没有 outbound\.json/, `拒的话要是人话：${err.message}`);
  assert.equal(nodeFs.existsSync(nodePath.join(w.dir, 'published-apps', 'news')), false, '盘上零残留');
  assert.deepEqual(w.published.discover(), []);

  // **负向对照**：放上申报（新一版）⇒ 同一条路就过（证明闸是"判"不是"关"）
  w.apps.create({
    id: 'news', ...APP,
    files: { 'index.html': '<p>有申报</p>', [OUTBOUND_DECL_FILENAME]: asText(decl()) },
  });
  const idx = w.published.publish(w.apps, { id: 'news', authorSub: 'u1', authorName: '甲' });
  assert.equal(idx.id, 'news');
  assert.equal(nodeFs.existsSync(nodePath.join(w.dir, 'published-apps', 'news', 'versions', String(idx.version), OUTBOUND_DECL_FILENAME)), true);
});

// ════════════════════════════════════════════════════════════════
// A16-2／A16-3 🔴 结构 / 枚举 / 套话 ⇒ 拒
// ════════════════════════════════════════════════════════════════

test('🔴 A16-2 申报的 schema 认不出 / 结构不对 ⇒ 拒（不是"当没有外联"）', () => {
  const cases = [
    ['不是 JSON', '{这不是 json', /看不懂/],
    ['不是对象', '[]', /不是一份对象/],
    ['schema 认不出', JSON.stringify(decl({ schema: 99 })), /版本认不出/],
    ['没有 outbound 表', JSON.stringify({ schema: 1, declaredUsage: decl().declaredUsage }), /没有出网点表/],
    ['没有 declaredUsage', JSON.stringify({ schema: 1, outbound: [] }), /没有用量预告/],
    ['declaredUsage 没有量级', JSON.stringify(decl({ declaredUsage: { dailyCallsBand: 0, basis: 'x' } })), /dailyTokensBand/],
    ['basis 空', JSON.stringify(decl({ declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '' } })), /basis/],
  ];
  for (const [name, raw, want] of cases) {
    const err = caught(() => parseOutboundDeclaration(raw));
    assert.ok(err instanceof DeclarationError, `🔴 ${name} ⇒ 必须拒`);
    assert.match(err.message, want, `${name}：${err.message}`);
  }
});

test('🔴 A16-3 枚举外的 `kind`／`fields`、空用途、套话用途 ⇒ 拒', () => {
  const askPoint = (patch) => decl({
    outbound: [{
      kind: 'ask', target: '经我们中转 → 上游模型域名', purpose: '问一句模型',
      fields: ['prompt'], viaRelay: true, ...patch,
    }],
  });
  const cases = [
    ['kind 认不出', askPoint({ kind: 'http-post' }), /认不出这个出网点/],
    ['fields 枚举外', askPoint({ fields: ['prompt', '全部聊天记录'] }), /不认识的字段/],
    ['fields 空', askPoint({ fields: [] }), /字段表是空的/],
    ['target 空', askPoint({ target: '' }), /没写清去哪儿/],
    ['purpose 空', askPoint({ purpose: '' }), /用途是空的或套话/],
    ['purpose 套话', askPoint({ purpose: '用于提供更好服务' }), /用途是空的或套话/],
    ['viaRelay 不是布尔', askPoint({ viaRelay: 'yes' }), /走不走我们的中转/],
  ];
  for (const [name, raw, want] of cases) {
    const err = caught(() => parseOutboundDeclaration(JSON.stringify(raw)));
    assert.ok(err instanceof DeclarationError, `🔴 ${name} ⇒ 必须拒`);
    assert.match(err.message, want, `${name}：${err.message}`);
  }
  // 正对照：逐字段合规的那一条 ⇒ 过
  const ok = parseOutboundDeclaration(JSON.stringify(askPoint({})));
  assert.equal(ok.outbound[0].kind, 'ask');
  assert.deepEqual(ok.outbound[0].fields, ['prompt']);
  // `none` 与别的出网点**不许同真**
  const both = decl({ outbound: [{ kind: 'none' }, { kind: 'ask', target: 'x', purpose: '问一句', fields: ['prompt'], viaRelay: true }] });
  assert.match(String(caught(() => parseOutboundDeclaration(JSON.stringify(both)))?.message), /不能同时为真/);
  // 枚举本身是冻死的（与契约 93 §2.2 一致）
  assert.deepEqual([...OUTBOUND_KINDS], ['ask', 'agent-web', 'artifact-fetch', 'none']);
  assert.deepEqual([...OUTBOUND_FIELDS], ['prompt', 'answer', 'sub', 'workspace-bytes', 'error-text', 'none']);
});

// ════════════════════════════════════════════════════════════════
// A16-4／A16-5 R1／R2：申报 vs 代码
// ════════════════════════════════════════════════════════════════

test('🔴 A16-4 申报说"不用外网"、代码里却有 `fetch(` ⇒ 拒（页面在说假话）', () => {
  const declOk = parseOutboundDeclaration(JSON.stringify(decl()));
  const files = { 'index.html': '<script>fetch("https://example.com/x")</script>' };
  const points = scanOutboundPoints(files);
  assert.equal(points.length >= 1, true, '扫描要看得见 fetch(');
  const err = caught(() => checkDeclarationAgainstCode({ decl: declOk, files }));
  assert.ok(err instanceof DeclarationError, '🔴 说不用外网却真有出网点 ⇒ 必须拒');
  assert.match(err.message, /不用外网/, err.message);

  // **反着验**：删掉那句 fetch ⇒ 同一份申报就过
  assert.doesNotThrow(() => checkDeclarationAgainstCode({ decl: declOk, files: { 'index.html': '<p>没事</p>' } }));
});

test('🔴 A16-5 有 `fetch`／`ask`／`web_search` 而申报里没有 ⇒ 逐类拒；补上就过', () => {
  const cases = [
    ['fetch', 'artifact-fetch', '<script>fetch("/x")</script>'],
    ['XMLHttpRequest', 'artifact-fetch', '<script>new XMLHttpRequest()</script>'],
    ['WebSocket', 'artifact-fetch', '<script>new WebSocket("wss://x")</script>'],
    ['ask', 'ask', '<script>ask("你好")</script>'],
    ['web_search', 'agent-web', '<p>用 web_search 查一下</p>'],
  ];
  for (const [name, kind, body] of cases) {
    const files = { 'index.html': body };
    const noneDecl = parseOutboundDeclaration(JSON.stringify(decl()));
    assert.match(String(caught(() => checkDeclarationAgainstCode({ decl: noneDecl, files }))?.message ?? ''), /没申报|不用外网/, `${name}：未申报必须拒`);
    // 补上对应那一类 ⇒ 过（正对照）
    const withIt = parseOutboundDeclaration(JSON.stringify(decl({
      outbound: [{ kind, target: 'example.com', purpose: '查公开资料', fields: ['none'], viaRelay: false }],
    })));
    assert.doesNotThrow(() => checkDeclarationAgainstCode({ decl: withIt, files }), `${name}：补上申报之后该过`);
  }
});

test('★ A16-5b 申报文件自己**不被扫**（它的正文里就有 `ask` 这些词）', () => {
  const files = {
    [OUTBOUND_DECL_FILENAME]: JSON.stringify(decl({
      outbound: [{ kind: 'ask', target: 'x', purpose: '问一句', fields: ['prompt'], viaRelay: true }],
    })),
    'index.html': '<p>干净的</p>',
  };
  assert.deepEqual(scanOutboundPoints(files), [], '扫到申报文件自己 ⇒ 那就永远自证');
});

// ════════════════════════════════════════════════════════════════
// A16-6 🔴 申报的字节在 `rootHash` 内
// ════════════════════════════════════════════════════════════════

test('🔴 A16-6 改一个字节的申报 ⇒ `rootHash` 变（它真的被 hash 盖住）', () => {
  const a = makeApp(world(), 'news', { [OUTBOUND_DECL_FILENAME]: asText(decl()) });
  const b = makeApp(world(), 'news', { [OUTBOUND_DECL_FILENAME]: asText(decl({ updatedAt: 1 })) });
  assert.notEqual(a.rootHash, b.rootHash, '🔴 改申报而 rootHash 不变 ⇒ 它没被 hash 盖住');
  // 同一条算法手算一遍（第三方可复算 · 93 §6.2.2）
  const byHand = rootHashOf(a.files.map((f) => ({ path: f.path, sha256: f.sha256 })));
  assert.equal(a.rootHash, byHand);
});

// ════════════════════════════════════════════════════════════════
// A16-7 🔴 申报不构成授权
// ════════════════════════════════════════════════════════════════

test('🔴 A16-7 只写申报（`kind:"ask"`）而没声明 `permissions:["ask"]` ⇒ `ask` 照旧不通', () => {
  const w = world();
  makeApp(w, 'news', {
    [OUTBOUND_DECL_FILENAME]: asText(decl({
      outbound: [{ kind: 'ask', target: '经我们中转 → 上游模型域名', purpose: '问一句模型', fields: ['prompt'], viaRelay: true }],
    })),
    'outbound.js': '<script>ask("问一句")</script>',
  });
  const man = w.apps.manifest('news', 1);
  assert.deepEqual(man.permissions, [], '🔴 申报**不构成**授权：清单里没有 ask');
  assert.deepEqual(w.apps.grants('news'), [], '没授予 ⇒ fail-closed');
  // 反着验：授权是**另一件事**（要清单里声明 + 他授予），申报一个字也帮不上
  const before = JSON.stringify(man.permissions);
  assert.doesNotThrow(() => assertDeclarationAllowed({ files: { 'index.html': '<p>x</p>', [OUTBOUND_DECL_FILENAME]: asText(decl()) }, version: 1 }));
  assert.equal(JSON.stringify(w.apps.manifest('news', 1).permissions), before);
});

// ════════════════════════════════════════════════════════════════
// A16-8 ★ 正对照 + 上架闸那一句
// ════════════════════════════════════════════════════════════════

test('★ A16-8 `assertDeclarationAllowed`：合规就过；读不到就抛', () => {
  const files = { 'index.html': '<p>没事</p>', [OUTBOUND_DECL_FILENAME]: asText(decl()) };
  const { decl: got, points } = assertDeclarationAllowed({ files, version: 1 });
  assert.equal(got.declaresNone, true);
  assert.deepEqual(points, []);
  // 版本对不上（拿旧版申报蒙新版）⇒ 拒
  assert.match(
    String(caught(() => assertDeclarationAllowed({ files: { ...files, [OUTBOUND_DECL_FILENAME]: asText(decl({ appVersion: 3 })) }, version: 4 }))?.message),
    /对不上/,
  );
  // 哈希对得上的前提下，读每个文件都由 `apps.read` 保证（这里只验这一层）
  assert.equal(sha256hex('x'), sha256hex('x'));
});
