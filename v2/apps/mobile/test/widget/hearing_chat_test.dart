// **聊天底下那一格：说出来的字到底进没进屏幕上**（真 `ChatScreen`，两个档都量）。
//
// ── 为什么要有这一份（2026-10-01 主人报的原话）────────────────────
//    *"好了，可以用了，那么我们在聊天窗口使用时，发现不对。当我点击语音的时候，
//      文本框没有出现文字。"*
//
// 🔴 **它和 `hearing_test.dart` 不是一回事**：那一份把旧的 `Composer` **单独**泵起来，
//    钉的是"框这一层收不收得到字"；这一份从**真的 `ChatScreen`** 进去 ——
//    中间还夹着 `ChatFloater`（收起/全开两个档）与 `ChatController` 那条
//    `startHear → onEvent → Hearing.event → notifyListeners → setState` 的链子。
//    那一段**从来没有判据**（"闸打在替代的那一侧"那一族）——
//    主人报的正是这一条链子，所以判据补在这一侧。
//
// ── 🔴 2026-10-06：字长的地方换了 ────────────────────────────
//    底下那一格换成**语音优先**（`widgets/voice_bar.dart`）之后，说出来的字
//    **长在那一行里**（那颗圆圈左边的气泡），**没有输入框** —— 旧 `Composer`
//    已经不在任何生产路径上。⇒ 判据跟着搬：量的是**那一行里有没有那几个字**。
//
// 现在钉三条（三条都是"屏幕底下那一行里到底有没有那几个字"）：
//   ① **收起档**：按圆圈 ⇒ 交出去 ⇒ 半句/定稿 ⇒ 字在那一行里
//   ② **全开档**：先点抓手展开，再按圆圈 ⇒ 一样要进那一行
//      （展开/收起会换一棵子树 —— 字不许因此在两棵之间掉一个）
//   ③ 🔴 停下语音**不许唤醒键盘**（那一格上一个输入框都不该有）
//
// ⚠️ `canHear` 在 `flutter test` 里默认是假（`services/hearing_stub.dart`）⇒
//    这里装一个**假的原生钩子**把 `canHear` 变成真（真机上装的就是它），
//    而 `startHear` 由 `ChatController` 注入 —— **照真实时序走**：先 `asr/ready`，
//    再一条条半句，最后 `asr/end`。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/widgets/voice_bar.dart';
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

  @override
  Future<void> warm({required Uri url, required String token}) async {}
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

/// **真实时序**（与线上那条真读数一致：ready → 半句（累积）→ 定稿）。
///
/// 🔴 字现在长在**底下那一行**（`VoiceBar` 的气泡）里，不再是那个旧 `Composer`
///    的 `TextField`；而且它一进"听懂"那一层就会被换成问句 / 一句实话 / 发出去
///    ⇒ "听到了"这件事要**在半句/定稿那一刻**量（那正是主人报的"没有出现文字"的现场）。
Future<void> _say(WidgetTester tester, _Rig r, {required String words}) async {
  for (final e in <Map<String, dynamic>>[
    {'type': 'asr/ready'},
    {'type': 'asr/partial', 'text': words.substring(0, 2), 'index': 0},
    {'type': 'asr/partial', 'text': words, 'index': 0},
    {'type': 'asr/final', 'text': words, 'index': 0},
  ]) {
    r.feeds.last(e);
    await tester.pump();
  }
  // ★ 原来守的是"那几个字有没有进那个输入框" ⇒ 现在守**等价的那一件事**：
  //   **那几个字真的长到了底下那一行上**（原来防的缺陷 = 点了语音屏幕上不出字）。
  expect(_barText(tester), contains(words), reason: '★ 听到了字就该在底下那一行里');
  // 收尾那一帧（`asr/end`）之后它自己进"听懂"那一层 —— 那一层在 VM 上答不出来，
  // 所以判据钉在"字确实上过屏"这一件事上（半句/定稿那一刻）。
  r.feeds.last({'type': 'asr/end', 'text': words, 'index': 0, 'reason': 'user-stop'});
  await tester.pumpAndSettle();
}

/// 底下那一格里的字（= `VoiceBar` 那个**真输入框**里那份字）。
///
/// 🔴 2026-10-07：字不再画在气泡上，而是**长在输入框里** ⇒ 读的是那个框的 controller
///    （`EditableText` 才是真正拿字的那一层）。空的时候那一格一个像素都不画。
String _barText(WidgetTester tester) {
  final f = find.descendant(of: find.byType(VoiceBar), matching: find.byType(EditableText));
  if (f.evaluate().isNotEmpty) return tester.widget<EditableText>(f.first).controller.text;
  return tester
      .widgetList<Text>(find.descendant(of: find.byType(VoiceBar), matching: find.byType(Text)))
      .map((t) => t.data ?? '')
      .join(' ');
}

