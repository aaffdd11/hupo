// **奥数题库**那一刀的判据（契约 `docs/dev/57-MATH.md`）。
//
// 🔴 这一份里**最值钱的不是界面判据，是题库自己的判据**：
//    一道算错的奥数题，比"没有题"坏得多 —— 这个项目最忌"看着像真的"。
//    所以这里既验**形状**（每道题都有答案和"为什么"），也**重算**了其中几道
//    （能算的必须算一遍，不能只信我写的那句答案）。

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/forbidden_words.dart';
import 'package:hupo_app/models/math_bank.dart';
import 'package:hupo_app/models/math_words.dart';
import 'package:hupo_app/screens/math_quiz_screen.dart';

void main() {
  group('题库本身', () {
    test('★ 每一道题都有题目、答案、和一句"为什么"', () {
      for (final (q, a, why) in mathBank) {
        expect(q.trim().isNotEmpty, true);
        expect(a.trim().isNotEmpty, true, reason: '这道题没写答案：$q');
        expect(why.trim().isNotEmpty, true, reason: '★ 这道题没有"为什么"，人就没法验它：$q');
      }
    });

    test('★ 题目不许重复（同一道题出现两次 = 换一题会撞车）', () {
      final seen = <String>{};
      for (final (q, _, _) in mathBank) {
        expect(seen.add(q), true, reason: '这道题出现两次：$q');
      }
    });

    test('🔴 能算的，**重算一遍**（不能只信写的那句答案）', () {
      // 挑那些"答案是个数、能独立算出来"的，用代码再算一次。
      String? answerOf(String q) {
        for (final (qq, a, _) in mathBank) {
          if (qq == q) return a;
        }
        return null;
      }

      // 等差数列求和：1+2+…+20
      expect(answerOf('巧算：1+2+3+…+20 = ?'), (20 * 21 ~/ 2).toString());
      // 1+3+5+…+19 = 前 10 个奇数的和 = 10²
      expect(answerOf('巧算：1+3+5+…+19 = ?'), (10 * 10).toString());
      // 2+4+…+20 = 2×(1+…+10) = 110
      expect(answerOf('巧算：2+4+6+…+20 = ?'), (2 * (10 * 11 ~/ 2)).toString());
      // 99×38
      expect(answerOf('简算：99 × 38 = ?'), (100 * 38 - 38).toString());
      // 125×8×7
      expect(answerOf('简算：125 × 8 × 7 = ?'), (125 * 8 * 7).toString());
      // 45×102
      expect(answerOf('简算：45 × 102 = ?'), (45 * 100 + 45 * 2).toString());
      // 鸡兔同笼：20 头 56 脚 ⇒ 兔 =(56−20×2)÷2
      expect(answerOf('鸡兔同笼：一共 20 个头、56 只脚。兔有几只？'), '${(56 - 20 * 2) ~/ 2} 只');
      // 植树（两端都栽）：100÷5+1
      expect(answerOf('一条 100 米的路，每隔 5 米栽一棵树，（两端都栽），一共栽多少棵？'), '${100 ~/ 5 + 1} 棵');
      // 圆形池塘：100÷5
      expect(answerOf('一个圆形池塘周长 100 米，每隔 5 米栽一棵树，一共栽多少棵？'), '${100 ~/ 5} 棵');
      // 平均数 (80+90+100+70)/4
      expect(answerOf('四个数 80、90、100、70 的平均数是多少？'), '${(80 + 90 + 100 + 70) ~/ 4}');
      // 归一：240/(3×4)×(5×6)
      expect(answerOf('3 台机器 4 小时做 240 个零件。5 台机器 6 小时做多少个？'), '${240 ~/ (3 * 4) * (5 * 6)} 个');
      // 容斥：30−(20+15−8)
      expect(answerOf('会游泳的 20 人、会滑冰的 15 人、两样都会的 8 人。两样都不会的有几人？（全班 30 人）'), '${30 - (20 + 15 - 8)} 人');
      // 方阵最外层：4×6−4
      expect(answerOf('一个方阵最外层每边 6 人。最外层一共多少人？'), '${4 * 6 - 4} 人');
      // 搭配：3×4
      expect(answerOf('3 件上衣和 4 条裤子，一共有多少种搭配？'), '${3 * 4} 种');
      // 正方体棱长和：12×5
      expect(answerOf('一个正方体的棱长是 5 厘米，它所有棱的长度和是多少？'), '${12 * 5} 厘米');
      // 相遇：300/(40+60)
      expect(answerOf('两地相距 300 米，两人从两头同时相向走，速度分别是 40 米/分和 60 米/分。几分钟相遇？'), '${300 ~/ (40 + 60)} 分钟');
      // 追及：100/(80−60)
      expect(answerOf('甲每分钟 80 米、乙每分钟 60 米，两人同向走，甲在乙后面 100 米。几分钟后甲追上乙？'), '${100 ~/ (80 - 60)} 分钟');
      // 火车过桥：(100+400)/20
      expect(answerOf('一列火车长 100 米，以每秒 20 米的速度通过 400 米长的桥。要多少秒？'), '${(100 + 400) ~/ 20} 秒');
      // 盈亏：(8+2)/(4−3)
      expect(answerOf('每人分 3 个还多 8 个，每人分 4 个又少 2 个。有多少人？'), '${(8 + 2) ~/ (4 - 3)} 人');
      // 锯木头：5 段要 4 刀 = 8 分 ⇒ 每刀 2 分；8 段要 7 刀
      expect(answerOf('把一根木头锯成 5 段要 8 分钟。锯成 8 段要多少分钟？'), '${8 ~/ 4 * 7} 分钟');
      // 敲钟：4 下 3 间隔 = 6 秒 ⇒ 每间隔 2 秒；8 下 7 间隔
      expect(answerOf('钟敲 4 下用了 6 秒。敲 8 下要用多少秒？'), '${6 ~/ 3 * 7} 秒');
      // 长方形面积：周长 20、长 7 ⇒ 宽 3
      expect(answerOf('一个长方形的周长是 20 米，长是 7 米。它的面积是多少平方米？'), '${7 * (20 ~/ 2 - 7)} 平方米');
      // 5 元/10 元：x+y=12、5x+10y=90 ⇒ x=6
      expect(answerOf('12 张纸币，5 元和 10 元共 90 元。5 元有几张？'), '6 张');
    });

    test('🔴 题库里一句禁用词都不许有（界面词表是硬闸）', () {
      for (final (q, a, why) in mathBank) {
        for (final s in [q, a, why]) {
          expect(hasForbidden(s), false, reason: '「$s」命中了禁用词');
        }
      }
    });
  });

  group('那一屏', () {
    Future<void> pump(WidgetTester tester, {int seed = 7}) async {
      await tester.pumpWidget(
        MaterialApp(home: Scaffold(body: MathQuizScreen(random: _Fixed(seed)))),
      );
      await tester.pump();
    }

    test('★ 新文案也要过禁用词闸', () {
      for (final s in [mathAppLabel, mathTitle, mathShowAnswer, mathNext, mathAnswerLabel, mathWhyLabel, mathProgress(0, 40)]) {
        expect(hasForbidden(s), false, reason: '「$s」命中了禁用词');
      }
    });

    testWidgets('🔴 一屏一道题 + 进度；**答案点开才给**（先让他想）', (tester) async {
      await pump(tester);
      expect(find.text(mathProgress(0, mathBank.length)), findsOneWidget);
      expect(find.text(mathBank[0].$1), findsOneWidget, reason: '题目要在');
      expect(find.text(mathAnswerLabel), findsNothing, reason: '★ 一进来不许摊着答案');
      expect(find.text(mathBank[0].$2), findsNothing, reason: '★ 答案不许一进来就在屏幕上');

      await tester.tap(find.text(mathShowAnswer));
      await tester.pump();
      expect(find.text(mathBank[0].$2), findsOneWidget, reason: '点了"看答案"才给');
      expect(find.text(mathBank[0].$3), findsOneWidget, reason: '★ 而且**永远带一句"为什么"**');
      expect(find.text(mathShowAnswer), findsNothing);
    });

    testWidgets('🔴 「换一题」真的换一道，而且**答案自己收起来**', (tester) async {
      await pump(tester);
      await tester.tap(find.text(mathShowAnswer));
      await tester.pump();
      expect(find.text(mathAnswerLabel), findsOneWidget);

      await tester.tap(find.text(mathNext));
      await tester.pump();
      expect(find.text(mathAnswerLabel), findsNothing, reason: '★ 换题要把答案收起来（新题一上来就摊答案 = 没得想）');
      // 换了一道**不同的**题（进度那一行也跟着变）
      final shown = [for (final (q, _, _) in mathBank) if (find.text(q).evaluate().isNotEmpty) q];
      expect(shown.length, 1, reason: '一屏只该有一道题');
      expect(shown.first == mathBank[0].$1, false, reason: '换一题该换掉刚才那道');
    });
  });
}

/// 固定种子的随机源（测试里结果不许飘）。
class _Fixed implements math.Random {
  _Fixed(this.seed);
  final int seed;
  int _n = 0;
  @override
  bool nextBool() => false;
  @override
  double nextDouble() => 0;
  @override
  int nextInt(int max) {
    _n += 1;
    return (seed + _n) % max;
  }
}
