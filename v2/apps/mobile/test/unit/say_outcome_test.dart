// `/api/say` 的**回执 → 结果**，以及"忙不过来"落到屏幕上是什么样。
//
// ⚠️ 为什么这两条值得进硬闸：
//   1. **协议语义一旦上线就冻结**（`03-DEVELOPMENT.md` §三）。改错一个码，
//      用户看到的就不是"没发出去"，而是别的话——而这句话决定他会不会再试一次。
//      所以映射被提成纯函数（`sayOutcomeOf`），在这里**逐码对表**。
//   2. 不变量 **N11**：拒绝必须是"一句人话 + 可重试"，不许静默。
//      而"可重试"在屏幕上不是一句话，是**那条消息的 `failed` 态**（它带「重发」）。
//
// ⚠️ 不写界面断言（那是 `test/widget`，提示档）：这里只用纯逻辑 ——
//    状态码表、`Timeline` 的状态、`stateLabel`、`statusLine`、禁用词扫描。

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/conn_state.dart';
import 'package:hupo_app/models/forbidden_words.dart';
import 'package:hupo_app/models/message_state.dart';
import 'package:hupo_app/models/timeline.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';

/// 一个"服务端固定回这个码 + 这个 body"的控制器。
/// MockClient 只是把那一次 HTTP 换成一个常量响应，**不开端口、不碰真网**。
ChatController _controllerReplying(int status, String body) {
  final api = Api(
    client: MockClient(
      (_) async => http.Response(
        body,
        status,
        headers: {'content-type': 'application/json; charset=utf-8'},
      ),
    ),
  );
  return ChatController(api: api, tokens: TokenStore(), token: 'tok');
}

const _busy = '{"error":"busy"}';

