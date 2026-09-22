// 桌面（底部一条）+ 聊天浮窗（四边 30 + 阴影 + 三档）：**画出来了没有**。
//
// 契约 `docs/dev/52-DESKTOP.md` · 手册 `08-SPEC.md` §六（Z1–Z4 / 6.2 三档 / 6.3 手势 / 6.5 无障碍）。
//
// ⚠️ 这一份是 `test/widget`（**提示档**），但它钉的是"这一刀到底有没有画到屏幕上"。
//    真正当闸的两条在别处：
//      · **五档不溢出 + 命中区 ≥44** → `accessibility_test.dart`（硬闸，已经跑过这一屏）；
//      · **桌面/浮窗的边距与档位** → 就是这一份（下面每条都带负向对照）。
//
// ⚠️ **默认是收起**（主人 2026-09-22 定：一进来看得见桌面）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/design.dart' as d;
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/app_desktop.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/widgets/composer.dart';

ChatController _controller() =>
    ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore());

Future<void> _pump(WidgetTester tester, {FloaterTier tier = FloaterTier.collapsed}) async {
  await tester.pumpWidget(
    MaterialApp(home: ChatScreen(initialTier: tier, controller: _controller(), onLoggedOut: () {})),
  );
  await tester.pump();
}

/// 浮窗那一块（`ChatFloater` 自己的矩形）。
Rect _floaterRect(WidgetTester tester) => tester.getRect(find.byType(ChatFloater));

