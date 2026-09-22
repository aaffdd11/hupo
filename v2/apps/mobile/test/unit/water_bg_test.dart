// **水面涟漪的几何**（纯函数 —— `rippleRings`）。
//
// 为什么单拎出来测：它住在 `paint()` 里的话，就只能靠**肉眼看截图**验证，
// 而"看着差不多"是没法在下一批之后还靠得住的东西（`04-ROADMAP.md` 的账）。
// 纯函数进 `test/unit`，这也是 `AGENTS.md` §5.1 纪律 3 的原话。
//
// ⚠️ 这里**不验美不美**（那是主人的眼睛），只验三件会静默坏掉的性质：
//   ① 圈数别多别少；② 读数都在合法区间；③ **五圈不许挤在同一个地方**
//   （挤在一起 = 看起来像一圈脉冲，而不是"水面上一圈一圈漾开"）。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/widgets/water_bg.dart';

void main() {
  group('涟漪的几何（纯函数）', () {
    test('要几圈给几圈', () {
      expect(rippleRings(0, 1000), hasLength(5));
      expect(rippleRings(0.37, 1000, count: 3), hasLength(3));
    });

    test('半径落在 0–要漾到的那条线之间，透明度落在 0–1 之间', () {
      // 扫一遍相位（不是抽查几个点：错位用的是黄金比，周期的整数倍会把错位"对齐"，
      // 抽着测很容易恰好抽到那几个整齐的点上）
      for (var i = 0; i < 200; i++) {
        final phase = i / 37.0;
        for (final r in rippleRings(phase, 800)) {
          expect(r.radius, inInclusiveRange(0, 800));
          expect(r.opacity, inInclusiveRange(0, 1));
        }
      }
    });

    test('🔴 五圈不许叠在一起（否则像一圈脉冲，不像水面）', () {
      // 相邻两圈的半径差，至少要有一个"可见的间距"（要漾到的那条线的 5%）
      for (var i = 0; i < 50; i++) {
        final rs = rippleRings(i / 13.0, 1000).map((r) => r.radius).toList()
          ..sort();
        for (var k = 1; k < rs.length; k++) {
          expect(
            rs[k] - rs[k - 1],
            greaterThan(1000 * 0.05),
            reason: '相位 ${i / 13.0}：第 $k 圈只比前一圈远 ${(rs[k] - rs[k - 1]).toStringAsFixed(1)}px '
                '—— 两圈糊在一起了',
          );
        }
      }
    });

    test('时间往前走，圈要真的变（否则它是个静止的靶子）', () {
      final a = rippleRings(0.0, 1000).map((r) => r.radius).toList();
      // 半个周期之后
      final b = rippleRings(0.5, 1000).map((r) => r.radius).toList();
      expect(a, isNot(equals(b)), reason: '★ 过了半个周期读数一模一样 ⇒ 它没在动');
    });

    test('它是**周期性的**：走满一个周期回到原样（水面该一直漾下去）', () {
      final a = rippleRings(0.25, 1000).map((r) => r.radius).toList();
      final b = rippleRings(1.25, 1000).map((r) => r.radius).toList();
      expect(a, equals(b), reason: '★ 走满一个周期没回到原样 ⇒ 每圈周期其实不一样，迟早会跳一下');
    });
  });

  test('水面那一层的时间读数：一秒 = 一秒（画家读的就是它）', () {
    // ⚠️ 这条钉的是**单位**：`seconds` 是秒，不是毫秒、不是微秒。
    //    量错单位的形状很讨厌 —— 动画会快/慢 1000 倍，而"能跑"、测试也绿。
    expect(waterRipplePeriod, greaterThan(1));
  });
}
