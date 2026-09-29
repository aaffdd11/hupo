// 系统通知**在屏幕上怎么画**（契约 `docs/dev/29-NOTICE.md` 约束 1 与 3）。
//
// 这一份里有两样东西，**它们在布局上的地位完全不同**，混起来就是这一件最贵的错：
//
//   · [NoticeLine] —— **时间线里那一条**（约束 2）。它进列表、跟着滚、
//     **占一个位置**：通知要经得起"你不在"（浮窗只是"喊一声"，会自己消失）。
//   · [NoticeOverlay] —— **浮窗**（约束 1）。它**浮在内容上面**，
//     **一个像素都不许挤动下面的东西**。判据是 **D4.8：新增助手消息触发的
//     高度变化必须 = 0px** —— 而浮窗比消息更容易犯这个错（它是个"条"），
//     所以它有专门的闸（`test/widget/notice_shape_test.dart（2026-09-30 改名）`，量的是
//     下面内容**变化前后同一个矩形**）。
//
// 两处都渲染撤销按钮（约束 3）：撤销窗口**不能随浮窗一起消失**。
// ⚠️ 是**同一个动作、同一条路**（`ChatController.undoNotice`）——
//    不是"浮窗里那个"和"时间线里那个"两套实现。
//
// ⚠️ 不许写死尺寸（D3）；文案在 `models/notice_words.dart`（那样才进得了
//    禁用词硬闸）。`notice.text` **是服务端给的**，这里一个字都不改写。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;

import '../models/notice.dart';
import '../models/notice_words.dart';

/// **时间线里那一条通知**（约束 2）。
///
/// ⚠️ 它由 `chat_screen._render` 摆在对话流里 ⇒ **占一个位置**，
///    而且冷启动重放（本机缓存里那一屏）也画得出来。
class NoticeLine extends StatelessWidget {
  const NoticeLine({super.key, required this.notice, this.onUndo});

  final Notice notice;

  /// 按撤销。`null` = 这一条没有撤销（或那条路今天走不通）⇒ 不画按钮。
  final VoidCallback? onUndo;

  @override
  Widget build(BuildContext context) => NoticeCard(
        notice: notice,
        onUndo: onUndo,
      );
}

/// **窗口里面那一条**（2026-09-30 起：**不再是浮窗**）。
///
/// 🔴 **主人 2026-09-30 原话**：*「顶部会出来一个浮窗，叫我去做做完叫你。这个不对。**不要浮窗**。」*
///    ⇒ 从前的 `NoticeOverlay`（`Stack` + `Positioned(top:0)` 浮在内容上面）**撤了**。
///    现在它**参与布局**：画在**浮窗里面**、输入条**上面**（与排队那条同一种形状），
///    收起档也看得见（输入条就在那一条里）—— 而**一个像素都不许盖在内容上**。
///
/// ⚠️ 这条只剩**瞬态那一种**（`notice/urgent`：写盘失败）。带号的通知
///    （"我去做，做完叫你"/"做完了"…）**只进时间线**（那是主人 2026-09-21 定的
///    "时间线留住"那一半，这一半**没动**）—— 不再"喊一声"。
///
/// ⚠️ **瞬态那条也要说清它不在记录里**（`29-NOTICE.md` §三①）：写盘失败时
///    时间线物理上写不进那一条 ⇒ 屏幕上**必须自己说清**（[noticeNotKeptLine]）。
class NoticeStrip extends StatelessWidget {
  const NoticeStrip({
    super.key,
    required this.notice,
    this.onUndo,
    this.onDismiss,
  });

  final Notice notice;
  final VoidCallback? onUndo;
  final VoidCallback? onDismiss;

  @override
  Widget build(BuildContext context) {
    // **在布局里**的一条（不是浮窗）：画在输入条上面，跟别的 strip 一样占位置。
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 0, 8, 6),
      child: NoticeCard(
        notice: notice,
        onUndo: onUndo,
        onDismiss: onDismiss,
        // ★ 瞬态那条：把"它不在记录里"说出来
        footnote: notice.urgent ? noticeNotKeptLine : null,
      ),
    );
  }
}

/// 一条通知长什么样。**两处共用**——于是"浮窗里那个撤销"和"时间线里那个撤销"
/// 不可能长得不一样、更不可能变成两套动作。
class NoticeCard extends StatelessWidget {
  const NoticeCard({
    super.key,
    required this.notice,
    this.onUndo,
    this.onDismiss,
    this.footnote,
  });

  final Notice notice;
  final VoidCallback? onUndo;
  final VoidCallback? onDismiss;

  /// 底下补的一句话（今天只有瞬态那条用：[noticeNotKeptLine]）。
  final String? footnote;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // 图标跟着字算（**不写死尺寸**，D3）
    final iconSize = theme.textTheme.bodySmall!.fontSize! + 4;
    final undo = notice.undo;
    final note = footnote;

    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      // ★ 2026-09-23 整理 UI（E）：原来这里用的是 **Material 自带的那两个色**
      //   （`secondaryContainer` / `outlineVariant`）+ 写死的 12 —— 全站就这一处
      //   不在我们自己的色板里，混在别的卡片中间一眼能看出不是一套。
      //   ⇒ 换成 `d.accentTint`（我们那层"很淡的同色"）+ `d.line`，圆角用 token。
      decoration: BoxDecoration(
        color: d.accentTint,
        borderRadius: BorderRadius.circular(d.radiusField),
        border: Border.all(color: d.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                // 出事那两条用一个"注意"的图标，别的用"信息"——
                // ⚠️ 图标**只是补充**：不许只靠它承载信息（四态那条纪律同理）。
                notice.kind == NoticeKind.crash || notice.kind == NoticeKind.diskFull
                    ? Icons.warning_amber_outlined
                    : Icons.info_outline,
                size: iconSize,
                color: d.accent,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  // ★ **服务端给的那句话，照抄**（契约 §五 🔴）
                  notice.text,
                  style: theme.textTheme.bodyMedium
                      ?.copyWith(color: theme.colorScheme.onSecondaryContainer),
                ),
              ),
              if (onDismiss != null) ...[
                const SizedBox(width: 4),
                TextButton(
                  onPressed: onDismiss,
                  style: TextButton.styleFrom(
                    // 触控 ≥44（D3.6 那道硬闸扫的就是这些按钮）
                    minimumSize: const Size(44, 44),
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                  ),
                  child: const Text(noticeDismissLabel),
                ),
              ],
            ],
          ),
          if (note != null)
            Padding(
              padding: const EdgeInsets.only(top: 2, left: 4),
              child: Text(note, style: theme.textTheme.bodySmall),
            ),
          if (undo != null && undo.usable) ...[
            // ⚠️ `Wrap` 不是 `Row`：字放到最大时按钮要能折行（D3.5 五档那道闸）
            Wrap(
              children: [
                TextButton(
                  onPressed: onUndo,
                  style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
                  // ⚠️ 按钮上的字**用服务端给的那份**（`undo.label`）：
                  //    客户端不另编一个说法，否则两边会漂。
                  child: Text(undo.label),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
