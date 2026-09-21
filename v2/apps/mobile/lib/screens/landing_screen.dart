// Landing：**未登录时的第一屏**（主人 2026-09-21 点名要的东西）。
//
// ── 版式参考（主人点名）────────────────────────────────────
// **gengshu.me**：暖米色底 + **一个**暖红强调色 + 药丸按钮 + 柔和卡片 +
// 居中小标题（kicker）+ 手机示意图。这一屏照那套语言来。
//
// ── 三件不只为了好看的事 ──────────────────────────────────
//   ① ⚠️ **主入口必须第一眼就看得见**：2026-09-21 无障碍硬闸抓过一次 ——
//      原来"三句支撑"排在按钮前面，字体放到 **3.1 倍**时两个按钮被挤出屏幕，
//      闸的话是「**一个能点的都没扫到**」。⇒ 现在按钮紧跟标题，细节一律往后放。
//   ② ⚠️ **不许假装**：三个平台入口今天都没有安装包 ⇒ 卡上**直接写着"还没上线"**，
//      点了也**只说这一句**（不转圈、不"正在准备"）。
//   ③ ⚠️ 不写死尺寸（D3.5）：字号全部来自 `theme.textTheme`，容器跟着字走；
//      整页是 `ListView`（能滚）⇒ 五档字体下**不溢出**（`accessibility_test.dart` 硬闸）。
//      命中区 ≥44（D3.6）。
//
// ⚠️ 文案全在 `models/landing_words.dart`（那样才进得了禁用词硬闸）。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../widgets/page_header.dart';

import '../models/landing_words.dart';

/// 这一屏自己的暖色（参考站那套：米底 + 暖红）。
/// ⚠️ **只包这一屏**，不动全局主题 —— 免得把聊天那几屏的颜色一起改了。
// ⚠️ 这套颜色**搬去 `models/design.dart` 了**（契约 `docs/dev/49-STYLE.md`）——
//    首页原来是它的事实源头，但**写在自己文件里** ⇒ 别的屏只能各抄一份。
//    现在**全站一处出处**，这里只留几个短名字指过去（读起来仍然顺）。
const Color _paper = d.paper;
const Color _accent = d.accent;
const Color _ink = d.ink;
const Color _muted = d.muted;
const Color _card = d.card;
const Color _line = d.line;

class LandingScreen extends StatelessWidget {
  const LandingScreen({super.key, required this.onStart});

  /// 点"开始用"之后干什么（上层决定：进登录页）。
  final VoidCallback onStart;

