// **派活那一步画到屏幕上了没有**（契约 `docs/dev/108-JOB-ASK-FLOW.md` §一 第①步 / §二 C1、C5）。
//
// ⚠️ 这一份是**提示档**（`test/widget` 的通用规矩）：真正的硬闸是
//    `test/unit/job_ask_test.dart`（协议与状态）与 `accessibility_test.dart`
//    （那层确认的五档不溢出 ＋ 命中区 ≥44）。
//    这一份管的是另一件事：**那条链子到底有没有断在界面这一层**——
//    "服务端问了、控制器记住了、而屏幕上什么都没出来"是本仓库最常见的坏形状
//    （`busy_line` / `process_levels` 那几份同一条理由）。
//
// ⚠️ 不碰真网：那一层由 `ChatScreen` 收到**控制器里那一帧**之后弹出来，
//    这里就喂那一帧（和真那条路同一个入口 `ingest`）。

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/app_words.dart';
import 'package:hupo_app/models/conn_state.dart';
import 'package:hupo_app/models/job_words.dart';
import 'package:hupo_app/models/process_levels.dart';
import 'package:hupo_app/screens/chat_screen.dart';
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

/// 假的那条流：只记账（这条判据要的是"答话真发出去了没有"）。
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
  final List<(String, bool)> answers = [];
  @override
  void open({int sinceSeq = 0}) {}
  @override
  void focus(String scope, {int sinceSeq = 0}) => _focus = scope;
  @override
  bool answerJob(String id, {required bool yes}) {
    answers.add((id, yes));
    return true;
  }

  @override
  void close() {}
  @override
  Future<void> dispose() async {}
}

/// 一个"我的小程序"（自动打开那条路要它在清单里）。
const _appId = 'math-drill';

Future<(Widget, ChatController, _FakeStream)> _screen({String? appTitle}) async {
  final made = <_FakeStream>[];
  final api = Api(
    client: MockClient((r) async {
      if (r.url.path == '/api/apps') {
        return _json(
          jsonEncode({
            'apps': [
              {
                'id': _appId,
                'title': appTitle ?? '算数小练',
                'icon': 'calculate',
                'version': 1,
                'entryUrl': 'https://apps.example/math-drill/index.html?sig=x',
                'expiresAt': 0,
              },
            ],
          }),
        );
      }
      return _json('{}');
    }),
  );
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
  // ⚠️ **真起一遍**（`start`）：那条流是注进去的假货（判据要读它那本账），
  //    不起的话 `answerJobAsk` 会走"流没连着"那一档（那就验不成 C2/C3 了）。
  await c.start(token: 'tok');
  return (ChatScreen(controller: c, onLoggedOut: () {}), c, made.single);
}

