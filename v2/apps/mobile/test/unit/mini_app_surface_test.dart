// **小程序那一层"扩开 / 收回"途中的样子**（主人 2026-09-23 报的）：
//   *"视觉效果上，因为小程序 icon 是有圆角有阴影的。而打开和关闭的时候，那一层效果
//     没有阴影，所以开启和打开的效果并不如意。"*
//
// 这一份钉三件（都是"错了也看不出来、只有盯着动画才看得出"那种）：
//   ① 🔴 **起点 = 图标那一格**：v = 0 时圆角与阴影**逐字等于** `design.dart` 里
//      图标格用的那几个数（不然"从图标那儿扩开"那一下会**跳**）
//   ② 🔴 **终点 = 全屏**：v = 1 时圆角 0、阴影 0（整页贴边，画阴影只是白费）
//   ③ **中间是单调收的**，而且**越界夹住**（动画被打断时也画得出合理的样子）

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/design.dart' as d;

void main() {
  test('🔴 起点（v=0）**逐字等于图标那一格**：圆角 + 那三个阴影数', () {
    final s = d.miniAppSurfaceAt(0);
    expect(s.radius, d.radiusCard, reason: '★ 圆角要和图标格一样（`radiusCard`）');
    expect(s.shadowAlpha, d.tileShadowAlpha, reason: '★ 阴影 α 要和图标格一样');
    expect(s.shadowBlur, d.tileShadowBlur, reason: '★ 模糊要和图标格一样');
    expect(s.shadowDy, d.tileShadowDy, reason: '★ 下移要和图标格一样');
  });

  test('🔴 终点（v=1）**什么都不留**：直角、没有阴影（整页贴边）', () {
    final s = d.miniAppSurfaceAt(1);
    expect(s.radius, 0);
    expect(s.shadowAlpha, 0);
    expect(s.shadowBlur, 0);
    expect(s.shadowDy, 0);
  });

  test('★ 中间是**单调收**的（圆角与阴影一起变小，不是忽大忽小）', () {
    var prev = d.miniAppSurfaceAt(0);
    for (var i = 1; i <= 10; i += 1) {
      final s = d.miniAppSurfaceAt(i / 10);
      expect(s.radius <= prev.radius, true, reason: '第 $i 步圆角变大了');
      expect(s.shadowAlpha <= prev.shadowAlpha, true, reason: '第 $i 步阴影变大了');
      expect(s.shadowBlur <= prev.shadowBlur, true, reason: '第 $i 步模糊变大了');
      expect(s.radius >= 0 && s.shadowAlpha >= 0, true, reason: '第 $i 步变负了');
      prev = s;
    }
  });

  test('🔴 越界（动画被打断 / 传了个怪值）夹在两端，不出现负圆角', () {
    for (final v in [-1.0, -0.001, 1.001, 2.0, 99.0]) {
      final s = d.miniAppSurfaceAt(v);
      expect(s.radius >= 0, true, reason: 'v=$v 时圆角是 ${s.radius}');
      expect(s.radius <= d.radiusCard, true, reason: 'v=$v 时圆角比图标还大');
      expect(s.shadowAlpha >= 0 && s.shadowAlpha <= d.tileShadowAlpha, true);
    }
    // 负的那一头 = 起点那一格（夹住，不是"更小"）
    expect(d.miniAppSurfaceAt(-5).radius, d.radiusCard);
    expect(d.miniAppSurfaceAt(-5).shadowAlpha, d.tileShadowAlpha);
  });
}
