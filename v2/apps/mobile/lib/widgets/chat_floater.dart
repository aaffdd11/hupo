// **聊天浮窗**（手册 `08-SPEC.md` §六 · 契约 `docs/dev/52-DESKTOP.md`）。
//
// 手册那几条铁律就是这个文件存在的理由：
//   · **Z1** 它永远在 z 序最上（任何页面/小程序都盖不住它）；
//   · **Z3** **盖住不是铺满**：四边永远留边距（现在**四边都是 30**，主人 2026-09-22 定）；
//   · **Z4**（新）桌面是**底部一条**，浮窗在它上面浮着、四边留同一个数。
//
// 三档（§6.2）：收起 / 半开 / 最大化。
//   · **用户按下发送** ⇒ 最大化（"发就拉满"）；
//   · **只有状态变化**（它在想/在做）⇒ **不动**（D4.8：新增助手消息触发的高度变化 = 0px）；
//   · 点浮窗外面 / 点桌面空白 ⇒ 收起；双击抓手 ⇒ 收起 ⇄ 回到上次档位；
//   · **400ms 内的连续触发合并成一次**（助手连发多段不该让窗口抖）。
//
// ── 🔴 2026-09-22 重做的那一处（上一版就死在这儿）────────────────
// 上一版把浮窗**高度定死**（`屏高 - 边距`），再把字塞进去 ⇒ 3.1 倍字号下
// 里面的 chrome（抓手行 + 状态条 + 输入条）比容器还高 ⇒ **纵向溢出 798px**。
// 那正好违反 D3.5：**容器跟字算，不是字跟容器**。现在的形状：
//   · **收起档不写死高度**：它就是"抓手行那点内容"，`SizedBox(height: null)` 由内容算；
//   · **半开/最大化用比例**（§6.2 明写"高度用系数表达"），上限 = 父层给的那块地方；
//   · 高度是父层（`LayoutBuilder`）算出来**传进来**的 —— 这里**不碰 `MediaQuery`**，
//     也就不需要在 `Positioned` 里套 `LayoutBuilder`（那个坑见契约 §二）。
//
// ⚠️ **"点浮窗自己不许漏到下面"**（§6.3）用 `Listener(behavior: opaque)` 挡 ——
//    `deferToChild` 挡不住，点空白会**漏到桌面**。
//    ⚠️ **不用 `GestureDetector`**：源码级禁令（`accessibility_test.dart`）。
//    拖拽与双击都走 `Listener`（原始指针）；可点的东西一律是 Material 按钮。
//
// ── ★ 批次 4：浮窗的**面子**换成 DSH 那套 token（契约 `docs/dev/119`）──────
// 底色 / 发丝线 / 标题 / 抓手 / 里面那一整棵 Material 主题，全部跟着
// `AppearanceScope` 的色板走（用户选亮/暗/跟随系统）。三条边界：
//   · **窗口外面一个像素都不动**：桌面图标墙 / 首页 / 登录 / 小程序容器那一圈壳
//     照旧是暖白纸那套（`models/design.dart`）。整机暗色**不是这一批的事**
//     —— 那等于要给暖白纸品牌色**发明**一份暗色版，得主人点头；
//   · **字号那一轴不在这里**：浮窗自己的字号（抓手/标题/动作）跟系统缩放走，
//     用户的 12–17 **只影响聊天内容**（DSH 原话，`115-raw/B-render.md` §3.1）；
//   · **阴影还是从 `d.ink` 来**（`desktop_floater_test` 钉着那个数）：阴影是
//     "压在多亮的底上"那件事，不是窗口自己的面子。

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/dsh_design.dart';
import '../models/space_words.dart';
import 'appearance_scope.dart';

/// 三档（手册 §6.2）。
enum FloaterTier {
  /// 收起：只剩一条（**必须带字**，D3.8）。
  collapsed,

  /// 半开。
  half,

  /// 最大化（"发就拉满"）。
  full,
}

