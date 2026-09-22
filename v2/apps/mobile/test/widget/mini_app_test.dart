// **小程序（设置）× 聊天**：手册 `08-SPEC.md` §6.4 那几条规矩**画出来了没有**。
//
// 主人 2026-09-22 把三者的关系定清了：
//   *"聊天和桌面是独立的，聊天是永续的，永远在底下。所以聊天不是桌面上的一个小程序。
//     桌面上应当有一个设置的小程序，用来退出登录，注销账号，修改 apikey。"*
//
// ⚠️ `test/widget`（**提示档**）—— 但它钉的是"这一刀到底有没有画到屏幕上"。
//    当闸的两条在别处：五档不溢出 + 命中区 ≥44（`accessibility_test.dart`，含"从真入口进"）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/screens/settings_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/widgets/mini_app_host.dart';
import 'package:hupo_app/widgets/composer.dart';

ChatController _controller() =>
    ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore());

Future<void> _pump(
  WidgetTester tester, {
  FloaterTier tier = FloaterTier.collapsed,
  VoidCallback? onLoggedOut,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: ChatScreen(
        initialTier: tier,
        controller: _controller(),
        onLoggedOut: onLoggedOut ?? () {},
        space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: true),
        onSendKey: (_) async => KeySend.ok,
      ),
    ),
  );
  await tester.pump();
}

/// 打开桌上那个「设置」（真实路径：点图标）。⚠️ 字和图标**都能点**（那是修过的一个 bug）。
Future<void> _openSettings(WidgetTester tester) async {
  await tester.tap(find.text(settingsAppLabel));
  await tester.pumpAndSettle();
}

