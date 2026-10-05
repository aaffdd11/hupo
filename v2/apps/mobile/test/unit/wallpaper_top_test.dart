// **顶上那一条（系统状态栏）该是深底还是浅底**（主人 2026-10-05 报的那件事）。
//
// 桌面是 edge-to-edge 的，顶上那一条**露的就是壁纸**；而系统那几颗图标不会自己跟着底走
// ⇒ 每张壁纸的"顶部那一条"是深是浅必须**量出来**（`models/wallpaper.dart` 的
// `wallpaperDarkTop`），然后告诉系统选深色还是浅色图标。
//
// 🔴 **这一份判据不看那张表，看图片本身**：把每张图的顶部那一条**真的解出来**、
//    算一遍亮度，再和那张表对 —— 这样"表写错了 / 加了新图没补表"都会当场红，
//    而不是"读一眼代码觉得对"。

import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/wallpaper.dart';

/// 一张图的**顶部那一条**是不是深色（与离线量它时用的是同一把尺子）。
Future<bool> _topIsDark(String id) async {
  final bytes = (await rootBundle.load('assets/wallpapers/$id.jpg')).buffer.asUint8List();
  // ⚠️ 直接按 32 像素宽解出来（不用把整图解开再缩）—— 28 张也就几秒
  final codec = await ui.instantiateImageCodec(bytes, targetWidth: 32);
  final frame = await codec.getNextFrame();
  final img = frame.image;
  final data = await img.toByteData(format: ui.ImageByteFormat.rawRgba);
  final w = img.width;
  final h = img.height;
  // 顶上那一条：量的是**顶部 6%**（状态栏那一条 + 一点余量）
  final rows = (h * 0.06).round().clamp(1, h);
  double lin(int c) {
    final v = c / 255;
    return v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
  }

  var sum = 0.0;
  for (var y = 0; y < rows; y++) {
    for (var x = 0; x < w; x++) {
      final i = (y * w + x) * 4;
      sum += 0.2126 * lin(data!.getUint8(i)) +
          0.7152 * lin(data.getUint8(i + 1)) +
          0.0722 * lin(data.getUint8(i + 2));
    }
  }
  final n = rows * w;
  img.dispose();
  codec.dispose();
  // 与离线那一遍同一个门槛（亮度过半 = 浅底）
  return (sum / n) <= 0.45;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('🔴 那张"哪几张壁纸顶上是深底"的表，**逐张与图片本身对得上**', () async {
    final wrong = <String>[];
    for (final id in wallpaperIds) {
      if (id == wallpaperNone) continue; // "不设"= 壳那张暖纸，单独看下一条
      final real = await _topIsDark(id);
      final baked = wallpaperTopIsDark(id);
      if (real != baked) wrong.add('$id：量出来是${real ? '深' : '浅'}底，表里写的是${baked ? '深' : '浅'}');
    }
    expect(wrong, isEmpty,
        reason: '★ 表和图片对不上（顶上那一条会让系统挑错图标颜色，深底上就会出现深色图标）：\n${wrong.join('\n')}');
  });

  test('🔴 "不设"（壳那张暖纸）是**浅底** ⇒ 图标走深色', () {
    expect(wallpaperTopIsDark(wallpaperNone), isFalse);
    // 负向对照：认不出来的 id 也当浅底（宁可深色图标，也不要在暖纸上用白图标）
    expect(wallpaperTopIsDark('wp-99'), isFalse);
  });

  test('表的形状：只放**认得出**的 id（写错一个字母 = 那一张永远按浅底处理）', () {
    for (final id in wallpaperDarkTop) {
      expect(wallpaperKnown(id), isTrue, reason: '★ 表里有一个不存在的壁纸 id：$id');
    }
    // 负向对照：表**不是空的**（空表的话上面那条会空转）
    expect(wallpaperDarkTop.length, greaterThan(0));
    // ⚠️ 加了新图要重新量一遍 —— 这条只是把"当前这一版的张数"钉住
    expect(wallpaperDarkTop.length, 19,
        reason: '★ 深底那张数变了：要么是重新量过的（那把这里也改掉），要么是漏量了新图');
  });
}
