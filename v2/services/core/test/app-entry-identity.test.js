// **D4.24 · A3 + A3·补**（`docs/handbook/05-DECISIONS.md` · 2026-10-03 定；口径
// `docs/dev/90-APP-CONTRACT.md` §9.2·1／§10.1·⑤）——两组判据各自钉死：
//
//   A3 —— **制品入口 URL 里不许带明文身份**
//     ① 真入口 URL 的串里搜不到身份（`sub=`／那个值的原文都搜不到）；
//     ② 照旧能打开（正对照），而且**老形状的正文**（带 `u`）也照旧认；
//     ③ 拿别人的签名 / 改一个字 ⇒ 拒（负向对照），而且**盘上零残留**；
//     ④ 客户端不用改（接口形状没动：页面照旧从 `location.search` 拿 `e`/`s`，
//        它多报一个被忽略的 `u` 也不影响）。
//
//   A3·补 —— **审计账里的身份换凭据哈希**
//     ① 新写入的审计行搜不到明文身份；
//     ② 同一个人的行仍然对得上（哈希稳定）；两个人不撞同一个哈希；
//     ③ 旧行**逐字节**没被动（只对新写入的行生效）。
//
// ⚠️ 每一条都带**负向对照**：搜索器先喂一个"确实带身份"的样本证明抓得住，
//    再喂真 URL 证明抓不到（不然"零命中"可能只是搜索器坏了）。

import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test, { after } from 'node:test';

import { Apps } from '../src/apps.js';
import { createAppServer, entryUrl, liveEntryUrl, resolveEntrySub, verifyEntry } from '../src/app-serve.js';
import { LIVE_VERSION } from '../src/app-live.js';
import { CRED_HASH_FALLBACK_KEY, credHashOf } from '../src/cred-hash.js';
import { Published } from '../src/published.js';

const NOW = 1_800_000_000_000;
const KEY = Buffer.from('a'.repeat(64), 'hex');

const open = new Set();
after(async () => {
  for (const close of open) {
    try { await close(); } catch { /* 关不干净不影响结论 */ }
  }
  open.clear();
});

function tmp(tag = 'hupo-a3-') {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), tag));
}

/** 盘上那份的指纹（相对路径 → sha256；目录也记进去）。零残留那条判据用它。 */
function treeDigest(root) {
  const out = new Map();
  const walk = (rel) => {
    let es = [];
    try { es = nodeFs.readdirSync(nodePath.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of es.sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.set(`${next}/`, 'dir'); walk(next); continue; }
      out.set(next, nodeCrypto.createHash('sha256').update(nodeFs.readFileSync(nodePath.join(root, next))).digest('hex'));
    }
  };
  walk('');
  return out;
}

const APP = Object.freeze({
  id: 'dice', title: '掷骰子', icon: 'dice', entry: 'index.html',
  files: { 'index.html': '<!doctype html><p>甲的一版</p>' },
});

/** 起一个**真**制品原点（两个人都登记过）。 */
async function bootOrigin(t, { worlds, subsOf = () => ['u1', 'u2'] }) {
  const origin = createAppServer({
    resolveApps: (sub) => worlds[sub] ?? null,
    resolveLive: (sub) => (worlds[sub] ? { readLive: (id, rel) => worlds[sub].read(id, worlds[sub].current(id), rel) } : null),
    key: KEY,
    frameAncestors: "'self'",
    subsOf,
    now: () => NOW,
    log: () => {},
  });
  await new Promise((res, rej) => {
    origin.once('error', rej);
    origin.listen(0, '127.0.0.1', res);
  });
  t.after(() => new Promise((r) => origin.close(() => r())));
  const base = `http://127.0.0.1:${origin.address().port}`;
  return { base, get: (url) => fetch(`${base}${url}`) };
}

