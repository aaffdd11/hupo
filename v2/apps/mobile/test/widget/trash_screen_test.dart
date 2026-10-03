// 「回收站」页**画到屏幕上之后**长什么样（契约 `docs/dev/154-CHAT-RECORD-LOOK.md` §2.3）。
//
// 纯逻辑那半边在 `test/unit/trash_test.dart`；这一份钉的是**用户真会看到的四件**：
//   ① 服务端给的 `preview`（他自己那句话）**照实上屏**（客户端不截、不改）；
//   ② 两颗按钮都在、命中区 ≥44（D3.6）；
//   ③ 🔴 按「彻底删掉」⇒ **先出确认，这一刻一个请求都不许发**；确认之后才发那一个；
//   ④ 空 ⇒ 那句实话（＋下一句）。
//
// ⚠️ **从真入口进**（从一个能 push 的栈上推上来，同 `unauthorized_test.dart`）——
//    直接把它当 `home` pump 的话，返回那条路量的不是用户真看到的那棵树。
// ⚠️ **不打真网**：`MockClient` 记账（真发出去过哪些请求都记下来 —— 判据③要数它）。

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/trash_words.dart';
import 'package:hupo_app/screens/trash_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// D3.6 点名的下限。
const minTouch = 44.0;

/// 假回执。⚠️ **必须带 `charset=utf-8`**（`http.Response` 默认按 latin1 编正文，
/// 正文里有中文就当场抛）。
http.Response _json(String body, [int status = 200]) => http.Response(
      body,
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

/// 那几个时刻用"本地时间构造出来"的毫秒（这样测试不写死一个时区）。
final _at = DateTime(2026, 10, 1, 21, 33).millisecondsSinceEpoch;
final _purgeAt = DateTime(2026, 10, 31, 9, 5).millisecondsSinceEpoch;

/// 一条回收站里的话（**服务端给的那个形状**：`messageIds` / `at` / `purgeAt` /
/// `preview`；★ 新增键 `say` = 他自己那句话，**老盒子不给**）。
Map<String, Object?> _entry({String preview = '2 条', String? say}) => {
      'messageIds': ['u_1', 'm_1'],
      'at': _at,
      'purgeAt': _purgeAt,
      'preview': preview,
      if (say != null) 'say': say,
    };

/// 假服务端 ＋ **记账**（`calls` 里是**真的发出去过**的请求路径）。
ChatController _controller(List<Map<String, Object?>> items, List<String> calls) {
  final api = Api(
    client: MockClient((r) async {
      calls.add(r.url.path);
      switch (r.url.path) {
        case '/api/trash':
          // ⚠️ 回执是 `{items, ttlDays}`（服务端 `GET /api/trash` 的形状）。
          return _json(jsonEncode({'items': items, 'ttlDays': 30}));
        case '/api/trash/restore':
        case '/api/trash/purge':
          return _json('{"ok":true}');
        default:
          return _json('{}');
      }
    }),
  );
  final c = ChatController(api: api, tokens: TokenStore(), token: 'tok');
  addTearDown(c.dispose);
  return c;
}

/// **像用户那样**进回收站：从一个能 push 的栈上推上来。
Future<void> _pumpTrash(WidgetTester tester, ChatController c) async {
  await tester.pumpWidget(MaterialApp(
    home: Builder(
      builder: (context) => Scaffold(
        body: Center(
          child: ElevatedButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => TrashScreen(controller: c, onLoggedOut: () {}),
              ),
            ),
            child: const Text('进回收站'),
          ),
        ),
      ),
    ),
  ));
  await tester.tap(find.text('进回收站'));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('① 新键 `say`（他自己那句话）**照实上屏**（客户端不截、不改）', (tester) async {
    // ⚠️ 故意给一句**长的**：客户端要是自己截了，`find.text` 就找不到整句。
    const long = '帮我把这周工时记一下，另外明天上午十点提醒我去医院拿体检报告，别忘了';
    final c = _controller([_entry(say: long)], <String>[]);
    await _pumpTrash(tester, c);

    expect(find.text(long), findsOneWidget, reason: '★ 服务端给的那句话被客户端截/改了');
    expect(find.text('2 条'), findsNothing, reason: '有那句话时不该再画摘要');
    // 什么时候删的 ＋ 还能放到什么时候（都来自服务端那两个数）
    expect(find.text(trashAtLine(_at)), findsOneWidget);
    expect(find.text(trashCanRestoreUntilLine(_purgeAt)), findsOneWidget);
    // 抬头那句（数的是"删了几次"）
    expect(find.text(trashHeadLine(1)), findsOneWidget);
  });

  testWidgets('①补 🔴 老回执（没有 `say`）⇒ 退回 `preview`（这条退回的路不许断）', (tester) async {
    final c = _controller([_entry(preview: '2 条')], <String>[]);
    await _pumpTrash(tester, c);
    expect(find.text('2 条'), findsOneWidget, reason: '★ 老盒子不给 `say` ⇒ 必须退回 `preview`');
  });

  testWidgets('①补 服务端两样都没给 ⇒ 如实说"没有能看的字"（不摆一张空白卡）', (tester) async {
    final c = _controller([_entry(preview: '')], <String>[]);
    await _pumpTrash(tester, c);
    expect(find.text(trashNoPreviewLine), findsOneWidget);
  });

  testWidgets('② 两颗按钮都在，命中区 ≥44（D3.6）', (tester) async {
    final c = _controller([_entry()], <String>[]);
    await _pumpTrash(tester, c);

    final restore = find.widgetWithText(TextButton, trashRestore);
    final purge = find.widgetWithText(TextButton, trashPurge);
    expect(restore, findsOneWidget);
    expect(purge, findsOneWidget);
    for (final (name, f) in [('放回来', restore), ('彻底删掉', purge)]) {
      final size = tester.getSize(f);
      expect(
        size.width >= minTouch && size.height >= minTouch,
        isTrue,
        reason: '$name 的命中区是 $size，小于 $minTouch×$minTouch',
      );
    }
  });

  testWidgets('③ 🔴 按「彻底删掉」先出确认（这一刻零请求），确认之后才发那一个', (tester) async {
    final calls = <String>[];
    final c = _controller([_entry()], calls);
    await _pumpTrash(tester, c);
    calls.clear(); // 列清单那一次不算（它已经把这一页画出来了）

    await tester.tap(find.widgetWithText(TextButton, trashPurge));
    await tester.pumpAndSettle();
    expect(find.text(trashPurgeConfirmTitle), findsOneWidget, reason: '★ 先出确认');
    expect(find.text(trashPurgeConfirmBody), findsOneWidget, reason: '正文要说清"拿不回来"');
    expect(calls, isEmpty, reason: '★ 还没确认 ⇒ 一个请求都不许发（连清单也不许）');

    // 【算了】⇒ 什么都不发，那一条还在
    await tester.tap(find.text(trashPurgeConfirmNo));
    await tester.pumpAndSettle();
    expect(find.text(trashPurgeConfirmTitle), findsNothing);
    expect(calls, isEmpty);
    expect(find.text(trashPurge), findsOneWidget, reason: '没确认 ⇒ 那一条还在');

    // 再来一次，这次按【彻底删掉】
    await tester.tap(find.widgetWithText(TextButton, trashPurge));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, trashPurgeConfirmYes));
    await tester.pumpAndSettle();

    expect(calls, ['/api/trash/purge'], reason: '★ 确认之后才发那一个');
    expect(find.text(trashPurgedLine), findsOneWidget, reason: '成没成都如实说');
    expect(find.text(trashRestore), findsNothing, reason: '删掉了 ⇒ 当场从列表里消失');
  });

  testWidgets('③补 恢复：按一下就直接发那个请求（它不要二次确认）', (tester) async {
    final calls = <String>[];
    final c = _controller([_entry()], calls);
    await _pumpTrash(tester, c);
    calls.clear();

    await tester.tap(find.widgetWithText(TextButton, trashRestore));
    await tester.pumpAndSettle();
    expect(calls, ['/api/trash/restore']);
    expect(find.text(trashRestoredLine), findsOneWidget);
  });

  testWidgets('④ 空 ⇒ 那句实话 ＋ 下一句（不给空框、也不给按钮）', (tester) async {
    final c = _controller(<Map<String, Object?>>[], <String>[]);
    await _pumpTrash(tester, c);

    expect(find.text(trashEmptyLine), findsOneWidget);
    expect(find.text(trashEmptyHint), findsOneWidget);
    expect(find.text(trashRestore), findsNothing);
    expect(find.text(trashPurge), findsNothing);
    expect(find.text(trashHeadLine(0)), findsNothing, reason: '空的时候不许摆抬头那句');
  });
}
