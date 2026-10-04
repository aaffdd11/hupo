// **小程序制品的"自查"**（契约 `docs/dev/149-APP-DEV-STANDARD.md` §六）。
//
// ── 它是什么、为什么要有 ────────────────────────────────────
//   做小程序的那个 agent 是**看不见浏览器**的：它写完一份 HTML 就走了。而标准里那些
//   最容易犯的错（**引了外部资源**、**用了存储却没声明**、**去 fetch 一个没声明的站**、
//   碰 `localStorage`、假设有原生桥…）**在它那一侧完全静默** —— 到了主人屏幕上才变成
//   "点了没反应""字都没了"。⇒ 把标准里**能机械判的**做成这一份：写完当场告诉它。
//
// ── 🔴 三条纪律 ────────────────────────────────────────────
//   ① **纯函数**：不碰盘、不认识人、不抛（进 `test/unit` 那一档的速度）；
//   ② **说人话、给下一步**：每条都写清"哪一条标准 + 怎么改"（它是给模型读的，不是给人扫的）；
//   ③ **只报不拦**（今天）：`errors` 也不阻断 `app_create` —— 拦住会把"它明明能做对"
//      变成"它做不出来"；**但要说得足够大声**（回执里直接摊在它眼前）。
//
// ⚠️ **它不是安全边界**：真正的边界在 CSP、在壳侧的闸（`147`/`148`）。
//    这一份只是**在写的那一刻**把标准喊给它听。

