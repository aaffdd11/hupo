#!/usr/bin/env node
/**
 * install-app-into-user.mjs —— **把开发机上的一份小程序源码装进某个人的盒子**。
 *
 * ── 它解决什么 ────────────────────────────────────────────
 * 小程序库**以盒子为准**（B15）：他在桌面上看到的那一格，是他**盒子里**那一份。
 * 而宿主**看不到**盒子的卷，也**不许**用 root 去写容器的卷 —— 那条隧道只有
 * **正在跑的那个服务**手上有。⇒ 装这一版这件事只能由服务经隧道推过去，
 * 落在**盒子自己那条写路**（`Apps.create()`）上：版本号 / 清单 / 权限 / 审计语义
 * 与助手在盒里自己造 app **逐字相同**。
 *
 * ── 和 `migrate-apps-to-box.mjs` 的分工 ────────────────────
 *   · `migrate-apps-to-box.mjs`：**存量搬迁**（宿主那份旧库 → 盒里），
 *     规矩是"版本不可变：盒里已有同名、hash 不同 ⇒ 报冲突、不动它"。
 *   · 这一份：**我自己做好一版装给他** —— 盒里已有同名就**照装**（那是**新的一版**，
 *     老那一版在盒里原样留着）。**要改一个小程序就用这一条。**
 *
 * ── 跑法 ──────────────────────────────────────────────────
 *   node scripts/install-app-into-user.mjs apps-src/futures-trade --user u2            # 只看（不动任何东西）
 *   node scripts/install-app-into-user.mjs apps-src/futures-trade --user u2 --apply    # 真装
 *
 * ── 三条不许破 ────────────────────────────────────────────
 *   ① 🔴 **默认只看**：读源码、跑制品自查、把"要装成什么样"念出来；`--apply` 才动。
 *   ② 🔴 **装完读回来核**（服务那一侧逐个 sha256 + rootHash）——
 *      回执里 `verified:true` 才是真的到盒里了，不是"我们发出去了"。
 *   ③ 🔴 **声明一起装**（`permissions` / `net` / `tasks`）：丢了声明，盒里那一版
 *      就是另一样东西（页面上就是"取不到数据"，而两边都以为配好了）。
 *
 * ⚠️ 源码目录里那份 `app.json` 是这一版的说明：`id` / `title` / `icon` / `entry` /
 *    `permissions` / `net` / `tasks`（`note` 只是给人看的，不进制品）。
 */

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { lintApp, lintReport } from '../v2/services/core/src/app-lint.js';
import { migrateCall, migrateSocketPath } from '../v2/services/core/src/apps-migrate.js';

const HERE = import.meta.dirname;
const DEFAULT_DATA = process.env.HUPO_DATA ?? nodePath.resolve(HERE, '..', 'v2/services/core/data');
/** 一行最长多少（与 `apps-migrate.js` 那条同一个量级）—— base64 之后还要余量。 */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

const USAGE = `用法：node scripts/install-app-into-user.mjs <源码目录> --user <谁> [--apply] [--data <目录>] [--socket <路径>] [--force]

  源码目录里要有 app.json（id/title/icon/entry/permissions/net/tasks）+ 页面那几份文件。
  （默认只看：读源码、跑制品自查、说要装成什么样；加 --apply 才真装。）
  --force  制品自查有 errors 时也照装（不推荐 —— 那些 errors 到了屏幕上就是"点了没反应"）`;

