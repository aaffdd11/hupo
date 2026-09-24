#!/usr/bin/env node
/**
 * migrate-apps-to-box.mjs —— **把宿主那份旧的小程序库推进盒子**（B15）。
 *
 * 契约：`docs/dev/77-BLOCKERS.md` 的 B15 那一行（主人 2026-09-25 拍板：**以盒子为准**）。
 *
 * ── 它解决什么 ────────────────────────────────────────────
 * 小程序库曾经"两处并存"：**桌面读宿主那份、助手写盒子里那份**
 * ⇒ 主人新做的小程序**永远不上桌面**（页面在说假话）。
 * 库已经改成"以盒子为准"之后，宿主上那些**旧的**（`u2` 的 `tianqi-probe` / `wenda`）
 * 还得搬进他自己的盒子 —— 否则他一刷新就**再也看不到**它们。
 *
 * ── 跑法 ──────────────────────────────────────────────────
 *   node scripts/migrate-apps-to-box.mjs                  # **只看**：要搬哪几个（不动任何东西）
 *   node scripts/migrate-apps-to-box.mjs --apply          # 真搬
 *   node scripts/migrate-apps-to-box.mjs --user u2 --apply
 *   node scripts/migrate-apps-to-box.mjs --user u2 --only wenda --apply
 *   node scripts/migrate-apps-to-box.mjs --offline        # 不问服务，只列宿主那份有什么
 *
 * ── 三条不许破 ────────────────────────────────────────────
 *   ① 🔴 **默认只看**（dry-run）：一个字节都不发。`--apply` 才动。
 *   ② 🔴 **可重跑**：盒子里已有同一个 hash ⇒ 什么都不写；已有别的 ⇒ 报冲突、不动它。
 *   ③ 🔴 **宿主那份不删**：这一步只"推过去"，一个字节都不从宿主上删。
 *
 * ── 为什么要连服务（而不是自己搬）─────────────────────────
 * 宿主**看不到**盒子的卷，又**不许**用 root 写容器的卷（`81-HARNESS-ENTRY.md` §9.3），
 * 而那条**现有隧道**只有正在跑的服务手上有 ⇒ 作业递给它，由它经隧道推进盒子自己那条
 * app 写入路（`Apps.create()`）。这一份脚本只负责**说清要什么、把报告念给人听**。
 *
 * ⚠️ 服务没在跑 ⇒ **如实说搬不了**（`--apply` 非零退出），绝不假装"搬完了"。
 */

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { Apps } from '../v2/services/core/src/apps.js';
import { describeMigrateReport, migrateCall, migrateSocketPath } from '../v2/services/core/src/apps-migrate.js';

const HERE = import.meta.dirname;
const DEFAULT_DATA = process.env.HUPO_DATA ?? nodePath.resolve(HERE, '..', 'v2/services/core/data');

function parseArgs(argv) {
  const flag = (name, fallback = null) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1] ?? fallback;
  };
  const users = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--user' && argv[i + 1]) users.push(...String(argv[i + 1]).split(',').map((s) => s.trim()).filter(Boolean));
  }
  return {
    apply: argv.includes('--apply'),
    offline: argv.includes('--offline'),
    only: flag('--only'),
    users,
    dataDir: flag('--data', DEFAULT_DATA),
    socketPath: flag('--socket', null),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

const USAGE = `用法：node scripts/migrate-apps-to-box.mjs [--apply] [--user u2] [--only <app>] [--offline] [--data <目录>] [--socket <路径>]

  （默认只看计划；加 --apply 才真搬。宿主那份不会被删。）`;

/** 宿主上那几格里"谁有旧库要搬"：`<data>/users/*` 那几个目录。 */
function discoverUsers(dataDir, fs = nodeFs) {
  const root = nodePath.join(dataDir, 'users');
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  return names;
}

/** **不问服务**时能说的那点实话：宿主那份里有什么。 */
function offlineReport(userId, dataDir, fs = nodeFs) {
  const apps = new Apps({ dir: nodePath.join(dataDir, 'users', userId), sub: userId, fs });
  let list = [];
  try {
    list = apps.list();
  } catch (err) {
    return [`【${userId}】宿主那份读不出来：${err?.message ?? err}`];
  }
  const lines = [`【${userId}】宿主那份里有 ${list.length} 个小程序（**只列了宿主这边**）：`];
  for (const a of list) lines.push(`  ${a.id}（第 ${a.version} 版 · ${a.bytes} 字节 · ${a.entry}）`);
  return lines;
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) {
    console.log(USAGE);
    return 0;
  }
  const dataDir = nodePath.resolve(opt.dataDir);
  const socketPath = opt.socketPath ? nodePath.resolve(opt.socketPath) : migrateSocketPath(dataDir);
  const users = opt.users.length > 0 ? opt.users : discoverUsers(dataDir);

  console.log(`数据目录 ${dataDir}`);
  console.log(`维护口   ${socketPath}`);
  if (users.length === 0) {
    console.log('  没有要看的用户（<data>/users 下面是空的）。');
    return 0;
  }

  const hasSocket = nodeFs.existsSync(socketPath);
  if (opt.offline || !hasSocket) {
    for (const u of users) for (const line of offlineReport(u, dataDir)) console.log(line);
    if (!hasSocket) {
      console.log(`  ⚠️ 维护口不在（${socketPath}）⇒ **问不到盒子那一侧**。`);
      console.log('     （搬这件事要经隧道，而隧道只有正在跑的那个服务手上有。）');
    }
    if (opt.apply) {
      console.log('✗ 服务没在跑 ⇒ **搬不了**（这一趟什么都没动）。');
      return 2;
    }
    console.log('（只看模式：什么都没动。服务在跑的时候再跑一遍就有盒子里那份的对照了。）');
    return 0;
  }

  let bad = 0;
  for (const u of users) {
    let reply;
    try {
      reply = await migrateCall({
        socketPath,
        msg: { op: opt.apply ? 'push' : 'plan', user: u, ...(opt.only ? { only: opt.only } : {}) },
      });
    } catch (err) {
      console.log(`【${u}】✗ 没问成：${err?.message ?? err}`);
      bad += 1;
      continue;
    }
    if (!reply?.ok) {
      console.log(`【${u}】✗ ${reply?.text ?? reply?.error ?? '没答上来'}`);
      continue;
    }
    const report = reply.report;
    console.log(describeMigrateReport(report));
    bad += (report.conflicts?.length ?? 0) + (report.failed?.length ?? 0);
  }
  return bad > 0 ? 2 : 0;
}

process.exit(await main());
