// 气泡长按之后那三个动作（契约 `docs/dev/28-DELETE.md` §二 第 2 条；
// 【复制】【多选】见 `docs/dev/106-CHAT-SELECT.md` §一）。
//
// ── 🔴 2026-09-26：它从"一层弹出的底部菜单"改成"输入条上面那条横条" ──────
//
// 根因（真机 + 合成触屏都复现了，读数在 `docs/dev/124-TOUCH-REGRESSION.md`）：
//   原来那一版是 `showModalBottomSheet`。它带一层**铺满全屏的 barrier**，
//   于是**只要它弹着，整个窗口就死了**：
//     · 时间线拖不动（那一下被 barrier 吃掉）；
//     · 抓手行上每一颗按钮都没反应（同上）；
//     · 输入条被那张单子**整个盖住** ⇒ "发不出去"。
//   而它是**手按住不放**触发的：`kLongPressTimeout` 只有 **500ms**
//   —— 真手指"按下去准备滑"的那一下、老人家的慢按，都够。
//   ⚠️ 合成的瞬点（`tester.tap` / 探针的 down+up 同拍）**永远碰不到**它
//   ⇒ 桌面那一套判据、上一批的探针**全都看不见这条**（这就是 #168 漏掉它的原因）。
//   ⇒ 收起那一档没有气泡可长按 ⇒ 只有它正常 ⇒ 主人那句"**收起才能发送**"。
//
// ⇒ 现在的形状：**不弹层、不铺 barrier**，就是输入条**上面**一条横条
//   （与 `BubbleSelectBar` 同一个姿势、同一个位置），所以：
//   它开着的时候时间线照样能滑、输入条照样能发、抓手行照样点得动。
//   ⚠️ 这一条**不是**"少画一点"：它保证的是**任何一层都不许把整个窗口吃掉**。
//
// ⚠️ 位置**等主人看过再定** ⇒ 将来挪地方时只丢这一个文件。
//
// ⚠️ 文案不写在这儿——在 `models/trash_words.dart`，
//    那样它才进得了 `test/unit` 的禁用词硬闸。
//
// ⚠️ 用 `Wrap`（和 `BubbleSelectBar` 同一条理由）：3.1 倍字号下
//    "标题 ＋ 四个按钮"一行摆不下，`Row` 会当场溢出（D3.5 那道硬闸）；
//    `Wrap` 换行就好，而且**行高跟着字算**（不写死尺寸，手册 D3）。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/trash_words.dart';

/// 长按气泡之后选了什么。
///
/// ⚠️ 契约 `docs/dev/106-CHAT-SELECT.md` §一 起多了【复制】【多选】两项
///    —— 枚举本来就是为这个留的（"将来加'复制'之类不用改调用方的形状"）。
/// ⚠️ **`delete` 的位置与含义一个字没动**（回收站那条路照旧）。
enum BubbleAction { copy, select, delete }

/// 那条横条本身的 key（判据用它量：它在不在、会不会挡住别的东西）。
const Key bubbleActionsBarKey = Key('bubble-actions-bar');

/// **长按气泡之后那一条**（输入条上面；不是一层弹层 —— 见文件头）。
class BubbleActionsBar extends StatelessWidget {
  const BubbleActionsBar({
    super.key,
    required this.onPick,
    required this.onCancel,
  });

  /// 选中了哪一项（复制 / 多选 / 删掉）。
  final ValueChanged<BubbleAction> onPick;

  /// 【算了】：什么都不做，把这条收起来。
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // 命中区 ≥44（D3.6）：`minimumSize` 撑起来（视觉可以小，命中区不许小）
    final style = TextButton.styleFrom(minimumSize: const Size(44, 44));
    return Material(
      key: bubbleActionsBarKey,
      color: d.card,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: EdgeInsets.symmetric(horizontal: d.gapM, vertical: d.gapS),
          child: Wrap(
            alignment: WrapAlignment.end,
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: d.gapS,
            runSpacing: d.gapXs,
            children: [
              Text(bubbleMenuTitle, style: theme.textTheme.labelLarge),
              TextButton.icon(
                onPressed: () => onPick(BubbleAction.copy),
                icon: const Icon(Icons.copy_outlined),
                label: const Text(bubbleMenuCopy),
                style: style,
              ),
              TextButton.icon(
                onPressed: () => onPick(BubbleAction.select),
                icon: const Icon(Icons.checklist),
                label: const Text(bubbleMenuSelect),
                style: style,
              ),
              // ⚠️ 那句"先放进回收站"原来挂在这张单子的副标题上；横条里没有副标题
              //    ⇒ 改挂**无障碍提示**（读屏照旧听得到，视觉上不再多占一行）。
              Semantics(
                hint: bubbleMenuDeleteHint,
                child: TextButton.icon(
                  onPressed: () => onPick(BubbleAction.delete),
                  icon: const Icon(Icons.delete_outline),
                  label: const Text(bubbleMenuDelete),
                  style: style,
                ),
              ),
              TextButton(
                onPressed: onCancel,
                style: style,
                child: const Text(bubbleMenuCancel),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
