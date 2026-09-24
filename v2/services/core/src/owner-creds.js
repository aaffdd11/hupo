// **主人那一份的"语言钥匙"怎么写**（主人 2026-09-24 选的那条路）。
//
// ── 事实（读的是 DSH 自己的代码，不是猜的）────────────────────
//   那份文件是 `$DSH_HOME/.credentials.yaml`，格式 `version: 1` +
//   `refs:`（名字 → 字符串）＋ `records:`（`<scope>/<id>` → `{kind, payload}`）。
//   实测这台机器上：
//     · `refs.DEEPSEEK_API_KEY` = **就是那把钥匙**（35 字符那种）；
//     · `records` 里那条是 `client-connection/browser-session`、`kind: grant`
//       —— 那是**GUI 的浏览器会话授权**，**与钥匙无关**。
//   ⇒ 换钥匙**只动 `refs` 里那一行**。`records` 那一块**一个字节都不许变**
//     （改它 = 把主人的浏览器会话搞坏）。
//
// ── 三条纪律 ────────────────────────────────────────────────
//   ① **先备份**（同目录 `.bak.<时间>`，0600）—— 这是全机器最要紧的一个文件；
//   ② **外科式**：只替换那一行的值，其余行原样（有判据逐字节比）；
//   ③ **原子写 + 0600**：先 `.tmp` 再 `rename`（DSH 可能随时在读它）。
//
// 🔴 **钥匙永远不进日志、不进回执**：这里所有返回值里都没有值本身。

import nodeFs from 'node:fs';

/** 那一行长什么样（名字固定 —— 事实来自 DSH 的 `DEFAULT_API_KEY_ENV`）。 */
export const OWNER_KEY_REF = 'DEEPSEEK_API_KEY';

/** 值能不能收（与 `/api/model-key` 那条路同一条规矩）。 */
export function ownerKeyOk(v) {
  return typeof v === 'string' && v.length > 0 && /^[\x20-\x7e]+$/.test(v);
}

/**
 * **只换 `refs` 里那一行的值**（纯函数，好判）。
 *
 * ⚠️ 三种形状都要认：`refs:` 段里有那一行 / 有 `refs:` 段但没那一行 / 连 `refs:` 都没有。
 * ⚠️ 认不出这份文件（例如**预发布那种扁平格式**、或根本不是 YAML）⇒ `null`：
 *    **宁可不写**，也不要把主人的凭据文件写坏（调用方据此如实报错）。
 *
 * @returns {string|null} 新的全文
 */
export function renderOwnerKey(text, key) {
  if (!ownerKeyOk(key)) return null;
  const src = String(text ?? '');
  if (src.trim() === '') return null;          // 空的 ⇒ 我们不猜格式
  const lines = src.split('\n');
  const eol = src.endsWith('\n');

  // 找 `refs:` 那一段的范围（到下一个"顶格的非空行"为止）
  let refsAt = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^refs:\s*$/.test(lines[i])) {
      refsAt = i;
      break;
    }
  }
  if (refsAt === -1) {
    // 没有 `refs:` 段：**不自己造**（那份文件的布局由 DSH 说了算）
    return null;
  }
  let end = lines.length;
  for (let i = refsAt + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    if (!/^\s/.test(raw)) { end = i; break; }  // 顶格 ⇒ 这一段完了
  }

  let hit = -1;
  for (let i = refsAt + 1; i < end; i += 1) {
    const m = lines[i].match(/^(\s+)([A-Za-z_][A-Za-z0-9_]*)(\s*:)(.*)$/);
    if (m && m[2] === OWNER_KEY_REF) { hit = i; break; }
  }
  // 值**不加引号、不转义**：能收的只有 ASCII 可打印字符（上面那道闸），
  // 而钥匙那种串在 YAML 里是安全的裸标量。写别的形状反而会和 DSH 自己写的不一致。
  const line = `  ${OWNER_KEY_REF}: ${key}`;
  if (hit === -1) {
    // 有 `refs:` 但没这一行 ⇒ **插在 `refs:` 段的最前面**（紧贴 `refs:` 那一行之后）
    lines.splice(refsAt + 1, 0, line);
  } else {
    lines[hit] = line;
  }
  const out = lines.join('\n');
  return eol ? out : out.replace(/\n$/, '');
}

/**
 * 落到盘上：**备份 → 原子写 → 写完自己核一遍**。
 *
 * ⚠️ 核的是两件事：① 那一行**读回来正是新值**；② `records:` 那一段**逐字节没变**。
 *    任一不过 ⇒ 我们把备份**放回去**，并如实报错（宁可回到原样）。
 *
 * @returns {{ok:boolean, why:string, backup?:string}}
 */
export function writeOwnerKey({ file, key, fs = nodeFs, now = Date.now } = {}) {
  if (!ownerKeyOk(key)) return { ok: false, why: 'bad-key-chars' };
  let before;
  try {
    before = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, why: `读不到那份凭据：${err?.code ?? err?.message ?? err}` };
  }
  const next = renderOwnerKey(before, key);
  if (next === null) return { ok: false, why: 'unexpected-format' };

  const backup = `${file}.bak.${now()}`;
  try {
    fs.writeFileSync(backup, before, { mode: 0o600 });
    fs.chmodSync(backup, 0o600);
  } catch (err) {
    // 备份写不出来 ⇒ **不往下走**（没有退路就不动它）
    return { ok: false, why: `备份写不出来：${err?.code ?? err?.message ?? err}` };
  }

  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, next, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    return { ok: false, why: `写不进去：${err?.code ?? err?.message ?? err}`, backup };
  }

  // 写完自己核（**判据打在真那一侧**：核的是盘上那份，不是内存里那个字符串）
  let after;
  try {
    after = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, why: `写完读不回来：${err?.code ?? err?.message ?? err}`, backup };
  }
  const okLine = new RegExp(`^\\s+${OWNER_KEY_REF}\\s*:\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(after);
  if (!okLine || recordsOf(after) !== recordsOf(before)) {
    try {
      fs.writeFileSync(file, before, { mode: 0o600 });
    } catch { /* 尽力还原 */ }
    return { ok: false, why: okLine ? 'records-changed' : 'verify-failed', backup };
  }
  return { ok: true, why: 'saved', backup };
}

/**
 * `records:` 那一段（到下一个顶格行为止）—— **只给判据用**：
 * 换钥匙**绝不许**动它。取不到（没有这一段）⇒ 空串。
 */
export function recordsOf(text) {
  const lines = String(text ?? '').split('\n');
  const at = lines.findIndex((l) => /^records:\s*$/.test(l));
  if (at === -1) return '';
  const out = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== '' && !/^\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}
