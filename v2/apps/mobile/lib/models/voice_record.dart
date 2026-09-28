// **"录一段"那一步的状态与那几行字**（纯的：进状态、出字）。
//
// ── 为什么要有它 ──────────────────────────────────────────
//   主人 2026-09-27：*"先实现录音功能。录音和播放。在设置页。"*
//   ⇒ 设置页「语音」那一屏除了「试一下」（那条要把音频送到识别路上、还得有钥匙），
//     再加一块**纯本机**的：**录一段、听一遍**。
//   🔴 它的价值就在"**不依赖任何钥匙与任何上游**"：麦克风到底通不通，
//     这件事本身就验得掉（"你至少先能成功把录音录下来"）。
//
// ── 三条纪律 ──────────────────────────────────────────────
//   ① 🔴 **这里不碰麦克风**：开录/收手/放音都是注入进来的函数
//      （真实现在 `services/recorder.dart` 的条件导出里）；这一份只算"该画什么字"。
//   ② 🔴 **一个字节都不往外发**：这块录下来的东西**只在这台设备上**
//      （与「试一下」那条刻意不同）—— 屏幕上那句话说的就是这件事。
//   ③ 🔴 **一个失败一个原因**：没权限 / 这里开不了麦 / 录不了（浏览器没那套东西）/
//      录下来是空的 —— 每一档都有自己的话，**绝不静默**；
//      与话筒那几句**共用**（同一个原因不许有两种说法）。
//
// ⚠️ 纯逻辑 ⇒ 进 `test/unit/voice_record_test.dart`，不靠界面断言。

import 'hearing_words.dart';

/// 录那一步现在处在哪儿。
enum RecPhase {
  /// 没在录也没在放（可能手里正拿着上一段）。
  idle,

  /// 正在录。
  recording,

  /// 录完了，手里有一段可以听。
  ready,

  /// 正在听那一段。
  playing,
}

/// **录下来的那一段**（一个能播的地址 ＋ 它多长）。
///
/// ⚠️ 它是**纯数据**（住 `models`）：`services/recorder.dart` 造它、界面用它。
/// ⚠️ `url` 是**本机**的一个临时地址（`blob:` 那种），**不上网**；
///    他离开这一屏就该把它放掉（`services/recorder.dart` 负责）。
class RecordedClip {
  const RecordedClip({required this.url, required this.ms});

  final String url;
  final int ms;

  /// 那一段**是不是真有东西**（空的那一段不算录到了 —— 见 [voiceRecEmpty]）。
  bool get ok => url.isNotEmpty && ms > 0;
}

/// 这一块要的那几个动作（纯 Dart：**不 import `services/`**，楼层闸钉着）。
class VoiceRecordHandlers {
  const VoiceRecordHandlers({
    required this.canRecord,
    required this.start,
    required this.stop,
    required this.play,
    required this.stopPlay,
    this.levels,
  });

  /// 这台设备/这个页面**录得了音吗**（`services/recorder.dart` 的 `canRecord`）。
  /// ⚠️ 假 ⇒ **照样画那颗按钮**，点下去说一句白话（[hearCantHere]）——
  ///    藏起来等于让他自己猜（同话筒那条）。
  final bool canRecord;

  /// **开录**。`null` = 真开起来了；否则一句**机器原因**
  /// （`denied` / `unsupported` / `failed`）。
  final Future<String?> Function() start;

  /// **收手**（用户按了第二下）⇒ 那一段（录不到东西 ⇒ `null`）。
  final Future<RecordedClip?> Function() stop;

  /// **放**那一段（[onEnded] 是它自己放完时叫我们一声 —— 按钮要回到"听一遍"）。
  final void Function(String url, void Function() onEnded) play;

  /// **别放了**。
  final void Function() stopPlay;

  /// 录的时候那一串**音量采样**（0..1，最新在后）。
  ///
  /// ⚠️ `null` = 这一份实现不报电平（老注入点、桩那一份）⇒ 界面**不画那条轴**，
  ///    也不说"听得到声音"（**没有读数就不许编一个**）。
  final Stream<double>? levels;
}

/// 那颗大按钮上现在写什么（录中 ⇒ 停下；其余时候都是"开始录"）。
///
/// ⚠️ **正在听的时候**那颗按钮**按不动**（界面不画它 / 灰着）—— 那是"做得到但已经到头了"
///    那一档（同外观那种步进器），所以这里给的是"开始录"也不会被用到。
String voiceRecButton(RecPhase p) => p == RecPhase.recording ? voiceRecStop : voiceRecStart;

/// 回放那颗按钮上现在写什么；**手里没东西 ⇒ `null`（不画）**。
String? voiceRecPlayButton(RecPhase p, {required bool hasClip}) {
  if (!hasClip) return null;
  return p == RecPhase.playing ? voiceRecPlayStop : voiceRecPlay;
}

/// 下面那一句实话（空 = 没什么要说的）。
///
/// 🔴 两条：
///   · **正在录/正在放的时候不说**（那会儿屏幕上已经有"在录/在放"那一行了）；
///   · **这台录不了音** ⇒ 说一句白话（与话筒同一句：同一个原因不许有两种说法）。
String voiceRecNotice({
  required RecPhase phase,
  required String why,
  required bool canRecord,
}) {
  if (!canRecord) return hearCantHere;
  if (phase == RecPhase.recording || phase == RecPhase.playing) return '';
  return why;
}

/// 那一段时长的说法（**只有手里真有东西时才说**；没有 ⇒ 空串）。
String voiceRecLengthLine(RecPhase phase, RecordedClip? clip) {
  if (clip == null || !clip.ok) return '';
  // ⚠️ 正在录的时候那份不算（那是上一次留下的）
  return phase == RecPhase.recording ? '' : voiceRecLength(clip.ms);
}
