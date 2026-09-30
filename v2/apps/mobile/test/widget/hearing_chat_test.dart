// **聊天窗口那颗话筒：说出来的字到底进没进输入框**（真 `ChatScreen`，两个档都量）。
//
// ── 为什么要有这一份（2026-10-01 主人报的原话）────────────────────
//    *"好了，可以用了，那么我们在聊天窗口使用时，发现不对。当我点击语音的时候，
//      文本框没有出现文字。"*
//
// 🔴 **它和 `hearing_test.dart` 不是一回事**：那一份把 `Composer` **单独**泵起来，
//    钉的是"框这一层收不收得到字"；这一份从**真的 `ChatScreen`** 进去 ——
//    中间还夹着 `ChatFloater`（收起/展开两个档）与 `ChatController` 那条
//    `startHear → onEvent → Hearing.event → notifyListeners → setState` 的链子。
//    那一段**从来没有判据**（"闸打在替代的那一侧"那一族）——
//    主人报的正是这一条链子，所以判据补在这一侧。
//
// 现在钉两条（两条都是"屏幕上的输入框里到底有没有那几个字"）：
//   ① **收起档**：按话筒 ⇒ 交出去 ⇒ 半句/定稿/收尾 ⇒ 字在框里
//   ② **展开档**：先点抓手展开，再按话筒 ⇒ 一样要进框
//      （展开/收起会换一棵子树 —— 字不许因此在两棵之间掉一个）
//
// ⚠️ `canHear` 在 `flutter test` 里默认是假（`services/hearing_stub.dart`）⇒
//    这里装一个**假的原生钩子**把 `canHear` 变成真（真机上装的就是它），
//    而 `startHear` 由 `ChatController` 注入 —— **照真实时序走**：先 `asr/ready`，
//    再一条条半句，最后 `asr/end`。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/hearing_session.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/hearing.dart' as hs;
import 'package:hupo_app/services/token_store.dart';

http.Response _json(String b) => http.Response(b, 200, headers: {'content-type': 'application/json'});

/// 假的"原生那一份"：**只为了让 `canHear` 为真**（真安卓上装的是真的那一份）。
class _FakeNative implements hs.NativeHearingApi {
  @override
  bool get canHear => true;
  @override
  Future<String?> start({
    required Uri url,
    required String token,
    required void Function(Map<String, dynamic>) onEvent,
  }) async => 'unsupported';
  @override
  void stop() {}
}

/// 先喂两句历史（**展开那一档要有点东西可展开**；空时间线时抓手点了不展）。
void _feed(ChatController c, int rounds) {
  var seq = 1;
  for (var i = 1; i <= rounds; i += 1) {
    c.ingest({'type': 'user/echo', 'seq': seq++, 'messageId': 'u$i', 'text': '第 $i 句'});
    c.ingest({'type': 'message/start', 'messageId': 'm$i', 'seq': seq++});
    c.ingest({'type': 'message/text', 'messageId': 'm$i', 'block': 'quick', 'text': '第 $i 答', 'seq': seq++});
    c.ingest({'type': 'message/end', 'messageId': 'm$i', 'seq': seq++, 'reason': 'completed'});
  }
}

/// 一屏 `ChatScreen` ＋ 一颗能接住事件的话筒。
class _Rig {
  final feeds = <void Function(Map<String, dynamic>)>[];
  int starts = 0;
  int stops = 0;
  late ChatController c;
}

_Rig _make() {
  final r = _Rig();
  final api = Api(client: MockClient((req) async {
    if (req.url.path.contains('/api/apps')) return _json('{"apps":[]}');
    return _json('{}');
  }));
  r.c = ChatController(
    api: api,
    tokens: TokenStore(),
    token: 'tok',
    startHear: ({required Uri url, required String token, required void Function(Map<String, dynamic>) onEvent}) async {
      r.starts += 1;
      r.feeds.add(onEvent);
      return null; // 真开起来了
    },
    stopHear: () => r.stops += 1,
  );
  return r;
}

Future<void> _pump(WidgetTester tester, ChatController c) async {
  await tester.pumpWidget(MaterialApp(home: ChatScreen(controller: c, onLoggedOut: () {})));
  await tester.pumpAndSettle();
}

/// **真实时序**（与线上那条真读数一致：ready → 半句（累积）→ 定稿 → 收尾）。
Future<void> _say(WidgetTester tester, _Rig r, {required String words}) async {
  for (final e in <Map<String, dynamic>>[
    {'type': 'asr/ready'},
    {'type': 'asr/partial', 'text': words.substring(0, 2), 'index': 0},
    {'type': 'asr/partial', 'text': words, 'index': 0},
    {'type': 'asr/final', 'text': words, 'index': 0},
    {'type': 'asr/end', 'text': words, 'index': 0, 'reason': 'user-stop'},
  ]) {
    r.feeds.last(e);
    await tester.pump();
  }
  await tester.pumpAndSettle();
}

String _boxText(WidgetTester tester) =>
    tester.widget<TextField>(find.byType(TextField).first).controller?.text ?? '';

void main() {
  setUp(() => hs.nativeHearingApi = _FakeNative());
  tearDown(() => hs.clearNativeHearing());

  testWidgets('① 收起档：按话筒 ⇒ 说一句 ⇒ **字进输入框**', (tester) async {
    final r = _make();
    await _pump(tester, r.c);
    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    expect(r.starts, 1, reason: '★ 按一下要真的交出去（而不是只画个样子）');
    expect(r.c.hearing.phase, HearingPhase.listening);
    await _say(tester, r, words: '今天天气怎么样');
    expect(_boxText(tester), contains('今天天气怎么样'), reason: '★ 听到了字就该在框里');
  });

  testWidgets('② 展开档：先展开再按话筒 ⇒ 一样要进框', (tester) async {
    final r = _make();
    _feed(r.c, 3); // ⚠️ 空时间线时抓手点了不展（真应用里也总是有东西）
    await _pump(tester, r.c);
    // 像用户那样展开（点抓手）—— 真应用就是从收起档开始的
    await tester.tap(find.byKey(chatHandleKey));
    await tester.pumpAndSettle();
    expect(find.byType(ListView), findsWidgets, reason: '★ 抓手那一下没把浮窗展开');
    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    expect(r.starts, 1);
    await _say(tester, r, words: '明天去哪里吃饭');
    expect(_boxText(tester), contains('明天去哪里吃饭'), reason: '★ 展开档听到了字也要进框');
  });
}
