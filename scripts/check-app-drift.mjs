#!/usr/bin/env node
// **「小程序 / app / 应用」= 他桌面上那个图标 —— 真行为检查（不漂）。**
//
// 判据一（`test/app-drift.test.js`）查的是**字**：钉子在不在。
// 这一份查的是**真图**：对**活系统**跑一轮真的，看它到底走哪条路。
//
// ── 它要一台**部署好的**系统 ───────────────────────────────────
// 人格与工具说明是**产品层**，改完要重启才生效 ⇒ **部署前跑，它可能红**。
// 那时它**照实说**（是哪种红：没走我们这条路 / 说了漂移词 / 反问你平台），
// **绝不为了让读数好看而放宽**。
//
// ── 它做什么（一轮真的）─────────────────────────────────────────
//   ① 连 `/api/stream`（子协议 `['bearer', <令牌>]`，照 `scripts/check-harness.mjs` 的写法）。
//      ⚠️ `sinceSeq` 故意给一个**比 maxSeq 大**的数 ⇒ 服务端回 `client/reset`、
//         **不补发历史** —— 我们只要**这一轮**的流（历史里别人说过的话不算数）。
//   ② 走 `/api/say` 发一句**像主人会说的话**（默认：帮我做一个小程序：一个丢骰子的小页面）。
//   ③ 收这一轮的流，然后判三件事：
//      · ✅ 走的是**我们这条路**：`app_create` 被调了（流上能看到的最接近形状是
//        `task/mutated` —— 见下面「一处实话」），**或者**它明确说给他桌面做了一个页面；
//      · 🔴 **没有漂移词**：微信 / AppID / AppSecret / 小程序开发者工具 / 上架 /
//        签名证书 / 包名 / APK / IPA / TestFlight / 备案；
//        （`域名` 只在**问他要**的那种语境里才算漂 —— 见 `DOMAIN_ASK`。）
//      · 🔴 **没有反问他"你要哪个平台 / 微信还是 app"**（那是漂的前兆）。
//      红的时候**打印是哪一句、是哪个词**触发的 —— 不只说"没过"。
//
// ── 一处实话（为什么工具名看不见）───────────────────────────────
// `/api/stream` 是**时间线**那条路，事件里**没有工具名、没有参数**
// （实测 —— 工具名只在 `/api/harness` 的 raw 事件 `tool/call.data.name` 上；
//  而 `/api/harness` 经 nginx 那条口今天不一定通，见 `check-harness.mjs` 里那段）。
// ⇒ 这一份**不假装**自己看见了 `app_create`：它报的是流上真有的两个信号
//   （`task/mutated` = 这一轮动过东西；以及它说的话），并把这一点写在读数里。
//   想看工具名那一层，那是另一条口、另一份检查的事。
//
// ── 纪律 ───────────────────────────────────────────────────────
// 🔴 **不打印密钥 / 令牌**（令牌只进子协议与 Authorization 头，输出里一律 `<令牌>`）。
// 🔴 **不写任何文件**（这一份连 `node:fs` 都不 import）。
// 🔴 发一句真的 = **动用那个号的模型额度**（用得很少，一次一轮）。
//
// 退出码：0 全通 · 2 有判据没通 · 3 环境不具备（没令牌 / 连不上这台机器 / 发不出去）

import nodeProcess from 'node:process';

import WebSocket from '../v2/services/core/node_modules/ws/index.js';

