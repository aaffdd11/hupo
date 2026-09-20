// **删前那份清单**（契约 `docs/dev/28-DELETE.md` §四 / §五 / §8.2）。
//
// 这一屏是这一件里最要紧的一屏：它是"删掉"这件事**唯一的实话**。
// 三条不许破：
//   1. **逐条照实显示**——`what / where / verdict / note` 一条都不许省
//      （§四：漏一项 = 屏幕上说"删掉了"却没删干净）。`note` 是**原话**，
//      不许改写成好听的。
//   2. **`verdict:"cannot"` 那种必须显眼**（§五：那句"删不掉"必须出现在屏幕上，
//      否则这一件就又变成"页面在说假话"）。⇒ 有它就在最上面写一行，并把它标出来。
//   3. **不许说"已全部删除"**：我们不汇总成一句话，只把服务端给的逐条摆出来。
//
// ⚠️ 文案在 `models/trash_words.dart`（那样才进得了禁用词硬闸）。
// ⚠️ `ttlDays` / `purgeAt` **都从服务端来**，客户端不复制那两个数。

import 'package:flutter/material.dart';

import '../models/trash.dart';
import '../models/trash_words.dart';

class TrashPlanSheet extends StatelessWidget {
  const TrashPlanSheet({super.key, required this.plan});

  final TrashPlan plan;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final purge = purgeAtLine(plan.purgeAt);
    return SafeArea(
      // 列表能滚 ⇒ 字号最大那一档也不会溢出（D3.5 那道硬闸）。
      child: ListView(
        shrinkWrap: true,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 4),
            child: Text(planTitle, style: theme.textTheme.titleMedium),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 4),
            child: Text(planTtlLine(plan.ttlDays), style: theme.textTheme.bodyMedium),
          ),
          if (purge.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: Text(purge, style: theme.textTheme.bodySmall),
            ),
          // ⚠️ §五 那一条：**删不掉的那一项必须被看见**。
          if (plan.hasCannot)
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.info_outline, size: theme.textTheme.bodyMedium!.fontSize! + 4),
                  const SizedBox(width: 8),
                  // 图标 + 文字两个通道（不只靠颜色 / 图标）
                  Expanded(
                    child: Text(planCannotLine, style: theme.textTheme.bodyMedium),
                  ),
                ],
              ),
            ),
          if (plan.items.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 8),
              child: Text(planEmptyLine, style: theme.textTheme.bodyMedium),
            )
          else
            for (final item in plan.items) _item(theme, item),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: () => Navigator.of(context).pop(false),
                  style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
                  child: const Text(planCancel),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: () => Navigator.of(context).pop(true),
                  style: FilledButton.styleFrom(minimumSize: const Size(44, 44)),
                  child: const Text(planConfirm),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// 一条清单项。**四样都摆出来**：哪一样（在哪儿）· 会删吗 · 服务端写的那句。
  ///
  /// ⚠️ 不用 `ListTile`：它的三行布局在最大字号下会把长的 `note` 挤掉，
  ///    而这一屏恰恰**不许省字**。用纯 `Column` + 自动换行（容器跟字算）。
  Widget _item(ThemeData theme, TrashPlanItem item) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 6, 20, 6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(planItemTitle(item.what, item.where), style: theme.textTheme.bodyLarge),
            Text(verdictLabel(item.verdict), style: theme.textTheme.bodySmall),
            if (item.note.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(item.note, style: theme.textTheme.bodySmall),
              ),
          ],
        ),
      );
}
