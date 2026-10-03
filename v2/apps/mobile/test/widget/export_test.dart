// 「导出」页的**界面断言**（契约 `docs/dev/30-EXPORT.md` §四 ·
// 重做契约 `docs/dev/154-CHAT-RECORD-LOOK.md` §2.2）。
//
// ⚠️ 项目纪律：纯逻辑进 `test/unit`（`test/unit/export_test.dart`），
//    界面断言放 `test/widget`（这一份）。可访问性那两条硬闸在
//    `test/widget/accessibility_test.dart` 里、**从真入口进**。
//
// 这一份量四件契约明说的事：
//   ① **空对话** ⇒ 只给那句实话（＋一句"能干什么"），**不给空白框、不给复制按钮**；
//   ② ★ **有 `items`** ⇒ **按天分组** ＋ 每条前一行 `我` / `它` 的标签；
//   ③ ★ **按「复制全部」** ⇒ 复制到的字符串**等于服务端那段 `text`**（不重拼）；
//   ④ ★ **不给 `items`**（老服务端）⇒ 屏幕上是**原来那段文字**（负向对照）。
//   另加：复制没成也要说（N11）、令牌不行要回登录页、网不好给重试。

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/export_words.dart';
import 'package:hupo_app/models/trash_words.dart' show trashRetry, trashUnauthorizedLine;
import 'package:hupo_app/screens/export_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

