// 浏览器采到的采样 → 对面要的形状：**16k · 单声道 · 16bit 小端**。
//
// ⚠️ **纯函数**（`test/unit/pcm16_test.dart` 钉住）。为什么单独一个文件：
//    这一段错一个字节，对面收到的就是噪声，而**界面上"正在听"照样在转** ——
//    这种毛病靠眼睛看不出来，只能靠判据。而腾讯云混元 ASR 内测版
//    **只收 16k 单声道 PCM**（`docs/dev/69-ASR-ROUTES.md` §四·补），
//    麦克风给的却是 44.1k/48k 的浮点 ⇒ 这一跳是**必须**的一跳。
//
// ⚠️ `16000` 是**对面协议的常数**，不是"某个尺寸"（不是界面数值）：
//    它写在这儿，一次，且与 `src/asr-sign.js` 里 `voice_format=1` 那一边配套。

import 'dart:typed_data';

/// 对面要的采样率。
const int pcmRate = 16000;

/// 16bit 有符号的边界。
const int pcmMax = 32767;
const int pcmMin = -32768;

/// `[-1, 1]` 的浮点采样 → 16bit 小端字节。
///
/// * [sampleRate] 是**采到的时候**那个率（`AudioContext.sampleRate`，通常是 48000）。
/// * 比 [pcmRate] 高 ⇒ **按窗口平均**（不是隔几个丢一个：丢点会把声音弄脏）。
/// * 比 [pcmRate] 低 ⇒ 线性插值补上来（宁可插值，也不要送一个率不对的流）。
Uint8List pcm16FromFloat(List<double> samples, {required int sampleRate}) {
  if (samples.isEmpty || sampleRate <= 0) return Uint8List(0);
  // ⚠️ **至少一个**：只剩一个采样时也要吐出去一个（丢尾巴 = 丢字）。
  //    真实的块是 4096 个采样（≈85ms），走不到这一格；但判据要它成立。
  final want = (samples.length * pcmRate / sampleRate).floor();
  final count = want < 1 ? 1 : want;

  final bd = ByteData(count * 2);
  final ratio = sampleRate / pcmRate;
  for (var i = 0; i < count; i++) {
    double v;
    if (sampleRate == pcmRate) {
      v = samples[i];
    } else if (sampleRate > pcmRate) {
      // 平均：起点向下取整、终点向上取整，保证窗口不空（否则会读到 0 = 静音）
      final from = (i * ratio).floor();
      final to = ((i + 1) * ratio).ceil().clamp(from + 1, samples.length);
      var sum = 0.0;
      for (var j = from; j < to && j < samples.length; j++) {
        sum += samples[j];
      }
      v = sum / (to - from);
    } else {
      // 插值（采样率比对面低：这种情况罕见，但不能悄悄送错）
      final x = i * ratio;
      final j = x.floor();
      final f = x - j;
      final a = samples[j];
      final b = j + 1 < samples.length ? samples[j + 1] : a;
      v = a + (b - a) * f;
    }
    bd.setInt16(i * 2, _toInt16(v), Endian.little);
  }
  return bd.buffer.asUint8List();
}

/// **截幅**：超过 ±1 的不许绕回去（绕回去就是"爆音"，听感上是刺啦声）。
int _toInt16(double v) {
  if (v >= 1) return pcmMax;
  if (v <= -1) return pcmMin;
  final n = (v * pcmMax).round();
  if (n > pcmMax) return pcmMax;
  if (n < pcmMin) return pcmMin;
  return n;
}
