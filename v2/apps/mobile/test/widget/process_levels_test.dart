// 过程两档**到底有没有画到屏幕上**（提示档，和 `busy_line_test.dart` 同一类）。
//
// ⚠️ 为什么非写不可：`test/unit` 能证明模型产出得对（`process_levels_test.dart` /
//    `process_steps_test.dart`），但"菜单里到底摆了哪几项 / 推理原文画没画 /
//    服务端还在发的 `step/*` 你画没画"**是"屏幕上看得见吗"的事**——
//    S2 那类缺陷（链子断在中间、屏幕上看不出来）只有把屏幕搭起来才能证伪。
//
// ⚠️ 它属于 `test/widget`（手册：**提示档，不是闸**）。
//    硬闸那一半（五档不溢出 / 命中区 ≥44）在 `accessibility_test.dart` 里。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/process_levels.dart';
import 'package:hupo_app/models/process_words.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/bubbles.dart';
import 'package:shared_preferences/shared_preferences.dart';

ChatController _controller({http.Client? client}) => ChatController(
  api: client == null ? Api(base: 'http://127.0.0.1:1') : Api(client: client),
  tokens: TokenStore(),
  token: client == null ? null : 'tok',
);

/// 一个不碰网络的控制器：`renew` 用假客户端回一份空 JSON（契约的"留旧令牌"那档）。
MockClient _fakeServer() => MockClient((_) async => http.Response('{}', 200));

Future<ChatController> _pump(WidgetTester tester, ProcessLevel level) async {
  final c = _controller();
  // 换档是本地设置 + 重连（这里没有流 ⇒ 只改档）
  await c.setLevel(level);
  await tester.pumpWidget(MaterialApp(home: ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {})));
  return c;
}

/// **从盘上读回来**（老设备的迁移路径）：不经过 `setLevel`，走 `start()` 那条真路。
Future<ChatController> _pumpFromDisk(WidgetTester tester, String stored) async {
  SharedPreferences.setMockInitialValues({'hupo_process_level': stored});
  final c = _controller(client: _fakeServer());
  await c.start(token: 'tok', openStream: false);
  await tester.pumpWidget(MaterialApp(home: ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {})));
  return c;
}

/// **像用户那样**打开过程菜单（顶栏那颗「过程」）。
Future<void> _openMenu(WidgetTester tester) async {
  final f = find.text(levelActionWords);
  await tester.ensureVisible(f.first);
  await tester.pumpAndSettle();
  await tester.tap(f.first);
  await tester.pumpAndSettle();
}

