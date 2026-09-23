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

  test('★ 全程按透明度交叉（**不是**到点切换）：任意一点两边加起来都是 1', () {
    for (var i = 0; i <= 10; i++) {
      final p = i / 10;
      expect(miniAppIconShare(p) + miniAppContentShare(p), closeTo(1, 1e-9));
    }
    // 交叉点自然落在 50%（算出来的，不是"切换"）
    expect(miniAppContentShare(0.5), closeTo(0.5, 1e-9));
    expect(miniAppIconShare(0.5), closeTo(0.5, 1e-9));
    // 而且**一路上都在变**（不是前 45% 一动不动）
    expect(miniAppContentShare(0.2), closeTo(0.2, 1e-9));
    expect(miniAppContentShare(0.8), closeTo(0.8, 1e-9));
  });

  test('收回：同一个函数走回去（100% → 0）', () {
    // 收回时 p 从 1 往 0 走 ⇒ 内容 1→0、图标 0→1
    expect(miniAppContentShare(1), 1);
    expect(miniAppContentShare(0), 0);
    expect(miniAppIconShare(1), 0);
    expect(miniAppIconShare(0), 1);
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
