// **小程序容器**（手册 `08-SPEC.md` §6.4「小程序 × 聊天共存」 · Z1–Z4）。
//
// ── 它是什么 ─────────────────────────────────────────────
// 桌面上的一个图标点开 = **在这个容器里跑一个"小程序"**。
// 现在桌上只有**设置**一个（主人 2026-09-22：*"桌面上应当有一个设置的小程序，
// 用来退出登录，注销账号，修改 apikey。"*）。
//
// 🔴 **聊天不是小程序**（主人同一天说清的）：*"聊天和桌面是独立的，聊天是永续的，
// 永远在底下。所以聊天不是桌面上的一个小程序。"* ⇒ 聊天浮窗**不住在这个容器里**，
// 它永远在最上面那一层（Z1）；这个容器是被它**盖住**的那一个。
//
// ── 手册 §6.4 那五条，这一版落了哪几条 ─────────────────────
//   ✅ 1 **收起时不许压住小程序里可点的东西**：内容底部**内缩**（`bottomInset`），
//        不是简单覆盖 —— 否则最后一行**永远点不到**（这是上一代真栽过的）。
//   ✅ 2 **展开时被盖住，而且要看得出来**：压暗 + 轻微缩小 + 圆角加大。
//   ✅ 3 **被盖住期间点可见区域 = 收起聊天**，而且**不把这次点击传给小程序**
//        （用户的意图是"回到小程序"，不是"点某个按钮"）⇒ `IgnorePointer` + 一层吸收层。
//   ✅ 4 **被盖住期间照常运行**（不许 pause）：它一直在树上，只是被盖住。
//   ✅ 5 **打开小程序 ⇒ 聊天自动收起**（把屏幕让给小程序）—— 由调用方做（`onOpen` 里点一下）。
//   ⏳ Z2"回到可见不许重建：滚动位置/表单内容/请求都还在" —— 结构上成立（容器一直在树上），
//      但**判据还没写**（要真验一次"打开 → 盖住 → 回来"）。
//
// ⚠️ **顶上那条栏由容器给**（返回 + 标题）：小程序自己**不许**画 AppBar ——
//    它跑在**容器自己的 `Navigator`** 里，所以它内部怎么跳都**跳不出这个容器**。
//    （上一代 `mini_app_container.dart` 就是这个形状，`50-DESKTOP-FLOATER.md` §四 记着。）

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/space_words.dart';

class MiniAppHost extends StatefulWidget {
  const MiniAppHost({
    super.key,
    required this.open,
    required this.title,
    required this.onClose,
    required this.covered,
    required this.onCoveredTap,
    required this.bottomInset,
    required this.child,
  });

  /// 现在有 app 开着吗。
  final bool open;

  /// **容器给的**标题（app 自己不许画那一条）。
  final String title;

  /// 顶栏那个返回：app 内部还能退就退，退到底就**关掉这个 app**。
  final VoidCallback onClose;

  /// 聊天展开了吗（展开 = 这一层**被盖住**）。
  final bool covered;

  /// 被盖住时点到可见的那一块 ⇒ 上层拿它收起聊天（§6.4 规则 3）。
  final VoidCallback onCoveredTap;

  /// **收起时那条压住了多少**（含边距）⇒ 内容底部按它内缩（§6.4 规则 1）。
  final double bottomInset;

  /// app 自己的内容（跑在容器自己的 `Navigator` 里）。
  final Widget child;

  @override
  State<MiniAppHost> createState() => _MiniAppHostState();
}

class _MiniAppHostState extends State<MiniAppHost> {
  final _nav = GlobalKey<NavigatorState>();

  @override
  Widget build(BuildContext context) {
    // 没开 ⇒ 什么都不画（**不是**画一个空壳：空壳是"看着像有、其实是空的"）
    if (!widget.open) return const SizedBox.shrink();
    final t = Theme.of(context);
    final covered = widget.covered;
    return Stack(
      children: [
        Positioned.fill(
          // ⚠️ 被盖住时**不接输入**（规则 3），但它**照样在跑**（规则 4）
          child: IgnorePointer(
            ignoring: covered,
            child: AnimatedScale(
              scale: covered ? 0.98 : 1,
              duration: d.motionPage,
              curve: Curves.easeOutCubic,
              child: AnimatedOpacity(
                opacity: covered ? 0.55 : 1,
                duration: d.motionPage,
                child: Material(
                  color: d.paper,
                  // 🔴 **全屏**（主人 2026-09-22：*"桌面小程序打开后，是全屏显示的，
                  //    只不过聊天窗口还在底下那里。"*）⇒ **不要外边距、不要常驻圆角**：
                  //    它是一"页"，不是一扇"窗"。
                  // ⚠️ 只有**被聊天盖住**时才有圆角（§6.4 规则 2："要看得出来被盖住"）。
                  borderRadius: BorderRadius.circular(covered ? 16 : 0),
                  clipBehavior: Clip.antiAlias,
                  child: DecoratedBox(
                    decoration: const BoxDecoration(),
                    child: Column(
                      children: [
                        // ── **容器给的**顶栏（app 自己不许画）──
                        Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: d.gapS,
                            vertical: 2,
                          ),
                          child: Row(
                            children: [
                              IconButton(
                                tooltip: miniAppBack,
                                onPressed: () {
                                  final nav = _nav.currentState;
                                  if (nav != null && nav.canPop()) {
                                    nav.pop();
                                  } else {
                                    widget.onClose();
                                  }
                                },
                                icon: const Icon(Icons.arrow_back),
                              ),
                              Expanded(
                                child: Text(
                                  widget.title,
                                  style: t.textTheme.titleMedium?.copyWith(
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                        Divider(height: 1, color: d.line),
                        // ── app 自己的内容：跑在**容器自己的 Navigator** 里 ──
                        //   ⚠️ **底部内缩挂在内容上**（不是挂在窗口上）：全屏之后
                        //      聊天那条仍然压在底下，不缩的话**最后一行永远点不到**（§6.4 规则 1）。
                        Expanded(
                          child: Padding(
                            padding: EdgeInsets.only(
                              bottom: widget.bottomInset,
                            ),
                            child: Navigator(
                              key: _nav,
                              onGenerateRoute: (_) => MaterialPageRoute<void>(
                                builder: (_) => widget.child,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
        // 被盖住时：**点可见的那一块 = 收起聊天**，而且这一下**不许传给下面的 app**
        if (covered)
          Positioned.fill(
            child: Listener(
              behavior: HitTestBehavior.opaque,
              onPointerDown: (_) => widget.onCoveredTap(),
            ),
          ),
      ],
    );
  }
}
