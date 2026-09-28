// **桌面那张壁纸**（契约 `docs/dev/131-WALLPAPER.md`）。
//
// 纯逻辑（`models/wallpaper.dart`）：id 的认法、资源路径、读盘兜底，全在 VM 上直接量。
// ⚠️ 这一份里有一条**数文件**的判据：模型说多少张，`assets/wallpapers/` 里就得有多少张
//    —— 不然会出现"库里说 28 张、盘上只有 20 张"这种悄悄漂掉的事
//    （主人换一包壁纸时最容易撞上）。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/models/wallpaper.dart';

void main() {
  test('① 「不设」是空串，而且它是**第一个**（那一格就是"原来那张纸"）', () {
    expect(wallpaperNone, '');
    expect(wallpaperIds.first, wallpaperNone);
    expect(wallpaperLabel(wallpaperNone), wallpaperDefaultLabel);
    expect(wallpaperAssetOf(wallpaperNone), isNull, reason: '不设 = 画那张暖纸，不是读一张图');
    expect(wallpaperThumbOf(wallpaperNone), isNull);
  });

  test('② id 是 `wp-NN`，一共 `wallpaperCount` 张（含"不设"共 N+1 格）', () {
    expect(wallpaperIds.length, wallpaperCount + 1);
    expect(wallpaperIds[1], 'wp-01');
    expect(wallpaperIds.last, 'wp-${wallpaperCount.toString().padLeft(2, '0')}');
    // 序号是**两位补零**的：判据与盘上的 key 都按这个认，改法就是换一包壁纸
    for (final id in wallpaperIds.skip(1)) {
      expect(RegExp(r'^wp-\d{2}$').hasMatch(id), isTrue, reason: 'id 形状不对：$id');
    }
  });

  test('③ 认不出来的一律当"不设"（**偏好读坏了也不许让桌面打不开**）', () {
    for (final bad in <String?>[null, '', '  ', 'wp-99', 'wp-1', 'WP-01', '../../etc/passwd', '壁纸']) {
      expect(wallpaperOf(bad), wallpaperNone, reason: '认不出来却当成认得：$bad');
    }
    // 认得出来的原样返回（而且去掉首尾空白）
    expect(wallpaperOf(' wp-07 '), 'wp-07');
    expect(wallpaperKnown('wp-07'), isTrue);
    expect(wallpaperKnown('wp-99'), isFalse);
  });

  test('④ 资源路径**只在认得出来时**给（整图与缩略图各一条）', () {
    expect(wallpaperAssetOf('wp-07'), 'assets/wallpapers/wp-07.jpg');
    expect(wallpaperThumbOf('wp-07'), 'assets/wallpapers/thumbs/wp-07.jpg');
    expect(wallpaperAssetOf('wp-99'), isNull, reason: '不认得的 id 不许拼出一个不存在的路径');
    expect(wallpaperThumbOf('wp-99'), isNull);
  });

  test('⑤ 屏幕上怎么念：第 N 张（**不编名字** —— 源图本来就没有名字）', () {
    expect(wallpaperLabel('wp-01'), '${wallpaperLabelPrefix}1');
    expect(wallpaperLabel('wp-28'), '${wallpaperLabelPrefix}28');
    expect(wallpaperLabel('wp-99'), wallpaperDefaultLabel, reason: '不认得的 id 念成默认那一格');
  });

  test('⑥ 🔴 盘上真的有多少张：图片与缩略图**一张都不许缺**（数文件，不是信常量）', () {
    // ⚠️ 这是这一份里最实在的一条：`wallpaperCount` 是**我们说的**，
    //    而盘上那两摞文件是**真的**。两边对不上 ⇒ 用户会看到空格子。
    const dir = 'assets/wallpapers';
    final big = Directory(dir)
        .listSync()
        .whereType<File>()
        .where((f) => f.path.endsWith('.jpg'))
        .map((f) => f.uri.pathSegments.last)
        .toList()
      ..sort();
    final small = Directory('$dir/thumbs')
        .listSync()
        .whereType<File>()
        .where((f) => f.path.endsWith('.jpg'))
        .map((f) => f.uri.pathSegments.last)
        .toList()
      ..sort();
    expect(big.length, wallpaperCount, reason: '整图的数量与 `wallpaperCount` 对不上');
    expect(small.length, wallpaperCount, reason: '缩略图的数量与 `wallpaperCount` 对不上');
    // 名字也要一一对上（不能只有个数对）
    for (var i = 1; i <= wallpaperCount; i++) {
      final name = 'wp-${i.toString().padLeft(2, '0')}.jpg';
      expect(big.contains(name), isTrue, reason: '少了整图：$name');
      expect(small.contains(name), isTrue, reason: '少了缩略图：$name');
    }
    // 🔴 **每一张都要能被模型认出来**（反着对一遍：盘上有的，`wallpaperIds` 里也有）
    for (final f in big) {
      expect(wallpaperKnown(f.replaceAll('.jpg', '')), isTrue, reason: '盘上这张模型不认得：$f');
    }
  });
}
