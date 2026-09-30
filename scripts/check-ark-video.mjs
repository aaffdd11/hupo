#!/usr/bin/env node
// **视频那条路的真读数探针**（火山方舟 · Seedance）。
//
// 这一条**今天还不存在**（`src/` 里没有视频生成），所以这个脚本先干一件事：
// **用真钥匙把上游问一遍**，把"创建任务 → 查任务"这**两个真回话**记下来 ——
// 之后写 `src/video.js` 就以那两次回话为准（不照第三方文档猜字段）。
//
// 用法：
//   ARK_API_KEY=<火山方舟的 API Key> node scripts/check-ark-video.mjs            # 干跑（不花钱）
//   ARK_API_KEY=... node scripts/check-ark-video.mjs --spend                     # 真提交一条 5 秒的任务
//   ARK_API_KEY=... node scripts/check-ark-video.mjs --spend --prompt "……" --ratio 16:9 --duration 5
//   ARK_API_KEY=... node scripts/check-ark-video.mjs --poll cgt-xxxx             # 只查某一条（不花钱）
//
// ⚠️ **视频比图片贵得多**：所以默认**不跑**；要真跑必须显式 `--spend`（它会花你的钱）。
// 🔴 **钥匙一个字符都不打印、不落盘、不进日志。**
// ⚠️ 任务 id 只留 7 天；出来的视频地址有效期 24 小时（上游这么说）。

import nodeProcess from 'node:process';

const args = nodeProcess.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d = null) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const KEY = nodeProcess.env.ARK_API_KEY ?? nodeProcess.env.HUPO_VIDEO_KEY ?? '';
const BASE = val('--base', nodeProcess.env.HUPO_VIDEO_BASE ?? 'https://ark.cn-beijing.volces.com/api/v3');
const MODEL = val('--model', nodeProcess.env.HUPO_VIDEO_MODEL ?? 'doubao-seedance-1-0-pro-250528');
const PROMPT = val('--prompt', '一只橘猫从窗台上跳下来，慢动作，阳光');
const RATIO = val('--ratio', '16:9');
const DURATION = val('--duration', '5');
const POLL_ID = val('--poll', '');
const SPEND = has('--spend');
const POLL_TIMES = Number.parseInt(val('--poll-times', '6'), 10);
const POLL_GAP_MS = Number.parseInt(val('--poll-gap-ms', '10000'), 10);

if (!KEY) {
  console.error('✗ 没给钥匙：ARK_API_KEY=<火山方舟 API Key>（或 HUPO_VIDEO_KEY=…）');
  nodeProcess.exit(3);
}

const createUrl = `${BASE}/contents/generations/tasks`;
// ⚠️ **参数走正文里的文本后缀**（火山那套：`--ratio` / `--duration` / `--watermark`…）——
//    这条路**没有在真上游验过**，所以这里把它原样打出来，跑完以**真回话**为准。
const params = ` --ratio ${RATIO} --duration ${DURATION} --watermark false`;
const body = { model: MODEL, content: [{ type: 'text', text: `${PROMPT}${params}` }] };

async function callJson(url, init) {
  const t0 = Date.now();
  const res = await fetch(url, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(120_000) });
  const text = await res.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {
    /* 不是 JSON 也照样打出来 */
  }
  return { status: res.status, ms: Date.now() - t0, text, json: j };
}

console.log('▶ 视频那条路（Seedance · 火山方舟）');
console.log(`  创建     POST ${createUrl}`);
console.log(`  查询     GET  ${BASE}/contents/generations/tasks/{id}`);
console.log(`  模型     ${MODEL}`);
console.log(`  钥匙     ${KEY.length} 个字符（**不打印内容**）`);

if (POLL_ID) {
  const r = await callJson(`${BASE}/contents/generations/tasks/${POLL_ID}`, { method: 'GET' });
  console.log(`\n◀ 查任务回话：HTTP ${r.status} · ${r.ms}ms\n${r.text.slice(0, 1500)}`);
  nodeProcess.exit(r.status === 200 ? 0 : 1);
}

console.log(`  要发的正文 ${JSON.stringify(body)}`);

if (!SPEND) {
  console.log('\n⏸ 干跑：**没有提交**（视频很贵）。要真提交就加 `--spend`。');
  console.log('   （只想看某一条的状态：`--poll cgt-…`，那一步不花钱）');
  nodeProcess.exit(0);
}

const made = await callJson(createUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
console.log(`\n◀ 创建任务回话：HTTP ${made.status} · ${made.ms}ms`);
console.log(`  原话（前 1500 字，**如实**）：\n${made.text.slice(0, 1500)}`);

const id = made.json?.id;
if (!id) {
  console.log('\n✗ 没拿到任务 id —— 上面那段原话就是事实（字段名/模型名/权限按它改）。');
  nodeProcess.exit(1);
}
console.log(`\n✅ 拿到任务 id：${id}（**只留 7 天**）`);

for (let i = 0; i < POLL_TIMES; i += 1) {
  if (i > 0) await new Promise((r) => setTimeout(r, POLL_GAP_MS));
  const q = await callJson(`${BASE}/contents/generations/tasks/${id}`, { method: 'GET' });
  const st = q.json?.status ?? '（没有 status 字段）';
  console.log(`\n  [${i + 1}/${POLL_TIMES}] HTTP ${q.status} · status=${st}`);
  if (i === 0) console.log(`     原话（前 900 字）：\n${q.text.slice(0, 900)}`);
  if (st === 'succeeded') {
    const v = q.json?.content?.video_url;
    console.log(`\n✅ 视频好了：${String(v).slice(0, 140)}`);
    console.log('  ⚠️ 这个地址**24 小时**过期 ⇒ 要看就现在看（要留下就得转存）。');
    nodeProcess.exit(0);
  }
  if (st === 'failed' || st === 'cancelled' || st === 'expired') {
    console.log(`\n✗ 任务 ${st}：${JSON.stringify(q.json?.error ?? {})}`);
    nodeProcess.exit(1);
  }
}
console.log(`\n⏳ 还在跑（查了 ${POLL_TIMES} 次）—— 用 \`--poll ${id}\` 接着看。`);
nodeProcess.exit(0);
