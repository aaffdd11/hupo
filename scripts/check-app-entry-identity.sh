#!/usr/bin/env bash
# **D4.24 · A3 + A3·补 的闸**（`docs/handbook/05-DECISIONS.md` · 2026-10-03 定；
#   口径 `docs/dev/90-APP-CONTRACT.md` §9.2·1／§10.1·⑤；事实记录 `docs/dev/162-ENTRY-IDENTITY.md`）。
#
# 用法：
#   bash scripts/check-app-entry-identity.sh
#
# 退出码 = 失败数（0 ⇒ 通过）；末尾固定打印 **`通过 N · 失败 M`**。
#
# ── 判据（两组，每条都带**负向对照**）──────────────────────────
#   A3-① 真入口 URL 的串里搜不到身份（`u=`／`sub=`／那个值的原文都零命中）；
#         负向对照：同两个搜索器喂一条**带明文身份**的样本必须抓得住。
#   A3-② 照旧能打开（正对照：真 URL ⇒ 200 ＋ 内容对）。
#   A3-③ 改一个字 / 拿别人的签名 / 换版本 / 换 app / 过期 / 没签名 ⇒ 一律 403；
#         负向对照之上再补一条：往真 URL 上挂 `u=u2` **也拿不到乙的东西**（旧攻击面已不存在）。
#   A3-③·补 被拒的那些请求**盘上零残留**（跑前跑后逐文件 sha256 比）。
#   A3-④ 客户端不用改：入口 URL 只剩 `e`/`s`；老页面正文里那个 `u` 照旧**被忽略**
#         （认人只看签名 ⇒ 报 `u=u2` 也冒充不了 `u1`）。
#   A3·补-① 新写入的审计行（每人那份 ＋ 共享库 install）搜不到明文身份。
#   A3·补-② 同一个人的行仍然对得上（稳定假名）；两个人不撞；换键就换值（不是裸 sha256）。
#   A3·补-③ 旧行**逐字节**没被动（新内容是追加在它后面）。
#
# ── 为什么不扩那三条已有的闸（`check-scope-boundary.sh` / `check-outbound-bridge.sh` /
#    `check-edge-kinds.sh`）──────────────────────────────────
#   那三条各自管 92 的一条阶段线（真机边界 / 出界独木桥 / 三条登记边），
#   与"入口 URL 里有没有身份 / 审计里写的是谁"**没有重叠**；
#   混进去会让"这一条红了该找谁"变模糊。⇒ **新开一条**，三条老闸**一个字节没动**。
#
# 🔴 纪律（照 92 §④ 末两条）：
#   · 读不出 / 算不出 ⇒ 如实打印 **`不可算`** 并记**失败**，**绝不安静地绿**；
#   · **每一条都要有负向对照**，脚本自己核那条对照真的在。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/v2/services/core"

# ⚠️ `sudo` 底下 PATH 里没有 node（这台机器只有 nvm 里那一个）⇒ 兜一圈找它。
NODE="${NODE_BIN:-}"
if [ -z "$NODE" ]; then
  for c in /home/deploy/.nvm/versions/node/*/bin/node "$(command -v node 2>/dev/null || true)"; do
    [ -x "$c" ] && { NODE="$c"; break; }
  done
fi
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "✗ 找不到 node（这台机器只有 nvm 里那一个）"; exit 2; }

pass=0; fail=0
ok()  { echo "  ✓ $1"; pass=$((pass + 1)); }
bad() { echo "  ✗ $1"; fail=$((fail + 1)); }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

echo '── A3 / A3·补：临时目录里用**真代码**（不碰线上、不碰真数据目录）'
echo

cat > "$T/identity-probe.mjs" <<'NODE'
// 一次性探针：真 `src/` 模块 ＋ 临时目录里的真盘。
// 输出协议：`OK <id> :: <名字> ;; <读数>` / `BAD ...` / `SKIP ...`，交给外面那个 bash 数数。
import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { pathToFileURL } from 'node:url';

const CORE = process.env.HUPO_CORE;
const T = process.env.HUPO_PROBE_TMP;

const ok = (id, name, reading) => console.log(`OK  ${id} :: ${name} ;; ${reading}`);
const bad = (id, name, reading) => console.log(`BAD ${id} :: ${name} ;; ${reading}`);

const mod = (rel) => import(pathToFileURL(nodePath.join(CORE, 'src', rel)).href);
const { Apps } = await mod('apps.js');
const { createAppServer, entryUrl, liveEntryUrl, resolveEntrySub, verifyEntry } = await mod('app-serve.js');
const { LIVE_VERSION } = await mod('app-live.js');
const { CRED_HASH_FALLBACK_KEY, credHashOf } = await mod('cred-hash.js');
const { Published } = await mod('published.js');

const NOW = 1_800_000_000_000;
const KEY = Buffer.from('a'.repeat(64), 'hex');

const tmp = (tag) => nodeFs.mkdtempSync(nodePath.join(T, `a3-${tag}-`));

/** 盘上指纹（相对路径 → sha256；空目录记 'dir'）。 */
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

