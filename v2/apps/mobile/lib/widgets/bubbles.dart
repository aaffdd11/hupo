// 气泡。手册 `08-SPEC.md` §6（界面铁律）、`05-DECISIONS.md` §3.1（四态）。
//
// 一条硬规矩：**不许写死尺寸**。容器跟着字算，跟在系统字号后面。
// 走查里最实在的一条故障是"字大了、笼子没大"——1.75 倍就溢出。
//
// 另一条：**四态必须一眼可辨，而且不能只靠颜色**。
// 色盲、屏幕反光、平板在阳台上——颜色是最不可靠的那个通道。
// ⇒ 每态都配一个**图标 + 文字**。

import 'package:flutter/material.dart';

import '../models/image_links.dart';
import '../models/space_words.dart';
import '../models/design.dart' as d;
import '../models/message_state.dart';
import '../models/notice_words.dart';
import '../models/source_words.dart';
import '../models/speak_words.dart';
import '../models/timeline.dart';

/// 四态的视觉。**图标 + 文字**双通道，不靠颜色单独承载信息。
({IconData icon, String label}) _stateMark(MessageState s) => switch (s) {
      MessageState.queued => (icon: Icons.schedule, label: '已交出去'),
      MessageState.sent => (icon: Icons.check, label: '已送到'),
      MessageState.confirmed => (icon: Icons.done_all, label: '已收到'),
      MessageState.failed => (icon: Icons.error_outline, label: '没发出去'),
    };

class UserBubble extends StatelessWidget {
  const UserBubble({super.key, required this.utterance, this.onResend, this.onLongPress});

  final UserUtterance utterance;
  final VoidCallback? onResend;

