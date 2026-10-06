// **小程序制品的自查**（契约 `docs/dev/149-APP-DEV-STANDARD.md` §六）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   做小程序的 agent **看不见浏览器**：那些错（引外部资源 / 用存储不声明 / 连没声明的站 /
//   碰 localStorage / 假设有桥）在它那一侧**完全静默**，到主人屏幕上才变成"点了没反应"。
//   ⇒ 这一份把标准里**能机械判的**钉住：**每条规则一正一反**（正例收下、反例报出来）。
//
// ⚠️ 它**不是安全边界**（真边界在 CSP 与壳侧的闸）—— 它只是**在写的那一刻**把标准喊给它听。

import assert from 'node:assert/strict';
import test from 'node:test';

import { httpsHostsIn, lintApp, lintReport } from '../src/app-lint.js';
import { placeholderIndex } from '../src/workspace.js';

// ⚠️ 2026-10-04：夹具补上 `viewport` —— ⑧ 那档新规则会**如实**报「没写视口」（见 `186`），
//    而这一份判据量的是别的几档，夹具就该是一份**正常的页面**。
// ⚠️ 2026-10-06：夹具再补上 ⑨ 那两档要的东西（**宽屏交代 ＋ 一处能点的地方**，见 `203`）——
//    同一个道理：量别的规则时，夹具不该被新规则喊。
const bare = (body) =>
  '<!doctype html><meta charset=utf-8>'
  + '<meta name="viewport" content="width=device-width, initial-scale=1">'
  + '<title>x</title>'
  + '<style>main{display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr))}</style>'
  + body;
const page = (body) => ({ files: { 'index.html': bare(`<button>按一下</button>${body}`) } });

test('① 自包含：引外部资源 ⇒ **报错**（脚本/样式/图片/CSS import/WebSocket/Google 字体）', () => {
  for (const bad of [
    '<script src="https://cdn.example.com/a.js"></script>',
    '<link rel="stylesheet" href="https://cdn.example.com/a.css">',
    '<img src="https://x.example.com/a.png">',
    '<style>@import url("https://x.example.com/a.css");</style>',
    '<script>new WebSocket("wss://x.example.com")</script>',
    '<link href="https://fonts.googleapis.com/css?family=X">',
  ]) {
    const r = lintApp(page(bad));
    assert.equal(r.errors.some((e) => e.code === 'external-resource'), true, `该报：${bad}`);
  }
  // 正例：内联 + data: 图片 ⇒ 一条都不报
  const ok = lintApp(page('<style>body{color:#333}</style><img src="data:image/png;base64,AAA"><script>let a=1</script>'));
  assert.deepEqual(ok.errors, []);
});

test('② 存储：碰 localStorage / sessionStorage / indexedDB ⇒ **报错**，并指向 /db', () => {
  for (const bad of ['<script>localStorage.setItem("a","1")</script>', '<script>sessionStorage.clear()</script>', '<script>indexedDB.open("x")</script>']) {
    const r = lintApp(page(bad));
    const e = r.errors.find((x) => x.code === 'browser-storage');
    assert.ok(e, `该报：${bad}`);
    assert.match(e.text, /\/db/, '要说清改法（走 /db）');
  }
});

test('③ 禁原生桥：webkit.messageHandlers / HupoNative / Android.* ⇒ **报错**', () => {
  for (const bad of ['<script>webkit.messageHandlers.hupo.postMessage("x")</script>', '<script>window.HupoNative.ask("x")</script>', '<script>Android.ask("x")</script>']) {
    const r = lintApp(page(bad));
    assert.equal(r.errors.some((e) => e.code === 'native-bridge'), true, `该报：${bad}`);
  }
});

