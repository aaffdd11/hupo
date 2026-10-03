#!/usr/bin/env bash
# **账本 `#74` 的闸**：回收留痕 `reclaimed.json` 里"谁删的"那一格（`by`）从
# **明文身份**换成 **带键 HMAC**（`cred-hash.js` 的口径：同一把键、同一个域
# `hupo-cred-v1`）—— 与 `A3·补`（审计）／`B1`（共享库作者假名）**同一个函数**。
# 事实与改法：`docs/dev/169-RECLAIM-BY-HASH.md`。
#
# 用法：
#   bash scripts/check-reclaim-by-hash.sh
#
# 退出码 = 失败数（0 ⇒ 通过）；末尾固定打印 **`通过 N · 失败 M`**。
#
# ── 判据（四条，每条都带**负向对照**）────────────────────────
#   ① 新写入的 `reclaimed.json` 里搜不到**身份明文**（含手机号形状），
#      写的是 `credHashOf(sub, 键)`；负向对照：同一个搜索器喂一份**老留痕**
#      （明文 `by`）必须抓得住 —— 否则上一条是空转。
#   ② 同一身份**稳定** ＋ **两个人不撞**（换一个 `sub` ⇒ 值必须变）
#      ＋ **换 key ⇒ 值变**（带键的证明）；不是裸 sha256、也不是退化键。
#   ③ **存量照旧**：拿**真机那一份**老 `reclaimed.json`（逐字节拷进临时目录）跑
#      **今天的读路**（`readReclaimedSeqs` ＋ `verifyMonotonic`）⇒ 照旧读得出、不抛；
#      老那一格本人认得出（`legacy`）、别人**认不出来**（`null`）；负向对照：
#      读不出来的情形（坏 JSON / 垃圾值 / 空 / 换键）**如实**是 `null`、
#      坏掉的那一份**跳过**（既不猜成某个人，也不当成"没有洞"）。
#   ④ **零残留**：真机 `data/hupo/apps/.removed/` 跑前跑后**逐文件 sha256 一致**
#      （这一条闸全程只读）；负向对照：改一个字节 ⇒ 指纹必须变（不是空转）。
#
# ── 为什么不把那几条已有的闸扩一扩 ──────────────────────────
#   `check-index-author-hash.sh` 管的是共享库 `index.json` 的作者假名
#   （另一格、另一条承重路）；`check-app-entry-identity.sh` 管入口 URL 与审计。
#   三条各管一格，混进去会让"这一条红了该找谁"变模糊。⇒ **新开一条**，
#   已有的那些**一个字节没动**。
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

cat > "$T/reclaim-by-probe.mjs" <<'NODE'
// 一次性探针：真 `src/` 模块 ＋ 临时目录里的真盘 ＋ （只读）真机那份 `.removed/`。
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
const { Store } = await mod('store.js');
const { CRED_HASH_FALLBACK_KEY, credHashOf } = await mod('cred-hash.js');
const { RECLAIMED_FILE, legacyReclaimBy, readReclaimBy, readReclaimedSeqs, reclaimByOf, reclaimScope } =
  await mod('reclaim.js');

const NOW = 1_800_000_000_000;
const KEY = Buffer.from('a'.repeat(64), 'hex');
const KEY2 = Buffer.from('b'.repeat(64), 'hex');
const PHONE = '13900000000'; // 合成手机号（**不是**任何人的号）
const APPS_REL = nodePath.join('hupo', 'apps');
const LIVE_REMOVED = nodePath.join(LIVE_DATA, APPS_REL, '.removed');

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

/** 一条能过 `verifyMonotonic` 的日志（号连续）。 */
function seedLog(dataDir, seqs) {
  const lines = seqs.map((seq) =>
    JSON.stringify({ type: 'user/echo', messageId: `m${seq}`, text: `${seq}`, seq, at: NOW }));
  nodeFs.writeFileSync(nodePath.join(dataDir, 'main.jsonl'), `${lines.join('\n')}\n`);
  return new Store({ dataDir, fsync: false });
}

