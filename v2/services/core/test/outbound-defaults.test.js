// 98 §②③ **阶段 3**：默认值翻过来 —— 两格都读、按声明判、默认最严、没有自动生效路
// （契约 `docs/dev/98-STAGE3-DEFAULTS.md` §二／§三 · `docs/dev/92-TRIPLE-PLAN.md` §② 三条硬规矩）。
//
// ── 这一份钉什么（判据 S3-1…S3-6，每条都带反例）──────────
//   §S3-1 🔴 **两格同结论**：同一份内容 ＋ 同一份声明，放 `.exp/x/` 与 `.data/x/`
//          ⇒ `assertOutboundAllowed` 的裁决**逐字相同**。
//          反例：只看 `.exp/`（＝阶段 2 的实现）⇒ 放 `.data/` 时结论变 ⇒ 红。
//   §S3-2 🔴 **默认最严**：包目录在、`pack.json` 不在 ⇒ 两格**同结论（拒）**。
//          ★ 对照（不许误伤）：两格都放**合法**的声明而**不分享**（`share:false`／
//          `one-to-one`／`never`）⇒ 两格**都过**（不带出去**不需要锚**）。
//   §S3-3 🔴 **声明承重**：`share:true` ＋ 合法锚 ⇒ 过；**原样 `mv`** 到另一格
//          （内容与声明一个字节不动）⇒ **仍然过**；删掉声明 ⇒ 拒。
//   §S3-4 🔴 **两格都不存在 ⇒ 不拦**（他给自己做的 app 照旧能上架）。
//   §S3-5 🔴 **无自动生效路**（源码级）：每轮输入那一侧（`dispatcher.js`／
//          `session-translate.js`／`worlds.js`）**不出现** `.exp`／`.data` 这两个名字。
//   §S3-6 🔴 **认不出就拒**：坏 JSON ／ `schema` 不认 ／ `outbound` 取值不认 ／
//          `items` 不是数组 ⇒ 拒（两格一致）。
//
// 🔴 **判据打在真调那条闸上**（V13）：`assertOutboundAllowed` / `published.publish()`，
//    不是这一份自己算一遍。§S3-5 是**源码扫描**（那条判据本身就只能这么打）。
//
// ⚠️ 风格照仓库现有测试：不起 HTTP、不起进程；盘上用真临时目录。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { Apps } from '../src/apps.js';
import {
  DATA_DIRNAME,
  EXP_DIRNAME,
  PACK_DIRNAMES,
  assertOutboundAllowed,
  readPacks,
} from '../src/outbound.js';
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

function tmp(prefix = 'hupo-outbound-s3-') {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** 一套：一个人（制品库 ＋ 工作区）＋ 共享库（与 `outbound-gate.test.js` 同一摆法）。 */
function world() {
  const dir = tmp();
  const apps = new Apps({ dir, sub: 'u1' });
  const workspaces = new AppWorkspaces({ dir, log: () => {} });
  const published = new Published({ dir });
  return { dir, apps, workspaces, published };
}

const APP = { title: '新闻', icon: 'dice', entry: 'index.html' };

/** ★ **A16：制品里必须有外联申报**（读不到 ⇒ 上架拒）—— 这一组验的是出界闸，带上它。 */
const DECLARATION = JSON.stringify({
  schema: 1,
  outbound: [],
  declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '还没人用过，先按 0 报' },
});

function makeApp(w, id = 'news', body = '<p>第一版</p>') {
  w.apps.create({ id, ...APP, files: { 'index.html': body, 'outbound.json': DECLARATION } });
  return w.apps.manifest(id, w.apps.current(id));
}

/** 两格里的包目录（`<scope>/<cell>/<pack>/`）。 */
function packDir(w, id, cell, pack) {
  return nodePath.join(w.workspaces.dirFor(id), cell, pack);
}

/**
 * 写一份包声明。`json === undefined` ⇒ **只建目录、不写 `pack.json`**（造"读不到声明"）。
 * `json` 给字符串就原样写（造坏 JSON）。
 */