/// **抓手那颗按钮的 key**（判据用它量命中区、也用它点/拖 —— 图形上没有字可找）。
const Key chatHandleKey = Key('chat-handle');

/// **标题行右边那一串动作那条横滚条**的 key（判据用它量"看得见几个"）。
const Key chatActionsStripKey = Key('chat-actions-strip');

/// 浮窗自己的几条常量（**不散在代码里**）。
class FloaterMetrics {
  const FloaterMetrics._();

  /// **四边留的边距**（Z3 + Z4：盖住不是铺满）。主人 2026-09-22 定的数。
  /// ⚠️ 表在手册 `08-SPEC.md` §10.1（阈值总表），改这里就要改那儿并升版本。
  static const double margin = 30;

  /// 半开占**可用高度**的比例（§6.2：高度用系数表达）。
  static const double halfRatio = 0.55;

  /// 松手吸附的判定带宽（拖到离某一档多近就吸过去）。
  static const double snapSlack = 40;

  /// 拖拽时的**视觉下限**。
  /// ⚠️ 它**不是**收起档的高度 —— 收起档由内容算（见文件头那条）。它只管"拖到多小"。
  static const double dragFloor = 56;

  /// **甩**的判据（D3.7：速度 + 位移 + 时长**三个都要满足**）。
  static const double flingVelocity = 700; // px/s
  static const double flingDistance = 60; // px
  static const int flingMaxMs = 300; // 一次动作不超过这么久

  /// 连续触发的**合并窗口**（§6.2：400ms 内合并成一次）。
  static const int debounceMs = 400;

  // ⚠️ 原来这里有一个 `doubleTapMs`（双击抓手的判定窗）。2026-09-24 起抓手是
  //    **单击 = 收起 ⇄ 展开**（主人：*"展开用一条杠"*）⇒ 双击那套拿掉：
  //    留着它只会让"点两下"变成"展开又收起"（看起来就是点了没反应）。
}

class ChatFloater extends StatefulWidget {
  const ChatFloater({
    super.key,
    required this.maxHeight,
    required this.title,
    required this.child,
    required this.composer,
    this.beforeActions,
    this.trailing = const <Widget>[],
    this.initialTier = FloaterTier.collapsed,
    this.onTier,
    this.onHeight,
  });

  /// **父层量好给它的可用高度**（父层是 `LayoutBuilder`）。
  /// ⚠️ 传进来而不是自己算，是为了**不碰 `MediaQuery`**、也不在 `Positioned` 里套 `LayoutBuilder`。
  final double maxHeight;

  /// 抓手行上那两个字（收起态那条也用它）。
  final String title;

  /// 浮窗里那一整块（状态条 + 时间线）。**不含输入条** —— 见 [composer]。
  final Widget child;

  /// **输入条**。⚠️ **收起态也要它**（主人 2026-09-22：*"助手那个聊天窗口，
  /// 收缩的时候也有一个输入框。"*）⇒ 而且上下两态用的是**同一个实例**，
  /// 不然"打了一半再展开"会换一个 `State`、**框里的字就丢了**。
  final Widget composer;

  /// 抓手行右边的动作（回收站/导出/过程/配置/退出那套）。
  /// ⚠️ **收起态不画它们** —— 收起条只留"带字的展开入口"（D3.8）。
  final List<Widget> trailing;

  /// **标题行上、动作那条横滚串前面那一格**。
  ///
  /// 今天放的是【这一窗动过哪些文件】那颗按钮（`FilePanelButton`）。
  /// `null` = 那一格什么都不画（老调用方 / 单看这一块的测试照旧）。
  /// ⚠️ **收起态不画它**（收起条只有一行：抓手 ＋ 输入框）。
  /// ⚠️ 它是**不弹性的**：挤的时候让标题去截字，这一格永远整颗看得见。
  final Widget? beforeActions;

  // ⚠️ 2026-09-24：原来这里有一个 `leading`（标题前面那个"在哪儿说话"的图标）。
  //    聊天窗口收成**一行**之后，它搬到了输入条那一行的最前面
  //    （主人：*"homeicon 放在聊天窗口左边"*）⇒ 浮窗不再认识它，
  //    由 `screens/chat_screen.dart` 直接交给 `Composer`。

