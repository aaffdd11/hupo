// 应用桌面：主页面。
//
// 它同时是聊天浮窗**后面那一层** —— 所以：
//   · 点桌面的空白处 = 点浮窗外面 = 收起聊天（这个手势由 ChatScreen 接）
//   · 点图标 = 打开这个应用（整块盖上来，像打开一个 APP）
//
// 刻意不用 ListView：桌面上应该是"图标墙"，而且浮窗里的消息列表
// 才是页面上唯一一个 ListView（测试靠它取聊天列表）。

import 'package:flutter/material.dart';

import '../apps/mini_app.dart';

class AppDesktop extends StatelessWidget {
  const AppDesktop({
    super.key,
    required this.apps,
    required this.onOpen,
    this.status,
  });

  final List<MiniApp> apps;
  final ValueChanged<MiniApp> onOpen;

  /// 左上角那行小字（开发者模式下显示"正在：xxx"，平时为空）。
  final String? status;

  /// 一屏放几个图标。
  static const int _columns = 4;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return DecoratedBox(
      key: const Key('app-desktop'),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [
            theme.colorScheme.surface,
            theme.colorScheme.surfaceContainerLowest,
          ],
        ),
      ),
      child: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // ── 顶栏：桌面自己的名字 + 开发状态 ────────────────
            //
            // 这一条也顺手当了"点空白处收起聊天"的安全区：最上面这一行
            // 没有任何可点的东西，点它必定落到桌面背景上。
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 14, 20, 6),
              child: Row(
                children: [
                  Container(
                    width: 8,
                    height: 8,
                    decoration: BoxDecoration(
                      color: theme.colorScheme.primary,
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    'Hupo',
                    style: theme.textTheme.labelLarge?.copyWith(
                      color: theme.hintColor,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 0.4,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      status ?? '',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.primary,
                      ),
                    ),
                  ),
                ],
              ),
            ),

            // ── 图标墙 ──────────────────────────────────────
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(12, 10, 12, 24),
                child: Wrap(
                  alignment: WrapAlignment.start,
                  runSpacing: 6,
                  children: [
                    for (final app in apps)
                      SizedBox(
                        width: _tileWidth(context),
                        child: _AppIcon(app: app, onTap: () => onOpen(app)),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 一行放 [_columns] 个，宽度按屏宽算。
  static double _tileWidth(BuildContext context) {
    final w = MediaQuery.sizeOf(context).width;
    return (w - 24) / _columns;
  }
}

/// 桌面上的一个图标。
class _AppIcon extends StatelessWidget {
  const _AppIcon({required this.app, required this.onTap});

  final MiniApp app;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      key: Key('app-icon-${app.id}'),
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 4),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // 图标本体：圆角方块 + 一点内高光，像真的应用图标
            Container(
              width: 52,
              height: 52,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(15),
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [
                    Color.alphaBlend(app.color.withValues(alpha: 0.85), theme.colorScheme.surface),
                    Color.alphaBlend(app.color.withValues(alpha: 0.45), theme.colorScheme.surface),
                  ],
                ),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.35),
                    blurRadius: 10,
                    offset: const Offset(0, 3),
                  ),
                ],
              ),
              child: Icon(app.icon, size: 24, color: Colors.white),
            ),
            const SizedBox(height: 6),
            Text(
              app.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodySmall?.copyWith(fontSize: 11),
            ),
          ],
        ),
      ),
    );
  }
}