function writePack(w, id, cell, pack, json) {
  const dir = packDir(w, id, cell, pack);
  nodeFs.mkdirSync(dir, { recursive: true });
  if (json === undefined) {
    nodeFs.writeFileSync(nodePath.join(dir, 'note.md'), '同一份内容\n');
    return;
  }
  nodeFs.writeFileSync(
    nodePath.join(dir, 'pack.json'),
    typeof json === 'string' ? json : `${JSON.stringify(json, null, 2)}\n`,
  );
}

/** 同一份内容 ＋ 同一份声明的两个世界（`rootHash` 逐字相同 ⇒ 裁决才可比）。 */
function twins(body = '<p>同一份内容</p>') {
  const wA = world();
  const wB = world();
  const mA = makeApp(wA, 'news', body);
  const mB = makeApp(wB, 'news', body);
  assert.equal(mA.rootHash, mB.rootHash, '前提：两个世界里的这一版是同一份内容');
  return { wA, wB, rootHash: mA.rootHash };
}

/**
 * 🔴 **把真闸的裁决压成一个字符串**（V13：打的是 `assertOutboundAllowed` 本身）。
 * 过 ⇒ 连裁决一起记下来；拒 ⇒ 连错误名与逐字文案一起记下来。
 */
function verdict(w, id = 'news') {
  try {
    const r = assertOutboundAllowed({ route: 'publish', apps: w.apps, workspaces: w.workspaces, id });
    return `过 ${JSON.stringify(r)}`;
  } catch (err) {
    return `拒 ${err.name}: ${err.message}`;
  }
}

/** 抓一次抛。 */
function caught(fn) {
  try { fn(); return null; } catch (err) { return err; }
}

const sharedAppDir = (w, id) => nodePath.join(w.dir, 'published-apps', id);

const withAnchor = (rootHash) => ({
  schema: 1,
  expVersion: 1,
  items: [{ path: 'rank.md', kind: 'prompt', share: true, anchor: { rootHash } }],
});

const noAnchor = () => ({
  schema: 1,
  expVersion: 1,
  items: [{ path: 'rank.md', kind: 'prompt', share: true }],
});

// ════════════════════════════════════════════════════════════════
// §S3-1 🔴 两格同结论：同一份内容 ＋ 同一份声明 ⇒ 裁决逐字相同
// ════════════════════════════════════════════════════════════════

test('🔴 S3-1 同一份内容 ＋ 同一份声明：放 `.exp/` 与放 `.data/` ⇒ 裁决**逐字相同**', () => {
  // 六种声明形状（含"读不到"、"坏 JSON"、"取值不认"）：每一种都两格各放一遍比裁决
  const shapes = [
    ['没有 pack.json', undefined],
    ['坏 JSON', '{这不是 json'],
    ['无锚的 share:true', noAnchor()],
    ['`outbound` 取值不认', { schema: 1, outbound: '也许吧', items: [] }],
    ['`one-to-one`（数据包）', { schema: 1, outbound: 'one-to-one', items: [] }],
    ['`never`（永不出）', { schema: 1, outbound: 'never', items: [] }],
  ];
  for (const [name, json] of shapes) {
    const { wA, wB, rootHash } = twins();
    writePack(wA, 'news', EXP_DIRNAME, 'x', json);
    writePack(wB, 'news', DATA_DIRNAME, 'x', json);
    const a = verdict(wA);
    const b = verdict(wB);
    assert.equal(b, a, `🔴 ${name}：两格必须同结论（逐字）——.exp=${a} ／ .data=${b}`);
    // 带锚的那种另比一遍（同一个 rootHash ⇒ 应当都过、且 share 逐字相同）
    writePack(wA, 'news', EXP_DIRNAME, 'x', withAnchor(rootHash));
    writePack(wB, 'news', DATA_DIRNAME, 'x', withAnchor(rootHash));
    const a2 = verdict(wA);
    const b2 = verdict(wB);
    assert.equal(b2, a2, `🔴 带锚的 share：两格必须同结论 —— .exp=${a2} ／ .data=${b2}`);
    assert.match(a2, /^过 /, `★ 对照：带锚的 share 必须过（否则这一条是空转）：${a2}`);
  }
});

