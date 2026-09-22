// **桌面那一层底图**（手册 `08-SPEC.md` §六 Z4：桌面铺满整屏）。
//
// ── 这是什么 ──────────────────────────────────────────────
// 主人 2026-09-22：*"给登录后的桌面增加一个动态背景，有水面波纹状。"*
//
// 形状上**只做一件事**：在桌面那层纸底上叠加**慢慢扩开的同心水波** ——
// 一圈一圈从屏幕外某个点往外漾，同时整圈微微摆动（所以它看起来是**水**，
// 不是一圈圈规规矩矩的靶子）。
//
// ── 五条它是怎么被约束住的（都不是随手定的）─────────────────
//   ① 🔴 **它只是背景，不许吃掉点击**。主人原话是"桌面增加一个背景" ——
//      背景如果可点，"点桌面空白 = 收起聊天"（§6.3 交互表）就当场失效。
//      ⇒ 整层 `IgnorePointer`（不透传、不改层级，就是**不参与命中**）。
//   ② 🔴 **它是纯装饰，一个字都不说**。界面上多一句话就多一样要学的
//      （`forbidden_words.dart`、D3.8 那套用词纪律）⇒ 这里面没有任何文字。
//   ③ ⚠️ **不动图标的命中区与排布**（D3.6 ≥44 是硬闸）：它在 `Stack` 的
//      **下面那一层**，图标墙照旧是它上面那一层。
//   ④ 🔴 **动画要能被关掉**（两条独立的理由，见下）。
//   ⑤ ⚠️ **不写死尺寸**：半径、线的粗细、点与点的间距全**按屏幕算**
//      （手册 D3：写死尺寸 = 缺陷）。
//
// ── ④ 展开说：为什么必须有个总开关 ───────────────────────────
//   · **测试**：`pumpAndSettle()` 的循环是 `while (binding.hasScheduledFrame)` ——
//     一个**永不结束**的动画会让它转到 10 分钟超时（实测：探针测试当场
//     `pumpAndSettle timed out`）。而 `test/widget/` 里有**一百多处**在用 pumpAndSettle，
//     ⇒ 默认开着动画 = 把整套界面闸变成红的（而且红的理由是"测试挂了"，
//     不是"这个功能坏了"）。⇒ 测试在 `test/flutter_test_config.dart` 一处把它关掉。
//   · **系统说"少动一点"**：用户开了"减弱动态效果"时，一个一直动的水面
//     对前庭敏感的人是**实打实的难受**，而它**一点信息都不承载**（纯装饰）
//     ⇒ 尊重那个开关（这跟 D3.5"不封顶字号"是同一类：**别假装支持**）。
//   ⚠️ 所以 `debugAnimate` 的默认值是 **true**（线上就是动的），
//     关它的只有那两处，而且各自都写明了理由。

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../models/design.dart' as d;

/// **水波那几圈的周期**（秒）。
///
/// ⚠️ 它是**这个效果的心跳**，不是随手写的数：
///   · 太快 = 像洗衣机，而且每一帧都在抢注意力（背景不该抢）；
///   · 太慢 = 看着像卡住了（"没有动画的界面看起来像坏了"，`53-MOTION.md` 同一句话）。
/// ⚠️ 上面那圈"围着圆心走一圈"的摆动**恰好也是一个周期** ⇒ 眼睛看到的是
///    "涟漪一边扩一边被水推着晃"，而不是两套各走各的动画。
const double waterRipplePeriod = 7.5;

/// **动画交给屏幕几帧**。
///
/// ⚠️ 这里**故意比屏幕慢**（60ms ≈ 16 帧/秒）：它是背景，16 帧和 60 帧
///    在观感上分不出来，但**手机上省下来的电是实打实的**
///    （而且真正的"丝滑"由下面那条按屏幕算的插值负责，不靠帧率）。
const Duration waterRippleFrame = Duration(milliseconds: 60);

/// **这一层现在动不动**。
///
/// ⚠️ 默认 **true**：线上就是要动的。关掉它只有两处，且都写明了理由 ——
///    测试（`test/flutter_test_config.dart`）与"系统要求减弱动态效果"。
bool debugWaterRippleAnimates = true;

/// **水面背景**。
///
/// [animate] = `false` ⇒ **一个像素都不画**（只留纸底）。
///
/// ⚠️ 为什么"不画"而不是"画一张静止的水面"：静止的同心圈看起来像**靶子**，
///    比没有更难看；而纯装饰在"能省就省"的时候**最该省的就是它**。
class WaterBackground extends StatefulWidget {
  const WaterBackground({super.key, this.animate = true});

  /// 动吗。⚠️ 调用方（`AppDesktop`）会把它和上面那个总开关一起算好。
  final bool animate;

  @override
  State<WaterBackground> createState() => _WaterBackgroundState();
}

