#!/usr/bin/env node
// **甲那条路的"活系统"检查**（判据 H9 / H10 · `docs/dev/81-HARNESS-ENTRY.md` §六）。
//
// 它要一台**部署好的**系统：容器里跑着新代码、`/api/harness` 那条口接得上。
// ⇒ 部署之前跑，它会失败，而且会**告诉你是哪一段断的**（不是丢一句 "connect 失败"）。
//
// ── 它验三件事 ────────────────────────────────────────────────
//   H9  对活系统连 WS、发一句、等到 `assistant/message`；
//       **并且整条流里没有琥珀人格的特征串**（那说明盒里跑的是"那台 DSH 本人"）。
//   H10a 不带令牌 ⇒ 拒（握手阶段，不是"先连上再关"）。
//   H10b 公网口 ⇒ 拒。默认打**这台机器自己的公开口**（`--url` 那个 origin）
//       并带一个"没有盒子的人"的令牌；也可以 `--public <ws 地址>` 直接指过去
//       （例如从盒子里指 `ws://127.0.0.1:8080/api/harness`）。
//
// ── 用法 ─────────────────────────────────────────────────────
//   HUPO_TOKEN=<你自己的令牌> node scripts/check-harness.mjs
//   HUPO_TOKEN=... node scripts/check-harness.mjs --url https://w.stalkerai.cn/ --wait 90000
//   HUPO_TOKEN=... node scripts/check-harness.mjs --public ws://127.0.0.1:8080/api/harness
//   HUPO_TOKEN=... HUPO_OWNER_TOKEN=<主人的令牌> node scripts/check-harness.mjs
//
// 🔴 **它不打印任何密钥**：令牌只在子协议里出现，输出里一律换成 `<令牌>`。
// 🔴 **它不写任何文件**：H10b 要一个"没有盒子的人"的令牌时，
//    用 `src/auth.js` 的 `Auth.issue()` **现发**一个 —— 而且给它一个**只读的 fs**，
//    免得"现发一个令牌"这件事顺手在盘上建/改什么（`Auth` 的构造会 `mkdir`，
//    盘上没口令时还会写 `auth.json`）。
//
// 退出码：0 全通 · 2 有判据没通 · 3 环境不具备（没令牌 / 连不上这台机器）

import nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeProcess from 'node:process';
import { fileURLToPath } from 'node:url';

import WebSocket from '../v2/services/core/node_modules/ws/index.js';

const REPO = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..');

const argv = nodeProcess.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const valueOf = (f, dflt = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const URL_ = valueOf('--url', 'https://w.stalkerai.cn/');
const WAIT_MS = Number.parseInt(valueOf('--wait', '90000'), 10);
const PUBLIC = valueOf('--public', null);
const DATA_DIR =
  valueOf('--data', null) ??
  nodeProcess.env.HUPO_DATA ??
  nodePath.join(REPO, 'v2/services/core/data');

/** 🔴 令牌**一个字都不许进输出**。 */
const SECRETS = [nodeProcess.env.HUPO_TOKEN, nodeProcess.env.HUPO_OWNER_TOKEN].filter(
  (s) => typeof s === 'string' && s.length >= 8,
);
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
  say(`甲那条路（\`/api/harness\`）的活系统检查 —— 判据 H9 / H10。

用法：
  HUPO_TOKEN=<令牌> node scripts/check-harness.mjs [选项]

选项：
  --url <地址>       主 origin（默认 ${URL_}）。令牌要能进一个**有容器**的号。
  --wait <毫秒>      等"回话"的上限（默认 ${WAIT_MS}）。
  --public <ws 地址> 公网口那条反例直接指到哪儿（默认用 --url 那个 origin）。
                     例：从盒子里指 \`ws://127.0.0.1:8080/api/harness\`。
  --data <目录>      本机 data 目录（H10b 要现发一个"主人"令牌时用；默认 ${DATA_DIR}）。
  --help             这一屏。

退出码：0 全通 · 2 有判据没通 · 3 环境不具备（没令牌 / 连不上这台机器）`);
  nodeProcess.exit(0);
}

