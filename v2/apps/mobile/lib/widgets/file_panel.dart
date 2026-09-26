// **右栏那块盖板**：这一窗动过哪些文件（契约 `docs/dev/120-FILE-PANEL.md`）。
//
// ── 形状从哪来 ─────────────────────────────────────────────
// DSH 的**右侧栏**（研究 `docs/dev/115-DSH-WINDOW-PARITY.md` §一.3 ＋
// `docs/dev/115-raw/A-layout.md` §3）：会话头右上角**一颗 28×28 的按钮**
// （`aria-label` = 打开右侧边栏）⇒ 右边**滑进一栏**；栏里顶上是一条 tab 带
// （DSH 是 文件/Files ＋ 文档预览），底下是那一栏的内容。
//
// 🔴 **我们这一批与 DSH 的三处不同**（都写在这儿，免得下一个人以为是漏了）：
//   ① **它是一块盖板（overlay），不是新的一屏、也不是"把聊天挤窄"**：
//      它从浮窗右缘滑进来、盖在聊天上，聊天那一块**一个像素都不动**
//      （派活单点名："不是新屏幕"＋"关掉之后聊天的滚动位置一点都不许丢"）；
//   ② **栏里只有一样**：这一窗动过哪些文件。DSH 的 文件 / 文档预览那两栏要
//      **读盘**（工作目录、文件内容）—— 这一批**没有服务端接口**，
//      客户端更不许碰文件系统（派活单：只读、不碰 FS）；
//   ③ **没有 tab 带**：只有一个 tab 的东西不做切换器（做了就是摆一个死键）。
//
// ── 三条硬约束（与工具行那一份同一条）──────────────────────────
//   ① **不许溢出**：五档字号（1.0–3.1）下横向一律 `Expanded`/`Wrap`，行高跟字算
//      （`test/widget/accessibility_test.dart` 是硬闸）；
//   ② **可点的都是按钮**、命中区 ≥44（D3.6）：那颗 28 的图标按钮靠
//      `minimumSize` 撑出 44 的命中区；每一行是一整颗 `TextButton`；
//   ③ **数值只从 `models/dsh_design.dart` 来**（新文件写死的尺寸 = 0 处，
//      `test/unit/design_tokens_test.dart` 那条棘轮盯着）。
//
// ── 🔴 这一屏**没有**的东西（和"有"一样重要）──────────────────
//   · **没有"改了多少行"**：我们手上没有权威的增删行数（`models/file_changes.dart`
//     顶上逐条写着）⇒ 一行里**一个数都没有**；
//   · **没有文件现在的内容 / 预览 / 下载 / 打开**：那要读盘或一条新接口；
//   · **没有编辑 / 发送 / 删除**：这一栏**只读**（派活单点名）。
//
// ── ⚠️ 一处如实说的口径 ────────────────────────────────────
// 抬头底下那句 [filePanelOrderLine] 说的是"**只算这一窗已经摊开的这些轮**" ——
// 因为「更早的那些轮」在客户端是**翻页才有的**（`older_*` 那一套），
// 没翻过来的轮我们手上根本没有 ⇒ 这一栏**不许**把它说成"整条聊天记录都算过了"。

import 'package:flutter/material.dart';

import '../models/dsh_design.dart';
import '../models/file_changes.dart';
import '../models/file_panel_words.dart';
import '../models/tool_row.dart';
import '../models/tool_row_words.dart';
import 'dsh_look.dart';

/// 那颗**展开按钮**的 key（判据用它点、也用它量命中区）。
const Key filePanelButtonKey = Key('file-panel-button');

/// 盖板本身的 key。
const Key filePanelKey = Key('file-panel');

/// 关上那颗按钮的 key。
const Key filePanelCloseKey = Key('file-panel-close');

/// 一行的 key（判据用它点那一行）。
Key filePanelRowKey(String path) => ValueKey('file-panel-row-$path');

/// 一轮分组头的 key。
Key filePanelTurnKey(int turn) => ValueKey('file-panel-turn-$turn');

/// 会话头右上角那颗**展开按钮**（DSH 的 `ExpandButton`）。
///
/// ⚠️ **图形 28×28、命中区 ≥44**（见 `dshPanelIconButtonSize` 那段）。
/// ⚠️ 它**开着的时候不画**（DSH 原话：`ExpandButton renders null while the panel
///    is shown`）—— 那一刻的出口是栏里那颗「收起这一栏」。
/// ⚠️ 图形是 `panel-left` 的**镜像**（DSH 的 `transform: scaleX(-1)`）——
///    朝右的那一支。
class FilePanelButton extends StatelessWidget {
  const FilePanelButton({super.key, required this.onPressed});

