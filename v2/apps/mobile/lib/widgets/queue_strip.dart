// **排队那条横条**：他还在等上一件事时又说了的那几句 —— 看得见、撤得掉。
//
// ── 形状是从哪来的（DSH 的 QueueDock）────────────────────────
// 研究 `docs/dev/115-DSH-WINDOW-PARITY.md` §一.5 / 原始证据 `115-raw/B-render.md` §3.3：
//   · **一条 ⇒ 一行内联**（带自己的小图标）；
//   · **两条以上 ⇒ 默认折在一个带计数的抬头后面**（点抬头展开）；
//   · 每一行 = 那句话（一行、超出省略号）＋ 一个**撤掉**的按钮；
//   · **一条都没有 ⇒ 什么都不画**（`rowCount === 0 → null`）。
// ⇒ 这一份就照那四条写。⚠️ DSH 每行还有 Edit / Steer 两个动作 ——
//    `115` §六 把它们列在**后面几期**（丙-4 的其余部分），这一批**不做**：
//    这一批只做"**看得见 ＋ 撤得掉**"（主人 2026-09-26 那批的下一刀）。
//
// ── 数值只有一处 ──────────────────────────────────────────
// 颜色 / 字号 / 行高 / 间距 / 发丝线全部来自 `models/dsh_design.dart`
// （那一份顶上写着数值是哪来的：DSH 真包解出来的 token）。这一份里**没有一个写死的数**
// —— `design_tokens_test.dart` 那条棘轮盯着（新文件的上限是 0 处）。
// ⚠️ `DshType` → `TextStyle` 那一小层与"色板 ＋ 用户字号轴"都走
//    `widgets/dsh_look.dart`：批次 4 起它是**唯一**的取值口（`appearance_scope`
//    把用户选的外观与字号传下来）——原来这一份自己抄了一小份 `_QueueLook`，
//    用户字号一接上就会变成"这一块不跟着设置走"，所以那一份**删掉**了。
//
// ── 三条硬约束 ────────────────────────────────────────────
//   ① **有界 ≠ 截断**：两条以上时列表有最高高度（`dshQueueListMaxHeight`），
//      超了在框里滚 —— 一屏塞不下不许把聊天区顶没。
//   ② **不许溢出**：五档字号（1.0–3.1）下横向一律 `Expanded` + 一行省略号
//      （`test/widget/accessibility_test.dart` 是硬闸）。
//   ③ **可点的都是真按钮**，命中区 ≥44（D3.6）：撤掉那颗是 `IconButton`（Material
//      撑着），抬头那颗是 `TextButton(minimumSize: 44×44)`。
//      ⚠️ **不许**用裸 `GestureDetector`（源码级禁令，同 `chat_floater.dart` 那条）。

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../models/chat_queue.dart';
import '../models/dsh_design.dart';
import '../models/queue_words.dart';
import 'dsh_look.dart';

/// 判据用的键：那条横条本体 / 两条以上时那个抬头。
const Key queueStripKey = Key('queue-strip');
const Key queueHeaderKey = Key('queue-header');

/// **排队那条横条**（渲染在输入条**上面**、浮窗里面）。
///
/// ⚠️ **空队 ⇒ `SizedBox.shrink()`**：**一个像素都不占**（不是"零高度的框还带 padding"
///    —— 那会在输入条上面留一条看不见的缝，而且高度还随 padding 变）。
class QueueStrip extends StatefulWidget {
  const QueueStrip({super.key, required this.queue, required this.onCancel});

  /// 现在排着什么（空 ⇒ 什么都不画）。
  final ChatQueue queue;

  /// 他按了某一行上那个"不发了" ⇒ 把这个 `messageId` 交出去撤。
  /// ⚠️ 这里**不做**乐观删除（屏幕上那一行等新快照回来才消失 —— 见控制器那份说明）。
  final ValueChanged<String> onCancel;

  @override
  State<QueueStrip> createState() => _QueueStripState();
}

