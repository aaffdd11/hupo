// 浮窗的验收：**它是一个贴底的浮窗，不是整屏**。
//
// 这条产品要求来自创始人原话：
//   「然后我需要聊天窗口变成一个浮窗，在底部显示。」
//
// 所以这里量的是：
//   1. **每次对话都最大化**（默认就是最大，用户开口/助手开口都回到最大）
//   2. **四边都留了边距** —— 铺满整屏就不叫浮窗了；加上阴影才有"浮起来"的观感
//   3. 它能收起/展开；收起时输入条还在、状态提示也还在（R6 不能被浮窗吃掉）

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/timeline.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/mock_transport.dart';

Widget _wrap(Widget child) => MaterialApp(
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF4A90D9),
          brightness: Brightness.dark,
        ),
      ),
      home: child,
    );

ChatController _controller() => ChatController(
      transport: MockTransport(scenario: MockScenario.normal, speed: 1000),
      conversationId: 'c_test',
    )..connect();

void main() {
  testWidgets('默认就是最大化，但四边都留着边距（看得出是浮窗）', (tester) async {
    final controller = _controller();
    addTearDown(controller.dispose);

    await tester.pumpWidget(_wrap(ChatScreen(controller: controller)));
    await tester.pump();

    final panel = find.byKey(const Key('floating-panel'));
    expect(panel, findsOneWidget, reason: '聊天应该是一个独立可测的浮窗');

    final rect = tester.getRect(panel);
    final screen = tester.getSize(find.byType(Scaffold));

    // ── 最大化：占了绝大部分高度 ──
    expect(rect.height, greaterThan(screen.height * 0.8),
        reason: '每次对话浮窗都是最大化的');

    // ── 但它仍然是浮窗：四边都有边缘 ──
    expect(rect.left, greaterThan(0), reason: '左边要留边距 —— 这就是"边缘"');
    expect(screen.width - rect.right, greaterThan(0), reason: '右边要留边距');
    expect(screen.height - rect.bottom, greaterThan(0), reason: '下边要留边距');
    expect(rect.top, greaterThan(0), reason: '上边也要留一条缝');
    // 左右边距对称
    expect(rect.left, closeTo(screen.width - rect.right, 0.5));
  });

  testWidgets('浮窗有阴影（"浮"起来靠的是它）', (tester) async {
    final controller = _controller();
    addTearDown(controller.dispose);

    await tester.pumpWidget(_wrap(ChatScreen(controller: controller)));
    await tester.pump();

    final panel = tester.widget<Container>(find.byKey(const Key('floating-panel')));
    final deco = panel.decoration! as BoxDecoration;
    expect(deco.boxShadow, isNotNull);
    expect(deco.boxShadow!.length, greaterThanOrEqualTo(2),
        reason: '一层散的 + 一层紧的，只有一层会像画上去的');
    expect(deco.borderRadius, isNotNull, reason: '四个角都要圆');
  });

  testWidgets('助手一开口也拉满（"每次对话"包括它先说）', (tester) async {
    final controller = _controller();
    addTearDown(controller.dispose);

    await tester.pumpWidget(_wrap(ChatScreen(controller: controller)));
    await tester.pump();
    final panel = find.byKey(const Key('floating-panel'));

    // 先手动拖到小档
    await tester.drag(find.byKey(const Key('panel-handle')), const Offset(0, 300));
    await tester.pumpAndSettle();
    final small = tester.getSize(panel).height;

    // 助手开始说话 ⇒ 拉满
    await controller.say('测试');
    var grew = false;
    for (var i = 0; i < 80 && !grew; i++) {
      await tester.pump(const Duration(milliseconds: 50));
      grew = tester.getSize(panel).height > small;
    }
    expect(grew, isTrue, reason: '助手开口也要把浮窗拉满');

    for (var i = 0; i < 40; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
  });

  testWidgets('点标题行能收起、再点能展开；收起后明显变矮', (tester) async {
    final controller = _controller();
    addTearDown(controller.dispose);

    await tester.pumpWidget(_wrap(ChatScreen(controller: controller)));
    await tester.pump();
    final panel = find.byKey(const Key('floating-panel'));
    final expandedH = tester.getSize(panel).height;

    await tester.tap(find.byIcon(Icons.expand_more));
    await tester.pumpAndSettle();
    final collapsedH = tester.getSize(panel).height;
    expect(collapsedH, lessThan(expandedH));
    // 收起时输入条**必须还在**，否则没法打字
    expect(find.byType(TextField), findsOneWidget);

    await tester.tap(find.byIcon(Icons.expand_less));
    await tester.pumpAndSettle();
    expect(tester.getSize(panel).height, closeTo(expandedH, 1));
  });

  testWidgets('拖抓手能改高度：往下拖变矮，往上拖变高', (tester) async {
    final controller = _controller();
    addTearDown(controller.dispose);

    await tester.pumpWidget(_wrap(ChatScreen(controller: controller)));
    await tester.pump();
    final panel = find.byKey(const Key('floating-panel'));
    final before = tester.getSize(panel).height;

    // 往下拖足够多 ⇒ 吸附到"收起"
    await tester.drag(find.byKey(const Key('panel-handle')), const Offset(0, 300));
    await tester.pumpAndSettle();
    final afterDown = tester.getSize(panel).height;
    expect(afterDown, lessThan(before));

    // 往上拖 ⇒ 变高
    await tester.drag(find.byKey(const Key('panel-handle')), const Offset(0, -250));
    await tester.pumpAndSettle();
    expect(tester.getSize(panel).height, greaterThan(afterDown));
  });

  testWidgets('用户一说话就拉满（不能打完看不见回答）', (tester) async {
    final controller = _controller();
    addTearDown(controller.dispose);

    await tester.pumpWidget(_wrap(ChatScreen(controller: controller)));
    await tester.pump();
    final panel = find.byKey(const Key('floating-panel'));

    await tester.tap(find.byIcon(Icons.expand_more));
    await tester.pumpAndSettle();
    final collapsedH = tester.getSize(panel).height;

    await tester.enterText(find.byType(TextField), '测试一下');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pump();

    expect(tester.getSize(panel).height, greaterThan(collapsedH),
        reason: '用户说了话就该能看见回答');

    // 让 mock 的定时器跑完，否则测试框架会报"还有 Timer 挂着"
    for (var i = 0; i < 40; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
  });

  testWidgets('收起时状态条不占输入条的位置，但"还有件事在处理"仍然看得见', (tester) async {
    final controller = _controller();
    addTearDown(controller.dispose);
    controller.activeTasks['t1'] = ActiveTask(
      taskId: 't1',
      title: '在查一件事',
      startedAt: DateTime(2026),
    );

    await tester.pumpWidget(_wrap(ChatScreen(controller: controller)));
    await tester.pump();
    await tester.tap(find.byIcon(Icons.expand_more));
    await tester.pumpAndSettle();

    // 收起时：不出现整条状态栏文案（那会挤掉输入条）
    expect(find.textContaining('还有件事在处理'), findsNothing);
    // 但标题行上有一个紧凑标记（R6：不能让用户以为忘了）
    expect(find.byIcon(Icons.schedule), findsOneWidget);
    expect(find.byType(TextField), findsOneWidget);
  });

  testWidgets('消息在浮窗里照常渲染（浮窗不是个空壳）', (tester) async {
    final controller = _controller();
    addTearDown(controller.dispose);

    await tester.pumpWidget(_wrap(ChatScreen(controller: controller)));
    await controller.say('测试');
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    expect(tester.takeException(), isNull);
    expect(find.text('测试'), findsWidgets);
  });
}
