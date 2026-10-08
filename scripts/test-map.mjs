#!/usr/bin/env node
// **测试映射与文件隔离树** —— 「改了哪个文件 ⇒ 该跑哪些测试、明确不必跑哪些」。
//
// 用法：
//   node scripts/test-map.mjs --for <改动路径…>     # 打印"改动中要跑什么"（一行一条命令）
//   node scripts/test-map.mjs --tree                # 隔离树（分区 · 隔离度 · 枢纽）
//   node scripts/test-map.mjs --file <路径>         # 看一个文件：谁依赖它、哪些测试盖得住它（分层）
//   node scripts/test-map.mjs --why <测试路径>      # 一个测试为什么会被选中（它够得到哪些源文件）
//
// ── 为什么要有它（主人 2026-10-09 的指令）────────────────────
//   「接下来跑测试不能跑那么多测试了……需要做一个 mapping：哪些功能改动，需要做哪些测试、
//     不需要做哪些测试。」旧的 `scripts/gate-quick.sh` 是**手写的同名约定**
//     （`src/x.js` ⇒ `test/x.test.js`），找不到同名判据就**退回全闸** ——
//     而"退回全闸"正是要消掉的那件事。
//
// ── 它怎么分层（**这是全部的方法**）──────────────────────────
//   🔴 先把每个测试**真正够得到的本地文件**算出来（import 闭包 ＋ 测试里以字符串读的路径），
//      再按**距离**分层：
//        · **距离 1** ＝ 这个测试**直接** import 了它（或直接读它）⇒ **必跑**；
//        · **距离 ≥2** ＝ 要走一个或多个中间模块才够得到 ⇒ 记为"**可能**"（只报数，不出命令）。
//
//   ⚠️ **为什么"可能"那一层不算必跑**（这是刻意的取舍，不是偷懒）：
//      本仓库服务端的测试**几乎都 import `server.js`**，而 `server.js` 又 import 了一大片
//      ⇒ 传递闭包会**退化成"几乎全跑"**（实测：改 `app-lint.js` 会选中 85 份）。
//      所以"少跑"的边界只能是**过程**上的，不是静态保证：
//        · **改动中**：跑距离 1 那些（快）；
//        · **收尾**：跑全闸（`scripts/gate-server.sh` · `scripts/check-client.sh`）——
//          它才是"可能那一层"的兜底。契约 [`docs/dev/213-GATES-CHEAPER.md`](../docs/dev/213-GATES-CHEAPER.md)。
//      🔴 **绝不把"改动中"当成"收尾"**：那等于拿"页面在说假话"换速度。
//
// ── 它不保证什么（如实说）──────────────────────────────────
//   · 只认三种边：`import/export/require`、Dart 的 `package:hupo_app/…` 与相对 import、
//     以及测试里**像路径的字符串字面量**。认不出的边 ⇒ 那个测试不会被选中 ⇒ **漏跑**。
//   · 🔴 **认不出的改动路径一律打印 `FULL`**（退回全闸），**绝不悄悄放过**。
//   · 它不管"测试跑不跑得过" —— 那是测试自己的事。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

const ROOT = nodePath.resolve(import.meta.dirname, '..');
const SERVER = nodePath.join(ROOT, 'v2/services/core');
const APP = nodePath.join(ROOT, 'v2/apps/mobile');

const args = process.argv.slice(2);
const mode = args[0] ?? '--tree';
const rest = args.slice(1);

const SRC_EXT = new Set(['.js', '.mjs', '.dart']);
const rel = (abs) => nodePath.relative(ROOT, abs).split(nodePath.sep).join('/');

