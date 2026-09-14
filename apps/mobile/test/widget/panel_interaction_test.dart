// 这两条是主人 2026-09-14 直接在页面上提的需求。
//
// 当时 agent 把代码改对了，但**自己重启服务把自己打断了**，没跑测试也没部署，
// 主人一直没拿到东西。这几条测试是回来补的 —— 把它改对的东西钉住，
// 顺便证明"它当时确实改对了，问题只在没走完最后一步"。
//
// 原话：
//   「它的聊天窗口上面点击它就消失，这个不对，应该在别的地方非聊天窗口上点击才会消失，
//    其次呢我进入以后聊天历史应该是放到最新的那几条，我们默认就按10条来吧，
//    然后超过10条那部分是要隐藏的，是属于向上滑才能够看到的」

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
      transport: MockTransport(scenario: MockScenario.normal, speed: 100000),
      conversationId: 'c_test',
    )..connect();

/// 直接往时间线里灌 n 条用户发言，用来验分页。
void seed(ChatController c, int n) {
  for (var i = 1; i <= n; i++) {
    c.timeline.add(UserUtterance(
      seq: i,
      at: DateTime(2026),
      messageId: 'u$i',
      text: '第 $i 条',
      sentAt: 0,
      pending: false,
    ));
  }
}

void main() {
  testWidgets('点浮窗**里面**不该收起（这是原来那个毛病）', (tester) async {
    final c = _controller();
    addTearDown(c.dispose);
    await tester.pumpWidget(_wrap(ChatScreen(controller: c)));
    await tester.pump();

    final panel = find.byKey(const Key('floating-panel'));
    final before = tester.getSize(panel).height;

    // 点消息区中间（浮窗内部）
    await tester.tapAt(tester.getCenter(panel));
    await tester.pumpAndSettle();

    expect(tester.getSize(panel).height, closeTo(before, 0.5),
        reason: '点浮窗自己不该有任何反应 —— 原来这里会整个收掉');
  });

  testWidgets('点浮窗**外面**才收起', (tester) async {
    final c = _controller();
    addTearDown(c.dispose);
    await tester.pumpWidget(_wrap(ChatScreen(controller: c)));
    await tester.pump();

    final panel = find.byKey(const Key('floating-panel'));
    final expanded = tester.getSize(panel).height;

    // 浮窗上面那条缝 = 背景
    await tester.tapAt(const Offset(200, 2));
    await tester.pumpAndSettle();

    expect(tester.getSize(panel).height, lessThan(expanded),
        reason: '点非聊天窗口的地方要收起');
  });

  testWidgets('点外面收起后，再点外面**不会**又弹回来（只收不放）', (tester) async {
    final c = _controller();
    addTearDown(c.dispose);
    await tester.pumpWidget(_wrap(ChatScreen(controller: c)));
    await tester.pump();

    final panel = find.byKey(const Key('floating-panel'));
    await tester.tapAt(const Offset(200, 2));
    await tester.pumpAndSettle();
    final collapsed = tester.getSize(panel).height;

    await tester.tapAt(const Offset(200, 2));
    await tester.pumpAndSettle();
    expect(tester.getSize(panel).height, closeTo(collapsed, 0.5),
        reason: '在外面点一下又弹回来会很烦');
  });

  testWidgets('进去只铺最新的 10 条，更早的藏起来', (tester) async {
    final c = _controller();
    addTearDown(c.dispose);
    await tester.pumpWidget(_wrap(ChatScreen(controller: c)));
    await tester.pump();

    seed(c, 25);
    c.notifyListeners();
    await tester.pump();

    // ListView 只构建视口附近的，所以"在不在"要滚到底再看。
    // 关键断言是**更早的那几条根本不在树上** —— 它们被 sublist 切掉了，
    // 不是"滚上去才有"，而是"还没放出来"。这就是主人要的"隐藏"。
    expect(find.text('第 15 条'), findsNothing, reason: '只放 10 条，第 15 条更早，应该藏起来');
    expect(find.text('第 1 条'), findsNothing, reason: '第 1 条最老，更该藏着');

    // 滚到底应该看到最新的那条
    await tester.drag(find.byType(ListView).first, const Offset(0, -4000));
    await tester.pump();
    expect(find.text('第 25 条'), findsOneWidget, reason: '进去就该停在最新几条');
  });

  testWidgets('往上滑到顶会一页一页放出更早的', (tester) async {
    final c = _controller();
    addTearDown(c.dispose);
    await tester.pumpWidget(_wrap(ChatScreen(controller: c)));
    await tester.pump();

    seed(c, 25);
    c.notifyListeners();
    await tester.pump();
    expect(find.text('第 15 条'), findsNothing);

    // 滑到顶部触发加载上一页
    await tester.drag(find.byType(ListView).first, const Offset(0, 4000));
    await tester.pump();
    await tester.pump();
    expect(find.text('第 15 条'), findsOneWidget, reason: '滑到顶该再放一页出来');
  });
}
