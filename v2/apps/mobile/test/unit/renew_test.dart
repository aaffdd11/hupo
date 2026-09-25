// 令牌续期（欠账 13 · 决策 A）—— 客户端这一半。
//
// 服务端已经做好了：`POST /api/renew`，头里带当前令牌，就换一个新的回来
// （`exp` 往后挪）。策略"空闲窗 + 绝对上限"住在服务端，客户端**不复制那几个天数**。
//
// ⚠️ 这一份钉的是**三条不许混的路**（混错的代价是"网络抖一下就把人踢回登录页"）：
//   1. **200** ⇒ 新令牌**存下来**、并且被接下来的请求/连流用上；
//   2. **401** ⇒ 这个令牌没得续了 ⇒ 清令牌 + 回登录页（**唯一**该清的情形）；
//   3. **网的问题 / 回执读不出来** ⇒ **一个字节都不许清**，拿旧令牌照常往下走。
//
// ⚠️ 还有一条顺序（`17-LOCAL-FIRST.md` 的教训）：
//    续期要等网络（最长 8 秒），**不许挡在"先画本机一屏"前面**。
//    ⇒ `ChatController.start()` 里的顺序是：先画本机 ⇒ 再续期 ⇒ 再连流。
//
// ⚠️ 不写界面断言（项目纪律：纯逻辑进 `test/unit`）。
//    这里只用：纯函数逐码对表、`TokenStore`/`TimelineStore` 的存取、
//    控制器的公开入口、禁用词扫描 —— **不开真 socket**（`openStream: false`）。

import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/conn_state.dart';
import 'package:hupo_app/models/forbidden_words.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/timeline_store.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _renewPath = '/api/renew';

/// 本机那一屏里的一条**服务端事实**（带号才进缓存）。
Map<String, dynamic> _fact(int seq, [String type = 'message/text']) => {
      'type': type,
      'seq': seq,
      'messageId': 'm1',
      if (type == 'message/text') 'text': '第 $seq 句',
    };

/// 一条"服务端都在、续期按剧本回"的假服务端。
/// MockClient 只把那一次 HTTP 换成一个常量响应，**不开端口、不碰真网**。
MockClient _server({
  required Future<http.Response> Function(http.Request r) renew,
  Future<http.Response> Function(http.Request r)? other,
}) =>
    MockClient((r) async {
      if (r.url.path == _renewPath) return renew(r);
      return (other ?? (_) async => http.Response('{"ok":true,"duplicate":false,"seq":5}', 200))(r);
    });

http.Response _ok(String token) =>
    http.Response('{"token":"$token","expiresAt":1789000000000}', 200);

http.Response _expired() => http.Response('{"error":"expired"}', 401);

/// 头名大小写在各个实现里不一样，读的时候两种都认。
String? _authOf(http.Request r) => r.headers['authorization'] ?? r.headers['Authorization'];

