// **把 `models/design.dart` 那套拼成 `ThemeData`**（契约 `docs/dev/49-STYLE.md`）。
//
// ⚠️ 为什么单独一个文件、而且住在 `screens/`：**拼主题要用 material**，
//    而 `models` 那一层不许 import 它（楼层闸）。放在这一层，谁都 import 得到
//    （`screens` 是装配层），而**数值仍然只有 `models/design.dart` 一处**。
//
// 🔴 **四屏统一靠的就是这一个函数**：实测全站只有一处硬编码颜色
//    （`widgets/notice.dart` 的 `Colors.transparent`），其余**全走 `colorScheme`**
//    ⇒ 把这里拼对，首页/登录页/配置页/聊天页**一起跟着变**。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;

/// 由 design tokens 拼出来的主题。**只有这一个出处**。
ThemeData buildAppTheme() {
  // ⚠️ `fromSeed` 会给出一整套**调和过**的色阶（避免我手挑每个 container 时挑花），
  //    再把关键几个角色**按 design 覆盖**成首页那套（背景/表面/正文/次要/描边）。
  final scheme = ColorScheme.fromSeed(
    seedColor: d.accent,
    brightness: Brightness.light,
  ).copyWith(
    primary: d.accent,
    onPrimary: Colors.white,
    secondary: d.accent,
    surface: d.card,
    onSurface: d.ink,
    onSurfaceVariant: d.muted,
    outline: d.line,
    outlineVariant: d.line,
    surfaceContainerLowest: d.paper,
    surfaceContainerLow: d.paper,
    surfaceContainer: d.card,
    surfaceContainerHigh: d.card,
    surfaceContainerHighest: d.card,
    // ⚠️ 用户气泡那一类"很淡的强调"用 `accentTint`（首页那种暖，不是蓝）
    primaryContainer: d.accentTint,
    onPrimaryContainer: d.ink,
  );

  final base = ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: d.paper,
    // ⚠️ 不写死字号（D3）：字号仍然跟着系统走，这里只说**字重与颜色**。
    textTheme: Typography.material2021().black.apply(bodyColor: d.ink, displayColor: d.ink),
  );

  return base.copyWith(
    appBarTheme: AppBarTheme(
      backgroundColor: d.paper,
      foregroundColor: d.ink,
      surfaceTintColor: Colors.transparent,
      // ⚠️ 全站**一条没有阴影的顶栏**（首页没有顶栏、靠底色连着读者往下看）
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: base.textTheme.titleLarge?.copyWith(
        color: d.ink,
        fontWeight: FontWeight.w600,
      ),
    ),
    dividerTheme: DividerThemeData(color: d.line, thickness: 1, space: d.gapL),
    // 按钮统一**胶囊形**（首页那两个就是）：主按钮实心陶土红、次按钮描边。
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: d.accent,
        foregroundColor: Colors.white,
        shape: const StadiumBorder(),
        padding: const EdgeInsets.symmetric(horizontal: d.gapL, vertical: 12),
        // 命中区下限（D3.6：视觉可以小，命中区不许小）
        minimumSize: const Size(48, 48),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: d.ink,
        side: BorderSide(color: d.line),
        backgroundColor: d.card,
        shape: const StadiumBorder(),
        padding: const EdgeInsets.symmetric(horizontal: d.gapL, vertical: 12),
        minimumSize: const Size(48, 48),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: d.muted,
        minimumSize: const Size(48, 44),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: d.card,
      labelStyle: TextStyle(color: d.muted),
      hintStyle: TextStyle(color: d.muted),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(d.radiusField),
        borderSide: BorderSide(color: d.line),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(d.radiusField),
        borderSide: BorderSide(color: d.line),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(d.radiusField),
        borderSide: BorderSide(color: d.accent, width: 2),
      ),
    ),
    // 卡片 / 弹层 / 底部面板：**白卡 + 大圆角**（首页那种）
    cardTheme: CardThemeData(
      color: d.card,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(d.radiusCard),
        side: BorderSide(color: d.line),
      ),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: d.card,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(d.radiusCard)),
      titleTextStyle: base.textTheme.titleLarge?.copyWith(color: d.ink, fontWeight: FontWeight.w600),
      contentTextStyle: base.textTheme.bodyMedium?.copyWith(color: d.ink),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: d.card,
      surfaceTintColor: Colors.transparent,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(d.gapL)),
      ),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: d.ink,
      contentTextStyle: TextStyle(color: d.card),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(d.radiusField)),
    ),
    listTileTheme: ListTileThemeData(iconColor: d.muted, textColor: d.ink),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: d.accent),
  );
}
