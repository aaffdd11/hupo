// 输入条。手册 `08-SPEC.md` §6.5、`05-DECISIONS.md` D5.14。
//
// ⚠️ **这一条是从探针那一步学来的，很重要**：
//
//   探针里我**每敲一个字就 `setState` 重建整个页面**（包括输入框）。
//   那是 Flutter 里一个**已知会把输入法合成搞乱**的写法——
//   而"打不了字的人能不能用"整条结论就压在输入法上。
//
//   ⇒ 这里**只重建按钮**：`ValueListenableBuilder` 只包住需要变的那一小块，
//     `TextField` 本身**在整个输入过程中不被重建**。
//
// 另一条：**打字框永远不许锁**（D5.14）。
// 09 是"网好时打字、出电梯才发"——把他锁住等于毁掉唯一顺畅的用法。

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/design.dart' as d;
import '../models/space_words.dart';

class Composer extends StatefulWidget {
  /// ⚠️ **刻意没有 `enabled` 参数**——手册 D5.14 说"打字框永远不许锁"。
  ///    留一个开关，就等于留一个"哪天有人顺手把它关掉"的机会。
  ///    网不好、断线、在重连——**都不该让人打不了字**。
  const Composer({
    super.key,
    required this.onSend,
    this.hint,
    this.draft,
    this.onDraftChanged,
    this.onDraftCleared,
    this.onFocused,
  });

  final void Function(String text) onSend;
  final String? hint;

  /// **本机存着的那份草稿**（"打了一半、还没发出去"的字；上层从控制器读）。
  /// ⚠️ 它**不是**"已发未认领那句话"（那是 `draft_store.dart` 那本账）。
  final String? draft;

  /// 框里的字变了（上层存盘 —— 主人：*"草稿也是要记住的"*）。
  final ValueChanged<String>? onDraftChanged;

  /// 这份草稿不用了（上层清掉）。
  final VoidCallback? onDraftCleared;

