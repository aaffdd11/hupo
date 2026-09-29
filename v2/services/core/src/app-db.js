// **小程序自己的那一格存储**（契约 `docs/dev/147-APP-SQLITE.md`）。
//
// ── 主人怎么拍的（2026-09-30，原话）──────────────────────────
//   *「sqlite 是一定要有的，必须要有这个能力。……一个小程序有一个独立的 sqlite」*
//
// ── 这一份是什么 ──────────────────────────────────────────
//   **一个小程序 ＝ 一个独立的 SQLite 文件**（`<他那一格>/hupo/apps/<id>/data.sqlite`）。
//   谁执行：**壳这一侧**（Node 24 自带 `node:sqlite`，零依赖）—— **不在页面里、不在浏览器里**。
//   页面永远拿不到文件、拿不到钥匙，只拿得到"**替我执行这一条**"这个动作。
//
// ── 🔴 四条不许破（每一条都有读数或判据钉着）──────────────────
//   ① **跨 app 读不到别人的库**：`ATTACH` / `DETACH` 由 `setAuthorizer` 当场拒
//      （读数：`ERR_SQLITE_ERROR not authorized`）；路径也由 `Apps` 那一侧定死，
//      页面报的路径**一个字节都不采信**。
//   ② **不许一条 SQL 把服务卡死**：`node:sqlite` 是**同步**的 ⇒ 它**不许**跑在主线程上。
//      ⚠️ 实测两条（2026-09-30）：`worker.terminate()` **打断不了一条正在跑的本地调用**
//      （探针整个卡了 60s 没退出）；**子进程 ＋ `SIGKILL` 可以**（1509ms 停下，停下之后
//      库照常打开）。⇒ 所以用**子进程**，超时就 `SIGKILL`。
//   ③ **不许无限长**：`max_page_count` 按字节上限换成页数写在库上（读数：写到第 1178 行
//      报 `database or disk is full`）；`WITH RECURSIVE` 由 authorizer 直接拒
//      （读数：action 33 出现且被拒）—— 失控查询里最便宜的那一种，静态就断了。
//   ④ **声明 ＋ 授予两样都要**（照 `ask` 那条先例）：制品清单里没声明 ⇒ 403；
//      看的人没允许 ⇒ 403。**授予是看的人的决定**，不是作者写进清单就能生效的。
//
// ── 给什么 ────────────────────────────────────────────────
//   三条动作：`run`（写 / 改）/ `get`（拿一行）/ `all`（拿多行），**参数一律绑定**
//   （`?` 占位符）—— 页面不许拼串。**一次一条语句**（多语句当场拒）。
//
// ⚠️ **数字只住这一处**（手册第一条纪律）：下面那些常量就是"上限"的唯一出处。

import nodeCrypto from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import nodePath from 'node:path';
import nodeUrl from 'node:url';

/** 制品要存储，就得在清单里声明这个名字（`permissions: ["db"]`）。 */
export const DB_PERMISSION = 'db';

/** 三条动作。**认不出来的动作一律拒**（不猜）。 */
export const DB_OPS = Object.freeze(['run', 'get', 'all']);

/**
 * **"替我存一笔"那条口的路**（app 原点上的 `POST /db`）。
 *
 * 🔴 **只有这一条路**：app 原点上的 POST 只认它，别的照旧 405。
 * ⚠️ 它写在**这里**（协议这一份），而不是那个 HTTP 服务里 ——
 *    因为客户端那一段（`docs/dev/147-APP-SQLITE.md` §三 给助手看的那份规则）
 *    要照着它写。
 */
export const DB_PATH = '/db';

/** 一个小程序那一个库的文件名（住在它的 `appDir` 里、`versions/` 外面）。 */
export const DB_FILE = 'data.sqlite';

/** 一个库最多多大（超了的写会被 SQLite 自己顶回来，见 `runDbChild`）。 */
export const DB_MAX_BYTES = 8 * 1024 * 1024;

/** 一条 SQL 最多多长（字符）。 */
export const SQL_MAX_CHARS = 8 * 1024;

/** 绑定参数最多几个（防呆：别把整本书塞进来）。 */
export const DB_MAX_PARAMS = 64;

/** 一次最多带回几行。**超了就截断，而且如实说截断了**（不静默）。 */
export const DB_MAX_ROWS = 500;

/** 一次最多带回多少字节（序列化之后）。超了如实拒（"加个 LIMIT"）。 */
export const DB_MAX_RESULT_BYTES = 256 * 1024;

/** 一条 SQL 最多跑多久。到点 ⇒ **子进程 SIGKILL**，如实回"这条查得太久"。 */
export const DB_TIMEOUT_MS = 3000;

