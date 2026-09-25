// **聊天条最前面那个图标：这句话是在哪儿说的**（主人 2026-09-23）。
//
// 主人原话：*"底部的聊天窗口，我需要左侧是一个 icon。是一个 home icon，说明聊天作用域
// 在桌面也就是全局。当进入某个 app 时，聊天作用域也进入了这个 app。所以聊天窗口前面的
// 图标也成了那个 app 的 logo icon。"*
//
// ⚠️ `test/widget`（**提示档**）—— 它钉的是"这一刀有没有画到屏幕上"。
//    它**不量命中区**：那不是按钮（只指示、不响应点击），所以 D3.6 的 ≥44 与它无关。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/math_words.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/app_desktop.dart';
import 'package:hupo_app/widgets/chat_floater.dart';

ChatController _controller() => ChatController(
  api: Api(base: 'http://127.0.0.1:1'),
  tokens: TokenStore(),
);

Future<void> _pump(WidgetTester tester) async {
  await tester.pumpWidget(
    MaterialApp(
      home: ChatScreen(
        initialTier: FloaterTier.collapsed,
        controller: _controller(),
        onLoggedOut: () {},
        space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: true),
        onSendKey: (_) async => KeySend.ok,
      ),
    ),
  );
  await tester.pump();
}

/// 聊天条最前面那个图标**此刻是哪一个**（按它的说明去定位 —— 说明与图标一起被钉住）。
IconData _badgeIcon(WidgetTester tester, String message) {
  final tooltip = find.byTooltip(message);
  expect(tooltip, findsOneWidget, reason: '★ 聊天条最前面那个图标的说明不是「$message」');
  final icon = tester.widget<Icon>(
    find.descendant(of: tooltip, matching: find.byType(Icon)),
  );
  return icon.icon!;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  SharedPreferences.setMockInitialValues(<String, Object>{});

  testWidgets('🔴 在桌面上（没进任何小程序）⇒ 最前面是一个**家**', (tester) async {
    await _pump(tester);
    expect(
      _badgeIcon(tester, chatScopeDesktop),
      Icons.home_outlined,
      reason: '★ 桌面上 = 全局 ⇒ 该是 home',
    );
  });

  testWidgets('🔴 进了「奥数题」⇒ 那个图标变成**奥数题自己的图标**，而且退出后回到**家**', (tester) async {
    await _pump(tester);
    await tester.tap(find.text(mathAppLabel)); // 真入口：点桌面上那个图标
    await tester.pumpAndSettle();

    final inApp = _badgeIcon(tester, chatScopeInApp(mathTitle));
    // ⚠️ **跟桌面上那一个是同一个**（"进去了"在两处必须是同一件事 —— 所以图标只有一份来源）
    final onDesktop = tester.widget<Icon>(
      find
          .descendant(
            of: find.byType(AppDesktop),
            matching: find.byIcon(Icons.calculate_outlined),
          )
          .first,
    );
    expect(inApp, onDesktop.icon, reason: '★ 聊天条前面那个图标必须与桌面上那个是同一个小程序的图标');

    // 退出小程序 ⇒ 回到"在桌面上"
    await tester.tap(find.byTooltip(miniAppBack));
    await tester.pumpAndSettle();
    expect(
      _badgeIcon(tester, chatScopeDesktop),
      Icons.home_outlined,
      reason: '★ 退出之后不该还写着那个小程序',
    );
  });

  _b35();

  testWidgets('🔴 收起态也画它（收起那条照样能发话 ⇒ 也该看得出在哪儿说）', (tester) async {
    await _pump(tester); // 默认就是收起档
    expect(find.byType(ChatFloater), findsOneWidget);
    expect(
      find.descendant(
        of: find.byType(ChatFloater),
        matching: find.byTooltip(chatScopeDesktop),
      ),
      findsOneWidget,
    );
  });
}

// ── 🔴 B35（主人 2026-09-25 拍）：那个指示**看的是"现在在哪一间"** ──────────────

/// ★ 它原来取 `_openApp`（"点开了哪个图标"）⇒ **窗口自己跟到新那一间**之后，
///   屏幕上还写着「在桌面上问（全局）」—— 而那句话其实进了**另一间**（假话）。
extension on WidgetTester {
  /// 从外面喂一条事实进去（和真那条流同一个入口 —— `ChatController.ingest`）。
  void feed(ChatController c, Map<String, dynamic> e) => c.ingest(e);
}

void _b35() {
  testWidgets('🔴 B35：跟到"名字查不到"的那一间 ⇒ 说明**不许**再写"在桌面上"', (tester) async {
    final c = _controller();
    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(
          initialTier: FloaterTier.collapsed,
          controller: c,
          onLoggedOut: () {},
        ),
      ),
    );
    await tester.pumpAndSettle();
    // 起点：主对话 ⇒ 「在桌面上问（全局）」
    expect(find.byTooltip(chatScopeDesktop), findsOneWidget, reason: '起点该是"在桌面上"');

    // ★ 服务端说"这件事搬到新的一处去了"（`102` §五那条瞬态帧）⇒ 窗口自己跟过去
    tester.feed(c, {'type': 'scope/open', 'scope': 'count-x-y', 'at': 1});
    await tester.pumpAndSettle();

    expect(c.scope, 'count-x-y', reason: '窗口该跟过去了（这一条是 B35 的前提）');
    expect(
      find.byTooltip(chatScopeDesktop),
      findsNothing,
      reason: '★ 跟过去之后还写着"在桌面上问" —— 那就是假话（话进了另一间）',
    );
    expect(
      find.byTooltip(chatScopeElsewhere),
      findsOneWidget,
      reason: '★ 名字查不到时要说那句不撒谎的模糊话',
    );
  });
}
