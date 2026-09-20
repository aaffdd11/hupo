// 气泡。手册 `08-SPEC.md` §6（界面铁律）、`05-DECISIONS.md` §3.1（四态）。
//
// 一条硬规矩：**不许写死尺寸**。容器跟着字算，跟在系统字号后面。
// 走查里最实在的一条故障是"字大了、笼子没大"——1.75 倍就溢出。
//
// 另一条：**四态必须一眼可辨，而且不能只靠颜色**。
// 色盲、屏幕反光、平板在阳台上——颜色是最不可靠的那个通道。
// ⇒ 每态都配一个**图标 + 文字**。

import 'package:flutter/material.dart';

import '../models/message_state.dart';
import '../models/timeline.dart';

/// 四态的视觉。**图标 + 文字**双通道，不靠颜色单独承载信息。
({IconData icon, String label}) _stateMark(MessageState s) => switch (s) {
      MessageState.queued => (icon: Icons.schedule, label: '已交出去'),
      MessageState.sent => (icon: Icons.check, label: '已送到'),
      MessageState.confirmed => (icon: Icons.done_all, label: '已收到'),
      MessageState.failed => (icon: Icons.error_outline, label: '没发出去'),
    };

class UserBubble extends StatelessWidget {
  const UserBubble({super.key, required this.utterance, this.onResend});

  final UserUtterance utterance;
  final VoidCallback? onResend;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final failed = utterance.state == MessageState.failed;
    final mark = _stateMark(utterance.state);

    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 520),
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: failed
              // 失败：底色也换掉——但**不只靠颜色**，下面还有图标与字
              ? theme.colorScheme.errorContainer
              : theme.colorScheme.primaryContainer,
          borderRadius: BorderRadius.circular(14),
          border: failed ? Border.all(color: theme.colorScheme.error, width: 1.5) : null,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Text(utterance.text, style: theme.textTheme.bodyLarge),
            const SizedBox(height: 4),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(mark.icon, size: theme.textTheme.bodySmall!.fontSize! + 4),
                const SizedBox(width: 4),
                Text(mark.label, style: theme.textTheme.bodySmall),
                if (failed && onResend != null) ...[
                  const SizedBox(width: 12),
                  // 触控目标 ≥44：视觉上是个小按钮，用 padding 把命中区撑起来
                  TextButton(
                    onPressed: onResend,
                    style: TextButton.styleFrom(
                      minimumSize: const Size(44, 44),
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      tapTargetSize: MaterialTapTargetSize.padded,
                    ),
                    child: const Text('重发'),
                  ),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// 助手说的一条。快答与深答**在同一个气泡里**（协议 R2）。
class AnswerBubble extends StatelessWidget {
  const AnswerBubble({super.key, required this.message});

  final AssistantMessage message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final text = message.displayText;

    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        // 限宽：太宽的长行没人读得下去（平板上一行 70 个字）
        constraints: const BoxConstraints(maxWidth: 760),
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: theme.colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(14),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (text.isEmpty)
              // 一句话都还没有：不要留一个空气泡，给一个"在处理"的轻标记
              Text('在处理…', style: theme.textTheme.bodySmall)
            else
              Text(text, style: theme.textTheme.bodyLarge),
            if (message.sources.isNotEmpty) ...[
              const SizedBox(height: 8),
              ...message.sources.take(5).map(
                    (s) => Text(
                      '· ${s['title'] ?? s['url'] ?? '来源'}',
                      style: theme.textTheme.bodySmall,
                    ),
                  ),
            ],
            if (message.ended && message.reason != null && message.reason != 'completed')
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text('（这条没说完）', style: theme.textTheme.bodySmall),
              ),
          ],
        ),
      ),
    );
  }
}

/// 系统说话。**与聊天气泡是两条不同的通道**（手册 R3）。
///
/// 为什么要分开：系统替用户做的决定（建了个东西、一件事做完了、删去哪了）
/// **不是对话**。混进气泡里，用户会以为"它在跟我唠嗑"。
class SystemNotice extends StatelessWidget {
  const SystemNotice({super.key, required this.text, this.onUndo});

  final String text;
  final VoidCallback? onUndo;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Icon(Icons.info_outline, size: theme.textTheme.bodySmall!.fontSize! + 4),
          const SizedBox(width: 8),
          Expanded(child: Text(text, style: theme.textTheme.bodySmall)),
          if (onUndo != null)
            TextButton(
              onPressed: onUndo,
              style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
              child: const Text('撤销'),
            ),
        ],
      ),
    );
  }
}

/// 时间线上的一条分隔（"你不在的时候"）。**它占一个位置，但不是消息。**
class MarkerLine extends StatelessWidget {
  const MarkerLine({super.key, required this.marker});

  final TimelineMarker marker;

  @override
  Widget build(BuildContext context) {
    final label = switch (marker.kind) {
      'away' => marker.label ?? '你不在的时候',
      'enter' => '进入「${marker.label ?? ''}」',
      'leave' => '离开「${marker.label ?? ''}」',
      _ => marker.label ?? '',
    };
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        children: [
          const Expanded(child: Divider()),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10),
            child: Text(label, style: theme.textTheme.bodySmall),
          ),
          const Expanded(child: Divider()),
        ],
      ),
    );
  }
}
