// **磁盘分级**（手册 `08-SPEC.md` §十一 那张表：「80 告警 / 88 清 / 92 拒新重活 / 95 优雅拒绝新会话」）。
//
// ── 为什么要单立成纯函数 ────────────────────────────────────
//   ① **阈值只住一处**（判据与守护都用它）—— 两处各写一份 = 迟早漂；
//   ② 它**算得出**（不像容量/准入那类：本机每层 `memory.max=max` 算不出判据）；
//   ③ 判据能钉住**与手册对得上**（阈值改了，判据会红 —— 见 `test/disk-grade.test.js`）。
//
// ⚠️ **今天只到"规则"这一层**：真正的**守护**（5 分钟一次、按级动作）
//    属于部署期（`P2-12` 要主人点头）⇒ 这一版**不接线**、也不改任何运行时行为。
//
// 🔴 **算不出来就说"算不出来"**：拿不到磁盘用量时回 `unknown`，
//    **绝不许**当成 `ok`（那就是这个项目最忌的"看起来有闸"）。

/** 手册那张表（**数值只住这一处**；判据会与手册逐条对表）。 */
export const DISK_STEPS = Object.freeze([
  { at: 95, grade: 'refuse-new' },
  { at: 92, grade: 'refuse-heavy' },
  { at: 88, grade: 'clean' },
  { at: 80, grade: 'warn' },
]);

/** 每一级**做什么**（守护接线时照这个做；今天只是表）。 */
export const DISK_ACTIONS = Object.freeze({
  ok: '什么都不做',
  warn: '告警（让它看得见）',
  clean: '自动清（缓存/临时产物）',
  'refuse-heavy': '拒新的重活（构建、镜像那类）',
  'refuse-new': '**优雅拒绝新的话**（他还能看到已有的，不会被丢在半路）',
  unknown: '算不出 ⇒ 明说算不出（**绝不当成"没事"**）',
});

/** 对用户说的那一句（会出现在界面上 ⇒ **不许有内部词**）。 */
export const DISK_WORDS = Object.freeze({
  ok: '',
  warn: '',
  clean: '',
  'refuse-heavy': '这台现在腾不出地方干重活了，等一会儿再试。',
  'refuse-new': '这台现在存不下了，先不接新的话 —— 等一会儿再试，你现在这些都在。',
  unknown: '',
});

/**
 * 按已经用掉的百分比分级。
 *
 * @param {unknown} usedPercent 0–100（拿不到就传 null/NaN）
 * @returns {{grade:string, action:string, words:string, percent:number|null}}
 *   `grade` ∈ `ok` / `warn` / `clean` / `refuse-heavy` / `refuse-new` / `unknown`
 */
export function diskGrade(usedPercent) {
  const p = typeof usedPercent === 'number' && Number.isFinite(usedPercent) ? usedPercent : null;
  if (p === null || p < 0 || p > 100) {
    return { grade: 'unknown', action: DISK_ACTIONS.unknown, words: DISK_WORDS.unknown, percent: null };
  }
  let grade = 'ok';
  for (const s of DISK_STEPS) {
    if (p >= s.at) {
      grade = s.grade;
      break;
    }
  }
  return { grade, action: DISK_ACTIONS[grade], words: DISK_WORDS[grade], percent: p };
}

/**
 * 从"盘上还剩多少、总共多少"算百分比（纯函数；拿不到 ⇒ `null`）。
 * ⚠️ 单独一支是因为**算不出来**和"用满了"是两件事 —— 前者回 null，后者回 100。
 */
export function usedPercentOf({ totalBytes, freeBytes } = {}) {
  const t = Number.isFinite(totalBytes) ? totalBytes : NaN;
  const f = Number.isFinite(freeBytes) ? freeBytes : NaN;
  if (!(t > 0) || !(f >= 0) || f > t) return null;
  return ((t - f) / t) * 100;
}