// ════════════════════════════════════════════════════════════
// A3 ①：URL 串里搜不到身份（含负向对照：搜索器抓得住带身份的样本）
// ════════════════════════════════════════════════════════════
test('A3① 真入口 URL 里搜不到身份（`sub=` 与值的原文都没有）；搜索器负向对照抓得住', () => {
  const sub = 'u1';
  for (const url of [
    entryUrl({ base: 'https://apps.example', key: KEY, sub, id: 'dice', version: 1, entry: 'index.html', now: NOW }),
    liveEntryUrl({ base: 'https://apps.example', key: KEY, sub, id: 'dice', entry: 'index.html', now: NOW }),
  ]) {
    // ── 负向对照：搜索器不是恒假 —— 一条**带明文身份**的样本必须被抓出来
    const leaky = `${url}&u=${sub}`;
    assert.equal(/[?&]u=/.test(leaky), true, '搜索器负向对照：带 u= 的样本要抓得住');
    assert.equal(leaky.includes(sub), true, '搜索器负向对照：带原文的样本要抓得住');

    // ── 真 URL：三种搜法都零命中
    assert.equal(/[?&]u=/.test(url), false, `URL 上不许有 u=（${url}）`);
    assert.equal(url.includes('sub='), false, 'URL 上不许有 sub=');
    assert.equal(url.includes(sub), false, `URL 上不许出现那个身份的原文（${url}）`);
    // 只剩"签名 + 到期"两格
    const q = new URL(url).searchParams;
    assert.deepEqual([...q.keys()].sort(), ['e', 's'], '入口 URL 上只许有 e 与 s');
    // ── 而身份**确实绑在签名里**（不然①②③就都成了空转）
    assert.equal(
      verifyEntry({ key: KEY, sig: q.get('s'), sub, id: 'dice', version: url.includes('/w/') ? LIVE_VERSION : 1, exp: q.get('e'), now: NOW }),
      true,
      '签名必须覆盖这个人（只是 URL 上看不到那个值）',
    );
  }
});

// ════════════════════════════════════════════════════════════
// A3 ②③：照旧能打开；拿着别人的签名 / 改一个字 ⇒ 拒 ＋ 盘上零残留
// ════════════════════════════════════════════════════════════
test('A3②③ 正对照能开、负向对照全拒、而且被拒的请求盘上零残留', async (t) => {
  const dir1 = tmp();
  const dir2 = tmp();
  const a1 = new Apps({ dir: dir1, sub: 'u1' });
  a1.create({ ...APP });
  const a2 = new Apps({ dir: dir2, sub: 'u2' });
  a2.create({ ...APP, id: 'dice', files: { 'index.html': '<!doctype html><p>乙的一版</p>' } });

  const { get } = await bootOrigin(t, { worlds: { u1: a1, u2: a2 } });

  const good = entryUrl({ base: 'https://apps.example', key: KEY, sub: 'u1', id: 'dice', version: 1, entry: 'index.html', now: NOW });
  const path = new URL(good).pathname;
  const exp = new URL(good).searchParams.get('e');
  const sig = new URL(good).searchParams.get('s');

  // 盘上先拍一张（零残留那条判据用它；老行也在里面）
  const before = treeDigest(dir1);

  // ② 正对照：真 URL 照旧打开，内容对
  const ok = await get(`${path}?e=${exp}&s=${sig}`);
  assert.equal(ok.status, 200, '正对照：真入口 URL 必须照旧能打开');
  assert.equal(await ok.text(), '<!doctype html><p>甲的一版</p>');

  // ③ 一条条负向对照（都要 403）
  const cases = [
    ['改签名一个字', `${path}?e=${exp}&s=${'0'.repeat(63)}${sig.endsWith('0') ? '1' : '0'}`],
    ['签名是别人的（u9 没登记过）', `${path}?e=${exp}&s=${signEntryFor('u9')}`],
    ['换版本（域分离）', `${path}?e=${exp}&s=${signEntryFor('u1', { version: 2 })}`],
    ['换 app（域分离）', `${path}?e=${exp}&s=${signEntryFor('u1', { id: 'other' })}`],
    ['过期', `${path}?e=${NOW - 1}&s=${signEntryFor('u1', { exp: NOW - 1 })}`],
    ['没签名', path],
  ];
  for (const [why, u] of cases) {
    const r = await get(u);
    assert.equal(r.status, 403, `负向对照「${why}」该被拒：${u}`);
  }

  // ③·补 **A3 的核心负向对照**：往真 URL 上挂一个"别人的身份"也改不了"这是谁"
  //    （URL 上今天根本没有那一格 —— 这条钉的是"旧攻击面已经不存在"）
  const swapped = await get(`${path}?e=${exp}&s=${sig}&u=u2`);
  assert.equal(swapped.status, 200, '挂 u=u2 不会变成 403 —— 它只是被忽略');
  assert.equal(await swapped.text(), '<!doctype html><p>甲的一版</p>', '🔴 认人只看签名：挂 u=u2 拿不到乙的东西');

  // ③·补 老页面照旧：正文里带 `u` 也照旧认（那一格被忽略，认人只看签名）
  const ticket = await import('../src/app-serve.js').then((m) => m.appTicketOf({
    key: KEY,
    body: { e: exp, s: sig, u: 'u2' },
    id: 'dice',
    version: 1,
    now: NOW,
    subsOf: () => ['u1', 'u2'],
  }));
  assert.equal(ticket?.sub, 'u1', '★ 老页面正文里那个 u 今天被忽略 —— 认人只看签名');

  // ③·补 盘上零残留：**只有**正对照那次读了文件（读不改盘），被拒的一次都不许碰盘
  assert.deepEqual(treeDigest(dir1), before, '🔴 被拒的请求在盘上留了东西（或正对照改了盘）');
});

