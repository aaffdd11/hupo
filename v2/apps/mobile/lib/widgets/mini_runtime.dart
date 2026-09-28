// 沙箱运行时的**入口**：按平台条件导入选实现，并把"原生那一层"接进来。
//
// ⚠️ 为什么 Web 那一支要条件导入：`dart:html` / `dart:ui_web` **只在 Web 上存在**，
//    而 `flutter analyze` 与 `flutter test` 在 VM 上跑 —— 一个文件同时要两边都编得过，
//    只能靠条件导入（Flutter 官方推荐的那种写法）。
//
// ── 🔴 2026-09-28：原生（Android）这一侧**有运行时了** ──────────────
//
//   主人 2026-09-28 拍板：*"原生 flutter。我不发布，只安装在自己的设备。"*
//   并同意**引 webview 依赖**（"连2一起"）⇒ Android 那一侧用 `WebView` 跑制品。
//
//   🔴 **iOS 商店版仍然没有**（`08-SPEC.md` §4.2 合规那一条：Apple 4.7.4
//     要"提交时冻结的清单"，与"运行时生成"天生冲突）⇒ 装钩子那一步
//     **只在 Android 上做**（`widgets/mini_native_boot_io.dart` 里那道平台判断）。
//
//   🔴 **原生那一层不装桥**（`08-SPEC.md` §14.1 铁律 3「禁原生桥」＋
//     "全库 grep 原生桥相关 API 命中 = 0"那条验收）：所以
//     · 制品能打开、能玩；
//     · **`ask`（让它替我问一句）在原生上没有** —— 也**不假装有**
//       （壳不发 `hupo-ready`，按契约写的制品就不会摆出那个入口）。
//     判据：`test/unit/mini_runtime_test.dart` 会把这条铁律**扫一遍源码**。
//
//   ⚠️ 为什么"原生那一层"是**注入**进来、而不是第五个条件导入文件：
//     `dart.library.io` 在 **VM（`flutter test`）上也是真的** —— 照它选实现的话，
//     测试会去建真的 `WebViewController`（那在 VM 上根本不存在），
//     而现有那几条"非 Web 拿到的是那句实话"的判据（`mini_runtime_test` /
//     `mini_live_update_test` / `remote_app_test` / `job_ask_test`）会一起翻车。
//     ⇒ 选路由**环境**分开：Web 走条件导入、原生走**启动时钩子**
//       （`main.dart` 里装，判据里不装 ⇒ VM 上永远是那句实话）。
//
//   ⇒ 判据钉在 `test/unit/mini_runtime_test.dart`：
//      · `kNativeMiniRuntime == true`（Android 有了）· `kNativeMiniRuntimeIOS == false`（iOS 不许有）；
//      · 没装钩子 ⇒ 非 Web 仍然是那句实话（不是白屏）；
//      · 装上钩子 ⇒ 走原生那一份，`releaseMiniAppView` 也会转给它；
//      · 条件导入**只许对 `dart.library.html` 选 Web 实现**；
//      · 全库**没有**原生桥 API。

import 'package:flutter/widgets.dart';

export 'mini_runtime_stub.dart' if (dart.library.html) 'mini_runtime_web.dart';

/// 起一帧小程序那一层的**签名**（三份实现必须一样）。
typedef MiniAppViewBuilder =
    Widget Function({
      required String entryUrl,
      required String title,
      Future<String> Function(String prompt)? onAsk,
    });

/// **原生那一层**（Android 的 WebView）由启动时装进来。
///
/// ⚠️ `null` = 没装 ⇒ 非 Web 那一侧照旧给出那句实话（VM 判据与 iOS 就是这一档）。
MiniAppViewBuilder? nativeMiniAppView;

/// **原生那一层**收帧时要做的事（把那个 WebView 放掉）。
///
/// 🔴 非 Web 的 `releaseMiniAppView` 会把这件事转给它 ——
///    少了它，换一版制品就多留一个 WebView（`MiniAppFrame` 的账照旧销号，
///    而那本账管不到插件的控制器）。
void Function(String viewId)? nativeMiniAppRelease;

/// 原生（Android）这一侧**有没有**小程序运行时。
///
/// 🔴 **2026-09-28 起是 `true`**：Android 那一侧由 `main.dart` 启动时装上
///    `widgets/mini_runtime_native.dart`（普通 WebView、**不装桥**）。
/// ⚠️ 改这一个字之前先读本文件顶上那段 —— iOS 商店版**必须**仍然是"没有"。
const bool kNativeMiniRuntime = true;

/// 🔴 **iOS 商店版这一侧**：**恒假**。
///
/// 它就是 `08-SPEC.md` §4.2 那条合规约束的落点（Apple 4.7.4）。
/// ⚠️ 不是"暂时没做"——**只要还上 iOS 商店，它就必须是 `false`**。
///    要不要给 iOS 做（非商店分发那条路）是另一件事，得主人单独拍板。
const bool kNativeMiniRuntimeIOS = false;