test('🔴 S3-1 两格**同时**有同名的包 ⇒ 各自按自己的声明判（不许报错、不许取其一）', () => {
  // ① 两格同名、都是 `never` ⇒ 两边都读了、都判了 ⇒ 过
  const w1 = world();
  makeApp(w1);
  writePack(w1, 'news', EXP_DIRNAME, 'x', { schema: 1, outbound: 'never', items: [] });
  writePack(w1, 'news', DATA_DIRNAME, 'x', { schema: 1, outbound: 'never', items: [] });
  assert.match(verdict(w1), /^过 /);

  // ② 两格同名、都声明可分享且带锚 ⇒ **两条都在**（同一个包名出现两次也是两份独立的包）
  const w2 = world();
  const m2 = makeApp(w2);
  writePack(w2, 'news', EXP_DIRNAME, 'x', withAnchor(m2.rootHash));
  writePack(w2, 'news', DATA_DIRNAME, 'x', withAnchor(m2.rootHash));
  const out = assertOutboundAllowed({ route: 'publish', apps: w2.apps, workspaces: w2.workspaces, id: 'news' });
  assert.equal(out.share.length, 2, `🔴 两格各一份 ⇒ 两条都要被读到：${JSON.stringify(out.share)}`);

  // ③ 同名不算数：`.exp/x` 是 `never`，`.data/x` 可分享却无锚 ⇒ **照拒**
  //    （反例：谁"取其一"或按目录名跳过 `.data/` ⇒ 这里会放行 ⇒ 红）
  const w3 = world();
  makeApp(w3);
  writePack(w3, 'news', EXP_DIRNAME, 'x', { schema: 1, outbound: 'never', items: [] });
  writePack(w3, 'news', DATA_DIRNAME, 'x', noAnchor());
  assert.match(verdict(w3), /^拒 /, '🔴 `.data/` 那一份也必须判；同名不是豁免');

  // ④ 反过来：`.exp/x` 可分享却无锚，`.data/x` 是 `never` ⇒ 同样拒
  const w4 = world();
  makeApp(w4);
  writePack(w4, 'news', EXP_DIRNAME, 'x', noAnchor());
  writePack(w4, 'news', DATA_DIRNAME, 'x', { schema: 1, outbound: 'never', items: [] });
  assert.match(verdict(w4), /^拒 /);
});

// ════════════════════════════════════════════════════════════════
// §S3-2 🔴 默认最严：读不到声明 ⇒ 拒；★ 合法的"不分享" ⇒ 照过
// ════════════════════════════════════════════════════════════════

test('🔴 S3-2 包目录在、`pack.json` 不在 ⇒ 两格**同结论（拒）**；两格一起也在 ⇒ 拒', () => {
  const { wA, wB } = twins();
  writePack(wA, 'news', EXP_DIRNAME, 'x', undefined);
  writePack(wB, 'news', DATA_DIRNAME, 'x', undefined);
  const a = verdict(wA);
  const b = verdict(wB);
  assert.match(a, /^拒 OutboundError: /, `🔴 读不到声明就不许出去（不是"当没有"）：${a}`);
  assert.match(a, /没有可读的 pack\.json/);
  assert.equal(b, a, `🔴 两格同结论（逐字）：.exp=${a} ／ .data=${b}`);

  // 两格都有（同名）⇒ 也是拒（第一格先报，但结论不变）
  const wC = world();
  makeApp(wC);
  writePack(wC, 'news', EXP_DIRNAME, 'x', undefined);
  writePack(wC, 'news', DATA_DIRNAME, 'x', undefined);
  assert.match(verdict(wC), /^拒 /);

  // 真闸那条路：拒的时候共享库零残留
  const err = caught(() => wA.published.publish(wA.apps, { id: 'news', authorSub: 'u1' }));
  assert.ok(err);
  assert.equal(nodeFs.existsSync(sharedAppDir(wA, 'news')), false, '盘上零残留');
});

