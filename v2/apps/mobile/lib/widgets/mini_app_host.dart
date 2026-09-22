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
    this.fromRect,
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

  /// **它是从哪儿打开的**（那个图标在屏幕上的矩形）。
  /// 🔴 主人 2026-09-22：*"小程序点开要有效果，就是从哪里打开，就从哪里扩开到全屏的效果。"*
  /// `null` = 没给 ⇒ 从屏幕中心"长出来"（总比硬切好）。
  final Rect? fromRect;

  @override
  State<MiniAppHost> createState() => _MiniAppHostState();
}

class _MiniAppHostState extends State<MiniAppHost>
    with SingleTickerProviderStateMixin {
  final _nav = GlobalKey<NavigatorState>();

  /// **"扩开/收回"那一下**。0 = 还只有图标那么大；1 = 全屏。
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: d.motionPage,
  );

  @override
  void initState() {
    super.initState();
    if (widget.open) _c.value = 1;
  }

  @override
  void didUpdateWidget(covariant MiniAppHost old) {
    super.didUpdateWidget(old);
    // 开 ⇒ 从图标那儿**扩开**；关 ⇒ **收回**到图标那儿
    if (widget.open && !old.open) _c.forward(from: 0);
    if (!widget.open && old.open) _c.reverse();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // 没开、而且已经收回去了 ⇒ 什么都不画
    // （**不是**"一关就消失"：关的时候要能看见它收回图标那一下）
    if (!widget.open && _c.isDismissed) return const SizedBox.shrink();
    final t = Theme.of(context);
    final covered = widget.covered;
    final screen = Offset.zero & MediaQuery.sizeOf(context);
    // 没给起点就从屏幕中心长出来（半个屏幕大的一块）
    final from =
        widget.fromRect ??
        Rect.fromCenter(
          center: screen.center,
          width: screen.width * 0.35,
          height: screen.height * 0.3,
        );

    Widget content() => Material(
      color: d.paper,
      // ⚠️ 只有**被聊天盖住**时才有圆角（§6.4 规则 2："要看得出来被盖住"）
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
            //   ⚠️ **底部内缩挂在内容上**：全屏之后聊天那条仍压在底下，
            //      不缩的话**最后一行永远点不到**（§6.4 规则 1）。
            Expanded(
              child: Padding(
                padding: EdgeInsets.only(bottom: widget.bottomInset),
                child: Navigator(
                  key: _nav,
                  onGenerateRoute: (_) =>
                      MaterialPageRoute<void>(builder: (_) => widget.child),
                ),
              ),
            ),
          ],
        ),
      ),
    );

    return Stack(
      children: [
        AnimatedBuilder(
          animation: _c,
          builder: (ctx, _) {
            final v = Curves.easeOutCubic.transform(_c.value);
            final rect = Rect.lerp(from, screen, v) ?? screen;
            return Positioned.fromRect(
              rect: rect,
              child: ClipRRect(
                // 小的时候有点圆角（像一张卡），长到全屏就是直角
                borderRadius: BorderRadius.circular((1 - v) * d.radiusCard),
                child: IgnorePointer(
                  ignoring: covered,
                  child: AnimatedOpacity(
                    opacity: covered ? 0.55 : 1,
                    duration: d.motionPage,
                    child: AnimatedScale(
                      scale: covered ? 0.98 : 1,
                      duration: d.motionPage,
                      curve: Curves.easeOutCubic,
                      // ⚠️ 内容**按全屏排版**，只是被上面那块矩形"露出来"
                      //    ⇒ 看起来就是"从那个图标扩开的"（而不是一个小窗被放大）
                      child: OverflowBox(
                        alignment: Alignment.topLeft,
                        minWidth: screen.width,
                        maxWidth: screen.width,
                        minHeight: screen.height,
                        maxHeight: screen.height,
                        child: content(),
                      ),
                    ),
                  ),
                ),
              ),
            );
          },
        ),
        // 被盖住时：**点可见的那一块 = 收起聊天**，而且这一下**不许传给下面的 app**
        if (covered && _c.isCompleted)
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
