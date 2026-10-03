// **聊天的"间距"**（主人 2026-10-01：*「聊天内容里面字体变小了，但是间距有问题」* ·
// 契约 `docs/dev/119-APPEARANCE-AND-FONT.md` §十·补）。
//
// ── 这一份钉什么（都是**量屏幕上真渲染出来的东西**，不是读常量）──────────────
//   ① 🔴 **每一条之间**那一条空当：上下各 `DshChatSpace.bubbleGap` ⇒
//      两个气泡之间 **≤ 6**（原来是 4+4＝8，加上时间线上下留白 8；字缩小之后显得很空）；
//   ② 🔴 **工具行那一行的高度**：原来行里那颗展开按钮是**默认 48** 的 `IconButton`
//      ⇒ 11 号字那一行被撑到 56+；现在图形 18、**可点区域仍 ≥44**（D3.6 不许放宽）
//      ⇒ 行高 ≤ 50 且 ≥ 44；
//   ③ 🔴 **标题行右边那颗「收起」**：图形收到 18（原来 24），可点区域仍 ≥44。
//
// ⚠️ 提示档（`AGENTS.md` §5.1：`test/widget` 只有可访问性那一份是硬闸），
//    但它是"这一刀到底有没有画到屏幕上"的唯一自动化证据；
//    "命中区 ≥44"那一条在 `accessibility_test.dart`（硬闸）里仍然管着。
//
// ⚠️ 每一条都从**真入口**进：`controller.ingest` 喂服务端那一帧的形状（和线上一模一样），
//    而不是直接把某个控件泵出来。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/dsh_design.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/bubbles.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/widgets/tool_row_view.dart';
import 'package:hupo_app/widgets/row_entry.dart';
import 'package:shared_preferences/shared_preferences.dart';

ChatController _controller() => ChatController(
  api: Api(base: 'http://127.0.0.1:1'),
  tokens: TokenStore(),
  token: 'tok',
);

