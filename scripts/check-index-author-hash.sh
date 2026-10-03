#!/usr/bin/env bash
# **`D4.24 · B1` / `A3·补·二` 的闸**：共享库 `index.json` 的作者假名换成
# **带键 HMAC**（`cred-hash.js` 的口径：同一把键、同一个域 `hupo-cred-v1`）——
# 还的是账本 `#73`（`docs/dev/00-PROGRESS.md` §六）。
# 事实与改法：`docs/dev/163-INDEX-AUTHOR-HASH.md`。
#
# 用法：
#   bash scripts/check-index-author-hash.sh
#
# 退出码 = 失败数（0 ⇒ 通过）；末尾固定打印 **`通过 N · 失败 M`**。
#
# ── 判据（四条，每条都带**负向对照**）────────────────────────
#   ① 新写入的 `index.json` 里搜不到**旧口径**的那个值（裸 sha256 前 12 位），
#      也搜不到身份明文；负向对照：同两个搜索器喂一条**旧口径＋明文**的样本必须抓得住。
#   ② 同一身份**稳定**（同一个值）＋ **两个人不撞**（换一个 `sub` ⇒ 值必须变）
#      ＋ **换 key ⇒ 值变**（带键的证明；不是裸 sha256）。
#   ③ **存量照旧**：拿**真机那一份** `index.json`（`data/published-apps/coin`；读不到就
#      照它造一份同形状夹具）跑"**上架 → 装上 → 打开**"全流程 ⇒ 照旧通；
#      负向对照：别人同名上架／别人下架 ⇒ 拒，而且**把新写的值当老值读**
#      ⇒ 必须走"读不出来"的分支（`null`），**不许误判成别人**。
#   ④ **零残留**：真机 `published-apps/` 跑前跑后**逐文件 sha256 一致**（这一条闸全程只读）；
#      负向对照：改动一个字节 ⇒ 指纹必须变（证明它不是恒等的空转）。
#
# ── 为什么不把那四条已有的闸扩一扩 ──────────────────────────
#   `check-app-entry-identity.sh`（入口 URL/审计）/ `check-edge-kinds.sh`（三条登记边）/
#   `check-outbound-bridge.sh`（出界独木桥）/ `check-scope-boundary.sh`（真机边界）
#   各自管一件事，与"共享库 `index.json` 里的作者假名是什么口径"没有重叠；
#   混进去会让"这一条红了该找谁"变模糊。⇒ **新开一条**，那四条**一个字节没动**。
#
# 🔴 纪律：读不出 / 算不出 ⇒ 打印 **`不可算`** 并记**失败**，绝不安静地绿；
#   每一条都有负向对照，脚本自己核那条对照真的在。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/v2/services/core"
# 真机数据目录（`serve.js` 用的是 `HUPO_DATA`；`restart-core.sh` 把它设成 `<core>/data`）。
LIVE_DATA="${HUPO_DATA:-$CORE/data}"

