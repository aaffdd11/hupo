// **两屏之间丝滑地换**（不是硬切）。
//
// ── 为什么要有这个文件 ────────────────────────────────────
// 主人 2026-09-22：*"从首页，点击开始，到登录页显示，我希望是一个**丝滑的过渡**展示效果，
// 而不是**突然出现**的效果。"*
//
// 原来 `main.dart` 里是 `_showLogin ? 登录页 : 首页` —— 那是**硬切**：
// 一帧之内旧屏没了、新屏整个出现。观感上就是"页面闪了一下"，
// 而且**没有动画的界面看起来像坏了**（这条不只是好看：走查里"它到底有没有反应"
// 是这个项目最贵的那个问题）。
//
// ── 它做三件事 ───────────────────────────────────────────
//   ① **淡入淡出**（`FadeTransition`）—— 两屏交叠，不再"啪"地一下；
//   ② **新屏轻轻上浮**（`SlideTransition`，行程很小：0.03 屏高）——
//      给"它来了"一点方向感，又不至于让人等它滑完；
//   ③ **旧屏留在下面、新屏在上面**（`layoutBuilder` 里 `Stack` 的顺序）——
//      动画期间旧屏**还能看见**（这就是"过渡"而不是"闪"），但**点不到**
//      （新屏在上面且铺满，`AnimatedSwitcher` 自己会把旧的包进 `IgnorePointer` 之外的那一层？
//       ⚠️ 不，它不会 —— 所以这里**显式**把旧屏包一层 `IgnorePointer`）。
//
// ⚠️ **时长只许从 `d.motionPage` 来**（手册 §10.1 阈值总表那一行）。
// ⚠️ **不动 `Navigator`**：这一屏的切换是"同一个页面里的两个状态"（`_showLogin`），
//    不是路由 —— 换成 push 会把"回首页那个箭头"、以及退出登录那条路一起改掉。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;

class SoftSwitch extends StatelessWidget {
  const SoftSwitch({super.key, required this.showSecond, required this.first, required this.second});

  /// `false` ⇒ 显示 [first]；`true` ⇒ 显示 [second]。
  final bool showSecond;

  final Widget first;
  final Widget second;

  @override
  Widget build(BuildContext context) {
    return AnimatedSwitcher(
      duration: d.motionPage,
      // 进场 easeOutCubic（快进慢出，像东西"落定"）；退场用同一条，免得两屏节奏打架
      switchInCurve: Curves.easeOutCubic,
      switchOutCurve: Curves.easeOutCubic,
      layoutBuilder: (current, previous) => Stack(
        alignment: Alignment.center,
        children: [
          // ⚠️ 旧屏在**下面**、而且**不许吃点击**（那半秒里点它 = 点到已经走了的东西）
          for (final p in previous) IgnorePointer(child: p),
          if (current != null) current,
        ],
      ),
      transitionBuilder: (child, anim) => FadeTransition(
        opacity: anim,
        child: SlideTransition(
          // ⚠️ 行程很小（0.03 屏高）：这是"上浮"，不是"滑进来" ——
          //    滑进来的话（比如 0.2）用户要**等**它，那就不是丝滑而是慢了。
          position: Tween<Offset>(begin: const Offset(0, 0.03), end: Offset.zero).animate(anim),
          child: child,
        ),
      ),
      child: KeyedSubtree(
        key: ValueKey<bool>(showSecond),
        child: showSecond ? second : first,
      ),
    );
  }
}
