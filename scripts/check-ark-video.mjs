#!/usr/bin/env node
// **视频那条路的真读数探针**（火山方舟 · Seedance）。
//
// 它干的是一件很具体的事：把"创建任务 → 查任务"这**两个真回话**记下来 ——
// `src/video.js` 就以那两次回话为准（不照第三方文档猜字段）。
//
// 用法：
//   node scripts/check-ark-video.mjs                       # 干跑（不花钱、不用钥匙）
//   ARK_API_KEY=<火山方舟的 API Key> node scripts/check-ark-video.mjs --preflight
//                                                          # 🔴 **不花钱**的先手：模型名是编的 ⇒ 画不出东西；
//                                                          #    回话不是鉴权类 ⇒ 钥匙与两条路径都对
//   ARK_API_KEY=... node scripts/check-ark-video.mjs --spend             # 真提交一条 5 秒的任务（花钱）
//   ARK_API_KEY=... node scripts/check-ark-video.mjs --poll cgt-xxxx     # 只查某一条（不花钱）
//   node scripts/check-ark-video.mjs --fake                              # 🔴 假钥匙连真上游（不花钱）
//
// ⚠️ **视频比图片贵得多**：要真跑必须显式 `--spend`。
// 🔴 **钥匙一个字符都不打印、不落盘、不进日志。**
// ⚠️ 任务 id 只留 7 天；出来的视频地址有效期 24 小时（上游这么说）。
// 🔴 **`--fake` 那一档能证什么、不能证什么**：火山的**鉴权在路由之前** ——
//    带假钥匙时**连不存在的路径也回 401** ⇒ 它只证"主机与鉴权那一层活着"，
//    **证不了路径与模型名**（那要真钥匙，或者 `--preflight` 那一次）。

import nodeProcess from 'node:process';

const args = nodeProcess.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d = null) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

if (has('--help') || has('-h')) {
  console.log('用法：node scripts/check-ark-video.mjs [--fake] [--preflight] [--spend] [--poll <id>] [--prompt …] [--ratio 16:9] [--duration 5] [--model …] [--base …]');
  nodeProcess.exit(0);
}

const KEY = nodeProcess.env.ARK_API_KEY ?? nodeProcess.env.HUPO_VIDEO_KEY ?? '';
const BASE = val('--base', nodeProcess.env.HUPO_VIDEO_BASE ?? 'https://ark.cn-beijing.volces.com/api/v3');
const MODEL = val('--model', nodeProcess.env.HUPO_VIDEO_MODEL ?? 'doubao-seedance-1-0-pro-250528');
const PROMPT = val('--prompt', '一只橘猫从窗台上跳下来，慢动作，阳光');
const RATIO = val('--ratio', '16:9');
const DURATION = val('--duration', '5');
const POLL_ID = val('--poll', '');
const SPEND = has('--spend');
const FAKE = has('--fake');
const PREFLIGHT = has('--preflight');
const POLL_TIMES = Number.parseInt(val('--poll-times', '6'), 10);
const POLL_GAP_MS = Number.parseInt(val('--poll-gap-ms', '10000'), 10);

/** 假钥匙：**明摆着是假的**（形状也不对），且永不出现在真配置里。 */
const FAKE_KEY = 'hupo-probe-not-a-real-key';
/** 编出来的模型名与任务号：**都不可能**真做出东西 ⇒ `--preflight` 不花钱。 */
const BOGUS_MODEL = 'hupo-preflight-definitely-not-a-real-model';
const BOGUS_TASK = 'hupo-preflight-no-such-task';

if (!KEY && !FAKE && (SPEND || PREFLIGHT || POLL_ID)) {
  console.error('✗ 没给钥匙：ARK_API_KEY=<火山方舟 API Key>（或 HUPO_VIDEO_KEY=…）；只想看鉴权那一层怎么回 ⇒ `--fake`');
  nodeProcess.exit(3);
}

