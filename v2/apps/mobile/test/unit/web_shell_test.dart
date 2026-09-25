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

    test('🔴 网页上**关掉浏览器自己的右键菜单**（不关的话，右键删除点不到）', () {
      // 判据（契约 `docs/dev/103-APP-DELETE.md` §一 C1 · 主人 2026-09-25 签字"关掉"）：
      //   引擎默认**开着**浏览器菜单（`browser_context_menu.dart` 原话："On web,
      //   by default, the browser's context menu is enabled and Flutter's context
      //   menus are hidden."）⇒ 右键桌面图标时它盖在「从桌面上删掉」那个面板上。
      //
      // ⚠️ 这一条只能查源码：那个开关是**引擎**的行为（页面元素上的一个
      //    `contextmenu` preventDefault 监听），Dart 侧没有可断言的状态。
      //    和这一份里另外两条同一类：**配置断言**。
      final src = File('lib/main.dart').readAsStringSync();
      expect(
        src.contains('BrowserContextMenu.disableContextMenu()'),
        true,
        reason: '★ 关掉那一行没了 ⇒ 网页上右键桌面图标会被浏览器菜单盖住（删不掉）',
      );
      expect(
        RegExp(r'if \(kIsWeb\)').hasMatch(src),
        true,
        reason: '★ 只许在网页上关（别的平台没这个开关，白调一次 method channel）',
      );
      // 🔴 **顺序也是判据**（2026-09-25 真机验出来的真缺陷）：
      //    `BrowserContextMenu` 用的是 **`OptionalMethodChannel`** —— 平台消息
      //    **发丢了不报错**；binding 没初始化时发出去就是丢的。
      //    实录：`runApp` 之前调用 ⇒ 线上产物里有这次调用、面板也出得来，
      //    可 `<html>` 上**没有**那个 `contextmenu` preventDefault ⇒ 浏览器菜单照弹。
      final ensure = src.indexOf('WidgetsFlutterBinding.ensureInitialized()');
      final call = src.indexOf('BrowserContextMenu.disableContextMenu()');
      expect(ensure, greaterThanOrEqualTo(0), reason: '★ 缺 `ensureInitialized()`（少了它那条消息是发丢的）');
      expect(ensure, lessThan(call), reason: '★ 顺序反了：binding 没初始化就发 ⇒ 消息发丢、浏览器菜单照弹');
    });
  });
}
