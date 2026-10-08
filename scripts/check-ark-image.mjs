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
//   node scripts/check-ark-image.mjs                          # 干跑（不花钱、不用钥匙）
//   ARK_API_KEY=<火山方舟的 API Key> node scripts/check-ark-image.mjs --preflight
//                                                            # 🔴 **不花钱**的先手：用真钥匙发一条"模型名是编的"请求
//                                                            #    ⇒ 回话不是鉴权类 ⇒ 钥匙与路径都对（画不出东西 ⇒ 不花钱）
//   ARK_API_KEY=... node scripts/check-ark-image.mjs --spend   # 真画一张（花你的钱）
//   node scripts/check-ark-image.mjs --fake                    # 🔴 **假钥匙连真上游**（不花钱）：看鉴权那一层怎么回
//   ARK_API_KEY=... node scripts/check-ark-image.mjs --spend --prompt "一只在窗台上的橘猫，水彩" --size 2K
//
// ⚠️ **模型名与端点是会过期的东西**：两边都能用 `--model` / `--url` 覆盖。
// 🔴 **`--fake` 那一档能证什么、不能证什么**（实测，见下）：火山方舟的**鉴权在路由之前** ——
//    带上假钥匙时，**连一条根本不存在的路径也回 401**（不是 404）⇒
//    它只证"主机与鉴权那一层是活的"，**证不了路径对不对、模型名对不对**（那要真钥匙）。

import nodeProcess from 'node:process';

// 🔴 **鉴权那三句的规则住服务端那一份**（`src/ark-check.js` 的 `authClassOf()`）——
//    这里**只负责翻成给开发者看的话**。抄两遍正则 = 迟早有一处漂（2026-10-07 收的）。
import { PREFLIGHT_MODEL, authClassOf } from '../v2/services/core/src/ark-check.js';

const args = nodeProcess.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d = null) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

if (has('--help') || has('-h')) {
  console.log('用法：node scripts/check-ark-image.mjs [--fake] [--preflight] [--spend] [--prompt …] [--size 2K] [--model …] [--url …]');
  nodeProcess.exit(0);
}

const KEY = nodeProcess.env.ARK_API_KEY ?? nodeProcess.env.HUPO_IMAGE_KEY ?? '';
const URL_ = val('--url', nodeProcess.env.HUPO_IMAGE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3/images/generations');
const MODEL = val('--model', nodeProcess.env.HUPO_IMAGE_MODEL ?? 'doubao-seedream-4-0-250828');
const SIZE = val('--size', nodeProcess.env.HUPO_IMAGE_SIZE ?? '2K');
const PROMPT = val('--prompt', '一张测试图：暖色纸底上放着一枚琥珀色的圆点');
const SPEND = has('--spend');
const FAKE = has('--fake');
const PREFLIGHT = has('--preflight');

/** 假钥匙：**明摆着是假的**（形状也不对），且永不出现在真配置里。 */
const FAKE_KEY = 'hupo-probe-not-a-real-key';
/** 编出来的模型名：它**不可能**画出东西 ⇒ `--preflight` 不花钱。 */
const BOGUS_MODEL = PREFLIGHT_MODEL;

if (!KEY && !FAKE && (SPEND || PREFLIGHT)) {
  console.error('✗ 没给钥匙：ARK_API_KEY=<火山方舟 API Key>（或 HUPO_IMAGE_KEY=…）；只想看鉴权那一层怎么回 ⇒ 加 `--fake`');
  nodeProcess.exit(3);
}

/** 火山方舟那三种"还没到业务"的回话，翻成人话（**实测**，见 `79-CREDS-TABS.md` §九·补）。 */
/** 那三种"还没走到业务"的回话**翻成人话**（规则在 `src/ark-check.js`，这里只说给人听）。 */
const AUTH_WORDS = {
  missing: '**没带钥匙**（请求里没有 Authorization）',
  'bad-shape': '**钥匙形状不对**（实测：UUID 形状 8-4-4-4-12 它认；`sk-…` 和随机长串都判格式不对）',
  'not-exist': '**形状对、但这把钥匙不存在**（拼错/删了/不是这个账号的）',
};

function explainAuth(text) {
  const cls = authClassOf(text);
  return cls ? AUTH_WORDS[cls] : null;
}

const useKey = FAKE ? FAKE_KEY : KEY;
const useModel = PREFLIGHT ? BOGUS_MODEL : MODEL;
const body = { model: useModel, prompt: PROMPT, size: SIZE, response_format: 'url', watermark: false };

console.log('▶ 图片那条路（Seedream · 火山方舟）');
console.log(`  端点     ${URL_}`);
console.log(`  模型     ${useModel}${PREFLIGHT ? '  ← **编的**（这一档画不出东西 ⇒ 不花钱）' : ''}`);
console.log(`  尺寸     ${SIZE}`);
console.log(`  提示词   ${PROMPT.slice(0, 60)}${PROMPT.length > 60 ? '…' : ''}`);
console.log(`  钥匙     ${FAKE ? '**假钥匙（--fake）**' : KEY ? `${KEY.length} 个字符（**不打印内容**）` : '**没有**'}`);
console.log(`  要发的正文 ${JSON.stringify(body)}`);

if (!SPEND && !PREFLIGHT && !FAKE) {
  console.log('\n⏸ 干跑：**没有发出去**（这一步要花你的钱）。要真跑就加 `--spend`。');
  console.log('   不花钱又想知道"钥匙与路径对不对"：`--preflight`（拿真钥匙、模型名是编的）。');
  console.log('   没有钥匙也想看一眼鉴权那一层：`--fake`。');
  nodeProcess.exit(0);
}

const t0 = Date.now();
let res;
let text = '';
try {
  res = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${useKey}` },
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

/** 🔴 鉴权那三句是**有用的针**（谁贴错钥匙、错在哪一步，照它说）。 */
const why = explainAuth(text);
if (why && (FAKE || PREFLIGHT || !res.ok)) console.log(`\n  ⇒ 照原话看：${why}`);

const url = j?.data?.[0]?.url ?? j?.data?.[0]?.b64_json ?? null;
if (res.ok && typeof url === 'string' && url.startsWith('http')) {
  console.log(`\n✅ 成了：第一张图 ${url.slice(0, 120)}…`);
  console.log('   ⚠️ 这个地址**会过期**（火山那边按小时算）⇒ 要看就现在看。');
  nodeProcess.exit(0);
}
if (FAKE) {
  console.log('\n⇒ `--fake` 这一档到此为止：它只证"主机与鉴权那一层活着"。');
  console.log('   ⚠️ **路径对不对、模型名对不对，它证不了** —— 火山的鉴权在路由之前（连不存在的路径也回 401）。');
  nodeProcess.exit(0);
}
if (PREFLIGHT && why) {
  console.log('\n✗ 先手就卡在鉴权那一层 —— 上面那句就是原因（**没有花钱**：请求根本没走到业务）。');
  nodeProcess.exit(1);
}
if (PREFLIGHT && !res.ok) {
  console.log('\n✅ **先手过了**：回话**不是**鉴权类 ⇒ 钥匙与路径都对（模型名是编的 ⇒ 它当然画不出来；这一步没花钱）。');
  console.log('   ⇒ 这时候再 `--spend` 画真的一张。');
  nodeProcess.exit(0);
}
console.log('\n✗ 没成（或回话里没有图片地址）—— **上面那段原话就是事实**，按它改。');
nodeProcess.exit(1);
