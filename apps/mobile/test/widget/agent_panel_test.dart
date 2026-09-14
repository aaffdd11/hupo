// 开发者模式里的 **agent 进程监控**。
//
// 创始人要求：「开发者模式里也要监控相关的 agent 进程状态。」
//
// 为什么这不是可有可无的装饰：一个会话 = 一个常驻真 agent 进程，每个 150–200MB。
// 这东西**看不见就会失控** —— 内存涨、僵尸进程、反复重启，产品界面上一点征兆都没有。
// 所以这里量的不是"画出来没有"，而是"该看见的能不能一眼看见"。

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/agent_status.dart';
import 'package:hupo_app/models/dev_step.dart';
import 'package:hupo_app/models/stream_event.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/transport.dart';
import 'package:hupo_app/widgets/dev_card.dart';

/// 假传输：可以把进程快照推进去。
class _FakeTransport implements ChatTransport {
  final _events = StreamController<ServerEvent>.broadcast();
  final _dev = StreamController<DevStep>.broadcast();
  final _agents = StreamController<AgentSnapshot>.broadcast();

  void pushSnapshot(Map<String, dynamic> json) {
    final s = AgentSnapshot.tryParse(json);
    if (s != null) _agents.add(s);
  }

  // ── 鉴权：假传输里一律"不用登录" ──────────────────────────
  String? _token;

  @override
  String? get token => _token;

  @override
  set token(String? value) => _token = value;

  @override
  Stream<void> get unauthorized => const Stream<void>.empty();

  @override
  Future<({bool required, bool authenticated})> authStatus() async =>
      (required: false, authenticated: true);

  @override
  Future<String?> login(String password) async => null;

  @override
  Stream<AgentSnapshot> get agentSnapshots => _agents.stream;

  @override
  Stream<ServerEvent> connect({required String conversationId, int sinceSeq = 0, bool dev = false}) =>
      _events.stream;

  @override
  Stream<DevStep> get devSteps => _dev.stream;

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
  Future<void> dispose() async {
    await _events.close();
    await _dev.close();
    await _agents.close();
  }
}

/// DevCard 自己**不监听** controller —— 它是靠父组件（ChatScreen）重建带起来的。
/// 所以单测里要自己套一层监听，否则永远看到的是第一帧。
Widget _wrapCard(ChatController c) => _wrap(
      ListenableBuilder(
        listenable: c,
        builder: (_, __) => DevCard(controller: c, onClose: () {}),
      ),
    );

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

void main() {
  testWidgets('开发卡片显示每个 agent 进程：状态 / 内存 / 活了多久 / 重启次数', (tester) async {
    final t = _FakeTransport();
    final c = ChatController(transport: t, conversationId: 'c_main')..connect(dev: true);
    addTearDown(c.dispose);

    await tester.pumpWidget(_wrapCard(c));
    await tester.pump();

    t.pushSnapshot({
      'type': 'dev/agents',
      'at': DateTime.now().millisecondsSinceEpoch,
      'sessions': 2,
      'totalRssBytes': 260 * 1024 * 1024,
      'uptimeMs': 125000,
      'agents': [
        {
          'key': 'c_main',
          'sessionId': 'c_main.abc',
          'pid': 1234,
          'state': 'running',
          'rssBytes': 168 * 1024 * 1024,
          'spawnedAt': DateTime.now().millisecondsSinceEpoch - 60000,
          'turnStartedAt': DateTime.now().millisecondsSinceEpoch - 3000,
          'restarts': 1,
        },
        {
          'key': 'debug:c_main',
          'sessionId': 'debug:c_main.abc',
          'pid': 1235,
          'state': 'idle',
          'rssBytes': 92 * 1024 * 1024,
          'spawnedAt': DateTime.now().millisecondsSinceEpoch - 30000,
          'restarts': 1,
        },
      ],
    });
    await tester.pump();
    await tester.pump();

    expect(find.textContaining('agent 进程 2 个'), findsOneWidget);
    expect(find.textContaining('内存 260MB'), findsOneWidget);
    expect(find.text('c_main'), findsOneWidget);
    expect(find.text('debug:c_main'), findsOneWidget);
    expect(find.textContaining('干活中'), findsOneWidget, reason: '在跑的那只要看得出来');
    expect(find.textContaining('待命'), findsOneWidget);
    expect(find.text('168MB'), findsOneWidget);
    expect(find.text('92MB'), findsOneWidget);
  });

  testWidgets('进程反复重启会很显眼（重启次数 > 1 才显示）', (tester) async {
    final t = _FakeTransport();
    final c = ChatController(transport: t, conversationId: 'c_main')..connect(dev: true);
    addTearDown(c.dispose);
    await tester.pumpWidget(_wrapCard(c));
    await tester.pump();

    t.pushSnapshot({
      'type': 'dev/agents',
      'sessions': 2,
      'totalRssBytes': 0,
      'agents': [
        {'key': 'c_main', 'sessionId': 'a', 'state': 'idle', 'restarts': 1},
        {'key': 'debug:c_main', 'sessionId': 'b', 'state': 'idle', 'restarts': 5},
      ],
    });
    await tester.pump();
    await tester.pump();

    expect(find.textContaining('重启×5'), findsOneWidget);
    expect(find.textContaining('重启×1'), findsNothing, reason: '起过一次是正常的，不该报警');
  });

  testWidgets('读不到内存显示「—」而不是 0（0 会被误读成很省）', (tester) async {
    final t = _FakeTransport();
    final c = ChatController(transport: t, conversationId: 'c_main')..connect(dev: true);
    addTearDown(c.dispose);
    await tester.pumpWidget(_wrapCard(c));
    await tester.pump();

    t.pushSnapshot({
      'type': 'dev/agents',
      'sessions': 1,
      'totalRssBytes': 0,
      'agents': [
        {'key': 'c_main', 'sessionId': 'a', 'state': 'starting', 'restarts': 0},
      ],
    });
    await tester.pump();
    await tester.pump();

    expect(find.text('—'), findsWidgets);
    expect(find.text('0MB'), findsNothing);
  });

  testWidgets('关掉开发者模式就不订阅进程状态（不白算）', (tester) async {
    final t = _FakeTransport();
    final c = ChatController(transport: t, conversationId: 'c_main')..connect(); // dev=false
    addTearDown(c.dispose);
    await tester.pumpWidget(_wrapCard(c));
    await tester.pump();

    t.pushSnapshot({
      'type': 'dev/agents',
      'sessions': 1,
      'totalRssBytes': 100,
      'agents': [
        {'key': 'c_main', 'sessionId': 'a', 'state': 'running', 'restarts': 0},
      ],
    });
    await tester.pump();
    await tester.pump();

    expect(c.agentSnapshot, isNull, reason: '没开开发者模式就不该收集进程状态');
  });
}
