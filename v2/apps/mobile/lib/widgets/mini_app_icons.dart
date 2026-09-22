// **图标名 → 图标**（服务端 `apps.js` 的 `ICONS` 白名单在这一侧的映射）。
//
// ⚠️ 为什么住 `widgets/` 而不是 `models/`：`Icons.*` 在 `material` 里，
//    而 `models` 层**点名不许 import material**（楼层闸 `test/unit/import_rules_test.dart`）。
//    ⇒ 模型层只存**名字**，到这一层才变成图标。
//
// ⚠️ **值必须全是常量**：`flutter build web --release` 会 tree-shake 图标字体，
//    运行时算出来的图标**线上画不出来**（`52-DESKTOP.md` §6.3 记着这个坑）。
//
// ⚠️ **两张表不许漂**：`test/unit/app_spec_test.dart` 会去读服务端那份源码逐字对。

import 'package:flutter/material.dart';

/// 白名单名字 → 图标。**这张表的名字必须与服务端 `ICONS` 一模一样。**
const Map<String, IconData> miniAppIcons = {
  'dice': Icons.casino_outlined,
  'quiz': Icons.edit_note_outlined,
  'list': Icons.checklist_outlined,
  'checklist': Icons.fact_check_outlined,
  'calculator': Icons.calculate_outlined,
  'book': Icons.menu_book_outlined,
  'timer': Icons.timer_outlined,
  'star': Icons.star_outline,
  'paint': Icons.brush_outlined,
  'music': Icons.music_note_outlined,
  'map': Icons.map_outlined,
  'pet': Icons.pets_outlined,
  'wallet': Icons.account_balance_wallet_outlined,
  'leaf': Icons.eco_outlined,
};

/// 认不出来的名字 ⇒ **默认图标**（**不是**把这条藏掉：名字不认识不该让他的东西消失）。
IconData miniAppIconFor(String name) => miniAppIcons[name] ?? Icons.widgets_outlined;
