// **图标 ⇄ 页面内容 的交接**（主人 2026-09-24 定案）· 契约 `docs/dev/73-MOTION-APP.md`。
//
// 原话：*"放大时，icon 随着放大，到一半左右换成页面内容；缩小时，在一半左右，
//        页面内容换成大 icon，随之缩小。"*
// ⚠️ 这两个数是按**位置进度**算的 ⇒ 打开和收回**同一进度表现一样**（不用写两套）。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/widgets/motion.dart';

void main() {
  test('起点全是图标、终点全是页面（两头不许混）', () {
    expect(miniAppIconShare(0), 1);
    expect(miniAppContentShare(0), 0);
    expect(miniAppIconShare(1), 0);
    expect(miniAppContentShare(1), 1);
  });

  test('★ 一半左右真的在换：45% 还是图标、60% 已经是页面', () {
    expect(miniAppIconShare(0.45), 1, reason: '45% 之前画面该还是那个图标');
    expect(miniAppContentShare(0.6), 1, reason: '60% 之后该已经是页面了');
  });

  test('★ 交接是"半路"的：0.5 处两边各占一半（不是硬切）', () {
    final c = miniAppContentShare(0.5);
    expect(c, greaterThan(0.05));
    expect(c, lessThan(0.95));
    expect(miniAppIconShare(0.5) + c, closeTo(1, 1e-9));
  });

  test('单调（只许一路换过去，不许来回闪）', () {
    var last = -1.0;
    for (var i = 0; i <= 100; i++) {
      final v = miniAppContentShare(i / 100);
      expect(v, greaterThanOrEqualTo(last));
      last = v;
    }
  });

  test('图标大小用的是**桌面那一格的比例**（0.375 ⇒ p=0 时和图标格逐像素一致）', () {
    expect(miniAppIconOfBox, closeTo(24 / 64, 1e-9));
  });
}
