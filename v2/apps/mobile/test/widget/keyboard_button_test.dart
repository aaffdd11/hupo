// 🔴 **左下角那颗「键盘」**（主人 2026-10-09）：
//   *"左下角有个在办的事务的按钮，这个按钮下面放一个键盘按钮。
//     点击会打开输入框和键盘。再次点击会收起。"*
//
// 这一份钉四件（每件都带反例）：
//   ① 🔴 它在**「清单」那一颗下面**（同一列、左边对齐），两个档都在，命中区 ≥44（D3.6）；
//   ② 🔴 点一下 ⇒ **输入框长出来**（`voiceBarTypeKey`）**并且真的拿到焦点**（＝键盘弹出来）；
//      再点一下 ⇒ 框没了**而且焦点交回去**（键盘收起）；
//   ③ 🔴 **有草稿时也收得掉**（原来那个框只要有字就赖在屏幕上），再打开草稿还在；
//   ④ 🔴 状态**只有一处**（`chat_screen`）：浮窗与输入条拿的是同一个数 ——
//      用源码那一条盯着（与 `voice_buttons_test` 的 `③·补` 同一个做法）。

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/dsh_design.dart';
import 'package:hupo_app/models/voice_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/widgets/voice_bar.dart';
import 'package:shared_preferences/shared_preferences.dart';