test('★ S3-2 对照：合法声明而**不分享**（`share:false`／`one-to-one`／`never`）⇒ 两格**都过**', () => {
  const notShared = [
    ['`share:false`（逐条）', { schema: 1, expVersion: 1, items: [{ path: 'a.md', kind: 'note', share: false }] }],
    ['`outbound:one-to-one`（数据包）', { schema: 1, outbound: 'one-to-one', items: [] }],
    ['`outbound:never`（缓存／记忆／账）', { schema: 1, outbound: 'never', items: [] }],
  ];
  for (const [name, json] of notShared) {
    for (const cell of PACK_DIRNAMES) {
      const w = world();
      makeApp(w);
      writePack(w, 'news', cell, 'x', json);
      const v = verdict(w);
      assert.match(v, /^过 /, `★ ${name}（住 ${cell}/）**不带出去** ⇒ 必须过，不是拒：${v}`);
      // 真闸那条路也要过：真发一次 ⇒ 共享库里真有一份（正对照不许是空跑）
      const idx = w.published.publish(w.apps, { id: 'news', authorSub: 'u1' });
      assert.equal(idx.id, 'news');
      assert.equal(
        nodeFs.existsSync(nodePath.join(sharedAppDir(w, 'news'), 'versions', '1', 'index.html')),
        true,
        `${name}（住 ${cell}/）：真的复制进共享库了`,
      );
    }
  }

  // 两格同时放同一种合法声明 ⇒ 也过（两格都读了、都没有要出去的）
  const w2 = world();
  makeApp(w2);
  for (const cell of PACK_DIRNAMES) {
    writePack(w2, 'news', cell, 'x', { schema: 1, outbound: 'never', items: [] });
  }
  assert.match(verdict(w2), /^过 /);
});

// ════════════════════════════════════════════════════════════════
// §S3-3 🔴 声明承重：原样 mv 到另一格 ⇒ 结论不变
// ════════════════════════════════════════════════════════════════

test('🔴 S3-3 `share`＋锚 ⇒ 过；**原样 mv 到另一格** ⇒ 仍然过；删掉声明 ⇒ 拒', () => {
  for (const [from, to] of [[EXP_DIRNAME, DATA_DIRNAME], [DATA_DIRNAME, EXP_DIRNAME]]) {
    const w = world();
    const man = makeApp(w);
    writePack(w, 'news', from, 'notes', withAnchor(man.rootHash));

    // ① 起点：过（真上架一次）
    const first = w.published.publish(w.apps, { id: 'news', authorSub: 'u1' });
    assert.equal(first.rootHash, man.rootHash, `(${from}→${to}) 起点必须过`);

    // ② **原样 mv**：内容与声明一个字节不动（先把目标那一格的目录建出来）
    const src = packDir(w, 'news', from, 'notes');
    const dst = packDir(w, 'news', to, 'notes');
    const bytesBefore = nodeFs.readFileSync(nodePath.join(src, 'pack.json'), 'utf8');
    nodeFs.mkdirSync(nodePath.dirname(dst), { recursive: true });
    nodeFs.renameSync(src, dst);
    const bytesAfter = nodeFs.readFileSync(nodePath.join(dst, 'pack.json'), 'utf8');
    assert.equal(bytesAfter, bytesBefore, '🔴 mv 必须是原样（逐字节相同）');

    // ③ 仍然过 —— 而且带出去的 share 逐条不变
    const again = w.published.publish(w.apps, { id: 'news', authorSub: 'u1' });
    assert.equal(again.rootHash, man.rootHash, `🔴 搬到 ${to}/ 之后必须照样过（目录名不承重）`);
    assert.deepEqual(
      assertOutboundAllowed({ route: 'publish', apps: w.apps, workspaces: w.workspaces, id: 'news' }).share,
      [{ pack: 'notes', path: 'rank.md', anchor: man.rootHash }],
      '🔴 搬完之后带出去的条目逐条不变',
    );

    // ④ 删掉声明 ⇒ 拒（未归类 = 永不出）
    nodeFs.rmSync(nodePath.join(dst, 'pack.json'));
    const err = caught(() => w.published.publish(w.apps, { id: 'news', authorSub: 'u1' }));
    assert.ok(err, `🔴 声明删掉 ⇒ 必须拒（在 ${to}/ 里也一样）`);
    assert.match(err.message, /没有可读的 pack\.json/);
  }
});

