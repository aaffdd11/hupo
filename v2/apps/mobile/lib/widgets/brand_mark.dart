// **标志（那个小红方块 + 名字）** —— 首页与登录页**共用一个实现**
// （契约 `docs/dev/49-STYLE.md`）。
//
// ⚠️ 为什么要抽出来：登录页原来只有一句居中的「助手」，而首页是
//    「小红方块 + 琥珀」+ 一句红色小标 + 大标题。两屏摆在一起**不像一个产品** ——
//    主人 2026-09-22 说的"统一一下页面风格"就是这个。
//    抽出来之后：**改标志只改这一处**（两屏同时变）。
//
// ⚠️ 文案从 `landing_words.dart` 拿（界面用的字不许在这儿现编）。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/landing_words.dart';

class BrandMark extends StatelessWidget {
  const BrandMark({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          // ⚠️ 这是**标志**（图形），尺寸固定；里面的字用 `labelLarge`（跟着系统走）——
          //    和首页原来那套**一模一样**，一个字号的数值都没新写。
          width: 30,
          height: 30,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: d.accent,
            borderRadius: BorderRadius.circular(d.radiusChip - 1),
          ),
          child: Text(
            landingBrand.substring(0, 1),
            style: theme.textTheme.labelLarge?.copyWith(color: Colors.white),
          ),
        ),
        SizedBox(width: d.gapS + 2),
        Text(
          landingBrand,
          style: theme.textTheme.titleMedium?.copyWith(
            color: d.ink,
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    );
  }
}