  @override
  Widget build(BuildContext context) {
    final base = Theme.of(context);
    // 这一屏用暖色；字号仍走**全局**那套 textTheme（不写死字号，D3.5）
    final theme = base.copyWith(
      colorScheme: base.colorScheme.copyWith(
        primary: _accent,
        onPrimary: Colors.white,
        surface: _paper,
        onSurface: _ink,
        outline: _line,
      ),
    );
    return Theme(
      data: theme,
      child: Scaffold(
        backgroundColor: _paper,
        body: Center(
          child: ConstrainedBox(
            // 内容列限宽（参考站也是一条窄列）
            constraints: const BoxConstraints(maxWidth: 640),
            // ⚠️ `ListView` 不是 `Column`：字体放到最大时**能滚**，而不是溢出
            child: ListView(
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 28),
              children: [
                // ── **header（与登录页共用一份）**（契约 `49-STYLE.md`）──
                //   ⚠️ 它里面就是"标志 + 红小标 + 大标题"；登录页那份只多一个返回箭头。
                const LandingHeader(),
                const SizedBox(height: 20),
                _ctaRow(context, theme),
                const SizedBox(height: 14),
                Text(
                  landingStartHint,
                  style: theme.textTheme.bodyMedium?.copyWith(color: _muted),
                ),
                const SizedBox(height: 18),
                Text(
                  landingLead,
                  style: theme.textTheme.bodyLarge?.copyWith(color: _muted, height: 1.6),
                ),
                const SizedBox(height: 22),
                _phone(),
                const SizedBox(height: 26),
                // ── 三张卡（记 / 办 / 实）──
                for (final (mark, title, body) in landingCards)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: _cardBox(
                      theme,
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          _mark(theme, mark),
                          const SizedBox(width: 14),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(title, style: theme.textTheme.titleMedium),
                                const SizedBox(height: 4),
                                Text(
                                  body,
                                  style: theme.textTheme.bodyMedium?.copyWith(color: _muted),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                const SizedBox(height: 16),
                _sectionTitle(theme, landingDownloadTitle),
                const SizedBox(height: 12),
                for (final (name, state, hint) in landingPlatforms)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: _cardBox(
                      theme,
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(name, style: theme.textTheme.titleMedium),
                                const SizedBox(height: 2),
                                Text(
                                  hint,
                                  style: theme.textTheme.bodySmall?.copyWith(color: _muted),
                                ),
                              ],
                            ),
                          ),
                          // ⚠️ **如实**：今天一个安装包都没有
                          Text(
                            state,
                            style: theme.textTheme.labelLarge?.copyWith(color: _muted),
                          ),
                        ],
                      ),
                    ),
                  ),
                const SizedBox(height: 20),
                _sectionTitle(theme, landingFaqTitle),
                const SizedBox(height: 12),
                for (final (q, a) in landingFaq)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(q, style: theme.textTheme.titleSmall),
                        const SizedBox(height: 4),
                        Text(
                          a,
                          style: theme.textTheme.bodyMedium?.copyWith(color: _muted, height: 1.6),
                        ),
                      ],
                    ),
                  ),
                const Divider(color: _line),
                const SizedBox(height: 10),
                Text(
                  landingFootNote,
                  style: theme.textTheme.bodySmall?.copyWith(color: _muted),
                ),
                const SizedBox(height: 8),
                Text(
                  '© 2026 $landingBrand',
                  style: theme.textTheme.bodySmall?.copyWith(color: _muted),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// 顶栏：一个暖红色的方块标记 + 品牌名。
  /// 两个入口：实心药丸 + 描边药丸。
  /// ⚠️ **`Wrap` 不是 `Row`**：最大字号下要能折到第二行，否则就是一条溢出。
  Widget _ctaRow(BuildContext context, ThemeData theme) => Wrap(
        spacing: 12,
        runSpacing: 12,
        children: [
          FilledButton(
            onPressed: onStart,
            style: FilledButton.styleFrom(
              minimumSize: const Size(48, 52),
              backgroundColor: _accent,
              foregroundColor: Colors.white,
              shape: const StadiumBorder(),
              padding: const EdgeInsets.symmetric(horizontal: 28),
            ),
            child: const Text(landingStart),
          ),
          OutlinedButton(
            onPressed: () => _notYet(context),
            style: OutlinedButton.styleFrom(
              minimumSize: const Size(48, 52),
              foregroundColor: _ink,
              side: const BorderSide(color: _line),
              shape: const StadiumBorder(),
              padding: const EdgeInsets.symmetric(horizontal: 24),
            ),
            child: const Text(landingDownload),
          ),
        ],
      );

  /// 手机示意图（参考站 hero 右边那个）。
  /// ⚠️ 画的是一个**外壳**，里面是几行示意，不是真截图 —— 免得像在假装有产品。
  Widget _phone() => Center(
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: _card,
            borderRadius: BorderRadius.circular(26),
            border: Border.all(color: _line),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 54,
                height: 5,
                decoration: BoxDecoration(color: _line, borderRadius: BorderRadius.circular(3)),
              ),
              const SizedBox(height: 14),
              for (final w in const [0.85, 0.6, 0.72]) _bubble(w),
              const SizedBox(height: 4),
              for (final w in const [0.7, 0.45]) _bubble(w, mine: true),
            ],
          ),
        ),
      );

  Widget _bubble(double widthFactor, {bool mine = false}) => FractionallySizedBox(
        alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
        widthFactor: widthFactor,
        child: Container(
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            color: mine ? _accent.withValues(alpha: 0.12) : _paper,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: _line),
          ),
          child: Container(height: 8, decoration: BoxDecoration(color: _line, borderRadius: BorderRadius.circular(4))),
        ),
      );

  Widget _cardBox(ThemeData theme, {required Widget child}) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
        decoration: BoxDecoration(
          color: _card,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: _line),
        ),
        child: child,
      );

  Widget _mark(ThemeData theme, String ch) => Container(
        width: 34,
        height: 34,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: _accent.withValues(alpha: 0.10),
          borderRadius: BorderRadius.circular(11),
        ),
        child: Text(ch, style: theme.textTheme.titleMedium?.copyWith(color: _accent)),
      );

  Widget _sectionTitle(ThemeData theme, String text) => Text(
        text,
        style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w600),
      );

  /// ⚠️ **如实说**：现在没有安装包。**不许假装开始下载**（不转圈、不"正在准备"）。
  void _notYet(BuildContext context) {
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text(landingAndroidNotYet)));
  }
}