class _WaterBackgroundState extends State<WaterBackground>
    with SingleTickerProviderStateMixin {
  /// ⚠️ **它不在这里 `..repeat()`** —— 起没起由 `_run()` 一处决定
  ///    （两头各写一遍"什么时候动"，迟早会分叉）。
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 10000),
  );

  /// `ticker == null` 时用来当钟（`elapsed` 是单调的，不会因为改系统时间跳）。
  final Stopwatch _clock = Stopwatch()..start();

  @override
  void initState() {
    super.initState();
    _run();
  }

  @override
  void didUpdateWidget(covariant WaterBackground old) {
    super.didUpdateWidget(old);
    // ⚠️ 开关变了要**立刻**反映（比如用户中途开了"减弱动态效果"）
    if (widget.animate != old.animate) _run();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  /// **动，还是不动**（唯一一处判断）。
  ///
  /// ⚠️ 它读 [_on]（`build()` 算好的那个），**不是**自己再算一遍 ——
  ///    两头各算一遍的话，"减弱动态效果"这个条件一定会漏掉一处：
  ///    `initState` 里没有 `context`，算不出 `MediaQuery`。
  void _run() {
    if (_on) {
      if (!_c.isAnimating) _c.repeat();
    } else {
      if (_c.isAnimating) _c.stop();
    }
  }

  /// 现在该不该动（`build()` 里算 → 这里读；默认不动，等第一帧算出来再说）。
  bool _on = false;

  @override
  Widget build(BuildContext context) {
    // 🔴 **尊重"减弱动态效果"**（理由见文件头 ④）。
    //    ⚠️ 不能把它算进 `_run()`：那是 `initState` 里跑的，那时**还没有 context**。
    final reduce = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    // 🔴 **三个条件的**与**（`_on` 就是这里算出来的唯一一份）：
    //      调用方说动 · 总开关说动 · 系统没要求少动。
    //    ⚠️ 2026-09-22 这里**漏过**总开关一次：测试里 `debugWaterRippleAnimates=false`
    //       读出来是对的，动画却照跑 ⇒ 7 条判据 `pumpAndSettle timed out`。
    //       这就是"同一个判断写两处"的形状（测试里只有一条断言拦得住它：
    //       `test/widget/water_bg_test.dart` 那条"pumpAndSettle 不挂"）。
    _on = widget.animate && debugWaterRippleAnimates && !reduce;

    // ⚠️ 变了（比如用户中途开了"减弱动态效果"）⇒ 这一帧画完之后去动 ticker。
    //    ⚠️ **不在 `build` 里直接动**（`_c.repeat()` 会排下一帧 —— build 期间干这个
    //       是 Flutter 明令不许的那种"边建边改"）。
    if (_on != _lastOn) {
      _lastOn = _on;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _run();
      });
    }

    // ⚠️ **不动的时候它也在树上、也画**（只是画第 0 刻那一帧）：
    //    `_run()` 只决定"ticker 转不转"。⛔ 千万别写成 `if (!_on) SizedBox.expand()`
    //    —— 那样"关掉动画"会顺手把这一层**删掉**，而删掉之后没有任何东西看着它
    //    （关掉的理由有两个：测试，以及用户开了"减弱动态效果"；
    //      后者少一层背景光，两张截图看起来"差不多"，没人会发现）。
    return IgnorePointer(
      child: RepaintBoundary(
        child: _on
            ? ListenableBuilder(
                listenable: _c,
                builder: (ctx, _) => CustomPaint(
                  // ⚠️ 时间从**钟**来，不从 `_c.value` 来：`_c` 只负责"每 60ms 叫我一次"
                  //    （它的 10 秒周期与 `waterRipplePeriod` 无关，别把两个数绑在一起）。
                  painter: WaterRipplePainter(
                    seconds: _clock.elapsedMicroseconds / 1e6,
                  ),
                  child: const SizedBox.expand(),
                ),
              )
            // 不动 ⇒ 固定在第 0 刻（同一笔画、只是不走时间）
            : const CustomPaint(
                painter: WaterRipplePainter(seconds: 0),
                child: SizedBox.expand(),
              ),
      ),
    );
  }

  /// 上一次算出来的开关（只在**真的变了**的时候去动 ticker）。
  bool? _lastOn;
}

/// 一圈涟漪在某一刻的读数（**纯数据**，给画家用；也是这一层唯一的"事实"）。
@immutable
class RippleRing {
  const RippleRing({required this.radius, required this.opacity});

  final double radius;

  /// 0–1。
  final double opacity;
}