const argv = nodeProcess.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const valueOf = (f, dflt = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const URL_ = valueOf('--url', 'https://w.stalkerai.cn/');
const WAIT_MS = Number.parseInt(valueOf('--wait', '180000'), 10);
/** 收口之后再等这么久没有新事件，就当这一轮说完了（免得把下一轮的话算进来）。 */
const QUIET_MS = Number.parseInt(valueOf('--quiet', '5000'), 10);
/** 像主人会说的那一句。 */
const TEXT = valueOf('--text', '帮我做一个小程序：一个丢骰子的小页面');
const TOKEN = nodeProcess.env.HUPO_TOKEN ?? null;

/** 🔴 令牌**一个字都不许进输出**。 */
const SECRETS = [TOKEN].filter((s) => typeof s === 'string' && s.length >= 8);
const scrub = (s) => {
  let out = String(s ?? '');
  for (const secret of SECRETS) out = out.split(secret).join('<令牌>');
  return out;
};
const say = (s = '') => console.log(scrub(s));

const results = [];
const record = (ok, label, detail = '') => {
  results.push({ ok, label });
  say(`${ok === true ? '✅' : ok === false ? '❌' : '⚠️'} ${label}${detail ? ` —— ${detail}` : ''}`);
};

if (hasFlag('--help') || hasFlag('-h')) {
  say(`「小程序 / app / 应用」= 桌面上那个图标 —— 活系统检查（真跑一轮，看不漂）。

用法：
  HUPO_TOKEN=<有容器的号的令牌> node scripts/check-app-drift.mjs [选项]

选项：
  --url <地址>     主 origin（默认 ${URL_}）
  --wait <毫秒>    等这一轮收口的上限（默认 ${WAIT_MS}）
  --quiet <毫秒>   收口后再等多久没新事件就算说完（默认 ${QUIET_MS}）
  --text <话>      要发的那一句（默认：${TEXT}）
  --self-test      **不联网、不花额度**：只验"漂移词 / 反问平台"这两条**红路真的会红**
  --help           这一屏

退出码：0 全通 · 2 有判据没通 · 3 环境不具备（没令牌 / 连不上 / 发不出去）`);
  nodeProcess.exit(0);
}

// ── 地址与等待 ─────────────────────────────────────────────────
// ⚠️ 令牌那两道闸**不在这里** —— 它们在 `--self-test` 之后（自检不联网、不要令牌）。

const wsUrlOf = (base, path) => {
  const u = new URL(base);
  return `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}${path}`;
};
const sayUrl = new URL('/api/say', URL_).toString();
const appsUrl = new URL('/api/apps', URL_).toString();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    const hit = fn();
    if (hit) return hit;
    if (Date.now() - t0 > ms) return null;
    await sleep(60);
  }
}

/** 连一次；`msgs` 是**活的**数组（连上之后还继续往里push）。 */
function connect(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, ['bearer', TOKEN]);
    const msgs = [];
    ws.on('message', (d) => {
      try {
        msgs.push(JSON.parse(String(d)));
      } catch {
        /* 这条线只有 JSON；认不出的不管 */
      }
    });
    const done = (v) => {
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* 已经没了 */
      }
      resolve({ ok: false, status: null, error: '握手超时' });
    }, 15000);
    ws.on('open', () => done({ ok: true, ws, msgs }));
    ws.on('unexpected-response', (_q, res) => {
      res.resume();
      done({ ok: false, status: res.statusCode, error: null });
    });
    ws.on('error', (err) => done({ ok: false, status: null, error: String(err?.message ?? err) }));
  });
}

/** 被拒时那句人话（**哪一段断了**）。 */
function whyRejected(status, error) {
  if (error) return `连不上（${error}）—— 这台机器 / 这条隧道那段断了`;
  if (status === 401) return '令牌不通（过期 / 被撤 / 不是这一台签的）';
  if (status === 404) return '这条口没有服务（路径不对 / 前面那层没转发 WebSocket）';
  if (status === 503) return '这台还没准备好（没设口令 / 空间还在准备 / 隧道没通）';
  return `被拒（HTTP ${status}）`;
}

/** 收口之后再等一会儿，直到**没有新事件**（把这一轮的话收全，不把下一轮算进来）。 */
async function waitQuiet(msgs, quietMs, capMs) {
  const t0 = Date.now();
  let last = msgs.length;
  let lastAt = Date.now();
  for (;;) {
    await sleep(100);
    if (msgs.length !== last) {
      last = msgs.length;
      lastAt = Date.now();
    }
    if (Date.now() - lastAt >= quietMs) return true;
    if (Date.now() - t0 >= capMs) return false;
  }
}

/** 助手**说出口的话**（只取 message/text —— 推理原文不在这条档上，也不该看它）。 */
const assistantTextOf = (msgs) =>
  msgs
    .filter((m) => m?.type === 'message/text')
    .map((m) => String(m.text ?? ''))
    .join('');

/** 切成句（打印"是哪一句"用）。 */
const sentencesOf = (t) => t.split(/(?<=[。！？!?\n])/u).map((s) => s.trim()).filter(Boolean);

// ── 判据用的词表 ───────────────────────────────────────────────

/**
 * 🔴 漂移词。命中**任意一个**就算漂 —— 这一条**故意严**：
//  主人没说"微信"，一个没漂的助手**根本没有理由**提起它。
 */