// ════════════════════════════════════════════════════════════════
// §S3-4 🔴 两格都不存在 ⇒ 不拦（本地自用照旧能上架）
// ════════════════════════════════════════════════════════════════

test('🔴 S3-4 两格都不存在 ⇒ **不拦**（他给自己做的 app 照旧能上架）', () => {
  const w = world();
  const man = makeApp(w);
  const scope = w.workspaces.dirFor('news');
  assert.equal(nodeFs.existsSync(nodePath.join(scope, EXP_DIRNAME)), false, '前提：没有 `.exp/`');
  assert.equal(nodeFs.existsSync(nodePath.join(scope, DATA_DIRNAME)), false, '前提：没有 `.data/`');
  assert.deepEqual(readPacks({ scopeDir: scope }), [], '两格都没有 ⇒ 一份申报都没有');

  const out = assertOutboundAllowed({ route: 'publish', apps: w.apps, workspaces: w.workspaces, id: 'news' });
  assert.deepEqual(out.share, [], '没有申报 ⇒ 没有要带出去的条目');
  const idx = w.published.publish(w.apps, { id: 'news', authorSub: 'u1' });
  assert.equal(idx.rootHash, man.rootHash);
  assert.equal(
    nodeFs.existsSync(nodePath.join(sharedAppDir(w, 'news'), 'versions', '1', 'index.html')),
    true,
    '★ 真的上架了（正对照不许是空跑）',
  );
});

// ════════════════════════════════════════════════════════════════
// §S3-5 🔴 无自动生效路（源码级判据）
// ════════════════════════════════════════════════════════════════

/** 去掉注释（判据只认**代码**里的字，不认解释里的 —— 照 `outbound-gate.test.js` 同款）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * 这一段源码里有没有"碰 `.exp`／`.data`"的字面。
 *
 * ⚠️ 认的是**路径段**那个名字：前面不能是标识符字符（`ev.data` 的 `.data` 不算），
 *    也不能是可选链的 `?.`（`params?.event?.data` 同样不算）—— 那两个都是**字段**，
 *    不是同名目录。
 *    另外连**常量名**与**读取函数名**一起认：`EXP_DIRNAME`／`DATA_DIRNAME`／
 *    `readPacks`／`readExpPacks` —— 有人绕开字面量、改成 import 那个常量，同样要红。
 */
function forbiddenHits(src) {
  const code = stripComments(src);
  const hits = [];
  const seg = /(^|[^A-Za-z0-9_$?.])\.(exp|data)(?![A-Za-z0-9_$])/g;
  let m;
  while ((m = seg.exec(code)) !== null) hits.push(`路径段「.${m[2]}」`);
  const id = /\b(EXP_DIRNAME|DATA_DIRNAME|readPacks|readExpPacks)\b/g;
  while ((m = id.exec(code)) !== null) hits.push(`名字「${m[1]}」`);
  return hits;
}

/** 每轮输入那一侧：**这三份**文件（98 §二③）。 */
const TURN_INPUT_FILES = ['dispatcher.js', 'session-translate.js', 'worlds.js'];

test('🔴 S3-5 每轮输入那一侧不许出现 `.exp`／`.data` —— 今天天然成立，钉成判据', () => {
  for (const name of TURN_INPUT_FILES) {
    const src = nodeFs.readFileSync(nodePath.join(SRC, name), 'utf8');
    const hits = forbiddenHits(src);
    assert.deepEqual(
      hits,
      [],
      `🔴 ${name} 里出现了申报那一格的名字 ⇒ 每轮输入有可能自动读到它：${JSON.stringify(hits)}`,
    );
  }
  // 读它们的字节只许发生在 `outbound.js`（声明读取）——这里顺带钉一下"那边确实在读"
  const gate = stripComments(nodeFs.readFileSync(nodePath.join(SRC, 'outbound.js'), 'utf8'));
  assert.match(gate, /PACK_DIRNAMES|EXP_DIRNAME/, '出界闸那边才是读这两格的地方');
});

