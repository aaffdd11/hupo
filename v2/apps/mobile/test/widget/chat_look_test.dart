// ★ 2026-10-02：**聊天窗口重做之后长什么样**（契约 `docs/dev/154-CHAT-RECORD-LOOK.md`）。
//
// 它是"这件事到底有没有画到屏幕上"的**唯一自动化证据**（`AGENTS.md` §5.1：
// `test/widget` 里只有可访问性那一份是硬闸，其余是提示档 —— 但别当没看见）。
//
// 这一份钉四件（每一件都对着主人那句"重新设计一下"）：
//   ① **它的话有容器**（白底 ＋ 发丝描边 ＋ 零阴影）—— 改前它是裸文字；
//   ② ★ **时间那一行**：跨天才出现，同一天挨得近**不出现**（负向对照）；
//   ③ ★ **连着同样几句通知合成一行**（带次数），中间夹了别的**不合并**；
//   ④ ★ **用量那串 `tok` 默认不在屏幕上**（收在「过程」里），点开才有。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/chat_time_words.dart';
import 'package:hupo_app/models/notice_words.dart';
import 'package:hupo_app/models/tool_row_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/bubbles.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/widgets/notice.dart';
import 'package:hupo_app/widgets/time_mark.dart';
import 'package:shared_preferences/shared_preferences.dart';

ChatController _controller() {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final c = ChatController(
    api: Api(base: 'http://127.0.0.1:1', client: MockClient((_) async => http.Response('{}', 200))),
    tokens: TokenStore(),
    token: 'tok',
  );
  addTearDown(c.dispose);
  return c;
}

Future<void> _pump(WidgetTester tester, ChatController c) async {
  await tester.pumpWidget(MaterialApp(
    home: ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}),
  ));
  await tester.pump();
  c.ingest({'type': '__caught_up__'});
  await tester.pump();
}

Map<String, dynamic> _echo(String id, String text, int seq, int at) =>
    {'type': 'user/echo', 'messageId': id, 'text': text, 'seq': seq, 'at': at};