# ⚠️ `sudo` 底下 PATH 里没有 node（这台机器只有 nvm 里那一个）⇒ 兜一圈找它。
NODE="${NODE_BIN:-}"
if [ -z "$NODE" ]; then
  for c in /home/deploy/.nvm/versions/node/*/bin/node "$(command -v node 2>/dev/null || true)"; do
    [ -x "$c" ] && { NODE="$c"; break; }
  done
fi
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "✗ 找不到 node（这台机器只有 nvm 里那一个）"; exit 2; }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

echo '── ① ② ③ ④：临时目录里用**真代码**（不碰线上、不碰真数据目录；真机那一步只读）'
echo

cat > "$T/author-hash-probe.mjs" <<'NODE'
// 一次性探针：真 `src/` 模块 ＋ 临时目录里的真盘 ＋ （只读）真机那份 `index.json`。
// 输出协议：`OK <id> :: <名字> ;; <读数>` / `BAD ...`，交给外面那个 bash 数数。
import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { pathToFileURL } from 'node:url';

const CORE = process.env.HUPO_CORE;
const T = process.env.HUPO_PROBE_TMP;
const LIVE_DATA = process.env.HUPO_LIVE_DATA;

const ok = (id, name, reading) => console.log(`OK  ${id} :: ${name} ;; ${reading}`);
const bad = (id, name, reading) => console.log(`BAD ${id} :: ${name} ;; ${reading}`);

const mod = (rel) => import(pathToFileURL(nodePath.join(CORE, 'src', rel)).href);
const { Apps } = await mod('apps.js');
const { createAppServer, entryUrl } = await mod('app-serve.js');
const { CRED_HASH_FALLBACK_KEY, credHashOf } = await mod('cred-hash.js');
const { PUBLISHED_DIR, Published, authorHashOf, legacyAuthorHashOf, readAuthorHash } = await mod('published.js');

const NOW = 1_800_000_000_000;
const KEY = Buffer.from('a'.repeat(64), 'hex');
const KEY2 = Buffer.from('b'.repeat(64), 'hex');
const OWNER = 'owner';
const FILES = Object.freeze({
  'index.html': '<!doctype html><p>掷硬币</p>',
  'outbound.json': JSON.stringify({
    schema: 1,
    outbound: [],
    declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '先按 0 报' },
  }),
});

const tmp = (tag) => nodeFs.mkdtempSync(nodePath.join(T, `${tag}-`));

/** 盘上指纹（相对路径 → sha256；空目录记 'dir'）。**零残留**那条用它。 */
function treeDigest(root) {
  const out = new Map();
  const walk = (rel) => {
    let es = [];
    try { es = nodeFs.readdirSync(nodePath.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of es.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.set(`${next}/`, 'dir'); walk(next); continue; }
      out.set(next, nodeCrypto.createHash('sha256').update(nodeFs.readFileSync(nodePath.join(root, next))).digest('hex'));
    }
  };
  walk('');
  return out;
}
const sameDigest = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/** 作者自己那一格：里面有一个 `coin`。 */
function authorApps(sub, key, id = 'coin') {
  const apps = new Apps({ dir: tmp(`own-${id}`), sub, credKey: key });
  apps.create({ id, title: '掷硬币', icon: 'dice', entry: 'index.html', files: { ...FILES } });
  return apps;
}

/** 起一个**真**制品原点（"打开"那一步打的就是它）。 */
async function bootOrigin(worlds) {
  const origin = createAppServer({
    resolveApps: (sub) => worlds[sub] ?? null,
    key: KEY,
    frameAncestors: "'self'",
    subsOf: () => Object.keys(worlds),
    now: () => NOW,
    log: () => {},
  });
  await new Promise((res, rej) => { origin.once('error', rej); origin.listen(0, '127.0.0.1', res); });
  return { base: `http://127.0.0.1:${origin.address().port}`, close: () => new Promise((r) => origin.close(() => r())) };
}

/** 真机那一份在不在（只读）。 */
const LIVE_PUB = nodePath.join(LIVE_DATA, PUBLISHED_DIR);
const liveBefore = nodeFs.existsSync(LIVE_PUB) ? treeDigest(LIVE_PUB) : null;

process.on('uncaughtException', (e) => { bad('probe', '探针崩了（算不出来）', String(e?.stack ?? e)); process.exitCode = 1; });

// ════════════════════════════════════════════════════════════
// ① 新写入的 index.json：旧口径的值 / 身份明文都零命中
// ════════════════════════════════════════════════════════════
{
  const id = '①';
  const pub = new Published({ dir: tmp('newhash'), credKey: KEY });
  const apps = authorApps(OWNER, KEY);
  const legacy = legacyAuthorHashOf(OWNER);
  const legacyName = `用户 ${legacy.slice(0, 4)}`;
  const idx = pub.publish(apps, { id: 'coin', authorSub: OWNER, authorName: `用户 ${authorHashOf(OWNER, KEY).slice(0, 4)}` });
  const text = nodeFs.readFileSync(nodePath.join(pub.appDir('coin'), 'index.json'), 'utf8');

  // 负向对照：搜索器不是恒假 —— 一条**旧口径 ＋ 明文身份**的样本必须被抓出来
  const leaky = `{"authorHash":"${legacy}","authorName":"${legacyName}","sub":"${OWNER}"}`;
  const searcher = leaky.includes(legacy) && leaky.includes(legacyName) && leaky.includes(OWNER);
  const clean = !text.includes(legacy) && !text.includes(legacyName) && !text.includes(OWNER);
  const caliber = idx.authorHash === credHashOf(OWNER, KEY)
    && idx.authorHash === authorHashOf(OWNER, KEY)
    && /^[0-9a-f]{64}$/.test(idx.authorHash);
  if (searcher && clean && caliber) {
    ok(id, '新写入的 `index.json`：搜不到旧口径的值/旧昵称/身份明文；口径 = `credHashOf(sub, 键)`', `authorHash=${idx.authorHash.slice(0, 16)}…`);
  } else {
    bad(id, '新写入的 `index.json` 里还有旧口径的值 / 明文，或口径不对', `search=${searcher} clean=${clean} caliber=${caliber}`);
  }
}