const BANNED = [
  { w: '微信', re: /微信/ },
  { w: '支付宝', re: /支付宝/, note: '和"微信"同一类漂（人格里点名的是"微信/支付宝那种小程序"）' },
  { w: 'AppID', re: /appid/i },
  { w: 'AppSecret', re: /appsecret|app_secret/i },
  { w: '小程序开发者工具', re: /小程序开发者工具|开发者工具/ },
  { w: '上架', re: /上架/ },
  { w: '签名证书', re: /签名证书/ },
  { w: '包名', re: /包名/ },
  { w: 'APK', re: /\bapk\b/i },
  { w: 'IPA', re: /\bipa\b/i },
  { w: 'TestFlight', re: /testflight/i },
  { w: '备案', re: /备案/ },
];

/**
 * `域名` / `服务器` 单独一档：它们**出现在"问他要"的语境里**才算漂。
 * （说"不用担心域名和服务器，我做的是你桌面上的页面"不算 —— 那是把话讲清楚。）
 */
const ASK_CONTEXT = /(要|问|填|提供|绑定|你有|需要|申请|给我|发我|告诉我)/;
const CONDITIONAL = [
  { w: '域名', re: /域名/ },
  { w: '服务器', re: /服务器/ },
];

/**
 * 🔴 "反问他平台"的几种形状。**只在问句上判** ——
 * 因为人格里**正确**的说法本身就会提"哪种平台"（"没有'哪种平台'这回事"），
 * 把那句一刀切掉 = 把对的判成错的。
 */
const PLATFORM_ASKS = [
  { why: '问他"要哪个/哪种平台"', re: /(哪个|哪种|哪一种|什么)\s*平台/ },
  { why: '问他"平台"（问句）', re: /平台/ },
  { why: '问"微信还是 app / 应用 / 原生"', re: /微信[^。！？!?\n]{0,10}(还是|或者)[^。！？!?\n]{0,10}(app|应用|原生)/i },
  { why: '问"app / 应用 / 原生还是微信"', re: /(app|应用|原生)[^。！？!?\n]{0,10}(还是|或者)[^。！？!?\n]{0,10}微信/i },
  { why: '问"你要哪种东西"（平台 / 微信 / app…）', re: /(你要|你想|需要|选)[^。！？!?\n]{0,8}(平台|微信|app|应用|原生)/i },
];
const isQuestion = (s) => /[?？]/.test(s) || /(吗|呢)/.test(s);

/** 命中哪些漂移词（**带上"是哪一句"** —— 红的时候要能一眼看见根）。 */
export function findDrift(text) {
  const hits = [];
  for (const s of sentencesOf(text)) {
    for (const b of BANNED) {
      if (b.re.test(s)) hits.push({ word: b.w, sentence: s, note: b.note ?? '' });
    }
    if (CONDITIONAL.some((c) => c.re.test(s)) && ASK_CONTEXT.test(s)) {
      for (const c of CONDITIONAL) {
        if (c.re.test(s)) hits.push({ word: c.w, sentence: s, note: '出现在"问他要"的语境里' });
      }
    }
  }
  return hits;
}

/** 反问他"要哪个平台"的几种形状（**只在问句上判** —— 见上面那段）。 */
export function findPlatformAsks(text) {
  const hits = [];
  for (const s of sentencesOf(text)) {
    if (!isQuestion(s)) continue;
    for (const p of PLATFORM_ASKS) {
      if (p.re.test(s)) {
        hits.push({ why: p.why, sentence: s });
        break;
      }
    }
  }
  return hits;
}

/** 走我们这条路：他桌面上多了一个页面（流上能看到的说法）。 */
const SAYS_MADE_DESKTOP =
  /(做好了|做完了|造好了|做成了|建好了|放好了|给你做了|帮你做了|它现在在[^。！？!?\n]{0,6}桌面|在你[^。！？!?\n]{0,6}桌面|桌面上[^。！？!?\n]{0,6}(能|可以|点开)|点开就能用)/;

/**
 * 第①条判据的判定（**单独抽出来** —— 好让 `--self-test` 能离线钉住它）。
 *
 * ⚠️ `task/mutated` **不是** `app_create` 的证据：MCP 那几个工具都不在只读白名单里，
 *    所以连"看一眼桌上有什么"（`app_list`）都会记成 mutated（实测）。
 *    ⇒ 它只配**配着"桌面"一起**当弱证据，不能单独过关。
 *
 * @param {{text: string, mutated?: number, newApps?: string[]|null}} o
 */
