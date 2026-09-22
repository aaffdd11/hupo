// 沙箱运行时（**非 Web 那一侧**，也用于测试环境）。
//
// ⚠️ 真实的那个在 `mini_runtime_web.dart`（用 `dart:html` 起 `<iframe sandbox>`），
//    由 `mini_runtime.dart` 按平台条件导入选。**两边都要在**，否则 VM 上的测试编不过。
//
// 🔴 **不许白屏**：这台设备跑不起来就**说一句人话**（"点了没反应"是本仓库最忌的形状）。

import 'package:flutter/material.dart';

import '../models/app_words.dart';
import '../models/design.dart' as d;

/// 起一个"看这个小程序的窗口"。Web 上是沙箱 iframe；别处是这句实话。
Widget buildMiniAppView({
  required String entryUrl,
  required String title,
  Future<String> Function(String prompt)? onAsk,
}) {
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