  /// 长按气泡（契约 `28-DELETE.md` §二 第 2 条：删除的入口就在这儿）。
  ///
  /// ⚠️ 用 `InkWell` 而不是裸的 `GestureDetector`：`test/widget/accessibility_test.dart`
  ///    有一条源码级断言**禁止 `lib/` 里出现裸的 GestureDetector**（真加了就得把它
  ///    加进命中区扫描）。`InkWell` 里的手势由 Material 撑着，且命中区就是气泡本身。
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final failed = utterance.state == MessageState.failed;
    final mark = _stateMark(utterance.state);

    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 520),
        margin: const EdgeInsets.symmetric(vertical: 4),
        // ⚠️ 气泡本体改成 `Material` + `InkWell`（为了长按），
        //    底色 / 圆角 / 失败时那圈边**照旧**：
        //    四态必须一眼可辨，而且不许只靠颜色（下面还是图标 + 文字）。
        child: Material(
          color: failed ? theme.colorScheme.errorContainer : theme.colorScheme.primaryContainer,
          clipBehavior: Clip.antiAlias,
          shape: RoundedRectangleBorder(
            // ★ 2026-09-23（E）：14 是写死的 —— 气泡用 `radiusField` 那一档
            borderRadius: BorderRadius.circular(d.radiusField),
            side: failed
                ? BorderSide(color: theme.colorScheme.error, width: 1.5)
                : BorderSide.none,
          ),
          child: InkWell(
            onLongPress: onLongPress,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(utterance.text, style: theme.textTheme.bodyLarge),
                  const SizedBox(height: 4),
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(mark.icon, size: theme.textTheme.bodySmall!.fontSize! + 4),
                      const SizedBox(width: 4),
                      Text(mark.label, style: theme.textTheme.bodySmall),
                      if (failed && onResend != null) ...[
                        const SizedBox(width: 12),
                        // 触控目标 ≥44：视觉上是个小按钮，用 padding 把命中区撑起来
                        TextButton(
                          onPressed: onResend,
                          style: TextButton.styleFrom(
                            minimumSize: const Size(44, 44),
                            padding: const EdgeInsets.symmetric(horizontal: 8),
                            tapTargetSize: MaterialTapTargetSize.padded,
                          ),
                          child: const Text('重发'),
                        ),
                      ],
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 助手说的一条。快答与深答**在同一个气泡里**（协议 R2）。
class AnswerBubble extends StatelessWidget {
  const AnswerBubble({
    super.key,
    required this.message,
    this.onLongPress,
    this.onOpenSource,
    this.onSpeak,
    this.onStopSpeak,
    this.speaking = false,
  });

  final AssistantMessage message;

  /// 长按气泡（同 [UserBubble.onLongPress]）。
  final VoidCallback? onLongPress;

  /// **出处那一行能不能点开**（契约 `docs/dev/67-SOURCES.md`）。
  ///
  /// ⚠️ `null` = 这个平台开不了外面的地址（见 `services/links.dart`）⇒
  ///    出处**只当文字显示**，**不画一个按不动的按钮**
  ///    （界面上不许出现做不到的东西 —— `AGENTS.md` §六 第 4 条那一族）。
  final void Function(String url)? onOpenSource;

  /// **把这一条念出来**（`null` = 这个平台念不了 ⇒ 不画那个按钮）。
  ///
  /// ⚠️ 与出处那条同一条规矩：**界面上不许出现按不动的东西**。
  final VoidCallback? onSpeak;

  /// 正在念这一条时，同一个按钮变成"别念了"。
  final VoidCallback? onStopSpeak;

  /// **这一条正在被念**（按钮的字与图标跟着变）。
  final bool speaking;

  /// **出处那几行**（「它替你查过的东西是哪来的」）。
  ///
  /// 三条规矩（契约 `67-SOURCES.md`）：
  ///   ① 有标题用标题、没有用域名 —— 那个名字**由服务端算好**（`sources.js` 的 `sourceLabel`），
  ///      这里只负责画（同一件事两处口径 ⇒ 迟早会漂）。
  ///   ② 能点开的时候**命中区 ≥44**（D3.6），图标大小跟字算（不写死尺寸）。
  ///   ③ 画不下就**如实报数**，不许静默少画。
  /// **画好的图**（P1-27 后半 · 主人 2026-09-24："图片需要打通"）。
  ///
  /// ⚠️ 认得出**才**画（`imageUrlsIn` 是纯函数，判据钉着）——
  ///    认不出就一个字都不动（把普通网址当图片去取 = 屏幕上多一块空白）。
  /// ⚠️ 取不到图 ⇒ **说一句实话**（地址是临时的那种），不留一块空白让人猜。
  List<Widget> _imageRows(ThemeData theme, String text) {
    final urls = imageUrlsIn(text);
    if (urls.isEmpty) return const [];
    return [
      for (final url in urls) ...[
        const SizedBox(height: d.gapS),
        ClipRRect(
          borderRadius: BorderRadius.circular(d.radiusField),
          child: Image.network(
            url,
            fit: BoxFit.contain,
            errorBuilder: (_, __, ___) => Text(
              imageGoneWords,
              style: theme.textTheme.bodySmall,
            ),
            loadingBuilder: (_, child, progress) => progress == null
                ? child
                : Padding(
                    padding: const EdgeInsets.symmetric(vertical: d.gapXs),
                    child: Text(imageLoadingWords, style: theme.textTheme.bodySmall),
                  ),
          ),
        ),
        const SizedBox(height: d.gapXs),
        Text(imageTempWords, style: theme.textTheme.bodySmall),
      ],
    ];
  }

  List<Widget> _sourceRows(ThemeData theme) {
    final shown = message.sources.take(sourcesShown).toList();
    final extra = message.sources.length - shown.length;
    final markSize = (theme.textTheme.bodySmall?.fontSize ?? 12) + 4;
    final rows = <Widget>[];
    for (final s in shown) {
      final url = '${s['url'] ?? ''}'.trim();
      // 服务端已经给好"给人看的名字"；万一它没给，就用地址兜底（不许出现空行）
      final label = '${s['title'] ?? ''}'.trim().isEmpty ? url : '${s['title']}'.trim();
      if (url.isEmpty || label.isEmpty) continue;
      rows.add(
        onOpenSource == null
            ? Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Text('· $label', style: theme.textTheme.bodySmall),
              )
            : TextButton.icon(
                onPressed: () => onOpenSource!(url),
                icon: Icon(Icons.open_in_new, size: markSize),
                label: Text(label, style: theme.textTheme.bodySmall),
                style: TextButton.styleFrom(
                  // D3.6：命中区 ≥44（视觉可以小，手指要够得着）
                  minimumSize: const Size(0, 44),
                  padding: const EdgeInsets.symmetric(horizontal: 6),
                  alignment: Alignment.centerLeft,
                ),
              ),
      );
    }
    if (extra > 0) {
      rows.add(
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Text(sourcesMoreWords(extra), style: theme.textTheme.bodySmall),
        ),
      );
    }
    return rows;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final text = message.displayText;

    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        // 限宽：太宽的长行没人读得下去（平板上一行 70 个字）
        constraints: const BoxConstraints(maxWidth: 760),
        margin: const EdgeInsets.symmetric(vertical: 4),
        child: Material(
          color: theme.colorScheme.surfaceContainerHighest,
          clipBehavior: Clip.antiAlias,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(d.radiusField),
          ),
          child: InkWell(
            onLongPress: onLongPress,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (text.isEmpty)
                    // 一句话都还没有：不要留一个空气泡，给一个"在处理"的轻标记
                    Text('在处理…', style: theme.textTheme.bodySmall)
                  else ...[
                    // ⚠️ **画出来的图那一行地址不重复显示**（图就在下面）——
                    //    但**只有整行都是地址**时才去掉（句子里的地址留着）
                    Text(textWithoutImageLines(text), style: theme.textTheme.bodyLarge),
                    // ★ **画好的图**（P1-27 后半）：回话里带着图片地址 ⇒ **画在聊天里**
                    ..._imageRows(theme, text),
                  ],
                  if (message.sources.isNotEmpty) ...[
                    const SizedBox(height: 10),
                    Text(sourcesHeadWords, style: theme.textTheme.bodySmall),
                    const SizedBox(height: 2),
                    ..._sourceRows(theme),
                  ],
                  // ★ **读一遍**（主人 2026-09-23 定案：每条都能念）
                  //
                  // ⚠️ 位置：**答案正文与出处之后**（它们是这一条的"内容"，
                  //    这个按钮是"怎么用这一条"）。
                  // ⚠️ 说完了才画：半句 / "没说完"的话念出来是**替它把话说圆**，
                  //    那是假话（D5.15 那一族：认识不到就说人话，不许拿猜的顶上）。
                  if (onSpeak != null && message.ended && message.reason == 'completed') ...[
                    const SizedBox(height: 2),
                    TextButton.icon(
                      onPressed: speaking ? (onStopSpeak ?? onSpeak) : onSpeak,
                      icon: Icon(
                        speaking ? Icons.stop_circle_outlined : Icons.volume_up_outlined,
                        // ★ 2026-09-23：字号跟着标签那一档走（原来按 bodySmall 算，偏小）
                        size: (theme.textTheme.labelLarge?.fontSize ?? 14) + 4,
                      ),
                      label: Text(
                        speaking ? speakStopWords : speakOnceWords,
                        // ★ 2026-09-23：`bodySmall`(≈12) → `labelLarge`(≈14) + 淡色
                        //   （原来又小又淡，主人这一批"整理 UI"里点过它）
                        style: theme.textTheme.labelLarge?.copyWith(color: d.muted),
                      ),
                      style: TextButton.styleFrom(
                        // D3.6：命中区 ≥44
                        minimumSize: const Size(0, 44),
                        padding: const EdgeInsets.symmetric(horizontal: 6),
                        alignment: Alignment.centerLeft,
                      ),
                    ),
                  ],
                  if (message.ended && message.reason != null && message.reason != 'completed')
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text('（这条没说完）', style: theme.textTheme.bodySmall),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 系统说话。**与聊天气泡是两条不同的通道**（手册 R3）。
///
/// 为什么要分开：系统替用户做的决定（建了个东西、一件事做完了、删去哪了）
/// **不是对话**。混进气泡里，用户会以为"它在跟我唠嗑"。
///
/// ⚠️ 批 3 起，"系统通知"那一条的正式形态是 `widgets/notice.dart`
///    的 `NoticeLine` / `NoticeOverlay`（契约 `29-NOTICE.md`）——
///    它们要带撤销、要分浮窗与时间线两份。这一条留着是因为它是一个有用的
///    通用形状，但**通知那条路不许用它**（否则"两处撤销"就没有共同实现）。
class SystemNotice extends StatelessWidget {
  const SystemNotice({super.key, required this.text, this.label, this.onUndo});

  final String text;
  final VoidCallback? onUndo;

  /// 撤销按钮上的字（服务端给的那份，见 `NoticeUndo.label`）。
  final String? label;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Icon(Icons.info_outline, size: theme.textTheme.bodySmall!.fontSize! + 4),
          const SizedBox(width: 8),
          Expanded(child: Text(text, style: theme.textTheme.bodySmall)),
          if (onUndo != null)
            TextButton(
              onPressed: onUndo,
              style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
              child: Text(label ?? noticeUndoLabel),
            ),
        ],
      ),
    );
  }
}

