// **原生小程序运行时：装钩子的入口**（按平台条件导入选实现）。
//
// `main.dart` 只认这一个名字：`installNativeMiniRuntime()`。
//
// ⚠️ 条件用的是 `dart.library.io`（**不是** `dart.library.html`）：
//    · Web ⇒ `mini_native_boot_stub.dart`（空操作，且**不含** `webview_flutter`）；
//    · 别的平台（含 VM 测试）⇒ `mini_native_boot_io.dart`（那一份自己再按
//      `defaultTargetPlatform` 判一次，iOS 上不装）。
//    🔴 **"会不会被装上"与"选哪一份"是两件事**：VM 测试里 `dart.library.io` 是真的
//      （所以编进来的是 io 那一份），但**没有任何测试会调 `installNativeMiniRuntime()`**
//      ⇒ 运行期钩子仍是空的 ⇒ 判据拿到的还是那句实话（见 `mini_runtime.dart` 顶上那段）。
//
// 契约：`docs/dev/129-NATIVE-ANDROID-BUILD.md`。

export 'mini_native_boot_stub.dart' if (dart.library.io) 'mini_native_boot_io.dart';