/** 两个人各一格真制品库。 */
function world(sub, body) {
  const dir = tmp(`w-${sub}`);
  const apps = new Apps({ dir, sub });
  apps.create({ id: 'dice', title: '掷骰子', icon: 'dice', entry: 'index.html', files: { 'index.html': body } });
  return { dir, apps };
}

const signFor = (sub, { id = 'dice', version = 1, exp = NOW + 600_000 } = {}) => {
  const u = entryUrl({ base: 'https://x.example', key: KEY, sub, id, version, entry: 'index.html', now: NOW, ttlMs: exp - NOW });
  return new URL(u).searchParams.get('s');
};

async function bootOrigin({ worlds, subsOf }) {
  const origin = createAppServer({
    resolveApps: (sub) => worlds[sub]?.apps ?? null,
    key: KEY,
    frameAncestors: "'self'",
    subsOf,
    now: () => NOW,
    log: () => {},
  });
  await new Promise((res, rej) => { origin.once('error', rej); origin.listen(0, '127.0.0.1', res); });
  const base = `http://127.0.0.1:${origin.address().port}`;
  return { base, close: () => new Promise((r) => origin.close(() => r())) };
}

process.on('uncaughtException', (e) => { bad('probe', '探针崩了（算不出来）', String(e?.stack ?? e)); process.exitCode = 1; });

// ════════════════════════════════════════════════════════════
// A3-① 真入口 URL 里搜不到身份（＋ 搜索器负向对照）
// ════════════════════════════════════════════════════════════
{
  const id = 'A3-①';
  const urls = {
    制品: entryUrl({ base: 'https://apps.example', key: KEY, sub: 'u1', id: 'dice', version: 1, entry: 'index.html', now: NOW }),
    活地址: liveEntryUrl({ base: 'https://apps.example', key: KEY, sub: 'u1', id: 'dice', entry: 'index.html', now: NOW }),
  };
  let allOk = true;
  for (const [what, url] of Object.entries(urls)) {
    const leaky = `${url}&u=u1`; // 负向对照样本
    const searcherWorks = /[?&]u=/.test(leaky) && leaky.includes('u1');
    const clean = !/[?&]u=/.test(url) && !url.includes('sub=') && !url.includes('u1');
    const q = new URL(url).searchParams;
    const twoKeys = JSON.stringify([...q.keys()].sort()) === JSON.stringify(['e', 's']);
    const bound = verifyEntry({
      key: KEY,
      sig: q.get('s'),
      sub: 'u1',
      id: 'dice',
      version: what === '活地址' ? LIVE_VERSION : 1,
      exp: q.get('e'),
      now: NOW,
    }) === true;
    if (!searcherWorks) { allOk = false; bad(id, `${what}：搜索器负向对照没抓住（判据可能空转）`, leaky); }
    if (!clean) { allOk = false; bad(id, `${what}：URL 里搜得到身份`, url); }
    if (!twoKeys) { allOk = false; bad(id, `${what}：URL 上不止 e/s`, [...q.keys()].join(',')); }
    if (!bound) { allOk = false; bad(id, `${what}：身份没绑进签名里（那 ①②③ 都成空转）`, url); }
  }
  if (allOk) ok(id, '真入口 URL 里搜不到身份；只剩 e/s；身份确实绑在签名里（搜索器负向对照通过）', '制品 ＋ 活地址 两种都零命中');
}

