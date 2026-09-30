// **「设置过的那一屏」那一段**：默认只说"已设置"，点了「修改」才摆输入框。
//
// 🔴 主人 2026-10-01 的原话：*"设置过的你要显示已设置，然后点击修改再修改。"*
//
// ── 为什么非改不可（真事）──────────────────────────────────
//   以前**输入框永远摆在那里**（空的）；他填完之后回到这一屏，看见的还是两个空框
//   ⇒ 他的结论是"**没效果**"（2026-10-01 真报过这一条）。而密钥**从不回填**是我们
//   自己的纪律（页面上永不回显钥匙）⇒ 两边一撞，就成了"页面在说假话"。
//   ⇒ 解法只有一条：**设置过就不摆输入框**，只说"已设置"；要看框，**自己点「修改」**。
//
// ⚠️ 这一块**只管"什么时候画表单"**，不碰钥匙、不碰网络（`CredForm` / `KeyForm` 照旧）。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/space_words.dart';

class CredSection extends StatefulWidget {
  const CredSection({
    super.key,
    required this.has,
    required this.what,
    required this.stateWords,
    required this.formBuilder,
    this.extras = const [],
    this.extraBelow = const [],
  });

  /// 现在**有没有**（服务端说的）。`true` ⇒ 默认只显示"已设置 ＋ 修改"。
  final bool has;

  /// **这一屏填什么、从哪儿拿**（`credTabWhat`）。
  final String what;

  /// **有没有**那句话（`credStateLine`）。
  final String stateWords;

  /// **钥匙那一块表单**（`KeyForm` / `CredForm`）—— 设置过、没点"修改"时**不画它**。
  ///
  /// 🔴 它是**一个 builder**（而不是一个现成的列表）：因为**保存成功之后要自动退回
  ///    "已设置"那一档** —— 那一块得拿到 [onSaved] 这个回调（2026-10-01 的真事：
  ///    主人填完保存，屏幕上**还是那两个输入框**，他的结论是"是不是没保存成功"）。
  final List<Widget> Function(VoidCallback onSaved) formBuilder;

  /// 🔴 **"试一张 / 录一段 / 试一下"那些块** —— 它们**不碰钥匙**，
  ///    所以**两种状态都画**（设置过之后他更想当场试一下）。
  final List<Widget> extras;

  /// 设置过时，"已设置 ＋ 修改"下面要不要再挂点别的（现在没用上，留个口）。
  final List<Widget> extraBelow;

  @override
  State<CredSection> createState() => _CredSectionState();
}

class _CredSectionState extends State<CredSection> {
  bool _editing = false;

  /// 🔴 **保存成功 ⇒ 自动退回"已设置"那一档**（不然那一屏会一直是"修改中"的样子）。
  void _backToSet() {
    if (!mounted) return;
    setState(() => _editing = false);
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final form = widget.formBuilder(_backToSet);
    // ── 设置过、而且没点"修改" ⇒ **只说已设置**（一个输入框都不画）────────
    if (widget.has && !_editing) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            credSetWords,
            style: t.textTheme.bodyMedium?.copyWith(color: d.ink),
          ),
          const SizedBox(height: d.gapM),
          OutlinedButton(
            onPressed: () => setState(() => _editing = true),
            style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
            child: const Text(credModifyWords),
          ),
          ...widget.extraBelow,
          // 设置过也照旧摆着"试一张 / 录一段 / 试一下"（它们是拿来用这把钥匙的）
          ...widget.extras,
        ],
      );
    }
    // ── 没设置过（要填第一次）或者点了"修改" ⇒ 画那一套 ────────────────
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(widget.what, style: t.textTheme.bodyMedium?.copyWith(color: d.ink)),
        const SizedBox(height: d.gapXs),
        Text(widget.stateWords, style: t.textTheme.bodyMedium?.copyWith(color: d.ink)),
        const SizedBox(height: d.gapM),
        ...form,
        // 🔴 动作块（试一张 / 录一段 / 试一下）**两种状态都画**：
        //    它们不碰钥匙，设置过之后他更想当场试一下（漏了这一行的后果：
        //    `voice_record_test` / `voice_try_test` 那 31 条当场全红 —— 2026-10-01 真发生过）。
        ...widget.extras,
        // 设置过的、点开"修改"之后 ⇒ 给一个**反悔**的出口（不然只能一路填下去）
        if (widget.has) ...[
          const SizedBox(height: d.gapS),
          TextButton(
            onPressed: () => setState(() => _editing = false),
            child: const Text(credCancelWords),
          ),
        ],
      ],
    );
  }
}
