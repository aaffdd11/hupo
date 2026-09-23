// **真开麦**（说给它听 · 主人 2026-09-23 定案）。
//
// 契约：`docs/dev/71-MIC-ASR.md`。这两个名字是**这套东西对外的全部**：
//   `canHear`  —— 这台设备/这个页面上开得了麦吗（开不了就别画那个话筒）；
//   `startHearing` / `stopHearing` —— 按一下开始、再按一下结束。
//
// ⚠️ 网页上是 `getUserMedia` + `AudioContext`（`hearing_web.dart`）；
//    别的平台这一份是桩（`hearing_stub.dart`，如实说开不了）。
//    与 `speech.dart` / `links.dart` 同一条路（条件导出 + 各平台一份，**零新依赖**）。

export 'hearing_stub.dart' if (dart.library.html) 'hearing_web.dart';
