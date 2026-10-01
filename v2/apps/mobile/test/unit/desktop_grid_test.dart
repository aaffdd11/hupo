// **桌面那一墙图标怎么排**（契约 `docs/dev/137-ICON-GRID.md`）。
//   主人 2026-09-29：*"app排布要根据页面宽度等宽排列"* ＋ 他选的**每行都铺满**。
//   🔴 主人 2026-10-01：*「一行根据屏幕大小，不要放超过6个app。而且app都有位置。
//      要模拟苹果的桌面排布。」* ⇒ 他选**甲**：**列数只由屏幕定** ＋ **末行贴左**。
//
// 纯逻辑（`models/desktop_grid.dart`）⇒ 在 VM 上直接量：一行几格、每格多宽。
// ⚠️ 这一份钉的是**那条数学**，不是"看起来像"。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/desktop_grid.dart';

const box = 64.0; // 图标格（与 `desktopIconBox` 同值；这里当参数传进去）
const gap = 20.0; // 最小间距（与 `desktopTileMinGap` 同值）

DesktopGrid at(double w, int n) =>
    desktopGridFor(width: w, count: n, iconBox: box, minGap: gap);

/// 一行真正占掉的宽（格子 ＋ 间距）。
double used(DesktopGrid g) => g.columns * g.slot + (g.columns - 1) * gap;

void main() {
  test('① 🔴 一行**正好铺满**可用宽（不是"差不多"）', () {
    for (final (w, n) in <(double, int)>[
      (1280, 7),
      (1280, 3),
      (800, 6),
      (390, 4),
      (390, 7),
      (360, 5),
      (1920, 7),
      (200, 2),
    ]) {
      final g = at(w, n);
      expect(used(g), closeTo(w, 0.001), reason: '宽 $w / $n 个没铺满：$g');
    }
  });

  test('② 🔴 **一行不超过 6 格**（主人 2026-10-01：「不要放超过6个app」）', () {
    expect(at(1280, 7).columns, 6, reason: '1280 宽也**只排 6 格**（改前是 7）');
    expect(at(1920, 7).columns, 6, reason: '再宽也是 6 —— 这是**上限**');
    expect(at(1920, 40).columns, 6);
  });

  test('③ 🔴 **列数与格宽只跟屏幕走，不跟个数走** —— 这一条就是"app 都有位置"', () {
    // 同一块屏上，1 个 / 3 个 / 7 个 / 20 个 —— 列数与格宽**必须是同一个数**。
    // （改前：1 个 ⇒ 那一格 = 整条宽；3 个 ⇒ 各 1/3 ⇒ **加一个 app 前面的就挪位**。）
    final one = at(1280, 1);
    for (final n in <int>[3, 7, 20]) {
      final g = at(1280, n);
      expect(g.columns, one.columns, reason: '$n 个时列数变了 ⇒ 已有的 app 会挪位');
      expect(g.slot, closeTo(one.slot, 0.001), reason: '$n 个时格宽变了 ⇒ 已有的 app 会挪位');
    }
    // 一个图标**不再摊满整条宽**（苹果上放一个 app 也不会把它拉到屏幕中间）
    expect(one.slot, lessThan(300), reason: '一个图标也占**一格**那么宽（改前是整条 1280）');
  });

  test('④ 手机（窄屏）仍然是**四列左右**（6 是上限，不是"永远 6"）', () {
    expect(at(390, 7).columns, 4, reason: '390 宽放不下 5 格（按最小间距算）');
    expect(at(360, 7).columns, 4, reason: '360 也是一行四格');
    // 换行之后**每一行的格宽是同一个数**（两行观感一致）
    expect(used(at(390, 7)), closeTo(390, 0.001));
  });

  test('⑤ 每格**永远不窄于图标格**（挤不下就换行，不许压扁）', () {
    for (final w in <double>[200, 240, 300, 390, 600, 1280, 1920]) {
      for (final n in <int>[1, 2, 5, 9, 17]) {
        final g = at(w, n);
        expect(g.slot >= box - 0.001, true,
            reason: '宽 $w / $n 个把格子压到 ${g.slot}（比 $box 还窄）');
      }
    }
  });

  test('⑥ 边界：0 个 / 1 个 / 可用宽为 0 —— 不抛，也不出现负数', () {
    expect(at(1280, 0).slot, 0);
    expect(at(1280, 0).columns, 1);
    // 🔴 这一条是**旧行为的反面**：1 个图标时那一格**不再是整条宽**
    expect(at(1280, 1).columns, desktopGridMaxCols);
    expect(at(1280, 1).slot, closeTo((1280 - 5 * gap) / 6, 0.001));
    expect(at(0, 3).slot >= 0, true, reason: '可用宽 0 时不许出负数');
  });

  test('⑦ 纯函数：同样的输入给同样的结果（判据自己不许带随机/状态）', () {
    expect(at(800, 5).columns, at(800, 5).columns);
    expect(at(800, 5).slot, at(800, 5).slot);
  });
}
