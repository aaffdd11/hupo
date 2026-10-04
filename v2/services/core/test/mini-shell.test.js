// **小程序那一屏的"壳"**（丙 · 契约 `docs/dev/184-MINI-SHELL.md`）。
//
// ── 这一份钉什么（S1–S3，都是**源码级**；DOM 的事在 VM 上跑不起来）────
//   S1 壳那一页认 `?u=`，而且**只认我们自己签过的活地址**（`/w/`|`/a/` 且带 `s=`）；
//      不是 ⇒ **不加载**，并出一句人话（不是白屏）
//   S2 🔴 **壳不拿任何钥匙**：这一族文件里不许出现 token / 签名键 / `HUPO_*`
//   S3 🔴 小程序那一层**照旧沙箱化**：`allow-scripts`，**不给** `allow-same-origin`
//      （这一条与 `08-SPEC.md` 那几条是同一条命）
//   S4 壳那一页的 CSS：内层**四边贴满 ＋ 裁溢出**（2026-10-05 那两条白边要从结构上没缝）
//   S5 路由：三样各自的 content-type ＋ 壳那一页带 CSP ＋ **不许缓存**

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import test from 'node:test';

import { SHELL_CSP, SHELL_CSS_PATH, SHELL_JS_PATH, SHELL_PATH, shellCss, shellHtml, shellJs, shellKindOf } from '../src/mini-shell.js';

const JS = shellJs();
const CSS = shellCss();
const HTML = shellHtml();

test('S1 壳只认"我们签过的活地址"（`/w/`|`/a/` 且带 `s=`）；不是 ⇒ 不加载 ＋ 一句人话', () => {
  assert.match(JS, /new URLSearchParams\(location\.search\)\.get\('u'\)/, '★ 参数只有这一个');
  assert.ok(JS.includes("u.indexOf('/w/') === 0") && JS.includes("u.indexOf('/a/') === 0"),
      '★ 只认我们自己那两条路（活地址 / 制品）');
  assert.ok(JS.includes("u.indexOf('s=') !== -1"), '★ 必须带签名（`s=`）—— 没签名的不许嵌');
  assert.match(JS, /这一条打不开/, '★ 不是有效地址 ⇒ 出一句人话（不是白屏）');
  // 负向对照：**把认地址那一条去掉** ⇒ 上面那些断言里至少有一条不再成立
  const loose = JS.replace(/var ok = [^;]+;/, 'var ok = true;');
  assert.equal(loose.includes("u.indexOf('/w/')"), false, '★ 负向对照：认地址那一条真的在起作用');
});

test('S2 🔴 壳不拿任何钥匙（token / 签名键 / HUPO_* 一个都不许出现）', () => {
  for (const [name, src] of [['shell.js', JS], ['shell.css', CSS], ['shell.html', HTML]]) {
    for (const bad of ['token', 'TOKEN', 'HUPO_', 'key=', 'Bearer', 'Authorization']) {
      assert.equal(src.includes(bad), false, `★ ${name} 里出现了「${bad}」—— 壳只许转发，不许拿钥匙`);
    }
  }
  // 它只 communicate 这一种形状（postMessage），没有别的话
  assert.match(JS, /parent\.postMessage\(\{ kind: 'hupo-chrome'/, '★ 只往外面说"哪个按钮被按了"');
});

test('S3 🔴 小程序那一层照旧沙箱化（`allow-scripts`；**不给** allow-same-origin）', () => {
  assert.match(JS, /setAttribute\('sandbox', 'allow-scripts'\)/, '★ 与别处同一个口径');
  // ⚠️ 判据看的是**那个属性的值**（脚本里有一句注释也提到这个词，别把注释当漏洞）
  const sandbox = /setAttribute\('sandbox', '([^']+)'\)/.exec(JS);
  assert.equal(sandbox && sandbox[1], 'allow-scripts',
      '★★ sandbox 值只许是 allow-scripts —— 给了 allow-same-origin 就是小程序和壳共享源');
  assert.match(JS, /referrerpolicy/, '★ 不带 referrer（同别的两条路）');
});

test('S4 壳的 CSS：内层四边贴满 ＋ 裁掉溢出（那两条白边从结构上没缝）', () => {
  assert.match(CSS, /#app\{position:fixed;inset:0;overflow:hidden\}/, '★ 容器四边贴满 ＋ 裁溢出');
  assert.match(CSS, /#app iframe\{[^}]*width:100%;height:100%/, '★ 内层精确贴满');
  assert.match(CSS, /#words\{[^}]*pointer-events:none/, '★ 字那一层不吃点击（点它穿进小程序）');
  assert.match(CSS, /#mic\{[^}]*width:64px;height:64px/, '★ 麦克风那颗与桌面那颗同尺寸（64）');
});

test('S5 三样各有自己的类型；壳那一页带 CSP 且不许被缓存', () => {
  assert.equal(shellKindOf(SHELL_PATH), 'html');
  assert.equal(shellKindOf(SHELL_CSS_PATH), 'css');
  assert.equal(shellKindOf(SHELL_JS_PATH), 'js');
  assert.equal(shellKindOf('/w/x/index.html'), null, '别的路径不归它管');
  assert.match(SHELL_CSP, /default-src 'none'/, '★ 默认什么都不许');
  assert.equal(SHELL_CSP.includes('unsafe-inline'), false, '★ 不给 unsafe-inline（与仓库一贯纪律一致）');
  const src = nodeFs.readFileSync('src/app-serve.js', 'utf8');
  assert.match(src, /shellKindOf\(parsed\.pathname/, '★ 路由真的接上了');
  assert.match(src, /'cache-control': 'no-store'/, '★ 壳不许被缓存住（改了要立刻生效）');
});
