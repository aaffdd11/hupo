// 过程怎么画（手册 **D7** / 契约 `docs/dev/26-PROCESS-LEVELS.md` §一）。
//
// 三样东西各画各的，**因为它们是三种不同的东西**：
//
//   ① 步骤流水 —— 它**做了哪几步**（第 ③ 档）。一步步摆在对话流尾巴上。
//   ② 推理原文 —— 它**心里想的**。⚠️ **不是它说的话**（D7.4）：
//      视觉上必须一眼分得开——气泡是"它对你说的"，这一块是"它没说出口的"。
//      所以它用**另一种容器**（左边一道竖线 + 更暗的底 + 斜体），
//      而不是再套一个气泡。
//   ③ 安静档 —— **什么都不画**（连「它正在做…」也没有）。
//
// ⚠️ 一条硬规矩：**不许写死尺寸**（D3）。容器跟着字算：
//    图标大小从 `textTheme` 的字号推，间距一律用 padding。
//
// ⚠️ 这一层是**傻组件**：只看 models（楼层闸）。档位与内容的取舍
//    在 `chat_controller` 那一层就做完了。

import 'package:flutter/material.dart';

import '../models/process_levels.dart';
import '../models/process_words.dart';
import '../models/timeline.dart';
import 'bubbles.dart';

/// 对话流尾巴上的那一块过程。
class ProcessTail extends StatelessWidget {
  const ProcessTail({
    super.key,
    required this.level,
    required this.busyText,
    required this.steps,
    required this.reasoning,
  });

  final ProcessLevel level;

  /// 「它正在做…」那句（**已经按档位掐过**：安静档到这里就是 null）。
  final String? busyText;

  /// 第 ③ 档的步骤流水（其余档位为空）。
  final List<ProcessStep> steps;

  /// 第 ④ 档的思考原文（其余档位为空串）。
  final String reasoning;

  @override
  Widget build(BuildContext context) {
    // ① 安静档：**什么都不画**——不是"画淡一点"，是一个像素都不占。
    if (level == ProcessLevel.quiet) return const SizedBox.shrink();

    // ② 在做什么：就那一行。原来的行为一个字都不动。
    if (level == ProcessLevel.doing) {
      final text = busyText;
      return text == null ? const SizedBox.shrink() : BusyLine(text: text);
    }

    // ③ 步骤流水 / 推理原文。
    final shown = _shownSteps();
    final hasReasoning = reasoning.isNotEmpty;
    if (shown.isEmpty && !hasReasoning) {
      // 还没有步骤可摆（比如状态先到、第一件活还没开）⇒
      // 用那行「它正在做…」把空白补上，**不许留白**。
      final text = busyText;
      return text == null ? const SizedBox.shrink() : BusyLine(text: text);
    }

    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final s in shown) _StepLine(step: s, theme: theme),
        if (hasReasoning) _ReasoningBlock(text: reasoning, theme: theme),
      ],
    );
  }

  /// 认不出来的状态名 ⇒ **跳过**（N10：沉默优于编造，内部词绝不上屏）。
  List<ProcessStep> _shownSteps() =>
      [for (final s in steps) if (processWord(s.state) != null) s];
}

/// 一句话一步。
class _StepLine extends StatelessWidget {
  const _StepLine({required this.step, required this.theme});

  final ProcessStep step;
  final ThemeData theme;

  @override
  Widget build(BuildContext context) {
    final word = processWord(step.state)!;
    // 图标跟着字号走（不写死尺寸）
    final iconSize = theme.textTheme.bodySmall!.fontSize! + 4;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3, horizontal: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            step.done ? Icons.check : Icons.more_horiz,
            size: iconSize,
            color: theme.hintColor,
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              word,
              style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
            ),
          ),
        ],
      ),
    );
  }
}

/// 它的思考原文。⚠️ **视觉上必须和"它说的话"分得开**——它不是它说的话。
///
/// 手段（都不靠尺寸，靠"形状 + 颜色 + 字体"三个通道）：
///   · 左边一道竖线（气泡是圆角矩形，这一块是"引文"的样子）
///   · 更暗的底（气泡用的是 `surfaceContainerHighest`）
///   · 斜体 + 提示色 + 一行标题说明"这是没说出口的"
class _ReasoningBlock extends StatelessWidget {
  const _ReasoningBlock({required this.text, required this.theme});

  final String text;
  final ThemeData theme;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(top: 6),
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHigh,
        border: Border(
          left: BorderSide(color: theme.colorScheme.outline, width: 3),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            reasoningLabel,
            style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 4),
          Text(
            text,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.hintColor,
              fontStyle: FontStyle.italic,
            ),
          ),
        ],
      ),
    );
  }
}
