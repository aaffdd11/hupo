// **非网页平台**：今天两条路 ——
//   · **安卓**（`speech_native.dart`，启动时钩子装进来）：系统自带的合成器；
//   · 其余（VM 上的 `flutter test` / iOS / 桌面）：**如实说念不出来**（不假装）。
//
// ⚠️ 这一份也是 `flutter test` 跑的那一份（`dart.library.html` 在 VM 上是假的）
//    ⇒ 判据里**不该看到"读一遍"那个按钮**；想验"点了会怎样"，
//    把钩子（或回调）**注入**进去测（见 `test/unit/speech_hook_test.dart`）。

import 'dart:async';

/// **原生那一份要做的三件事**（与 `hearing.dart` 的 `NativeHearingApi` 同一条路：
/// 条件导出只分得出"网页 / 非网页"，分不出"安卓 / 别的"）。
abstract class NativeSpeechApi {
  /// 这台设备念得出来吗（引擎没就绪 / 没有中文音色 ⇒ 假）。
  bool get canSpeak;

  /// 念一段。**真的交出去了**才回 `true`。
  bool speak(String text, {void Function()? onEnd});

  /// 停（关开关 / 离开这一屏都得停）。
  void stop();
}

/// **原生那一份**（`main.dart` 在 Android 上装；别处是 `null`）。
NativeSpeechApi? nativeSpeech;

/// 装钩子（**只在 Android 上调**）。
void installNativeSpeech(NativeSpeechApi api) {
  nativeSpeech = api;
}

/// 这个平台能不能把它说的话念出来。
///
/// ⚠️ 2026-10-05 由 `const bool` 改成**取值**：安卓那一份的引擎是**异步**就绪的
///    （`NativeTts` 的 `onInit`）⇒ 这个值会从假变成真 ⇒ 界面靠 [watchSpeakReady] 重建。
bool get canSpeak => nativeSpeech?.canSpeak ?? false;

/// **这台设备现在真的念得出来吗**（与 [canSpeak] 不是一回事：那个是"有没有那个能力"）。
///
/// ⚠️ 网页那一侧它是"浏览器给没给音色"；这一侧与 [canSpeak] 同值
///    （原生那一份的引擎起来了就是真念得出来）。
bool get speechHasVoices => nativeSpeech?.canSpeak ?? false;

/// 念不出来 ⇒ `false`（调用方据此**不画按钮**）。
bool speakAloud(String text, {void Function()? onEnd}) =>
    nativeSpeech?.speak(text, onEnd: onEnd) ?? false;

/// 没什么可停的（或者交给原生那一份停）。
void stopSpeaking() {
  nativeSpeech?.stop();
}

/// **能念了的那一刻**举手（原生那一份的引擎是异步起来的）—— 界面据此重建一次。
///
/// ⚠️ 与网页那一份（`speech_web.dart` 听 `voiceschanged`）**同一件事**：
///    不然那颗「播放语音」要等下一次别的原因重建才出现。
final List<void Function()> _readyWatchers = <void Function()>[];

void watchSpeakReady(void Function() onReady) {
  if (canSpeak) {
    // 已经能念 ⇒ 晚一步叫（`initState` 里同步 setState 是不许的）
    scheduleMicrotask(onReady);
    return;
  }
  _readyWatchers.add(onReady);
}

/// **原生那一份**：引擎就绪时叫这个（只会生效一次）。
void notifySpeechReady() {
  final ws = List<void Function()>.from(_readyWatchers);
  _readyWatchers.clear();
  for (final f in ws) {
    f();
  }
}
