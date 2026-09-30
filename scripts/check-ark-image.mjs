#!/usr/bin/env node
// **图片那条路的真读数探针**（火山方舟 · 种子梦 Seedream）。
//
// 为什么要有它：`src/image.js` 那条路**从来没在真上游跑过一次** ——
// 端点与模型名是从一份**第三方速查**抄来的，而第三方**不算权威**
// （`docs/dev/79-CREDS-TABS.md` §九 记着这笔账：要以"真跑一次的回话"为准）。
// 这个脚本就是那一次。它**只说事实**：上游回了什么状态码、什么 JSON、第一张图的地址
// （**钥匙一个字符都不打印、不落盘、不进日志**）。
//
// 用法：
//   ARK_API_KEY=<火山方舟的 API Key> node scripts/check-ark-image.mjs
//   ARK_API_KEY=... node scripts/check-ark-image.mjs --prompt "一只在窗台上的橘猫，水彩" --size 2K
//   ARK_API_KEY=... node scripts/check-ark-image.mjs --model doubao-seedream-4-0-250828
//
// ⚠️ **这一步要花钱**（一张图的钱）：所以默认**不跑**，必须显式带 `--spend`。
//    不带 `--spend` ⇒ 只打印"我会发什么"（干跑，一分钱不花）。
// ⚠️ 模型名与端点是**会过期的东西**：两边都能用 `--model` / `--url` 覆盖。

import nodeProcess from 'node:process';

const args = nodeProcess.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d = null) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const KEY = nodeProcess.env.ARK_API_KEY ?? nodeProcess.env.HUPO_IMAGE_KEY ?? '';
const URL_ = val('--url', nodeProcess.env.HUPO_IMAGE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3/images/generations');
const MODEL = val('--model', nodeProcess.env.HUPO_IMAGE_MODEL ?? 'doubao-seedream-4-0-250828');
const SIZE = val('--size', nodeProcess.env.HUPO_IMAGE_SIZE ?? '2K');
const PROMPT = val('--prompt', '一张测试图：暖色纸底上放着一枚琥珀色的圆点');
const SPEND = has('--spend');

if (!KEY) {
  console.error('✗ 没给钥匙：ARK_API_KEY=<火山方舟 API Key>（或 HUPO_IMAGE_KEY=…）');
  nodeProcess.exit(3);
}

const body = { model: MODEL, prompt: PROMPT, size: SIZE, response_format: 'url', watermark: false };

console.log('▶ 图片那条路（Seedream · 火山方舟）');
console.log(`  端点     ${URL_}`);
console.log(`  模型     ${MODEL}`);
console.log(`  尺寸     ${SIZE}`);
console.log(`  提示词   ${PROMPT.slice(0, 60)}${PROMPT.length > 60 ? '…' : ''}`);
console.log(`  钥匙     ${KEY.length} 个字符（**不打印内容**）`);
console.log(`  要发的正文 ${JSON.stringify(body)}`);

if (!SPEND) {
  console.log('\n⏸ 干跑：**没有发出去**（这一步要花你的钱）。要真跑就加 `--spend`。');
  nodeProcess.exit(0);
}

const t0 = Date.now();
let res;
let text = '';
try {
  res = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  text = await res.text();
} catch (err) {
  // ⚠️ 出错也要如实说；但**不许**把钥匙带进任何输出（它只可能在 header 里，够不着这里）
  console.error(`\n✗ 没连上：${String(err?.message ?? err).slice(0, 300)}`);
  nodeProcess.exit(2);
}

const ms = Date.now() - t0;
console.log(`\n◀ 上游回话：HTTP ${res.status} · ${ms}ms`);
console.log(`  原话（前 1200 字，**如实**，不去猜）：\n${text.slice(0, 1200)}`);

let j = null;
try {
  j = JSON.parse(text);
} catch {
  /* 不是 JSON 也照样打出来 */
}
const url = j?.data?.[0]?.url ?? j?.data?.[0]?.b64_json ?? null;
if (res.ok && typeof url === 'string' && url.startsWith('http')) {
  console.log(`\n✅ 成了：第一张图 ${url.slice(0, 120)}…`);
  console.log('   ⚠️ 这个地址**会过期**（火山那边按小时算）⇒ 要看就现在看。');
  nodeProcess.exit(0);
}
console.log('\n✗ 没成（或回话里没有图片地址）—— **上面那段原话就是事实**，按它改。');
nodeProcess.exit(1);
