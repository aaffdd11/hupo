// 主界面。手册 `08-SPEC.md` §6（铁律）、`01-PROJECT.md` §五（五条原则）。
//
// 这一屏只干一件事：**让用户知道发生了什么**。
// 走查里十个用户，八个的放弃点落在同一件事上——
// "它到底活着没有、记着没有、说的是不是真的"，**而系统自己也不说**。
//
// 所以这一屏有三块"说话"的地方：
//   ① 顶部状态条：网怎么样、登录还有没有效
//   ② 每条消息的四态（在气泡里）
//   ③ 出错的实话：没发出去就是没发出去
//
// ⚠️ 文案里**不许出现内部词**（"连接/客户端/云端/工作区"…）——
//    有 `forbidden_words` 那道闸守着，改文案时会拦。

import 'package:flutter/material.dart';

import '../models/timeline.dart';
import '../services/chat_controller.dart';
import '../services/stream.dart';
import '../widgets/bubbles.dart';
import '../widgets/composer.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key, required this.controller, required this.onLoggedOut});

  final ChatController controller;
  final VoidCallback onLoggedOut;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onChanged);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onChanged);
    _scroll.dispose();
    super.dispose();
  }

  void _onChanged() {
    if (!mounted) return;
    setState(() {});
    // 新东西进来时滚到底；**用户正在往上翻时不打断他**
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      final pos = _scroll.position;
      final nearBottom = pos.maxScrollExtent - pos.pixels < 160;
      if (nearBottom) {
        _scroll.animateTo(pos.maxScrollExtent,
            duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return Scaffold(
      appBar: AppBar(
        title: const Text('助手'),
        actions: [
          IconButton(
            tooltip: '退出',
            onPressed: () async {
              await c.logout();
              widget.onLoggedOut();
            },
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: Column(
        children: [
          _StatusStrip(state: c.conn, error: c.lastError),
          Expanded(
            child: Center(
              child: ConstrainedBox(
                // 内容列限宽（手册 D4.6 / R5）：平板上一行七十个字没人读
                constraints: const BoxConstraints(maxWidth: 760),
                child: c.items.isEmpty
                    ? const _EmptyState()
                    : ListView.builder(
                        controller: _scroll,
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
                        itemCount: c.items.length,
                        itemBuilder: (context, i) => _render(c.items[i], c),
                      ),
              ),
            ),
          ),
          Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 760),
              child: Composer(onSend: c.send),
            ),
          ),
          SizedBox(height: MediaQuery.viewInsetsOf(context).bottom),
        ],
      ),
    );
  }

  Widget _render(TimelineItem item, ChatController c) => switch (item) {
        UserUtterance() => UserBubble(
            utterance: item,
            onResend: () => c.resend(item.messageId),
          ),
        AssistantMessage() => AnswerBubble(message: item),
        TimelineMarker() => MarkerLine(marker: item),
      };
}

/// 顶部状态条。**只在"需要用户知道点什么"的时候出现**——
/// 一切正常的时候它不该占地方（那会变成一种噪音）。
class _StatusStrip extends StatelessWidget {
  const _StatusStrip({required this.state, this.error});

  final ConnState state;
  final String? error;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final (String? text, bool isError) = switch (state) {
      ConnState.connected => (error, error != null),
      ConnState.connecting => ('正在连上…', false),
      // ★ 这个词组是刻意的：不说"正在恢复连接"（那会被读成"它坏了"）
      ConnState.reconnecting => ('网断了，我在等它回来', false),
      ConnState.unauthorized => ('登录过期了，重新登录一下', true),
      ConnState.notSetup => ('这台机器还没设密码', true),
      ConnState.idle => ('还没连上', false),
    };
    if (text == null) return const SizedBox.shrink();
    return Container(
      width: double.infinity,
      color: isError ? theme.colorScheme.errorContainer : theme.colorScheme.surfaceContainerHighest,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Text(text, style: theme.textTheme.bodySmall),
    );
  }
}

/// 空屏。手册 D1/D3：**不许写"你好，我能帮你做什么"**（人格硬规则禁止留客式追问）。
class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text('说点什么', style: theme.textTheme.titleMedium),
          const SizedBox(height: 12),
          Text(
            // 说清"能干什么"，不是"我是什么"
            '记一笔账、问一件事、让它去查个东西。\n'
            '它会把做过的事说给你听。',
            style: theme.textTheme.bodyMedium,
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }
}