test('★ ④ 🔴 **存储默认有**：用 `/db` 不报"没声明"；"声明了没用"也不再提；别的照旧要对上', () => {
  // 主人 2026-10-02：*"我发现做的小程序都不会有存储。这个应该默认有存储。"*
  // ⇒ 存储是基本能力 ⇒ ① 用了 `/db` **不用声明**（不再报错）；② "声明了 db 却没用"**也不再提**
  //   （他不用为此操心）；③ 别的那几样（ask/agent/net）**照旧**"用了就得声明"。
  const dbUse = page('<script>fetch("/db",{method:"POST"})</script>');
  const r1 = lintApp(dbUse);
  assert.equal(r1.errors.some((e) => e.code === 'db-not-declared'), false, '★ 用了 /db 不该再报"没声明"');
  assert.deepEqual(lintApp({ ...dbUse, permissions: ['db'] }).errors, [], '声明了当然也没事');
  assert.equal(
    lintApp({ files: { 'index.html': '<p>纯静态</p>' }, permissions: ['db'] }).warnings.some((w) => w.code === 'db-unused'),
    false,
    '★ "声明了 db 却没用"不该再提醒（它默认就有，不是他操心的事）',
  );

  // ask / agent 各一条
  assert.equal(lintApp(page('<script>fetch("/ask")</script>')).errors.some((e) => e.code === 'ask-not-declared'), true);
  assert.equal(lintApp(page('<script>fetch("/agent")</script>')).errors.some((e) => e.code === 'agent-not-declared'), true);
  // 调那几条口却没读入口参数 ⇒ 提示（第一次要带 u/e/s）
  const noParams = lintApp({ ...dbUse, permissions: ['db'] });
  assert.equal(noParams.warnings.some((w) => w.code === 'no-entry-params'), true);
  // 读了就不再提示
  const withParams = lintApp({
    files: { 'index.html': '<script>const q=new URLSearchParams(location.search);fetch("/db")</script>' },
    permissions: ['db'],
  });
  assert.equal(withParams.warnings.some((w) => w.code === 'no-entry-params'), false);
});

test('⑧ ★ 外观基线（`docs/dev/186`）：每条都**抓得住**，改对了就**不再响**（各带负向对照）', () => {
  // ① 手机视口：没有 ⇒ 报；有 ⇒ 不报
  const noVp = lintApp({ files: { 'index.html': '<html><body><p>x</p></body></html>' } });
  assert.equal(noVp.warnings.some((w) => w.code === 'no-viewport'), true, '★ 没有 viewport ⇒ 要报（手机上会按桌面宽渲染）');
  assert.equal(lintApp(page('<p>x</p>')).warnings.some((w) => w.code === 'no-viewport'), false, '★ 有 viewport ⇒ 不报');

  // ② 焦点框：关掉却没替代 ⇒ 报；关掉但给了 `:focus-visible` ⇒ 不报
  const killed = lintApp(page('<style>:focus{outline:none}</style>'));
  assert.equal(killed.warnings.some((w) => w.code === 'focus-removed'), true, '★ 关掉焦点框没替代 ⇒ 要报');
  const fixed = lintApp(page('<style>:focus{outline:none}:focus-visible{outline:2px solid #333;outline-offset:2px}</style>'));
  assert.equal(fixed.warnings.some((w) => w.code === 'focus-removed'), false, '★ 给了替代焦点样式 ⇒ 不报（负向对照）');

  // ③ 字号下限：<12px ⇒ 报；≥12px ⇒ 不报
  assert.equal(lintApp(page('<p style="font-size:11px">x</p>')).warnings.some((w) => w.code === 'tiny-text'), true, '★ 11px ⇒ 要报');
  assert.equal(lintApp(page('<p style="font-size:12px">x</p>')).warnings.some((w) => w.code === 'tiny-text'), false);
  assert.equal(lintApp(page('<p style="font-size:15px">x</p>')).warnings.some((w) => w.code === 'tiny-text'), false);

  // ④ 渐变字 ⇒ 报（两种写法都认）；普通字色 ⇒ 不报
  for (const css of ['background-clip:text', '-webkit-background-clip: text']) {
    assert.equal(
      lintApp(page(`<style>h1{${css};background:linear-gradient(#f00,#00f)}</style>`)).warnings.some((w) => w.code === 'gradient-text'),
      true,
      `★ ${css} ⇒ 要报`,
    );
  }
  assert.equal(lintApp(page('<style>h1{color:#221f1b;font-weight:700}</style>')).warnings.some((w) => w.code === 'gradient-text'), false);

  // 🔴 **那份起步页自己必须一条都不响**（它就是"基线"的样子，也是 agent 照着改的骨架）
  const starter = lintApp({ files: { 'index.html': placeholderIndex({ id: 'x', title: '记账本' }) } });
  assert.deepEqual(starter.warnings, [], '★ 起步页自己响了 ⇒ 说明基线与脚手架不是一套话');
  assert.deepEqual(starter.errors, []);
});

