// **存量迁移：把宿主那份旧库搬进盒子**（B15 · `docs/dev/77-BLOCKERS.md`）。
//
// ── 它解决什么 ────────────────────────────────────────────
// 小程序库曾经"两处并存"：桌面读**宿主**那份、助手写**盒子里**那份。
// 主人 2026-09-25 拍板：**以盒子为准**。⇒ 宿主上那些旧的（`u2` 的 `tianqi-probe` / `wenda`）
// 要搬进他自己的盒子，否则他刷新之后**再也看不到**它们（而东西还在盘上 —— 那更难查）。
//
// ── 四条不许破 ────────────────────────────────────────────
//   ① 🔴 **内容逐字节不变**：搬完**从盒子里读回来**再核一遍 sha256（不是"发出去了就算"）。
//   ② 🔴 **可重跑**：盒子里已有**同一个 rootHash** ⇒ 报 `already`、**什么都不写**；
//      已有**别的** rootHash ⇒ 报 `conflicts`、**不动它**（版本不可变）。
//   ③ 🔴 **dry-run 不动盘**：默认只看（`apply:false`）—— 一个字节都不发。
//   ④ 🔴 **宿主那份不删**：这一步只"推过去"，**不搬走、不删**（先留着，如实报告）。
//
// ── 搬是怎么过去的（这一条最要紧）─────────────────────────
// 宿主**看不到**盒子的卷（实测 `/home/hupo-b/tenant` 在宿主上不存在），
// 而且**不许用 root 去写容器的卷**（`81-HARNESS-ENTRY.md` §9.3 那条教训）。
// ⇒ 只能**经现有隧道**（`TenantChannel.openSocket`）把每一版**推进**盒子，
//   落点是**盒子自己那条 app 写入路**（`Apps.create()` —— 见 `apps-box.js` 的
//   `POST /internal/app`）：版本号 / 清单 / 权限 / 审计语义与助手自己造 app 时**逐字相同**。
//
// ⚠️ **隧道只有正在跑的那个服务手上才有** ⇒ 这个迁移**必须在服务进程里执行**。
//    所以这里除了核心逻辑，还有一条**本机维护口**（`apps-migrate.sock`，`0600`）：
//    `scripts/migrate-apps-to-box.mjs` 连上它、递一条作业、拿回一份报告 ——
//    形状照 `apps.sock` / `ledger.sock` 那两条既有的本地通道（一行一条 JSON）。

import nodeFs from 'node:fs';
import nodeNet from 'node:net';
import nodePath from 'node:path';

import { rootHashOf, sha256hex } from './apps.js';

/** 那条维护口叫什么（`<dataDir>/apps-migrate.sock`）。 */
export const MIGRATE_SOCKET_NAME = 'apps-migrate.sock';

/** 维护口放在哪。 */
export function migrateSocketPath(dataDir) {
  return nodePath.join(dataDir, MIGRATE_SOCKET_NAME);
}

/** 一行最长多少（防呆）：制品总量上限 2MB，base64 之后还有余量。 */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * **一趟迁移**（核心；纯逻辑：给一个宿主库、一个盒子客户端，就搬这一份）。
 *
 * @param {object} o
 * @param {string} o.userId
 * @param {{list:Function, manifest:Function, read:Function}} o.hostApps  宿主那份（`Apps`）
 * @param {{list:Function, create:Function, read:Function}} o.box          盒子那份（`createBoxApps`）
 * @param {string|null} [o.only]
 * @param {boolean} [o.apply]   **false = 只看计划**（默认）
 * @param {(m:string)=>void} [o.log]
 * @param {()=>number} [o.now]
 * @returns {Promise<object>} 报告（**JSON 可序列化**：里面没有 Buffer）
 */