/** 这个 origin 上那条 WS 的地址。 */
function wsUrlOf(base, path = '/api/harness') {
  const u = new URL(base);
  const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${u.host}${path}`;
}

/**
 * 连一次，把**握手阶段的结论**带回来（不是"先连上再关"）。
 * @returns {Promise<{ok:true,ws:WebSocket,msgs:object[]}|{ok:false,status:number|null,error:string|null}>}
 */
function connect(url, token = null) {
  return new Promise((resolve) => {
    const ws = token ? new WebSocket(url, ['bearer', token]) : new WebSocket(url);
    const msgs = [];
    // ⚠️ 监听要在 `open` 之前挂好：`state:booting` 可能是**同步**发出来的
    ws.on('message', (d) => {
      try {
        msgs.push(JSON.parse(String(d)));
      } catch {
        /* 不认识的不管（这条线只有 JSON） */
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

/** 被拒时的那句人话（**哪一段断了**）。 */
function whyRejected(status, error) {
  if (error) return `连不上（${error}）—— 这台机器/这条隧道那段断了`;
  if (status === 401) return '令牌不通（过期 / 被撤 / 不是这一台签的；也可能前面那层没转发 Upgrade —— 见下面那句诊断）';
  if (status === 404) {
    return '这条口**没有服务那台 DSH**：多半是**盒子里的代码还没更新到含 `/api/harness` 的版本**（部署那一段没走完）';
  }
  if (status === 503) return '这台还没准备好（没设口令 / 你那台的空间还在准备 / 隧道没通）';
  return `被拒（HTTP ${status}）`;
}

/** 把收到的 `raw` 里的一串正文取出来（判据 H9 只看这个）。 */
function assistantTexts(msgs) {
  return msgs
    .filter((m) => m?.t === 'raw' && m.m?.params?.event?.type === 'assistant/message')
    .flatMap((m) => m.m.params.event.data?.message?.content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => String(b.text ?? ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    const hit = fn();
    if (hit) return hit;
    if (Date.now() - t0 > ms) return null;
    await sleep(50);
  }
}

/**
 * **同一个令牌在 `/api/stream` 上通不通**。
 *
 * 为什么要问这一句：`/api/harness` 被 401 的时候有两种完全不同的原因 ——
 *   ① **令牌真的不灵**；② **前面那一层没把 Upgrade 头转进来**（请求变成了普通 GET，
 *      而普通 GET 上那条令牌根本不在（它走的是 WS 子协议）⇒ 必然 401）。
 * 同一个令牌在 `/api/stream` 上能通 ⇒ 令牌是好的 ⇒ **是②**。
 *
 * ⚠️ 2026-09-24 实测到的②：repo 里那份 `deploy/nginx-w-stalkerai.conf` 的
 *    WebSocket 那段只匹配 `^/api/(stream|asr)$` —— `/api/harness` 落进普通那段，
 *    nginx **不转发** `Upgrade`/`Connection` ⇒ 那条路在 nginx 那一层就断
 *    （本地直连 8020 是好的，经 `w.` 就一定 401）。那是一条**部署/VPS**上的改动。
 */
async function streamWorks(token) {
  const c = await connect(wsUrlOf(URL_, '/api/stream'), token);
  if (!c.ok) return false;
  try {
    c.ws.close();
  } catch {
    /* 已经没了 */
  }
  return true;
}

/** H9：主连接。 */
async function checkH9(token) {
  say('');
  say('── H9：连上、说一句、等它回话（而且它得是那台 DSH 本人）────────');
  const url = wsUrlOf(URL_);
  say(`   连 ${url}`);
  const c = await connect(url, token);
  if (!c.ok) {
    record(false, 'H9 连上那条 WS', whyRejected(c.status, c.error));
    if (c.status === 401 && (await streamWorks(token))) {
      say('   🔴 同一个令牌在 `/api/stream` 上是**通的** ⇒ 不是令牌的问题：');
      say('      是前面那一层没把这条路径的 `Upgrade` 头转进来（请求变成了普通 GET）。');
      say('      repo 里那份 `deploy/nginx-w-stalkerai.conf` 的 WebSocket 那段只写了');
      say('      `location ~ ^/api/(stream|asr)$` —— 要把 `harness` 也放进去，这条路才走得通。');
      say('      ⚠️ 那是**部署/VPS**上的改动（不是盒子里的代码，也不是这份脚本能改的）。');
    } else {
      say('   → 怎么办：先确认令牌能进一个有容器的号；再看盒子是不是更新到含 `/api/harness` 的版本。');
    }
    return;
  }
  say('   握手过了');

  // ① 状态：booting → ready（起不来时它会给 `gone` + 一句人话）
  const ready = await waitUntil(
    () => c.msgs.find((m) => m?.t === 'state' && m.s === 'ready') ?? c.msgs.find((m) => m?.t === 'state' && m.s === 'gone'),
    20000,
  );
  if (!ready) {
    record(false, 'H9 盒里那台 DSH 起来', '连上了，但 20 秒里既没 `ready` 也没 `gone`');
    say('   → 怎么办：看盒子里的服务日志（`/data` 那一份），多半是 `dsh` 起不来。');
    try { c.ws.terminate(); } catch { /* 已经没了 */ }
    return;
  }
  if (ready.s === 'gone') {
    record(false, 'H9 盒里那台 DSH 起来', `它说：${ready.why ?? '（没说为什么）'}`);
    try { c.ws.terminate(); } catch { /* 已经没了 */ }
    return;
  }
  say('   `state:ready`');

  // ② 说一句
  c.ws.send(JSON.stringify({ t: 'say', text: '你好，请用一句话介绍你自己。' }));
  say('   说了一句，等 `assistant/message` …');
  const hit = await waitUntil(
    () => c.msgs.find((m) => m?.t === 'raw' && m.m?.params?.event?.type === 'assistant/message'),
    WAIT_MS,
  );
  if (!hit) {
    const types = [
      ...new Set(
        c.msgs.filter((m) => m?.t === 'raw').map((m) => m.m?.params?.event?.type ?? m.m?.method ?? '?'),
      ),
    ];
    record(false, 'H9 收到 `assistant/message`', `${WAIT_MS}ms 里没等到；收到的类型：${types.join(' · ') || '（一个都没有）'}`);
    say('   → 怎么办：起了但没回话 ⇒ 看"模型那条 patch"与盒内 8787 那个小代理（`HUPO_MODEL_TICKET`）。');
    try { c.ws.terminate(); } catch { /* 已经没了 */ }
    return;
  }
  record(true, 'H9 收到 `assistant/message`');

  // ③ 它得是 DSH 本人，不是琥珀
  const rawText = JSON.stringify(c.msgs.filter((m) => m?.t === 'raw').map((m) => m.m));
  const amber = ['私人助理', '你不是编码助手'].filter((w) => rawText.includes(w));
  if (amber.length > 0) {
    record(false, 'H9 流里没有琥珀人格', `出现了人格特征串：${amber.join('、')} —— 盒里跑的不是"那台 DSH 本人"`);
    say('   → 怎么办：看容器那一侧起进程的参数里有没有多挂 `--patch <人格>`（判据 H5）。');
  } else {
    record(true, 'H9 流里没有琥珀人格');
  }

  // 证据（**不是**秘密）：它说了什么 + 这一轮有哪些事件
  const texts = assistantTexts(c.msgs);
  say(`   它回的话：「${texts.join(' / ').slice(0, 200)}」`);
  const counts = new Map();
  for (const m of c.msgs) {
    if (m?.t !== 'raw') continue;
    const t = m.m?.params?.event?.type ?? m.m?.method ?? '（响应）';
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  say(`   这一轮收到：${[...counts.entries()].map(([k, v]) => `${k}×${v}`).join(' · ')}`);

  try { c.ws.close(); } catch { /* 已经没了 */ }
}

/** H10a：不带令牌 ⇒ 拒。 */
async function checkH10a() {
  say('');
  say('── H10a：不带令牌 ⇒ 拒（握手阶段）──────────────────────────');
  const c = await connect(wsUrlOf(URL_), null);
  if (c.ok) {
    record(false, 'H10a 不带令牌也连上了', '这条口**不许**对任何人不带令牌开放');
    try { c.ws.terminate(); } catch { /* 已经没了 */ }
    return;
  }
  if (typeof c.status !== 'number') {
    // ⚠️ "连不上"**不是**"被拒" —— 那种情形要如实说没验到（不然这条判据是假的）
    record(null, 'H10a 不带令牌 ⇒ 拒', `没验到：${whyRejected(c.status, c.error)}`);
    return;
  }
  record(c.status >= 400, 'H10a 不带令牌 ⇒ 拒', `HTTP ${c.status}（没带令牌 ⇒ 握手阶段就拒，正确）`);
}

/** 现发一个"没有盒子的人"（主人）的令牌 —— **只读**，一个文件都不写。 */
async function ownerToken() {
  if (nodeProcess.env.HUPO_OWNER_TOKEN) return nodeProcess.env.HUPO_OWNER_TOKEN;
  try {
    const { Auth } = await import('../v2/services/core/src/auth.js');
    const roFs = {
      readFileSync: nodeFs.readFileSync.bind(nodeFs),
      statSync: nodeFs.statSync.bind(nodeFs),
      existsSync: nodeFs.existsSync.bind(nodeFs),
      readdirSync: nodeFs.readdirSync.bind(nodeFs),
      mkdirSync: () => {}, // 只读：不建目录
      writeFileSync: () => {
        throw new Error('这份脚本**不许写文件**');
      },
      appendFileSync: () => {
        throw new Error('这份脚本**不许写文件**');
      },
      chmodSync: () => {},
    };
    const auth = new Auth({ dataDir: DATA_DIR, fs: roFs });
    if (auth.needsSetup) return null;
    return auth.issue({ sub: 'owner' }).token;
  } catch {
    return null;
  }
}

/** H10b：公网口 ⇒ 拒。 */
async function checkH10b() {
  say('');
  say('── H10b：公网口 ⇒ 拒 ─────────────────────────────────────');
  const target = PUBLIC ?? wsUrlOf(URL_);
  const token = PUBLIC ? null : await ownerToken();
  if (!PUBLIC && !token) {
    record(
      null,
      'H10b 公网口 ⇒ 拒',
      `没验到：拿不到"没有盒子的人"的令牌（--data ${DATA_DIR} 里没有 auth.json，也没设 HUPO_OWNER_TOKEN）`,
    );
    say('   → 怎么办：设 HUPO_OWNER_TOKEN，或者用 `--public <ws 地址>` 直接指到那个公网口。');
    return;
  }
  say(`   连 ${target}${token ? '（带一个"没有盒子的人"的令牌）' : '（不带令牌）'}`);
  const c = await connect(target, token);
  if (c.ok) {
    record(false, 'H10b 公网口 ⇒ 拒', '公网口**居然**接上了 —— 那就是 H1 反例');
    say('   → 怎么办：这条口只该在 `trusted === true`（容器里那条 UDS）上接。');
    try { c.ws.terminate(); } catch { /* 已经没了 */ }
    return;
  }
  if (typeof c.status !== 'number') {
    record(null, 'H10b 公网口 ⇒ 拒', `没验到：${whyRejected(c.status, c.error)}`);
    say('   → 怎么办：这个地址够不着。盒子自己那个公网口从盒子外面通常够不着 —— 用 `--public` 指到够得着的地方。');
    return;
  }
  record(c.status >= 400, 'H10b 公网口 ⇒ 拒', `HTTP ${c.status}（这条口不该服务那台 DSH —— 拒了就对了）`);
}

// ── 跑 ───────────────────────────────────────────────────────

const TOKEN = nodeProcess.env.HUPO_TOKEN ?? null;
say('甲那条路（`/api/harness`）· 活系统检查 —— 判据 H9 / H10');
say(`   origin: ${URL_}`);
if (!TOKEN) {
  say('');
  say('⚠️ 环境不具备：没给令牌。');
  say('   HUPO_TOKEN=<你自己的令牌> node scripts/check-harness.mjs');
  say('   （令牌要能进一个**有容器**的号；没有它就没法验 H9 那条主连接。）');
  nodeProcess.exit(3);
}
// ⚠️ **令牌不合法要说"环境不具备"，不许让它崩栈**（2026-09-24 我踩过：现发令牌时漏了 `.token`，
//    拿到的是一段 `}`，于是 `new WebSocket(url, ['bearer', '}'])` 直接抛
//    `An invalid or duplicated subprotocol was specified` —— 栈里全是 ws 内部，看不出是"令牌给错了"）。
//    WS 子协议那一格只收 RFC 7230 的 token：长度短得不像令牌、或者带了分隔符，都在这里拦下。
if (!/^[A-Za-z0-9._~+/-]{20,}$/u.test(TOKEN)) {
  say('');
  say(`⚠️ 环境不具备：HUPO_TOKEN 不像一个令牌（长度 ${TOKEN.length}）。`);
  say('   它应该长这样：<base64url>.<base64url>（现发时注意接口回的是**对象**，要取 `.token`）。');
  nodeProcess.exit(3);
}

await checkH9(TOKEN);
await checkH10a();
await checkH10b();

say('');
const bad = results.filter((r) => r.ok === false).length;
const unknown = results.filter((r) => r.ok === null).length;
say(`── 结果：${results.length - bad - unknown} 通 · ${bad} 没通 · ${unknown} 没验到 ──`);
nodeProcess.exit(bad > 0 ? 2 : unknown > 0 ? 3 : 0);
