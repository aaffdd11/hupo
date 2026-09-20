// 「续做」的调度：**这一件该不该自动重来**。纯函数，没有 IO。
//
// 决策 **D10.1–D10.5**（`05-DECISIONS.md` §二·补）+ 手册 `08-SPEC.md` §15.3 / §11.1。
//
// ── 一句话 ────────────────────────────────────────────────
//
// **只自动重来"整轮只碰过只读工具"的活**（D10.1），而且有额度
// （≤3 次 / 6 小时 / 全局并发 1 / 同一件间隔 ≥5 分钟）。
//
// ── ⚠️ 额度数的是「**发起过几次**」，不是「失败过几次」──────────
//
// 手册 §15.3 说"上游失败 / OOM **不计入**那 3 次额度"。
// 那条要实现，得先能**认出**这两类——而今天两个都认不出来：
//   · §11.1 的崩溃环要 `journalctl` 里有没有 oom-kill，**这台机器上服务不在 systemd 里**
//   · §15.4 的上游熔断**还没建**
//
// ⇒ 取"**数发起次数**"：
//   · 它是**更严**的方向（认不出来就都算），所以**不会重复下单**；
//   · 而且它**不会说假话**——"我试过 3 次"是真的（不像"失败了 3 次"那样得先分类）；
//   · OOM 环那个真正的风险，由**降级启动**（§11.1）单独挡住，不靠额度。
//
// ⚠️ **明说没做**：`上游不通` / `OOM` 的**免额度**还没实现（见 `10-RECONCILE.md` §九）。
//
// ── 纯函数 ────────────────────────────────────────────────
// 输入是事件数组 + 这一轮对账的发现，输出是"重来哪一件"。**没有任何 IO**，
// 所以那四条规则可以一条一条离线钉死。

/** §15.3：同一件 **≤3 次** */
export const RESUME_MAX_ATTEMPTS = 3;
/** §10.2：同一 task 两次续做间隔 **≥5 min** */
export const RESUME_MIN_GAP_MS = 5 * 60_000;
/** §15.3：**只对最近 6 小时内**的说话 */
export const RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;

/** 续做记录的事件名（落盘、取号 —— 额度要活过重启） */
export const RESUMED_EVENT = 'task/resumed';

/**
 * 从事件里数出**每一件活发起过几次续做**，以及最后一次是什么时候。
 *
 * @returns {Map<string, {attempts: number, lastAt: number}>}
 */
export function readResumeRecords(events) {
  const out = new Map();
  for (const e of events) {
    if (!e || e.type !== RESUMED_EVENT) continue;
    const ref = typeof e.ref === 'string' ? e.ref : null;
    if (ref === null) continue; // 归属不明的续做记录没法算额度
    const prev = out.get(ref) ?? { attempts: 0, lastAt: 0 };
    out.set(ref, {
      attempts: prev.attempts + 1,
      lastAt: Math.max(prev.lastAt, typeof e.at === 'number' ? e.at : 0),
    });
  }
  return out;
}

/**
 * 决定这一轮开机**要不要自动重来一件**。
 *
 * @param {object} o
 * @param {{orphans: Array, unanswered: Array}} o.findings  `findInterrupted` 的产出
 * @param {Array<object>} o.events  日志（用来数额度）
 * @param {number} [o.now]
 * @param {boolean} [o.degraded]    崩溃环降级中 ⇒ **一件都不重来**（§11.1）
 * @param {number} [o.maxAttempts] / [o.minGapMs] / [o.windowMs]
 * @returns {{pick: {ref: string, text: string, attempt: number} | null, reason: string,
 *            considered: number}}
 *          `reason` 是**给人看的诊断**，不是给用户的文案。
 */
export function planResume({
  findings,
  events,
  now = Date.now(),
  degraded = false,
  maxAttempts = RESUME_MAX_ATTEMPTS,
  minGapMs = RESUME_MIN_GAP_MS,
  windowMs = RESUME_WINDOW_MS,
} = {}) {
  const all = [...(findings?.orphans ?? []), ...(findings?.unanswered ?? [])];
  if (all.length === 0) return { pick: null, reason: 'nothing-interrupted', considered: 0 };

  // ① **降级期间一件都不重来**（§11.1：崩溃环里继续续做只会放大问题）
  if (degraded) return { pick: null, reason: 'degraded', considered: all.length };

  // ② 按归属去重；同一件活两种形状都命中时，取**更近**的那条（它带着原话）
  const byRef = new Map();
  for (const f of all) {
    const key = f.ref ?? null;
    const prev = byRef.get(key);
    if (!prev || (f.at ?? 0) > (prev.at ?? 0)) byRef.set(key, f);
  }

  const records = readResumeRecords(events);
  let considered = 0;
  let lastReason = 'no-candidate';
  const candidates = [];

  for (const [ref, f] of byRef) {
    // ⚠️ 归属不明 ⇒ **不重来**。认不出是哪件活，就没法算额度，也没法保证幂等。
    if (typeof ref !== 'string' || ref === '') {
      lastReason = 'no-ref';
      continue;
    }
    // ⚠️ **动过东西的一律不重来**（D10.1）——这一条是这一整套的地基
    if (f.mutated) {
      lastReason = 'touched-something';
      continue;
    }
    // ⚠️ 没有原话就没法重来（连"重来什么"都不知道）
    if (typeof f.text !== 'string' || f.text.trim() === '') {
      lastReason = 'no-text';
      continue;
    }
    // §15.3：只对最近 6 小时内的说话
    if (now - (f.at ?? 0) > windowMs) {
      lastReason = 'too-old';
      continue;
    }

    const rec = records.get(ref) ?? { attempts: 0, lastAt: 0 };
    if (rec.attempts >= maxAttempts) {
      lastReason = 'over-quota';
      continue;
    }
    // §10.2：同一件两次之间 ≥5 分钟
    if (rec.lastAt > 0 && now - rec.lastAt < minGapMs) {
      lastReason = 'too-soon';
      continue;
    }

    considered += 1;
    candidates.push({ ref, text: f.text, at: f.at ?? 0, attempt: rec.attempts + 1 });
  }

  if (candidates.length === 0) return { pick: null, reason: lastReason, considered };

  // ③ **全局并发 1**（D10.5）⇒ 一次只挑一件。
  //    挑**最近**那一件：它是主人最可能还在等的那件。
  candidates.sort((a, b) => b.at - a.at);
  const chosen = candidates[0];
  return {
    pick: { ref: chosen.ref, text: chosen.text, attempt: chosen.attempt },
    reason: 'resume',
    considered,
  };
}
