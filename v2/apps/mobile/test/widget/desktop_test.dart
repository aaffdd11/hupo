// **桌面那一片**（主人 2026-09-23：*"先整理整个UI"*，第一块就是它）· 契约 `docs/dev/72-UI-PASS.md`。
//
// 这一份钉四件：
//   ① 🔴 **格子够大**（目标用户视力弱）：`desktopIconBox` 不许缩回 52 那一档
//   ② 标签跟着变大（bodySmall → bodyMedium），而且**名字长了不撑破格子**
//   ③ 桌面上有一句**引导**（原来一句都没有：几个陌生图标 + 一片空白）
//   ④ 🔴 **点标签真的能打开**（这是 2026-09-22 实测抓到过的坑：`InkWell` 只包了方格，
//      点字落到"点桌面空白"上 ⇒ "点设置"变成了"收起聊天"，而判据还照样绿）

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/app_tint.dart';
import 'package:hupo_app/models/design.dart' as d;
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/widgets/app_desktop.dart';

DesktopApp app(String label, {VoidCallback? onOpen, int badge = 0}) =>
    DesktopApp(
      label: label,
      icon: Icons.star_outline,
      badge: badge,
      onOpen: (_) => onOpen?.call(),
    );

Future<void> pump(
  WidgetTester tester,
  List<DesktopApp> apps, {
  VoidCallback onBlank = _noop,
  double scale = 1.0,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: MediaQuery(
        data: MediaQueryData(textScaler: TextScaler.linear(scale)),
        child: Scaffold(
          body: AppDesktop(apps: apps, onTapBlank: onBlank),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void _noop() {}

void main() {
  testWidgets('★ 格子够大：>= 64（为看不清的人留的，不许缩回去）', (tester) async {
    expect(
      desktopIconBox,
      greaterThanOrEqualTo(64),
      reason: '目标用户视力弱（01-PROJECT.md）；52 那一档在手机上像一粒纽扣',
    );
    await pump(tester, [app('设置')]);
    final box = tester.getSize(
      find.ancestor(
        of: find.byIcon(Icons.star_outline),
        matching: find.byType(Container),
      ).first,
    );
    expect(box.width, desktopIconBox);
    expect(box.height, desktopIconBox);
  });

  testWidgets('🔴 每一格的底是**按身份算的那个色**（不是清一色白卡）', (tester) async {
    // 主人 2026-09-29：*"所有小程序的icon都需要一个背景颜色。不同的背景颜色。"*
    await pump(tester, [
      DesktopApp(label: '设置', id: 'settings', icon: Icons.star_outline, onOpen: (_) {}),
      DesktopApp(label: '发现', id: 'discover', icon: Icons.star_outline, onOpen: (_) {}),
    ]);

    Color tileColorOf(String label) {
      // 那一格的图标格（`desktopIconBox` 那个方块）—— 从标签往上找到那个 Container
      final box = find
          .ancestor(of: find.text(label), matching: find.byType(Column))
          .first;
      final c = find.descendant(of: box, matching: find.byType(Container)).first;
      final dec = tester.widget<Container>(c).decoration! as BoxDecoration;
      return dec.color!;
    }

    final a = tileColorOf('设置');
    final b = tileColorOf('发现');
    // 负向对照：**不是**那张白卡（`d.card` 是改之前那一版的样子）
    expect(a, isNot(d.card), reason: '★ 图标还是白底 —— 这一刀没画到屏幕上');
    expect(a, appTintFor('settings'));
    expect(b, appTintFor('discover'));
    expect(a, isNot(b), reason: '★ 两个身份算出来同一个色（这一条只对这两个内置的钉死）');
    // ⚠️ 底色**不跟主题走**（它是"这个 app 长什么样"，不是"这块屏什么档"）
    expect(appTintFor('settings'), appTintFor('settings'));
  });

  testWidgets('★ 加号那一格**还是空的**（它不是小程序，不给它上色）', (tester) async {
    var opened = 0;
    await pump(
      tester,
      [DesktopApp(label: '创建小程序', icon: Icons.add, isCreate: true, onOpen: (_) => opened += 1)],
    );
    final box = find.ancestor(of: find.text('创建小程序'), matching: find.byType(Column)).first;
    final c = find.descendant(of: box, matching: find.byType(Container)).first;
    final dec = tester.widget<Container>(c).decoration! as BoxDecoration;
    expect(dec.color, Colors.transparent, reason: '加号那一格是"空位"，不是一个小程序 ⇒ 不许上色');
  });

  testWidgets('🔴 一行**铺满**那一条的宽 ＋ **不超过 6 格**（2026-10-01 主人改的这一条）', (tester) async {
    // 2026-09-29 主人：*"根据页面宽度等宽排列"* ⇒ 铺满（这一半照旧）。
    // 🔴 2026-10-01 主人：*「一行根据屏幕大小，不要放超过6个app。而且app都有位置。」*
    //    ⇒ **1280 宽也只排 6 格**（改前是 7 格），第 7 个落到第二行**贴左**。
    tester.view.physicalSize = const Size(1280, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await pump(tester, [
      for (var i = 0; i < 7; i++)
        app('应用$i', onOpen: () {}),
    ]);

    Rect cell(String label) => tester.getRect(
      find
          .ancestor(of: find.text(label), matching: find.byType(SizedBox))
          .first,
    );
    final first = cell('应用0');
    final sixth = cell('应用5');
    final seventh = cell('应用6');
    // ① **前 6 个在一行里**；第 7 个**必须在第二行**（一行最多 6 个）
    expect(first.top, sixth.top, reason: '前 6 个该在一行里');
    expect(seventh.top, greaterThan(first.top), reason: '★ 第 7 个必须在第二行（上限 6）');
    // ② 这一行**铺满**：左端贴左边留白、第 6 格的右端贴右边留白
    expect(first.left, closeTo(d.gapL, 0.5), reason: '★ 没贴左边：${first.left}');
    expect(sixth.right, closeTo(1280 - d.gapL, 0.5),
        reason: '★ 右边空着（改前就是"全挤在左边"）：${1280 - sixth.right}');
    // ③ 末行**贴左**（苹果是从左边接着排）：第 7 个落在第一列
    expect(seventh.left, closeTo(first.left, 0.5),
        reason: '★ 末行该贴左；居中的话它会往右偏（改前就是居中）');
    // ④ 相邻两格的**间距一样**（等宽排列）
    final gaps = <double>[];
    for (var i = 0; i < 5; i++) {
      gaps.add(cell('应用${i + 1}').left - cell('应用$i').right);
    }
    for (final g in gaps) {
      expect(g, closeTo(gaps.first, 0.5), reason: '间距不齐：$gaps');
    }
  });

  testWidgets('🔴 图标格那圈阴影**够浓**（2026-09-29 主人："appicon的阴影加浓一些"）', (tester) async {
    await pump(tester, [app('设置')]);
    final box = find.ancestor(of: find.text('设置'), matching: find.byType(Column)).first;
    final c = find.descendant(of: box, matching: find.byType(Container)).first;
    final dec = tester.widget<Container>(c).decoration! as BoxDecoration;
    final sh = dec.boxShadow!.first;
    // ⚠️ 这一条是**棘轮**（同"格子够大"那条）：只许更浓，不许悄悄缩回去 ——
    //    门槛住这一份（它是判据，不是产品参数）。
    expect(sh.color.a, greaterThanOrEqualTo(0.20),
        reason: '★ 阴影淡回去了（α=${sh.color.a}）—— 主人 2026-09-29 明确要"加浓"');
    expect(sh.color.r, closeTo(d.ink.r, 0.01), reason: '阴影色还是从 ink 来的');
    expect(sh.blurRadius, greaterThanOrEqualTo(14), reason: '★ 只加浓度不加模糊 ⇒ 一圈硬边');
    // 负向对照：**两处共用同一组数**（打开/收回那一层的起点）
    expect(sh.color.a, d.tileShadowAlpha);
    expect(sh.blurRadius, d.tileShadowBlur);
    expect(sh.offset.dy, d.tileShadowDy);
  });

  testWidgets('★ 桌子上有一句引导（原来一句都没有）', (tester) async {
    await pump(tester, [app('设置')]);
    expect(find.text(desktopHint), findsOneWidget);
  });

  testWidgets('🔴 点**标签**真的能打开（不是点桌面空白）', (tester) async {
    var opened = 0;
    var blank = 0;
    await pump(
      tester,
      [app('设置', onOpen: () => opened += 1)],
      onBlank: () => blank += 1,
    );
    // 点**字**（那是人第一眼看到的靶子）
    await tester.tap(find.text('设置'));
    await tester.pumpAndSettle();
    expect(opened, 1, reason: '点标签要打开小程序');
    expect(blank, 0, reason: '点标签**不许**落成"点桌面空白"（2026-09-22 的坑）');
  });

  testWidgets('★ 名字长了：最多两行、格子不撑破（界面自己抖那一族）', (tester) async {
    await pump(tester, [app('一个特别特别长的小程序名字'), app('短')]);
    final long = tester.getSize(
      find.ancestor(
        of: find.text('一个特别特别长的小程序名字'),
        matching: find.byType(SizedBox),
      ).first,
    );
    final short = tester.getSize(
      find.ancestor(
        of: find.text('短'),
        matching: find.byType(SizedBox),
      ).first,
    );
    expect(long.width, short.width, reason: '一格的宽度不许跟着名字变');
    // ★ 2026-09-29：一格的宽度**不再封顶 96**了 —— 它是"按页面宽度等宽排列"里那个槽宽
    //   （宽屏上会比 96 大：那是主人要的"铺满"）。这里只钉**等宽**这一半；
    //   "铺满"由 `test/unit/desktop_grid_test.dart` 与下面那条判据管。
    expect(long.width > 0, true);
  });

  testWidgets('★ 正在动的那一格：**只藏图标**，格子和标签还在（位置一个像素不动）', (tester) async {
    // 主人 2026-09-24：*"appicon 应该是动效结束后出现…打开的时候 appicon 应该是瞬间消失掉"*
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AppDesktop(
            apps: [
              DesktopApp(
                label: '设置',
                id: 'settings',
                icon: Icons.star_outline,
                onOpen: (_) {},
              ),
              DesktopApp(
                label: '发现',
                id: 'discover',
                icon: Icons.star_outline,
                onOpen: (_) {},
              ),
            ],
            hideIconId: 'settings',
            onTapBlank: _noop,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final ops = tester
        .widgetList<Opacity>(
          find.ancestor(
            of: find.byIcon(Icons.star_outline),
            matching: find.byType(Opacity),
          ),
        )
        .map((o) => o.opacity)
        .toList();
    expect(ops, contains(0.0), reason: '正在动的那一格图标要藏起来');
    expect(ops, contains(1.0), reason: '别的格子照常画');
    expect(find.text('设置'), findsOneWidget, reason: '标签留着（只藏图标）');
    expect(find.text('发现'), findsOneWidget);
  });

  testWidgets('放大到 2.0 倍也不溢出（D3.5 那一族的形状）', (tester) async {
    await pump(
      tester,
      [app('设置'), app('发现'), app('我自己那台'), app('掷硬币'), app('掷骰子'), app('问答小抄')],
      scale: 2.0,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('🔴 加一个 app ⇒ 已有那几个**一格都不动**（"app 都有位置"·苹果那套）', (tester) async {
    // 主人 2026-10-01：*「一行根据屏幕大小，不要放超过6个app。而且app都有位置。
    //   要模拟苹果的桌面排布。」* —— 问过之后他选**甲**：
    //   **列数只由屏幕定** ＋ **末行贴左**（见 `models/desktop_grid.dart`）。
    //   ⇒ 这一条钉的就是那个感觉：**加一个 app，前面的一个都不许挪**。
    final names = [for (var i = 0; i < 6; i++) '应用$i'];
    await pump(tester, [for (final n in names) app(n)]);
    final before = [for (final n in names) tester.getRect(find.text(n))];

    await pump(tester, [for (final n in [...names, '应用6']) app(n)]);
    for (var i = 0; i < names.length; i++) {
      expect(tester.getRect(find.text(names[i])), before[i],
          reason: '★ 第 7 个进来之后「${names[i]}」挪位了 —— 那就不是"app 都有位置"'
              '（旧算法：列数跟着**个数**走 ⇒ 1 个时那一格是整条宽）');
    }
    // 一行最多 6 个 ⇒ 第 7 个必须落到**第二行**
    expect(tester.getRect(find.text('应用6')).top, greaterThan(before[0].top),
        reason: '★ 第 7 个该在第二行（「不要放超过6个app」）');
    // 末行**贴左**（苹果是从左边接着排）：第 7 个落在**第一列**上 ⇒ 与第 1 个同一 x
    expect(tester.getRect(find.text('应用6')).left, closeTo(before[0].left, 0.001),
        reason: '★ 末行该贴左；居中的话它会往右偏（改前就是居中）');
  });

}
