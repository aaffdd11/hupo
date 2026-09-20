// 过程四档的切换入口（**最小那一个**）。
//
// ⚠️ 契约 §五 说得很清楚：**入口放哪还没定**（关于页？长按？），
//    这一批只做"能切"。所以这里刻意是最朴素的一种形态——
//    一个底栏小面板，不改主界面的结构，将来挪地方时只丢这一个文件。
//
// ⚠️ 为什么不用 `RadioListTile`：它的选中态**只靠左边那个圆点**，
//    而这个项目对"信息不能只靠一个通道"（`bubbles.dart` 顶上那条）是认真的。
//    这里用 `ListTile(selected:)` + 一个对勾图标：**文字 + 图标**两个通道。
//
// ⚠️ 文案不写在这儿——四档的名字与解释在 `models/process_levels.dart`，
//    那样它才进得了 `test/unit` 的禁用词硬闸。

import 'package:flutter/material.dart';

import '../models/process_levels.dart';

class ProcessLevelMenu extends StatelessWidget {
  const ProcessLevelMenu({super.key, required this.current, required this.onPick});

  final ProcessLevel current;
  final ValueChanged<ProcessLevel> onPick;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      // ⚠️ 用 `ListView` 而不是 `Column`：五档字号里最大那档（3.1x）
      //    四项会顶出屏幕——列表能滚，溢出就永远不会发生（D3.5 那道硬闸）。
      child: ListView(
        shrinkWrap: true,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
            child: Text('它说多少过程', style: theme.textTheme.titleMedium),
          ),
          for (final level in ProcessLevel.values)
            ListTile(
              title: Text(level.title),
              subtitle: Text(level.hint),
              selected: level == current,
              trailing: level == current
                  ? Icon(Icons.check, color: theme.colorScheme.primary)
                  : null,
              onTap: () => onPick(level),
            ),
        ],
      ),
    );
  }
}
