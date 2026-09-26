// **聊天条最前面那颗 home**（主人 2026-09-27 三件一起定的）：
//   ① *"那个我的小程序不需要 header 和箭头返回，把那一个东西去掉"*
//   ② *"让我的聊天窗口那边左侧的那个 home 按钮扩大一些"*
//   ③ *"点击 home 就是回到桌面…点击 home 那个 icon 上面会有一个浮窗，
//       大概停留 3~4 秒钟，就是说点击这里可以回到桌面哦"*
//
// ⚠️ `test/widget`（**提示档**）—— 它钉的是"这一刀有没有画到屏幕上"。
//    当闸的两条在别处：五档不溢出 + 命中区 ≥44（`accessibility_test.dart`）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:hupo_app/models/app_words.dart';
import 'package:hupo_app/models/scope.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/screens/discover_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/chat_floater.dart';

ChatController _controller() =>
    ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore());

Future<ChatController> _pump(WidgetTester tester, {FloaterTier tier = FloaterTier.collapsed}) async {
  final c = _controller();
  await tester.pumpWidget(
    MaterialApp(
      home: ChatScreen(
        initialTier: tier,
        controller: c,
        onLoggedOut: () {},
        space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: true),
        onSendKey: (_) async => KeySend.ok,
      ),
    ),
  );
  await tester.pump();
  return c;
}

/// 走真入口：点桌面上那个「发现」。
Future<void> _openDiscover(WidgetTester tester) async {
  await tester.tap(find.text(discoverAppLabel));
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  SharedPreferences.setMockInitialValues(<String, Object>{});

  testWidgets('🔴 容器那条顶栏与返回箭头：**进小程序的时候也不在**（整条撤掉）', (tester) async {
    await _pump(tester);
    await _openDiscover(tester);
    // 小程序**开着**的时候判（关掉之后找不到是当然的 —— 那不算）
    expect(find.byType(DiscoverScreen), findsOneWidget, reason: '前提：这一屏真开着');
    expect(find.byTooltip(miniAppBack), findsNothing, reason: '★ 「返回」这个字不许在');
    expect(find.byIcon(Icons.arrow_back), findsNothing, reason: '★ 箭头也不许在');
  });

  testWidgets('★ 那颗 home 的命中区 ≥44（图形只是中间那一块）', (tester) async {
    await _pump(tester);
    final size = tester.getSize(find.byKey(chatHomeButtonKey));
    expect(size.width, greaterThanOrEqualTo(44), reason: '★ D3.6：命中区 ≥44（实测 $size）');
    expect(size.height, greaterThanOrEqualTo(44), reason: '★ D3.6：命中区 ≥44（实测 $size）');
  });

  testWidgets('🔴 进小程序 ⇒ 那颗 home 上面浮一句「$homeHintWords」，3.5 秒后自己走', (tester) async {
    await _pump(tester);

    // 负向对照：**还没进**小程序 ⇒ 一个字都不许有
    expect(find.byKey(chatHomeHintKey), findsNothing, reason: '★ 在桌面上不该有那条提示');
    expect(find.text(homeHintWords), findsNothing);

    // ⚠️ 计时那条**不走 `pumpAndSettle`**（它会把钟往前推一段，算不准）：
    //    点开之后自己推进固定的 600ms（开屏动效 0.5s）—— 从这一刻起算那 3.5 秒。
    await tester.tap(find.text(discoverAppLabel));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));

    expect(find.byKey(chatHomeHintKey), findsOneWidget, reason: '★ 进屏就该浮出来');
    expect(find.text(homeHintWords), findsOneWidget, reason: '★ 逐字：$homeHintWords');

    // 它**浮在那一行上面**（不是把输入条挤下去）：输入条还在，而且提示贴住它的上沿
    final hint = tester.getRect(find.byKey(chatHomeHintKey));
    final bar = tester.getRect(find.byKey(chatHomeButtonKey));
    expect(hint.bottom, lessThanOrEqualTo(bar.top + 1), reason: '★ 提示得在 icon 上面（贴住上沿）');

    // ★ 3.5 秒（`homeHintFor`）之后自己走 —— 不用他点
    await tester.pump(homeHintFor - const Duration(milliseconds: 800));
    expect(find.byKey(chatHomeHintKey), findsOneWidget, reason: '还没到点，别提前收');
    await tester.pump(const Duration(milliseconds: 900));
    expect(find.byKey(chatHomeHintKey), findsNothing, reason: '★ 到点自己走');
  });

  testWidgets('🔴 点那颗 home ⇒ **回到桌面**（那一屏关掉 ＋ 聊天收起来 ＋ 回主线那一间）', (tester) async {
    final c = await _pump(tester);
    await _openDiscover(tester);
    expect(find.byType(DiscoverScreen), findsOneWidget);

    await tester.tap(find.byKey(chatHomeButtonKey));
    await tester.pumpAndSettle();

    expect(find.byType(DiscoverScreen), findsNothing, reason: '★ 关掉了');
    expect(c.scope, mainScope, reason: '★ 回到桌面那一间（契约 83 §五·甲）');
    expect(find.byTooltip(chatCollapse), findsNothing, reason: '★ 聊天也收起来了（桌面才露得出来）');
    expect(find.byKey(chatHomeHintKey), findsNothing, reason: '★ 他真按了 ⇒ 那条提示不用再留着');
  });

  testWidgets('★ 在桌面上按它：照样有结果（把聊天收起来）—— 它不是一颗空按钮', (tester) async {
    await _pump(tester, tier: FloaterTier.full);
    expect(find.byTooltip(chatCollapse), findsOneWidget, reason: '前提：聊天是展开的');

    await tester.tap(find.byKey(chatHomeButtonKey));
    await tester.pumpAndSettle();
    expect(find.byTooltip(chatCollapse), findsNothing, reason: '★ 收起来了 = 回到桌面');
  });

  testWidgets('★ 那条提示**不吃点击**（浮着的一句说明，不许挡住底下的东西）', (tester) async {
    await _pump(tester);
    await _openDiscover(tester);
    expect(
      find.descendant(
        of: find.byKey(chatHomeHintKey),
        matching: find.byType(IgnorePointer),
      ),
      findsNothing,
      reason: '（提示自己不是 IgnorePointer，**包着它的那一层**才是）',
    );
    expect(
      find.ancestor(
        of: find.byKey(chatHomeHintKey),
        matching: find.byType(IgnorePointer),
      ),
      findsWidgets,
      reason: '★ 外面必须有一层 `IgnorePointer` —— 不然它会挡住时间线那一片的点击',
    );
  });
}