/** 一分钟最多调用几次（每个 app）。 */
export const DB_CALLS_PER_MINUTE = 240;

/** 一次打开换来的会话票能活多久（页面开着的时候用它，不再反复出示入口签名）。 */
export const DB_TICKET_TTL_MS = 12 * 60 * 60 * 1000;

/** 会话票的域分离前缀（和入口签名、活地址签名**各签各的**）。 */
const TICKET_PURPOSE = 'hupo-app-db-ticket-v1';

/** 子进程脚本（**spawn 它，不 import 它**）。 */
export const DB_RUNNER = nodePath.join(nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url)), 'app-db-run.js');

// ── 人话（页面会照原样显示，所以不许出现内部词）────────────────

export const DB_DECLARED_TEXT = '这个小程序没说要存东西。';
export const DB_NOT_GRANTED_TEXT = '你还没允许它存东西。';
export const DB_BUSY_TEXT = '这个小程序刚存完上一笔，等一下再试。';
export const DB_TOO_MANY_TEXT = '这个小程序一分钟里存得太频繁了，等一会儿再试。';
export const DB_FULL_TEXT = '这个小程序的存储满了。';
export const DB_TIMEOUT_TEXT = '这一条查得太久了，先不查了 —— 把范围写小一点再试。';
export const DB_TOO_BIG_TEXT = '这一条查回来的东西太多，加个 LIMIT 再查。';
export const DB_ERROR_TEXT = '这一条它没执行成功。';

/**
 * **把一条 SQL 过一遍**（纯函数，不碰盘、不花钱）。
 *
 * 它挡三样：
 *   ① **多语句**（`;` 后面还有东西）—— 一次只许一条；
 *   ② **跨库 / 危险关键字**（`ATTACH` / `DETACH` / `load_extension` / `VACUUM` /
 *      显式事务）—— 头一条最要紧：它是"读别人的库"的唯一入口；
 *   ③ **空语句 / 太长**。
 *
 * ⚠️ **引号与注释里的 `;` 不算**（`INSERT INTO t VALUES ('a;b')` 是合法的）——
 *    所以这里真扫一遍字符串状态，不用正则图省事。
 * ⚠️ 这一层是**第一道**；第二道是 `setAuthorizer`（就算这里漏了，`ATTACH` 也过不去）。
 *
 * @param {unknown} raw
 * @returns {{ok:true, sql:string} | {ok:false, text:string}}
 */
export function guardSql(raw) {
  if (typeof raw !== 'string') return { ok: false, text: DB_ERROR_TEXT };
  const sql = raw.trim();
  if (sql === '') return { ok: false, text: '这一条是空的。' };
  if (sql.length > SQL_MAX_CHARS) return { ok: false, text: '这一条太长了。' };
  // 结尾那个分号可以有，别的分号必须在引号里
  const body = sql.endsWith(';') ? sql.slice(0, -1) : sql;
  let i = 0;
  let quote = null; // `'` / `"` / '`' / ']'
  let stripped = '';
  while (i < body.length) {
    const ch = body[i];
    if (quote) {
      stripped += ' ';
      if (quote === ']') {
        if (ch === ']') quote = null;
      } else if (ch === quote) {
        // SQL 里两个连着的引号 = 一个转义的引号
        if (body[i + 1] === quote) i += 1;
        else quote = null;
      }
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      stripped += ' ';
      i += 1;
      continue;
    }
    if (ch === '[') {
      quote = ']';
      stripped += ' ';
      i += 1;
      continue;
    }
    if (ch === '-' && body[i + 1] === '-') {
      while (i < body.length && body[i] !== '\n') i += 1;
      stripped += ' ';
      continue;
    }
    if (ch === '/' && body[i + 1] === '*') {
      i += 2;
      while (i < body.length && !(body[i] === '*' && body[i + 1] === '/')) i += 1;
      i += 2;
      stripped += ' ';
      continue;
    }
    if (ch === ';') return { ok: false, text: '一次只能执行一条。' };
    stripped += ch;
    i += 1;
  }
  if (quote !== null) return { ok: false, text: DB_ERROR_TEXT };
  const low = stripped.toLowerCase();
  /**
   * ⚠️ 用**词边界**判，不用 `includes`：`attachment` 这种列名不许被误伤，
   *    而 `attach` 作为第一个词、或者 `;attach`（多语句已在上面拒了）都要拦住。
   *    ⇒ 这里只判"独立出现的关键字"。
   */
  const banned = ['attach', 'detach', 'load_extension', 'vacuum', 'begin', 'commit', 'rollback', 'savepoint', 'release'];
  for (const word of banned) {
    if (new RegExp(`(^|[^a-z0-9_])${word}([^a-z0-9_]|$)`).test(low)) {
      return { ok: false, text: `这一条里不许出现「${word}」。` };
    }
  }
  if (low.includes('readfile') || low.includes('writefile')) {
    return { ok: false, text: DB_ERROR_TEXT };
  }
  return { ok: true, sql };
}