export function routeVerdict({ text, mutated = 0, newApps = null }) {
  const mentionsDesktop = /桌面/.test(text ?? '');
  const saysMade = SAYS_MADE_DESKTOP.test(text ?? '');
  const fromList = Array.isArray(newApps) && newApps.length > 0;
  return { ok: fromList || saysMade || (mentionsDesktop && mutated > 0), mentionsDesktop, saysMade, fromList };
}

// ── `--self-test`：**不联网、不花额度**，只验"红的那条路真的会红" ──
// ⚠️ 为什么要有它：上面那张词表要是写坏了（正则失效 / 拼错），
//    真跑一轮时**它会绿灯** —— 而那种绿灯看起来和"没漂"一模一样。
//    这是本仓库反复栽的形状（判据失效 = 静默降级），所以红路要能单独验。
if (hasFlag('--self-test')) {
  const cases = [
    { name: '好句子（桌面上做好了）', text: '做好了，它叫「丢骰子」，已经在你桌面上，点开就能用。', drift: 0, ask: 0, route: true },
    {
      name: '人格里那句**正确**的否定（提了"哪种平台"但不是在问）',
      text: '没有"哪种平台"这回事，只有你的桌面。我做的是你桌面上那个。',
      drift: 0,
      ask: 0,
      // ⚠️ 这一条只验前两条（"不漂"）；它没在说"做好了"，所以路①不算数。
      route: false,
    },
    { name: '漂到微信', text: '做微信小程序要先注册 AppID，你申请一个吧。', drift: 2, ask: 0, route: false },
    { name: '漂到原生', text: '这个得打包成 APK，还要准备好签名证书和包名。', drift: 3, ask: 0, route: false },
    { name: '漂到网站', text: '你有域名吗？我要绑定一下服务器，还得备案。', drift: 3, ask: 0, route: false },
    {
      name: '反问他"微信还是 app"（⚠️ 这一个同时踩两条：微信本身就是漂移词）',
      text: '你要做微信里的，还是手机上能装的那种 app？',
      drift: 1,
      ask: 1,
      route: false,
    },
    { name: '反问他哪个平台', text: '你想在哪个平台上用呢？', drift: 0, ask: 1, route: false },
    {
      name: '域名只是把话讲清楚（不算漂）',
      text: '不用管域名和服务器，我做的是你桌面上的页面。',
      drift: 0,
      ask: 0,
      // ⚠️ 同上：没在说"做好了"，路①不算数。
      route: false,
    },
    // —— 第①条的几种形状（**mutated 不能单独过关**）——
    { name: '路①：只说了"做好了…点开就能用"（没提"桌面"也算）', text: '做好了，它叫「丢骰子」，点开就能用。', drift: 0, ask: 0, route: true, mutated: 0, newApps: null },
    { name: '路①：它已经在你桌面上（上一轮做的）', text: '它现在在你的桌面上，第 1 版。', drift: 0, ask: 0, route: true, mutated: 0, newApps: null },
    { name: '路①：桌面清单真的多了一个（最强的那条）', text: '好了，你点开看看。', drift: 0, ask: 0, route: true, mutated: 0, newApps: ['dice'] },
    { name: '路①：只是列了一遍桌上的东西（mutated=1 不算数）', text: '我看了一眼，你手上现在没有小程序。', drift: 0, ask: 0, route: false, mutated: 1, newApps: null },
    { name: '路①：说了"桌面"但什么都没做', text: '你桌面上那些都在。', drift: 0, ask: 0, route: false, mutated: 0, newApps: null },
  ];
  let bad = 0;
  for (const c of cases) {
    const d = findDrift(c.text);
    const a = findPlatformAsks(c.text);
    const r = routeVerdict({ text: c.text, mutated: c.mutated ?? 0, newApps: c.newApps ?? null });
    const ok = d.length === c.drift && a.length === c.ask && r.ok === c.route;
    if (!ok) bad += 1;
    say(`${ok ? '✅' : '❌'} ${c.name}`);
    say(`     漂移词 ${d.length}（要 ${c.drift}）｜ 反问平台 ${a.length}（要 ${c.ask}）｜ 走我们这条路 ${r.ok}（要 ${c.route}）`);
    if (!ok || d.length > 0) {
      for (const h of d) say(`       · 词「${h.word}」：${h.sentence.slice(0, 80)}`);
      for (const h of a) say(`       · 问法「${h.why}」：${h.sentence.slice(0, 80)}`);
    }
  }
  say('');
  if (bad === 0) {
    say('✅ 自检全过：词表与"反问平台"这两条**红路都真的会红**。');
    nodeProcess.exit(0);
  }
  say(`❌ 自检有 ${bad} 条不对 —— 词表写坏了，真跑一轮的绿灯不可信。`);
  nodeProcess.exit(2);
}