// ════════════════════════════════════════════════════════════
// ② 稳定 ＋ 两人不撞 ＋ 换键就换值
// ════════════════════════════════════════════════════════════
{
  const id = '②';
  const A = new Published({ dir: tmp('stable-a'), credKey: KEY });
  const B = new Published({ dir: tmp('stable-b'), credKey: KEY });
  const C = new Published({ dir: tmp('stable-c'), credKey: KEY });
  const D = new Published({ dir: tmp('stable-d'), credKey: KEY2 });
  const one = A.publish(authorApps(OWNER, KEY, 'coin'), { id: 'coin', authorSub: OWNER, authorName: '甲' });
  const two = B.publish(authorApps(OWNER, KEY, 'dice'), { id: 'dice', authorSub: OWNER, authorName: '甲' });
  const other = C.publish(authorApps('u2', KEY, 'coin'), { id: 'coin', authorSub: 'u2', authorName: '乙' });
  const keyed = D.publish(authorApps(OWNER, KEY2, 'coin'), { id: 'coin', authorSub: OWNER, authorName: '甲' });

  const stable = one.authorHash === two.authorHash && one.authorHash === credHashOf(OWNER, KEY);
  const differ = one.authorHash !== other.authorHash;                 // 负向对照：换 sub ⇒ 值变
  const keyChanges = one.authorHash !== keyed.authorHash;             // 负向对照：换键 ⇒ 值变
  const notBare = one.authorHash !== legacyAuthorHashOf(OWNER)
    && one.authorHash !== nodeCrypto.createHash('sha256').update(OWNER).digest('hex')
    && one.authorHash !== credHashOf(OWNER, null);
  if (stable && differ && keyChanges && notBare) {
    ok(id, '同一身份稳定；两个人不撞（换 sub ⇒ 换值）；换键 ⇒ 换值（不是裸 sha256，也不是退化键）', `${one.authorHash.slice(0, 12)}… vs ${other.authorHash.slice(0, 12)}…`);
  } else {
    bad(id, '哈希不稳定 / 两人撞了 / 换键不变（说明不是带键的）', `stable=${stable} differ=${differ} keyChanges=${keyChanges} notBare=${notBare}`);
  }
}

