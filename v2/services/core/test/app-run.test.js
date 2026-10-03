// **发布前的"真跑一次"（分级）**（`D4.24` · **A2** · 2026-10-03 主人定）—— 离线判据。
//
// 口径与理由见 `docs/dev/168-PUBLISH-RUN-UPGRADE.md`；闸脚本 `scripts/check-publish-run-upgrade.sh`。
//
// 这一份钉五件（每条都带**负向对照**）：
//   D1 **真跑**：入口的脚本**真的执行了**（不是"看了一眼"）—— 后一段读得到前一段留下的东西
//   D2 **入口必崩 ⇒ 拒**（语法错 / 顶层抛 / 起不来）；★ 负向对照：**把崩的那份修好 ⇒ 过**
//   D3 **不做全量回归**：源码级（不碰子进程／网络／npm）＋ 行为级（`while(true)` 在硬预算内被截）
//   D4 **驳回理由看得见**：点名哪个文件、哪一行、什么错
//   D5 **分级／不过度**：外链脚本、模块脚本、没有脚本 ⇒ **不拦**；接进 `published.publish` 且拒时零残留

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { Apps, SCHEMA } from '../src/apps.js';
import { Published } from '../src/published.js';
import {
  RUN_FAILURES,
  RUN_TIMEOUT_MS,
  describeRunFailure,
  extractScripts,
  runEntryOnce,
} from '../src/app-run.js';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const SRC = nodePath.join(HERE, '..', 'src');

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});
const tmp = () => {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-run-'));
  tmpDirs.push(d);
  return d;
};

const page = (body) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
const caught = (fn) => { try { fn(); return null; } catch (err) { return err; } };

const OUTBOUND = JSON.stringify({
  schema: 1,
  outbound: [],
  declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '测试' },
});

function world(tag = 'w') {
  const dir = tmp();
  return { dir, apps: new Apps({ dir, sub: 'u1' }), published: new Published({ dir }), tag };
}

/** 整棵树逐文件 sha256（判"零残留"用）。 */
function treeSha(root) {
  const out = [];
  const walk = (rel) => {
    let es = [];
    try { es = nodeFs.readdirSync(rel === '' ? root : nodePath.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of [...es].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const next = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) { out.push(`${next}/`); walk(next); continue; }
      out.push(`${next}:${nodeFs.readFileSync(nodePath.join(root, next)).toString('base64')}`);
    }
  };
  walk('');
  return out.join('\n');
}

// ════════════════════════════════════════════════════════════════
// D1 · 真跑：后一段脚本读得到前一段留下的东西
// ════════════════════════════════════════════════════════════════

test('🔴 D1：入口的脚本**真的执行了**（前一段留下的东西，后一段读得到）', () => {
  // 前一段留下一个记号；后一段**没有它就跑不完**（抛）⇒ 只有"两段都真跑了"才会过
  const ok = runEntryOnce({
    entry: 'index.html',
    files: { 'index.html': page('<script>window.__ran = 1</script><script>if (window.__ran !== 1) throw new Error("没跑过")</script>') },
  });
  assert.equal(ok.ok, true, `两段都该跑过：${JSON.stringify(ok)}`);
  assert.equal(ok.executed, 2);

  // ★ 负向对照：把两段**倒过来**（记号还没留下就检查）⇒ 必须拒（证明它真在按顺序执行）
  const reversed = runEntryOnce({
    entry: 'index.html',
    files: { 'index.html': page('<script>if (window.__ran !== 1) throw new Error("没跑过")</script><script>window.__ran = 1</script>') },
  });
  assert.equal(reversed.ok, false, '顺序反了 ⇒ 必须判"起不来"（否则说明它根本没执行）');
  assert.equal(reversed.kind, RUN_FAILURES.THROW);
});

// ════════════════════════════════════════════════════════════════
// D2 · 入口必崩 ⇒ 拒；★ 修好 ⇒ 过
// ════════════════════════════════════════════════════════════════