/// 那一帧问话（服务端给的）。
Map<String, dynamic> _ask() => {
  'type': 'job/ask',
  'id': 'j_ask_1',
  'where': _appId,
  'why': '帮我做一个练算数的小程序',
  'text': '这件事要另开一处专门做吗？',
  'at': 7,
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  testWidgets('🔴 C1：收到那帧问话 ⇒ 屏幕上真的出**那一层确认 ＋ 两个按钮**', (tester) async {
    final (screen, c, _) = await _screen();
    await tester.pumpWidget(MaterialApp(home: screen));
    await tester.pump();

    c.ingest(_ask());
    await tester.pumpAndSettle();

    expect(find.text(jobAskTitle), findsOneWidget, reason: '🔴 服务端问了，而屏幕上什么都没出来');
    expect(find.text('这件事要另开一处专门做吗？'), findsOneWidget, reason: '★ 问话要照服务端给的显示');
    expect(find.text(jobAskWhyLine('帮我做一个练算数的小程序')), findsOneWidget, reason: '★ 他那句原话要看得见');
    expect(find.text(jobAskNewPlace), findsOneWidget, reason: '★ 【另开一处做】这个按钮没有');
    expect(find.text(jobAskHere), findsOneWidget, reason: '★ 【就在这儿做】这个按钮没有');
  });

  testWidgets('★ C2：点【另开一处做】⇒ 发出"答是"，那层确认收掉', (tester) async {
    final (screen, c, s) = await _screen();
    await tester.pumpWidget(MaterialApp(home: screen));
    await tester.pump();
    c.ingest(_ask());
    await tester.pumpAndSettle();

    await tester.tap(find.text(jobAskNewPlace));
    await tester.pumpAndSettle();

    expect(s.answers, [('j_ask_1', true)], reason: '★ 点了【另开一处做】却没发出"答是"');
    expect(find.text(jobAskNewPlace), findsNothing, reason: '★ 答完那层确认要收掉');
  });

  testWidgets('★ C3：点【就在这儿做】⇒ 发出"答否"', (tester) async {
    final (screen, c, s) = await _screen();
    await tester.pumpWidget(MaterialApp(home: screen));
    await tester.pump();
    c.ingest(_ask());
    await tester.pumpAndSettle();

    await tester.tap(find.text(jobAskHere));
    await tester.pumpAndSettle();

    expect(s.answers, [('j_ask_1', false)], reason: '★ 点了【就在这儿做】却没发出"答否"');
    expect(find.text(jobAskHere), findsNothing);
  });

  testWidgets('🔴 C5：他正开着那一间、那一格也在 ⇒ 做完**自动把它打开**（不用他点）', (tester) async {
    final (screen, c, _) = await _screen();
    await tester.pumpWidget(MaterialApp(home: screen));
    await tester.pumpAndSettle(); // 等 `/api/apps` 回来（清单里那一条）

    await c.setScope(_appId); // 他已经切到那一间（客户端收到 `scope/open` 之后做的事）
    await tester.pumpAndSettle();
    // 🔴 起点：**那一屏还没开**（否则下面那条断言是空的）。
    //   ⚠️ 判"开没开"看**小程序那一屏自己那句话**（VM 上跑不起来 ⇒ 它会说一句实话）：
    //      第一版量的是"聊天收起那个按钮在不在" —— 那个**开了也在、没开也在**
    //      （收起档本来就没有它）⇒ 那条断言是空的，变异验证时没红。
    expect(find.text(appRuntimeNotHere), findsNothing, reason: '起点：那一屏还没打开');

    c.ingest({
      'type': 'app/open',
      'app': _appId,
      'text': '做完了。它叫「算数小练」，在「算数小练」里看。',
      'at': 30,
      'scopeId': _appId,
    });
    await tester.pumpAndSettle();

    // ★ **判据本体**：那一屏真的开了（不用他点）
    expect(find.text(appRuntimeNotHere), findsOneWidget, reason: '🔴 只长出一格图标、没打开');
    // 负向对照：**旁边那句总结**也要看得见（浮窗里那条）
    expect(find.textContaining('做完了'), findsWidgets, reason: '★ 旁边那句总结没出来');
    // ⚠️ 浮窗那个"自己消失"的钟要收掉（留一个没走完的定时器本身就是一种失败）
    c.dispose();
  });

  testWidgets('🔴 C6：那一格**不在他清单里** ⇒ 不开（不猜、也不留一屏"找不到"）', (tester) async {
    final (screen, c, _) = await _screen(appTitle: '别的名字');
    await tester.pumpWidget(MaterialApp(home: screen));
    await tester.pumpAndSettle();

    await c.setScope(_appId);
    await tester.pumpAndSettle();

    c.ingest({
      'type': 'app/open',
      'app': 'not-mine-at-all',
      'text': '做完了。',
      'at': 30,
      'scopeId': _appId,
    });
    await tester.pumpAndSettle();

    // 认不出那一个 ⇒ 什么都不开（**不许**开一屏"找不到"）
    expect(find.text(appRuntimeNotHere), findsNothing, reason: '🔴 开了个不是他的东西（那是一屏"找不到"）');
    expect(c.takeOpenAppRequest(), isNull, reason: '★ 那一帧被界面那一层拿走了却没开');
    c.dispose(); // 浮窗那个钟收掉（同 C5）
  });
}
