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

import '../models/design.dart' as d;
import '../models/space_words.dart';
import '../services/api.dart';
import '../widgets/key_form.dart';
import 'about_screen.dart';

/// **分区标题**（设置页这一层就两三个，形状只有一种）。
///
/// 🔴 为什么不用强调色：它原来用 `d.accent`，屏幕上读起来像**警告** ——
///    而它只是"这一块叫什么"。分区名要**稳**，要让红色的意思留给"退出登录"这类事。
/// ⚠️ 字号不写死（跟主题那一档走）；什么时候全站统一，见 `72-UI-PASS.md` 的 E。
class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Text(
      text,
      style: t.textTheme.titleSmall?.copyWith(
        color: d.ink,
        fontWeight: FontWeight.w600,
      ),
    );
  }
}

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
    this.onLogout,
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

  /// **退出登录**（主人 2026-09-22：*"桌面上应当有一个设置的小程序，用来退出登录，
  /// 注销账号，修改 apikey。"*）
  /// ⚠️ 它**原来挂在聊天抓手行上**（一个 logout 图标）—— 现在搬进来了：
  ///    那一行是"聊天"的地方，而退出登录不是聊天的事。
  final VoidCallback? onLogout;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    // ⚠️ **没有 `Scaffold` / `AppBar`**：顶上那一条由**小程序容器**给
    //    （`MiniAppHost`）—— 小程序自己画的话，"跳不出容器"这件事就没了保证。
    return Center(
          child: ConstrainedBox(
            // ⚠️ **和首页同一条窄列**（契约 `49-STYLE.md`）：一行太长没人读得下去
            constraints: const BoxConstraints(maxWidth: 640),
            // ⚠️ `ListView` 不是 `Column`：字体放到最大时**能滚**，而不是溢出
            child: ListView(
              padding: const EdgeInsets.symmetric(horizontal: d.gapL, vertical: d.gapL),
              children: [
                // ── 钥匙那一段：**分区标题 + 白卡** ──
                // ★ 2026-09-23（主人：*"先整理整个UI"*）：标题原来是**强调色 + 加宽字距**，
                //   在屏幕上读起来像一条**警告**（它是分区名，不是告警）。
                //   ⇒ 改成"黑 + 加粗"的普通分区标题；什么时候统一到全站，见 E。
                const _SectionTitle(configKeySection),
                const SizedBox(height: d.gapS + 2),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(d.gapM),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (localOnly) ...[
                          // 🔴 **本机那一份：说实话、不给假输入框**（见 `configLocalOnly` 那段）
                          Text(configLocalOnly, style: t.textTheme.bodyMedium?.copyWith(color: d.ink)),
                        ] else ...[
                          // ★ **现状**：三种状态分开说（见 `keyStateLine` 那段）。
                          Text(
                            keyStateLine(hasKey: hasKey, keyBad: keyBad),
                            style: t.textTheme.bodyMedium?.copyWith(color: d.ink),
                          ),
                          if (hasKey) ...[
                            const SizedBox(height: 4),
                            Text(
                              configKeyHint,
                              style: t.textTheme.bodySmall?.copyWith(color: d.muted),
                            ),
                          ],
                          const SizedBox(height: d.gapM),
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
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: d.gapL),
                // ── 第二个分区：**这个助手**（关于 / 退出登录）──
                // ★ 2026-09-23：原来这两条**光秃秃挂在最下面**（一页三块读不出结构）
                //   ⇒ 加分区标题，并把两条收进**同一张卡**（中间一条分隔线）。
                const _SectionTitle(settingsAboutSection),
                const SizedBox(height: d.gapS + 2),
                Card(
                  child: Column(
                    children: [
                      // ⚠️ **关于搬进来了**（见 `space_words.dart` 那段）：
                      //    顶栏再加一个图标就是 7 个 —— 手机上那一条会挤成一团。
                      ListTile(
                        leading: const Icon(Icons.info_outline),
                        title: const Text('关于'),
                        // ★ 加一句小字：光"关于"两个字，读不出这一页管什么
                        subtitle: Text(
                          aboutEntryHint,
                          style: t.textTheme.bodySmall?.copyWith(color: d.muted),
                        ),
                        trailing: const Icon(Icons.chevron_right),
                        onTap: () => Navigator.of(context).push(
                          MaterialPageRoute<void>(builder: (_) => const AboutScreen()),
                        ),
                      ),
                      // ── **退出登录**（主人 2026-09-22：设置里管"退出登录 / 注销账号 / 改钥匙"）──
                      // ⚠️ 它原来挂在**聊天抓手行**上 —— 那一行是"聊天"的地方，退出登录不是聊天的事。
                      if (onLogout != null) ...[
                        Divider(height: 1, color: d.line),
                        ListTile(
                          leading: Icon(Icons.logout, color: d.accent),
                          title: Text(
                            settingsLogout,
                            style: t.textTheme.bodyLarge?.copyWith(color: d.ink),
                          ),
                          onTap: onLogout,
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
  }
}
