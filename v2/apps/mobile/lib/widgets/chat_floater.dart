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

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/space_words.dart';

/// 三档（手册 §6.2）。
enum FloaterTier {
  /// 收起：只剩一条（**必须带字**，D3.8）。
  collapsed,

  /// 半开。
  half,

  /// 最大化（"发就拉满"）。
  full,
}

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

  /// 双击抓手的判定窗（与防抖无关：这是"用户的手势"）。
  static const int doubleTapMs = 300;
}

class ChatFloater extends StatefulWidget {
  const ChatFloater({
    super.key,
    required this.maxHeight,
    required this.title,
    required this.child,
    required this.composer,
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

  /// 双击抓手用（两次抬手之间的间隔）。
  int _lastUpMs = 0;
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
      // 没拖动 ⇒ 可能是一次"点"：双击抓手 = 收起 ⇄ 上次档位（§6.3）
      if (!_movedInGesture) {
        if (now - _lastUpMs <= FloaterMetrics.doubleTapMs) {
          _lastUpMs = 0;
          _setTier(_collapsed ? _lastOpen : FloaterTier.collapsed, auto: false);
        } else {
          _lastUpMs = now;
        }
      }
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
    return ConstrainedBox(
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
                color: d.card,
                child: Column(
                  mainAxisSize: collapsed ? MainAxisSize.min : MainAxisSize.max,
                  children: [
                    // ── 抓手行（收起态就是那条"带字的入口"）──────────
                    //  🔴 **手势只绑在这一行**（§6.3："竖向拖抓手 / 标题行"）。
                    //     绑在整块浮窗上会把时间线的滚动吃掉 —— 那正是上一版没暴露的 bug。
                    Listener(
                      behavior: HitTestBehavior.opaque,
                      onPointerDown: _onDown,
                      onPointerMove: _onMove,
                      onPointerUp: _onUp,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: d.gapS,
                          vertical: 2,
                        ),
                        child: Row(
                          children: [
                            if (!collapsed) ...[
                              const SizedBox(width: d.gapS),
                              Container(
                                width: 28,
                                height: 4,
                                decoration: BoxDecoration(
                                  color: d.line,
                                  borderRadius: BorderRadius.circular(2),
                                ),
                              ),
                            ],
                            const SizedBox(width: d.gapS),
                            Text(
                              widget.title,
                              style: t.textTheme.titleSmall?.copyWith(
                                color: d.ink,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            const Spacer(),
                            // 🔴 **收起态必须有"带字的展开入口"**（D3.8：不是 40px 无字箭头），
                            //    命中区 ≥44（D3.6）—— 上一版就是被这条判据当场抓住的。
                            if (collapsed)
                              TextButton(
                                style: TextButton.styleFrom(
                                  minimumSize: const Size(88, 44),
                                ),
                                onPressed: () =>
                                    _setTier(_lastOpen, auto: false),
                                child: const Text('展开'),
                              )
                            else ...[
                              // ⚠️ 那一串动作要能**横向滚**：窄屏 + 大字号下它**一定**放不下；
                              //    折行会让这一行变高 ⇒ 把时间线挤没。一行 + 横滚：高度不变、一个都不藏。
                              Flexible(
                                child: SingleChildScrollView(
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
                              //    ⚠️ **只在展开态画它**：收起态本来就已经收起来了
                              //      （第一版把它放在 if/else 之外 ⇒ 收起那条上也挂着一个"收起"，是错的）。
                              IconButton(
                                tooltip: chatCollapse,
                                onPressed: () => _setTier(
                                  FloaterTier.collapsed,
                                  auto: false,
                                ),
                                icon: const Icon(Icons.keyboard_arrow_down),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                    // 收起态：**只画输入条**（时间线不画 —— 免得它被压成一条时还在偷偷布局，
                    // 那正是上一版溢出的来源）。主人 2026-09-22："收缩的时候也有一个输入框。"
                    if (collapsed)
                      widget.composer
                    else ...[
                      Divider(height: 1, color: d.line),
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
    );
  }
}
