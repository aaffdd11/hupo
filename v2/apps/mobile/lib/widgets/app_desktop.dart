// **桌面** —— **铺满整屏**的那一层（聊天浮窗**后面**那一层）。
//
// ── 形状是谁定的（两次才说清，都记下来）──────────────────
// 主人 2026-09-22 第一句：*"首先，页面底部是一个桌面。聊天窗口是一个左右上下 margin 为 30 的浮窗，有阴影。"*
// 我把它读成了"桌面=屏幕最下面那一条"（并且问过他，他当时也选了那一条）——
// **但那是读错了**。他看了真站点之后更正：*"桌面是全屏的，聊天窗口是在底部的。"*
// ⇒ 正确的形状：**桌面铺满整屏**（它是底图），**聊天浮窗贴在屏幕底部**浮着、四边各 30。
// ⇒ 契约 `docs/dev/52-DESKTOP.md`，手册 `08-SPEC.md` §六 Z4。
//
// ⚠️ **教训（值得留着）**：用户说"底部"时，可能是说**浮窗的位置**，也可能是说**桌面的位置** ——
//    这两个都合理，而选中错的那个，代价是一整套布局返工。
//    下一回遇到"底部/上面"这种词，**先让他看一眼两种摆法的截图**再动手。
//
// 手册里另外三件，这个文件是它们的落点：
//   · **D4.11 手机上第一入口 = 图标墙**（登录之后先看见的是它）；
//   · **一个作用域 = 一个工作区 = 一条会话 = 一个目录 = 桌面上一个图标**（1:1:1:1）；
//   · **点桌面空白 = 收起聊天浮窗**（`08-SPEC.md` §六 交互表）。
//
// ⚠️ 桌面上**只放"真能打开的"**（主人选：先只有「会话」一个）。
//    摆一个"点了没反应"的方块，是这个项目最忌的形状（"看着像有、其实是空的"）。
//
// ⚠️ **不用 `GestureDetector`**：`accessibility_test.dart` 有一条**源码级禁令**，
//    用它就等于让"命中区 ≥44"那份扫描多一个没人检查的缺口。点空白用 `InkWell`。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;

/// **小程序没给图标时用的那个**（主人 2026-09-22：*"设置要给一个默认 icon"*）。
///
/// ⚠️ 它必须是一个**写在代码里的常量**：`flutter build web` 默认会 tree-shake 图标字体，
///    只有**常量**才会被收进那份子集字体；运行时算出来的 `IconData` 会在线上**画不出来**
///    （而测试里是好的 —— 测试不 tree-shake）。⇒ 默认值放这里，别在调用处现造。
const IconData defaultAppIcon = Icons.widgets_outlined;

/// 桌面上一个图标。
///
/// ⚠️ `label` **必须给人看**（D3.8：不许只有一个无字图形）。
class DesktopApp {
  const DesktopApp({
    required this.label,
    required this.onOpen,
    this.icon = defaultAppIcon,
    this.badge = 0,
  });

  final String label;
  final IconData icon;

