// 过程怎么画（手册 **D7** / 契约 `docs/dev/122-TWO-PROCESS-LEVELS.md` §一）。
//
// 现在只剩**两档**，要画的东西只有两样：
//
//   ① 「它正在做…」 —— 屏幕上**别的什么都没有**时，它是唯一的"它在动"信号
//      （默认档 `doing`）。
//   ② 推理原文 —— 它**心里想的**。⚠️ **不是它说的话**（D7.4）：
//      视觉上必须一眼分得开——气泡是"它对你说的"，这一块是"它没说出口的"。
//      所以它用**另一种容器**（左边一道竖线 + 更暗的底 + 斜体），
//      而不是再套一个气泡。
//      ⚠️ 它摆在**它自己那条气泡的正下方**（`chat_screen._answer`），
//      而且**收口不清**：主人回头要看的是"这条回答当时怎么想的"。
//
// ⚠️ **步骤流水那串行已经不画了**（2026-09-26，主人「名不副实的要去掉。」）：
//    工具行（`tool_rows_view.dart`）已经把"做了哪几步、成没成、入参输出"
//    说得更准更全，而且**落盘、切回来还在**；再画一串粗粒度、瞬态
//    （切走就没）的重复行**只是噪音**。
//    ⇒ `Timeline` 仍然认 `step/*`（那是**老客户端 `steps` 档**的通道，
//      `docs/dev/122` §四），但**这一层不画它**。
//
// ⚠️ 一条硬规矩：**不许写死尺寸**（D3）。容器跟着字算：
//    图标大小从 `textTheme` 的字号推，间距一律用 padding。
//
// ⚠️ 这一层是**傻组件**：只看 models（楼层闸）。档位与内容的取舍
//    在 `chat_controller` 那一层就做完了。

import 'package:flutter/material.dart';

import '../models/process_words.dart';
import 'dsh_look.dart';
import 'bubbles.dart';

/// 对话流尾巴上的那一块过程（**只有那行「它正在做…」**）。
///
/// ⚠️ 推理原文**不在这儿**：它挂在**它自己那条气泡**下面
///    （`ReasoningBlock`，由 `chat_screen._render` 摆），因为主人回头要看的是
///    "**这条回答**当时怎么想的"——摆到尾巴上就会跟着下一轮跑掉。
///
/// ⚠️ 步骤流水**不在这儿**：那一档已经从菜单上砍掉（见文件头）。
class ProcessTail extends StatelessWidget {
  const ProcessTail({super.key, required this.busyText});

  /// 「它正在做…」那句；`null` = **一个像素都不占**。
  final String? busyText;

  @override
  Widget build(BuildContext context) {
    final text = busyText;
    return text == null ? const SizedBox.shrink() : BusyLine(text: text);
  }
}

/// 它的思考原文。⚠️ **视觉上必须和"它说的话"分得开**——它不是它说的话。
///
/// 手段（都不靠尺寸，靠"形状 + 颜色 + 字体"三个通道）：
///   · 左边一道竖线（气泡是圆角矩形，这一块是"引文"的样子）
///   · 更暗的底（气泡用的是 `surfaceContainerHighest`）
///   · 斜体 + 提示色 + 一行标题说明"这是没说出口的"
///
/// ⚠️ 它由 `chat_screen` 摆在**它那条气泡的正下方**：主人回头看的是
///    "这条回答当时怎么想的"，所以要跟着那条走，不能挂在尾巴上。
class ReasoningBlock extends StatelessWidget {
  const ReasoningBlock({super.key, required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // 限宽与气泡一致（平板上一行七十个字没人读）
    return Align(
      alignment: Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 760),
        child: Container(
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
                // ★ `119`：抬头与小字都跟着用户字号轴（同上）
                style: TextStyle(
                  fontSize: DshLook.of(context).caption.size,
                  height: DshLook.of(context).caption.lineHeight / DshLook.of(context).caption.size,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                text,
                style: TextStyle(
                  fontSize: DshLook.of(context).content.size,
                  height: DshLook.of(context).content.lineHeight / DshLook.of(context).content.size,
                ).copyWith(
                  color: theme.hintColor,
                  fontStyle: FontStyle.italic,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