  /// 点它 ⇒ 上层把那块盖板打开。
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final look = DshLook.of(context);
    return IconButton(
      key: filePanelButtonKey,
      onPressed: onPressed,
      tooltip: filePanelOpenLabel,
      // D3.6：命中区下限 44（图形只有 dshPanelIconButtonSize）
      constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
      color: look.palette.labelTertiary,
      icon: const Icon(Icons.last_page, size: dshPanelIconButtonSize),
    );
  }
}

/// 右栏那块盖板。
///
/// [open] 一翻，它就从右缘滑进来 / 滑出去（`AnimatedSlide`：
/// 动画的**只有这一块自己**，聊天那一棵子树连重建都不需要 —— 它的
/// `ScrollPosition` 因此原封不动，这正是"关掉不许丢位置"那条的机制）。
class FilePanel extends StatelessWidget {
  const FilePanel({
    super.key,
    required this.open,
    required this.width,
    required this.changes,
    required this.onClose,
  });

  final bool open;

  /// 这一块占多宽（**由上层算好**：`dshRightPanelWidth(可用宽)`）。
  ///
  /// 🔴 为什么宽度是**传进来**的、不在这里再套一个 `LayoutBuilder`：
  ///    这一块是**浮在聊天上面**的（`Stack` 里的 `Positioned`），
  ///    而"能不能挤得下"这件事要在**别处**也问一次（标题行让不让位）。
  ///    两处各量一次 = 两个真相（迟早一处说"盖着"、另一处说"挤着"）。
  final double width;

  /// 算好的那一份（`FileChanges.of`）。
  final FileChanges changes;