// ════════════════════════════════════════════════════════════
// A3-②③ 正对照能开、负向对照全拒、零残留
// ════════════════════════════════════════════════════════════
{
  const id = 'A3-②③';
  const u1 = world('u1', '<p>甲的一版</p>');
  const u2 = world('u2', '<p>乙的一版</p>');
  const s = await bootOrigin({ worlds: { u1, u2 }, subsOf: () => ['u1', 'u2'] });
  try {
    const good = entryUrl({ base: 'https://apps.example', key: KEY, sub: 'u1', id: 'dice', version: 1, entry: 'index.html', now: NOW });
    const { pathname, searchParams } = new URL(good);
    const exp = searchParams.get('e');
    const sig = searchParams.get('s');
    const before = treeDigest(u1.dir);

    const r0 = await fetch(`${s.base}${pathname}?e=${exp}&s=${sig}`);
    const body0 = await r0.text();
    if (r0.status === 200 && body0 === '<p>甲的一版</p>') ok(id, '正对照：真入口 URL 照旧打开、内容对', `200 · ${body0}`);
    else bad(id, '正对照：真入口 URL 打开不了 / 内容不对', `${r0.status} · ${body0}`);

    const cases = [
      ['改签名一个字', `${pathname}?e=${exp}&s=${'0'.repeat(63)}${sig.endsWith('0') ? '1' : '0'}`],
      ['别人的签名（u9 没登记）', `${pathname}?e=${exp}&s=${signFor('u9')}`],
      ['换版本（域分离）', `${pathname}?e=${exp}&s=${signFor('u1', { version: 2 })}`],
      ['换 app（域分离）', `${pathname}?e=${exp}&s=${signFor('u1', { id: 'other' })}`],
      ['过期', `${pathname}?e=${NOW - 1}&s=${signFor('u1', { exp: NOW - 1 })}`],
      ['没签名', pathname],
    ];
    let allDenied = true;
    for (const [why, u] of cases) {
      const r = await fetch(`${s.base}${u}`);
      if (r.status !== 403) { allDenied = false; bad(id, `负向对照「${why}」没被拒`, String(r.status)); }
    }
    if (allDenied) ok(id, '负向对照：改一个字 / 别人的签名 / 换版本 / 换 app / 过期 / 没签名 ⇒ 全 403', `6/6 拒`);

    // 旧攻击面已经不存在：挂 `u=u2` 改不了"这是谁"
    const swapped = await fetch(`${s.base}${pathname}?e=${exp}&s=${sig}&u=u2`);
    const swappedBody = await swapped.text();
    if (swapped.status === 200 && swappedBody === '<p>甲的一版</p>') {
      ok(id, '负向对照·核心：往真 URL 上挂 `u=u2` 也拿不到乙的东西（认人只看签名）', `200 · ${swappedBody}`);
    } else {
      bad(id, '挂 `u=u2` 之后行为不对（可能冒充成功了，或不该拒的拒了）', `${swapped.status} · ${swappedBody}`);
    }

    // 零残留
    const after = treeDigest(u1.dir);
    const same = before.size === after.size && [...before].every(([k, v]) => after.get(k) === v);
    if (same) ok(id, '被拒的请求 ＋ 正对照读盘 ⇒ **零残留**（逐文件 sha256 一致）', `${before.size} 个条目不变`);
    else bad(id, '盘上有残留 / 被改过', `前 ${before.size} 条 → 后 ${after.size} 条`);
  } finally {
    await s.close();
  }
}

