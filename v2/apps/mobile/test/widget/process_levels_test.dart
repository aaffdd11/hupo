// 过程四档**到底有没有画到屏幕上**（提示档，和 `busy_line_test.dart` 同一类）。
//
// ⚠️ 为什么非写不可：`test/unit` 能证明模型产出得对（`process_steps_test.dart`），
//    但契约 §三 那两条（乱序保护 / 收口即清）**是"屏幕上看得见吗"的事**——
//    S2 那类缺陷（链子断在中间、屏幕上看不出来）只有把屏幕搭起来才能证伪。
//
// ⚠️ 它属于 `test/widget`（手册：**提示档，不是闸**）。
//    硬闸那一半（五档不溢出 / 命中区 ≥44）在 `accessibility_test.dart` 里。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/process_levels.dart';
import 'package:hupo_app/models/process_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/bubbles.dart';
import 'package:shared_preferences/shared_preferences.dart';

ChatController _controller() =>
    ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore());

Future<ChatController> _pump(WidgetTester tester, ProcessLevel level) async {
  final c = _controller();
  // 换档是本地设置 + 重连（这里没有流 ⇒ 只改档）
  await c.setLevel(level);
  await tester.pumpWidget(MaterialApp(home: ChatScreen(controller: c, onLoggedOut: () {})));
  return c;
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('★ 默认档（在做什么）：还是一句话，行为没变', (tester) async {
    final c = await _pump(tester, ProcessLevel.doing);
    c.ingest({'type': 'message/status', 'turn': 1, 'state': 'started'});
    await tester.pump();
    expect(find.text(busyFallback), findsOneWidget);
  });

  testWidgets('★ 步骤流水：一条条步骤真的在屏幕上', (tester) async {
    final c = await _pump(tester, ProcessLevel.steps);
    c.ingest({'type': 'message/status', 'turn': 1, 'state': 'started'});
    c.ingest({'type': 'step/start', 'turn': 1, 'step': 1, 'state': 'searching'});
    c.ingest({'type': 'step/start', 'turn': 1, 'step': 2, 'state': 'writing'});
    await tester.pump();

    expect(find.text('在查资料'), findsOneWidget);
    expect(find.text('在写'), findsOneWidget);
    // 内部状态名一个都不许上屏
    expect(find.textContaining('searching'), findsNothing);
    expect(find.textContaining('writing'), findsNothing);
  });

  testWidgets('★ 步骤流水：第一件活还没开之前，那行「它正在做…」补上空白', (tester) async {
    final c = await _pump(tester, ProcessLevel.steps);
    c.ingest({'type': 'message/status', 'turn': 1, 'state': 'started'});
    await tester.pump();
    expect(find.text(busyFallback), findsOneWidget);

    c.ingest({'type': 'step/start', 'turn': 1, 'step': 1, 'state': 'searching'});
    await tester.pump();
    expect(find.text(busyFallback), findsNothing, reason: '有步骤了，那句就该让位');
    expect(find.text('在查资料'), findsOneWidget);
  });

  testWidgets('🔴 步骤流水：收口之后必须消失（不许留成"永远在查资料"）', (tester) async {
    final c = await _pump(tester, ProcessLevel.steps);
    c.ingest({'type': 'message/status', 'turn': 1, 'state': 'started'});
    c.ingest({'type': 'step/start', 'turn': 1, 'step': 1, 'state': 'searching'});
    c.ingest({'type': 'message/start', 'messageId': 'm1', 'seq': 1});
    c.ingest({'type': 'message/end', 'messageId': 'm1', 'seq': 2, 'reason': 'timeout'});
    await tester.pump();
    expect(find.text('在查资料'), findsNothing);
  });

  testWidgets('🔴 步骤流水：迟到的旧轮步骤不许冒出来（H4）', (tester) async {
    final c = await _pump(tester, ProcessLevel.steps);
    c.ingest({'type': 'message/status', 'turn': 3, 'state': 'started'});
    c.ingest({'type': 'message/end', 'messageId': 'm3', 'seq': 1, 'reason': 'completed'});
    // 第 2 轮的步骤迟到
    c.ingest({'type': 'step/start', 'turn': 2, 'step': 1, 'state': 'searching'});
    await tester.pump();
    expect(find.text('在查资料'), findsNothing);
  });

  testWidgets('★ 推理原文：正文和标题都在屏幕上，而且**不在气泡里**', (tester) async {
    final c = await _pump(tester, ProcessLevel.reasoning);
    c.ingest({'type': 'reasoning/delta', 'turn': 1, 'text': '先看看他问的是哪一周'});
    await tester.pump();

    expect(find.text(reasoningLabel), findsOneWidget);
    expect(find.text('先看看他问的是哪一周'), findsOneWidget);
    // ★ 视觉上必须和"它说的话"分得开：它是**另一种容器**，不是回答气泡。
    expect(
      find.ancestor(of: find.text('先看看他问的是哪一周'), matching: find.byType(AnswerBubble)),
      findsNothing,
      reason: '推理原文被塞进了"它说的话"那个气泡里 —— D7.4 要求两者分得开',
    );
  });

  testWidgets('🔴 安静档：**什么都不显示**（连「它正在做…」也没有）', (tester) async {
    final c = await _pump(tester, ProcessLevel.quiet);
    c.ingest({'type': 'message/status', 'turn': 1, 'state': 'started'});
    c.ingest({'type': 'step/start', 'turn': 1, 'step': 1, 'state': 'searching'});
    c.ingest({'type': 'reasoning/delta', 'turn': 1, 'text': '心里想的'});
    c.ingest({'type': 'message/start', 'messageId': 'm1', 'seq': 1});
    await tester.pump();

    expect(find.text(busyFallback), findsNothing);
    expect(find.text('在查资料'), findsNothing);
    expect(find.text(reasoningLabel), findsNothing);
    expect(find.text('心里想的'), findsNothing);
    // 它说的话照常要在（安静档只是"不说过程"，不是"不说话"）
    c.ingest({'type': 'message/text', 'messageId': 'm1', 'block': 'quick', 'text': '晴天', 'seq': 2});
    await tester.pump();
    expect(find.text('晴天'), findsOneWidget);
  });

  testWidgets('★ 从"步骤流水"切回"在做什么" ⇒ 那串步骤立刻下屏', (tester) async {
    final c = await _pump(tester, ProcessLevel.steps);
    c.ingest({'type': 'message/status', 'turn': 1, 'state': 'started'});
    c.ingest({'type': 'step/start', 'turn': 1, 'step': 1, 'state': 'searching'});
    await tester.pump();
    expect(find.text('在查资料'), findsOneWidget);

    await c.setLevel(ProcessLevel.doing);
    await tester.pump();
    expect(find.text('在查资料'), findsNothing, reason: '换档之后旧的步骤不许还挂在屏幕上');
    expect(find.text(busyFallback), findsOneWidget, reason: '"在做什么"那一档要有一句话');
  });
}
