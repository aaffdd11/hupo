// **轨迹那一屏**（契约 `docs/dev/118-TRAJECTORY-VIEW.md`）。
//
// DSH 的窗口顶上有两个 tab：聊天 / 轨迹；轨迹把**同一条会话**摊成一张表
// （研究 `docs/dev/115-DSH-WINDOW-PARITY.md` §一.4 ＋ `115-raw/B-render.md` §1.5）。
// 这一份只干一件事：把 `models/trajectory.dart` 算好的那张表**画出来**。
//
// ── 🔴 这一屏上"没有的东西"和"有的东西"一样重要 ─────────────────
//   · **没有模型名 / 钱 / 时长 / 百分比**（我们收不到 —— `models/trajectory.dart`
//     顶上那五条逐条写着）；合计那一行也只说手上真有的（轮数 ＋ 折得出的 token）；
//   · **没有编出来的行**：一条记录一行，来源就是**同一份** `ChatController.items`
//     （聊天那一屏画的是同一份 ⇒ 两个视图不会各说各的）；
//   · **不做任何写动作**：这一屏没有编辑、没有删除、没有发送 ——
//     每一行只有一件事：**跳到聊天里的那一条**（DSH 那种 turn navigation）。
//
// ── 三条硬约束 ──────────────────────────────────────────
//   ① **不许溢出**：五档字号（1.0–3.1）下横向一律 `Expanded`/`Flexible`/`Wrap` 兜住
//      （`test/widget/accessibility_test.dart` 是硬闸）；
//   ② **可点的都是按钮**、命中区 ≥44（D3.6）—— 一行一整颗 `TextButton`；
//   ③ **数值只从 `models/dsh_design.dart` 来**（新文件写死的尺寸 = 0 处）。

import 'package:flutter/material.dart';

import '../models/dsh_design.dart';
import '../models/tool_row.dart';
import '../models/tool_row_words.dart';
import '../models/trajectory.dart';
import '../models/trajectory_words.dart';
import 'dsh_look.dart';

/// 某一行的 key（判据用它点那一行）。
Key trajectoryRowKey(TrajectoryRow row) => ValueKey('trajectory-row-${row.seq}-${row.tie}');

/// 轨迹那一屏。
class TrajectoryView extends StatelessWidget {
  const TrajectoryView({
    super.key,
    required this.table,
    required this.onPick,
    this.note,
  });

  /// 算好的那张表（`trajectoryTableOf`）。
  final TrajectoryTable table;

  /// 点某一行 ⇒ 上层把它对应的那一条**在聊天里找出来并滚过去**。
  final ValueChanged<TrajectoryRow> onPick;

  /// 就地那一句实话（比如"这一条在聊天里没有单独一行"）。
  /// `null` = 一个像素都不占。
  final String? note;

  @override
  Widget build(BuildContext context) {
    // ⚠️ 内容列宽用 DSH 的 token，但**夹到这块地方真有那么宽**——
    //    `dshContentWidth` 的下限是 680，比浮窗还宽时照抄就是横向溢出。
    return LayoutBuilder(
      builder: (context, cons) {
        final want = dshContentWidth(cons.maxWidth);
        final width = want > cons.maxWidth ? cons.maxWidth : want;
        return Center(
          child: SizedBox(width: width, child: _body(context)),
        );
      },
    );
  }

  Widget _body(BuildContext context) {
    // 一条记录都没有 ⇒ **只说一句实话**（不编任何行、也不画合计那一行）。
    if (table.isEmpty) {
      final look = DshLook.of(context);
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(DshSpace.s16),
          child: Text(
            trajectoryEmptyLine,
            textAlign: TextAlign.center,
            style: dshTextStyle(look.content, look.palette.labelTertiary),
          ),
        ),
      );
    }
    final byTurn = <int, TrajectoryTurn>{
      for (final t in table.turns) t.turn: t,
    };
    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: DshSpace.s12, vertical: DshSpace.s8),
      children: [
        _TotalsHeader(totals: table.totals),
        if (note != null) _Note(text: note!),
        for (final row in table.rows) ...[
          if (row.turnHead && byTurn[row.turn] != null) _TurnHeader(turn: byTurn[row.turn]!),
          _Row(row: row, onPick: onPick),
        ],
        // 🔴 **这一窗是不是"全部"**：不是就写明（绝不许把一窗说成整条会话）。
        _Footer(complete: table.totals.complete),
      ],
    );
  }
}

/// 顶栏那几个"这一屏合计"（**只列手上真有的**）。
class _TotalsHeader extends StatelessWidget {
  const _TotalsHeader({required this.totals});

  final TrajectoryTotals totals;

