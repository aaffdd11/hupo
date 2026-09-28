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
import 'package:hupo_app/models/dsh_design.dart';
import 'package:hupo_app/models/design.dart' as d;
import 'package:hupo_app/models/hearing_words.dart';
import 'package:hupo_app/models/space_words.dart';
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
  testWidgets('🔴 一进来是**收起**那一档：看得见桌面，**输入框也在**，但时间线不画', (tester) async {
    await _pump(tester);
    // 桌面在（整页底图）
    expect(find.byType(AppDesktop), findsOneWidget);
    // 🔴 **桌面上不该有「会话」**（主人 2026-09-22）：*"聊天和桌面是独立的，聊天是永续的，
    //    永远在底下。所以聊天不是桌面上的一个小程序。"* ⇒ 聊天没有桌面图标。
    expect(find.text('会话'), findsNothing, reason: '聊天不是桌面上的小程序 ⇒ 它不该有图标');
    expect(find.byIcon(Icons.chat_bubble_outline), findsNothing, reason: '同上');
    // ★ **收起态的展开入口**：主人 2026-09-24 改形状了 ——
    //   *"展开用一条杠，杠上面有一个小箭头，箭头比较平…放在上边框的正中央"*
    //   ⇒ 它**不再有可见的字**（D3.8 那条同日改掉），字挂在 tooltip 上；
    //     但**命中区仍然 ≥44**、而且它就在上边框正中央（下面的判据量的就是这两条）。
    expect(find.byKey(chatHandleKey), findsOneWidget, reason: '收起态该有那个抓手');
    expect(find.byTooltip('展开'), findsOneWidget, reason: '收起态抓手要说得出"展开"');
    // ★ **收起态也有输入框**（主人 2026-09-22：*"助手那个聊天窗口，收缩的时候也有一个输入框。"*）
    expect(find.byType(Composer), findsOneWidget, reason: '★ 收起时也该能直接说话');
    // 但**展开态才有的东西一个都不许在**（判档位要看这些，不是看输入条）
    expect(find.byTooltip(chatCollapse), findsNothing, reason: '收起态不该有「收起」');
    expect(find.byKey(chatBodyKey), findsNothing, reason: '收起态不画状态条 + 时间线那一块');
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
    // ⚠️ 主人更正过的那一处：**浮窗贴屏幕底**（不是"底面那条桌子的上面"）
    expect(screen.bottom - f.bottom, m, reason: '下边距 = 浮窗底到屏幕底');
    // ⚠️ 桌面是**整页底图**（铺满整屏），不是底部一条
    expect(desk.top, screen.top, reason: '桌面从屏幕顶开始');
    expect(desk.bottom, screen.bottom, reason: '桌面铺到屏幕底');
    expect(desk.left, screen.left);
    expect(desk.right, screen.right);

    // 负向对照：浮窗**不是铺满**（Z3：盖住不是铺满）
    expect(f.width < screen.width, true);
    expect(f.height < screen.height, true);
  });

  // ── ★ 2026-09-29：底部那条 bar（主人："一个半透明的bar，左 home、中输入、右语音；
  //    这些按钮就不是透明的了"）────────────────────────────────────────

  /// 浮窗自己那块 `Material`（深度优先里它排在最前面 —— 与 `appearance_test.dart` 同一条）。
  Material barMaterial(WidgetTester tester) => tester.widget<Material>(
    find.descendant(of: find.byType(ChatFloater), matching: find.byType(Material)).first,
  );

  testWidgets('🔴 收起那条 bar 是**半透明**的；展开档**必须不透明**（时间线要读字）', (tester) async {
    await _pump(tester);
    final collapsed = barMaterial(tester).color!;
    expect(collapsed.a, lessThan(1.0), reason: '★ 收起那条 bar 还是实底 —— 桌面透不过来');
    expect(collapsed.a, closeTo(d.barVeilAlpha, 0.001));

    // ⚠️ **先把上一棵树拆掉**：同类型的 `ChatScreen` 再泵一次会**复用同一个 State**
    //    ⇒ `initialTier` 不再生效（这一条判据第一版就是这么假绿/假红的）。
    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
    await _pump(tester, tier: FloaterTier.full);
    final full = barMaterial(tester).color!;
    expect(full.a, 1.0, reason: '★ 展开档透了 —— 时间线的字会压在壁纸上，读不出来');
  });

  testWidgets('🔴 bar 上那三样**各自是不透明的**：home 圆片 / 输入框 / 话筒', (tester) async {
    await _pump(tester);
    final p = DshPalette.light;

    // ① 输入框：实底（`filled` + `fillColor`），不是透的
    final field = tester.widget<TextField>(
      find.descendant(of: find.byType(Composer), matching: find.byType(TextField)),
    );
    expect(field.decoration!.filled, true, reason: '★ 输入框没实底 —— bar 透了它也跟着透');
    expect(field.decoration!.fillColor, p.bgLayer2);

    // ② 话筒：它的 IconButton 带实底
    // ⚠️ `IconButton(tooltip:)` 把 `Tooltip` 建在**按钮里面** ⇒ 要往上找
    //    （往下找是 0 个 —— 这一条判据第一版就是这么假的）。
    final mic = tester.widget<IconButton>(
      find.ancestor(of: find.byTooltip(hearStart), matching: find.byType(IconButton)).first,
    );
    expect(mic.style?.backgroundColor?.resolve(<WidgetState>{}), p.bgLayer2,
        reason: '★ 话筒没有实底');

    // ③ home 那颗：圆片（`homeButtonFace`）带实底
    final face = find
        .descendant(of: find.byKey(chatHomeButtonKey), matching: find.byType(Container))
        .first;
    final dec = tester.widget<Container>(face).decoration! as BoxDecoration;
    expect(dec.color, p.bgLayer2, reason: '★ home 那颗没有实底');
    expect(tester.getSize(face).width, homeButtonFace);
    // 负向对照：可点区**比那个圆片大**（D3.6 —— 命中区不许缩成看得见的那一圈）
    expect(tester.getSize(find.byKey(chatHomeButtonKey)).width,
        greaterThan(homeButtonFace));
  });

  testWidgets('🔴 话筒在**这一行的最右**（不在输入框里面了）', (tester) async {
    await _pump(tester);
    final mic = find.byTooltip(hearStart);
    // 负向对照：它**不是**那个 `TextField` 的孩子（2026-09-24 那一版它在框里）
    expect(
      find.descendant(of: find.byType(TextField), matching: mic),
      findsNothing,
      reason: '★ 话筒还在框里面 —— 主人要的是"右侧是语音按钮"',
    );
    // 而且它在框的**右边**（拿屏幕坐标量，不猜结构）
    final micRect = tester.getRect(mic);
    final fieldRect = tester.getRect(
      find.descendant(of: find.byType(Composer), matching: find.byType(TextField)),
    );
    expect(micRect.left, greaterThanOrEqualTo(fieldRect.right - 1),
        reason: '★ 话筒不在输入框右边：mic=$micRect field=$fieldRect');
  });

  testWidgets('🔴 浮窗有阴影（不是靠描边假装浮着）', (tester) async {
    await _pump(tester, tier: FloaterTier.full);
    // ⚠️ **只扫浮窗里面那一棵**（2026-09-22 栽过）：桌面图标也有阴影了，
    //    全树扫会先扫到**图标**那个（blur 12）⇒ 判据当场红，而浮窗其实没问题。
    //    ⇒ 这就是"判据要钉在**这件事独有**的东西上"的第三次。
    final shadows = <BoxShadow>[];
    for (final e in find
        .descendant(of: find.byType(ChatFloater), matching: find.byType(DecoratedBox))
        .evaluate()) {
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

  testWidgets('🔴 点收起态那个「说点什么」⇒ **窗口自动打开**（而且字不丢）', (tester) async {
    // 主人 2026-09-22：*"点击说点什么，聊天窗口会自动打开。"*
    // （手册 §6.3 那条"点收起态底部条 ⇒ 展开到上次档位"就是这个）
    await _pump(tester);
    expect(find.byTooltip(chatCollapse), findsNothing, reason: '一开始是收起的');

    // 先打两个字，再点框 —— 两件事都要成立：窗口开了，**字还在**
    await tester.enterText(find.byType(TextField), '在吗');
    await tester.pump();
    await tester.tap(find.byType(TextField));
    await tester.pumpAndSettle();

    expect(find.byTooltip(chatCollapse), findsOneWidget, reason: '★ 点输入框 ⇒ 窗口该打开');
    expect(find.byKey(chatBodyKey), findsOneWidget, reason: '打开之后时间线那一块该在');
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      '在吗',
      reason: '★ 打开这一下不许把你打的字弄丢（两态是同一个输入条实例）',
    );
  });

  testWidgets('🔴 在**收起态**打了一半，点「展开」⇒ 字不丢（输入条是同一个实例）', (tester) async {
    // ⚠️ 这条钉的是**实现上的一个关键选择**：输入条从 `_sheetBody` 里**拆出来单独传给浮窗**，
    //    上下两态共用**同一个** `Composer`。要是两处各建一个，"打了一半再展开"会换一个 `State`，
    //    **框里的字就没了**（那是最气人的那种丢字）。
    await _pump(tester);
    await tester.enterText(find.byType(TextField), '半句话');
    await tester.pump();

    await tester.tap(find.byKey(chatHandleKey));
    await tester.pumpAndSettle();

    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      '半句话',
      reason: '★ 展开不该把你打了一半的字弄丢',
    );
  });

  testWidgets('🔴 收起态那个输入框**真能发**：发出去就拉满（§6.2"发就拉满"）', (tester) async {
    final c = _controller();
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(controller: c, onLoggedOut: () {})),
    );
    await tester.pump();
    final before = _floaterRect(tester).height; // 收起态
    expect(find.byTooltip(chatCollapse), findsNothing, reason: '一开始是收起的');

    await tester.enterText(find.byType(TextField), '在吗');
    await tester.pump();
    await tester.tap(find.byTooltip('发送'));
    await tester.pump();

    expect(_floaterRect(tester).height > before, true,
        reason: '★ 从收起态发出去 ⇒ 该拉满（$before → ${_floaterRect(tester).height}）');
    expect(find.byTooltip(chatCollapse), findsOneWidget, reason: '拉满之后该有「收起」');
  });

  testWidgets('🔴 点「展开」⇒ 真的开（时间线那一块出来、多出「收起」）', (tester) async {
    await _pump(tester);
    expect(find.byTooltip(chatCollapse), findsNothing);
    await tester.tap(find.byKey(chatHandleKey));
    await tester.pumpAndSettle();
    expect(find.byTooltip(chatCollapse), findsOneWidget, reason: '开了之后该有「收起」');
    expect(find.byKey(chatBodyKey), findsOneWidget, reason: '开了之后状态条 + 时间线该在');
    // ⚠️ 抓手**仍然在**（它在上边框正中，收起/展开都在同一个位置）——
    //    变的是它的朝向与那句 tooltip。
    expect(find.byKey(chatHandleKey), findsOneWidget, reason: '抓手不该消失');
    expect(find.byTooltip('展开'), findsNothing, reason: '展开之后它不再是「展开」');
  });

  testWidgets('🔴 点桌面空白 ⇒ 收起；点浮窗**内部** ⇒ 无反应（负向对照）', (tester) async {
    await _pump(tester, tier: FloaterTier.full);
    final before = _floaterRect(tester).height;

    // ① 点浮窗内部（标题那一行）⇒ **不许**收起（§6.3：点浮窗内部无反应）
    //    ⚠️ 2026-09-24 改：原来是点"最上面 12px"，而现在那一块**就是抓手**
    //      （主人要它在上边框正中央）⇒ 再点那儿等于点抓手，判据会红得毫无意义。
    //      改成点标题那几个字（那儿没有按钮，也在浮窗内部）。
    await tester.tap(find.text('助手'));
    await tester.pumpAndSettle();
    expect(_floaterRect(tester).height, before, reason: '点浮窗内部不该动它（更不该漏到桌面）');
    expect(find.byTooltip(chatCollapse), findsOneWidget, reason: '还是展开着');

    // ② 点桌面空白 ⇒ 收起。
    //    ⚠️ **得点浮窗盖不到的地方**：桌面现在是整页底图，浮窗贴底盖住了中间那一大块，
    //       所以"空白"是左边那条**留白带子**（这也正是 Z3 要留出边距的理由之一）。
    //    🔴 **那一点要从常量算，不能写死 10**（2026-09-28 修）：主人把留白从 30 改成 10
    //       之后，`left + 10` 正好落在浮窗**自己的左边缘上** ⇒ 这一条会红得莫名其妙
    //       （它量的其实是"浮窗边距有多宽"，不是"点空白收不收得起"）。
    //       ⇒ 取那条带子的**中间**：留白怎么变都还是空白。
    final screen = tester.getRect(find.byType(MaterialApp));
    await tester.tapAt(Offset(screen.left + FloaterMetrics.margin / 2, screen.center.dy));
    await tester.pumpAndSettle();
    expect(find.byTooltip(chatCollapse), findsNothing, reason: '点桌面空白该收起');
  });

  testWidgets('🔴 负向对照：点**浮窗左边那条桌面**不会误伤浮窗自己的按钮', (tester) async {
    // 上一条证明了"点桌面能收起"；这一条反向确认"边距那条带子确实不属于浮窗"，
    // 免得哪天有人把浮窗的 `left/right` 写成 0（那样桌面就点不到了，而上面那条会红）
    await _pump(tester, tier: FloaterTier.full);
    final f = _floaterRect(tester);
    expect(f.left, FloaterMetrics.margin, reason: '浮窗左边必须留出桌面那条带子');
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

  testWidgets('🔴 桌面**铺满整屏**（是底图，不是"内容那么宽"的一块）', (tester) async {
    // ⚠️ 2026-09-22 实测抓到过的形状：桌面被缩成 **100px 宽、居中**
    //    （截图上看不出来：它底色跟页面一样）—— 那时它还是"底部一条"。
    //    现在形状改成"桌面=整页底图"，这条判据钉的就是**四边都贴屏幕**。
    await _pump(tester);
    final desk = tester.getRect(find.byType(AppDesktop));
    final screen = tester.getRect(find.byType(MaterialApp));
    expect(desk.left, screen.left, reason: '桌面左边该贴屏幕左');
    expect(desk.right, screen.right, reason: '桌面右边该贴屏幕右');
    expect(desk.top, screen.top, reason: '桌面该从屏幕顶开始');
    expect(desk.bottom, screen.bottom, reason: '桌面该铺到屏幕底');
    expect(desk.size, screen.size, reason: '桌面该铺满整屏（实测过它只有 ${desk.size}）');
  });

  testWidgets('🔴 抓手的命中区 ≥44，而且**就在上边框正中央**（D3.6 + 主人 2026-09-24）', (tester) async {
    await _pump(tester);
    // 图形本身小（26×7 的箭头 + 44×4 的杠），但**它那个按钮**要够大
    final btn = tester.getRect(find.byKey(chatHandleKey));
    expect(btn.height >= 44, true, reason: '抓手命中区只有 ${btn.height}');
    expect(btn.width >= 44, true, reason: '抓手命中区只有 ${btn.width}');
    // ★ 位置：**上边框的正中央**（主人原话）
    final f = _floaterRect(tester);
    expect(
      (btn.center.dx - f.center.dx).abs() < 1,
      true,
      reason: '抓手该在水平正中（差 ${(btn.center.dx - f.center.dx).abs()}）',
    );
    expect(
      (btn.top - f.top).abs() < 6,
      true,
      reason: '抓手该贴着上边框（差 ${(btn.top - f.top).abs()}）',
    );
  });

  testWidgets('🔴 **单击**抓手 ⇒ 收起（§6.3 的手势表 · 2026-09-24 改）', (tester) async {
    await _pump(tester, tier: FloaterTier.full);
    expect(find.byType(Composer), findsOneWidget);
    // ⚠️ 原来是"双击 = 收起 ⇄ 展开"。2026-09-24 抓手变成**能点的那个展开入口**之后，
    //    双击 = 两次单击 = 展开又收起（屏幕上就是"点了没反应"）⇒ **双击这套拿掉**。
    await tester.tap(find.byKey(chatHandleKey));
    await tester.pumpAndSettle();
    expect(find.byTooltip(chatCollapse), findsNothing, reason: '单击抓手该收起');
    expect(find.byKey(chatHandleKey), findsOneWidget, reason: '抓手还在（收起态它就是展开入口）');
  });

  testWidgets('🔴 拖抓手行向上 ⇒ 跟手变高，松手吸附到更大的一档', (tester) async {
    await _pump(tester, tier: FloaterTier.collapsed);
    final collapsed = _floaterRect(tester).height;
    await tester.drag(find.byKey(chatHandleKey), const Offset(0, -260));
    await tester.pumpAndSettle();
    final after = _floaterRect(tester).height;
    expect(after > collapsed, true, reason: '往上拖该变高（$collapsed → $after）');
    expect(find.byTooltip(chatCollapse), findsOneWidget, reason: '拖开之后该有「收起」');
  });
}
