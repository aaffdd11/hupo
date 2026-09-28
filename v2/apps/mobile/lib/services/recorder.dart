// **录一段（本机录音 ＋ 回放）**。
//
// 契约：`docs/dev/128-VOICE-RECORD-AND-PLAY.md`（网页那一份）
//   ＋ `docs/dev/129-NATIVE-ANDROID-BUILD.md` §十二（原生那一份，2026-09-28 做的）。
// 这几个名字是**这一套对外的全部**：
//   `canRecord` —— 这台设备/这个页面录得了音吗（录不了就别装）；
//   `recordStart` / `recordStop` —— 按一下开始、再按一下停（停下拿到那一段）；
//   `play` / `stopPlay` / `releaseAll` —— 听一遍 / 别放了 / 走开时放掉。
//
// ── 两份实现 ＋ 一个钩子 ────────────────────────────────────
//   · 网页：`getUserMedia` ＋ `MediaRecorder`（`recorder_web.dart`，条件导出选的）；
//   · 安卓：`MediaRecorder` ＋ `MediaPlayer`，走 MethodChannel
//     （`recorder_native.dart`，**启动时钩子装进来** —— 见下）；
//   · 其余（VM 上的 `flutter test`、iOS、桌面）：桩（`recorder_stub.dart`，如实说录不了）。
//
//   ⚠️ **为什么原生那一份是"钩子"而不是第三个条件导出**：`dart.library.io` 在
//      **VM（`flutter test`）上也是真的** —— 照它选实现的话，测试会去调真的 MethodChannel，
//      而 `test/unit/recorder_native_test.dart` 那几条（以及所有"VM 上录不了"的判据）
//      会一起翻车。⇒ 选路按**环境**分开：Web 走条件导入、原生走**启动时钩子**
//      （`main.dart` → `widgets/mini_native_boot.dart` → `recorder_native.dart` 里那句
//      `installNativeRecorder()`，而且**只在 Android**）。
//      这是与 `widgets/mini_runtime.dart` **同一套**做法（那一份的理由写在它顶上）。
//
// 🔴 **一个字节都不往外发**：录下来的是**本机**的临时文件，只在**这台设备**上放。

export 'recorder_stub.dart' if (dart.library.html) 'recorder_web.dart';

import '../models/voice_record.dart';

/// 原生那一份能做的四件事 ＋ 一个问题（可由启动时钩子装进来）。
///
/// ⚠️ 它长得跟 `VoiceRecordHandlers` 很像，但**不是同一层**：
///    这里是"这台设备有没有能力"，那里是"界面把这个能力接到哪几个动作上"。
typedef NativeRecorderApi = ({
  bool canRecord,
  /// 录的时候那一串音量采样（0..1）。**没有就不报**（界面据此不画那条轴）。
  Stream<double>? levels,
  Future<String?> Function() start,
  Future<RecordedClip?> Function() stop,
  void Function(String path, void Function() onEnded) play,
  void Function() stopPlay,
  void Function() releaseAll,
});

/// **原生那一份**（安卓的 MethodChannel 实现）由启动时装进来。
///
/// ⚠️ `null` = 没装 ⇒ 非 Web 那一侧照旧给"这里录不了"（VM 判据与 iOS 就是这一档）。
NativeRecorderApi? nativeRecorderApi;

/// （给判据用的）把钩子清干净。
void clearNativeRecorder() => nativeRecorderApi = null;
