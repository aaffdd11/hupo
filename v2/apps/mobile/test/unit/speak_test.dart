// **"读出来"那一半**（主人 2026-09-23 定案：每条都能念 + 一个自动念开关）。
//
// 契约：`docs/dev/68-SPEAK.md`。这一份钉的是**控制器的行为**（界面那半在
// `test/widget/speak_test.dart`、开关那半在 `test/widget/voice_demo_test.dart`）：
//
//   ① 打开自动念 ⇒ 它**新说的话**会被念（念的是**那一条的原文**）
//   ② 🔴 **首屏那段历史不念**（一登录把它以前说过的话全念一遍 = 骚扰）
//   ③ 🔴 **没说完的不念**（半句 / 卡住 —— 念出来等于替它把话说圆）
//   ④ 🔴 **关掉开关要立刻停**（按钮说关、它还在念 = 这一族的假话）
//   ⑤ 🔴 **念不了就什么都不发生**（`speak` 回 false ⇒ 界面上不显示"正在念"）
//   ⑥ 一段念完（`onEnd`）⇒ 界面上的"正在念"复位
//
// ⚠️ 全程**注入一个假的合成器**（记账用）：判据不依赖真浏览器有没有音色。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/speech_store.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 假的"自动念"偏好仓（记账；不碰 shared_preferences）。
class FakeSpeechStore extends SpeechStore {
  FakeSpeechStore({this.initial = false});
  final bool initial;
  final List<bool> written = [];

  @override
  Future<bool> read() async => initial;

  @override
  Future<void> write(bool on) async => written.add(on);
}

/// 一个记账用的假合成器。
class FakeSpeaker {
  final List<String> spoken = [];
  int stops = 0;
  bool refuse = false;
  void Function()? _onEnd;

  bool speak(String text, {void Function()? onEnd}) {
    spoken.add(text);
    _onEnd = onEnd;
    return !refuse;
  }

  void stop() => stops++;

  /// 假装这一段念完了。
  void finish() => _onEnd?.call();
}

/// 一条**说完了的**助手回答（`message/start` → `text` → `end`）。
///
/// ⚠️ `from` 是号段起点：**同一份时间线里号必须往上涨**（服务端就是这么发的），
///    所以两组事件要用不同的号段 —— 复用号段会被时间线丢掉（判据会以
///    "念不出来"的形式红，而真原因是夹具自己把号写重了）。
List<Map<String, dynamic>> answer(String id, String text, {String reason = 'completed', int from = 10}) => [
  {'type': 'message/start', 'seq': from, 'messageId': id},
  {'type': 'message/text', 'seq': from + 1, 'messageId': id, 'block': 'quick', 'text': text},
  {'type': 'message/end', 'seq': from + 2, 'messageId': id, 'reason': reason},
];

Future<(ChatController, FakeSpeaker, FakeSpeechStore)> build({
  bool autoSpeak = false,
}) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final speaker = FakeSpeaker();
  final store = FakeSpeechStore(initial: autoSpeak);
  final c = ChatController(
    api: Api(base: 'http://127.0.0.1:1'),
    tokens: TokenStore(),
    speech: store,
    speak: speaker.speak,
    stop: speaker.stop,
  );
  await c.loadAutoSpeak();
  return (c, speaker, store);
}

