#!/usr/bin/env node
/**
 * migrate-app-workspaces.mjs —— **把主目录里的小程序搬进它自己的工作区**。
 *
 * 契约：`docs/dev/83-APP-WORKSPACE.md` §三·6（判据 A6）。
 *
 * ── 它解决什么 ────────────────────────────────────────────
 * 今天（2026-09-24 进盒子看到的）：
 *
 *     /data/workspaces              ← **空的**（没有任何东西在建子工作区）
 *     /data/main/city-weather/      ← 6.7KB 的单文件小程序**躺在主目录里**
 *     /data/hupo/apps               ← 不存在
 *
 * ⇒ 这一趟把它搬成：
 *
 *     /data/workspaces/city-weather/   ← 与主目录**平行**（手册 §2.2 第二条）
 *     /data/hupo/apps/city-weather/versions/1/   ← 登记成 app（快照）
 *
 * ── 三条不许破 ────────────────────────────────────────────
 *   ① 🔴 **内容逐字节不变**（判据 A6）：先 `rename`（同一个文件系统上就是原子的），
 *      跨设备时才退化成"拷过去 → **逐字节核对** → 再删源"。
 *   ② 🔴 **可重跑**：第二次跑时源已经没了 ⇒ 那一条报 `skipped`，**什么都不动**；
 *      已经登记过的 app **不再开新版本**（版本不可变）。
 *   ③ 🔴 **一次性的**：逻辑只住这一个文件，**不许**在服务代码里到处撒
 *      （开机不自动搬、路由不顺手搬 —— 那种"到处撒"正是这次要修的病）。
 *
 * ── 跑法 ──────────────────────────────────────────────────
 *   node scripts/migrate-app-workspaces.mjs                # 只看计划（**不动任何东西**）
 *   node scripts/migrate-app-workspaces.mjs --apply        # 真搬
 *   node scripts/migrate-app-workspaces.mjs --apply --only city-weather
 *   node scripts/migrate-app-workspaces.mjs --data /data --main /data/main
 *
 * ⚠️ 默认是**只看**（dry-run）：搬东西是不可逆的，先让人看清楚要搬哪几个。
 * ⚠️ 盒子里**不许用 root 跑**（`81-HARNESS-ENTRY.md` §9.3）—— 用那个租户自己的身份。
 */

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { Apps, checkAppId, sha256hex } from '../v2/services/core/src/apps.js';
import { AppWorkspaces, scopeDirFor, snapshotWorkspace, workspacesRoot } from '../v2/services/core/src/workspace.js';

/** 主目录下这一层里，哪些名字像"一个小程序"。 */
export function scanMainDirs(mainDir, { fs = nodeFs } = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(mainDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !String(e.name).startsWith('.'))
    .map((e) => e.name)
    .sort();
}

/** 一棵树里每个文件相对根的名字（**不跟符号链接**，跳过隐藏文件）。 */
export function walkTree(root, { fs = nodeFs } = {}) {
  const out = [];
  const walk = (rel) => {
    const here = rel === '' ? root : nodePath.join(root, rel);
    for (const e of fs.readdirSync(here, { withFileTypes: true })) {
      if (String(e.name).startsWith('.')) continue;
      const next = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isSymbolicLink()) continue; // 不跟：跟出去就可能把"搬这一份"变成"搬到别处"
      if (e.isDirectory()) walk(next);
      else if (e.isFile()) out.push(next);
    }
  };
  walk('');
  return out.sort();
}

function copyTree(from, to, { fs }) {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const rel of walkTree(from, { fs })) {
    const src = nodePath.join(from, rel);
    const dst = nodePath.join(to, rel);
    fs.mkdirSync(nodePath.dirname(dst), { recursive: true, mode: 0o700 });
    fs.writeFileSync(dst, fs.readFileSync(src), { mode: 0o600 });
  }
}

/**
 * **逐字节核对两棵树**（判据 A6 的红线就是"搬丢了"）。
 * @returns {string[]} 对不上的地方（空数组 = 一模一样）
 */
export function compareTrees(from, to, { fs = nodeFs } = {}) {
  const a = walkTree(from, { fs });
  const b = walkTree(to, { fs });
  const bad = [];
  for (const rel of a) {
    if (!b.includes(rel)) {
      bad.push(`${rel}：搬过去就没有了`);
      continue;
    }
    const ha = sha256hex(fs.readFileSync(nodePath.join(from, rel)));
    const hb = sha256hex(fs.readFileSync(nodePath.join(to, rel)));
    if (ha !== hb) bad.push(`${rel}：内容对不上`);
  }
  return bad;
}

/** 搬一棵树：优先 `rename`（同一文件系统上是原子的），跨设备才拷＋核对＋删。 */
function moveTree(from, to, { fs }) {
  try {
    fs.renameSync(from, to);
    return 'rename';
  } catch (err) {
    if (err?.code !== 'EXDEV') throw err;
    copyTree(from, to, { fs });
    const bad = compareTrees(from, to, { fs });
    if (bad.length > 0) {
      // ⚠️ **靠不住的那一侧**：宁可留着一个半份报出来，也不许删源
      throw new Error(`拷过去之后对不上（**源没删**）：${bad.join('；')}`);
    }
    fs.rmSync(from, { recursive: true, force: true });
    return 'copy';
  }
}

