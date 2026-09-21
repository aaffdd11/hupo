// **"还差最后一步：填你自己那串钥匙"**（契约 `docs/dev/38-ISOLATION-SPLIT.md` §8.3）。
//
// ── 四条规矩 ──────────────────────────────────────────────
//   1. **说清这是什么、去哪找**（`keyBody` / `keyWhere`）—— 用户不会拼音、不读术语；
//   2. **说清它去哪**（`keyPrivacy`：只送到你自己那一台，不留在我们这边）——
//      这一句是**如实**，不是营销话术；
//   3. **失败要分开说**（空白 / 有空格换行 / 太长 / 没送过去）—— 混成一句用户会一直重试；
//   4. 🔴 **填进去不回落**：输入框用 `obscure` 挡一下**旁边的人**，
//      但**不清空**（清空会让他以为没填上，然后再粘一遍）。
//
// ⚠️ 界面上**没有** `模型` / `工具` / `客户端` 这些词（词表硬闸会拦，见 `forbidden_words.dart`）。

import 'package:flutter/material.dart';

import '../models/space_words.dart';
import '../services/api.dart';

class ModelKeyScreen extends StatefulWidget {
  const ModelKeyScreen({super.key, required this.onSubmit});

  /// 交给上层去发（这一屏**只管界面与那四句失败话**）。
  final Future<KeySend> Function(String key) onSubmit;

  @override
  State<ModelKeyScreen> createState() => _ModelKeyScreenState();
}

class _ModelKeyScreenState extends State<ModelKeyScreen> {
  final _c = TextEditingController();
  bool _busy = false;
  String? _err;

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _err = null;
    });
    final r = await widget.onSubmit(_c.text);
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
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(keyTitle, style: t.textTheme.titleLarge, textAlign: TextAlign.center),
                const SizedBox(height: 12),
                Text(keyBody, style: t.textTheme.bodyMedium, textAlign: TextAlign.center),
                const SizedBox(height: 4),
                Text(keyWhere, style: t.textTheme.bodySmall, textAlign: TextAlign.center),
                const SizedBox(height: 16),
                TextField(
                  controller: _c,
                  // ⚠️ **挡旁边的人，但不清空**（见文件头第 4 条）
                  obscureText: true,
                  autocorrect: false,
                  enableSuggestions: false,
                  decoration: InputDecoration(
                    labelText: keyLabel,
                    border: const OutlineInputBorder(),
                  ),
                ),
                if (_err != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    _err!,
                    style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.error),
                    textAlign: TextAlign.center,
                  ),
                ],
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: _busy ? null : _submit,
                  style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                  child: Text(_busy ? '…' : keySubmit),
                ),
                const SizedBox(height: 12),
                Text(keyPrivacy, style: t.textTheme.bodySmall, textAlign: TextAlign.center),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
