// **账本 `#74`：回收留痕里"谁删的"那一格换成带键 HMAC**（`D4.24 · B1`／`A3·补` 同族）。
//
// ── 这一份钉什么（一句话）──────────────────────────────────
// `reclaimed.json` 的 `by` 原来是**明文身份**（`owner`／`u1`…，可枚举）；现在写的是
// `credHashOf(sub, 键)`（域 `hupo-cred-v1`，与审计账 / 共享库作者假名**同一个函数**）。
// 🔴 口径是**"读得出老值、只写新值"**（不做存量迁移）：读走 `readReclaimBy`
//    （`'cred' | 'legacy' | null`，形状照 `published.js` 的 `readAuthorHash`），
//    写永远走 `reclaimByOf`。
//
// ⚠️ 每条判据都带**负向对照**；变异实测读数写进 `docs/dev/169-RECLAIM-BY-HASH.md`。
//
// 事实与改法：`docs/dev/169-RECLAIM-BY-HASH.md`。

import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CRED_HASH_FALLBACK_KEY, credHashOf } from '../src/cred-hash.js';
import {
  RECLAIMED_FILE,
  legacyReclaimBy,
  readReclaimBy,
  readReclaimedSeqs,
  reclaimByOf,
  reclaimScope,
} from '../src/reclaim.js';
import { Store } from '../src/store.js';

const NOW = 1_800_000_000_000;
const KEY = Buffer.from('a'.repeat(64), 'hex');
const KEY2 = Buffer.from('b'.repeat(64), 'hex');
/** 合成手机号（**不是**任何人的号）：证明"手机号形状的明文"同样搜得出来、也藏得住。 */
const PHONE = '13900000000';
const SRC = nodePath.dirname(fileURLToPath(import.meta.url));
const CORE = nodePath.dirname(SRC);

const tmp = (tag = 'hupo-74-') => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), tag));

/** 一条能过 `verifyMonotonic` 的最小日志（号连续）。 */
function seedLog(dataDir, seqs = [1, 2, 3]) {
  const lines = seqs.map((seq) =>
    JSON.stringify({ type: 'user/echo', messageId: `m${seq}`, text: `${seq}`, seq, at: NOW }),
  );
  nodeFs.writeFileSync(nodePath.join(dataDir, 'main.jsonl'), `${lines.join('\n')}\n`);
}

/**
 * 真 `reclaimScope` 走一遍（真 `Store`、真盘），返回 `{ into, rec, text }`。
 * ⚠️ 号一个都不抽（日志里没有 `scopeId`）⇒ 只验"留痕那一格写的是什么"。
 */
function reclaimOnce({ sub, credKey, dataDir = tmp() } = {}) {
  seedLog(dataDir);
  const into = nodePath.join(dataDir, 'hupo', 'apps', '.removed', 'x-1');
  const rec = reclaimScope({
    id: 'x',
    into,
    cwdFor: () => nodePath.join(dataDir, 'workspaces', 'x'),
    dshHome: nodePath.join(dataDir, '__dsh__'),
    store: new Store({ dataDir, fsync: false }),
    sub,
    credKey,
    at: NOW,
    fs: nodeFs,
    log: () => {},
  });
  return { into, rec, text: nodeFs.readFileSync(nodePath.join(into, RECLAIMED_FILE), 'utf8') };
}

const source = (rel) => nodeFs.readFileSync(nodePath.join(CORE, rel), 'utf8');
/** 只留代码行（注释/块注释里的名字不算 —— 判据别被文件顶上的说明骗了）。 */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

