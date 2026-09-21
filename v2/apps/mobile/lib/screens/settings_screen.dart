// **「配置」** —— 页面上随时能唤起的那一屏（契约 `docs/dev/48-SETTINGS-KEY.md`）。
//
// 主人 2026-09-22：*"用户可以在页面唤起配置。配置上可以输入 apikey"*。
//
// ── 为什么要有它 ──────────────────────────────────────────
// 钥匙原来**只有**第一次那条流程能填：填过之后就再也回不去那一屏了
// （只有"被判无效"之后刷新页面才碰巧回得去 —— 那是欠账 #34）。
// ⇒ 换一把钥匙、或者"我到底有没有填过"，用户**没有地方可去**。
//
// ── 三条纪律 ──────────────────────────────────────────────
//   ① **现状要如实**：有三种状态（有 / 没填过 / 填过但被判无效），
//      它们必须**分得开**（`keyStateLine`）—— 混成一句就是页面在说假话；
//   ② **换掉要说清**：已经有一串时，上面明说"填一串新的就会把它换掉"；
//   ③ **不新增第二份真相**：表单就是 `widgets/key_form.dart` 那一块，
//      和第一次进来那一屏**用的是同一个东西**。
//
// ⚠️ 界面上**没有** `模型` / `工具` / `客户端` 这些词（词表硬闸会拦）。

import 'package:flutter/material.dart';

import '../models/space_words.dart';
import '../services/api.dart';
import '../widgets/key_form.dart';
import 'about_screen.dart';

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({
    super.key,
    required this.hasKey,
    required this.keyBad,
    required this.onSubmit,
    this.localOnly = false,
    this.onCancel,
    this.onCancelled,
    this.onKeyChanged,
  });

  /// 现在有没有一串能用的钥匙（服务端说的）。
  final bool hasKey;

  /// 有没有"填过、但上游说它不灵"（服务端说的）。
  final bool keyBad;

  final Future<KeySend> Function(String key) onSubmit;
  final Future<CancelOutcome> Function()? onCancel;
  final VoidCallback? onCancelled;

  /// 🔴 **"你自己这一份"那种（没有单独一台）** ⇒ 不给钥匙表单，只说实话。
  final bool localOnly;

  /// 换成功之后叫一声（上层去重问一次状态，让别处也跟着对）。
  final VoidCallback? onKeyChanged;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text(configTitle)),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(configKeySection, style: t.textTheme.titleMedium),
              const SizedBox(height: 8),
              if (localOnly) ...[
                // 🔴 **本机那一份：说实话、不给假输入框**（见 `configLocalOnly` 那段）
                Text(configLocalOnly, style: t.textTheme.bodyMedium),
              ] else ...[
              // ★ **现状**：三种状态分开说（见 `keyStateLine` 那段）。
              Text(keyStateLine(hasKey: hasKey, keyBad: keyBad), style: t.textTheme.bodyMedium),
              if (hasKey) ...[
                const SizedBox(height: 4),
                Text(configKeyHint, style: t.textTheme.bodySmall),
              ],
              const SizedBox(height: 16),
              KeyForm(
                // ⚠️ 换成功之后**顺手叫一声**（上层拿它去重问一次状态）——
                //    不然用户回到聊天页时，别处可能还挂着"没有钥匙"那句旧话。
                onSubmit: (k) async {
                  final r = await onSubmit(k);
                  if (r == KeySend.ok && context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text(configKeyChanged)),
                    );
                    onKeyChanged?.call();
                  }
                  return r;
                },
                onCancel: onCancel,
                onCancelled: onCancelled,
                submitLabel: hasKey ? keySubmitChange : keySubmit,
              ),
              ],
              const SizedBox(height: 24),
              const Divider(),
              // ⚠️ **关于搬进来了**（见 `space_words.dart` 那段）：
              //    顶栏再加一个图标就是 7 个 —— 手机上那一条会挤成一团。
              //    它本来就是配置那一类东西（"这台设备上行不行"）。
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.info_outline),
                title: const Text('关于'),
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(builder: (_) => const AboutScreen()),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
