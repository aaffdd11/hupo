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
// ⇒ 现在的顺序：**按下去就要麦克风**。
//
// 🔴 **2026-10-06 第二处（同一天、同一个症状的第二个根）**：主人又说了一遍
//   *"我说话以后，没有直接显示语音转换文字，响应很慢，然后真正出现的时候，
//   前面的几个字可能会不见。"* —— 换了新顺序之后**还剩一个洞**：这两份实现
//   仍然**先 `await` 那条连接握上手，再往下开麦**，而"握上手"冷启那一下真量到
//   **4.4 秒**（热 10~25ms）⇒ 那几秒里还是一样丢。
//   ⇒ 现在连"等连接"也不等了：**采集与连接并行**，音频先在**本机**攒着
//     （`models/asr_outbox.dart`），一握上手就按顺序补发（服务端那一侧同样有一份
//     攒法：`src/asr-doubao.js` 的队列／判据「连上之前推的音频不丢」）。
//   ⇒ 这一份现在钉三件事：① 开麦在"验对面"之前；② **开麦也在"等连接"之外**
//     （连接那条 `await …ready` 必须住在一个**不被 await 的闭包**里）；
//     ③ 音频走 **outbox**（没连上攒着、连上按顺序补发）。
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

  test('🔴 两份实现：开麦**也不在"等连接"里面**（连接那条 await 住在不被 await 的闭包里）', () {
    for (final (f, ready) in [
      ('lib/services/hearing_web.dart', 'await ch.ready'),
      ('lib/services/hearing_native.dart', 'await w.ready'),
    ]) {
      final src = _read(f);
      // ⚠️ 注释里也会出现这几个字样（这一份的批注就在讲原来那行）⇒ 从那个闭包**往后找**。
      final iStart = src.indexOf('unawaited(() async {');
      expect(iStart >= 0, true,
          reason: '★ $f：那条"握上手"的 await 不在 `unawaited(() async {…}())` 里 —— '
              '它会被 await ⇒ 冷启那 4.4 秒里麦克风还没开（他开头那几个字就没了）');
      final iReady = src.indexOf(ready, iStart);
      expect(iReady > iStart, true,
          reason: '★ $f：`$ready` 没住进那个不被 await 的闭包（找到的是注释里那一处吗）');
    }
  });

  test('🔴 两份实现：音频走 outbox（没连上攒着、连上补发）', () {
    for (final f in ['lib/services/hearing_web.dart', 'lib/services/hearing_native.dart']) {
      final src = _read(f);
      expect(src.contains('outbox.add('), true, reason: '★ $f：采到的音频没进 outbox');
      expect(src.contains('outbox.open()'), true,
          reason: '★ $f：握上手那一下没有把攒着的补发出去（攒了就白攒）');
    }
  });

  test('★ 预热那条路（`205`）：两份都"先取热的" ＋ 预热**自己不发 asr/start**', () {
    final web = _read('lib/services/hearing_web.dart');
    final nat = _read('lib/services/hearing_native.dart');
    // ① 按下那一刻**先取热的那条**（取不到才现连）
    for (final (f, src) in [('lib/services/hearing_web.dart', web), ('lib/services/hearing_native.dart', nat)]) {
      expect(src.contains('_takeWarm()'), true,
          reason: '★ $f：按下那一刻没有先取"热着的那条" ⇒ 预热白做（冷连那 1.1~4.4 秒还在按键那条路上）');
      expect(src.contains('final warm = _takeWarm();'), true, reason: '★ $f：取得太晚 / 取的地方不对');
    }
    // ② **预热那一段里不许出现 `asr/start`**：一出现就等于"一进聊天就把上游开了"（花钱）
    for (final (f, src, head) in [
      ('lib/services/hearing_web.dart', web, 'Future<void> warmHearing('),
      ('lib/services/hearing_native.dart', nat, 'Future<void> warmNativeHearing('),
    ]) {
      final i = src.indexOf(head);
      expect(i >= 0, true, reason: '★ $f：找不到那份预热的实现（`$head`）');
      final end = src.indexOf('\n}', i);
      final body = src.substring(i, end < 0 ? src.length : end);
      expect(body.contains('asr/start'), false,
          reason: '🔴 $f：预热那一段里出现了 `asr/start` —— 那一下就把上游开了（花钱）；预热只许"先连上"');
    }
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
