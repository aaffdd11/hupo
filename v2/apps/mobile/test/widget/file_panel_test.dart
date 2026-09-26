// **右栏那个文件面板真的画到屏幕上了没有**（契约 `docs/dev/120-FILE-PANEL.md`）。
//
// ⚠️ 这是**提示档**（`AGENTS.md` §5.1：`test/widget` 只有可访问性那一份是硬闸），
//    但它不是可有可无的：它是"这件事到底有没有画到屏幕上"的**唯一自动化证据**。
//    纯逻辑在 `test/unit/file_changes_test.dart` / `file_panel_words_test.dart`。
//
// 这一份钉六件：
//   ① 会话头那颗按钮**真的在**（命中区 ≥44）、点了**真的滑进来**、再点**真的收起来**；
//   ② 一行行真的画出来（轮分组头 / 路径（等宽）/ 是哪个工具碰的）；
//   ③ 点一行 ⇒ 展开**那一次的入参原文**，被服务端截过就**如实说**；
//   ④ 一窗没有文件行 ⇒ **只给一句实话**（不编行）；
//   ⑤ 🔴 **开一下再关掉，聊天那一屏的滚动位置一点都没动**（这一批的命门）；
//   ⑥ 面板开着的时候那颗按钮收起来（出口是栏里那颗「收起这一栏」）。

import 'dart:ui' show SemanticsAction;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/file_panel_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/widgets/file_panel.dart';
import 'package:shared_preferences/shared_preferences.dart';

ChatController _controller() {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  return ChatController(
    api: Api(
      base: 'http://127.0.0.1:1',
      client: MockClient((_) async => http.Response('{}', 200)),
    ),
    tokens: TokenStore(),
    token: 'tok',
  );
}

/// 一轮里两次写：`write` 一个文件、`edit` 另一个文件。
/// 第 2 轮再写第一次那个文件（**跨轮不合并** ⇒ 屏幕上该有两条）。
ChatController _twoTurns() {
  final c = _controller();
  c.ingest({
    'type': 'tool/call',
    'seq': 1,
    'turn': 1,
    'step': 1,
    'callId': 'c_1',
    'name': 'write',
    'title': '写一个新文件',
    'args': '{"path":"/w/账本.txt","content":"7 小时"}',
    'bytes': 40,
    'truncated': false,
  });
  c.ingest({
    'type': 'tool/call',
    'seq': 2,
    'turn': 1,
    'step': 2,
    'callId': 'c_2',
    'name': 'edit',
    'args': '{"file_path":"/w/摘要.md"}',
  });
  c.ingest({
    'type': 'tool/call',
    'seq': 3,
    'turn': 2,
    'step': 1,
    'callId': 'c_3',
    'name': 'write',
    'args': '{"path":"/w/账本.txt","content":"8 小时"}',
    // 服务端把入参裁过 ⇒ 那一行展开时要**如实说**
    'bytes': 2000,
    'truncated': true,
  });
  return c;
}

/// **像用户那样**打开那一栏（点会话头那颗按钮），并核"它真的画出来了"。
Future<void> _openPanel(WidgetTester tester) async {
  await tester.tap(find.byKey(filePanelButtonKey));
  await tester.pumpAndSettle();
  // 负向对照：**面板真的在树里**才算数（不然这道闸扫的是聊天那一屏）
  expect(find.byKey(filePanelKey), findsOneWidget, reason: '★ 点开了却没进树 ⇒ 闸扫错了地方');
}

Future<void> _pump(WidgetTester tester, ChatController c) async {
  await tester.pumpWidget(
    MaterialApp(
      home: ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}),
    ),
  );
  await tester.pumpAndSettle();
}