void main() {
  test('★ 打开自动念 ⇒ 它新说的话被念出来（念的是那一条的原文）', () async {
    final (c, sp, _) = await build(autoSpeak: true);
    expect(c.autoSpeak, true, reason: '那一份偏好读出来了');
    c.ingest({'type': '__caught_up__'}); // 首屏那段历史读完了（这之后才算"刚说的"）
    for (final e in answer('m1', '北京今天多云，19 度。')) {
      c.ingest(e);
    }
    expect(sp.spoken, ['北京今天多云，19 度。']);
    expect(c.speakingId, 'm1', reason: '界面靠它把按钮变成"别念了"');
    c.dispose();
  });

  test('🔴 负向对照：关着 ⇒ 一个字都不念', () async {
    final (c, sp, _) = await build(autoSpeak: false);
    c.ingest({'type': '__caught_up__'});
    for (final e in answer('m1', '北京今天多云。')) {
      c.ingest(e);
    }
    expect(sp.spoken, isEmpty);
    expect(c.speakingId, isNull);
    c.dispose();
  });

  test('🔴 首屏那段**历史**不念（一登录把它以前说过的话全念一遍 = 骚扰）', () async {
    final (c, sp, _) = await build(autoSpeak: true);
    // 服务端还没说"首屏读完了"（`client/hello` 那条信号之前收到的都算历史）
    for (final e in answer('m_old', '这是很久以前说过的一句话。')) {
      c.ingest(e);
    }
    expect(sp.spoken, isEmpty, reason: '★ 历史不许念');
    // 读完历史之后新来的一条 ⇒ 要念
    c.ingest({'type': '__caught_up__'});
    for (final e in answer('m_new', '这一条是刚说的。', from: 100)) {
      c.ingest(e);
    }
    expect(sp.spoken, ['这一条是刚说的。']);
    c.dispose();
  });

  test('🔴 没说完的（半句 / 卡住 / 超时）不念 —— 念出来等于替它把话说圆', () async {
    final (c, sp, _) = await build(autoSpeak: true);
    c.ingest({'type': '__caught_up__'});
    var from = 10;
    for (final reason in ['failed', 'timeout', 'max-tokens']) {
      for (final e in answer('m_$reason', '这句还没说完……', reason: reason, from: from)) {
        c.ingest(e);
      }
      from += 10;
    }
    expect(sp.spoken, isEmpty, reason: '★ 只有 reason == completed 才念');
    c.dispose();
  });

  test('🔴 关掉开关 ⇒ **立刻停**（按钮说关、它还在念就是假话）', () async {
    final (c, sp, store) = await build(autoSpeak: true);
    c.ingest({'type': '__caught_up__'});
    for (final e in answer('m1', '第一句。')) {
      c.ingest(e);
    }
    expect(c.speakingId, 'm1');
    await c.setAutoSpeak(false);
    expect(sp.stops, 1, reason: '★ 关掉要真的停');
    expect(c.speakingId, isNull);
    expect(store.written, [false], reason: '偏好存盘了（下次开机还是关）');
    expect(c.autoSpeak, false);
    c.dispose();
  });

  test('★ 点了"读一遍" ⇒ 念这一条；再点"别念了" ⇒ 停', () async {
    final (c, sp, _) = await build();
    c.ingest({'type': '__caught_up__'});
    for (final e in answer('m1', '这一条要念。')) {
      c.ingest(e);
    }
    expect(sp.spoken, isEmpty, reason: '自动念关着 ⇒ 不主动念');
    c.speakMessage('m1', '这一条要念。');
    expect(sp.spoken, ['这一条要念。']);
    expect(c.speakingId, 'm1');
    c.stopSpeakingNow();
    expect(sp.stops, 1);
    expect(c.speakingId, isNull);
    c.dispose();
  });

  test('🔴 念不了（合成器拒绝）⇒ 不许显示"正在念"', () async {
    final (c, sp, _) = await build();
    sp.refuse = true;
    c.speakMessage('m1', '这一条念不出来。');
    expect(c.speakingId, isNull, reason: '交不出去就不该显示在念 —— 那是假状态');
    c.dispose();
  });

  test('★ 一段念完（onEnd）⇒ "正在念"复位', () async {
    final (c, sp, _) = await build();
    c.speakMessage('m1', '这一条。');
    expect(c.speakingId, 'm1');
    sp.finish();
    expect(c.speakingId, isNull, reason: '念完了要复位（不然按钮一直显示"别念了"）');
    c.dispose();
  });

  test('🔴 换个平台念不了的空文本：不念、也不显示在念', () async {
    final (c, sp, _) = await build();
    c.speakMessage('m1', '   ');
    expect(sp.spoken, ['   '], reason: '空文本由 speech.dart 那一层挡（界面上不会有这种调用）');
    c.dispose();
  });

  // ★ P1-2（2026-09-24）：`canSpeak` **不许再写死**。
  //   VM 上跑的是 `speech_stub.dart`（本来就 false），所以这条判据扫的是
  //   **Web 那一份源码**：它必须真的去问浏览器有没有音色。
  test('P1-2：speech_web 的 canSpeak 必须查音色（不许写死 true）', () {
    final src = File('lib/services/speech_web.dart').readAsStringSync();
    expect(src.contains('getVoices'), isTrue, reason: '要真的问浏览器有没有音色');
    expect(
      RegExp(r'const bool canSpeak = true').hasMatch(src),
      isFalse,
      reason: '写死 true ⇒ 没音色的浏览器上会画出一个按不动的开关（2026-09-23 实测到过）',
    );
  });
}