/**
 * **绑定参数过一遍**：只认 `null` / 字符串 / 数字 / 布尔。
 *
 * ⚠️ 二进制（`BLOB`）这一版**不开**：要开得先定"怎么编码、多大上限"，那是另一件事
 *    （如实说没做，见契约 §没做的）。认不出来 ⇒ 拒，**不许悄悄转成字符串**。
 */
export function guardParams(raw) {
  const list = raw === undefined || raw === null ? [] : raw;
  if (!Array.isArray(list)) return { ok: false, text: DB_ERROR_TEXT };
  if (list.length > DB_MAX_PARAMS) return { ok: false, text: DB_ERROR_TEXT };
  for (const v of list) {
    const t = typeof v;
    if (v === null || t === 'string' || t === 'number' || t === 'boolean') {
      if (t === 'number' && !Number.isFinite(v)) return { ok: false, text: DB_ERROR_TEXT };
      continue;
    }
    return { ok: false, text: DB_ERROR_TEXT };
  }
  return { ok: true, params: list };
}

/**
 * **这一条该不该跑**（声明 ＋ 授予 ＋ 语句 ＋ 参数 ＋ 频率，纯逻辑）。
 *
 * ⚠️ 它和 `ask` 那四道闸**同一个形状**：`ok:false` 时 `status` 就是该回的那个码。
 * ⚠️ 宿主与盒子**调的都是这一个函数**（`Apps.dbExec` 里那一句）⇒ 两端不可能分叉。
 *
 * @param {object} o
 * @param {boolean} o.declared 制品清单里声明了 `db` 没有
 * @param {boolean} o.granted  看的人允许了没有
 * @param {string} o.op
 * @param {unknown} o.sql
 * @param {unknown} o.params
 * @returns {{ok:true, sql:string, params:any[]} | {ok:false, status:number, error:string, text:string}}
 */
export function checkAppDb({ declared, granted, op, sql, params } = {}) {
  if (declared !== true) {
    return { ok: false, status: 403, error: 'not-declared', text: DB_DECLARED_TEXT };
  }
  if (granted !== true) {
    return { ok: false, status: 403, error: 'not-granted', text: DB_NOT_GRANTED_TEXT };
  }
  if (!DB_OPS.includes(op)) {
    return { ok: false, status: 400, error: 'bad-op', text: DB_ERROR_TEXT };
  }
  const g = guardSql(sql);
  if (g.ok !== true) return { ok: false, status: 400, error: 'bad-sql', text: g.text };
  const p = guardParams(params);
  if (p.ok !== true) return { ok: false, status: 400, error: 'bad-params', text: p.text };
  return { ok: true, sql: g.sql, params: p.params };
}

/**
 * **开一次子进程，跑一条 SQL**。
 *
 * ── 为什么是子进程（不是 worker、不是主线程）──────────────────
 *   `node:sqlite` 只有同步 API ⇒ 在主线程上跑＝**整个服务等它**。而 `worker.terminate()`
 *   **打断不了一条正在跑的本地调用**（实测：探针卡了 60s）。⇒ 只有**进程**能被 `SIGKILL`
 *   真的停下（实测 1509ms 停下，且库随后照常打开）。
 *
 * ⚠️ **代价**：一次调用多约 30–40ms（实测冷 35ms / 暖 31ms）—— 这是"能硬停下"的价钱，
 *    写在契约里，不藏。
 *
 * @returns {Promise<{ok:true, rows:any[], changes:number, lastInsertRowid:number, truncated:boolean}
 *                   | {ok:false, error:string, text:string}>} **绝不抛**
 */