/// 两条**回话**（他一句、它一句 ⇒ 时间线上就是两个气泡）。
///
/// ⚠️ 形状照服务端真发的那两帧（`message/start` ＋ `message/text`；
///    见 `accessibility_test.dart` / `busy_line_test.dart` 那两处的 `c.ingest`）。
Future<void> _feedTwo(WidgetTester tester) async {
  final c = _controller();
  c.ingest({'type': 'user/echo', 'seq': 1, 'messageId': 'u1', 'text': '这一条是他的话'});
  c.ingest({'type': 'message/start', 'seq': 2, 'messageId': 'm2', 'block': 'quick'});
  c.ingest({'type': 'message/text', 'seq': 3, 'messageId': 'm2', 'block': 'quick', 'text': '这一条是它的回答'});
  await tester.pumpWidget(
    MaterialApp(
      home: ChatScreen(
        initialTier: FloaterTier.full,
        controller: c,
        onLoggedOut: () {},
        space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: true),
        onSendKey: (_) async => KeySend.ok,
      ),
    ),
  );
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  testWidgets('🔴 字缩小之后"围在它周围的那圈空当"也收了（气泡高度 ≤ 42）', (tester) async {
    await _feedTwo(tester);
    await tester.pumpAndSettle();

    // ⚠️ 量的是**气泡本身**（`UserBubble` / `AnswerBubble`）——
    //    量正文那两个 `Text` 的话，中间还夹着"已收到"那一行（那是气泡里的东西）。
    final h = tester.getRect(find.byType(UserBubble));
    final a = tester.getRect(find.byType(AnswerBubble));
    expect(h.height > 0 && a.height > 0, true, reason: '前提：两条都在树上');

    // ① **一句话的回话**：气泡高 = 正文一行（20）＋ 上下的内边距（8×2）＋ 上下 margin（2×2）
    //    ⇒ 40。原来（正文 24 ＋ padV 10 ＋ margin 4）是 52。这里就钉"它真的收了"。
    expect(
      a.height,
      lessThanOrEqualTo(42),
      reason: '★ 这句话只有一个字高，气泡却 ${a.height} 高 —— 那圈空当没跟着字收',
    );
    expect(a.height, greaterThanOrEqualTo(20), reason: '前提：至少装得下一行字');

    // ② **两条之间不再多出一条缝**（那圈空当在气泡自己的 margin 里，别再叠一层）
    expect(
      a.top - h.bottom,
      lessThanOrEqualTo(1),
      reason: '★ 两条之间多出 ${a.top - h.bottom} 的缝（那一层不该有）',
    );
  });

  testWidgets('🔴 工具行那一行：字缩了，行也收（≤50）而**可点区域仍 ≥44**', (tester) async {
    final c = _controller();
    c.ingest({'type': 'message/status', 'turn': 1, 'state': 'started'});
    c.ingest({
      'type': 'tool/call',
      'seq': 2,
      'turn': 1,
      'step': 1,
      'callId': 'c_1',
      'name': 'bash',
      'title': '跑一下测试',
      'args': '{"command":"ls"}',
    });
    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(
          initialTier: FloaterTier.full,
          controller: c,
          onLoggedOut: () {},
        ),
      ),
    );
    await tester.pumpAndSettle();

    // 🔴 2026-10-03（主人：*"那个右边点一下展开的箭头，行高明显占用太大了……
    //    这个箭头要重新设计"*）：这一行改成**整行可点**（`DshRowEntry`），
    //    右边那颗箭头只当指示 ⇒ 行高**跟着文字走**（原来那颗 44×44 的按钮把它撑到 50）。
    final row = tester.getRect(find.byType(ToolRowView).first);
    expect(row.height, lessThanOrEqualTo(50), reason: '★ 工具行还是被撑高了（实测 ${row.height}）');
    expect(row.height, lessThan(44), reason: '★ 这一版就是要它跟着文字走（实测 ${row.height}）');
    // 而**命中区**照旧够：整行都是入口 ⇒ 按**面积**算（D3.6 行级那一档）
    final entry = tester.getRect(
      find.descendant(of: find.byType(ToolRowView).first, matching: find.byType(DshRowEntry)).first,
    );
    expect(entry.width, greaterThanOrEqualTo(44), reason: '行级入口的宽只有 ${entry.width}');
    expect(
      entry.width * entry.height,
      greaterThanOrEqualTo(44 * 44),
      reason: '行级入口的面积只有 ${entry.width}×${entry.height}（要 ≥ 1936）',
    );
    // 点**行的左边**（不是箭头那一格）也要能展开 —— 整行才是入口
    await tester.tapAt(Offset(entry.left + 4, entry.center.dy));
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.keyboard_arrow_down), findsWidgets,
        reason: '★ 点行左边也该展开（整行可点）');
  });

  testWidgets('🔴 标题行右边那颗「收起」：图形 18，可点区域仍 ≥44', (tester) async {
    await _feedTwo(tester);
    await tester.pumpAndSettle();
    final btn = find.byWidgetPredicate(
      (w) => w is IconButton && w.tooltip == chatCollapse,
    );
    expect(btn, findsOneWidget, reason: '前提：那颗「收起」该在树上');
    final r = tester.getRect(btn);
    expect(r.height, greaterThanOrEqualTo(44), reason: '★ 命中区被收小了 —— D3.6 不许');
    expect(r.width, greaterThanOrEqualTo(44), reason: '★ 同上');
    // ⚠️ 同上：`Icon.size` 是 null（走 IconTheme）⇒ 量那颗按钮声明的大小
    expect(tester.widget<IconButton>(btn).iconSize, DshChatSpace.headerIconSize,
        reason: '★ 图形该是收小的那个（18）');
    expect(DshChatSpace.headerIconSize < 24, true, reason: '★ 比默认 24 小才是"不占地方"');
  });
}
