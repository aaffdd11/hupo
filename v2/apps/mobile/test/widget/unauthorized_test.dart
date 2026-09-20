// 「令牌不行了」那一路画出来之后长什么样（欠账 **#25 / #26**）。
//
// 两条欠账各自只有一句判据，都在**屏幕上**，所以进 `test/widget`：
//
//   🔴 **#25**：回收站 / 导出页撞上 401 ⇒ **要退回登录页**，
//      不许只飘一句话把人留在一个**永远读不出来**的页面上。
//   🔴 **#26**：恢复 / 彻底删成功之后 ⇒ **那一组当场从列表里消失**，
//      而不是先清空再重拉（那样会闪一下加载圈，服务端异步时还会显示旧快照）。
//
// ⚠️ 这两条都是**提示档**（`test/widget` 的通用规矩），但它们是"有没有画到屏幕上"
//    的唯一自动化证据 ⇒ 别删。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/trash_words.dart';
import 'package:hupo_app/screens/export_screen.dart';
import 'package:hupo_app/screens/trash_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

http.Response _json(String body, [int status = 200]) => http.Response(
      body,
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

String _binBody() => '{"items":['
    '{"messageIds":["u_1","m_1"],"at":1,"purgeAt":2,"preview":"2 条","usable":true},'
    '{"messageIds":["u_2","m_2"],"at":1,"purgeAt":2,"preview":"2 条","usable":true}'
    '],"ttlDays":30}';

/// 一个"想让它怎么答就怎么答"的假服务端。
MockClient _server({
  int listStatus = 200,
  int restoreStatus = 200,
  int exportStatus = 200,
}) {
  return MockClient((r) async {
    switch (r.url.path) {
      case '/api/trash':
        if (listStatus != 200) return _json('{"error":"nope"}', listStatus);
        return _json(_binBody());
      case '/api/trash/restore':
        if (restoreStatus != 200) return _json('{"error":"nope"}', restoreStatus);
        return _json('{"ok":true}');
      case '/api/export':
        if (exportStatus != 200) return _json('{"error":"nope"}', exportStatus);
        return _json('{"text":"我：你好\\n\\n它：在。","hiddenCount":0}');
      default:
        return _json('{}');
    }
  });
}

ChatController _controller(MockClient client) {
  final c = ChatController(api: Api(client: client), tokens: TokenStore(), token: 'tok');
  addTearDown(c.dispose);
  return c;
}

/// 把回收站页挂在**一个能 push 的栈**上（要验"弹回第一层"就必须有栈）。
Future<void> _pumpTrash(WidgetTester tester, ChatController c, {required VoidCallback onLoggedOut}) async {
  await tester.pumpWidget(MaterialApp(
    home: Builder(
      builder: (context) => Scaffold(
        body: Center(
          child: ElevatedButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => TrashScreen(controller: c, onLoggedOut: onLoggedOut),
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

  testWidgets('🔴 #25 回收站撞上 401 ⇒ 说话 + **弹回** + 通知上层回登录页', (tester) async {
    var loggedOut = 0;
    final c = _controller(_server(listStatus: 401));
    await _pumpTrash(tester, c, onLoggedOut: () => loggedOut += 1);

    expect(loggedOut, 1, reason: '★ 必须通知上层 —— 只说话就会把人留在这一页');
    expect(find.byType(TrashScreen), findsNothing, reason: '★ 这一页必须弹掉（不弹就压在最上面）');
    expect(find.text(trashUnauthorizedLine), findsOneWidget, reason: '★ 还得说清为什么');
    expect(find.text(trashRetry), findsNothing, reason: '重试解决不了"令牌过期"');
  });

  testWidgets('🔴 #25 导出页撞上 401 ⇒ 同样要回登录页（两页同一套）', (tester) async {
    var loggedOut = 0;
    final c = _controller(_server(exportStatus: 401));
    await tester.pumpWidget(MaterialApp(
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: ElevatedButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => ExportScreen(controller: c, onLoggedOut: () => loggedOut += 1),
                ),
              ),
              child: const Text('进导出'),
            ),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('进导出'));
    await tester.pumpAndSettle();

    expect(loggedOut, 1);
    expect(find.byType(ExportScreen), findsNothing);
    expect(find.text(trashUnauthorizedLine), findsOneWidget);
  });

  testWidgets('负向对照：网不好（不是 401）**不许**把人踢回登录页', (tester) async {
    var loggedOut = 0;
    final c = _controller(_server(listStatus: 500));
    await _pumpTrash(tester, c, onLoggedOut: () => loggedOut += 1);

    expect(loggedOut, 0, reason: '★ "网不好"和"令牌不行"是两件事，别混');
    expect(find.byType(TrashScreen), findsOneWidget, reason: '人该留在这儿，能重试');
    expect(find.text(trashRetry), findsOneWidget);
  });

  testWidgets('🔴 #26 恢复成功 ⇒ 那一组**当场消失**，而且不闪加载圈', (tester) async {
    final c = _controller(_server());
    await _pumpTrash(tester, c, onLoggedOut: () {});

    // 两组都在（负向对照：这是"两组的 id 都画出来了"的证明）
    expect(find.text('2 条'), findsNWidgets(2));

    // 恢复第一组
    await tester.tap(find.text(trashRestore).first);
    await tester.pump(); // 不 settle：正好看"中间有没有闪一下加载圈"
    expect(find.byType(CircularProgressIndicator), findsNothing,
        reason: '★ 乐观删除的意思就是**不重拉**、不闪加载圈');
    await tester.pumpAndSettle();

    expect(find.text('2 条'), findsOneWidget, reason: '★ 恢复掉的那一组该当场没了');
    expect(find.text(trashRestoredLine), findsOneWidget, reason: '而且如实说了做了什么');
  });

  testWidgets('🔴 #26 彻底删成功 ⇒ 同样当场消失（走完二次确认）', (tester) async {
    final c = _controller(_server());
    await _pumpTrash(tester, c, onLoggedOut: () {});
    expect(find.text('2 条'), findsNWidgets(2));

    await tester.tap(find.text(trashPurge).first);
    await tester.pumpAndSettle();
    // ⚠️ 确认框那颗按钮的字**和列表里那颗是同一个词**（`trashPurgeConfirmYes`
    //    == `trashPurge`）⇒ 按字找会撞上三颗，得按**控件类型**找。
    await tester.tap(find.widgetWithText(FilledButton, trashPurgeConfirmYes));
    await tester.pump();
    expect(find.byType(CircularProgressIndicator), findsNothing);
    await tester.pumpAndSettle();

    expect(find.text('2 条'), findsOneWidget);
    expect(find.text(trashPurgedLine), findsOneWidget);
  });

  testWidgets('两条都干净：`TrashEntry.usable` 为假的那一组按钮是灰的（没被这次改动碰坏）',
      (tester) async {
    final c = _controller(MockClient((r) async {
      if (r.url.path == '/api/trash') {
        // ⚠️ `usable` 是**算出来的**（`messageIds` 空 ⇒ 不可操作），不是回执里的字段
        return _json('{"items":[{"messageIds":[],"at":1,"purgeAt":2,"preview":"2 条"}],"ttlDays":30}');
      }
      return _json('{}');
    }));
    await _pumpTrash(tester, c, onLoggedOut: () {});
    final restore = tester.widget<TextButton>(
      find.widgetWithText(TextButton, trashRestore),
    );
    expect(restore.onPressed, isNull, reason: '用不了的那一组不许给一个点得动的按钮');
  });
}
