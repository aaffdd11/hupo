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
import 'motion.dart';
import '../models/design.dart' show miniAppSurfaceAt;
import '../models/space_words.dart';

/// **小程序那一层的 key**（给判据用：量"扩开/收回"途中的圆角与阴影）。
///
/// ⚠️ 与 `chatBodyKey` 同一条做法：**它是给闸用的**，不是给业务逻辑用的。
final GlobalKey miniAppSurfaceKey = GlobalKey(debugLabel: 'mini-app-surface');

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
    this.icon,
    this.onSettled,
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

  /// **这一屏的图标**（主人 2026-09-24：前半程要看到"图标自己在长大"）。
  /// `null` = 没给 ⇒ 这一层不画（老行为：一上来就是页面被裁出的一小块）。
  final IconData? icon;

  /// **动画落定了**（扩开铺满 / 收回到底）—— 上层拿它决定"桌面那一格的图标什么时候回来"。
  /// ⚠️ 只在**状态变化**时叫一次，不是每帧叫。
  final VoidCallback? onSettled;

  @override
  State<MiniAppHost> createState() => _MiniAppHostState();
}

class _MiniAppHostState extends State<MiniAppHost>
    with SingleTickerProviderStateMixin {
  final _nav = GlobalKey<NavigatorState>();

  /// **"扩开/收回"那一下**。0 = 还只有图标那么大；1 = 全屏。
  late final AnimationController _c = AnimationController(
    vsync: this,
    // ★ 2026-09-24 主人定案：**0.5 秒**、而且不是线性的（见 `motion.dart`）
    duration: d.motionAppOpen,
  );

  @override
  void initState() {
    super.initState();
    if (widget.open) _c.value = 1;
    _c.addStatusListener((st) {
      if (st == AnimationStatus.completed || st == AnimationStatus.dismissed) {
        widget.onSettled?.call();
      }
    });
    // 🔴 **收回动画走完的那一刻必须重建一次**（2026-09-22 主人报"退出小程序有个小bug"）。
    //    原来只在 `build()` 里写了一句"没开而且收回去了 ⇒ 什么都不画"——
    //    而**动画结束不会触发外层 `build()`**（只有里面那个 `AnimatedBuilder` 会重建）
    //    ⇒ 关掉之后**那一块还留在图标的位置上**，而且它是**可点的**
    //    ⇒ 它正好压在图标上，**把图标挡住了**：退出小程序之后再点图标**没反应**。
    //    （实测：关掉后矩形还停在 (24,8,116,82)；再点图标开不起来。）
    _c.addStatusListener((st) {
      if (st == AnimationStatus.dismissed && mounted) setState(() {});
    });
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
            // ★ "越远越快、越近越慢"（速度 ∝ 剩余距离）—— 见 `widgets/motion.dart`
            //   ⚠️ **两个方向各算一次**：直接倒放曲线会让"关掉"变成"先不动、最后砸回去"
            final v = miniAppSurfaceProgress(
              value: _c.value,
              closing: _c.status == AnimationStatus.reverse,
            );
            final rect = Rect.lerp(from, screen, v) ?? screen;
            // 🔴 **起点 = 图标那一格，终点 = 全屏**（主人 2026-09-23：
            //    *"小程序 icon 是有圆角有阴影的。而打开和关闭的时候，那一层效果没有阴影，
            //    所以开启和打开的效果并不如意。"*）
            //    ⚠️ 圆角原来就有（下面那个 `ClipRRect` 一直在插值），**缺的是阴影** ——
            //      而且阴影**必须画在裁剪外面**：`ClipRRect` 会把里面的阴影一起剪掉，
            //      这正是它一直"没有影子"的原因。
            final face = miniAppSurfaceAt(v);
            return Positioned.fromRect(
              rect: rect,
              child: DecoratedBox(
                // 阴影层（在 `ClipRRect` **外面**，所以看得见）
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(face.radius),
                  boxShadow: face.shadowAlpha <= 0.001
                      ? const <BoxShadow>[]
                      : [
                          BoxShadow(
                            color: d.ink.withValues(alpha: face.shadowAlpha),
                            blurRadius: face.shadowBlur,
                            offset: Offset(0, face.shadowDy),
                          ),
                        ],
                ),
                child: Stack(
              fit: StackFit.expand,
              children: [
                ClipRRect(
                key: miniAppSurfaceKey,
                // 小的时候有点圆角（像一张卡），长到全屏就是直角
                borderRadius: BorderRadius.circular(face.radius),
                child: IgnorePointer(
                  // ★ 前半程画的是"长大中的图标"，页面还没出来 ⇒ 也先别收点击
                  ignoring: covered || miniAppContentShare(v) < 0.5,
                  child: Opacity(
                    // ★ "到一半左右换成页面内容"（按位置进度 ⇒ 打开/收回对称）
                    opacity: miniAppContentShare(v),
                    child: AnimatedOpacity(
                     opacity: covered ? 0.55 : 1,
                    duration: d.motionAppOpen,
                    child: AnimatedScale(
                      scale: covered ? 0.98 : 1,
                      duration: d.motionAppOpen,
                      curve: miniAppOpenCurve,
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
              ),
                // ★ 上层：**那个图标本身**（按格子比例放大 ⇒ p=0 时和桌面那一格逐像素一致，
                        //   所以"从图标长出来"那一下不会跳）
                if (widget.icon != null)
                  IgnorePointer(
                    child: Opacity(
                      opacity: miniAppIconShare(v),
                      child: Center(
                        child: Icon(
                          widget.icon,
                          size: rect.shortestSide * miniAppIconOfBox,
                          color: d.ink,
                        ),
                      ),
                    ),
                  ),
              ],
            )),
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
