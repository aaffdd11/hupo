// **老消息往上翻着加载**（批 C · `docs/dev/64-CHAT-REDESIGN.md` §三）。
//
// 这一份钉五件（都是"错了看起来也像对的"那种）：
//   ① 取回来的几页**接在最前面**（更早的在上）
//   ② 🔴 **同一页取两次不许出现两遍**（按号去重）
//   ③ 服务端说没有更早的 ⇒ **到头了**；问了没回 ⇒ **"没问到"**（**不是**"到头了"）
//   ④ 本机留的页数到顶 ⇒ `olderCapped`（**如实说**，别假装服务端没有了）
//   ⑤ 🔴 **换个人/复位时，那几页一起清掉**（不然就是"串"那类 bug）

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 一页帧：`seq` 从 `from` 到 `from+count-1`（都是用户说过的话，最省事）。
List<Map<String, dynamic>> page(int from, int count) => [
  for (var i = 0; i < count; i += 1)
    {
      'type': 'user/echo',
      'seq': from + i,
      'messageId': 'm${from + i}',
      'text': '第 ${from + i} 句',
      'at': 1700000000000 + (from + i) * 1000,
    },
];

/// 造一个控制器：它先自己"已经收到"了 [known] 这些帧，然后把 `/api/timeline` 的
/// 回答交给 [serve]（返回 `(frames, hasMore, status)`）。
Future<ChatController> build({
  required List<Map<String, dynamic>> known,
  required (List<Map<String, dynamic>>, bool, int) Function(int before) serve,
  List<Uri>? seen,
}) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final api = Api(
    base: 'http://127.0.0.1:1',
    client: MockClient((req) async {
      if (!req.url.path.contains('/api/timeline')) {
        return http.Response('{}', 404);
      }
      seen?.add(req.url);
      final before = int.parse(req.url.queryParameters['before']!);
      final (frames, hasMore, status) = serve(before);
      if (status != 200) return http.Response('{"error":"x"}', status);
      return http.Response(
        jsonEncode({'frames': frames, 'hasMore': hasMore}),
        200,
        headers: {'content-type': 'application/json'},
      );
    }),
  );
  final c = ChatController(api: api, tokens: TokenStore());
  for (final e in known) {
    c.ingest(e);
  }
  return c;
}

void main() {
  test('★ 取回来的一页**接在最前面**（更早的在上），而且顺序不乱', () async {
    final c = await build(
      known: page(50, 5), // 手上: 50..54
      serve: (before) {
        expect(before, 50, reason: '★ 该从我手上最老那一号往前取');
        return (page(45, 5), false, 200);
      },
    );
    final beforeCount = c.items.length;
    await c.loadOlder();
    expect(c.items.length, beforeCount + 5);
    expect((c.items.first as dynamic).seq, 45, reason: '更早的排在前面');
    expect(c.olderExhausted, true, reason: '服务端说没有了');
    expect(c.olderFailed, false);
  });

  test('🔴 同一页取两次 ⇒ **不许出现两遍**（按号去重）', () async {
    final c = await build(
      known: page(50, 5),
      serve: (_) => (page(45, 5), true, 200),
    );
    await c.loadOlder();
    final once = c.items.length;
    // 再取一次同一页（比如用户又滑到顶，而服务端这次还是给这一段）
    await c.loadOlder();
    expect(c.items.length, once, reason: '★ 同一号第二次进来必须被丢掉');
  });

  test('🔴 "没问到"（非 200 / 抛了）⇒ `olderFailed`，**不是**"到头了"', () async {
    final c = await build(
      known: page(50, 5),
      serve: (_) => (const [], false, 500),
    );
    await c.loadOlder();
    expect(c.olderFailed, true);
    expect(c.olderExhausted, false, reason: '把"没问到"说成"没有更早的" = 假话');
    // 而且它**还能再试**（失败不该把门关死）
    expect(c.olderLoading, false);
  });

  test('★ 本机页数到顶 ⇒ `olderCapped`（服务端还有，是**我们**不再留了）', () async {
    var guard = 0;
    final c = await build(
      known: page(1000, 5),
      serve: (before) {
        guard += 1;
        // 每次都给上一页，而且**永远说还有**
        return (page(before - 5, 5), true, 200);
      },
    );
    while (!c.olderExhausted && guard < 50) {
      await c.loadOlder();
    }
    expect(guard, ChatController.olderMaxPages, reason: '到顶就停手（不再一遍遍问）');
    expect(c.olderCapped, true);
    expect(c.olderExhausted, true);
  });

  test('🔴 复位（换人/判死）⇒ 那几页**一起清掉**', () async {
    final c = await build(
      known: page(50, 5),
      serve: (_) => (page(45, 5), true, 200),
    );
    await c.loadOlder();
    expect(c.items.length > 5, true, reason: '确实多了几页');
    // 服务端说"你的号跑到我前面了" ⇒ 本地这个世界不作数了
    c.ingest({'type': '__reset__'});
    await Future<void>.delayed(Duration.zero);
    expect(c.items.length, 0, reason: '★ 更早那几页也必须跟着清（不然就是串）');
    expect(c.olderExhausted, false);
  });

  test('★ 手上一条都没有 ⇒ 别问（直接认"到头了"）', () async {
    final seen = <Uri>[];
    final c = await build(
      known: const [],
      serve: (_) => (const [], false, 200),
      seen: seen,
    );
    await c.loadOlder();
    expect(seen, isEmpty, reason: '没有游标就别发请求');
    expect(c.olderExhausted, true);
  });
}
