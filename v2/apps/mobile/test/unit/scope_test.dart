// **一个图标 = 一条对话**（契约 `docs/dev/83-APP-WORKSPACE.md` §五·甲，主人亲口选的"甲"）。
//
// 这一份是**硬闸**（`test/unit`）：房间里那几件事全是"错了看起来也像对的"——
//
//   ① **房间怎么算**（纯函数）：桌面上 = `main`、打开"我的小程序" = 那个 app 的 id、
//      关掉 = 回 `main`；★ **内置那四个也各回自己的 id**（主人 2026-09-25：「要分家」，
//      见 `77-BLOCKERS.md` 的 B16 与 `models/scope.dart` 顶上那段）——
//      服务端 `worlds.js` 的 `BUILTIN_SCOPES` 把那四个名字登记成了合法房间。
//   ② **地址上带没带对**：那条流（`?scope=…`，还不许带令牌）、那一次 say（body）、
//      那一问老消息（`/api/timeline?scope=…`）。
//   ③ 🔴 **切房间不许把主线弄丢**（判据 A4）：这一条最贵 ——
//      丢了的话用户会觉得"切一趟图标，我原来那些话没了"（而没网时它再也回不来）。
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
/// "造了几条 / 每一条带的是哪个 scope / 从哪个游标开的 / 有没有被收掉"。
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
    required this.scope,
  });

  @override
  final String base;
  @override
  final String token;
  @override
  final Api api;
  @override
  final ProcessLevel level;
  @override
  final String scope;
  @override
  Duration get pingTimeout => const Duration(seconds: 60);
  @override
  Future<TokenProbe> Function(String token)? get probe => null;

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
  int get sinceSeq => _since;
  int _since = 0;

  int opens = 0;
  int openedWith = -1;
  bool closed = false;
  bool disposed = false;

  @override
  void open({int sinceSeq = 0}) {
    opens += 1;
    _since = sinceSeq;
    openedWith = sinceSeq;
  }

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

  // ── ③ 那条流跟着房间走 ──────────────────────────────────────
  group('切房间 ⇒ 重连那条流（连接级）', () {
    test('🔴 旧连接收掉、新连接带的是**新房间**、从**那一间自己的游标**续', () async {
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
      expect(made.single.scope, mainScope, reason: '开机连的是主对话那一间');
      expect(made.single.opens, 1);

      await c.setScope('dice');
      expect(made.length, 2, reason: '★ `scope` 是连接级的 ⇒ 切房间**必须重连**');
      expect(made[0].disposed, true, reason: '★ 旧那条要收干净（不然两间的话会同时进同一个屏幕）');
      expect(made[1].scope, 'dice', reason: '★ 新连接带的必须是新房间');
      expect(made[1].opens, 1, reason: '新连接要真的开起来');

      // 回主线 ⇒ 再一次重连，而且仍然带 `main`
      await c.setScope(mainScope);
      expect(made.length, 3);
      expect(made[1].disposed, true);
      expect(made[2].scope, mainScope);
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
