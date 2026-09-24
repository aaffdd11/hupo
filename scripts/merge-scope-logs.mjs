#!/usr/bin/env node
/**
 * merge-scope-logs.mjs —— **把每间分出去的那份日志并回那一条**。
 *
 * 契约：`docs/dev/84-DISPATCHER-FOCUS.md` §六（判据 F1 · 分期 B 的迁移那一半）。
 *
 * ── 它解决什么 ────────────────────────────────────────────
 * `#121`（`docs/dev/83-APP-WORKSPACE.md`）给每个 scope 各落了一份
 * `scope-<id>.jsonl`，**各自从 1 开始编号**。那与手册 `05-DECISIONS.md` **P-l**
 * 「**一条可见时间线 = 一条日志**；多作用域只是事件上的标签，不是并列的计数器」
 * **相反**。代码已经收回（一个 scope 一层视图、同一条日志、同一套号），
 * 但**盘上已经分出去的那些文件**要这一趟搬回来：
 *
 *     <dir>/main.jsonl            ← 主线（一条线）
 *     <dir>/scope-alpha.jsonl     ← 甲那间（自己从 1 起）
 *     <dir>/scope-beta.jsonl      ← 乙那间（自己从 1 起）
 *   ⇒
 *     <dir>/main.jsonl            ← **一条线**：所有事件按 `at` 归并、重新统一编号
 *     <dir>/scope-alpha.merged.jsonl   ← **旧文件不删**（改名留作证据）
 *     <dir>/scope-beta.merged.jsonl
 *     <dir>/log-merge-evidence/<戳>/main.jsonl   ← 并之前那份时间线的**逐字节快照**
 *     <dir>/log-merge-evidence/<戳>/report.json  ← 各文件 sha ＋ **哪些号变了**
 *
 * ── 四条不许破 ────────────────────────────────────────────
 *   ① 🔴 **默认 dry-run**：不加 `--apply` 一个字节都不动（先把"哪些号变了"看清楚）。
 *   ② 🔴 **可重跑**：并过的第二次一律报 `skipped`（`*.merged.jsonl` ＋ 台账里的 sha）。
 *   ③ 🔴 **旧文件不删**：改成 `*.merged.jsonl` 留着；并之前算 sha（逐字节可核对）。
 *   ④ 🔴 **一条线、不跳号**：归并后 `seq = 1..N`（跑完可以直接用 `store.verifyMonotonic` 复核）。
 *   ⑤ 🔴 **补标签**：`#121` 那套里只有 `user/echo` / `message/start` 带 `scopeId`，
 *      其余的靠"住在哪个文件里"说明归属 —— 并成一条之后那个信息就没了，
 *      所以从 `scope-<id>.jsonl` 读出来、没有标签的事件要**补上那个 id**
 *      （不补 ⇒ 房间看不到自己的后半句，主线却冒出别人的回答）。补了几条**如实报**。
 *
 * ── 跑法（**只在盒子里、按租户身份**）────────────────────────
 *   node scripts/merge-scope-logs.mjs --dir /data              # 只看计划
 *   node scripts/merge-scope-logs.mjs --dir /data --apply      # 真并
 *
 * ⚠️ **只在盒子里跑**：数据在他自己盒子里（契约 §六末条），**宿主侧不留副本**。
 * 🔴 **不许拿 root 在盒子里乱写**（`81-HARNESS-ENTRY.md` §9.3）：盒子里服务是
 *    root、干活的是 agent（uid 1000）。以 root 跑就必须给 `HUPO_AGENT_UID`
 *    （照着 `socket-owner.mjs` 那条实测规矩），把**新写出来的**文件交给它；
 *    给不出来就**拒绝跑** —— 否则写出一份 agent 读不到（EACCES）的日志，
 *    而那种故障看起来只是"它失忆了"。
 *
 * ── 它只做这一件事 ────────────────────────────────────────
 * ⚠️ 逻辑只住这一个文件、**只手动跑一次**：开机不自动并、路由不顺手并
 *    （"到处撒"正是 `83` 那批要修的另一种病）。
 */

import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { agentOwnerFromEnv } from '../v2/services/core/src/socket-owner.mjs';
// ★ T6（契约 `docs/dev/88-P1-TIME-WAIT.md` §四）：**只在没人握着那条日志时**才许并。
//   理由见 `src/serve-lock.js` 文件头与 `00-PROGRESS.md` #123 的实测记录。
import { isStoreHot } from '../v2/services/core/src/serve-lock.js';

