// **"这句话是在哪儿说的" —— 现在由哪一屏自己说**（主人 2026-09-23；2026-10-04 改口径）。
//
// 主人原话（2026-09-23）：*"底部的聊天窗口，我需要左侧是一个 icon。是一个 home icon，
// 说明聊天作用域在桌面也就是全局。当进入某个 app 时，聊天作用域也进入了这个 app。
// 所以聊天窗口前面的图标也成了那个 app 的 logo icon。"*
//
// 🔴 **2026-10-04 主人把那一颗取消了**（手册 `D3.15`，原话：*"所有的app，右上角都有一个
//    退出按钮。所以我不再需要home按钮。"*）⇒ 底下那一格**不再收 `leading`**，
//    聊天条最前面那颗 home / 小程序图标**从屏幕上撤掉了**（不是藏起来）。
// ⇒ 这一份守的东西换成**等价的那一件事**（"看得出现在在哪一间"）：
//      · 在桌面上 ⇒ **没有任何一屏压在最上面**（容器是收起的）；
//      · 进了某个 app / 内置那一屏 ⇒ **那一屏自己压在最上面**，出口在它**右上角**；
//      · 窗口自己跟到新那一间（B35）⇒ **聊天窗口里的内容跟着换了一间**。
//
// ⚠️ `test/widget`（**提示档**）—— 它钉的是"这一刀有没有画到屏幕上"。
//    它**不量命中区**：那不是按钮（只指示、不响应点击），所以 D3.6 的 ≥44 与它无关。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:hupo_app/widgets/mini_app_host.dart';
import 'package:hupo_app/models/scope.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/app_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/screens/discover_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/chat_floater.dart';

ChatController _controller() => ChatController(
  api: Api(base: 'http://127.0.0.1:1'),
  tokens: TokenStore(),
);

Future<void> _pump(WidgetTester tester, [ChatController? c]) async {
  await tester.pumpWidget(
    MaterialApp(
      home: ChatScreen(
        initialTier: FloaterTier.collapsed,
        controller: c ?? _controller(),
        onLoggedOut: () {},
        space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: true),
        onSendKey: (_) async => KeySend.ok,
      ),
    ),
  );
  await tester.pump();
}

/// **现在有没有哪一屏压在最上面**（容器开着 = 你在某一间里）。
///
/// ⚠️ `MiniAppHost` **一直在树上**（没开的时候也占着那一格 —— 收回动画要缩的是它自己）
///    ⇒ 判据读的是它的 `open`，不是"它在不在"。
bool _inApp(WidgetTester tester) =>
    tester.widget<MiniAppHost>(find.byType(MiniAppHost)).open;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  SharedPreferences.setMockInitialValues(<String, Object>{});

  testWidgets('🔴 在桌面上（没进任何小程序）⇒ 没有哪一屏压在最上面', (tester) async {
    // 原来守的是：桌面上时聊天条最前面那颗是**家**。
    // 那颗图标取消了（`D3.15`）⇒ 现在守的是**等价的那一件事**：桌面上 = 全局
    // ⇒ 屏幕最上面**没有"某一间"那一屏**。
    await _pump(tester);
    expect(_inApp(tester), isFalse, reason: '★ 桌面上不该有某一屏压在最上面');
  });

  testWidgets('🔴 进了「发现」⇒ 那一屏在最上面、出口在它右上角；退出后回到桌面', (tester) async {
    await _pump(tester);
    await tester.tap(find.text(discoverAppLabel)); // 真入口：点桌面上那个图标
    await tester.pumpAndSettle();

    // 原来是"聊天条前面那个图标换成发现自己的图标"；图标撤了 ⇒ 换成等价的那一件事：
    // **发现那一屏自己压在最上面**（"看得出来在哪儿"的现在形状）。
    expect(_inApp(tester), isTrue, reason: '★ 进了发现 ⇒ 那一屏要压在最上面');
    expect(find.byType(DiscoverScreen), findsOneWidget);
    // 🔴 `D3.15`：出口在**那一屏自己的右上角**（原来那颗 home 干的活搬到了这儿）
    expect(find.byKey(miniAppExitKey), findsOneWidget,
        reason: '★ 那一屏的右上角必须有一颗「退出」（`D3.15`）');

    // 退出 ⇒ 回到"在桌面上"（按那一屏右上角那颗「退出」）
    await tester.tap(find.byKey(miniAppExitKey));
    await tester.pumpAndSettle();
    expect(_inApp(tester), isFalse, reason: '★ 退出之后不该还压着某一屏');
  });

  _b35();

  testWidgets('🔴 收起态也看得出来（收起着，那一屏照样压在最上面）', (tester) async {
    await _pump(tester); // 默认就是收起档
    await tester.tap(find.text(discoverAppLabel));
    await tester.pumpAndSettle();
    expect(find.byType(ChatFloater), findsOneWidget);
    // 原来守的是"收起那条也画那颗图标"；图标撤了 ⇒ 现在守等价的那一件事：
    // 收起态里，那一屏（和它的出口）**照样在最上面** ⇒ 照样看得出在哪一间。
    expect(find.byType(DiscoverScreen), findsOneWidget);
    expect(find.byKey(miniAppExitKey), findsOneWidget);
  });
}

// ── 🔴 B35（主人 2026-09-25 拍）：那个指示**看的是"现在在哪一间"** ──────────────

/// ★ 它原来取 `_openApp`（"点开了哪个图标"）⇒ **窗口自己跟到新那一间**之后，
///   屏幕上还写着「在桌面上问（全局）」—— 而那句话其实进了**另一间**（假话）。
void _b35() {
  testWidgets('🔴 B35：跟到"名字查不到"的那一间 ⇒ 窗口里的内容跟着换了一间（不许还停在主线）', (tester) async {
    final c = _controller();
    // 主线先有一句话（冷启动那一屏就有的东西）
    c.ingest({'type': 'user/echo', 'seq': 1, 'messageId': 'u1', 'text': '主线那句话'});
    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(
          initialTier: FloaterTier.full,
          controller: c,
          onLoggedOut: () {},
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(c.scope, mainScope, reason: '起点该是主线');
    expect(find.text('主线那句话'), findsOneWidget, reason: '起点：主线的窗口里有它');

    // ★ 服务端说"这件事搬到新的一处去了"（`102` §五那条瞬态帧）⇒ 窗口自己跟过去
    c.ingest({'type': 'scope/open', 'scope': 'count-x-y', 'at': 1});
    await tester.pumpAndSettle();

    expect(c.scope, 'count-x-y', reason: '窗口该跟过去了（这一条是 B35 的前提）');
    // 原来守的是：跟过去之后**不许再写「在桌面上问（全局）」**（那是假话）——
    // 那句话挂在那颗**取消了的图标**上 ⇒ 现在守**等价的那一件事**：
    // 窗口里的内容真的换了另一间 ⇒ **主线那句话不许再挂在这一间的窗口里**。
    expect(find.text('主线那句话'), findsNothing,
        reason: '★ 跟过去之后窗口里还挂着主线那句话 —— 那就是假话（话进了另一间）');
  });
}
