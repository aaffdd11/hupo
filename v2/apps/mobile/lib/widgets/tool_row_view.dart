// **聊天窗口重做的第 1 批：工具行 + 系统提示词行 + 每轮用量 + 过程折叠**。
//
// ── 这一批是什么、不是什么 ───────────────────────────────────
// 主人 2026-09-26：*"首先全部开放，聊天窗口的设计也要重做。"*
// 形状定的是：**桌面 + 浮窗不动**，重做**里面那一块**；这一批只做
// 「工具行 + 过程折叠 + 设计骨架」（研究 `docs/dev/115-DSH-WINDOW-PARITY.md` 丙-1/丙-2/丙-3/丙-5）。
//
// ⚠️ **这是第 1 批**：Trajectory、右栏、Queue/Steer、字号/外观设置那几件**都还没有**
//    （115 §六 丙-4/丙-6/丙-7/丙-8）。别把这一份当成"DSH 的窗口已经抄完了"。
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

// ── 一小层样式换算（DshType → TextStyle；**一个数都不写死**）──────

/// DSH 的字重只有 400/500/600/700。
FontWeight _weightOf(int w) => switch (w) {
  500 => FontWeight.w500,
  600 => FontWeight.w600,
  700 => FontWeight.w700,
  _ => FontWeight.w400,
};

/// 把 DSH 的"字号 + 绝对行高"翻成 Flutter 的 `TextStyle`
/// （`height` 是**倍数**，所以要 `lineHeight / size`）。
///
/// ⚠️ 不碰 `textScaler`：缩放由 `Text` 自己按 `MediaQuery` 施加
///    （D3.5 那条"不封顶"就是靠它 —— 我们在这里夹一刀就把那个设置废了）。
TextStyle _styleOf(DshType t, Color color, {String? family}) => TextStyle(
  fontFamily: family,
  fontFamilyFallback: family == null ? null : const ['Menlo', 'Consolas', 'monospace'],
  fontSize: t.size,
  height: t.lineHeight / t.size,
  fontWeight: _weightOf(t.weight),
  color: color,
);

/// DSH 的代码字体栈（真包 `--dsh-font-mono`；平台没有就退回系统等宽）。
const String _monoFamily = 'monospace';

/// 这一屏的色板 + 用户字号轴（一处算好，往下传）。
class _DshLook {
  const _DshLook(this.palette, this.scale);

  final DshPalette palette;
  final DshContentScale scale;

  /// 亮/暗跟着 `Theme` 走（今天全站只有亮色，但别把"暗色 = 另一套色板"这件事写死错）。
  static _DshLook of(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    // ⚠️ 字号这一批**还没有用户设置**（115 丙-8 才有）⇒ 走默认档。
    //    但**入口留好了**：接了设置之后只需把 `null` 换成读出来的那个值。
    return _DshLook(dshPaletteFor(dark: dark), dshContentScale(null));
  }

  /// 工具行/系统提示词行**抬头**那一档（DSH 正文 14/24）。
  DshType get content => scale.content;

  /// 抬头下面那行小字（DSH 二级台阶 13/20）。
  DshType get caption => scale.secondaryAt(DshTypes.xs);

  /// 展开后那块正文（DSH 代码块小阶 11/16 —— 我们**没有 11px 这个 token**，
  /// 用二级台阶代替；差的那一档等真的需要时再进 `dsh_design.dart`）。
  DshType get mono => scale.secondaryAt(DshTypes.xs);
}

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
    final look = _DshLook.of(context);
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
  Widget _body(_DshLook look) {
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
    final look = _DshLook.of(context);
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
    final look = _DshLook.of(context);
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
    final look = _DshLook.of(context);
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