/** 外部资源的几种写法（标准：**一个自包含页面**，不许引外部资源）。 */
const EXTERNAL_PATTERNS = [
  { re: /<script[^>]+\bsrc\s*=\s*["']?(https?:)?\/\//i, what: '<script src=…> 引了外部脚本' },
  { re: /<link[^>]+\bhref\s*=\s*["']?(https?:)?\/\//i, what: '<link href=…> 引了外部样式/字体' },
  { re: /<img[^>]+\bsrc\s*=\s*["']https?:\/\//i, what: '<img src="http…"> 引了外部图片' },
  { re: /@import\s+url\(\s*["']?https?:\/\//i, what: 'CSS `@import` 拉了一个外部样式' },
  { re: /new\s+WebSocket\s*\(/i, what: '`new WebSocket(...)`（页面连不了长连接）' },
  { re: /fonts\.googleapis\.com|fonts\.gstatic\.com/i, what: '引了 Google 字体（取不到）' },
];

/** 写盘/存储那几样（网页上是不透明源 ⇒ 一碰就抛）。 */
const STORAGE_PATTERNS = [
  { re: /\blocalStorage\b/, what: '`localStorage`' },
  { re: /\bsessionStorage\b/, what: '`sessionStorage`' },
  { re: /\bindexedDB\b/i, what: '`indexedDB`' },
];

/** 原生的那几样（手册铁律 3：**禁原生桥**）。 */
const BRIDGE_PATTERNS = [
  { re: /webkit\.messageHandlers/i, what: '`webkit.messageHandlers`' },
  { re: /window\.HupoNative|HupoNative\./i, what: '`HupoNative` 那种桥对象' },
  { re: /Android\.\w+/i, what: '`Android.*`（安卓注入对象）' },
];

/** "随便逛逛"这种**开放式**的任务说法（会被当成"他让它做的事"执行 ⇒ 标准不许）。 */
const OPEN_TASK_RE = /随便|随便看看|逛|看看有什么|你看着办|自由发挥|anything|whatever/i;

/** 把所有文件拼成一段可扫的正文（制品的页面就那么一两份）。 */
function joinText(files) {
  if (files && typeof files === 'object') {
    return Object.values(files)
      .map((v) => (typeof v === 'string' ? v : Buffer.isBuffer(v) ? v.toString('utf8') : ''))
      .join('\n');
  }
  return '';
}

/** 页面里出现的**绝对 https 站**（用来对"声明的白名单"）。 */
export function httpsHostsIn(text) {
  const out = [];
  const re = /https?:\/\/([a-z0-9.-]+)(?::\d+)?/gi;
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    const h = m[1].toLowerCase();
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

/**
 * **过一遍**。
 *
 * @param {object} o
 * @param {Record<string,string|Buffer>} [o.files]     制品的文件（页面正文）
 * @param {string[]} [o.permissions]                   清单里声明的能力
 * @param {string[]} [o.net]                           声明的白名单
 * @param {Array<{id?:string,title?:string,prompt?:string,everyMinutes?:number}>} [o.tasks]
 * @param {string} [o.title]
 * @returns {{errors:Array<{code:string,text:string}>, warnings:Array<{code:string,text:string}>}}
 */
export function lintApp({ files = {}, permissions = [], net = [], tasks = [], title = '' } = {}) {
  const errors = [];
  const warnings = [];
  const E = (code, text) => errors.push({ code, text });
  const W = (code, text) => warnings.push({ code, text });
  const text = joinText(files);
  const perms = Array.isArray(permissions) ? permissions.map(String) : [];
  const hosts = Array.isArray(net) ? net.map((h) => String(h).toLowerCase()) : [];
  const has = (p) => perms.includes(p);
  const uses = (s) => text.includes(s);

  // ① **自包含**：不许引外部资源（CSP 也拿不到）
  for (const { re, what } of EXTERNAL_PATTERNS) {
    if (re.test(text)) {
      E('external-resource', `${what} —— 标准 §三：小程序是**一份自包含的 HTML**，不许引外部资源（引了也取不到，屏幕上就是空白/没样式）。改法：把样式/脚本内联，图片用 data: 或干脆不画。`);
    }
  }

  // ② 存储：网页上是不透明源 ⇒ 一碰就抛（要存就走平台那条路）
  for (const { re, what } of STORAGE_PATTERNS) {
    if (re.test(text)) {
      E('browser-storage', `用了 ${what} —— 网页上它活在**不透明源**里，一碰就抛 SecurityError。改法：要记住东西就声明 \`db\`，走 \`/db\` 那条口（见 §四·存储）。`);
    }
  }

  // ③ 禁原生桥
  for (const { re, what } of BRIDGE_PATTERNS) {
    if (re.test(text)) {
      E('native-bridge', `用了 ${what} —— **禁原生桥**（手册铁律 3）：网页与安卓两端都不提供它，写了就是"点了没反应"。`);
    }
  }

  // ④ **声明与用途要对上**（这一条最值钱：用错就是"配了却连不出去 / 存不进去"）
  if (uses("'/db'") || uses('"/db"') || uses('`/db`')) {
    if (!has('db')) {
      // ★ **2026-10-02：这条规则撤了** —— 存储默认就有（`db` 不再需要声明，见 `147` §二·丁 /
      //   `app-db.js` 的 `checkAppDb`）⇒ 再用 `/db` 不是错。
    }
  } else if (has('db')) {
    // ★ **2026-10-02：「声明了没用」这条也不提了** —— `db` 默认就有、不必声明，
    //   所以"声明了却没用"不再是一件值得提醒的事（他也不用为此操心）。
  }
  if (uses("'/ask'") || uses('"/ask"') || uses('`/ask`')) {
    if (!has('ask')) {
      E('ask-not-declared', '页面在调 `/ask`（用他的钥匙问一句），但清单里**没声明 `ask`** ⇒ 一调就 403。改法：`permissions` 里加上 `ask`。');
    }
  }
  if (uses("'/agent'") || uses('"/agent"') || uses('`/agent`')) {
    if (!has('agent')) {
      E('agent-not-declared', '页面在调 `/agent`（跟你的助手说一句），但清单里**没声明 `agent`** ⇒ 一调就 403。改法：`permissions` 里加上 `agent`。');
    }
  }
  if (uses("'/db'") || uses('"/db"') || uses("'/ask'") || uses('"/ask"') || uses("'/agent'") || uses('"/agent"')) {
    if (!/URLSearchParams|location\.search/.test(text)) {
      W('no-entry-params', '调平台那几条口**第一次要带上入口 URL 里那三样**（`u`/`e`/`s`，见 `148` §1.4/§3.4 的片段）—— 页面里没看到读 `location.search`。');
    }
  }

  // ⑤ 网络：页面**直连**的站必须在名单里（没声明的连不出去）
  const pageHosts = httpsHostsIn(text);
  for (const h of pageHosts) {
    if (!hosts.includes(h)) {
      E('host-not-declared', `页面里去连 \`${h}\`，但清单的 \`net\` 里**没有它** ⇒ 浏览器/平板会拦掉（页面上就是"取不到数据"）。改法：把它写进 \`net\`（并且你**自己去访问确认过**），或者改成让助手取好写进文件。`);
    }
  }
  for (const h of hosts) {
    if (!pageHosts.includes(h)) {
      W('host-unused', `\`net\` 里声明了 \`${h}\`，但页面里没看到连它 —— 名单是安全边界（多一个就多一分风险），用不到就去掉。`);
    }
  }
  if (pageHosts.length > 0 && !has('net')) {
    E('net-not-declared', '页面自己去连外部站点，但清单里**没声明 `net`** ⇒ 一个站都连不出去。改法：声明 `net` 并把域名写进名单（见 §四·网络）。');
  }

  // ⑥ 任务：**不许写开放式的"让它干什么"**（那会被当成"他让它做的事"执行）
  const list = Array.isArray(tasks) ? tasks : [];
  for (const t of list) {
    const p = typeof t?.prompt === 'string' ? t.prompt : '';
    if (OPEN_TASK_RE.test(p)) {
      W('open-task-prompt', `定时任务「${t?.title ?? t?.id ?? '?'}」的"让它干什么"写得太开放（"${p.slice(0, 20)}…"）—— 它会**当成你让他做的事**去执行。改法：写成他会说的那种具体的一句（例如"看看今天花了多少，一句话告诉我"）。`);
    }
    if (list.length > 0 && !has('tasks')) {
      E('tasks-not-declared', '写了定时任务，但清单里**没声明 `tasks`** ⇒ 一件都不会跑。');
      break;
    }
  }

  /**
   * ⑧ ★ **外观基线**（2026-10-04 · 契约 `docs/dev/186-APP-DESIGN-BASELINE.md`）。
   *
   * 🔴 为什么这一档值得进自查：做小程序的 agent **看不见浏览器**（这一份文件的头一段就写着）。
   *    它写得出来、跑得通、功能也对，**但屏幕上可能很难看或者很难用** —— 而看的人里有
   *    "看不清小字、点不准"的那一端（`01-PROJECT.md`）。下面这几条**都是机械可判、
   *    而且判出来就是真毛病**的，不是口味问题：
   *      · 手机上看，没有 `viewport` ⇒ 整页按桌面宽渲染，字小到看不清；
   *      · `outline: none` 却没有替代的焦点样式 ⇒ 键盘/读屏用户不知道焦点在哪；
   *      · 字号小到 12px 以下 ⇒ 与"3 倍字号不破版"那条服务的人直接冲突；
   *      · `background-clip: text` 那种渐变字 ⇒ 对比度随底色变，读不清。
   *    ⚠️ **只报不拦**（warnings），而且**说清怎么改**。
   */
  if (text !== '') {
    if (!/<meta[^>]+name\s*=\s*["']?viewport/i.test(text)) {
      W('no-viewport', '没写 `<meta name="viewport" content="width=device-width, initial-scale=1">` —— 他那边是按手机那点宽度打开的，少了它整页会按桌面宽渲染（字小到看不清）。');
    }
    const killsFocus = /outline\s*:\s*(none|0)\b/i.test(text);
    // ⚠️ **"有没有替代的焦点样式"要看得更细**：`:focus{outline:none}` 本身也会命中
    //    "focus 里出现 outline"那种粗判 ⇒ 必须看那一块里 outline 的**值**是不是又给了东西。
    const focusBlocks = [...text.matchAll(/:focus(?:-visible)?\b[^{]*\{([^}]*)\}/gi)].map((m) => m[1]);
    const hasFocusStyle = focusBlocks.some((b) => /outline\s*:\s*(?!none\b|0\b)/i.test(b));
    if (killsFocus && !hasFocusStyle) {
      W('focus-removed', '把焦点框关掉了（`outline: none`）却没给替代的焦点样式 —— 用键盘或用读屏的人就不知道焦点在哪儿。改法：`:focus-visible { outline: 2px solid …; outline-offset: 2px; }`。');
    }
    const sizes = [...text.matchAll(/font-size\s*:\s*([0-9]+(?:\.[0-9]+)?)px/gi)].map((m) => Number(m[1]));
    const tiny = sizes.filter((n) => n < 12);
    if (tiny.length > 0) {
      W('tiny-text', `有 ${tiny.length} 处字号小于 12px（最小 ${Math.min(...tiny)}px）—— 这一份是给"看不清小字"的人也用的（界面那条线是"3 倍字号不破版"）。改法：正文 ≥15px、小字 ≥12px，靠字重和颜色分层，别靠缩小。`);
    }
    if (/background-clip\s*:\s*text/i.test(text) || /-webkit-background-clip\s*:\s*text/i.test(text)) {
      W('gradient-text', '用了渐变字（`background-clip: text`）—— 它的对比度跟着底色变，常常读不清，而且是一眼认得出的"模板感"。改法：要点靠**字重或字号**。');
    }
  }

  // ⑦ 名字/标题这类小事（页面标题空着不好看，但不拦）
  if (text !== '' && !/<title[^>]*>\s*\S/i.test(text)) {
    W('no-page-title', '页面里没写 `<title>` —— 加一句它的名字（他那边有些地方会用到）。');
  }
  void title;
  return { errors, warnings };
}

/** 把 lint 结果翻成**给 agent 看的那一段**（没有事 ⇒ 空串）。 */
export function lintReport({ errors = [], warnings = [] } = {}) {
  if (errors.length === 0 && warnings.length === 0) return '';
  const lines = [];
  if (errors.length > 0) {
    lines.push('🔴 **这一份跟标准对不上（会真的不好使）**：');
    for (const e of errors) lines.push(`  · ${e.text}`);
  }
  if (warnings.length > 0) {
    lines.push('⚠️ **顺手看一眼**：');
    for (const w of warnings) lines.push(`  · ${w.text}`);
  }
  lines.push('（标准：`docs/dev/149-APP-DEV-STANDARD.md`；这一条只报不拦，但请**当场改**再交。）');
  return lines.join('\n');
}