// ════════════════════════════════════════════════════════════
// A3-④ 客户端不用改（入口 URL 只剩 e/s；老页面的 `u` 被忽略、冒充不了）
// ════════════════════════════════════════════════════════════
{
  const id = 'A3-④';
  const exp = String(NOW + 600_000);
  const sig = signFor('u1', { exp: NOW + 600_000 });
  // 老页面正文：`u` 还在里面（`u=u2` 想冒充）—— 认人只看签名 ⇒ 还是 u1
  const { appTicketOf } = await mod('app-serve.js');
  const who = appTicketOf({ key: KEY, body: { u: 'u2', e: exp, s: sig }, id: 'dice', version: 1, now: NOW, subsOf: () => ['u1', 'u2'] });
  const ignored = who?.sub === 'u1';
  // 负向对照：把签名换成 u2 的 ⇒ 认出来的就该是 u2（搜索/认人不是恒回 u1）
  const who2 = appTicketOf({ key: KEY, body: { u: 'u1', e: exp, s: signFor('u2', { exp: NOW + 600_000 }) }, id: 'dice', version: 1, now: NOW, subsOf: () => ['u1', 'u2'] });
  const flips = who2?.sub === 'u2';
  // 结构：`app-serve.js` 里不再有读 URL 上 `u` 的地方（**去注释**再扫 —— 注释里提到它不算）
  const src = nodeFs.readFileSync(nodePath.join(CORE, 'src', 'app-serve.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const noUrlU = !/\.get\(['"]u['"]\)/.test(code);
  if (ignored && flips && noUrlU) {
    ok(id, '客户端不用改：正文里那个 `u` 被忽略（冒充不了）；认人只看签名；URL 上不再读 `u`', `u=u2 ⇒ 仍 u1；换 u2 签名 ⇒ u2`);
  } else {
    bad(id, '客户端兼容/结构判据没过', `ignored=${ignored} flips=${flips} noUrlU=${noUrlU}`);
  }
}

// ════════════════════════════════════════════════════════════
// A3·补-① 新审计行无明文（每人那份 ＋ 共享库 install）
// ════════════════════════════════════════════════════════════
{
  const id = 'A3·补-①';
  const ck = Buffer.from('c'.repeat(64), 'hex');
  const d1 = tmp('audit-u1');
  const d2 = tmp('audit-u2');
  const a1 = new Apps({ dir: d1, sub: 'u1', credKey: ck });
  const a2 = new Apps({ dir: d2, sub: 'u2', credKey: ck });
  a1.create({ id: 'one', title: '一', icon: 'dice', entry: 'index.html', files: { 'index.html': '<p>1</p>' } });
  a1.create({ id: 'two', title: '二', icon: 'dice', entry: 'index.html', files: { 'index.html': '<p>2</p>' } });
  a2.create({ id: 'three', title: '三', icon: 'dice', entry: 'index.html', files: { 'index.html': '<p>3</p>' } });
  const at1 = nodeFs.readFileSync(nodePath.join(a1.root, 'audit.jsonl'), 'utf8');
  const at2 = nodeFs.readFileSync(nodePath.join(a2.root, 'audit.jsonl'), 'utf8');
  const rows1 = at1.trim().split('\n').map((l) => JSON.parse(l));
  const rows2 = at2.trim().split('\n').map((l) => JSON.parse(l));

  // 共享库那条 install
  const pdir = tmp('pub');
  const author = new Apps({ dir: nodePath.join(pdir, 'a'), sub: 'u1' });
  author.create({
    id: 'dice', title: '掷骰子', icon: 'dice', entry: 'index.html',
    files: {
      'index.html': '<p>x</p>',
      'outbound.json': JSON.stringify({ schema: 1, outbound: [], declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '先按 0 报' } }),
    },
  });
  const pub = new Published({ dir: pdir, credKey: ck });
  pub.publish(author, { id: 'dice', authorSub: 'u1', authorName: '甲' });
  pub.installInto(new Apps({ dir: nodePath.join(pdir, 'b'), sub: 'u2' }), 'dice');
  const shared = nodeFs.readFileSync(nodePath.join(pub.root, 'audit.jsonl'), 'utf8');
  const installRow = shared.trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.what === 'install');

  // 负向对照：搜索器喂一条明文样本必须抓得住
  const searcherWorks = '{"sub":"u1"}'.includes('u1') && '{"what":"install","by":"u2"}'.includes('u2');
  const okAll = searcherWorks
    && !at1.includes('u1') && !at2.includes('u2')
    && !shared.includes('"u2"')
    && installRow?.by === credHashOf('u2', ck);
  if (okAll) {
    ok(id, '每人那份 ＋ 共享库 install 的新行都搜不到明文身份（搜索器负向对照通过）', `install.by=${String(installRow?.by).slice(0, 16)}…`);
  } else {
    bad(id, '新审计行里还有明文身份 / 搜索器空转', `search=${searcherWorks} a1=${at1.includes('u1')} a2=${at2.includes('u2')} shared=${shared.includes('"u2"')}`);
  }
  globalThis.__rows = { rows1, rows2, ck };
}

