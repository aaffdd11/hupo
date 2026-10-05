// **安卓那一份：念出来**（主人 2026-10-05：*"如果开启，会将对 agent 的回复进行语音转换
//   和实时播报。"*）。
//
// 契约：`docs/dev/189-VOICE-BAR-BUTTONS.md`。
//
// ── 三条与网页那一份（`speech_web.dart`）一字不差 ─────────────
//  ① 🔴 **一个字节都不往外发**：交给**系统自带**的合成器（`android.speech.tts`，
//     也就是 `NativeTts.kt`）—— 与"系统读任何一段文字"是同一件事，不是我们在传。
//  ② 🔴 **念不出来就不画那颗按钮**：引擎装不上 / 没有中文音色 ⇒ 这条口如实回假
//     （`canSpeak`）⇒ 界面上那颗按钮不出现。
//  ③ **一次只念一段**：新的开念之前先 `stop()`（原生那半做）；关开关 / 离开这一屏也停。
//
// ⚠️ 引擎初始化是**异步**的：Kotlin 那半就绪之后会主动回一条 `ready`
//    ⇒ 这里转成 `notifySpeechReady()`（界面据此重建一次，那颗按钮才出现）。
//
// ⚠️ 这一份**只在 Android 上被装**（`main.dart`），别处不 import 它的任何行为；
//    它自己不 import `dart:io` / `dart:html` ⇒ 进 Web 那条编译链也没事（只是一直是死的）。

import 'package:flutter/services.dart';

import 'speech_stub.dart';

/// 与 Kotlin 那一侧（`MainActivity.TTS_CHANNEL`）**必须逐字一致**。
const String _channelName = 'hupo/tts';

class _NativeSpeech implements NativeSpeechApi {
  _NativeSpeech() {
    _ch.setMethodCallHandler(_onCall);
  }

  final MethodChannel _ch = const MethodChannel(_channelName);

  /// 引擎就绪了没有（Kotlin 那半说了算）。
  bool _ready = false;

  /// 正在念那一段的收尾回调（念完 / 出错都要**放手**）。
  void Function()? _onEnd;

  @override
  bool get canSpeak => _ready;

  @override
  bool speak(String text, {void Function()? onEnd}) {
    final t = text.trim();
    if (!_ready || t.isEmpty) return false;
    _onEnd = onEnd;
    // ⚠️ 不 await：叫一声就回（真念多久是系统那一层的事）
    _ch.invokeMethod<bool>('speak', <String, Object?>{'text': t}).then<void>((ok) {
      // 交不出去 ⇒ **当场放开**（不然界面上会一直显示"正在念"）
      if (ok != true) _finish();
    }).catchError((Object _) {
      _finish();
    });
    return true;
  }

  @override
  void stop() {
    _finish();
    _ch.invokeMethod<void>('stop').catchError((Object _) {});
  }

  Future<dynamic> _onCall(MethodCall call) async {
    switch (call.method) {
      case 'ready':
        // 🔴 引擎就绪（或者确认念不了）—— 只有真的能念才举手
        _ready = call.arguments == true;
        if (_ready) notifySpeechReady();
        return null;
      case 'speakEnded':
        _finish();
        return null;
      default:
        return null;
    }
  }

  void _finish() {
    final f = _onEnd;
    _onEnd = null;
    f?.call();
  }
}

/// **原生那一份**：装钩子（**只在 Android 上调**）。
///
/// ⚠️ 顺手问一次"现在能念吗"：引擎可能**早就**就绪了（那时 `ready` 那条消息
///    是在这里挂上 handler **之前**发的 —— 错过就永远不亮）⇒ 补问一次。
void installNativeTts() {
  final s = _NativeSpeech();
  installNativeSpeech(s);
  s._ch.invokeMethod<bool>('canSpeak').then<void>((ok) {
    if (ok == true) {
      s._ready = true;
      notifySpeechReady();
    }
  }).catchError((Object _) {
    // 叫不通（没装/老版本）⇒ 就当这台念不出来（**不假装**）
  });
}