// ════════════════════════════════════════════════════════════
// R1 —— 新写入的那一行搜不到明文身份；负向对照：老记录会被同一个搜索器抓住
// ════════════════════════════════════════════════════════════
test('R1 新留痕的 `by` 是带键 HMAC（不是明文）；负向对照：老记录被同一个搜索器抓住', () => {
  // 搜索器：把身份明文（含**手机号形状**）都当"泄漏"。
  const searcher = (t) => t.includes('owner') || t.includes('u2') || t.includes(PHONE);

  const owner = reclaimOnce({ sub: 'owner', credKey: KEY });
  const phone = reclaimOnce({ sub: PHONE, credKey: KEY });

  assert.equal(searcher(owner.text), false, '🔴 新留痕里搜得到身份明文');
  assert.equal(searcher(phone.text), false, '🔴 新留痕里搜得到手机号明文');
  assert.equal(owner.rec.by, credHashOf('owner', KEY), '口径必须是 `credHashOf(sub, 键)`');
  assert.match(owner.rec.by, /^[0-9a-f]{64}$/u, '形状 = 64 位十六进制');
  assert.equal(owner.rec.by, reclaimByOf('owner', KEY), '写的就是 `reclaimByOf`');
  assert.equal(readReclaimBy(owner.rec.by, 'owner', KEY), 'cred', '本人读得回来');

  // 负向对照：搜索器**不是恒假** —— 一份"明文的"老留痕必须被抓出来。
  const legacyText = JSON.stringify({ v: 1, scopeId: 'x', at: NOW, by: 'owner', takenSeqs: [] });
  const phoneText = JSON.stringify({ v: 1, scopeId: 'x', at: NOW, by: PHONE, takenSeqs: [] });
  assert.equal(searcher(legacyText), true, '🔴 搜索器抓不住老留痕的明文 ⇒ 上一条是空转');
  assert.equal(searcher(phoneText), true, '🔴 搜索器抓不住手机号形状的明文 ⇒ 上一条是空转');

  // 老那一格走**老读法**：认得出来（`legacy`），不是"读不出"。
  assert.equal(readReclaimBy('owner', 'owner', KEY), 'legacy', '老值必须认得出来');
  assert.equal(legacyReclaimBy('owner'), 'owner', '旧口径就是明文本身（只读）');
  assert.equal(legacyReclaimBy(''), null, '空 ⇒ `null`（不编一个出来）');
});

// ════════════════════════════════════════════════════════════
// R2 —— 同一人稳定 · 两人不撞 · 换键就换值（带键的证明）
// ════════════════════════════════════════════════════════════
test('R2 同一人稳定 · 两个人不撞 · 换 key 就换值；不是裸 sha256、也不是退化键', () => {
  const a1 = reclaimOnce({ sub: 'owner', credKey: KEY }).rec.by;
  const a2 = reclaimOnce({ sub: 'owner', credKey: KEY }).rec.by;
  const other = reclaimOnce({ sub: 'u2', credKey: KEY }).rec.by;
  const keyed = reclaimOnce({ sub: 'owner', credKey: KEY2 }).rec.by;
  const fallback = reclaimOnce({ sub: 'owner', credKey: null }).rec.by;

  assert.equal(a1, a2, '同一个人两次写入必须同一个值（能对账）');
  assert.notEqual(a1, other, '两个人不许撞（换 sub ⇒ 值必须变）');
  assert.notEqual(a1, keyed, '换一把键 ⇒ 同一个人的值必须变（带键，不是裸哈希）');
  assert.notEqual(a1, fallback, '生产必须接真键 —— 不许落退化键那个值');

  const bare = nodeCrypto.createHash('sha256').update('owner').digest('hex');
  assert.notEqual(a1, bare, '不许是裸 `sha256(sub)`（那等于换个写法）');
  assert.notEqual(a1, 'owner', '不许是明文');
  assert.equal(fallback, credHashOf('owner', CRED_HASH_FALLBACK_KEY), '没接键时是退化键的值');
});