/** 那条日志的文件名（`Store.pathFor('main')` 的落点）。**只有这一处**。 */
export const MAIN_LOG = 'main.jsonl';

/** 台账 / 证据目录的名字（在数据目录下面）。 */
export const EVIDENCE_DIR = 'log-merge-evidence';

/** `scope-<id>.jsonl`（**还没并**的）。 */
const SCOPE_RE = /^scope-([a-z0-9][a-z0-9-]*)\.jsonl$/;
/** `scope-<id>.merged.jsonl`（**已经并过**的证据）。 */
const MERGED_RE = /^scope-([a-z0-9][a-z0-9-]*)\.merged\.jsonl$/;
/** 证据目录里那本台账（记"哪一份文件、sha 多少、已经并过"）。 */
const LEDGER = 'merged.json';

/** sha256（十六进制）。**与 `apps.js` 同一个算法**（只是不引它，脚本要能独立跑）。 */
export function sha256hex(data) {
  return nodeCrypto.createHash('sha256').update(data).digest('hex');
}

/** `scope-*.jsonl` / `scope-*.merged.jsonl` 扫一遍（排好序，认不出就丢）。 */
export function scanScopeLogs(dir, { fs = nodeFs } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { pending: [], merged: [] };
  }
  const pending = [];
  const merged = [];
  for (const name of names.sort()) {
    const p = nodePath.join(dir, name);
    let buf;
    try {
      if (!fs.statSync(p).isFile()) continue;
      buf = fs.readFileSync(p);
    } catch {
      continue;
    }
    const m = SCOPE_RE.exec(name);
    if (m) {
      pending.push({ id: m[1], name, path: p, sha256: sha256hex(buf), bytes: buf.length });
      continue;
    }
    const g = MERGED_RE.exec(name);
    if (g) {
      merged.push({ id: g[1], name, path: p, sha256: sha256hex(buf), bytes: buf.length });
    }
  }
  return { pending, merged };
}

/** 读一条日志（坏行**不许静默跳过**：报出来并标冲突）。 */
export function readLog(file, { fs = nodeFs } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { events: [], bytes: 0, sha256: null, bad: [] };
    throw err;
  }
  const buf = Buffer.from(text, 'utf8');
  const events = [];
  const bad = [];
  let lineNo = 0;
  for (const raw of text.split('\n')) {
    lineNo += 1;
    if (raw.trim() === '') continue;
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch (err) {
      bad.push({ lineNo, why: `不是合法 JSON：${err?.message ?? err}` });
      continue;
    }
    if (typeof ev?.seq !== 'number') {
      bad.push({ lineNo, why: '没有 seq（编号不可核对）' });
      continue;
    }
    events.push(ev);
  }
  return { events, bytes: buf.length, sha256: sha256hex(buf), bad };
}

/**
 * **归并计划**（纯函数，不碰 IO）：把主线 ＋ 各 scope 的事件按 `at` 排成一条线，
 * 重新编号，并把"**哪些号变了**"逐条列出来。
 *
 * 排序口径（写死在这里，别处不许再算一遍）：
 *   ① `at` 升序（服务端盖的那个钟）；② 同一 `at` ⇒ 稳定排序 ⇒ 各文件内部的
 *   原顺序、主线排在 scope 之前（主线的事件因此尽量保住自己的号）。
 */
export function planMerge({ mainEvents = [], scopes = [] } = {}) {
  const items = [];
  for (const ev of mainEvents) items.push({ ev, file: MAIN_LOG, oldSeq: ev.seq });
  for (const s of scopes) {
    for (const ev of s.events) items.push({ ev, file: s.name, oldSeq: ev.seq });
  }
  const atOf = (x) => (Number.isFinite(x.ev.at) ? x.ev.at : 0);
  // ⚠️ **稳定排序**（Node 的 `Array.sort` 是稳定的）：同 `at` 时保持插入顺序 ——
  //    主线在前、scope 按名字在前、各自保持原顺序。
  items.sort((a, b) => atOf(a) - atOf(b));

  const events = [];
  const changes = [];
  for (const [i, it] of items.entries()) {
    const newSeq = i + 1;
    events.push({ ...it.ev, seq: newSeq });
    if (newSeq !== it.oldSeq) changes.push({ file: it.file, oldSeq: it.oldSeq, newSeq });
  }
  return {
    total: items.length,
    events,
    changes,
    /** 主线的号有没有动（一半以上会动，因为 scope 里更早的事件插了进来）。 */
    mainChanged: changes.filter((c) => c.file === MAIN_LOG).length,
  };
}

