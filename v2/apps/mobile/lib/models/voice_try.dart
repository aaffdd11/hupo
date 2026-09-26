// **配置页「语音」那一屏那颗「试一下」**：状态 → 屏幕上那几行字（纯的）。
//
// ── 为什么要有它 ──────────────────────────────────────────
//   主人 2026-09-26：*"配置页，语音配置上，增加一个测试按钮，点击后会录音，
//   会转文字，并写入一个文本框。"*
//   填了那三样之后，他得**当场知道这把钥匙到底能不能听** —— 不然就是
//   "填了一个不知道有没有用的东西"（图片那一屏的「试一张」是同一条理由，
//   契约 `docs/dev/123-VOICE-TEST-BUTTON.md`）。
//
// ── 三条纪律 ──────────────────────────────────────────────
//   ① 🔴 **这里没有第二套录音状态机**：状态机本体就是聊天那颗话筒用的那一份
//      （`models/hearing_session.dart`）。这一份只做"把它翻成这一屏的按钮字 /
//      那一句实话"——两份状态机 = 迟早会说两种话。
//   ② 🔴 **一次失败一个原因、一句话**（没配 / 没权限 / 连不上 / 没额度 /
//      没听到 / 读不懂），**绝不静默**；而且**不编**（原因由服务端给，
//      或由 `Hearing` 那张表给）。
//   ③ 🔴 **认不出来的帧不许抛**（对面以后加字段，老客户端不能崩），
//      也**不许装作什么都没发生**（形状都不对时要说一句实话）。
//
// ⚠️ 纯逻辑 ⇒ 进 `test/unit/voice_try_test.dart`，不靠界面断言。

import 'hearing_session.dart';
import 'hearing_words.dart';

/// 这一块要的那两个动作。
///
/// ⚠️ 它只是一个**函数形状**（纯 Dart，**不 import `services/`**）——
///    楼层闸写着 `models` 不许指向别的层。真实现在 `services/hearing.dart`
///    （条件导出：网页那一份真开麦，别的平台是桩）；判据注假的进去。
class VoiceTryHandlers {
  const VoiceTryHandlers({required this.start, required this.stop});

  /// **开麦**。`null` = 真开起来了；否则一句**机器原因**
  /// （`denied` / `unsupported` / `no-entry` / `not-configured` / `engine` / …）。
  /// 识别那一头的字从那一个回调里进来（就是 `startHearing` 的 `onEvent`）。
  final Future<String?> Function(void Function(Map<String, dynamic>) onEvent) start;

  /// **收手**（用户按了第二下）。最后那一句是在这之后才回来的（见 `Hearing.finishing`）。
  final void Function() stop;
}

/// 那一颗按钮上现在写什么（三档：闲 / 在听 / 收尾中）。
String voiceTryButton(Hearing h) {
  if (h.phase == HearingPhase.listening) return voiceTryStop;
  if (h.phase == HearingPhase.finishing) return voiceTryWorking;
  return voiceTryStart;
}

/// 那一句实话（空 = 没什么要说的）。
///
/// 🔴 两条：
///   · **正在听/收尾中不说**：那会儿屏幕上已经有"在听"那一条，把上一次停下来的
///     原因留着就是假话（同 `Hearing.notice` 那条纪律）；
///   · **"没配好"这一档要跟着"上面那三样填过没有"分开说**：这一屏正在编的就是
///     那三样 ⇒ 他要能看出"填了就该用它"还是"填了也还用不上"。
String voiceTryNotice(Hearing h, {required bool hasOwn}) {
  if (h.busy) return '';
  if (h.phase == HearingPhase.unavailable) {
    return hasOwn ? voiceTryNoKeyFilled : voiceTryNoKeyEmpty;
  }
  return h.why;
}

/// **收下识别那一头发来的一帧**。
///
/// 🔴 认不出来的分两种，**分开办**：
///   · **形状都不对**（不是一个表）⇒ 说一句实话（[voiceTryBadFrame]），
///     而且**字一个都不许丢**（已经听到的那半句留着）；没在试的时候来的
///     一律不管（不冒字、不出提示）。
///   · **类型不认识**（对面以后加的新事件）⇒ **什么都不做**（不猜、不假装）——
///     这条纪律在 `Hearing.event` 里，与聊天那颗话筒完全同一条。
///
/// ⚠️ 它**绝不抛**：一个坏帧不该把这一屏打掉。
Hearing voiceTryFrame(Hearing h, Object? raw) {
  if (raw is Map<String, dynamic>) return h.event(raw);
  if (!h.busy) return h;
  return Hearing(
    phase: HearingPhase.failed,
    segments: h.segments,
    why: voiceTryBadFrame,
  );
}
