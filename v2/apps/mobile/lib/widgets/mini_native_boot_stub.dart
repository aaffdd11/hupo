// **原生小程序运行时：Web 那一份的装钩子（空操作）**。
//
// ⚠️ Web 有自己的运行时（`mini_runtime_web.dart` 的 `<iframe sandbox>`）⇒
//    不需要装任何东西。这一份存在的唯一理由是让 `main.dart` 只有一句话。
//
// 🔴 顺带守住一件事：**`webview_flutter` 一个字节都不许进 Web 那条编译链**
//    （那一份依赖原生平台通道，装到网页产物里只是白白变胖）。
//    判据：`test/unit/mini_runtime_test.dart` 扫源码 ——
//    `main.dart` 只许从 `mini_native_boot.dart` 拿这件事。

/// Web：无操作。
void installNativeMiniRuntime() {}
