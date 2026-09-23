// **动效**（曲线与它为什么长这样）—— 界面层的东西，所以曲线住这儿（`design.dart` 不碰 UI 类型）。
//
// 主人 2026-09-24 定案（原话）：
// *"对于图标打开和关闭小程序，我希望动效的移动速度，不是线性的，而是越远越快，越近越慢。
//   大概在0.5秒内完成。"*
//
// ── 那句话翻译成数学 ──────────────────────────────────────
// "越远越快、越近越慢" = **速度与剩余距离成正比**（还剩得远就走得快，快到了就慢下来）：
//
//     dx/dt = k · (1 - x)        ⇒        x(t) = 1 - e^(−k·t)
//
// 归一到 `f(0)=0`、`f(1)=1`，就是下面这条 [FarFastCurve]。
//
// ⚠️ **为什么不用 Flutter 自带的 `easeOutCubic`**：它也是减速的，但**前段不够猛**
//    （t=0.25 时才走完 58%），主人看真站点时说的就是要"**越远**越快"。
//    这一条 t=0.25 已经走了 **79%**（k=5.5），尾段更黏 —— 观感上就是"甩过去、轻轻落"。
// ⚠️ 时长住 `design.dart` 的 [motionAppOpen]（0.5 秒，主人给的）。
// ⚠️ 纯函数（`test/unit/motion_curve_test.dart` 钉住形状）—— 曲线改了，判据会红。

import 'dart:math' as math;

import 'package:flutter/animation.dart';

/// 那条曲线本身。
///
/// @param k 越大 ⇒ 前段越猛、尾段越黏。**4.5** 是照主人那句话挑的：
///   t=0.25 走完 ≈71%、t=0.5 走完 ≈90% —— 剩下的 10% 用掉后半程（"轻轻落"）。
///   ⚠️ 再大（5.5 试过：t=0.25 就 79%）会"一晃就到了"，看不出是**动**的。
class FarFastCurve extends Curve {
  const FarFastCurve([this.k = 4.5]);

  final double k;

  @override
  double transformInternal(double t) {
    // 归一化：`x(t) = (1 - e^(−k·t)) / (1 - e^(−k))`
    return (1 - math.exp(-k * t)) / (1 - math.exp(-k));
  }
}

/// 图标 ⇄ 小程序那一层用它。
///
/// 🔴 **两个方向都要"越远越快、越近越慢"，所以不能直接倒放**（2026-09-24 发现的）：
///    · **打开**：位置从图标(0) → 全屏(1)，走 `f(u)`（前段猛）✓
///    · **关掉**：位置从全屏(1) → 图标(0)，要的是"刚离开屏幕时快、快回到图标时慢"
///      ⇒ 位置随**已用时间**是 `1 − f(u)`（对同一个 u，前段也猛）✓
///    ⚠️ 直接把控制器倒放（`p = f(1−u)`）会得到**相反**的观感：
///      刚开始几乎不动、最后猛地砸回图标 —— 那不是主人要的。
///    ⇒ 两个方向各算一次，见 `miniAppSurfaceProgress()`。
const Curve miniAppOpenCurve = FarFastCurve();

/// **这一刻"扩开"走到哪儿了**（0 = 还只有图标那么大，1 = 全屏）。
///
/// @param value 控制器当前值（0→1 是打开，1→0 是关掉）
/// @param closing 这一刻是在**关**吗（`AnimationStatus.reverse`）
///
/// ⚠️ 纯函数（判据 `test/unit/motion_curve_test.dart`）—— 两个方向都钉住。
double miniAppSurfaceProgress({required double value, required bool closing}) {
  final v = value.clamp(0.0, 1.0);
  // 打开：直接用曲线；关掉：把"已用时间"喂给曲线，再取反
  return closing
      ? 1 - miniAppOpenCurve.transform(1 - v)
      : miniAppOpenCurve.transform(v);
}