void main() {
  testWidgets('🔴 一进来是**收起**那一档：看得见桌面，看不见输入条', (tester) async {
    await _pump(tester);
    // 桌面那一条在（带字的图标是 D3.8 的要求）
    expect(find.byType(AppDesktop), findsOneWidget);
    expect(find.text('会话'), findsOneWidget);
    // 收起态：有**带字的**展开入口（D3.8），没有输入条
    expect(find.text('展开'), findsOneWidget, reason: '收起态必须有带字的展开入口');
    expect(find.byType(Composer), findsNothing, reason: '收起时不该画输入条');
    // 负向对照：展开态才有的东西一个都不许在
    for (final w in ['说点什么']) {
      expect(find.text(w), findsNothing, reason: '收起态不该有「$w」');
    }
  });

  testWidgets('🔴 四边边距都是 30（Z3/Z4），桌面在浮窗**下面**', (tester) async {
    await _pump(tester, tier: FloaterTier.full);
    final screen = tester.getRect(find.byType(MaterialApp));
    final f = _floaterRect(tester);
    final desk = tester.getRect(find.byType(AppDesktop));
    const m = FloaterMetrics.margin;

    expect(f.left - screen.left, m, reason: '左边距');
    expect(screen.right - f.right, m, reason: '右边距');
    expect(f.top - screen.top, m, reason: '上边距');
    // 下边距 = 浮窗底到**桌面顶**（桌面是底部一条，浮窗浮在它上面）
    expect(desk.top - f.bottom, m, reason: '浮窗与桌面之间也是 $m');
    expect(desk.bottom, screen.bottom, reason: '桌面贴着屏幕底');

    // 负向对照：浮窗**不是铺满**（Z3：盖住不是铺满）
    expect(f.width < screen.width, true);
    expect(f.height < screen.height, true);
  });

  testWidgets('🔴 浮窗有阴影（不是靠描边假装浮着）', (tester) async {
    await _pump(tester, tier: FloaterTier.full);
    final shadows = <BoxShadow>[];
    for (final e in find.byType(DecoratedBox).evaluate()) {
      final dec = (e.widget as DecoratedBox).decoration;
      if (dec is BoxDecoration) shadows.addAll(dec.boxShadow ?? const []);
    }
    expect(shadows.isNotEmpty, true, reason: '浮窗必须有阴影（手册阈值总表：blur 32 · α.45 · offset(0,-6)）');
    final s = shadows.first;
    expect(s.blurRadius, 32);
    expect(s.offset.dy, -6);
    // 阴影颜色是从 ink 来的（不是随手一个黑）
    expect(s.color.a > 0, true);
    expect(s.color.r, closeTo(d.ink.r, 0.01));
  });

  testWidgets('🔴 点「展开」⇒ 真的开（输入条出现）', (tester) async {
    await _pump(tester);
    expect(find.byType(Composer), findsNothing);
    await tester.tap(find.text('展开'));
    await tester.pumpAndSettle();
    expect(find.byType(Composer), findsOneWidget, reason: '点了展开就该能说话');
    expect(find.text('展开'), findsNothing, reason: '开了之后不该还挂着「展开」');
  });

  testWidgets('🔴 点桌面空白 ⇒ 收起；点浮窗**内部** ⇒ 无反应（负向对照）', (tester) async {
    await _pump(tester, tier: FloaterTier.full);
    final before = _floaterRect(tester).height;

    // ① 点浮窗内部（中间那块空白）⇒ **不许**收起（§6.3：点浮窗内部无反应）
    final f = _floaterRect(tester);
    await tester.tapAt(Offset(f.center.dx, f.top + 12)); // 抓手行上的空白处
    await tester.pumpAndSettle();
    expect(_floaterRect(tester).height, before, reason: '点浮窗内部不该动它（更不该漏到桌面）');
    expect(find.byType(Composer), findsOneWidget);

    // ② 点桌面空白 ⇒ 收起
    final desk = tester.getRect(find.byType(AppDesktop));
    await tester.tapAt(Offset(desk.right - 20, desk.center.dy));
    await tester.pumpAndSettle();
    expect(find.byType(Composer), findsNothing, reason: '点桌面空白该收起');
  });

  testWidgets('🔴 用户在输入条上按发送 ⇒ 最大化（"发就拉满"）', (tester) async {
    await _pump(tester, tier: FloaterTier.half);
    final half = _floaterRect(tester).height;
    await tester.enterText(find.byType(TextField), '在吗');
    await tester.pump();
    await tester.tap(find.byTooltip('发送'));
    await tester.pump();
    expect(_floaterRect(tester).height > half, true, reason: '发送之后该拉满（$half → ${_floaterRect(tester).height}）');
  });

  testWidgets('🔴 拖**时间线**仍然滚动（手势只绑抓手行，不吃列表滚动）', (tester) async {
    // ⚠️ 这条是回归判据：第一版把拖拽手势挂在整块浮窗上 ⇒ 拖时间线被当成"改窗口高度"，
    //    而当时只有"重发"那条判据红了。这里把它钉住。
    //
    // ⚠️ 得先**喂几条话**：空屏画的是 `_EmptyState`，**根本没有 `ListView`** ——
    //    拿不到列表就量不了"拖它会不会改窗口高度"（第一版这条判据就是这么空转的）。
    final c = _controller();
    var seq = 1;
    for (var i = 1; i <= 6; i += 1) {
      c.ingest({'type': 'user/echo', 'seq': seq++, 'messageId': 'u$i', 'text': '第 $i 句'});
      c.ingest({'type': 'message/start', 'messageId': 'm$i', 'seq': seq++});
      c.ingest({'type': 'message/text', 'messageId': 'm$i', 'block': 'quick', 'text': '第 $i 答', 'seq': seq++});
      c.ingest({'type': 'message/end', 'messageId': 'm$i', 'seq': seq++, 'reason': 'completed'});
    }
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {})),
    );
    await tester.pump();
    expect(find.byType(ListView), findsOneWidget, reason: '喂了话之后时间线该在');
    final before = _floaterRect(tester).height;
    await tester.drag(find.byType(ListView), const Offset(0, -120));
    await tester.pumpAndSettle();
    expect(_floaterRect(tester).height, before, reason: '拖时间线不该改浮窗高度');
  });

  testWidgets('🔴 桌面那一条**横跨整宽**（不是"内容那么宽"居中）', (tester) async {
    // ⚠️ 2026-09-22 实测抓到的：外层 `Column` 默认 `crossAxisAlignment: center`
    //    ⇒ 桌面那一条被缩成 **100px 宽、居中**（截图上看不出来：它底色跟页面一样）。
    //    ⇒ 一条判据钉住"它是横跨整宽的底部一条"。
    await _pump(tester);
    final desk = tester.getRect(find.byType(AppDesktop));
    final screen = tester.getRect(find.byType(MaterialApp));
    expect(desk.left, screen.left, reason: '桌面左边该贴屏幕左');
    expect(desk.right, screen.right, reason: '桌面右边该贴屏幕右');
    expect(desk.width, screen.width, reason: '桌面该横跨整宽（实测过它只有 ${desk.width}）');
  });

  testWidgets('🔴 收起态的「展开」命中区 ≥44（D3.6/D3.8）', (tester) async {
    await _pump(tester);
    // 文字本身可能小，但**它那个按钮**的命中区要够 —— 量按钮（D3.6：视觉可以小）
    final btn = tester.getRect(
      find.ancestor(of: find.text('展开'), matching: find.byType(TextButton)),
    );
    expect(btn.height >= 44, true, reason: '展开按钮命中区只有 ${btn.height}');
    expect(btn.width >= 44, true, reason: '展开按钮命中区只有 ${btn.width}');
  });

  testWidgets('🔴 双击抓手 ⇒ 收起（§6.3 的手势表）', (tester) async {
    await _pump(tester, tier: FloaterTier.full);
    expect(find.byType(Composer), findsOneWidget);
    // 双击 = 两次点击落在判定窗内（实现里是 Listener + 时间窗，不是 GestureDetector）
    await tester.tap(find.text('助手'));
    await tester.pump(const Duration(milliseconds: 40));
    await tester.tap(find.text('助手'));
    await tester.pumpAndSettle();
    expect(find.byType(Composer), findsNothing, reason: '双击抓手该收起');
    expect(find.text('展开'), findsOneWidget);
  });

  testWidgets('🔴 拖抓手行向上 ⇒ 跟手变高，松手吸附到更大的一档', (tester) async {
    await _pump(tester, tier: FloaterTier.collapsed);
    final collapsed = _floaterRect(tester).height;
    await tester.drag(find.text('助手'), const Offset(0, -260));
    await tester.pumpAndSettle();
    final after = _floaterRect(tester).height;
    expect(after > collapsed, true, reason: '往上拖该变高（$collapsed → $after）');
    expect(find.byType(Composer), findsOneWidget, reason: '拖开之后该能说话');
  });
}
