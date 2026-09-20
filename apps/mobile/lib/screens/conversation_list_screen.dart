// 会话列表页。
//
// 设计要点（见 docs/handbook/02-ARCHITECTURE.md）：**不在本地存消息**。
// 只拉服务端的会话元数据（标题/最后一条/时间/未读），点进去才加载对话。

import 'package:flutter/material.dart';

import '../models/timeline.dart';
import '../services/transport.dart';
import 'chat_screen.dart';
import '../services/chat_controller.dart';
import '../services/dev_mode.dart';

class ConversationListScreen extends StatelessWidget {
  const ConversationListScreen({super.key, required this.transport});

  final ChatTransport transport;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('会话'),
        actions: [
          IconButton(
            tooltip: '设置',
            icon: const Icon(Icons.settings_outlined),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const SettingsScreen()),
            ),
          ),
        ],
      ),
      body: ConversationListView(transport: transport),
    );
  }
}

/// 会话列表的**本体**（不带 Scaffold / AppBar）。
///
/// 拆出来是为了让"会话"这个应用能把它放进小程序容器里 ——
/// 容器顶栏已经给了标题和返回，再套一层 AppBar 就是两层标题栏。
class ConversationListView extends StatefulWidget {
  const ConversationListView({super.key, required this.transport});

  final ChatTransport transport;

  @override
  State<ConversationListView> createState() => _ConversationListViewState();
}

class _ConversationListViewState extends State<ConversationListView> {
  late Future<List<ConversationSummary>> _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  /// 只取元数据；正文在进入对话页时才拉。
  Future<List<ConversationSummary>> _load() async {
    final rows = await widget.transport.listConversations();
    return rows.map((r) {
      final updated = r['updatedAt'];
      return ConversationSummary(
        conversationId: r['conversationId'] as String? ?? '',
        title: r['title'] as String? ?? '未命名',
        lastText: r['lastText'] as String? ?? '',
        updatedAt: updated is int
            ? DateTime.fromMillisecondsSinceEpoch(updated)
            : DateTime.now(),
        unread: r['unread'] as int? ?? 0,
      );
    }).toList();
  }

  void _openConversation(ConversationSummary summary) {
    // 每个会话一个独立的控制器实例 —— 会话之间不共享状态
    final controller = ChatController(
      transport: widget.transport,
      conversationId: summary.conversationId,
    )..connect();
    Navigator.of(context)
        .push(MaterialPageRoute(
          builder: (_) => ChatScreen(controller: controller),
        ))
        .then((_) => controller.dispose());
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return FutureBuilder<List<ConversationSummary>>(
      future: _future,
      builder: (context, snap) {
        if (snap.connectionState == ConnectionState.waiting) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snap.hasError) {
          return Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('加载失败', style: theme.textTheme.bodyMedium),
                const SizedBox(height: 8),
                TextButton(
                  onPressed: () => setState(() => _future = _load()),
                  child: const Text('重试'),
                ),
              ],
              ),
            );
          }
          final items = snap.data ?? const <ConversationSummary>[];
          if (items.isEmpty) {
            return Center(
              child: Text('还没有会话', style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor)),
            );
          }
          return ListView.separated(
            itemCount: items.length,
            separatorBuilder: (_, __) => const Divider(height: 1, indent: 16),
            itemBuilder: (context, i) {
              final c = items[i];
              return ListTile(
                title: Text(c.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                subtitle: Text(c.lastText, maxLines: 1, overflow: TextOverflow.ellipsis),
                trailing: c.unread > 0
                    ? Badge(label: Text('${c.unread}'))
                    : Text(
                        _relativeTime(c.updatedAt),
                        style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
                      ),
                onTap: () => _openConversation(c),
              );
            },
          );
      },
    );
  }

  static String _relativeTime(DateTime t) {
    final d = DateTime.now().difference(t);
    if (d.inMinutes < 1) return '刚刚';
    if (d.inHours < 1) return '${d.inMinutes} 分钟前';
    if (d.inDays < 1) return '${d.inHours} 小时前';
    return '${d.inDays} 天前';
  }
}

/// 设置页。
///
/// 刻意保持极少 —— 客户端是哑终端。
/// 但**账号删除入口是应用商店硬要求**，必须在。
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('设置')),
      body: ListView(
        children: [
          const ListTile(
            leading: Icon(Icons.person_outline),
            title: Text('账号'),
            subtitle: Text('（尚未接入登录）'),
          ),
          const Divider(),
          ListTile(
            leading: const Icon(Icons.memory_outlined),
            title: const Text('它记住了什么'),
            subtitle: const Text('查看与纠正记忆（待接入）'),
            onTap: () => _todo(context),
          ),
          ListTile(
            leading: const Icon(Icons.rule_outlined),
            title: const Text('记忆与偏好'),
            subtitle: const Text('哪些该记、哪些不该记（待接入）'),
            onTap: () => _todo(context),
          ),
          const Divider(),
          // 开发者模式：打开后对话页顶部会出现"后台在做什么"的卡片
          ValueListenableBuilder<bool>(
            valueListenable: devModeEnabled,
            builder: (context, on, _) => SwitchListTile(
              secondary: const Icon(Icons.developer_mode_outlined),
              title: const Text('开发者模式'),
              subtitle: const Text('在对话页顶部显示后台正在做什么（调试用）'),
              value: on,
              onChanged: (v) => devModeEnabled.value = v,
            ),
          ),
          const Divider(),
          ListTile(
            leading: Icon(Icons.delete_forever_outlined, color: theme.colorScheme.error),
            title: Text('删除账号与全部数据', style: TextStyle(color: theme.colorScheme.error)),
            subtitle: const Text('应用商店要求必须提供此入口'),
            onTap: () => _confirmDelete(context),
          ),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Text(
              '版本 0.1.0（开发版）\n客户端只负责对话与显示，所有 agent 逻辑在云端。',
              style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
            ),
          ),
        ],
      ),
    );
  }

  void _todo(BuildContext context) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('尚未接入'), duration: Duration(seconds: 1)),
    );
  }

  void _confirmDelete(BuildContext context) {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除账号'),
        content: const Text('这会删除你的账号、全部对话与全部记忆，且不可恢复。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          TextButton(
            onPressed: () {
              Navigator.pop(ctx);
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('接口未接入')),
              );
            },
            child: const Text('确认删除'),
          ),
        ],
      ),
    );
  }
}