test('⑨ ★ 宽屏与"太薄"（`docs/dev/203`）：宽屏没交代 / 通篇只能看 ⇒ 各报一条；改对了就不报', () => {
  const vp = '<meta name="viewport" content="width=device-width, initial-scale=1"><title>x</title>';
  // ① 宽屏：一列、一个字的交代都没有 ⇒ 报（平板上一整屏只有一条窄栏）
  const narrow = lintApp({ files: { 'index.html': `${vp}<button>按</button><p>一列到底</p>` } });
  assert.equal(narrow.warnings.some((w) => w.code === 'no-wide-layout'), true, '★ 宽屏没交代 ⇒ 要报');
  // 负向对照：三种写法各算"交代过了"
  for (const css of [
    '@media (min-width:48rem){main{grid-template-columns:1fr 1fr}}',
    'main{grid-template-columns:repeat(auto-fit,minmax(16rem,1fr))}',
    'ul{display:flex;flex-wrap:wrap}',
  ]) {
    const r = lintApp({ files: { 'index.html': `${vp}<button>按</button><style>${css}</style>` } });
    assert.equal(r.warnings.some((w) => w.code === 'no-wide-layout'), false, `★ 这一种算交代过了：${css}`);
  }
  // ⚠️ 只写了深色那一条 `@media` **不算**（它跟宽度无关 —— 假报会把"照抄骨架"的人坑了）
  const darkOnly = lintApp({ files: { 'index.html': `${vp}<button>按</button><style>@media (prefers-color-scheme:dark){body{background:#000}}</style>` } });
  assert.equal(darkOnly.warnings.some((w) => w.code === 'no-wide-layout'), true, '★ 深色模式的 @media 不算宽屏交代');

  // ② 太薄：通篇只能看 ⇒ 报（那不是"能用的小程序"，是一张图）
  const dead = lintApp({ files: { 'index.html': `${vp}<style>@media (min-width:48rem){}</style><h1>天气</h1><p>今天晴</p>` } });
  assert.equal(dead.warnings.some((w) => w.code === 'thin-page'), true, '★ 只有看的页面 ⇒ 要报');
  // 负向对照：能点 / 能填 / 能选 / 能听 / 挂了监听 —— 各算一处"能动的"（用没有按钮的底，才量得准）
  for (const body of [
    '<button>按</button>',
    '<input type="text">',
    '<select><option>a</option></select>',
    '<a href="#x">看</a>',
    '<script>el.addEventListener("click", f)</script>',
    '<div contenteditable="true"></div>',
  ]) {
    const r = lintApp({ files: { 'index.html': bare(body) } });
    assert.equal(r.warnings.some((w) => w.code === 'thin-page'), false, `★ 这一处算"能动的"：${body}`);
  }
  // ⚪ **占位页豁免**：壳自己那份空状态本来就该是空的（认「这里还空着」那句话）
  assert.equal(
    lintApp({ files: { 'index.html': placeholderIndex({ id: 'x', title: '记账本' }) } }).warnings.some((w) => w.code === 'thin-page'),
    false,
    '★ 占位页不该被报"太薄"',
  );
  // 🔴 变异对照：把那句话换掉 ⇒ 当场报（豁免认的是那句话，不是"凡空页面都不报"）
  const stripped = placeholderIndex({ id: 'x', title: '记账本' }).replace('这里还空着。', '今天晴。');
  assert.equal(
    lintApp({ files: { 'index.html': stripped } }).warnings.some((w) => w.code === 'thin-page'),
    true,
    '★ 把「这里还空着」换成别的话 ⇒ 该报了（变异验证）',
  );
});

