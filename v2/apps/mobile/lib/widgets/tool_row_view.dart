// **聊天窗口重做的第 1 批：工具行 + 系统提示词行 + 每轮用量 + 过程折叠**。
//
// ── 这一批是什么、不是什么 ───────────────────────────────────
// 主人 2026-09-26：*"首先全部开放，聊天窗口的设计也要重做。"*
// 形状定的是：**桌面 + 浮窗不动**，重做**里面那一块**；这一批只做
// 「工具行 + 过程折叠 + 设计骨架」（研究 `docs/dev/115-DSH-WINDOW-PARITY.md` 丙-1/丙-2/丙-3/丙-5）。
//
// ⚠️ **这是第 1 批**，后面那几批（右栏、Queue/Steer、字号/外观设置）**都已经落地**
//    —— 别把这一份当成"DSH 的窗口已经抄完了"：115 §六 那几条里，
//    轨迹那一屏 2026-09-26 已按主人决定**砍掉**（见 `docs/dev/118` 顶上横幅）。
//
// ── 数值只有一处 ──────────────────────────────────────────
// 颜色 / 字号 / 行高 / 圆角 / 间距全部来自 `models/dsh_design.dart`
// （那一份顶上写着数值是哪来的：DSH 真包解出来的 token）。这一份里**没有一个写死的数**
// ——`design_tokens_test.dart` 那条棘轮盯着（新文件的上限是 0 处）。
//
// ── 与"禁用词"的关系 ──────────────────────────────────────
// 工具名（`bash` / `subagent` / `web_search`…）与"系统提示词 / 工具调用"这些词
// **这一批之后是允许上屏的**（聊天窗口内放开 D1.1，见 `models/tool_row_words.dart` 顶上那段）。
//
// ── 三条硬约束（都在这一份里落实）──────────────────────────
//   ① **有界 ≠ 截断**：展开那块是**能滚到底**的（DSH 的 `max-height`），
//      真被服务端截过的那一段另有那句实话（`toolTruncatedLine`）；
//   ② **结果不是 Markdown/HTML**：工具输出是**纯文本**，只走 `SelectableText`
//      —— 它里面可能是 `<b>`、`##`、`|` 这类东西，当 Markdown 画就是对内容的二次解释；
//   ③ **不许溢出**：五档字号（1.0–3.1）下横向一律用 `Expanded` + `Wrap` 兜住
//      （`test/widget/accessibility_test.dart` 是硬闸）；可点的东西一律是按钮，
//      而且命中区 ≥44（D3.6）。

import 'package:flutter/material.dart';

import '../models/dsh_design.dart';
import '../models/tool_row.dart';
import '../models/tool_row_words.dart';
import 'dsh_look.dart';

// ── 样式换算（DshType → TextStyle）现在住在 `dsh_look.dart` ──────────
//
// ⚠️ 这一小层 2026-09-26 抽了出去（那会儿轨迹那一屏与两个 tab 也要用同一份换算；
//    轨迹当天砍了，这一层留着给工具行 / 右栏 / 排队条 / 输入条共用）。
//    这里只留两个短别名，行为一字未改（`DshLook` 直接用那一个类）。

/// 本文件里的短别名：`_styleOf` → [dshTextStyle]。
TextStyle _styleOf(DshType t, Color color, {String? family}) =>
    dshTextStyle(t, color, family: family);

/// 本文件里的短别名：`_monoFamily` → [dshMonoFamily]。
const String _monoFamily = dshMonoFamily;

/// 一次工具调用 → 屏幕上**一行**（收起）/ 一个带正文的卡（展开）。
///
/// 形状照 DSH 的通用工具行（`o3BgMG_*`）：小图标 · **工具名（等宽）** · `·` ·
/// 一句人话标题 · 状态 · 展开；展开是"入参原样 + 输出摘要"，超了在框里滚。
class ToolRowView extends StatefulWidget {
  const ToolRowView({super.key, required this.row});

  final ToolRow row;

  @override
  State<ToolRowView> createState() => _ToolRowViewState();
}