test('🔴 D2：入口必崩（语法错／顶层抛）⇒ 拒；★ 负向对照：修好那一行 ⇒ 过', () => {
  const cases = [
    ['语法错', '<script>function ( {</script>', RUN_FAILURES.SYNTAX],
    ['顶层就抛', '<script>throw new Error("入口就崩了")</script>', RUN_FAILURES.THROW],
    ['引了不存在的函数', '<script>buZhiDaoDeHanShu()</script>', RUN_FAILURES.THROW],
    ['引的本地脚本不在制品里', '<script src="./app.js"></script>', RUN_FAILURES.MISSING_SCRIPT],
    ['入口那一份不在制品里', '', RUN_FAILURES.ENTRY_MISSING],
  ];
  for (const [name, body, kind] of cases) {
    const files = name === '入口那一份不在制品里' ? {} : { 'index.html': page(body) };
    const r = runEntryOnce({ entry: 'index.html', files });
    assert.equal(r.ok, false, `${name}：必须判"起不来"`);
    assert.equal(r.kind, kind, `${name}：错类要分对（实为 ${r.kind}）`);
  }
  // ★ 负向对照：把那句抛修掉 ⇒ 同一份就过
  const fixed = runEntryOnce({
    entry: 'index.html',
    files: { 'index.html': page('<script>var x = 1; if (x === 1) { /* 修好了 */ }</script>') },
  });
  assert.equal(fixed.ok, true, `修好之后就该过：${JSON.stringify(fixed)}`);
  // ★ 对照：崩的那一份与修好的那一份**只差那一句**，结论必须相反
  const broken = runEntryOnce({ entry: 'index.html', files: { 'index.html': page('<script>throw new Error("崩")</script>') } });
  assert.equal(broken.ok, false);
});

// ════════════════════════════════════════════════════════════════
// D3 · 不做全量回归：源码级 ＋ 行为级（硬预算）
// ════════════════════════════════════════════════════════════════

test('🔴 D3：不做全量回归 —— 源码级（不碰子进程／网络／npm）＋ 行为级（`while(true)` 被硬预算截住）', () => {
  const raw = nodeFs.readFileSync(nodePath.join(SRC, 'app-run.js'), 'utf8');
  // ⚠️ 先**剥掉注释**再扫：文件头自己就写着"没有 child_process"那句话，扫字面会误伤
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  for (const bad of ['child_process', 'execSync', 'spawnSync', 'node:net', 'node:http', 'node:https', 'npm test', 'test/*.test.js']) {
    assert.equal(src.includes(bad), false, `app-run.js 里不该出现 ${bad}（那就不叫"最小判据"了）`);
  }
  assert.match(src, /timeout: RUN_TIMEOUT_MS/, '跑的时候必须带硬时间预算');

  // 行为级：一个死循环的入口 ⇒ 被截住，而且**当场**返回（不是跑很久）
  const t0 = Date.now();
  const r = runEntryOnce({
    entry: 'index.html',
    files: { 'index.html': page('<script>while (true) { /* 卡死 */ }</script>') },
  });
  const ms = Date.now() - t0;
  assert.equal(r.ok, false, '死循环的入口必须判"起不来"');
  assert.equal(r.kind, RUN_FAILURES.TIMEOUT, `该报 timeout（实为 ${r.kind}）`);
  assert.ok(ms < RUN_TIMEOUT_MS * 20, `不许偷偷跑长：实测 ${ms}ms（硬预算 ${RUN_TIMEOUT_MS}ms）`);
});

// ════════════════════════════════════════════════════════════════
// D4 · 驳回理由看得见
// ════════════════════════════════════════════════════════════════

