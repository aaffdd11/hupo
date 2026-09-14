// 自动刷新机制的端到端验证：**真浏览器**，看页面会不会自己刷。
//
// 验的是这条链路：
//   部署脚本写 client-build.json → 服务端侦测到变了 → 推 client/reload
//   → 客户端在"手上没有没说完的话"时刷新自己
//
// 判据不是"事件发出去了"，而是**浏览器真的重新加载了一次页面**：
// 页面重载会重连 WebSocket，所以数一下 `ws open` 出现几次。
//
// 用法：node reload-probe.mjs

import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const PW = process.env.PLAYWRIGHT_PATH || '/home/deploy/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright';
const { chromium } = require(PW);

const BASE = process.env.BASE || 'https://hupo.stalkerai.cn';
const BUILD_FILE = process.env.BUILD_FILE || '/var/www/hupo/client-build.json';
const CHROME = process.env.CHROME_PATH
  || '/home/deploy/.cache/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell';

const original = fs.readFileSync(BUILD_FILE, 'utf8');
const originalId = JSON.parse(original).buildId;
console.log(`当前构建指纹：${originalId}`);

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 420, height: 860 } });

let wsOpens = 0;
let reloads = 0;
page.on('websocket', () => {
  wsOpens += 1;
  console.log(`[ws] 第 ${wsOpens} 次连接`);
});
page.on('framenavigated', (f) => {
  if (f === page.mainFrame()) {
    console.log(`[nav] 页面导航到 ${f.url()}`);
  }
});

console.log('打开页面…');
await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(8000);
console.log(`加载完成：ws 连接 ${wsOpens} 次`);

// ── 模拟一次"部署了新版本" ────────────────────────────────
const fakeId = `probe-${Date.now().toString(36)}`;
console.log(`\n把 client-build.json 改成 ${fakeId}（模拟部署）…`);
fs.writeFileSync(BUILD_FILE, JSON.stringify({ buildId: fakeId, builtAt: new Date().toISOString() }));

let reloaded = false;
for (let i = 1; i <= 10; i++) {
  await page.waitForTimeout(2000);
  console.log(`  [${i * 2}s] ws 连接次数 = ${wsOpens}`);
  if (wsOpens >= 2) {
    reloaded = true;
    break;
  }
}

console.log('\n── 结论 ①：服务端发令 → 页面自己刷新 ──');
console.log(reloaded ? '✅ 页面自己刷新了' : '✗ 页面没有刷新 —— 机制没生效');

// ── 护栏：**不还原指纹**，看它会不会一直刷 ────────────────
// 这一步才是护栏的真正判据。如果护栏坏了，页面会每 5 秒刷一次（服务端轮询间隔）。
const before = wsOpens;
console.log(`\n盯着 ${fakeId} 不变，观察 20s 会不会反复刷…`);
await page.waitForTimeout(20000);
const after = wsOpens;
console.log('\n── 结论 ②：护栏（同一个指纹只刷一次）──');
console.log(wsOpens === before
  ? `✅ 没有反复刷（仍是 ${after} 次）—— 护栏生效`
  : `✗ 又刷了 ${after - before} 次 —— 会陷入无限刷新`);

// ── 还原 ─────────────────────────────────────────────────
fs.writeFileSync(BUILD_FILE, original);
console.log(`\n已还原指纹为 ${originalId}（这会让页面再刷一次，属正常）`);

await browser.close();
process.exit(reloaded && after === before ? 0 : 1);