test('🔴 S3-5 这条判据**不是恒真**：塞进一行读 `.exp/x/pack.json` ⇒ 当场命中', () => {
  // 反例①：正是 98 §二③ 点名的那一行
  const bad = "const raw = nodeFs.readFileSync(nodePath.join(scopeDir, '.exp', 'x', 'pack.json'), 'utf8');";
  assert.notDeepEqual(forbiddenHits(bad), [], '🔴 塞一行读 `.exp/x/pack.json` 必须被扫出来');
  // 反例②：绕开字面量，改 import 常量
  assert.notDeepEqual(forbiddenHits("import { EXP_DIRNAME } from './outbound.js';"), [], '🔴 常量名也算');
  assert.notDeepEqual(forbiddenHits("nodePath.join(scope, '.data')"), [], '🔴 `.data` 同样要命中');
  // ⚠️ 负对照：今天真实存在的 `event.data` **不许**被误伤（否则这条判据会假红）
  assert.deepEqual(forbiddenHits('if (isAuthFailure(params?.event?.data)) {'), [], '字段名 `.data` 不是目录名');
  assert.deepEqual(forbiddenHits("const { data } = ev;"), []);
});

// ════════════════════════════════════════════════════════════════
// §S3-6 🔴 认不出就拒（两格一致）
// ════════════════════════════════════════════════════════════════

test('🔴 S3-6 坏 JSON ／ `schema` 不认 ／ `outbound` 取值不认 ／ `items` 不是数组 ⇒ 拒（两格一致）', () => {
  const cases = [
    { name: '坏 JSON', json: '{这不是 json', want: /看不懂/ },
    { name: '声明不是对象', json: '[1,2,3]', want: /不是一份对象/ },
    { name: 'schema 不认', json: { schema: 99, items: [] }, want: /声明版本认不出/ },
    { name: 'outbound 取值不认', json: { schema: 1, outbound: 'maybe', items: [] }, want: /出去律认不出/ },
    { name: 'outbound 是数字', json: { schema: 1, outbound: 1, items: [] }, want: /出去律认不出/ },
    { name: 'items 不是数组', json: { schema: 1, items: 'later' }, want: /没有条目表/ },
    { name: 'items 缺了', json: { schema: 1 }, want: /没有条目表/ },
  ];
  for (const c of cases) {
    const { wA, wB } = twins();
    writePack(wA, 'news', EXP_DIRNAME, 'x', c.json);
    writePack(wB, 'news', DATA_DIRNAME, 'x', c.json);
    const a = verdict(wA);
    const b = verdict(wB);
    assert.match(a, /^拒 /, `🔴 ${c.name} ⇒ 必须拒（fail-closed，不是"当没有"）：${a}`);
    assert.match(a, c.want, `${c.name}：${a}`);
    assert.equal(b, a, `🔴 ${c.name}：两格必须同结论（逐字）：.exp=${a} ／ .data=${b}`);
    // 真闸：拒的时候共享库零残留
    const err = caught(() => wA.published.publish(wA.apps, { id: 'news', authorSub: 'u1' }));
    assert.ok(err, `${c.name}：上架也必须拒`);
    assert.equal(nodeFs.existsSync(sharedAppDir(wA, 'news')), false, `${c.name}：盘上零残留`);
  }
});

test('🔴 S3-6 `outbound` 取值不认时**不许**当成"没写"退回逐条 `share`（否则会静默放行）', () => {
  const w = world();
  const man = makeApp(w);
  // 带锚的 share:true ＋ 一个认不出的包级取值 ⇒ 若被当成"没写"就会放行
  writePack(w, 'news', EXP_DIRNAME, 'x', {
    schema: 1,
    outbound: 'shrae',
    items: [{ path: 'rank.md', kind: 'prompt', share: true, anchor: { rootHash: man.rootHash } }],
  });
  assert.match(verdict(w), /^拒 /, '🔴 认不出的取值必须拒，不许悄悄退回逐条判');
});
