// **派活那一步的体验：先问一句 · 切过去像没切 · 做完自动给我看**
// （契约 `docs/dev/108-JOB-ASK-FLOW.md` §一 那四步 / §二 C1–C6）。
//
// 这一份是**硬闸**（`test/unit`）：这一族里"错了看起来也像对的"太多了 ——
//
//   C1 收到那帧问话 ⇒ 出确认层 ＋ 两个按钮（文案住一处表）；
//   C2 点【另开一处做】⇒ 发出"答是" ⇒ 之后**窗口自己切过去**（既有 `scope/open` 那条路）；
//   C3 点【就在这儿做】⇒ 发出"答否"、**不切房间**；
//   C4 🔴 **切过去之后那一屏看得见他那句原话**（"接着往下"）——而且**盘上不多一份**；
//   C5 做完且他正开着那一间 ⇒ **自动把那个东西打开**（"点开图标"那条路）；
//   C6 他不在那一间时**不许**自动打开（不抢屏）。
//
// ⚠️ 不写"画到屏幕上了没有"那种断言（那是 `test/widget`，提示档）：
//    这里只有纯逻辑与状态。
// ⚠️ 那一层确认**长什么样**（两个按钮 ≥44、五档不溢出）在
//    `test/widget/accessibility_test.dart` 那两道硬闸里。

import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/conn_state.dart';
import 'package:hupo_app/models/forbidden_words.dart';
import 'package:hupo_app/models/job_ask.dart';
import 'package:hupo_app/models/job_words.dart';
import 'package:hupo_app/models/process_levels.dart';
import 'package:hupo_app/models/scope.dart';
import 'package:hupo_app/models/timeline.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/stream.dart';
import 'package:hupo_app/services/timeline_store.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 假回执。⚠️ **必须带 `charset=utf-8`**（中文正文在 `http.Response` 里按 latin1 编会抛）。
http.Response _json(String body, [int status = 200]) => http.Response(
  body,
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

/// **一条假的流**（只为判据存在）：不开 socket，只记账 ——
/// "切了几次焦点 / 答了几次话 / 有没有被收掉"。
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

  int _since = 0;
  @override
  int get sinceSeq => _since;

  int opens = 0;
  bool closed = false;
  bool disposed = false;

  /// 每次 `focus()`：`(哪一间, 带的游标)`。
  final List<(String, int)> focuses = [];

  /// ★ **答话那一帧发了没有**：每次 `(号, 是/否)`。
  final List<(String, bool)> answers = [];

  @override
  void open({int sinceSeq = 0}) {
    opens += 1;
    _since = sinceSeq;
  }

  @override
  void focus(String scope, {int sinceSeq = 0}) {
    _focus = scope;
    _since = sinceSeq;
    focuses.add((scope, sinceSeq));
  }

  @override
  bool answerJob(String id, {required bool yes}) {
    if (id.trim().isEmpty) return false;
    answers.add((id.trim(), yes));
    return !closed;
  }

  /// ★ **契约 117**：撤掉排队里那一句（走同一条流）。判据要读得到"发了没有、发的什么"。
  @override
  bool unsay(String messageId) {
    if (messageId.trim().isEmpty) return false;
    unsays.add(messageId.trim());
    return !closed;
  }

  /// 判据要读的账：每次撤一句（号）。
  final List<String> unsays = [];

  /// 判据用：从"服务端"推一帧进来（走和真那条一样的入口）。
  void push(Map<String, dynamic> e) => _events.add(e);

  @override
  void close() => closed = true;

  @override
  Future<void> dispose() async {
    disposed = true;
    await _events.close();
    await _states.close();
  }
}

