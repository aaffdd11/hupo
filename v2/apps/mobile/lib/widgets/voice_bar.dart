// **聊天底下那一格：一个圆圈 ＋ 它左边那句字**（乙期 · 手册 `D3.14`／`D5.19`）。
//
// 主人 2026-10-04：*「聊天按钮直接只剩右下角一个圆圈。点击以后开始录音，录音会转文字，
//   文字会出现在底部，录音按钮的左侧。系统如果询问这句话什么意思，用户回答，会修正用户前面
//   说的那句话，一旦没有语义问题，就会被发出去。」*
//
// ── 这一格只画三样 ────────────────────────────────────────
//   ① **一个圆圈**（右下角）：点一下开始录、再点一下停（`onMic`）；
//   ② **它左边那句字**：正在听的那半句 / 它在问的那一句 / 如实说的那一句；
//   ③ **开不了麦时**那条打字的退路（`D3.14` 的注：不许让他没有路可走）。
//
// ⚠️ 状态在 `models/hear_drill.dart`（那台状态机就是设置里那场演练那台）——
//    这一份**只负责画**：进来一个状态、出去两个回调。
// ⚠️ 它是 widget ⇒ 只许 import models（楼层闸）：所以拿的是 `flow` ＋ 回调，**不是控制器**。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/hear_drill.dart';
import '../models/hear_words.dart';

/// 底下那一格。
class VoiceBar extends StatefulWidget {
  const VoiceBar({
    super.key,
    required this.flow,
    required this.canHear,
    required this.onMic,
    required this.onTyped,
    this.leading,
    this.hintAbove,
    this.speakable = false,
  });

  /// 这一场说到哪儿了（听着 / 在懂 / 在问 / 没听清…）。
  final HearDrill flow;

  /// 这台开得了麦吗（开不了 ⇒ 画打字的退路，**不画那颗圆圈**）。
  final bool canHear;

  /// 那颗圆圈：按一下开始录、再按一下停。
  final VoidCallback onMic;

  /// 打字那条兜底路（他按了「就这句」）。
  final ValueChanged<String> onTyped;

  /// 那一行最前面那颗（今天还是那颗 home —— 它搬到每个 app 右上角之前，
  /// **出口不能没有**）。
  final Widget? leading;

  /// 那颗圆圈上方偶尔飘一句（进屏提示那一类；不占排版）。
  final Widget? hintAbove;

  /// 这台念不念得出来（念不出来时，屏幕上如实说一句）。
  final bool speakable;

  @override
  State<VoiceBar> createState() => _VoiceBarState();
}

class _VoiceBarState extends State<VoiceBar> {
  final _type = TextEditingController();

  @override
  void dispose() {
    _type.dispose();
    super.dispose();
  }

  bool get _listening => widget.flow.hearing.listening;

  /// **打字那条退路**要不要摊开（默认不摊 —— 空白时屏幕上一个字都不许有）。
  bool _typing = false;

