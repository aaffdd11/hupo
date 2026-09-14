// 「开发者模式」这个应用的内容。
//
// 它原来是一张贴在对话页顶部的卡片，占着页面不说，还把浮窗往下挤。
// 现在它是一个应用：桌面上点开才看，看完关掉 —— 页面回到干净状态。
//
// 内容本身没变（连接 / 上下文 / agent 进程 / 后台步骤），都在 DevPanel 里。

import 'package:flutter/material.dart';

import '../services/chat_controller.dart';
import '../widgets/dev_card.dart';

class DevModeAppPage extends StatelessWidget {
  const DevModeAppPage({super.key, required this.controller});

  final ChatController controller;

  @override
  Widget build(BuildContext context) {
    return DevPanel(controller: controller);
  }
}