export async function migrateAppsToBox({
  userId,
  hostApps,
  box,
  only = null,
  apply = false,
  log = () => {},
  now = Date.now,
}) {
  const report = {
    userId,
    apply,
    at: now(),
    planned: [],
    pushed: [],
    already: [],
    skipped: [],
    conflicts: [],
    failed: [],
    // 🔴 **宿主那份一个字节都没动**（不删、不挪）—— 这一栏是**如实报告**，不是承诺
    leftOnHost: true,
  };
  if (!hostApps) {
    report.skipped.push({ id: null, why: '宿主上找不到他那一份库' });
    return report;
  }
  let mine = [];
  try {
    mine = hostApps.list();
  } catch (err) {
    report.skipped.push({ id: null, why: `宿主那份读不出来：${err?.message ?? err}` });
    return report;
  }
  if (only) {
    mine = mine.filter((a) => a.id === only);
    if (mine.length === 0) {
      // ⚠️ **如实说**：`--only` 点了一个宿主那份里没有的 ⇒ 别回一句"没有要搬的"
      //    （那会被读成"搬完了"）
      report.skipped.push({ id: only, why: '宿主那份里没有这个小程序' });
      return report;
    }
  }

  // ⚠️ **盒子里现在有什么**：一次问清（重跑那一条靠它）
  let theirs = [];
  try {
    theirs = await box.list();
  } catch (err) {
    // 盒子不通 ⇒ **不许假装"搬完了"**（也不许退回宿主那份）。抛给调用方如实回。
    throw err;
  }
  const theirById = new Map(theirs.map((a) => [a.id, a]));

  for (const a of mine) {
    const m = hostApps.manifest(a.id, a.version);
    if (!m) {
      report.skipped.push({ id: a.id, why: '宿主那份的清单坏了（读不出来）' });
      continue;
    }
    // ── ① 把这一版的**全部字节**读回内存（`Apps.read` 自己会核 hash）
    const files = {};
    let bad = null;
    for (const rec of m.files ?? []) {
      try {
        files[rec.path] = hostApps.read(a.id, m.version, rec.path).content;
      } catch (err) {
        bad = `${rec.path}：${err?.message ?? err}`;
        break;
      }
    }
    if (bad) {
      report.skipped.push({ id: a.id, why: `宿主那一版读不出来（${bad}）` });
      continue;
    }
    // ── ② 拿**读回来的字节**自己再算一遍 hash（不是抄清单里的）
    const computed = Object.entries(files).map(([path, buf]) => ({ path, sha256: sha256hex(buf) }));
    const rootHash = rootHashOf(computed);
    if (rootHash !== m.rootHash) {
      // 宿主那份自己都不自洽 ⇒ **不许**把它推过去（宁可留着、如实报）
      report.skipped.push({ id: a.id, why: '宿主那份算出来的 hash 和它自己的清单对不上（不动它）' });
      continue;
    }
    const meta = { id: a.id, version: m.version, rootHash, files: computed.length, bytes: m.bytes ?? null };

    // ── ③ 盒子里已经有了吗
    const there = theirById.get(a.id);
    if (there) {
      if (there.rootHash === rootHash) {
        report.already.push({ ...meta, boxVersion: there.version });
        continue;
      }
      report.conflicts.push({
        id: a.id,
        why: `盒子里已经有一个不一样的了（他那份第 ${there.version} 版，hash 不同）—— 版本不可变，不动它`,
      });
      continue;
    }

    if (!apply) {
      report.planned.push(meta);
      continue;
    }

    // ── ④ 真推（落点是**盒子自己那条写入路**）
    let manifest;
    try {
      manifest = await box.create({
        id: a.id,
        title: m.title,
        icon: m.icon,
        entry: m.entry,
        files,
        permissions: m.permissions ?? [],
        createdBy: 'user',
      });
    } catch (err) {
      report.failed.push({ ...meta, why: `推不进去：${err?.message ?? err}` });
      continue;
    }

    // ── ⑤ **从盒子里读回来**再核一遍（判据 B15-4 的"逐字节不变"就钉在这一步）
    const diff = await verifyBack({ box, manifest, computed });
    if (diff) {
      report.failed.push({ ...meta, boxVersion: manifest?.version ?? null, why: diff });
      continue;
    }
    report.pushed.push({ ...meta, boxVersion: manifest?.version ?? null, verified: true });
    log(`  ✔ ${a.id}：第 ${manifest?.version} 版推进去了，读回来对得上（${computed.length} 个文件）`);
  }
  return report;
}

/**
 * **把刚推进去的读回来核一遍**。对不上就返回一句人话（对得上返回 `null`）。
 *
 * ⚠️ 这是"逐字节不变"这句话的**唯一证据**：不是"我们发出去了"。
 */
