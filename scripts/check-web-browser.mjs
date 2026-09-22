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
//      为什么要有这一半：Flutter web 把字画在 canvas 上，**DOM 里没有文本**，
//      所以"页面上到底写了什么"靠查 DOM 是查不到的；而"看一眼"是最诚实的办法。
//
// 用法：
//   HUPO_TOKEN=<令牌> node scripts/check-web-browser.mjs
//   HUPO_TOKEN=... node scripts/check-web-browser.mjs --shot /tmp/shot.png --wait 60000
//   看未登录那两屏：加 `--no-token`；点一下再拍：`--click-at X,Y`（`--click-settle` 控制点完等多久）；
//   看折叠线以下：`--scroll-px <像素>`（页内合成 touch 指针拖一段 —— 鼠标拖在网页上不滚动）
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

const URL_ = valueOf('--url', 'https://w.stalkerai.cn/');
const WAIT_MS = Number.parseInt(valueOf('--wait', '45000'), 10);
const SHOT = valueOf('--shot', null);
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
      '用法：HUPO_TOKEN=<令牌> node scripts/check-web-browser.mjs [--url <地址>] [--shot <png>] [--wait <毫秒>]',
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
    await send('Page.navigate', { url: URL_ });
    console.log('  令牌：没给（--no-token）⇒ 看的是**未登录**那一屏；那条流**不验**。');
  } else {
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source:
      `try { if (location.origin === ${JSON.stringify(origin)}) {` +
      KEYS.map((k) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(encoded)});`).join('') +
      `} } catch (e) {}`,
  });
  await send('Page.navigate', { url: URL_ });
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

  // ④ 看那条流：等到"收到了帧"或超时
  const t0 = Date.now();
  while (Date.now() - t0 < WAIT_MS) {
    if (wsEvents.types.has('user/echo') || wsEvents.received > 0) break;
    await sleep(500);
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
      const el = document.elementFromPoint(x, y) || document.body;
      const mk = (type, buttons) => new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, screenX: x, screenY: y,
        pointerId: 1, pointerType: 'mouse', isPrimary: true,
        button: 0, buttons, width: 1, height: 1, pressure: buttons ? 0.5 : 0,
      });
      el.dispatchEvent(mk('pointerover', 0));
      el.dispatchEvent(mk('pointerenter', 0));
      el.dispatchEvent(mk('pointermove', 0));
      el.dispatchEvent(mk('pointerdown', 1));
      el.dispatchEvent(mk('pointerup', 0));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y }));
      return el.tagName + '|' + (el.className || '');
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
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const b64 = shot.result?.data;
    if (b64) {
      nodeFs.writeFileSync(SHOT, Buffer.from(b64, 'base64'));
      console.log(`📷 截图：${SHOT}`);
    } else {
      console.error('⚠️ 截图没拿到');
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
