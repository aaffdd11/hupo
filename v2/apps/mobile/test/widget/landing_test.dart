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
import 'package:hupo_app/screens/landing_screen.dart';

Future<void> _pump(WidgetTester tester, {VoidCallback? onStart}) async {
  await tester.pumpWidget(MaterialApp(home: LandingScreen(onStart: onStart ?? () {})));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('🔴 那句承诺和三个入口都在屏幕上', (tester) async {
    await _pump(tester);
    expect(find.text(landingPromise), findsOneWidget, reason: '手册 〇 那句承诺必须在这儿');
    expect(find.text(landingStart), findsOneWidget);
    expect(find.text(landingDownload), findsOneWidget);
    // ⚠️ 三张卡在**首屏之外** ⇒ 要像用户那样**滚下去**再看
    //    （`ListView` 是懒的，不滚就不会建 ⇒ 直接 find 会说"找不到"，那是假的）
    for (final (mark, title, _) in landingCards) {
      await tester.scrollUntilVisible(find.text(title), 240);
      expect(find.text(title), findsOneWidget, reason: '三张卡少了一张：$title');
      expect(find.text(mark), findsOneWidget, reason: '标记少了一个：$mark');
    }
    // ⚠️ "第一次要等一下"必须**在点之前**就说（别让他登录完才发现）
    expect(find.text(landingStartHint), findsOneWidget);
  });

  testWidgets('🔴 点"下载安卓版" ⇒ **如实说没上线**，而且不许装出"正在下载"', (tester) async {
    await _pump(tester);
    await tester.tap(find.text(landingDownload));
    await tester.pump();

    expect(find.text(landingAndroidNotYet), findsOneWidget, reason: '★ 必须说没上线');
    // 负向对照：屏上**不许**出现任何"在下载/正在准备"这一类假动作的字
    for (final fake in ['正在下载', '下载中', '正在准备', '请稍候', '即将开始']) {
      expect(find.textContaining(fake), findsNothing, reason: '★ 没有的东西不许装：$fake');
    }
    // 而且 Promise 之外不许编一个进度条出来
    expect(find.byType(LinearProgressIndicator), findsNothing);
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