/** 签一条给某个人的入口签名（造"别人的签名 / 改一个字"那些负向样本）。 */
function signEntryFor(sub, { id = 'dice', version = 1, exp = NOW + 600_000 } = {}) {
  // 走**同一个** signEntry（不在判据里重写一遍签名算法）
  const url = entryUrl({ base: 'https://x.example', key: KEY, sub, id, version, entry: 'index.html', now: NOW, ttlMs: exp - NOW });
  return new URL(url).searchParams.get('s');
}

// ════════════════════════════════════════════════════════════
// A3：`resolveEntrySub` 本身（认人只从签名来）
// ════════════════════════════════════════════════════════════
test('A3 `resolveEntrySub`：签名属于谁就是谁；不在名单里 ⇒ null（fail-closed）', () => {
  const exp = String(NOW + 600_000);
  const sig = signEntryFor('u1', { exp: NOW + 600_000 });
  assert.equal(resolveEntrySub({ key: KEY, sig, id: 'dice', version: 1, exp, subs: ['u1', 'u2'], now: NOW }), 'u1');
  assert.equal(resolveEntrySub({ key: KEY, sig, id: 'dice', version: 1, exp, subs: ['u2'], now: NOW }), null, '名单里没有他 ⇒ 拒');
  assert.equal(resolveEntrySub({ key: KEY, sig, id: 'dice', version: 1, exp, subs: [], now: NOW }), null, '没人 ⇒ 拒');
  assert.equal(resolveEntrySub({ key: KEY, sig: 'x', id: 'dice', version: 1, exp, subs: ['u1'], now: NOW }), null, '签名坏 ⇒ 拒');
});

// ════════════════════════════════════════════════════════════
// A3·补 ①②：新审计行没有明文身份；同一个人的行对得上；两个人不撞
// ════════════════════════════════════════════════════════════
test('A3·补①② 审计写的是凭据哈希：无明文、同一人稳定、两人不撞', () => {
  const ck = Buffer.from('c'.repeat(64), 'hex');
  const d1 = tmp();
  const d2 = tmp();
  const a1 = new Apps({ dir: d1, sub: 'u1', credKey: ck });
  const a2 = new Apps({ dir: d2, sub: 'u2', credKey: ck });
  a1.create({ ...APP, id: 'one' });
  a1.create({ ...APP, id: 'two' });
  a2.create({ ...APP, id: 'three' });

  const audit1 = nodeFs.readFileSync(nodePath.join(a1.root, 'audit.jsonl'), 'utf8');
  const audit2 = nodeFs.readFileSync(nodePath.join(a2.root, 'audit.jsonl'), 'utf8');
  const rows1 = audit1.trim().split('\n').map((l) => JSON.parse(l));
  const rows2 = audit2.trim().split('\n').map((l) => JSON.parse(l));

  // ① 明文身份搜不到（负向对照：先证明搜索器抓得住）
  assert.equal(audit1.includes('"u1"'), false, '🔴 新审计行里不许有明文身份');
  assert.equal(audit1.includes('u1'), false, '🔴 连裸串都不许出现');
  assert.equal('{"sub":"u1"}'.includes('u1'), true, '搜索器负向对照：带明文的样本要抓得住');
  // ② 同一个人的两行**对上**；而且**不一样的两行也各不相同**（不是恒等常量）
  assert.equal(rows1[0].sub, rows1[1].sub, '同一个人的行要归得到一起（稳定假名）');
  assert.equal(rows1[0].sub, credHashOf('u1', ck), '口径 = `credHashOf(sub, 键)`');
  assert.notEqual(rows1[0].sub, rows2[0].sub, '🔴 两个人不许撞成同一个哈希');
  assert.equal(typeof rows1[0].sub, 'string');
  assert.match(rows1[0].sub, /^[0-9a-f]{64}$/);
  // ★ "推不回明文"的前提：**换一把键，同一个人的值就变**（不是裸 sha256）
  assert.notEqual(credHashOf('u1', ck), credHashOf('u1', Buffer.from('d'.repeat(64), 'hex')), '换键 ⇒ 换值（键不对就算不出同一串）');
  assert.notEqual(credHashOf('u1', ck), nodeCrypto.createHash('sha256').update('u1').digest('hex'), '不能是裸 sha256（sub 可枚举 ⇒ 能穷举反推）');
  assert.equal(credHashOf('u1', null), credHashOf('u1', CRED_HASH_FALLBACK_KEY), '没接线 ⇒ 退化键（生产必须接上真键）');
});

