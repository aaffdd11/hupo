#!/usr/bin/env node
/**
 * remove-host-apps.mjs —— **删掉宿主编一份"旧的小程序库"**（P2-6 · B15 的最后一步）。
 *
 * 主人 2026-09-25 拍板：**乙 把宿主那份删掉**（`docs/dev/96-OWNER-DECISIONS.md`）。
 *
 * ── 删什么、不删什么 ──────────────────────────────────────
 *   删：**租户那几格** —— `<data>/users/<id>/hupo/apps/`
 *   🔴 **不删**：主人自己那份 **`<data>/hupo/apps/`**（**权威，一个字节都不许动**）
 *
 * ── 为什么必须先核对 ──────────────────────────────────────
 * 库已经改成"**以盒子为准**"（`apps-box.js`）：桌面读的是**盒子里**那份。
 * 宿主上那些旧的是**迁移残留**。删之前必须逐条核对：
 * 宿主那一版拿字节重算的 `rootHash`，能在盒子里找到**同一个** ——
 * **核对不上就不许删**（宁可留着，也不许把"盒子里没有的东西"从盘上抹掉）。
 *
 * ── 跑法 ──────────────────────────────────────────────────
 *   node scripts/remove-host-apps.mjs                 # **只看**：逐条核对 + 报"要删什么"
 *   node scripts/remove-host-apps.mjs --apply         # 真删（核对全过才删）
 *   node scripts/remove-host-apps.mjs --user u2 --apply
 *   node scripts/remove-host-apps.mjs --offline       # 不问服务，只列宿主那份有什么
 *
 * ── 四条不许破 ────────────────────────────────────────────
 *   ① 🔴 **默认只看**（dry-run）：一个字节都不动（审计也不写）。
 *   ② 🔴 **核对不上就不删**：有一个对不上 ⇒ 整格都不删、如实报。
 *   ③ **可重跑**：已经删过（那格空了）⇒ 报"没有要删的"，什么都不做。
 *   ④ 🔴 **只删租户那几格**：主人自己那份**从来不列进来**（这里只扫 `users/`），
 *      而且服务那一侧还有一道"认出主人那份就停"的闸（`protectRoots`）。
 *
 * ── 为什么要连服务（而不是自己删）─────────────────────────
 * 宿主**看不到**盒子的卷，而那条**现有隧道**只有正在跑的服务手上有 ⇒
 * "读盒里清单与 rootHash"这件事只能由服务经隧道代做。这一份脚本只负责
 * **说清要什么、把报告念给人听**（与 `migrate-apps-to-box.mjs` 同一条规矩）。
 *
 * ⚠️ 服务没在跑 ⇒ **如实说核对不了**（`--apply` 非零退出），绝不假装删过了。
 */

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { Apps } from '../v2/services/core/src/apps.js';
import { auditPath } from '../v2/services/core/src/audit.js';
import { describePruneReport, migrateCall, migrateSocketPath, pruneHostApps } from '../v2/services/core/src/apps-migrate.js';

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
    users,
    dataDir: flag('--data', DEFAULT_DATA),
    socketPath: flag('--socket', null),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

const USAGE = `用法：node scripts/remove-host-apps.mjs [--apply] [--user u2] [--offline] [--data <目录>] [--socket <路径>]

  （默认只看：逐条核对盒里那份，只报告。加 --apply 才真删。）
  🔴 只删租户那几格 <data>/users/<id>/hupo/apps/；主人自己那份 <data>/hupo/apps/ 一个字都不动。`;

/** 宿主上那几格里"谁可能有旧库"：`<data>/users/*` 那几个目录（**主人不在这里**）。 */
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

/** **不问服务**时能说的那点实话：宿主那份里有什么（一个字节都不动）。 */
function offlineReport(userId, dataDir, fs = nodeFs) {
  const apps = new Apps({ dir: nodePath.join(dataDir, 'users', userId), sub: userId, fs });
  let list = [];
  try {
    list = apps.list();
  } catch (err) {
    return [`【${userId}】宿主那份读不出来：${err?.message ?? err}`];
  }
  if (list.length === 0) return [`【${userId}】宿主那份是空的（没有要删的）。`];
  const lines = [`【${userId}】宿主那份里有 ${list.length} 个小程序（**还没核对**盒里那份）：`];
  for (const a of list) lines.push(`  ${a.id}（第 ${a.version} 版 · ${a.bytes} 字节 · ${a.rootHash.slice(0, 12)}…）`);
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
  console.log('🔴 只删租户那几格（users/<id>/hupo/apps/）；主人自己那份（hupo/apps/）一个字节都不动。');
  if (users.length === 0) {
    console.log('  没有要看的用户（<data>/users 下面是空的）。');
    return 0;
  }

  const hasSocket = nodeFs.existsSync(socketPath);
  if (opt.offline || !hasSocket) {
    for (const u of users) for (const line of offlineReport(u, dataDir)) console.log(line);
    if (!hasSocket) {
      console.log(`  ⚠️ 维护口不在（${socketPath}）⇒ **核对不了盒里那份**。`);
      console.log('     （读盒里 `rootHash` 要经隧道，而隧道只有正在跑的那个服务手上有。）');
    }
    if (opt.apply) {
      console.log('✗ 核对不了 ⇒ **不删**（这一趟什么都没动）。');
      return 2;
    }
    console.log('（只看模式：什么都没动。服务在跑的时候再跑一遍就有盒里那份的对照了。）');
    return 0;
  }

  let bad = 0;
  const ownerRoot = nodePath.join(dataDir, 'hupo', 'apps');
  const auditFile = auditPath(dataDir);
  for (const u of users) {
    const hostApps = new Apps({ dir: nodePath.join(dataDir, 'users', u), sub: u });
    // ⚠️ "读盒里清单与 rootHash"这件事**只有正在跑的服务做得到**（隧道在它手上）——
    //    而那条路已经有了：`plan` 作业逐条拿宿主字节重算 hash、与盒里那份比。
    const plan = async () => {
      const r = await migrateCall({ socketPath, msg: { op: 'plan', user: u } });
      if (!r?.ok) throw new Error(r?.text ?? r?.error ?? '问不出盒里那份');
      return r.report;
    };
    let report;
    try {
      report = await pruneHostApps({
        userId: u,
        hostApps,
        plan,
        apply: opt.apply,
        protect: [ownerRoot],
        auditFile,
      });
    } catch (err) {
      console.log(`【${u}】✗ 核对不了 ⇒ **不删**：${err?.message ?? err}`);
      bad += 1;
      continue;
    }
    console.log(describePruneReport(report));
    if (report.blocked) bad += 1;
  }
  return bad > 0 ? 2 : 0;
}

process.exit(await main());