async function verifyBack({ box, manifest, computed }) {
  if (!manifest || !Number.isInteger(Number(manifest.version))) return '盒子那边没回一份清单';
  const boxFiles = manifest.files ?? [];
  const want = Object.fromEntries(computed.map((f) => [f.path, f.sha256]));
  if (boxFiles.length !== computed.length) return '盒子那边收的文件数目与推过去的不一样';
  for (const f of boxFiles) {
    if (want[f.path] !== f.sha256) return `盒子里那份的 ${f.path} 与推过去的不一样`;
  }
  const boxRoot = rootHashOf(boxFiles.map((f) => ({ path: f.path, sha256: f.sha256 })));
  if (boxRoot !== rootHashOf(computed)) return '盒子那边算出来的 hash 与推过去的不一样';
  // 真·读回来：每个文件取一次字节，核 sha256
  for (const f of computed) {
    let got;
    try {
      got = await box.read(manifest.id, manifest.version, f.path);
    } catch (err) {
      return `盒子里那份 ${f.path} 读不回来：${err?.message ?? err}`;
    }
    if (sha256hex(got.content) !== f.sha256) return `盒子里那份 ${f.path} 的字节对不上`;
  }
  return null;
}

/** 人看得懂的一段话（CLI 与测试都可以用）。 */
export function describeMigrateReport(report) {
  const lines = [];
  const head = `【${report.userId}】${report.apply ? '真搬' : '只看（不会动任何东西）'}`;
  lines.push(head);
  if (report.planned.length > 0) {
    for (const a of report.planned) lines.push(`  要搬 ${a.id}（第 ${a.version} 版 · ${a.files} 个文件 · ${a.rootHash.slice(0, 12)}…）`);
  }
  for (const a of report.pushed) lines.push(`  搬了 ${a.id}（盒子里第 ${a.boxVersion} 版 · 读回来对得上）`);
  for (const a of report.already) lines.push(`  已经在盒子里了 ${a.id}（第 ${a.boxVersion} 版 · 同一个 hash，没再动）`);
  for (const s of report.skipped) lines.push(`  跳过 ${s.id ?? '—'}：${s.why}`);
  for (const c of report.conflicts) lines.push(`  ⚠️ 冲突 ${c.id}：${c.why}`);
  for (const f of report.failed) lines.push(`  ✗ 没搬成 ${f.id}：${f.why}`);
  if (report.planned.length === 0 && report.pushed.length === 0 && report.already.length === 0) {
    lines.push('  没有要搬的（宿主那份里没有别的小程序）。');
  }
  if (!report.apply && report.planned.length > 0) lines.push('加 --apply 才真搬。');
  lines.push('  （宿主那份**原样留着**：这一步只推过去，不删、不挪。）');
  return lines.join('\n');
}

/**
 * **本机维护口**（`0600` 的 UDS）。
 *
 * ⚠️ 它只干两件事（`plan` / `push`），而且**只认服务自己在跑时手上那条隧道** ——
 *    外部脚本**拿不到隧道**，所以这件事只能由服务代做（见文件头）。
 * ⚠️ 身份靠**文件权限**（`0600` + 调用方是同一台机器上那个 `deploy`），
 *    和 `apps.sock` / `ledger.sock` 同一条规矩。
 *
 * @param {object} o
 * @param {string} o.socketPath
 * @param {(userId:string)=>object|null} o.hostAppsFor   宿主那份库（`Apps`）
 * @param {(userId:string)=>string|null} o.tenantOf
 * @param {(tenant:string)=>any} o.dialFor               拿一条到那台盒子的隧道
 * @param {(m:string)=>void} [o.log]
 * @param {import('node:fs')} [o.fs]
 */
