// **一个房间（scope）一条 DSH 会话** —— 那份映射（mapping）。
//
// 契约：`docs/dev/110-ONE-SESSION-PER-ROOM.md`。
//
// ── 这个文件要解决什么 ──────────────────────────────────────────
//
// DSH 的官方 SDK server（`@deepseek-ai/dsh-sdk-jsonrpc-server`）**只能 create、
// 不能 resume**：同一个会话 id 再进去，它报 `session "…" already exists`。
// 而 DSH 的会话记录**落在 `$DSH_HOME/sessions/` 里，跨进程活着**。
// ⇒ 旧的调度器只能**每换一个进程实例就换一个会话 id**
//   （`<会话>.<bootId>.<第几个>`，见 `agent-runtime.js` 的历史注释），
//   于是界面里"一个工作区 = N 个对话"（真机读数：`/data/main` 38 条、
//   `/data/workspaces/aoshu-bank` 16 条）。
//
// 现在那一层换成了我们自己的 `sdk-server-hupo.mjs`（它会 resume），
// 而**客户端的会话 id 不再变** —— 它从**这份映射**里取：
//
//   一个用户一份（`<他的数据目录>/dsh-sessions.json`）：
//     { "main": "main", "aoshu-bank": "aoshu-bank" }
//
// ── 三条纪律（每一条都有判据钉着）──────────────────────────────
//
//   ① **稳定**：`sessionIdFor(scope)` 是纯函数，同一个 scope 永远同一个 id；
//   ② **不猜**：映射文件读不动 / 内容坏掉 ⇒ **如实报错**，绝不"当成没有"——
//      当成没有就会**悄悄多出一条对话**，而那正是这个契约要修的那个毛病
//      （详见 `readSessions` 顶上那段）；
//   ③ **原子写**：先写 `.tmp`，`chmod 0600`，再 `rename` —— 半截文件不会被读到。
//
// ── 为什么 fs 是可注入的 ───────────────────────────────────────
//
// 判据要能问"坏掉的那份有没有被盖掉""写是不是先 tmp 后 rename"，
// 而这些问题的答案**只能在真的文件系统调用上**看见 ⇒ 注入一个假 fs，
// 把调用序列记下来（照 `prune.js` 那条"纯逻辑与读盘分开"的老规矩）。

import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

// ★ 会话 id 的**形状**判据只有一处出处（`session-id.mjs`）——
//   映射里钉的值与服务端（`sdk-server-hupo.mjs`）收的值用**同一个函数**校验。
//   为什么必须一处：2026-09-26 真机事故（产品层发布之后全程没有答复）的根因
//   就是这里两套口径 —— 服务端不收 `/`，而映射里钉的 `owner/aoshu-bank.…`
//   **带一个 `/`**（DSH 自己的写法）。读法见 `session-id.mjs` 顶上那段。
import { sessionIdProblem } from './session-id.mjs';

/** 映射文件叫什么（一个用户一份，落在**他的数据目录**下面）。 */
export const DSH_SESSIONS_FILE = 'dsh-sessions.json';

/**
 * 会话 id 最长多少 —— 超了就在尾巴上挂一个短哈希（见 `sessionIdFor`）。
 *
 * 100：DSH 那边的 id 会变成一个目录名（它自己会转义，长度不是硬限制），
 * 但**人要看**这个目录名（排障、真机读数），太长就没法看。
 * 100 足够装下任何正常的 scope，同时留出哈希的位置。
 */
export const SCOPE_ID_MAX = 100;

/** scope 名里"不用转义"的那些字符（与 DSH 自己的转义表一致，见下）。 */
const SAFE_CHAR = /^[A-Za-z0-9._-]$/;