  /// 一进来是哪一档。**默认收起**（主人 2026-09-22 定：先看见桌面）。
  final FloaterTier initialTier;

  /// **换档了**（上层拿它算"小程序被盖住了没有" —— §6.4 规则 2/3）。
  final ValueChanged<FloaterTier>? onTier;

  /// **我现在占多高**（上层拿它给小程序内容做底部内缩 —— §6.4 规则 1）。
  /// ⚠️ 收起档的高度是**内容算出来**的（D3.5）⇒ 只能**画完再报**，
  ///    所以它在 post-frame 里回调；上层自己判"变了没有"再 setState（免得抖）。
  final ValueChanged<double>? onHeight;

  @override
  State<ChatFloater> createState() => ChatFloaterState();
}

class ChatFloaterState extends State<ChatFloater> {
  late FloaterTier _tier;

  /// 上次**非收起**的那一档（双击抓手 / 点"展开"时回到它）。
  late FloaterTier _lastOpen;

  /// 拖拽中：`null` = 没在拖；有值 = 当前跟手的高度。
  double? _dragging;

  double _dragStartH = 0;
  int _dragStartMs = 0;
  double _dragVelocity = 0;
  int _lastMoveMs = 0;

  bool _movedInGesture = false;

  /// 上一次**自动**换档的时间（防抖：400ms 内合并成一次）。
  int _lastAutoMs = 0;

