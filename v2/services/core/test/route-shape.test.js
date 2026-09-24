// **手册的接口表 ⇄ 代码里真实的路由**（防漂闸 · 2026-09-24）。
//
// ── 为什么要有它 ────────────────────────────────────────────
//   手册 `08-SPEC.md` §2.1 是"**线上有哪些路**"的**唯一权威**。而代码是另一处。
//   两边靠人同步 ⇒ 一定会漂，而且**漂了没人发现**：
//     · 加了路由没写进表 ⇒ 下一个人按手册做，不知道有这条路；
//     · 表里写着一条其实没有的路 ⇒ **手册在说假话**（这个项目最忌的形状）。
//   ⇒ 这条闸三个方向都盯（P1-12 `health-shape.test.js` 是它的先例）。
//
// ⚠️ **只扫 §2.1 那一节**：手册别处也会提到 `/api/…`（例如 §10.4 成本表里
//    "给 `/api/debug/analyze` 定限额"那种 —— 那是**目标态**，不是"现在有这条路"）。
//    扫全篇会把那些当成"表里说有、代码没有" ⇒ 一片假红（"每次都响的报警等于没有报警"）。
//
// ⚠️ **那几种"如实说不存在"的写法要认**：`~~…~~`、`⏳ 不存在` ——
//    手册已经这样标了（`/api/health/local`、`/api/receipt`、`/api/conversations`、
//    `/api/debug/*`），这条闸要**认这个标法**，并且反过来：标了不存在的**真的不许存在**。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

const REPO = nodePath.resolve(import.meta.dirname, '../../../..');
const SPEC = nodePath.join(REPO, 'docs/handbook/08-SPEC.md');
const SERVER = nodePath.join(REPO, 'v2/services/core/src/server.js');
const ASR = nodePath.join(REPO, 'v2/services/core/src/asr.js');
const HARNESS = nodePath.join(REPO, 'v2/services/core/src/harness-session.mjs');
const DEV_MODE = nodePath.join(REPO, 'v2/services/core/src/dev-mode.js');

/** 手册 §2.1 那一节（从它的标题到下一个同级/更高级标题）。 */
function interfaceSection() {
  const lines = nodeFs.readFileSync(SPEC, 'utf8').split('\n');
  const start = lines.findIndex((l) => /^### 2\.1 /.test(l));
  assert.ok(start >= 0, '手册里找不到 §2.1 那一节（标题改了就要回来改这条闸）');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{2,3} /.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end);
}

/**
 * **路径只住在常量里**的那几条路（`server.js` 里只有常量名，没有字面量）。
 *
 * ⚠️ 为什么单列一张表：这三条（`/api/harness`、`/api/dev-harness`、`/api/dev-mode`）
 *    是从常量模块加进来的，而这条闸原先**只扫 `server.js` 的字面量** ⇒
 *    它们**既没进手册、也没被闸盖住**（闸全绿，却漏了三条）。
 * ⇒ 现在逐条认常量，而且**取不到就红**：常量被改名/删掉时不许静默漏掉。
 */
const PATH_CONSTANTS = [
  { file: ASR, name: 'ASR_PATH' }, // /api/asr
  { file: HARNESS, name: 'HARNESS_PATH' }, // /api/harness
  { file: DEV_MODE, name: 'DEV_MODE_PATH' }, // /api/dev-mode
  { file: DEV_MODE, name: 'DEV_HARNESS_PATH' }, // /api/dev-harness
];

/** 代码里真实存在的 `/api/…`（`server.js` 的字面量 ＋ 上表那几个常量）。 */
function routesInCode() {
  const src = nodeFs.readFileSync(SERVER, 'utf8');
  const out = new Set();
  for (const m of src.matchAll(/'(\/api\/[a-z0-9/_-]+)'/g)) out.add(m[1]);
  for (const { file, name } of PATH_CONSTANTS) {
    const text = nodeFs.readFileSync(file, 'utf8');
    // ⚠️ `\b` 保证 `HARNESS_PATH` **不会**匹配到 `DEV_HARNESS_PATH` 里面那一段。
    const m = new RegExp(`\\b${name}\\s*=\\s*'([^']+)'`, 'u').exec(text);
    assert.ok(
      m,
      `${nodePath.basename(file)} 里找不到 \`${name}\` —— 这条路的路径就没人核对了` +
        '（常量被改名/删掉时，这条闸必须当场红，不许静默漏掉）',
    );
    out.add(m[1]);
  }
  return out;
}

