// **D4.24 · B1／A3·补·二**：共享库 `index.json` 的作者假名换成**带键 HMAC**
// （`cred-hash.js` 的口径：同一把键、同一个域 `hupo-cred-v1`）—— 还的是账本 `#73`：
// 原来那一格是 **`sha256(sub)` 的前 12 位**（裸 sha256 截断），而 `sub` 可枚举
// ⇒ 能穷举反推 ⇒ 与 B1「真身份不给」冲突。
//
// ── 这一格**承重**（改法由它决定）────────────────────────────
//   · `publish` 的重名判（"这个名字被别人用了"）
//   · `unpublish` 的"这一条不是你发的"
//   · `discover` 的"哪条是我自己发的"（工具侧 `app_discover` 按它分"别人的"）
//   ⇒ 而**存量 `index.json`（真机上的 `published-apps/coin`）写的是旧口径**
//   ⇒ 改法是 **"读得出老值、只写新值"**：读走 `readAuthorHash`（新旧都认，
//   认不出一律 fail-closed），写永远走 `authorHashOf`（新口径）。见 `docs/dev/163`。
//
// ── 判据（每条都带**负向对照**）──────────────────────────────
//   ① 新写入的 `index.json` 搜不到旧口径的值、也搜不到身份明文（搜索器先证明抓得住）；
//   ② 同一身份稳定 ＋ 两个人不撞（换一个 `sub` ⇒ 值必须变）＋ **换键就换值**（带键的证明）；
//   ③ 存量照旧：拿一份**旧口径**的 `index.json` 走"上架 → 装上 → 读得出那份内容"；
//   ③·负向 把**新写的值当老值读** ⇒ 走"读不出来"的分支，**不许**误判成别人；
//   ④ 发现页的 `mine`：旧值也认（不许把本人发的那条误判成"别人发的"）；
//   ⑤ 接线（源码级）：`worlds` 把凭据键交给 app 口、昵称同键；读走 `readAuthorHash`。

import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test, { after } from 'node:test';

import { Apps } from '../src/apps.js';
import { credHashOf } from '../src/cred-hash.js';
import {
  PUBLISHED_DIR, Published, authorHashOf, legacyAuthorHashOf, readAuthorHash,
} from '../src/published.js';

const KEY = Buffer.from('a'.repeat(64), 'hex');
const KEY2 = Buffer.from('b'.repeat(64), 'hex');
const OWNER = 'owner';

const APP_FILES = Object.freeze({
  'index.html': '<!doctype html><p>掷硬币</p>',
  'outbound.json': JSON.stringify({
    schema: 1,
    outbound: [],
    declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '先按 0 报' },
  }),
});

const dirs = [];
after(() => {
  for (const d of dirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});

function tmp(tag) {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), `hupo-${tag}-`));
  dirs.push(d);
  return d;
}

/** 作者自己那一格：里面有一个 `coin`。 */
function authorApps(sub = OWNER, key = null, id = 'coin') {
  const apps = new Apps({ dir: tmp('own'), sub, credKey: key });
  apps.create({ id, title: '掷硬币', icon: 'dice', entry: 'index.html', files: { ...APP_FILES } });
  return apps;
}

/**
 * 一份**真机同形状**的老夹具：`index.json` 里的 `authorHash` 是**旧口径**
 * （真机上那份 `coin` 就是 `4c1029697ee3` = `sha256("owner")[:12]`）。
 */
