// **奥数题**：桌面上的第二个小程序（契约 `docs/dev/57-MATH.md`）。
//
// 主人 2026-09-22：*"我让它做一个四年级 mca 奥数题库小程序。"* —— 助手做不到
// （界面是编译进客户端的，它没有"装一个进桌面"的路；人格已改成第一句直说）。
// ⇒ 主人选 **A：内置一份题库**，由我来做。
//
// 形状（微信那种题库小程序的味道）：一屏一道题 · 底下两个动作（看答案 / 换一题）。
//   · **看答案**点开才给 —— 先让他想（这是题库，不是答案册）；
//   · 答案下面**永远带一句"为什么"**：一道算错的题比没有题坏得多，
//     而"为什么"就是让人**一眼能验**的那一步。
//
// ⚠️ 和 `SettingsScreen` 同一条规矩：**不画 `Scaffold` / `AppBar`** ——
//    顶上那条由**小程序容器**（`MiniAppHost`）给；它跑在容器自己的 `Navigator` 里。
// ⚠️ 整屏是 `ListView`（不是 `Column`）：五档字号下**能滚**，不溢出（`accessibility_test.dart` 硬闸）。

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/math_bank.dart';
import '../models/math_words.dart';

class MathQuizScreen extends StatefulWidget {
  const MathQuizScreen({super.key, this.bank = mathBank, this.random});

  /// 题库（测试可以塞一小份进来）。默认就是内置那 40 道。
  final List<MathQuestion> bank;

  /// "换一题"用哪个随机源（测试里给固定种子，免得结果飘）。
  final math.Random? random;

  @override
  State<MathQuizScreen> createState() => _MathQuizScreenState();
}

class _MathQuizScreenState extends State<MathQuizScreen> {
  late final math.Random _rng = widget.random ?? math.Random();
  int _i = 0;
  bool _showAnswer = false;

  /// **换一题**：随机挑一道**不是现在这道**的（题多的时候别让人连着看见同一题）。
  void _next() {
    if (widget.bank.length <= 1) {
      setState(() => _showAnswer = false);
      return;
    }
    var n = _i;
    while (n == _i) {
      n = _rng.nextInt(widget.bank.length);
    }
    setState(() {
      _i = n;
      _showAnswer = false; // 换题就把答案收起来 —— 不然新题一上来答案就摊着
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final (q, a, why) = widget.bank[_i];
    return Center(
      child: ConstrainedBox(
        // 和首页/设置同一条窄列（契约 `49-STYLE.md`：一行太长没人读得下去）
        constraints: const BoxConstraints(maxWidth: 640),
        child: ListView(
          padding: const EdgeInsets.symmetric(horizontal: d.gapL, vertical: d.gapL),
          children: [
            // ── 进度（他自己知道的那个数）──
            Text(
              mathProgress(_i, widget.bank.length),
              style: t.textTheme.labelLarge?.copyWith(color: d.accent, letterSpacing: 1.2),
            ),
            const SizedBox(height: d.gapM),
            // ── 题目 ──
            Card(
              child: Padding(
                padding: const EdgeInsets.all(d.gapM),
                child: Text(
                  q,
                  style: t.textTheme.titleMedium?.copyWith(color: d.ink, height: 1.6),
                ),
              ),
            ),
            const SizedBox(height: d.gapM),
            // ── 答案：**点开才给**，而且**永远带一句"为什么"** ──
            if (!_showAnswer)
              Align(
                alignment: Alignment.centerLeft,
                child: FilledButton(
                  onPressed: () => setState(() => _showAnswer = true),
                  child: const Text(mathShowAnswer),
                ),
              )
            else
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(d.gapM),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        mathAnswerLabel,
                        style: t.textTheme.labelLarge?.copyWith(color: d.accent),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        a,
                        style: t.textTheme.headlineSmall?.copyWith(color: d.ink),
                      ),
                      const SizedBox(height: d.gapM),
                      Text(
                        mathWhyLabel,
                        style: t.textTheme.labelLarge?.copyWith(color: d.muted),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        why,
                        style: t.textTheme.bodyMedium?.copyWith(color: d.ink, height: 1.6),
                      ),
                    ],
                  ),
                ),
              ),
            const SizedBox(height: d.gapM),
            // ── 换一题 ──
            Align(
              alignment: Alignment.centerLeft,
              child: OutlinedButton(
                onPressed: _next,
                child: const Text(mathNext),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
