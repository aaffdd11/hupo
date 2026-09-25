// 多选态那条**底栏工具条**（契约 `docs/dev/106-CHAT-SELECT.md` §一）：
//
//     已选 N 条    【复制】  【取消】
//
// ⚠️ 文案不写在这儿 —— 在 `models/trash_words.dart`（和气泡菜单那几句**同一份表**），
//    那样它才进得了 `test/unit` 的禁用词硬闸。
//
// ⚠️ 用 `Wrap` 而不是 `Row`：字放大到 3.1 倍时"已选 N 条 + 两个按钮"一行摆不下，
//    `Row` 会当场溢出（D3.5 那道硬闸）；`Wrap` 换行就好，
//    而且**行高跟着字算**（不写死尺寸，手册 D3）。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/trash_words.dart';

class BubbleSelectBar extends StatelessWidget {
  const BubbleSelectBar({
    super.key,
    required this.count,
    required this.onCopy,
    required this.onCancel,
  });

  /// 已选几条。⚠️ 数的是**选中的条数**，不是"有几条能复制"
  /// （能不能复制由按下去之后那句实话回答）。
  final int count;

  final VoidCallback onCopy;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Material(
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
              Text(bubbleSelectCount(count), style: theme.textTheme.labelLarge),
              // 触控目标 ≥44（D3.6）：`minimumSize` 撑命中区
              TextButton.icon(
                onPressed: onCopy,
                icon: const Icon(Icons.copy_outlined),
                label: const Text(bubbleMenuCopy),
                style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
              ),
              TextButton(
                onPressed: onCancel,
                style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
                child: const Text(bubbleSelectCancel),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
