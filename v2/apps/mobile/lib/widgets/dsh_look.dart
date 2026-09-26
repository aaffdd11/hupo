// **DSH 那一套设计 token → Flutter 的那一小层换算**（契约 `docs/dev/118-TRAJECTORY-VIEW.md`）。
//
// 为什么单独一份：`models/dsh_design.dart` 是纯逻辑层（不 import `material`），
// 所以"字号 + 绝对行高 → `TextStyle`"这种事只能住在 `widgets/` 这一层。
// 而它**每一个用 token 的控件都要**（工具行、轨迹表、那两个 tab）——
// 各写一份就是三份会漂的换算（本项目第一条纪律：同一份数字不许有两处）。
//
// ⚠️ 这里**一个写死的数都没有**：字号/字重/行高/颜色全部从 `models/dsh_design.dart`
//    来（`design_tokens_test.dart` 那条棘轮盯着新文件的上限是 0 处）。
// ⚠️ **不碰 `textScaler`**：缩放由 `Text` 自己按 `MediaQuery` 施加
//    （D3.5 那条"不封顶"就是靠它 —— 在这里夹一刀就把那个设置废了）。

import 'package:flutter/material.dart';

import '../models/dsh_design.dart';

/// DSH 的字重只有 400/500/600/700。
FontWeight dshWeightOf(int w) => switch (w) {
  500 => FontWeight.w500,
  600 => FontWeight.w600,
  700 => FontWeight.w700,
  _ => FontWeight.w400,
};

/// 把 DSH 的"字号 + 绝对行高"翻成 Flutter 的 `TextStyle`
/// （`height` 是**倍数**，所以要 `lineHeight / size`）。
TextStyle dshTextStyle(DshType t, Color color, {String? family}) => TextStyle(
  fontFamily: family,
  fontFamilyFallback: family == null ? null : const ['Menlo', 'Consolas', 'monospace'],
  fontSize: t.size,
  height: t.lineHeight / t.size,
  fontWeight: dshWeightOf(t.weight),
  color: color,
);

/// DSH 的代码字体栈（真包 `--dsh-font-mono`；平台没有就退回系统等宽）。
const String dshMonoFamily = 'monospace';

/// 一屏的色板 + 用户字号轴（一处算好，往下传）。
class DshLook {
  const DshLook(this.palette, this.scale);

  final DshPalette palette;
  final DshContentScale scale;

  /// 亮/暗跟着 `Theme` 走（今天全站只有亮色，但别把"暗色 = 另一套色板"这件事写死错）。
  static DshLook of(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    // ⚠️ 字号设置（`115` 丙-8）**还没接**⇒ 走默认档。
    //    入口已经留好：接了设置之后只需把 `null` 换成读出来的那个值。
    return DshLook(dshPaletteFor(dark: dark), dshContentScale(null));
  }

  /// 正文那一档（DSH `markdown-base`：400 `14+Δ` / `24+Δ`）。
  DshType get content => scale.content;

  /// 抬头下面那行小字（DSH 二级台阶 13/20）。
  DshType get caption => scale.secondaryAt(DshTypes.xs);

  /// 展开后那块正文（DSH 代码块小阶 11/16 —— 我们**没有 11px 这个 token**，
  /// 用二级台阶代替；差的那一档等真的需要时再进 `dsh_design.dart`）。
  DshType get mono => scale.secondaryAt(DshTypes.xs);
}
