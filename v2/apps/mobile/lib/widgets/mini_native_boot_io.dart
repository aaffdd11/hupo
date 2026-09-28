// **原生小程序运行时：装钩子那一份（Web 上不编它）**。
//
// 由 `mini_native_boot.dart` 条件导入选：
//   · Web ⇒ `mini_native_boot_stub.dart`（什么都不做）
//   · 别的平台 ⇒ 这一份
//
// 🔴 **只在 Android 上装**（`defaultTargetPlatform`）：
//    iOS 商店版不许发布小程序运行时（Apple 4.7.4，`08-SPEC.md` §4.2）——
//    见 `mini_runtime.dart` 里的 `kNativeMiniRuntimeIOS`。
// ⚠️ 这里用 `defaultTargetPlatform`（`package:flutter/foundation.dart`）而**不是**
//    `dart:io` 的 `Platform`：这一份虽然只在非 Web 编译，但同一份源码
//    以后可能被别处引用，而 `dart:io` 一旦进了 Web 那条编译链就当场编不过。

import 'package:flutter/foundation.dart';

import 'mini_runtime.dart';
import 'mini_runtime_native.dart';

/// 装/不装原生那一层（方幂：装两次也就是把那两个函数再指一遍）。
void installNativeMiniRuntime() {
  if (defaultTargetPlatform != TargetPlatform.android) {
    // iOS / 桌面：**不装** ⇒ 非 Web 那一侧照旧给那句实话（不许白屏）。
    return;
  }
  nativeMiniAppView = buildNativeMiniAppView;
  nativeMiniAppRelease = releaseNativeMiniAppView;
}