  /// 点「收起这一栏」。
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final look = DshLook.of(context);
    return AnimatedSlide(
      // ⚠️ **关着的时候是"滑出右缘"而不是"不建它"**：那两个方向都不占位置、
      //    都不接指针（下面那层 `IgnorePointer`）—— 于是打开的那一瞬间
      //    有动画可看，而不是一块凭空出现的白。
      offset: open ? Offset.zero : const Offset(1, 0),
      duration: dshPanelSlideDuration,
      curve: dshPanelSlideCurve,
      child: IgnorePointer(
        ignoring: !open,
        child: SizedBox(
          // 宽度**由上层算好传进来**（`dshRightPanelWidth(可用宽)`）：
          // 那一栏要么被 `Row` 分到一块、要么盖在聊天上面，两种都由上层决定
          // （见 `screens/chat_screen.dart` 的 `_panelDocked`）。
          width: width,
          height: double.infinity,
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: look.palette.bgLayer1,
              // 与聊天那块之间的那条发丝线（DSH 的 `border-l3` + 0.5px）。
              border: Border(
                left: BorderSide(
                  color: look.palette.borderL3,
                  width: dshHairline,
                ),
              ),
            ),
            child: _body(context),
          ),
        ),
      ),
    );
  }

  Widget _body(BuildContext context) {
    final look = DshLook.of(context);
    final p = look.palette;
    return Semantics(
      container: true,
      label: filePanelTitle,
      // 🔴 **关着的时候它一个可点的东西都不算**：这一块只是"滑出右缘"，
      //    元素还在树里（动画要用）——而**无障碍树里不许有一个点不到的东西**。
      //    不挡的话：读屏会念到它，`sweep` 那道硬闸也会去量它，
      //    量出来的是**被裁成负数的矩形**（真栽过：`Size(-281, 48)`）。
      blockUserActions: !open,
      // 🔴 **抬头与那一行行住在同一个滚动面里**（不是"抬头占上面一条、
      //    列表占剩下那点"）：五档字号 3.1x 下抬头会长到**比整块地方还高**，
      //    按"上下分"来摆，列表会分到 0 高 ⇒ 一行都建不出来
      //    （真栽过：`ensureVisible` 抛 `Bad state: No element`）。
      //    ⇒ 合成一个滚动面：**谁也不挤谁**，超了就在这一栏里滚到底
      //      （与 `116` 那两块正文同一条老规矩：有界 ≠ 截断）。
      child: CustomScrollView(
        // ⚠️ 多留一小段缓存（`dshPanelCacheExtent`）：抬头把视口占满时，
        //    "紧挨着抬头下面"的那几行也建出来 —— 判据要能 `ensureVisible` 到它们。
        cacheExtent: dshPanelCacheExtent,
        slivers: [
          SliverToBoxAdapter(child: _header(look)),
          SliverToBoxAdapter(
            child: Divider(height: dshHairline, thickness: dshHairline, color: p.borderL1),
          ),
          if (changes.isEmpty)
            // 🔴 一窗里一条文件行都没有 ⇒ **只说一句实话**（不编任何行）。
            SliverFillRemaining(
              hasScrollBody: false,
              child: Center(
                child: Padding(
                  padding: const EdgeInsets.all(DshSpace.s16),
                  child: Text(
                    filePanelEmptyLine,
                    textAlign: TextAlign.center,
                    style: dshTextStyle(look.content, p.labelTertiary),
                  ),
                ),
              ),
            )
          else
            _list(look),
        ],
      ),
    );
  }

  Widget _header(DshLook look) {
    final p = look.palette;
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        DshSpace.s12,
        DshSpace.s8,
        DshSpace.s4,
        DshSpace.s8,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              // ⚠️ `Expanded` + 省略号：窄栏 + 大字号下这一行一定放不下，
              //    让它截字，**绝不横向溢出**。
              Expanded(
                child: Text(
                  filePanelTitle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: dshTextStyle(
                    look.scale.at(DshTypes.sStrong),
                    p.labelPrimary,
                  ),
                ),
              ),
              IconButton(
                key: filePanelCloseKey,
                onPressed: onClose,
                tooltip: filePanelCloseLabel,
                // D3.6：命中区 ≥44（图形只有 dshPanelIconButtonSize）
                constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
                color: p.labelTertiary,
                icon: const Icon(Icons.last_page, size: dshPanelIconButtonSize),
              ),
            ],
          ),
          // 合计那一行：**只有有内容时才说**（空的时候说"0 轮"是拿 0 当事实）。
          if (!changes.isEmpty) ...[
            Text(
              filePanelCountLine(changes.totalTurns, changes.totalFiles),
              style: dshTextStyle(look.content, p.labelSecondary),
            ),
            Text(
              filePanelOrderLine,
              style: dshTextStyle(look.caption, p.labelTertiary),
            ),
          ],
        ],
      ),
    );
  }

  /// 一轮一组：**最新的那一轮在最上面**。
  ///
  /// ⚠️ 倒着遍历的是 `changes.turns`（它是**第一次见到的顺序**）——
  ///    排序只在这一处发生（数据那边保持原样，见 `FileChanges.turns` 那段）。
  /// ⚠️ 用 `SliverList`：这些行与抬头**住在同一个滚动面**里（见 `_body` 那段）。
  Widget _list(DshLook look) {
    final rows = <Widget>[
      for (var i = changes.turns.length - 1; i >= 0; i -= 1)
        ..._turn(look, changes.turns[i]),
    ];
    return SliverPadding(
      padding: const EdgeInsets.symmetric(
        horizontal: DshSpace.s12,
        vertical: DshSpace.s8,
      ),
      sliver: SliverList(delegate: SliverChildListDelegate(rows)),
    );
  }

  List<Widget> _turn(DshLook look, TurnFileChanges turn) => [
        Padding(
          key: filePanelTurnKey(turn.turn),
          padding: const EdgeInsets.only(top: DshSpace.s8, bottom: DshSpace.s4),
          child: Wrap(
            spacing: DshSpace.s8,
            runSpacing: DshSpace.s4,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text(
                filePanelTurnHead(turn.turn),
                style: dshTextStyle(
                  look.scale.at(DshTypes.sStrong),
                  look.palette.labelSecondary,
                ),
              ),
              Text(
                filePanelTurnFiles(turn.fileCount),
                style: dshTextStyle(look.caption, look.palette.labelTertiary),
              ),
            ],
          ),
        ),
        for (final f in turn.files) FileChangeRow(change: f),
      ];
}

/// 一条"某次调用动了某个文件" → 屏幕上**一行**（点开看那次的入参原文）。
///
/// ⚠️ 行高**跟字算**（不写死）：五档字号下它自己变高，容器是 `ListView`，
///    绝不溢出。⚠️ 一整行是一颗 `TextButton`（命中区 ≥44）。
class FileChangeRow extends StatefulWidget {
  const FileChangeRow({super.key, required this.change});

  final FileChange change;

  @override
  State<FileChangeRow> createState() => _FileChangeRowState();
}

