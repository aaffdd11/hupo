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
import '../models/dsh_design.dart';
import '../models/notice.dart';
import '../models/notice_words.dart';
import 'dsh_look.dart';

/// **时间线里那一条通知**（约束 2）。
///
/// ⚠️ 它由 `chat_screen._render` 摆在对话流里 ⇒ **占一个位置**，
///    而且冷启动重放（本机缓存里那一屏）也画得出来。
/// ⚠️ [count] > 1 = 这是**连着同样几句合成的一行**（契约 `154` §2.1）：
///    那句话**逐字是服务端给的**，只在末尾多一个次数。
class NoticeLine extends StatelessWidget {
  const NoticeLine({super.key, required this.notice, this.count = 1});

  final Notice notice;

  /// 连着几句合成一行的次数（`1` = 就是一条）。
  final int count;

  @override
  Widget build(BuildContext context) => NoticeCard(notice: notice, count: count);
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
  const NoticeStrip({super.key, required this.notice, this.onDismiss});

  final Notice notice;
  final VoidCallback? onDismiss;

  @override
  Widget build(BuildContext context) {
    // **在布局里**的一条（不是浮窗）：画在输入条上面，跟别的 strip 一样占位置。
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 0, 8, 6),
      child: NoticeCard(
        notice: notice,
        onDismiss: onDismiss,
        // ★ 瞬态那条：把"它不在记录里"说出来
        footnote: notice.urgent ? noticeNotKeptLine : null,
      ),
    );
  }
}

/// 一条通知长什么样。**两处共用**（时间线里那一条 / 输入条上面那条瞬态）。
///
/// 🔴 **2026-10-03：那个「撤销」（拿回来）整条砍了**（主人：*"回收站…我们也不需要"*）
///    ⇒ 通知上**不再有任何按钮**（只有那条事实本身）；`notice.undo` 照旧解析
///    （协议冻结），只是**不画**。
///
/// 🔴 ★ **2026-10-02 改过形状**（契约 `docs/dev/154-CHAT-RECORD-LOOK.md` §2.1）：
///    主人让我重做聊天窗口，我登录拍到的屏幕上是**连着九张一模一样的粉色卡**
///    （`accentTint` 底 ＋ 描边 ＋ ⓘ）—— 真正说的话被压在中间，一眼看过去像满屏报错。
///    ⇒ 通知回到它本来的分量：**一行安静的字**（小图标 ＋ 次要色，**不铺底、不描边**）。
///    🔴 **只有"出事"那两档仍占一块底**（`crash` / `diskFull`）——
///       那两件值得占眼睛；别的（"我去做，做完叫你""做完了"）不值得。
class NoticeCard extends StatelessWidget {
  const NoticeCard({
    super.key,
    required this.notice,
    this.onDismiss,
    this.footnote,
    this.count = 1,
  });

  final Notice notice;
  final VoidCallback? onDismiss;

  /// 底下补的一句话（今天只有瞬态那条用：[noticeNotKeptLine]）。
  final String? footnote;

  /// ★ **连着同样几句**合成一行时，它一共出现了几次（契约 `154` §2.1）。
  ///
  /// ⚠️ 服务端给的那句话**照抄**，这里只在末尾挂一个次数（`（4 次）`）；
  ///    `count <= 1` 时**一个字都不加**。合并判据在 `timeline.mergeableNotices`。
  final int count;

  /// 这一条是不是"出事"那一档（值得占一块底）。
  bool get _loud =>
      notice.kind == NoticeKind.crash || notice.kind == NoticeKind.diskFull;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final look = DshLook.of(context);
    final p = look.palette;
    // 图标跟着字算（**不写死尺寸**，D3）
    // ★ 2026-10-01：通知是"非主要"⇒ 走非主要那一档（`look.quiet` = 11/14）
    final iconSize = look.quiet.size + 4;
    final note = footnote;

    final row = Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(
          // 出事那两条用一个"注意"的图标，别的用"信息"——
          // ⚠️ 图标**只是补充**：不许只靠它承载信息（四态那条纪律同理）。
          _loud ? Icons.warning_amber_outlined : Icons.info_outline,
          size: iconSize,
          // ⚠️ 安静那一档的图标也要**看得见**：用次要色，不用最淡那一级
          color: _loud ? d.accent : p.labelTertiary,
        ),
        const SizedBox(width: DshSpace.s8),
        Expanded(
          child: Text.rich(
            TextSpan(
              // ★ **服务端给的那句话，照抄**（契约 §五 🔴）——一个字节都不改
              text: notice.text,
              children: [
                if (count > 1)
                  TextSpan(
                    text: ' ${noticeRepeatSuffix(count)}',
                    style: dshTextStyle(look.caption, p.labelCaption),
                  ),
              ],
            ),
            style: dshTextStyle(
              look.quiet,
              _loud ? theme.colorScheme.onSecondaryContainer : p.labelSecondary,
            ),
          ),
        ),
        if (onDismiss != null) ...[
          const SizedBox(width: DshSpace.s4),
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
    );

    // ── 安静那一档：**一行字**，不铺底、不描边（它就是"顺口说一声"）──
    if (!_loud) {
      return Padding(
        // ⚠️ 上下留白跟着字走（`look.quiet` 那一档的 4）
        padding: const EdgeInsets.symmetric(vertical: DshSpace.s4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            row,
            if (note != null)
              Padding(
                padding: const EdgeInsets.only(top: 2, left: DshSpace.s4),
                child: Text(note, style: dshTextStyle(look.quiet, p.labelTertiary)),
              ),
          ],
        ),
      );
    }

    // ── "出事"那一档：留一块底（原来那块形状不变，只把文案换成上面那个）──
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
          row,
          if (note != null)
            Padding(
              padding: const EdgeInsets.only(top: 2, left: 4),
              child: Text(note, style: dshTextStyle(look.quiet, look.palette.labelTertiary)),
            ),
        ],
      ),
    );
  }

}