/**
 * **一趟迁移**（纯函数式：给什么目录就搬什么目录；不读全局配置）。
 *
 * @param {object} o
 * @param {string} o.dataDir        他那一格的根（盒子里是 `/data`）
 * @param {string} [o.mainDir]      主目录（默认 `<dataDir>/main`）
 * @param {string|null} [o.only]    只搬这一个（默认全部像 app 的）
 * @param {boolean} [o.apply]       **false = 只看计划**（默认）
 * @param {object} [o.fs]
 * @param {()=>number} [o.now]
 * @param {(m:string)=>void} [o.log]
 * @returns {{dataDir:string, mainDir:string, apply:boolean, moved:object[], skipped:object[], conflicts:object[], registered:object[]}}
 */
export function migrateAppWorkspaces({
  dataDir,
  mainDir = null,
  only = null,
  apply = false,
  fs = nodeFs,
  now = Date.now,
  log = () => {},
}) {
  if (!dataDir) throw new Error('dataDir 必填');
  const main = mainDir ?? nodePath.join(dataDir, 'main');
  const report = {
    dataDir,
    mainDir: main,
    apply,
    moved: [],
    skipped: [],
    conflicts: [],
    registered: [],
  };
  if (!fs.existsSync(main)) {
    // ⚠️ **如实说**：主目录都不在，就别说"搬完了"
    report.skipped.push({ id: null, why: `主目录不在：${main}` });
    return report;
  }

  const workspaces = new AppWorkspaces({ dir: dataDir, fs, now });
  const apps = new Apps({ dir: dataDir, sub: null, fs, now });

  for (const name of scanMainDirs(main, { fs })) {
    if (only && name !== only) continue;
    let id;
    try {
      id = checkAppId(name);
    } catch (err) {
      // 主目录里那些**不像 app 名字**的目录（`My Project` / 带点的）**不动**
      report.skipped.push({ id: null, name, why: err.message });
      continue;
    }
    const from = nodePath.join(main, id);
    let to;
    try {
      // ⚠️ `scopeDirFor` 会拒掉保留名（`main`）：那种名字进不了工作区那一层
      to = scopeDirFor(dataDir, id);
    } catch (err) {
      report.skipped.push({ id, why: err.message });
      continue;
    }
    if (!fs.existsSync(nodePath.join(from, 'index.html'))) {
      // ⚠️ **不猜**：没有入口就不像一个小程序，动它才是危险的
      report.skipped.push({ id, why: '不像一个小程序（顶层没有 index.html）' });
      continue;
    }
    if (fs.existsSync(to)) {
      report.conflicts.push({ id, from, to, why: '目标已经在了（**两边都有**，不敢覆盖）' });
      continue;
    }
    if (!apply) {
      report.moved.push({ id, from, to, applied: false });
      continue;
    }

    fs.mkdirSync(workspacesRoot(dataDir), { recursive: true, mode: 0o700 });
    const how = moveTree(from, to, { fs });
    // ① 骨架清单（⚠️ **不写占位 index.html**：它已经有了，而且内容必须原样）
    workspaces.ensure(id, { title: id, entry: 'index.html', at: now() });
    // ② 登记成 app（登记过就不再开新版本 —— 版本不可变）
    const already = apps.current(id);
    if (already === null) {
      const snap = snapshotWorkspace({
        apps,
        workspaces,
        id,
        title: id,
        icon: undefined,
        entry: null,
        createdBy: 'user',
      });
      report.registered.push({ id, version: snap.manifest.version, files: snap.files });
    } else {
      report.registered.push({ id, version: already, already: true });
    }
    report.moved.push({ id, from, to, applied: true, how });
    log(`  ✔ ${id}：${from} → ${to}（${how}）`);
  }
  return report;
}

/** 人看得懂的一段话（CLI 与测试都可以用）。 */
export function describeReport(report, { wrote } = {}) {
  const lines = [];
  lines.push(`数据目录 ${report.dataDir}`);
  lines.push(`主目录   ${report.mainDir}${report.apply ? '' : '（**只看，不会动**）'}`);
  for (const m of report.moved) {
    lines.push(`  ${m.applied ? '搬了' : '要搬'} ${m.id}：${m.from} → ${m.to}`);
  }
  for (const r of report.registered) {
    lines.push(`  ${r.already ? '已登记' : '登记成 app'} ${r.id}（第 ${r.version} 版）`);
  }
  for (const s of report.skipped) {
    lines.push(`  跳过 ${s.name ?? s.id ?? '—'}：${s.why}`);
  }
  for (const c of report.conflicts) {
    lines.push(`  ⚠️ 冲突 ${c.id}：${c.why}`);
  }
  if (report.moved.length === 0 && report.conflicts.length === 0) {
    lines.push('  没有要搬的（主目录里已经没有任何小程序）。');
  }
  if (!report.apply && report.moved.length > 0) {
    lines.push('加 --apply 才真搬。');
  }
  if (wrote) lines.push(`已写入：${wrote}`);
  return lines.join('\n');
}

// ── CLI ────────────────────────────────────────────────────
const isMain = process.argv[1] && nodePath.resolve(process.argv[1]) === nodePath.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (name, fallback = null) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1] ?? fallback;
  };
  const dataDir = flag('--data', process.env.HUPO_DATA ?? nodePath.resolve(process.cwd(), 'data'));
  const mainDir = flag('--main', null);
  const only = flag('--only', null);
  const apply = argv.includes('--apply');
  const report = migrateAppWorkspaces({ dataDir, mainDir, only, apply, log: (m) => console.log(m) });
  console.log(describeReport(report));
  // ⚠️ 有冲突就**非零退出**（不然脚本会被人接在 `&&` 后面当成"成功了"）
  process.exit(report.conflicts.length > 0 ? 2 : 0);
}
