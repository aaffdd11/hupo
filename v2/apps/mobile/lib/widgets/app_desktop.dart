// **桌面** —— 屏幕**最下面那一条**（主人 2026-09-22 定的形状 B）。
//
// ── 为什么是"一条"而不是"整页底图" ────────────────────────
// 手册原来写的是"图标墙 = 浮窗后面那一层"（Z1–Z3）。主人看过之后改了：
// **桌面摆在底部一条**，聊天浮窗在它**上面**浮着、四边各留 30。
// 理由是他那句话本身：默认收起时，"底部是桌面"要**一眼看得见**
// （整页底图 + 最大化浮窗 ⇒ 你只看得到 30px 的一圈边）。
// ⇒ 契约 `docs/dev/52-DESKTOP.md`，手册 `08-SPEC.md` §六 Z4 + 阈值总表。
//
// 手册里另外三件，这个文件是它们的落点：
//   · **D4.11 手机上第一入口 = 图标墙**（桌面就是那个"墙"，只是排在底部）；
//   · **一个作用域 = 一个工作区 = 一条会话 = 一个目录 = 桌面上一个图标**（1:1:1:1）；
//   · **点桌面空白 = 收起聊天浮窗**（`08-SPEC.md` §六 交互表）。
//
// ⚠️ 桌面上**只放"真能打开的"**（主人选：先只有「会话」一个）。
//    摆一个"点了没反应"的方块，是这个项目最忌的形状（"看着像有、其实是空的"）。
//
// ⚠️ **不用 `GestureDetector`**：`accessibility_test.dart` 有一条**源码级禁令**，
//    用它就等于让"命中区 ≥44"那份扫描多一个没人检查的缺口。点空白用 `InkWell`。
//
// ⚠️ **高度由内容算**（D3.5）：图标格 + 一行带字的标签 + 间距。
//    大字号下这一条会**变高**，而浮窗拿的是**剩下的高度**
//    ——父层是 `Column`，不是"屏高减去一个写死的数"。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;

/// 桌面上一个图标。
///
/// ⚠️ `label` **必须给人看**（D3.8：不许只有一个无字图形）。
class DesktopApp {
  const DesktopApp({
    required this.label,
    required this.icon,
    required this.onOpen,
    this.badge = 0,
  });

  final String label;
  final IconData icon;
  final VoidCallback onOpen;

  /// 未读小点（`02-ARCHITECTURE.md`：**动作可静默，事实不能静默**）。
  /// `0` = 不画。⚠️ 现在还没有人给它赋值 —— 等真有"未读"这件事时再接。
  final int badge;
}

/// 图标格边长：**≥44** 是 D3.6 的硬要求，这里给得更宽一点（手指好按）。
const double desktopIconBox = 52;

class AppDesktop extends StatelessWidget {
  const AppDesktop({
    super.key,
    required this.apps,
    required this.onTapBlank,
  });

  final List<DesktopApp> apps;

  /// **点空白**（不是点图标）⇒ 上层拿它收起聊天浮窗。
  final VoidCallback onTapBlank;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Material(
      color: d.paper,
      child: InkWell(
        // ⚠️ 点空白 = 收起聊天（§六 交互表）。splash 关掉：整屏闪一下不是反馈，是噪声。
        onTap: onTapBlank,
        splashColor: Colors.transparent,
        highlightColor: Colors.transparent,
        child: Container(
          // 一条上边线：让它读起来是"桌面"这一层，而不是聊天页的页脚
          decoration: BoxDecoration(border: Border(top: BorderSide(color: d.line))),
          padding: const EdgeInsets.symmetric(horizontal: d.gapM, vertical: d.gapS),
          child: SafeArea(
            top: false,
            // ⚠️ 图标多了**横向滚**（不折行、不挤扁）——这条在窄屏 + 大字号下是唯一稳的摆法
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final a in apps)
                    Padding(
                      padding: const EdgeInsets.only(right: d.gapM),
                      child: _DesktopIcon(app: a, theme: t),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _DesktopIcon extends StatelessWidget {
  const _DesktopIcon({required this.app, required this.theme});

  final DesktopApp app;
  final ThemeData theme;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Material(
          color: d.card,
          borderRadius: BorderRadius.circular(d.radiusField),
          child: InkWell(
            onTap: app.onOpen,
            borderRadius: BorderRadius.circular(d.radiusField),
            child: SizedBox(
              width: desktopIconBox,
              height: desktopIconBox,
              child: Stack(
                children: [
                  Center(child: Icon(app.icon, color: d.ink)),
                  if (app.badge > 0)
                    Positioned(
                      top: d.gapS,
                      right: d.gapS,
                      child: Container(
                        width: 10,
                        height: 10,
                        decoration: const BoxDecoration(color: d.accent, shape: BoxShape.circle),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(height: 4),
        // ⚠️ **带字的**（D3.8：图标不许只有图形，收起态也不许）
        Text(
          app.label,
          style: theme.textTheme.bodySmall?.copyWith(color: d.ink),
          textAlign: TextAlign.center,
        ),
      ],
    );
  }
}