/** 把一个字符写成 `~XXXX`（4 位十六进制）。 */
function escapeUnit(ch) {
  return `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * **一个 scope 的会话 id**。纯函数、稳定、**单射**（不同的 scope 不会撞）。
 *
 * ⚠️ 转义表**照抄 DSH 自己那一份**（`dsh-session-persistence-jsonl` 的
 *    `encodeSegment`）：安全字符原样、其余（**包括 `~` 本身**）写成 `~XXXX`。
 *    为什么照抄：那个函数是**单射**的（`~` 自己也被转义），所以
 *    `a b` → `a~0020b` 与一个字面叫 `a~0020b` 的 scope 会变成**不同的** id。
 *    随手写个"把非法字符换成 `-`"就会把这两间并成一条对话
 *    —— 而那种错误在界面上看起来只是"两间的话混在一起"。
 *    `'.'` / `'..'` 那两个特例也照它（它们会变成 `~002E`，不是路径穿越）。
 *
 * @param {string} scope 房间名（`main` / 小程序 id …）
 * @returns {string} 会话 id（只含 `[A-Za-z0-9._~-]`）
 * @throws 空的 / 不是字符串 ⇒ 抛（**不猜**：空 id 会让 DSH 的持久化直接抛，
 *   而"猜一个默认值"就等于把某一间的话送进另一间）
 */
export function sessionIdFor(scope) {
  if (typeof scope !== 'string' || scope === '') {
    throw new Error(`scope 必须是非空字符串（收到 ${JSON.stringify(scope)}）—— 不许猜一个默认的会话 id`);
  }
  // 两个特例照 DSH 那份来（否则它们会变成相对路径）
  if (scope === '.') return '~002E';
  if (scope === '..') return '~002E~002E';

  let full = '';
  for (let i = 0; i < scope.length; i += 1) {
    const ch = scope[i];
    full += SAFE_CHAR.test(ch) ? ch : escapeUnit(ch);
  }
  if (full.length <= SCOPE_ID_MAX) return full;

  // 太长：留住能看懂的那一截，尾巴挂上**原文的**短哈希（否则截断会把两间并掉）
  const hash = nodeCrypto.createHash('sha256').update(scope, 'utf8').digest('hex').slice(0, 12);
  const room = SCOPE_ID_MAX - hash.length - 1;
  let head = '';
  for (let i = 0; i < scope.length; i += 1) {
    const ch = scope[i];
    const part = SAFE_CHAR.test(ch) ? ch : escapeUnit(ch);
    if (head.length + part.length > room) break;
    head += part;
  }
  return `${head}~${hash}`;
}

/**
 * 进程池那把键（`<userId>/<scope>`，见 `worlds.js` 的 `agentKeyFor`）⇒ scope。
 *
 * ⚠️ 取的是**第一个 `/` 之后**的全部：`checkScope` 不许 scope 里有 `/`，
 *    所以这个切法是准的（userId 里也没有 `/`）。
 *    没有 `/`（判据里直接 `runtime.agent('main')` 那种）⇒ 整串就是 scope。
 */
export function scopeOfAgentKey(agentKey) {
  const s = String(agentKey ?? '');
  const i = s.indexOf('/');
  return i === -1 ? s : s.slice(i + 1);
}

/**
 * 这一份 `cfg` 的映射文件在哪。**没有落点就返回 `null`**（不猜一个路径）。
 *
 * 两种来源：`cfg.sessionMapPath`（`worlds.js` 按人给的那一份）优先；
 * 其次是 `cfg.dataDir`（`config.js` 的默认值就是它）。
 * 手搭的 `cfg`（判据里那些）两样都没有 ⇒ `null` ⇒ 只按 scope 名算 id
 * （**仍然是一间一条**，只是不落映射 —— 那种 cfg 本来就没有"这个人的数据目录"）。
 */
export function mappingPathFor(cfg = {}) {
  if (cfg.sessionMapPath) return String(cfg.sessionMapPath);
  if (cfg.dataDir) return nodePath.join(String(cfg.dataDir), DSH_SESSIONS_FILE);
  return null;
}

/**
 * 读那份映射。**读不动 / 坏掉 ⇒ 抛**（"不猜"那一条纪律的落点）。
 *
 * ── 为什么坏掉时**不能**"当成没有" ──────────────────────────
 *
 * "当成没有"的下场：这一间会按 scope 名**重算一个新 id** ⇒ DSH 里
 * **多出一条对话**，而旧那条还在盘上 —— 这正是 `110` 要修的那个毛病，
 * 而且它**不会报任何错**（看起来只是"它今天不记得了"）。
 * ⇒ 宁可**当场失败**（调用方那一轮会说不出话，主人/运维看得见），
 *   也**不许**偷偷长出一条新对话。
 *
 * ⚠️ 抛之前**一个字节都不改**那个文件（原文留着，人手修得回来）。
 *
 * @param {object} o
 * @param {string} o.file 映射文件（`null` ⇒ 空映射）
 * @param {object} [o.fs] 注入的 fs（要 `readFileSync`）
 * @returns {Record<string,string>} scope → 会话 id
 */
export function readSessions({ file, fs = nodeFs } = {}) {
  if (!file) return {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // 没有这个文件 = 第一次用，**正常**（不是"坏掉"）
    if (err?.code === 'ENOENT') return {};
    throw new Error(`会话映射读不了：${file}\n    ⇒ ${err?.message ?? err}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `会话映射不是一份能读的 JSON：${file}\n` +
        '    ⇒ **不猜**：把它当成"没有映射"会悄悄给这一间再开一条对话（`110` 要修的就是那个毛病）。\n' +
        '    ⇒ 这个文件**一个字节都没动**。修法：把这份 JSON 修正；或者（确定不要它了）删掉它 ——\n' +
        '      删掉之后每一间会按 scope 名重算一个 id（旧的那几条对话会留在盘上，不会被删）。\n' +
        `    原始报错：${err?.message ?? err}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`会话映射的形状不对（要一个对象：{"main":"main"}）：${file}`);
  }
  const out = {};
  for (const [scope, id] of Object.entries(parsed)) {
    // ★ **同一个形状函数**（`session-id.mjs`）：映射里钉的值 == 服务端收的值。
    //   不收的形状（空 / 超长 / 控制字符 / `.`、`..` 整段）在这里就**当场抛** ——
    //   `preflight` 会把它变成"开机拒绝启动"，而不是"某一轮说不出话"。
    //   ⚠️ **不收的形状里没有"带 `/`"** —— `owner/aoshu-bank.…` 是 DSH 自己的写法，必须过。
    const problem = sessionIdProblem(id);
    if (problem !== null) {
      throw new Error(
        `会话映射里 "${scope}" 钉住的 id DSH 收不了（${problem}）：${JSON.stringify(id)}：${file}\n` +
          '    ⇒ 这一条必须与服务端收的**同一个形状**（判据在 `src/session-id.mjs`，只有一处出处）。\n' +
          '    ⇒ 不猜、也不改它 —— 改**映射**（别改代码）。⚠️ `owner/…` 那种**带 `/` 是 DSH 自己的写法**（目录名才转义），必须收',
      );
    }
    out[scope] = id;
  }
  return out;
}

/**
 * 原子写那份映射：先写 `<file>.tmp`（0600），再 `rename` 盖上去。
 *
 * 为什么原子：读到半截 JSON 的后果见 `readSessions`（会抛，会让那一轮说不出话）。
 * `rename` 在同一个目录里是原子的 ⇒ 读的人要么看见旧的、要么看见新的。
 *
 * ⚠️ `0600`：这份文件里有他的**房间名**（`main` / 小程序 id / 会话 id）——
 *    不是秘密，但**没有理由让别人读**（与 `store.js`、`focus-book.js` 一致）。
 */
export function writeSessions({ file, entries, fs = nodeFs, mode = 0o600 } = {}) {
  if (!file) throw new Error('writeSessions：没有映射文件路径（`sessionMapPath` / `dataDir` 都没有）');
  const dir = nodePath.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err?.code !== 'EEXIST') throw new Error(`会话映射的目录建不出来：${dir}\n    ⇒ ${err?.message ?? err}`);
  }
  const tmp = `${file}.tmp`;
  const body = `${JSON.stringify(entries ?? {}, null, 2)}\n`;
  try {
    fs.writeFileSync(tmp, body, { mode });
    // ⚠️ `mode` 只在新文件时生效 —— 老 `.tmp` 还在的话它不改权限 ⇒ 显式再来一次
    try {
      fs.chmodSync?.(tmp, mode);
    } catch {
      /* chmod 失败不改写盘这件事本身；权限位下面那条 rename 之后仍是 0600 的那个新文件 */
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    throw new Error(`会话映射写不下去：${file}\n    ⇒ ${err?.message ?? err}`);
  }
  return file;
}

/**
 * **调度器要的那个 id**：`<userId>/<scope>` ⇒ DSH 会话 id。
 *
 * 路数（这就是"一个房间一个对话"的全部机关）：
 *   ① 映射里有这一间 ⇒ **用它**（可能是父 agent 那一手钉下来的"正本"，
 *      比如旧的那条 `<scope>.<bootId>.<n>`）；
 *   ② 没有 ⇒ 按 `sessionIdFor(scope)` 算一个**稳定**的 id，**落进映射**再返回。
 *
 * ⚠️ 同一个 id 不许被两间占着（那会把两间的话并进一条对话）⇒ 撞了就抛。
 *    （`sessionIdFor` 自己是单射的，所以这只可能来自手写/迁移写坏的映射。）
 *
 * @param {object} o
 * @param {string} o.agentKey 进程池那把键（`<userId>/<scope>`）
 * @param {object} [o.cfg]
 * @param {object} [o.fs] 注入的 fs
 * @returns {string}
 */
export function dshSessionIdFor({ agentKey, cfg = {}, fs = nodeFs } = {}) {
  const scope = scopeOfAgentKey(agentKey);
  const file = mappingPathFor(cfg);
  if (!file) return sessionIdFor(scope);

  const entries = readSessions({ file, fs });
  const pinned = entries[scope];
  if (pinned !== undefined) return pinned;

  const id = sessionIdFor(scope);
  for (const [other, otherId] of Object.entries(entries)) {
    if (other !== scope && otherId === id) {
      throw new Error(
        `会话映射里 "${other}" 已经占着会话 id "${id}"，现在又要把 "${scope}" 也指过去：${file}\n` +
          '    ⇒ 两间用同一条会话 = 两间的话混在一起。**不猜、不改**，请先修那份映射。',
      );
    }
  }
  entries[scope] = id;
  writeSessions({ file, entries, fs });
  return id;
}
