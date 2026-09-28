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
//   ② ⚠️ **不许假装**：安卓那个入口**今天真能下载了**（2026-09-28）⇒ 点它就把 `/hupo.apk`
//      交出去；苹果与"还没上线"那两格照旧**如实标着**。点了没开成 ⇒ **说清怎么办**
//      （不转圈、不"正在准备"—— 那条纪律一个字没松）。
//   ③ ⚠️ 不写死尺寸（D3.5）：字号全部来自 `theme.textTheme`，容器跟着字走；
//      整页是 `ListView`（能滚）⇒ 五档字体下**不溢出**（`accessibility_test.dart` 硬闸）。
//      命中区 ≥44（D3.6）。
//
// ⚠️ 文案全在 `models/landing_words.dart`（那样才进得了禁用词硬闸）。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/server_address.dart';
import '../services/links.dart';
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
  const LandingScreen({super.key, required this.onStart, this.onDownload});

  /// 点"开始用"之后干什么（上层决定：进登录页）。
  final VoidCallback onStart;

  /// 点「下载安卓版」时**把那条绝对地址交出去**（返回"真开了没有"）。
  ///
  /// ⚠️ 不传就用真的那一份（`services/links.dart` 的 `openExternal`）。
  /// 🔴 判据**必须能注入**：VM 上 `canOpenLinks` 恒假（那一份是桩），
  ///    不注入的话"网页上点它真的把包下下来"这件事在判据里量不到。
  final bool Function(String url)? onDownload;

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
        // 🔴 **顶上那条让给状态栏**（2026-09-28 主人在安卓真机上报的：*"我看到它顶部跟时间、
        //   WiFi 信号重叠了"*）：安卓是 **edge-to-edge**（`targetSdk` 已经到 36 ⇒ 系统强制），
        //   而这一屏原来直接从窗口最上面开始排 ⇒ 标志与标题压在**时钟、信号**底下。
        //   ⚠️ 网页上那条内边距是 0（含手机浏览器）⇒ **一个像素都不变** —— 这正是 `SafeArea` 的用法。
        body: SafeArea(
          child: Center(
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
                // ── 它能替你做什么（记 / 办 / 实 / 回）──
                //   ⚠️ 小标题本身就是那句话：**扫一眼就知道这一块讲什么**（主人 2026-09-22：
                //     "重新规划设计首页内容，能让用户看明白"）。
                _sectionTitle(theme, landingCanTitle),
                const SizedBox(height: 12),
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
                const SizedBox(height: 22),
                // ── **你的东西是你自己的**（主人 2026-09-22："不够全面" ⇒ 补上这一块）──
                //   它回答的是**担心**，不是能力 —— 所以单独一块、单独一个标题。
                _sectionTitle(theme, landingYoursTitle),
                const SizedBox(height: 12),
                for (final (title, body) in landingYours)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: _cardBox(
                      theme,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(title, style: theme.textTheme.titleSmall),
                          const SizedBox(height: 4),
                          Text(
                            body,
                            style: theme.textTheme.bodyMedium?.copyWith(color: _muted),
                          ),
                        ],
                      ),
                    ),
                  ),
                const SizedBox(height: 16),
                // ── 对照块：跟"光是聊天"差在哪（契约 `docs/dev/51-VS-CHAT.md`）──
                //   ⚠️ 两行**竖着排**（不是左右两列）：字号放到 3.1 倍时，
                //      两列会被挤成一条细缝 —— 竖排永远不会横向溢出（D3.5）。
                _sectionTitle(theme, landingDiffTitle),
                const SizedBox(height: 12),
                for (final (left, right) in landingDiff)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: _cardBox(
                      theme,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            '$landingDiffLeft：$left',
                            style: theme.textTheme.bodySmall?.copyWith(color: _muted),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            '$landingDiffRight：$right',
                            style: theme.textTheme.titleSmall,
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
            onPressed: () => _download(context),
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

  /// 点「下载安卓版」：**真的把那个包装下来**（2026-09-28 起它不再是"还没上线"）。
  ///
  /// 三条边界：
  ///   · 交出去的必须是**绝对地址**（`openExternal` 只认 http(s)；相对路径它当场回 false）；
  ///   · 站在**安卓包里**点它 ⇒ 如实说"你正在用的就是这个安卓版"（不装出"正在下载"）；
  ///   · 没开成 ⇒ 说清怎么办（**绝不**转圈说"正在准备"）。
  void _download(BuildContext context) {
    final messenger = ScaffoldMessenger.of(context);
    final open = onDownload;
    if (open == null && !canOpenLinks) {
      messenger.showSnackBar(const SnackBar(content: Text(landingAndroidOnIt)));
      return;
    }
    final url = apkDownloadUri(base: hupoApiBase, page: Uri.base).toString();
    final ok = (open ?? openExternal)(url);
    messenger.showSnackBar(
      SnackBar(content: Text(ok ? landingAndroidStarted : landingAndroidCantHere)),
    );
  }
}
