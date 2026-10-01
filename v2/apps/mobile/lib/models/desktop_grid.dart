// **桌面那一墙图标怎么排**（纯函数 —— 判据在 `test/unit/desktop_grid_test.dart`）。
//
// ── 主人 2026-09-29 原话 ────────────────────────────────────
//   *"app排布要根据页面宽度等宽排列"* —— 问过之后他选的是**每行都铺满**：
//   "1280 宽、7 个图标 ⇒ 一行 7 格铺满（图标大小不变，只是它们之间的距离变大）；
//     图标很多时一行的格数自己变多。窄屏（手机）仍是四列左右。"
//
// ── 🔴 主人 2026-10-01 又定了一次（**这一条覆盖上面那句的"格数自己变多"**）──
//   *「一行根据屏幕大小，不要放超过6个app。而且app都有位置。要模拟苹果的桌面排布。」*
//   问过之后他选的是**甲**：**列数只由屏幕定** ＋ **末行贴左**。
//   ⚠️ 差别在哪儿（这是这次改的全部理由）：
//     改前：`列数 = min(放得下几格, 【图标个数】)` —— **跟着个数走**
//           ⇒ 1 个 app 时那一格 = 整条宽（图标被摊在屏幕中间），3 个时各 1/3
//           ⇒ **加一个 app，已有的那几个会挪位**（那就不是"app 都有位置"）
//     改后：`列数 = min(放得下几格, 6)` —— **只跟屏幕有关**
//           ⇒ 加/删 app **一格都不动**（跟苹果一样：iPhone 上第 5 个 app 进来，
//             前四个一动不动）
//
// ── 三条规矩（这一份就是它们的唯一出处）────────────────────
//   ① 一行的格数 = `min(放得下几格, 6)`；**不看图标个数**；
//      "放得下几格"是按**最小间距**算的 ⇒ 放不下就换行，**不挤**；
//   ② 每一格**等宽** = `(可用宽 − 间距×(格数−1)) / 格数` ⇒ 一行**铺满左右两边**
//      （列数固定 ⇒ 这个宽度也固定 ⇒ **位置稳**）；
//   ③ **图标本身多大不归它管**（`desktopIconBox` 由调用方传进来）——
//      这个函数只回答"一行几格、每格多宽"，所以它能在 VM 上直接量。
//
// ⚠️ **楼房规矩**：住 `models/` ⇒ 不许 import flutter / services（`import_rules_test` 钉着）。
//    ⇒ 这里连 `Color` 都不用，只有数。

import 'dart:math' as math;

/// **一行最多几格**（主人 2026-10-01：「不要放超过 6 个 app」）。
///
/// ⚠️ 它是**上限**，不是"永远 6 格"：窄屏放不下 6 格时按放得下的来（手机仍是四列左右）。
const int desktopGridMaxCols = 6;

/// 排布的结果：一行几格、每格多宽（逻辑像素）。
class DesktopGrid {
  const DesktopGrid({required this.columns, required this.slot});

  /// 一行放几格（≥1）。**只由屏幕宽度决定**（封顶 `desktopGridMaxCols`）。
  final int columns;

  /// 每一格的宽度（等宽；一行 `columns` 格 ＋ `columns-1` 个间距**正好铺满**可用宽）。
  final double slot;

  @override
  String toString() => 'DesktopGrid(columns: $columns, slot: $slot)';
}

/// 按**屏幕可用宽**算出排布。
///
/// * [width] **可用宽**（已经扣掉两边留白的那一条 —— 调用方量的就是它）；
/// * [count] 这一墙有几个图标 —— ⚠️ **只用来判"一个都没有"**，
///   **不再参与算列数**（那正是"加一个 app 就挪位"的旧毛病）；
/// * [iconBox] 一个图标格多大（正方形边长）；
/// * [minGap] 两格之间的**最小**间距（放不下就换行的那条线）。
DesktopGrid desktopGridFor({
  required double width,
  required int count,
  required double iconBox,
  required double minGap,
}) {
  final avail = math.max(0.0, width);
  final n = math.max(0, count);
  // 一个图标都没有：给一个"一格"的形状（调用方不会拿它去画），免得外面到处判空。
  if (n == 0) return const DesktopGrid(columns: 1, slot: 0);

  // ① 放得下几格：`k` 格占 `k*iconBox + (k-1)*minGap` ⇒ 反解出 k 再取整；
  //    再封顶到 `desktopGridMaxCols`。**与 n 无关**。
  final fit = math.max(1, ((avail + minGap) / (iconBox + minGap)).floor());
  final cols = math.min(fit, desktopGridMaxCols);
  // ② 每一格等宽（`cols*slot + (cols-1)*minGap == avail`）。
  final slot = (avail - (cols - 1) * minGap) / cols;
  return DesktopGrid(columns: cols, slot: math.max(0.0, slot));
}
