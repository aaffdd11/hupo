// 长按气泡 ⇒ **复制 / 多选**（契约 `docs/dev/106-CHAT-SELECT.md` §三 判据 S1–S6）。
//
// ⚠️ 全部走**真入口**：泵 `ChatScreen` + 真长按 / 真点，
//    不直接把 `BubbleActionsBar` / `BubbleSelectBar` 当 `home` 泵出来 ——
//    那样量不到"接线到底对不对"（这一批最容易做歪的正是接线）。
// ⚠️ 剪贴板用**拦 `SystemChannels.platform` 的 `Clipboard.setData`** 来看那串字符
//    （`test/widget/paste_test.dart` 是同一套法子，只是那边看的是 `getData`）。
//
// ⚠️ 这一份是**提示档**（`test/widget` 的通用规矩），但它是"这两项到底有没有画到
//    屏幕上、按下去到底写没写剪贴板"的唯一自动化证据 ⇒ 别删。

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/message_state.dart';
import 'package:hupo_app/models/trash_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/bubble_menu.dart';
import 'package:hupo_app/widgets/bubble_select_bar.dart';
import 'package:hupo_app/widgets/bubbles.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _userText = '帮我把这周工时记一下';
const _answerText = '这周 7 小时。';
const _user2Text = '再记一笔：买咖啡 18 块';
const _answer2Text = '记好了，这周多了一笔 18 块。';
const _sourceTitle = '中国天气网 · 北京今天多云';
const _sourceUrl = 'https://www.weather.com.cn/bj';

/// 假回执。⚠️ 必须带 `charset=utf-8`（中文正文）。
http.Response _json(String body, [int status = 200]) => http.Response(
      body,
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

/// **剪贴板**：拦下 `Clipboard.setData`，把那串字符逐字记下来。
///
/// ⚠️ 判据要的是"**逐字**对"（S2），所以这里既不 trim 也不规范化 —— 原样收。
class _ClipboardSpy {
  String? text;
  int writes = 0;

  void install(WidgetTester tester) {
    tester.binding.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') {
        writes += 1;
        text = (call.arguments as Map)['text'] as String?;
      }
      return null;
    });
  }
}

/// 两轮对话（都带 `messageId` 和号 ⇒ 进得了时间线、也认得出"轮"）。
///
/// ⚠️ 第一条回答**带出处**：S2 要的就是"复制里不许混进出处"。
List<Map<String, dynamic>> _facts() => [
      {'type': 'user/echo', 'seq': 1, 'messageId': 'u_1', 'text': _userText},
      {'type': 'message/start', 'seq': 2, 'messageId': 'm_1'},
      {'type': 'message/text', 'seq': 3, 'messageId': 'm_1', 'block': 'quick', 'text': _answerText},
      {
        'type': 'message/end',
        'seq': 4,
        'messageId': 'm_1',
        'reason': 'completed',
        'sources': [
          {'title': _sourceTitle, 'url': _sourceUrl},
        ],
      },
      {'type': 'user/echo', 'seq': 5, 'messageId': 'u_2', 'text': _user2Text},
      {'type': 'message/start', 'seq': 6, 'messageId': 'm_2'},
      {'type': 'message/text', 'seq': 7, 'messageId': 'm_2', 'block': 'quick', 'text': _answer2Text},
      {'type': 'message/end', 'seq': 8, 'messageId': 'm_2', 'reason': 'completed'},
    ];

ChatController _controller({MockClient? client}) {
  final c = ChatController(
    api: Api(client: client ?? MockClient((r) async => _json('{}'))),
    tokens: TokenStore(),
    token: 'tok',
  );
  addTearDown(c.dispose);
  return c;
}

/// 一个**真实手机那么大**的屏（默认的 800×600 是个横屏平板尺寸：
/// 两轮对话 + 出处就装不下，第一轮会被滚到视口外 ⇒ "点空了"而断言照样绿）。
void _phone(WidgetTester tester) {
  tester.view.physicalSize = const Size(500, 1000);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Future<void> _pumpChat(WidgetTester tester, ChatController c) async {
  _phone(tester);
  for (final e in _facts()) {
    c.ingest(e);
  }
  await tester.pumpWidget(MaterialApp(
    home: ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}),
  ));
  await tester.pump();
}