/// 一条**没有撤销**的持久通知（有撤销的一律不合并，判据在 `unit/notice_test.dart`）。
Map<String, dynamic> _notice(String text, int seq) => {
      'type': 'notice',
      'kind': 'resumed',
      'text': text,
      'seq': seq,
      'at': DateTime.now().millisecondsSinceEpoch,
    };

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  testWidgets('★ 它的话是一张卡：白底 ＋ 发丝描边 ＋ **零阴影**（改前是裸文字）', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    c.ingest({'type': 'message/start', 'seq': 1, 'messageId': 'm_1'});
    c.ingest({
      'type': 'message/text',
      'seq': 2,
      'messageId': 'm_1',
      'block': 'quick',
      'text': '我在机器上核过了。',
    });
    c.ingest({'type': 'message/end', 'seq': 3, 'messageId': 'm_1', 'reason': 'completed'});
    await tester.pumpAndSettle();

    expect(find.byType(AnswerBubble), findsOneWidget);
    final box = tester.widget<Material>(
      find.descendant(of: find.byType(AnswerBubble), matching: find.byType(Material)).first,
    );
    // 🔴 零阴影：平面卡片那条规矩（`design.dart`：平面用描边、浮起来才用阴影）
    expect(box.elevation, 0, reason: '卡上不许有阴影（它不是浮起来的东西）');
    final shape = box.shape;
    expect(shape, isA<RoundedRectangleBorder>(), reason: '卡要有圆角');
    final side = (shape! as RoundedRectangleBorder).side;
    // ★ 描边要真的画出来（白底压白底，不描边等于没有卡）
    expect(side.width > 0, isTrue, reason: '★ 没描边 ⇒ 白底压白底 = 又变回裸文字');
  });

  testWidgets('★ 时间那一行：跨天出现（今天 / 昨天），同一天挨得近**不出现**', (tester) async {
    final c = _controller();
    await _pump(tester, c);

    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day, 14, 32).millisecondsSinceEpoch;
    final todayEarlier =
        DateTime(now.year, now.month, now.day, 14, 27).millisecondsSinceEpoch;
    final yesterday =
        DateTime(now.year, now.month, now.day, 9, 5).subtract(const Duration(days: 1));
    // ⚠️ 那句话里**不许**出现「昨天」这两个字：这一条量的是**时间那一行**，
    //    文案里带同款字会让 `find.textContaining` 数到两个（第一版就这么栽的）。
    c.ingest(_echo('u_1', '更早说的那句', 10, yesterday.millisecondsSinceEpoch));
    c.ingest(_echo('u_2', '刚才那句', 11, todayEarlier));
    c.ingest(_echo('u_3', '现在这句', 12, today));
    await tester.pumpAndSettle();

    // 头一条（昨天）＋ 跨到今天那一条 ⇒ 两行；同一天那两条之间**不再插**
    expect(find.byType(TimeMarkLine), findsNWidgets(2), reason: '跨天要插、挨得近不插');
    expect(find.textContaining(timeMarkToday), findsOneWidget);
    expect(find.textContaining(timeMarkYesterday), findsOneWidget);
  });

  testWidgets('🔴 连着同样几句通知 ⇒ **合成一行带次数**；夹了别的 ⇒ 不合并', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    c.ingest(_notice('我去做，做完叫你。', 20));
    c.ingest(_notice('我去做，做完叫你。', 21));
    c.ingest(_notice('我去做，做完叫你。', 22));
    c.ingest(_notice('做完了。（就在这儿）', 23));
    c.ingest(_notice('我去做，做完叫你。', 24));
    await tester.pumpAndSettle();

    // 三段：三连 ⇒ 一行（次数 3）· 中间那句 ⇒ 自己一行 · 最后一句 ⇒ 又一行
    final lines = tester.widgetList<NoticeLine>(find.byType(NoticeLine)).toList();
    expect(lines.length, 3, reason: '连着同样的合成一行，夹了别的就断开');
    expect(lines[0].count, 3, reason: '★ 三连要合成一行');
    expect(lines[1].count, 1);
    expect(lines[2].count, 1);
    // 那句话**照抄服务端**（一个字节都不改），只多一个次数
    expect(lines[0].notice.text, '我去做，做完叫你。');
    expect(find.textContaining(noticeRepeatSuffix(3)), findsOneWidget);
  });

  testWidgets('★ 用量那串 tok **默认不在屏幕上**（收在「过程」里）；点开才有', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    // ⚠️ 先让"这一轮"被看见（收口时 `_closeTurn` 按"见过的最大轮号"收）
    c.ingest({'type': 'message/status', 'turn': 1, 'state': 'started'});
    c.ingest({
      'type': 'tool/call',
      'seq': 1,
      'turn': 1,
      'step': 1,
      'callId': 'c_1',
      'name': 'bash',
      'title': '跑一下测试',
    });
    c.ingest({
      'type': 'tool/result',
      'seq': 2,
      'turn': 1,
      'step': 1,
      'callId': 'c_1',
      'ok': true,
      'excerpt': 'ok',
      'bytes': 2,
    });
    c.ingest({
      'type': 'turn/usage',
      'seq': 3,
      'turn': 1,
      'usage': {'input': 800, 'output': 434, 'cacheRead': 900},
      'complete': true,
    });
    // 一轮收口 ⇒ 工具行与用量都进了「过程」，默认收起
    c.ingest({'type': 'message/end', 'seq': 4, 'messageId': 'm_1', 'reason': 'completed'});
    await tester.pumpAndSettle();

    expect(
      find.textContaining(turnUsageUnit),
      findsNothing,
      reason: '★ 默认屏幕上不许出现 token 那一串（它是过程，不是他说的话）',
    );
    // 点开「过程」⇒ 那一行回来（"看得见"那条路没断）
    await tester.tap(find.textContaining('次工具调用'));
    await tester.pumpAndSettle();
    expect(find.textContaining(turnUsageUnit), findsOneWidget, reason: '点开之后要看得见');
  });

  testWidgets('★ 只说了话的一轮：用量也收进「过程」（**给它一个控件，不许点不出来**）', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    c.ingest({'type': 'message/status', 'turn': 7, 'state': 'started'});
    c.ingest({'type': 'message/start', 'seq': 1, 'messageId': 'm_7'});
    c.ingest({
      'type': 'message/text',
      'seq': 2,
      'messageId': 'm_7',
      'block': 'quick',
      'text': '这一轮只说了话。',
    });
    c.ingest({
      'type': 'turn/usage',
      'seq': 3,
      'turn': 7,
      'usage': {'input': 12, 'output': 3},
      'complete': true,
    });
    c.ingest({'type': 'message/end', 'seq': 4, 'messageId': 'm_7', 'reason': 'completed'});
    await tester.pumpAndSettle();

    // 一个工具行都没有 ⇒ 控件那一行是那句兜底（零段的说法）
    expect(find.text(turnProcessFallback), findsOneWidget, reason: '★ 没有工具行也要给一个控件');
    expect(find.textContaining(turnUsageUnit), findsNothing, reason: '★ 收着的时候不许出现 tok');
    await tester.tap(find.text(turnProcessFallback));
    await tester.pumpAndSettle();
    expect(find.textContaining(turnUsageUnit), findsOneWidget, reason: '点开之后要看得见');
  });
}
