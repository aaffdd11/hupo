// **首页那个 header** —— 首页与登录页**共用一份**（契约 `docs/dev/49-STYLE.md`）。
//
// 主人 2026-09-22：*"登录页应该能回到首页。所以首页那个 header 也留在登录页吧。"*
//   ⇒ ① 登录页顶上**就是首页那个 header**（标志 + 红小标 + 那句大标题）；
//     ② 登录页多一个**返回箭头**（回首页）。
//
// ⚠️ 为什么抽出来而不是抄一份：这一块原来只长在首页里 ⇒ 登录页想"留同一个 header"
//    就只能**再抄一遍**，而抄的那一份**一定会漂**（这个项目今天已经栽过两次同款）。
//
// ⚠️ **不写死字号**（D3.5）：这里只给颜色、字重、行高；字号仍然跟着系统走。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/landing_words.dart';
import 'brand_mark.dart';

class LandingHeader extends StatelessWidget {
  const LandingHeader({super.key, this.onBack, this.backTooltip});

  /// 给了就画一个**返回箭头**（登录页用它回首页）；不给就是首页那个样子。
  final VoidCallback? onBack;

  /// 箭头的 tooltip（读屏用）。⚠️ 文案由调用方给（词表那一层管着界面用词）。
  final String? backTooltip;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            // ⚠️ 箭头放在**标志那一行**里（不是在顶上再加一条 AppBar）——
            //    这样登录页的 header 与首页**结构完全一样**，只多一个箭头。
            if (onBack != null)
              IconButton(
                onPressed: onBack,
                tooltip: backTooltip,
                icon: const Icon(Icons.arrow_back),
                color: d.ink,
              ),
            const BrandMark(),
          ],
        ),
        const SizedBox(height: d.gapL - 2),
        Text(
          landingKicker,
          style: theme.textTheme.labelLarge?.copyWith(
            color: d.accent,
            letterSpacing: 1.2,
          ),
        ),
        const SizedBox(height: 10),
        Text(
          landingPromise,
          style: theme.textTheme.headlineMedium?.copyWith(
            color: d.ink,
            height: 1.3,
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    );
  }
}