class _ToolRowViewState extends State<ToolRowView> {
  /// **这一行展开了没有**（每一行各记各的；默认收起 —— DSH 同一条）。
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final look = DshLook.of(context);
    final p = look.palette;
    final row = widget.row;
    final (IconData glyph, Color glyphColor) = switch (row.status) {
      ToolStatus.running => (Icons.more_horiz, p.stateBusiness),
      ToolStatus.ok => (Icons.check, p.stateSuccess),
      ToolStatus.error => (Icons.close, p.stateError),
      ToolStatus.interrupted => (Icons.remove, p.labelTertiary),
    };
    final title = row.title;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: DshSpace.s4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                // ⚠️ 图标跟着字号算（不写死尺寸）
                padding: const EdgeInsets.only(top: DshSpace.s4),
                child: Icon(glyph, size: look.content.size, color: glyphColor),
              ),
              const SizedBox(width: DshSpace.s8),
              // ⚠️ `Expanded` + `Wrap`：窄屏 + 大字号下这一串会折行，
              //    **绝不许横向溢出**（五档那道硬闸）。
              Expanded(
                child: Wrap(
                  spacing: DshSpace.s6,
                  runSpacing: DshSpace.s4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    // ⚠️ **名字可以是空的**：`tool/call` 那条配不上时（合同 `116` §一
                    //    规矩 4）只画结果那一行，那时**我们不知道是哪个工具** ——
                    //    名字那一格就空着，绝不编一个占位名（N10：沉默优于编造）。
                    if (row.name.isNotEmpty)
                      Text(row.name, style: _styleOf(look.content, p.labelSecondary, family: _monoFamily)),
                    if (title != null && title.isNotEmpty) ...[
                      if (row.name.isNotEmpty) Text('·', style: _styleOf(look.content, p.labelCaption)),
                      Text(title, style: _styleOf(look.content, p.labelSecondary)),
                    ],
                    Text(
                      toolStatusWord(row.status),
                      style: _styleOf(look.caption, p.labelTertiary),
                    ),
                  ],
                ),
              ),
              // 展开入口：**真按钮**（命中区由 Material 撑着 ≥44，D3.6）。
              IconButton(
                onPressed: () => setState(() => _open = !_open),
                tooltip: _open ? toolRowCollapseLabel : toolRowExpandLabel,
                icon: Icon(_open ? Icons.keyboard_arrow_down : Icons.keyboard_arrow_right),
                color: p.labelTertiary,
              ),
            ],
          ),
          if (_open) _body(look),
        ],
      ),
    );
  }

  /// 展开那一块：**有界**（能滚到底）、**纯文本**（不是 Markdown）。
  Widget _body(DshLook look) {
    final p = look.palette;
    final row = widget.row;
    final args = row.args;
    final excerpt = row.excerpt;
    return Padding(
      padding: const EdgeInsets.only(top: DshSpace.s4, left: DshSpace.s4),
      child: Container(
        decoration: BoxDecoration(
          color: p.markdownCodeBlock,
          borderRadius: BorderRadius.circular(DshRadius.r12),
          border: Border.all(color: p.borderL1, width: dshHairline),
        ),
        padding: const EdgeInsets.all(DshSpace.s12),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: dshToolBodyMaxHeight),
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (args != null && args.isNotEmpty)
                  SelectableText(args, style: _styleOf(look.mono, p.labelSecondary, family: _monoFamily)),
                // ⚠️ 结果**绝不**当 Markdown/HTML 画：走 `SelectableText`（纯文本、保留换行）。
                if (excerpt != null && excerpt.isNotEmpty) ...[
                  // 入参和结果之间留一点空（上面没有入参就不留）
                  if (args != null && args.isNotEmpty) const SizedBox(height: DshSpace.s8),
                  SelectableText(
                    excerpt,
                    style: _styleOf(look.mono, p.labelPrimary, family: _monoFamily),
                  ),
                ],
                // 🔴 **截了就要说**（不说的那一刻这一行就在说假话）。
                if (row.truncated)
                  Padding(
                    padding: const EdgeInsets.only(top: DshSpace.s8),
                    child: Text(
                      toolTruncatedLine(row.bytes),
                      style: _styleOf(look.caption, p.stateWarn),
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

/// **模型看到的那段系统提示词**（DSH `SystemPromptRow`）：默认收起、展开逐字。
///
/// ⚠️ 它存在的唯一意义是"能核对模型到底看到了什么" ⇒ 正文**逐字**（保留换行），
///    框只是**有界**（141px，能滚），**不是**截断。
class SystemPromptView extends StatefulWidget {
  const SystemPromptView({super.key, required this.row});

  final SystemPromptRow row;

  @override
  State<SystemPromptView> createState() => _SystemPromptViewState();
}

class _SystemPromptViewState extends State<SystemPromptView> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final look = DshLook.of(context);
    final p = look.palette;
    final row = widget.row;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: DshSpace.s4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.article_outlined, size: look.content.size, color: p.labelTertiary),
              const SizedBox(width: DshSpace.s8),
              // ⚠️ `Expanded`：抬头那句话在大字号下也不许把这一行顶出去。
              Expanded(
                child: Text(
                  systemPromptTitle,
                  style: _styleOf(look.content, p.labelSecondary),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              IconButton(
                onPressed: () => setState(() => _open = !_open),
                tooltip: _open ? systemPromptCollapseLabel : systemPromptExpandLabel,
                icon: Icon(_open ? Icons.keyboard_arrow_down : Icons.keyboard_arrow_right),
                color: p.labelTertiary,
              ),
            ],
          ),
          if (_open)
            Padding(
              padding: const EdgeInsets.only(top: DshSpace.s4, left: DshSpace.s4),
              child: Container(
                decoration: BoxDecoration(
                  color: p.markdownCodeBlock,
                  borderRadius: BorderRadius.circular(DshRadius.r12),
                  border: Border.all(color: p.borderL1, width: dshHairline),
                ),
                padding: const EdgeInsets.all(DshSpace.s12),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: dshOpaqueBodyMaxHeight),
                  child: SingleChildScrollView(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        SelectableText(
                          row.text,
                          style: _styleOf(look.mono, p.labelSecondary, family: _monoFamily),
                        ),
                        if (row.truncated)
                          Padding(
                            padding: const EdgeInsets.only(top: DshSpace.s8),
                            child: Text(
                              toolTruncatedLine(row.bytes),
                              style: _styleOf(look.caption, p.stateWarn),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// **这一轮用了多少 token**（DSH `TurnUsagePanel` 那个触发器那一行）。
///
/// ⚠️ 传进来的 [usage] **已经是折过的**（`foldTurnUsage`）：`null` = 这一轮
///    **一个数都不许画**（有一次尝试没报准 / 还没结清）⇒ 这里**一个像素都不占**。
/// 🔴 **没有钱、没有百分比**：DSH 全树只有 token（`B-render.md` §2.7 最后一行）。
class TurnUsageRowView extends StatelessWidget {
  const TurnUsageRowView({super.key, required this.usage});

  final TurnUsage? usage;

  @override
  Widget build(BuildContext context) {
    final u = usage;
    if (u == null) return const SizedBox.shrink();
    final look = DshLook.of(context);
    final p = look.palette;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: DshSpace.s4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.data_usage, size: look.caption.size, color: p.labelTertiary),
          const SizedBox(width: DshSpace.s6),
          // ⚠️ 那一行字很长（5 个桶都报时）⇒ `Expanded` 让它自己折行，不许溢出。
          Expanded(
            child: Text(turnUsageLine(u), style: _styleOf(look.caption, p.labelTertiary)),
          ),
        ],
      ),
    );
  }
}

/// **这一轮做过什么**那个折叠控件（DSH `TurnProcessNodeView`）。
///
/// ⚠️ 它是**真按钮**（不是一段能点的文字）：命中区 ≥44（D3.6）；
///    字由 `dshTurnProcessLabel` 拼（零段省略、顺序固定、全零 ⇒「已思考」）。
class TurnProcessControl extends StatelessWidget {
  const TurnProcessControl({
    super.key,
    required this.counts,
    required this.expanded,
    required this.onToggle,
  });

  final TurnProcess counts;
  final bool expanded;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final look = DshLook.of(context);
    final p = look.palette;
    final label = dshTurnProcessLabel(counts, turnProcessChatWords);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: DshSpace.s4),
      child: SizedBox(
        width: double.infinity,
        child: TextButton(
          onPressed: onToggle,
          style: TextButton.styleFrom(
            // D3.6：命中区下限 44（视觉可以小，命中区不许小）
            minimumSize: const Size(44, 44),
            alignment: Alignment.centerLeft,
            foregroundColor: p.labelSecondary,
            padding: const EdgeInsets.symmetric(horizontal: DshSpace.s8),
          ),
          child: Row(
            children: [
              Icon(
                expanded ? Icons.keyboard_arrow_down : Icons.keyboard_arrow_right,
                size: look.content.size,
                color: p.labelTertiary,
              ),
              const SizedBox(width: DshSpace.s8),
              Expanded(
                child: Text(
                  label,
                  style: _styleOf(look.content, p.labelSecondary),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