/** 火山方舟那三种"还没走到业务"的回话，翻成人话（**实测**，见 `79-CREDS-TABS.md` §九·补）。 */
function explainAuth(text) {
  const t = String(text);
  if (/API key or AK\/SK in the request is missing or invalid/i.test(t)) return '**没带钥匙**（请求里没有 Authorization）';
  if (/API key format is incorrect/i.test(t)) return '**钥匙形状不对**（实测：UUID 形状 8-4-4-4-12 它认；`sk-…` 和随机长串都判格式不对）';
  if (/API key doesn[’\']?t exist/i.test(t)) return '**形状对、但这把钥匙不存在**（拼错/删了/不是这个账号的）';
  return null;
}

const useKey = FAKE ? FAKE_KEY : KEY;
const useModel = PREFLIGHT ? BOGUS_MODEL : MODEL;
const createUrl = `${BASE}/contents/generations/tasks`;
const taskUrl = (id) => `${BASE}/contents/generations/tasks/${id}`;
// ⚠️ **参数走正文里的文本后缀**（火山那套：`--ratio` / `--duration` / `--watermark`…）——
//    这条路**没有在真上游验过**，所以这里把它原样打出来，跑完以**真回话**为准。
const params = ` --ratio ${RATIO} --duration ${DURATION} --watermark false`;
const body = { model: useModel, content: [{ type: 'text', text: `${PROMPT}${params}` }] };

async function callJson(url, init) {
  const t0 = Date.now();
  const res = await fetch(url, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${useKey}` }, signal: AbortSignal.timeout(120_000) });
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
console.log(`  查询     GET  ${taskUrl('{id}')}`);
console.log(`  模型     ${useModel}${PREFLIGHT ? '  ← **编的**（画不出东西 ⇒ 不花钱）' : ''}`);
console.log(`  钥匙     ${FAKE ? '**假钥匙（--fake）**' : KEY ? `${KEY.length} 个字符（**不打印内容**）` : '**没有**'}`);

if (POLL_ID) {
  const r = await callJson(taskUrl(POLL_ID), { method: 'GET' });
  console.log(`\n◀ 查任务回话：HTTP ${r.status} · ${r.ms}ms\n${r.text.slice(0, 1500)}`);
  const why = explainAuth(r.text);
  if (why) console.log(`\n  ⇒ 照原话看：${why}`);
  nodeProcess.exit(r.status === 200 ? 0 : 1);
}

// ── `--preflight`：**不花钱**地把"钥匙 ＋ 两条路径"问清楚 ──────────────────
//    ① 创建：模型名是编的 ⇒ 它**不可能**做出东西（业务层会拒）
//    ② 查询：任务号是编的 ⇒ 它**不可能**查到东西
//    两边的回话**只要不是鉴权类**，就说明"钥匙对 ＋ 路径对"。
if (PREFLIGHT) {
  console.log(`  要发的正文 ${JSON.stringify(body)}`);
  console.log('\n▶ 先手（**不花钱**）：两条路径各发一次"注定做不出东西"的请求');
  const mk = await callJson(createUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  console.log(`\n  ① 创建 ${createUrl}\n     HTTP ${mk.status} · ${mk.ms}ms\n     ${mk.text.slice(0, 400)}`);
  const whyMk = explainAuth(mk.text);
  if (whyMk) console.log(`     ⇒ ${whyMk}`);
  const q = await callJson(taskUrl(BOGUS_TASK), { method: 'GET' });
  console.log(`\n  ② 查询 ${taskUrl(BOGUS_TASK)}\n     HTTP ${q.status} · ${q.ms}ms\n     ${q.text.slice(0, 400)}`);
  const whyQ = explainAuth(q.text);
  if (whyQ) console.log(`     ⇒ ${whyQ}`);
  if (whyMk || whyQ) {
    console.log('\n✗ 先手卡在鉴权那一层（**没有花钱**：请求根本没走到业务）⇒ 按上面那句改。');
    nodeProcess.exit(1);
  }
  console.log('\n✅ **先手过了**：两条路径的回话都不是鉴权类 ⇒ 钥匙对 ＋ 两条路径对。');
  console.log('   ⚠️ 模型名与那几个参数后缀**仍然没验**（先手这两次都没走到业务）—— 那要 `--spend` 那一次。');
  nodeProcess.exit(0);
}

console.log(`  要发的正文 ${JSON.stringify(body)}`);

// 🔴 `--fake` 排在干跑**前面**：它就是"真发一次、但用假钥匙"（不花钱），
//    别被"没说 --spend"那句拦住（拦了就等于这一档永远跑不到）。
if (FAKE) {
  const r = await callJson(createUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  console.log(`\n◀ 创建任务回话（**假钥匙**）：HTTP ${r.status} · ${r.ms}ms\n${r.text.slice(0, 800)}`);
  const why = explainAuth(r.text);
  if (why) console.log(`\n  ⇒ 照原话看：${why}`);
  console.log('\n⇒ `--fake` 到此为止：只证"主机与鉴权那一层活着"（**路径与模型名证不了**）。');
  nodeProcess.exit(0);
}

if (!SPEND) {
  console.log('\n⏸ 干跑：**没有提交**（视频很贵）。要真提交就加 `--spend`。');
  console.log('   不花钱又想验"钥匙与路径"：`--preflight`（模型名是编的 ⇒ 画不出东西）。');
  console.log('   只想看某一条的状态：`--poll cgt-…`（那一步不花钱）。没有钥匙：`--fake`。');
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
  const why = explainAuth(made.text);
  if (why) console.log(`\n  ⇒ 照原话看：${why}`);
  console.log('\n✗ 没拿到任务 id —— 上面那段原话就是事实（字段名/模型名/权限按它改）。');
  nodeProcess.exit(1);
}
console.log(`\n✅ 拿到任务 id：${id}（**只留 7 天**）`);

for (let i = 0; i < POLL_TIMES; i += 1) {
  if (i > 0) await new Promise((r) => setTimeout(r, POLL_GAP_MS));
  const q = await callJson(taskUrl(id), { method: 'GET' });
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
