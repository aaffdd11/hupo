// **一个图标 = 一条对话**（契约 `docs/dev/83-APP-WORKSPACE.md` §五·甲，主人亲口选的"甲"）
// **＋ C 期：焦点路由（一条连接）**（契约 `docs/dev/84-DISPATCHER-FOCUS.md` §三·3）。
//
// 这一份是**硬闸**（`test/unit`）：房间里那几件事全是"错了看起来也像对的"——
//
//   ① **房间怎么算**（纯函数）：桌面上 = `main`、打开"我的小程序" = 那个 app 的 id、
//      关掉 = 回 `main`；★ **内置那四个也各回自己的 id**（主人 2026-09-25：「要分家」，
//      见 `77-BLOCKERS.md` 的 B16 与 `models/scope.dart` 顶上那段）——
//      服务端 `worlds.js` 的 `BUILTIN_SCOPES` 把那四个名字登记成了合法房间。
//   ② **地址上带没带对**：那一次 say（body）、那一问老消息（`/api/timeline?scope=…`）。
//   ③ 🔴 **切房间不许把主线弄丢**（判据 A4）：这一条最贵 ——
//      丢了的话用户会觉得"切一趟图标，我原来那些话没了"（而没网时它再也回不来）。
//   ④ 🔴 **C 期 F2/F3**：切房间**不重连**（只发一帧焦点，带那一间自己的游标）；
//      不属于现在这一间的帧**不许落进来**（一条连接服务所有房间之后最容易踩的坑）。
//
// ⚠️ 不写界面断言（那是 `test/widget`，提示档）：这里只有纯逻辑与状态。