void main() {
  group('状态码 → outcome（纯函数）', () {
    test('★ 既有的几个码：语义一个都不许动', () {
      expect(
        sayOutcomeOf(200, jsonEncode({'ok': true, 'duplicate': false, 'seq': 7})),
        isA<SayOk>().having((o) => o.seq, 'seq', 7),
        reason: '200 还是"收下了"',
      );
      // 重复投递：**没有新号**（重复那次不落盘）
      expect(
        sayOutcomeOf(200, jsonEncode({'ok': true, 'duplicate': true, 'seq': null})),
        isA<SayOk>().having((o) => o.duplicate, 'duplicate', true),
      );
      expect(sayOutcomeOf(401, '{"error":"unauthorized"}'), isA<SayUnauthorized>(),
          reason: '401 还是"令牌不行"，不许被并进别的');
      expect(sayOutcomeOf(503, '{"error":"not-setup"}'), isA<SayNotSetup>(),
          reason: '503 还是"这台机器还没设密码"');
      expect(sayOutcomeOf(500, 'boom'), isA<SayRejected>(),
          reason: '其余码还是"没细分"那条路');
    });

    test('★ 429 + {"error":"busy"} ⇒ SayBusy（忙不过来 ≠ 试得太频繁）', () {
      expect(sayOutcomeOf(429, _busy), isA<SayBusy>());
    });

    test('★ 同一个 429 分三种事：说话这条路按 body 分，登录那条路**一个字没动**',
        () async {
      // ① `/api/say`：429 = 它满了，这一句没收下。
      //    ⚠️ **不猜 body**——按"是哪个端点"分，不按"body 长什么样"猜。
      expect(sayOutcomeOf(429, _busy), isA<SayBusy>());
      // ⚠️ **不带 busy 标记的 429 仍然是原来那个意思**（试得太频繁 + 等多久）。
      //    这条语义是**冻结**的（旧客户端还在按它说话）：新加的"忙"不许把它吃掉。
      final locked = sayOutcomeOf(429, '{"error":"locked","retryAfterSec":90}');
      expect(locked, isA<SayLocked>());
      expect((locked as SayLocked).retryAfterSec, 90);
      // 读不出来也别慌：老行为是 0，而且**不许**把它说成"忙"
      expect((sayOutcomeOf(429, '不是 JSON') as SayLocked).retryAfterSec, 0);

      // ② `/api/login`：同一个状态码，意思完全不同 —— 这条是**回归条**：
      //    加 SayBusy 时最容易顺手把登录那句"还有多久"（D2）弄丢。
      final api = Api(
        client: MockClient(
          (_) async => http.Response(
            '{"error":"locked","retryAfterSec":90}',
            429,
            headers: {'content-type': 'application/json; charset=utf-8'},
          ),
        ),
      );
      final r = await api.login('whatever');
      expect(r.ok, false);
      expect(r.lockedSec, 90, reason: '登录这条路必须还能读出"还有多久"');
      expect(r.wrongPassword, false, reason: '"锁住了"不是"密码错了"');
    });

    test('★ C 期：409 + `{"ask":true}` ⇒ SayAsk（焦点与目标不一致 ⇒ 先反问一句）', () {
      // 契约 `docs/dev/84-DISPATCHER-FOCUS.md` §三·3 · `96-OWNER-DECISIONS.md` 第 16 条
      final ask = sayOutcomeOf(
        409,
        jsonEncode({
          'error': 'focus-mismatch',
          'ask': true,
          'focus': 'alpha',
          'scope': 'beta',
          'text': '你现在看的是「甲」，这句话是要送到「乙」那间去吗？',
        }),
      );
      expect(ask, isA<SayAsk>());
      final a = ask as SayAsk;
      expect(a.scope, 'beta', reason: '★ 这一句本来要去哪一间');
      expect(a.focus, 'alpha', reason: '★ 他刚才在看哪一间');
      expect(a.question, contains('去吗？'), reason: '★ 反问那句话要**原样**用服务端给的');
      // 🔴 **不按状态码猜**：409 上没有 `ask:true` 就还是原来那条"没细分"的路
      expect(sayOutcomeOf(409, '{"error":"whatever"}'), isA<SayRejected>());
      expect(sayOutcomeOf(409, '不是 JSON'), isA<SayRejected>());
      // ⚠️ 409 以前是 `SayRejected('HTTP 409')` —— 那条**还在**（上面两条就是它的正身）
    });
  });

  group('SayAsk 落到屏幕上（N11：人话 + 可重试，而且一个字都不丢）', () {
    const askBody =
        '{"error":"focus-mismatch","ask":true,"focus":"alpha","scope":"beta",'
        '"text":"你现在看的是这一间，这句话是要送到别的那一间去吗？"}';

    test('★ 那条发言落 failed（有「重发」），顶部显示**服务端那句反问**', () async {
      final c = _controllerReplying(409, askBody);
      await c.send('乙房那件事');

      final mine = c.items.whereType<UserUtterance>().single;
      expect(mine.state, MessageState.failed, reason: '★ 反问那次**一个字都没落盘** ⇒ 这句还算没被收下');
      expect(canTransition(mine.state, MessageState.queued), true, reason: '「重发」要把这条推回 queued');
      final line = c.lastError;
      expect(line, isNotNull, reason: 'N11：不许静默 —— 反问就是那句人话');
      expect(line, contains('去吗'), reason: '★ 反问那句话必须真的到得了状态条');
      expect(scanForbidden(line!), isEmpty, reason: '禁用词：${scanForbidden(line)}');
      // 网是通的、它也没满 ⇒ 不许说成"网断了"（那是假话；`conn_state.dart` 记过一次）
      expect(line.contains('网'), false);
      final (shown, _) = statusLine(ConnState.connected, error: line);
      expect(shown, line);
    });

    test('反问**不是**令牌的事：不许把人踢回登录页（令牌留着，重发还能用）', () async {
      final c = _controllerReplying(409, askBody);
      await c.send('乙房那件事');
      expect(c.token, 'tok');
    });
  });

  group('SayBusy 落到屏幕上（N11：人话 + 可重试）', () {
    test('★ 那条发言是 failed ⇒ 屏幕上「没发出去」+ 有「重发」这条路', () async {
      final c = _controllerReplying(429, _busy);
      await c.send('帮我记一笔');

      final mine = c.items.whereType<UserUtterance>().single;
      expect(mine.state, MessageState.failed);
      expect(stateLabel(mine.state), '没发出去');
      // "可重试"不是文风：失败态必须能靠重发推回排队，界面那个按钮才走得通
      expect(canTransition(mine.state, MessageState.queued), true,
          reason: '「重发」要把这条推回 queued');
    });

    test('★ 顶部那句：有人话（不静默）、过禁用词扫描、**不说成网断了**', () async {
      final c = _controllerReplying(429, _busy);
      await c.send('帮我记一笔');

      final line = c.lastError;
      expect(line, isNotNull, reason: 'N11：拒绝必须给人话，不许静默');
      expect(scanForbidden(line!), isEmpty, reason: '禁用词：${scanForbidden(line)}');
      // 网是通的 ⇒ 说"网断了"就是假话（`conn_state.dart` 记过一次同类的假话事故）
      expect(line.contains('网'), false, reason: '这不是网的事，那是另一回事');

      // 屏幕上真正显示的那一句走的是 `statusLine`（顶部状态条那个纯函数）
      final (shown, _) = statusLine(ConnState.connected, error: line);
      expect(shown, line, reason: '设置的那句话必须真的到得了状态条');
      expect(scanForbidden(shown!), isEmpty);
    });

    test('忙不过来**不是**令牌的事：不许把人踢回登录页', () async {
      final c = _controllerReplying(429, _busy);
      await c.send('在吗');
      // 只有 401 才清令牌（网络失败不清，忙不过来当然也不清）
      expect(c.token, 'tok');
    });
  });

  test('🔴 /api/say 的 503 也分两件事：not-setup ⇒ 没设密码；tenant-not-ready ⇒ 照服务端那句说', () {
    // 这条与 `probeFrom503` 同源（2026-09-25 线上真事故）：混成一个 ⇒ 用户看到"这台机器还没设密码"，
    // 于是去重设密码（而真相是"你那台盒子刚才没应"）。
    final a = sayOutcomeOf(503, '{"error":"not-setup","text":"这台机器还没设密码，先设好再用。"}');
    expect(a, isA<SayNotSetup>(), reason: '★ 真没设密码 ⇒ 走原来那条');

    final b = sayOutcomeOf(503, '{"error":"tenant-not-ready","text":"你那台刚才没应，等会儿再试。"}');
    expect(b, isA<SayRejected>(), reason: '★ 盒子没应 ⇒ 不是"没设密码"，是"你那台没应"');
    expect((b as SayRejected).message, '你那台刚才没应，等会儿再试。',
        reason: '★ 照服务端那句原话说（不许自己编、也不许说成"没设密码"）');

    // 读不出来 ⇒ 也不许猜成"没设密码"（宁可说那句兜底的人话）
    final c = sayOutcomeOf(503, '不是 JSON');
    expect(c, isA<SayRejected>(), reason: '★ 认不出就不许猜成"没设密码"');
    expect((c as SayRejected).message, contains('没应'));
  });
}
