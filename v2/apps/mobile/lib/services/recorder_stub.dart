// **录一段**：别的平台那一份 —— **装了原生钩子就用原生，没装就如实说录不了**。
//
// ⚠️ 与 `hearing_stub.dart` / `speech_stub.dart` / `links_stub.dart` 同一条路，
//    但多一层：**2026-09-28 起安卓有真那一份了**（`recorder_native.dart`，主人
//    *"你帮我测试录音能力。"*）⇒ 这一份变成"**默认那一份 ＋ 转交**"：
//      · 装了钩子（安卓，`main.dart` 启动时装）⇒ 全部转到 `nativeRecorderApi`；
//      · 没装（VM 上的判据 / iOS / 桌面）⇒ `canRecord` 恒假，
//        而界面**照画那颗按钮**、点下去说一句白话（藏起来等于让他自己猜 ——
//        同话筒那条，主人 2026-09-23 当场问过）。
//
// 🔴 **判据请不要在这上面松手**：`test/unit/recorder_native_test.dart` 会显式验
//    "没装钩子 ⇒ 恒假 / 装了 ⇒ 转交"，两边都要在。

import '../models/voice_record.dart';
import 'recorder.dart';

/// 这台设备录得了音吗。**没装原生钩子就是恒假**（那一份就是那个事实）。
bool get canRecord => nativeRecorderApi?.canRecord ?? false;

Future<String?> recordStart() async {
  final api = nativeRecorderApi;
  if (api == null) return 'unsupported';
  return api.start();
}

Future<RecordedClip?> recordStop() async {
  final api = nativeRecorderApi;
  if (api == null) return null;
  return api.stop();
}

void play(String url, void Function() onEnded) {
  final api = nativeRecorderApi;
  if (api == null) {
    onEnded();
    return;
  }
  api.play(url, onEnded);
}

void stopPlay() {
  nativeRecorderApi?.stopPlay();
}

void releaseAll() {
  nativeRecorderApi?.releaseAll();
}
