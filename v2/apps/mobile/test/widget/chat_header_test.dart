// **会话头：只剩一个视图了 ⇒ 一个 tab 都不许有**。
//
// 主人 2026-09-26 原话：*「聊天和轨迹有选项，我决定不要轨迹。」*
// ⇒ 轨迹那一屏连同「聊天 / 轨迹」那对切换器一起砍了（`#173`，见
// `docs/dev/118-TRAJECTORY-VIEW.md` 顶上那条横幅）。
//
// 这一份是那条决定**屏幕那一侧**的负向对照（源码那一侧在
// `test/unit/trajectory_removed_test.dart`）：
//   ① 会话头上**没有**「聊天 / 轨迹」那一对（再冒出来 ⇒ 当场红）；
//   ② 留下来那几样**还在**：`助手` · `导出` · `过程` ·（右栏那颗按钮）；
//   ③ 右栏那颗按钮**照样开 / 关**（砍轨迹不许把另一件事碰坏）。
//
// ⚠️ 提示档（`AGENTS.md` §5.1：`test/widget` 只有可访问性那一份是硬闸），
//    但它是"屏幕上到底还有没有那一档"的唯一自动化证据。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/export_words.dart';
import 'package:hupo_app/models/file_panel_words.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/widgets/file_panel.dart';
import 'package:shared_preferences/shared_preferences.dart';

ChatController _controller() => ChatController(
  api: Api(base: 'http://127.0.0.1:1'),
  tokens: TokenStore(),
);

Future<void> _pump(WidgetTester tester) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  await tester.pumpWidget(
    MaterialApp(
      home: ChatScreen(
        initialTier: FloaterTier.full,
        controller: _controller(),
        onLoggedOut: () {},
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('🔴 会话头上没有「聊天 / 轨迹」那一对（砍了就是砍了）', (tester) async {
    await _pump(tester);
    final header = find.byType(ChatFloater);
    // 负向对照之对照：先把"扫的是会话头"这句话验一遍（浮窗不在 ⇒ 闸是空的）
    expect(header, findsOneWidget, reason: '★ 浮窗没进这棵树 ⇒ 这道闸扫错了屏');
    expect(
      find.descendant(of: header, matching: find.text('轨迹')),
      findsNothing,
      reason: '主人 2026-09-26 已决定不要轨迹 —— 屏幕上又出现了那一档',
    );
    expect(
      find.descendant(of: header, matching: find.text('聊天')),
      findsNothing,
      reason: '只剩一个视图时不摆切换器（摆一个就是一颗点不动的死键）',
    );
  });

  testWidgets('会话头那几样还在：助手 · 导出 · 过程 ·（右栏那颗）', (tester) async {
    await _pump(tester);
    final header = find.byType(ChatFloater);
    expect(
      find.descendant(of: header, matching: find.text('助手')),
      findsOneWidget,
      reason: '会话头那两个字被碰掉了',
    );
    expect(
      find.descendant(of: header, matching: find.text(exportTooltip)),
      findsOneWidget,
      reason: '「导出」被碰掉了',
    );
    expect(
      find.descendant(of: header, matching: find.text(levelActionWords)),
      findsOneWidget,
      reason: '「过程」被碰掉了',
    );
    expect(
      find.descendant(of: header, matching: find.byKey(filePanelButtonKey)),
      findsOneWidget,
      reason: '★ 右栏那颗按钮被跟轨迹一起砍了 —— 它是**另一件事**，不许动',
    );
  });

  testWidgets('右栏那颗照样开 / 关（砍轨迹不许把它碰坏）', (tester) async {
    await _pump(tester);
    await tester.tap(find.byKey(filePanelButtonKey));
    await tester.pumpAndSettle();
    expect(find.text(filePanelTitle), findsOneWidget, reason: '★ 点开没进去');
    // 开着的时候会话头上那颗**收起来**（出口是栏里那颗）
    expect(find.byKey(filePanelButtonKey), findsNothing);
    await tester.tap(find.byKey(filePanelCloseKey));
    await tester.pumpAndSettle();
    expect(find.byKey(filePanelButtonKey), findsOneWidget, reason: '关掉之后那颗该回来');
  });
}