http.Response _json(String body, [int status = 200]) => http.Response(
  body,
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

class _Rec {
  final says = <String>[];
  late ChatController c;
}

_Rec _controller() {
  final r = _Rec();
  final api = Api(
    client: MockClient((req) async {
      if (req.url.path.contains('/api/hear')) {
        final b = jsonDecode(req.body) as Map<String, dynamic>;
        return _json(jsonEncode({'heard': (b['text'] as String?) ?? ''}));
      }
      if (req.url.path.contains('/api/say')) {
        r.says.add(req.body);
        return _json('{"ok":true}');
      }
      if (req.url.path.contains('/api/apps')) return _json('{"apps":[]}');
      return _json('{}');
    }),
  );
  r.c = ChatController(api: api, tokens: TokenStore(), token: 'tok');
  return r;
}

/// **走真入口**（与 `expand_input_test.dart` / `accessibility_test.dart` 同一条路）。
Future<void> _pump(WidgetTester tester, ChatController c) async {
  SharedPreferences.setMockInitialValues(<String, Object>{
    'hupo_chat_appearance': 'light|$dshContentFontSizeDefault',
  });
  await tester.pumpWidget(
    MaterialApp(home: ChatScreen(controller: c, onLoggedOut: () {})),
  );
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // ── ① 它在哪儿 ─────────────────────────────────────────────

  testWidgets('① 🔴 两个档里它都在「清单」那颗**下面**，左边对齐，命中区 ≥44', (tester) async {
    for (final expanded in const [false, true]) {
      final r = _controller();
      await _pump(tester, r.c);
      if (expanded) {
        await tester.tap(find.byKey(chatHandleKey));
        await tester.pumpAndSettle();
      }
      final tier = expanded ? '展开档' : '收起档';
      expect(find.byKey(chatKeyboardKey), findsOneWidget, reason: '$tier：★ 那颗「键盘」不见了');
      expect(find.byKey(chatWorkKey), findsOneWidget, reason: '$tier：★ 「清单」那颗不见了（前提）');

      final kb = tester.getRect(find.byKey(chatKeyboardKey));
      final work = tester.getRect(find.byKey(chatWorkKey));
      expect(kb.width >= 44 && kb.height >= 44, true,
          reason: '$tier：★ 命中区 ${kb.size} 小于 44×44（D3.6）');
      // 🔴 "这个按钮下面" ⇒ 竖直上在它下面（不是并排），而且同一列
      expect(kb.top >= work.bottom - 0.5, true,
          reason: '$tier：★ 它没在「清单」下面（top ${kb.top} vs bottom ${work.bottom}）');
      expect((kb.left - work.left).abs() < 0.5, true,
          reason: '$tier：★ 没跟「清单」左边对齐（${kb.left} vs ${work.left}）');
      // 负向对照：输入条**不许**因为多了一颗按钮就搬家（两者都画在同一行里）
      expect(kb.bottom <= work.bottom + 4 * 44 + 2, true,
          reason: '$tier：★ 那一列高得离谱（${kb.bottom} vs ${work.bottom}）');
    }
  });

  // ── ② 点开 / 收起 ──────────────────────────────────────────

  testWidgets('② 🔴 点一下 ⇒ 输入框长出来**并且拿到焦点**；再点一下 ⇒ 收掉、焦点交回', (tester) async {
    final r = _controller();
    await _pump(tester, r.c);
    await tester.tap(find.byKey(chatHandleKey)); // 展开（那一行两个档都画）
    await tester.pumpAndSettle();

    // 前提（负向对照）：没点它之前，屏幕上**没有**那个输入框
    expect(find.byKey(voiceBarTypeKey), findsNothing, reason: '★ 一上来就摆了个框（前提不成立）');

    await tester.tap(find.byKey(chatKeyboardKey));
    await tester.pumpAndSettle();
    expect(find.byKey(voiceBarTypeKey), findsOneWidget, reason: '★ 点了它输入框没出来');
    final node = tester.widget<TextField>(find.byKey(voiceBarTypeKey)).focusNode!;
    expect(node.hasFocus, isTrue, reason: '★ 框出来了但**没拿到焦点**（＝键盘不会弹）');

    // 再点一下 ⇒ 收起（框没了 ＋ 焦点交回去）
    await tester.tap(find.byKey(chatKeyboardKey));
    await tester.pumpAndSettle();
    expect(find.byKey(voiceBarTypeKey), findsNothing, reason: '★ 再点一下没有收掉');
    // ⚠️ 量的**就是刚才那个节点**（不是"屏幕上还有没有框"）：它必须**不再**是主焦点
    //    —— 不然键盘会一直挂在屏幕上（用户报的"收不掉"就是这个形状）。
    expect(identical(FocusManager.instance.primaryFocus, node), isFalse,
        reason: '★ 框收了但焦点还攥着（键盘不会收）');
  });

  testWidgets('③ 🔴 有草稿时也收得掉；再打开，那份字还在', (tester) async {
    final r = _controller();
    await _pump(tester, r.c);
    await tester.tap(find.byKey(chatHandleKey));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(chatKeyboardKey));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(voiceBarTypeKey), '半句话');
    await tester.pumpAndSettle();
    // 前提：草稿真的进了控制器（不然下面"还在"是空转）
    expect(r.c.composeText, contains('半句话'), reason: '★ 打的字没进控制器（前提不成立）');

    // 🔴 就是他说的那一下"再次点击会收起" —— 有字也必须收得掉
    await tester.tap(find.byKey(chatKeyboardKey));
    await tester.pumpAndSettle();
    expect(find.byKey(voiceBarTypeKey), findsNothing,
        reason: '★ 有草稿时那颗按钮收不掉它（原来那个框只要有字就赖着）');

    // 再打开 ⇒ 那份字还在（收起只是"先不摆"，不是丢掉）
    await tester.tap(find.byKey(chatKeyboardKey));
    await tester.pumpAndSettle();
    expect(find.byKey(voiceBarTypeKey), findsOneWidget);
    expect(
      tester.widget<TextField>(find.byKey(voiceBarTypeKey)).controller?.text,
      contains('半句话'),
      reason: '★ 收起再打开，那份草稿没了',
    );
  });

  // ── ④ 状态只有一处 ────────────────────────────────────────

  test('④ 🔴 单一出处：`chat_screen` 把同一个数给了浮窗与输入条', () {
    final src = File('lib/screens/chat_screen.dart').readAsStringSync();
    for (final needle in const [
      'keyboardOpen: _keyboardOpen',
      'onToggleKeyboard: _toggleKeyboard',
      'typingOpen: _keyboardOpen',
      'onKeyboardWanted: _wantKeyboard',
    ]) {
      expect(src.contains(needle), isTrue, reason: '★ 少了一句：`$needle`（会变成两份状态）');
    }
  });

  // ── ⑤ 那句提示不许说假话 ───────────────────────────────────

  testWidgets('⑤ 🔴 能开麦的那一台摊开这一格时，框里那句不许写"这台开不了麦"', (tester) async {
    Future<String?> hintOf({required bool canHear}) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: VoiceBar(
              text: '',
              recording: false,
              wrapping: false,
              canHear: canHear,
              typingOpen: true,
              onChanged: (_) {},
              onMic: () {},
              onSend: (_) {},
              onKeyboardWanted: (_) {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return tester.widget<TextField>(find.byKey(voiceBarTypeKey)).decoration?.hintText;
    }

    // 🔴 能开麦 ＋ 他自己按了那颗「键盘」⇒ 提示得是"打一句吧…"
    expect(await hintOf(canHear: true), voiceTypeHereLead,
        reason: '★ 能开麦的机器上写着"这台开不了麦"＝屏幕在说假话');
    // 负向对照：真的开不了麦那一台照旧用原来那句（不然上面那条就成了空转）
    expect(await hintOf(canHear: false), voiceTypeInstead);
  });
}
