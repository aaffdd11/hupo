// **录一段（录音 ＋ 回放）**：安卓那一份（`MediaRecorder` ＋ `MediaPlayer`，走 MethodChannel）。
//
// 契约：`docs/dev/129-NATIVE-ANDROID-BUILD.md` §十二。
// 那一侧的真东西在 `android/app/src/main/kotlin/chat/hupo/hupo_app/NativeRecorder.kt`。
//
// ── 四条对齐网页那一份（`recorder_web.dart`）──────────────────
//  ① 🔴 **一个字节都不往外发**：录到应用的缓存目录，放的时候只在本机播；
//  ② 🔴 **第一次按下去才问权限**（手册 D5.11）—— Kotlin 那边问，这里只翻话；
//  ③ **一个原因一句话**：`denied` / `unsupported` / `failed` 各自回一句，绝不静默；
//  ④ **一次只开一条**：开录前先停放；走开时 `releaseAll()` 把麦和临时文件收干净。
//
// 🔴 **它由启动时装进来**（`mini_native_boot_io.dart`，**只在 Android**）：
//    这一份里那句 `installNativeRecorder()` 是**唯一**的入口 ——
//    没装（VM 判据 / iOS / 桌面）⇒ `recorder_stub.dart` 照旧说"这里录不了"。

import 'package:flutter/services.dart';

import '../models/voice_record.dart';
import 'recorder.dart';

/// 与 Kotlin 那一侧（`MainActivity.CHANNEL`）**必须逐字一致**。
const String _channelName = 'hupo/recorder';

/// 放完了那一下（Kotlin 主动叫回来）——一次只放一条，所以只留一个回调。
void Function()? _onEnded;

/// 装钩子。**只在 Android 上调**（`mini_native_boot_io.dart` 那道判断）。
void installNativeRecorder() {
  final ch = const MethodChannel(_channelName);
  ch.setMethodCallHandler((call) async {
    if (call.method == 'onPlayEnded') {
      final cb = _onEnded;
      _onEnded = null;
      cb?.call();
    }
    return null;
  });
  nativeRecorderApi = (
    canRecord: true, // ⚠️ 真正的判定在 `start()` 那一下（没麦克风/没权限 ⇒ 各回各的原因）
    start: () async {
      try {
        final why = await ch.invokeMethod<String?>('start');
        return why; // null = 真开起来了
      } on PlatformException {
        return 'failed';
      } on MissingPluginException {
        return 'unsupported';
      }
    },
    stop: () async {
      try {
        final got = await ch.invokeMapMethod<String, Object?>('stop');
        if (got == null || got['ok'] != true) return null;
        final path = got['path'] as String?;
        final ms = (got['ms'] as num?)?.toInt() ?? 0;
        if (path == null || path.isEmpty || ms <= 0) return null;
        return RecordedClip(url: path, ms: ms);
      } catch (_) {
        return null;
      }
    },
    play: (path, onEnded) {
      _onEnded = onEnded;
      unawaitedPlay(ch, path, onEnded);
    },
    stopPlay: () {
      _onEnded = null;
      ch.invokeMethod<void>('stopPlay').catchError((Object _) {});
    },
    releaseAll: () {
      _onEnded = null;
      ch.invokeMethod<void>('releaseAll').catchError((Object _) {});
    },
  );
}

/// 放那一段；**开不起来就当场叫一声"放完了"**（按钮别停在"别放了"上 —— 同网页那份
/// 2026-09-27 在线上看出来的那个毛病）。
void unawaitedPlay(MethodChannel ch, String path, void Function() onEnded) {
  ch.invokeMethod<bool>('play', <String, Object?>{'path': path}).then((ok) {
    if (ok != true) {
      if (identical(_onEnded, onEnded)) _onEnded = null;
      onEnded();
    }
  }).catchError((Object _) {
    if (identical(_onEnded, onEnded)) _onEnded = null;
    onEnded();
  });
}