export function createAppsMigrateServer({
  socketPath,
  hostAppsFor,
  tenantOf,
  dialFor,
  log = () => {},
  fs = nodeFs,
  now = Date.now,
}) {
  if (!socketPath) throw new Error('socketPath 必填');
  if (typeof hostAppsFor !== 'function') throw new Error('hostAppsFor 必填');
  let server = null;
  let ready = null;

  /** 一条作业。**不抛**：坏输入只让那一条失败（同 `apps.sock`）。 */
  async function handle(msg) {
    const op = msg?.op;
    if (op !== 'plan' && op !== 'push') return { ok: false, error: '认不出这条请求（要 plan 或 push）' };
    const userId = typeof msg?.user === 'string' ? msg.user.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) return { ok: false, error: '要一个用户名（像 u2 这种）' };
    const only = typeof msg?.only === 'string' && msg.only.trim() !== '' ? msg.only.trim() : null;

    let tenant = null;
    try {
      tenant = tenantOf?.(userId) ?? null;
    } catch {
      tenant = null;
    }
    if (!tenant) {
      return { ok: false, error: 'no-tenant', text: `${userId} 名下没有单独一台盒子，不用搬。` };
    }
    const hostApps = hostAppsFor(userId);
    if (!hostApps) return { ok: false, error: 'no-world', text: `${userId} 那一格还没建起来。` };
    if (typeof dialFor !== 'function') {
      return { ok: false, error: 'no-tunnel', text: '这台服务手上没有隧道，搬不了。' };
    }

    // ⚠️ 这里**才**引 `apps-box.js`（免得一个纯逻辑模块把 HTTP 那套也拖进来）
    const { createBoxApps } = await import('./apps-box.js');
    const box = createBoxApps({ sub: userId, dial: () => dialFor(tenant), log });
    const report = await migrateAppsToBox({
      userId,
      hostApps,
      box,
      only,
      apply: op === 'push',
      log,
      now,
    });
    return { ok: true, report };
  }

  function listen() {
    if (server) return api;
    fs.mkdirSync(nodePath.dirname(socketPath), { recursive: true, mode: 0o700 });
    try {
      fs.unlinkSync(socketPath); // 上次没善终留下的，`listen` 会撞 EADDRINUSE
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    const s = nodeNet.createServer((conn) => {
      let buf = '';
      conn.setEncoding('utf8');
      conn.on('data', async (chunk) => {
        buf += chunk;
        if (buf.length > MAX_LINE_BYTES) {
          conn.end(`${JSON.stringify({ ok: false, error: '这一行太长了' })}\n`);
          buf = '';
          return;
        }
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let req = null;
          try {
            req = JSON.parse(line);
          } catch {
            conn.write(`${JSON.stringify({ ok: false, error: '这一行不是 JSON' })}\n`);
            continue;
          }
          let reply;
          try {
            reply = await handle(req);
          } catch (err) {
            // 盒子不通 ⇒ **如实回一句**（不是"成了"）
            reply = { ok: false, error: err?.why ?? 'box', text: err?.message ?? String(err) };
          }
          conn.write(`${JSON.stringify(reply)}\n`);
        }
      });
      conn.on('error', (err) => log(`[apps-migrate] 连接出错：${err?.message ?? err}`));
    });
    s.on('error', (err) => log(`[apps-migrate] 维护口出错：${err?.message ?? err}`));
    // ⚠️ 文件一出生就是 0600（不能"先按 umask 建、回头再 chmod"）
    const prev = process.umask(0o177);
    try {
      s.listen(socketPath);
    } finally {
      process.umask(prev);
    }
    ready = new Promise((resolve) => {
      s.once('listening', () => {
        try {
          fs.chmodSync(socketPath, 0o600);
        } catch (err) {
          log(`[apps-migrate] 维护口权限没设上：${err?.message ?? err}`);
        }
        resolve();
      });
    });
    server = s;
    return api;
  }

  const api = {
    path: socketPath,
    listen,
    ready: () => ready ?? Promise.resolve(),
    handle,
    close() {
      const s = server;
      server = null;
      return new Promise((resolve) => {
        if (!s) {
          resolve();
          return;
        }
        s.close(() => resolve());
      });
    },
  };
  return api;
}

/**
 * **连一次维护口**（CLI 与判据共用）：递一条作业、拿回一份回执。
 *
 * @returns {Promise<object>} 回执（`{ok:true, report}` 或 `{ok:false, error, text?}`）
 */
export function migrateCall({ socketPath, msg, timeoutMs = 120_000 }) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let done = false;
    const sock = nodeNet.connect(socketPath);
    const timer = setTimeout(() => finish(new Error('维护口没应（超时）')), timeoutMs);
    timer.unref?.();
    function finish(err, val) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* 已经没了 */
      }
      if (err) reject(err);
      else resolve(val);
    }
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify(msg)}\n`));
    sock.on('data', (chunk) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      try {
        finish(null, JSON.parse(buf.slice(0, i)));
      } catch (err) {
        finish(err);
      }
    });
    sock.on('error', (err) => finish(err));
    sock.on('close', () => finish(new Error('维护口把连接关了（没回话）')));
  });
}