/// **像用户那样**点面板里某一条文件行（先让它真的露出来）。
///
/// ⚠️ 必须先把那一行滚进视野：那一栏自己有滚动，展开又会让行变高 ——
///    不先露出来，`tap` 会点到底下压着的那条输入框上（真栽过：
///    点击落在 `RenderEditable` 上，屏幕上看起来就是"点了没反应"）。
/// ⚠️ 做法是**像用户那样滚那一栏**（`drag`），不是 `ensureVisible`：
///    大字号下那一行可能**还没被建出来**，而 `ensureVisible` 对"不在树里"
///    的东西会当场抛 `Bad state: No element`。
Future<void> _tapRow(WidgetTester tester, String path) async {
  final f = find.byKey(filePanelRowKey(path));
  if (f.evaluate().isEmpty) {
    // 往下滚那一栏（面板里那个滚动面 = `filePanelKey` 底下的 `CustomScrollView`）
    await tester.drag(
      find.descendant(
        of: find.byKey(filePanelKey),
        matching: find.byType(CustomScrollView),
      ),
      const Offset(0, -400),
    );
    await tester.pumpAndSettle();
  }
  // ⚠️ 再 `ensureVisible` **一次**：滚动之前它还不存在，而滚动之后它可能
  //    只是**露出了一半** ⇒ 直接点会点在视口外面（真栽过：点击落在输入框上）。
  await tester.ensureVisible(f.first);
  await tester.pumpAndSettle();
  await tester.tap(f.first);
  await tester.pumpAndSettle();
}

/// 聊天那一屏的滚动位置（手势都作用在它上面）。
/// 聊天那一屏里那个滚动列表（**要指名**：批 5 起这一栏里也有一个滚动面）。
Finder _chatList(WidgetTester tester) => find
    .descendant(of: find.byKey(chatBodyKey), matching: find.byType(ListView))
    .first;

double _chatOffset(WidgetTester tester) => tester
    .state<ScrollableState>(
      find.descendant(of: find.byKey(chatBodyKey), matching: find.byType(Scrollable)).first,
    )
    .position
    .pixels;

