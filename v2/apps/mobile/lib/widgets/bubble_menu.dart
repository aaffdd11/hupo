// 气泡长按菜单（契约 `docs/dev/28-DELETE.md` §二 第 2 条；
// 2026-09-25 起多了【复制】【多选】两项 —— `docs/dev/106-CHAT-SELECT.md` §一）。
//
// ⚠️ 位置**等主人看过再定** ⇒ 将来挪地方时只丢这一个文件。
//
// ⚠️ 文案不写在这儿——在 `models/trash_words.dart`，
//    那样它才进得了 `test/unit` 的禁用词硬闸。
//
// ⚠️ 用 `ListView(shrinkWrap: true)`（和过程四档那个面板同一条理由）：
//    字号最大那一档（3.1x）下，标题 + 一行 + 取消会顶出屏幕——
//    列表能滚，溢出就永远不会发生（D3.5 那道硬闸）。

import 'package:flutter/material.dart';

import '../models/trash_words.dart';

/// 长按气泡之后选了什么。
///
/// ⚠️ 契约 `docs/dev/106-CHAT-SELECT.md` §一 起多了【复制】【多选】两项
///    —— 枚举本来就是为这个留的（"将来加'复制'之类不用改调用方的形状"）。
/// ⚠️ **`delete` 的位置与含义一个字没动**（回收站那条路照旧）。
enum BubbleAction { copy, select, delete }

class BubbleMenu extends StatelessWidget {
  const BubbleMenu({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      child: ListView(
        shrinkWrap: true,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
            child: Text(bubbleMenuTitle, style: theme.textTheme.titleMedium),
          ),
          ListTile(
            leading: const Icon(Icons.copy_outlined),
            title: const Text(bubbleMenuCopy),
            onTap: () => Navigator.of(context).pop(BubbleAction.copy),
          ),
          ListTile(
            leading: const Icon(Icons.checklist),
            title: const Text(bubbleMenuSelect),
            onTap: () => Navigator.of(context).pop(BubbleAction.select),
          ),
          ListTile(
            leading: const Icon(Icons.delete_outline),
            title: const Text(bubbleMenuDelete),
            subtitle: const Text(bubbleMenuDeleteHint),
            onTap: () => Navigator.of(context).pop(BubbleAction.delete),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
            child: Align(
              alignment: Alignment.centerRight,
              // 触控目标 ≥44：`TextButton` 的 `minimumSize` 撑命中区
              child: TextButton(
                onPressed: () => Navigator.of(context).pop(),
                style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
                child: const Text(bubbleMenuCancel),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
