// **排队那条横条画到屏幕上没有**（契约 `docs/dev/117-QUEUE-VISIBLE.md`）。
//
// ⚠️ 这是**提示档**（`AGENTS.md` §5.1：`test/widget` 只有可访问性那一份是硬闸），
//    但它不是可有可无的：它是"这件事到底有没有画到屏幕上"的**唯一自动化证据**。
//    纯逻辑在 `test/unit/chat_queue_test.dart`；五档字号与命中区在 `accessibility_test.dart`。
//
// 这一份钉四件：
//   ① **空队 ⇒ 什么都不画**（不是"零高度的框还带 padding"）；
//   ② **一条 ⇒ 一行内联**（没有那个计数抬头）；
//   ③ **两条以上 ⇒ 折在计数抬头后面**，点抬头展开（再点收起）；
//   ④ 🔴 **按那颗"不发了" ⇒ 只发一帧**（`{"t":"unsay","messageId":…}`），
//      而且发的是**那一行自己的号**（不是别人的）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/conn_state.dart';
import 'package:hupo_app/models/process_levels.dart';
import 'package:hupo_app/models/queue_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/stream.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/queue_strip.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 假的那条流：只记账（这条判据要的是"撤那一帧真发出去了没有、发了几条"）。
class _FakeStream implements StreamClient {
  _FakeStream({required this.base, required this.token, required this.api, required this.level, required scope})
    : _focus = scope;

  @override
  final String base;
  @override
  final String token;
  @override
  final Api api;
  @override
  final ProcessLevel level;
  @override
  Duration get pingTimeout => const Duration(seconds: 60);
  @override
  Future<TokenProbe> Function(String token)? get probe => null;
  String _focus;
  @override
  String get scope => _focus;
  @override
  Stream<Map<String, dynamic>> get events => const Stream<Map<String, dynamic>>.empty();
  @override
  Stream<ConnState> get states => const Stream<ConnState>.empty();
  @override
  ConnState get state => ConnState.connected;
  @override
  bool get isConnected => true;
  @override
  int get sinceSeq => 0;
  @override
  void open({int sinceSeq = 0}) {}
  @override
  void focus(String scope, {int sinceSeq = 0}) => _focus = scope;
  @override
  bool answerJob(String id, {required bool yes}) => true;
  @override
  bool unsay(String messageId) {
    unsays.add(messageId);
    return true;
  }

  /// 判据要读的账：每一次撤一句（号）。
  final List<String> unsays = [];
  @override
  void close() {}
  @override
  Future<void> dispose() async {}
}

/// 那一帧（服务端给的形状）。
Map<String, dynamic> queueFrame(List<Map<String, dynamic>> items) => {
  'type': 'queue/changed',
  'items': items,
  'count': items.length,
};

Map<String, dynamic> item(String id, String text) => {
  'messageId': id,
  'text': text,
  'at': 1790,
  'truncated': false,
};

/// 一架屏 ＋ 一个控制器 ＋ 那条假流（真 `start` 一遍 —— 不真起，发帧那条路是断的）。
Future<(Widget, ChatController, _FakeStream)> _screen() async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final made = <_FakeStream>[];
  final api = Api(base: 'http://127.0.0.1:1', client: MockClient((_) async => http.Response('{}', 200)));
  final c = ChatController(
    api: api,
    tokens: TokenStore(),
    token: 'tok',
    newStream: ({required base, required token, required level, required scope}) {
      final s = _FakeStream(base: base, token: token, api: api, level: level, scope: scope);
      made.add(s);
      return s;
    },
  );
  await c.start(token: 'tok');
  return (ChatScreen(controller: c, onLoggedOut: () {}), c, made.single);
}

