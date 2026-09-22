// **打字框 + 上面那条草稿**（界面那半边）。契约 `docs/dev/54-COMPOSE-DRAFT.md`。
//
// 主人 2026-09-22：*"就是要有一个空的输入框，但如果用户输入过，没发送，
// 则显示在上面作为草稿。草稿也是要记住的。"*
//
// ⚠️ 存储那半边在 `test/unit/compose_store_test.dart`（"记住"由它守）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/widgets/composer.dart';
import 'package:shared_preferences/shared_preferences.dart';

ChatController _controller() =>
    ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore());

/// 单看输入条（草稿条是它的一部分）。
Future<void> _pumpComposer(
  WidgetTester tester, {
  String? draft,
  void Function(String)? onSend,
  VoidCallback? onCleared,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Composer(
          onSend: onSend ?? (_) {},
          draft: draft,
          onDraftCleared: onCleared,
        ),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  testWidgets('★ 没有草稿 ⇒ 输入框就是**空的**，上面什么都没有', (tester) async {
    await _pumpComposer(tester);
    expect(find.byType(TextField), findsOneWidget);
    expect(find.text(composeDraftTitle), findsNothing, reason: '没草稿就不该画那条');
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      isEmpty,
      reason: '★ 主人要的是"一个空的输入框"',
    );
  });

  testWidgets('🔴 打了一半、没发送 ⇒ **显示在上面作为草稿**', (tester) async {
    await _pumpComposer(tester, draft: '帮我把这周的工时记一下');
    // ⚠️ 判据是"框仍然是空的，而那句话在上面的草稿条里"
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      isEmpty,
      reason: '框该是空的 —— 草稿在**上面**',
    );
    expect(find.text(composeDraftTitle), findsOneWidget, reason: '★ "你打了一半"那一行');
    expect(find.text('帮我把这周的工时记一下'), findsOneWidget, reason: '★ 原话要在');
  });

  testWidgets('🔴 点「接着写」⇒ 字回到框里，草稿条收起来（同一句话不许画两遍）', (tester) async {
    await _pumpComposer(tester, draft: '半句话');
    await tester.tap(find.text(composeDraftBack));
    await tester.pump();
    expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, '半句话');
    expect(find.text(composeDraftTitle), findsNothing, reason: '字进框之后，上面那条该收起来');
  });

  testWidgets('🔴 点「不用了」⇒ 告诉上层清掉', (tester) async {
    var cleared = 0;
    await _pumpComposer(tester, draft: '不想要了', onCleared: () => cleared += 1);
    await tester.tap(find.text(composeDraftDiscard));
    await tester.pump();
    expect(cleared, 1);
  });

  testWidgets('🔴 一边打一边存（"草稿也是要记住的"）+ 发出去之后草稿没了', (tester) async {
    final c = _controller();
    addTearDown(c.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(
          initialTier: FloaterTier.full,
          controller: c,
          onLoggedOut: () {},
          space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: true),
          onSendKey: (_) async => KeySend.ok,
        ),
      ),
    );
    await tester.pump();

    await tester.enterText(find.byType(TextField), '帮我把这周的工时记一下');
    await tester.pump();
    expect(c.composeDraft, '帮我把这周的工时记一下', reason: '★ 每敲一下就存一次');

    // 发出去 ⇒ 上面那条草稿该消失（它已经是"说过的话"了，不是草稿）
    await tester.tap(find.byTooltip('发送'));
    await tester.pump();
    expect(c.composeDraft, isNull, reason: '★ 发出去了就不是草稿了');
  });
}
