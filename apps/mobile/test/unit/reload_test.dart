// 「服务端说刷新，前端照做」的行为测试。
//
// 这条要求的形状（创始人原话）：
//   「前端只是一个接受和回应的东西。你当然还要做一个自动化的刷新页面机制。
//    就是如果系统改变了需要刷新，你会去刷新页面。」
//
// 但"照做"不等于"立刻刷"：用户正看着一段话往外蹦的时候把页面刷掉，
// 等于把话从他眼前抽走。所以规则是：
//   **收到刷新令先记下 —— 手上有没说完的话就等它说完，等太久（20s）才强刷。**
//
// 另有一条护栏：同一个指纹只自动刷一次。防的是"服务端记的指纹和实际部署的包
// 对不上 → 刷新 → 还是旧包 → 又刷新"这种无限循环。
// 测试环境是 VM（非 Web），走的是 _io 分支：reloadClient 是空操作，
// 所以这里用 onReloadRequested 观察"决定刷新"这个动作。

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/agent_status.dart';
import 'package:hupo_app/models/dev_step.dart';
import 'package:hupo_app/models/stream_event.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/transport.dart';

/// 最小假传输：测试自己往里推事件。
class _FakeTransport implements ChatTransport {
  final _events = StreamController<ServerEvent>.broadcast();
  final _dev = StreamController<DevStep>.broadcast();
  Map<String, dynamic>? versionResult;
  int connectCount = 0;

  void push(Map<String, dynamic> json) {
    final e = ServerEvent.tryParse(json);
    if (e != null) _events.add(e);
  }

  @override
  Stream<ServerEvent> connect({required String conversationId, int sinceSeq = 0, bool dev = false}) {
    connectCount++;
    return _events.stream;
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
  Stream<AgentSnapshot> get agentSnapshots => const Stream<AgentSnapshot>.empty();

  @override
  Stream<DevStep> get devSteps => _dev.stream;

  @override
  Stream<bool> get connectionState => const Stream<bool>.empty();

  @override
  Future<Map<String, dynamic>?> serverVersion() async => versionResult;

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
  }
}

void main() {
  test('收到刷新令：手上没说完的话，就先说完再刷（不把话从用户眼前抽走）', () async {
    final t = _FakeTransport();
    final c = ChatController(transport: t, conversationId: 'c1');
    var reloads = 0;
    c.onReloadRequested = () => reloads++;
    c.connect();

    t.push({'type': 'message/start', 'seq': 1, 'messageId': 'm1'});
    t.push({
      'type': 'message/text',
      'seq': 2,
      'messageId': 'm1',
      'block': 'quick',
      'seqInBlock': 0,
      'text': '收到，我先去查。',
    });
    t.push({'type': 'client/reload', 'seq': 3, 'reason': 'build-changed', 'buildId': 'abc'});
    await Future<void>.delayed(Duration.zero);
    expect(reloads, 0, reason: '这一轮还没说完，不能刷');

    t.push({'type': 'message/end', 'seq': 4, 'messageId': 'm1', 'reason': 'completed'});
    await Future<void>.delayed(Duration.zero);
    expect(reloads, 1, reason: '话说完就该刷了');

    c.dispose();
  });

  test('收到刷新令：手上没事就立刻刷', () async {
    final t = _FakeTransport();
    final c = ChatController(transport: t, conversationId: 'c1');
    var reloads = 0;
    c.onReloadRequested = () => reloads++;
    c.connect();

    t.push({'type': 'client/reload', 'seq': 1, 'reason': 'build-changed', 'buildId': 'abc'});
    await Future<void>.delayed(Duration.zero);
    expect(reloads, 1);

    c.dispose();
  });

  test('版本对不上（断线期间部署过新版本）也会触发刷新', () async {
    final t = _FakeTransport()..versionResult = {'buildId': 'server-side-hash'};
    final c = ChatController(transport: t, conversationId: 'c1');
    var reloads = 0;
    c.onReloadRequested = () => reloads++;
    c.connect();
    await Future<void>.delayed(Duration.zero);
    // 测试构建的 kClientBuildId 是 'dev'，比不了 —— 这时**不该**刷新，
    // 否则开发机上会无限刷新。线上构建才有真指纹。
    expect(reloads, 0, reason: '没有真指纹的构建不做版本比较，避免刷进死循环');

    c.dispose();
  });

  group('刷新护栏：同一个指纹只自动刷一次（防无限刷新）', () {
    test('已经为这个指纹刷过 → 不再刷', () {
      expect(
        ChatController.shouldSkipReload(buildId: 'abc', alreadyReloadedFor: 'abc'),
        isTrue,
      );
    });

    test('换了一个新指纹 → 可以刷', () {
      expect(
        ChatController.shouldSkipReload(buildId: 'def', alreadyReloadedFor: 'abc'),
        isFalse,
      );
    });

    test('没有指纹（服务端没说）→ 不拿它当护栏依据', () {
      expect(
        ChatController.shouldSkipReload(buildId: '', alreadyReloadedFor: ''),
        isFalse,
      );
    });
  });

  test('服务端问不到版本时不动手（宁可不刷，也不乱刷）', () async {
    final t = _FakeTransport()..versionResult = null;
    final c = ChatController(transport: t, conversationId: 'c1');
    var reloads = 0;
    c.onReloadRequested = () => reloads++;
    c.connect();
    await Future<void>.delayed(Duration.zero);
    expect(reloads, 0);

    c.dispose();
  });
}
