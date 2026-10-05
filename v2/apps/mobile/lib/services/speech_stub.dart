// **非网页平台**：念不出来 —— 如实说念不出来（不要假装）。
//
// ⚠️ 这一份也是 `flutter test` 跑的那一份（`dart.library.html` 在 VM 上是假的）
//    ⇒ 判据里**不该看到"读一遍"这个按钮**；想验"点了会怎样"，
//    把回调**注入**进去测（见 `test/widget/speak_test.dart`）。

/// 这个平台能不能把它说的话念出来。**今天只有网页可以**。
const bool canSpeak = false;

/// 念不出来 ⇒ `false`（调用方据此**不画按钮**）。
bool speakAloud(String text, {void Function()? onEnd}) => false;

/// 没什么可停的。
void stopSpeaking() {}

/// **音色到位时举手**（网页那一份等浏览器异步给音色）—— 这一份**没有那种事**：
/// 念不出来的平台永远不会"稍后就能念了" ⇒ 空操作。
void watchSpeakReady(void Function() onReady) {}