// ── 跑起来 ─────────────────────────────────────────────────────

// ⚠️ 令牌这两道闸放在这里（`--self-test` 之后）：自检**不联网、不要令牌**。
if (!TOKEN) {
  say('⚠️ 环境不具备：没给令牌。');
  say('   HUPO_TOKEN=<有容器的号的令牌> node scripts/check-app-drift.mjs');
  say('   （只想验词表本身：node scripts/check-app-drift.mjs --self-test）');
  nodeProcess.exit(3);
}
if (TOKEN.length < 8) {
  // ⚠️ 实测踩过：`HUPO_TOKEN=$(cat 某个 json)` 拿到的是 `}`，而
  //    `new WebSocket(url, ['bearer', '}'])` 会直接抛。所以先拦一道，**不打印那个值**。
  say(`⚠️ 环境不具备：HUPO_TOKEN 不像一个令牌（长度 ${TOKEN.length}）。`);
  nodeProcess.exit(3);
}

say('「小程序 / app / 应用」= 他桌面上那个图标 —— 活系统检查（真跑一轮）');
say(`   地址 ${URL_}`);
say(`   要发 «${TEXT}»`);

const c = await connect(wsUrlOf(URL_, '/api/stream?sinceSeq=9007199254740991&level=steps'));
if (!c.ok) {
  record(false, '连上 `/api/stream`', whyRejected(c.status, c.error));
  say('   → 怎么办：确认这个令牌能进一个**有容器**的号；再看这台服务在不在。');
  nodeProcess.exit(3);
}
record(true, '连上 `/api/stream`（握手过了）');

// ⚠️ `client/reset` = 我们故意报了"号跑到前面去了" ⇒ 它**不补发历史**（那正是我们要的）。
const greeted = await waitUntil(
  () => c.msgs.find((m) => m?.type === 'client/hello' || m?.type === 'client/reset'),
  10000,
);
if (!greeted) say('   ⚠️ 10 秒里没收到 `client/hello` / `client/reset` —— 接着按"只收实时事件"跑');

/** 桌面那本清单（**只是旁证**，见下）。 */
async function readAppIds() {
  try {
    const r = await fetch(appsUrl, { headers: { authorization: `Bearer ${TOKEN}` } });
    if (!r.ok) return null;
    const j = await r.json();
    const list = Array.isArray(j?.apps) ? j.apps : null;
    return list ? list.map((a) => String(a?.id ?? '')).filter(Boolean) : null;
  } catch {
    return null;
  }
}
const appsBefore = await readAppIds();

const messageId = `u_drift_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let said = null;
try {
  said = await fetch(sayUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messageId, text: TEXT }),
  });
} catch (err) {
  record(false, '发那一句（`/api/say`）', `连不上：${scrub(err?.message ?? err)}`);
  try { c.ws.terminate(); } catch { /* 已经没了 */ }
  nodeProcess.exit(3);
}
if (!said.ok) {
  const body = await said.text().catch(() => '');
  record(false, '发那一句（`/api/say`）', `HTTP ${said.status} ${scrub(body).slice(0, 120)}`);
  try { c.ws.terminate(); } catch { /* 已经没了 */ }
  nodeProcess.exit(3);
}
record(true, '那句发出去了（`/api/say`）');

say(`   等这一轮收口（最多 ${Math.round(WAIT_MS / 1000)} 秒）…`);
const started = await waitUntil(
  () => c.msgs.find((m) => m?.type === 'message/status' && m.state === 'started')
    ?? c.msgs.find((m) => m?.type === 'message/start'),
  WAIT_MS,
);
const ended = await waitUntil(() => c.msgs.find((m) => m?.type === 'message/end'), WAIT_MS);
if (ended) await waitQuiet(c.msgs, QUIET_MS, 20000);

try { c.ws.close(); } catch { /* 已经没了 */ }

// ── 收这一轮的账 ───────────────────────────────────────────────

const text = assistantTextOf(c.msgs);
const mutated = c.msgs.filter((m) => m?.type === 'task/mutated').length;
const steps = c.msgs.filter((m) => m?.type === 'step/start').length;
const appsAfter = await readAppIds();
const newApps = appsBefore && appsAfter ? appsAfter.filter((id) => !appsBefore.includes(id)) : null;

say('');
say('── 这一轮收到了什么 ──────────────────────────────');
say(`   起手 ${started ? '有' : '没等到'}（message/status started）｜ 收口 ${ended ? '有' : '没等到'}（message/end）`);
say(`   说的字 ${text.length} 个 ｜ \`task/mutated\` ${mutated} 条 ｜ \`step/start\` ${steps} 条`);
if (text) say(`   它说的话：\n${text.split('\n').map((l) => `     ${l}`).join('\n')}`);

