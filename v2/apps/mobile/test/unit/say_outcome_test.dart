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
}
