// `116` 那四行**画到屏幕上没有**（主人 2026-09-26：*"首先全部开放"*）。
//
// ⚠️ 这是**提示档**（`AGENTS.md` §5.1：`test/widget` 只有可访问性那一份是硬闸），
//    但它不是可有可无的：它是"这件事到底有没有画到屏幕上"的**唯一自动化证据**。
//    纯逻辑在 `test/unit/tool_row_plumbing_test.dart` / `tool_row_words_test.dart`。
//
// 这一份钉四件：
//   ① 展开真的看得见入参 / 输出 / "已截断"那句（收回时那两块**不在树里**）；
//   ② 一轮收口 ⇒ 折成一个控件（**真的少画**，不是画出来再藏）；点开又回来；
//   ③ 用量那一行**折得出才画**（`usage:null, complete:false` ⇒ 一个像素都不占）；
//   ④ 🔴 **自动折叠绝不吃掉键盘焦点**：焦点还在那一行上时，收口**不许**把它收走
//      （DSH `B-render.md` §2.3 那条硬规矩）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/tool_row.dart';
import 'package:hupo_app/models/tool_row_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/widgets/tool_row_view.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 一轮**还在跑**：一条工具调用（成了、而且被截过）。
ChatController _open() {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final c = ChatController(
    api: Api(base: 'http://127.0.0.1:1', client: MockClient((_) async => http.Response('{}', 200))),
    tokens: TokenStore(),
    token: 'tok',
  );
  c.ingest({'type': 'message/status', 'turn': 1, 'state': 'started'});
  c.ingest({
    'type': 'tool/call',
    'seq': 2,
    'turn': 1,
    'step': 1,
    'callId': 'c_1',
    'name': 'bash',
    'title': '跑一下测试',
    'args': '{\n  "command": "ls -la"\n}',
  });
  c.ingest({
    'type': 'tool/result',
    'seq': 3,
    'turn': 1,
    'step': 1,
    'callId': 'c_1',
    'ok': true,
    'excerpt': '<b>结果</b>\na.txt',
    'bytes': 1234,
    'truncated': true,
  });
  c.ingest({'type': 'message/start', 'seq': 4, 'messageId': 'm_1'});
  c.ingest({'type': 'message/text', 'seq': 5, 'messageId': 'm_1', 'block': 'quick', 'text': '这周 7 小时。'});
  return c;
}

Future<void> _pump(WidgetTester tester, ChatController c) async {
  await tester.pumpWidget(
    MaterialApp(home: ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {})),
  );
  await tester.pumpAndSettle();
}

String _foldLabel() => dshTurnProcessLabel(
  const TurnProcess(toolCalls: 1, messages: 0, subagents: 0),
  turnProcessChatWords,
);

