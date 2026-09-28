// **录的时候那条音量轴**（纯的：进一串采样，出"条画多高 / 该说哪句话"）。
//
// ── 主人 2026-09-28 的原话 ────────────────────────────────
//   *"录音时，可以检测收到语音，并且给出一个录音时候的那种时间轴语音bar吗？"*
//
// ── 它能说什么、不能说什么（先说清边界）──────────────────────
//   我们手上只有**音量**（振幅），**没有识别** ⇒
//   · 能说：**"听得到声音"** / **"这边很安静"**（这是对电平的**如实**描述）；
//   · 🔴 **不能说**："听到你在说话了" / "正在识别" —— 那要有识别结果才算数
//     （振幅分不出人声、音乐、关门声）。词表里那两句就按这个尺度写。
//
// ── 为什么单独一份纯逻辑 ────────────────────────────────────
//   ① "有没有声音"这件事**有迟滞**（不然一个字一停就闪：听到/安静/听到…），
//      而迟滞是要**判据钉**的（`test/unit/voice_level_test.dart`）；
//   ② 那条轴是**一窗子历史**（最新在右），窗口长度/曲线/阈值都住在这儿 ——
//      界面那份只管画。
//
// ⚠️ 楼层：住 `models/` ⇒ 不许 import flutter / services（`import_rules_test` 钉着）。

import 'dart:math' as math;

import 'hearing_words.dart';

/// 录的时候那条音量轴。
///
/// * [capacity] 一屏放多少根（**最多**留这么多历史，新的挤掉旧的）；
/// * [onLevel] 高于它 ⇒ 认为"有声音"；[offLevel] 低于它 ⇒ 认为"安静了"。
///   ⚠️ 两个阈值**不是**一回事（差那一截就是**迟滞**）：只用一条线的话，
///   声音在它附近抖，屏幕上就会"听得到/很安静"来回跳。
class LevelMeter {
  LevelMeter({
    this.capacity = 48,
    this.onLevel = 0.18,
    this.offLevel = 0.08,
    this.releaseSamples = 6,
  }) : assert(offLevel <= onLevel, '迟滞的下沿不许高过上沿');

  /// 一屏放多少根条（`push` 超出就挤掉最老的）。
  final int capacity;

  /// 高于它 ⇒ "有声音"。
  final double onLevel;

  /// 连续这么多根都低于 [offLevel] ⇒ "安静了"（**不是**一根就翻）。
  final int releaseSamples;

  /// 低于它 ⇒ 算安静那一侧。
  final double offLevel;

  final List<double> _samples = <double>[];
  bool _hearing = false;

  /// 现在留着的那些（**最老的在前、最新的在后** ⇒ 界面从右往左看时间）。
  List<double> get samples => List<double>.unmodifiable(_samples);

  /// 现在算不算"听得到声音"（带迟滞）。
  bool get hearingSound => _hearing;

  /// 有没有采到过东西（一次都没采到时**不画那条轴** —— 免得画一排 0 骗人）。
  bool get hasSignal => _samples.isNotEmpty;

  /// 进来一个采样（**0..1**，超出会被夹住）。
  void push(double raw) {
    final v = raw.isFinite ? raw.clamp(0.0, 1.0).toDouble() : 0.0;
    _samples.add(v);
    while (_samples.length > capacity) {
      _samples.removeAt(0);
    }
    if (!_hearing) {
      if (v >= onLevel) _hearing = true;
    } else {
      // 迟滞：连续 [releaseSamples] 根都低到安静那一侧才翻回去
      final tail = _samples.length < releaseSamples
          ? _samples
          : _samples.sublist(_samples.length - releaseSamples);
      if (tail.length >= releaseSamples && tail.every((x) => x < offLevel)) {
        _hearing = false;
      }
    }
  }

  /// 收手/重录：清干净（**留一段旧的在屏幕上会让人以为刚才那段录到了**）。
  void clear() {
    _samples.clear();
    _hearing = false;
  }

  /// 那一根该画多高（0..1）：**开方**压一下，不然轻声说话几乎看不见。
  static double barHeight(double v) => math.sqrt(v.clamp(0.0, 1.0));

  /// 下面那句实话（正在录的时候才说；**音量轴那条不是判据，只是应答**）。
  String get line => _hearing ? voiceRecHearing : voiceRecQuiet;

  /// 录了多久那句（`elapsedMs` 从按下那一刻算）。
  static String elapsedLine(int elapsedMs) {
    final s = (elapsedMs / 1000);
    return voiceRecElapsed(s.toStringAsFixed(1));
  }
}
