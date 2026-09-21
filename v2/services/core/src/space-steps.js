// **开空间那三步**（真进度 · 契约 `docs/dev/42-SPACE-PROGRESS.md`）。
//
// 主人 2026-09-21：*"创建 docker 空间要能够对用户展示进度。"*
//
// 🔴 **但项目有一条硬规矩：不许假进度**（`38` §8.3 点名过）。
//    ⇒ 这里的三步**每一条都是服务端真的知道的事实**，没有百分比：
//
//      assigned  分到了哪一台（表里有他 → 一定有）
//      starting  那一台**连上来了没有**（`channel.hasTunnel()` 真的知道）
//      ready     就绪（同一条事实，语义上是"可以用"）
//
// ⚠️ **为什么不给百分比**：我们**不知道**"还要多久"——那取决于容器什么时候连上来。
//    编一个数字就是"看着在动、其实不知道到哪"，比诚实的一句更坏。
//
// ⚠️ 纯函数（`stepsFor` 在 `test/unit` 里逐档钉）。

/** 三步的名字。**顺序就是它们发生的顺序。** */
export const SPACE_STEPS = Object.freeze(['assigned', 'starting', 'ready']);

/**
 * @param {number} done 走到第几步（0 = 刚排队 · 1 = 分到了、正在起 · 2 = 就绪）
 * @returns {{step: string, done: boolean}[]}
 */
export function stepsFor(done) {
  const n = Number.isFinite(done) ? Math.max(0, Math.min(SPACE_STEPS.length, done)) : 0;
  return SPACE_STEPS.map((step, i) => ({ step, done: i < n }));
}
