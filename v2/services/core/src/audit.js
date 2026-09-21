// **给主人看的那一笔账**（账 #39 的后一半 · 契约 `docs/dev/43-AUTO-PROVISION.md` §十四）。
//
// ── 为什么要有它 ──────────────────────────────────────────
// "注销"是**不可逆**的（那一台连同里面的东西一起收掉）。而在这之前：
// 助手那侧只有 journal 里滚过去的一行，**主人没有一个地方能一眼看出"谁把哪一台收掉了"**。
// ⇒ 每一件"有人想收 / 真的收掉了 / 拒了"都留一行，**人和机器都能读**。
//
// ── 🔴 格式只有这一处出处 ─────────────────────────────────
//     `[YYYY-MM-DD HH:MM:SS] 事件 · 租户 · 用户 · 手机(掩码) · 说明`
//
// 特权侧（shell）那边写的是**同一个形状**（`remove-tenant.sh` 的 `audit()`）。
// ⚠️ 两边各写一份格式 = **一定会漂**，而漂了之后"账"就分成两半、谁也读不全 ——
//    这个项目已经栽过两次同一种病（`3.req.cancel`、仓库根算错一级）。
//    ⇒ 判据里有一条**跨产物**的闸：拿真跑出来的两种行去比形状。
//
// ── 三条纪律 ──────────────────────────────────────────────
//   ① **不含钥匙**（任何形态：原文、片段、长度都不要）；
//   ② **手机号只写掩码**（`139****3333`）—— 这一行是要给人看的，不是给人肉的；
//   ③ **拒了也要记**（"有人想删、没让他删、为什么" —— 那正是最该看见的一行）。

import nodePath from 'node:path';

/** 审计文件叫什么（服务这一侧；特权侧那份在 `/var/log/hupo/`）。 */
export const AUDIT_FILE = 'audit.log';

/** 服务这一侧的审计文件放哪。 */
export function auditPath(dataDir) {
  return nodePath.join(dataDir, AUDIT_FILE);
}

/** 两位补零（本地时间：主人看的是墙上那个钟）。 */
const p2 = (n) => String(n).padStart(2, '0');

/** `YYYY-MM-DD HH:MM:SS`（**本地时间** —— 这一行是给人看的）。 */
export function stamp(at = Date.now()) {
  const d = new Date(at);
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  );
}

/**
 * 手机号掩码。**只留前三后四**。
 * ⚠️ 拿不到就写 `—`，**不许**把用户 id 或别的什么当成手机号塞进来。
 */
export function maskPhone(phone) {
  const p = String(phone ?? '');
  return /^\d{7,}$/.test(p) ? `${p.slice(0, 3)}****${p.slice(-4)}` : '—';
}

/**
 * 拼一行审计。**纯函数**（`test/unit` 里逐字段钉）。
 *
 * @param {object} o
 * @param {number} [o.at]
 * @param {string} o.what      事件（`收到请求` / `真收掉了` / `没收成` / `拒了`）
 * @param {string} [o.tenant]  租户名（`hupo-t3` / `—`）
 * @param {string} [o.userId]  用户 id（`u3` / `—`）
 * @param {string} [o.phone]   手机号（**会被掩码**）
 * @param {string} [o.detail]  一句人话（为什么拒 / 收成什么样）
 * @returns {string} 一行（**不带换行**）
 */
export function auditLine({ at = Date.now(), what, tenant = null, userId = null, phone = null, detail = null } = {}) {
  const w = String(what ?? '').trim();
  if (!w) throw new Error('auditLine 需要 what');
  return [
    // ⚠️ **时间和事件之间是空格、不是 ` · `**（这一格是"一句话的开头"，
    //    后面那几格才是字段）。判据里钉了整行的字面形状 —— 我第一版就是错在这儿。
    `[${stamp(at)}] ${w}`,
    String(tenant ?? '—').trim() || '—',
    String(userId ?? '—').trim() || '—',
    maskPhone(phone),
    String(detail ?? '').trim() || '—',
  ].join(' · ');
}

/**
 * 往审计文件里追加一行。**写不进去也不许把动作带走**（它是旁路信息）——
 * 但要**说出来**（`onError`），不许静默。
 *
 * @param {object} o
 * @param {string} o.file
 * @param {string} o.line
 * @param {import('node:fs')} [o.fs]
 * @param {(m:string)=>void} [o.onError]
 * @returns {boolean} 写进去了没有
 */
export function appendAudit({ file, line, fs, onError = () => {} }) {
  try {
    fs?.appendFileSync ? fs.appendFileSync(file, `${line}\n`, { mode: 0o644 }) : null;
    return true;
  } catch (err) {
    onError(`  ⚠️ 审计那一行没写进去（${file}）：${err?.code ?? err?.message ?? err}`);
    return false;
  }
}