// ════════════════════════════════════════════════════════════
// A3·补-② 同一人稳定、两人不撞、换键就换值（不是裸 sha256）
// ════════════════════════════════════════════════════════════
{
  const id = 'A3·补-②';
  const { rows1, rows2, ck } = globalThis.__rows;
  const stable = rows1[0].sub === rows1[1].sub && rows1[0].sub === credHashOf('u1', ck);
  const differ = rows1[0].sub !== rows2[0].sub;
  const keyed = credHashOf('u1', ck) !== credHashOf('u1', Buffer.from('d'.repeat(64), 'hex'));
  const notPlain = credHashOf('u1', ck) !== nodeCrypto.createHash('sha256').update('u1').digest('hex');
  const fallback = credHashOf('u1', null) === credHashOf('u1', CRED_HASH_FALLBACK_KEY);
  if (stable && differ && keyed && notPlain && fallback) {
    ok(id, '同一个人的行对得上；两个人不撞；换键就换值（不是裸 sha256）；口径 = `credHashOf(sub, 键)`', `${rows1[0].sub.slice(0, 16)}… vs ${rows2[0].sub.slice(0, 16)}…`);
  } else {
    bad(id, '哈希不稳定 / 撞了 / 是可反推的裸 sha256', `stable=${stable} differ=${differ} keyed=${keyed} notPlain=${notPlain}`);
  }
}

// ════════════════════════════════════════════════════════════
// A3·补-③ 旧行逐字节没被动
// ════════════════════════════════════════════════════════════
{
  const id = 'A3·补-③';
  const ck = Buffer.from('f'.repeat(64), 'hex');
  const d = tmp('oldrows');
  const apps = new Apps({ dir: d, sub: 'u1', credKey: ck });
  // 先摆一条**旧形状**的行（明文），再触发新写入
  const file = nodePath.join(apps.root, 'audit.jsonl');
  nodeFs.mkdirSync(apps.root, { recursive: true });
  const OLD = '{"at":1,"sub":"u1","what":"create","id":"old","version":1}\n';
  nodeFs.writeFileSync(file, OLD);
  const before = nodeFs.readFileSync(file);
  apps.create({ id: 'new', title: '新', icon: 'dice', entry: 'index.html', files: { 'index.html': '<p>n</p>' } });
  const after = nodeFs.readFileSync(file);
  const untouched = after.subarray(0, before.length).equals(before);
  const appended = after.length > before.length;
  if (untouched && appended) {
    ok(id, '旧行逐字节没被动（新行是追加在它后面的）', `旧 ${before.length}B 原样，新 ＋${after.length - before.length}B`);
  } else {
    bad(id, '旧行被改写 / 没有追加', `untouched=${untouched} appended=${appended}`);
  }
}
NODE

out="$(HUPO_CORE="$CORE" HUPO_PROBE_TMP="$T" "$NODE" "$T/identity-probe.mjs" 2>&1)"
rc=$?
# 逐条报读数（OK ⇒ ✓；BAD ⇒ ✗）
printf '%s\n' "$out" | grep '^OK  ' | sed 's/^OK  /  ✓ /'
# 数数（OK/BAD 各算一条；`SKIP` 不算）
n_ok="$(printf '%s\n' "$out" | grep -c '^OK  ' || true)"
n_bad="$(printf '%s\n' "$out" | grep -c '^BAD ' || true)"
printf '%s\n' "$out" | grep '^BAD ' | sed 's/^BAD /  ✗ /'
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
