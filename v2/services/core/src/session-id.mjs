// **会话 id 的形状** —— 判据只有这一处出处（`sdk-server-hupo.mjs` 与
// `dsh-sessions.mjs`／`config.js` 都 import 这一个文件）。
//
// ── 为什么"DSH 收什么就收什么"，而不是我们自己拍脑袋 ──────────────────
//
// 真机读数（2026-09-26 · 主人的盒子 · 产品层发布之后 · 原话照抄）：
//
//   {"id":2,"error":{"code":-32603,"message":"sessionId 形状不认（只收
//    [A-Za-z0-9._~-]、最长 200）：\"owner/aoshu-bank.muh709vsibnh.1\"
//    ⇒ 不猜、也不替它换一个 —— 请用映射（dsh-sessions.mjs）产出的那个 id"}}
//
// 那一条 id 是 **DSH 自己的写法**（映射里按契约 §八"取最新一条当正本"钉的就是它）：
//   · **注册表 / 会话头里的 `id` 字段是原始形式** —— `owner/aoshu-bank.<…>`，**带一个 `/`**；
//   · **目录名才是转义形式**：DSH 的持久化层（`dsh-session-persistence-jsonl` 的
//     `encodeSegment`）把它当**一个**路径段来转义 —— 安全字符 `[A-Za-z0-9._-]` 原样、
//     其余（**包括 `~` 自己**）写成 `~XXXX`，所以 `/` ⇒ `~002F`；
//     另外 `.` / `..` **整段**特判成 `~002E` / `~002E~002E`。
//
// 上一版只收 `[A-Za-z0-9._~-]`（`/` 在黑名单里）⇒ 把 **DSH 自己的 id 判成非法**
// ⇒ 服务端如实回上面那条错误帧 ⇒ 产品层发布之后**任何一句话都没有答复**
// （那一台 DSH 一直活着、什么都不说）⇒ 只好回滚。
//
// ⇒ 这一层按 **DSH 自己收什么** 收：DSH 那边 `sessions.create(id)` 只要求
//   "非空字符串 / 不重复"，路径安全由它自己的 `encodeSegment` 负责。
//   我们**明确拒掉**的只有这四类（是"多一层防线"，不是 DSH 的限制）：
//     · 空串 / 不是字符串；
//     · 超长（`SESSION_ID_MAX` 住代码，**不写进文档**）；
//     · 控制字符 / NUL；
//     · `.` / `..` **整段**（路径穿越的形状）。
//   ⚠️ **"含 `/`"本身不是穿越** —— DSH 会把整个 id 转义成**一个**目录名。
//      别把它当穿越拒掉（上一版就是这么错的）。
//
// ⚠️ 别把映射里钉住的那个值**再转义一次**（`sessionIdFor` 的转义是给
//    "我们自己按 scope 名算出来的 id"用的）—— 那会去找一条**不存在**的会话。

/**
 * 会话 id 最长多少 —— **代码里的常量**（文档不许抄数值）。
 *
 * 200：够装下 DSH 自己那种 `<owner>/<scope>.<base36>.<n>`（真机那条二十几个字符），
 * 同时挡住"拿一整段东西当 id"的形状。
 */
export const SESSION_ID_MAX = 200;

/** 控制字符：C0 控制符 ＋ DEL ＋ C1 控制符（**含 NUL**）。 */
const CONTROL_CHAR = /[\u0000-\u001F\u007F-\u009F]/u;

/**
 * 形状**问题**：没问题 ⇒ `null`，有问题 ⇒ 一句人话（说清是哪一类）。
 *
 * 判据本体就是它 —— `isSessionIdShape` / `assertSessionId`（服务端那一侧）
 * 与 `readSessions`（映射那一侧）都调**这一个函数**，不可能有两套口径。
 *
 * @param {unknown} id
 * @returns {string|null}
 */
export function sessionIdProblem(id) {
  if (typeof id !== 'string' || id === '') return '不是非空字符串';
  if (id.length > SESSION_ID_MAX) return `太长（${id.length} > ${SESSION_ID_MAX}）`;
  if (CONTROL_CHAR.test(id)) return '含控制字符 / NUL';
  if (id.split('/').some((seg) => seg === '.' || seg === '..')) {
    return '含 `.` / `..` 整段（路径穿越的形状）';
  }
  return null;
}

/** 形状对不对（`true` = 收）。纯函数，判据直接打它。 */
export function isSessionIdShape(id) {
  return sessionIdProblem(id) === null;
}

/**
 * 校验一个会话 id。**不合法就如实拒**（不猜、也不替它换一个）。
 *
 * @param {unknown} id
 * @returns {string} 原样返回（合法时）
 * @throws {Error} 不合法 ⇒ 说清问题 ＋ 为什么 `/` 必须收
 */
export function assertSessionId(id) {
  const problem = sessionIdProblem(id);
  if (problem === null) return id;
  throw new Error(
    `sessionId 形状不认（${problem}）：${JSON.stringify(id)}\n` +
      '    ⇒ 收的是"DSH 自己收的那种 id"（非空、不超长、不含控制字符、不含 `.`/`..` 整段）；\n' +
      '      `owner/aoshu-bank.…` 里那个 `/` 是 DSH 自己的写法（**目录名**才转义成 `~002F`）⇒ 必须收。\n' +
      '    ⇒ 不猜、也不替它换一个 —— 请用映射（dsh-sessions.mjs）产出的那个 id',
  );
}
