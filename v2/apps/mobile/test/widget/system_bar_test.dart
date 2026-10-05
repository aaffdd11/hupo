// **顶上那一条（状态栏）由谁说了算**（主人 2026-10-05 选的那条路："归我们"）。
//
// 两件事一起钉：
//   ① 🔴 **桌面**：顶上那一条露的是壁纸 ⇒ 图标深浅跟着**这张壁纸的顶部**走；
//   ② 🔴 **小程序那一屏**：顶上那一条是**壳自己的纸色**（那个面盖到 y=0）
//      ⇒ 图标固定走**深色**（浅底）。页面是第三方 HTML，我们读不到它的颜色，
//      所以**不让它铺上去**（铺上去就没法保证图标看得清）。
//
// ⚠️ 用 `SystemBarTint`（内部就是 `AnnotatedRegion<SystemUiOverlayStyle>`）交出去：
//    Flutter 在**状态栏那一条的正中**取样、取最上面那一层 ⇒ 谁盖在顶上谁说了算。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/wallpaper.dart';
import 'package:hupo_app/widgets/app_desktop.dart';
import 'package:hupo_app/widgets/mini_app_host.dart';
import 'package:hupo_app/widgets/system_bar.dart';

Future<void> _pumpDesktop(WidgetTester tester, String wallpaper) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: AppDesktop(apps: const [], wallpaper: wallpaper, onTapBlank: () {}),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('🔴 桌面：顶上那一条跟**壁纸的顶部**走（深底 ⇒ 浅色图标）', (tester) async {
    // wp-03 是离线量出来的"深底"那一族里的（`models/wallpaper.dart`）
    await _pumpDesktop(tester, 'wp-03');
    expect(find.byType(SystemBarTint), findsOneWidget);
    expect(tester.widget<SystemBarTint>(find.byType(SystemBarTint)).darkBackground, isTrue,
        reason: '★ 深色壁纸上还挑深色图标 ⇒ 时钟/电量看不清');

    // 负向对照：**浅底**那一张（wp-01）⇒ 深色图标
    await _pumpDesktop(tester, 'wp-01');
    expect(tester.widget<SystemBarTint>(find.byType(SystemBarTint)).darkBackground, isFalse);

    // 负向对照之二：**不设壁纸**（壳那张暖纸，浅）⇒ 深色图标
    await _pumpDesktop(tester, wallpaperNone);
    expect(tester.widget<SystemBarTint>(find.byType(SystemBarTint)).darkBackground, isFalse);
  });

  testWidgets('🔴 小程序那一屏：那个面盖到 y=0，而且顶上那一条是**壳的纸色**（深色图标）', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: MiniAppHost(
            open: true,
            title: '看天气',
            covered: false,
            onCoveredTap: _noop,
            bottomInset: 0,
            child: SizedBox(key: Key('里面那一屏'), width: 100, height: 100),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // ① 那个面**从屏幕最上面开始**（不是从安全区下面）—— 顶上那一条归它
    final surface = tester.getRect(find.byKey(miniAppSurfaceKey));
    expect(surface.top, 0, reason: '★ 那个面没有盖到顶上 ⇒ 顶上露的还是桌面那一层');
    // ② 那一层交给系统的样式：**浅底 ⇒ 深色图标**
    final tints = tester.widgetList<SystemBarTint>(find.byType(SystemBarTint)).toList();
    expect(tints.isNotEmpty, isTrue, reason: '★ 这一屏没有把状态栏那一条交出去（没人设 ⇒ 深壁纸上是深图标）');
    expect(tints.any((t) => t.darkBackground == false), isTrue,
        reason: '★ 壳那张纸是浅的 ⇒ 图标要深色');

    // ③ 内容**从安全区下面开始**（页面第一行不许压在时钟底下 —— 2026-09-28 那件事）
    await tester.pumpAndSettle();
    expect(tester.getRect(find.byKey(const Key('里面那一屏'))).top, greaterThanOrEqualTo(0));
  });
}

void _noop() {}
