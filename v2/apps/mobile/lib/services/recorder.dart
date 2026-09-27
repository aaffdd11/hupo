// **录一段（本机录音 ＋ 回放）**。
//
// 契约：`docs/dev/128-VOICE-RECORD-AND-PLAY.md`。这几个名字是**这一套对外的全部**：
//   `canRecord` —— 这台设备/这个页面录得了音吗（录不了就别装）；
//   `recordStart` / `recordStop` —— 按一下开始、再按一下停（停下拿到那一段）；
//   `play` / `stopPlay` / `releaseAll` —— 听一遍 / 别放了 / 走开时放掉。
//
// ⚠️ 网页上是 `getUserMedia` + `MediaRecorder`（`recorder_web.dart`）；
//    别的平台是桩（`recorder_stub.dart`，如实说录不了）。
//    与 `hearing.dart` / `speech.dart` / `links.dart` 同一条路（条件导出，**零新依赖**）。
//
// 🔴 **一个字节都不往外发**：录下来的是**本机**的临时地址，只在**这台设备**上放。

export 'recorder_stub.dart' if (dart.library.html) 'recorder_web.dart';