void main() {
  testWidgets('🔴 空队 ⇒ **什么都不画**（不是一个带 padding 的空框）', (tester) async {
    final (screen, c, _) = await _screen();
    await tester.pumpWidget(MaterialApp(home: screen));
    await tester.pumpAndSettle();
    expect(c.queue.isEmpty, isTrue, reason: '起点就是空队');
    expect(find.byKey(queueStripKey), findsNothing, reason: '🔴 空队时那条横条一个像素都不该占');
    expect(find.text(queueCountHeader(1)), findsNothing);

    // 正对照：来一帧（一条）⇒ 它真的会画出来
    c.ingest(queueFrame([item('m_1', '这件事也做一下')]));
    await tester.pumpAndSettle();
    expect(find.byKey(queueStripKey), findsOneWidget);
  });

  testWidgets('★ 一条 ⇒ 一行内联（没有计数抬头）', (tester) async {
    final (screen, c, _) = await _screen();
    await tester.pumpWidget(MaterialApp(home: screen));
    await tester.pumpAndSettle();
    c.ingest(queueFrame([item('m_1', '这件事也做一下')]));
    await tester.pumpAndSettle();

    expect(find.text('这件事也做一下'), findsOneWidget);
    expect(find.byKey(queueHeaderKey), findsNothing, reason: '一条不折 —— 它就是那一行');
    expect(find.byTooltip(queueCancelLabel), findsOneWidget, reason: '那一行上的撤掉按钮');
  });

  testWidgets('★ 两条以上 ⇒ 折在计数抬头后面；点开看得见，再点收起', (tester) async {
    final (screen, c, _) = await _screen();
    await tester.pumpWidget(MaterialApp(home: screen));
    await tester.pumpAndSettle();
    c.ingest(queueFrame([item('m_2', '第二件也做一下'), item('m_3', '第三件')]));
    await tester.pumpAndSettle();

    // 折着：抬头在、正文**不在树里**（真的少画）
    expect(find.byKey(queueHeaderKey), findsOneWidget);
    expect(find.text(queueCountHeader(2)), findsOneWidget);
    expect(find.text('第二件也做一下'), findsNothing, reason: '两条以上默认折起来');
    expect(find.text('第三件'), findsNothing);

    // 点开
    await tester.tap(find.byKey(queueHeaderKey));
    await tester.pumpAndSettle();
    expect(find.text('第二件也做一下'), findsOneWidget);
    expect(find.text('第三件'), findsOneWidget);
    expect(find.byTooltip(queueCancelLabel), findsNWidgets(2));

    // 再点收起
    await tester.tap(find.byKey(queueHeaderKey));
    await tester.pumpAndSettle();
    expect(find.text('第二件也做一下'), findsNothing);
  });

  testWidgets('🔴 按"不发了" ⇒ **只发一帧**，而且发的是那一行自己的号', (tester) async {
    final (screen, c, fake) = await _screen();
    await tester.pumpWidget(MaterialApp(home: screen));
    await tester.pumpAndSettle();
    c.ingest(queueFrame([item('m_2', '第二件也做一下'), item('m_3', '第三件')]));
    await tester.pumpAndSettle();

    // 折着的时候**没有**那个按钮可点（点不着的东西不画）—— 先证明这一点
    expect(find.byTooltip(queueCancelLabel), findsNothing);
    expect(fake.unsays, isEmpty);

    await tester.tap(find.byKey(queueHeaderKey));
    await tester.pumpAndSettle();
    expect(fake.unsays, isEmpty, reason: '点抬头只是展开，不该撤任何东西');

    // 点**第二行**那颗（两条都画出来时它们是按 FIFO 排的：第一颗 = m_2）
    await tester.tap(find.byTooltip(queueCancelLabel).last);
    await tester.pumpAndSettle();
    expect(fake.unsays, ['m_3'], reason: '🔴 撤的必须是**那一行自己的号**，而且只发一帧');
    expect(fake.unsays.length, 1, reason: '🔴 一次点击 = 一帧');

    // ★ **不做乐观删除**：还没收到新快照 ⇒ 屏幕上那一行**留着**
    //   （服务端才是"撤掉没有"的裁判 —— 那一句可能已经在跑了）。
    expect(find.text('第三件'), findsOneWidget,
        reason: '★ 还没收到新快照就把那一行抹掉 = 屏幕上说假话（它可能撤不掉）');

    // 服务端回一份新快照 ⇒ 那一行才消失
    c.ingest(queueFrame([item('m_2', '第二件也做一下')]));
    await tester.pumpAndSettle();
    expect(find.text('第三件'), findsNothing, reason: '新快照里没它了 ⇒ 它才消失');
    expect(find.text('第二件也做一下'), findsOneWidget);
  });

  testWidgets('★ 服务端说"没排队了" ⇒ 横条自己消失', (tester) async {
    final (screen, c, _) = await _screen();
    await tester.pumpWidget(MaterialApp(home: screen));
    await tester.pumpAndSettle();
    c.ingest(queueFrame([item('m_1', '这件事也做一下')]));
    await tester.pumpAndSettle();
    expect(find.byKey(queueStripKey), findsOneWidget);

    c.ingest(queueFrame(const [])); // 那一句被认领了 / 被撤了
    await tester.pumpAndSettle();
    expect(find.byKey(queueStripKey), findsNothing, reason: '空队 ⇒ 一个像素都不占');
  });

  testWidgets('负向对照：坏的 items 不许把屏幕打崩（横条清掉，聊天还在）', (tester) async {
    final (screen, c, _) = await _screen();
    await tester.pumpWidget(MaterialApp(home: screen));
    await tester.pumpAndSettle();
    c.ingest(queueFrame([item('m_1', '这件事也做一下')]));
    await tester.pumpAndSettle();
    // `items` 认不出 ⇒ 当成空队（不是抛、也不是留着旧的幽灵行）
    expect(() => c.ingest({'type': 'queue/changed', 'items': '坏了', 'count': 1}), returnsNormally);
    await tester.pumpAndSettle();
    expect(find.byKey(queueStripKey), findsNothing);
    expect(tester.takeException(), isNull);
  });

  test('★ 那句计数就是 DSH 那句（逐字）', () {
    expect(queueCountHeader(1), '1 条排队消息');
    expect(queueCountHeader(12), '12 条排队消息');
  });
}