/// **水面涟漪的几何**（纯函数 —— ⚠️ 别把这段塞进 `paint()` 里：
/// 塞进去就只能靠肉眼验，而这里能直接算）。
///
/// 形状是**一圈一圈往外漾**：
///   · 每一圈从 0 长到 [extent]；
///   · 长到一半时最亮（刚冒出来和快散掉时都淡）⇒ `sin(π·x)`；
///   · 每一圈的"出场时间"错开（**这是看起来像水、而不是像脉冲的关键**）。
///
/// [phase] = 已过的周期数（可以是小数）。[extent] = 要长到多远（一般在屏幕对角线上）。
List<RippleRing> rippleRings(double phase, double extent, {int count = 5}) {
  final out = <RippleRing>[];
  for (var i = 0; i < count; i++) {
    // ⚠️ 相位错开用的是**黄金比**（0.618…）：它是最"不均匀得均匀"的那个数 ——
    //    等分（i/count）会让五圈排成一条整齐的队；黄金比让它们的间距**永远对不齐**，
    //    那才像水面上此起彼伏的圈。
    final x = (phase + i * 0.6180339887498949) % 1.0;
    // 内圈刚冒头时把外圈压住一点，免得五圈同时亮到刺眼
    out.add(RippleRing(
      radius: extent * x,
      opacity: math.sin(math.pi * x),
    ));
  }
  return out;
}

/// **水面那一笔**（画在桌面纸底上，图标墙下面）。
///
/// ⚠️ 它**只画装饰**：不画任何文字、不碰任何命中区。
class WaterRipplePainter extends CustomPainter {
  const WaterRipplePainter({required this.seconds});

  /// 从这一层出现到现在过了多久（秒）。
  final double seconds;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    // 要长到多远：屏幕对角线 × 1.2（留出摆动的余量）。
    // ⚠️ 用对角线而不是宽或高：竖屏上"从中心往外"的距离是对角线的一半，
    //    用宽度算的话，上下两头永远漾不到边。
    final extent = math.sqrt(size.width * size.width + size.height * size.height);
    final center = size.center(Offset.zero);
    final phase = seconds / waterRipplePeriod;

    // 到底能画多大（外圈漾出去也要画得下）
    final reach = extent * 1.6;

    // 落点那一小块：涟漪是从这儿漾出去的（看不见它，圈会像凭空出现）。
    // ⚠️ **先画它、再画圈**：反过来的话这层淡色会盖在圈上、把涟漪洗掉。
    // ⚠️ 用**一次**径向渐变（不是每帧画一个模糊圆 —— 那是手机上最贵的那种画法）。
    canvas.drawCircle(
      center,
      reach,
      Paint()
        ..shader = RadialGradient(
          colors: [
            d.accent.withValues(alpha: 0.045),
            d.paper.withValues(alpha: 0.0),
          ],
        ).createShader(Rect.fromCircle(center: center, radius: reach)),
    );

    for (final ring in rippleRings(phase, extent)) {
      if (ring.radius <= 0) continue;
      final path = Path();
      const steps = 180; // 720 段在这个半径上肉眼看不出，180 段够了
      for (var k = 0; k <= steps; k++) {
        final a = 2 * math.pi * k / steps;
        // ★ **摆了多远**：围着圆心转一圈正好一次（所以眼睛看到的是
        //   "这圈涟漪被水推着晃"，而不是"这个圆在抖"）。
        //   ⚠️ 它跟内圈还是外圈无关 ⇒ 水面的摆动是**整体的**，符合直觉。
        final r = ring.radius + math.sin(a + 2 * math.pi * phase) * ring.radius * 0.03;
        final p = center + Offset(math.cos(a) * r, math.sin(a) * r);
        if (k == 0) {
          path.moveTo(p.dx, p.dy);
        } else {
          path.lineTo(p.dx, p.dy);
        }
      }
      // ⚠️ **线宽按屏幕算**（D3：不写死尺寸）
      final stroke = size.shortestSide * 0.006;
      canvas.drawPath(
        path,
        Paint()
          // 陶土红压到 6%–7%：它是**纸底上的一点光**，不是一圈红圈
          //（比 `landing` 那些卡片淡得多，别抢图标）
          // ⚠️ 2026-09-22 从 3.5% 提到 6.5%：**3.5% 在真屏幕上看不出来**
          //    （线上的截图里那层水几乎是白的 —— 那就不叫"加了背景"）。
          //    幅度是**量出来的**，不是拍脑袋：见 `60-WATER-BG.md` §六。
          ..color = d.accent.withValues(alpha: 0.065 * ring.opacity)
          ..style = PaintingStyle.stroke
          ..strokeWidth = stroke,
      );
      // 再叠一层更细更淡的白：看起来像水面反光的那道亮边
      canvas.drawPath(
        path,
        Paint()
          ..color = Colors.white.withValues(alpha: 0.09 * ring.opacity)
          ..style = PaintingStyle.stroke
          ..strokeWidth = stroke * 0.5,
      );
    }
  }

  @override
  bool shouldRepaint(covariant WaterRipplePainter old) =>
      old.seconds != seconds;
}