void main() {
  testWidgets('★ 工具行：工具名 + 人话标题 + 状态；展开才看得见入参/输出/截断那句', (tester) async {
    final c = _open();
    await _pump(tester, c);
    expect(find.text('bash'), findsOneWidget);
    expect(find.text('跑一下测试'), findsOneWidget);
    expect(find.text(toolStatusWord(ToolStatus.ok)), findsOneWidget);

    // 收起时：正文**一个像素都不画**（不在树里）
    expect(find.text('{\n  "command": "ls -la"\n}'), findsNothing);
    expect(find.text(toolTruncatedLine(1234)), findsNothing);

    await tester.tap(find.byIcon(Icons.keyboard_arrow_right).first);
    await tester.pumpAndSettle();

    // 展开：入参**换行原样**、输出**纯文本**（`<b>` 不被当 HTML）、截断那句**如实说**
    expect(find.text('{\n  "command": "ls -la"\n}'), findsOneWidget);
    expect(find.text('<b>结果</b>\na.txt'), findsOneWidget);
    expect(find.text('… 已截断，共 1234 字节'), findsOneWidget);
  });

  testWidgets('★ 收口 ⇒ 折成一个控件（真的少画）；点开又回来', (tester) async {
    final c = _open();
    await _pump(tester, c);
    c.ingest({'type': 'message/end', 'seq': 6, 'messageId': 'm_1', 'reason': 'completed'});
    await tester.pumpAndSettle();

    // 折起来：那一行**不在树里**（少画 = 真省），控件那一句在
    expect(find.byType(ToolRowView), findsNothing, reason: '折起来就该真的不建那一行');
    expect(find.text(_foldLabel()), findsOneWidget);

    await tester.tap(find.text(_foldLabel()));
    await tester.pumpAndSettle();
    expect(find.text('bash'), findsOneWidget, reason: '点开之后那一行要回来');
  });

  testWidgets('🔴 自动折叠**不许吃掉键盘焦点**（焦点还在那一行上就不折）', (tester) async {
    final c = _open();
    await _pump(tester, c);

    // 把焦点放到工具行那个展开按钮上（键盘用户就是停在这儿的）
    final arrow = find.byIcon(Icons.keyboard_arrow_right).first;
    final node = Focus.maybeOf(tester.element(arrow));
    expect(node, isNotNull, reason: '那个按钮身上没挂 Focus ⇒ 这条判据不成立');
    node!.requestFocus();
    await tester.pump();
    expect(node.hasFocus, isTrue);

    // 这一轮收口 ⇒ 自动折叠那一刀必须**让开**
    c.ingest({'type': 'message/end', 'seq': 6, 'messageId': 'm_1', 'reason': 'completed'});
    await tester.pumpAndSettle();
    expect(
      find.text('bash'),
      findsOneWidget,
      reason: '焦点还在那一行上，收口却把它收走了 —— 键盘用户会当场失去焦点',
    );
    expect(find.text(_foldLabel()), findsNothing);
  });

  testWidgets('★ 配不上的结果：**只画结果那一行**（名字空着 —— 不编一个）', (tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final c = ChatController(
      api: Api(base: 'http://127.0.0.1:1', client: MockClient((_) async => http.Response('{}', 200))),
      tokens: TokenStore(),
      token: 'tok',
    );
    // `tool/call` 那条配不上（翻页 / 缓存裁剪）—— 结果这一半必须看得见（合同 `116` §一 规矩 4）
    c.ingest({
      'type': 'tool/result',
      'seq': 1,
      'turn': 1,
      'step': 1,
      'callId': 'c_x',
      'ok': false,
      'error': 'boom',
      'excerpt': '炸了',
      'bytes': 6,
    });
    await _pump(tester, c);
    expect(find.text(toolStatusWord(ToolStatus.error)), findsOneWidget);
    expect(find.text('炸了'), findsNothing, reason: '收起时不画正文');
    await tester.tap(find.byIcon(Icons.keyboard_arrow_right).first);
    await tester.pumpAndSettle();
    expect(find.text('炸了'), findsOneWidget);
  });

  testWidgets('负向对照：没有焦点 ⇒ 同样的收口**必须**折起来', (tester) async {
    // 这一条是上一条的对照：不然"焦点那条规矩"可能只是"根本没折"的同义反复。
    final c = _open();
    await _pump(tester, c);
    c.ingest({'type': 'message/end', 'seq': 6, 'messageId': 'm_1', 'reason': 'completed'});
    await tester.pumpAndSettle();
    expect(find.byType(ToolRowView), findsNothing);
    expect(find.text(_foldLabel()), findsOneWidget);
  });

  testWidgets('★ 用量那一行：折得出才画（没结清 ⇒ 一个像素都不占）', (tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final c = ChatController(
      api: Api(base: 'http://127.0.0.1:1', client: MockClient((_) async => http.Response('{}', 200))),
      tokens: TokenStore(),
      token: 'tok',
    );
    await _pump(tester, c);
    // 最早那一条：这一轮没报用量 ⇒ 一个像素都不许有
    c.ingest({'type': 'turn/usage', 'seq': 1, 'turn': 1, 'usage': null, 'complete': false});
    await tester.pumpAndSettle();
    expect(find.textContaining(turnUsageUnit), findsNothing, reason: '没报就不许画（连 0 都不许）');

    // 结清了 ⇒ 那一行出来（只有 token，没有钱/百分比）
    c.ingest({
      'type': 'turn/usage',
      'seq': 2,
      'turn': 2,
      'usage': {'input': 800, 'output': 434, 'cacheRead': 900},
      'complete': true,
    });
    await tester.pumpAndSettle();
    expect(find.textContaining(turnUsageUnit), findsOneWidget);
    expect(find.textContaining('%'), findsNothing);
  });
}
