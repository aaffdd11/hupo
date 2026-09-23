// **线上产物那两条不变量**（P1-13，2026-09-24）· 契约 `docs/dev/15-CACHE.md`
//
// 🔴 为什么要有它：2026-09-24 出过两次"整页白屏 / 图标全空"，根因都是**缓存**：
//    · 入口文件被删 ⇒ `index.html` 指的东西不在（我自己的发布脚本 bug）；
//    · 字体 URL 不带指纹 ⇒ 浏览器里那份旧/坏的副本被 304 一直续用。
//    shell 级的验证（部署脚本里那几条）只在**部署那一刻**跑；这一条是**随时可跑**的：
//    它直接读**盘上那份产物**，把两条不变量钉住。
//
// ⚠️ 产物不在（干净 clone / 还没构建过）⇒ **不是失败**，但那句话要打出来（别假装验过）。

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// 产物在哪（本机就是 `v2/services/core/web`）。
const String webDir = '../../services/core/web';

void main() {
  test('P1-13：字体清单里每一个文件都在盘上，而且文件名带内容指纹', () {
    final man = File('$webDir/assets/FontManifest.json');
    if (!man.existsSync()) {
      // 说清"没验"而不是"验过了"（这个项目最忌后者）
      // ignore: avoid_print
      print('⚠️ 没有产物（$webDir），这一条**没验**——先跑一次 deploy-web-v2.sh');
      return;
    }
    final list = jsonDecode(man.readAsStringSync()) as List<dynamic>;
    var checked = 0;
    for (final fam in list) {
      for (final f in (fam as Map)['fonts'] as List<dynamic>) {
        final asset = (f as Map)['asset'] as String;
        final path = '$webDir/assets/$asset';
        expect(
          File(path).existsSync(),
          isTrue,
          reason: '清单指着 `$asset`，盘上却没有 ⇒ 线上就是 404（浏览器拿 HTML 当字体解析）',
        );
        final name = asset.split('/').last;
        expect(
          RegExp(r'\.[0-9a-f]{8}\.[a-z0-9]+$').hasMatch(name),
          isTrue,
          reason: '字体文件名必须带 8 位内容指纹（`名字.<8hex>.后缀`）：`$name`'
              '—— 不带指纹的话，浏览器里那份旧的/坏的副本会被 304 一直续用（2026-09-24 实测）',
        );
        checked += 1;
      }
    }
    expect(checked, greaterThan(0), reason: '清单里应该有字体（一条都没读到 ⇒ 这个判据在空转）');
  });

  test('P1-13：入口文件（index.html 指的那个）也在盘上', () {
    final idx = File('$webDir/index.html');
    if (!idx.existsSync()) return; // 同上：没产物就说"没验"
    final html = idx.readAsStringSync();
    final m = RegExp(r'flutter_bootstrap\.[0-9a-f]+\.js').firstMatch(html);
    expect(m, isNotNull, reason: 'index.html 里没有带指纹的入口引用 ⇒ 缓存那条路会出问题');
    expect(
      File('$webDir/${m!.group(0)}').existsSync(),
      isTrue,
      reason: '`index.html` 指着 `${m.group(0)}`，盘上却没有 ⇒ **整页白屏**（2026-09-24 真发生过）',
    );
  });
}
