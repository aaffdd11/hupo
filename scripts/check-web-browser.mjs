#!/usr/bin/env node
// **浏览器那条路的端到端检查**（欠账第 16 条）。
//
// ⚠️ 为什么要有它：`w.stalkerai.cn` 上那条流**曾经整整一段时间一次都没连上过**
//    （客户端在 https 页面上拼出了 `ws://`，被浏览器按混合内容拦掉），
//    而当时**所有闸都是绿的** —— 因为验收用的是 node 探针，
//    而探针把 `wss://` **写死了**，正好绕过了客户端自己算地址的那一行。
//    ⇒ 手册因此加了判据 **V13**：**凡是客户端自己算出来的东西，闸要打在客户端这一侧。**
//    这条脚本就是那一侧：**真开一个浏览器**，让它自己去连。
//
// ⚠️ **它假定拿到的令牌能进聊天**（也就是说：那条流本来该通）。
//    ⇒ 拿一个**还没开好空间**的号的令牌来跑（`/api/space` 是 `provisioning`/`full`），
//      页面会停在**等待屏**、**根本不该连那条流** —— 而这条脚本仍然会报
//      "**没通** + 0 帧"（判据的形状与那个状态不匹配）。
//    ⚠️ 我 2026-09-21 就这么被骗过一次：截图里明明是"给不了"那一屏、
//      完全正常，而脚本判的是"那条路没通"。
//    ⇒ **看它的结论之前，先确认拿的令牌是能聊天的**（或者只看截图）。
//
// 它验两件事（**一件都不能省**）：
//   ① **自动断言**：那个页面里的 WebSocket 到底连上没有、有没有收到帧
//      （这正是 `ws://` 那类 bug 的唯一可观察信号）；
//   ② **截图**：`--shot` 存一张 PNG —— 人（或助手）能**看一眼**屏幕上到底什么样。
//      为什么要有这一半：Flutter web 把字画在 canvas 上，**默认 DOM 里没有文本**，
//      所以"页面上到底写了什么"靠查 DOM 是查不到的；而"看一眼"是最诚实的办法。
//
//      🔴 **2026-09-23 更新（重要）**：**打开无障碍语义树之后，DOM 里就有字了** ——
//         `--eval "document.querySelector('flt-semantics-placeholder').click()"` 一下，
//         Flutter 会建出真 DOM：`document.querySelector('flt-semantics-host').innerText`
//         就是屏幕上那些字（**近似**：它含列表里**没在视口里**的条目，所以"在树里"
//         ≠ "在屏幕上"，看屏幕仍然要看截图）；语义节点也**收得住 `click()`**。
//         ⇒ 现在有两条互补的路：**截图看"长什么样"**、**语义树读"写了什么"**。
//      ⚠️ **合成鼠标/指针事件仍然送不进画布**（pointer 与 mouse 都在
//         `flt-glass-pane` 上派过，页面**逐像素不变**）⇒ `--click-at` 那一套
//         **基本无效**，要"走到某一屏"请用 `--eval` + 语义节点点击。
//      ⚠️ **滚轮事件是有效的**：`flt-glass-pane` 上派 `WheelEvent`（deltaY 正数 = 往下）。
//
// 用法：
//   HUPO_TOKEN=<令牌> node scripts/check-web-browser.mjs
//   HUPO_TOKEN=... node scripts/check-web-browser.mjs --shot /tmp/shot.png --wait 60000
//   看未登录那两屏：加 `--no-token`；点一下再拍：`--click-at X,Y`（`--click-settle` 控制点完等多久）；
//   看折叠线以下：`--scroll-px <像素>`（页内合成 touch 指针拖一段 —— 鼠标拖在网页上不滚动）；
//   在页面里跑一段 JS（取证用，最有用的是"打开无障碍树"与"按语义节点点一下"）：
//     `--eval "<js>"`（可给多次，按顺序跑，结果打出来；`awaitPromise` 已开）；
//   滚到底：`--eval "(()=>{const g=document.querySelector('flt-glass-pane');for(let i=0;i<8;i++)g.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:600,clientX:640,clientY:300}));return 'ok'})()"`；
//   截图前等多久：`--shot-after <毫秒>`（默认 6000 —— **中文字体是异步下的，拍早了就是豆腐块**）；
//   屏掉 gstatic 验自托管：`--block-gstatic`（**在开页面之前**就屏，见 ②.5）
//   （`--url` 默认打线上；`--chrome` 指定浏览器可执行文件）
//
// ⚠️ **它不在硬闸里**：要一个浏览器 + 一个令牌。本机没有浏览器时它就该**跳过**
//    （`--help` 会说清怎么弄一个：`npx @puppeteer/browsers install chrome@stable --path ~/.cache/hupo-chrome`）。
//
// 退出码：0 路通了 · 2 没通 · 3 环境不具备（没浏览器 / 没令牌）· 4 只看了一眼屏幕（--no-token：那条流没验，别当“通了”）