  @override
  Widget build(BuildContext context) {
    final look = DshLook.of(context);
    final p = look.palette;
    return Padding(
      padding: const EdgeInsets.only(bottom: DshSpace.s8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // ⚠️ `Wrap`：3.1 倍字号下这一串一定放不下 —— 折行，**绝不横向溢出**。
          Wrap(
            spacing: DshSpace.s12,
            runSpacing: DshSpace.s4,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text(
                trajectoryTotalsHead,
                style: dshTextStyle(look.scale.at(DshTypes.sStrong), p.labelPrimary),
              ),
              Text(
                trajectoryTurnsCount(totals.turns),
                style: dshTextStyle(look.content, p.labelSecondary),
              ),
              // 🔴 **步骤那一格不画**：我们收不到"这一轮一共几步"
              //    （`TrajectoryTotals.steps` 恒 null，见 `models/trajectory.dart`）。
              // 🔴 **折不出用量 ⇒ 一个数都不给**（`tokens == null`）。
              if (totals.tokens != null)
                Text(
                  trajectoryTotalUsageLine(totals.tokens!),
                  style: dshTextStyle(look.caption, p.labelTertiary),
                ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.only(top: DshSpace.s8),
            child: Divider(height: dshHairline, thickness: dshHairline, color: p.borderL1),
          ),
        ],
      ),
    );
  }
}

/// 就地那一句实话（不是错误层，也不弹窗）。
class _Note extends StatelessWidget {
  const _Note({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final look = DshLook.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: DshSpace.s8),
      child: Text(
        text,
        style: dshTextStyle(look.caption, look.palette.stateWarn),
      ),
    );
  }
}

/// 一轮的分组头：轮号 ＋ **复用 `116` 的计数**（工具 / 消息 / subagent）。
class _TurnHeader extends StatelessWidget {
  const _TurnHeader({required this.turn});

  final TrajectoryTurn turn;

  @override
  Widget build(BuildContext context) {
    final look = DshLook.of(context);
    final p = look.palette;
    return Padding(
      padding: const EdgeInsets.only(top: DshSpace.s12, bottom: DshSpace.s4),
      child: Wrap(
        spacing: DshSpace.s8,
        runSpacing: DshSpace.s4,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Text(
            trajectoryTurnHead(turn.turn),
            style: dshTextStyle(look.scale.at(DshTypes.sStrong), p.labelSecondary),
          ),
          // ⚠️ **计数一条规矩都不重写**：`dshTurnProcessLabel` ＋ `TurnProcess`
          //    都来自 `116`（零段省略、工具与 subagent 互斥、全零兜底）。
          Text(
            dshTurnProcessLabel(turn.process, turnProcessChatWords),
            style: dshTextStyle(look.caption, p.labelTertiary),
          ),
        ],
      ),
    );
  }
}

/// 一行 = 一条记录。
class _Row extends StatelessWidget {
  const _Row({required this.row, required this.onPick});

  final TrajectoryRow row;
  final ValueChanged<TrajectoryRow> onPick;

  @override
  Widget build(BuildContext context) {
    final look = DshLook.of(context);
    final p = look.palette;
    final at = row.at;
    final time = at == null ? null : trajectoryClock(DateTime.fromMillisecondsSinceEpoch(at).toLocal());
    return SizedBox(
      width: double.infinity,
      child: TextButton(
        key: trajectoryRowKey(row),
        onPressed: () => onPick(row),
        style: TextButton.styleFrom(
          // D3.6：命中区下限 44
          minimumSize: const Size(44, 44),
          padding: const EdgeInsets.symmetric(horizontal: DshSpace.s8, vertical: DshSpace.s4),
          alignment: Alignment.centerLeft,
          foregroundColor: p.labelSecondary,
        ),
        child: Row(
          children: [
            _KindChip(kind: row.kind),
            const SizedBox(width: DshSpace.s8),
            // 摘要：**一行**、超了省略号（`Expanded` ⇒ 挤的时候它先让位，绝不溢出）。
            Expanded(
              child: Text(
                row.summary,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: dshTextStyle(look.content, p.labelSecondary),
              ),
            ),
            const SizedBox(width: DshSpace.s8),
            // 时刻：服务端给的那个 `at`（**没给就空着** —— 绝不拿设备钟补）。
            if (time != null)
              Flexible(
                child: Text(
                  time,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: dshTextStyle(look.caption, p.labelTertiary),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// 类别那一小格（DSH 行首那个彩色小标签）。
class _KindChip extends StatelessWidget {
  const _KindChip({required this.kind});

  final TrajectoryKind kind;

  @override
  Widget build(BuildContext context) {
    final look = DshLook.of(context);
    final p = look.palette;
    // 颜色只从标签色阶里取（**不新造颜色**）。
    final color = switch (kind) {
      TrajectoryKind.user => p.stateBusiness,
      TrajectoryKind.assistant => p.labelPrimary,
      TrajectoryKind.tool => p.labelSecondary,
      TrajectoryKind.systemPrompt => p.labelTertiary,
      TrajectoryKind.usage => p.labelDimmed,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: DshSpace.s6, vertical: DshSpace.s4),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(DshRadius.r6),
        border: Border.all(color: p.borderL1, width: dshHairline),
      ),
      child: Text(
        trajectoryKindWord(kind),
        style: dshTextStyle(look.caption, color),
      ),
    );
  }
}

/// 尾巴那一句：**更早的到底加载完了没有**。
class _Footer extends StatelessWidget {
  const _Footer({required this.complete});

  final bool complete;

  @override
  Widget build(BuildContext context) {
    final look = DshLook.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: DshSpace.s12),
      child: Text(
        complete ? trajectoryCompleteLine : trajectoryIncompleteLine,
        textAlign: TextAlign.center,
        style: dshTextStyle(look.caption, look.palette.labelTertiary),
      ),
    );
  }
}