class _QueueStripState extends State<QueueStrip> {
  /// **两条以上时那个抬头展开了没有**（DSH：`collapsed` 默认 **true**）。
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final items = widget.queue.items;
    // 🔴 `rowCount === 0 → null`（DSH 原话）：空的时候**什么都不画**。
    if (items.isEmpty) return const SizedBox.shrink();
    final look = DshLook.of(context);
    final p = look.palette;
    final multi = items.length > 1;
    // 一条 ⇒ 直接内联；两条以上 ⇒ 抬头说了算。
    final showRows = !multi || _expanded;
    return Column(
      key: queueStripKey,
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // 上边一条**发丝线**（0.5，不是 1.0 —— 见 `dshHairline` 那段）。
        Container(height: dshHairline, color: p.borderL1),
        if (multi) _header(look, items.length),
        if (showRows)
          ConstrainedBox(
            // 有界（超了在框里滚）—— 见文件头约束 ①
            // ⚠️ 上限取 `min(180, 屏高 × 比例)`：只用那个 180 的话，3.1 倍字号下
            //    这一块会把聊天区挤没（D3.5 那道硬闸当场红）—— 见 `dsh_design.dart`
            //    里那两个常量各自的说明。
            constraints: BoxConstraints(
              maxHeight: math.min(
                dshQueueListMaxHeight,
                MediaQuery.sizeOf(context).height * dshQueueListMaxHeightFactor,
              ),
            ),
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [for (final it in items) _row(look, it)],
              ),
            ),
          ),
      ],
    );
  }

  /// 两条以上时那个抬头（点它展开 / 收起）。
  Widget _header(DshLook look, int count) {
    final p = look.palette;
    return SizedBox(
      width: double.infinity,
      child: TextButton(
        key: queueHeaderKey,
        onPressed: () => setState(() => _expanded = !_expanded),
        // D3.6：命中区下限 44（视觉可以小，命中区不许小）
        style: TextButton.styleFrom(
          minimumSize: const Size(44, 44),
          alignment: Alignment.centerLeft,
          foregroundColor: p.labelSecondary,
          padding: const EdgeInsets.symmetric(horizontal: DshSpace.s8),
        ),
        child: Row(
          children: [
            Icon(
              _expanded ? Icons.keyboard_arrow_down : Icons.keyboard_arrow_up,
              size: look.content.size,
              color: p.labelTertiary,
            ),
            const SizedBox(width: DshSpace.s8),
            // ⚠️ `Expanded` + 省略号：大字号下那句计数也不许把这一行顶出去。
            Expanded(
              child: Text(
                queueCountHeader(count),
                overflow: TextOverflow.ellipsis,
                style: dshTextStyle(look.content, p.labelSecondary),
              ),
            ),
            // 抬头那一颗也带一句读屏/悬停的话（它是"点开会发生什么"）。
            Tooltip(
              message: _expanded ? queueCollapseLabel : queueExpandLabel,
              child: Icon(Icons.expand_more, size: look.content.size, color: p.labelTertiary),
            ),
          ],
        ),
      ),
    );
  }

  /// 一行 = 那句话（一行、超出省略号）＋ 撤掉那颗按钮。
  Widget _row(DshLook look, ChatQueueItem item) {
    final p = look.palette;
    return Padding(
      padding: const EdgeInsets.only(left: DshSpace.s8),
      child: Row(
        children: [
          Icon(Icons.schedule, size: look.caption.size, color: p.labelTertiary),
          const SizedBox(width: DshSpace.s6),
          // ⚠️ `Expanded` + `maxLines: 1` + 省略号：这是**屏幕上**的裁剪，
          //    与服务端那个"截到 200 字符"（`ChatQueueItem.truncated`）**不是一回事**；
          //    两个都如实留着，谁也不冒充谁。
          Expanded(
            child: Text(
              item.text,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: dshTextStyle(look.content, p.labelSecondary),
            ),
          ),
          // 撤掉这颗**是真按钮**：命中区由 Material 撑着（D3.6 ≥44）。
          IconButton(
            onPressed: () => widget.onCancel(item.messageId),
            tooltip: queueCancelLabel,
            icon: const Icon(Icons.close),
            color: p.labelTertiary,
          ),
        ],
      ),
    );
  }
}
