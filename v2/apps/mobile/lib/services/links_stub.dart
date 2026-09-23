// **非网页平台**：开不了外面的地址 —— 如实说开不了（不要假装）。
//
// ⚠️ 这一份也是 `flutter test` 跑的那一份（`dart.library.html` 在 VM 上是假的），
//    ⇒ **判据里那几行不该是可点的**；想验"点了会怎样"，把回调注入进去测
//    （见 `test/widget/sources_test.dart`）。

/// 这个平台能不能打开外面的地址。**今天只有网页可以**。
const bool canOpenLinks = false;

/// 打不开 ⇒ 永远返回 `false`（调用方据此**不画按钮**）。
bool openExternal(String url) => false;