/**
 * ★ T6：**开机幂等的那一步**（契约 §四 T6 的"可执行做法"）。
 *
 * 盒子重开时、**服务还没起来之前**调它：
 *   · 那一刻没有内存里的 `Timeline` ⇒ 不算热 ⇒ 真并是安全的；
 *   · 已经是"一条线"（没有 `scope-*.jsonl`）⇒ 一条都不动（**幂等**，
 *     第二次跑全 `skipped`）；
 *   · 有冲突（坏行）⇒ 拒绝并不动盘，由开机日志如实报出来。
 *
 * ⚠️ 它**不**改启动路径：想让它在开机时跑，是**盒子的开机单元**加一步
 *    `node scripts/merge-scope-logs.mjs --dir /data --apply --at-boot`
 *    （或者调这个函数）。**没有**这一步时的硬约束是：
 *    **并完必须触发盒子重开**（`--apply` 已经在结构上要求 `--at-boot`）。
 */
export function bootMergeIfPending({
  dir,
  fs = nodeFs,
  now = () => new Date(),
  log = () => {},
  env = process.env,
  uid = process.getuid?.(),
} = {}) {
  return mergeScopeLogs({ dir, apply: true, atBoot: true, hot: false, fs, now, log, env, uid });
}

/** 数据目录 → 那一条日志的路径。 */
export function mainLogPath(dir) {
  return nodePath.join(dir, MAIN_LOG);
}

/** 那一本"哪些 scope 已经并过"的台账（没有 ⇒ 空）。 */
export function readMergeLedger(dir, { fs = nodeFs } = {}) {
  const file = nodePath.join(dir, EVIDENCE_DIR, LEDGER);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { merged: {} };
  }
}

/**
 * **主入口**：扫 → 算 sha → 归并计划（dry-run 只到这里）。
 *
 * @param {object} o
 * @param {string} o.dir        数据目录（盒子里就是 `/data`）
 * @param {boolean} [o.apply]   **默认 false**：一个字节都不动
 * @param {object} [o.fs]
 * @param {() => Date} [o.now]
 * @param {(m:string)=>void} [o.log]
 */
