// 「它正在做…」到底有没有出现在**屏幕上**。
//
// ⚠️ 为什么这一条非写不可：`test/unit` 只能证明**模型**产出那句话
//    （`timeline.agentLine`）。而 S2 这件事的原始缺陷恰恰是
//    **"链子某一处断了、而屏幕上看不出来"**——所以只测模型等于没测。
//    唯一能证明"画出来了"的，是把屏幕搭起来看一眼。
//
// ⚠️ 它属于 `test/widget`（手册：**提示档，不是闸**）。界面一重构它可能过期，
//    那时照常交付、回头再修；**但别把它删了**——它是这里唯一一条
//    "用户真的看得见吗"的自动化证据。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/process_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';

/// 一个不碰网络的控制器：`Api` 指一个没人听的地址，测试里一次都不会真发。
ChatController _controller() =>
    ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore());

Future<void> _pump(WidgetTester tester, ChatController c) async {
  await tester.pumpWidget(MaterialApp(home: ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {})));
}

void main() {
  testWidgets('★ 一轮开了、还没出字 ⇒ 屏幕上真的有一行「它正在做…」', (tester) async {
    final c = _controller();
    await _pump(tester, c);

    // 一开始什么都不该有（不许无端显示"在工作"）
    expect(find.text(busyFallback), findsNothing);

    c.ingest({'type': 'message/status', 'turn': 1, 'state': 'started'});
    await tester.pump();

    expect(find.text(busyFallback), findsOneWidget, reason: '★ 这段空白正是 8/10 放弃点所在');
  });

  testWidgets('★ 它说出第一句之后，提示还在（这一轮还没完）', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    c.ingest({'type': 'message/status', 'turn': 1, 'state': 'started'});
    c.ingest({'type': 'message/start', 'messageId': 'm1', 'seq': 1});
    c.ingest({'type': 'message/text', 'messageId': 'm1', 'block': 'quick', 'text': '查着', 'seq': 2});
    await tester.pump();

    expect(find.text('查着'), findsOneWidget, reason: '气泡出来了');
    expect(find.text(busyFallback), findsOneWidget, reason: '但这一轮还没收口');
  });

  testWidgets('🔴 收口之后提示必须消失（H4：不许永久停在"正在做"）', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    c.ingest({'type': 'message/status', 'turn': 1, 'state': 'started'});
    c.ingest({'type': 'message/start', 'messageId': 'm1', 'seq': 1});
    c.ingest({'type': 'message/text', 'messageId': 'm1', 'block': 'quick', 'text': '好了', 'seq': 2});
    c.ingest({'type': 'message/end', 'messageId': 'm1', 'seq': 3, 'reason': 'completed'});
    await tester.pump();

    expect(find.text(busyFallback), findsNothing);
  });

  testWidgets('🔴 它断了 ⇒ 提示也得消失（而不是永远挂着）', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    c.ingest({'type': 'message/status', 'turn': 1, 'state': 'started'});
    await tester.pump();
    expect(find.text(busyFallback), findsOneWidget);

    c.ingest({'type': 'error', 'kind': 'agent-exit', 'text': '刚才我断了'});
    await tester.pump();
    expect(find.text(busyFallback), findsNothing);
  });

  testWidgets('认不出来的状态 ⇒ 屏幕上**保持安静**（不许把内部词摆出来）', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    c.ingest({'type': 'message/status', 'turn': 1, 'state': 'working'});
    await tester.pump();
    expect(find.text(busyFallback), findsNothing);
    expect(find.textContaining('working'), findsNothing, reason: '内部词绝不许上屏');
  });
}