// ════════════════════════════════════════════════════════════
// ③ 存量照旧：真机那份 index.json（或照它造的夹具）跑"上架 → 装上 → 打开"
// ════════════════════════════════════════════════════════════
{
  const id = '③';
  const shared = tmp('legacy-shared');
  const A = authorApps(OWNER, KEY);
  const rootHash = A.manifest('coin', A.current('coin')).rootHash;

  // ── 夹具：优先**真机那一份的字节**；真机上没有 ⇒ 照它造（同形状、旧口径）
  const liveIndex = nodePath.join(LIVE_PUB, 'coin', 'index.json');
  const liveVers = nodePath.join(LIVE_PUB, 'coin', 'versions');
  const fixtureDir = nodePath.join(shared, PUBLISHED_DIR, 'coin');
  let fixtureFrom = '照它造（真机上没有那一份）';
  if (nodeFs.existsSync(liveIndex)) {
    nodeFs.mkdirSync(fixtureDir, { recursive: true });
    nodeFs.copyFileSync(liveIndex, nodePath.join(fixtureDir, 'index.json'));
    if (nodeFs.existsSync(liveVers)) nodeFs.cpSync(liveVers, nodePath.join(fixtureDir, 'versions'), { recursive: true });
    fixtureFrom = '真机那一份（逐字节拷进来的）';
  } else {
    // 与真机同形状：旧口径 ＋ 旧昵称 ＋ 可核的 rootHash
    nodeFs.mkdirSync(nodePath.join(fixtureDir, 'versions', '1'), { recursive: true });
    for (const [rel, body] of Object.entries(FILES)) {
      const p = nodePath.join(fixtureDir, 'versions', '1', rel);
      nodeFs.mkdirSync(nodePath.dirname(p), { recursive: true });
      nodeFs.writeFileSync(p, body);
    }
    const legacy = legacyAuthorHashOf(OWNER);
    nodeFs.writeFileSync(nodePath.join(fixtureDir, 'index.json'), `${JSON.stringify({
      schema: 1, id: 'coin', title: '掷硬币', icon: 'dice', entry: 'index.html', version: 1,
      rootHash, permissions: [], authorHash: legacy, authorName: `用户 ${legacy.slice(0, 4)}`,
      publishedAt: 1, published: true,
    }, null, 2)}\n`);
  }

  const pub = new Published({ dir: shared, credKey: KEY });
  const storedBefore = pub.index('coin')?.authorHash ?? '';
  const legacy = legacyAuthorHashOf(OWNER);
  const isLegacyFixture = storedBefore === legacy;

  // ── 负向对照（上架前）：**别人**同名上架 / 别人下架 ⇒ 拒
  let othersDenied = false;
  try { pub.publish(authorApps('u2', KEY, 'coin'), { id: 'coin', authorSub: 'u2', authorName: '乙' }); } catch (e) { othersDenied = /被别人用了/.test(String(e?.message)); }
  let othersUnpub = false;
  try { pub.unpublish('coin', 'u2'); } catch (e) { othersUnpub = /不是你发的/.test(String(e?.message)); }

  // ── ★ 存量**本人**那条：旧值必须读得出 ⇒ 他能把自己那条**撤下来**
  //    （"只写新值"≠ 让老条目变成没人认领 —— 这一条是"存量照旧"的承重点，
  //      变异实测：把它退回"直接比哈希" ⇒ 这一条判据当场红）
  let legacyOwnerUnpub = false;
  try { legacyOwnerUnpub = pub.unpublish('coin', OWNER).published === false; } catch { legacyOwnerUnpub = false; }

  // ── ① 上架：**本人**更新自己那条 ⇒ 照旧通，且写下去的是新口径
  let published = null;
  let publishErr = null;
  try {
    published = pub.publish(A, { id: 'coin', authorSub: OWNER, authorName: `用户 ${authorHashOf(OWNER, KEY).slice(0, 4)}` });
  } catch (e) { publishErr = e?.message ?? String(e); }
  const wroteNew = published?.authorHash === credHashOf(OWNER, KEY);
  const diskText = nodeFs.readFileSync(nodePath.join(fixtureDir, 'index.json'), 'utf8');
  const noLegacyLeft = !diskText.includes(legacy);

  // ── ② 装上：乙那一格真拿到一份
  const B = new Apps({ dir: tmp('installer'), sub: 'u2' });
  let got = null;
  let installErr = null;
  try { got = pub.installInto(B, 'coin'); } catch (e) { installErr = e?.message ?? String(e); }

  // ── ③ 打开：真 HTTP 那一条路（签名认人 ⇒ 原样拿到那一版的字节）
  let openStatus = 0;
  let openBody = '';
  let origin = null;
  try {
    origin = await bootOrigin({ u2: B });
    const idx = pub.index('coin');
    const url = entryUrl({ base: 'https://apps.example', key: KEY, sub: 'u2', id: 'coin', version: idx.version, entry: idx.entry, now: NOW });
    const { pathname, searchParams } = new URL(url);
    const r = await fetch(`${origin.base}${pathname}?e=${searchParams.get('e')}&s=${searchParams.get('s')}`);
    openStatus = r.status;
    openBody = await r.text();
  } catch (e) {
    openBody = `不可算：${e?.message ?? e}`;
  } finally {
    if (origin) await origin.close();
  }
  const opened = openStatus === 200 && openBody === FILES['index.html'];

  // ── ④ 下架：本人照旧撤得下来
  let ownerUnpub = false;
  try { ownerUnpub = pub.unpublish('coin', OWNER).published === false; } catch { ownerUnpub = false; }

  // ── 负向对照：**把新写的值当老值读** ⇒ 读不出来（fail-closed），不许误判成别人
  const pub2 = new Published({ dir: shared, credKey: KEY });
  const storedNew = pub2.index('coin').authorHash;
  const readOut = {
    owner: readAuthorHash(storedNew, OWNER, KEY),
    other: readAuthorHash(storedNew, 'u2', KEY),
    otherKey: readAuthorHash(storedNew, OWNER, KEY2),
    legacyReadOfNew: storedNew === legacyAuthorHashOf(OWNER) || storedNew === legacyAuthorHashOf('u2'),
  };
  // 拿新值当老值读：本人读不出（走"读不出来"分支），别人更读不出
  const oldReaderFailsClosed = readOut.legacyReadOfNew === false;
  const notMistakenAsOther = readOut.other === null && readOut.otherKey === null;

  const allOk = isLegacyFixture && othersDenied && othersUnpub && legacyOwnerUnpub
    && publishErr === null && wroteNew
    && noLegacyLeft && installErr === null && got !== null && opened && ownerUnpub
    && oldReaderFailsClosed && notMistakenAsOther && readOut.owner === 'cred';
  if (allOk) {
    ok(id, '存量照旧：旧口径那份"本人撤得下来 ＋ 上架 → 装上 → 打开"全程通；别人同名/下架被拒；新值当老值读 ⇒ 读不出来（不误判成别人）', `${fixtureFrom} · 旧值 ${String(storedBefore).slice(0, 12)}… → 新值 ${String(storedNew).slice(0, 12)}… · 打开 ${openStatus}`);
  } else {
    bad(id, '存量那条路断了 / 负向对照没拒 / 新值被误判', `fixture=${isLegacyFixture}(${fixtureFrom}) othersDenied=${othersDenied} othersUnpub=${othersUnpub} legacyOwnerUnpub=${legacyOwnerUnpub} publishErr=${publishErr} wroteNew=${wroteNew} noLegacyLeft=${noLegacyLeft} installErr=${installErr} open=${openStatus} opened=${opened} ownerUnpub=${ownerUnpub} oldReads=${JSON.stringify(readOut)}`);
  }
}

