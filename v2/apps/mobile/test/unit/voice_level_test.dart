// **录的时候那条音量轴**（纯逻辑，契约 `docs/dev/129` §十三）。
//
// 主人 2026-09-28：*"录音时，可以检测收到语音，并且给出一个录音时候的那种时间轴语音bar吗？"*
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   ① 采样夹到 0..1、窗口满了挤掉最老的（**最新在右**）；
//   ② 🔴 **"有没有声音"带迟滞**：不能一个字一停就"听得到/很安静"来回跳
//      （上沿 `onLevel`、下沿 `offLevel`、连续 `releaseSamples` 根才算翻回去）；
//   ③ 那句实话的**尺度**：说的是"听得到声音 / 很安静"，**不许**说成"听到你在说话了"
//      （我们手上只有电平，没有识别）；
//   ④ 一次都没采到时不画（`hasSignal == false`）；
//   ⑤ 走时那句（`已录 X.X 秒`）。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/hearing_words.dart';
import 'package:hupo_app/models/voice_level.dart';

void main() {
  test('① 采样夹到 0..1；窗口满了挤掉最老的（最新在右）', () {
    final m = LevelMeter(capacity: 3);
    m.push(-5);
    m.push(2);
    m.push(0.5);
    expect(m.samples, [0.0, 1.0, 0.5], reason: '★ 超范围的要被夹住（不然条会画到天上）');
    m.push(0.25);
    expect(m.samples, [1.0, 0.5, 0.25], reason: '★ 只能留 capacity 根，最老的走');
  });

  test('② 🔴 "有没有声音"带迟滞：一根高就翻上去，连续几根都低才翻回来', () {
    final m = LevelMeter(onLevel: 0.2, offLevel: 0.1, releaseSamples: 3);
    expect(m.hearingSound, false);
    expect(m.line, voiceRecQuiet);
    m.push(0.5);
    expect(m.hearingSound, true, reason: '★ 超过上沿 ⇒ 立刻"听得到"');
    expect(m.line, voiceRecHearing);
    // 掉到两个阈值**中间**：不算安静（这正是迟滞要挡的那一段）
    m.push(0.15);
    m.push(0.15);
    m.push(0.15);
    expect(m.hearingSound, true, reason: '★ 中间那一段（0.1~0.2）不许让它翻回去 —— 挡住了"抖"');
    // 连续三根都低于下沿 ⇒ 这回真的安静了
    m.push(0.0);
    m.push(0.0);
    m.push(0.0);
    expect(m.hearingSound, false, reason: '★ 连续 releaseSamples 根都低 ⇒ 才说安静');
    expect(m.line, voiceRecQuiet);
  });

  test('②·补 负向对照：**只有一根**低不许翻（否则一停顿就闪一下）', () {
    final m = LevelMeter(releaseSamples: 3);
    m.push(0.9);
    expect(m.hearingSound, true);
    m.push(0.0);
    m.push(0.9);
    m.push(0.0);
    expect(m.hearingSound, true, reason: '★ 只夹了一根低音 ⇒ 还是"听得到"');
  });

  test('③ 那一句的尺度：只说"听得到声音/很安静"（**不许**说成认出来了）', () {
    final m = LevelMeter();
    m.push(0.9);
    expect(m.line, voiceRecHearing);
    for (var i = 0; i < 10; i++) {
      m.push(0.0);
    }
    expect(m.line, voiceRecQuiet);
    // 负向对照：两句话里**不许**出现"说话 / 识别 / 听懂了"这一族（那是另一件事）
    for (final w in ['说话', '识别', '听懂', '认出来']) {
      expect(voiceRecHearing.contains(w), isFalse, reason: '★ 电平不等于识别：$w');
      expect(voiceRecQuiet.contains(w), isFalse, reason: '★ 电平不等于识别：$w');
    }
  });

  test('④ 一次都没采到 ⇒ hasSignal 假（界面据此**不画那条轴**）', () {
    final m = LevelMeter();
    expect(m.hasSignal, false);
    m.push(0.0);
    expect(m.hasSignal, true, reason: '★ 采到 0 也算"有读数"（只是安静）');
    m.clear();
    expect(m.hasSignal, false, reason: '★ 收手/重录之后要清干净（旧的那排会让人以为录到了）');
    expect(m.hearingSound, false);
  });

  test('⑤ 条高：开方压一下（轻声说话也看得见），而且 0..1', () {
    expect(LevelMeter.barHeight(0), 0);
    expect(LevelMeter.barHeight(1), 1);
    expect(LevelMeter.barHeight(0.25), closeTo(0.5, 1e-9), reason: '★ 开方：0.25 → 0.5');
    expect(LevelMeter.barHeight(-3), 0);
    expect(LevelMeter.barHeight(9), 1);
  });

  test('⑥ 走时那句：X.X 秒', () {
    expect(LevelMeter.elapsedLine(0), voiceRecElapsed('0.0'));
    expect(LevelMeter.elapsedLine(3400), voiceRecElapsed('3.4'));
    expect(LevelMeter.elapsedLine(3449), voiceRecElapsed('3.4'), reason: '★ 只到 0.1 秒（别跳来跳去）');
    expect(LevelMeter.elapsedLine(3450), voiceRecElapsed('3.5'), reason: '★ 四舍五入（不是截断）');
  });
}