export function mergeScopeLogs({
  dir,
  apply = false,
  /**
   * ★ T6：**这是不是"开机那一步"**。
   *
   * 🔴 合并会**重新编号**那条日志，而 `store.append` 的 `seq` 是内存里的 `Timeline`
   *    定的 ⇒ 盒子跑着的时候合并，内存那个 `Timeline` 下一条会从**旧号**起、
   *    与重编号后的号**撞**（#123 实测）。所以 `--apply` **必须**是被"开机/重开"
   *    这一步调起来的；否则一律拒绝（dry-run 照旧允许）。
   */
  atBoot = false,
  /** 注入"热不热"（默认真判：锁 ＋ `status.json`）。`null` = 自己去判。 */
  hot = null,
  fs = nodeFs,
  now = () => new Date(),
  log = () => {},
  /** 交给谁（盒子里服务是 root 时必须要）——注入是为了能**验**这一条。 */
  env = process.env,
  uid = process.getuid?.(),
} = {}) {
  if (!dir) throw new Error('缺少 --dir（数据目录）');
  const hotCheck = hot === null ? isStoreHot(dir, { fs, now: () => now().getTime() }) : { hot: hot === true, why: '注入' };
  const report = {
    dir,
    apply: apply === true,
    at: now().toISOString(),
    /** ★ T6：这一刻数据目录是不是热的（有服务攥着内存里的 `Timeline`）。 */
    hot: hotCheck.hot === true,
    hotWhy: hotCheck.why ?? null,
    atBoot: atBoot === true,
    /** 拒绝了没有（拒绝 ⇒ 一个字节都不动）。 */
    refused: null,
    files: [],
    merged: [],
    skipped: [],
    conflicts: [],
    numberChanges: [],
    numberChangesTotal: 0,
    /** 从 scope 文件里读出来、**补上 `scopeId`** 的事件数（见 `sources` 那段说明）。 */
    tagged: 0,
    shaBefore: {},
    shaAfter: null,
    counts: { before: 0, after: 0 },
  };

  // 🔴 **T6 的闸**：真并的两条硬条件 ——
  //   ① 是"开机/重开"这一步调起来的（`atBoot`）；
  //   ② 那一刻数据目录是**冷的**（没有活着的服务）。
  //   任一条不成立 ⇒ **拒绝、一个字节都不动**（dry-run 不受影响）。
  if (report.apply && !report.atBoot) {
    report.refused = '热状态合并会与重编号后的号撞（#123）：--apply 必须与 --at-boot 一起用（或走开机幂等那一步）';
    return report;
  }
  if (report.apply && report.hot) {
    report.refused = `盒子还在跑（${report.hotWhy ?? '热'}）：合并会撞号 —— 先让盒子重开（或等它停）再并`;
    return report;
  }

  const mainPath = mainLogPath(dir);
  const main = readLog(mainPath, { fs });
  report.shaBefore[MAIN_LOG] = main.sha256;
  report.files.push({ name: MAIN_LOG, sha256: main.sha256, bytes: main.bytes, events: main.events.length });
  if (main.bad.length > 0) {
    report.conflicts.push({ name: MAIN_LOG, why: `有 ${main.bad.length} 行读不懂`, bad: main.bad.slice(0, 5) });
  }

  const { pending, merged: already } = scanScopeLogs(dir, { fs });
  const ledger = readMergeLedger(dir, { fs });

  // 已经并过的（改了名）⇒ skipped（**这就是"第二次跑全 skipped"**）
  for (const m of already) {
    report.skipped.push({ id: m.id, name: m.name, why: '已经并过（证据文件还留着）' });
  }

  // 还没并的：算 sha；台账说"这份 sha 已经并过" ⇒ skipped（上一次并到一半）
  const toMerge = [];
  for (const f of pending) {
    report.files.push({ name: f.name, sha256: f.sha256, bytes: f.bytes, events: null });
    if (ledger?.merged?.[f.id] === f.sha256) {
      report.skipped.push({ id: f.id, name: f.name, why: '台账说这份 sha 并过了（上次并到一半）' });
      continue;
    }
    toMerge.push(f);
  }

  if (toMerge.length === 0) {
    report.counts.before = main.events.length;
    report.counts.after = main.events.length;
    if (report.conflicts.length === 0 && report.skipped.length === 0) {
      report.skipped.push({ id: null, name: '—', why: '没有任何 scope-*.jsonl 要并' });
    }
    return report;
  }

  // 读各 scope 的事件（坏行 ⇒ 冲突，**不许 apply**）
  //
  // ★ **补标签**（这一条不说清，并完那条视图就是错的）：
  //   改前（`#121`）那一套里，**只有** `user/echo` 与 `message/start` 带 `scopeId`；
  //   `message/text` / `message/end` / `task/mutated` / 计划那些**不带**（它们
  //   靠"住在哪个文件里"说明自己属于哪一间）。并成一条日志之后，
  //   "住在哪个文件"这个信息就没了 ⇒ 不补标签的话，那些事件会被当成**主线**的：
  //   房间那一眼看不到自己后半句，主线那一眼却冒出来别人的回答。
  //   ⇒ 从某个 `scope-<id>.jsonl` 里读出来的、没有标签的事件，**补上那个 id**。
  const sources = [];
  let tagged = 0;
  for (const f of toMerge) {
    const r = readLog(f.path, { fs });
    const rec = report.files.find((x) => x.name === f.name);
    if (rec) rec.events = r.events.length;
    if (r.bad.length > 0) {
      report.conflicts.push({ name: f.name, why: `有 ${r.bad.length} 行读不懂`, bad: r.bad.slice(0, 5) });
    }
    const events = r.events.map((e) => {
      if (e.scopeId === undefined || e.scopeId === null) {
        tagged += 1;
        return { ...e, scopeId: f.id };
      }
      if (e.scopeId !== f.id) {
        report.conflicts.push({
          name: f.name,
          why: `有一条事件的 scopeId=${e.scopeId}，与文件名（${f.id}）对不上 —— 不许猜`,
        });
      }
      return e;
    });
    sources.push({ id: f.id, name: f.name, path: f.path, sha256: f.sha256, bytes: f.bytes, events });
  }
  report.tagged = tagged;

  const plan = planMerge({ mainEvents: main.events, scopes: sources });
  report.counts.before = main.events.length + sources.reduce((n, s) => n + s.events.length, 0);
  report.counts.after = plan.total;
  report.numberChanges = plan.changes;
  report.numberChangesTotal = plan.changes.length;
  report.mainChanged = plan.mainChanged;

  if (report.conflicts.length > 0) {
    report.skipped.push({ id: null, name: '—', why: '有冲突 ⇒ 拒绝并（先把坏行处理掉）' });
    return report;
  }

  report.merged = sources.map((s) => ({
    id: s.id, name: s.name, sha256: s.sha256, bytes: s.bytes, events: s.events.length,
    to: s.name.replace(/\.jsonl$/, '.merged.jsonl'),
  }));

  if (!report.apply) return report; // ★ dry-run：到此为止，一个字节都没动

  // ── apply ────────────────────────────────────────────────
  const stamp = report.at.replace(/[:.]/g, '-');
  const evidenceDir = nodePath.join(dir, EVIDENCE_DIR, stamp);
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });

  // ① **并之前先落一份快照**（时间线逐字节 ＋ 各 scope 文件 sha）
  if (main.sha256 !== null) {
    try {
      fs.copyFileSync(mainPath, nodePath.join(evidenceDir, MAIN_LOG));
    } catch (err) {
      // 快照落不下就**不并**：那会让"哪些号变了"变成一句没法核对的话
      throw new Error(`快照没落成（${MAIN_LOG}）：${err?.message ?? err}`);
    }
  }

  // ② 写新的一条日志（原子：tmp → rename）
  const text = plan.events.map((e) => `${JSON.stringify(e)}\n`).join('');
  const tmp = `${mainPath}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, mainPath);
  const after = fs.readFileSync(mainPath);
  report.shaAfter = sha256hex(after);

  // ③ **旧文件不删**：改名留作证据
  for (const s of sources) {
    fs.renameSync(s.path, nodePath.join(dir, s.name.replace(/\.jsonl$/, '.merged.jsonl')));
  }

  // ④ 台账（记 sha ⇒ 下次跑得出 skipped）
  const nextLedger = {
    ...(ledger ?? {}),
    merged: { ...(ledger?.merged ?? {}) },
    last: report.at,
  };
  for (const s of sources) nextLedger.merged[s.id] = s.sha256;
  fs.writeFileSync(nodePath.join(dir, EVIDENCE_DIR, LEDGER), `${JSON.stringify(nextLedger, null, 2)}\n`, { mode: 0o600 });

  // ⑤ 报告（**逐字节可核对**：sha ＋ 哪些号变了，一条都不省）
  const reportPath = nodePath.join(evidenceDir, 'report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

  // ⑥ 盒子里：新写出来的东西**交给干活的 uid**（`socket-owner.mjs` 那条实测规矩）。
  //    ⚠️ 证据目录**里面那两份也要交**：只交目录会把"证据"留成 agent 读不到的东西。
  const hand = handNewFiles(
    [
      mainPath,
      nodePath.join(dir, EVIDENCE_DIR, LEDGER),
      evidenceDir,
      nodePath.join(evidenceDir, MAIN_LOG),
      reportPath,
    ],
    { fs, log, env, uid },
  );
  report.handed = hand;
  return report;
}

/**
 * 把**新写出来的**路径交给 agent（盒子里服务是 root 时必须要）。
 * 宿主（非 root / 没配 `HUPO_AGENT_UID`）上什么都不做。
 */
export function handNewFiles(paths, { fs = nodeFs, env = process.env, uid = process.getuid?.(), log = () => {} } = {}) {
  if (uid !== 0) return { done: false, why: `不是 root（uid=${String(uid)}）——身份就是干活的身份，不用交` };
  const owner = agentOwnerFromEnv(env);
  if (!owner) {
    // 🔴 这里**不抛**：调用方已经写完了。但要**说得清清楚楚**（下一句就是它为什么读不到）。
    log(
      `  🔴 以 root 跑、又没配 HUPO_AGENT_UID/HUPO_AGENT_GID：新写出来的文件属主是 root，` +
      `盒子里干活的 uid 会读不到（EACCES）⇒ 请用租户身份重跑，或补上那两条 env`,
    );
    return { done: false, why: 'root 且没配 HUPO_AGENT_UID' };
  }
  const failed = [];
  for (const p of paths) {
    try {
      fs.chownSync(p, owner.uid, owner.gid);
    } catch (err) {
      failed.push(`${p}: ${err?.message ?? err}`);
    }
  }
  if (failed.length > 0) {
    log(`  ⚠️ 有几样没能交给 ${owner.uid}:${owner.gid}：${failed.join('；')}`);
    return { done: false, why: failed };
  }
  return { done: true, why: `已交给 ${owner.uid}:${owner.gid}` };
}

/** 人看得懂的一段话（CLI 与测试共用）。 */
export function describeMerge(report, { sample = 12 } = {}) {
  const lines = [];
  lines.push(`数据目录 ${report.dir}${report.apply ? '（**真并**）' : '（**只看，不会动**）'}`);
  // ★ T6：把"现在能不能并"摆在第一屏（排查的人第一眼要看的就是它）。
  lines.push(
    `盒子状态 ${report.hot ? `**还在跑**（${report.hotWhy ?? '热'}）` : `冷的（${report.hotWhy ?? '没有服务'}）`}` +
    `${report.atBoot ? ' · 开机那一步' : ''}`,
  );
  if (report.refused) {
    lines.push('');
    lines.push(`🔴 **拒绝了**：${report.refused}`);
    lines.push('   （契约 88 §四 T6 / `00-PROGRESS.md` #123：热状态合并会撞号。）');
    return lines.join('\n');
  }
  lines.push(`事件     ${report.counts.before} 条 → ${report.counts.after} 条（一条线、重新编号）`);
  for (const f of report.files) {
    lines.push(`  ${f.name}  sha256=${f.sha256 ?? '—'}  ${f.bytes}B  ${f.events ?? '?'} 条`);
  }
  for (const m of report.merged) {
    lines.push(`  ${report.apply ? '并了' : '要并'} ${m.name}（${m.events} 条）→ ${m.to}`);
  }
  if (report.shaAfter) lines.push(`并完的 ${MAIN_LOG}  sha256=${report.shaAfter}`);
  if (report.tagged) {
    lines.push(`补标签：${report.tagged} 条（#121 那套里 message/text、message/end 不带 scopeId）`);
  }
  lines.push(
    `号变了的：${report.numberChangesTotal} 条` +
    (report.mainChanged ? `（其中主线的 ${report.mainChanged} 条）` : ''),
  );
  for (const c of report.numberChanges.slice(0, sample)) {
    lines.push(`  ${c.file} 第 ${c.oldSeq} 号 → 第 ${c.newSeq} 号`);
  }
  if (report.numberChangesTotal > sample) {
    lines.push(`  …还有 ${report.numberChangesTotal - sample} 条（全表在 report.json 里）`);
  }
  for (const s of report.skipped) lines.push(`  跳过 ${s.name}：${s.why}`);
  for (const c of report.conflicts) lines.push(`  ⚠️ 冲突 ${c.name}：${c.why}`);
  if (!report.apply && report.merged.length > 0) lines.push('加 --apply 才真并。');
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
  const dir = flag('--dir', process.env.HUPO_DATA ?? null);
  const apply = argv.includes('--apply');
  const atBoot = argv.includes('--at-boot');
  if (!dir) {
    console.error('用法：node scripts/merge-scope-logs.mjs --dir /data [--apply --at-boot]');
    console.error('  ⚠️ --apply 必须与 --at-boot 一起用（盒子重开/开机幂等那一步）。');
    process.exit(1);
  }
  if (apply && !atBoot) {
    console.error(
      '🔴 --apply 必须和 --at-boot 一起用（契约 88 §四 T6）。\n' +
      '   合并会重新编号那条日志，而 seq 是内存里那个 Timeline 定的 ⇒\n' +
      '   盒子跑着的时候并，它下一条会从旧号起、与重编号后的号**撞**（#123 实测）。\n' +
      '   ⇒ 正确做法：① 让盒子重开，在开机幂等那一步跑这条命令；\n' +
      '              ② 或者先 dry-run 看计划，并完**立刻触发盒子重开**。',
    );
    process.exit(3);
  }
  // 🔴 身份闸：盒子里以 root 跑就**必须**能交代"新文件交给谁"
  const uid = process.getuid?.();
  if (uid === 0 && !agentOwnerFromEnv(process.env)) {
    console.error(
      '🔴 现在是 root，又没配 HUPO_AGENT_UID/HUPO_AGENT_GID：\n' +
      '   写出来的日志会属于 root，盒子里干活的 uid 读不到（EACCES）。\n' +
      '   请**用租户自己的身份**跑（`su -s /bin/sh <uid> -c …`），或在盒子里带上那两条 env。',
    );
    process.exit(1);
  }
  const report = mergeScopeLogs({ dir, apply, atBoot, log: (m) => console.log(m) });
  console.log(describeMerge(report));
  // ⚠️ 有冲突 / 被 T6 拒了 ⇒ 非零退出（不然会被接在 `&&` 后面当成"成功了"）
  if (report.refused) process.exit(3);
  process.exit(report.conflicts.length > 0 ? 2 : 0);
}
