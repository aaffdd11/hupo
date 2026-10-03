// 92 §③ **阶段 2** · 判据 D 的**加强版**：出界只许**一条路**（源码级扫描）
// （契约 `docs/dev/92-TRIPLE-PLAN.md` §③ 阶段 2 · `docs/dev/157-OUTBOUND-BRIDGE-GATE.md`）。
//
// ── 为什么另起一份（而不是把 `outbound-gate.test.js` §2-10 改掉）──────
// 那一份认的是**字面量** `published-apps` / `PUBLISHED_DIR`。它抓得住"另开一个文件、
// 自己拼那个目录名"的出口，却**漏掉**这一类：
//
//     const d = nodePath.join(published.root, id, 'versions', '1');   // ← 一个字面量都没提
//     nodeFs.writeFileSync(nodePath.join(d, 'index.html'), buf);
//
// `published.root` 这一半路径**已经由 `published.js` 自己拼好了** ⇒ 第二出口可以**完全
// 不提那个目录名**，老扫描就绿着放它过去。**判据 D 的原话是"冒出第二个绕过这条检查的
// 出口 ⇒ 红"**，所以这一份补上那一半，并且自带**植入的负向对照**（`PLANTED_SECOND_EXIT`：
// 喂一个绕开字面量的第二出口 ⇒ 扫描**必须**抓住；喂一个只读的 ⇒ **不许**误伤）。
//
// ── 它问三件（都不需要执行代码，只看 `src/` 的源码）──────────────
//   ① 能**写共享库**的文件只许一个（认两种形态：目录名字面量／拿到 `Published` 的路径访问器
//      再动写盘）—— 多出来那一个就是"第二个出口"；
//   ② 那一个文件必须**真的**过了 `outbound.js` 那个裁决（不许"有闸但没人用"）；
//   ③ 裁决本身只许有**一处定义**（`adjudicate` / `assertOutboundAllowed` 只许住 `outbound.js`）。
//
// ⚠️ **局限（如实写在 `157` 里）**：扫描是**字符串层面**的。把目录名拆成 `'published-' + 'apps'`
//    拼出来、或绕开 `Published` 自己从 `dir` 硬拼，这一层抓不住 —— 它抓的是"**认得出来的**
//    第二出口"。真正的结构性保证是"共享库只有一个写入者"这件事本身（`published.js`），
//    扫描只是**不让它悄悄多出第二个**。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

const HERE = nodePath.dirname(new URL(import.meta.url).pathname);
const SRC = nodePath.resolve(HERE, '..', 'src');

/** 去掉注释（判据只认**代码**里的字，不认解释里的 —— 照 `outbound-gate.test.js` 同款）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** 共享库目录名的**字面量**（阶段 2 原来只认这一个）。 */
const SHARED_LITERAL = /published-apps|PUBLISHED_DIR/;

/** 一个 `…published…` 的标识符拿到"共享库里的路径"（`root` / `appDir()` / `dir`）。 */
const SHARED_PATH_ACCESS = /\b[A-Za-z0-9_$]*published[A-Za-z0-9_$]*\s*\.\s*(?:root|appDir|dir)\b/iu;

/** 会往盘上写东西的动作。 */
const WRITE_VERB = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|mkdirSync|mkdir|renameSync|rename|copyFileSync|copyFile|createWriteStream|rmSync|rm|unlinkSync|unlink|truncateSync|truncate|chmodSync|chmod|openSync|open)\b/u;

/** 裁决的定义（"另一处出界检查"就是多一个这种定义）。 */
const ADJUDICATION_DEF = /\bfunction\s+(?:adjudicate|assertOutboundAllowed)\s*\(/u;

/**
 * 🔴 **判据 D 的扫描本体**（纯函数 ⇒ 可以喂植入的假源码做负向对照）。
 *
 * @param {Array<{rel:string, code:string}>} files
 * @returns {{writers:string[], adjudicationDefs:string[]}}
 */
export function scanSingleExit(files) {
  const writers = [];
  const adjudicationDefs = [];
  for (const f of files) {
    const code = stripComments(f.code);
    if (SHARED_LITERAL.test(code)) writers.push(f.rel);
    else if (SHARED_PATH_ACCESS.test(code) && WRITE_VERB.test(code)) writers.push(f.rel);
    if (ADJUDICATION_DEF.test(code)) adjudicationDefs.push(f.rel);
  }
  return { writers: writers.sort(), adjudicationDefs: adjudicationDefs.sort() };
}

/** 仓库里真实的 `src/`（递归，只要 `.js`／`.mjs`）。 */
function realSource() {
  const out = [];
  const walk = (dir) => {
    for (const e of nodeFs.readdirSync(dir, { withFileTypes: true })) {
      const p = nodePath.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs)$/u.test(e.name)) out.push({ rel: nodePath.relative(SRC, p), code: nodeFs.readFileSync(p, 'utf8') });
    }
  };
  walk(SRC);
  return out;
}

// ════════════════════════════════════════════════════════════════
// §D-1 🔴 真树：能写共享库的只许 `published.js` 一个
// ════════════════════════════════════════════════════════════════

