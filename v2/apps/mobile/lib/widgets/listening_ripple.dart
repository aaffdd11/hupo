// **"我正在听"那一圈涟漪**（主人 2026-10-07：*"我们增加动效，表达正在听的意思。"*）。
//
// ── 它是什么、不是什么 ────────────────────────────────────
//   ✅ 是：那颗圆圈**外面一圈一圈荡开**的淡琥珀（两条错开、一圈一轮），
//      它只说一件事 —— **在听**。慢的时候（第一次按下要等连接/上游）屏幕上
//      有个"它在动着"的东西，而不是一颗静止的按钮。
//   🔴 **不是**"我听到声音了"：聊天这一条**没有量电平**（量电平那一套在
//      「语音」设置页那颗「试一下」里）。装成"跟着他声音起伏"就是**骗人**
//      —— 安静的时候它照样在动，一看就知道是假的。
//   🔴 尺寸 / 位置 / 命中区**一个像素都不动**（画在 `IgnorePointer` 里、允许溢出；
//      圆圈还是原来那么大、还在原来那个位置）。
//
// ── 两条纪律（与 `RecBlink` 一字不差）──────────────────────
//   ① 🔴 **永不结束的动画必须读那个总开关**（手册 §6.1.1 M1–M4）：
//      `models/motion_switch.dart` 的 `hupoAnimationsEnabled`。
//   ② 系统要求"少动"（`MediaQuery.disableAnimations`）⇒ 同一条路。
//   ⚠️ 关掉 / 没在听 ⇒ **一个像素都不画**（这是"运动"本身，不是一件静态的东西；
//      停在第 0 刻会凭空多出两圈线来），但**这一层照旧在树上**（M3：不动 ≠ 没有）。
//
// ⚠️ 判据：`test/widget/voice_blink_test.dart`（开着开关推帧量"真的在荡"；
//    关着开关量"一动不动"，而且不许超时）。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/motion_switch.dart';

/// 判据按它认这一层。
const Key listeningRippleKey = ValueKey<String>('listening-ripple');

/// **在听时那一圈涟漪**。
class ListeningRipple extends StatefulWidget {
  const ListeningRipple({super.key, required this.on});

  /// 现在该不该荡（＝正在听）。
  final bool on;

  @override
  State<ListeningRipple> createState() => _ListeningRippleState();
}

class _ListeningRippleState extends State<ListeningRipple> with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: d.listeningRipplePeriod);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // ⚠️ 只在这一处起步：`MediaQuery…Of(context)` 在 `initState` 里读会当场抛。
    _sync();
  }

  @override
  void didUpdateWidget(ListeningRipple old) {
    super.didUpdateWidget(old);
    _sync();
  }

  /// **现在该不该荡**（同一个判断只有这一处：`_sync` 与 `build` 都问它）。
  bool get _want =>
      widget.on && hupoAnimationsEnabled && !MediaQuery.disableAnimationsOf(context);

  /// 该荡就荡、该停就停（**同一个判断只有这一处**）。
  void _sync() {
    final want = _want;
    if (want && !_c.isAnimating) {
      _c.repeat();
    } else if (!want && _c.isAnimating) {
      _c.stop();
      _c.value = 0;
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      // ⚠️ 必须挂在 `_c` 上（每一帧重建一次）：`CustomPaint` 的 painter 是
      //    **建的时候**算出来的 —— 不挂的话 `t` 永远是 0，屏幕上根本不动。
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, _) => CustomPaint(
          key: listeningRippleKey,
          // ⚠️ 这一层**照旧在树上**（M3）；画不画由 painter 自己决定。
          painter: ListeningRipplePainter(t: _want ? _c.value : null),
          child: const SizedBox.expand(),
        ),
      ),
    );
  }
}

/// 把涟漪画出来（[t] 为 `null` ⇒ **一个像素都不画**）。
///
/// 🔴 纯画图 ⇒ 判据可以直接喂 `t` 量它画在哪（不用真跑动画）。
class ListeningRipplePainter extends CustomPainter {
  const ListeningRipplePainter({required this.t});

  /// 这一帧走到哪儿了（0…1 循环）；`null` = 不画。
  final double? t;

  /// 一圈的粗细。
  ///
  /// ★ **2026-10-07 主人**：*"我希望这个一圈圈波纹变得更明显一点，它可以扩散的更大一点。"*
  static const double ringWidth = 2.6;

  /// 最多荡出半径的多少（0 = 贴着圆圈边，1 = 再往外一个半径）。
  ///
  /// ★ 改前是 0.42（几乎看不出在荡）；现在 **0.95**（荡到将近两倍大）。
  static const double spread = 0.95;

  /// 最亮那一刻的不透明度（淡 —— 它只说"在动"，不该抢戏；但也不该看不见）。
  static const double peak = 0.46;

  /// **同时荡几条**（错开均分一轮）—— 三条比两条更像"一圈一圈接着出去"。
  static const int rings = 3;

  /// **这一帧该画哪两个圈**（**纯的** —— 判据直接量它，不用去 mock 一块画布）。
  ///
  /// @param t 0…1（循环）
  /// @param base 圆圈那一半的半径
  static List<({double r, double opacity})> ringsFor(double t, double base) {
    final out = <({double r, double opacity})>[];
    // 几条错开均分一轮，看起来是"一圈一圈接着荡出去"。
    for (var i = 0; i < rings; i += 1) {
      final p = (t + i / rings) % 1.0;
      out.add((
        r: base * (1 + spread * p),
        opacity: peak * (1 - p) * (1 - p),
      ));
    }
    return out;
  }

  @override
  void paint(Canvas canvas, Size size) {
    final T = t;
    if (T == null) return; // 不画（见文件头：这是运动本身）
    final center = Offset(size.width / 2, size.height / 2);
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = ringWidth;
    for (final ring in ringsFor(T, size.shortestSide / 2)) {
      canvas.drawCircle(center, ring.r, paint..color = d.accent.withValues(alpha: ring.opacity));
    }
  }

  @override
  bool shouldRepaint(ListeningRipplePainter old) => old.t != t;
}
