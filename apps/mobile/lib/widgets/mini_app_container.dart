// 小程序容器：打开一个应用之后看到的那一层"壳"。
//
// 参考小程序的容器化做法：
//   · 顶栏由**容器**给（返回 / 标题 / 胶囊按钮），应用自己不管标题栏
//   · 应用内容跑在容器**自己的 Navigator 里** —— 所以应用内部怎么跳转
//     都跑不出这个容器，这就是"每个 app 都是一个独立的站点"
//   · 打开有动画（淡入 + 轻微放大），关掉就整块没了，不留残影

import 'package:flutter/material.dart';

import '../apps/mini_app.dart';

class MiniAppContainer extends StatefulWidget {
  const MiniAppContainer({
    super.key,
    required this.app,
    required this.onClose,
  });

  final MiniApp app;

  /// 退出这个应用（不关掉开发者模式那种语义 —— 那个由应用自己在内容里做）。
  final VoidCallback onClose;

  @override
  State<MiniAppContainer> createState() => _MiniAppContainerState();
}

class _MiniAppContainerState extends State<MiniAppContainer> {
  /// 应用私有的返回栈。应用内部用 Navigator.of(context).push 就会落在这里。
  final _navKey = GlobalKey<NavigatorState>();

  void _back() {
    final nav = _navKey.currentState;
    if (nav != null && nav.canPop()) {
      nav.pop();
      return;
    }
    widget.onClose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Material(
      key: const Key('mini-app-page'),
      color: theme.colorScheme.surface,
      child: TweenAnimationBuilder<double>(
        tween: Tween<double>(begin: 0, end: 1),
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOutCubic,
        builder: (context, t, child) => Opacity(
          opacity: t,
          child: Transform.scale(scale: 0.97 + 0.03 * t, child: child),
        ),
        child: Column(
          children: [
            _MiniAppBar(
              title: widget.app.name,
              color: widget.app.color,
              icon: widget.app.icon,
              closeTooltip: widget.app.closeTooltip,
              onBack: _back,
              onClose: widget.onClose,
            ),
            Expanded(
              child: Navigator(
                key: _navKey,
                onGenerateRoute: (settings) => MaterialPageRoute<void>(
                  settings: settings,
                  builder: (context) => widget.app.build(context),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 容器的顶栏：返回 + 图标 + 标题 + 胶囊（关闭）。
class _MiniAppBar extends StatelessWidget {
  const _MiniAppBar({
    required this.title,
    required this.color,
    required this.icon,
    required this.closeTooltip,
    required this.onBack,
    required this.onClose,
  });

  final String title;
  final Color color;
  final IconData icon;
  final String closeTooltip;
  final VoidCallback onBack;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Material(
      color: theme.colorScheme.surfaceContainerLow,
      child: SafeArea(
        bottom: false,
        child: SizedBox(
          height: 52,
          child: Row(
            children: [
              const SizedBox(width: 4),
              IconButton(
                key: const Key('mini-app-back'),
                tooltip: '返回',
                iconSize: 20,
                icon: const Icon(Icons.arrow_back_ios_new),
                onPressed: onBack,
              ),
              Container(
                width: 26,
                height: 26,
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.18),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(icon, size: 15, color: color),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
                ),
              ),
              // 小程序那种"胶囊"：一个圆角框里装着操作
              Container(
                margin: const EdgeInsets.only(right: 10),
                decoration: BoxDecoration(
                  color: theme.colorScheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(16),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    IconButton(
                      key: const Key('mini-app-close'),
                      tooltip: closeTooltip,
                      iconSize: 17,
                      visualDensity: VisualDensity.compact,
                      icon: const Icon(Icons.close),
                      onPressed: onClose,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