import nodeChild from 'node:child_process';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import nodeProcess from 'node:process';
import WebSocket from '../v2/services/core/node_modules/ws/index.js';

const argv = nodeProcess.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f, dflt) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
/** 有没有这个开关（布尔型的那些用它）。 */
const hasFlag = (f) => argv.includes(f);

const URL_ = valueOf('--url', 'https://w.stalkerai.cn/');
/** `--block-gstatic`：把 gstatic 整个屏掉再开页面（验 CanvasKit 自托管）。 */
const BLOCK_GSTATIC = hasFlag('--block-gstatic');
const WAIT_MS = Number.parseInt(valueOf('--wait', '45000'), 10);
const SHOT = valueOf('--shot', null);
/**
 * **截图前再等多久**（`--shot-after <毫秒>`，默认 6000）。
 *
 * ── 为什么要有它（⚠️ 同一类坑第二次咬人）─────────────────────
 * 🔴 2026-09-23：拿 `--block-gstatic` 验"中文字体自托管"时，**同一条命令一会儿中文好好的、
 *    一会儿全是豆腐块** —— 排查了好几轮，根因是**截图比字体先到**：
 *    * 中文用的是**异步下载的分片字体**（引擎遇到缺字才去 `/fonts/…` 要，每片约 25KB）；
 *    * 这个脚本等到"**收到第一帧**"就往下走 ⇒ 那时字体可能还在路上 ⇒ 拍到的是 `.notdef` 方块；
 *    * 而**服务端字体缓存是冷的**时（新部署 / 新分片），这段路更久。
 *    ⇒ 它**不是**"镜子坏了"，是**我拍早了**。
 *    ⚠️ 这跟上面 `--click-settle` 那条是**同一类**：`CLICK_SETTLE_MS` 太短也会拍到
 *    "图标在、字全不见"（当时也差点当成真 bug）。**判断"画出来没有"必须给足时间。**
 *    ⇒ 现在截图前**固定等这么久**，`--shot-after 0` 可关掉（要拍"字还没到"那一帧时用）。
 */
const SHOT_AFTER_MS = Number.parseInt(valueOf('--shot-after', '6000'), 10);
/**
 * **往下滚一段再截图**：`--scroll-px <像素>`（正数 = 看更下面的内容）。
 *
 * ── 为什么要有它 ───────────────────────────────────────────
 * ⚠️ 2026-09-22：首页（落地页）**下半屏根本没法看一眼** —— 截图只拍视口，
 *    而"跟聊天机器人不一样在哪"那一块在折叠线以下。判据能证明它画出来了
 *    （`test/widget/landing_test.dart`），但**"屏幕上到底长什么样"只能看一眼**。
 *
 * ⚠️ 必须用 `pointerType: 'touch'` **拖**：桌面网页上**鼠标拖不会滚动**
 *    （Flutter 的滚动要滚轮或触摸拖动）。合成一次"按下 → 连续 move → 抬起"。
 */
const SCROLL_PX = Number.parseInt(valueOf('--scroll-px', '0'), 10);
/**
 * **点完等多久再截图**（`--click-settle <毫秒>`，默认 1400）。
 *
 * ── 为什么要这个开关 ───────────────────────────────────────
 * ⚠️ 2026-09-22：主人要"**丝滑的过渡**"。而过渡是**动态**的 ——
 *    默认那 1.4 秒早就走完了，截出来的永远只有"到站"那一帧。
 *    ⇒ 把它调小（比如 150）就能拍到**半途**：两屏交叠、新屏半透明。
 *    ⚠️ 它只用来"看一眼"，**不是判据**（判据在 `test/widget/landing_transition_test.dart`）。
 *
 * 🔴 **但要小心它太短**（2026-09-22 实测，差点把我看错）：
 *    调成 1500ms 时，新开的那一屏**字还没栅格化**（CanvasKit 的栅格缓存）——
 *    截图里图标在、**文字全不见**，看起来像"文字渲染坏了"的一个**真 bug**。
 *    多等到 **5000ms** 再拍，字全在。
 *    ⇒ **判断"画出来没有"要给足时间（≥1000ms，拿不准就 5000ms）**；
 *      "看一眼"也会看错 —— 看早了。
 */
const CLICK_SETTLE_MS = Number.parseInt(valueOf('--click-settle', '1400'), 10);
/**
 * **点一下再截图**：`--click-at X,Y`（可给多次，按顺序点；坐标是**视口 CSS 像素**）。
 *
 * ── 为什么不用 CDP 的 `Input.dispatchMouseEvent` ─────────────
 * ⚠️ 2026-09-22 实测：那条路**送不到 Flutter**（鼠标与触摸都试了，连
 *    `Emulation.setFocusEmulationEnabled` 也加了）—— 页面**逐字节不变**。
 *    ⇒ 改成**在页面里合成 pointer 事件**（Flutter web 监听的就是 pointerdown/up；
 *      它**不查 `isTrusted`**）。实测点"退出"能回首页 ⇒ 这条路通。
 * ⚠️ 它只用来**看一眼某一屏**（这个脚本的 `--shot` 用途），**不是判据** ——
 *    判据是 `test/widget/*`（真点真断言）。
 */
