// 登录页的验收。
//
// 这不是普通的表单测试 —— 这台机器上跑着一个能执行命令、能动自己代码的 agent。
// 所以这里量的是**没登录时到底露了什么**：
//   · 只显示登录页，对话气泡 / 会话列表 / 开发者卡片**一个都不许出现**
//   · 口令不对要明确说"不对"，不能假装成功
//   · 登录成功后**才**建连

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/agent_status.dart';
import 'package:hupo_app/models/dev_step.dart';
import 'package:hupo_app/models/stream_event.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/screens/login_screen.dart';
import 'package:hupo_app/main.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/transport.dart';
import 'package:hupo_app/widgets/answer_bubble.dart';

class _FakeTransport implements ChatTransport {
  _FakeTransport({this.required = true});

  final bool required;

  /// 测试用的口令（写死就够了，这里不测口令本身，测的是"没登录时露了什么"）
  static const String goodPassword = 'Correct-Horse-9Battery';
  int connectCount = 0;
  bool get hasToken => _token != null;

  String? _token;

  @override
  String? get token => _token;

  @override
  set token(String? value) => _token = value;

  @override
  Stream<void> get unauthorized => const Stream<void>.empty();

  @override
  Future<({bool required, bool authenticated})> authStatus() async =>
      (required: required, authenticated: !required || _token != null);

  @override
  Future<String?> login(String password) async {
    if (password != goodPassword) return null;
    _token = 'tok-ok';
    return _token;
  }

  @override
  Stream<ServerEvent> connect({required String conversationId, int sinceSeq = 0, bool dev = false}) {
    connectCount++;
    return const Stream<ServerEvent>.empty();
  }

  @override
  Stream<DevStep> get devSteps => const Stream<DevStep>.empty();

  @override
  Stream<AgentSnapshot> get agentSnapshots => const Stream<AgentSnapshot>.empty();

  @override
  Stream<bool> get connectionState => const Stream<bool>.empty();

  @override
  Future<Map<String, dynamic>?> serverVersion() async => null;

  @override
  Future<void> say({
    required String conversationId,
    required String messageId,
    required String text,
    int? clientAt,
  }) async {}

  @override
  Future<void> reportSeen({
    required String conversationId,
    required String messageId,
    int? firstSeenAt,
    int? endedSeenAt,
  }) async {}

  @override
  Future<void> cancelMessage({required String conversationId, required String messageId}) async {}

  @override
  Future<List<Map<String, dynamic>>> listConversations() async => const [];

  @override
  Future<void> dispose() async {}
}

Widget _wrapLogin(ChatController c) => MaterialApp(home: LoginScreen(controller: c));

void main() {
  testWidgets('没登录时只有登录页 —— 对话/气泡/开发者卡片一个都不露', (tester) async {
    final t = _FakeTransport();
    final c = ChatController(transport: t, conversationId: 'c_main');
    addTearDown(c.dispose);

    await c.refreshAuth();
    expect(c.needsLogin, isTrue);

    await tester.pumpWidget(_wrapLogin(c));
    await tester.pump();

    expect(find.byType(LoginScreen), findsOneWidget);
    // 这些是"露了就等于泄密"的东西
    expect(find.byType(AnswerBubble), findsNothing, reason: '对话气泡一个都不能有');
    expect(find.byType(ChatScreen), findsNothing);
    expect(find.textContaining('开发者模式'), findsNothing, reason: '调试卡片不能露');
  });

  testWidgets('口令不对：明确说"不对"，而且**不建连**', (tester) async {
    final t = _FakeTransport();
    final c = ChatController(transport: t, conversationId: 'c_main');
    addTearDown(c.dispose);
    await c.refreshAuth();

    await tester.pumpWidget(_wrapLogin(c));
    await tester.enterText(find.byKey(const Key('login-password')), '错误口令');
    await tester.tap(find.byKey(const Key('login-submit')));
    await tester.pump();
    await tester.pump();

    expect(c.authenticated, isFalse);
    expect(find.text('口令不对'), findsOneWidget);
    expect(t.connectCount, 0, reason: '没登录就不该去建连（建了也是被拒）');
  });

  testWidgets('口令对了：拿到令牌、状态变为已登录、并且**才开始建连**', (tester) async {
    final t = _FakeTransport();
    final c = ChatController(transport: t, conversationId: 'c_main');
    addTearDown(c.dispose);
    await c.refreshAuth();

    await tester.pumpWidget(_wrapLogin(c));
    await tester.enterText(find.byKey(const Key('login-password')), 'Correct-Horse-9Battery');
    await tester.tap(find.byKey(const Key('login-submit')));
    await tester.pump();
    await tester.pump();

    expect(c.authenticated, isTrue);
    expect(c.needsLogin, isFalse);
    expect(t.hasToken, isTrue, reason: '令牌要落到传输层，后续请求都靠它');
    expect(t.connectCount, 1, reason: '登录成功才建连');
  });

  testWidgets('服务端不要鉴权时：不进登录页（本地开发不该被挡）', (tester) async {
    final t = _FakeTransport(required: false);
    final c = ChatController(transport: t, conversationId: 'c_main');
    addTearDown(c.dispose);
    await c.refreshAuth();
    expect(c.needsLogin, isFalse);
  });

  _shellTests();
}

// ── 外壳级：登录成功后**真的换页**吗 ─────────────────────────
//
// 这一条是补的。之前只测 LoginScreen 本身（全过），但线上实测是：
// 接口全 200、登录成功，**界面却停在登录页不动** —— 因为外层 App 没重建。
// 单测一个页面测不出这种事，必须把整个外壳跑起来。

void _shellTests() {
  testWidgets('登录成功后，整个 App 从登录页换成对话页（不能停在原地）', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final t = _FakeTransport();
    await tester.pumpWidget(HupoApp(transportOverride: t));
    await tester.pump();
    await tester.pump();

    // 一开始没令牌 ⇒ 登录页
    expect(find.byType(LoginScreen), findsOneWidget);
    expect(find.byType(ChatScreen), findsNothing);

    // 输对口令
    await tester.enterText(find.byKey(const Key('login-password')), 'Correct-Horse-9Battery');
    await tester.tap(find.byKey(const Key('login-submit')));
    await tester.pump();
    await tester.pump();
    await tester.pump();

    expect(find.byType(LoginScreen), findsNothing, reason: '登录成功就该离开登录页');
    expect(find.byType(ChatScreen), findsOneWidget, reason: '要换成对话页');
    expect(t.connectCount, 1, reason: '登录之后才建连');
  });
}
