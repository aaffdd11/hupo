// **"还差最后一步：填你自己那串钥匙"**（契约 `docs/dev/38-ISOLATION-SPLIT.md` §8.3）。
//
// ── 它现在只负责"摆位" ────────────────────────────────────
//   表单本身（输入框 / 粘贴 / 四种失败话 / 取消注册）搬去了 `widgets/key_form.dart`，
//   因为**同一块东西有两个去处**（契约 `docs/dev/48-SETTINGS-KEY.md`）：
//   ① **这一屏**：第一次进来时，流程推着你填；
//   ② 聊天页上那个**「配置」**（`SettingsScreen`）：随时能唤起它换一串。
//   ⇒ 一份实现两处用（各写一份 = 一定会漂）。
//
// ⚠️ 界面上**没有** `模型` / `工具` / `客户端` 这些词（词表硬闸会拦，见 `forbidden_words.dart`）。

import 'package:flutter/material.dart';

import '../models/space_words.dart';
import '../services/api.dart';
import '../widgets/key_form.dart';

class ModelKeyScreen extends StatelessWidget {
  const ModelKeyScreen({
    super.key,
    required this.onSubmit,
    this.onCancel,
    this.onCancelled,
  });

  /// 交给上层去发（这一屏**只管界面与那四句失败话**）。
  final Future<KeySend> Function(String key) onSubmit;

  /// 🔴 **取消注册**（主人 2026-09-22）。`null` ⇒ 不显示那个入口
  /// （单看这一屏的测试可以不传）。
  final Future<CancelOutcome> Function()? onCancel;

  /// 收掉之后回登录页（令牌已经被服务端撤了）。
  final VoidCallback? onCancelled;

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
                KeyForm(onSubmit: onSubmit, onCancel: onCancel, onCancelled: onCancelled),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
