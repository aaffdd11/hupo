// 真浏览器体检：把线上页面在真实 Chromium 里跑一遍，看**用户到底看到了什么**。
//
// 为什么必须有这个：服务端日志只能证明"事件发出去了"，
// 证明不了"用户屏幕上有没有"。之前就是靠日志争论了半天 —— 这次直接看屏幕。
//
// Flutter Web 默认用 CanvasKit 渲染，**DOM 里没有文字**，所以这里靠截图 + WS 帧，
// 不靠 innerText。
//
// 用法：node browser-check.mjs ["要发的话"]
//   BASE=https://hupo.stalkerai.cn   SHOT_DIR=/tmp/shots

import { createRequire } from 'node:module';

import { ensureLoggedIn } from './probe-login.mjs';
import fsx from 'node:fs';

// 服务已开鉴权：验证工具要带着令牌进页面（模拟"主人已经登录过"）。
// 存进 localStorage 的那个 key 要和客户端 token_store.dart 一致。
const TOKEN = process.env.HUPO_TOKEN
  || (fsx.existsSync('/tmp/hupo.token') ? fsx.readFileSync('/tmp/hupo.token', 'utf8').trim() : '');
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const PW = process.env.PLAYWRIGHT_PATH || '/home/deploy/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright';
const { chromium } = require(PW);

const BASE = process.env.BASE || 'https://hupo.stalkerai.cn';
// ⚠ 默认用**探针专用会话**，不碰主人的 c_main。
//   踩过：所有浏览器测试都往 c_main 里发消息，主人的聊天记录里堆了一堆
//   「我已经升级好了。」「这条我没能给出结论」——那是我自己造的垃圾。
//   真要验主人那条会话时显式传 CONV=c_main。
const CONV = process.env.CONV || 'c_probe';
const TEXT = process.argv[2] || '帮我查一下今天上海天气';
const SHOT = process.env.SHOT_DIR || '/tmp/shots';
const WAIT_MS = Number(process.env.WAIT_MS || 30000);

mkdirSync(SHOT, { recursive: true });

// 本机只装了 playwright 1.61 期望版本之外的 headless shell，直接指定可执行文件。
const CHROME = process.env.CHROME_PATH
  || '/home/deploy/.cache/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell';

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 420, height: 860 } });

const logs = [];
const frames = [];
page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(0, 4).join('\n')}`));
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => {
  const u = r.url();
  if (u.includes('/api/')) logs.push(`[http ${r.status()}] ${u.replace(BASE, '')}`);
});
page.on('websocket', (ws) => {
  logs.push(`[ws] open ${ws.url().replace(BASE, '')}`);
  ws.on('close', () => logs.push('[ws] closed'));
  ws.on('framesent', (f) => frames.push(`[ws→] ${String(f.payload).slice(0, 140)}`));
  ws.on('framereceived', (f) => {
    const s = String(f.payload).slice(0, 200);
    frames.push(`[ws←] ${s}`);
  });
});

const shot = async (name) => {
  await page.screenshot({ path: `${SHOT}/${name}.png` });
  return `${SHOT}/${name}.png`;
};

console.log(`打开 ${BASE}（会话 ${CONV}）…`);
// 带令牌进页面，省掉每次输口令；拿不到就退回"走一遍登录"（那条路也要有人验）
if (TOKEN) {
  await page.addInitScript((t) => {
    try {
      // ⚠ shared_preferences 在 web 上是 **JSON 编码**存的（值带引号）。
      //   注入裸串读不出来 —— 实测踩过，页面会一直停在登录页。
      window.localStorage.setItem('flutter.hupo_auth_token', JSON.stringify(t));
    } catch (e) {}
  }, TOKEN);
}
await page.goto(`${BASE}/?conv=${CONV}`, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(7000);
// 服务开了鉴权：先登进去（顺便每次都在验证登录本身没坏）
if (!TOKEN) {
  const loggedIn = await ensureLoggedIn(page);
  if (loggedIn) console.log('（已登录）');
}
console.log('截图（加载后）:', await shot('01-loaded'));

// Flutter Web 的文字输入是一个**按需创建的隐藏 <input>**：点中输入条之前
// DOM 里根本没有它。所以先按坐标点（输入条在视口底部），再找那个 input。
const H = page.viewportSize().height;
const W = page.viewportSize().width;
async function focusInput() {
  const candidates = [
    [W * 0.35, H - 20], // 输入条：底部左侧（占位符「说点什么」）
    [W * 0.35, H - 40],
    [W * 0.35, H - 60],
  ];
  for (const [x, y] of candidates) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(700);
    const el = page.locator('input, textarea').first();
    if (await el.count()) {
      const editable = await el.evaluate((n) => !n.disabled && !n.readOnly).catch(() => false);
      if (editable) return true;
    }
  }
  return false;
}

const focused = await focusInput();
console.log(`输入框可聚焦：${focused}`);

await page.keyboard.type(TEXT, { delay: 30 });
await page.waitForTimeout(1000);
console.log('截图（输入后）:', await shot('02-typed'));

await page.keyboard.press('Enter');

let lastFrames = 0;
for (let i = 1; i <= Math.ceil(WAIT_MS / 2000); i++) {
  await page.waitForTimeout(2000);
  if (frames.length !== lastFrames) {
    lastFrames = frames.length;
    console.log(`[${i * 2}s] 收到 ${frames.length} 帧`);
  }
  if (i === 3) await shot('03-after3s');
  if (i === 8) await shot('08-after16s');
}
// 滚到底，确认最新几条真的画出来了（不靠"应该在下面"这种话）
await page.mouse.move(W / 2, H / 2);
await page.mouse.wheel(0, 6000);
await page.waitForTimeout(1200);
console.log('截图（滚到底）:', await shot('98-bottom'));
console.log('截图（结束）:', await shot('99-final'));

console.log('\n── 屏幕文件 ──');
console.log(`${SHOT}/01-loaded.png  02-typed.png  03-after3s.png  08-after16s.png  99-final.png`);

console.log('\n── 浏览器日志 ──');
for (const l of logs) console.log(l);

console.log('\n── WebSocket 帧 ──');
for (const f of frames) console.log(f);

writeFileSync(`${SHOT}/report.txt`, [...logs, '', ...frames].join('\n'));
await browser.close();
