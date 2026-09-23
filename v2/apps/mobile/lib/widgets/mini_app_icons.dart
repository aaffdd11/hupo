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
  // ── 2026-09-23 扩的（主人：*"做一个 icon 库，给每个小程序创造一个默认 icon"*）──
  // ⚠️ **每一个都必须是常量**（`flutter build web --release` 会 tree-shake 图标字体，
  //    运行时算出来的图标**线上画不出来** —— `52-DESKTOP.md` §6.3 记着这个坑）。
  'weather': Icons.wb_sunny_outlined,
  'calendar': Icons.calendar_month_outlined,
  'note': Icons.sticky_note_2_outlined,
  'photo': Icons.photo_outlined,
  'phone': Icons.phone_outlined,
  'message': Icons.chat_bubble_outline,
  'mail': Icons.mail_outline,
  'heart': Icons.favorite_border,
  'health': Icons.health_and_safety_outlined,
  'pill': Icons.medication_outlined,
  'food': Icons.restaurant_outlined,
  'recipe': Icons.restaurant_menu_outlined,
  'shopping': Icons.shopping_cart_outlined,
  'money': Icons.payments_outlined,
  'bank': Icons.account_balance_outlined,
  'chart': Icons.insert_chart_outlined,
  'search': Icons.search,
  'translate': Icons.translate,
  'news': Icons.article_outlined,
  'video': Icons.movie_outlined,
  'game': Icons.sports_esports_outlined,
  'sport': Icons.directions_run_outlined,
  'car': Icons.directions_car_outlined,
  'train': Icons.train_outlined,
  'plane': Icons.flight_outlined,
  'home': Icons.home_outlined,
  'key': Icons.key_outlined,
  'bell': Icons.notifications_outlined,
  'gift': Icons.card_giftcard_outlined,
  'school': Icons.school_outlined,
  'tools': Icons.handyman_outlined,
  'flower': Icons.local_florist_outlined,
  'baby': Icons.child_care_outlined,
  'doctor': Icons.medical_services_outlined,
  'coffee': Icons.local_cafe_outlined,
  'swim': Icons.pool_outlined,
  'bike': Icons.directions_bike_outlined,
  'document': Icons.description_outlined,
  'group': Icons.groups_outlined,
  'clock': Icons.schedule_outlined,
};

/// 认不出来的名字 ⇒ **默认图标**（**不是**把这条藏掉：名字不认识不该让他的东西消失）。
IconData miniAppIconFor(String name) => miniAppIcons[name] ?? Icons.widgets_outlined;