const CLICKS = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--click-at' && argv[i + 1]) CLICKS.push(argv[i + 1]);
}
/** 两次 `--eval` 之间歇多久（要看动画途中那一帧就调小它）。 */
const EVAL_SETTLE_MS = Number.parseInt(valueOf('--eval-settle', '600'), 10);

/** `--eval <js>`（可多次）：在页面里跑一段 JS 并把结果打出来（取证用，见下面 ④.4）。 */
const EVALS = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--eval' && argv[i + 1]) EVALS.push(argv[i + 1]);
}
// ⚠️ **CDP 的 `Input.*` 送不到 Flutter**（2026-09-22 实测：鼠标与触摸都试了、
//    连聚焦模拟也加了，**页面逐字节不变**）；而**页内合成 pointer 事件**可以
//    （见上面 `CLICKS` 那段）。⇒ 点这一下走后者。
const WIDTH = Number.parseInt(valueOf('--width', '1280'), 10);
const HEIGHT = Number.parseInt(valueOf('--height', '757'), 10);
const TOKEN = nodeProcess.env.HUPO_TOKEN ?? null;

/** 浏览器在哪。优先环境变量，其次我们自己的缓存目录。 */
function findChrome() {
  const explicit = valueOf('--chrome', nodeProcess.env.HUPO_CHROME ?? null);
  if (explicit) return nodeFs.existsSync(explicit) ? explicit : null;
  const home = nodeOs.homedir();
  const roots = [nodePath.join(home, '.cache/hupo-chrome')];
  for (const root of roots) {
    if (!nodeFs.existsSync(root)) continue;
    // `chrome@stable` 解出来是 `<root>/chrome/<版本>/chrome-linux64/chrome`
    for (const ver of nodeFs.readdirSync(root, { withFileTypes: true })) {
      if (!ver.isDirectory()) continue;
      const dir = nodePath.join(root, ver.name);
      for (const mid of nodeFs.readdirSync(dir, { withFileTypes: true })) {
        if (!mid.isDirectory()) continue;
        for (const exe of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
          const p = nodePath.join(dir, mid.name, exe);
          if (nodeFs.existsSync(p)) return p;
        }
      }
    }
  }
  return null;
}

if (has('--help') || has('-h')) {
  console.log(
    [
      '用法：HUPO_TOKEN=<令牌> node scripts/check-web-browser.mjs [--url <地址>] [--shot <png>] [--wait <毫秒>] [--shot-after <毫秒>]',
      '',
      '它做什么：开一个真浏览器 → 灌进令牌 → 打开页面 →',
      '          **看那条流到底连上没有、有没有收到帧** → 可选截图。',
      '退出码：0 路通了 ｜ 2 没通 ｜ 3 环境不具备（没浏览器 / 没令牌）',
      '',
      '没有浏览器的话，弄一个**不需要 root** 的：',
      '  npx --yes @puppeteer/browsers install chrome@stable --path ~/.cache/hupo-chrome',
      '',
      '没有令牌的话（令牌不是口令，不违反"口令只留在机器上"）：',
      '  在 v2/services/core 下用 Auth 发一个，或者用主人平时登录的那个。',
    ].join('\n'),
  );
  nodeProcess.exit(0);
}

const chrome = findChrome();
if (!chrome) {
  console.error('⚠️ 环境不具备：找不到浏览器。');
  console.error('   弄一个（不需要 root）：npx --yes @puppeteer/browsers install chrome@stable --path ~/.cache/hupo-chrome');
  nodeProcess.exit(3);
}
/**
 * `--no-token`：**只看"未登录"那两屏**（首页 / 登录页）。
 * ⚠️ 那时**不能判"路通不通"**（没登录就没有那条流）⇒ 只截图、只说"没验那条流"。
 * 为什么要有它：这个脚本的另一半用途是**看一眼某一屏长什么样**（改版时尤其需要），
 * 而首页/登录页恰恰是"没令牌"才看得到的。
 */
