// **一套外观，只有这一个出处**（契约 `docs/dev/49-STYLE.md`）。
//
// ── 为什么要有它 ──────────────────────────────────────────
// 首页（`landing_screen.dart`）本来就是这套颜色的**事实源头**，但它把六个常量
// **写在自己文件里**（`_paper` / `_accent` / …）⇒ 别的屏想跟着它就得**再抄一遍**。
// 而"同一份数字写两处 = 一定会漂"是这个项目的老毛病（今天已经栽过两次同样的形状）。
//
// 2026-09-22 主人：*"我们现在统一一下页面风格。看看首页，就知道登录页需要改了，
// 配置页也要改。聊天页也要改。"* ⇒ 把首页那套**提上来**当全站的底子。
//
// ── 三条纪律 ──────────────────────────────────────────────
//   ① **数值只住在这里**（颜色、圆角、间距）—— 别处一律 `import` 它；
//   ② ⚠️ **不 import `package:flutter/material.dart`**（楼层闸：`models` 是纯逻辑层）。
//      这里只用 `dart:ui` 的 `Color`（一个纯值类型）——
//      `ThemeData` 是在界面层拼的（`screens/app_theme.dart`）；
//   ③ ⚠️ **不许写死字号**（手册 D3：容器跟字算）：这里只有**形状**，
//      一个 `fontSize` 都不许出现。
//
// ⚠️ 换颜色之前先想一眼**对比度**：正文（`ink`）压在纸底（`paper`）上、
//    主色（`accent`）上的白字 —— 这两对现在是够的。要改就先量一遍。

import 'dart:ui' show Color;

/// 纸底（全站背景）。首页用的就是它。
const Color paper = Color(0xFFF8F5EE);

/// 陶土红（主色：主按钮、强调、"它正在做"那类小标）。
const Color accent = Color(0xFFC8452F);

/// 正文黑（**不是纯黑**：纯黑压在纸底上偏硬）。
const Color ink = Color(0xFF2B2320);

/// 次要灰（说明文字、提示）。
const Color muted = Color(0xFF7A6E66);

/// 卡片白（比纯白暖一点，压在纸底上不刺眼）。
const Color card = Color(0xFFFFFDF9);

/// 描边 / 分隔线（暖灰）。
const Color line = Color(0xFFE8E0D4);

/// 主色上那层"很淡的同色"（用户气泡、选中态这类地方）。
const Color accentTint = Color(0xFFF7E4DF);

/// 圆角（收成三档，别再各写各的）。
const double radiusCard = 18; // 卡片 / 大块

/// **图标格那一圈阴影**（主人 2026-09-22：*"小程序图标要有阴影。"*）。
///
/// 🔴 2026-09-23 提成 token：小程序**打开 / 收回**那一层要**从图标那儿长出来**
///    ⇒ 它的起点必须和图标格**逐字相同**（主人：*"那一层效果没有阴影，所以开启和打开的
///    效果并不如意。"*）。两处各写一份数 ⇒ 迟早漂（本项目第一条纪律）。
const double tileShadowAlpha = 0.12;
const double tileShadowBlur = 12;
const double tileShadowDy = 4;

/// **小程序那一层在"扩开 / 收回"途中的样子**（纯函数，判据在 `test/unit`）。
///
/// @param v 已经过缓动的进度：**0 = 还只有图标那么大，1 = 全屏**
///   （⚠️ 传进来的是**缓动之后**的值 —— 缓动在调用处做，这里只管"形状怎么变"）
/// @returns 圆角、阴影的三个数（α / 模糊 / 下移）
///
/// ⚠️ **v = 0 时必须和 `_DesktopIcon` 那一格一模一样**（圆角 = [radiusCard]，
///    阴影 = [tileShadowAlpha] / [tileShadowBlur] / [tileShadowDy]）——
///    不然"从图标那儿扩开"那一下会**跳**一下。
/// ⚠️ 到全屏（v = 1）**圆角 0、阴影 0**：整页贴着屏幕边，画阴影只是白费。
/// ⚠️ 越界（v < 0 或 > 1）按两端夹住（动画被打断时也画得出一个合理的样子）。
({double radius, double shadowAlpha, double shadowBlur, double shadowDy}) miniAppSurfaceAt(
  double v,
) {
  final k = (1 - v).clamp(0.0, 1.0);
  return (
    radius: radiusCard * k,
    shadowAlpha: tileShadowAlpha * k,
    shadowBlur: tileShadowBlur * k,
    shadowDy: tileShadowDy * k,
  );
}
const double radiusField = 12; // 输入框 / 小卡片
const double radiusChip = 10; // 小方块（首页那种"记 / 办 / 实"）

/// 间距（同样收成三档：别再散着写 10 / 12 / 14）。
const double gapS = 8;
const double gapM = 16;
const double gapL = 24;

/// ── 动效 ────────────────────────────────────────────────────
///
/// **第一屏（首页）⇄ 登录页**的那次切换用多长。
/// ⚠️ 它和手册 `08-SPEC.md` §10.1 阈值总表里那一行是**同一个数**，改就一起改。
/// ⚠️ 为什么要有这一条：主人 2026-09-22 —— *"从首页，点击开始，到登录页显示，
///    我希望是一个**丝滑的过渡**展示效果，而不是**突然出现**的效果。"*
///    ⇒ "硬切"在观感上就是"页面闪了一下"，而**没有动画的界面看起来像坏了**。
///
/// ⚠️ **时长是产品判断，不是随手写的数**：太短看不出过渡（等于硬切），
///    太长会让人觉得"点了没反应"。曲线在界面层给（`Curves`，`models` 不碰 UI 类型）。
///
/// ⚠️ **2026-09-22 主人看过之后把它从 320 加到 400**（原话："过渡时间增加到 400ms"）——
///    这是**他的观感判断**，不是我们算出来的 ⇒ 别"顺手调回去"。
const Duration motionPage = Duration(milliseconds: 400);