export function runDbChild({
  file,
  sql,
  params = [],
  op = 'all',
  timeoutMs = DB_TIMEOUT_MS,
  maxBytes = DB_MAX_BYTES,
  maxRows = DB_MAX_ROWS,
  maxResultBytes = DB_MAX_RESULT_BYTES,
  cwd = undefined,
  spawnImpl = nodeSpawn,
  execPath = process.execPath,
  runner = DB_RUNNER,
} = {}) {
  return new Promise((resolve) => {
    /**
     * 🔴 **规格走 stdin，不走 argv**（2026-09-30）：argv 有长度上限（一条大 INSERT 会撞），
     *    而且 `/proc/<pid>/cmdline` 把参数摊给同机所有人看。stdin 两样都没有。
     */
    const spec = JSON.stringify({ file, sql, params, op, maxBytes, maxRows });
    let child;
    try {
      child = spawnImpl(execPath, [runner], { stdio: ['pipe', 'pipe', 'pipe'], cwd });
    } catch {
      resolve({ ok: false, error: 'spawn', text: DB_ERROR_TEXT });
      return;
    }
    let out = '';
    let over = false;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      // 🔴 **硬停**：只有 `SIGKILL` 拦得住一条正在跑的本地调用（`terminate()` 拦不住）。
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经没了 */
      }
      finish({ ok: false, error: 'timeout', text: DB_TIMEOUT_TEXT });
    }, timeoutMs);
    try {
      child.stdin.on('error', () => {
        /* 子进程可能已经没了 */
      });
      child.stdin.end(spec);
    } catch {
      /* 下面 exit/error 那两条会如实说 */
    }
    child.stdout.on('data', (d) => {
      out += d;
      // 子进程的输出也封顶：一条 `SELECT *` 不许把内存吃光
      if (out.length > maxResultBytes) {
        over = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已经没了 */
        }
        finish({ ok: false, error: 'too-big', text: DB_TOO_BIG_TEXT });
      }
    });
    child.stderr.on('data', () => {
      /* 子进程的报错走正文那一条，不要它自己那串栈 */
    });
    child.on('error', () => finish({ ok: false, error: 'spawn', text: DB_ERROR_TEXT }));
    child.on('exit', (code) => {
      if (over) return;
      if (code !== 0) {
        finish({ ok: false, error: 'exit', text: DB_ERROR_TEXT });
        return;
      }
      let j = null;
      try {
        j = JSON.parse(out);
      } catch {
        finish({ ok: false, error: 'bad-json', text: DB_ERROR_TEXT });
        return;
      }
      if (!j || typeof j.ok !== 'boolean') {
        finish({ ok: false, error: 'bad-json', text: DB_ERROR_TEXT });
        return;
      }
      if (j.ok === false) {
        // 子进程认出来的那几档（满 / 语法错），原样带回来
        finish({ ok: false, error: String(j.error ?? 'db'), text: String(j.text ?? DB_ERROR_TEXT) });
        return;
      }
      finish({
        ok: true,
        rows: Array.isArray(j.rows) ? j.rows : [],
        changes: Number.isFinite(j.changes) ? j.changes : 0,
        lastInsertRowid: Number.isFinite(j.lastInsertRowid) ? j.lastInsertRowid : 0,
        truncated: j.truncated === true,
      });
    });
  });
}

// ── 会话票（页面开着的时候用它，不再反复出示入口签名）──────────────

/** 签一张票：**绑人 ＋ 绑 app ＋ 绑版本 ＋ 到期**。 */
export function mintTicket({ key, sub, id, version, now = Date.now(), ttlMs = DB_TICKET_TTL_MS }) {
  const exp = now + ttlMs;
  const sig = ticketSig({ key, sub, id, version, exp });
  return `${Buffer.from(JSON.stringify({ u: sub, i: id, v: String(version), e: exp }), 'utf8').toString('base64url')}.${sig}`;
}

function ticketSig({ key, sub, id, version, exp }) {
  return nodeCrypto
    .createHmac('sha256', key)
    .update(`${TICKET_PURPOSE}|${sub}|${id}|${version}|${exp}`)
    .digest('hex');
}

/**
 * 验一张票。**四道**：形状 / 签名 / 到期 / **绑的是同一个 app**。
 * ⚠️ 认不出来一律 `null`（不猜、不抛）。
 */
export function verifyTicket({ key, ticket, id, now = Date.now() }) {
  if (typeof ticket !== 'string' || typeof id !== 'string') return null;
  const dot = ticket.indexOf('.');
  if (dot <= 0) return null;
  let j = null;
  try {
    j = JSON.parse(Buffer.from(ticket.slice(0, dot), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const sig = ticket.slice(dot + 1);
  if (!j || typeof j.u !== 'string' || typeof j.i !== 'string' || typeof j.v !== 'string') return null;
  const exp = Number(j.e);
  if (!Number.isFinite(exp) || exp <= now) return null;
  if (j.i !== id) return null;
  const want = ticketSig({ key, sub: j.u, id: j.i, version: j.v, exp });
  const a = Buffer.from(want, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  if (a.length !== b.length || !nodeCrypto.timingSafeEqual(a, b)) return null;
  return { sub: j.u, id: j.i, version: j.v, exp };
}
