// **回话里那段视频**（2026-10-01）：气泡里那个框。
//
// 钉三件（都从真入口进：`controller.ingest` 喂服务端那一帧的形状）：
//   ① 🔴 回话里带视频地址 ⇒ 屏幕上**真的多了一个框**，而**不是**把长地址当正文画出来；
//   ② 🔴 **在跑判据的这个环境里开不了外链**（`canOpenLinks == false`，见 `services/links.dart`）
//      ⇒ 那个框必须画成**不可点的**并如实说一句（**不给假按钮** —— 这是本仓库第 4 条纪律那一族）；
//   ③ 点它**不许抛**（按不动 ≠ 一按就崩）。

import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/links.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:shared_preferences/shared_preferences.dart';

const String _videoUrl = 'https://ark.example/gen/video-123.mp4';

ChatController _controller() => ChatController(
  api: Api(base: 'http://127.0.0.1:1'),
  tokens: TokenStore(),
  token: 'tok',
);

void _feed(ChatController c) {
  c.ingest({'type': 'message/start', 'seq': 1, 'messageId': 'm1', 'block': 'quick'});
  c.ingest({
    'type': 'message/text',
    'seq': 2,
    'messageId': 'm1',
    'block': 'quick',
    'text': '视频做好了：\n$_videoUrl',
  });
}

Future<void> _pump(WidgetTester tester) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final c = _controller();
  _feed(c);
  await tester.pumpWidget(
    MaterialApp(home: ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {})),
  );
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  testWidgets('★ 回话里带视频地址 ⇒ 屏幕上多一个框（不是一串长地址）', (tester) async {
    await _pump(tester);
    // ① 人话那部分还在
    expect(find.textContaining('视频做好了'), findsOneWidget);
    // ② ★ **地址没被当正文画出来**
    expect(find.text(_videoUrl), findsNothing, reason: '★ 地址被当正文画出来了（B37 那种形状）');
    // ③ ★ 那个框真的在（两种字之一：能开的 / 这儿开不了的）
    final canOpen = canOpenLinks;
    expect(
      find.text(canOpen ? '点开看这段视频' : '这段视频在这儿打不开（换个地方看）'),
      findsOneWidget,
      reason: '★ 那个框没画出来（canOpenLinks=$canOpen）',
    );
  });

  testWidgets('🔴 这个环境开不了外链 ⇒ 那个框**画成不可点的**并如实说（不许给假按钮）', (tester) async {
    await _pump(tester);
    if (canOpenLinks) {
      // ⚠️ 在真能开外链的环境（网页）里这一条不适用：那儿的框是能点的
      expect(find.text('点开看这段视频'), findsOneWidget);
      return;
    }
    expect(find.text('这段视频在这儿打不开（换个地方看）'), findsOneWidget);
    // 点它**不许抛**（按不动 ≠ 一按就崩）
    await tester.tap(find.text('这段视频在这儿打不开（换个地方看）'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    // 负向对照：这一条跑的确实是 VM（不是网页）
    expect(Platform.isLinux || Platform.isMacOS || Platform.isWindows, isTrue);
  });
}
