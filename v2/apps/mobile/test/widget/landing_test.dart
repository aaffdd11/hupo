// 第一屏（landing）画到屏幕上之后长什么样（主人 2026-09-21 点名要的那一屏）。
//
// 这一屏只有两条规矩真正值钱，都在这里钉住：
//   🔴 **安卓那个按钮不许假装**：现在**没有**安装包 ⇒ 点了必须**如实说没上线**。
//      这是本项目最贵的那一类缺陷（"说了做不到 = 撒谎"，手册事故一的形状）。
//   🔴 **点"开始用"必须真的往下走**（进登录）—— 一个点了没反应的按钮，
//      在用户那边和"坏了"是同一件事。
//
// ⚠️ 提示档（`test/widget` 的通用规矩），但它是"这一屏到底画没画出来"的唯一自动化证据 ⇒ 别删。
// ⚠️ 五档不溢出 / 命中区 ≥44 那两条在 `accessibility_test.dart`（**硬闸**）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/landing_words.dart';
import 'package:hupo_app/models/server_address.dart';
import 'package:hupo_app/screens/landing_screen.dart';

Future<void> _pump(
  WidgetTester tester, {
  VoidCallback? onStart,
  bool Function(String url)? onDownload,
}) async {
  await tester.pumpWidget(MaterialApp(
    home: LandingScreen(onStart: onStart ?? () {}, onDownload: onDownload),
  ));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('🔴 那句承诺和四个入口都在屏幕上（开始用 ＋ 两颗下载）', (tester) async {
    await _pump(tester);
    expect(find.text(landingPromise), findsOneWidget, reason: '手册 〇 那句承诺必须在这儿');
    expect(find.text(landingStart), findsOneWidget);
    expect(find.text(landingDownload), findsOneWidget);
    // ★ 2026-10-05：老那一版那颗也在（主人："1.0 和 2.0 各一个"）
    expect(find.text(landingDownloadV1), findsOneWidget,
        reason: '★ 1.0 那颗下载按钮也要在屏幕上（老包原样留着）');
    // ⚠️ "第一次要等一下"必须**在点之前**就说（别让他登录完才发现）。
    //    ⚠️ 这句要在**滚动之前**查：它在顶上，滚到底之后 `ListView` 会把它回收掉（我栽过）。
    expect(find.text(landingStartHint), findsOneWidget);
    // ⚠️ 这几张卡在**首屏之外** ⇒ 要像用户那样**滚下去**再看
    //    （`ListView` 是懒的，不滚就不会建 ⇒ 直接 find 会说"找不到"，那是假的）
    //
    // ⚠️ **别用 `scrollUntilVisible` 逐张找**（2026-09-22 实测）：它一步 240px 地跳，
    //    卡片一多就会**冲过头**，然后报 "Bad state: No element"（找不着了）。
    //    ⇒ 改成**一路滚下去、边滚边收**：验证的是"每一张都被画出来过"。
    final wanted = <String>{
      for (final (mark, title, _) in landingCards) ...[title, mark],
    };
    final seen = <String>{};
    for (var i = 0; i < 40 && seen.length < wanted.length; i++) {
      for (final w in wanted) {
        if (find.text(w).evaluate().isNotEmpty) seen.add(w);
      }
      await tester.drag(find.byType(ListView), const Offset(0, -200));
      await tester.pump();
    }
    expect(seen.length, wanted.length, reason: '这些没被画出来过：${wanted.difference(seen).toList()}');
  });

  testWidgets('🔴 点"下载安卓版" ⇒ **真把那条绝对地址交出去**（2026-09-28 起不再是"还没上线"）', (tester) async {
    // ⚠️ 判据**必须注入**：VM 上 `canOpenLinks` 恒假（那一份是桩）⇒
    //    不注入就只能量到"你正在用的就是这个安卓版"那一句。
    final asked = <String>[];
    await _pump(tester, onDownload: (u) { asked.add(u); return true; });
    await tester.tap(find.text(landingDownload));
    await tester.pump();

    expect(asked, hasLength(1), reason: '★ 点了没反应 = 用户那边就是"坏了"');
    final uri = Uri.parse(asked.single);
    expect(uri.hasAuthority, isTrue, reason: '★ `openExternal` 只认 http(s)：相对路径当场回 false ⇒ 什么都下不下来');
    expect(uri.path, hupoApkPath, reason: '★ 交出去的那条路必须正是安装包那条');
    expect(find.text(landingAndroidStarted), findsOneWidget, reason: '★ 真开了才说"开始下载"');

    // 负向对照：屏上**不许**出现任何"还在准备"这一类假动作的字（真下载也不例外）
    for (final fake in ['下载中', '正在准备', '请稍候', '即将开始']) {
      expect(find.textContaining(fake), findsNothing, reason: '★ 没有的东西不许装：$fake');
    }
    expect(find.byType(LinearProgressIndicator), findsNothing);
    // 负向对照之二：那句旧的"还没上线"**必须已经不在**了（它就是这次改掉的假话）
    expect(find.textContaining('还没上线'), findsNothing, reason: '★ 安卓已经能下载了 ⇒ 那句是假话');
  });

  testWidgets('🔴 两颗下载按钮各交各的地址：2.0 与 1.0 **不是同一条路**', (tester) async {
    // 主人 2026-10-05：*「打包apk，这次是2.0版本了，我想起另一个app，不要覆盖1.0」*
    //   ＋ 他挑的首页形状："1.0 和 2.0 各一个"。
    //   ⇒ 两颗按钮必须**各指各的**：一个指现在这一版、一个指老那一版。
    //   ⚠️ 它们要是同一条路，屏幕上就是"两颗按钮下同一个包"（等于骗人，也等于没做）。
    final asked = <String>[];
    await _pump(tester, onDownload: (u) { asked.add(u); return true; });
    await tester.tap(find.text(landingDownload));
    await tester.pump();
    await tester.tap(find.text(landingDownloadV1));
    await tester.pump();

    expect(asked, hasLength(2), reason: '★ 两颗按钮都得真交出一条地址');
    final two = asked.map((u) => Uri.parse(u)).toList();
    expect(two[0].path, hupoApkPath, reason: '★ 「下载安卓版 2.0」要指现在这一版');
    expect(two[1].path, hupoApkPathV1, reason: '★ 「下载安卓版 1.0」要指老那一版（它原样留着）');
    expect(two[0].path, isNot(two[1].path), reason: '★ 两条路不许是同一条');
    for (final u in two) {
      expect(u.hasAuthority, isTrue, reason: '★ 两条都得是绝对地址（`openExternal` 只认 http(s)）');
    }
  });

  testWidgets('🔴 没开成 ⇒ 说清怎么办（**不是**"正在准备"）', (tester) async {
    await _pump(tester, onDownload: (_) => false);
    await tester.tap(find.text(landingDownload));
    await tester.pump();
    expect(find.text(landingAndroidCantHere), findsOneWidget);
    expect(find.text(landingAndroidStarted), findsNothing, reason: '★ 没开成就不许说"开始下载了"');
  });

  testWidgets('★ 站在安卓包里点它 ⇒ 如实说"你正在用的就是这个安卓版"', (tester) async {
    // 不注入 ⇒ VM 那一侧 `canOpenLinks` 恒假，就是"原生那一档"的形状。
    await _pump(tester);
    await tester.tap(find.text(landingDownload));
    await tester.pump();
    expect(find.text(landingAndroidOnIt), findsOneWidget);
  });

  testWidgets('🔴 点"开始用" ⇒ 真的往下走（回调被调用一次）', (tester) async {
    var started = 0;
    await _pump(tester, onStart: () => started += 1);
    await tester.tap(find.text(landingStart));
    await tester.pump();
    expect(started, 1, reason: '★ 点了没反应 = 用户那边就是"坏了"');
  });

  testWidgets('负向对照：它是**介绍**，不是登录页（没有输入框）', (tester) async {
    await _pump(tester);
    expect(find.byType(TextField), findsNothing, reason: '第一屏不该让人填东西');
  });

  testWidgets('🔴 "跟聊天机器人不一样在哪"那块**真的画在屏幕上**（契约 51-VS-CHAT）', (tester) async {
    await _pump(tester);
    // ⚠️ 这一块在**首屏之外**，而且 `ListView` 是懒的（不滚就不建）
    //    ⇒ 判据是"**一路滚下去，每一句都被画出来过**"。
    //    （我第一版用 `scrollUntilVisible` 逐行滚 —— 它会跳过/冲过头，读数不稳。）
    final wanted = <String>{
      landingDiffTitle,
      for (final (left, right) in landingDiff) ...[
        '$landingDiffLeft：$left',
        '$landingDiffRight：$right',
      ],
    };
    final seen = <String>{};
    for (var i = 0; i < 30 && seen.length < wanted.length; i++) {
      for (final w in wanted) {
        if (find.text(w).evaluate().isNotEmpty) seen.add(w);
      }
      await tester.drag(find.byType(ListView), const Offset(0, -200));
      await tester.pump();
    }
    expect(
      seen.length,
      wanted.length,
      reason: '这些句子没被画出来过：${wanted.difference(seen).toList()}',
    );
    // 负向对照：两边**不许写成同一句**（那样这个对照块就什么都没说）
    for (final (left, right) in landingDiff) {
      expect(left == right, false, reason: '左右两栏写成同一句了：$left');
    }
  });
}
