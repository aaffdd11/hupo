// **麦克风什么时候开**（源码级判据）—— 只有这一条路能钉住它。
//
// 🔴 **主人 2026-10-06 报的原话**：*「语音处理有问题，开头说的话可能会少。」*
//
// **量出来的根子**：那两份实现（网页 / 安卓）原来都是
//   **先连上 → 跟对面说"我要开始了" → 等对面回 `asr/ready` → 这才去要麦克风**。
// 而"按下去"到"对面说能听"之间那一段时间里，**麦克风压根没开** ⇒
// 他开口那几个字**从来没被采到过**（采都没采，谁也补不回来）。
// 真读数（线上那条路 · 宿主 ⇒ 他自己的盒子 ⇒ 豆包）：**热 ~240 ms、冷启第一次 ~2.7 s**。
//
// ⇒ 现在的顺序：**按下去就要麦克风**，音频先往对面送（服务端那一侧本来就会把
//   "握上手之前到的音频"攒住、握上手立刻补发 —— `test/asr.test.js` 那条判据），
//   回头再验对面那句"能听"（失败就把麦克风收干净、如实说）。
//
// ⚠️ **为什么这一条必须做成"源码级"**：这两份实现是**平台专用**的
//   （`dart:html` / 原生 channel），在 VM 上跑不起来 —— 与 `mini_runtime_test.dart`
//   那些"只看接线在不在"的判据同一条路子。安卓那一侧另有一条**行为级**判据
//   （`hearing_native_test.dart` 的"立刻就要麦克风"），这里补的是**网页那一侧**
//   与"两份顺序必须一样"。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

String _read(String rel) => File(rel).readAsStringSync();

/// `src` 里 [first] 必须出现在 [second] **之前**（两处都要找得到）。
void _before(String src, String first, String second, String what) {
  final a = src.indexOf(first);
  final b = src.indexOf(second);
  expect(a >= 0, true, reason: '$what：找不到「$first」（判据要跟着它走，别让它悄悄漂走）');
  expect(b >= 0, true, reason: '$what：找不到「$second」');
  expect(a < b, true,
      reason: '★ $what：麦克风是**等完 `asr/ready` 才开**的 —— 那一段（实测热 240ms / 冷启 2.7s）里'
          '他开口的字全丢（主人报的"开头说的话可能会少"）');
}

void main() {
  test('🔴 网页那一份：**要麦克风**必须在「等对面说能听」之前', () {
    final web = _read('lib/services/hearing_web.dart');
    _before(web, 'await md.getUserMedia', 'await gate.future', '网页那一份');
  });

  test('🔴 安卓那一份：**要麦克风**也必须在「等对面说能听」之前（两份顺序一样）', () {
    final nat = _read('lib/services/hearing_native.dart');
    _before(nat, "invokeMethod<String?>('start')", 'await gate.future', '安卓那一份');
  });

  test('★ 负向对照：那两处"等对面"的字样还在（不然上面两条会变成空转）', () {
    // 上一条判据靠"两处都找得到"兜底，这一条把它说明白：**`asr/ready` 那道门还在**，
    //   只是它现在**只决定"要不要把麦克风收掉"**，不再决定"要不要开"。
    for (final f in ['lib/services/hearing_web.dart', 'lib/services/hearing_native.dart']) {
      final src = _read(f);
      expect(src.contains("t == 'asr/ready'"), true, reason: '★ $f：`asr/ready` 那道门不见了');
      expect(src.contains('await gate.future'), true, reason: '★ $f：验对面那一步不见了');
    }
  });
}
