// **真开麦**（说给它听 · 主人 2026-09-23 定案；原生那一份 2026-09-28 做出来）。
//
// 契约：`docs/dev/71-MIC-ASR.md`（网页那一份）＋ `docs/dev/129-NATIVE-ANDROID-BUILD.md`
// §十四（原生那一份）。这两个名字是**这套东西对外的全部**：
//   `canHear`  —— 这台设备/这个页面上开得了麦吗（开不了就别画那个话筒）；
//   `startHearing` / `stopHearing` —— 按一下开始、再按一下结束。
//
// ── 两份实现 ＋ 一个钩子 ────────────────────────────────────
//   · 网页：`getUserMedia` ＋ `AudioContext`（`hearing_web.dart`，条件导出选的）；
//   · 安卓：`AudioRecord` 取 16k 单声道 PCM ＋ 我们那条 `/api/asr`
//     （`hearing_native.dart`，**启动时钩子**装进来 —— 同 `recorder.dart` 那套）；
//   · 其余（VM 上的 `flutter test` / iOS / 桌面）：桩（`hearing_stub.dart`，如实说开不了）。
//
//   ⚠️ **为什么原生那一份是"钩子"而不是第三个条件导出**：`dart.library.io` 在
//      **VM（`flutter test`）上也是真的** ⇒ 照它选实现的话，测试会去建真的麦克风/连接，
//      而"VM 上开不了麦"那一批判据会一起翻车。
//
// 🔴 **一个字节都不留给浏览器**：网页那一份也不直连腾讯云（SecretKey 不许下发）——
//    原生这一份同理：音频发给**我们自己的** `/api/asr`，签名只在服务端算。

export 'hearing_stub.dart' if (dart.library.html) 'hearing_web.dart';

/// **原生那一份**要做的三件事。
///
/// ⚠️ 用类而不是记录：这里有**带命名参数的回调**，写成记录里的函数类型没人读得懂
///    （`recorder.dart` 那一份三个成员都是无参的，用记录就够了）。
abstract class NativeHearingApi {
  /// 这台设备开得了麦吗（装了原生那一份就是"能"；真正的判定在 `start` 那一下）。
  bool get canHear;

  /// 开麦。`null` = 真开起来了；否则一句**机器原因**
  /// （`denied` / `unsupported` / `no-entry` / `failed` / `not-configured` / `engine`）。
  Future<String?> start({
    required Uri url,
    required String token,
    required void Function(Map<String, dynamic>) onEvent,
  });

  /// 收手（用户按了第二下）。
  void stop();

  /// ★ **预热**（2026-10-06）：把那条连接**先连上**，按下去那一刻就不用等它。
  ///
  /// 🔴 为什么值得单独来一下：那条连接冷启那一次真量到 **1.1~4.4 秒**
  ///    （热的时候 16 ms，见 `docs/dev/199-ASR-HEAD.md` §二）—— 那一段原来落在
  ///    **"按下 → 屏幕上出第一个字"**这条路上。
  /// ⚠️ **只是连上**：**不发 `asr/start`** ⇒ 上游那一跳不开、**不花钱**，
  ///    也没有麦克风、没有音频。没人按 / 过一会儿 ⇒ 它自己会过期收掉。
  Future<void> warm({required Uri url, required String token});
}

/// **原生那一份**（安卓的 `AudioRecord` ＋ `/api/asr`）由启动时装进来。
///
/// ⚠️ `null` = 没装 ⇒ 非 Web 那一侧照旧"开不了麦"（VM 判据与 iOS 就是这一档）。
NativeHearingApi? nativeHearingApi;

/// （给判据用的）把钩子清干净。
void clearNativeHearing() => nativeHearingApi = null;
