// **桌面那一墙图标怎么排**（契约 `docs/dev/137-ICON-GRID.md`）。
//   主人 2026-09-29：*"app排布要根据页面宽度等宽排列"* ＋ 他选的**每行都铺满**。
//
// 纯逻辑（`models/desktop_grid.dart`）⇒ 在 VM 上直接量：一行几格、每格多宽。
// ⚠️ 这一份钉的是"**铺满**"这件事的数学，不是"看起来像"。

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

  test('② 🔴 宽屏：图标少也**一行排开铺满**（不是挤在左边）', () {
    // 1280 宽、7 个 —— 这正是主人看到的那一屏（改前它们只占左边三分之一）
    final g = at(1280, 7);
    expect(g.columns, 7, reason: '7 个该在一行里');
    expect(g.slot, greaterThan(100), reason: '每格该明显宽于图标格（距离被拉开）');
  });

  test('③ 手机（窄屏）仍然是**四列左右**', () {
    expect(at(390, 7).columns, 4, reason: '390 宽放不下 5 格（按最小间距算）');
    expect(at(360, 7).columns, 4, reason: '360 也是一行四格');
    // 而且换行之后**每一行的格宽是同一个数**（两行观感一致）
    final g = at(390, 7);
    expect(used(g), closeTo(390, 0.001));
  });

  test('④ 图标很多 ⇒ 一行的格数**自己变多**（放得下几格就放几格）', () {
    expect(at(1280, 20).columns, greaterThan(at(390, 20).columns));
    // 但一行**绝不超过放得下的格数**（不挤：每格至少 iconBox 宽）
    final g = at(1280, 20);
    expect(g.slot >= box, true, reason: '每格比图标格还窄 ⇒ 挤了');
  });

  test('⑤ 每格**永远不窄于图标格**（挤不下就换行，不许压扁）', () {
    for (final w in <double>[200, 240, 300, 390, 600, 1280]) {
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
    expect(at(1280, 1).columns, 1);
    expect(at(1280, 1).slot, closeTo(1280, 0.001), reason: '一个图标 ⇒ 那一格就是整条宽');
    expect(at(0, 3).slot >= 0, true, reason: '可用宽 0 时不许出负数');
  });

  test('⑦ 格数**只跟"放得下几格"与个数有关**，跟顺序无关', () {
    expect(at(800, 5).columns, at(800, 5).columns);
    expect(at(800, 5).slot, at(800, 5).slot);
  });
}
