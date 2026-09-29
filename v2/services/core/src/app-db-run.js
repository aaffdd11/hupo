// **跑一条小程序 SQL 的那个子进程**（**由 `app-db.js` spawn，不许 import 它**）。
//
// ── 为什么单独一个进程（三条实测，2026-09-30）────────────────
//   ① `node:sqlite` 只有同步 API ⇒ 跑在主线程上＝**整个服务等它**；
//   ② `worker.terminate()` **打断不了一条正在跑的本地调用**（探针卡了 60s 没退出）；
//   ③ **进程 ＋ `SIGKILL` 可以**（1509ms 停下；停下之后库照常打开）⇒ 父进程用它做超时。
//
// ── 这一份里做的四件事（全是"最后一道防线"）────────────────
//   · **只有这一个文件碰库**：页面报的路径一个字节都不采信（路径由父进程定死）；
//   · `PRAGMA max_page_count` —— **字节上限变成 SQLite 自己的规矩**
//     （读数：写到第 1178 行报 `database or disk is full`）；
//   · `setAuthorizer` —— 拒 `ATTACH`(24) / `DETACH`(25)（**读别人的库的唯一入口**）、
//     拒 `PRAGMA`(19，只放行 `user_version`，迁移要用)、拒 `RECURSIVE`(33)
//     （失控查询里最便宜的那一种，静态就断）；
//   · 结果封顶（行数由父进程再截一次）+ `BigInt` 转成字符串（JSON 序列化要它）。

import nodeFs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** SQLite 的 authorizer 动作号（**实测出来的，不是猜的**：见 `147` §二）。 */
const SQLITE_PRAGMA = 19;
const SQLITE_ATTACH = 24;
const SQLITE_DETACH = 25;
const SQLITE_RECURSIVE = 33;

const FULL_TEXT = '这个小程序的存储满了。';
const GENERIC_TEXT = '这一条它没执行成功。';

/** 认出来就给人话；认不出来给那句中性的（**不把 SQLite 的错误原文甩给页面**）。 */
function textOf(err) {
  const msg = String(err?.message ?? '');
  if (/database or disk is full/i.test(msg)) return { error: 'full', text: FULL_TEXT };
  if (/not authorized/i.test(msg)) return { error: 'denied', text: GENERIC_TEXT };
  return { error: 'sql', text: GENERIC_TEXT };
}

/** JSON 里塞不进去的东西：`BigInt` ⇒ 字符串；`Buffer` ⇒ 只报字节数（不许悄悄吞掉）。 */
function replacer(_k, v) {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return { blob: v.byteLength };
  return v;
}

function main(spec) {
  const file = String(spec?.file ?? '');
  const sql = String(spec?.sql ?? '');
  const params = Array.isArray(spec?.params) ? spec.params : [];
  const op = String(spec?.op ?? 'all');
  const maxBytes = Number(spec?.maxBytes) || 0;
  const maxRows = Number(spec?.maxRows) || 0;
  if (file === '' || sql === '') {
    process.stdout.write(JSON.stringify({ ok: false, error: 'spec', text: GENERIC_TEXT }));
    return;
  }
  // 库是**我们**建的：先按 0600 建出来（`DatabaseSync` 自己建的话跟着 umask 走）
  try {
    if (!nodeFs.existsSync(file)) {
      nodeFs.closeSync(nodeFs.openSync(file, 'a', 0o600));
    }
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: 'open', text: GENERIC_TEXT }));
    return;
  }
  let db = null;
  try {
    db = new DatabaseSync(file);
    // ★ **字节上限变成库自己的规矩**：超了的写会被 SQLite 顶回来（父进程回"满了"）
    if (maxBytes > 0) {
      const page = Number(db.prepare('PRAGMA page_size').get()?.page_size) || 4096;
      const pages = Math.max(1, Math.floor(maxBytes / page));
      db.exec(`PRAGMA max_page_count = ${pages}`);
    }
    db.setAuthorizer((action, arg) => {
      if (action === SQLITE_ATTACH || action === SQLITE_DETACH) return 1;
      if (action === SQLITE_RECURSIVE) return 1;
      if (action === SQLITE_PRAGMA && String(arg ?? '') !== 'user_version') return 1;
      return 0;
    });
    const stmt = db.prepare(sql);
    if (op === 'run') {
      const r = stmt.run(...params);
      const out = {
        ok: true,
        rows: [],
        changes: Number(r?.changes ?? 0),
        lastInsertRowid: Number(r?.lastInsertRowid ?? 0),
        truncated: false,
      };
      process.stdout.write(JSON.stringify(out, replacer));
      return;
    }
    if (op === 'get') {
      const row = stmt.get(...params);
      process.stdout.write(
        JSON.stringify({ ok: true, rows: row === undefined ? [] : [row], changes: 0, lastInsertRowid: 0, truncated: false }, replacer),
      );
      return;
    }
    const all = stmt.all(...params);
    const rows = Array.isArray(all) ? all : [];
    const cut = maxRows > 0 && rows.length > maxRows;
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          rows: cut ? rows.slice(0, maxRows) : rows,
          changes: 0,
          lastInsertRowid: 0,
          // ⚠️ **截断了就说截断了** —— 页面和助手都看得到这个 `true`
          truncated: cut,
        },
        replacer,
      ),
    );
  } catch (err) {
    const t = textOf(err);
    process.stdout.write(JSON.stringify({ ok: false, error: t.error, text: t.text }));
  } finally {
    try {
      db?.close();
    } catch {
      /* 关不掉就算了：这个进程马上就没 */
    }
  }
}

// **规格走 stdin**（`app-db.js` 那边写的）：argv 有长度上限，而且 `/proc/<pid>/cmdline`
// 会把参数摊给同机所有人看 —— 一条大 INSERT 两样都撞。stdin 两样都没有。
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  let spec = null;
  try {
    spec = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: 'spec', text: GENERIC_TEXT }));
    return;
  }
  main(spec);
});
process.stdin.on('error', () => {
  process.stdout.write(JSON.stringify({ ok: false, error: 'spec', text: GENERIC_TEXT }));
});
