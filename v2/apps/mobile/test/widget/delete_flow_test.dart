// 「删掉」这条路**画到屏幕上之后**长什么样（契约 `docs/dev/28-DELETE.md`）。
//
// ⚠️ 纯逻辑那半边在 `test/unit/trash_test.dart`（分组 / 隐藏判定 / 本机两份的清）。
//    这一份只钉**屏幕上看到的东西**——也就是这一件唯一的硬判据：
//
//     🔴 **删完之后屏幕上不许再出现那一轮的任何字**（含冷启动那一屏 · §四）
//
//    以及"清单必须照实显示"（§四 / §五：`cannot` 那种是诚实的交代，
//    不许省略、不许美化成"已全部删除"）。
//
// ⚠️ 这几条是**提示档**（`test/widget` 的通用规矩），但它们是"这件事到底有没有
//    画到屏幕上"的唯一自动化证据 ⇒ 别删。

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/message_state.dart';
import 'package:hupo_app/models/trash_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/draft_store.dart';
import 'package:hupo_app/services/timeline_store.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _userText = '帮我把这周工时记一下';
const _answerText = '这周 7 小时。';
const _userId = 'u_1';
const _answerId = 'm_1';

/// 假回执。⚠️ 必须带 `charset=utf-8`（中文正文）。
http.Response _json(String body, [int status = 200]) => http.Response(
      body,
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

/// 一份**这一轮**的服务端事实（都带号 ⇒ 进得了本机缓存）。
List<Map<String, dynamic>> _facts() => [
      {'type': 'user/echo', 'seq': 1, 'messageId': _userId, 'text': _userText},
      {'type': 'message/start', 'seq': 2, 'messageId': _answerId},
      {'type': 'message/text', 'seq': 3, 'messageId': _answerId, 'block': 'quick', 'text': _answerText},
      {'type': 'message/end', 'seq': 4, 'messageId': _answerId, 'reason': 'completed'},
    ];

/// 一份"清单里有一条删不掉"的假服务端。
MockClient _server({
  int removeStatus = 200,
  String removeBody = '{"ok":true,"messageIds":["u_1","m_1"],"purgeAt":1758400000000}',
}) =>
    MockClient((r) async {
      switch (r.url.path) {
        case '/api/trash/plan':
          return _json(jsonEncode({
            'messageIds': [_userId, _answerId],
            'items': [
              {'what': '可见的那几句', 'where': '这台设备', 'verdict': 'delete', 'note': '这一屏上看得到的，会跟着清掉'},
              {
                'what': '它记住的那一段',
                'where': '记忆里',
                'verdict': 'cannot',
                'note': '要等这段对话的记忆被重建才会消失',
              },
            ],
            'purgeAt': 1758400000000,
            'ttlDays': 30,
          }));
        case '/api/trash/remove':
          return _json(removeBody, removeStatus);
        default:
          return _json('{}');
      }
    });

ChatController _controller({
  MockClient? client,
  TimelineStore? local,
  DraftStore? drafts,
}) {
  final c = ChatController(
    api: Api(client: client ?? _server()),
    tokens: TokenStore(),
    token: 'tok',
    local: local,
    drafts: drafts,
  );
  addTearDown(c.dispose);
  return c;
}

/// 把主界面挂起来，并灌进"上一次开机存下来的那一轮"。
Future<void> _pumpChat(WidgetTester tester, ChatController c) async {
  for (final e in _facts()) {
    c.ingest(e);
  }
  await tester.pumpWidget(MaterialApp(home: ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {})));
  await tester.pump();
}

