// **小程序那一屏的"壳"**（丙 · 契约 `docs/dev/184-MINI-SHELL.md` · 主人 2026-10-05 选定）。
//
// ── 它解决什么 ────────────────────────────────────────────
//   网页上小程序是**一个真的 iframe**，它压在 Flutter 画布上面 ⇒ 想"把我的按钮画在它上面"
//   只有一条路：**也用网页元素画**。上一批我是在壳外面（Flutter 那一层）补了一套 DOM 叠加 ⇒
//   **同一颗按钮两份实现**（桌面一份、小程序里一份），大小/图形/颜色各自漂。
//   ⇒ 这一份把那一层**挪进 iframe 里**：壳是我们自己的页面，它里面再嵌小程序，
//     按钮由**壳**画 —— **一份实现**，天然在小程序之上，网页与手机同一套。
//
// ── 三条不许破 ────────────────────────────────────────────
//   ① 🔴 **壳不拿任何钥匙**：它收到的只是**已经签好名的活地址**（短时效、绑人）；
//      这个文件里**不许**出现 token / 签名键 / `HUPO_*`（判据 S2 扫它）。
//   ② 🔴 **小程序那一层照旧沙箱化**：`sandbox="allow-scripts"`，**不给** `allow-same-origin`
//      （给了就等于让它和壳共享源 —— 那正是 `08-SPEC.md` 那几条要防的）。判据 S3。
//   ③ **壳只转发**：它自己**不解析**小程序说了什么（`ask` 那条通道端到端照旧，判据 S5）。

/** 壳那三个地址（同一个原点；与制品/活地址同一个口）。 */
export const SHELL_PATH = '/one/shell';
export const SHELL_CSS_PATH = '/one/shell.css';
export const SHELL_JS_PATH = '/one/shell.js';

/**
 * 壳的 CSP（**壳自己那一页**那一条；小程序那一页的 CSP 照旧由它自己那条路管）。
 *
 * 🔴 **不给 `unsafe-inline`**（与这个仓库一贯的纪律）：所以样式与脚本各是一个文件。
 * ⚠️ `frame-src 'self'`：小程序那一页是**同一个原点**发出去的（活地址）。
 */
export const SHELL_CSP =
  "default-src 'none'; frame-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'";

/** 壳那一页（只有一个空的容器 —— 按钮由 JS 建，地址由 `?u=` 传进来）。 */
export function shellHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>小程序</title>
<link rel="stylesheet" href="${SHELL_CSS_PATH}">
</head>
<body>
<div id="app"></div>
<div id="words" aria-live="polite"></div>
<button id="mic" type="button">说一句</button>
<button id="exit" type="button">退出</button>
<script src="${SHELL_JS_PATH}"></script>
</body>
</html>
`;
}

/**
 * 壳的样式。
 *
 * 🔴 **四边贴满 ＋ 裁掉溢出**（2026-10-05 主人两次截图报的那两条白边：上方、右侧）：
 *    壳自己那一页由我们写，所以"内层精确贴满"是**结构上保证**的，不再靠调像素。
 * ⚠️ 三颗浮层：字（不吃点击，点它穿进小程序）、麦克风、退出（都是圆形，样式与桌面那颗对齐）。
 */
export function shellCss() {
  return `*{box-sizing:border-box}
html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#0000}
#app{position:fixed;inset:0;overflow:hidden}
#app iframe{position:absolute;top:0;left:0;width:100%;height:100%;border:0;display:block}
#words{position:fixed;bottom:92px;right:92px;max-width:62%;text-align:right;white-space:pre-wrap;
  color:#2B2320;font:15px/1.3 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
  pointer-events:none;display:none}
#mic,#exit{position:fixed;z-index:2147483647;display:flex;align-items:center;justify-content:center;
  border-radius:50%;cursor:pointer;padding:0;-webkit-tap-highlight-color:transparent}
#mic{bottom:16px;right:16px;width:64px;height:64px;background:#FFFDF9;border:1px solid #E8E0D4;
  color:#2B2320;box-shadow:0 2px 10px rgba(0,0,0,.16)}
