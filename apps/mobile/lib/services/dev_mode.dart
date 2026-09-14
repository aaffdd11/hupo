// 开发者模式的全局开关。
//
// **当前默认开启**：页面上方显示"后台在做什么"的卡片。
// 用户点卡片上的 × 可以关掉；将来产品稳定后把默认值改成 false 即可隐藏。
//
// 三个入口：
//   · 默认：开（开发期要看得见）
//   · 网址参数：`?dev=0` 关、`?dev=1` 开（Web）
//   · 设置页：「开发者模式」开关
//
// 用全局 ValueNotifier 而不是往 widget 树里传回调 —— 设置页和对话页
// 不在同一条路由上，用全局状态最省事，也便于将来接"持久化"。

import 'package:flutter/foundation.dart';

/// 开发者模式是否开启。
///
/// 默认值按平台分：
///   · Web：开（开发期要看得见，`?dev=0` 可关）
///   · 原生（iOS/Android）：**关** —— 那是产品构建，内部细节卡片
///     不该一开机就贴在主人手机上。要开去设置页（会话 app 里）。
final ValueNotifier<bool> devModeEnabled = ValueNotifier<bool>(!kIsWeb);

/// 启动时从网址参数覆盖（仅 Web 有效）：`?dev=0` 关、`?dev=1` 开。
void initDevModeFromUrl(Uri base) {
  final v = base.queryParameters['dev'];
  if (v == '0') devModeEnabled.value = false;
  if (v == '1') devModeEnabled.value = true;
}
