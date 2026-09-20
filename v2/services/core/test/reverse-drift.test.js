// **防回潮断言** —— 手册 `08-SPEC.md` §13.2 三条 + §13.3 的 **V8 / V9**。
//
// 手册把这三条写成 `grep -rn ... = 0`。⚠️ **照字面写，它们永远绿不了**：
// 那三个词**就写在定义它们的文档里**（`08-SPEC.md` §13.2 自己就有 `usermod` 和 `HEAD~1`），
// 而"回退不许用 HEAD~1"这句话本身也得在 `06-OPERATIONS.md` 里出现。
// 更要命的是：**断言本身必须写出那个字符串**（不然它拿什么去搜）。
//
// ⇒ 所以这一条闸要**说清楚它扫哪儿、不扫哪儿、为什么**：
//
//   **扫**：① 会被执行的（`scripts/`、`v2/**/src/`）
//          ② 开机喂给 agent 的（人格、`AGENTS.md`）
//   **不扫**：`docs/`（**规则的定义**住在那里）、`**/test/`（**断言自己**必须写出那个词）
//
// ⚠️ 一条"匹配到自己定义"的闸不是闸，是一句口号 —— 而"永远绿的闸"比没有闸更坏
//    （它给人"已经守住了"的错觉）。下面第 3 条测试就是把这个理由**跑出来**给人看。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import test from 'node:test';

// test → core → services → v2 → 仓库根
const REPO = nodePath.resolve(import.meta.dirname, '../../../..');

/** 递归收文件；`skip` 是**目录名**的黑名单。 */
function walk(dir, out = []) {
  let list;
  try {
    list = nodeFs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of list) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'data') continue;
    const full = nodePath.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

/**
 * **这条闸扫的那一小块**（见文件头）。
 *
 * ⚠️ 刻意不扫 `docs/` 与 `test/` —— 理由写在文件头，也在下面的测试里跑给你看。
 */
function scanned() {
  const files = [
    ...walk(nodePath.join(REPO, 'scripts')),
    ...walk(nodePath.join(REPO, 'v2/services/core/src')),
    ...walk(nodePath.join(REPO, 'v2/apps/mobile/lib')),
    nodePath.join(REPO, 'AGENTS.md'),
    nodePath.join(REPO, 'v2/services/core/hupo-persona.yml'),
  ];
  return files.filter((f) => nodeFs.existsSync(f) && nodeFs.statSync(f).isFile());
}

/**
 * 一条文件里"**会被读到的那部分**"。
 *
 * ⚠️ **整行注释不算**：一句写着「这里不许写某个词」的注释**不是指令**，
 *    它恰恰是防止别人把它加回来的那块牌子。人格文件更是如此——
 *    真正送到 agent 眼前的是 `personaSuffix:` 里那一块（`persona.test.js` 的
 *    `payload()` 就是照那个取的；V8 在**渲染后的 payload** 上验，那才是权威）。
 *
 * ⚠️ 已知的保守处：**行尾**注释里的词仍然算命中（`//` 出现在 URL 里没法安全地剥）。
 *    往保守那一边错是对的——宁可让人把注释挪到单独一行。
 */
function codeOf(file) {
  return nodeFs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('#') && !t.startsWith('//');
    })
    .join('\n');
}

const hits = (files, needle) =>
  files.filter((f) => codeOf(f).includes(needle)).map((f) => nodePath.relative(REPO, f));

test('🔴 §13.2 第 1 条：`usermod` 命中 = 0（不许有人再往 docker 组里加账号）', () => {
  assert.deepEqual(hits(scanned(), 'usermod'), []);
});

test('🔴 §13.2 第 3 条：`HEAD~1` 命中 = 0（回退必须 `git revert`）', () => {
  // 理由：`HEAD~1` 是"回退到上一个提交"，而它**会丢掉这之后的每一个提交**；
  // `git revert` 是"把这一次的效果反做一遍"，历史留着 ⇒ 才叫"可回退"（N5）。
  assert.deepEqual(hits(scanned(), 'HEAD~1'), []);
});

test('🔴 §13.2 第 2 条（V8）：`直接动手 / 直接改，不要问` 命中 = 0', () => {
  for (const bad of ['直接动手', '直接改，不要问']) {
    assert.deepEqual(
      hits(scanned(), bad),
      [],
      `命中了「${bad}」—— P2 的整个前提就是"助手不自己按那个按钮"`,
    );
  }
});

test('🔴 负向对照：扫到的东西不能是空的（不然这条闸是摆设）', () => {
  const files = scanned();
  assert.ok(files.length >= 15, `只扫到 ${files.length} 个文件，太少`);
  for (const must of ['scripts/restart-core.sh', 'AGENTS.md', 'v2/services/core/hupo-persona.yml']) {
    assert.ok(
      files.map((f) => nodePath.relative(REPO, f)).includes(must),
      `该扫到的东西没扫到：${must}`,
    );
  }
});

test('⚠️ 为什么必须排除 `docs/` 与 `test/`：不排除，这条闸**永远绿不了**', () => {
  // 把理由跑出来：规则的定义与断言本身**必然**含有这些词。
  const spec = nodeFs.readFileSync(nodePath.join(REPO, 'docs/handbook/08-SPEC.md'), 'utf8');
  assert.ok(spec.includes('usermod'), '手册 §13.2 自己就写着 usermod —— 扫它必然命中');
  assert.ok(spec.includes('HEAD~1'), '同一条规则自己就写着 HEAD~1');
  const self = nodeFs.readFileSync(nodePath.join(import.meta.dirname, 'reverse-drift.test.js'), 'utf8');
  assert.ok(self.includes('HEAD~1'), '这条断言自己必须写出那个字符串，不然它拿什么去搜');
  // ⇒ 所以扫的范围必须**收窄到"会被执行 / 会被喂给 agent"的那一块**，
  //   而不是"整个仓库里这个词一次都不许出现"。那句话是**做不到的**。
});

test('V9：`apply-change.sh` 必须存在，而且只从 `proposals/` 里吃补丁', () => {
  // ⚠️ 这一条只钉**形状**（脚本在、且限定入口）；"跑完真的留下一个 commit"
  //    由 `apply-change.test.js` 用**真脚本 + 真 git** 验（那是 V9 的正文）。
  const p = nodePath.join(REPO, 'scripts/apply-change.sh');
  assert.ok(nodeFs.existsSync(p), 'apply-change.sh 不在 ⇒ P2 那条路没有落点');
  const body = nodeFs.readFileSync(p, 'utf8');
  assert.ok(body.includes('proposals'), '补丁入口必须限定在 proposals/ 里（主人要看的那个"一眼"）');
  assert.ok(body.includes('git apply'), '必须先 git apply');
  const rollback = nodePath.join(REPO, 'scripts/rollback.sh');
  assert.ok(nodeFs.existsSync(rollback), 'rollback.sh 不在 ⇒ 回退要助手参与，那正好违反 P1.5');
  assert.ok(nodeFs.readFileSync(rollback, 'utf8').includes('git revert'), '回退必须 git revert');
});