// ════════════════════════════════════════════════════════════
// A3·补 ②③：共享库那条 install 也不写明文；旧行逐字节没被动
// ════════════════════════════════════════════════════════════
test('A3·补②③ 共享库 install 审计不带明文；旧行逐字节没被动', () => {
  const ck = Buffer.from('e'.repeat(64), 'hex');
  const dir = tmp();
  const author = new Apps({ dir: nodePath.join(dir, 'a'), sub: 'u1' });
  // ★ A16：制品里必须有外联申报（读不到 ⇒ 上架拒）—— 这一条验的是审计，带上它。
  author.create({
    ...APP,
    files: {
      ...APP.files,
      'outbound.json': JSON.stringify({
        schema: 1,
        outbound: [],
        declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '还没人用过，先按 0 报' },
      }),
    },
  });
  const pub = new Published({ dir, credKey: ck });

  // ★ 先造一条**旧行**（明文形状），证明"只对新写入的行生效"
  const auditFile = nodePath.join(pub.root, 'audit.jsonl');
  nodeFs.mkdirSync(pub.root, { recursive: true });
  const OLD = '{"at":1,"what":"install","id":"old","version":1,"by":"u2"}\n';
  nodeFs.writeFileSync(auditFile, OLD);
  const beforeOld = nodeFs.readFileSync(auditFile);

  pub.publish(author, { id: 'dice', authorSub: 'u1', authorName: '甲' });
  const viewer = new Apps({ dir: nodePath.join(dir, 'b'), sub: 'u2' });
  pub.installInto(viewer, 'dice');

  const after = nodeFs.readFileSync(auditFile);
  // ③ 旧行逐字节没被动（新内容是**追加**在它后面的）
  assert.equal(after.subarray(0, beforeOld.length).equals(beforeOld), true, '🔴 旧行被改写了（只许追加）');
  // ① 新写入的那一行没有明文身份
  const added = after.subarray(beforeOld.length).toString('utf8');
  assert.equal(added.includes('"u2"'), false, '🔴 共享库新审计行里有明文身份');
  const install = added.trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.what === 'install');
  assert.equal(install.by, credHashOf('u2', ck), 'install 那一格 = 装的人的凭据哈希');
  assert.notEqual(install.by, 'u2');
});

// ════════════════════════════════════════════════════════════
// A3·补 接线的判据：生产那两条路都真的接上了（源码级，防止"写好了没接"）
// ════════════════════════════════════════════════════════════
test('A3 接线：`serve.js` 真的给了 `subsOf` 与 `credKey`；`worlds.js` 真的往下传', () => {
  const read = (rel) => nodeFs.readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8');
  const serve = read('serve.js');
  assert.match(serve, /subsOf:\s*\(\)\s*=>\s*\[OWNER_ID,\s*\.\.\.users\.ids\(\)\]/u, '入口验签那一侧要拿到"登记过的人"');
  assert.match(serve, /credKey:\s*appsSignKey/u, '审计那把凭据键要接上（不给就是退化键）');
  const worlds = read('worlds.js');
  assert.match(worlds, /new Published\(\{\s*dir:\s*this\.#cfg\.dataDir,\s*credKey:\s*this\.#credKey\s*\}\)/u, '共享库要拿到凭据键');
  assert.match(worlds, /credKey:\s*this\.#credKey/u, '每个人那份制品库也要拿到凭据键');
});