const NO_TOKEN = has('--no-token');
if (!TOKEN && !NO_TOKEN) {
  console.error('⚠️ 环境不具备：没给令牌（设 HUPO_TOKEN；只看未登录那两屏加 --no-token）。**不是路坏了。**');
  nodeProcess.exit(3);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const profile = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-br-'));
  const port = 9200 + Math.floor(Math.random() * 400);
  const child = nodeChild.spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      // ⚠️ 这台机器上 apparmor 限制无根用户命名空间 ⇒ 浏览器的沙箱起不来。
      //    这是**测试用的一次性浏览器**（临时 profile、只看我们自己的站点），
      //    不是拿来上网的，所以退到 --no-sandbox 是可接受的取舍。
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--window-size=${WIDTH},${HEIGHT}`,
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const cleanup = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已经没了 */
    }
    try {
      nodeFs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* 删不掉就算了 */
    }
  };

  // ① 等调试口起来
  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  if (!target) {
    cleanup();
    console.error('✗ 浏览器起来了但调试口没响应（--remote-debugging-port）');
    nodeProcess.exit(2);
  }

  // ② 接上它
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });

  let msgId = 0;
  const pending = new Map();
  const wsEvents = { created: 0, received: 0, types: new Set(), closed: 0 };
  // ★ **中文字体回退那条路的读数**：引擎会去 `/fonts/…` 要**分片字体**（每片约 25KB）。
  //   ⚠️ 它**不报错** —— 取不到就是"字变方块/空白"，所以判据只能看**请求本身**。
  const fontReqs = { asked: 0, ok: 0, failed: 0, last: '', t0: null, tLast: null };
  const fontPending = new Map(); // requestId → url（`loadingFailed` 里不带 url，只能自己记）
  /**
   * **这次导航是从什么时候开始的**（用于把"字体到位"换算成**秒**）。
   *
   * ⚠️ 为什么值得有（账 #64）：`--shot-after 0` 拍到的永远是**字体还没到**的那一帧
   *    （那是"第一帧"的定义，跟服务端缓存冷热**无关**）。服务端字体镜像冷热影响的是
   *    **最后一条字体回来的时间** —— 那才是"头一次访问中文会晚几秒"那句话的**读数**。
   *    ⇒ 没有这个数，冷/热两件事在截图上是**分不出来**的（我为此白跑过一轮）。
   */
  let navAt = 0;
  const navigate = async () => {
    navAt = Date.now();
    fontReqs.t0 = null;
    fontReqs.tLast = null;
    await send('Page.navigate', { url: URL_ });
  };
  const pageErrors = [];
  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
      return;
    }
    // 页面的报错**必须收**：不然"为什么没连"只能猜
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params?.exceptionDetails;
      pageErrors.push(String(d?.exception?.description ?? d?.text ?? '').split('\n')[0]);
    }
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params?.type)) {
      pageErrors.push(`[${m.params.type}] ` + (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
    }
    // ★ 这一半才是"浏览器那条路"的判据：**页面自己**连的 WebSocket 有没有通
    if (m.method === 'Network.webSocketCreated') wsEvents.created += 1;
    if (m.method === 'Network.webSocketClosed') wsEvents.closed += 1;
    if (m.method === 'Network.webSocketFrameReceived') {
      wsEvents.received += 1;
      const p = m.params?.response?.payloadData ?? '';
      for (const t of ['user/echo', 'message/start', 'message/text', 'message/end', 'client/hello']) {
        if (p.includes(`"${t}"`)) wsEvents.types.add(t);
      }
    }
    // ★ 字体那条口：问了没问、成没成（**它决定中文是不是方块**）
    if (m.method === 'Network.requestWillBeSent') {
      const u = m.params?.request?.url ?? '';
      if (u.includes('/fonts/')) {
        fontReqs.asked += 1;
        fontPending.set(String(m.params.requestId), u);
      }
    }
    if (m.method === 'Network.responseReceived') {
      const u = m.params?.response?.url ?? '';
      if (u.includes('/fonts/')) {
        // ★ **字体到位花了多久**（账 #64 那句话的读数）：从这次导航算起
        const at = Date.now() - navAt;
        if (fontReqs.t0 == null) fontReqs.t0 = at;
        fontReqs.tLast = at;
        const st = m.params.response.status ?? 0;
        if (st >= 200 && st < 300) fontReqs.ok += 1;
        else {
          fontReqs.failed += 1;
          fontReqs.last = `${st} ${u}`;
        }
      }
    }
    if (m.method === 'Network.loadingFailed') {
      const u = fontPending.get(String(m.params?.requestId));
      if (u) {
        fontReqs.failed += 1;
        fontReqs.last = `${m.params?.errorText ?? '失败'} ${u}`;
      }
    }
  });

  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = (msgId += 1);
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Network.enable');
  await send('Page.enable');
  await send('Runtime.enable');

  // ②.5 🔴 **屏掉 gstatic —— 必须在第一次导航之前**
  //
  //   ⚠️ 原来这段在**第一次导航之后**（见下面 ③.5 的旧址），而那是**一个假判据**：
  //      第一次导航是**不屏蔽**的真实导航，`fonts.gstatic.com` 与 `www.gstatic.com`
  //      都被真的拉了一遍、进了同一个 profile 的 HTTP 缓存；第二次导航虽然屏了，
  //      却**从缓存里拿到了**——于是"页面照样开"**什么都证明不了**。
  //      **实测代价**：同一条命令一会儿"中文好好的"、一会儿"全是豆腐块"，
  //      来回排查了好几轮，根因就是这个自热缓存（2026-09-23）。
  //   ⇒ 判据要成立，屏蔽就得**在页面第一次发出请求之前**生效：这样跑出来的
  //      "还能开 + 字还在"才是"CanvasKit 与中文回退字体都不是从 gstatic 取的"。
  if (BLOCK_GSTATIC) {
    await send('Network.setBlockedURLs', { urls: ['*gstatic.com*', '*gstatic.cn*'] });
    console.log('  🚫 已屏掉 gstatic（域名级，**开页面之前**就屏）—— 页面还能开、字还在，才算自托管'); 
  }

  // ③ 令牌**在页面自己的脚本跑之前**就位（**不碰口令**：令牌是可撤销的，口令不是）
  //
  // ⚠️ 第一版这里是"先导航一次 → 灌 localStorage → 再刷新"，**它赌输了**：
  //    第一次导航还没 commit 的时候 `Runtime.evaluate` 落在**空源**上，
  //    `localStorage.setItem` 直接抛（SecurityError），于是页面起来时没有令牌、
  //    停在登录页、**一个 WebSocket 都没建** —— 而断言就报了"路没通"。
  //    图一打开就看得出来：登录页画得好好的（所以不是页面坏了，是**我灌晚了**）。
  // ⇒ 改用 CDP 的正规做法：`addScriptToEvaluateOnNewDocument`，
  //   让**下一次加载**一开头就把令牌放进去，不用赌什么时候 commit、也不用手动 reload。
  const origin = new URL(URL_).origin;
  // ⚠️ **键名带前缀**（实测，不是猜）：`shared_preferences_web` 里
  //    `_defaultPrefix = 'flutter.'` ⇒ 客户端存的是 **`flutter.hupo_auth_token`**。
  //    我第一版灌的是裸 `hupo_auth_token`，于是页面起来看不见令牌、停在登录页、
  //    **一个 WebSocket 都没建** —— 而断言照样老老实实报"路没通"（它也确实是没通）。
  //    ⇒ 两个都灌：真的那个 + 裸的那个（万一哪天插件改了前缀，这里不至于又白跑一次）。
  //
  // ⚠️ 而且值**不是裸串**：插件是 `_encodeValue = json.encode(value)`（实测 2.4.3 源码），
  //    读的时候 `json.decode` 解不开就**静默返回 null** ⇒ App 就当"没有令牌"。
  //    我第一版灌的是裸串，于是：键对了、值在了、App 还是看不见它
  //    —— 排查这条链花了几轮，**根因就是少了一层 JSON 编码**。
  //    ⇒ 值要写成 JSON 字符串（`"eyJ…"` 这种带引号的形式）。
  const KEYS = ['flutter.hupo_auth_token', 'hupo_auth_token'];
  const encoded = JSON.stringify(TOKEN); // 这就是 json.encode 的结果
  if (!TOKEN) {
    // `--no-token`：**不灌令牌**，只把页面打开（看首页/登录页那两屏）
    await navigate();
    console.log('  令牌：没给（--no-token）⇒ 看的是**未登录**那一屏；那条流**不验**。');
  } else {
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source:
      `try { if (location.origin === ${JSON.stringify(origin)}) {` +
      KEYS.map((k) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(encoded)});`).join('') +
      `} } catch (e) {}`,
  });
  await navigate();
  // 等它真的开始用了（能读到令牌 ⇒ 客户端才会去连那条流）
  let seededOk = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    const q = await send('Runtime.evaluate', {
      expression: `(localStorage.getItem('flutter.hupo_auth_token') ?? localStorage.getItem('hupo_auth_token') ?? '').length`,
      returnByValue: true,
    });
    if ((q.result?.result?.value ?? 0) > 0) {
      seededOk = true;
      break;
    }
  }
  console.log(`  令牌就位：${seededOk ? '是' : '⚠️ 否（那页面会停在登录页 ⇒ 后面必然一个帧都收不到）'}`);
  // ⚠️ 诊断信息：**键名到底叫什么**、页面**有没有报错**。
  //    第一版这里吃过亏：我按裸键名灌，App 看不见，于是一路"没通"，
  //    而真正的原因（键名前缀）只能靠打出来才知道。
  const dump = await send('Runtime.evaluate', {
    expression: `JSON.stringify({ href: location.href, w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, keys: Object.keys(localStorage), hasFlutter: typeof window._flutter !== 'undefined' })`,
    returnByValue: true,
  });
  console.log(`  页面现场：${dump.result?.result?.value ?? '(读不到)'}`);
  }

  // ③.5 ⚠️ **屏蔽搬走了**：原来在这里（第一次导航**之后**）才 `setBlockedURLs`，
  //      那会让第一次导航把 gstatic 的东西灌进缓存 ⇒ 判据自欺。**现在在 ②.5**。
  //
  //   这条判据为什么值得单钉：Flutter web 默认把 **CanvasKit** 指向
  //   `https://www.gstatic.com/flutter-canvaskit/<hash>/`、中文回退字体指向
  //   `https://fonts.gstatic.com/s/` —— **国内经常取不到**，
  //   而现象是"页面加载很慢/白屏/字变豆腐"，且**本地一切正常**（这台机器取 gstatic 只要 0.4s）。
  //   ⇒ 判据只能是：**gstatic 整个取不到，页面照样得开、字照样得在**。
  if (BLOCK_GSTATIC) {
    await navigate();
  }

  // ④ 看那条流：等到"收到了帧"或超时
  const t0 = Date.now();
  while (Date.now() - t0 < WAIT_MS) {
    if (wsEvents.types.has('user/echo') || wsEvents.received > 0) break;
    await sleep(500);
  }

  // ④.4 **在页面里跑一段 JS**（可选）：`--eval <js>`（可给多次，按顺序跑，结果打出来）。
  //
  // 🔴 为什么需要它（2026-09-23 实测）：**合成鼠标事件送不进 Flutter 的画布**
  //    （pointer 与 mouse 都在 `flt-glass-pane` 上派过，页面**逐像素不变**）。
  //    而 Flutter 有一套**真 DOM 的无障碍树**：把 `flt-semantics-placeholder`
  //    点一下就会建出来，那之后：
  //      · 屏幕上的**字能在 DOM 里查到**（`aria-label`）—— 不用只靠看截图；
  //      · 语义节点**收得住真点击**（Flutter 自己转回框架）。
  //    ⇒ 它让"走到某一屏再看一眼"这条路重新可用。
  // ⚠️ 它**只是取证**（看一眼），**不是判据** —— 判据是 `test/` 里那些。
  for (const expr of EVALS) {
    try {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      const v = r.result?.result?.value;
      console.log(`  🧪 eval → ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    } catch (err) {
      console.error(`  ⚠️ eval 失败：${err?.message ?? err}`);
    }
    // ⚠️ **两次 eval 之间默认歇 600ms**（给页面时间画完）；要看**动画途中**那一帧就得调小它
    //    （例如 `--eval-settle 0`：点完立刻截图 ⇒ 拍到"刚扩开"那一帧）。
    await sleep(EVAL_SETTLE_MS);
  }

  // ④.5 **按顺序点几下**（可选）：用来"走到某一屏再看一眼"
  for (const spec of CLICKS) {
    const m = /^\s*([0-9.]+)\s*,\s*([0-9.]+)\s*$/.exec(spec);
    if (!m) {
      console.error(`⚠️ --click-at 要 "X,Y" 这种（实为 ${spec}）`);
      continue;
    }
    const x = Number(m[1]);
    const y = Number(m[2]);
    const js = `(() => {
      const x = ${x}, y = ${y};
      // 🔴 **要往 shadow root 里钻**（2026-09-23 修）：
      //    Flutter web 把画布装在一个 shadow root 里，elementFromPoint
      //    **只会返回宿主元素**（实测：FLUTTER-VIEW），而监听 pointer 的是里面那一层
      //    ⇒ 事件派在宿主上**进不去**（页面逐字节不变 —— 我拿坐标点"展开"验过两次）。
      //    ⚠️ 这一段在**外层模板串里**生成 ⇒ 注释里**不许出现反引号**（会掐断字符串，当场语法错）。
      const deep = (px, py) => {
        let el = document.elementFromPoint(px, py) || document.body;
        for (let i = 0; i < 8 && el && el.shadowRoot; i += 1) {
          const inner = el.shadowRoot.elementFromPoint(px, py);
          if (!inner || inner === el) break;
          el = inner;
        }
        return el || document.body;
      };
      const el = deep(x, y);
      const mk = (type, buttons) => new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, screenX: x, screenY: y,
        pointerId: 1, pointerType: 'mouse', isPrimary: true,
        button: 0, buttons, width: 1, height: 1, pressure: buttons ? 0.5 : 0,
      });
      // 🔴 **派给 Flutter 真正收事件的那个元素**（2026-09-23 修）：
      //    实测这一版 DOM 是 flutter-view + flt-glass-pane / flt-text-editing-host /
      //    flt-semantics-host，而 elementFromPoint 只回 flutter-view（玻璃板
      //    pointer-events 是 none）⇒ 事件派在 flutter-view 上**进不去**。
      //    ⇒ 优先派给玻璃板，它不在就退回那个命中元素。
      const target = document.querySelector('flt-glass-pane') || el;
      // ⚠️ 光有 pointer 事件不够（实测点不动）：**老式的 mouse 事件一起给**。
      const mouse = (type, buttons) => new MouseEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, button: 0, buttons,
      });
      for (const ev of [mk('pointerover', 0), mk('pointerenter', 0), mk('pointermove', 0)]) target.dispatchEvent(ev);
      target.dispatchEvent(mouse('mouseover', 0));
      target.dispatchEvent(mouse('mousemove', 0));
      target.dispatchEvent(mk('pointerdown', 1));
      target.dispatchEvent(mouse('mousedown', 1));
      target.dispatchEvent(mk('pointerup', 0));
      target.dispatchEvent(mouse('mouseup', 0));
      target.dispatchEvent(mouse('click', 0));
      // ⚠️ 打印**整摞**命中的元素（不只是最上面那个）：排查"事件到底该派给谁"时，
      //    只看最上面那个会把人带偏（实测 elementFromPoint 只回宿主）。
      const stack = Array.from(document.elementsFromPoint(x, y))
        .map((e) => e.tagName + (e.className ? '.' + String(e.className).split(' ')[0] : ''))
        .join(' > ');
      return target.tagName + ' ⟸ ' + stack;
    })()`;
    const r = await send('Runtime.evaluate', { expression: js, returnByValue: true });
    console.log(`  🖱 点了 (${x}, ${y}) → 落在 ${r.result?.result?.value ?? '?'}`);
    // 让它把新一屏画出来。⚠️ 用 `--click-settle` 调小就能拍到**过渡半途**那一帧。
    await sleep(CLICK_SETTLE_MS);
  }

  // ④.7 **往下滚一段**（可选）：折叠线以下的那一块，截图看不到 —— 只能滚过去再看
  if (SCROLL_PX > 0) {
    const js = `(async () => {
      const cx = Math.round(innerWidth / 2);
      const y0 = Math.round(innerHeight * 0.85);
      const el = document.elementFromPoint(cx, y0) || document.body;
      const mk = (type, y, buttons) => new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        clientX: cx, clientY: Math.round(y), screenX: cx, screenY: Math.round(y),
        pointerId: 7, pointerType: 'touch', isPrimary: true,
        button: 0, buttons, width: 1, height: 1, pressure: buttons ? 0.5 : 0,
      });
      el.dispatchEvent(mk('pointerover', y0, 0));
      el.dispatchEvent(mk('pointerdown', y0, 1));
      const total = ${SCROLL_PX};
      const steps = 14;
      for (let i = 1; i <= steps; i += 1) {
        el.dispatchEvent(mk('pointermove', y0 - (total * i) / steps, 1));
        await new Promise((r) => setTimeout(r, 16));
      }
      el.dispatchEvent(mk('pointerup', y0 - total, 0));
      return '滚了 ' + total + 'px（在 ' + (el.tagName || '?') + ' 上）';
    })()`;
    const r = await send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true });
    console.log(`  ↕ ${r.result?.result?.value ?? '?'}`);
    await sleep(1200); // 等惯性滚完、把新内容画出来
  }

  // ⑤ 截图（给"人/助手看一眼"用）
  if (SHOT) {
    // ⚠️ **先等字体落定再拍**（见 `SHOT_AFTER_MS` 那段）：中文是异步下载的分片字体，
    //    拍早了就是一片 `.notdef` 方块，而**看起来像"镜子坏了"**。
    if (SHOT_AFTER_MS > 0) {
      console.log(`  ⏳ 截图前等 ${SHOT_AFTER_MS}ms（中文字体是异步下的；不等就可能拍到"字还没到"那一帧）`);
      await sleep(SHOT_AFTER_MS);
    }
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const b64 = shot.result?.data;
    if (b64) {
      nodeFs.writeFileSync(SHOT, Buffer.from(b64, 'base64'));
      console.log(`📷 截图：${SHOT}`);
    } else {
      console.error('⚠️ 截图没拿到');
    }
    // 🔤 字体那条口的读数：**屏幕上有没有字，只能看截图**（canvas 里查不到文本），
    //     但"引擎到底有没有把字体取回来"这里是看得见的 —— 两件对着看才判得准。
    const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
    console.log(
      `  🔤 中文字体那条口：问了 ${fontReqs.asked} 次 · 成了 ${fontReqs.ok} · 失败 ${fontReqs.failed}` +
        (fontReqs.t0 != null
          ? ` · 第一条 ${secs(fontReqs.t0)} · **最后一条 ${secs(fontReqs.tLast)}**（从开始导航算）`
          : '') +
        (fontReqs.last ? `（最后一次失败：${fontReqs.last}）` : ''),
    );
    if (fontReqs.asked > 0 && fontReqs.ok === 0) {
      console.log('     🔴 **一次都没取回来** ⇒ 屏幕上的中文多半是方块/空白（看截图确认）');
    }
  }

  // ⑤.5 **续期到底有没有发生**（这一条只有"在浏览器里"才看得到）
  //   ⚠️ 为什么值得单钉一条：客户端开机会拿旧令牌换一个新的（`POST /api/renew`）。
  //      "自动闸绿"证明不了这件事在**装出来的那个页面上**真的发生了 ——
  //      而它的失败是**静默**的（拿旧令牌照样能连，只是半年后某天会被踢出去）。
  //   ⇒ 判据很直接：**App 有没有把 localStorage 里那个令牌换掉。**
  const afterTok = await send('Runtime.evaluate', {
    expression: `localStorage.getItem('flutter.hupo_auth_token') ?? ''`,
    returnByValue: true,
  });
  const afterVal = afterTok.result?.result?.value ?? '';
  if (afterVal === '') {
    console.log('  续期       ⚠️ 令牌**被清掉了**（那是 401 那条路：它认为续不动了）');
  } else if (afterVal !== encoded) {
    console.log('  续期       ✅ 令牌**被换新了**（App 开机续了一次）');
  } else {
    console.log('  续期       ⚠️ 没看到换新（续期没发生 / 失败后按"留着旧的"处理）');
  }

  // ⑤.4 **制品那个沙箱的 origin**（乙-1 · 判据 N1 的**唯一可观察信号**）
  //
  //   🔴 为什么只能在这儿看：N1 说的是"执行第三方代码的东西**绝不与持有令牌的原点同源**"。
  //      那件事在这一侧才看得见 —— 页面上到底起没起 iframe、它的 origin 是不是**另一个**。
  //   ⚠️ **没有 iframe 不算失败**（可能是没开小程序）；**有而违规**才算失败：
  //      ① 与页面同源 ② `sandbox` 里出现了 `allow-same-origin`（那等于把壳的存储给它）。
  let appFramesBad = 0;
  {
    const r = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        page: location.origin,
        frames: Array.from(document.querySelectorAll('iframe')).map((f) => ({
          src: f.getAttribute('src') || '',
          sandbox: f.getAttribute('sandbox') || '',
        })),
      })`,
      returnByValue: true,
    });
    const raw = r.result?.result?.value ?? '';
    try {
      const j = JSON.parse(raw);
      const page = String(j.page ?? '');
      if (!j.frames?.length) {
        console.log('  小程序壳   （这一趟没有开小程序：页面上没有 iframe）');
      }
      for (const f of j.frames ?? []) {
        let origin = '(读不出)';
        try {
          origin = new URL(f.src).origin;
        } catch { /* 空 src / 非 URL */ }
        const sameOrigin = origin !== '(读不出)' && origin === page;
        const hasSameOriginSandbox = /allow-same-origin/.test(f.sandbox);
        const bad = sameOrigin || hasSameOriginSandbox;
        if (bad) appFramesBad += 1;
        console.log(`  小程序壳   ${bad ? '🔴' : '✅'} iframe origin=${origin} sandbox="${f.sandbox}"（壳是 ${page}）`);
        if (sameOrigin) console.log('      🔴 **与壳同源** —— 那等于 N1 没做（制品读得到壳的存储与令牌）');
        if (hasSameOriginSandbox) console.log('      🔴 sandbox 里有 `allow-same-origin` —— 不透明原点没了');
      }
    } catch {
      console.log(`  小程序壳   ⚠️ 读不出来：${raw.slice(0, 120)}`);
    }
  }

  // ⑥ 报（**如实**：把数出来的一起说，别只说结论）
  const ok = wsEvents.created > 0 && wsEvents.received > 0;
  console.log(`  页面里建过的 WebSocket：${wsEvents.created}（断过 ${wsEvents.closed}）`);
  console.log(`  收到的帧：${wsEvents.received}`);
  console.log(`  认出的事件类型：${[...wsEvents.types].join(' / ') || '（一个都没认出来）'}`);
  if (pageErrors.length) {
    console.log(`  ⚠️ 页面报的错（前 5 条）：`);
    for (const e of pageErrors.slice(0, 5)) console.log(`      · ${e}`);
  }
  cleanup();
  if (!TOKEN) {
    // `--no-token`：**这一趟没判那条路**（未登录就没有流）⇒ 用**单独的退出码 4**，
    // 免得"0 = 路通了"被读成一句没验过的好话。
    console.log(`👀 只看了一眼屏幕（未登录那两屏）—— 那条流**没有验**（${URL_}）`);
    nodeProcess.exit(4);
  }
  if (appFramesBad > 0) {
    console.error(`✗ **小程序的沙箱不合规**（${appFramesBad} 个 iframe：与壳同源 / 或 sandbox 里带了 allow-same-origin）`);
    console.error('  ⇒ 手册 N1：执行第三方代码的东西**绝不与持有令牌的原点同源**。');
    nodeProcess.exit(5);
  }
  if (ok) {
    console.log(`✅ 浏览器那条路通了（${URL_}）`);
    nodeProcess.exit(0);
  }
  console.error(`✗ **浏览器那条路没通**（${URL_}）`);
  console.error('  ⇒ 这正是 `ws://` 那类 bug 的形状：页面本身能开、接口也能答，就这条流不通。');
  nodeProcess.exit(2);
}

main().catch((err) => {
  console.error(`✗ 检查本身出错了：${err?.stack ?? err}`);
  nodeProcess.exit(2);
});
