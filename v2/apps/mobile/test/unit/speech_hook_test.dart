// **"念出来"那个钩子**（`services/speech.dart` 选出来的那一份是"按平台分的"）。
//
// 三种平台今天是这样：
//   · **网页**：`speech_web.dart`（条件导出选的）—— 不在这一份判据的范围里；
//   · **安卓**：`speech_native.dart` 装钩子（`main.dart` **只在 Android** 上调）；
//   · **其余**（VM 上的 `flutter test` / iOS / 桌面）：没有钩子 ⇒ **如实说念不出来**。
//
// 这一份钉四件（每件都带反例）：
//   ① 🔴 **没装钩子 ⇒ 念不出来，而且一个字节都不许假装念了**（VM 就是这一档）；
//   ② 🔴 **装了钩子 ⇒ 值跟着钩子走**（`canSpeak` / `speakAloud` 的返回值与文本）；
//   ③ 🔴 **`watchSpeakReady`**：没就绪时先记着、就绪时**举手一次**（界面据此重建）；
//      已经就绪时**晚一步**也叫一次（`initState` 里同步 setState 是不许的）；
//   ④ 🔴 **那两条 channel 名字两边逐字一致**（Kotlin 与 Dart 各写了一遍）。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/services/speech_stub.dart';

/// 一个"装上去"的假原生：念过什么、停过几次都记着。
class _FakeSpeech implements NativeSpeechApi {
  _FakeSpeech({this.ready = true});

  bool ready;
  final List<String> spoken = <String>[];
  int stops = 0;

  @override
  bool get canSpeak => ready;

  @override
  bool speak(String text, {void Function()? onEnd}) {
    spoken.add(text);
    return ready;
  }

  @override
  void stop() => stops += 1;
}

void main() {
  tearDown(() => nativeSpeech = null);

  test('① 🔴 没装钩子（＝VM / iOS / 桌面）⇒ 念不出来，而且**不假装念了**', () {
    nativeSpeech = null;
    expect(canSpeak, false, reason: '★ 没钩子还说自己能念 = 摆一颗按不动的按钮');
    expect(speakAloud('你好'), false, reason: '★ 交不出去就得回 false');
    // 负向对照：那一句也不该被谁记下来（没有"谁"）
    stopSpeaking(); // 不许抛
  });

  test('② 🔴 装了钩子 ⇒ 值跟着钩子走（文本逐字交出去）', () {
    final fake = _FakeSpeech();
    installNativeSpeech(fake);
    expect(canSpeak, true);
    expect(speakAloud('明天晴。'), true);
    expect(fake.spoken, ['明天晴。'], reason: '★ 交出去的必须是那一段正文');
    stopSpeaking();
    expect(fake.stops, 1);

    // 负向对照：钩子说"这台念不出来" ⇒ 整条路都当念不出来
    fake.ready = false;
    expect(canSpeak, false);
    expect(speakAloud('明天晴。'), false);
  });

  test('③ 🔴 `watchSpeakReady`：没就绪先记着、就绪时举手一次；已经就绪则晚一步叫', () async {
    final fake = _FakeSpeech(ready: false);
    installNativeSpeech(fake);
    var called = 0;
    watchSpeakReady(() => called += 1);
    expect(called, 0, reason: '★ 还没就绪就先叫 = 那颗按钮出现在一个念不出来的时刻');

    // 引擎就绪（Kotlin 那半会叫这个）
    fake.ready = true;
    notifySpeechReady();
    expect(called, 1, reason: '★ 就绪了却不举手 ⇒ 那颗按钮要等下一次别的原因重建才出现');
    notifySpeechReady();
    expect(called, 1, reason: '★ 举了两次手 = 界面白重建一次（而且"只叫一次"是我写下的承诺）');

    // 已经就绪之后再挂 ⇒ **晚一步**叫（不是不叫）
    var late = 0;
    watchSpeakReady(() => late += 1);
    expect(late, 0, reason: '★ 同步就叫的话会在 `initState` 里 setState（Flutter 不许）');
    await Future<void>.delayed(Duration.zero);
    expect(late, 1);
  });

  test('④ 🔴 `hupo/tts` 那个名字：Kotlin 与 Dart 两边逐字一致（写错 = 静默不工作）', () {
    final kt = File('android/app/src/main/kotlin/chat/hupo/hupo_app/MainActivity.kt');
    final dart = File('lib/services/speech_native.dart');
    expect(kt.existsSync(), isTrue, reason: '找不到 MainActivity.kt');
    expect(dart.existsSync(), isTrue, reason: '找不到 speech_native.dart');
    expect(kt.readAsStringSync().contains('TTS_CHANNEL = "hupo/tts"'), isTrue,
        reason: '★ Kotlin 那一侧的 channel 名字变了');
    expect(dart.readAsStringSync().contains("_channelName = 'hupo/tts'"), isTrue,
        reason: '★ Dart 那一侧的 channel 名字变了');
    // 而装钩子那一行**只许在 Android 上**（与录音/开麦同一个道理）
    final main = File('lib/main.dart').readAsStringSync();
    final i = main.indexOf('installNativeTts()');
    expect(i > 0, isTrue, reason: '★ `main.dart` 里没有装它 —— 安卓上那颗按钮永远不会出现');
    final before = main.substring(0, i);
    expect(before.contains('TargetPlatform.android'), isTrue,
        reason: '★ 装它那一句不在 Android 分支里（别的平台会拿到一个念不出来的钩子）');
    expect(main.contains("import 'services/speech_native.dart';"), isTrue);
  });
}
