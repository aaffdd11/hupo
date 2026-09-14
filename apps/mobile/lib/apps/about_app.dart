// 「关于」这个应用。
//
// 为什么值得单独一个应用：客户端是哑终端，出了问题第一个要问的就是
// "你看的是哪个版本"。构建指纹、会话号、连接状态放在这里，一眼能报出来。

import 'package:flutter/material.dart';

import '../services/app_version.dart';
import '../services/chat_controller.dart';

class AboutAppPage extends StatelessWidget {
  const AboutAppPage({super.key, required this.controller});

  final ChatController controller;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final c = controller;

    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
      children: [
        Text('Hupo', style: theme.textTheme.titleMedium),
        const SizedBox(height: 4),
        Text(
          '客户端只负责说话和显示，所有判断都在云端。',
          style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
        ),
        const SizedBox(height: 20),
        _Row(label: '客户端版本', value: isDevBuild ? '本地开发（无指纹）' : kClientBuildId),
        _Row(label: '会话', value: c.conversationId),
        _Row(label: '连接', value: c.connected ? '已连上' : '没连上'),
        _Row(label: '序号', value: '${c.lastSeq}'),
        _Row(label: '历史', value: '${c.timeline.length} 条'),
      ],
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 88,
            child: Text(label,
                style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor)),
          ),
          Expanded(
            child: SelectableText(
              value,
              style: theme.textTheme.bodyMedium?.copyWith(fontFamily: 'monospace'),
            ),
          ),
        ],
      ),
    );
  }
}