  /// **用户点了打字框**（主人 2026-09-22：*"点击说点什么，聊天窗口会自动打开。"*）。
  /// ⚠️ 收起态那条里也有这个框 ⇒ 点它要先**把窗口打开**，不然他是在一条
  /// 只有一行的缝里打字（而上面那一大块明明在）。
  final VoidCallback? onFocused;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  final _controller = TextEditingController();
  final _focus = FocusNode();

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// 从剪贴板读一段，**接在光标处**（不是替换 —— 聊天里他可能已经打了一半）。
  Future<void> _paste() async {
    String? text;
    try {
      final d = await Clipboard.getData(Clipboard.kTextPlain);
      text = d?.text;
    } catch (_) {
      text = null;
    }
    if (!mounted || text == null || text.isEmpty) return;
    // 接在**光标处**（没有光标就接在末尾）—— 顺手把光标挪到粘完的位置
    final v = _controller.value;
    final at = v.selection.isValid ? v.selection.end : v.text.length;
    final next = v.text.substring(0, at) + text + v.text.substring(at);
    _controller.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: at + text.length),
    );
    _focus.requestFocus();
  }

  /// 框里的字变了 ⇒ 交给上层存下来（**一边打一边存**，刷新回来还在）。
  void _onChanged(String text) {
    widget.onDraftChanged?.call(text);
    setState(() {}); // 草稿条要跟着"框是不是空的"变
  }

  /// **把上面那条草稿放回框里**（"接着写"）。
  void _resume() {
    final d = widget.draft;
    if (d == null) return;
    _controller.value = TextEditingValue(
      text: d,
      selection: TextSelection.collapsed(offset: d.length),
    );
    _focus.requestFocus();
    setState(() {});
  }

  void _submit() {
    final text = _controller.text.trim();
    if (text.isEmpty) return;
    _controller.clear();
    // ⚠️ 发完**焦点留在框里**：连着说两句不用再点一次
    _focus.requestFocus();
    widget.onSend(text);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // 框里有字 ⇒ 不画草稿条（同一句话不许画两遍）
    final showDraft =
        (widget.draft?.isNotEmpty ?? false) && _controller.text.isEmpty;
    return Padding(
      // ★ 主人 2026-09-22："聊天浮窗的 padding 减少一些"（里面这一圈）：12/8 → 8/6
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // ── **上面那条草稿**（主人 2026-09-22）──────────────────
          //   规则：**框是空的、而且本机存着一份草稿**时才出现。
          //   ⚠️ 一旦他开始打字（框里有字），这条就收起来 —— 不然同一句话画两遍。
          if (showDraft) _draftStrip(theme),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              // 🔴 **粘贴**（2026-09-21 主人报「我无法黏贴」之后加的）。
              //    ⚠️ 同一个病：Flutter 把字画在 canvas 上，**空输入框长按不弹菜单**
              //      （它自己的选择菜单要有可选中的文字才弹）⇒ 手机没物理键盘就粘不进来。
              //    ⇒ 一个按钮按下去就是「用户手势」，能合法读剪贴板。
              //    ⚠️ 命中区 ≥44（`IconButton` 默认 48）。
              IconButton(
                tooltip: composerPaste,
                icon: const Icon(Icons.content_paste),
                onPressed: _paste,
              ),
              Expanded(
                child: TextField(
                  controller: _controller,
                  focusNode: _focus,
                  enabled: true, // ★ 永远不锁（D5.14）
                  minLines: 1,
                  maxLines: 6,
                  textInputAction: TextInputAction.send,
                  // ★ **点了打字框 ⇒ 告诉上层"把窗口打开"**（主人 2026-09-22：
                  //   *"点击说点什么，聊天窗口会自动打开。"*）
                  onTap: widget.onFocused,
                  onChanged: _onChanged,
                  onSubmitted: (_) => _submit(),
                  decoration: InputDecoration(
                    hintText: widget.hint ?? '说点什么',
                    border: const OutlineInputBorder(),
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 14,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              // ★ 只有这一块跟着输入变——输入框本身不会被重建
              ValueListenableBuilder<TextEditingValue>(
                valueListenable: _controller,
                builder: (context, value, _) {
                  final canSend = value.text.trim().isNotEmpty;
                  return Semantics(
                    button: true,
                    label: canSend ? '发送' : '还没有话要说',
                    child: IconButton.filled(
                      // 触控目标 ≥44
                      constraints: const BoxConstraints(
                        minWidth: 48,
                        minHeight: 48,
                      ),
                      onPressed: canSend ? _submit : null,
                      icon: const Icon(Icons.arrow_upward),
                      tooltip: '发送',
                      style: IconButton.styleFrom(
                        minimumSize: const Size(48, 48),
                        backgroundColor: canSend
                            ? theme.colorScheme.primary
                            : null,
                      ),
                    ),
                  );
                },
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// 草稿条：**说清这是你打了一半的字**，并给两条出路（接着写 / 不用了）。
  Widget _draftStrip(ThemeData theme) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 4),
      decoration: BoxDecoration(
        color: d.card,
        borderRadius: BorderRadius.circular(d.radiusField),
        border: Border.all(color: d.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            composeDraftTitle,
            style: theme.textTheme.labelLarge?.copyWith(color: d.accent),
          ),
          const SizedBox(height: 4),
          Text(
            widget.draft!,
            style: theme.textTheme.bodyMedium?.copyWith(color: d.ink),
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: 2),
          Row(
            children: [
              TextButton(
                // 命中区 ≥44（D3.6）：`TextButton` 默认给的是 36 —— 显式撑起来
                style: TextButton.styleFrom(minimumSize: const Size(88, 44)),
                onPressed: _resume,
                child: const Text(composeDraftBack),
              ),
              TextButton(
                style: TextButton.styleFrom(minimumSize: const Size(88, 44)),
                onPressed: widget.onDraftCleared,
                child: const Text(composeDraftDiscard),
              ),
            ],
          ),
        ],
      ),
    ),
  );
}