  /// 圆圈左边那句话（**一句**：现在该让他看见什么）。
  ({String text, bool loud}) get _line {
    final f = widget.flow;
    switch (f.phase) {
      case DrillPhase.listening:
        final said = f.said.trim();
        return (text: said.isEmpty ? hearDrillListeningLead : said, loud: true);
      case DrillPhase.thinking:
        final said = f.said.trim();
        return (text: said.isEmpty ? hearDrillThinkingLead : said, loud: true);
      case DrillPhase.asking:
        // ⚠️ 问句后面**带上"怎么答"**：只摆一个问句，他就不知道下一步干什么
        //   （主人 2026-10-04：*"出现了一个问句，然后就没有然后"*）。
        return (
          text: (f.question.isEmpty ? hearDrillAskingLead : f.question) + hearDrillAnswerHint,
          loud: true,
        );
      case DrillPhase.failed:
        return (text: f.note.isEmpty ? hearDrillFailedLead : f.note, loud: true);
      case DrillPhase.ready:
      case DrillPhase.idle:
        return (text: '', loud: false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final line = _line;
    // ★ **2026-10-04 主人**：*"如果是空的，小 bubble 自己就消失了。"*
    //   ⇒ 什么都没有的时候**一个像素都不画**（不摆提示、不摆空框）：
    //     · 有字 ⇒ 一颗**从右边长出来**的气泡（下面 `_bubble`）；
    //     · 空 ⇒ 只剩那颗圆圈；
    //     · 开不了麦 ⇒ 圆圈那个位置换成一颗「打字」，**按一下才摊开那一格**
    //       （不按就什么都不摆 —— 这就是他看见"空对话上挂着一句开不了麦"的那一处）。
    final typed = _typing || (!widget.canHear && widget.flow.phase != DrillPhase.idle);
    return Padding(
      padding: const EdgeInsets.fromLTRB(d.gapM, d.gapS, d.gapM, d.gapS),
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              if (widget.leading != null) ...[widget.leading!, const SizedBox(width: d.gapS)],
              // ── 字那一侧（在圆圈的**左边**）──
              Expanded(
                child: typed
                    ? _typedField(t)
                    : Align(
                        alignment: Alignment.centerRight,
                        // 空 ⇒ **什么都不画**（气泡自己消失）
                        child: line.text.trim().isEmpty ? const SizedBox.shrink() : _bubble(t, line),
                      ),
              ),
              const SizedBox(width: d.gapS),
              // ── 那个圆圈（右下角）──
              if (widget.canHear)
                _circle(t)
              else if (!_typing)
                _typeChip(t),
            ],
          ),
          if (widget.hintAbove != null)
            Positioned(left: 0, right: 0, bottom: d.barButtonBox, child: widget.hintAbove!),
        ],
      ),
    );
  }

  /// 那颗圆圈：**全局最显眼的一颗**（它服务的是打不了字、眼神不好的人）。
  Widget _circle(ThemeData t) => Semantics(
        button: true,
        label: _listening ? hearDrillStopLabel : hearDrillTalkLabel,
        child: SizedBox(
          key: voiceBarCircleKey,
          width: d.voiceCircleBox,
          height: d.voiceCircleBox,
          child: Material(
            color: _listening ? d.accent : d.card,
            shape: const CircleBorder(),
            child: InkWell(
              customBorder: const CircleBorder(),
              onTap: widget.onMic,
              child: Icon(
                _listening ? Icons.stop_rounded : Icons.mic_none_rounded,
                size: d.voiceCircleIcon,
                color: _listening ? d.card : d.ink,
              ),
            ),
          ),
        ),
      );

  /// **他说的话那一颗气泡**：从右边长出来，长满一行就换行（主人 2026-10-04）。
  ///
  /// ⚠️ 宽度是**跟着字长**的（`Flexible` ＋ 右对齐），最多占那一行的 76%；
  ///    超过就换行（`maxLines: 4` 兜底，真长到 4 行也该发出去了）。
  Widget _bubble(ThemeData t, ({String text, bool loud}) line) => Container(
        constraints: const BoxConstraints(maxWidth: 420),
        padding: const EdgeInsets.symmetric(horizontal: d.gapM, vertical: d.gapS),
        decoration: BoxDecoration(
          color: d.card,
          borderRadius: BorderRadius.circular(d.radiusField),
          border: Border.all(color: d.line),
        ),
        child: Text(
          line.text,
          textAlign: TextAlign.right,
          maxLines: 4,
          overflow: TextOverflow.ellipsis,
          style: t.textTheme.bodyLarge?.copyWith(color: line.loud ? d.ink : d.muted),
        ),
      );

  /// **开不了麦**时，圆圈那个位置那颗「打字」（按一下才摊开输入格）。
  Widget _typeChip(ThemeData t) => TextButton(
        key: voiceBarTypeChipKey,
        onPressed: () => setState(() => _typing = true),
        child: const Text('打字'),
      );

  /// 打字那条退路（**按了那颗「打字」**才有）。
  Widget _typedField(ThemeData t) => Row(
        children: [
          Expanded(
            child: TextField(
              key: voiceBarTypeKey,
              controller: _type,
              decoration: const InputDecoration(hintText: hearDrillTypeInstead),
              onSubmitted: (v) {
                widget.onTyped(v);
                _type.clear();
              },
            ),
          ),
          const SizedBox(width: d.gapS),
          FilledButton(
            key: voiceBarTypedSendKey,
            onPressed: () {
              widget.onTyped(_type.text);
              _type.clear();
            },
            child: const Text(hearDrillAnswer),
          ),
        ],
      );
}

/// 那个圆圈（判据要按它）。
const Key voiceBarCircleKey = ValueKey<String>('voice-bar-circle');

/// 打字那条退路（开不了麦时才画）。
const Key voiceBarTypeKey = ValueKey<String>('voice-bar-type');
const Key voiceBarTypedSendKey = ValueKey<String>('voice-bar-typed-send');

/// 开不了麦时那颗「打字」（按一下才摊开输入格）。
const Key voiceBarTypeChipKey = ValueKey<String>('voice-bar-type-chip');
