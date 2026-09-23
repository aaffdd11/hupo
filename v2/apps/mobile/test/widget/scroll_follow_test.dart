// 「打开就看到最新的话」（欠账第 24 条）——**屏幕上真的跟到底了吗**。
//
// ⚠️ 为什么非写不可：`test/unit/scroll_follow_test.dart` 只证明**判据**对，
//    而第 24 条的形状恰恰是"判据接错了线/该调的时候没调"——
//    那种缺陷只有把屏幕搭起来、喂一屏放不下的历史才证得出来。
//    这正是 `busy_line_test.dart` / `process_levels_test.dart` 存在的理由：
//    **"这件事到底有没有画到屏幕上"**。
//
// ⚠️ 它属于 `test/widget`（手册：**提示档，不是闸**）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

ChatController _controller() =>
    ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore());

/// 喂一屏放不下的历史（默认测试窗口 800×600，一条气泡 ~50px）。
///
/// ⚠️ **每一条都要带 `seq`**：不带 `seq` 的事件走的是**瞬态**那条路
///    （决策 P-g：不占号 = 不上时间线），连 `message/start` 都不会新建气泡。
///    真协议里 `message/start` 是落盘事件，所以这里也照那样喂。
void _feedHistory(ChatController c, int rounds) {
  var seq = 1;
  for (var i = 1; i <= rounds; i += 1) {
    c.ingest({'type': 'user/echo', 'seq': seq++, 'messageId': 'u$i', 'text': '第 $i 句'});
    c.ingest({'type': 'message/start', 'messageId': 'm$i', 'seq': seq++});
    c.ingest({'type': 'message/text', 'messageId': 'm$i', 'block': 'quick', 'text': '第 $i 答', 'seq': seq++});
    c.ingest({'type': 'message/end', 'messageId': 'm$i', 'seq': seq++, 'reason': 'completed'});
  }
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('🔴 打开就停在**最新**那一条：一屏放不下的历史也不许停在最老', (tester) async {
    final c = _controller();
    await tester.pumpWidget(MaterialApp(home: ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {})));
    _feedHistory(c, 40);
    await tester.pumpAndSettle();

    expect(find.text('第 40 句'), findsOneWidget, reason: '★ 最新那句必须在屏幕上（第 24 条）');
    expect(find.text('第 1 句'), findsNothing, reason: '★ 最老那条应该在屏幕外面 —— 它还在屏幕上就说明没跟到底');
  });

  // 🔴 **这一条打的是"真应用那条路"**（主人 2026-09-23 报的）：
  //    真应用**从收起档开始**（默认档），而展开档才会**建出**时间线
  //    ⇒ 那个新视口从偏移 0 开始 = 停在**最早**那条。
  //    ⚠️ 上面那两条判据全都从 `initialTier: FloaterTier.full` 进 —— 恰好绕过它。
  testWidgets('🔴 **展开之后**停在最新（收起档进 ⇒ 点"展开" ⇒ 不许停在最早）', (tester) async {
    final c = _controller();
    // ⚠️ 默认档就是收起（`ChatScreen.initialTier` 的默认值）—— 别显式传 full
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(controller: c, onLoggedOut: () {})),
    );
    _feedHistory(c, 80);
    await tester.pumpAndSettle();
    // 收起档里没有列表（也不该有那一屏）
    expect(find.text('第 80 句'), findsNothing, reason: '收起档本来就不画时间线');

    await tester.tap(find.byKey(chatHandleKey));
    await tester.pumpAndSettle();

    expect(
      find.text('第 80 句'),
      findsOneWidget,
      reason: '★ 展开之后必须停在**最新**那一条（主人 2026-09-23 报的缺陷）',
    );
    // ⚠️ **最后那条回答也要在屏幕上**（不只是最后那句用户的话）：
    //    列表是懒加载的 —— 只跳一次会**差一条**（实测：最后一句被输入条切掉、
    //    它的回答还在下面）。多喂一点历史 + 看最后那条回答，才量得出这件事。
    expect(
      find.text('第 80 答'),
      findsOneWidget,
      reason: '★ 连最后那条回答都得露出来（懒加载会让 maxScrollExtent 跳完又长）',
    );
    expect(
      find.text('第 1 句'),
      findsNothing,
      reason: '★ 最老那条不许出现在屏幕上 —— 出现就说明展开时停在了最早',
    );
  });

  testWidgets('历史短到一屏放得下 ⇒ 全都看得见（跟随不许把内容弄没）', (tester) async {
    final c = _controller();
    await tester.pumpWidget(MaterialApp(home: ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {})));
    _feedHistory(c, 2);
    await tester.pumpAndSettle();

    expect(find.text('第 1 句'), findsOneWidget);
    expect(find.text('第 2 答'), findsOneWidget);
  });

  testWidgets('新的一句进来 ⇒ 屏幕自己跟下去（不用手划）', (tester) async {
    final c = _controller();
    await tester.pumpWidget(MaterialApp(home: ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {})));
    _feedHistory(c, 20);
    await tester.pumpAndSettle();
    expect(find.text('第 20 句'), findsOneWidget);

    c.ingest({'type': 'user/echo', 'seq': 999, 'messageId': 'u_new', 'text': '刚刚说的那句'});
    await tester.pumpAndSettle();
    expect(find.text('刚刚说的那句'), findsOneWidget);
  });
}