/// 起一台控制器（那条流是假的：判据要读它那本账）。
Future<(ChatController, _FakeStream)> up() async {
  final made = <_FakeStream>[];
  final api = Api(
    client: MockClient((r) async {
      if (r.url.path == '/api/renew') {
        return _json(jsonEncode({'token': 'tok2', 'expiresAt': 9000000000000}));
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
  await c.start(token: 'tok');
  c.ingest({'type': '__caught_up__'}); // 首屏那段历史读完了（真实路径上一定发）
  return (c, made.single);
}

/// 那一帧问话（服务端给的一句 ＋ 他说的那句原话）。
Map<String, dynamic> _askFrame({String id = 'j_ask_1', String why = '帮我做一个练算数的小程序'}) => {
  'type': 'job/ask',
  'id': id,
  'where': 'math-drill',
  'why': why,
  'text': '这件事要另开一处专门做吗？',
  'at': 7,
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  // ── C1 · 收到那帧问话 ⇒ 出确认层 ＋ 两个按钮 ────────────────────
  group('C1：收到那帧问话 ⇒ 那一层确认（文案住一处表 · 两个按钮都有字）', () {
    test('★ `job/ask` ⇒ `pendingJobAsk` 里是**服务端给的那句**＋他那句原话', () async {
      final (c, s) = await up();
      c.ingest(_askFrame());

      final ask = c.pendingJobAsk;
      expect(ask, isNotNull, reason: '★ 收到问话却没出那层确认（他根本不知道要答什么）');
      expect(ask!.id, 'j_ask_1', reason: '★ 号要留着 —— 答话时原样带回去');
      expect(ask.text, '这件事要另开一处专门做吗？', reason: '★ 问话**照抄服务端**（不许自己拼一句）');
      expect(ask.why, '帮我做一个练算数的小程序', reason: '★ 他那句原话要看得见');
      expect(s.focuses, isEmpty, reason: '★ 还没答 ⇒ 一个房间都不许切');
    });

    test('🔴 那是**瞬态**：不进时间线、不占号（重放时会再问一遍）', () async {
      final (c, s) = await up();
      s.push({..._askFrame(), 'seq': 9});
      await pumpEventQueue();

      expect(c.items, isEmpty, reason: '★ 它混进历史了 ⇒ 重放（`sinceSeq=0`）会把问题再弹一遍');
      expect(c.timeline.lastSeq, 0, reason: '★ 瞬态不许占号');
    });

    test('★ 两个按钮的文案在**那一张表**里，而且过禁用词扫描', () {
      // 🔴 摆在界面里的字符串，禁用词硬闸够不着 ⇒ 文案必须住 `models/job_words.dart`。
      for (final line in [
        jobAskTitle,
        jobAskNewPlace,
        jobAskHere,
        jobAskWhyLine('帮我做一个练算数的小程序'),
        jobAskExpiredFallback,
        jobAskExpiredTitle,
        jobAskFailedLine,
      ]) {
        expect(scanForbidden(line), isEmpty, reason: '禁用词上了屏：$line');
      }
      expect(jobAskNewPlace, '另开一处做', reason: '★ 主人原话就是这两个按钮');
      expect(jobAskHere, '就在这儿做');
      expect(jobAskNewPlace == jobAskHere, false, reason: '两个按钮不许一模一样（按哪个都分不出来）');
    });

    test('★ 读不全的那一帧 ⇒ **不猜**（没有号 / 没有问话都不出那层确认）', () {
      expect(jobAskOf({'type': 'job/ask', 'text': '问一句'}), isNull, reason: '★ 没有号 ⇒ 答不回去');
      expect(jobAskOf({'type': 'job/ask', 'id': 'x'}), isNull, reason: '★ 没有问题 ⇒ 屏上是个空框');
      expect(jobAskOf({'type': '别的'}), isNull);
      expect(jobAskOf(null), isNull);
      expect(
        jobAskOf({'type': 'job/ask', 'id': 'x', 'text': '问一句'})!.why,
        '',
        reason: '★ 服务端没给原话 ⇒ 空串（**不编**一句"你要做一个东西"）',
      );
    });
  });

  // ── C2 / C3 · 两个按钮各发什么、之后切不切 ──────────────────────
  group('C2/C3：答【另开一处做】/【就在这儿做】', () {
    test('★ 答【是】⇒ 发出去的是"答是"，**这一层不自己切房间**（等服务端那一帧）', () async {
      final (c, s) = await up();
      s.push(_askFrame());
      await pumpEventQueue();

      c.answerJobAsk(yes: true);
      expect(s.answers, [('j_ask_1', true)], reason: '★ 点了没发出"答是"');
      expect(c.pendingJobAsk, isNull, reason: '★ 答了之后那层确认要收掉');
      expect(c.scope, mainScope, reason: '★ 客户端**不许自己切**（切过去只认服务端那一帧）');

      // 服务端建好之后推那一帧 ⇒ 这时才切（**既有那条路**）
      s.push({'type': 'scope/open', 'scope': 'math-drill', 'at': 8});
      await pumpEventQueue();
      expect(c.scope, 'math-drill', reason: '★ 窗口没跟过去');
      expect(s.opens, 1, reason: '★ 切房间不许重连（一条连接服务所有房间）');
      expect(s.focuses.map((f) => f.$1).toList(), ['math-drill']);
    });

    test('🔴 答【否】⇒ 发出去的是"答否"，而且**房间一动不动**', () async {
      final (c, s) = await up();
      s.push(_askFrame());
      await pumpEventQueue();

      c.answerJobAsk(yes: false);
      expect(s.answers, [('j_ask_1', false)], reason: '★ 点了没发出"答否"');
      expect(c.pendingJobAsk, isNull);
      expect(s.focuses, isEmpty, reason: '🔴 答"否"也把房间切了（活还在主对话里做，切走就看不见了）');
      expect(c.scope, mainScope);
    });

    test('🔴 流没连着 ⇒ **如实说一句**，那层确认**留着**（不是"按了没反应"）', () async {
      final c = ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore(), token: 'tok');
      c.ingest(_askFrame()); // 没有流（`openStream:false` 那条路）
      c.answerJobAsk(yes: true);

      expect(c.lastError, jobAskFailedLine, reason: '★ 没送出去却不说（N11：拒绝必须给人话）');
      expect(scanForbidden(c.lastError!), isEmpty);
      expect(c.pendingJobAsk, isNotNull, reason: '★ 留着才能再来一次；收掉就等于把这一笔丢了');
    });

    test('★ 回执：收下了就安静；没收下 ⇒ **照抄服务端那句人话**', () async {
      final (c, s) = await up();
      s.push(_askFrame());
      await pumpEventQueue();
      c.answerJobAsk(yes: true);

      s.push({'type': 'job/answer-ack', 'id': 'j_ask_1', 'ok': true, 'yes': true, 'at': 9});
      await pumpEventQueue();
      expect(c.lastError, isNull, reason: '★ 收下了就该安静（不是"又报一句"）');

      // 号码对不上的回执**不许**当成自己的（那是别人/别的时刻的事）
      s.push({'type': 'job/answer-ack', 'id': 'j_ask_其他的', 'ok': false, 'text': '那件事我还没动手。', 'at': 10});
      await pumpEventQueue();
      expect(c.lastError, isNull, reason: '★ 别的号的回执被当成了自己的');
    });

    test('★ 没收下的回执 ⇒ 那句人话到得了状态条（照抄服务端给的）', () async {
      final (c, s) = await up();
      s.push(_askFrame());
      await pumpEventQueue();
      c.answerJobAsk(yes: true); // 先答（那层确认收了，但那一笔还等回执）

      s.push({'type': 'job/answer-ack', 'id': 'j_ask_1', 'ok': false, 'text': '那件事我还没动手。', 'at': 9});
      await pumpEventQueue();
      expect(c.lastError, '那件事我还没动手。');
      expect(scanForbidden(c.lastError!), isEmpty);
    });

    test('🔴 超时那一帧（`job/ask-expired`）⇒ 那层确认收掉 ＋ 如实说一句', () async {
      final (c, s) = await up();
      s.push(_askFrame());
      await pumpEventQueue();
      expect(c.pendingJobAsk, isNotNull);

      s.push({'type': 'job/ask-expired', 'id': 'j_ask_1', 'text': '那件事我还没动手。', 'at': 9});
      await pumpEventQueue();
      expect(c.pendingJobAsk, isNull, reason: '★ 作废了那层确认还挂着 ⇒ 他答了也没用（按了不会有结果）');
      expect(c.lastError, '那件事我还没动手。', reason: '★ 不许猜、也不许静默');
      expect(scanForbidden(c.lastError!), isEmpty);
    });

    test('★ 号对不上的作废帧 ⇒ 不许把**现在这一笔**收掉', () async {
      final (c, s) = await up();
      s.push(_askFrame());
      await pumpEventQueue();

      s.push({'type': 'job/ask-expired', 'id': 'j_ask_别的', 'text': '那件事我还没动手。', 'at': 9});
      await pumpEventQueue();
      expect(c.pendingJobAsk, isNotNull, reason: '★ 作废的是那一笔，不是"所有的问话"');
    });
  });

  // ── C4 · 「接着往下」：切过去先看得见他那句原话 ─────────────────
  group('C4：切过去之后那一屏**先看得见他那句原话**（而且盘上不多一份）', () {
    /// 主对话里他先说了一句（真那条路：`user/echo` ⇒ `confirmed`）。
    Future<(ChatController, _FakeStream)> withSaid() async {
      final (c, s) = await up();
      s.push({'type': 'user/echo', 'seq': 1, 'messageId': 'u1', 'text': '帮我做一个练算数的小程序'});
      await pumpEventQueue();
      expect(c.items.length, 1);
      return (c, s);
    }

    test('★ 答【是】⇒ 切过去之后那一屏**有他那句原话**（排在这一间那些条目之前）', () async {
      final (c, s) = await withSaid();
      s.push(_askFrame());
      await pumpEventQueue();
      c.answerJobAsk(yes: true);
      s.push({'type': 'scope/open', 'scope': 'math-drill', 'at': 8});
      await pumpEventQueue();
      // 那一间自己也有东西（子进程的过程）
      s.push({'type': 'message/start', 'seq': 20, 'messageId': 'm9', 'scopeId': 'math-drill'});
      s.push({
        'type': 'message/text',
        'seq': 21,
        'messageId': 'm9',
        'block': 'quick',
        'text': '我先把页面写出来。',
        'scopeId': 'math-drill',
      });
      await pumpEventQueue();

      final texts = c.items.whereType<UserUtterance>().map((u) => u.text).toList();
      expect(texts, contains('帮我做一个练算数的小程序'), reason: '🔴 切过去只有空屏（"像没切"就没了）');
      expect(c.items.first, isA<UserUtterance>(), reason: '★ 他那句原话要**排在最前面**（接着往下）');
      expect(c.items.length, greaterThan(1), reason: '★ 这一间自己的过程照旧在后面');
    });

    test('🔴 **不许复制事实**：那一份只在内存里（不进时间线、不进本机缓存）', () async {
      final (c, s) = await withSaid();
      s.push(_askFrame());
      await pumpEventQueue();
      c.answerJobAsk(yes: true);
      s.push({'type': 'scope/open', 'scope': 'math-drill', 'at': 8});
      await pumpEventQueue();
      // 那一间自己也落一条（这样本机缓存那一份才真的会被写出来）
      s.push({'type': 'user/echo', 'seq': 20, 'messageId': 'u9', 'text': '那一间自己的一句', 'scopeId': 'math-drill'});
      await pumpEventQueue();
      await c.local.flush();

      expect(
        c.timeline.items.whereType<UserUtterance>().map((u) => u.text).toList(),
        isNot(contains('帮我做一个练算数的小程序')),
        reason: '🔴 那条是**主对话**的事实，不许写进这一间的时间线（两个家）',
      );
      final p = await SharedPreferences.getInstance();
      final saved = p.getStringList('${TimelineStore.keyPrefix}single@math-drill') ?? const <String>[];
      expect(
        saved.any((l) => l.contains('帮我做一个练算数的小程序')),
        false,
        reason: '🔴 它在盘上被写了第二份（一条事实一个家）',
      );
      // ★ 反例的正身：那一间自己那条**确实落了盘**（上面那条不是"什么都没存"）
      expect(saved.any((l) => l.contains('那一间自己的一句')), true);
      // 回主对话：原来那句照旧在（**一个字节都没丢**）
      await c.setScope(mainScope);
      expect(c.items.whereType<UserUtterance>().map((u) => u.text), contains('帮我做一个练算数的小程序'));
      c.dispose();
    });

    test('★ 答【否】⇒ 没有"带过去"这回事（那一句本来就在主对话里）', () async {
      final (c, s) = await withSaid();
      s.push(_askFrame());
      await pumpEventQueue();
      c.answerJobAsk(yes: false);
      s.push({'type': 'scope/open', 'scope': 'math-drill', 'at': 8}); // 真那条路上不会有
      await pumpEventQueue();
      await c.setScope(mainScope);
      expect(c.items.whereType<UserUtterance>().length, 1);
      expect(c.items.whereType<UserUtterance>().single.text, '帮我做一个练算数的小程序');
      c.dispose();
    });
  });

  // ── C5 / C6 · 做完自动给他看（他不在那一间不许抢屏）──────────────
  group('C5/C6：做完 ⇒ 他正开着那一间才**自动把它打开**', () {
    test('★ 他正开着那一间 ⇒ 自动打开（走"点开图标"那条路）＋ 旁边留一句总结', () async {
      final (c, s) = await up();
      await c.setScope('math-drill');
      final frame = {
        'type': 'app/open',
        'app': 'math-drill',
        'text': '做完了。做成了一个能出题的算数小程序。它叫「算数小练」，在「算数小练」里看。',
        'at': 30,
        'scopeId': 'math-drill',
      };
      s.push(frame);
      await pumpEventQueue();

      expect(c.takeOpenAppRequest(), 'math-drill', reason: '🔴 只长出一格图标、不打开 —— 主人要的是"自动给我看"');
      expect(c.takeOpenAppRequest(), isNull, reason: '★ 只自动打开**一次**（不然每次重绘都抢一次屏）');
      expect(c.notice, isNotNull, reason: '★ 旁边那句总结要看得见');
      expect(c.notice!.text, contains('做完了'), reason: '★ 那句话**照抄服务端给的**');
      c.dispose();
    });

    test('🔴 他不在那一间 ⇒ **一帧都不认**（不许抢屏）', () async {
      final (c, s) = await up();
      // 他还停在主对话，而服务端推来的是**别的那一间**的一帧。
      // ⚠️ 这里**走 `ingest`**（不是 `s.push`）：那条流自己那一层过滤
      //    （`chat_controller` 订阅处那个 `eventInScope`）是**另外一道**，
      //    它由 `scope_test.dart` 的"上一间的帧不许落进来"钉着；
      //    这一条要钉的是**这一层收下之后还认不认**。
      c.ingest({
        'type': 'app/open',
        'app': 'math-drill',
        'text': '做完了。',
        'at': 30,
        'scopeId': 'math-drill',
      });
      await pumpEventQueue();

      expect(c.takeOpenAppRequest(), isNull, reason: '🔴 他不在那一间，却把屏抢了');
      expect(c.notice, isNull, reason: '★ 连那句话都不该冒出来');
      c.dispose();
    });

    test('★ 那一帧也**不落盘、不进时间线**（总结的家只有主进程那一条）', () async {
      final (c, s) = await up();
      await c.setScope('math-drill');
      s.push({
        'type': 'app/open',
        'app': 'math-drill',
        'text': '做完了。做成了一个小程序。',
        'at': 30,
        'seq': 44,
        'scopeId': 'math-drill',
      });
      await pumpEventQueue();
      expect(c.timeline.lastSeq, 0, reason: '★ 瞬态不许占号');
      expect(c.items, isEmpty, reason: '★ 它进了时间线 ⇒ 那一间里多出第二份总结（两个家）');
      c.dispose();
    });
  });
}
