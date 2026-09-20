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

class Composer extends StatefulWidget {
  /// ⚠️ **刻意没有 `enabled` 参数**——手册 D5.14 说"打字框永远不许锁"。
  ///    留一个开关，就等于留一个"哪天有人顺手把它关掉"的机会。
  ///    网不好、断线、在重连——**都不该让人打不了字**。
  const Composer({super.key, required this.onSend, this.hint});

  final void Function(String text) onSend;
  final String? hint;

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
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: TextField(
              controller: _controller,
              focusNode: _focus,
              enabled: true, // ★ 永远不锁（D5.14）
              minLines: 1,
              maxLines: 6,
              textInputAction: TextInputAction.send,
              onSubmitted: (_) => _submit(),
              decoration: InputDecoration(
                hintText: widget.hint ?? '说点什么',
                border: const OutlineInputBorder(),
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
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
                  constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
                  onPressed: canSend ? _submit : null,
                  icon: const Icon(Icons.arrow_upward),
                  tooltip: '发送',
                  style: IconButton.styleFrom(
                    minimumSize: const Size(48, 48),
                    backgroundColor: canSend ? theme.colorScheme.primary : null,
                  ),
                ),
              );
            },
          ),
        ],
      ),
    );
  }
}