// ① 有回话
if (!started && !ended) {
  record(false, '这一轮有回话', `${WAIT_MS}ms 里既没"起手"也没"收口"—— 它不是没做，是没答`);
  say('   → 怎么办：看这台服务 / 那个盒子里的日志；部署没走完时也可能长这样。');
  nodeProcess.exit(2);
}
if (!ended) {
  record(false, '这一轮收口了', `${WAIT_MS}ms 里没等到 message/end（收到的类型：` +
    `${[...new Set(c.msgs.map((m) => m?.type ?? '?'))].join(' · ') || '（一个都没有）'}）`);
  say('   → 下面照收上来的东西判，但这条已经红了。');
}

// ② 走的是我们这条路
say('');
say('── ① 它走的是哪条路 ──────────────────────────────');
const route = routeVerdict({ text, mutated, newApps });
if (newApps && newApps.length > 0) {
  say(`   ✅ 旁证：桌面那本清单多了一个 —— ${newApps.join(' · ')}`);
} else if (appsBefore && appsAfter) {
  say('   （桌面清单前后一样 —— 这条只是旁证，不算判据）');
} else {
  say('   （桌面清单读不到 —— ⚠️ `/api/apps` 不在租户路由表里，是个号的可能读到宿主那份；这条只当旁证）');
}
record(
  route.ok,
  '走的是我们这条路（他桌面上多了一个页面）',
  `提到了"桌面"=${route.mentionsDesktop} ｜ 说了"做好了/桌面上能点开"=${route.saysMade} ｜ ` +
    `这一轮动过东西=${mutated > 0}（⚠️ 这个**不是** app_create 的证据）｜ 桌面清单多了=${newApps ? newApps.length : '读不到'}`,
);
if (!route.ok) {
  say('   → 这一条红 = **它没往桌面上做**（或者做了但没说清）。');
  say('     ⚠️ 一处实话：`/api/stream` 上**没有工具名**，所以这里看不见 `app_create` 本身；');
  say('        能看到的最接近的形状是 `task/mutated`（这一轮动过东西）+ 它说的话。');
}

// ③ 没有漂移词
say('');
say('── ② 有没有漂移词 ────────────────────────────────');
const driftHits = findDrift(text);
if (driftHits.length === 0) {
  record(true, '没有漂移词');
} else {
  record(false, `出现了漂移词（${[...new Set(driftHits.map((h) => h.word))].join(' · ')}）`);
  for (const h of driftHits) {
    say(`   🔴 哪个词：**${h.word}**${h.note ? `（${h.note}）` : ''}`);
    say(`      哪一句：${h.sentence.slice(0, 120)}`);
  }
}

// ④ 没有反问他平台
say('');
say('── ③ 有没有反问他"要哪个平台" ─────────────────────');
const askHits = findPlatformAsks(text);
if (askHits.length === 0) {
  record(true, '没有反问他"要哪个平台 / 微信还是 app"');
} else {
  record(false, `反问他平台了（${[...new Set(askHits.map((h) => h.why))].join(' · ')}）`);
  for (const h of askHits) {
    say(`   🔴 哪种问法：${h.why}`);
    say(`      哪一句：${h.sentence.slice(0, 120)}`);
  }
}

// ── 收尾 ───────────────────────────────────────────────────────
say('');
const bad = results.filter((r) => r.ok === false);
if (bad.length === 0) {
  say('✅ 全通：它走的是**他桌面上那个**，没有漂。');
  nodeProcess.exit(0);
}
say(`❌ 有 ${bad.length} 条没通：`);
for (const r of bad) say(`   · ${r.label}`);
say('   ⚠️ 这台要是**还没部署**新的人格 / 工具说明，红是**如实**的 —— 别为此放宽判据。');
nodeProcess.exit(2);
