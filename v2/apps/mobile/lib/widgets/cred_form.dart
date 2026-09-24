// **配置页里"填一串 / 填三样"那一块表单**（主人 2026-09-24 定的四个 tab）。
//
// ── 与 `key_form.dart` 的分别（两块都在，别合并）────────────────
//   · `key_form.dart`：**聊天那一把**专用的老表单 —— 它带着**粘贴**、
//     **取消注册**（不可逆，要先列清单）、以及第一次进来那一屏共用；
//   · 这一块：**图片 / 视频 / 语音**那三屏用 —— 字段可以有**一串**（语音是三样），
//     没有取消注册（注册那一件事只在聊天那把那一屏）。
//
// ── 三条规矩（与 `key_form.dart` 同源）───────────────────────
//   1. **失败要分开说**（空白 / 有空格换行 / 太长 / 没送过去）；
//   2. 🔴 **填进去不回落**：`obscure` 只挡旁边的人，**不清空**；
//   3. ⚠️ **一次提交写整屏的字段**（语音那三样必须一起写下去 ——
//      分开写会出现"填了两样"的半截状态）。
//
// ⚠️ 界面上**没有** `模型` / `工具` / `客户端` 这些词（词表硬闸会拦）。

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/design.dart' as d;
import '../models/key_outcome.dart';
import '../models/space_words.dart';

/// 一屏里要填的一项。
class CredField {
  const CredField({required this.key, required this.label, this.hint});

  /// 服务端认的短名（`model` / `voiceAppId` / …）—— **不认识就别编**。
  final String key;

  /// 输入框上那句话。
  final String label;

  /// 下面那行小字（说去哪找它）。
  final String? hint;
}

class CredForm extends StatefulWidget {
  const CredForm({
    super.key,
    required this.fields,
    required this.onSubmit,
    required this.submitLabel,
  });

  final List<CredField> fields;
  final Future<KeySend> Function(Map<String, String>) onSubmit;
  final String submitLabel;

  @override
  State<CredForm> createState() => _CredFormState();
}

class _CredFormState extends State<CredForm> {
  late final List<TextEditingController> _c =
      widget.fields.map((_) => TextEditingController()).toList();
  bool _busy = false;
  String? _err;

  @override
  void dispose() {
    for (final c in _c) {
      c.dispose();
    }
    super.dispose();
  }

  /// 从剪贴板读一段填进某一格。
  /// ⚠️ 读不到**不算错**（可能没授权、剪贴板是空的）—— 说清还能怎么办就行。
  Future<void> _paste(int i) async {
    String? text;
    try {
      final d = await Clipboard.getData(Clipboard.kTextPlain);
      text = d?.text;
    } catch (_) {
      text = null;
    }
    if (!mounted) return;
    if (text == null || text.trim().isEmpty) {
      setState(() => _err = keyPasteFailed);
      return;
    }
    // ⚠️ **只 trim 首尾**：中间的空格/换行要留着，让服务端那条检查去说他。
    _c[i].text = text.trim();
    setState(() => _err = null);
  }

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _err = null;
    });
    final values = <String, String>{};
    for (var i = 0; i < widget.fields.length; i += 1) {
      values[widget.fields[i].key] = _c[i].text.trim();
    }
    final r = await widget.onSubmit(values);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _err = switch (r) {
        KeySend.ok => null,
        KeySend.blank => keyBlank,
        KeySend.badChars => keyBadChars,
        KeySend.tooLong => keyTooLong,
        KeySend.failed => keyFailed,
      };
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var i = 0; i < widget.fields.length; i += 1) ...[
          TextField(
            controller: _c[i],
            // ⚠️ **挡旁边的人，但不清空**
            obscureText: true,
            autocorrect: false,
            enableSuggestions: false,
            decoration: InputDecoration(
              labelText: widget.fields[i].label,
              border: const OutlineInputBorder(),
              // 每一格自己带"粘贴"：手机上空框长按不弹菜单（见 `key_form.dart` 那段）
              suffixIcon: IconButton(
                icon: const Icon(Icons.content_paste),
                tooltip: keyPaste,
                onPressed: _busy ? null : () => _paste(i),
              ),
            ),
          ),
          if (widget.fields[i].hint != null) ...[
            const SizedBox(height: d.gapXs),
            Text(
              widget.fields[i].hint!,
              style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
            ),
          ],
          const SizedBox(height: d.gapM),
        ],
        if (_err != null) ...[
          const SizedBox(height: d.gapXs),
          Text(
            _err!,
            style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.error),
            textAlign: TextAlign.center,
          ),
        ],
        const SizedBox(height: d.gapS),
        FilledButton(
          onPressed: _busy ? null : _submit,
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
          child: Text(_busy ? '…' : widget.submitLabel),
        ),
        const SizedBox(height: d.gapS),
        Text(keyPrivacy, style: t.textTheme.bodySmall, textAlign: TextAlign.center),
      ],
    );
  }
}
