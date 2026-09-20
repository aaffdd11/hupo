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
//   ④ 它正在做（`BusyLine`）：一轮开了、还没出字的那段空白
//   ⑤ 关于（顶栏那个 i）：**这台设备上能不能用嘴说** —— D3.3 要求如实说
//
// ⚠️ 文案里**不许出现内部词**（"连接/客户端/云端/工作区"…）——
//    有 `forbidden_words` 那道闸守着，改文案时会拦。

import 'package:flutter/material.dart';

import '../models/conn_state.dart';
import '../models/timeline.dart';
import '../services/chat_controller.dart';
import '../widgets/bubbles.dart';
import '../widgets/composer.dart';
import '../widgets/process_level_menu.dart';
import '../widgets/process_view.dart';
import 'about_screen.dart';

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
          // ⚠️ **过程四档的入口**（契约 §五：位置等主人看过再定，
          //    所以这一批只做"能切"）。换档要重连（`level` 是连接级的）。
          IconButton(
            tooltip: '它说多少过程',
            onPressed: () => _pickLevel(c),
            icon: const Icon(Icons.tune),
          ),
          // ⚠️ **关于**放在这儿不是装饰：H1 点名要避免的形态是
          //    "字放大了，但还是打不了字" ⇒ 得有一处**如实告诉他这台设备上行不行**。
          IconButton(
            tooltip: '关于',
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => const AboutScreen()),
            ),
            icon: const Icon(Icons.info_outline),
          ),
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
                child: _body(c),
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

  /// 时间线本体 + 尾巴上那一块**过程**（步骤流水 / 那行「它正在做…」）。
  ///
  /// ⚠️ 那一块**算在列表里**（会跟着滚），不是浮在输入框上面——
  ///    它是"这一轮正在发生"，属于对话流，不属于工具栏。
  Widget _body(ChatController c) {
    if (c.items.isEmpty && !c.hasProcess) return const _EmptyState();
    return ListView.builder(
      controller: _scroll,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      itemCount: c.items.length + (c.hasProcess ? 1 : 0),
      itemBuilder: (context, i) => i < c.items.length
          ? _render(c.items[i], c)
          : ProcessTail(
              level: c.level,
              busyText: c.agentLine,
              steps: c.steps,
              reasoning: c.reasoning,
            ),
    );
  }

  /// 打开四档的切换面板。**选中即生效**（换档会重连，见 `setLevel`）。
  Future<void> _pickLevel(ChatController c) async {
    await showModalBottomSheet<void>(
      context: context,
      builder: (sheet) => ProcessLevelMenu(
        current: c.level,
        onPick: (level) {
          Navigator.of(sheet).pop();
          c.setLevel(level);
        },
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
    // 屏幕上那句话在 `models/conn_state.dart` 里（纯函数，进硬闸）——
    // ⚠️ 别在这里直接写死："网断了"这句话曾经在网没断的时候也显示（那是一次事故）。
    final (String? text, bool isError) = statusLine(state, error: error);
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
