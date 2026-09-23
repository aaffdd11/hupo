// **非网页平台**：开不了麦 —— 如实说开不了（不要假装）。
//
// ⚠️ 这一份也是 `flutter test` 跑的那一份（`dart.library.html` 在 VM 上是假的）
//    ⇒ 判据里**不该看到那个话筒**；想验"按下去会怎样"，把回调**注入**进去测
//    （见 `test/widget/hearing_test.dart`）。
//
// 这一批只做网页那一条（主人 2026-09-23：*"可以试试页面的语音功能了"*）。
// 手机壳里那一条（原生录音 + 上传）**明说没做**，不在这儿假装有一个。

/// 这个平台能不能真开麦。**今天只有网页可以**。
bool get canHear => false;

/// 开不了 ⇒ 一句机器原因（调用方据此说人话，**不会**去装开麦）。
Future<String?> startHearing({
  required Uri url,
  required String token,
  required void Function(Map<String, dynamic>) onEvent,
}) async => 'unsupported';

/// 没什么可停的。
void stopHearing() {}