class _FileChangeRowState extends State<FileChangeRow> {
  /// 这一行展开了没有（默认收起 —— 与 `116` 的工具行同一条）。
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final look = DshLook.of(context);
    final p = look.palette;
    final f = widget.change;
    // ⚠️ 名字那一格**可以是空的**（那次调用的 `name` 本站就不知道）：
    //    空的就**不画那一句**，绝不编一个占位名（N10：沉默优于编造）。
    final tools = f.tools.where((t) => t.isNotEmpty).toList(growable: false);
    return Padding(
      padding: const EdgeInsets.only(bottom: DshSpace.s4),
      // 🔴 **一整行要占满那一栏的宽**：`TextButton` 的宽度本来**跟内容算**，
      //    而 `Row` 里的 `Expanded` 在"宽无界"时不会把文字压出省略号 ——
      //    路径长一点，这颗按钮就会**戳出那一栏的右缘**（真栽过：
      //    一条 8 个字的路径把按钮撑到 `x≈758`，而那一栏右缘是 770、
      //    聊天窗口的输入条又从下面压上来 ⇒ 点那一行点到了输入框）。
      child: SizedBox(
        width: double.infinity,
        child: TextButton(
          key: filePanelRowKey(f.path),
          onPressed: () => setState(() => _open = !_open),
          style: TextButton.styleFrom(
            // D3.6：命中区下限 44
            minimumSize: const Size(44, 44),
            padding: const EdgeInsets.symmetric(
              horizontal: DshSpace.s8,
              vertical: DshSpace.s4,
            ),
            alignment: Alignment.centerLeft,
            foregroundColor: p.labelSecondary,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    // ⚠️ 方向只表示"点开/收起"，不是状态（状态不许只靠图形；
                    //    这里旁边就写着那是哪一次、还跑不跑）。
                    _open ? Icons.keyboard_arrow_down : Icons.keyboard_arrow_right,
                    size: look.content.size,
                    color: p.labelTertiary,
                  ),
                  const SizedBox(width: DshSpace.s4),
                  // 路径：**等宽、一行、超了省略号**（派活单点名）。
                  Expanded(
                    child: Text(
                      f.path,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: dshTextStyle(
                        look.content,
                        p.labelPrimary,
                        family: dshMonoFamily,
                      ),
                    ),
                  ),
                ],
              ),
              if (tools.isNotEmpty || f.running) ...[
                const SizedBox(height: DshSpace.s4),
                Wrap(
                  spacing: DshSpace.s8,
                  runSpacing: DshSpace.s4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    if (tools.isNotEmpty)
                      Text(
                        filePanelToolLine(tools),
                        style: dshTextStyle(look.caption, p.labelTertiary),
                      ),
                    if (f.running)
                      Text(
                        toolStatusWord(ToolStatus.running),
                        style: dshTextStyle(look.caption, p.stateBusiness),
                      ),
                  ],
                ),
              ],
              if (_open) _args(look),
            ],
          ),
        ),
      ),
    );
  }

  /// 展开那一块：**那一次的入参原文**（纯文本、有界、能滚到底）。
  ///
  /// 🔴 三条与 `116` 的工具行**逐字相同**：
  ///   · **有界 ≠ 截断**（`dshToolBodyMaxHeight`：超了在框里滚，不删字）；
  ///   · **不是 Markdown/HTML**：入参是纯文本 ⇒ 只走 `SelectableText`；
  ///   · **截了就要说**：服务端在 `tool/call` 上报过 `truncated` 才说
  ///     （`filePanelArgsTruncatedLine`），**不自己数一遍**。
  Widget _args(DshLook look) {
    final p = look.palette;
    final row = widget.change.row;
    final args = row.args;
    return Padding(
      padding: const EdgeInsets.only(top: DshSpace.s8, left: DshSpace.s4),
      child: Container(
        width: double.infinity,
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
                Text(
                  filePanelArgsHead,
                  style: dshTextStyle(look.caption, p.labelTertiary),
                ),
                if (args != null && args.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: DshSpace.s4),
                    child: SelectableText(
                      args,
                      style: dshTextStyle(
                        look.mono,
                        p.labelSecondary,
                        family: dshMonoFamily,
                      ),
                    ),
                  ),
                // 🔴 **截了就要说**（不说的那一刻这一块就在说假话）。
                if (row.argsTruncated)
                  Padding(
                    padding: const EdgeInsets.only(top: DshSpace.s8),
                    child: Text(
                      filePanelArgsTruncatedLine(row.argsBytes),
                      style: dshTextStyle(look.caption, p.stateWarn),
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