ChatController _controller({
  required MockClient client,
  void Function()? onUnauthorized,
  TokenStore? tokens,
  TimelineStore? local,
}) {
  final c = ChatController(
    api: Api(client: client),
    tokens: tokens ?? TokenStore(),
    token: 'old',
    local: local,
    onUnauthorized: onUnauthorized,
  );
  addTearDown(c.dispose);
  return c;
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('回执 → 结果（纯函数，逐码对表）', () {
    test('🔴 200 且读得出 token + expiresAt ⇒ 换到了新的（该存、该用）', () {
      final o = renewOutcomeOf(200, jsonEncode({'token': 'new', 'expiresAt': 1789000000000}));
      expect(o, isA<RenewOk>());
      expect((o as RenewOk).token, 'new');
      expect(o.expiresAt, 1789000000000, reason: '过期时刻也要读回来（不是摆设）');
      expect(renewActionOf(o), RenewAction.useNewToken);
    });

    test('🔴 401 ⇒ 这个令牌没得续了：**唯一**该清令牌的那一档', () {
      final o = renewOutcomeOf(401, '{"error":"expired"}');
      expect(o, isA<RenewExpired>(), reason: '过期 / 被撤销 / 过了绝对上限都走这里');
      expect(renewActionOf(o), RenewAction.logout);
    });

    test('🔴 其它码（5xx / 429…）⇒ 当网络问题：可重试，**绝不**回登录页', () {
      for (final code in [429, 500, 502, 503]) {
        final o = renewOutcomeOf(code, 'boom');
        expect(o, isA<RenewNetworkError>(), reason: 'HTTP $code 不是"令牌不行了"');
        expect(renewActionOf(o), RenewAction.keepOldToken);
      }
    });

    test('200 但 token / expiresAt 读不出 ⇒ 当失败，**不许**把坏东西存下去', () {
      for (final body in [
        '{}',
        '{"token":"new"}', // 少了 expiresAt
        '{"expiresAt":1}', // 少了 token
        '{"token":"","expiresAt":1}', // 空令牌不算令牌
        '{"token":123,"expiresAt":1}', // 类型不对
        '[]',
        '不是 JSON',
      ]) {
        final o = renewOutcomeOf(200, body);
        expect(o, isA<RenewMalformed>(), reason: 'body=$body');
        // ⚠️ 读不出来也**不是** 401 ⇒ 不许清令牌（那会把网的问题说成"登录过期"）
        expect(renewActionOf(o), RenewAction.keepOldToken, reason: 'body=$body');
      }
    });

    test('🔴 续期没碰既有那几张表：say 的 401 / 503 / 429 语义都在（503 按**正文**分义）', () {
      expect(sayOutcomeOf(401, '{}'), isA<SayUnauthorized>());
      // 🔴 2026-09-25 **更正**（线上真事故）：503 在 `/api/say` 上**有两个意思**，
      //    必须按**显式字段**分（和下面那条 429 一个风格）：
      //      · `{"error":"not-setup"}` ⇒ 真没设密码 ⇒ [SayNotSetup]；
      //      · 别的（租户那条 `tenant-not-ready`）⇒ **他那台没应** ⇒ [SayRejected] 照原话说。
      //    ⚠️ 这条原来钉的是"**任何** 503 都算没设密码" —— 那正是缺陷本身
      //      （盒子抖一下，界面就写"这台机器还没设密码"，而且不再重连）。
      expect(
        sayOutcomeOf(503, '{"error":"not-setup","text":"这台机器还没设密码，先设好再用。"}'),
        isA<SayNotSetup>(),
      );
      expect(
        sayOutcomeOf(503, '{"error":"tenant-not-ready","text":"你那台刚才没应，等会儿再试。"}'),
        isA<SayRejected>(),
        reason: '★ 别的 503 ⇒ 不许猜成"没设密码"',
      );
      expect(sayOutcomeOf(429, '{"error":"busy"}'), isA<SayBusy>());
      final locked = sayOutcomeOf(429, '{"error":"locked","retryAfterSec":9}');
      expect(locked, isA<SayLocked>());
      expect((locked as SayLocked).retryAfterSec, 9);
    });
  });

  group('接进开机那条路（读到令牌之后、连流之前）', () {
    test('🔴 200 ⇒ 新令牌被存下来、并且被接下来的请求用上', () async {
      String? saidWith;
      final c = _controller(
        client: _server(
          renew: (_) async => _ok('new'),
          other: (r) async {
            saidWith = _authOf(r);
            return http.Response('{"ok":true,"duplicate":false,"seq":5}', 200);
          },
        ),
      );

      await c.start(token: 'old', openStream: false);

      expect(c.token, 'new', reason: '连流要用的就是新的那个');
      expect(await c.tokens.read(), 'new', reason: '新令牌必须落下来（下次开机靠它）');

      await c.send('在吗');
      expect(saidWith, 'Bearer new', reason: '接下来的请求必须用新令牌，不是旧的');
    });

    test('🔴 401 ⇒ 清令牌 + 回登录页（**这是唯一该清的情形**）', () async {
      await TimelineStore().save([_fact(1), _fact(2)]);

      var kicked = false;
      final c = _controller(
        client: _server(renew: (_) async => _expired()),
        onUnauthorized: () => kicked = true,
      );
      await c.start(token: 'old', openStream: false);

      expect(kicked, true, reason: '要有人把界面送回登录页');
      expect(c.token, isNull, reason: '令牌真的不行了');
      expect(await c.tokens.read(), isNull, reason: '401 才清，而且要清干净');
      expect(c.items, isEmpty, reason: '本机那一屏一起清（换个人登录不许看见上一个人的）');

      // 那句人话也得干净（它可能露在状态条上）
      expect(c.lastError, '登录过期了，重新登录一下');
      expect(scanForbidden(c.lastError!), isEmpty);
      final (shown, isError) = statusLine(ConnState.unauthorized, error: c.lastError);
      expect(shown, c.lastError);
      expect(isError, true, reason: '这是"要用户动手"的那一类');
    });

    test('🔴 网络错误 ⇒ **一个字节都不许清**，拿旧令牌照常往下走', () async {
      await TimelineStore().save([_fact(1), _fact(2)]);

      String? saidWith;
      final c = _controller(
        client: _server(
          renew: (_) async => throw Exception('网断了'),
          other: (r) async {
            saidWith = _authOf(r);
            return http.Response('{"ok":true,"duplicate":false,"seq":5}', 200);
          },
        ),
        onUnauthorized: () => fail('网的问题**不许**把人踢回登录页'),
      );

      await c.start(token: 'old', openStream: false);

      // ① 什么都没清
      expect(c.token, 'old', reason: '还得拿旧令牌往下走');
      expect(await c.tokens.read(), 'old', reason: '网的问题不许清令牌（B1 的根）');
      expect(await TimelineStore().load(), isNotEmpty, reason: '本机那一屏也不许清');

      // ② 照常往下走：下一句话用的还是旧令牌（连不上才走原来那套"网断了"）
      await c.send('在吗');
      expect(saidWith, 'Bearer old');
      expect(c.lastError, isNull, reason: '发成功了就不该有错话');
    });

    test('🔴 回执读不出来（200 坏 body）⇒ 也不许存、不许清', () async {
      final c = _controller(
        client: _server(renew: (_) async => http.Response('{"token":"new"}', 200)),
      );
      await c.start(token: 'old', openStream: false);

      expect(c.token, 'old', reason: '不许把半个令牌当新令牌用');
      expect(await c.tokens.read(), 'old', reason: '坏回执不许覆盖旧令牌、更不许清');
    });
  });

  group('顺序：续期不许把冷启动那一屏拖没了（17-LOCAL-FIRST）', () {
    test('🔴 续期卡在网上时，本机那一屏**已经画出来了**', () async {
      SharedPreferences.setMockInitialValues({
        'hupo_timeline_v1.single': [
          jsonEncode(_fact(1, 'message/start')),
          jsonEncode(_fact(2)),
        ],
      });

      final gate = Completer<void>();
      final c = _controller(
        client: _server(renew: (_) async {
          await gate.future; // 续期挂在那儿，等一个永远还没到的网络
          return _ok('new');
        }),
      );

      final starting = c.start(token: 'old', openStream: false);
      await pumpEventQueue();

      // ★ 续期还没回来，可本机那一屏已经在屏幕上了
      expect(c.items, isNotEmpty, reason: 'S5c 的全部目的：冷启动不许空屏');
      expect(c.token, 'old', reason: '还没换到新的，就别假装换了');

      gate.complete();
      await starting;
      expect(c.token, 'new', reason: '续期回来了照常换、照常连流');
    });

    test('🔴 续期失败**不许**把已经画出来的本机一屏弄没', () async {
      await TimelineStore().save([_fact(1, 'message/start'), _fact(2)]);
      final c = _controller(client: _server(renew: (_) async => _expired()));

      // 401 那条路是**刻意**清屏的（回登录页）；这里钉的是"网的问题"那条：
      // 一屏画出来之后，网的问题不该动它一根手指头。
      final ok = _controller(
        client: _server(renew: (_) async => throw Exception('连不上')),
      );
      await ok.start(token: 'old', openStream: false);
      expect(ok.items, isNotEmpty, reason: '网的问题之后，本机那一屏还必须在那儿');

      // 而 401 是另一回事：那是"令牌真的不行了"，清是对的
      await c.start(token: 'old', openStream: false);
      expect(c.items, isEmpty, reason: '401 ⇒ 回登录页，这一屏跟着清');
    });
  });

  group('屏幕上那句（没有新文案，但复用的这句也要过闸）', () {
    test('🔴 续期落回登录页时那句：过禁用词扫描、而且是既有的那句', () async {
      final c = _controller(client: _server(renew: (_) async => _expired()));
      await c.start(token: 'old', openStream: false);

      final line = c.lastError;
      expect(line, isNotNull, reason: 'N11：不许静默');
      // 复用既有的 401 那句（同一件事同一句话），**没有新造词**
      expect(line, '登录过期了，重新登录一下');
      expect(scanForbidden(line!), isEmpty, reason: '禁用词：${scanForbidden(line)}');
    });
  });
}

// ⚠️ 上面那行 `fail(...)` 用在回调里：网的问题走这条路时测试必须当场红，
//    而不是"悄悄过去了"。dart 的 `fail` 由 flutter_test 提供（见顶部 import）。
