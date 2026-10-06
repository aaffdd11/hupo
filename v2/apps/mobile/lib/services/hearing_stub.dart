// **非网页平台**：装了原生钩子就用原生，没装就如实说开不了（不要假装）。
//
// ⚠️ 这一份也是 `flutter test` 跑的那一份（`dart.library.html` 在 VM 上是假的）
//    ⇒ 判据里**不该看到那个话筒**；想验"按下去会怎样"，把回调**注入**进去测
//    （见 `test/widget/hearing_test.dart`）。
//
// ⚠️ 2026-09-28 起**安卓有真那一份了**（`hearing_native.dart`，主人："安卓也要支持转文字"）
//    ⇒ 这一份变成"**默认那一份 ＋ 转交**"：装了钩子就全转过去；
//      没装（VM 判据 / iOS / 桌面）就照旧 `canHear == false`，一个字都不假装。

import 'hearing.dart';

/// 这个平台能不能真开麦。**没装原生钩子就是恒假**。
bool get canHear => nativeHearingApi?.canHear ?? false;

/// 开不了 ⇒ 一句机器原因（调用方据此说人话，**不会**去装开麦）。
Future<String?> startHearing({
  required Uri url,
  required String token,
  required void Function(Map<String, dynamic>) onEvent,
}) async {
  final api = nativeHearingApi;
  if (api == null) return 'unsupported';
  return api.start(url: url, token: token, onEvent: onEvent);
}

/// 没什么可停的（没装钩子时）。
void stopHearing() {
  nativeHearingApi?.stop();
}

/// ★ **预热**（2026-10-06）：装了原生钩子就转过去；没装 ⇒ **什么都不做**
/// （开不了麦的地方也没什么可热的 —— 不许假装）。
Future<void> warmHearing({required Uri url, required String token}) async {
  await nativeHearingApi?.warm(url: url, token: token);
}
