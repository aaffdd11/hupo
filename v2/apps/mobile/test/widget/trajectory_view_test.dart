// **轨迹那一屏真的画到屏幕上了没有**（契约 `docs/dev/118-TRAJECTORY-VIEW.md`）。
//
// ⚠️ 这是**提示档**（`AGENTS.md` §5.1：`test/widget` 只有可访问性那一份是硬闸），
//    但它不是可有可无的：它是"这件事到底有没有画到屏幕上"的**唯一自动化证据**。
//    纯逻辑在 `test/unit/trajectory_test.dart` / `chat_view_test.dart`。
//
// 这一份钉五件：
//   ① 两个 tab 真的在标题行上、点了真的换（而且点当前那一档不会出事）；
//   ② 一个 tab 里的记录**真的摊成一行行**（类别词 / 摘要 / 轮号 / 合计都在）；
//   ③ **空会话**只给一句实话（不编行）；
//   ④ 🔴 **切回聊天时滚动位置一点都没动**（这是"切过去看一眼再切回来"的命门）；
//   ⑤ 点一行 ⇒ 滚到聊天里那一条并切回去；**没有那一格时如实说**，不乱滚。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/chat_view.dart';
import 'package:hupo_app/models/tool_row.dart';
import 'package:hupo_app/models/tool_row_words.dart';
import 'package:hupo_app/models/trajectory.dart';
import 'package:hupo_app/models/trajectory_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/widgets/chat_tabs.dart';
import 'package:hupo_app/widgets/tool_row_view.dart';
import 'package:hupo_app/widgets/trajectory_view.dart';
import 'package:shared_preferences/shared_preferences.dart';

ChatController _controller() {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  return ChatController(
    api: Api(base: 'http://127.0.0.1:1', client: MockClient((_) async => http.Response('{}', 200))),
    tokens: TokenStore(),
    token: 'tok',
  );
}

/// 一轮：用户那句话 ＋ 一次工具调用 ＋ 系统提示词 ＋ 这一轮的用量。
ChatController _oneTurn() {
  final c = _controller();
  c.ingest({'type': 'message/status', 'turn': 1, 'state': 'started'});
  c.ingest({
    'type': 'user/echo',
    'seq': 1,
    'messageId': 'u_1',
    'text': '帮我把这周工时记一下',
    'at': 1758400000000,
  });
  c.ingest({
    'type': 'tool/call',
    'seq': 2,
    'turn': 1,
    'step': 1,
    'callId': 'c_1',
    'name': 'bash',
    'title': '跑一下测试',
    'at': 1758400001000,
  });
  c.ingest({
    'type': 'system/prompt',
    'seq': 3,
    'turn': 1,
    'step': 1,
    'text': '你是琥珀。\n后面还有很多',
    'bytes': 25,
    'at': 1758400002000,
  });
  c.ingest({
    'type': 'turn/usage',
    'seq': 4,
    'turn': 1,
    'usage': {'input': 800, 'output': 434},
    'complete': true,
    'at': 1758400003000,
  });
  return c;
}

Future<void> _pump(WidgetTester tester, ChatController c) async {
  await tester.pumpWidget(
    MaterialApp(home: ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {})),
  );
  await tester.pumpAndSettle();
}

Future<void> _openTrajectory(WidgetTester tester) async {
  await tester.tap(find.byKey(chatTabKey(ChatView.trajectory)));
  await tester.pumpAndSettle();
}

/// 聊天那一屏的滚动位置（键盘/手势都作用在它上面）。
double _chatOffset(WidgetTester tester) => tester
    .state<ScrollableState>(
      find.descendant(of: find.byKey(chatBodyKey), matching: find.byType(Scrollable)).first,
    )
    .position
    .pixels;

