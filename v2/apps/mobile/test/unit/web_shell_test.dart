// Web 外壳里的**配置断言** —— 与 `android_manifest_test.dart` 同一类（都进硬闸）。
//
// ⚠️ 为什么值得有一条：`web/index.html` 与 `web/manifest.json` 是**脚手架生成的**，
//    里面那几个占位串（`hupo_app` / "A new Flutter project."）**用户看得见**：
//      · 浏览器标签页的标题；
//      · **"添加到主屏幕"之后的图标名字**（平板用户最可能看见的就是这个）。
//    这一条是查 #15 引用图时顺带发现的 —— 而"顺带发现"正是最容易漏掉的那一类。

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  group('Web 外壳', () {
    test('🔴 不许留着脚手架的占位（用户看得见：标签页 + 主屏幕图标名）', () {
      final html = File('web/index.html').readAsStringSync();
      final manifest = File('web/manifest.json').readAsStringSync();
      for (final bad in ['hupo_app', 'A new Flutter project.']) {
        expect(html.contains(bad), false, reason: 'index.html 里还有占位：$bad');
        expect(manifest.contains(bad), false, reason: 'manifest.json 里还有占位：$bad');
      }
    });

    test('名字就是那个给用户看的词（「助手」）', () {
      expect(File('web/index.html').readAsStringSync().contains('<title>助手</title>'), true);
      final m = jsonDecode(File('web/manifest.json').readAsStringSync()) as Map;
      expect(m['name'], '助手');
      expect(m['short_name'], '助手');
    });
  });
}
