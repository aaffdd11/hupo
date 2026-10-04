// **每个 app 右上角那颗「退出」**（乙期 · 手册 `D3.15`）。
//
// 主人 2026-10-04 原话：*「所有的app，右上角都有一个退出按钮。所以我不再需要home按钮」*
//
// ── 这一份钉什么（E1–E3）────────────────────────────────────
//   E1 进了 app ⇒ **右上角有那颗「退出」**（带字、命中区 ≥44）
//   E2 🔴 **底下那条里那颗 home 没了**（负向对照：它一个字节都不许回来）
//   E3 点它 ⇒ **回桌面**（那一屏关掉 ＋ 聊天收起来）
//   E4 聊天展开把它盖住时 ⇒ **不画**（他看不见它，画了也点不到）
//
// ⚠️ 它替掉的是 `home_button_test.dart`（那颗 home 的判据）—— **判据随功能走**：
//    功能没了，它的判据删掉；换来的新东西在这一份里。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/mini_app_host.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Api _api() => Api(
      base: '',
      client: MockClient((req) async {
        if (req.url.path == '/api/apps') {
          return http.Response('{"apps":[]}', 200, headers: {'content-type': 'application/json'});
        }
        return http.Response('', 404);
      }),
    );

Future<ChatController> _pump(WidgetTester tester) async {
  final c = ChatController(api: _api(), tokens: TokenStore(), token: '测试令牌');
  await tester.pumpWidget(
    MaterialApp(
      home: ChatScreen(
        controller: c,
        onLoggedOut: () {},
        space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: true),
        onSendKey: (_) async => KeySend.ok,
      ),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
  await tester.pump(const Duration(milliseconds: 50));
  return c;
}

/// 进一个内置那一格（设置：它进去得最快，而且不依赖任何数据）。
Future<void> _openSettings(WidgetTester tester) async {
  await tester.tap(find.text('设置').first);
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 120));
  }
}

void main() {
  testWidgets('E1 进了 app ⇒ 右上角那颗「退出」在，而且带字、命中区 ≥44', (tester) async {
    await _pump(tester);
    await _openSettings(tester);
    final f = find.byKey(miniAppExitKey);
    expect(f, findsOneWidget, reason: '★ 每一屏右上角都要有它（`D3.15`）');
    // ★ 2026-10-04 主人要的是**一个圆圈**（微信那个样子）⇒ 看得见的是图形，
    //   "退出"这个词挂在 `Semantics`／`Tooltip` 上（读屏与悬停都听得到）。
    expect(find.byTooltip(miniAppExitLabel), findsOneWidget, reason: '★ 那颗圆圈要说得出"退出"');
    final size = tester.getSize(f);
    expect(size.height, greaterThanOrEqualTo(44), reason: '★ 命中区 ≥44（D3.6）');
    expect(size.width, greaterThanOrEqualTo(44));
  });

  testWidgets('E2 🔴 底下那条里那颗 home 没了（负向对照）', (tester) async {
    await _pump(tester);
    // 桌面上（没进任何 app）：那一行里不许有 home
    expect(find.byKey(const Key('chat-home')), findsNothing, reason: '★★ 那颗 home 取消了');
    expect(find.byIcon(Icons.home_outlined), findsNothing);
    expect(find.byIcon(Icons.home), findsNothing);
  });

  testWidgets('E3 点它 ⇒ 回桌面（那一屏关掉、聊天收起来）', (tester) async {
    final c = await _pump(tester);
    await _openSettings(tester);
    expect(find.byKey(miniAppExitKey), findsOneWidget);
    await tester.tap(find.byKey(miniAppExitKey));
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 120));
    }
    // 回桌面：那一屏没了，而桌面那几格还在
    expect(find.byKey(miniAppExitKey), findsNothing, reason: '★ 出来了 ⇒ 那一屏不在了');
    expect(find.text('发现'), findsWidgets, reason: '★ 回到桌面（图标墙还在）');
    expect(c.scope, 'main', reason: '★ 退回桌面 = 回到主线那条对话');
  });

  testWidgets('E5 🔴 平台视图那一屏 ⇒ Flutter 这颗**不画**（同一时刻只许有一颗 ✕）', (tester) async {
    // 直接泵那一层：`exitDrawnElsewhere: true` 就是"真小程序 ＋ 网页"那一档
    //（网页那一侧另画了一颗 DOM 的，见 `mini_runtime_web.dart`）
    Widget host(bool elsewhere) => MaterialApp(
          home: Scaffold(
            body: MiniAppHost(
              open: true,
              title: '真的那个小程序',
              covered: false,
              onCoveredTap: () {},
              bottomInset: 0,
              onExit: () {},
              exitDrawnElsewhere: elsewhere,
              child: const SizedBox.expand(),
            ),
          ),
        );
    await tester.pumpWidget(host(false));
    await tester.pump();
    expect(find.byKey(miniAppExitKey), findsOneWidget, reason: '前提：内置那几屏由 Flutter 画');
    await tester.pumpWidget(host(true));
    await tester.pump();
    expect(find.byKey(miniAppExitKey), findsNothing,
        reason: '★★ 真小程序那一屏：Flutter 这颗不许再画（不然屏幕上两个 ✕）');
  });

  testWidgets('E4 被聊天盖住时 ⇒ 那颗退出不画（点不到的东西不许摆）', (tester) async {
    Widget host(bool covered) => MaterialApp(
          home: Scaffold(
            body: MiniAppHost(
              open: true,
              title: '随便哪一屏',
              covered: covered,
              onCoveredTap: () {},
              bottomInset: 0,
              onExit: () {},
              child: const SizedBox.expand(),
            ),
          ),
        );
    await tester.pumpWidget(host(false));
    await tester.pump();
    expect(find.byKey(miniAppExitKey), findsOneWidget, reason: '前提：没被盖住时它在');
    await tester.pumpWidget(host(true));
    await tester.pump();
    expect(find.byKey(miniAppExitKey), findsNothing, reason: '★ 被盖住 ⇒ 不画');
  });
}
