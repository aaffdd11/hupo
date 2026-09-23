// **桌面那层动态背景**（主人 2026-09-22：*"给登录后的桌面增加一个动态背景，有水面波纹状。"*）。
//
// ── 这一份量的是什么 ───────────────────────────────────────
// 不是"好不好看"（那是主人的眼睛说了算），而是**三件会在将来悄悄坏掉的事**：
//   ① 它**真的挂到桌面上了**（不是写了一个没人用的 widget）；
//   ② 它**没吃掉点击** —— "点桌面空白 = 收起聊天"是 §6.3 交互表里的一条，
//      背景把点击吃了的话，那一条会**静默失效**（而这种失效没人会去查背景）；
//   ③ 它**不会把别的闸拖死** —— 一个永不结束的动画会让 `pumpAndSettle` 转到
//      10 分钟超时，而"测试卡住"和"功能坏了"是**两种完全不同的红**。
//
// ⚠️ ② 的写法很关键：**点空白，然后看上层收到没收** ——
//    只断言"图标还在"是测不出背景吃点击的（背景又不改排布）。

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/design.dart' as d;
import 'package:hupo_app/widgets/app_desktop.dart';
import 'package:hupo_app/widgets/water_bg.dart';

Widget _desk({required VoidCallback onTapBlank}) => MaterialApp(
  home: Scaffold(
    body: AppDesktop(
      apps: [
        DesktopApp(
          label: '设置',
          icon: Icons.settings_outlined,
          onOpen: (_) {},
        ),
      ],
      onTapBlank: onTapBlank,
    ),
  ),
);

/// **桌面那一层里的水面画笔**（在不在）。
///
/// ⚠️ 量的是**画家**、不是"那个 widget"：`WaterBackground` 在树里只说明接上了，
///    而**画不画**由 `WaterRipplePainter` 说了算 —— 一个没有画家的 `CustomPaint`
///    看着像做了，其实一个像素都没有。
Finder _painters() => find.byWidgetPredicate(
  (w) => w is CustomPaint && w.painter is WaterRipplePainter,
);

