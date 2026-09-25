#!/usr/bin/env node
// **开发者模式那条路的"活系统"检查**（判据 **D8** · `docs/dev/82-DEV-MODE.md` §六）。
//
// 它要一台**部署好的**系统：VPS 上那个 `dsh<手机号>.<后缀>` 的 server 块通了、
// 本机核心是按 Host 分流的、某个人被标成了开发者、盒子里那台 `dsh web` 起得来。
// ⇒ 部署之前跑，它会失败，而且会**告诉你是哪一段断的**（不是丢一句 "fetch 失败"）。
//
// ── 它验三步（D8 那一条）────────────────────────────────────
//   ① **无 cookie** 取 `/` ⇒ **拒**（不许"先给界面"）；
//   ② 走一次 `/__enter` 签名 ⇒ **302/303 + `hupo-dev` cookie**；
//   ③ 带 cookie 取 `/` ⇒ **200 且是"房间清单"那一页**（★ 2026-09-25 起那条入口**先给清单**）
//      —— 顺便验 **D6**（列得出全部房间：`main` ＋ 每一间工作区）与**看板那句话**
//      （"在这儿说话的不是琥珀"）；
//   ③b 从那一页里挑一间（`/?room=<id>`）⇒ **302**（选上了）；
//   ③c 再取 `/` ⇒ **200 且 HTML 里有 `__DSH_BOOT__`**（界面本体真的从那台 DSH 来）
//      ＋ **那条提示真的插进去了**（`injectDevBanner`：看板那句话在那一页本体上也看得见）；
//   ④ 带 cookie **真升一次级** `/api/remote.mux` ⇒ **101**（数据通道）。
//
// ⚠️ **这一条改过一次（2026-09-25）**：③ 原来直接要 `__DSH_BOOT__`，那是**旧形状**
//    （那条入口直连那一台）。改成"先给房间清单"之后，照旧版跑会在 ③/④ 报红，
//    而系统其实是好的 ⇒ **判据要跟着形状改**（不是把红的哄绿）。
//
// ── 用法 ────────────────────────────────────────────────────
//   HUPO_TOKEN=<令牌> node scripts/check-dev-mode.mjs --url https://dsh19145526557.stalkerai.cn
//   HUPO_TOKEN=<主人的令牌> node scripts/check-dev-mode.mjs --url https://dsh… --phone 19145526557
//   node scripts/check-dev-mode.mjs --link 'https://dsh…/__enter?u=…&e=…&s=…'   # 直接给链接
//
// 🔴 **它不打印任何密钥 / 令牌 / 签名**：输出里一律换成 `<已隐去>`。
// 🔴 **它不写任何文件**。
//
// 退出码：0 全通 · 2 有判据没通 · 3 环境不具备（没地址 / 拿不到链接 / 连不上）

import nodeProcess from 'node:process';

// 🔴 升级那条判据必须用 `ws`：`Host`/`Cookie` 是 fetch 的**禁止头**，拿 `fetch` 验不了升级。
import WebSocket from '../v2/services/core/node_modules/ws/index.js';

const argv = nodeProcess.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const valueOf = (f, dflt = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const API = valueOf('--api', 'https://w.stalkerai.cn').replace(/\/+$/u, '');
let URL_ = valueOf('--url', null);
const LINK_ARG = valueOf('--link', null);
const PHONE = valueOf('--phone', '');
const TOKEN = nodeProcess.env.HUPO_TOKEN ?? null;

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`开发者模式（\`dsh<手机号>.<后缀>\`）的活系统检查 —— 判据 D8。

用法：
  HUPO_TOKEN=<令牌> node scripts/check-dev-mode.mjs --url <那个域名> [选项]

选项：
  --url <地址>    开发者域名（例如 https://dsh19145526557.stalkerai.cn）。
                  不给也能从 --link / HUPO_TOKEN 那条回执里推出来。
  --api <地址>    主 origin（默认 ${API}）—— 用令牌去这里要签名链接。
  --phone <手机号> 主人点名别人的时候用（普通用户不许点名）。
  --link <地址>   直接给一条 /__enter 链接（给了就不去要令牌）。
  --help          这一屏。

退出码：0 全通 · 2 有判据没通 · 3 环境不具备`);
  nodeProcess.exit(0);
}