/// 菜单里那一行（按标题找），用来读它的选中态。
ListTile _tile(WidgetTester tester, String title) => tester
    .widgetList<ListTile>(find.byType(ListTile))
    .firstWhere((t) => (t.title! as Text).data == title);

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('★ 默认档（在做什么）：还是一句话，行为没变', (tester) async {
    final c = await _pump(tester, ProcessLevel.doing);
    c.ingest({'type': 'message/status', 'turn': 1, 'state': 'started'});
    await tester.pump();
    expect(find.text(busyFallback), findsOneWidget);
  });

  testWidgets('🔴 菜单里**恰好两项**：安静 / 步骤流水一个都不出现', (tester) async {
    final c = await _pump(tester, ProcessLevel.doing);
    await _openMenu(tester);

    expect(find.byType(ListTile), findsNWidgets(ProcessLevel.values.length));
    expect(find.byType(ListTile), findsNWidgets(2));
    expect(find.text(ProcessLevel.doing.title), findsOneWidget);
    expect(find.text(ProcessLevel.reasoning.title), findsOneWidget);
    // ★ 负向对照：砍掉的那两条**一个字都不许出现**
    expect(find.text('安静'), findsNothing, reason: '那一档做不到它名字说的事，已砍');
    expect(find.text('步骤流水'), findsNothing, reason: '工具行已经说得更准更全，已砍');
    // 盘上是空的 ⇒ 默认档必须是**选中**的那一项（菜单不许"一项都没选中"）
    expect(_tile(tester, ProcessLevel.doing.title).selected, isTrue);
    expect(_tile(tester, ProcessLevel.reasoning.title).selected, isFalse);
    expect(c.level, ProcessLevel.doing);
  });

  testWidgets('🔴 盘上存着老档 `steps` ⇒ 读出来是 `doing`，菜单上"在做什么"选中', (tester) async {
    final c = await _pumpFromDisk(tester, 'steps');
    expect(c.level, ProcessLevel.doing, reason: '那一档已砍 ⇒ 必须归一到默认档');
    await _openMenu(tester);
    expect(_tile(tester, ProcessLevel.doing.title).selected, isTrue);
    expect(_tile(tester, ProcessLevel.reasoning.title).selected, isFalse);
  });

  testWidgets('🔴 盘上存着老档 `quiet` ⇒ 同上（归一，不是"没有选中项"）', (tester) async {
    final c = await _pumpFromDisk(tester, 'quiet');
    expect(c.level, ProcessLevel.doing);
    await _openMenu(tester);
    expect(_tile(tester, ProcessLevel.doing.title).selected, isTrue);
  });

  testWidgets('★ 盘上存着 `reasoning` ⇒ 照旧选中"它心里想的"（负向对照）', (tester) async {
    final c = await _pumpFromDisk(tester, 'reasoning');
    expect(c.level, ProcessLevel.reasoning);
    await _openMenu(tester);
    expect(_tile(tester, ProcessLevel.reasoning.title).selected, isTrue);
    expect(_tile(tester, ProcessLevel.doing.title).selected, isFalse);
  });

  testWidgets('🔴 不认识的 token ⇒ 默认档、不抛、菜单照开', (tester) async {
    final c = await _pumpFromDisk(tester, 'loud-not-a-level');
    expect(c.level, ProcessLevel.doing);
    await _openMenu(tester);
    expect(find.byType(ListTile), findsNWidgets(2));
  });

  testWidgets('🔴 推理档下：服务端仍发来的 `step/*` **不再画**，推理原文照旧画', (tester) async {
    // 服务端那两档（`steps` / `reasoning`）都发 `step/*`（累加的梯子）⇒
    // 新客户端在推理档下**收得到**它，但界面**一个像素都不该画**（契约 §三）。
    final c = await _pump(tester, ProcessLevel.reasoning);
    c.ingest({'type': 'message/status', 'turn': 1, 'state': 'started'});
    c.ingest({'type': 'step/start', 'turn': 1, 'step': 1, 'state': 'searching'});
    c.ingest({'type': 'step/start', 'turn': 1, 'step': 2, 'state': 'writing'});
    c.ingest({'type': 'message/start', 'messageId': 'm1', 'seq': 1});
    c.ingest({'type': 'reasoning/delta', 'turn': 1, 'text': '先看看他问的是哪一周'});
    await tester.pump();

    expect(find.text('在查资料'), findsNothing, reason: '步骤那一档已砍 ⇒ 收了也不画');
    expect(find.text('在写'), findsNothing);
    // 内部状态名一个都不许上屏
    expect(find.textContaining('searching'), findsNothing);
    expect(find.textContaining('writing'), findsNothing);
    // ★ 保留的那一档照旧：推理原文与它的标题都在
    expect(find.text(reasoningLabel), findsOneWidget);
    expect(find.text('先看看他问的是哪一周'), findsOneWidget);
  });

  testWidgets('🔴 默认档（在做什么）下：`step/*` 也不画（负向对照）', (tester) async {
    final c = await _pump(tester, ProcessLevel.doing);
    c.ingest({'type': 'message/status', 'turn': 1, 'state': 'started'});
    c.ingest({'type': 'step/start', 'turn': 1, 'step': 1, 'state': 'searching'});
    await tester.pump();
    expect(find.text('在查资料'), findsNothing);
    expect(find.text(busyFallback), findsOneWidget, reason: '这一档要有一句话');
  });

  testWidgets('★ 推理原文：正文和标题都在屏幕上，而且**不在气泡里**', (tester) async {
    final c = await _pump(tester, ProcessLevel.reasoning);
    c.ingest({'type': 'message/start', 'messageId': 'm1', 'seq': 1});
    c.ingest({'type': 'reasoning/delta', 'turn': 1, 'text': '先看看他问的是哪一周'});
    await tester.pump();

    expect(find.text(reasoningLabel), findsOneWidget);
    expect(find.text('先看看他问的是哪一周'), findsOneWidget);
    // ★ 视觉上必须和"它说的话"分得开：它是**另一种容器**，不是回答气泡。
    expect(
      find.ancestor(of: find.text('先看看他问的是哪一周'), matching: find.byType(AnswerBubble)),
      findsNothing,
      reason: '推理原文被塞进了"它说的话"那个气泡里 —— D7.4 要求两者分得开',
    );
  });

  testWidgets('🔴 收口之后：**推理还挂在它那条气泡下面**（步骤不画）', (tester) async {
    // 这是批 3 改过一次的地方：一出答案就把推理删掉，推理档就只剩
    // "生成过程中盯着看"；而它真正的用处是主人**回头看它当时怎么想的**。
    final c = await _pump(tester, ProcessLevel.reasoning);
    c.ingest({'type': 'message/status', 'turn': 1, 'state': 'started'});
    c.ingest({'type': 'step/start', 'turn': 1, 'step': 1, 'state': 'searching'});
    c.ingest({'type': 'message/start', 'messageId': 'm1', 'seq': 1});
    c.ingest({'type': 'message/text', 'messageId': 'm1', 'block': 'quick', 'text': '晴天', 'seq': 2});
    c.ingest({'type': 'reasoning/delta', 'turn': 1, 'text': '他问的是明天'});
    await tester.pump();
    expect(find.text('在查资料'), findsNothing, reason: '步骤那一档已砍 ⇒ 一开始就不画');

    c.ingest({'type': 'message/end', 'messageId': 'm1', 'seq': 3, 'reason': 'completed'});
    await tester.pump();

    expect(find.text('他问的是明天'), findsOneWidget, reason: '推理是内容 ⇒ 留着供主人回头看');
    expect(find.text(reasoningLabel), findsOneWidget);
  });

  testWidgets('🔴 重放（服务端说号不对了）⇒ 推理必须从屏幕上消失', (tester) async {
    // 它本来就不该存在于任何地方（契约 §二）⇒ reset 是它的终点。
    final c = await _pump(tester, ProcessLevel.reasoning);
    c.ingest({'type': 'message/start', 'messageId': 'm1', 'seq': 1});
    c.ingest({'type': 'reasoning/delta', 'turn': 1, 'text': '不该留下的'});
    await tester.pump();
    expect(find.text('不该留下的'), findsOneWidget);

    c.ingest({'type': '__reset__'});
    await tester.pump();
    expect(find.text('不该留下的'), findsNothing);
    expect(find.text(reasoningLabel), findsNothing);
  });

  testWidgets('★ 换出推理档 ⇒ 推理下屏；换回来还看得见（是隐藏，不是删）', (tester) async {
    final c = await _pump(tester, ProcessLevel.reasoning);
    c.ingest({'type': 'message/start', 'messageId': 'm1', 'seq': 1});
    c.ingest({'type': 'reasoning/delta', 'turn': 1, 'text': '心里过的那些话'});
    await tester.pump();
    expect(find.text('心里过的那些话'), findsOneWidget);

    await c.setLevel(ProcessLevel.doing);
    await tester.pump();
    expect(find.text('心里过的那些话'), findsNothing, reason: '换了档就不许再占屏幕');
    expect(find.text(reasoningLabel), findsNothing);

    await c.setLevel(ProcessLevel.reasoning);
    await tester.pump();
    expect(find.text('心里过的那些话'), findsOneWidget, reason: '没删 ⇒ 换回来还看得见');
  });
}