// ════════════════════════════════════════════════════════════
// ④ 零残留：真机 `published-apps/` 逐文件 sha256 跑前跑后一致（＋ 指纹负向对照）
// ════════════════════════════════════════════════════════════
{
  const id = '④';
  if (liveBefore === null) {
    bad(id, '**不可算**：真机共享库读不到（这一条判据要它）', LIVE_PUB);
  } else {
    const liveAfter = treeDigest(LIVE_PUB);
    const unchanged = sameDigest(liveBefore, liveAfter);
    // 负向对照：改一个字节 ⇒ 指纹必须变（证明这条判据不是恒等的空转）
    const d = tmp('digest-control');
    nodeFs.writeFileSync(nodePath.join(d, 'x'), 'one');
    const d1 = treeDigest(d);
    nodeFs.writeFileSync(nodePath.join(d, 'x'), 'two');
    const d2 = treeDigest(d);
    const detector = !sameDigest(d1, d2);
    if (unchanged && detector) {
      ok(id, '真机 `published-apps/` 逐文件 sha256 跑前跑后一致 —— **零残留**（这一条闸全程只读）', `${liveAfter.size} 个条目不变`);
    } else {
      bad(id, '真机上多了/少了/改了文件，或指纹检测器是空转的', `unchanged=${unchanged} detector=${detector} 前 ${liveBefore.size} → 后 ${liveAfter.size}`);
    }
  }
}
NODE

out="$(HUPO_CORE="$CORE" HUPO_PROBE_TMP="$T" HUPO_LIVE_DATA="$LIVE_DATA" "$NODE" "$T/author-hash-probe.mjs" 2>&1)"
rc=$?
printf '%s\n' "$out" | grep '^OK  ' | sed 's/^OK  /  ✓ /'
printf '%s\n' "$out" | grep '^BAD ' | sed 's/^BAD /  ✗ /'
n_ok="$(printf '%s\n' "$out" | grep -c '^OK  ' || true)"
n_bad="$(printf '%s\n' "$out" | grep -c '^BAD ' || true)"
if ! printf '%s\n' "$out" | grep -q '^OK  \|^BAD '; then
  echo "  ✗ 一条判据都没跑出来（**不可算**）—— 探针没出声"
  printf '%s\n' "$out" | tail -20 | sed 's/^/      | /'
  echo "通过 0 · 失败 1"
  exit 1
fi
pass="$n_ok"; fail="$n_bad"
if [ "$rc" -ne 0 ] && [ "$fail" -eq 0 ]; then
  echo "  ✗ 探针非零退出但没报 BAD（**不可算**）"
  fail=1
fi
echo
echo "通过 $pass · 失败 $fail"
exit "$fail"