function parseArgs(argv) {
  const flag = (name, fallback = null) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1] ?? fallback;
  };
  const pos = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      if (['--user', '--data', '--socket'].includes(argv[i])) i += 1;
      continue;
    }
    pos.push(argv[i]);
  }
  return {
    src: pos[0] ?? null,
    user: flag('--user'),
    apply: argv.includes('--apply'),
    force: argv.includes('--force'),
    dataDir: flag('--data', DEFAULT_DATA),
    socketPath: flag('--socket', null),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

/** 源码目录里那几份文件（递归；`app.json` 是说明、不进制品；点开头的路径一律不要）。 */
function readSource(dir, fs = nodeFs) {
  const files = {};
  let bytes = 0;
  const walk = (rel) => {
    for (const name of fs.readdirSync(nodePath.join(dir, rel)).sort()) {
      if (name.startsWith('.')) continue; // 隐藏路径：制品那边写入侧本来就拒（`refuseHiddenRelPath`）
      const r = rel ? `${rel}/${name}` : name;
      const abs = nodePath.join(dir, r);
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        walk(r);
        continue;
      }
      if (!st.isFile()) continue;
      if (r === 'app.json') continue;
      const buf = fs.readFileSync(abs);
      files[r] = buf;
      bytes += buf.length;
    }
  };
  walk('');
  return { files, bytes };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || !a.src) {
    console.log(USAGE);
    process.exit(a.help ? 0 : 2);
  }
  const dir = nodePath.resolve(a.src);
  if (!nodeFs.existsSync(nodePath.join(dir, 'app.json'))) {
    console.error(`✗ ${dir} 里没有 app.json —— 这一份源码缺"这一版是什么"那一段。`);
    process.exit(2);
  }
  if (!a.user) {
    console.error('✗ 要给一个 --user（像 u2 这种）。');
    process.exit(2);
  }

  let cfg = null;
  try {
    cfg = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, 'app.json'), 'utf8'));
  } catch (err) {
    console.error(`✗ app.json 看不懂：${err?.message ?? err}`);
    process.exit(2);
  }
  const { files, bytes } = readSource(dir);
  const permissions = Array.isArray(cfg.permissions) ? cfg.permissions : [];
  const net = Array.isArray(cfg.net) ? cfg.net : [];
  const tasks = Array.isArray(cfg.tasks) ? cfg.tasks : [];
  const entry = typeof cfg.entry === 'string' && cfg.entry !== '' ? cfg.entry : 'index.html';
  if (!cfg.id || !cfg.title) {
    console.error('✗ app.json 里 id 与 title 都要有。');
    process.exit(2);
  }
  if (!files[entry]) {
    console.error(`✗ 入口文件不在这一份里：${entry}`);
    process.exit(2);
  }

  // ── 制品自查（与 `app_create` 那条回执同一份规则）
  const lint = lintApp({ files, permissions, net, tasks, title: cfg.title });
  const report = lintReport(lint);

  console.log(`【${a.user}】${a.apply ? '真装' : '只看（不会动任何东西）'} · ${cfg.title}（${cfg.id}）`);
  console.log(`  源码　${dir}`);
  console.log(`  文件　${Object.keys(files).length} 个 · ${bytes} 字节 · 入口 ${entry}`);
  console.log(`  声明　权限 ${permissions.length ? permissions.join('、') : '（无）'}` +
    ` · 联网名单 ${net.length ? net.join('、') : '（无）'}` +
    ` · 定时任务 ${tasks.length} 件`);
  if (report) console.log(report);
  else console.log('  自查　✅ 一条要改的都没有。');

  if (lint.errors.length > 0 && !a.force) {
    console.error('\n✗ 制品自查有 errors ⇒ 不装（那些到了屏幕上就是"点了没反应"）。要照装就加 --force。');
    process.exit(2);
  }

  if (!a.apply) {
    console.log('\n加 --apply 才真装（会落成他盒子里**新的一版**）。');
    return;
  }

  // ── 递作业给服务（它手上有那条隧道）
  const socketPath = a.socketPath ?? migrateSocketPath(a.dataDir);
  const payload = {};
  for (const [rel, buf] of Object.entries(files)) payload[rel] = buf.toString('base64');
  const line = JSON.stringify({
    op: 'install',
    user: a.user,
    app: { id: cfg.id, title: cfg.title, icon: cfg.icon ?? null, entry, files: payload, permissions, net, tasks },
  });
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    console.error(`✗ 这一份太大了（${Buffer.byteLength(line, 'utf8')} 字节 > ${MAX_LINE_BYTES}）—— 那条维护口一行装不下。`);
    process.exit(2);
  }

  let reply;
  try {
    reply = await migrateCall({ socketPath, msg: JSON.parse(line) });
  } catch (err) {
    console.error(`✗ 递不进去：${err?.message ?? err}`);
    console.error('  （服务没在跑？维护口在 ' + socketPath + '，只有它手上有那条隧道。）');
    process.exit(2);
  }
  if (reply?.ok !== true) {
    console.error(`✗ 没装成：${reply?.text ?? reply?.error ?? '（服务没答话）'}`);
    process.exit(2);
  }
  const it = reply.install;
  console.log(`\n✔ 装上了：${it.id} 第 ${it.version} 版 · ${it.files} 个文件 · ${it.bytes ?? '?'} 字节`);
  console.log(`  rootHash ${String(it.rootHash).slice(0, 12)}… · 读回来核过：${it.verified === true ? '是（逐个 sha256）' : '**没有**'}`);
  console.log(`  盒里那一版的声明：权限 ${(it.permissions ?? []).join('、') || '（无）'} · 名单 ${(it.net ?? []).join('、') || '（无）'} · 定时任务 ${it.tasks ?? 0} 件`);
  if (reply.sameAsSent !== true) {
    console.log('  ⚠️ 盒里那一版算出来的 rootHash 与发出去的不一样 —— 请核一遍（这不该发生）。');
    process.exit(3);
  }
  console.log(`\n他那边：打开琥珀就能看到「${cfg.title}」这一格（要联网的话，第一次打开时会问他一遍）。`);
}

main().catch((err) => {
  console.error(`✗ ${err?.stack ?? err}`);
  process.exit(1);
});