/** 真 `reclaimScope` 走一遍（真 `Store`、真盘），返回 `{ into, rec, text }`。 */
function reclaimOnce({ sub, credKey, dataDir = tmp('own') } = {}) {
  seedLog(dataDir, [1, 2, 3]);
  const into = nodePath.join(dataDir, APPS_REL, '.removed', 'x-1');
  const rec = reclaimScope({
    id: 'x',
    into,
    cwdFor: () => nodePath.join(dataDir, 'workspaces', 'x'),
    dshHome: nodePath.join(dataDir, '__dsh__'),
    store: new Store({ dataDir, fsync: false }),
    sub, credKey, at: NOW, fs: nodeFs, log: () => {},
  });
  return { into, rec, text: nodeFs.readFileSync(nodePath.join(into, RECLAIMED_FILE), 'utf8') };
}

/** 真机那一份 `.removed/` 在不在（只读）。 */
const liveBefore = nodeFs.existsSync(LIVE_REMOVED) ? treeDigest(LIVE_REMOVED) : null;

process.on('uncaughtException', (e) => {
  bad('probe', '探针崩了（算不出来）', String(e?.stack ?? e));
  process.exitCode = 1;
});

// ════════════════════════════════════════════════════════════
// ① 新写入的留痕：身份明文（含手机号形状）零命中
// ════════════════════════════════════════════════════════════
{
  const id = '①';
  const searcher = (t) => t.includes('owner') || t.includes('u2') || t.includes(PHONE);
  const owner = reclaimOnce({ sub: 'owner', credKey: KEY });
  const phone = reclaimOnce({ sub: PHONE, credKey: KEY });
  const clean = !searcher(owner.text) && !searcher(phone.text);
  const caliber = owner.rec.by === credHashOf('owner', KEY)
    && owner.rec.by === reclaimByOf('owner', KEY)
    && /^[0-9a-f]{64}$/.test(owner.rec.by)
    && readReclaimBy(owner.rec.by, 'owner', KEY) === 'cred';
  // 负向对照：搜索器不是恒假 —— 一份"明文的"老留痕必须被抓出来。
  const legacyText = JSON.stringify({ v: 1, scopeId: 'x', at: NOW, by: 'owner', takenSeqs: [] });
  const phoneText = JSON.stringify({ v: 1, scopeId: 'x', at: NOW, by: PHONE, takenSeqs: [] });
  const detector = searcher(legacyText) && searcher(phoneText);
  const legacyRead = readReclaimBy('owner', 'owner', KEY) === 'legacy'
    && legacyReclaimBy('owner') === 'owner';
  if (clean && caliber && detector && legacyRead) {
    ok(id, '新留痕里搜不到身份明文 / 手机号明文；口径 = `credHashOf(sub, 键)`；负向对照抓住了老留痕', `by=${owner.rec.by.slice(0, 16)}…`);
  } else {
    bad(id, '新留痕里还有明文 / 口径不对 / 负向对照是空转', `clean=${clean} caliber=${caliber} detector=${detector} legacyRead=${legacyRead}`);
  }
}

