// **按停 ⇒ 自己发出去 ⇒ 聊天记录窗口自己打开**（乙期 · 手册 `D3.14`／`D5.19`）。
//
// ── 这一份钉什么（V6–V8）────────────────────────────────────
//   V6 🔴 按停 ⇒ **自己发出去**（一次 `/api/say`，发的就是**他说的原话**）
//   V7 🔴 **发出去之后那扇聊天记录窗口自己打开**（主人：*"发出去以后聊天窗口自动打开。"*）
//   V8 🔴 **没按停就不发**（到点收了一轮也一样）、窗口也不打开（负向对照）
//
// 🔴 **2026-10-07：那一层"抽离"删了** ⇒ 原来 V6 量的是"改过错别字那句"、
//   V8 量的是"它在问的时候不许发"；现在**一个字都不改、也不问** ⇒ 改成上面那三条。
//
// ⚠️ 这一层是**界面那一条**：链子在控制器里（`test/unit/voice_compose_test.dart`），
//    这里量的是"屏幕上真发生了没有"。

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/hearing.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/voice_bar.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class _Mic implements NativeHearingApi {
  void Function(Map<String, dynamic>)? _on;
  @override
  bool get canHear => true;
  @override
  Future<String?> start({
    required Uri url,
    required String token,
    required void Function(Map<String, dynamic>) onEvent,
  }) async {
    _on = onEvent;
    return null;
  }

  @override
  void stop() {}

  @override
  Future<void> warm({required Uri url, required String token}) async {}

  void push(Map<String, dynamic> e) => _on?.call(e);

  /// 说完一句（🔴 **2026-10-07 起：他按停才算说完**）。
  void say(String text) {
    push({'type': 'asr/ready'});
    push({'type': 'asr/final', 'text': text});
    push({'type': 'asr/end', 'text': text, 'reason': 'user-stop'});
  }
}

class _Server {
  final List<String> said = [];
  int hearCalls = 0;

  late final Api api = Api(
    base: '',
    client: MockClient((req) async {
      if (req.url.path == '/api/hear') {
        // 🔴 那一层删了 ⇒ 走到这儿就是判据要抓的事
        hearCalls += 1;
        return http.Response('{"error":"这一层已经删了"}', 500, headers: {'content-type': 'application/json'});
      }
      if (req.url.path == '/api/say') {
        final b = jsonDecode(req.body) as Map<String, dynamic>;
        said.add((b['text'] as String?) ?? '');
        return http.Response('{"ok":true}', 200, headers: {'content-type': 'application/json'});
      }
      if (req.url.path == '/api/apps') {
        return http.Response('{"apps":[]}', 200, headers: {'content-type': 'application/json'});
      }
      return http.Response('', 404);
    }),
  );
}

Future<_Server> _pump(WidgetTester tester) async {
  final s = _Server();
  await tester.pumpWidget(
    MaterialApp(
      home: ChatScreen(
        controller: ChatController(api: s.api, tokens: TokenStore(), token: '测试令牌'),
        onLoggedOut: () {},
        space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: true),
        onSendKey: (_) async => KeySend.ok,
      ),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
  await tester.pump(const Duration(milliseconds: 50));
  return s;
}

Future<void> _frames(WidgetTester tester) async {
  for (var i = 0; i < 10; i++) {
    await tester.pump(const Duration(milliseconds: 120));
  }
}

void main() {
  setUp(clearNativeHearing);
  tearDown(clearNativeHearing);

  testWidgets('V6/V7 🔴 按停 ⇒ 自己发出去（原话）＋ 记录窗口自己打开（一次都不用点）', (tester) async {
    final mic = _Mic();
    nativeHearingApi = mic;
    final s = await _pump(tester);
    // 说话之前：聊天是**收起的**（那颗收起/展开的标志不在）
    expect(find.byTooltip(chatCollapse), findsNothing);

    await tester.tap(find.byKey(voiceBarCircleKey));
    await tester.pump();
    await tester.tap(find.byKey(voiceBarCircleKey)); // ★ 按停（才算说完）
    await tester.pump();
    mic.say('帮我查一下明天北京的天气予报');
    await _frames(tester);

    expect(s.said, ['帮我查一下明天北京的天气予报'], reason: '★ 发出去的就是他说的原话（一个字都不改）');
    expect(s.hearCalls, 0, reason: '★ 那一层删了：一次都不许调');
    // ⚠️ 2026-10-05：展开态里「收起」有**两颗**（标题行那颗 ＋ 录音旁边那颗翻过来的）
    expect(find.byTooltip(chatCollapse), findsWidgets,
        reason: '★★ 发出去之后聊天记录窗口**自己打开**了（他没点任何东西）');
  });

  testWidgets('V8 🔴 没按停 ⇒ 一次都不发、窗口也不打开（负向对照）', (tester) async {
    // 主人：*"不可能每个句号做断点，也必须是用户说完，语音变成文字拿回来了，我们再发出去。"*
    //   ⇒ 说到一半（哪怕到点收了一轮）**都不算说完**。
    final mic = _Mic();
    nativeHearingApi = mic;
    final s = await _pump(tester);

    await tester.tap(find.byKey(voiceBarCircleKey));
    await tester.pump();
    mic.push({'type': 'asr/ready'});
    mic.push({'type': 'asr/final', 'text': '那个东西弄一下'});
    mic.push({'type': 'asr/end', 'text': '那个东西弄一下', 'reason': 'upstream'}); // 一句完了
    await _frames(tester);
    mic.push({'type': 'asr/capped'}); // 到点收了一轮
    await _frames(tester);

    expect(s.said, isEmpty, reason: '★★ 他还没按停 ⇒ 一次都不许发');
    expect(s.hearCalls, 0);
    expect(find.byTooltip(chatCollapse), findsNothing, reason: '★ 没发出去 ⇒ 窗口不许自己打开');
    // ★ 而那份字**还在屏幕上**（一个字都没丢）
    expect(find.textContaining('那个东西弄一下'), findsWidgets, reason: '★ 前面那句不许没');
  });
}
