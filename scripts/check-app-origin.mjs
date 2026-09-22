#!/usr/bin/env node
// **制品那个口，上生产之后的自检**（乙-5 · 契约 `docs/dev/59-USER-APPS.md` §九）。
//
// ── 它是干什么的 ──────────────────────────────────────────
// 上生产是**在 VPS 上做的**（DNS / 证书 / nginx / visitor，见 `59` §九 那张照抄清单）。
// 那一步做完了怎么算"对"？—— 就是这个脚本：**一条命令，把该对的都对一遍**。
//
// ── 它验什么（每一条都带"错的时候会是什么样"）────────────
//   ① 制品口**真的在另一个原点**（N1）—— 写成同一个 origin 是这整套里最贵的错
//   ② 带签名的 URL 取得到（200 + 内容对）
//   ③ **没签名 / 改过签名**取不到（403）—— 制品是"凭签名取一次"，不是公开静态目录
//   ④ 响应头：有 CSP、**没有 `X-Frame-Options`**（发了它壳里就嵌不进去）
//   ⑤ 制品页的 CSP 里 `frame-ancestors` **包含壳**（不然浏览器照样不嵌）
//   ⑥ 🔴 **不认令牌**：带上 `Authorization: Bearer …` 也不影响（它本来就该无视它）
//
// ⚠️ **它不写任何东西、不碰别人的东西**：只发几个 GET。
// ⚠️ 用法（本机验收也一样能跑，那是它的"正对照"）：
//     HUPO_TOKEN=<令牌> node scripts/check-app-origin.mjs
//     HUPO_TOKEN=<令牌> HUPO_APPS_ORIGIN=https://apps.example node scripts/check-app-origin.mjs
//
// 🔴 **令牌不许写进任何文件**：现发、从环境进、用完就没了。

import nodeChildProcess from 'node:child_process';
import nodePath from 'node:path';
import nodeProcess from 'node:process';
import nodeUrl from 'node:url';

const HERE = nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url));
const CORE = nodePath.join(HERE, '..', 'v2', 'services', 'core');

const SHELL = nodeProcess.env.HUPO_SHELL_ORIGIN ?? 'https://w.stalkerai.cn';
/** 制品口在哪：默认取本机那个（本机验收）；上生产之后用 `HUPO_APPS_ORIGIN` 指过去。 */
const APPS = nodeProcess.env.HUPO_APPS_ORIGIN ?? 'http://127.0.0.1:8021';
/** API 在哪（签一条入口 URL 用）。 */
const API = nodeProcess.env.HUPO_API ?? 'http://127.0.0.1:8020';

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m) => {
  bad += 1;
  console.log(`  ✗ ${m}`);
};

/** 现发一个令牌（**只从内存里过**，不落盘）。 */
function token() {
  if (nodeProcess.env.HUPO_TOKEN) return nodeProcess.env.HUPO_TOKEN;
  const js = "import('./src/auth.js').then((m)=>{const a=new m.Auth({dataDir:process.env.HUPO_DATA??'data'});"
    + "process.stdout.write(a.issue({sub:'owner'}).token)});";
  return nodeChildProcess.execFileSync(nodeProcess.execPath, ['-e', js], { cwd: CORE, encoding: 'utf8' }).trim();
}

async function main() {
  console.log('① 制品口是不是**另一个原点**（手册 N1）');
  const appsOrigin = new URL(APPS).origin;
  const shellOrigin = new URL(SHELL).origin;
  if (appsOrigin === shellOrigin) {
    no(`制品口与壳**同源**（都是 ${appsOrigin}）—— 这一条不成立，整套就白做`);
  } else {
    ok(`制品口 ${appsOrigin} ≠ 壳 ${shellOrigin}`);
  }

  const tok = token();
  const listRes = await fetch(`${API}/api/apps`, { headers: { authorization: `Bearer ${tok}` } });
  if (listRes.status !== 200) {
    no(`拿不到清单（${listRes.status}）—— 先看服务在不在、令牌对不对`);
    return bad;
  }
  const list = (await listRes.json()).apps ?? [];
  if (list.length === 0) {
    console.log('  （这个人还没有自己的小程序 ⇒ 后面几条没得验；先造一个再跑）');
    return bad;
  }

  const one = list[0];
  console.log(`② 带签名的 URL 取得到（拿「${one.title}」试）`);
  const r = await fetch(one.entryUrl, { headers: { authorization: `Bearer ${tok}` } });
  if (r.status !== 200) {
    no(`带签名取不到：${r.status} —— DNS / 证书 / nginx / visitor 那一条链上有一处没通`);
  } else {
    const body = await r.text();
    ok(`200，拿到 ${body.length} 字节`);
    console.log('③ 响应头');
    const csp = r.headers.get('content-security-policy') ?? '';
    const xfo = r.headers.get('x-frame-options');
    if (!csp.includes("default-src 'none'")) no(`CSP 不对：${csp.slice(0, 80)}`);
    else ok('CSP 在，而且 default-src 是 none');
    if (xfo) no(`发了 X-Frame-Options：${xfo} —— 壳里就嵌不进去了`);
    else ok('没有 X-Frame-Options（壳里嵌得进去）');
    // ⚠️ 要**按那一节的值**判，不能拿子串找：`frame-ancestors a b` 是**一串**，
    //    壳可能排在第二个（第一次跑就是这么误报的）。
    const fa = /frame-ancestors([^;]*)/u.exec(csp)?.[1]?.trim().split(/\s+/u) ?? [];
    if (fa.includes(shellOrigin)) ok(`frame-ancestors 里有壳（${fa.join(' ')}）`);
    else no(`frame-ancestors 里没有壳（${shellOrigin}）；它写的是：${fa.join(' ') || '（空）'}`);

    console.log('④ 没签名 / 改过签名 ⇒ 取不到');
    const bare = one.entryUrl.split('?')[0];
    const b = await fetch(bare);
    if (b.status === 403 || b.status === 404) ok(`不带签名 ⇒ ${b.status}`);
    else no(`不带签名竟然拿到了：${b.status}`);
    const tampered = `${one.entryUrl}&x=1`.replace(/s=[0-9a-f]+/u, `s=${'0'.repeat(64)}`);
    const t = await fetch(tampered);
    if (t.status === 403) ok('假签名 ⇒ 403');
    else no(`假签名竟然拿到了：${t.status}`);

    console.log('⑤ 它**不认令牌**（带着也不影响 —— 它只认签名）');
    // ⚠️ 头里的值**只能是 ASCII**（塞中文会让 fetch 直接抛 —— 第一次跑就栽在这儿）
    const withTok = await fetch(one.entryUrl, { headers: { authorization: 'Bearer not-a-real-token' } });
    if (withTok.status === 200) ok('带了假令牌照样 200 ⇒ 说明它压根不看 Authorization');
    else no(`带了假令牌变成 ${withTok.status} ⇒ 它在看 Authorization（那就不该）`);
  }

  console.log('');
  console.log(bad === 0 ? '✅ 制品那个口这边对得上。' : `❌ 有 ${bad} 条不对（见上）。`);
  return bad;
}

main().then((n) => nodeProcess.exit(n === 0 ? 0 : 2)).catch((err) => {
  console.error(`✗ 自检本身出错了：${err?.stack ?? err}`);
  nodeProcess.exit(2);
});