function walk(dir, out = []) {
  let entries;
  try {
    entries = nodeFs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'build' || e.name === '.dart_tool' || e.name === 'data') continue;
    const p = nodePath.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

// ── ① 文件全集 ──────────────────────────────────────────────────
const serverSrc = walk(nodePath.join(SERVER, 'src')).filter((f) => SRC_EXT.has(nodePath.extname(f)));
const appLib = walk(nodePath.join(APP, 'lib')).filter((f) => nodePath.extname(f) === '.dart');
const serverTests = walk(nodePath.join(SERVER, 'test')).filter((f) => f.endsWith('.test.js'));
const appUnit = walk(nodePath.join(APP, 'test/unit')).filter((f) => f.endsWith('_test.dart'));
const appWidget = walk(nodePath.join(APP, 'test/widget')).filter((f) => f.endsWith('_test.dart'));
const appConfig = walk(nodePath.join(APP, 'test')).filter((f) => nodePath.basename(f) === 'flutter_test_config.dart');

const ALL = new Set([...serverSrc, ...appLib, ...serverTests, ...appUnit, ...appWidget, ...appConfig].map(rel));

// ── ② 依赖边 ────────────────────────────────────────────────────
function edgesOf(abs) {
  const text = nodeFs.readFileSync(abs, 'utf8');
  const out = new Set();
  const from = nodePath.dirname(abs);

  const push = (spec) => {
    if (typeof spec !== 'string' || spec === '') return;
    let target = null;
    if (spec.startsWith('package:hupo_app/')) target = nodePath.join(APP, 'lib', spec.slice('package:hupo_app/'.length));
    else if (spec.startsWith('.')) target = nodePath.resolve(from, spec);
    else if (spec.startsWith('/') && spec.startsWith(ROOT)) target = spec;
    else return;
    for (const c of [target, `${target}.js`, `${target}.mjs`, `${target}.dart`, nodePath.join(target, 'index.js')]) {
      const r = rel(c);
      if (ALL.has(r)) { out.add(r); return; }
    }
  };

  for (const m of text.matchAll(/(?:from|require\s*\(|import\s*\()\s*['"]([^'"]+)['"]/g)) push(m[1]);
  for (const m of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) push(m[1]);
  for (const m of text.matchAll(/^\s*export\s+\*\s+from\s+['"]([^'"]+)['"]/gm)) push(m[1]);
  if (/\.test\.js$|_test\.dart$|flutter_test_config\.dart$/.test(abs)) {
    for (const m of text.matchAll(/['"]([^'"\n]*\/[^'"\n]*)['"]/g)) {
      const spec = m[1];
      if (!/\.(js|mjs|dart|md|json|yml|yaml|sh|html|conf|txt)$/.test(spec)) continue;
      push(spec.startsWith('.') ? spec : `./${spec}`);
      const rr = rel(nodePath.join(ROOT, spec));
      if (ALL.has(rr)) out.add(rr);
    }
  }
  out.delete(rel(abs));
  return out;
}

const EDGES = new Map();
for (const abs of [...serverSrc, ...appLib, ...serverTests, ...appUnit, ...appWidget, ...appConfig]) {
  EDGES.set(rel(abs), edgesOf(abs));
}

const REV = new Map();
for (const [f, deps] of EDGES) for (const d of deps) {
  if (!REV.has(d)) REV.set(d, new Set());
  REV.get(d).add(f);
}

/** 从一个测试出发的**分层距离**：文件 → 第几跳够到它。 */
function distanceMap(start) {
  const dist = new Map();
  let frontier = [start];
  let level = 0;
  while (frontier.length) {
    level += 1;
    const next = [];
    for (const cur of frontier) {
      for (const nxt of EDGES.get(cur) ?? []) {
        if (dist.has(nxt)) continue;
        dist.set(nxt, level);
        next.push(nxt);
      }
    }
    frontier = next;
  }
  return dist;
}

const TESTS = [...serverTests, ...appUnit, ...appWidget, ...appConfig].map(rel);
const TEST_DIST = new Map(TESTS.map((t) => [t, distanceMap(t)]));

/** 改这个文件，哪些测试**直接**够得到（距离 1）／要走中间模块（距离 ≥2）。 */
function testsFor(r) {
  const must = [];
  const maybe = [];
  for (const [t, dist] of TEST_DIST) {
    const d = dist.get(r);
    if (d === 1) must.push(t);
    else if (d !== undefined) maybe.push(t);
  }
  return { must, maybe };
}
const fanIn = (r) => (REV.get(r) ?? new Set()).size;

// ── ③ 常驻守卫（不靠 import 也成立的那几条）────────────────────
// ⚠️ 只写"为什么它必须跟着跑"。
const CLIENT_GUARDS = [
  // 楼层闸：它**静态扫整个 lib 树**（不靠 import）⇒ 任何 lib 改动都要跑
  'v2/apps/mobile/test/unit/import_rules_test.dart',
];
// 服务端：文本读 `docs/handbook*/08-SPEC.md` 与 `src/*.js` 的那两份
const SERVER_TEXT_READERS = {
  'v2/services/core/src/server.js': ['v2/services/core/test/route-shape.test.js', 'v2/services/core/test/server-wiring.test.js'],
  'v2/services/core/src/serve.js': ['v2/services/core/test/server-wiring.test.js'],
  'v2/services/core/src/asr.js': ['v2/services/core/test/route-shape.test.js'],
  'v2/services/core/src/dev-mode.js': ['v2/services/core/test/route-shape.test.js'],
};

// ── ④ 分区（只给 `--tree` 报告用）───────────────────────────────
const SERVER_FAMILIES = [
  [/^asr|^voice/, 'voice'],
  [/^app-|^apps|^workspace$|^published$|^main-leak$/, 'apps'],
  [/^image|^video|^ark-check/, 'media'],
  [/^ledger|^usage$/, 'ledger'],
  [/^auth|^cred|^users$|^owner-creds|^key-|^reauth|^audit$/, 'identity'],
  [/^tenants?$|^provision|^product-layer|^admission|^disk-|^oom$/, 'supply'],
  [/^job$|^worklog|^work-words|^plan$/, 'jobs'],
];
function zoneOf(r) {
  if (r.startsWith('v2/services/core/src/')) {
    const name = r.slice('v2/services/core/src/'.length).replace(/\.[^.]+$/, '');
    for (const [re, z] of SERVER_FAMILIES) if (re.test(name)) return `server:${z}`;
    return 'server:core';
  }
  if (r.startsWith('v2/services/core/test/')) return 'server-test';
  if (r.startsWith('v2/apps/mobile/lib/')) {
    const p = r.slice('v2/apps/mobile/lib/'.length).split('/');
    return p.length > 1 ? `client:${p[0]}` : 'client:root';
  }
  if (r.startsWith('v2/apps/mobile/test/')) return 'client-test';
  return 'other';
}

function commandFor(testRel) {
  if (testRel.startsWith('v2/services/core/test/')) return `cd v2/services/core && node --test test/${nodePath.basename(testRel)}`;
  if (testRel.startsWith('v2/apps/mobile/test/')) return `cd v2/apps/mobile && ~/sdk/flutter/bin/flutter test ${testRel.slice('v2/apps/mobile/'.length)}`;
  return null;
}

// ── ⑤ --for ─────────────────────────────────────────────────────
// **不是代码**的那些路径（文档 / 配置 / 脚本）：它们不进依赖图，但各有各的闸。
// ⚠️ 这几条是**白名单**：认不出的路径一律 `FULL`（退回全闸），绝不悄悄放过。
const NON_CODE = [
  // ⚠️ **这一条必须在通用 `docs/**` 那条前面**（`.find()` 取第一条命中）——
  //    2026-10-09 实测：写在后面等于**死代码**，改 `08-SPEC.md` 只挑出文档闸，
  //    "手册 ←→ 代码"那五条形状闸**一条都不跑**（"闸没打在改动上"）。
  [/^docs\/handbook(-v3)?\/08-SPEC\.md$/, () => [
    'node scripts/check-docs.mjs',
    'cd v2/services/core && node --test test/route-shape.test.js test/disk-grade.test.js test/disk-watch.test.js test/health-shape.test.js test/reverse-drift.test.js',
  ]],
  [/^docs\/.*\.md$/, () => ['node scripts/check-docs.mjs']],
  [/^[A-Za-z-]+\.md$|^docs\/.*\.md$/, () => ['node scripts/check-docs.mjs']],
  [/^v2\/services\/core\/hupo-persona\.yml$/, () => ['bash scripts/check-persona.sh', 'cd v2/services/core && node --test test/persona.test.js']],
  [/^v2\/services\/core\/hupo-.*\.yml$/, () => ['cd v2/services/core && npm test']],
  [/^v2\/services\/core\/package\.json$/, () => ['cd v2/services/core && npm test']],
  [/^v2\/services\/core\/review-policy\.json$/, () => ['cd v2/services/core && node --test test/review-policy-layer.test.js']],
  [/^scripts\/[^/]+\.sh$/, (p) => [`bash -n ${p}`]],
  [/^scripts\/[^/]+\.mjs$/, (p) => [`node --check ${p}`]],
];

if (mode === '--for') {
  const must = new Set();
  const unknown = [];
  let libTouched = false;
  let maybeMax = 0;

  for (const raw of rest) {
    const r = raw.split(nodePath.sep).join('/').replace(/^\.\//, '');
    if (!ALL.has(r)) {
      const rule = NON_CODE.find(([re]) => re.test(r));
      if (rule) { for (const c of rule[1](r)) must.add(c); continue; }
      unknown.push(r);
      continue;
    }
    if (r.startsWith('v2/apps/mobile/lib/')) libTouched = true;
    if (r.includes('/test/') || r.endsWith('_test.dart')) { must.add(r); continue; }
    const base = nodePath.basename(r).replace(/\.[^.]+$/, '');
    for (const cand of [`v2/services/core/test/${base}.test.js`, `v2/apps/mobile/test/unit/${base}_test.dart`, `v2/apps/mobile/test/widget/${base}_test.dart`]) {
      if (ALL.has(cand)) must.add(cand);
    }
    const { must: m, maybe } = testsFor(r);
    for (const t of m) must.add(t);
    maybeMax = Math.max(maybeMax, maybe.length);
    for (const t of SERVER_TEXT_READERS[r] ?? []) must.add(t);
  }
  if (libTouched) for (const g of CLIENT_GUARDS) must.add(g);

  const lines = [];
  if (unknown.length) lines.push('FULL');
  if (libTouched) lines.push('cd v2/apps/mobile && ~/sdk/flutter/bin/flutter analyze');
  for (const t of [...must].sort()) {
    const c = t.includes(' ') || t.startsWith('cd ') || t.startsWith('node ') || t.startsWith('bash ') ? t : commandFor(t);
    if (c) lines.push(c);
  }
  for (const l of lines) console.log(l);

  if (unknown.length) console.error(`⚠️ 这几条认不出（不在依赖图、也不在白名单里）⇒ **退回全闸**：${unknown.join(' · ')}`);
  if (!lines.length) console.error('⚠️ 一条都没挑出来 ⇒ 这次改动今天没有对应测试（**如实说**，别当成"过了"）');
  if (maybeMax) console.error(`ℹ️ 另有最多 ${maybeMax} 份测试是**经中间模块**够得到它的（不在上面）—— 那些留给收尾全闸。`);
  console.error('⚠️ 这**不是**收尾：收尾仍要跑全闸（scripts/gate-server.sh · scripts/check-client.sh）。');
  process.exit(0);
}

// ── ⑥ --why / --file / --tree ──────────────────────────────────
if (mode === '--why') {
  const t = rest[0];
  if (!TEST_DIST.has(t)) { console.error(`不是测试文件（或不在图里）：${t}`); process.exit(2); }
  console.log(`▶ ${t} 够得到 ${TEST_DIST.get(t).size} 个本地文件：`);
  for (const [f, d] of [...TEST_DIST.get(t)].sort((a, b) => a[1] - b[1])) console.log(`   ${d} 跳  ${f}`);
  process.exit(0);
}

if (mode === '--file') {
  const r = rest[0];
  if (!ALL.has(r)) { console.error(`不在图里：${r}`); process.exit(2); }
  const { must, maybe } = testsFor(r);
  console.log(`▶ ${r}`);
  console.log(`  区：${zoneOf(r)} · 扇入：${fanIn(r)} · 直接盖住它的测试：${must.length} · 经中间模块：${maybe.length}`);
  console.log('  **必跑**（距离 1）：');
  for (const t of must) console.log(`   · ${t}`);
  console.log('  **可能**（距离 ≥2，改动中不跑、收尾全闸兜）：');
  for (const t of maybe.slice(0, 20)) console.log(`   · ${t}`);
  if (maybe.length > 20) console.log(`   … 还有 ${maybe.length - 20} 份`);
  process.exit(0);
}

const byZone = new Map();
for (const r of ALL) {
  const z = zoneOf(r);
  if (!byZone.has(z)) byZone.set(z, []);
  byZone.get(z).push(r);
}
const edgeCount = [...EDGES.values()].reduce((n, s) => n + s.size, 0);
console.log(`▶ 文件隔离树（**现算**：${ALL.size} 个文件 · ${edgeCount} 条依赖边 · ${TESTS.length} 份测试）`);
console.log('');
console.log('区 · 文件 · 改本区"必跑"的测试数 · 本区往外依赖哪些区（越少越隔离）');
for (const [z, files] of [...byZone].sort()) {
  const must = new Set();
  for (const f of files) for (const t of testsFor(f).must) must.add(t);
  const out = new Map();
  for (const f of files) for (const d of EDGES.get(f) ?? []) {
    const dz = zoneOf(d);
    if (dz !== z) out.set(dz, (out.get(dz) ?? 0) + 1);
  }
  const outTxt = [...out.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k}×${n}`).join(' · ') || '（不出区 —— ****完全隔离****）';
  console.log(`${z.padEnd(16)} ${String(files.length).padStart(3)}   ${String(must.size).padStart(3)}   ${outTxt}`);
}
console.log('');
const noTest = [...ALL].filter((f) => { const { must, maybe } = testsFor(f); return must.length + maybe.length === 0; });
console.log(`▶ 有 ${noTest.length}/${ALL.size} 个文件**任何测试都够不到** —— 改它们时映射会照实说"一条都没有"（那是实话，不是"过了"）`);
console.log('');
console.log('▶ 全库枢纽（改它们"必跑"的面最大 —— 前 12 名）：');
for (const [f, n] of [...ALL].map((f) => [f, testsFor(f).must.length]).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`   必跑 ${String(n).padStart(3)} 份   ${f}`);
}