void main() {
  testWidgets('★ 标题行上两个 tab；点了真的换，切回来聊天那一屏还在', (tester) async {
    final c = _oneTurn();
    await _pump(tester, c);

    expect(find.text(ChatView.chat.tab), findsOneWidget);
    expect(find.text(ChatView.trajectory.tab), findsOneWidget);
    expect(find.byType(TrajectoryView), findsNothing, reason: '默认是聊天那一档');

    await _openTrajectory(tester);
    expect(find.byType(TrajectoryView), findsOneWidget);

    await tester.tap(find.byKey(chatTabKey(ChatView.chat)));
    await tester.pumpAndSettle();
    // 切回聊天 ⇒ 轨迹那一块被 `Offstage` 盖住（`find` 默认跳过它）
    expect(find.byType(TrajectoryView), findsNothing);
    expect(find.text('帮我把这周工时记一下'), findsOneWidget, reason: '聊天那一屏得回来');
  });

  testWidgets('★ 一个 tab 里的记录真的摊成一行行（类别 / 摘要 / 轮号 / 合计）', (tester) async {
    final c = _oneTurn();
    await _pump(tester, c);
    await _openTrajectory(tester);

    // 合计抬头
    expect(find.text(trajectoryTotalsHead), findsOneWidget);
    expect(find.text(trajectoryTurnsCount(1)), findsOneWidget);
    // 分组头：轮号 ＋ `116` 那个计数（一条工具调用）
    expect(find.text(trajectoryTurnHead(1)), findsOneWidget);
    expect(
      find.text(dshTurnProcessLabel(const TurnProcess(toolCalls: 1, messages: 0, subagents: 0), turnProcessChatWords)),
      findsOneWidget,
    );
    // 五类里的四类都在（用户 / 工具 / 系统提示词 / 用量）
    expect(find.text(trajectoryKindWord(TrajectoryKind.user)), findsOneWidget);
    expect(find.text(trajectoryKindWord(TrajectoryKind.tool)), findsOneWidget);
    expect(find.text(trajectoryKindWord(TrajectoryKind.systemPrompt)), findsOneWidget);
    expect(find.text(trajectoryKindWord(TrajectoryKind.usage)), findsOneWidget);
    // 摘要：工具行是「名字 · 人话标题」；消息是正文第一行
    expect(find.text('bash · 跑一下测试'), findsOneWidget);
    expect(find.text('帮我把这周工时记一下'), findsOneWidget);
    expect(find.text('你是琥珀。'), findsOneWidget);
    // 用量：那一行有数（合计那一行也有），但**一个百分比都没有**
    expect(find.textContaining(turnUsageUnit), findsWidgets);
    expect(find.textContaining('%'), findsNothing);
    // 时刻用的是服务端给的 `at`（设备本地时区 —— 这里只钉"有那一格"）
    expect(find.text(trajectoryClock(DateTime.fromMillisecondsSinceEpoch(1758400000000).toLocal())), findsWidgets);
  });

  testWidgets('★ 空会话 ⇒ 一句实话（不编行）', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    await _openTrajectory(tester);
    expect(find.text(trajectoryEmptyLine), findsOneWidget);
    // 反例：一条记录都没有的时候**不许**出现合计/轮号那些行
    expect(find.text(trajectoryTotalsHead), findsNothing);
    expect(find.text(trajectoryTurnHead(1)), findsNothing);
  });

  testWidgets('🔴 切回聊天：**滚动位置一点都没动**', (tester) async {
    final c = _controller();
    for (var i = 1; i <= 30; i += 1) {
      c.ingest({
        'type': 'user/echo',
        'seq': i,
        'messageId': 'u_$i',
        'text': '第 $i 句',
        'at': 1758400000000 + i,
      });
    }
    await _pump(tester, c);

    // 往上翻一段（用户自己翻走）
    await tester.drag(find.byType(ListView).first, const Offset(0, 600));
    await tester.pumpAndSettle();
    final before = _chatOffset(tester);
    expect(before, greaterThan(0), reason: '没翻上去 ⇒ 这条判据量不到东西');

    await _openTrajectory(tester);
    await tester.tap(find.byKey(chatTabKey(ChatView.chat)));
    await tester.pumpAndSettle();

    expect(_chatOffset(tester), before, reason: '切回来之后聊天那一屏跳位置了');
  });

  testWidgets('★ 点一行 ⇒ 回到聊天并滚到那一条（被折起来的那一轮先展开）', (tester) async {
    final c = _oneTurn();
    await _pump(tester, c);
    // 这一轮收口 ⇒ 聊天里那几行被折成一个控件（轨迹里那一行因此要"先展开"）
    c.ingest({'type': 'message/end', 'seq': 5, 'messageId': 'm_x', 'reason': 'completed'});
    await tester.pumpAndSettle();
    expect(find.byType(ToolRowView), findsNothing, reason: '收口之后聊天里应该折起来了');

    await _openTrajectory(tester);
    await tester.tap(find.text('bash · 跑一下测试'));
    await tester.pumpAndSettle();

    // 回到聊天，而且那一行**被展开、看得见**
    expect(find.byType(TrajectoryView), findsNothing);
    expect(find.byType(ToolRowView), findsOneWidget, reason: '跳过去要先展开那一轮');
  });

  testWidgets('🔴 聊天里没有那一格 ⇒ **如实说**，不乱滚（也不切视图）', (tester) async {
    final c = _controller();
    // 同一轮两条 `turn/usage`：聊天只画**最后**那一条（`_planSlots` 的规矩）
    c.ingest({
      'type': 'turn/usage',
      'seq': 1,
      'turn': 1,
      'usage': {'input': 10, 'output': 5},
      'complete': true,
    });
    c.ingest({
      'type': 'turn/usage',
      'seq': 2,
      'turn': 1,
      'usage': {'input': 20, 'output': 5},
      'complete': true,
    });
    await _pump(tester, c);
    await _openTrajectory(tester);

    // 前一条（seq 1）在聊天里没有单独的一格
    await tester.tap(find.byKey(const ValueKey('trajectory-row-1-0')));
    await tester.pumpAndSettle();

    expect(find.text(trajectoryJumpUnavailableLine), findsOneWidget);
    expect(find.byType(TrajectoryView), findsOneWidget, reason: '过不去就该留在原地');
  });
}
