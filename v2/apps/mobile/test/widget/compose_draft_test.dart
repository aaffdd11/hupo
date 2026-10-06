// **"打了一半的字要记住"** —— 那一格换成语音优先之后，它落在**打字退路**上。
//
// 主人 2026-09-22：*"就是要有一个空的输入框，但如果用户输入过，没发送，
// 则显示在上面作为草稿。草稿也是要记住的。"*
//
// ── 这一份的历史（别把今天的样子当成一直是这样）────────────────
//   ① 原来它守的是 `widgets/composer.dart`（输入框 ＋ 上面那条"你打了一半"的草稿条：
//      「接着写」/「不用了」）。那四条判据连同那个组件**2026-10-06 一起删了**：
//      那一格 2026-10-05 换成"一颗录音圆圈 ＋ 它左边那行字"之后，
//      `composer.dart` **没有任何生产代码再实例化**（判据随功能走）。
//   ② 🔴 **删的时候发现一条真缺陷**：写草稿的只有那个没人用的组件
//      ⇒ **开不了麦时打了一半的字，刷新一下就没了**（`docs/dev/194` §二）。
//      修法：`VoiceBar` 多两个入参（`draft` / `onDraft` → `ChatController.saveComposeDraft`），
//      进来自动填回框里并摊开、每敲一下喊一声、发出去喊一声空的。
//   ③ ⇒ 这一份现在守**活的这一格**上那三件事（存储那半边照旧由
//      `test/unit/compose_store_test.dart` 守着）。

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/widgets/voice_bar.dart';
import 'package:shared_preferences/shared_preferences.dart';

http.Response _json(String body) => http.Response(
  body,
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

/// 假服务端：`/api/hear` 说"听清了"，`/api/say` 记下那句。
class _Srv {
  final said = <String>[];
  late final ChatController c;
}

_Srv _voiceController() {
  final s = _Srv();
  final api = Api(
    client: MockClient((req) async {
      if (req.url.path.contains('/api/hear')) {
        final b = jsonDecode(req.body) as Map<String, dynamic>;
        return _json(jsonEncode({'heard': (b['text'] as String?) ?? ''}));
      }
      if (req.url.path.contains('/api/say')) {
        s.said.add(req.body);
        return _json('{"ok":true}');
      }
      if (req.url.path.contains('/api/apps')) return _json('{"apps":[]}');
      return _json('{}');
    }),
  );
  s.c = ChatController(api: api, tokens: TokenStore(), token: 'tok');
  return s;
}

/// 从**真的那一屏**进（开不了麦那一档 ⇒ 打字退路才画得出）。
Future<_Srv> _pumpChat(WidgetTester tester) async {
  final s = _voiceController();
  addTearDown(s.c.dispose);
  await tester.pumpWidget(
    MaterialApp(
      home: ChatScreen(
        initialTier: FloaterTier.full,
        controller: s.c,
        onLoggedOut: () {},
      ),
    ),
  );
  await tester.pump();
  return s;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  testWidgets('🔴 每敲一下就喊一声 ⇒ **那份草稿真的进了控制器**（"草稿也是要记住的"）', (tester) async {
    final s = await _pumpChat(tester);
    // 开不了麦 ⇒ 先按那颗「打字」，那一格才摊开
    await tester.tap(find.byKey(voiceBarTypeChipKey));
    await tester.pump();
    expect(find.byKey(voiceBarTypeKey), findsOneWidget, reason: '★ 那颗「打字」没把输入格摊开');

    await tester.enterText(find.byKey(voiceBarTypeKey), '帮我把这周的工时记一下');
    await tester.pump();
    // 🔴 原来这条路**断在界面这一侧**：打了一半刷新就没了（写草稿的只有那个没人用的组件）
    expect(s.c.composeDraft, '帮我把这周的工时记一下',
        reason: '★ 打了一半的字没进控制器 ⇒ 刷新一次就没了（主人 2026-09-22 要的"记住"）');
    expect(tester.widget<TextField>(find.byKey(voiceBarTypeKey)).controller!.text,
        '帮我把这周的工时记一下',
        reason: '★ 打了一半的字被清掉了');
  });

  testWidgets('🔴 上回打了一半的那句 ⇒ **回来还在框里**', (tester) async {
    final s = await _pumpChat(tester);
    // 模拟"读盘回来的那份草稿"（真那条路是 `ChatController._restoreDrafts`：
    // 它把那份字读进 `_typed` 并刷一下）。
    // 🔴 2026-10-07 推倒重来之后：框里那份字的**唯一出处**是 `composeText`（`_typed`），
    //    不再看 `composeDraft` 那一格 —— 所以这里走**真入口**（`voiceEdited`）。
    s.c.voiceEdited('半句话还没说完');
    await tester.pump();
    expect(find.byKey(voiceBarTypeKey), findsOneWidget,
        reason: '★ 有草稿却把那一格收着 ⇒ 屏幕上等于"字丢了"');
    expect(tester.widget<TextField>(find.byKey(voiceBarTypeKey)).controller!.text, '半句话还没说完');
  });

  testWidgets('🔴 那条打字退路：发出去之后**那一格空了**、草稿清掉、那句话进了时间线', (tester) async {
    final s = await _pumpChat(tester);
    await tester.tap(find.byKey(voiceBarTypeChipKey));
    await tester.pump();
    await tester.enterText(find.byKey(voiceBarTypeKey), '帮我把这周的工时记一下');
    await tester.pump();

    // 按「发送」⇒ **当场发出去**（2026-10-07 推倒重来：中间没有第二层了）
    await tester.tap(find.byKey(voiceBarTypedSendKey));
    await tester.pumpAndSettle();

    expect(s.said.length, 1, reason: '★ 那句话没发出去');
    expect(s.c.composeDraft, isNull,
        reason: '★ 发出去了那份草稿还留着 ⇒ 下次回来又冒出一句他已经发过的话');
    // 🔴 2026-10-07：发出去之后那一格**整个收起来**（不是留一个空框）——
    //    "空的时候一个像素都不画"那条规矩在这一格上也成立。
    expect(find.byKey(voiceBarTypeKey), findsNothing,
        reason: '★ 发出去之后那一格还留着（它已经是"说过的话"了）');
    expect(find.text('帮我把这周的工时记一下'), findsWidgets,
        reason: '★ 那句话该进了时间线（屏幕上看得见）');
  });
}
