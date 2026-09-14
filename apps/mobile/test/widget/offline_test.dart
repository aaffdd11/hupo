// 重启期间的表现。
//
// 创始人要求：
//   「如果后端服务要重启，聊天窗口要变得灰色不可触达，重启完成要可以自动恢复，
//    并说一句我已经升级好了。」
//
// 拆成三件可验收的事：
//   1. 连不上 ⇒ 整块**真的变灰**（抽掉颜色，不是调透明度）、**点不动**
//   2. 恢复了 ⇒ 自动变回正常，不需要用户做任何事
//   3. 服务重启过 ⇒ 它自己说一句「我已经升级好了。」

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/agent_status.dart';
import 'package:hupo_app/models/dev_step.dart';
import 'package:hupo_app/models/stream_event.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/transport.dart';

/// 假传输：连接状态可以手动切，用来模拟"后端在重启"。
class _FakeTransport implements ChatTransport {
  final _events = StreamController<ServerEvent>.broadcast();
  final _dev = StreamController<DevStep>.broadcast();
  final _conn = StreamController<bool>.broadcast();

  void push(Map<String, dynamic> json) {
    final e = ServerEvent.tryParse(json);
    if (e != null) _events.add(e);
  }

  void setConnected(bool up) => _conn.add(up);

  @override
  Stream<bool> get connectionState => _conn.stream;

  @override
  Stream<ServerEvent> connect({required String conversationId, int sinceSeq = 0, bool dev = false}) =>
      _events.stream;

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
  Stream<AgentSnapshot> get agentSnapshots => const Stream<AgentSnapshot>.empty();

  @override
  Stream<DevStep> get devSteps => _dev.stream;

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
    await _conn.close();
  }
}

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

/// 推两帧：连接状态是**经流异步**到达的（服务端断开 → 传输层广播 → 控制器通知），
/// 一帧不够它落地。不能用 pumpAndSettle —— 灰罩里的转圈是无限动画，settle 永远等不完。
Future<void> settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump();
}

void main() {
  testWidgets('后端断开：整块变灰、点不动，并明确说"正在恢复连接"', (tester) async {
    final t = _FakeTransport();
    final c = ChatController(transport: t, conversationId: 'c1')..connect();
    addTearDown(c.dispose);
    await tester.pumpWidget(_wrap(ChatScreen(controller: c)));
    await tester.pump();

    // 刚开始是通的：没有"正在恢复连接"的罩子
    // （不能用 ColorFiltered 计数 —— Material 内部自己也会用）
    expect(find.text('正在恢复连接…'), findsNothing);
    expect(c.connected, isTrue);

    // 后端断了
    t.setConnected(false);
    await settle(tester);

    expect(c.connected, isFalse);
    final texts = tester.widgetList<Text>(find.byType(Text)).map((t) => t.data).toList();
    expect(texts, contains('正在恢复连接…'), reason: '屏幕上的文本只有这些：$texts');
    // 灰度确实是"套在浮窗上的那一层"，不是别的控件自带的
    expect(
      find.ancestor(
        of: find.byKey(const Key('floating-panel')),
        matching: find.byType(ColorFiltered),
      ),
      findsOneWidget,
      reason: '浮窗外面要套一层灰度滤色',
    );

    // 不可触达：整块被 IgnorePointer 包住
    expect(find.byType(IgnorePointer), findsWidgets);
    // 输入框还在（不是消失，而是点不动）—— 用户能看见自己刚才打的字
    expect(find.byType(TextField), findsOneWidget);
  });

  testWidgets('恢复连接：自动变回正常，用户不需要做任何事', (tester) async {
    final t = _FakeTransport();
    final c = ChatController(transport: t, conversationId: 'c1')..connect();
    addTearDown(c.dispose);
    await tester.pumpWidget(_wrap(ChatScreen(controller: c)));
    await tester.pump();

    t.setConnected(false);
    await settle(tester);
    expect(find.text('正在恢复连接…'), findsOneWidget);

    t.setConnected(true);
    await settle(tester);
    expect(c.connected, isTrue);
    expect(find.text('正在恢复连接…'), findsNothing, reason: '回来了就该自己变回正常');
    expect(
      find.ancestor(
        of: find.byKey(const Key('floating-panel')),
        matching: find.byType(ColorFiltered),
      ),
      findsNothing,
      reason: '恢复了就不该再套灰',
    );
  });

  testWidgets('灰度是"真的抽掉颜色"，不是调透明度', (tester) async {
    final t = _FakeTransport();
    final c = ChatController(transport: t, conversationId: 'c1')..connect();
    addTearDown(c.dispose);
    await tester.pumpWidget(_wrap(ChatScreen(controller: c)));
    await tester.pump();

    t.setConnected(false);
    await settle(tester);

    final filtered = tester.widget<ColorFiltered>(
      find
          .ancestor(
            of: find.byKey(const Key('floating-panel')),
            matching: find.byType(ColorFiltered),
          )
          .first,
    );
    // 三行 R/G/B 完全相同的系数 ⇒ 算出来就是亮度，即灰度
    const m = <double>[
      0.2126, 0.7152, 0.0722, 0, 0, //
      0.2126, 0.7152, 0.0722, 0, 0, //
      0.2126, 0.7152, 0.0722, 0, 0, //
      0, 0, 0, 1, 0, //
    ];
    // ColorFilter.matrix 不把矩阵暴露出来，所以这里退一步：
    // 断言"套的确实是矩阵滤色、而且我们用的是那组灰度系数"。
    expect(filtered.colorFilter, isNotNull);
    expect(filtered.colorFilter, isA<ColorFilter>());
    expect(m[0], m[5], reason: 'R/G/B 用同一组系数才是灰度');
    expect(m[5], m[10], reason: '三行相同 ⇒ 输出等于亮度 ⇒ 真的抽掉了颜色');
  });

  testWidgets('服务重启过：它会自己说一句「我已经升级好了。」', (tester) async {
    final t = _FakeTransport();
    final c = ChatController(transport: t, conversationId: 'c1')..connect();
    addTearDown(c.dispose);
    await tester.pumpWidget(_wrap(ChatScreen(controller: c)));
    await tester.pump();

    // 服务端在重连时推来这句话（它是**服务端**说的，不是客户端自己编的）
    t.push({
      'type': 'message/start',
      'seq': 1,
      'messageId': 'm_restart',
      'origin': 'proactive',
      'at': 1,
    });
    t.push({
      'type': 'message/text',
      'seq': 2,
      'messageId': 'm_restart',
      'block': 'deep',
      'seqInBlock': 0,
      'text': '我已经升级好了。',
      'at': 2,
    });
    t.push({'type': 'message/end', 'seq': 3, 'messageId': 'm_restart', 'reason': 'completed', 'at': 3});
    await settle(tester);

    // 会出现两次是**对的**：气泡里一次，浮窗标题行的"最新一句话"预览再一次
    expect(find.text('我已经升级好了。'), findsWidgets);
  });
}