import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/app_spec.dart';
import 'package:hupo_app/models/conn_state.dart';
import 'package:hupo_app/models/process_levels.dart';
import 'package:hupo_app/models/scope.dart';
import 'package:hupo_app/models/timeline.dart';
import 'package:hupo_app/models/token_sub.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/stream.dart';
import 'package:hupo_app/services/timeline_store.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 假回执。⚠️ **必须带 `charset=utf-8`**（`http.Response` 默认按 latin1 编正文，
/// 正文里有中文就当场抛）；真服务端也是带 charset 的。
http.Response _json(String body, [int status = 200]) => http.Response(
  body,
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

/// **一条假的流**（只为判据存在）：它不开 socket，只**记账** ——
/// "造了几条 / 从哪个游标开的 / 切了几次焦点（每次带的哪一间、哪个游标）/ 有没有被收掉"。
///
/// ⚠️ 为什么不真连：真连一个口会把"这件事对不对"变成"这台机器网络快不快"，
///    而且真实的 `wss://` 在 VM 上根本连不上（`stream_uri.dart` 顶上那次事故
///    就是"闸打在另一侧"来的 —— 这一条打在**客户端自己造的那条连接**上）。
class _FakeStream implements StreamClient {
  _FakeStream({
    required this.base,
    required this.token,
    required this.api,
    required this.level,
    required scope,
  }) : _focus = scope;

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

  /// 判据要读的账（照真那一份的形状）。
  int _since = 0;
  @override
  int get sinceSeq => _since;

  int opens = 0;
  int openedWith = -1;
  bool closed = false;
  bool disposed = false;

  /// 每次 `focus()`：`(哪一间, 带的游标)`。
  final List<(String, int)> focuses = [];

  @override
  void open({int sinceSeq = 0}) {
    opens += 1;
    _since = sinceSeq;
    openedWith = sinceSeq;
  }

  /// ★ **C 期**：切焦点**不重连** —— 就是在这条连接上记一笔（真那一份会发一帧）。
  @override
  void focus(String scope, {int sinceSeq = 0}) {
    _focus = scope;
    _since = sinceSeq;
    focuses.add((scope, sinceSeq));
  }

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

/// 把这一串帧喂进**现在那一间**（和 `ingest` 同一条路）。
void _feed(ChatController c, List<Map<String, dynamic>> frames) {
  for (final e in frames) {
    c.ingest(e);
  }
}

/// 主线那两句（用户说 + 它的回答）。
List<Map<String, dynamic>> _mainFrames() => [
  {'type': 'user/echo', 'seq': 1, 'messageId': 'u1', 'text': '主线那句话'},
  {'type': 'message/start', 'seq': 2, 'messageId': 'm1'},
  {'type': 'message/text', 'seq': 3, 'messageId': 'm1', 'block': 'quick', 'text': '主线那句回答'},
];

int _countOf(List<TimelineItem> items, String text) =>
    items.where((i) => i is UserUtterance && i.text == text).length;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  // ── ① 房间怎么算（纯函数）────────────────────────────────────
  group('房间的解析与默认值（纯函数）', () {
    test('★ 桌面上（没打开任何小程序）⇒ `main`', () {
      expect(scopeOfOpenApp(null), mainScope);
      expect(mainScope, 'main', reason: '★ 这个名字是协议里写死的（不带 scope = main）');
    });

    test('★ 打开"我的小程序" ⇒ **那个 app 的 id**', () {
      expect(scopeOfOpenApp('mine:dice'), 'dice');
      expect(scopeOfOpenApp('mine:city-weather'), 'city-weather');
      // 前缀本身是 `models/scope.dart` 里那一个（不是谁在界面里现拼的）
      expect('mine:dice'.startsWith(mineAppPrefix), true);
    });

    test('★ B16-4：内置那四个 ⇒ **各回自己的 id**（每个图标一间房，不再落回主线）', () {
      // 🔴 与客户端 `app_spec.dart` 的 `builtIn*Id` 逐字对齐，也与服务端
      //    `worlds.js` 的 `BUILTIN_SCOPES` 逐字对齐。
      final expected = <String, String>{
        builtInSettingsId: 'settings',
        builtInMathId: 'math',
        builtInDiscoverId: 'discover',
        builtInHarnessId: 'harness',
      };
      expect(expected.length, 4, reason: '四个内置 id 不许有重的（重了 = 两个图标一间房）');
      expected.forEach((open, scope) {
        expect(scopeOfOpenApp(open), scope, reason: '★ 内置的「$open」就是它自己的房间');
        expect(scope, isNot(mainScope), reason: '★ 内置那四个**不再**落回主线');
        // 它必须是**服务端认得的形状**（小写字母数字与短横，`safeScope` 那条）
        expect(
          RegExp(r'^[a-z0-9][a-z0-9-]*$').hasMatch(scope),
          true,
          reason: '★ "$scope" 得是个合法 scope 的形状（不然服务端 404）',
        );
      });
      // **反例的正身**：把两间串起来就会红（比如设置映射成了奥数题）
      expect(
        scopeOfOpenApp(builtInSettingsId),
        isNot(scopeOfOpenApp(builtInMathId)),
        reason: '🔴 两间内置房间必须不同（串了 = 在设置里说的话跑到奥数题去）',
      );
      // **负向对照**："我的小程序"照旧回那个 app 的 id；认不出的写法回主线（不许现编）
      expect(scopeOfOpenApp('mine:dice'), 'dice');
      expect(scopeOfOpenApp(null), mainScope);
      expect(scopeOfOpenApp('whatever'), mainScope, reason: '★ 认不出 ⇒ 主线（宁回主线，也不许编一个房间名）');
    });

    test('★ 半截 id（`mine:` 后面空的）⇒ 回 `main`（不许造一个没有名字的房间）', () {
      expect(scopeOfOpenApp('mine:'), mainScope);
      expect(mineAppIdOf('mine:'), null);
      expect(mineAppIdOf('settings'), null);
      expect(mineAppIdOf(null), null);
    });

    test('★ 缓存一间一份：主对话**沿用老键**，别的房间各加一段', () {
      expect(scopedCacheNamespace('u1', mainScope), 'u1');
      expect(scopedCacheNamespace('u1', 'dice'), 'u1@dice');
      expect(
        scopedCacheNamespace('u1', mainScope),
        isNot(scopedCacheNamespace('u1', 'dice')),
        reason: '★ 主对话与小程序那一间不许共用一份缓存（共用 = 切一趟就互相覆写）',
      );
      // 兜底命名空间（读不出身份）也一样：至少两间不许撞
      expect(scopedCacheNamespace(cacheNamespaceFallback, 'dice'), 'single@dice');
    });
  });

  // ── ② 地址上带没带对 ────────────────────────────────────────
  group('说一句 / 翻老消息：都带着当前房间', () {
    test('★ `/api/say` 的 body 里带 scope，而且已有的字段一个都不少', () async {
      final seen = <http.Request>[];
      final api = Api(
        client: MockClient((r) async {
          seen.add(r);
          return _json(jsonEncode({'ok': true, 'duplicate': false, 'seq': 1}));
        }),
      );
      final c = ChatController(api: api, tokens: TokenStore(), token: 'tok');

      await c.send('在主线说一句');
      final mainBody = jsonDecode(seen.single.body) as Map;
      expect(mainBody['scope'], mainScope, reason: '★ 主线上说的一句，房间就是 main');
      expect(mainBody['text'], '在主线说一句');
      expect(mainBody['messageId'], isA<String>(), reason: '★ 已有字段的语义不许动（幂等靠它）');
      expect(mainBody.containsKey('clientAt'), true);

      await c.setScope('dice');
      await c.send('在骰子那一间说一句');
      expect(
        (jsonDecode(seen.last.body) as Map)['scope'],
        'dice',
        reason: '★ 换了房间，说出去的那一句必须跟着换（不然就是"我在 A 说的话跑进 B"）',
      );
    });

    test('★ `/api/timeline` 的地址上带 scope（翻老消息也在那一间里翻）', () async {
      final seen = <Uri>[];
      final api = Api(
        base: 'http://127.0.0.1:1',
        client: MockClient((r) async {
          seen.add(r.url);
          return _json(jsonEncode({'frames': <Object>[], 'hasMore': false}));
        }),
      );
      final c = ChatController(api: api, tokens: TokenStore(), token: 'tok');
      _feed(c, [
        {'type': 'user/echo', 'seq': 50, 'messageId': 'u1', 'text': '主线的一句'},
      ]);

      await c.setScope('dice');
      _feed(c, [
        {'type': 'user/echo', 'seq': 60, 'messageId': 'u2', 'text': '骰子那一间的一句'},
      ]);
      await c.loadOlder();

      expect(seen.single.path, '/api/timeline');
      expect(seen.single.queryParameters['scope'], 'dice', reason: '★ 在哪一间就翻哪一间的老话');
      expect(seen.single.queryParameters['before'], '60', reason: '游标也要跟着这一间（不许拿上一间的号）');
      expect(seen.single.queryParameters['limit'], isNotNull);
      // 令牌不进 URL（和从前同一条规矩）
      expect(seen.single.toString().contains('tok'), false);
    });
  });

  // ── ③ 那条流服务**所有**房间：切焦点不重连（C 期 F2/F3）──────────
  group('切房间 ⇒ **发焦点**（一条连接 · 不重连）', () {
    test('🔴 F2：一条连接不新建、不重开；焦点帧带的是**那一间自己的**游标', () async {
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
          final s = _FakeStream(
            base: base,
            token: token,
            api: api,
            level: level,
            scope: scope,
          );
          made.add(s);
          return s;
        },
      );

      await c.start(token: 'tok');
      expect(made.length, 1);
      expect(made.single.scope, mainScope, reason: '开机连的初始焦点是主对话那一间');
      expect(made.single.opens, 1);
      // 主线先有两句 ⇒ 主线那一间自己的游标 = 3
      _feed(c, _mainFrames());

      await c.setScope('dice');
      // 🔴 **判据本体**：一条连接 —— 没新建、旧那条没被收掉、也没重开
      expect(
        made.length,
        1,
        reason: '🔴 `scope` 还是连接级的旧形状 ⇒ 这里会变成 2（84 §八·3/4 明说不做）',
      );
      expect(made.single.disposed, false, reason: '★ 旧连接不许被收掉（连接不动）');
      expect(made.single.opens, 1, reason: '★ 不许重开（重开就是重连）');
      // 焦点帧发了，而且带的是 dice 那一间**自己的**游标（没来过 ⇒ 0）
      expect(made.single.focuses.map((f) => f.$1).toList(), ['dice']);
      expect(
        made.single.focuses.single.$2,
        0,
        reason: '★ 新房间没来过 ⇒ 带 0（服务端按那一间的视图把整段历史补过来）',
      );

      // 回主线：还是那条连接，带的是**主线自己**那个号（连续 —— 不是 0、也不是骰子那间的）
      await c.setScope(mainScope);
      expect(made.length, 1, reason: '🔴 切回来还是一条连接');
      expect(made.single.disposed, false);
      expect(made.single.opens, 1);
      expect(made.single.focuses.map((f) => f.$1).toList(), ['dice', mainScope]);
      expect(
        made.single.focuses.last.$2,
        3,
        reason: '★ `sinceSeq` 连续：回主线带的是它自己那个号',
      );

      // **反例的正身**：真按房间重连（旧形状）会新造一条 ⇒ 上面每一条 `made.length == 1` 全红
      expect(made.single.scope, mainScope);
    });

    test('★ 没在跑的流**不许顺手开一条**（还没登录完 / 判据里没开流）', () async {
      final made = <_FakeStream>[];
      final api = Api(base: 'http://127.0.0.1:1', client: MockClient((_) async => _json('{}')));
      final c = ChatController(
        api: api,
        tokens: TokenStore(),
        newStream: ({required base, required token, required level, required scope}) {
          final s = _FakeStream(
            base: base,
            token: token,
            api: api,
            level: level,
            scope: scope,
          );
          made.add(s);
          return s;
        },
      );
      await c.setScope('dice'); // 从没 start() 过
      expect(made, isEmpty, reason: '★ 没在跑就没有"重连"这回事（凭空开一条会去连一个不该连的地址）');
      expect(c.scope, 'dice', reason: '房间本身还是要换（本机那一屏、说出去的话都跟着换）');
    });
  });

  // ── ③b 焦点路由**客户端这一半**：不属于这一间的帧不许落进来 ──────
  group('焦点路由（客户端这一半 · C 期 F3）', () {
    test('🔴 `eventInScope`：主线 = 没标签 / `main`；房间 = 逐字等于它', () {
      expect(eventInScope({'scopeId': 'alpha'}, 'alpha'), true);
      expect(eventInScope({'scopeId': 'alpha'}, 'beta'), false, reason: '★ 甲房的事不许算进乙房');
      expect(eventInScope({}, mainScope), true, reason: '主线的事件**不带** `scopeId`（老字节）');
      expect(eventInScope({'scopeId': 'main'}, mainScope), true);
      expect(eventInScope({}, 'alpha'), false, reason: '★ 主线的事件不许落进房间（判据 A3）');
      expect(eventInScope({'scopeId': 'alpha'}, mainScope), false);
      // **反例的正身**：把"不看标签"那条旧形状写出来（一条连接只服务一间时的做法）
      // ⇒ 上面第 2、5 条会当场红 —— 那正是"甲房的话出现在乙房"的样子
      bool oldShape(Map<String, dynamic> _) => true;
      expect(oldShape({'scopeId': 'alpha'}), true);
      expect(oldShape({}), true);
    });

    test('🔴 切焦点之后，上一间补发过来的帧**不许**落进这一间', () async {
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
      final s = made.single;
      await c.setScope('alpha');
      await c.setScope('beta'); // 用户手快，连着切两下

      // "服务端"把**甲房**的补发推过来（切焦点时它已经在路上了）
      s.push({'type': 'user/echo', 'seq': 11, 'messageId': 'ua', 'text': '甲房的话', 'scopeId': 'alpha'});
      await Future<void>.delayed(Duration.zero);
      expect(
        _countOf(c.items, '甲房的话'),
        0,
        reason: '🔴 上一间的帧落进了乙这一间（屏幕上就是"别人的话"）',
      );
      // 负向对照：属于**现在这一间**的照收（证明上面不是"什么都不收"）
      s.push({'type': 'user/echo', 'seq': 12, 'messageId': 'ub', 'text': '乙房的话', 'scopeId': 'beta'});
      await Future<void>.delayed(Duration.zero);
      expect(_countOf(c.items, '乙房的话'), 1);
      expect(c.scope, 'beta');
      // 而主线那间**一个字都没被污染**
      await c.setScope(mainScope);
      expect(_countOf(c.items, '甲房的话'), 0);
      expect(_countOf(c.items, '乙房的话'), 0);
    });

    test('🔴 切焦点那一段历史**不许**当成"现在"：补发期间不弹浮窗、确认之后才弹', () async {
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
      final s = made.single;
      c.ingest({'type': '__caught_up__'}); // 首屏那段历史读完了（真实路径上服务端一定发）
      await c.setScope('dice'); // 切焦点 ⇒ 接下来那一段是**那一间的历史**

      // "服务端"把那一间的历史发过来（头一回进那一间 ⇒ 服务端给的是全量历史）
      s.push({
        'type': 'notice',
        'kind': 'expiring',
        'text': '很久以前那件事',
        'at': 1758400000000,
        'seq': 30,
        'scopeId': 'dice',
      });
      await Future<void>.delayed(Duration.zero);
      expect(
        c.notice,
        isNull,
        reason: '🔴 切焦点那一段历史被当成"现在"弹出来了（就是冷启动那种骚扰 + 假话）',
      );

      // 服务端说"那一间的历史发完了"（内部信号，来自 `client/focus`）
      s.push({'type': '__focus_ready__'});
      await Future<void>.delayed(Duration.zero);
      // 之后来的才算"现在发生的"
      s.push({
        'type': 'notice',
        'kind': 'expiring',
        'text': '刚刚那件事',
        'at': 1758400000001,
        'seq': 31,
        'scopeId': 'dice',
      });
      await Future<void>.delayed(Duration.zero);
      expect(c.notice, isNotNull, reason: '★ 确认之后的通知该弹还是得弹（别修过头）');
      expect(c.notice!.text, '刚刚那件事');
      c.dispose();
    });
  });

  // ── ④ 🔴 切房间不许把主线弄丢（判据 A4）─────────────────────
  group('切房间不丢主线（判据 A4）', () {
    test('🔴 主线那两句**一个字节都不许丢**，而且两间互不串', () async {
      final c = ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore());
      _feed(c, _mainFrames());
      expect(c.items.length, 2, reason: '主线：一句用户的话 + 它那句回答');
      expect(c.scope, mainScope);

      // 进小程序那一间
      await c.setScope('dice');
      expect(c.scope, 'dice');
      expect(_countOf(c.items, '主线那句话'), 0, reason: '★ 主线的话不许露到小程序那一间');
      _feed(c, [
        {'type': 'user/echo', 'seq': 9, 'messageId': 'u9', 'text': '骰子那一间那句话'},
      ]);
      expect(_countOf(c.items, '骰子那一间那句话'), 1);

      // 退回桌面
      await c.setScope(mainScope);
      expect(c.scope, mainScope);
      expect(_countOf(c.items, '主线那句话'), 1, reason: '★ 回到桌面必须还看得见主线原来那句');
      expect(c.items.length, 2, reason: '★ 主线的两句都还在（判据 A4）');
      expect(_countOf(c.items, '骰子那一间那句话'), 0, reason: '★ 小程序那一间的话不许露到主线');

      // 再去 A 间：它那一句也还在（不是单向的）
      await c.setScope('dice');
      expect(_countOf(c.items, '骰子那一间那句话'), 1, reason: '★ 那一间自己也留着');
      expect(c.items.length, 1);
    });

    test('🔴 连着切两个房间（第一间还没读完）⇒ 缓存不许串，没读成的那间下次要重读', () async {
      // 先把 A 间的一屏**直接写进盘**（模拟"他上次来过那一间"）——
      // A 间这一次是**第一次**在内存里建，所以必然会去读盘。
      const aLine = 'a 间那句';
      final seed = TimelineStore(namespace: 'single@a');
      await seed.save([
        {'type': 'user/echo', 'seq': 5, 'messageId': 'ua', 'text': aLine},
      ]);
      await seed.flush();

      final c = ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore());
      // ⚠️ **不 await 第一个** —— 它正卡在读盘那一步时第二个已经切过去了。
      //    这正是"用户手快，连着点两个图标"的形状。
      final first = c.setScope('a');
      final second = c.setScope('b');
      await first;
      await second;

      expect(c.scope, 'b');
      expect(_countOf(c.items, aLine), 0, reason: '★ A 间读出来的那一屏**不许**落进 B 间');
      // 而 A 间那一份**没读成**（房间被换掉了）⇒ 切回去必须重新读一遍：
      // 不重读的话，那一间会**永远空着**（直到流把它补回来，而没网时补不回来）。
      await c.setScope('a');
      expect(_countOf(c.items, aLine), 1, reason: '★ 没读成的那一间，下次切回来必须补上');
    });

    test('★ 本机缓存**一间一份**：小程序那一间不许把主线那份覆写掉', () async {
      final c = ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore());
      final mainKey = '${TimelineStore.keyPrefix}single';
      _feed(c, _mainFrames());
      await c.local.flush();
      final p = await SharedPreferences.getInstance();
      expect(p.getStringList(mainKey), isNotNull, reason: '★ 主对话的缓存还在**老键**上（升级那一下不许白屏）');

      await c.setScope('dice');
      expect(c.local.namespace, 'single@dice', reason: '★ 小程序那一间自己一份（按 scope 分）');
      final mainSaved = p.getStringList(mainKey)!.length;
      expect(mainSaved, greaterThan(0), reason: '★ 主线确实落了盘（不然下面那条比的是空）');
      _feed(c, [
        {'type': 'user/echo', 'seq': 9, 'messageId': 'u9', 'text': '骰子那一间那句话'},
      ]);
      await c.local.flush();
      expect(p.getStringList('${TimelineStore.keyPrefix}single@dice'), isNotNull);
      expect(
        p.getStringList(mainKey)!.length,
        mainSaved,
        reason: '★ 主线那一屏**不许**被新房间覆写掉（一条都不许多、一条都不许少）',
      );

      await c.setScope(mainScope);
      expect(c.local.namespace, 'single', reason: '回主线 ⇒ 键也回老那个');
    });

    test('★ 退出登录 ⇒ **丢掉所有房间**，而且回到主线那一间', () async {
      final c = ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore());
      _feed(c, _mainFrames());
      await c.setScope('dice');
      _feed(c, [
        {'type': 'user/echo', 'seq': 9, 'messageId': 'u9', 'text': '骰子那一间那句话'},
      ]);
      expect(c.items.length, 1);

      await c.logout();
      expect(c.scope, mainScope, reason: '★ 下一个人进来看到的是**桌面上那条**（不是上一位开着的那个小程序）');
      expect(c.items, isEmpty, reason: '★ 所有房间一起丢（共用设备那条规矩）');
      expect(c.local.namespace, 'single');
    });
  });
}