/// 键盘会不会被顶上来（＝**有没有输入框在抢焦点**）。
///
/// ⚠️ 原来量的是旧 `Composer` 那个 `TextField` 的 `_focus` —— 那一格现在
///    **根本不该有输入框**（开得了麦时只有圆圈；打字那条退路要他按「打字」才摊开）
///    ⇒ 读数就是"树里一个被点亮的输入框都没有"。
bool _focused(WidgetTester tester) {
  // ⚠️ 读 `EditableText` 那一层：`TextField.focusNode` 只在**外面给了**才非空，
  //    没给的时候它是 null ⇒ 拿它当判据永远读到 `false`（那就是一条假判据）。
  final f = find.byType(EditableText);
  if (f.evaluate().isEmpty) return false;
  return tester.widget<EditableText>(f.first).focusNode.hasFocus;
}

void main() {
  setUp(() => hs.nativeHearingApi = _FakeNative());
  tearDown(() => hs.clearNativeHearing());

  testWidgets('① 收起档：按圆圈 ⇒ 说一句 ⇒ **字进底下那一行**', (tester) async {
    final r = _make();
    await _pump(tester, r.c);
    await tester.tap(find.byKey(voiceBarCircleKey));
    await tester.pumpAndSettle();
    expect(r.starts, 1, reason: '★ 按一下要真的交出去（而不是只画个样子）');
    expect(r.c.voiceRecording, true, reason: '★ 按下去就该在听');
    await _say(tester, r, words: '今天天气怎么样');
  });

  testWidgets('③ 🔴 停下语音**不许唤醒键盘**（那颗圆圈不碰焦点）', (tester) async {
    // 主人 2026-10-01：*"当我停下语音，键盘却被唤醒了。我认为停止语音，就是语音结束，
    // 不需要唤醒键盘。"*
    // ⚠️ 2026-10-07 推倒重来之后：那一格**就是一个真输入框**（字长在里面）
    //    ⇒ "键盘会不会被顶上来"量的仍然是**有没有输入框在抢焦点**
    //      （框在 ≠ 焦点在：它不 autofocus，按停也不去点它）。
    final r = _make();
    await _pump(tester, r.c);
    expect(_focused(tester), false, reason: '一开始键盘就该是收着的');

    await tester.tap(find.byKey(voiceBarCircleKey));
    await tester.pumpAndSettle();
    expect(_focused(tester), false, reason: '开麦也不该把键盘顶上来');

    // 说半句（还在听），然后**按第二下停手**
    r.feeds.last({'type': 'asr/ready'});
    r.feeds.last({'type': 'asr/partial', 'text': '今天天气', 'index': 0});
    await tester.pump();
    expect(_focused(tester), false, reason: '听着的时候更不该抢焦点');

    // 正在录时那颗圆圈画的是"停"（不是话筒图形）⇒ 还是点同一个 key
    await tester.tap(find.byKey(voiceBarCircleKey));
    await tester.pumpAndSettle();
    expect(_focused(tester), false, reason: '★ 按停那一下**不许**唤醒键盘');
    expect(_focused(tester), false, reason: '★ 按停那一下不许把光标放进那个框里');

    // 最后那句回来 ⇒ 字留着、键盘**还是收着**
    r.feeds.last({'type': 'asr/final', 'text': '今天天气怎么样', 'index': 0});
    await tester.pump();
    expect(_barText(tester), contains('今天天气怎么样'), reason: '字还是要落到那一行里');
    expect(_focused(tester), false, reason: '★ 收尾那一下也不许唤醒键盘');

    r.feeds.last({'type': 'asr/end', 'text': '今天天气怎么样', 'index': 0, 'reason': 'user-stop'});
    await tester.pumpAndSettle();
    expect(_focused(tester), false, reason: '★ 整场走完，键盘也不许被顶上来');
  });

  testWidgets('② 全开档：先展开再按圆圈 ⇒ 一样要进那一行', (tester) async {
    final r = _make();
    _feed(r.c, 3); // ⚠️ 空时间线时抓手点了不展（真应用里也总是有东西）
    await _pump(tester, r.c);
    // 像用户那样展开（点抓手）—— 真应用就是从收起档开始的
    await tester.tap(find.byKey(chatHandleKey));
    await tester.pumpAndSettle();
    expect(find.byType(ListView), findsWidgets, reason: '★ 抓手那一下没把浮窗展开');
    await tester.tap(find.byKey(voiceBarCircleKey));
    await tester.pumpAndSettle();
    expect(r.starts, 1);
    await _say(tester, r, words: '明天去哪里吃饭');
  });
}
