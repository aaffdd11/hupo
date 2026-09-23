// **小程序（设置）× 聊天**：手册 `08-SPEC.md` §6.4 那几条规矩**画出来了没有**。
//
// 主人 2026-09-22 把三者的关系定清了：
//   *"聊天和桌面是独立的，聊天是永续的，永远在底下。所以聊天不是桌面上的一个小程序。
//     桌面上应当有一个设置的小程序，用来退出登录，注销账号，修改 apikey。"*
//
// ⚠️ `test/widget`（**提示档**）—— 但它钉的是"这一刀到底有没有画到屏幕上"。
//    当闸的两条在别处：五档不溢出 + 命中区 ≥44（`accessibility_test.dart`，含"从真入口进"）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/design.dart' as d;
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/models/math_words.dart';
import 'package:hupo_app/screens/math_quiz_screen.dart';
import 'package:hupo_app/screens/settings_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/app_desktop.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/widgets/mini_app_host.dart';
import 'package:hupo_app/widgets/composer.dart';

ChatController _controller() =>
    ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore());

Future<void> _pump(
  WidgetTester tester, {
  FloaterTier tier = FloaterTier.collapsed,
  VoidCallback? onLoggedOut,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: ChatScreen(
        initialTier: tier,
        controller: _controller(),
        onLoggedOut: onLoggedOut ?? () {},
        space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: true),
        onSendKey: (_) async => KeySend.ok,
      ),
    ),
  );
  await tester.pump();
}

/// 打开桌上那个「设置」（真实路径：点图标）。⚠️ 字和图标**都能点**（那是修过的一个 bug）。
Future<void> _openSettings(WidgetTester tester) async {
  await tester.tap(find.text(settingsAppLabel));
  await tester.pumpAndSettle();
}