// ════════════════════════════════════════════════════════════
// ② 稳定 ＋ 两人不撞 ＋ 换键就换值
// ════════════════════════════════════════════════════════════
{
  const id = '②';
  const a1 = reclaimOnce({ sub: 'owner', credKey: KEY }).rec.by;
  const a2 = reclaimOnce({ sub: 'owner', credKey: KEY }).rec.by;
  const other = reclaimOnce({ sub: 'u2', credKey: KEY }).rec.by;
  const keyed = reclaimOnce({ sub: 'owner', credKey: KEY2 }).rec.by;
  const fallback = reclaimOnce({ sub: 'owner', credKey: null }).rec.by;

  const stable = a1 === a2 && a1 === credHashOf('owner', KEY);
  const differ = a1 !== other;                 // 负向对照：换 sub ⇒ 值变
  const keyChanges = a1 !== keyed;             // 负向对照：换键 ⇒ 值变
  const notBare = a1 !== nodeCrypto.createHash('sha256').update('owner').digest('hex')
    && a1 !== legacyReclaimBy('owner')
    && a1 !== fallback
    && fallback === credHashOf('owner', CRED_HASH_FALLBACK_KEY);

  // 🔴 **生产那条路真接了键吗**（源码级）—— 不接 ⇒ 留痕落的是退化键那个值，
  //    而上面几条自己拿 KEY 造记录是**看不出**来的（变异实测：拔掉接线 ⇒ 光靠上面全绿）。
  const coreSrc = (rel) => nodeFs.readFileSync(nodePath.join(CORE, 'src', rel), 'utf8');
  const codeOnly = (t) => t
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const ctx = codeOnly(coreSrc('worlds.js')).match(/const reclaimCtx = \(\) => \(\{[\s\S]*?\n {4}\}\);/);
  const wired = /credKey:\s*appsSignKey/.test(coreSrc('serve.js'))
    && ctx !== null && /credKey:\s*this\.#credKey/.test(ctx[0])
    && /reclaimScope\(\{[\s\S]{0,300}?credKey:\s*this\.credKey/.test(codeOnly(coreSrc('apps.js')))
    && /by:\s*reclaimByOf\(sub, credKey\)/.test(codeOnly(coreSrc('reclaim.js')));

  if (stable && differ && keyChanges && notBare && wired) {
    ok(id, '同一身份稳定；两个人不撞（换 sub ⇒ 换值）；换键 ⇒ 换值（不是裸 sha256，也不是退化键）＋ 生产接线真把键传下去', `${a1.slice(0, 12)}… vs ${other.slice(0, 12)}…`);
  } else {
    bad(id, '哈希不稳定 / 两人撞了 / 换键不变（说明不是带键的）/ 生产那条路没接键', `stable=${stable} differ=${differ} keyChanges=${keyChanges} notBare=${notBare} wired=${wired}`);
  }
}

// ════════════════════════════════════════════════════════════
// ③ 存量照旧：真机那份老 `reclaimed.json`（逐字节拷进来）跑今天的读路
// ════════════════════════════════════════════════════════════
{
  const id = '③';
  // 挑一份**有 takenSeqs** 的真记录（没有就退而取任意一份）。
  let picked = null;
  try {
    const dirs = nodeFs.readdirSync(LIVE_REMOVED, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const d of dirs) {
      const p = nodePath.join(LIVE_REMOVED, d.name, RECLAIMED_FILE);
      try {
        const j = JSON.parse(nodeFs.readFileSync(p, 'utf8'));
        if (Array.isArray(j?.takenSeqs) && j.takenSeqs.length > 0) { picked = { dir: d.name, p, j }; break; }
        if (!picked) picked = { dir: d.name, p, j };
      } catch { /* 坏的那一份不要 */ }
    }
  } catch { picked = null; }

  if (!picked) {
    bad(id, '**不可算**：真机那一份 `.removed/` 读不到（这一条判据要它）', LIVE_REMOVED);
  } else {
    const fixtureRoot = nodePath.join(tmp('legacy'), '.removed');
    const fixDir = nodePath.join(fixtureRoot, picked.dir);
    nodeFs.mkdirSync(fixDir, { recursive: true });
    // **逐字节**拷真机那一份（这一条闸只读）。
    nodeFs.copyFileSync(picked.p, nodePath.join(fixDir, RECLAIMED_FILE));
    const legacyBytes = nodeFs.readFileSync(picked.p);
    const rec = JSON.parse(legacyBytes.toString('utf8'));
    const taken = (rec.takenSeqs ?? []).filter(Number.isInteger).slice().sort((a, b) => a - b);

    // ① **今天的读路**：`readReclaimedSeqs` 照旧读出那些号、不抛。
    let seqs = null;
    let readErr = null;
    try { seqs = readReclaimedSeqs({ removedRoot: fixtureRoot }); } catch (e) { readErr = e?.message ?? String(e); }
    const seqsRead = readErr === null && JSON.stringify(seqs) === JSON.stringify(taken);

    // ② 校验器按它解释洞 ⇒ 过（正身：洞真在盘上）。日志只留洞外面那些号。
    let verifyOk = false;
    let verifyWithout = 'n/a';
    let verifyErr = null;
    try {
      const dataDir = tmp('legacyData');
      const max = taken.length ? Math.max(...taken) : 0;
      const min = taken.length ? Math.min(...taken) : 0;
      const seqsOnDisk = [];
      for (let s = 1; s < min; s += 1) seqsOnDisk.push(s);
      if (max) seqsOnDisk.push(max + 1); // 洞后面留一条 ⇒ "中间有洞"那种形状
      const store = seedLog(dataDir, seqsOnDisk);
      const r = store.verifyMonotonic('main', { reclaimed: readReclaimedSeqs({ removedRoot: fixtureRoot }) });
      verifyOk = Number.isInteger(r?.count);
      try { store.verifyMonotonic('main'); verifyWithout = 'passed'; }
      catch { verifyWithout = 'threw'; }
    } catch (e) { verifyErr = e?.message ?? String(e); }

    // ③ 老那一格：本人认得出（legacy），别人**认不出来**（null）。
    const byLegacyOwner = readReclaimBy(rec.by, 'owner', KEY);
    const byAsOther = readReclaimBy(rec.by, 'u2', KEY);

    // ④ 负向对照：读不出来的情形**如实** null / 坏掉的那一份**跳过**。
    const unreadable = reclaimByOf('owner', KEY2);            // 别人的键写的
    const readOut = {
      wrongKey: readReclaimBy(unreadable, 'owner', KEY),
      garbage: readReclaimBy('deadbeef', 'owner', KEY),
      empty: readReclaimBy('', 'owner', KEY),
      missing: readReclaimBy(null, 'owner', KEY),
      nonString: readReclaimBy(123, 'owner', KEY),
    };
    const failsClosed = Object.values(readOut).every((v) => v === null);
    // 坏 JSON 那一份：既不猜成某个人，也**不当它没洞**（`readReclaimedSeqs` 跳过它）。
    const brokenDir = nodePath.join(fixtureRoot, 'broken-1');
    nodeFs.mkdirSync(brokenDir, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(brokenDir, RECLAIMED_FILE), '{ 这不是 JSON');
    const after = readReclaimedSeqs({ removedRoot: fixtureRoot });
    const skippedBroken = JSON.stringify(after) === JSON.stringify(taken);

    const allOk = seqsRead && verifyOk && verifyWithout === 'threw'
      && byLegacyOwner === 'legacy' && byAsOther === null
      && failsClosed && skippedBroken && verifyErr === null;
    if (allOk) {
      ok(id, '真机老留痕逐字节拷进来：今天的读路照旧读得出、校验器照旧解释得了；本人认得出、别人认不出；读不出的如实 null、坏的那份跳过', `${picked.dir} · by=${String(rec.by).slice(0, 12)} · takenSeqs=${JSON.stringify(taken)}`);
    } else {
      bad(id, '存量那条路断了 / 老值被误判 / 读不出来时没如实说', `seqsRead=${seqsRead} verifyOk=${verifyOk} verifyWithout=${verifyWithout} owner=${byLegacyOwner} other=${byAsOther} failsClosed=${failsClosed} skippedBroken=${skippedBroken} err=${verifyErr}`);
    }
  }
}

// ════════════════════════════════════════════════════════════
// ④ 零残留：真机 `.removed/` 逐文件 sha256 跑前跑后一致（＋ 指纹负向对照）
// ════════════════════════════════════════════════════════════
{
  const id = '④';
  if (liveBefore === null) {
    bad(id, '**不可算**：真机 `.removed/` 读不到（这一条判据要它）', LIVE_REMOVED);
  } else {
    const liveAfter = treeDigest(LIVE_REMOVED);
    const unchanged = sameDigest(liveBefore, liveAfter);
    // 负向对照：改一个字节 ⇒ 指纹必须变（证明这条判据不是恒等的空转）
    const d = tmp('digest-control');
    nodeFs.writeFileSync(nodePath.join(d, 'x'), 'one');
    const d1 = treeDigest(d);
    nodeFs.writeFileSync(nodePath.join(d, 'x'), 'two');
    const d2 = treeDigest(d);
    const detector = !sameDigest(d1, d2);
    if (unchanged && detector) {
      ok(id, '真机 `.removed/` 逐文件 sha256 跑前跑后一致 —— **零残留**（这一条闸全程只读）', `${liveAfter.size} 个条目不变`);
    } else {
      bad(id, '真机上多了/少了/改了文件，或指纹检测器是空转的', `unchanged=${unchanged} detector=${detector} 前 ${liveBefore.size} → 后 ${liveAfter.size}`);
    }
  }
}
NODE

out="$(HUPO_CORE="$CORE" HUPO_PROBE_TMP="$T" HUPO_LIVE_DATA="$LIVE_DATA" "$NODE" "$T/reclaim-by-probe.mjs" 2>&1)"
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
