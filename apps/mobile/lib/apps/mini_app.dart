// 一个「应用」。
//
// 桌面上的一个图标 + 点开之后的一个独立页面。定位参考**小程序容器**：
//   · 每个应用是**自己的一个站点** —— 有自己的标题栏、自己的返回栈，
//     在它内部跳转不会跑出这个容器（所以容器里塞了一个私有 Navigator）。
//   · 容器负责"壳"（标题栏、返回、关闭、打开动画），应用只负责内容。
//   · 应用之间不共享界面状态 —— 关掉就是关掉，不留残影。
//
// 为什么做成注册表而不是散在界面里：以后加一个应用 = 加一条注册项 +
// 一个内容 widget，不用动桌面和容器的任何代码。

import 'package:flutter/material.dart';

import '../services/chat_controller.dart';
import '../services/transport.dart';

/// 应用能拿到的东西。
///
/// 刻意只有这三样 —— 应用不该直接摸到界面层的状态（谁开着、窗口多高）。
class MiniAppEnv {
  const MiniAppEnv({
    required this.controller,
    required this.exitDevMode,
    this.transport,
    this.devMode = false,
  });

  /// 当前会话的控制器（连接状态、时间线、后台步骤…）。
  final ChatController controller;

  /// 关掉开发者模式（开发者模式那个应用才用得上）。
  final VoidCallback exitDevMode;

  /// 网络传输。为 null 时"会话"应用不出现（单测里不会传）。
  final ChatTransport? transport;

  /// 开发者模式开着时，桌面上才多一个「开发者模式」应用。
  final bool devMode;
}

/// 一个应用的定义。
class MiniApp {
  const MiniApp({
    required this.id,
    required this.name,
    required this.icon,
    required this.color,
    required this.build,
    this.description = '',
    this.visible = true,
    this.closeTooltip = '关闭',
  });

  /// 稳定标识。用于 Key（`app-icon-<id>`）和测试。
  final String id;

  /// 桌面图标下面的名字，也是容器标题栏上的标题。
  final String name;

  final IconData icon;

  /// 图标的底色（桌面上一眼区分）。
  final Color color;

  /// 一句话说明（桌面上长按/详情用，现在只在无障碍标签里用）。
  final String description;

  /// 这个应用此刻该不该出现在桌面上。
  final bool visible;

  /// 容器右上角那个"关闭"按钮的说明文字。
  ///
  /// 各应用语义不同：开发者模式的关闭是真的把模式关掉，普通应用只是退出。
  final String closeTooltip;

  /// 应用内容。容器给的 BuildContext 位于容器内部。
  final Widget Function(BuildContext context) build;
}
