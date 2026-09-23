// **计划条**那条 UI（主人 2026-09-23 定案：*"浮在屏幕上方（窗口不动）"* · `64-CHAT-REDESIGN.md` §二/§四）。
//
// 形状（按定案）：
//   · 屏幕**上沿**一条卡片：目标一行 + 最多三件任务（在做的那件排最前）+ "还有 N 件"
//   · **没有计划 ⇒ 一个像素都不画**（`Plan? == null` 时这个 widget 直接给空盒子）
//   · 🔴 **`IgnorePointer`**：它**只是指示**，不是按钮 —— 点它**穿透到桌面**
//     （否则屏幕上方会多一块"点了没反应"的死区，而"点桌面空白 = 收起聊天"在那块就失灵了）
//   · 尺寸全走 token（跟字算、不写死）；命中区那一套与它无关（它不可点）
//
// ⚠️ 它在 `Stack` 里是**最上面那一条**、聊天浮窗在最下面（Z1：浮窗永远最上 —— 两者不重叠，
//    浮窗贴底、这条贴上沿）。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/plan.dart';
import '../models/plan_words.dart';

class PlanStrip extends StatelessWidget {
  const PlanStrip({super.key, required this.plan});

  /// 现在这一份计划；`null` = 没有 ⇒ **什么都不画**。
  final Plan? plan;

  @override
  Widget build(BuildContext context) {
    final p = plan;
    // 🔴 **两个"什么都不画"的条件**：
    //   ① 没有计划（`null`）—— 空态禁令；
    //   ② **全做完了**（`p.allDone`）—— 主人 2026-09-23 的实测反馈：*"还在。它列了几件事"*。
    //      这条的定位是"它**现在**打算做哪几件"；全做完之后它就不再是"进行中"，
    //      挂在那儿只会剩一排打勾 + 划掉的字（而"划掉的字"被读成了"删掉了"）。
    if (p == null || p.allDone) return const SizedBox.shrink();
    final t = Theme.of(context);
    final phaseWord =
        planPhaseWords[switch (p.phase) {
          PlanPhase.active => 'active',
          PlanPhase.paused => 'paused',
          PlanPhase.complete => 'complete',
          PlanPhase.blocked => 'blocked',
          PlanPhase.unknown => 'unknown',
        }]!;

    return IgnorePointer(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(d.gapM, d.gapM, d.gapM, 0),
        child: Material(
          color: d.card,
          borderRadius: BorderRadius.circular(d.radiusCard),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
              d.gapM,
              d.gapS + 2,
              d.gapM,
              d.gapS + 2,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // ① 目标那一行（没有目标就换成"它列了几件事"）
                Row(
                  children: [
                    Icon(
                      p.phase == PlanPhase.complete
                          ? Icons.check_circle_outline
                          : Icons.play_circle_outline,
                      size: 18,
                      color: d.accent,
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        p.goal == null
                            ? planTodoOnlyLabel
                            : '$planGoalLabel${phaseWord.isEmpty ? '' : '（$phaseWord）'}：${p.goal}',
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: t.textTheme.bodyMedium?.copyWith(
                          color: d.ink,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ],
                ),
                // ② 任务清单（最多三件；在做的排最前）
                for (final todo in p.shown)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Icon(
                          todo.done
                              ? Icons.check_box_outlined
                              : todo.now
                              ? Icons.radio_button_checked
                              : Icons.check_box_outline_blank,
                          size: 16,
                          color: todo.done ? d.muted : d.ink,
                        ),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Text(
                            todo.text,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            // ⚠️ **完成的条目不许画删除线**（2026-09-23 主人实测：
                            //    那条横线被读成了"**删掉了**"）—— "做完了"靠**勾**说，
                            //    颜色只是第二眼；判据钉着这件事。
                            style: t.textTheme.bodySmall?.copyWith(
                              color: todo.done ? d.muted : d.ink,
                              fontWeight: todo.now ? FontWeight.w600 : null,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                // ③ 没画出来的那几件**如实报数**（不假装只有这些）
                if (p.hidden > 0)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(
                      planMoreWords(p.hidden),
                      style: t.textTheme.labelSmall?.copyWith(color: d.muted),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
