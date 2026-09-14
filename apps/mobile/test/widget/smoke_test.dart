// 渲染冒烟测试：把"能不能渲染"变成可自动检查的事。
//
// 这些测试抓过真 bug：Web 版一度整页空白，根因是
// ThemeData.brightness 与 ColorScheme.brightness 不一致导致启动即断言失败。
// 资源全部 200，所以从服务器侧完全看不出来 —— 只有渲染测试能拦住。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/main.dart';
import 'package:hupo_app/models/stream_event.dart';
import 'package:hupo_app/models/timeline.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/mock_transport.dart';
import 'package:hupo_app/widgets/answer_bubble.dart';

void main() {
  testWidgets('应用能启动并渲染出界面（不抛异常）', (tester) async {
    await tester.pumpWidget(const HupoApp());
    await tester.pump(const Duration(milliseconds: 100));

    expect(tester.takeException(), isNull, reason: '启动不应抛异常');
    expect(find.text('说点什么'), findsWidgets);
    // 开发期默认开启：页面上方应有后台活动卡片
    expect(find.text('开发者模式'), findsOneWidget);
  });

  testWidgets('产品界面上【没有】任何内部分类（简单/复杂/深度都不该出现）', (tester) async {
    await tester.pumpWidget(const HupoApp());
    await tester.pump(const Duration(milliseconds: 100));

    for (final leaked in ['简单问题', '复杂问题', '深答失败', '被动聆听', '主动开口', '已连接']) {
      expect(find.text(leaked), findsNothing,
          reason: '「$leaked」是内部概念，不该出现在产品界面上');
    }
  });

  // 逐个边界档单独测渲染：每例用极快倍速，避免残留定时器影响下一次
  // ⚠ 这些档位只是开发期回放，不是产品概念；测试用它们覆盖边界情况。
  for (final (label, scenario) in [
    ('正常', MockScenario.normal),
    ('很快', MockScenario.fastDeep),
    ('很慢', MockScenario.slowDeep),
    ('失败', MockScenario.deepFails),
    ('不出声', MockScenario.listening),
    ('主动', MockScenario.proactive),
    ('要很久', MockScenario.longTask),
  ]) {
    testWidgets('场景「$label」能渲染且不抛异常', (tester) async {
      final controller = ChatController(
        transport: MockTransport(scenario: scenario, speed: 100000),
        conversationId: 'c_test',
      )..connect();
      addTearDown(controller.dispose);

      await tester.pumpWidget(_wrap(ChatScreen(controller: controller)));
      await controller.say('测试');
      for (var i = 0; i < 8; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(tester.takeException(), isNull, reason: '档位「$label」不应抛异常');
    });
  }

  testWidgets('查到的来源显示在结论下面；没来源时一个字都不显示', (tester) async {
    final withSources = DispatcherMessage(messageId: 'm1', seq: 1, at: DateTime(2026));
    withSources.sources = const [
      Source(title: 'DeepSeek 发布 V4.1', url: 'https://www.36kr.com/a'),
      Source(title: '', url: 'https://example.com/b'),
    ];
    withSources.applyText(const MessageTextEvent(
        seq: 1, messageId: 'm1', block: TextBlock.deep, seqInBlock: 0, text: '9 月 10 日发布。', isFinal: true));

    await tester.pumpWidget(_wrap(AnswerBubble(message: withSources)));
    await tester.pump();

    expect(tester.takeException(), isNull);
    expect(find.text('来源'), findsOneWidget);
    expect(find.text('DeepSeek 发布 V4.1'), findsOneWidget);
    expect(find.text('example.com'), findsOneWidget); // 没标题就用域名

    // 没搜到来源：不出现"来源"字样（也就没有内部解释）
    final noSources = DispatcherMessage(messageId: 'm2', seq: 2, at: DateTime(2026));
    noSources.applyText(const MessageTextEvent(
        seq: 2, messageId: 'm2', block: TextBlock.deep, seqInBlock: 0, text: '先看日志。', isFinal: true));
    await tester.pumpWidget(_wrap(AnswerBubble(message: noSources)));
    await tester.pump();
    expect(find.text('来源'), findsNothing);
  });

  testWidgets('一条消息渲染成【单个】气泡（无缝衔接的验收）', (tester) async {
    final m = DispatcherMessage(messageId: 'm1', seq: 1, at: DateTime(2026));
    m.applyText(const MessageTextEvent(
        seq: 1, messageId: 'm1', block: TextBlock.quick, seqInBlock: 0, text: '先看连接池。', isFinal: true));
    m.applyText(const MessageTextEvent(
        seq: 2, messageId: 'm1', block: TextBlock.deep, seqInBlock: 0, text: '确认了，是连接池打满。', isFinal: true));

    await tester.pumpWidget(_wrap(AnswerBubble(message: m)));
    await tester.pump();

    expect(tester.takeException(), isNull);
    // 两块文字出现在**同一个**文本组件里，而不是两个气泡
    expect(find.text('先看连接池。确认了，是连接池打满。'), findsOneWidget);
    expect(find.byType(AnswerBubble), findsOneWidget);
  });

  testWidgets('被动聆听不产生消息气泡，但显示独立状态', (tester) async {
    final controller = ChatController(
      transport: MockTransport(scenario: MockScenario.listening, speed: 100),
      conversationId: 'c_test',
    )..connect();

    await tester.pumpWidget(_wrap(ChatScreen(controller: controller)));
    await controller.say('测试');
    await tester.pump(const Duration(milliseconds: 50));

    expect(tester.takeException(), isNull);
    expect(find.byType(AnswerBubble), findsNothing, reason: '不出声 ⇒ 不产生消息');
    expect(find.textContaining('正在听'), findsOneWidget, reason: '状态走独立区域');
  });

  testWidgets('主动开口：没有任何用户输入也会渲染消息（v1 的关键修正）', (tester) async {
    final controller = ChatController(
      transport: MockTransport(scenario: MockScenario.proactive, speed: 1000),
      conversationId: 'c_test',
    )..connect();

    await tester.pumpWidget(_wrap(ChatScreen(controller: controller)));
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 200));
    }

    expect(tester.takeException(), isNull);
    // 时间线上没有用户发言，但调度器消息必须出现
    expect(controller.timeline.whereType<UserUtterance>(), isEmpty);
    expect(controller.timeline.whereType<DispatcherMessage>().length, 1);
    expect(find.byType(AnswerBubble), findsOneWidget);
  });

  testWidgets('深答失败时界面给出合法收尾（不留白）', (tester) async {
    final controller = ChatController(
      transport: MockTransport(scenario: MockScenario.deepFails, speed: 1000),
      conversationId: 'c_test',
    )..connect();

    await tester.pumpWidget(_wrap(ChatScreen(controller: controller)));
    await controller.say('测试');
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 200));
    }

    expect(tester.takeException(), isNull);
    expect(find.byType(AnswerBubble), findsWidgets);
    expect(find.textContaining('这条没能给出结论'), findsWidgets);
  });

  testWidgets('要很久的事变成独立任务：先说"我拿去做了"，界面显示在处理', (tester) async {
    final controller = ChatController(
      transport: MockTransport(scenario: MockScenario.longTask, speed: 5),
      conversationId: 'c_test',
    )..connect();
    addTearDown(controller.dispose);

    await tester.pumpWidget(_wrap(ChatScreen(controller: controller)));
    await controller.say('帮我查一下昨天那个接口的问题');

    // 轮询直到出现"进行中的任务"（不依赖精确时刻）
    var sawTask = false;
    for (var i = 0; i < 60 && !sawTask; i++) {
      await tester.pump(const Duration(milliseconds: 20));
      if (controller.activeTasks.isNotEmpty) sawTask = true;
    }

    expect(tester.takeException(), isNull);
    expect(sawTask, isTrue, reason: '要很久的事应该变成独立任务并处于进行中');
    expect(find.textContaining('还有件事在处理'), findsOneWidget,
        reason: '用户必须知道还有件事没回来（R6）');

    // 把剩余回放走完，避免测试结束时留下未完成的定时器
    for (var i = 0; i < 300; i++) {
      await tester.pump(const Duration(milliseconds: 20));
    }
  });

  testWidgets('任务做完后主动回来报结果，且标记为"打断"', (tester) async {
    final controller = ChatController(
      transport: MockTransport(scenario: MockScenario.longTask, speed: 5),
      conversationId: 'c_test',
    )..connect();
    addTearDown(controller.dispose);

    await tester.pumpWidget(_wrap(ChatScreen(controller: controller)));
    await controller.say('帮我查一下昨天那个接口的问题');

    // 把整条回放走完（约 1.7s 的模拟时间），再断言终态
    for (var i = 0; i < 300; i++) {
      await tester.pump(const Duration(milliseconds: 20));
    }

    expect(tester.takeException(), isNull);
    expect(controller.activeTasks, isEmpty, reason: '任务已完成，不该还挂着');

    final msgs = controller.timeline.whereType<DispatcherMessage>().toList();
    expect(msgs.length, greaterThanOrEqualTo(2), reason: '应有"我拿去做了"与"做完了"两条');
    final report = msgs.last;
    expect(report.origin, DispatcherOrigin.proactive, reason: '报结果是主动发起');
    expect(report.interrupts, isTrue, reason: '应标记为打断当前话题');
    expect(report.displayText, contains('打断'));
  });

  testWidgets('开发者模式：卡片可开关（关掉时完全不显示）', (tester) async {
    // 关掉开发者模式 → 不该有卡片
    final plain = ChatController(
      transport: MockTransport(scenario: MockScenario.normal, speed: 100000),
      conversationId: 'c_test',
    )..connect();
    addTearDown(plain.dispose);
    await tester.pumpWidget(_wrap(ChatScreen(controller: plain)));
    await tester.pump();
    expect(find.text('开发者模式'), findsNothing, reason: '关掉时不该显示开发卡片');

    // 打开开发者模式 → 卡片出现
    final dev = ChatController(
      transport: MockTransport(scenario: MockScenario.normal, speed: 100000),
      conversationId: 'c_test',
    )..connect();
    addTearDown(dev.dispose);
    var exited = false;
    await tester.pumpWidget(_wrap(ChatScreen(
      controller: dev,
      devMode: true,
      onExitDevMode: () => exited = true,
    )));
    await tester.pump();
    expect(find.text('开发者模式'), findsOneWidget);
    expect(tester.takeException(), isNull);

    // 点关闭 → 回调触发
    await tester.tap(find.byTooltip('关闭开发者模式'));
    await tester.pump();
    expect(exited, isTrue, reason: '点关闭应退出开发者模式');
  });

  testWidgets('用户连续说两句、调度器只回一条 —— 界面不配对也不错位', (tester) async {
    final controller = ChatController(
      transport: MockTransport(scenario: MockScenario.fastDeep, speed: 1000),
      conversationId: 'c_test',
    )..connect();

    await tester.pumpWidget(_wrap(ChatScreen(controller: controller)));
    await controller.say('第一句');
    await controller.say('第二句');
    for (var i = 0; i < 15; i++) {
      await tester.pump(const Duration(milliseconds: 200));
    }

    expect(tester.takeException(), isNull);
    final utterances = controller.timeline.whereType<UserUtterance>().toList();
    expect(utterances.length, 2, reason: '两句都要在时间线上');
    expect(utterances.first.text, '第一句');
    expect(utterances.last.text, '第二句');
  });
}

Widget _wrap(Widget child) => MaterialApp(
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF4A90D9),
          brightness: Brightness.dark,
        ),
      ),
      home: Scaffold(body: child),
    );