test('🔴 D-1 能写共享库的文件只许一个（含"绕开目录名字面量"的那一类）', () => {
  const src = realSource();
  const { writers } = scanSingleExit(src);
  assert.deepEqual(
    writers,
    ['published.js'],
    `🔴 共享库只许一个写入者；多出来那个就是"第二个出口"：${JSON.stringify(writers)}`,
  );
});

test('🔴 D-2 那一个写入者**真的**过了 `outbound.js` 的裁决（不许有闸没人用）', () => {
  const src = realSource();
  const pub = src.find((f) => f.rel === 'published.js');
  assert.ok(pub, '前提：找得到 published.js');
  const code = stripComments(pub.code);
  assert.match(code, /assertOutboundAllowed\s*\(/u, '🔴 唯一写入者必须调那道闸');
  assert.match(code, /from\s+'\.\/outbound\.js'/u, '🔴 它得真的引那道闸');
  // 闸自己**不许**写共享库（裁决与搬运分开）
  const gate = src.find((f) => f.rel === 'outbound.js');
  assert.doesNotMatch(stripComments(gate.code), SHARED_LITERAL, '🔴 闸只裁决，不写盘到共享库');
});

test('🔴 D-3 裁决只许有**一处定义**（`adjudicate` / `assertOutboundAllowed`）', () => {
  const { adjudicationDefs } = scanSingleExit(realSource());
  assert.deepEqual(
    adjudicationDefs,
    ['outbound.js'],
    `🔴 出界检查多了一处定义 ⇒ 两条裁决迟早会漂：${JSON.stringify(adjudicationDefs)}`,
  );
});

// ════════════════════════════════════════════════════════════════
// §D-4 🔴 **植入的负向对照**：这条扫描真的抓得住吗
// ════════════════════════════════════════════════════════════════

/**
 * 🔴 `PLANTED_SECOND_EXIT` —— 一个**绕开目录名字面量**的第二出口。
 * 它一个字都没提 `published-apps` / `PUBLISHED_DIR`，靠的是 `published.root`。
 */
const PLANTED_SECOND_EXIT = `
import nodeFs from 'node:fs';
import nodePath from 'node:path';

export function sneakOut(published, id, buf) {
  const d = nodePath.join(published.root, id, 'versions', '1');
  nodeFs.mkdirSync(d, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(d, 'index.html'), buf);
}
`;

/** 🔴 另一个变体：走 `published.appDir()`。 */
const PLANTED_APP_DIR_EXIT = `
import nodeFs from 'node:fs';
import nodePath from 'node:path';

export function sneakOut(published, id, buf) {
  nodeFs.writeFileSync(nodePath.join(published.appDir(id), 'index.html'), buf);
}
`;

test('🔴 D-4 负向对照：绕开字面量的第二出口（`published.root`）**必须**被抓出来', () => {
  const got = scanSingleExit([{ rel: 'sneak.js', code: PLANTED_SECOND_EXIT }]);
  assert.deepEqual(got.writers, ['sneak.js'], `🔴 植入的第二出口没被抓到 ⇒ 这条扫描是空转：${JSON.stringify(got)}`);
});

test('🔴 D-4b 负向对照：走 `published.appDir()` 的变体同样要被抓出来', () => {
  const got = scanSingleExit([{ rel: 'sneak.js', code: PLANTED_APP_DIR_EXIT }]);
  assert.deepEqual(got.writers, ['sneak.js'], `🔴 appDir 那个变体没被抓到：${JSON.stringify(got)}`);
});

test('🔴 D-4c 负向对照：另立一处裁决定义 ⇒ 也要被抓出来', () => {
  const got = scanSingleExit([{ rel: 'fake-gate.js', code: 'export function assertOutboundAllowed(o) { return o; }\n' }]);
  assert.deepEqual(got.adjudicationDefs, ['fake-gate.js'], '🔴 第二处裁决定义必须被抓住');
});

test('★ D-4d 对照：**只读**共享库的文件**不许**误伤（否则这条判据会假红）', () => {
  const readOnly = `
export function look(published, id) {
  const idx = published.index(id);
  return published.discover().filter((a) => a.id !== idx?.id);
}
`;
  assert.deepEqual(scanSingleExit([{ rel: 'reader.js', code: readOnly }]).writers, [], '只读不许被当成出口');

  const localized = `
import nodeFs from 'node:fs';
import nodePath from 'node:path';
export function writeMyOwnThing(apps, id, buf) {
  nodeFs.writeFileSync(nodePath.join(apps.appDir(id), 'note.txt'), buf);
}
`;
  assert.deepEqual(
    scanSingleExit([{ rel: 'own.js', code: localized }]).writers,
    [],
    '🔴 往**自己那一格**（`apps.appDir`）写不算出界 —— 不许误伤',
  );

  // 阶段 2 原来认的那一类**仍然**要抓住（加强版不许把老判据弄丢）
  const literal = "const root = nodePath.join(dir, 'published-apps');\nnodeFs.mkdirSync(root);\n";
  assert.deepEqual(scanSingleExit([{ rel: 'old.js', code: literal }]).writers, ['old.js'], '字面量那一类照样要抓');
});

after(() => {
  // 这一份**不落盘**（纯源码扫描）—— 没有临时目录要清，留这个钩子是明说"零残留"。
});