test('🔴 D4：驳回理由**看得见**（点名哪个文件、哪一行、什么错）', () => {
  const r = runEntryOnce({
    entry: 'index.html',
    files: { 'index.html': page('<script>\nvar a = 1;\nthrow new Error("第三行崩的")\n</script>') },
  });
  assert.equal(r.ok, false);
  assert.equal(r.file, 'index.html#script-0');
  assert.equal(r.line, 3, `要点名哪一行（实为 ${r.line}）`);
  assert.match(r.error, /第三行崩的/);
  const words = describeRunFailure(r);
  assert.match(words, /起不来/, `人话要说清"真跑过一次、起不来"：${words}`);
  assert.match(words, /index\.html#script-0/, '要点名文件');
  assert.match(words, /第 3 行/, '要点名行号');
});

// ════════════════════════════════════════════════════════════════
// D5 · 分级／不过度 + 接进发布那条路
// ════════════════════════════════════════════════════════════════

test('🔴 D5：分级／不过度 —— 外链脚本、模块脚本、没脚本 ⇒ 不拦', () => {
  const ext = runEntryOnce({
    entry: 'index.html',
    files: { 'index.html': page('<script src="https://cdn.example.com/a.js"></script><script>var ok = 1</script>') },
  });
  assert.equal(ext.ok, true, '外链脚本取不到 ⇒ **不拦**（那不是"必崩"，`app-lint` 已经报它）');
  assert.deepEqual(ext.skipped, [{ index: 0, why: 'external' }]);

  const mod = runEntryOnce({
    entry: 'index.html',
    files: { 'index.html': page('<script type="module">import x from "./x.js"</script>') },
  });
  assert.equal(mod.ok, true, '模块脚本最小壳里跑不了 ⇒ 如实跳过，**不误拒**');
  assert.equal(mod.skipped[0].why, 'module');

  const data = runEntryOnce({ entry: 'index.html', files: { 'index.html': page('<script type="application/json">{"a":1}</script>') } });
  assert.equal(data.ok, true, 'JSON 数据块不是脚本');
  assert.equal(data.skipped[0].why, 'data');

  const plain = runEntryOnce({ entry: 'index.html', files: { 'index.html': page('<p>就是一行字</p>') } });
  assert.equal(plain.ok, true);
  assert.equal(plain.executed, 0);

  // 同 artifact 的 `src` ⇒ **真读真跑**
  const local = runEntryOnce({
    entry: 'index.html',
    files: {
      'index.html': page('<script src="./app.js"></script>'),
      'app.js': 'window.__local = 1; if (window.__local !== 1) throw new Error("x")',
    },
  });
  assert.equal(local.ok, true);
  assert.equal(local.executed, 1);
  assert.equal(local.skipped.length, 0);
});

test('🔴 D5b：接进 `published.publish` —— 崩的那一版**拒**，盘上零残留；修好 ⇒ 发得成（带"跑过"的凭据）', () => {
  const w = world('D5');
  const files = (body) => ({
    'index.html': page(body),
    'outbound.json': OUTBOUND,
  });
  const make = (body) => w.apps.create({
    id: 'boom', title: '崩的', icon: 'dice', entry: 'index.html', files: files(body),
  });

  make('<script>throw new Error("入口就崩了")</script>');
  const before = treeSha(nodePath.join(w.dir, 'published-apps'));
  const err = caught(() => w.published.publish(w.apps, { id: 'boom', authorSub: 'u1', authorName: '甲' }));
  assert.ok(err, '崩的那一版必须拒');
  assert.equal(err.name, 'EntryRunError');
  assert.match(err.message, /起不来/, err.message);
  assert.equal(w.published.index('boom'), null, '拒的时候共享库**一条都不该有**');
  const after = treeSha(nodePath.join(w.dir, 'published-apps'));
  const beforeNoDir = nodeFs.existsSync(nodePath.join(w.dir, 'published-apps')) ? before : '';
  const afterNoDir = nodeFs.existsSync(nodePath.join(w.dir, 'published-apps')) ? after : '';
  assert.equal(afterNoDir, beforeNoDir, '拒的时候共享库一个字节都不动');

  // ★ 负向对照：修好 ⇒ 发得成，而且登记里有"跑过"的凭据
  w.apps.create({ id: 'boom', title: '崩的', icon: 'dice', entry: 'index.html', files: files('<script>var ok = 1</script>') });
  const idx = w.published.publish(w.apps, { id: 'boom', authorSub: 'u1', authorName: '甲' });
  assert.equal(idx.ran.ok, true, '登记里要有一条"跑过"的凭据');
  assert.equal(idx.ran.scripts, 1);
  assert.ok(Number.isInteger(idx.ran.ms));
  const onDisk = JSON.parse(nodeFs.readFileSync(nodePath.join(w.published.appDir('boom'), 'index.json'), 'utf8'));
  assert.equal(onDisk.ran.ok, true, '凭据要落在登记里（不是只在内存里）');
});

// 兜底：契约里的那个号不许被这一批偷偷改掉（`SCHEMA` 是能力体那一族）
test('★ D6：这一批没动清单的形状号（`SCHEMA` 照旧）', () => {
  assert.equal(SCHEMA, 1);
  // `extractScripts` 认得出三种 type（顺手钉住分类不会漂）
  const kinds = extractScripts('<script></script><script type="module"></script><script type="application/json"></script>').map((s) => s.kind);
  assert.deepEqual(kinds, ['classic', 'module', 'data']);
});
