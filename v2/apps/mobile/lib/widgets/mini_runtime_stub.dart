// 沙箱运行时（**非 Web 那一侧**，也用于测试环境）。
//
// ⚠️ 真实的那些在
//    · `mini_runtime_web.dart`（`dart:html` 起 `<iframe sandbox>`）—— **网页**；
//    · `mini_runtime_native.dart`（`webview_flutter` 起 WebView）—— **Android**；
//    由 `mini_runtime.dart` 按平台条件导入选 + **启动时钩子**装（见那份顶上那段）。
//    **三边都要在**，否则 VM 上的测试编不过。
//
// 🔴 **不许白屏**：这台设备跑不起来就**说一句人话**（"点了没反应"是本仓库最忌的形状）。
//    ⚠️ 今天这一份的顺序是：**装了原生钩子 ⇒ 用原生**；没装 ⇒ 那句实话。
//       所以"iOS / 没装钩子 / 测试环境"这三档拿到的都是那句实话。

import 'package:flutter/material.dart';

import '../models/app_words.dart';
import '../models/design.dart' as d;
import 'mini_runtime.dart';

/// 起一个"看这个小程序的窗口"。装了原生那一层就用它；否则是这句实话。
Widget buildMiniAppView({
  required String entryUrl,
  required String title,
  Future<String> Function(String prompt)? onAsk,
}) {
  final native = nativeMiniAppView;
  if (native != null) {
    return native(entryUrl: entryUrl, title: title, onAsk: onAsk);
  }
  return Center(
    child: Padding(
      padding: const EdgeInsets.all(d.gapL),
      child: Text(
        appRuntimeNotHere,
        textAlign: TextAlign.center,
        style: const TextStyle(color: d.muted),
      ),
    ),
  );
}

/// **这一帧换掉了 / 关掉了 ⇒ 收干净**。
///
/// * Web：退订那一帧的消息监听（`mini_runtime_web.dart`）；
/// * 原生：把那个 WebView 放掉（`mini_runtime_native.dart`）；
/// * 没装（iOS / 测试）：**空操作** —— 本来就没有东西可收。
///
/// ⚠️ 它必须在（`MiniAppFrame` 对**三个平台**说同一句话）—— 少了它这一侧编不过，
///    而那正是"判据只在 Web 上跑得到"的老毛病。
void releaseMiniAppView(String viewId) {
  nativeMiniAppRelease?.call(viewId);
}
