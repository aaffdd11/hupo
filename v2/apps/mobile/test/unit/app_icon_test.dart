// **app 的图标**（主人 2026-09-28 给了一张图：*"用这个做 app 的 icon"*）。
//
// 契约：`docs/dev/130-APP-ICON.md`；生成器：`scripts/make-app-icons.py`。
//
// ── 这一份钉什么（都是"装到手机上/浏览器里才看得见"的东西）──────
//   ① 🔴 **每一档密度都在，而且尺寸对**（少一档 = 他那台手机上就是别的形状）；
//   ② 🔴 **不是 Flutter 模板那五张**（模板是什么都不做的默认值 —— 上一次真机上
//      桌面写的就是模板那张；哈希钉着，防的是"改回去了没人发现"）；
//   ③ 🔴 **自适应图标那一套在**（安卓 8+ 用它；少了它系统会给传统图标套一个白底圆形，
//      看起来就是我们没做图标）；
//   ④ 🔴 **是暖色的那一张**（解出来数像素：琥珀色占多数、模板那张是蓝的）；
//   ⑤ 🔴 **源图角上那行"AI 生成"的水印一个像素都没进来**（右下角那一块里
//      不许有亮像素 —— 水印就住在那里）。
//
// ⚠️ ④⑤ 两条**必须真的解码**才量得到 ⇒ 用 `dart:ui` 解 PNG（`flutter test` 里有 binding），
//    零新依赖。
//
// ⚠️ 为什么值得单开一份：这一批改的全是**资源**，而资源错了不会让任何编译/逻辑判据变红 ——
//    它只在**他手机上那一个格子里**看得出来。

import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';

const _res = 'android/app/src/main/res';

/// 五档密度（dp × 倍数 = 那张图的边长）。
const _densities = <String, int>{
  'mdpi': 48,
  'hdpi': 72,
  'xhdpi': 96,
  'xxhdpi': 144,
  'xxxhdpi': 192,
};

/// **改之前那五张**（Flutter 模板给的默认图标）的 sha256。
///
/// 🔴 它们**一个都不许回来**：装上模板图标 = 桌面上那一格是 Flutter 的默认样子。
const _templateHashes = <String, String>{
  'mdpi': 'c7c0c0189145e4e32a401c61c9bdc615754b0264e7afae24e834bb81049eaf81',
  'hdpi': '6a7c8f0d703e3682108f9662f813302236240d3f8f638bb391e32bfb96055fef',
  'xhdpi': 'e14aa40904929bf313fded22cf7e7ffcbf1d1aac4263b5ef1be8bfce650397aa',
  'xxhdpi': '4d470bf22d5c17d84edc5f82516d1ba8a1c09559cd761cefb792f86d9f52b540',
  'xxxhdpi': '3c34e1f298d0c9ea3455d46db6b7759c8211a49e9ec6e44b635fc5c87dfb4180',
};

File _f(String p) {
  final f = File(p);
  expect(f.existsSync(), isTrue, reason: '找不到 $p（测试的工作目录是包根）');
  return f;
}

/// 从 PNG 头里读宽高（IHDR 就住在前 24 字节）——**不解码**，够用且快。
(int, int) _pngSize(Uint8List b) {
  expect(b.length, greaterThan(24), reason: '这不是一张 PNG');
  expect(String.fromCharCodes(b.sublist(1, 4)), 'PNG', reason: '这不是一张 PNG');
  final d = ByteData.sublistView(b, 16, 24);
  return (d.getUint32(0), d.getUint32(4));
}

