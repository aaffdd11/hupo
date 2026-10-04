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
const page = (body) => ({
  files: {
    'index.html':
      '<!doctype html><meta charset=utf-8>'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + `<title>x</title>${body}`,
  },
});

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
