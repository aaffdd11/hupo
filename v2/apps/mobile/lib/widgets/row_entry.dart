// **行级入口**（D3.6 的"行级那一档"）。
//
// 主人 2026-10-03：*"聊天窗口中，那个右边点一下展开的箭头，行高明显占用太大了，
// 看看他对应的那段文字的行高，这个箭头要重新设计。"*
//
// ── 为什么要单立一个控件（而不是各自把 IconButton 改小）──────────────
// 那些行的文字是 **11 号 / 行高 14**（`DshTypes.chatQuiet`），而右边那颗箭头为了过
// D3.6 的"命中区 ≥44"被撑成 **44×44** ⇒ **整行 50 高**（44 ＋ 上下各 3 的 padding）：
// 屏幕上就是"一行小字漂在一大片空白里"。
//
// 🔴 **D3.6 现在分两档**（手册同日改，见 `05-DECISIONS.md` 的 D3.6）：
//   · **点状控件**（按钮 / 图标）：命中区 **≥44×44**，一个都不能少；
//   · **行级入口**（整行都能点的那种）：按**面积**算 —— 整行宽 × 行高 **≥ 44×44（1936）**，
//     而且**宽度 ≥44**；行高跟着那行文字走，**不为了凑 44 把行撑高**。
//   ⇒ 理由是"哪个更好按"而不是"哪个更好看"：一行 300×20 的可点面积是 6000 px²，
//     比 44×44（1936）**大两倍多**，而手指要够的地方从"一颗小图标"变成**整行**。
//   ⚠️ 代价写在这里、不藏：它**不再是"处处 44 高"**；换来的是一行 50 → ~20。
//
// ── 实现约束 ────────────────────────────────────────────────
//   · 用 `InkWell`（Material 的水波）：**不用 `GestureDetector`**——那是源码级禁令；
//   · 语意上它是**一个按钮**（`Semantics(button: true)`），悬停/读屏那句走 `Tooltip`；
//   · 那两颗箭头（左右各一种用法）只是**指示**：18 的图形，**不是按钮**，
//     所以它们不进 D3.6 的点状那一档（也就不会再把行撑高）。

import 'package:flutter/material.dart';

import '../models/dsh_design.dart';

/// 一行都能点的那种入口（见文件头）。**整行**都是它的命中区。
class DshRowEntry extends StatelessWidget {
  const DshRowEntry({
    super.key,
    required this.onTap,
    required this.child,
    this.tooltip,
    this.label,
    this.padding = const EdgeInsets.symmetric(
      vertical: DshChatSpace.rowPadV,
      horizontal: DshSpace.s8,
    ),
  });

  /// 点整行的哪一处都走它（展开 / 收起）。
  final VoidCallback onTap;

  /// 这一行里画什么（含那颗**只是指示**的箭头）。
  final Widget child;

  /// 悬停那一句（web 上看得见）—— 它同时充当无障碍名（没给 [label] 时）。
  final String? tooltip;

  /// 无障碍名（不给就用 [tooltip]）。
  final String? label;

  /// 里面那一圈（默认：上下 `rowPadV`、左右 `s8` —— 与原来那些行一致）。
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    Widget w = InkWell(
      onTap: onTap,
      child: Padding(padding: padding, child: child),
    );
    final tip = tooltip;
    if (tip != null) w = Tooltip(message: tip, child: w);
    return Semantics(button: true, label: label ?? tip, child: w);
  }
}