void main() {
  // ⚠️ 动画的开关**不是这一份管的**：它由 `test/flutter_test_config.dart`
  //    在整个测试进程启动时关掉（理由写在那儿）。这一份要验的恰恰是
  //    "关掉之后它还在树上、还画着"。

  testWidgets('桌面那一层真的有水面背景（而且画家在画）', (tester) async {
    await tester.pumpWidget(_desk(onTapBlank: () {}));
    expect(
      find.byType(WaterBackground),
      findsOneWidget,
      reason: '★ 桌面上没有这一层 ⇒ "动态背景"根本没接上',
    );
    expect(
      _painters(),
      findsOneWidget,
      reason: '★ 有那一层、却没有画笔 ⇒ 它是个透明的空壳（看着像做了，其实什么都没画）',
    );
  });

  testWidgets('背景**不许**吃掉"点桌面空白"（§6.3：点空白 = 收起聊天）', (tester) async {
    var tapped = 0;
    await tester.pumpWidget(_desk(onTapBlank: () => tapped += 1));
    // ⚠️ 点**图标以外的**地方（右上角空旷处）—— 那才是"点桌面空白"
    await tester.tapAt(const Offset(760, 40));
    await tester.pump();
    expect(
      tapped,
      1,
      reason: '★ 点空白没传到桌面手上 —— 多半是背景那一层把命中吃了'
          '（背景必须 `IgnorePointer`；它只是底图，不接任何输入）',
    );
  });

  testWidgets('永不结束的动画**不会**把 pumpAndSettle 拖死（"关掉动画"那一套的前提）', (tester) async {
    // 🔴 这条看着平淡，其实是**整套界面闸的前提**：
    //    没有它，`test/widget/` 里一百多处 pumpAndSettle 会集体转到 10 分钟超时
    //    （那种红不指向任何真 bug，而且没人修得动）。
    //    ⚠️ 断言的是"能回来"，不是"回来得快" —— 时长不是这一条要钉的东西。
    //
    // ⚠️ 这一条**不自己设那个标志**：它要钉的正是
    //    "`test/flutter_test_config.dart` 那一处**真的生效了**"——
    //    自己设一遍的话，配置丢了它也照样绿（那就成了自说自话）。
    //    ⇒ 所以它必须排在下面那条"显式把动画打开"的用例**之前**。
    //
    // ⚠️ 2026-09-22 它**真的抓到过一次**：`build()` 里算 `_on` 时漏了
    //    `debugWaterRippleAnimates` 这个条件（`_run()` 里算对了、`build()` 里漏了）
    //    ⇒ 测试里动画照跑、`desktop_floater_test` 7 条 `pumpAndSettle timed out`。
    //    这就是"同一个判断写两处"的形状。
    await tester.pumpWidget(_desk(onTapBlank: () {}));
    await tester.pumpAndSettle(const Duration(milliseconds: 100));
    expect(find.byType(AppDesktop), findsOneWidget);
  });

  testWidgets('🔴 关掉动画 ≠ 删掉这一层：画笔照旧在，只是不走时间', (tester) async {
    // ⚠️ 这条是给"将来有人图省事、把开关做成 `if (!on) return SizedBox()`"留的负向对照：
    //    那样写"pumpAndSettle 不挂"照样成立（所以上面那条拦不住它），
    //    但线上那次"用户开了减弱动态效果"就会**少一层背景光** ——
    //    而两张截图看起来"差不多"，没人会发现。
    //
    // ⚠️ **显式**关一次（哪怕上面那份配置已经关了），而且**把原来那个值还回去**：
    //    这条用例要钉的正是"关掉之后会怎样"，不能靠别处的副作用成立；
    //    而它改的是**全局**标志 —— 不还回去的话，往后跑的一切都会跟着变
    //    （连"动画开着会怎样"都没法再测了）。
    final was = debugWaterRippleAnimates;
    debugWaterRippleAnimates = false;
    addTearDown(() => debugWaterRippleAnimates = was);
    await tester.pumpWidget(_desk(onTapBlank: () {}));
    expect(find.byType(WaterBackground), findsOneWidget);
    expect(
      _painters(),
      findsOneWidget,
      reason: '★ 关掉动画顺手把画笔也删了 —— 那它就不是"不动"，是"没有"',
    );
  });

  // ── 🔴 这两条是 2026-09-23「水纹没有生效」补的 ─────────────────────
  //
  // 那次事故的形状：**动画一直在跑（帧一直在走），一个像素都没露出来** ——
  // 因为水面在 `Stack` 最底层，而它上面那个 `Material` 是**不透明的纸色**。
  // 上面四条判据**全是绿的**：它们验的是"在不在树上 / 会不会吃点击 /
  // 会不会拖死 pumpAndSettle"，**没有一条验过"它画出来的东西看得见"**。
  // ⚠️ 这就是"闸变弱了"的典型形状（`43`/`52`/`54` 都栽过）：
  //    判的东西是对的，只是**没判到那件会坏的事**。
  //
  // ⇒ 补两条，一条管"画家真的出像素"，一条管"没有人再把它盖回去"。

  testWidgets('🔴 画家**真的出像素**：画到画布上必须有一片和纸底不同的点', (tester) async {
    // ⚠️ 量的是**像素**，不是"有没有那个 widget"。
    //    这一条能拦住的典型写法：alpha 写成了 0、颜色写成了纸底、尺寸算成了 0。
    // ⚠️ **必须 `runAsync`**：光栅化（`toImage`）走的是**真异步**，
    //    而 `testWidgets` 的假时钟里那种 Future **永远不会完成** ——
    //    我第一次就写成普通的 `await`，结果整条用例**挂到超时**（600 秒）。
    const size = Size(400, 300);
    final bytes = await tester.runAsync(() async {
      final rec = ui.PictureRecorder();
      final canvas = Canvas(rec);
      canvas.drawRect(Offset.zero & size, Paint()..color = d.paper);
      const WaterRipplePainter(seconds: 0).paint(canvas, size);
      final img = await rec.endRecording().toImage(
        size.width.toInt(),
        size.height.toInt(),
      );
      return img.toByteData(format: ui.ImageByteFormat.rawRgba);
    });

    var diff = 0;
    final px = bytes!.buffer.asUint8List();
    for (var i = 0; i < px.length; i += 4) {
      if ((px[i] - 248).abs() + (px[i + 1] - 245).abs() + (px[i + 2] - 238).abs() >
          0) {
        diff += 1;
      }
    }
    expect(
      diff,
      greaterThan(200),
      reason: '★ 画家画了半天，和纸底**一模一样的点有 ${400 * 300 - diff} 个**'
          '（只有 $diff 个不一样）⇒ 它画的要么是纸色、要么 alpha 是 0 —— '
          '那"加了背景"就是一句假话',
    );
  });

  test('🔴 桌面那层"接点击的纸"**必须透明**（不然它会把水面盖住）', () {
    // ⚠️ 这是**源码级**判据：这个 bug（水面被不透明的纸盖住）在任何渲染判据里
    //    都表现为"一切正常"（树是对的、点击是对的），只有像素能看出来 ——
    //    而像素判据在 CI 上不一定稳。⇒ 在这儿把那一处**点名钉死**。
    //    （同一条纪律的另一个例子：`accessibility_test.dart` 里那条
    //      "lib 里不许出现裸的 GestureDetector"。）
    final src = File('lib/widgets/app_desktop.dart').readAsStringSync();
    expect(
      src.contains('color: Colors.transparent,'),
      isTrue,
      reason: '★ 那层 `Material` 的颜色不是透明 ⇒ 它会盖在水面上，'
          '用户看到的就是"水纹没生效"（2026-09-23 真栽过）',
    );
    expect(
      // ⚠️ 同时把**旧的错法**钉成负向对照：纸色不许再出现在这一层
      RegExp(r'Material\(\s*//[^\n]*\n\s*color: d\.paper').hasMatch(src),
      isFalse,
      reason: '★ 那层 `Material` 又画成纸色了 —— 纸底归 `Scaffold` 管',
    );
  });
}
