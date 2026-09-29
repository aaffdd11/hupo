// **录音时那颗话筒上的脉动**（主人 2026-09-29：*"正在录音，就放到录音按钮上，
//   麦克风logo变成一个在闪动的bar"*）。
//
// ── 它说什么、不说什么（这条最重要）────────────────────────
// 🔴 它只说 **"我在录"**（状态），**不说声音多大** —— 聊天那颗话筒走的是**云端识别**
//    这一条路，我们**手上没有电平**（`services/hearing*.dart` 里没有那一路）。
//    ⇒ 那几根 bar 是**一起呼吸**的（相位错开），**不是**"按电平高低画"。
//    ⚠️ 主人当场选的就是这一档（另一档"真电平"要新接一路电平：网页从分析节点、
//      安卓从 `AudioRecord` 循环取 RMS —— 那是另一件事，见 `133` §五）。
//
// ── 两条纪律 ──────────────────────────────────────────────
//   ① 🔴 **永不结束的动画必须读那个总开关**（手册 §6.1.1 M1–M4）：
//      `models/motion_switch.dart` 的 `hupoAnimationsEnabled`。
//      **关掉 ≠ 删掉**（M3）：关掉之后照旧画，只是停在第 0 刻。
//   ② 系统要求"少动"（`MediaQuery.disableAnimations`）⇒ 同一条路（静止那一帧）。
//
// ⚠️ 它不是按钮（按钮是它外面那颗）⇒ 不涉及 D3.6 的命中区；尺寸住 `design.dart`。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/motion_switch.dart';

/// 判据用它认"那颗话筒现在在脉动"（= 正在录）。
const Key recPulseKey = ValueKey('recPulse');

/// 那几根 bar（一起呼吸，相位错开）。
class RecPulse extends StatefulWidget {
  const RecPulse({super.key, this.color = d.amber, this.bars = d.recPulseBars});

  /// 条的颜色（默认琥珀 —— 与"正在录"这套一致）。
  final Color color;

  /// 画几根。
  final int bars;

  @override
  State<RecPulse> createState() => _RecPulseState();
}

class _RecPulseState extends State<RecPulse> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: d.recPulsePeriod,
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // ⚠️ **只在这一处起步**：`disableAnimationsOf(context)` 是**继承**查询，
    //    在 `initState` 里读会当场抛（"called before initState completed"）。
    //    `didChangeDependencies` 紧跟 `initState` 跑一次，之后依赖变了还会再跑 ⇒ 够了。
    _sync();
  }

  /// 该动就动、该停就停（**同一个判断只有这一处** —— 手册记着一次"写两处"的事故）。
  void _sync() {
    final want = hupoAnimationsEnabled && !MediaQuery.disableAnimationsOf(context);
    if (want && !_c.isAnimating) {
      _c.repeat();
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
    return SizedBox(
      key: recPulseKey,
      height: d.recPulseBarMax,
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, _) => Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            for (var i = 0; i < widget.bars; i++) ...[
              if (i > 0) const SizedBox(width: d.levelBarGap),
              Container(
                width: d.levelBarWidth,
                // **一起呼吸、相位错开**：第 i 根比第 0 根晚一点 ⇒ 看起来像"在动"
                // ⚠️ 这一条**不读任何电平**（见文件头那条"它说什么"）。
                height: _heightAt(i),
                decoration: BoxDecoration(
                  color: widget.color,
                  borderRadius: BorderRadius.circular(d.levelBarWidth / 2),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  double _heightAt(int i) {
    final phase = (_c.value + i / widget.bars) % 1.0;
    // 0 → 1 → 0 的一条平滑呼吸（`sin` 的绝对值那一族；不用动画曲线也能读）
    final breath = 1 - (phase * 2 - 1).abs(); // 0..1..0
    return d.recPulseBarMin + (d.recPulseBarMax - d.recPulseBarMin) * breath;
  }
}