/// 真长按某条气泡（按**屏幕上那句话**找它）。
///
/// ⚠️ 先 `ensureVisible`：时间线是**懒加载 + 会滚**的，字小的屏上那一条可能
///    已经在视口外（还在树里）—— 直接点会落到底下的东西上，
///    而"点空了"照样能让下一条断言绿（那是"闸变弱了"的形状）。
Future<void> _longPress(WidgetTester tester, String text) async {
  final f = find.text(text);
  await tester.ensureVisible(f);
  await tester.pumpAndSettle();
  await tester.longPress(f);
  await tester.pumpAndSettle();
}

/// 真点一下某条气泡（多选态里那一下 = 选中 / 取消）。
Future<void> _tapBubble(WidgetTester tester, String text) async {
  final f = find.text(text);
  await tester.ensureVisible(f);
  await tester.pumpAndSettle();
  await tester.tap(f);
  await tester.pumpAndSettle();
}

/// 长按 → 菜单 → 【多选】。
Future<void> _enterSelect(WidgetTester tester, {String on = _answerText}) async {
  await _longPress(tester, on);
  await tester.tap(find.text(bubbleMenuSelect));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });

  // ── S1 ────────────────────────────────────────────────────

  testWidgets('S1：长按他说的 / 它回的 ⇒ 菜单里都有【复制】【多选】（原来的删掉也在）', (tester) async {
    final c = _controller();
    await _pumpChat(tester, c);

    for (final text in [_userText, _answerText]) {
      await _longPress(tester, text);
      expect(find.text(bubbleMenuCopy), findsOneWidget, reason: '长按「$text」没有【复制】');
      expect(find.text(bubbleMenuSelect), findsOneWidget, reason: '长按「$text」没有【多选】');
      // ⚠️ 负向对照：原有的那条路**必须还在**（这一批不许把它顶掉）
      expect(find.text(bubbleMenuDelete), findsOneWidget,
          reason: '长按「$text」少了原有的"先放进回收站"');
      await tester.tap(find.text(bubbleMenuCancel));
      await tester.pumpAndSettle();
    }
  });

  // ── S2 ────────────────────────────────────────────────────

  testWidgets('S2：点【复制】⇒ 剪贴板里**逐字**就是那一条正文（不带出处）', (tester) async {
    final clip = _ClipboardSpy()..install(tester);
    final c = _controller();
    await _pumpChat(tester, c);

    await _longPress(tester, _answerText);
    await tester.tap(find.text(bubbleMenuCopy));
    await tester.pumpAndSettle();

    expect(clip.text, _answerText, reason: '★ 剪贴板必须是那一条正文**逐字**（不许带出处 / 时间 / 标签）');
    expect(clip.writes, 1, reason: '★ 只许写一次');
    expect(clip.text!.contains(_sourceTitle), isFalse, reason: '★ 出处那个名字混进来了');
    expect(clip.text!.contains('http'), isFalse, reason: '★ 出处地址混进来了');
    expect(find.text(bubbleCopiedLine), findsOneWidget, reason: '成没成都要如实说一句');
    expect(find.text(bubbleMenuSelect), findsNothing, reason: '菜单要关掉');
  });

  testWidgets('S2：他说的那条 ⇒ 复制的是他那一句话逐字（不带"已收到"那行状态）', (tester) async {
    final clip = _ClipboardSpy()..install(tester);
    final c = _controller();
    await _pumpChat(tester, c);

    await _longPress(tester, _userText);
    await tester.tap(find.text(bubbleMenuCopy));
    await tester.pumpAndSettle();

    expect(clip.text, _userText, reason: '★ 他说的那句话逐字，别的什么都不许带');
    expect(find.text(bubbleCopiedLine), findsOneWidget);
  });

  // ── S3 ────────────────────────────────────────────────────

  testWidgets('S3：【多选】进态（工具条出来 · 0 条）⇒ 点两条 = 2 ⇒ 再点一下 = 1', (tester) async {
    final c = _controller();
    await _pumpChat(tester, c);

    await _enterSelect(tester);
    expect(find.byType(BubbleSelectBar), findsOneWidget, reason: '★ 工具条要出来');
    expect(find.text(bubbleSelectCount(0)), findsOneWidget,
        reason: '★ 进多选态**不预选**长按的那一条（预选的话"点两条"就成了 3）');

    await _tapBubble(tester, _userText);
    expect(find.text(bubbleSelectCount(1)), findsOneWidget);
    expect(find.byIcon(Icons.check_circle), findsOneWidget, reason: '★ 选中要看得出来（勾）');

    await _tapBubble(tester, _answerText);
    expect(find.text(bubbleSelectCount(2)), findsOneWidget);

    // 负向对照：再点一下 ⇒ 变回 1（"点了没反应"或"只加不减"都会当场红）
    await _tapBubble(tester, _answerText);
    expect(find.text(bubbleSelectCount(1)), findsOneWidget, reason: '★ 再点一下要**取消**选中');
  });

  // ── S4 ────────────────────────────────────────────────────

  testWidgets('S4：多选【复制】⇒ 按时间顺序、一条一行；然后退出多选态 ＋ 如实说一句', (tester) async {
    final clip = _ClipboardSpy()..install(tester);
    final c = _controller();
    await _pumpChat(tester, c);

    await _enterSelect(tester);
    // ⚠️ **故意倒着点**：先点第二条那一轮、再点第一条 ——
    //    剪贴板仍须按**时间顺序**（拿"点选顺序"当顺序就会当场红）。
    await _tapBubble(tester, _answer2Text);
    await _tapBubble(tester, _userText);
    expect(find.text(bubbleSelectCount(2)), findsOneWidget);

    await tester.tap(find.text(bubbleMenuCopy)); // ← 工具条上那个【复制】
    await tester.pumpAndSettle();

    expect(clip.text, '$_userText\n$_answer2Text', reason: '★ 按时间顺序、**一条一行**');
    expect(clip.writes, 1);
    expect(find.byType(BubbleSelectBar), findsNothing, reason: '★ 复制完必须**退出**多选态');
    expect(find.text(bubbleSelectCount(2)), findsNothing);
    expect(find.byIcon(Icons.check_circle), findsNothing, reason: '退出之后不许留着勾');
    expect(find.text(bubbleCopiedManyLine(2)), findsOneWidget, reason: '要如实说复制了几条');
  });

  // ── S5 ────────────────────────────────────────────────────

  testWidgets('S5：多选【取消】⇒ 退出多选态，而且**剪贴板没被碰过**', (tester) async {
    final clip = _ClipboardSpy()..install(tester);
    final c = _controller();
    await _pumpChat(tester, c);

    await _enterSelect(tester);
    await _tapBubble(tester, _userText);
    await _tapBubble(tester, _answerText);
    expect(find.text(bubbleSelectCount(2)), findsOneWidget);

    await tester.tap(find.text(bubbleSelectCancel));
    await tester.pumpAndSettle();

    expect(find.byType(BubbleSelectBar), findsNothing, reason: '取消要退出多选态');
    expect(clip.writes, 0, reason: '★ 取消也写剪贴板 = 反例当场红');
    expect(clip.text, isNull);
    expect(find.text(_userText), findsOneWidget, reason: '取消只退出，屏幕上别的一条都不许动');
    expect(find.text(_answerText), findsOneWidget);
  });

  // ── S6 ────────────────────────────────────────────────────

  testWidgets('S6：多选态下点气泡**只切换选中** —— 不重发 / 不弹长按菜单', (tester) async {
    final calls = <String>[];
    final c = _controller(client: MockClient((r) async {
      calls.add('${r.method} ${r.url.path}');
      return _json('{}');
    }));
    // 造一条**发失败了**的（平时它自己有"重发"入口）——
    // 多选态里按下去真发请求的话，这一条判据就会红。
    // ⚠️ 放在事实**之后**（它是本机那条，没被服务端认领）：这样它排在最后，
    //    屏幕上看得见 —— 不然"点了没反应"可能只是那一条在视口外面。
    for (final e in _facts()) {
      c.ingest(e);
    }
    c.timeline.addLocalUtterance('这句没发出去', 'u_f');
    c.timeline.setLocalState('u_f', MessageState.failed);
    _phone(tester);
    await tester.pumpWidget(MaterialApp(
      home: ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}),
    ));
    await tester.pump();
    expect(find.text('重发'), findsOneWidget, reason: '负向对照：平时它是有的（不然下面那条断言是空转）');

    await _enterSelect(tester);
    final before = calls.length;

    // ① 重发那个入口**不画**（画了就是"点一下顺手触发别的动作"）
    expect(find.text('重发'), findsNothing, reason: '★ 多选态里不许有重发入口');

    // ② 点那个失败的气泡 ⇒ 只切换选中
    await _tapBubble(tester, '这句没发出去');
    expect(find.text(bubbleSelectCount(1)), findsOneWidget, reason: '★ 点气泡 = 切换选中');

    // ③ 长按 ⇒ **不许再弹长按菜单**。
    //    ⚠️ 标准 Flutter 行为：只有 `onTap` 的时候，长按松手**仍算一次点按**
    //       ⇒ 这一按只把选中切回去 —— 那正是 S6 要的"**只**切换选中"。
    //       真弹了菜单 / 真发了请求，下面两条就会红。
    await _longPress(tester, '这句没发出去');
    expect(find.byType(BubbleActionsBar), findsNothing, reason: '★ 多选态下不许再弹出长按那一条');
    expect(find.text(bubbleMenuDelete), findsNothing);
    // ⚠️ 这里**不能**用 `find.text(bubbleMenuCopy)` 当证据：工具条上那个【复制】
    //    是同一句字 —— 菜单真弹了也可能"找不到它"，那是误判。
    expect(find.text(bubbleSelectCount(0)), findsOneWidget,
        reason: '长按松手算一次点按 ⇒ 只把选中切回去');
    await _longPress(tester, '这句没发出去');
    expect(find.text(bubbleSelectCount(1)), findsOneWidget, reason: '再一下切回来（始终只有"选中/取消"这一件事）');

    // ④ 一次请求都没发（重发真按下去会打 `/api/say`）
    final after = calls.skip(before).toList();
    expect(after.where((x) => x.contains('/api/say')).toList(), isEmpty,
        reason: '★ 多选态里一次重发都不许发出去；实际发了：$after');

    // ⑤ "打开链接"这一半：屏幕给气泡的回调必须是 `null`
    //    （⚠️ VM 里 `canOpenLinks` 是假、出处本来就不画按钮 ⇒ 这一条是**结构检查**，
    //       真手势那一下在测试环境里演不出来，见报告里"只能间接验"那一段）
    final bubble = tester.widget<AnswerBubble>(find.byType(AnswerBubble).first);
    expect(bubble.onOpenSource, isNull, reason: '★ 多选态里出处不许是可点的');
  });

  // ── 自己再想的两条反例（契约之外）────────────────────────────

  group('自己再想的两条反例', () {
    testWidgets('反例甲：他说的那条下面那行状态字（"已收到"）**不许**混进剪贴板', (tester) async {
      final clip = _ClipboardSpy()..install(tester);
      final c = _controller();
      await _pumpChat(tester, c);
      // 负向对照：那行字**确实在屏幕上**（不然"剪贴板里没有它"是句废话）
      expect(find.text('已收到'), findsWidgets);

      await _longPress(tester, _userText);
      await tester.tap(find.text(bubbleMenuCopy));
      await tester.pumpAndSettle();

      expect(clip.text, _userText, reason: '★ 复制的只有正文');
      expect(clip.text!.contains('已收到'), isFalse, reason: '★ 状态字混进来了');
      expect(clip.text!.contains('已交出去'), isFalse);
    });

    testWidgets('反例乙：选中的几条**都没正文** ⇒ 说复制不了、剪贴板不碰、也不退出', (tester) async {
      final clip = _ClipboardSpy()..install(tester);
      final c = _controller();
      await _pumpChat(tester, c);
      // 一条"只有过程、还没有话"的回答（空正文）
      c.ingest({'type': 'user/echo', 'seq': 9, 'messageId': 'u_9', 'text': '在吗'});
      c.ingest({'type': 'message/start', 'seq': 10, 'messageId': 'm_9'});
      await tester.pump();

      await _enterSelect(tester);
      await _tapBubble(tester, '在处理…');
      expect(find.text(bubbleSelectCount(1)), findsOneWidget);

      await tester.tap(find.text(bubbleMenuCopy));
      await tester.pumpAndSettle();

      expect(clip.writes, 0, reason: '★ 一条正文都没有 ⇒ 剪贴板一个字节都不许写');
      expect(clip.text, isNull);
      expect(find.text(bubbleCopyEmptyLine), findsOneWidget, reason: '要如实说一句');
      expect(find.text(bubbleCopiedLine), findsNothing, reason: '★ 不许说"复制好了"');
      expect(find.byType(BubbleSelectBar), findsOneWidget,
          reason: '什么都没复制成 ⇒ 不算"做完"，还留在多选态让人接着挑');
    });
  });
}
