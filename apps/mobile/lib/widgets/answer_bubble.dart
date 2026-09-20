// 调度器一条消息的气泡。
//
// **这是"无缝衔接"在客户端的落点**（见 docs/handbook/08-SPEC.md §1.2）：
// 快速回答与深思回答必须渲染成**同一条消息** ——
// - 深答到达时**追加**到同一气泡内，不新起一条
// - 不做弹出动画（弹出会强调"这是新的一条"）
// - 打字指示器从快答平滑延续到深答，中间不消失
//
// 客户端的职责边界（评审结论 3.2）：**不做句子缓冲、不做回放**。
// 服务端已经决定何时放行文本；客户端收到什么就渲染什么。

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/stream_event.dart';
import '../models/timeline.dart';

class AnswerBubble extends StatelessWidget {
  const AnswerBubble({super.key, required this.message});

  final DispatcherMessage message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final text = message.displayText;
    final showStatus = !message.isFinished && message.status != null;

    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 560),
        margin: const EdgeInsets.symmetric(vertical: 6, horizontal: 12),
        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 14),
        decoration: BoxDecoration(
          color: theme.colorScheme.surfaceContainerHighest,
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(4),
            topRight: Radius.circular(16),
            bottomLeft: Radius.circular(16),
            bottomRight: Radius.circular(16),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // 主动开口：不伪装成"在回答你"，但不加标签 —— 调度器本来就是同一个人
            if (text.isNotEmpty) SelectableText(text, style: theme.textTheme.bodyLarge),

            if (showStatus) ...[
              if (text.isNotEmpty) const SizedBox(height: 8),
              _StatusLine(status: message.status!),
            ],

            // 查证来源：**只在真的有来源时出现**（没联网就不显示，也不解释）。
            // 位置放在正文之后 —— 先给结论，再给可核查的出处。
            if (message.hasAnyText && message.sources.isNotEmpty) ...[
              const SizedBox(height: 10),
              _SourceList(sources: message.sources),
            ],

            // 中止：只能追加说明（已显示的字撤不回来）
            if (message.endReason == MessageEndReason.aborted) ...[
              const SizedBox(height: 8),
              Text('（已停下）',
                  style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor)),
            ],

            // 失败：必须有**合法收尾**，不能留白（评审结论 Q1）
            if (message.endReason == MessageEndReason.failed) ...[
              const SizedBox(height: 8),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.info_outline, size: 14, color: theme.hintColor),
                  const SizedBox(width: 4),
                  Text('这条没能给出结论',
                      style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor)),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// 来源行：最多 3 条，点开浏览器。
///
/// 设计取舍：**不把链接塞进正文** —— 正文是"说给你的话"，来源是"你可以去核"。
/// 也不显示条数/耗时这类内部数字（用户不关心搜了几次）。
class _SourceList extends StatelessWidget {
  const _SourceList({required this.sources});

  final List<Source> sources;

  static const int _max = 3;

  Future<void> _open(BuildContext context, String url) async {
    final messenger = ScaffoldMessenger.maybeOf(context);
    try {
      final ok = await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
      if (!ok) throw StateError('launch returned false');
    } catch (_) {
      // 打不开就把链接给用户自己复制 —— **绝不悄悄失败**
      messenger?.showSnackBar(
        SnackBar(content: SelectableText('打不开链接：$url')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final shown = sources.take(_max).toList();
    final extra = sources.length - shown.length;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(Icons.link, size: 12, color: theme.hintColor),
            const SizedBox(width: 4),
            Text('来源',
                style: theme.textTheme.labelSmall?.copyWith(color: theme.hintColor)),
          ],
        ),
        const SizedBox(height: 4),
        Wrap(
          spacing: 6,
          runSpacing: 4,
          children: [
            for (final s in shown)
              InkWell(
                onTap: () => _open(context, s.url),
                borderRadius: BorderRadius.circular(10),
                child: Container(
                  constraints: const BoxConstraints(maxWidth: 200),
                  padding: const EdgeInsets.symmetric(vertical: 3, horizontal: 8),
                  decoration: BoxDecoration(
                    color: theme.colorScheme.surface,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(
                    s.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: theme.colorScheme.primary,
                    ),
                  ),
                ),
              ),
            if (extra > 0)
              Text('+$extra',
                  style: theme.textTheme.labelSmall?.copyWith(color: theme.hintColor)),
          ],
        ),
      ],
    );
  }
}

/// 状态提示行。三种状态在视觉上**必须可分**（思考 / 工作中 / 交接）。
class _StatusLine extends StatelessWidget {
  const _StatusLine({required this.status});

  final StreamStatus status;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // 文案只用用户能懂的话，**不出现"交接/处理层/深答"这类内部概念**
    final (label, animated) = switch (status) {
      StreamStatus.thinking => ('正在查…', true),
      StreamStatus.working => ('还在处理，这个要多花点时间…', true),
      StreamStatus.handoff => ('马上说完', true),
      StreamStatus.listening => ('正在听…', false),
    };
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (animated)
          SizedBox(
            width: 12,
            height: 12,
            child: CircularProgressIndicator(strokeWidth: 1.6, color: theme.hintColor),
          )
        else
          Icon(Icons.graphic_eq, size: 14, color: theme.hintColor),
        const SizedBox(width: 6),
        Flexible(
          child: Text(label,
              style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor)),
        ),
      ],
    );
  }
}
