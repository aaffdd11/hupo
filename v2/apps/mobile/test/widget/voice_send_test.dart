// **说完 ⇒ 自己发出去 ⇒ 聊天记录窗口自己打开**（乙期 · 手册 `D3.14`／`D5.19`）。
//
// ── 这一份钉什么（V6–V7）────────────────────────────────────
//   V6 🔴 语义没问题 ⇒ **自己发出去**（一次 `/api/say`，发的是**改过错别字**那句）
//   V7 🔴 **发出去之后那扇聊天记录窗口自己打开**（主人：*"发出去以后聊天窗口自动打开。"*）
//   V8 它在问的时候 ⇒ **一次都不许发**、窗口也**不许**打开（负向对照）
//
// ⚠️ 这一层是**界面那一条**：链子在控制器里（`test/unit/voice_compose_test.dart` 5/0），
//    这里量的是"屏幕上真发生了没有"。

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/semantic_switch.dart';
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

  /// 说完一句（🔴 **2026-10-07 起：他按停才算说完** —— 主人*「我的目的是语音输入。要连贯」*；
  /// 这里只补"按停"那一下，量的事一件没变：按停之后发的是哪一份字）。
  void say(String text) {
    _on?.call({'type': 'asr/ready'});
    _on?.call({'type': 'asr/final', 'text': text});
    _on?.call({'type': 'asr/end', 'text': text, 'reason': 'user-stop'});
  }
}

class _Server {
  _Server(this.hearReply);
  final Map<String, Object?> hearReply;
  final List<String> said = [];
  final List<String> asked = [];

  late final Api api = Api(
    base: '',
    client: MockClient((req) async {
      if (req.url.path == '/api/hear') {
        asked.add(req.body);
        return http.Response(jsonEncode(hearReply), 200, headers: {'content-type': 'application/json'});
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

Future<_Server> _pump(WidgetTester tester, Map<String, Object?> hearReply) async {
  final s = _Server(hearReply);
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
  // 🔴 **2026-10-06：这一份量的是"听懂那一层"那条路**（主人当天说*「先暂停语义检查。
  //   不要检查语义，直接快速语音转文字，点击结束就发送。」*）⇒ 那条路**代码还在、
  //   生产里关着** ⇒ 这里临时打开（判据才量得到 V6–V8），验完还原。
  //   "关着"那一档（说完直接发、一次都不调 `/api/hear`）住 `test/unit/semantic_pause_test.dart`。
  setUp(() {
    semanticCheckOn = true;
    clearNativeHearing();
  });
  tearDown(() {
    semanticCheckOn = false;
    clearNativeHearing();
  });

  testWidgets('V6/V7 🔴 通顺 ⇒ 自己发出去 ＋ 记录窗口自己打开（一次都不用点）', (tester) async {
    final mic = _Mic();
    nativeHearingApi = mic;
    final s = await _pump(tester, {
      'heard': '帮我查一下明天北京的天气预报',
      'ask': null,
      'fact': '予报→预报',
      'scene': 'do',
    });
    // 说话之前：聊天是**收起的**（那颗收起/展开的标志不在）
    expect(find.byTooltip(chatCollapse), findsNothing);

    await tester.tap(find.byKey(voiceBarCircleKey));
    await tester.pump();
    await tester.tap(find.byKey(voiceBarCircleKey)); // ★ 按停（才算说完）
    await tester.pump();
    mic.say('帮我查一下明天北京的天气予报');
    await _frames(tester);

    expect(s.said, ['帮我查一下明天北京的天气预报'], reason: '★ 发出去的是改过错别字那句');
    // ⚠️ 2026-10-05：展开态里「收起」有**两颗**（标题行那颗 ＋ 录音旁边那颗翻过来的）
    expect(find.byTooltip(chatCollapse), findsWidgets,
        reason: '★★ 发出去之后聊天记录窗口**自己打开**了（他没点任何东西）');
  });

  testWidgets('V8 🔴 它在问的时候：一次都不发、窗口也不打开（负向对照）', (tester) async {
    final mic = _Mic();
    nativeHearingApi = mic;
    final s = await _pump(tester, {
      'heard': '那个东西弄一下',
      'ask': '你说的那个东西是指什么？',
      'scene': 'do',
    });
    await tester.tap(find.byKey(voiceBarCircleKey));
    await tester.pump();
    await tester.tap(find.byKey(voiceBarCircleKey)); // ★ 按停（才算说完）
    await tester.pump();
    mic.say('那个东西弄一下');
    await _frames(tester);

    expect(s.asked.length, 1, reason: '★ 它问了一句');
    expect(s.said, isEmpty, reason: '★★ 问了就不许发');
    // ⚠️ 现在是**气泡里那一句**（后面还带着"（按一下圆圈，答一句就行）"）
    expect(find.textContaining('你说的那个东西是指什么？'), findsWidgets, reason: '★ 那一句写在屏幕上');
    expect(find.byTooltip(chatCollapse), findsNothing, reason: '★ 没发出去 ⇒ 窗口不许自己打开');
  });
}