  /// **打开**。参数 = **这个图标在屏幕上的位置**（"从哪里打开，就从哪里扩开"）。
  /// ⚠️ 由图标自己量、自己报 —— 上层不用去猜它在哪儿（猜的话换个排布就错了）。
  final ValueChanged<Rect?> onOpen;

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
    this.header,
    this.columns = 4,
  });

  final List<DesktopApp> apps;

  /// **点空白**（不是点图标）⇒ 上层拿它收起聊天浮窗。
  final VoidCallback onTapBlank;

  /// 顶上一行（不参与点击 —— 它也是"点空白"的安全区）。
  final Widget? header;

  /// 一屏放几列。
  final int columns;

  @override
  Widget build(BuildContext context) {
    // ⚠️ 宽度从 `MediaQuery` 来（它在 `Stack` 里是 `Positioned.fill` ⇒ 就是屏宽）
    final w = MediaQuery.sizeOf(context).width;
    final spacing = d.gapL - 4;
    // 🔴 **列宽要封顶**：宽屏上按 4 列算会得到 293px 一格（实测过），
    //    而图标本该是**一个小方块**、列宽只决定它在哪儿 ⇒ 两端都夹住：
    //    下限 = 图标格 + 一点余量（不然字挤成一列），上限 = 一个"图标格"该有的宽度。
    final raw = (w - d.gapL * 2 - spacing * (columns - 1)) / columns;
    final tileWidth = raw.clamp(desktopIconBox + 10, 88.0);
    return Material(
      color: d.paper,
      child: InkWell(
        // ⚠️ 点空白 = 收起聊天（§六 交互表）。splash 关掉：整屏闪一下不是反馈，是噪声。
        onTap: onTapBlank,
        splashColor: Colors.transparent,
        highlightColor: Colors.transparent,
        child: SafeArea(
          bottom: false, // 浮窗贴底 ⇒ 下面那条安全区由浮窗自己管
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (header != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    d.gapL,
                    d.gapM,
                    d.gapL,
                    d.gapS,
                  ),
                  child: header,
                ),
              Expanded(
                // ⚠️ 图标多了要能滚（窄屏 + 大字号下这一条是唯一稳的摆法）
                child: SingleChildScrollView(
                  // ★ 主人 2026-09-22：*"桌面排布好一点，我看小程序图标顶部 Margin 可以增加一些。"*
                  //   ⇒ 顶部留白从 8 提到 **48**（`gapL * 2`），横向仍是 24，图标之间给足间距。
                  padding: EdgeInsets.fromLTRB(
                    d.gapL,
                    d.gapL * 2,
                    d.gapL,
                    d.gapL,
                  ),
                  child: Wrap(
                    spacing: spacing,
                    runSpacing: d.gapL,
                    children: [
                      for (final a in apps)
                        _DesktopIcon(app: a, width: tileWidth),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _DesktopIcon extends StatelessWidget {
  const _DesktopIcon({required this.app, required this.width});

  final DesktopApp app;
  final double width;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    // 🔴 **图标 + 它下面那行字，一起可点**（2026-09-22 实测抓到的）：
    //    第一版把 `InkWell` 只包在图标格上，**字在外面** ⇒ 点字落到了"点桌面空白"上
    //    （于是"点设置"变成"收起聊天"，而且判据还照样绿 —— 扫的是桌面，不是设置那一屏）。
    //    ⚠️ 字才是人第一眼看到的靶子，它必须能点。
    return SizedBox(
      width: width,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: () {
            // ★ **"从哪里打开"**：把图标此刻在屏幕上的矩形报上去
            final box = context.findRenderObject() as RenderBox?;
            final rect = (box != null && box.hasSize)
                ? box.localToGlobal(Offset.zero) & box.size
                : null;
            app.onOpen(rect);
          },
          borderRadius: BorderRadius.circular(d.radiusCard),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              // 图标格：**永远是那个小方块**（`desktopIconBox`，≥44 见 D3.6）
              Container(
                width: desktopIconBox,
                height: desktopIconBox,
                decoration: BoxDecoration(
                  color: d.card,
                  borderRadius: BorderRadius.circular(d.radiusCard),
                  // ★ 主人 2026-09-22：*"小程序图标要有阴影。"*
                  //   浅一点（图标是一小块，用浮窗那种 α.45 会脏）
                  // ⚠️ 这三个数**住 `design.dart`**（`tileShadow*`）：小程序扩开那一层
                  //    的**起点就是它**，两处必须是同一份（主人 2026-09-23 报的"没有阴影"）。
                  boxShadow: [
                    BoxShadow(
                      color: d.ink.withValues(alpha: d.tileShadowAlpha),
                      blurRadius: d.tileShadowBlur,
                      offset: const Offset(0, d.tileShadowDy),
                    ),
                  ],
                ),
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
                          decoration: const BoxDecoration(
                            color: d.accent,
                            shape: BoxShape.circle,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 6),
              // ⚠️ **带字的**（D3.8：图标不许只有图形）
              Text(
                app.label,
                style: t.textTheme.bodySmall?.copyWith(color: d.ink),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
