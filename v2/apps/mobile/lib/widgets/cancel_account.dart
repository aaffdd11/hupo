// **「注销账号」那一条**：入口 ＋ 先把话列清楚的确认框 ＋ 六种结果各说各的。
//
// ── 为什么抽出来（2026-09-29）──────────────────────────────
// 它现在有**两个去处**：
//   ① 填钥匙那块表单的最下面（`key_form.dart` —— 第一次进来那一屏 /「模型设置」那一页）；
//   ② 设置列表里**单独立出来**的「注销账号」那一页（主人要"每一项点开才是配置"）。
// ⇒ 同一件不可逆的事、同一套话、**同一个确认框** —— 一份实现两处用
//   （两处各写一份 = 迟早有一处忘了弹确认框，而这一步撤不回来）。
//
// ── 顺序是死的（手册 X3 ②）────────────────────────────────
//   **先说清删什么，再动手**：反过来的话，用户是"点了才知道会删"。
//
// ⚠️ 两种画法的**差别只有一个**：`danger`。表单底下那条要**隐蔽**
//   （主人 2026-09-22："隐蔽一点"= 入口不抢眼：小字 + 次要色 + 排在主流程下面），
//   而设置里那一页是**独立入口**，要让人看得见它在那儿 —— 但仍然不是
//   "随手一按就没"：两处都要过他亲手点的那一个确认框。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/key_outcome.dart';
import '../models/space_words.dart';

class CancelAccountEntry extends StatefulWidget {
  const CancelAccountEntry({
    super.key,
    required this.onCancel,
    required this.onCancelled,
    this.label = keyCancelEntry,
    this.danger = false,
    this.buttonKey,
  });

  /// 真去收（服务端那条路 —— 结果由 [CancelOutcome] 逐种说清）。
  final Future<CancelOutcome> Function() onCancel;

  /// 收掉之后回登录页（令牌已经被服务端撤了）。
  final VoidCallback onCancelled;

  /// 按钮上那句话（表单底下是「不想填了，取消注册」，独立那一页是「注销账号」）。
  final String label;

  /// 真 ⇒ 用警示色画（独立入口那一页）；假 ⇒ 次要色（表单底下那条）。
  final bool danger;

  /// 给判据认的那一个按钮（同一屏上有两处时用来指名道姓）。
  final Key? buttonKey;

  @override
  State<CancelAccountEntry> createState() => _CancelAccountEntryState();
}

class _CancelAccountEntryState extends State<CancelAccountEntry> {
  bool _busy = false;
  String? _err;

  /// 🔴 **先列清单、再问一次**，然后才真调。
  Future<void> _cancel() async {
    final go = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text(keyCancelTitle),
        content: const Text(keyCancelWhat),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text(keyCancelNo),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text(keyCancelYes),
          ),
        ],
      ),
    );
    if (go != true || !mounted) return;
    setState(() => _busy = true);
    final r = await widget.onCancel();
    if (!mounted) return;
    setState(() => _busy = false);
    final msg = switch (r) {
      CancelOutcome.ok => keyCancelOk,
      CancelOutcome.noHelper => keyCancelNoHelper,
      CancelOutcome.protectedOne => keyCancelProtected,
      CancelOutcome.local => keyCancelLocal,
      CancelOutcome.noTenant => keyCancelNone,
      CancelOutcome.needsRelogin => keyCancelRelogin,
      CancelOutcome.failed => keyCancelFailed,
    };
    // ★ **要重新登一次**（账 #39）：服务端在这一步**什么都没做** ⇒
    //   把他的原话念给他听（"现在什么都没动"），然后**送他回登录那一屏** ——
    //   因为下一步就是"重新登一次，再点一遍"。
    if (r == CancelOutcome.needsRelogin) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
      widget.onCancelled();
      return;
    }
    if (r == CancelOutcome.ok) {
      // ⚠️ **收掉了就回登录页**：令牌已经被服务端撤了，留在这儿只会到处 401。
      //    先说一句"已经在收了"，再走 —— 不然用户不知道刚才那一下干了什么。
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
      widget.onCancelled();
      return;
    }
    setState(() => _err = msg);
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final color = widget.danger ? t.colorScheme.error : t.colorScheme.onSurfaceVariant;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.danger)
          FilledButton.tonal(
            key: widget.buttonKey,
            style: FilledButton.styleFrom(
              minimumSize: const Size.fromHeight(48),
              foregroundColor: color,
            ),
            onPressed: _busy ? null : _cancel,
            child: Text(widget.label),
          )
        else
          TextButton(
            key: widget.buttonKey,
            style: TextButton.styleFrom(
              minimumSize: const Size(48, 44),
              foregroundColor: color,
            ),
            onPressed: _busy ? null : _cancel,
            child: Text(widget.label, style: t.textTheme.bodySmall),
          ),
        if (_err != null) ...[
          const SizedBox(height: d.gapS),
          Text(
            _err!,
            style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.error),
            textAlign: TextAlign.center,
          ),
        ],
      ],
    );
  }
}