function legacySharedFixture(root, { id = 'coin', sub = OWNER, version = 1, rootHash }) {
  const appDir = nodePath.join(root, PUBLISHED_DIR, id);
  const vdir = nodePath.join(appDir, 'versions', String(version));
  nodeFs.mkdirSync(vdir, { recursive: true });
  for (const [rel, body] of Object.entries(APP_FILES)) {
    const p = nodePath.join(vdir, rel);
    nodeFs.mkdirSync(nodePath.dirname(p), { recursive: true });
    nodeFs.writeFileSync(p, body);
  }
  const legacy = legacyAuthorHashOf(sub);
  const index = {
    schema: 1,
    id,
    title: '掷硬币',
    icon: 'dice',
    entry: 'index.html',
    version,
    rootHash,
    permissions: [],
    authorHash: legacy,
    authorName: `用户 ${legacy.slice(0, 4)}`,
    publishedAt: 1,
    published: true,
  };
  nodeFs.writeFileSync(nodePath.join(appDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  return { appDir, legacy };
}

const readIndex = (pub, id) => JSON.parse(nodeFs.readFileSync(nodePath.join(pub.appDir(id), 'index.json'), 'utf8'));

// ════════════════════════════════════════════════════════════
// ① 新写入的 index.json：旧值 / 身份明文都零命中（含搜索器负向对照）
// ════════════════════════════════════════════════════════════
test('A3·补·二① 新写入的 `index.json` 搜不到旧口径的值，也搜不到身份明文', () => {
  const pub = new Published({ dir: tmp('newhash'), credKey: KEY });
  const apps = authorApps(OWNER, KEY);
  const legacy = legacyAuthorHashOf(OWNER);
  const name = `用户 ${authorHashOf(OWNER, KEY).slice(0, 4)}`;

  const idx = pub.publish(apps, { id: 'coin', authorSub: OWNER, authorName: name });
  const text = nodeFs.readFileSync(nodePath.join(pub.appDir('coin'), 'index.json'), 'utf8');

  // ── 负向对照：搜索器不是恒假 —— 一份**旧口径 ＋ 明文身份**的样本必须被抓出来
  const leaky = `{"authorHash":"${legacy}","authorName":"用户 ${legacy.slice(0, 4)}","sub":"${OWNER}"}`;
  assert.equal(leaky.includes(legacy), true, '搜索器负向对照：旧口径的值要抓得住');
  assert.equal(leaky.includes(`用户 ${legacy.slice(0, 4)}`), true, '搜索器负向对照：旧昵称要抓得住');
  assert.equal(leaky.includes(OWNER), true, '搜索器负向对照：身份明文要抓得住');

  // ── 真写入的这份：三种搜法都零命中
  assert.equal(text.includes(legacy), false, '🔴 旧口径（裸 sha256 前 12 位）不许出现');
  assert.equal(text.includes(`用户 ${legacy.slice(0, 4)}`), false, '🔴 旧口径推出来的昵称也不许出现');
  assert.equal(text.includes(OWNER), false, '🔴 身份明文不许出现');

  assert.equal(idx.authorHash, credHashOf(OWNER, KEY), '口径 = `credHashOf(sub, 键)`（带键 HMAC）');
  assert.equal(idx.authorHash, authorHashOf(OWNER, KEY), '`authorHashOf` 与审计那套是同一个口径');
  assert.match(idx.authorHash, /^[0-9a-f]{64}$/u, '新值 = 64 位十六进制（HMAC-SHA256）');
  assert.notEqual(idx.authorHash, nodeCrypto.createHash('sha256').update(OWNER).digest('hex'), '不是裸 sha256');
});

// ════════════════════════════════════════════════════════════
// ② 稳定 ＋ 两个人不撞（换 sub ⇒ 值变）＋ 换键就换值（带键的证明）
// ════════════════════════════════════════════════════════════
test('A3·补·二② 同一身份稳定、两个人不撞、换键就换值（证明不是裸 sha256）', () => {
  const ownerA = new Published({ dir: tmp('stable-a'), credKey: KEY });
  const ownerB = new Published({ dir: tmp('stable-b'), credKey: KEY });
  const other = new Published({ dir: tmp('stable-c'), credKey: KEY });
  const ownerKey2 = new Published({ dir: tmp('stable-d'), credKey: KEY2 });

  const one = ownerA.publish(authorApps(OWNER, KEY, 'coin'), { id: 'coin', authorSub: OWNER, authorName: '甲' });
  // 同一身份、另一条 app、**另一个共享库实例** ⇒ 值必须一模一样（能对账）
  const two = ownerB.publish(authorApps(OWNER, KEY, 'dice'), { id: 'dice', authorSub: OWNER, authorName: '甲' });
  // 负向对照：换一个 `sub` ⇒ 值必须变
  const u2 = other.publish(authorApps('u2', KEY, 'coin'), { id: 'coin', authorSub: 'u2', authorName: '乙' });
  // 负向对照：换一把键 ⇒ 同一个人的值也必须变（"手里没有那把键就推不回来"）
  const keyed = ownerKey2.publish(authorApps(OWNER, KEY2, 'coin'), { id: 'coin', authorSub: OWNER, authorName: '甲' });

  assert.equal(one.authorHash, two.authorHash, '同一个身份每次都要落到同一个值（稳定假名）');
  assert.equal(one.authorHash, credHashOf(OWNER, KEY), '口径 = `credHashOf(sub, 键)`');
  assert.notEqual(one.authorHash, u2.authorHash, '🔴 两个人不许撞成同一个值（负向对照：换 sub ⇒ 值变）');
  assert.notEqual(one.authorHash, keyed.authorHash, '🔴 换键 ⇒ 换值（带键的证明）');
  assert.notEqual(one.authorHash, legacyAuthorHashOf(OWNER), '不是旧口径那个可枚举反推的值');
  assert.notEqual(one.authorHash, credHashOf(OWNER, null), '也不是退化键推出来的那个值');
});

// ════════════════════════════════════════════════════════════
// ③ 存量照旧：老 index.json 走"上架 → 装上 → 读得出那份内容"；本人撤得下来
// ════════════════════════════════════════════════════════════
test('A3·补·二③ 存量照旧：旧口径那条照旧能上架/装上；写下去的是新口径', () => {
  const shared = tmp('legacy-shared');
  const A = authorApps(OWNER, KEY);
  const rootHash = A.manifest('coin', A.current('coin')).rootHash;
  const { appDir, legacy } = legacySharedFixture(shared, { rootHash });
  const pub = new Published({ dir: shared, credKey: KEY });

  // 真机那份长什么样，先钉住（免得夹具自己漂）
  assert.equal(readIndex(pub, 'coin').authorHash, legacy);
  assert.equal(legacy, nodeCrypto.createHash('sha256').update(OWNER).digest('hex').slice(0, 12), '旧口径 = 裸 sha256 前 12 位');
  assert.equal(legacy, '4c1029697ee3', '真机 `published-apps/coin/index.json` 里就是这一串（夹具照它造）');

  // ── 负向对照（上架前）：**别人**拿同一个 id 发 ⇒ 拒（旧值认得出不是他）
  assert.throws(
    () => pub.publish(authorApps('u2', KEY, 'coin'), { id: 'coin', authorSub: 'u2', authorName: '乙' }),
    /被别人用了/,
    '旧口径那条也要拦得住别人（重名判不许因为换了口径就失灵）',
  );
  assert.throws(() => pub.unpublish('coin', 'u2'), /不是你发的/, '旧口径那条例外：别人也撤不下来');

  // ── ★ 存量**本人**那条：旧值必须读得出 ⇒ 他照旧能把自己那条**撤下来**
  //    （"只写新值"≠ 让老条目变成没人认领；变异实测：退回"直接比哈希" ⇒ 这里当场红）
  assert.equal(pub.unpublish('coin', OWNER).published, false, '旧口径那条：本人照旧撤得下来');

  // ── ① 上架：**本人**更新自己那条旧口径的条目 ⇒ 照旧通，而且写下去的是新口径
  const updated = pub.publish(A, { id: 'coin', authorSub: OWNER, authorName: `用户 ${authorHashOf(OWNER, KEY).slice(0, 4)}` });
  assert.equal(updated.authorHash, credHashOf(OWNER, KEY), '写下去的必须是新口径');
  const onDisk = readIndex(pub, 'coin');
  assert.equal(onDisk.authorHash, credHashOf(OWNER, KEY), '盘上那一格也换了新口径');
  assert.equal(nodeFs.readFileSync(nodePath.join(appDir, 'index.json'), 'utf8').includes(legacy), false, '旧值不再出现在新写的 index.json 里');

  // ── ② 装上：乙那一格真拿到一份，而且字节就是那一版
  const B = new Apps({ dir: tmp('installer'), sub: 'u2' });
  const got = pub.installInto(B, 'coin');
  assert.equal(B.read(got.id, got.version, 'index.html').content.toString('utf8'), APP_FILES['index.html'], '装上之后读得出的就是那一版（打开那条路的字节）');

  // ── ③ 下架：本人照旧撤得下来
  assert.equal(pub.unpublish('coin', OWNER).published, false, '本人撤得下来');

  // ── 负向对照（换新口径之后）：别人撤不下来
  const fresh = new Published({ dir: tmp('legacy-shared-2'), credKey: KEY });
  const A2 = authorApps(OWNER, KEY);
  const rh2 = A2.manifest('coin', A2.current('coin')).rootHash;
  legacySharedFixture(fresh.dir, { rootHash: rh2 });
  fresh.publish(A2, { id: 'coin', authorSub: OWNER, authorName: '甲' });
  assert.throws(() => fresh.unpublish('coin', 'u2'), /不是你发的/, '别人不许撤（新口径也是）');
  assert.equal(fresh.unpublish('coin', OWNER).published, false, '本人照旧撤得下来');
});

test('A3·补·二③·补 旧口径那条**原样留在盘上**（只写新值 ≠ 回头改老值）', () => {
  const shared = tmp('legacy-untouched');
  const A = authorApps(OWNER, KEY);
  const rootHash = A.manifest('coin', A.current('coin')).rootHash;
  const { appDir, legacy } = legacySharedFixture(shared, { rootHash });
  const before = nodeFs.readFileSync(nodePath.join(appDir, 'index.json'));
  const pub = new Published({ dir: shared, credKey: KEY });
  // 只做**读**（发现/索引）⇒ 盘上一个字节都不许动
  pub.discover({ sub: OWNER, key: KEY });
  pub.index('coin');
  const after = nodeFs.readFileSync(nodePath.join(appDir, 'index.json'));
  assert.equal(after.equals(before), true, '只读那两条路不许改存量（旧值原样）');
  assert.equal(JSON.parse(after.toString('utf8')).authorHash, legacy, '旧值照旧在（读得出老值）');
});

// ════════════════════════════════════════════════════════════
// ③·负向 把**新写的值当老值读** ⇒ "读不出来"（fail-closed），绝不误判成别人
// ════════════════════════════════════════════════════════════
test('A3·补·二③·负向 新值当旧值读 ⇒ 读不出来；换人/换键一律 null（不许误判成别人）', () => {
  const pub = new Published({ dir: tmp('newval'), credKey: KEY });
  pub.publish(authorApps(OWNER, KEY, 'coin'), { id: 'coin', authorSub: OWNER, authorName: '甲' });
  const stored = pub.index('coin').authorHash;

  // 旧读法（= 改前那一行 `prev.authorHash !== sha256(sub)[:12]`）：
  // 对新值一个字都认不出 ⇒ 走"读不出来"的分支
  assert.equal(stored === legacyAuthorHashOf(OWNER), false, '旧读法读不出本人（fail-closed）');
  assert.equal(stored === legacyAuthorHashOf('u2'), false, '🔴 更不许把新值算成**别人**的');

  // 真正承重的那条：认不出 ⇒ 一律 null
  assert.equal(readAuthorHash(stored, OWNER, KEY), 'cred', '本人（同一把键）读得出来');
  assert.equal(readAuthorHash(stored, 'u2', KEY), null, '别人读不出来');
  assert.equal(readAuthorHash(stored, OWNER, KEY2), null, '换键 ⇒ 同一个人的新值也读不出来');
  assert.equal(readAuthorHash(stored, OWNER, null), null, '不给键（退化键）也读不出来');
  assert.equal(readAuthorHash('', OWNER, KEY), null, '空格子 ⇒ 读不出来（不是"那就是他"）');

  // 落到承重那两条路上：读不出来 = 明确拒，不是放行
  assert.throws(() => pub.unpublish('coin', 'u2'), /不是你发的/, '别人撤 ⇒ 拒');
  assert.throws(() => new Published({ dir: pub.dir, credKey: KEY2 }).unpublish('coin', OWNER), /不是你发的/, '换键之后连本人也拒（fail-closed）');
  assert.throws(
    () => new Published({ dir: pub.dir, credKey: KEY2 }).publish(authorApps(OWNER, KEY2, 'coin'), { id: 'coin', authorSub: OWNER, authorName: '甲' }),
    /被别人用了/,
    '换键之后同名也发不上去（读不出来 ⇒ 当"别人的"）',
  );
});

// ════════════════════════════════════════════════════════════
// ④ 发现页的 `mine`：旧值也认（不许把本人那条误判成"别人发的"）
// ════════════════════════════════════════════════════════════
test('A3·补·二④ 发现页的"哪条是我发的"：旧值也认成自己的，别人不认', () => {
  const shared = tmp('discover');
  const A = authorApps(OWNER, KEY);
  const rootHash = A.manifest('coin', A.current('coin')).rootHash;
  legacySharedFixture(shared, { rootHash });
  const pub = new Published({ dir: shared, credKey: KEY });

  assert.equal(pub.discover({ sub: OWNER, key: KEY }).find((a) => a.id === 'coin').mine, true, '存量旧值：本人必须认成自己的');
  assert.equal(pub.discover({ sub: 'u2', key: KEY }).find((a) => a.id === 'coin').mine, false, '别人不许认成自己的');
  // ⚠️ 旧值是**不挑键**的（它压根不是带键推出来的）⇒ 换一把键本人照样认得出 ——
  //    这是"读得出老值"必然的代价，如实钉在这儿；要紧的是**不许认成别人**：
  assert.equal(pub.discover({ sub: OWNER, key: KEY2 }).find((a) => a.id === 'coin').mine, true, '旧值不挑键（读得出老值）');
  assert.equal(pub.discover({ sub: 'u2', key: KEY2 }).find((a) => a.id === 'coin').mine, false, '换键也好、不换也好，别人都不许认成自己的');
  // 不给"这是谁" ⇒ 形状与以前一字不差（没有 mine 那一格）
  assert.equal('mine' in pub.discover()[0], false, '不给身份时形状不变');
  // 旧值原样在盘上（`discover` 是只读）
  assert.equal(pub.index('coin').authorHash, legacyAuthorHashOf(OWNER), '只读那条路不许动存量');

  // 换新口径之后再发现：本人照旧认得出
  pub.publish(A, { id: 'coin', authorSub: OWNER, authorName: '甲' });
  assert.equal(pub.discover({ sub: OWNER, key: KEY }).find((a) => a.id === 'coin').mine, true, '新口径：本人认得出');
  assert.equal(pub.discover({ sub: 'u2', key: KEY }).find((a) => a.id === 'coin').mine, false, '新口径：别人不认');
});

// ════════════════════════════════════════════════════════════
// ⑤ 接线（源码级）：防止"写好了没接上"
// ════════════════════════════════════════════════════════════
test('A3·补·二⑤ 接线：app 口拿到凭据键；读写走 `readAuthorHash`；工具侧按 `mine` 分', () => {
  const read = (rel) => nodeFs.readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8');

  const worlds = read('worlds.js');
  assert.match(worlds, /ctx:\s*\{[\s\S]{0,400}?credKey:\s*this\.#credKey/u, 'app 口那条 ctx 要带凭据键');
  assert.match(worlds, /authorHashOf\(t\.userId,\s*this\.#credKey\)/u, '对外昵称也要同一把键（不然它还是旧的裸 sha256）');

  const pub = read('published.js');
  assert.match(pub, /readAuthorHash\(prev\.authorHash, authorSub, this\.credKey\)/u, '重名判/下架判要走 `readAuthorHash`（读得出老值）');
  assert.match(pub, /authorHashOf\(authorSub, this\.credKey\)/u, '写永远走新口径');

  const socket = read('apps-socket.js');
  assert.match(socket, /discover\(\{\s*sub:\s*ctx\.sub \?\? null,\s*key:\s*ctx\.credKey \?\? null\s*\}\)/u, 'discover 要把"这是谁"交给共享库判');
  assert.match(socket, /authorHashOf\(ctx\.sub \?\? '',\s*ctx\.credKey \?\? null\)/u, '`me` 那一格也要同一把键');

  const mcp = read('mcp-apps-server.mjs');
  assert.match(mcp, /a\.mine === false/u, '工具侧按服务端判好的 `mine` 分"别人的"');
});