void main() {
  testWidgets('★ 那颗按钮在会话头上（命中区 ≥44），点了真的滑进来、再点真的收起来', (tester) async {
    await _pump(tester, _twoTurns());

    expect(find.byKey(filePanelButtonKey), findsOneWidget);
    // ⚠️ 先**真的把语义树打开**，再量命中区、再看那个名字。
    final handle = tester.ensureSemantics();
    final node = tester.getSemantics(find.byKey(filePanelButtonKey));
    final r = node.rect;
    expect(r.width >= 44 && r.height >= 44, isTrue, reason: '命中区 $r 小于 44×44');
    // DSH 那颗按钮带无障碍名（`aria-label="打开右侧边栏"`）。
    // ⚠️ 它落在语义节点的 **`tooltip`** 那一格（`IconButton.tooltip` 就是这么下来的），
    //    不是 `label` —— `find.bySemanticsLabel` 找的是 `label`，所以这里直接量那一格。
    expect(node.tooltip, filePanelOpenLabel);
    expect(node.getSemanticsData().flagsCollection.isButton, isTrue);
    expect(node.getSemanticsData().hasAction(SemanticsAction.tap), isTrue, reason: '它得真的按得动');

    await _openPanel(tester);
    expect(
      // ⚠️ 用 `RegExp`：这一栏的语义节点是**合并**出来的（`label` 里是几行拼起来的），
      //    精确相等匹配不上（第一版就是这么误报的）。
      find.bySemanticsLabel(RegExp(filePanelTitle)),
      findsWidgets,
      reason: '那一栏自己也该有个名字（读屏进得来）',
    );
    handle.dispose();
    // 开着的时候那颗展开按钮**收起来**（DSH：`ExpandButton renders null while shown`）
    expect(find.byKey(filePanelButtonKey), findsNothing);
    expect(find.byKey(filePanelCloseKey), findsOneWidget);

    await tester.tap(find.byKey(filePanelCloseKey));
    await tester.pumpAndSettle();
    expect(find.byKey(filePanelButtonKey), findsOneWidget, reason: '关掉之后按钮该回来');
  });

  testWidgets('★ 一行行真的画出来：轮分组头 / 路径 / 是哪个工具碰的 / 最新在上', (tester) async {
    await _pump(tester, _twoTurns());
    await _openPanel(tester);

    // 两个分组头都在；抬头底下那一行是"N 轮 · M 处"（**逐轮相加**的口径）
    expect(find.byKey(filePanelTurnKey(1)), findsOneWidget);
    expect(find.byKey(filePanelTurnKey(2)), findsOneWidget);
    expect(find.text(filePanelCountLine(2, 3)), findsOneWidget);

    // 一行行：路径原样 ＋ 是哪个工具碰的
    expect(find.text('/w/账本.txt'), findsNWidgets(2), reason: '两轮各改过一次 ⇒ 各一行（跨轮不合并）');
    expect(find.text('/w/摘要.md'), findsOneWidget);
    expect(find.text(filePanelToolLine(['write'])), findsNWidgets(2));
    expect(find.text(filePanelToolLine(['edit'])), findsOneWidget);

    // 🔴 最新那一轮在上：第 2 轮那个分组头要在第 1 轮上面
    final y2 = tester.getTopLeft(find.byKey(filePanelTurnKey(2))).dy;
    final y1 = tester.getTopLeft(find.byKey(filePanelTurnKey(1))).dy;
    expect(y2, lessThan(y1), reason: '抬头说的是"最近改的在上"');

    // 口径那一行（说的是哪一窗 —— 不许说成"整条聊天记录"）
    expect(find.text(filePanelOrderLine), findsOneWidget);
    expect(find.text(filePanelTitle), findsOneWidget);
  });

  testWidgets('★ 点一行 ⇒ 展开那一次的入参原文；服务端截过就如实说', (tester) async {
    await _pump(tester, _twoTurns());
    await _openPanel(tester);

    expect(find.text(filePanelArgsHead), findsNothing, reason: '默认收起');

    // ⚠️ 两次点同一行之间**必须让那一行重新可见**：展开会把这一行变高，
    //    它自己可能被顶出视口 ⇒ 直接 `tap` 会点到底下那条输入框上（真栽过）。
    //    ⇒ 点之前一律 `ensureVisible`。
    await _tapRow(tester, '/w/摘要.md');
    expect(find.text(filePanelArgsHead), findsOneWidget);
    expect(find.text('{"file_path":"/w/摘要.md"}'), findsOneWidget, reason: '入参是**原样**那串');
    // 没被截的**不许**说"截了"
    expect(find.textContaining('已截断'), findsNothing);

    // 再点一次收起来
    await _tapRow(tester, '/w/摘要.md');
    expect(find.text(filePanelArgsHead), findsNothing, reason: '再点一次该收起来（不是又展开一次）');

    // 第 2 轮那一条：服务端报了 `truncated` ⇒ 展开时必须说出来（截了不说 = 说假话）
    await _tapRow(tester, '/w/账本.txt');
    expect(find.text(filePanelArgsTruncatedLine(2000)), findsOneWidget);
  });

  testWidgets('★ 一窗里没有文件行 ⇒ 只给一句实话（不编行、也不画合计）', (tester) async {
    final c = _controller();
    c.ingest({
      'type': 'tool/call',
      'seq': 1,
      'turn': 1,
      'step': 1,
      'callId': 'c_1',
      'name': 'bash',
      'title': '看一眼目录',
      'args': '{"command":"ls"}',
    });
    await _pump(tester, c);
    await _openPanel(tester);

    expect(find.text(filePanelEmptyLine), findsOneWidget);
    // 反例：空的时候**不许**出现合计与分组头
    expect(find.text(filePanelCountLine(0, 0)), findsNothing);
    expect(find.byKey(filePanelTurnKey(1)), findsNothing);
    // 也不许出现"没有路径"那种编出来的行
    expect(find.byType(FileChangeRow), findsNothing);
  });

  testWidgets('🔴 开一下再关掉：聊天那一屏的**滚动位置一点都没动**', (tester) async {
    final c = _controller();
    for (var i = 1; i <= 30; i += 1) {
      c.ingest({
        'type': 'user/echo',
        'seq': i,
        'messageId': 'u_$i',
        'text': '第 $i 句',
        'at': 1758400000000 + i,
      });
    }
    await _pump(tester, c);

    // 像用户那样往上翻一段
    await tester.drag(_chatList(tester), const Offset(0, 600));
    await tester.pumpAndSettle();
    final before = _chatOffset(tester);
    expect(before, greaterThan(0), reason: '没翻上去 ⇒ 这条判据量不到东西');

    await _openPanel(tester);
    await tester.tap(find.byKey(filePanelCloseKey));
    await tester.pumpAndSettle();

    expect(_chatOffset(tester), before, reason: '开了那一栏再关掉，聊天那一屏跳位置了');
  });

  testWidgets('★ 面板里点一行**不许**动聊天那一屏的滚动位置', (tester) async {
    final c = _controller();
    for (var i = 1; i <= 30; i += 1) {
      c.ingest({
        'type': 'user/echo',
        'seq': i,
        'messageId': 'u_$i',
        'text': '第 $i 句',
        'at': 1758400000000 + i,
      });
    }
    c.ingest({
      'type': 'tool/call',
      'seq': 31,
      'turn': 1,
      'step': 1,
      'callId': 'c_1',
      'name': 'write',
      'args': '{"path":"/w/账本.txt"}',
    });
    await _pump(tester, c);
    await tester.drag(_chatList(tester), const Offset(0, 600));
    await tester.pumpAndSettle();
    final before = _chatOffset(tester);

    await _openPanel(tester);
    await tester.tap(find.byKey(filePanelRowKey('/w/账本.txt')));
    await tester.pumpAndSettle();
    expect(find.text(filePanelArgsHead), findsOneWidget, reason: '这一行真的展开了');
    expect(_chatOffset(tester), before, reason: '在那一栏里点一下，聊天不该跟着滚');
  });

  testWidgets('★ 地方够宽 ⇒ 那一栏**贴着右缘、与聊天并排**（挤，不是盖）', (tester) async {
    await _pump(tester, _twoTurns());
    final viewport = tester.getRect(find.byKey(chatBodyKey));

    await _openPanel(tester);
    final panel = tester.getRect(find.byKey(filePanelKey));
    // 挨着浮窗的右缘、而且真的占住了地方
    expect(panel.right, moreOrLessEquals(viewport.right, epsilon: 0.5));
    expect(panel.width, greaterThan(0));
    expect(panel.left, greaterThan(viewport.left), reason: '左边还该看得见聊天');
    // 高度上它占满视图那一块（不是一小条）
    expect(panel.height, greaterThan(0));
    // 挤的那一条路：**它旁边的聊天那一块真的变窄了**（两者加起来 = 浮窗内部宽）
    final chatBody = tester.getRect(find.byKey(chatBodyKey));
    expect(
      panel.left,
      lessThan(chatBody.right),
      reason: '面板的左缘必须在浮窗里面（挤），不是滑出去',
    );
  });

  testWidgets('★ 一行里没有"改了多少行 / 百分比 / 钱"那类数（我们收不到）', (tester) async {
    await _pump(tester, _twoTurns());
    await _openPanel(tester);

    expect(find.textContaining('%'), findsNothing);
    expect(find.textContaining('¥'), findsNothing);
    // ⚠️ 路径里**没有**数字，所以这条排的是"界面上凭空冒出来的行数"
    expect(find.textContaining('改了'), findsNothing);
    // 只有"轮 · 处"那一条合计（抬头那一行）
    expect(find.text(filePanelCountLine(2, 3)), findsOneWidget);
    // 每一组只说自己那一轮几个文件
    expect(find.text(filePanelTurnFiles(2)), findsOneWidget, reason: '第 1 轮那一组两个文件');
    expect(find.text(filePanelTurnFiles(1)), findsOneWidget, reason: '第 2 轮那一组一个文件');
  });
}