void main() {
  // ⚠️ 退出登录那条路会 `tokens.clear()`（本机存储）⇒ 测试里得给它一个桩，
  //    不然那句会抛，而"退出登录"看起来像**点了没反应**（那是假象，不是产品行为）。
  TestWidgetsFlutterBinding.ensureInitialized();
  SharedPreferences.setMockInitialValues(<String, Object>{});

  testWidgets('🔴 桌面上**没有**「会话」—— 聊天不是桌面上的小程序', (tester) async {
    await _pump(tester);
    expect(find.text('会话'), findsNothing, reason: '聊天永续、永远在底下 ⇒ 它不该有桌面图标');
    expect(find.byIcon(Icons.chat_bubble_outline), findsNothing);
    // 但聊天**在**（收起那条一直在）
    expect(find.byType(ChatFloater), findsOneWidget);
    expect(find.text('展开'), findsOneWidget);
  });

  testWidgets('🔴 点「设置」⇒ 设置那一屏开了，而且**聊天自动收起**（§6.4 规则 5）', (tester) async {
    // 从**半开**进场：这时桌面顶上那块看得见、点得到（最大化会把桌面盖住）
    await _pump(tester, tier: FloaterTier.half);
    expect(find.byType(Composer), findsOneWidget, reason: '半开时能说话');

    await _openSettings(tester);

    expect(find.byType(SettingsScreen), findsOneWidget, reason: '设置那一屏该开在小程序容器里');
    expect(find.byType(Composer), findsNothing, reason: '★ 打开小程序 ⇒ 聊天该自动收起（把屏幕让给它）');
  });

  testWidgets('🔴 设置里有「退出登录」，点了真的回调（它原来挂在聊天抓手行上）', (tester) async {
    var loggedOut = 0;
    await _pump(tester, onLoggedOut: () => loggedOut += 1);
    await _openSettings(tester);

    // ⚠️ 它在这个小窗口里**在折叠线以下**，而 `ListView` 不建屏幕外的孩子
    //    ⇒ 判据要**像用户那样先滚**（不是把那一行硬塞进屏幕）
    await tester.scrollUntilVisible(
      find.text(settingsLogout),
      200,
      scrollable: find.descendant(of: find.byType(SettingsScreen), matching: find.byType(Scrollable)).first,
    );
    await tester.pumpAndSettle();
    expect(find.text(settingsLogout), findsOneWidget, reason: '主人点名要的三件之一：退出登录');
    await tester.tap(find.text(settingsLogout));
    await tester.pumpAndSettle();
    expect(loggedOut, 1, reason: '★ 点了退出登录就该退出去（一个点了没反应的入口 = 坏了）');
  });

  testWidgets('🔴 小程序打开后是**全屏**的 —— 只有聊天还在底下那一条', (tester) async {
    // 主人 2026-09-22：*"桌面小程序打开后，是全屏显示的，只不过聊天窗口还在底下那里。"*
    await _pump(tester);
    await _openSettings(tester);

    final screen = tester.getRect(find.byType(MaterialApp));
    final host = tester.getRect(find.byType(MiniAppHost));
    final app = tester.getRect(find.byType(SettingsScreen));
    expect(host.size, screen.size, reason: '★ 小程序该是全屏（实测 ${host.size} vs ${screen.size}）——不是带边距的小窗');
    expect(app.width, screen.width, reason: '内容也该全宽');
    // 而**聊天还在底下那一条**（Z1：它永远在最上面）
    expect(find.byType(ChatFloater), findsOneWidget);
    expect(find.text('展开'), findsOneWidget, reason: '聊天收起那条该还在底下浮着');
  });

  testWidgets('🔴 收起那条**压不住**小程序里可点的东西：内容底部内缩（§6.4 规则 1）', (tester) async {
    await _pump(tester);
    await _openSettings(tester);
    final settings = tester.getRect(find.byType(SettingsScreen));
    final floater = tester.getRect(find.byType(ChatFloater));
    // ⚠️ 这一条正是上一代栽过的地方：「最后一行永远点不到」
    expect(settings.bottom <= floater.top, true,
        reason: '设置内容该在收起条**上面**（内容底 ${settings.bottom} vs 条顶 ${floater.top}）');
    expect(settings.bottom > 0, true);
  });

  testWidgets('🔴 聊天展开时小程序被盖住 —— 而且**看得出来**（压暗 + 缩小，§6.4 规则 2）', (tester) async {
    await _pump(tester);
    await _openSettings(tester);

    double opacity() => tester
        .widget<AnimatedOpacity>(
          find.ancestor(of: find.byType(SettingsScreen), matching: find.byType(AnimatedOpacity)).first,
        )
        .opacity;
    double scale() => tester
        .widget<AnimatedScale>(
          find.ancestor(of: find.byType(SettingsScreen), matching: find.byType(AnimatedScale)).first,
        )
        .scale;

    expect(opacity(), 1.0, reason: '没被盖住时是正常的');
    expect(scale(), 1.0);

    await tester.tap(find.text('展开'));
    await tester.pumpAndSettle();

    expect(opacity() < 1.0, true, reason: '★ 被盖住要**看得出来**（压暗），不是"悄悄被盖住"');
    expect(scale() < 1.0, true, reason: '★ 同上（轻微缩小）');
    // 负向对照：**它没被销毁**（规则 4/Z2：被盖住 ≠ 被杀）
    expect(find.byType(SettingsScreen), findsOneWidget, reason: '被盖住不许销毁它');
  });

  testWidgets('🔴 被盖住期间点可见的那一块 ⇒ **只收起聊天**，那一下不传给小程序（规则 3）', (tester) async {
    await _pump(tester);
    await _openSettings(tester);
    await tester.tap(find.text('展开'));
    await tester.pumpAndSettle();
    expect(find.byType(Composer), findsOneWidget);

    // 点小程序可见的那一块（左上角，浮窗盖不到的地方）
    final screen = tester.getRect(find.byType(MaterialApp));
    await tester.tapAt(Offset(screen.left + 8, screen.top + 8));
    await tester.pumpAndSettle();

    expect(find.byType(Composer), findsNothing, reason: '★ 点被盖住的小程序 = "回到小程序" ⇒ 收起聊天');
    expect(find.byType(SettingsScreen), findsOneWidget, reason: '而且小程序还在（没被那一下点走）');
  });
}