// ════════════════════════════════════════════════════════════
// R3 —— 存量照旧：老留痕走**今天的读路**读得出、不误判、不抛；读不出如实 `null`
// ════════════════════════════════════════════════════════════
test('R3 老留痕照旧读得出（不抛）；认不出如实 `null`，不许猜成某个人', () => {
  const dataDir = tmp('hupo-74-legacy-');
  const removedRoot = nodePath.join(dataDir, 'hupo', 'apps', '.removed');
  // 一份**老**留痕（明文 `by`、号洞 [2,3]）＋ 一份**新**留痕，摆在一起。
  nodeFs.mkdirSync(nodePath.join(removedRoot, 'old-1'), { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(removedRoot, 'old-1', RECLAIMED_FILE),
    `${JSON.stringify({ v: 1, scopeId: 'old', at: NOW, by: 'owner', takenSeqs: [2, 3] })}\n`,
  );
  nodeFs.mkdirSync(nodePath.join(removedRoot, 'new-1'), { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(removedRoot, 'new-1', RECLAIMED_FILE),
    `${JSON.stringify({ v: 1, scopeId: 'new', at: NOW, by: reclaimByOf('owner', KEY), takenSeqs: [4] })}\n`,
  );

  // ① **今天的读路**（`readReclaimedSeqs`）照旧读得出那两个洞、不抛。
  assert.deepEqual(
    readReclaimedSeqs({ removedRoot }),
    [2, 3, 4],
    '🔴 老的 `takenSeqs` 必须照旧读得出来（新口径不影响它）',
  );

  // ② 校验器按它解释洞 ⇒ 过（正身：洞真在盘上）。
  seedLog(dataDir, [1, 5]);
  assert.deepEqual(
    new Store({ dataDir, fsync: false }).verifyMonotonic('main', {
      reclaimed: readReclaimedSeqs({ removedRoot }),
    }),
    { count: 2, maxSeq: 5 },
    '带留痕判 ⇒ 洞解释得了，过',
  );

  // ③ 老那一格：本人**认得出来**（`legacy`），别人**认不出来**（`null`，不是"那就是他"）。
  assert.equal(readReclaimBy('owner', 'owner', KEY), 'legacy', '老值的本人认得出');
  assert.equal(readReclaimBy('owner', 'u2', KEY), null, '🔴 不许把老值误判成别人');
  assert.equal(readReclaimBy('owner', 'owner', KEY2), 'legacy',
    '老值是**明文**，与键无关 ⇒ 换键照样认得出（这不叫"误判"；换键变值只对新口径成立）');

  // ④ 负向对照：**读不出来**的情形要如实说 —— `null`，一个都不许猜。
  const unreadable = reclaimByOf('owner', KEY2); // 别人的键写的
  assert.equal(readReclaimBy(unreadable, 'owner', KEY), null, '换键 ⇒ 读不出，不许猜');
  assert.equal(readReclaimBy('deadbeef', 'owner', KEY), null, '垃圾值 ⇒ 读不出，不许猜');
  assert.equal(readReclaimBy('', 'owner', KEY), null, '空 ⇒ 读不出');
  assert.equal(readReclaimBy(null, 'owner', KEY), null, '缺那一格 ⇒ 读不出');
  assert.equal(readReclaimBy(123, 'owner', KEY), null, '非字符串 ⇒ 读不出');
});

// ════════════════════════════════════════════════════════════
// R4 —— 接线：真代码里那把键一路传到 `reclaimScope`（源码级 ＋ 行为级）
// ════════════════════════════════════════════════════════════
test('R4 接线：`serve.js` → `worlds.js` 的回收上下文 / `apps.js` 都真把 `credKey` 传下去', () => {
  const serve = source('src/serve.js');
  const worlds = source('src/worlds.js');
  const apps = source('src/apps.js');
  const reclaim = source('src/reclaim.js');

  assert.match(serve, /credKey:\s*appsSignKey/u, '`serve.js` 必须把制品签名键接上（不给就是退化键）');
  // 回收上下文（`reclaimCtx`）里要带那把键 —— 没带 ⇒ 留痕落退化键那个值。
  // ⚠️ 只截**那一个对象字面量**（到它自己的 `});` 为止）—— 否则会误配后面
  //    `new Apps({… credKey: this.#credKey …})` 里同名的那一格（变异实测栽过一次）。
  const ctx = codeOnly(worlds).match(/const reclaimCtx = \(\) => \(\{[\s\S]*?\n {4}\}\);/u);
  assert.ok(ctx, '找不到 `reclaimCtx` 那个对象字面量（源码形状变了？）');
  assert.match(ctx[0], /credKey:\s*this\.#credKey/u,
    '`worlds.js` 的 `reclaimCtx` 要带 `credKey`（`world.reclaimRoom()` 那条路只走它）');
  // `Apps.remove()` 那条路：显式给（与 `sub` 同一条理由）。
  assert.match(
    codeOnly(apps),
    /reclaimScope\(\{[\s\S]{0,300}?credKey:\s*this\.credKey/u,
    '`apps.js` 的 `remove()` 要把 `credKey` 显式传给 `reclaimScope`',
  );
  // 写那一格只许走 `reclaimByOf`（不许退回明文）。
  assert.match(codeOnly(reclaim), /by:\s*reclaimByOf\(sub, credKey\)/u, '留痕那一格必须走新口径');
  assert.match(codeOnly(reclaim), /credHashOf/u, '带键 HMAC 要与审计/共享库**同一个函数**');

  // 行为级：真 `reclaimScope` 接上键 ⇒ 那一格 = `credHashOf(sub, 键)`（不是明文）。
  const rec = reclaimOnce({ sub: 'owner', credKey: KEY }).rec;
  assert.equal(rec.by, credHashOf('owner', KEY));
});