/**
 * 从一节里抽出 `/api/…`，并**准确地**判断哪几条是"如实说不存在"。
 *
 * ⚠️ 第一版判得太粗（"这一行里有 `⏳`/`不存在` ⇒ 这一行提到的**所有**路径都算不存在"）
 *    ⇒ 把"本机的健康检查走 `/api/health`"这种**同一行里的对照**也算进去了，
 *      当场假红 5 条。⇒ 收成两条规矩：
 *      ① **`~~划掉~~` 里的**路径才算"不存在"（手册就是这么标的）；
 *      ② 没有划线的行：只有**第一格**（= 这一行讲的那条路）带 `⏳`/`不存在` 才算。
 */
function rowsOf(section) {
  const rows = [];
  for (const line of section) {
    if (!line.trim().startsWith('|')) continue;
    const struck = new Set(
      [...line.matchAll(/~~([^~]*)~~/g)]
        .flatMap((m) => [...m[1].matchAll(/\/api\/[a-z0-9/_-]+/g)].map((x) => x[0])),
    );
    const firstCell = (line.split('|')[1] ?? '');
    const firstPaths = [...firstCell.matchAll(/\/api\/[a-z0-9/_-]+/g)].map((m) => m[0]);
    const all = [...line.matchAll(/`[^`]*\/api\/[a-z0-9/_-]+[^`]*`/g)]
      .map((m) => (m[0].match(/\/api\/[a-z0-9/_-]+/) ?? [null])[0])
      .filter(Boolean);
    const lineSaysAbsent = /不存在/.test(line) || /⏳/.test(line);
    for (const p of all) {
      const absent = struck.has(p) || (lineSaysAbsent && firstPaths.includes(p) && !struck.size);
      rows.push({ path: p, absent });
    }
  }
  return rows;
}

test('🔴 手册 §2.1 说"有"的每条路，代码里**真的在**', () => {
  const code = routesInCode();
  const missing = rowsOf(interfaceSection())
    .filter((r) => !r.absent)
    .map((r) => r.path)
    .filter((p) => !code.has(p));
  assert.deepEqual([...new Set(missing)], [],
    `手册写着有、代码里没有（手册在说假话，或者代码把那一条丢了）：${[...new Set(missing)].join('、')}`);
});

test('🔴 代码里的每条 `/api/…` 都要进手册 §2.1（加了路由没写表 = 漂）', () => {
  const rows = rowsOf(interfaceSection());
  const inTable = new Set(rows.filter((r) => !r.absent).map((r) => r.path));
  const notDocumented = [...routesInCode()].filter((p) => !inTable.has(p));
  assert.deepEqual(notDocumented, [],
    `这些路由代码里有、手册 §2.1 的表里没有：${notDocumented.join('、')}\n` +
    '（要么补进表，要么在表里**如实写"⏳ 不存在"**——不许两边各说各话）');
});

/**
 * **手册明确标了"⏳ 不存在"的那几条**（`08-SPEC.md` §2.1 里划掉的那些）。
 *
 * ⚠️ 为什么写成**清单**而不是从散文里猜：第一版试着从每行里推"哪些路径算不存在"，
 *    结果把"本机的健康检查走 `/api/health`"这种**同一行里的对照**也算进去了 ⇒ 假红。
 *    散文里推不出来；清单 + **两边互证**才是可靠的（见下面那条）。
 */
const DECLARED_ABSENT = [
  '/api/health/local',
  '/api/receipt',
  '/api/conversations',
  '/api/debug/report',
  '/api/debug/tasks',
  '/api/debug/analyze',
];

test('🔴 手册标了"⏳ 不存在"的，代码里**真的不许**有（两边互证）', () => {
  const code = routesInCode();
  const spec = nodeFs.readFileSync(SPEC, 'utf8');
  for (const p of DECLARED_ABSENT) {
    // ① 代码里不许有
    assert.equal(code.has(p), false, `手册说 ${p} 不存在，可代码里有了 ⇒ 删代码或改手册（别让它当假话）`);
    // ② 手册里**仍然**得标着"不存在"（不然清单本身就过期了）
    const line = spec.split('\n').find((l) => l.includes(p));
    assert.ok(line, `手册里找不到 ${p} 那一行 —— 清单过期了（要么它被删了，要么路径写错了）`);
    assert.ok(/不存在|~~/.test(line), `${p} 在手册里不再标"不存在"了 ⇒ 那条路由要是真加了，请把它从这份清单里拿掉并补进接口表`);
  }
});

test('负向对照：这三条真的读得到东西（不是空转）', () => {
  const section = interfaceSection();
  assert.ok(section.length > 20, `§2.1 那一节太小了（${section.length} 行）—— 多半是标题改了`);
  const rows = rowsOf(section);
  assert.ok(rows.length >= 15, `表里只认出 ${rows.length} 条路 —— 抽取规则多半不对了`);
  assert.ok(rows.some((r) => r.absent), '手册里那几条"⏳ 不存在"要认出来（不然第三方向就是空转）');
  assert.ok(routesInCode().size >= 20, '代码里的路由也认得出来才行');
});
