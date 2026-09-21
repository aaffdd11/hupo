// **填钥匙那一块表单**（输入框 + 粘贴 + 四种失败话 + 提交 + 取消注册）。
//
// ── 为什么抽出来 ──────────────────────────────────────────
// 它现在有**两个去处**（`docs/dev/48-SETTINGS-KEY.md`）：
//   ① **第一次**进来时那一屏（`ModelKeyScreen`）—— 流程推着你填；
//   ② 聊天页上那个**「配置」**（`SettingsScreen`）—— 你**随时**能唤起它换一串。
// ⇒ 同一块东西、同一套话，**一份实现两处用**（两处各写一份 = 一定会漂）。
//
// ── 四条规矩（原来写在 `model_key_screen.dart` 里，搬过来是**原文**）──
//   1. **说清这是什么、去哪找**（`keyBody` / `keyWhere`）；
//   2. **说清它去哪**（`keyPrivacy`：只送到你自己那一台，不留在我们这边）；
//   3. **失败要分开说**（空白 / 有空格换行 / 太长 / 没送过去）—— 混成一句用户会一直重试；
//   4. 🔴 **填进去不回落**：输入框用 `obscure` 挡一下**旁边的人**，
//      但**不清空**（清空会让他以为没填上，然后再粘一遍）。
//
// ⚠️ 界面上**没有** `模型` / `工具` / `客户端` 这些词（词表硬闸会拦）。

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/key_outcome.dart';
import '../models/space_words.dart';

class KeyForm extends StatefulWidget {
  const KeyForm({
    super.key,
    required this.onSubmit,
    this.onCancel,
    this.onCancelled,
    this.submitLabel = keySubmit,
  });

  /// 交给上层去发（这一块**只管界面与那四句失败话**）。
  final Future<KeySend> Function(String key) onSubmit;

  /// 🔴 **取消注册**（主人 2026-09-22）。`null` ⇒ 不显示那个入口。
  /// ⚠️ 它**不可逆**，所以这一块**先弹确认框把"删掉什么"列清楚**再调它。
  final Future<CancelOutcome> Function()? onCancel;

  /// 收掉之后回登录页（令牌已经被服务端撤了）。
  final VoidCallback? onCancelled;

  /// 提交按钮上那句话（第一次是"填好了"，换一串时是"换好了"）。
  final String submitLabel;

  @override
  State<KeyForm> createState() => _KeyFormState();
}

class _KeyFormState extends State<KeyForm> {
  final _c = TextEditingController();
  bool _busy = false;
  String? _err;

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  /// 从剪贴板读一把填进去。
  /// ⚠️ 读不到**不算错**（用户可能没授权、或者剪贴板是空的）—— 说清还能怎么办就行。
  Future<void> _paste() async {
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
    // ⚠️ **只 trim 首尾**：钥匙中间的空格/换行要留着，让服务端那条
    //    "有空格换行"的检查去说他 —— 在这儿替他改，是我们在猜他要粘什么。
    _c.text = text.trim();
    setState(() => _err = null);
  }

  /// 🔴 **取消注册**：先**列清单**、再问一次，然后才真调。
  ///
  /// ⚠️ 顺序是死的：**先说清删什么**（手册 X3 ②），**再动手**。
  ///    反过来的话，用户是"点了才知道会删" —— 那不可逆。
  Future<void> _cancel() async {
    final go = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text(keyCancelTitle),
        content: const Text(keyCancelWhat),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text(keyCancelNo)),
          FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text(keyCancelYes)),
        ],
      ),
    );
    if (go != true || !mounted) return;
    setState(() => _busy = true);
    final r = await widget.onCancel!();
    if (!mounted) return;
    setState(() => _busy = false);
    final msg = switch (r) {
      CancelOutcome.ok => keyCancelOk,
      CancelOutcome.noHelper => keyCancelNoHelper,
      CancelOutcome.protectedOne => keyCancelProtected,
      CancelOutcome.local => keyCancelLocal,
      CancelOutcome.noTenant => keyCancelNone,
      CancelOutcome.failed => keyCancelFailed,
    };
    if (r == CancelOutcome.ok) {
      // ⚠️ **收掉了就回登录页**：令牌已经被服务端撤了，留在这儿只会到处 401。
      //    先说一句"已经在收了"，再走 —— 不然用户不知道刚才那一下干了什么。
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
      widget.onCancelled?.call();
      return;
    }
    setState(() => _err = msg);
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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: _c,
          // ⚠️ **挡旁边的人，但不清空**（见文件头第 4 条）
          obscureText: true,
          autocorrect: false,
          enableSuggestions: false,
          decoration: InputDecoration(labelText: keyLabel, border: const OutlineInputBorder()),
        ),
        const SizedBox(height: 10),
        // 🔴 **粘贴**（2026-09-21 主人报"我无法黏贴"之后加的）。
        //    ⚠️ 手机上没有这个按钮就**真的粘不进来**：空框长按不弹菜单
        //      （Flutter 的选择菜单要有可选中的文字才弹）。见 `keyPaste` 那段。
        OutlinedButton(
          style: OutlinedButton.styleFrom(minimumSize: const Size(48, 48)),
          onPressed: _busy ? null : _paste,
          child: const Text(keyPaste),
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
          child: Text(_busy ? '…' : widget.submitLabel),
        ),
        const SizedBox(height: 12),
        Text(keyPrivacy, style: t.textTheme.bodySmall, textAlign: TextAlign.center),
        // 🔴 **取消注册**（主人 2026-09-22："隐蔽一点"）。
        //    ⚠️ "隐蔽"= **入口不抢眼**（小字 + 次要色 + 放在主流程**下面**），
        //      **不是**"不告诉他就删" —— 点下去先弹一个把话列清楚的确认框。
        if (widget.onCancel != null && widget.onCancelled != null)
          TextButton(
            style: TextButton.styleFrom(
              minimumSize: const Size(48, 44),
              foregroundColor: t.colorScheme.onSurfaceVariant,
            ),
            onPressed: _busy ? null : _cancel,
            child: Text(keyCancelEntry, style: t.textTheme.bodySmall),
          ),
      ],
    );
  }
}
