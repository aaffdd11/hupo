// 「会话」这个应用的内容。
//
// 以前它是对话页标题行上的一个小图标，点开跳到另一个整页。
// 现在它是一个应用：内容跑在容器自己的 Navigator 里，
// 所以点开某个会话之后跳转的是**容器内部**，返回键也先退容器内部的栈。
//
// 应用自己不带标题栏 —— 容器的顶栏已经有了。设置入口放在内容里。

import 'package:flutter/material.dart';

import '../screens/conversation_list_screen.dart';
import '../services/transport.dart';

class ConversationsAppPage extends StatelessWidget {
  const ConversationsAppPage({super.key, required this.transport});

  final ChatTransport transport;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 4, 0),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  '全部会话',
                  style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
                ),
              ),
              TextButton.icon(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => const SettingsScreen()),
                ),
                icon: const Icon(Icons.settings_outlined, size: 17),
                label: const Text('设置'),
              ),
            ],
          ),
        ),
        Expanded(child: ConversationListView(transport: transport)),
      ],
    );
  }
}