#mic[data-listening="1"]{background:#C8452F;border:0;color:#FFFDF9}
#exit{top:10px;right:10px;width:44px;height:44px;background:rgba(43,35,32,.38);border:0;color:#fff;
  font-size:18px;line-height:44px}
#oops{position:fixed;inset:0;display:none;align-items:center;justify-content:center;padding:24px;
  color:#2B2320;font:16px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;text-align:center}
`;
}

/**
 * 壳的脚本。
 *
 * 四件事：① 认 `?u=`（**只认我们自己签过的活地址**：`/w/…` 或 `/a/…` 且带 `s=`）；
 * ② 把小程序嵌进沙箱 iframe；③ 按钮被按 ⇒ postMessage 给外面（Flutter）；
 * ④ 外面推来的"该显示什么" ⇒ 写到字那一行 / 换麦克风的样子。**不解析小程序的内容**。
 */
export function shellJs() {
  return `(function () {
  var u = new URLSearchParams(location.search).get('u') || '';
  var app = document.getElementById('app');
  // ① 只认我们自己签过的活地址（短时效、绑人）；别的一律不加载，并如实说一句。
  var ok = (u.indexOf('/w/') === 0 || u.indexOf('/a/') === 0) && u.indexOf('s=') !== -1;
  if (!ok) {
    var oops = document.createElement('div');
    oops.id = 'oops';
    oops.textContent = '这一条打不开：它不是一个有效的小程序地址。';
    oops.style.display = 'flex';
    document.body.appendChild(oops);
    return;
  }
  // ② 小程序那一层：**照旧沙箱化**（allow-scripts，**不给** allow-same-origin）
  var f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts');
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.setAttribute('allow', '');
  f.src = u;
  app.appendChild(f);

  function tell(what) {
    try { parent.postMessage({ kind: 'hupo-chrome', what: what }, '*'); } catch (e) {}
  }
  document.getElementById('mic').addEventListener('click', function () { tell('mic'); });
  document.getElementById('exit').addEventListener('click', function () { tell('exit'); });

  // ④ 外面推来的状态（字 / 在不在录）—— 我们只照着显示，**不解析小程序说了什么**
  addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || typeof d !== 'object') return;
    // ★ **小程序问一句那条路：壳只做"转发"**（丙 · 契约 184 的 S5）。
    //   🔴 壳**不看**正文（那一段 prompt 一个字都不读）—— 它只把这条消息原样递给外面，
    //      外面那条闸（app-ask 那四道）照旧一道不落。
    if (d.kind === 'ask') {
      try { parent.postMessage({ kind: 'ask', prompt: d.prompt }, '*'); } catch (e2) {}
      return;
    }
    if (d.kind === 'hupo-reply' || d.kind === 'hupo-error') {
      // 外面答回来的那一句 ⇒ 交给**里面那一层**（小程序那一页）
      try { if (f.contentWindow) f.contentWindow.postMessage(d, '*'); } catch (e3) {}
      return;
    }
    if (d.kind === 'hupo-words') {
      var w = document.getElementById('words');
      var t = typeof d.text === 'string' ? d.text : '';
      w.textContent = t;
      w.style.display = t.trim() === '' ? 'none' : 'block';
    } else if (d.kind === 'hupo-mic-state') {
      var m = document.getElementById('mic');
      m.setAttribute('data-listening', d.listening ? '1' : '0');
      m.setAttribute('aria-label', d.label || '说一句');
      m.textContent = d.listening ? '' : '';
      m.innerHTML = d.listening
        ? '<span style="display:block;width:16px;height:16px;border-radius:3px;background:#FFFDF9"></span>'
        : '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>';
    }
  });
})();
`;
}

/** 这一条请求是不是壳那三样之一（`app-serve.js` 的路由用它分岔）。 */
export function shellKindOf(pathname) {
  if (pathname === SHELL_PATH) return 'html';
  if (pathname === SHELL_CSS_PATH) return 'css';
  if (pathname === SHELL_JS_PATH) return 'js';
  return null;
}