http.Response _json(String body, int status) => http.Response(
      body,
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

ChatController _controller(String body, {int status = 200, String? token = 'tok'}) {
  final api = Api(client: MockClient((_) async => _json(body, status)));
  return ChatController(api: api, tokens: TokenStore(), token: token);
}

/// 泵出导出页。`copy` 注入一个假的 —— **别在 widget 测试里敲平台通道**。
Future<void> _pump(
  WidgetTester tester,
  ChatController c, {
  Future<void> Function(String)? copy,
}) async {
  await tester.pumpWidget(
    MaterialApp(home: ExportScreen(controller: c, copy: copy, onLoggedOut: () {})),
  );
  await tester.pumpAndSettle();
}

/// 服务端那段成品原文（客户端**原样显示、原样复制**，一个字都不改写）。
const _sample = '—— 9月21日 ——\n\n我：帮我把这周工时记一下\n\n它：这周 7 小时。\n\n'
    '（这儿只是这条对话里你我互相说过的话。它自己记在记忆里的那一层不在里面。）';

/// 两天的四条话（★ 154：`items` 那份 `{seq, at, who, text}`）＋ 服务端原文。
String _withItems() {
  final d1 = DateTime(2026, 9, 21, 9).millisecondsSinceEpoch;
  final d2 = DateTime(2026, 9, 22, 10).millisecondsSinceEpoch;
  return jsonEncode({
    'text': _sample,
    'hiddenCount': 2,
    'items': [
      {'seq': 1, 'at': d1, 'who': 'me', 'text': '帮我把这周工时记一下'},
      {'seq': 2, 'at': d1, 'who': 'it', 'text': '这周 7 小时。'},
      {'seq': 3, 'at': d2, 'who': 'me', 'text': '那下周呢'},
      {'seq': 4, 'at': d2, 'who': 'it', 'text': '下周一并给你。'},
    ],
  });
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('① 空对话 ⇒ 那句实话（＋能干什么），**不给框、不给复制按钮**', (tester) async {
    final c = _controller('{"text":"","hiddenCount":0}');
    addTearDown(c.dispose);
    await _pump(tester, c);

    expect(find.text(exportEmptyLine), findsOneWidget);
    expect(find.text(exportEmptyHint), findsOneWidget, reason: '★ 别把人晾在一句话上');
    expect(find.byType(SelectableText), findsNothing, reason: '★ 空的时候不许出现一个空白框');
    expect(find.text(exportCopyAll), findsNothing, reason: '★ 没东西可复制就不该给按钮');
  });

  testWidgets('② 有 items ⇒ **按天分组** ＋ 每条前一行 `我` / `它` 标签', (tester) async {
    final c = _controller(_withItems());
    addTearDown(c.dispose);
    await _pump(tester, c);

    final d1 = DateTime(2026, 9, 21, 9).millisecondsSinceEpoch;
    final d2 = DateTime(2026, 9, 22, 10).millisecondsSinceEpoch;
    expect(find.text(exportDayLabel(d1)), findsOneWidget, reason: '★ 第一天的小标题');
    expect(find.text(exportDayLabel(d2)), findsOneWidget, reason: '★ 第二天的小标题');
    expect(find.text(exportWhoMe), findsNWidgets(2));
    expect(find.text(exportWhoIt), findsNWidgets(2));
    // 每一条自己是一块可选的正文（不是那一大段等宽字）
    expect(find.byType(SelectableText), findsNWidgets(4));
    expect(find.text(exportHintLine), findsNothing, reason: '★ items 那一档不再退回文字块');
  });

  testWidgets('③ 按「复制全部」⇒ 复制到的**等于服务端那段 text**（不重拼）', (tester) async {
    String? copied;
    final c = _controller(_withItems());
    addTearDown(c.dispose);
    await _pump(tester, c, copy: (t) async => copied = t);

    await tester.tap(find.text(exportCopyAll));
    await tester.pumpAndSettle();
    expect(copied, _sample, reason: '★ 复制的必须是服务端拼好的那段原文，不是拿 items 重拼');
    expect(find.text(exportCopiedLine), findsOneWidget);
  });

  testWidgets('④ 不给 items（老服务端）⇒ 屏幕上是**原来那段文字**', (tester) async {
    String? copied;
    final c = _controller(jsonEncode({'text': _sample, 'hiddenCount': 2}));
    addTearDown(c.dispose);
    await _pump(tester, c, copy: (t) async => copied = t);

    // 负向对照：退回那条路真的没断 —— 整段成品**原样**在
    expect(find.byType(SelectableText), findsOneWidget);
    final shown = tester.widget<SelectableText>(find.byType(SelectableText));
    expect(shown.data, _sample);
    expect(find.text(exportHintLine), findsOneWidget);
    // 抬眼那颗「复制全部」照样复制得走（这才是 §2.2 说的"常驻"）
    await tester.tap(find.text(exportCopyAll));
    await tester.pumpAndSettle();
    expect(copied, _sample);
  });

  testWidgets('⑤ 复制没成 ⇒ 如实说（不许沉默）', (tester) async {
    final c = _controller(_withItems());
    addTearDown(c.dispose);
    await _pump(tester, c, copy: (_) async => throw Exception('平台通道不在'));

    await tester.tap(find.text(exportCopyAll));
    await tester.pumpAndSettle();
    expect(find.text(exportCopyFailedLine), findsOneWidget);
  });

  testWidgets('令牌不行 ⇒ 说"登录过期了"，而且**离开这一页**（不再给"再试一次"）', (tester) async {
    // ⚠️ 2026-09-21 改的（欠账 **#25**）：令牌过期**重试解决不了**。
    //    原来这一页只飘一句话、把人留在一个永远读不出来的界面上；
    //    现在它和回收站同一套：说话 + 回登录页。
    //    ⇒ "网不好"那一档**不变**（见下一条：那一档才是该重试的）。
    var loggedOut = 0;
    final c = _controller('{}', status: 401);
    addTearDown(c.dispose);
    // ⚠️ 这里**不能用 `_pump`（它 pumpAndSettle）**：401 之后这一页正在**被离开**
    //    （真实那一侧:上层把主界面换成登录页；这个用例里 `onLoggedOut` 只是记个数），
    //    于是它还停在自己的加载态上 —— 那个转圈**永远不会停** ⇒ `pumpAndSettle` 会超时。
    //    这不是界面坏了，是"它正要走"的形状；所以只 pump 两下把那一帧推出来。
    await tester.pumpWidget(MaterialApp(
      home: ExportScreen(controller: c, onLoggedOut: () => loggedOut += 1),
    ));
    await tester.pump();
    await tester.pump();

    expect(loggedOut, 1, reason: '★ 必须通知上层：令牌过期得回登录页');
    expect(find.text(trashUnauthorizedLine), findsOneWidget);
    expect(find.text(exportLoadFailedLine), findsNothing);
    expect(find.text(trashRetry), findsNothing, reason: '★ 重试解决不了令牌过期');
  });

  testWidgets('网不好 ⇒ 说"没拿到" + 给"再试一次"', (tester) async {
    final c = _controller('{}', status: 500);
    addTearDown(c.dispose);
    await _pump(tester, c);

    expect(find.text(exportLoadFailedLine), findsOneWidget);
    expect(find.text(trashUnauthorizedLine), findsNothing);
    expect(find.text(trashRetry), findsOneWidget);
  });
}