Future<void> _longPressAnswer(WidgetTester tester) async {
  await tester.longPress(find.text(_answerText));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('🔴 删掉之后：那一轮的字**一个都不许留在屏幕上**', (tester) async {
    final c = _controller();
    await _pumpChat(tester, c);
    expect(find.text(_userText), findsOneWidget);
    expect(find.text(_answerText), findsOneWidget);

    // 长按 → 菜单 → 删掉 → （清单）→ 删掉
    await _longPressAnswer(tester);
    await tester.tap(find.text(bubbleMenuDelete));
    await tester.pumpAndSettle();
    await tester.tap(find.text(planConfirm));
    await tester.pumpAndSettle();

    expect(find.text(_userText), findsNothing, reason: '★ 用户那句不许还在');
    expect(find.text(_answerText), findsNothing, reason: '★ 回答那句不许还在');
    // 而且**如实说了一句做了什么**
    expect(find.text(trashDeletedLine), findsOneWidget);
  });

  testWidgets('🔴 冷启动那一屏也不许出现那一轮的字（本机缓存跟着清了）', (tester) async {
    // 上一次开机：这一轮在缓存里 + 墓碑也在（事件都带号）
    await TimelineStore().save([
      ..._facts(),
      {'type': 'turn/deleted', 'seq': 5, 'messageIds': [_userId, _answerId]},
    ]);
    // 另有**一句不相干**的话（本机还没发出去的）——它必须还在：
    // 这是这条闸的负向对照（不然"屏幕上什么都没有"也可能是根本没画出来）。
    await DraftStore().save([
      const LocalDraft(messageId: 'u_draft', text: '这句我还没发出去', state: MessageState.failed),
    ]);

    final c = _controller(local: TimelineStore(), drafts: DraftStore());
    // ⚠️ `openStream: false`：这里测的是**冷启动那一屏**，不开真 socket
    await c.start(token: 'tok', openStream: false);
    await tester.pumpWidget(MaterialApp(home: ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {})));
    await tester.pump();

    expect(find.text(_userText), findsNothing, reason: '★ 冷启动那一屏也不许出现那一轮的字');
    expect(find.text(_answerText), findsNothing);
    expect(find.text('这句我还没发出去'), findsOneWidget, reason: '负向对照：这一屏不是空的');
  });

  testWidgets('🔴 删前清单：`cannot` 那条**照实显示**（那几句话必须在屏幕上）', (tester) async {
    final c = _controller();
    await _pumpChat(tester, c);
    await _longPressAnswer(tester);
    await tester.tap(find.text(bubbleMenuDelete));
    await tester.pumpAndSettle();

    // 会删的那条
    expect(find.text(planItemTitle('可见的那几句', '这台设备')), findsOneWidget);
    // ★ 删不掉的那条：名字、那句"删不掉"、以及**服务端写的原话**都要在
    expect(find.text(planItemTitle('它记住的那一段', '记忆里')), findsOneWidget);
    expect(find.text(verdictLabel('cannot')), findsOneWidget);
    expect(find.text('要等这段对话的记忆被重建才会消失'), findsOneWidget,
        reason: '★ 那句解释是服务端给的原话，不许改写、更不许省略');
    // 而且显眼地说了一句"有一条删不掉"
    expect(find.text(planCannotLine), findsOneWidget);

    // 退出来：什么都没删
    await tester.tap(find.text(planCancel));
    await tester.pumpAndSettle();
    expect(find.text(_answerText), findsOneWidget, reason: '"先不删" ⇒ 屏幕上什么都不许变');
  });

  testWidgets('🔴 删不成时**如实说**，而且屏幕上那条还在', (tester) async {
    final c = _controller(client: _server(removeStatus: 500, removeBody: '{"error":"boom"}'));
    await _pumpChat(tester, c);
    await _longPressAnswer(tester);
    await tester.tap(find.text(bubbleMenuDelete));
    await tester.pumpAndSettle();
    await tester.tap(find.text(planConfirm));
    await tester.pumpAndSettle();

    expect(find.text(trashDeleteFailedLine), findsOneWidget, reason: '成没成都要说');
    expect(find.text(_answerText), findsOneWidget, reason: '没删成 ⇒ 不许把它从屏幕上抹掉');
  });

  testWidgets('🔴 清单都拿不到 ⇒ 一个字都不许删（"先看清单"这一步不许绕）', (tester) async {
    final c = _controller(client: MockClient((r) async {
      if (r.url.path == '/api/trash/plan') return _json('{"error":"boom"}', 500);
      return _json('{"ok":true}');
    }));
    await _pumpChat(tester, c);
    await _longPressAnswer(tester);
    await tester.tap(find.text(bubbleMenuDelete));
    await tester.pumpAndSettle();

    expect(find.text(trashPlanFailedLine), findsOneWidget, reason: '拿不到清单要如实说');
    expect(find.text(planConfirm), findsNothing, reason: '★ 没清单就没有"删掉"那个按钮');
    expect(find.text(_answerText), findsOneWidget, reason: '★ 一个字都不许删');
  });

  testWidgets('长按**还没发出去**的那句：不给"删掉"这个入口（那会是个删不掉的动作）', (tester) async {
    final c = _controller();
    c.timeline.addLocalUtterance('这句我还没发出去', 'u_local');
    await tester.pumpWidget(MaterialApp(home: ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {})));
    await tester.pump();

    await tester.longPress(find.text('这句我还没发出去'));
    await tester.pumpAndSettle();
    expect(find.text(bubbleMenuDelete), findsNothing);
  });

  testWidgets('回收站页：列出条目 + 恢复 + 彻底删（彻底删要二次确认）', (tester) async {
    final c = ChatController(
      api: Api(
        client: MockClient((r) async {
          switch (r.url.path) {
            case '/api/trash':
              return _json(jsonEncode({
                'items': [
                  {
                    'messageIds': [_userId, _answerId],
                    'at': 1758400000000,
                    'purgeAt': 1758400000000,
                    'preview': _userText,
                  },
                ],
              }));
            default:
              return _json('{"ok":true}');
          }
        }),
      ),
      tokens: TokenStore(),
      token: 'tok',
    );
    addTearDown(c.dispose);
    await tester.pumpWidget(MaterialApp(home: ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {})));
    await tester.pump();
    await tester.tap(find.byTooltip(trashTooltip));
    await tester.pumpAndSettle();

    expect(find.text(trashTitle), findsOneWidget);
    expect(find.text(_userText), findsOneWidget, reason: '条目要列出来（预览）');
    expect(find.textContaining(trashPurge), findsWidgets, reason: '每条都要写明什么时候彻底删掉');

    // 彻底删 ⇒ 先弹二次确认（确认框里明说"拿不回来了"）
    await tester.tap(find.text(trashPurge).first);
    await tester.pumpAndSettle();
    expect(find.text(trashPurgeConfirmTitle), findsOneWidget);
    expect(find.text(trashPurgeConfirmBody), findsOneWidget);

    await tester.tap(find.text(trashPurgeConfirmNo));
    await tester.pumpAndSettle();
    expect(find.text(trashPurgeConfirmTitle), findsNothing, reason: '"算了" ⇒ 不删');

    // 恢复 ⇒ 一键就拿回来，而且如实说了一句
    await tester.tap(find.text(trashRestore));
    await tester.pumpAndSettle();
    expect(find.text(trashRestoredLine), findsOneWidget);
  });
}