void main() {
  // ⚠️ 退出登录那条路会 `tokens.clear()`（本机存储）⇒ 测试里得给它一个桩，
  //    不然那句会抛，而"退出登录"看起来像**点了没反应**（那是假象，不是产品行为）。
  TestWidgetsFlutterBinding.ensureInitialized();
  SharedPreferences.setMockInitialValues(<String, Object>{});

  testWidgets('🔴 桌面上**没有**「会话」—— 聊天不是桌面上的小程序', (tester) async {
    await _pump(tester);
    expect(find.text('会话'), findsNothing, reason: '聊天永续、永远在底下 ⇒ 它不该有桌面图标');
    expect(find.byIcon(Icons.chat_bubble_outline), findsNothing);
    // 但聊天**在**（收起那条一直在）
    expect(find.byType(ChatFloater), findsOneWidget);
    expect(find.byKey(chatHandleKey), findsOneWidget);
  });

  testWidgets('🔴 展开态的「收起」在（而**收起态不该有它** —— 它已经收起来了）', (tester) async {
    // 主人 2026-09-22：*"展开后要有收回的按钮"*。
    // ⚠️ 第一版把这个按钮放在 if/else **之外** ⇒ 收起态那条上也挂着一个"收起"（错的）。
    await _pump(tester); // 默认收起
    expect(find.byTooltip(chatCollapse), findsNothing, reason: '收起态不该再挂一个"收起"');
    expect(find.byKey(chatHandleKey), findsOneWidget);

    await tester.tap(find.byKey(chatHandleKey));
    await tester.pumpAndSettle();
    expect(find.byTooltip(chatCollapse), findsOneWidget, reason: '★ 展开后必须找得到"收起"');
    // 而且它**不在那条横滚里**（窄屏 + 大字号下也不会被滚出视野）
    await tester.tap(find.byTooltip(chatCollapse));
    await tester.pumpAndSettle();
    expect(find.byKey(chatHandleKey), findsOneWidget, reason: '点了收起该回到收起态');
  });

  testWidgets('🔴 点「设置」⇒ 设置那一屏开了，而且**聊天自动收起**（§6.4 规则 5）', (tester) async {
    // 从**半开**进场：这时桌面顶上那块看得见、点得到（最大化会把桌面盖住）
    await _pump(tester, tier: FloaterTier.half);
    expect(find.byTooltip(chatCollapse), findsOneWidget, reason: '半开时是展开着的');

    await _openSettings(tester);

    expect(find.byType(SettingsScreen), findsOneWidget, reason: '设置那一屏该开在小程序容器里');
    // ⚠️ 判"收起了没有"要看**只有展开态才有的那个「收起」**，不是看输入条 ——
    //    收起态**也有**输入条（主人 2026-09-22）。
    expect(find.byTooltip(chatCollapse), findsNothing, reason: '★ 打开小程序 ⇒ 聊天该自动收起（把屏幕让给它）');
  });

  testWidgets('🔴 设置里有「退出登录」，点了真的回调（它原来挂在聊天抓手行上）', (tester) async {
    var loggedOut = 0;
    await _pump(tester, onLoggedOut: () => loggedOut += 1);
    await _openSettings(tester);

    // ⚠️ 它在这个小窗口里**在折叠线以下**，而 `ListView` 不建屏幕外的孩子
    //    ⇒ 判据要**像用户那样先滚**（不是把那一行硬塞进屏幕）
    await tester.scrollUntilVisible(
      find.text(settingsLogout),
      200,
      scrollable: find.descendant(of: find.byType(SettingsScreen), matching: find.byType(Scrollable)).first,
    );
    await tester.pumpAndSettle();
    expect(find.text(settingsLogout), findsOneWidget, reason: '主人点名要的三件之一：退出登录');
    await tester.tap(find.text(settingsLogout));
    await tester.pumpAndSettle();
    expect(loggedOut, 1, reason: '★ 点了退出登录就该退出去（一个点了没反应的入口 = 坏了）');
  });

  testWidgets('🔴 小程序不写 icon 也**不会空着**（默认图标）', (tester) async {
    // 主人 2026-09-22：*"设置要给一个默认 icon"*。
    // ⚠️ 而且这个默认值必须是**常量** —— `flutter build web` 会 tree-shake 图标字体，
    //    运行时造出来的 `IconData` 线上是**画不出来**的（测试里却看不出来）。
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AppDesktop(
            apps: [
              DesktopApp(label: '随手一件', onOpen: (_) {}), // ← 刻意不写 icon
            ],
            onTapBlank: () {},
          ),
        ),
      ),
    );
    await tester.pump();
    expect(find.byIcon(defaultAppIcon), findsOneWidget, reason: '★ 没给 icon 时该用默认那个');
    expect(find.text('随手一件'), findsOneWidget, reason: '字还是要有（D3.8）');
  });

  testWidgets('🔴 退出小程序之后那一块**真的没了**，而且**图标还能再点开**（回归）', (tester) async {
    // 🔴 主人 2026-09-22 报的"退出小程序有个小bug"。
    //    根因：`build()` 里那句"没开而且收回了 ⇒ 什么都不画"**不会因为动画结束而重跑**
    //    （只有里面那个 `AnimatedBuilder` 会重建）⇒ 关掉之后**那一块还留在图标的位置上**，
    //    而且它是**可点的** ⇒ 正好压在图标上，**把图标挡住了**：退出之后**再点图标没反应**。
    await _pump(tester);
    await _openSettings(tester);
    expect(find.byType(SettingsScreen), findsOneWidget);

    await tester.tap(find.byTooltip(miniAppBack));
    await tester.pumpAndSettle();
    expect(find.byType(SettingsScreen), findsNothing, reason: '★ 退出了就该真的不在树里（不许留残影）');
    expect(find.byTooltip(miniAppBack), findsNothing, reason: '★ 连容器那条顶栏也不许留');

    // ★ 再点一次图标：必须还能开（残影挡住图标的话，这一下就没反应）
    await tester.tap(find.text(settingsAppLabel));
    await tester.pumpAndSettle();
    expect(find.byType(SettingsScreen), findsOneWidget, reason: '★ 退出之后再点图标必须还能开');
    final screen = tester.getRect(find.byType(MaterialApp));
    final reveal = tester.getRect(
      find.descendant(of: find.byType(MiniAppHost), matching: find.byType(ClipRRect)).first,
    );
    expect(reveal.size, screen.size, reason: '而且该是全屏');
  });

  /// 读"小程序那一层"的阴影（画在裁剪**外面**那一层 `DecoratedBox`）。
  ///
  /// ⚠️ 为什么要读它：主人 2026-09-23 报的 *"打开和关闭的时候，那一层效果没有阴影"* ——
  ///    而 `ClipRRect` 会把**里面**的阴影一起剪掉，所以阴影只能画在它**外面**。
  BoxShadow? surfaceShadow(WidgetTester tester) {
    final box = find.ancestor(
      of: find.byKey(miniAppSurfaceKey),
      matching: find.byType(DecoratedBox),
    );
    if (box.evaluate().isEmpty) return null;
    final deco = tester.widget<DecoratedBox>(box.first).decoration;
    if (deco is! BoxDecoration || deco.boxShadow == null || deco.boxShadow!.isEmpty) return null;
    return deco.boxShadow!.first;
  }

  testWidgets('🔴 打开那一瞬间：那一层**带阴影**（主人 2026-09-23 报的）', (tester) async {
    await _pump(tester);
    // 点开一个不是设置的小程序（缩小动画那一下才看得出"从图标长出来"）
    await tester.tap(find.text(mathAppLabel));
    await tester.pump(); // 起第一帧
    await tester.pump(const Duration(milliseconds: 60)); // 落在扩开动画里

    final sh = surfaceShadow(tester);
    expect(sh, isNotNull, reason: '★ 扩开途中那一层**必须有阴影**（不然就是一块白板）');
    expect(sh!.blurRadius > 0, true, reason: '模糊要是正的，实际 ${sh.blurRadius}');
    expect(sh.color.a > 0, true, reason: '阴影要看得见，实际 α=${sh.color.a}');

    await tester.pumpAndSettle();
    expect(
      surfaceShadow(tester),
      isNull,
      reason: '★ 到全屏就**不该**再有阴影（整页贴边，画它只是白费）',
    );
  });

  testWidgets('🔴 收回的时候阴影**回来了**（缩回图标那一下也要有）', (tester) async {
    await _pump(tester);
    await tester.tap(find.text(mathAppLabel));
    await tester.pumpAndSettle();
    expect(surfaceShadow(tester), isNull, reason: '全屏时没有阴影');

    await tester.tap(find.byTooltip(miniAppBack));
    // ⚠️ 先空 pump 一次（让 `didUpdateWidget` 起跑），**再**推进 250ms。
    //    为什么不是 60ms：形状那条曲线是 `easeOutCubic` —— 刚起步时它**几乎还是全屏**，
    //    阴影那一项被压到 0.001 以下（正是"贴边时不该有阴影"那条规矩），量出来是 null。
    //    推进到中段，它才真的在"变回一个图标"。
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    final sh = surfaceShadow(tester);
    expect(sh, isNotNull, reason: '★ 收回途中要有阴影（它正在变回"一个图标"）');
    expect(sh!.blurRadius > 0, true);
  });

  testWidgets('🔴 退出小程序时**不许先闪到「设置」那一屏**（主人 2026-09-23 报的）', (tester) async {
    // 主人原话：*"在小程序退出的时候，其他的小程序竟然会先切换页面到设置才缩小隐藏。"*
    //
    // 根因：`_openApp` 一置空，"现在开着哪一屏"那一串判断**最后兜底到 `SettingsScreen`**
    // ⇒ 收回动画那一帧里画的是**设置**。⇒ 这一条就钉在**收回动画中间那一帧**上。
    await _pump(tester);
    // 拿「奥数题」当例子（它**不是**设置 —— 缺陷只在"关掉的不是设置"时才看得出来）
    await tester.tap(find.text(mathAppLabel));
    await tester.pumpAndSettle();
    expect(find.byType(MathQuizScreen), findsOneWidget);

    await tester.tap(find.byTooltip(miniAppBack));
    // ⚠️ **只推进一小段**（正好落在收回动画里）——`pumpAndSettle` 会一口气跑完，看不出这一帧
    await tester.pump(const Duration(milliseconds: 60));
    expect(
      find.byType(SettingsScreen),
      findsNothing,
      reason: '★ 收回动画期间**不许**出现"设置"那一屏（那是兜底分支跑出来了）',
    );
    expect(
      find.byType(MathQuizScreen),
      findsOneWidget,
      reason: '★ 正在缩回去的应该是**它自己**（不是别的屏）',
    );

    await tester.pumpAndSettle();
    expect(find.byType(MathQuizScreen), findsNothing, reason: '收完了就该真的没了');
    expect(find.byType(SettingsScreen), findsNothing);
  });

  testWidgets('★ 正对照：设置**真的开着**的时候，那一屏照旧在（别修过头）', (tester) async {
    await _pump(tester);
    await _openSettings(tester);
    expect(find.byType(SettingsScreen), findsOneWidget);
    await tester.tap(find.byTooltip(miniAppBack));
    await tester.pump(const Duration(milliseconds: 60));
    expect(find.byType(SettingsScreen), findsOneWidget, reason: '关它自己的时候，缩回去的当然还是它');
  });

  testWidgets('🔴 小程序打开后是**全屏**的 —— 只有聊天还在底下那一条', (tester) async {
    // 主人 2026-09-22：*"桌面小程序打开后，是全屏显示的，只不过聊天窗口还在底下那里。"*
    await _pump(tester);
    await _openSettings(tester);

    final screen = tester.getRect(find.byType(MaterialApp));
    final host = tester.getRect(find.byType(MiniAppHost));
    final app = tester.getRect(find.byType(SettingsScreen));
    expect(host.size, screen.size, reason: '★ 小程序该是全屏（实测 ${host.size} vs ${screen.size}）——不是带边距的小窗');
    expect(app.width, screen.width, reason: '内容也该全宽');
    // 而**聊天还在底下那一条**（Z1：它永远在最上面）
    expect(find.byType(ChatFloater), findsOneWidget);
    expect(find.byKey(chatHandleKey), findsOneWidget, reason: '聊天收起那条该还在底下浮着');
  });

  testWidgets('🔴 点开小程序**从图标那儿扩开**（不是硬切出现）', (tester) async {
    // 主人 2026-09-22：*"小程序点开要有效果，就是从哪里打开，就从哪里扩开到全屏的效果。"*
    await _pump(tester);
    // ⚠️ 参照物是**图标那个格子**（不是它下面那行字）
    final icon = tester.getRect(
      find.ancestor(of: find.text(settingsAppLabel), matching: find.byType(InkWell)).first,
    );

    await tester.tap(find.text(settingsAppLabel));
    await tester.pump(); // 动画第 0 帧

    // ★ 判据：**这一刻它还不是全屏**，而且**起点就在那个图标附近**
    //   （硬切的话这一帧就已经铺满屏幕了）
    // ⚠️ 量的是**被露出来的那块矩形**（`MiniAppHost` 自己是铺满的 `Stack`，它不动）
    Rect reveal() => tester.getRect(
          find.descendant(of: find.byType(MiniAppHost), matching: find.byType(ClipRRect)).first,
        );
    final justOpened = reveal();
    final screen = tester.getRect(find.byType(MaterialApp));
    expect(justOpened.width < screen.width, true,
        reason: '刚点开时不该已经全屏（实测宽 ${justOpened.width} vs 屏幕 ${screen.width}）—— 那就是硬切');
    expect((justOpened.topLeft - icon.topLeft).distance < 40, true,
        reason: '★ 起点该在**那个图标**附近（实测 ${justOpened.topLeft} vs 图标 ${icon.topLeft}）');

    // 中途：比刚才大了、还没到全屏
    await tester.pump(Duration(milliseconds: d.motionAppOpen.inMilliseconds ~/ 2));
    final mid = reveal();
    expect(mid.width > justOpened.width, true, reason: '该在长大');
    expect(mid.width < screen.width, true, reason: '中途还没铺满');
    // ★ 2026-09-24 主人：*"越远越快，越近越慢"* ⇒ **一半时间就该走掉八成以上**
    //   （线性的话这会儿只有一半；这正是"不是线性的"那句判据）
    final traveled = (mid.width - justOpened.width) / (screen.width - justOpened.width);
    expect(traveled, greaterThan(0.8),
        reason: '一半时间只走了 ${(traveled * 100).round()}% —— 主人要的是"越远越快"');

    // 收尾：全屏
    await tester.pumpAndSettle();
    expect(reveal().size, screen.size);

  });

  testWidgets('🔴 收起那条**压不住**小程序里可点的东西：内容底部内缩（§6.4 规则 1）', (tester) async {
    await _pump(tester);
    await _openSettings(tester);
    final settings = tester.getRect(find.byType(SettingsScreen));
    final floater = tester.getRect(find.byType(ChatFloater));
    // ⚠️ 这一条正是上一代栽过的地方：「最后一行永远点不到」
    expect(settings.bottom <= floater.top, true,
        reason: '设置内容该在收起条**上面**（内容底 ${settings.bottom} vs 条顶 ${floater.top}）');
    expect(settings.bottom > 0, true);
  });

  testWidgets('🔴 聊天展开时小程序被盖住 —— 而且**看得出来**（压暗 + 缩小，§6.4 规则 2）', (tester) async {
    await _pump(tester);
    await _openSettings(tester);

    double opacity() => tester
        .widget<AnimatedOpacity>(
          find.ancestor(of: find.byType(SettingsScreen), matching: find.byType(AnimatedOpacity)).first,
        )
        .opacity;
    double scale() => tester
        .widget<AnimatedScale>(
          find.ancestor(of: find.byType(SettingsScreen), matching: find.byType(AnimatedScale)).first,
        )
        .scale;

    expect(opacity(), 1.0, reason: '没被盖住时是正常的');
    expect(scale(), 1.0);

    await tester.tap(find.byKey(chatHandleKey));
    await tester.pumpAndSettle();

    expect(opacity() < 1.0, true, reason: '★ 被盖住要**看得出来**（压暗），不是"悄悄被盖住"');
    expect(scale() < 1.0, true, reason: '★ 同上（轻微缩小）');
    // 负向对照：**它没被销毁**（规则 4/Z2：被盖住 ≠ 被杀）
    expect(find.byType(SettingsScreen), findsOneWidget, reason: '被盖住不许销毁它');
  });

  testWidgets('🔴 被盖住期间点可见的那一块 ⇒ **只收起聊天**，那一下不传给小程序（规则 3）', (tester) async {
    await _pump(tester);
    await _openSettings(tester);
    await tester.tap(find.byKey(chatHandleKey));
    await tester.pumpAndSettle();
    expect(find.byType(Composer), findsOneWidget);

    // 点小程序可见的那一块（左上角，浮窗盖不到的地方）
    final screen = tester.getRect(find.byType(MaterialApp));
    await tester.tapAt(Offset(screen.left + 8, screen.top + 8));
    await tester.pumpAndSettle();

    expect(find.byTooltip(chatCollapse), findsNothing, reason: '★ 点被盖住的小程序 = "回到小程序" ⇒ 收起聊天');
    expect(find.byType(SettingsScreen), findsOneWidget, reason: '而且小程序还在（没被那一下点走）');
  });
}
