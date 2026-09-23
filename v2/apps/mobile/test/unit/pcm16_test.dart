// **麦克风采样 → 对面要的形状**（16k 单声道 16bit 小端）· 契约 `docs/dev/71-MIC-ASR.md`。
//
// 🔴 这一段错一个字节，对面收到的就是噪声，而**界面上"正在听"照样在转** ——
//    没有判据的话，这种毛病只能等主人听出来。⇒ 纯函数，钉在这儿。

import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/pcm16.dart';

/// 读出第 i 个 16bit 采样（小端）。
int at(Uint8List b, int i) => b.buffer.asByteData().getInt16(i * 2, Endian.little);

void main() {
  test('16k 进去 ⇒ 一个不差（只做量化）', () {
    final out = pcm16FromFloat([0, 0.5, -0.5, 1, -1], sampleRate: pcmRate);
    expect(out.length, 10); // 5 个采样 × 2 字节
    expect(at(out, 0), 0);
    expect(at(out, 1), (0.5 * pcmMax).round());
    expect(at(out, 2), (-0.5 * pcmMax).round());
    expect(at(out, 3), pcmMax);
    expect(at(out, 4), pcmMin);
  });

  test('★ 48k ⇒ 16k：**按窗口平均**，不是"隔两个丢一个"', () {
    // 三个一组：1,1,1 → 1；0,0,0 → 0；-1,1,0 → 0
    final samples = <double>[
      1, 1, 1, //
      0, 0, 0, //
      -1, 1, 0, //
    ];
    final out = pcm16FromFloat(samples, sampleRate: 48000);
    expect(out.length, 6); // 9 个采样 ÷ 3 = 3 个采样
    expect(at(out, 0), pcmMax);
    expect(at(out, 1), 0);
    // 平均 = 0（丢点法会得到 -1 → 一听就听得出是另一种东西）
    expect(at(out, 2), 0);
  });

  test('★ 平均 vs 丢点：交替信号必须被**摊平**（丢点法会留满幅）', () {
    // 48k 上 24kHz 那种交替（真实麦克风里对应很尖的高频噪声）：
    //   平均三个 ⇒ |1-1+1|/3 = 1/3；隔点丢 ⇒ 满幅。
    final samples = List<double>.generate(3000, (i) => i.isEven ? 1.0 : -1.0);
    final out = pcm16FromFloat(samples, sampleRate: 48000);
    final peak = List<int>.generate(out.length ~/ 2, (i) => at(out, i))
        .map((v) => v.abs())
        .reduce((a, b) => a > b ? a : b);
    expect(peak, lessThan(pcmMax ~/ 2));
    // 而且**每一格都摊过**：全在 1/3 那一档附近，不是一片 0
    expect(peak, greaterThan(pcmMax ~/ 10));
  });

  test('★ 截幅：超过 ±1 的不许绕回去（绕回去 = 刺啦声）', () {
    final out = pcm16FromFloat([1.4, -1.4, 2.0, -9.0], sampleRate: pcmRate);
    expect(at(out, 0), pcmMax);
    expect(at(out, 1), pcmMin);
    expect(at(out, 2), pcmMax);
    expect(at(out, 3), pcmMin);
  });

  test('短一段（比一个窗口还短）不崩、也不吐错东西', () {
    final out = pcm16FromFloat([0.25], sampleRate: 48000);
    expect(out.length, 2);
    expect(at(out, 0), (0.25 * pcmMax).round());
  });

  test('空的 / 采样率不像话的 ⇒ 空（绝不吐一个长度不对的流）', () {
    expect(pcm16FromFloat(const [], sampleRate: 48000), isEmpty);
    expect(pcm16FromFloat([1, 2, 3], sampleRate: 0), isEmpty);
    expect(pcm16FromFloat([1, 2, 3], sampleRate: -1), isEmpty);
  });

  test('比对面低（8k）⇒ 插值补上来，长度对得上', () {
    final out = pcm16FromFloat(List<double>.filled(800, 0.5), sampleRate: 8000);
    expect(out.length, 1600 * 2); // 1 秒 @16k
    expect(at(out, 0), (0.5 * pcmMax).round());
  });

  test('小端写对了（第 0 字节是低位）', () {
    final out = pcm16FromFloat([1], sampleRate: pcmRate);
    expect(out.length, 2);
    expect(out[0], pcmMax & 0xff);
    expect(out[1], (pcmMax >> 8) & 0xff);
  });
}