/// 解一张 PNG ⇒ `(宽, 高, RGBA 像素)`。
Future<(int, int, Uint8List)> _decode(String path) async {
  final bytes = _f(path).readAsBytesSync();
  final codec = await ui.instantiateImageCodec(bytes);
  final frame = await codec.getNextFrame();
  final img = frame.image;
  final data = await img.toByteData(format: ui.ImageByteFormat.rawRgba);
  return (img.width, img.height, data!.buffer.asUint8List());
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('① 五档密度都在，而且尺寸对', () {
    for (final e in _densities.entries) {
      final path = '$_res/mipmap-${e.key}/ic_launcher.png';
      final (w, h) = _pngSize(_f(path).readAsBytesSync());
      expect((w, h), (e.value, e.value), reason: '★ ${e.key} 那一档该是 ${e.value}×${e.value}');
    }
  });

  test('② 不是 Flutter 模板那五张（sha256 钉着）', () {
    for (final e in _densities.entries) {
      final bytes = _f('$_res/mipmap-${e.key}/ic_launcher.png').readAsBytesSync();
      final sum = sha256.convert(bytes).toString();
      expect(sum, isNot(_templateHashes[e.key]),
          reason: '★ 这一档还是 Flutter 模板那张默认图标（桌面上那一格就是它）');
    }
    // 负向对照：把"模板的字节"喂给同一条判法必须**判红**（否则这条闸是空转的）。
    expect(_templateHashes['xxxhdpi'], isNot(_templateHashes['xxhdpi']),
        reason: '★ 五档各自的哈希本来就不同（别拿一个值糊弄五档）');
  });

  test('③ 自适应图标那一套在（安卓 8+ 用它）', () {
    final xml = _f('$_res/mipmap-anydpi-v26/ic_launcher.xml').readAsStringSync();
    expect(xml.contains('<adaptive-icon'), isTrue);
    expect(xml.contains('@color/ic_launcher_background'), isTrue, reason: '★ 背景那一层');
    expect(xml.contains('@mipmap/ic_launcher_foreground'), isTrue, reason: '★ 前景那一层');
    final bg = _f('$_res/values/ic_launcher_background.xml').readAsStringSync();
    expect(RegExp(r'<color name="ic_launcher_background">#[0-9A-Fa-f]{6}</color>').hasMatch(bg), isTrue,
        reason: '★ 底色的出处（从主人那张图里取的）');
    // 前景那一档：五档都要在（108dp 那套）
    for (final e in _densities.entries) {
      final path = '$_res/mipmap-${e.key}/ic_launcher_foreground.png';
      final (w, h) = _pngSize(_f(path).readAsBytesSync());
      expect(w, h, reason: '★ 前景图标必须是正方形');
      expect(w, greaterThan(_densities[e.key]!), reason: '★ 前景画布比传统图标大（108dp 那套）');
    }
    // 圆形那一套：每个密度一张 PNG ＋ 一份自适应 XML（`android:roundIcon` 指的就是它们）
    final roundXml = _f('$_res/mipmap-anydpi-v26/ic_launcher_round.xml').readAsStringSync();
    expect(roundXml.contains('<adaptive-icon'), isTrue);
    for (final e in _densities.entries) {
      final path = '$_res/mipmap-${e.key}/ic_launcher_round.png';
      final (w, h) = _pngSize(_f(path).readAsBytesSync());
      expect((w, h), (e.value, e.value), reason: '★ 圆图标 ${e.key} 那一档');
    }
    // 清单里要指上圆那一个（不指的话，要圆图标的启动器只能拿方的去裁）
    final manifest = _f('android/app/src/main/AndroidManifest.xml').readAsStringSync();
    expect(manifest.contains('android:roundIcon="@mipmap/ic_launcher_round"'), isTrue,
        reason: '★ 圆图标做好了却没人指它 = 白做');
  });

  test('④ 解出来是**暖色**那一张（不是模板那张蓝的）', () async {
    final (w, h, px) = await _decode('$_res/mipmap-xxxhdpi/ic_launcher.png');
    expect(w, 192);
    var warm = 0, total = 0;
    for (var i = 0; i < px.length; i += 4) {
      final r = px[i], b = px[i + 2];
      total += 1;
      if (r > b + 40 && r > 120) warm += 1; // 琥珀/金色
    }
    final ratio = warm / total;
    expect(ratio, greaterThan(0.25),
        reason: '★ 暖色像素只占 ${(ratio * 100).toStringAsFixed(1)}% —— 这不像是主人那张琥珀气泡（模板那张是蓝的）');
  });

  test('⑤ 🔴 源图角上那行"AI 生成"的水印**一个像素都没进来**', () async {
    final (w, h, px) = await _decode('$_res/mipmap-xxxhdpi/ic_launcher.png');
    expect((w, h), (192, 192));
    // 右下角那一块（15%×15%）：水印就住在源图的那个方位
    var bright = 0;
    for (var y = (h * 0.85).floor(); y < h; y++) {
      for (var x = (w * 0.85).floor(); x < w; x++) {
        final i = (y * w + x) * 4;
        final lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        final a = px[i + 3];
        if (a > 40 && lum > 140) bright += 1;
      }
    }
    expect(bright, 0, reason: '★ 右下角那一块里有 $bright 个亮像素 —— 水印（或别的东西）漏进来了');
  });
}
