// **网没通了、那一条没发出去 —— 网回来之后它自己走掉**（主人 2026-10-04 报的）。
//
// 原话：*「网没通，这条没发出去，这个状态在恢复后依然还在。」*
//
// ── 这一份钉三件 ──────────────────────────────────────────
//   ① 网没通 ⇒ 屏幕上「没发出去」＋ 顶上那句"网没通，这条没发出去"（**如实**）
//   ② 🔴 **连回来** ⇒ ①那句**自己走掉**；②那一句**自己重发一次**
//      （同一个 `messageId` ⇒ 服务端幂等，不会让 agent 干两遍）
//   ③ 负向对照：**"忙不过来 / 太频繁 / 被拒"那几种一律不许自动重发**
//      （那不是网的事 —— 网一通就自动重试 = 白打服务端，而且屏幕上会撒谎）
//
// ⚠️ 这一份进硬闸（`test/unit`）：只有纯逻辑与状态，不写界面断言。

import 'dart:async';
import 'dart:convert';
import 'dart:io' show SocketException;

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/conn_state.dart';
import 'package:hupo_app/models/message_state.dart';
import 'package:hupo_app/models/process_levels.dart';
import 'package:hupo_app/models/timeline.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/stream.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

http.Response _json(String body, [int status = 200]) => http.Response(
  body,
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

/// 一条假流：只记"连没连上"，判据自己往里推状态。
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
  final _events = StreamController<Map<String, dynamic>>.broadcast();
  final _states = StreamController<ConnState>.broadcast();
  @override
  Stream<Map<String, dynamic>> get events => _events.stream;
  @override
  Stream<ConnState> get states => _states.stream;
  @override
  ConnState get state => ConnState.idle;
  @override
  bool get isConnected => false;
  @override
  int get sinceSeq => 0;
  @override
  void open({int sinceSeq = 0}) {}
  @override
  void focus(String scope, {int sinceSeq = 0}) => _focus = scope;
  @override
  bool answerJob(String id, {required bool yes}) => true;
  @override
  bool unsay(String messageId) => true;
  @override
  void close() {}
  @override
  Future<void> dispose() async {
    await _events.close();
    await _states.close();
  }

  /// 判据用：**连上了**（那正是"网回来了"那一刻）。
  void sayConnected() => _states.add(ConnState.connected);
}

/// 那一句现在是什么态（本地那一条）。
MessageState? _stateOf(ChatController c, String messageId) {
  for (final it in c.items) {
    if (it is UserUtterance && it.messageId == messageId) return it.state;
  }
  return null;
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  test('🔴 网没通 ⇒ 如实说；**连回来 ⇒ 那句话自己走掉、那一句自己重发**', () async {
    final says = <String>[]; // 每次 /api/say 的正文（读 messageId）
    var offline = true;
    final api = Api(
      client: MockClient((r) async {
        if (r.url.path == '/api/say') {
          if (offline) throw const SocketException('网没通');
          says.add(r.body);
          return _json(jsonEncode({'ok': true, 'duplicate': false, 'seq': 1}));
        }
        if (r.url.path == '/api/renew') {
          return _json(jsonEncode({'token': 'tok', 'expiresAt': 9_999_999_999_999}));
        }
        return _json(jsonEncode({'frames': <Object>[], 'hasMore': false}));
      }),
    );
    _FakeStream? stream;
    final c = ChatController(
      api: api,
      tokens: TokenStore(),
      token: 'tok',
      newStream: ({required base, required token, required level, required scope}) {
        stream = _FakeStream(base: base, token: token, api: api, level: level, scope: scope);
        return stream!;
      },
    );
    addTearDown(c.dispose);
    await c.start(token: 'tok');
    await c.send('这句话是在网断的时候按的');
    await Future<void>.delayed(Duration.zero);

    final id = c.items.whereType<UserUtterance>().last.messageId;
    expect(_stateOf(c, id), MessageState.failed, reason: '★ 网没通 ⇒ 屏幕上该是「没发出去」');
    expect(c.lastError, '网没通，这条没发出去', reason: '★ 顶上也该如实说');
    expect(says, isEmpty, reason: '前提：第一次真的没发出去');

    // ── 网回来了 ──────────────────────────────────────────
    offline = false;
    stream!.sayConnected();
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);

    expect(c.lastError, isNull, reason: '★ 网回来了那句"网没通"不许还挂着（屏幕上说假话）');
    expect(says.length, 1, reason: '★ 那一句该自己重发一次');
    expect(jsonDecode(says.single)['messageId'], id, reason: '★ 必须用**同一个 messageId**（服务端靠它幂等）');
    expect(_stateOf(c, id), isNot(MessageState.failed), reason: '★ 重发之后不该还写着"没发出去"');
  });

  test('🔴 负向对照：**忙不过来**那一种不许自动重发', () async {
    var calls = 0;
    final api = Api(
      client: MockClient((r) async {
        if (r.url.path == '/api/say') {
          calls += 1;
          return _json(jsonEncode({'ok': false, 'error': 'busy'}), 503);
        }
        if (r.url.path == '/api/renew') {
          return _json(jsonEncode({'token': 'tok', 'expiresAt': 9_999_999_999_999}));
        }
        return _json(jsonEncode({'frames': <Object>[], 'hasMore': false}));
      }),
    );
    _FakeStream? stream;
    final c = ChatController(
      api: api,
      tokens: TokenStore(),
      token: 'tok',
      newStream: ({required base, required token, required level, required scope}) {
        stream = _FakeStream(base: base, token: token, api: api, level: level, scope: scope);
        return stream!;
      },
    );
    addTearDown(c.dispose);
    await c.start(token: 'tok');
    await c.send('服务端忙的时候按的');
    await Future<void>.delayed(Duration.zero);
    expect(calls, 1);
    expect(c.lastError, isNotNull, reason: '前提：这一条也如实说了（但说的不是"网没通"）');

    stream!.sayConnected();
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);
    expect(calls, 1, reason: '★ "忙不过来"不是网的事 ⇒ 连回来也不许自动重发');
    expect(c.lastError, isNotNull, reason: '★ 那句话也不许被"连上了"顺手抹掉');
  });
}