test('★ 内联 SVG 的 `xmlns` 不算"连了一个站"（2026-10-06：基线点名让图标用内联 SVG）', () => {
  const withSvg = lintApp(page('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>'));
  assert.deepEqual(withSvg.errors, [], '★ `xmlns` 是个标识符、浏览器永远不去请求它 ⇒ 不许报 host-not-declared / net-not-declared');
  assert.deepEqual(withSvg.warnings, []);
  // 负向对照：**真去连一个站**照旧要报（豁免只对命名空间那一格）
  assert.equal(
    lintApp(page('<script>fetch("https://www.example.com/a")</script>')).errors.some((e) => e.code === 'host-not-declared'),
    true,
    '★ 豁免不许把真外站也放过',
  );
  assert.deepEqual(httpsHostsIn('<svg xmlns="http://www.w3.org/2000/svg"></svg> https://api.x.com/a'), ['api.x.com']);
});

test('⑤ 网络：连了没声明的站 ⇒ **报错**；声明了没连 ⇒ 提示；没声明 net 却连外站 ⇒ 报错', () => {
  const body = '<script>fetch("https://api.github.com/repos/x")</script>';
  const r = lintApp(page(body));
  assert.equal(r.errors.some((e) => e.code === 'host-not-declared'), true, '连了没声明的站 ⇒ 报');
  assert.equal(r.errors.some((e) => e.code === 'net-not-declared'), true, '没声明 net ⇒ 也报');
  // 声明对了 ⇒ 干净
  const good = lintApp({ ...page(body), permissions: ['net'], net: ['api.github.com'] });
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.warnings, []);
  // 声明了却没连 ⇒ 提示
  const unused = lintApp({ ...page('<p>x</p>'), permissions: ['net'], net: ['api.github.com'] });
  assert.equal(unused.warnings.some((w) => w.code === 'host-unused'), true);
  // 只认 host（路径/查询串不算）
  assert.deepEqual(httpsHostsIn('https://a.example.com/x?y=1 http://b.example.com:8080/z'), ['a.example.com', 'b.example.com']);
});

test('⑥ 定时任务：开放式的"让它干什么" ⇒ 提示；写了任务没声明 tasks ⇒ 报错', () => {
  const open = lintApp({
    files: { 'index.html': '<p>x</p>' },
    permissions: ['tasks'],
    tasks: [{ id: 't', title: '随便', prompt: '随便逛逛，看看有什么能做的' }],
  });
  assert.equal(open.warnings.some((w) => w.code === 'open-task-prompt'), true);
  const closed = lintApp({
    files: { 'index.html': '<p>x</p>' },
    permissions: ['tasks'],
    tasks: [{ id: 't', title: '看账单', prompt: '看看今天花了多少，一句话告诉我' }],
  });
  assert.equal(closed.warnings.some((w) => w.code === 'open-task-prompt'), false, '具体的一句不该被报');
  const noPerm = lintApp({ files: { 'index.html': '<p>x</p>' }, tasks: [{ id: 't', title: 'x', prompt: '做事' }] });
  assert.equal(noPerm.errors.some((e) => e.code === 'tasks-not-declared'), true);
});

test('⑥ 七七八八：空页面只提示 title；`lintReport` 把结果翻成给 agent 看的一段', () => {
  const noTitle = lintApp({ files: { 'index.html': '<p>x</p>' } });
  assert.equal(noTitle.errors.length, 0);
  assert.equal(noTitle.warnings.some((w) => w.code === 'no-page-title'), true);
  assert.equal(lintReport({ errors: [], warnings: [] }), '', '没事 ⇒ 一个字都不说');
  const rep = lintReport(lintApp(page('<script>localStorage.setItem("a","1")</script>')));
  assert.match(rep, /对不上/, '有事 ⇒ 抬头要说清');
  assert.match(rep, /149-APP-DEV-STANDARD/, '要指向标准那一份');
  // 认不出来不许抛（垃圾输入 ⇒ 空结果）
  assert.deepEqual(lintApp().errors, []);
  assert.deepEqual(lintApp({ files: { 'a.html': null } }).errors, []);
});