/** 🔴 令牌 / 链接里的签名**一个字都不许进输出**。 */
const SECRETS = [TOKEN].filter((s) => typeof s === 'string' && s.length >= 8);
const scrub = (s) => {
  let out = String(s ?? '');
  for (const secret of SECRETS) out = out.split(secret).join('<已隐去>');
  // 链接里的签名与令牌参数（`?s=…`）一律抹掉
  out = out.replace(/([?&](?:s|token)=)[^&\s'"]+/giu, '$1<已隐去>');
  return out;
};
const say = (s = '') => console.log(scrub(s));

const results = [];
const record = (ok, label, detail = '') => {
  results.push({ ok, label });
  say(`${ok === true ? '✅' : ok === false ? '❌' : '⚠️'} ${label}${detail ? ` —— ${detail}` : ''}`);
};

/** 一条请求（**手动跟重定向**：302 那条本身就是判据）。 */
async function get(url, headers = {}) {
  try {
    const res = await fetch(url, { redirect: 'manual', headers });
    const body = res.status >= 300 && res.status < 400 ? '' : await res.text();
    let setCookies = [];
    try {
      setCookies = res.headers.getSetCookie?.() ?? [];
    } catch {
      setCookies = [];
    }
    return { ok: true, status: res.status, headers: res.headers, setCookies, body };
  } catch (err) {
    return { ok: false, error: String(err?.cause?.message ?? err?.message ?? err) };
  }
}

/** 取出第一方 cookie 的值。 */
function devCookieValueOf(setCookies) {
  for (const raw of setCookies) {
    const first = String(raw).split(';')[0].trim();
    if (first.startsWith('hupo-dev=')) return first.slice('hupo-dev='.length);
  }
  return null;
}

/** 用令牌去主 origin 要一条签名链接。 */
async function linkFromApi() {
  if (!TOKEN) return { ok: false, why: '没给令牌（HUPO_TOKEN），也没给 --link' };
  const q = PHONE ? `?phone=${encodeURIComponent(PHONE)}` : '';
  const r = await get(`${API}/api/dev-harness${q}`, { authorization: `Bearer ${TOKEN}` });
  if (!r.ok) return { ok: false, why: `要链接那一步连不上（${r.error}）` };
  if (r.status === 401) return { ok: false, why: '令牌不通（过期 / 被撤 / 不是这一台签的）' };
  if (r.status === 403) return { ok: false, why: '这个令牌不许看那个人的入口（只有主人能点名）' };
  if (r.status !== 200) return { ok: false, why: `要链接那一步被拒（HTTP ${r.status}）` };
  let j = null;
  try {
    j = JSON.parse(r.body);
  } catch {
    return { ok: false, why: '要链接那一步回的不是 JSON' };
  }
  if (j?.dev === false || j?.ok === false) {
    return { ok: false, why: `这个人还没被标成开发者 ⇒ 没有入口（${scrub(j?.text ?? '')}）`, notDev: true };
  }
  if (typeof j?.url !== 'string' || j.url === '') return { ok: false, why: '要链接那一步没回 url' };
  return { ok: true, url: j.url, expiresAt: j.expiresAt ?? null };
}

// ── 跑 ───────────────────────────────────────────────────────

say('开发者模式（`dsh<手机号>.<后缀>`）· 活系统检查 —— 判据 D8');
say(`   主 origin：${API}`);

let linkUrl = LINK_ARG;
if (!linkUrl) {
  const got = await linkFromApi();
  if (!got.ok) {
    say('');
    say(`⚠️ 环境不具备：${got.why}`);
    say('   → 怎么办：给一个有权限的 HUPO_TOKEN（要能进**那个被标成开发者的人**，或主人 + --phone），');
    say('     或者直接 `--link <那条 /__enter 链接>`。');
    nodeProcess.exit(3);
  }
  linkUrl = got.url;
  if (got.expiresAt) say(`   链接有效期到：${new Date(got.expiresAt).toISOString()}（**短时效**）`);
}
if (!URL_) {
  try {
    URL_ = new URL(linkUrl).origin;
  } catch {
    say('');
    say('⚠️ 环境不具备：--url 给得不对，而且从 --link 里也推不出 origin。');
    nodeProcess.exit(3);
  }
}
say(`   开发者域名：${URL_}`);

// ① 无 cookie ⇒ 拒
say('');
say('── ① 不带 cookie 取 `/` ⇒ 必须拒（不许"先给界面"）──────');
const noCookie = await get(`${URL_}/`);
if (!noCookie.ok) {
  record(null, '① 无 cookie ⇒ 拒', `没验到：连不上（${noCookie.error}）—— VPS 那个 server 块 / 隧道那一段断了`);
} else if (noCookie.status < 400) {
  record(false, '① 无 cookie ⇒ 拒', `居然 HTTP ${noCookie.status} —— 那**就是**"先给界面"（判据 D3 的反例）`);
  if (/__DSH_BOOT__/u.test(noCookie.body)) {
    say('   🔴 而且 HTML 里还有 `__DSH_BOOT__` —— 界面真的递出去了，**这道锁不在**。');
  }
} else {
  record(true, '① 无 cookie ⇒ 拒', `HTTP ${noCookie.status}（正确）`);
}

// ② `/__enter` 签名 ⇒ 302/303 + cookie
say('');
say('── ② 走一次 `/__enter` 签名 ⇒ 302 + 第一方 cookie ────────');
const enter = await get(linkUrl);
let cookie = null;
if (!enter.ok) {
  record(false, '② `/__enter` 换 cookie', `连不上：${enter.error}`);
} else if (enter.status < 300 || enter.status >= 400) {
  record(
    false,
    '② `/__enter` 换 cookie',
    `HTTP ${enter.status}（要的是 302/303）—— 多半是链接过期了（短时效），或者签名这一路没接上`,
  );
} else {
  cookie = devCookieValueOf(enter.setCookies);
  if (!cookie) {
    record(false, '② `/__enter` 换 cookie', `HTTP ${enter.status} 但没有 hupo-dev cookie`);
  } else {
    const raw = enter.setCookies.join(' | ');
    const attrs = ['HttpOnly', 'Secure', 'SameSite=Lax'].filter((a) => new RegExp(a, 'iu').test(raw));
    record(true, '② `/__enter` 换 cookie', `HTTP ${enter.status} + hupo-dev（${attrs.join(' / ')}）`);
    SECRETS.push(cookie); // 🔴 cookie 值也不许进输出
  }
}

// ③ 带 cookie ⇒ 200 且**是"房间清单"那一页**（★ 2026-09-25：那条入口先给清单）
//    ★ 顺手验两件**主人点名要的**：**D6**（列得出全部房间）与**看板那句话**（不是琥珀）。
say('');
say('── ③ 带 cookie 取 `/` ⇒ 200 且是"房间清单"那一页（D6 ＋ 看板那句话）─────');
/** ★ 看板那句话（**主人 2026-09-25 拍的「甲」**）：跟 `src/dev-mode.js` 里那份逐字一样。 */
const NOT_HUPO = '在这儿说话的不是琥珀。';
let roomHref = null;
if (!cookie) {
  record(null, '③ 带 cookie 取 `/`', '没验到：上一步没拿到 cookie');
} else {
  const home = await get(`${URL_}/`, { cookie: `hupo-dev=${cookie}` });
  if (!home.ok) {
    record(false, '③ 带 cookie 取 `/`', `连不上：${home.error}`);
  } else if (home.status !== 200) {
    record(
      false,
      '③ 带 cookie 取 `/`',
      `HTTP ${home.status}（要 200）—— 外层过了但里层没通：看盒子里那台 dsh web 起没起来`,
    );
  } else if (!home.body.includes(NOT_HUPO)) {
    record(
      false,
      '③ 带 cookie 取 `/`',
      '200 了，但页面上**没写**"在这儿说话的不是琥珀" —— 那一页要么还是旧形状，要么那句话丢了',
    );
  } else {
    // D6：列得出全部房间（`main` ＋ 每一间工作区）——**至少两间**才算过
    const names = [...home.body.matchAll(/<li><a href="\/\?room=[^"]*">([^<]*)<\/a>/gu)].map((m) => m[1]);
    const hrefs = [...home.body.matchAll(/href="(\/\?room=[^"]*)"/gu)].map((m) => m[1]);
    roomHref = hrefs[0] ?? null;
    if (names.length >= 2 && roomHref) {
      record(
        true,
        '③ 房间清单那一页（＋ D6 ＋ 看板那句话）',
        `200 · 房间 ${names.length} 间：${names.join(' / ')} · 那句话在`,
      );
    } else {
      record(
        false,
        '③ D6：清单里要列得出全部房间（至少两间）',
        `只列了 ${names.length} 间：${names.join(' / ') || '（一间都没有）'} —— 要么这一间真没有工作区，要么那一台没重新认房间（workspaceNudge）`,
      );
    }
  }
}

// ③b/③c：挑一间（302）⇒ 再取 `/` ⇒ 200 且含 `__DSH_BOOT__` ＋ 那条提示（真的插进去了）
say('');
say('── ③b/c 点一间 ⇒ 302；再取 `/` ⇒ 200 且含 `__DSH_BOOT__` ＋ 看板那句话 ─────');
if (!roomHref) {
  record(null, '③b/c 点一间再取 `/`', '没验到：上一步没拿到房间清单里那一条链接');
} else {
  const pick = await get(`${URL_}${roomHref}`, { cookie: `hupo-dev=${cookie}` });
  if (!pick.ok || pick.status < 300 || pick.status >= 400) {
    record(false, '③b 点一间（`/?room=…`）', pick.ok ? `HTTP ${pick.status}（要 302）` : `连不上：${pick.error}`);
  } else {
    record(true, '③b 点一间（`/?room=…`）', `HTTP ${pick.status} —— 记下了这一间`);
    const ui = await get(`${URL_}/`, { cookie: `hupo-dev=${cookie}` });
    if (!ui.ok) {
      record(false, '③c 再取 `/`', `连不上：${ui.error}`);
    } else if (ui.status !== 200) {
      record(false, '③c 再取 `/`', `HTTP ${ui.status}（要 200）`);
    } else if (!/__DSH_BOOT__/u.test(ui.body)) {
      record(false, '③c 再取 `/`', '200 了，但 HTML 里没有 `__DSH_BOOT__` —— 来的不是那台 DSH 的界面');
    } else if (!ui.body.includes(NOT_HUPO)) {
      record(
        false,
        '③c 那一页本体上要看板那句话',
        '`__DSH_BOOT__` 在，但那条提示**没插进去**（`injectDevBanner`：多半认不出 `<body>` 或者被压缩过）',
      );
    } else {
      record(
        true,
        '③c 那一页本体（＋ 看板那句话）',
        `200 · HTML ${ui.body.length} 字节 · 含 \`__DSH_BOOT__\` 与"不是琥珀"那一条`,
      );
    }
  }
}

// ④ 带 cookie **真的升一次级**（那台界面的**数据通道**就是它）
//   🔴 **为什么必须有这一步**：③ 只证明"那一页 HTML 来对了地方"——
//      而它的数据通道（`/api/remote.mux` 那条 WebSocket）**死着的时候，③ 照样是绿的**。
//      2026-09-24 就这么被骗过一次：屏幕上写着 `No sessions yet` ＋ `Reconnecting…`，
//      而当时 D8 那三条全绿（判据打在了被测代码的**另一侧** —— 正是 `AGENTS.md` V13 说的形状）。
//      ⇒ 判据要打在这一侧：**真升一次级**。
say('');
say('── ④ 带 cookie 真升一次级 `/api/remote.mux` ⇒ 必须升得上去 ─────');
if (!cookie) {
  record(null, '④ 升级 `/api/remote.mux`', '没验到：还没有 cookie');
} else {
  const wsUrl = `${URL_.replace(/^http/u, 'ws')}/api/remote.mux`;
  const up = await new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(wsUrl, { headers: { cookie: `hupo-dev=${cookie}` } });
    } catch (e) {
      resolve({ ok: false, why: `连不出去：${String(e?.message ?? e)}` });
      return undefined;
    }
    const t = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* 已经没了 */
      }
      resolve({ ok: false, why: '15 秒没升上去（超时）' });
    }, 15000);
    ws.on('open', () => {
      clearTimeout(t);
      try {
        ws.close();
      } catch {
        /* 已经关了 */
      }
      resolve({ ok: true });
    });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(t);
      resolve({ ok: false, why: `握手被拒：HTTP ${res.statusCode}` });
    });
    ws.on('error', (e) => {
      clearTimeout(t);
      resolve({ ok: false, why: `握手失败：${String(e?.message ?? e)}` });
    });
  });
  if (up.ok) {
    record(true, '④ 升级 `/api/remote.mux`', '101 —— 那条数据通道真的通了');
  } else {
    record(
      false,
      '④ 升级 `/api/remote.mux`',
      `${up.why} —— 界面会一直显示「Reconnecting…」、会话列不出来。查两处：nginx 有没有转发 \`Upgrade\`、宿主那道升级闸有没有放行`,
    );
  }
}

say('');
const bad = results.filter((r) => r.ok === false).length;
const unknown = results.filter((r) => r.ok === null).length;
say(`── 结果：${results.length - bad - unknown} 通 · ${bad} 没通 · ${unknown} 没验到 ──`);
nodeProcess.exit(bad > 0 ? 2 : unknown > 0 ? 3 : 0);