/// 时间线上的一条分隔（"你不在的时候"）。**它占一个位置，但不是消息。**
class MarkerLine extends StatelessWidget {
  const MarkerLine({super.key, required this.marker});

  final TimelineMarker marker;

  @override
  Widget build(BuildContext context) {
    final label = switch (marker.kind) {
      'away' => marker.label ?? '你不在的时候',
      'enter' => '进入「${marker.label ?? ''}」',
      'leave' => '离开「${marker.label ?? ''}」',
      _ => marker.label ?? '',
    };
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        children: [
          const Expanded(child: Divider()),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10),
            child: Text(label, style: theme.textTheme.bodySmall),
          ),
          const Expanded(child: Divider()),
        ],
      ),
    );
  }
}

/// 「它正在做这件事…」——**一轮开着、但屏幕上还什么都没出现**的那段空白。
///
/// 为什么值得有它：走查里 8/10 的放弃点落在"**它到底收到没有**"。
/// 用户说完一句话，在它出第一个字之前，屏幕上唯一的变化是自己那条气泡
/// 从"已交出去"变成"已收到"——然后就**什么都没了**。
/// 这一行就是补那段空白的。
///
/// ⚠️ **不许用无限动画**（转圈 / 呼吸灯）。
///    本项目实测过一次：转圈动画 + 并发跑多个界面测试 ⇒ **互相饿死 CPU，
///    跑到 17 分钟还没结束**。静态一行字就够，而且更省电。
///
/// ⚠️ 它**不是**气泡：不占号、不落盘、刷新就没了（决策 P-g）。
class BusyLine extends StatelessWidget {
  const BusyLine({super.key, required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 4),
      child: Row(
        children: [
          Icon(Icons.more_horiz, size: theme.textTheme.bodySmall?.fontSize, color: theme.hintColor),
          const SizedBox(width: 6),
          // 跟着系统字号走（**不写死尺寸**，手册 D3）
          Flexible(child: Text(text, style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor))),
        ],
      ),
    );
  }
}