  @override
  void initState() {
    super.initState();
    _tier = widget.initialTier;
    _lastOpen = widget.initialTier == FloaterTier.collapsed
        ? FloaterTier.full
        : widget.initialTier;
    // 初始档位也报一次（不然上层以为"还没展开"而屏幕上已经展开了）
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) widget.onTier?.call(_tier);
    });
  }

  int _nowMs() => DateTime.now().millisecondsSinceEpoch;

  /// 换档（**带防抖**：§6.2 的"400ms 内合并成一次"）。
  void _setTier(FloaterTier t, {bool auto = true}) {
    if (t == _tier) return;
    final now = _nowMs();
    if (auto && now - _lastAutoMs < FloaterMetrics.debounceMs) return;
    if (auto) _lastAutoMs = now;
    setState(() {
      _tier = t;
      if (t != FloaterTier.collapsed) _lastOpen = t;
    });
    widget.onTier?.call(t);
  }

  /// **外面叫它拉满**（"用户按下发送 ⇒ 最大化" · §6.2）。
  /// ⚠️ **不受防抖限制**：用户主动的动作不该被合并掉。
  void maximize() {
    _lastAutoMs = _nowMs(); // 顺手把防抖窗推后，免得紧接着的状态变化又来动窗口
    setState(() {
      _tier = FloaterTier.full;
      _lastOpen = FloaterTier.full;
      _dragging = null;
    });
    widget.onTier?.call(FloaterTier.full);
  }

  /// 外面叫它收起（点桌面空白时用）。
  void collapse() => _setTier(FloaterTier.collapsed, auto: false);

  /// **展开到上次那一档**（§6.3："点收起态底部条 ⇒ 展开到上次档位"）。
  /// ⚠️ 「展开」按钮和**点输入框**走的是**同一条路** —— 两处各写一套迟早会分叉。
  void expand() => _setTier(_lastOpen, auto: false);

  /// 现在哪一档（闸用）。
  FloaterTier get tier => _tier;

  bool get _collapsed => _tier == FloaterTier.collapsed && _dragging == null;

  /// 某一档的高度。**收起档返回 `null`** ⇒ 交给内容自己算（D3.5）。
  double? _heightFor(double max) {
    if (_dragging != null) {
      return _dragging!.clamp(FloaterMetrics.dragFloor, max);
    }
    return switch (_tier) {
      FloaterTier.collapsed => null,
      FloaterTier.half => (max * FloaterMetrics.halfRatio).clamp(
        FloaterMetrics.dragFloor,
        max,
      ),
      FloaterTier.full => max,
    };
  }

  /// 松手之后吸附到哪一档（甩优先，其次看离哪一档近）。
  FloaterTier _snapTo(
    double h,
    double max, {
    required bool flungDown,
    required bool flungUp,
  }) {
    if (flungDown) return FloaterTier.collapsed;
    if (flungUp) return FloaterTier.full;
    final candidates = <(FloaterTier, double)>[
      (FloaterTier.collapsed, FloaterMetrics.dragFloor),
      (FloaterTier.half, max * FloaterMetrics.halfRatio),
      (FloaterTier.full, max),
    ];
    candidates.sort((a, b) => (a.$2 - h).abs().compareTo((b.$2 - h).abs()));
    return candidates.first.$1;
  }

  void _onDown(PointerDownEvent e) {
    _dragging = null; // 还没动：先别改高度（点一下不该跳）
    _dragStartH = _heightFor(widget.maxHeight) ?? FloaterMetrics.dragFloor;
    _dragStartMs = _nowMs();
    _lastMoveMs = _dragStartMs;
    _dragVelocity = 0;
    _movedInGesture = false;
  }

  void _onMove(PointerMoveEvent e) {
    if (e.delta.dy.abs() > 1) _movedInGesture = true;
    if (!_movedInGesture) return;
    final now = _nowMs();
    final dy = e.delta.dy;
    _dragging = ((_dragging ?? _dragStartH) - dy).clamp(
      FloaterMetrics.dragFloor,
      widget.maxHeight,
    );
    if (now > _lastMoveMs) {
      _dragVelocity = -dy / ((now - _lastMoveMs) / 1000); // 往上拖 = 变高 = 正速度
    }
    _lastMoveMs = now;
    setState(() {}); // ⚠️ 跟手：拖拽期间**动画 0ms**（§6.7 约束 2）
  }

  void _onUp(PointerUpEvent e) {
    final now = _nowMs();
    final h = _dragging;
    if (h == null) {
      // 没拖动 ⇒ 这一下是"点"。⚠️ **点由抓手那颗按钮处理**（见 `_handle`），
      // 这里**不再自己判双击**：2026-09-24 起抓手是"单击 = 收起 ⇄ 展开"，
      // 而双击 = 两次单击 = 自己把自己抵消掉（真机上就是"点了没反应"）。
      return;
    }
    final durMs = now - _dragStartMs;
    final moved = (h - _dragStartH).abs();
    // ⚠️ D3.7：**速度 + 位移 + 时长三个都要满足**才算"甩"
    final flung =
        durMs <= FloaterMetrics.flingMaxMs &&
        moved >= FloaterMetrics.flingDistance;
    final flungUp =
        flung &&
        _dragVelocity > FloaterMetrics.flingVelocity &&
        h > _dragStartH;
    final flungDown =
        flung &&
        _dragVelocity < -FloaterMetrics.flingVelocity &&
        h < _dragStartH;
    final to = _snapTo(
      h,
      widget.maxHeight,
      flungDown: flungDown,
      flungUp: flungUp,
    );
    _dragging = null;
    _setTier(to, auto: false); // 用户刚松手 ⇒ 不听防抖
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    // ★ 批次 4：这一屏的面子（色板）从 `AppearanceScope` 来；没有 scope
    //   （单看这一块的判据）就退回"跟着 Theme 的亮暗"，与原来逐字一致。
    final scope = AppearanceScope.maybeOf(context);
    final variant =
        scope?.variant ??
        (Theme.of(context).brightness == Brightness.dark
            ? DshVariant.dark
            : DshVariant.light);
    final p = variant.palette;
    final maxH = math.max(widget.maxHeight, FloaterMetrics.dragFloor);
    final h = _heightFor(maxH);
    final collapsed = _collapsed;
    if (widget.onHeight != null) {
      // 画完再报（收起档的高度只有画完才知道 —— D3.5）
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final h = context.size?.height;
        if (mounted && h != null) widget.onHeight!(h);
      });
    }
    return Theme(
      // 🔴 **窗口里面那一整棵**换成这一档的 Material 主题（见 `appearance_scope.dart`
      //    里 `chatThemeOf` 顶上那段：不这么做，里面那些读 `Theme` 的控件
      //    ——气泡、输入框、状态条——会把近黑的字压在近黑的底上，而判据照样全绿）。
      data: chatThemeOf(variant),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxH),
        // ⚠️ 收起档 `h == null` ⇒ `SizedBox` 不约束高度 ⇒ 由内容算（D3.5）
        child: SizedBox(
          height: h,
          child: DecoratedBox(
            // 阴影照手册 §10.1 阈值总表：外 blur 32 · α.45 · offset(0,-6)
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(d.radiusCard),
              boxShadow: [
                BoxShadow(
                  color: d.ink.withValues(alpha: 0.45),
                  blurRadius: 32,
                  offset: const Offset(0, -6),
                ),
              ],
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(d.radiusCard),
              child: Listener(
                // 🔴 **点浮窗自己不许漏到下面**（§6.3）：opaque 吃掉所有指针事件。
                // ⚠️ 这里**不接手势**（没有 onPointerXxx）—— 它只负责"挡住"。
                //    手势绑在抓手那一行（见下），否则会把**时间线的滚动**吃掉：
                //    2026-09-22 实测，第一版把 `_onMove` 挂在整块浮窗上，
                //    于是"往上拖时间线"被当成"把窗口拉高"，`重发`那条判据当场红。
                behavior: HitTestBehavior.opaque,
                child: Material(
                  // ★ 窗口的底 = DSH 的 `bg-layer-1`（亮色就是纯白，暗色 #232324）。
                  color: p.bgLayer1,
                  child: Column(
                    mainAxisSize: collapsed ? MainAxisSize.min : MainAxisSize.max,
                    children: [
                      // ── 抓手（主人 2026-09-24）────────────────────────
                      //   原话：*"展开用一条杠，杠上面有一个小箭头，箭头比较平，
                      //   所以不会显得那么突兀，放在上边框的正中央"*
                      //
                      // 🔴 **一根杠 + 一个"平"的小箭头**，**永远在上边框正中央**
                      //    （收起、展开都在同一个位置 —— 位置不动，只有箭头朝上/朝下）。
                      //   · **点它 = 收起 ⇄ 展开**（单击就够）；
                      //   · **竖向拖它 = 跟手变高**（§6.3 的手势表）。
                      //
                      //   ⚠️ **命中区 96×44（D3.6）**，图形只有 26×7 —— 好点，但不显眼。
                      //   ⚠️ 它**没有可见的字**（主人这次的原话就是"一条杠 + 小箭头"）：
                      //      D3.8 那条"必须带字"由这一版**改掉**（手册同日改），
                      //      字改挂在 tooltip 与无障碍名上（`展开` / `收起`）。
                      //   ⚠️ 手势**只绑在这一行**（§6.3）：绑在整块浮窗上会把时间线的滚动吃掉
                      //      —— 那正是上一版没暴露的 bug。
                      Listener(
                        behavior: HitTestBehavior.opaque,
                        onPointerDown: _onDown,
                        onPointerMove: _onMove,
                        onPointerUp: _onUp,
                        child: Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: _handle(collapsed, p),
                        ),
                      ),
                      // ── 展开态：标题行（**收起态不画它** —— 那一档就是"一行"）──
                      if (!collapsed)
                        Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: d.gapS,
                            vertical: 2,
                          ),
                          child: Row(
                            children: [
                              const SizedBox(width: d.gapS),
                              // ★ `118` 起标题**可以让位**（窄屏 + 大字号下右边还要摆
                              //    那一串动作）：原来的 Text 是不弹性的 ⇒
                              //    这一行会横向溢出。`Flexible` + 省略号把它变成
                              //    "地方不够就截字"，**位置与大小在地方够时一字不变**
                              //    （`notice_overlay_test` 量的就是那个矩形）。
                              Flexible(
                                child: Text(
                                  widget.title,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  // ★ 2026-09-23：`titleSmall`(≈14) → `titleMedium`(≈16)
                                  //   —— 它是这一屏的名字，原来和旁边那排图标一样大。
                                  // ★ 批次 4：字色跟色板走（暗色下 `d.ink` 是黑字）。
                                  style: t.textTheme.titleMedium?.copyWith(
                                    color: p.labelPrimary,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ),
                              // ★ 会话头上、动作那条横滚串**前面**那一格
                              //    （今天放的是【这一窗动过哪些文件】那颗按钮）。
                              //    ⚠️ 它是**不弹性**的：挤的时候让标题去截字，
                              //       这一格永远整颗看得见。
                              if (widget.beforeActions != null) ...[
                                const SizedBox(width: d.gapS),
                                widget.beforeActions!,
                              ],
                                                            // 🔴 **这里原来有一个 `Spacer()`** —— 2026-09-26 拿掉。
                              //    它和右边那一条**都是 flex 1** ⇒ 把剩余宽对半分，
                              //    而它自己一个像素都不画。390 宽的手机上量到：
                              //      有它：横滚条 **35.4** 宽（连「过程」都被切掉半个）
                              //      没它：横滚条 **53** 宽（「过程」整颗在里面）
                              //    ⇒ 纯粹是浪费。读数在 `docs/dev/124-TOUCH-REGRESSION.md` §三。
                              //    ⚠️ 那一条**仍然贴右**：`Flexible` 里的横滚条是**贪婪**的，
                              //      会把分到的宽全占满（`收起` 照旧钉在最右）。
                              // ⚠️ 那一串动作要能**横向滚**：窄屏 + 大字号下它**一定**放不下；
                              //    折行会让这一行变高 ⇒ 把时间线挤没。一行 + 横滚：高度不变。
                              // 🔴 **"一个都不藏"是假话**（2026-09-26 如实改口径）：
                              //    窄屏下这一串**仍然**放不下 ⇒ 靠前那几颗在视口外，
                              //    只有横滑够得着。
                              //    ⚠️ 2026-09-26（`#173` 砍掉那两个 tab 之后）真量过：
                              //      390 宽下这一格只剩【这一窗动过哪些文件】那一颗
                              //      ⇒ 横滚条 **53 → 101** 像素（读数见 `docs/dev/00-PROGRESS.md` §〇 `#173`）；
                              //      「过程」整颗在里面、「导出」露一半、「回收站」还在视口外。
                              //      原来那条"视口外那几颗的 a11y 矩形挂在【聊天/轨迹】坐标上"
                              //      的实例，随着 tab 一起没了。
                              //    ⇒ 这条账**没结**：真修法要么加一颗「更多」的出口、
                              //      要么把它们搬出这一行 —— 那是产品决定，
                              //      记在 `docs/dev/124-TOUCH-REGRESSION.md` §三·五。
                              Flexible(
                                child: SingleChildScrollView(
                                  key: chatActionsStripKey,
                                  scrollDirection: Axis.horizontal,
                                  reverse: true,
                                  child: Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: widget.trailing,
                                  ),
                                ),
                              ),
                              // 🔴 **「收起」钉在横滚之外**（主人 2026-09-22：*"展开后要有收回的按钮"*）：
                              //    它原来在那条**横向滚动**里 ⇒ 窄屏 + 大字号下会被滚出视野，
                              //    而"想收起来"的时候找不到按钮 = 一个点不到的出口。
                              //    ⚠️ **只在展开态画它**（收起态本来就已经收起来了）。
                              //    ⚠️ 2026-09-24 起**抓手自己也收得起来**，这个按钮留着是"看得见的出口"。
                              IconButton(
                                tooltip: chatCollapse,
                                onPressed: () => _setTier(
                                  FloaterTier.collapsed,
                                  auto: false,
                                ),
                                icon: const Icon(Icons.keyboard_arrow_down),
                                color: p.labelTertiary,
                              ),
                            ],
                          ),
                        ),
                      // 收起态：**只画输入条**（时间线不画 —— 免得它被压成一条时还在偷偷布局，
                      // 那正是上一版溢出的来源）。主人 2026-09-22："收缩的时候也有一个输入框。"
                      if (collapsed)
                        widget.composer
                      else ...[
                        // ★ 批次 4：发丝线（0.5，不是 1.0）＋ 这一档的描边色。
                        Divider(
                          height: 1,
                          thickness: dshHairline,
                          color: p.borderL3,
                        ),
                        Expanded(child: widget.child),
                        widget.composer,
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// **抓手**（主人 2026-09-24）：上边框正中央**一条杠 + 一个平的小箭头**。
  ///
  /// 🔴 三条约束，缺一条都会退回到"上一版那种看不出来的东西"：
  ///   ① **位置固定在上边框正中**（收起/展开都在同一个位置 ⇒ 他知道戳哪儿）；
  ///   ② **箭头要平**（浅角 —— 26×7 ≈ 15°，不是那种尖尖的 `keyboard_arrow_up`）；
  ///   ③ **命中区 ≥44**（D3.6）：外面那颗按钮给的是 **96×44**，图形只占中间一小块。
  ///
  /// ⚠️ **单击 = 收起 ⇄ 展开**（不再有双击：两次单击会互相抵消 ⇒ "点了没反应"）。
  /// ⚠️ 字挂在 `Tooltip`（web 上悬停看得见）+ 无障碍名上（D3.8 的"带字"由 2026-09-24 改掉）。
  /// ★ 批次 4：那一笔与那条杠的颜色跟色板走（`label-tertiary` / `border-l3`）。
  Widget _handle(bool collapsed, DshPalette p) {
    final button = TextButton(
      key: chatHandleKey,
      onPressed: () =>
          _setTier(collapsed ? _lastOpen : FloaterTier.collapsed, auto: false),
      style: TextButton.styleFrom(
        minimumSize: const Size(96, 44),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
        foregroundColor: p.labelTertiary,
      ),
      child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CustomPaint(
              size: const Size(26, 7),
              painter: _FlatChevron(color: p.labelTertiary, up: collapsed),
            ),
            const SizedBox(height: 3),
          Container(
            width: 44,
            height: 4,
            decoration: BoxDecoration(
              color: p.borderL3,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
        ],
      ),
    );
    // ⚠️ tooltip 只在**收起态**挂（那会儿它是唯一的展开入口）。
    //    展开态**不挂** —— 标题行已经有一个「收起」按钮，两个控件挂同一句话
    //    会让"屏幕上到底有几个收起"这种判据（和读屏）分不清。
    //    无障碍名两种状态都给（`Semantics` 那句在下面）。
    final named = Semantics(
      button: true,
      label: collapsed ? '展开' : '收起',
      child: button,
    );
    return Center(
      child: collapsed ? Tooltip(message: '展开', child: named) : named,
    );
  }
}

/// **一个"平"的小箭头**（浅角的 V 字那一笔）。
///
/// ⚠️ 为什么自己画：`Icons.keyboard_arrow_up` 那个角**太尖**，摆在一条杠上显得突兀
///    （主人原话：*"箭头比较平，所以不会显得那么突兀"*）
///    ⇒ 26×7 的框、2px 圆头笔画，画出来是很浅的一笔。
class _FlatChevron extends CustomPainter {
  const _FlatChevron({required this.color, required this.up});

  final Color color;

  /// 收起态朝上（"往上拉就能展开"），展开态朝下。
  final bool up;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..strokeWidth = 2
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..style = PaintingStyle.stroke;
    final w = size.width;
    final h = size.height;
    final path = Path();
    if (up) {
      path.moveTo(0, h);
      path.lineTo(w / 2, 0);
      path.lineTo(w, h);
    } else {
      path.moveTo(0, 0);
      path.lineTo(w / 2, h);
      path.lineTo(w, 0);
    }
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(covariant _FlatChevron old) =>
      old.color != color || old.up != up;
}
