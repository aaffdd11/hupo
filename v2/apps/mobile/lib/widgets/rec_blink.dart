// **在录时那颗圆圈的"一明一暗"**（主人 2026-10-05：*"录音按钮在激活的时候，
//   要有一个循环的效果，就是颜色一明一暗的闪烁。"*）。
//
// ── 它是什么、不是什么 ────────────────────────────────────
//   ✅ 是：一个**永不结束的呼吸**，把"亮度"（0…1）交给下面那一层去调底色。
//   🔴 不是：尺寸/位置/命中区**一个像素都不动**（那种"按钮在自己跳"反而更难按）。
//
// ── 两条纪律（与它前任 `rec_pulse.dart` 一字不差，因为它们是同一条；
//    那一份 2026-10-06 随没人用的输入框一起删了）─────────────
//   ① 🔴 **永不结束的动画必须读那个总开关**（手册 §6.1.1 M1–M4）：
//      `models/motion_switch.dart` 的 `hupoAnimationsEnabled`。
//      **关掉 ≠ 删掉**（M3）：关掉之后照旧画，只是**停在第 0 刻**。
//   ② 系统要求"少动"（`MediaQuery.disableAnimations`）⇒ 同一条路（静止那一帧）。
//
// ⚠️ 判据：`test/widget/voice_blink_test.dart`（关着开关量"停在第 0 刻"，
//    临时打开再推帧量"真的在变"）。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/motion_switch.dart';

/// 判据用它认"那颗圆圈现在在做那个呼吸"。
const Key recBlinkKey = ValueKey('recBlink');

/// **亮度那一条呼吸**：把 0…1 交给 [builder]（0 = 暗、1 = 亮）。
///
/// [on] 为假 ⇒ **一个像素都不动**（也停在第 0 刻），画的是同一棵子树。
class RecBlink extends StatefulWidget {
  const RecBlink({super.key, required this.on, required this.builder});

  /// 现在该不该闪（＝正在录）。
  final bool on;

  /// 拿"这一帧多亮"去画那颗圆圈。
  final Widget Function(BuildContext context, double glow) builder;

  @override
  State<RecBlink> createState() => _RecBlinkState();
}

class _RecBlinkState extends State<RecBlink> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: d.recBlinkPeriod);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // ⚠️ **只在这一处起步**：`disableAnimationsOf(context)` 是继承查询，
    //    在 `initState` 里读会当场抛（"called before initState completed"）。
    _sync();
  }

  @override
  void didUpdateWidget(RecBlink old) {
    super.didUpdateWidget(old);
    _sync();
  }

  /// 该动就动、该停就停（**同一个判断只有这一处**）。
  void _sync() {
    final want = widget.on && hupoAnimationsEnabled && !MediaQuery.disableAnimationsOf(context);
    if (want && !_c.isAnimating) {
      _c.repeat(reverse: true);
    } else if (!want && _c.isAnimating) {
      _c.stop();
      _c.value = 0; // 停在第 0 刻（M3：不动 ≠ 没有）
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // ⚠️ **不在录的时候也要经过这一层**（M3：那一层照旧在树上、照旧画）——
    //    所以这里不写 `if (!on) return child`，而是照旧走 builder（值恒 0）。
    return AnimatedBuilder(
      key: recBlinkKey,
      animation: _c,
      builder: (context, _) => widget.builder(context, widget.on ? _c.value : 0),
    );
  }
}

/// 这一帧的底色：在暗（[d.accent]）与亮（[d.accentLit]）之间按 [glow] 插值。
Color recBlinkColor(double glow) =>
    Color.lerp(d.accent, d.accentLit, glow.clamp(0.0, 1.0)) ?? d.accent;
