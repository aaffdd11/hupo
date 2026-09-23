// 输入条。手册 `08-SPEC.md` §6.5、`05-DECISIONS.md` D5.14。
//
// ⚠️ **这一条是从探针那一步学来的，很重要**：
//
//   探针里我**每敲一个字就 `setState` 重建整个页面**（包括输入框）。
//   那是 Flutter 里一个**已知会把输入法合成搞乱**的写法——
//   而"打不了字的人能不能用"整条结论就压在输入法上。
//
//   ⇒ 这里**只重建按钮**：`ValueListenableBuilder` 只包住需要变的那一小块，
//     `TextField` 本身**在整个输入过程中不被重建**。
//
// 另一条：**打字框永远不许锁**（D5.14）。
// 09 是"网好时打字、出电梯才发"——把他锁住等于毁掉唯一顺畅的用法。

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/design.dart' as d;
import '../models/hearing_session.dart';
import '../models/hearing_words.dart';
import '../models/speak_words.dart';
import '../models/space_words.dart';

class Composer extends StatefulWidget {
  /// ⚠️ **刻意没有 `enabled` 参数**——手册 D5.14 说"打字框永远不许锁"。
  ///    留一个开关，就等于留一个"哪天有人顺手把它关掉"的机会。
  ///    网不好、断线、在重连——**都不该让人打不了字**。
  const Composer({
    super.key,
    required this.onSend,
    this.hint,
    this.draft,
    this.onDraftChanged,
    this.onDraftCleared,
    this.onFocused,
    this.autoSpeak = false,
    this.onToggleAutoSpeak,
    this.canSpeak = false,
    this.canHear = false,
    this.hearing = const Hearing(),
    this.onMicToggle,
  });

  final void Function(String text) onSend;
  final String? hint;

  /// **本机存着的那份草稿**（"打了一半、还没发出去"的字；上层从控制器读）。
  /// ⚠️ 它**不是**"已发未认领那句话"（那是 `draft_store.dart` 那本账）。
  final String? draft;

  /// 框里的字变了（上层存盘 —— 主人：*"草稿也是要记住的"*）。
  final ValueChanged<String>? onDraftChanged;

  /// 这份草稿不用了（上层清掉）。
  final VoidCallback? onDraftCleared;

  /// **用户点了打字框**（主人 2026-09-22：*"点击说点什么，聊天窗口会自动打开。"*）。
  /// ⚠️ 收起态那条里也有这个框 ⇒ 点它要先**把窗口打开**，不然他是在一条
  /// 只有一行的缝里打字（而上面那一大块明明在）。
  final VoidCallback? onFocused;

  /// **"读出来"这个开关现在是开还是关**（主人 2026-09-23 定案：它替换了原来那个
  /// 演示用的「听筒 / 扬声器」 —— 网页上没有"听筒"这个出口，那套语义**明说砍掉**）。
  final bool autoSpeak;

  /// 拨这个开关（状态住上层：它是**设备级偏好**，要存盘、也要跨这一屏活着）。
  final ValueChanged<bool>? onToggleAutoSpeak;

  /// 这个平台能不能念出来（网页可以）。⚠️ 假 ⇒ **不画那个开关**
  ///    （界面上不许出现按不动的东西）。
  final bool canSpeak;

  /// 这台设备/这个页面**开得了麦吗**（`services/hearing.dart` 的 `canHear`）。
  /// ⚠️ 假 ⇒ **不画那个话筒**（同一个道理：开不了就别摆在那儿）。
  final bool canHear;

  /// **语音那一步现在什么样**（纯状态机，`models/hearing_session.dart`）。
  /// 状态住上层（控制器）：它要跨这一屏活着，也要跟着事件走。
  final Hearing hearing;

  /// **按了一下那个按钮**（开始 / 结束都由上层按当前状态决定）。
  final VoidCallback? onMicToggle;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  final _controller = TextEditingController();
  final _focus = FocusNode();

  /// **现在是语音那一档吗**（微信那个话筒/键盘切换）。
  bool _voice = false;

  /// 开麦之前框里已经有那几个字 —— 识别出来的字**接在它们后面**
  /// （绝不把用户打了一半的字擦掉）。
  String _prefix = '';

  /// 上一次**由语音写进框里**的那份字。
  /// ⚠️ 有了它才敢在"他自己动过手"之后**不再覆盖**（收尾那句字回来得比手慢）。
  String _mirror = '';

  @override
  void initState() {
    super.initState();
    _mirror = _controller.text;
  }

  @override
  void didUpdateWidget(Composer old) {
    super.didUpdateWidget(old);
    // 语音那一边变了 ⇒ 把字搬进框里
    if (widget.hearing.text != old.hearing.text) _pushMirror();
    // **这一轮真的完了就回到键盘那一档**：字在框里、键盘在、发送钮也在
    // —— 主人那句"然后将文字展示出来。用户可以选择发送"落在这儿。
    // ⚠️ 判据是 `busy`（在听 **或** 收尾中）**不是 `listening`**：
    //    按下"结束"之后还有一句要等，那一句没到就切回去 = 切早了（字会迟到）。
    if (old.hearing.busy &&
        !widget.hearing.busy &&
        widget.hearing.phase == HearingPhase.idle) {
      setState(() => _voice = false);
      _focus.requestFocus();
    }
  }

  /// 把语音那一边现在的字写进框里。
  ///
  /// 🔴 两条规矩：
  ///  ① 开麦前框里那几个字**留着**（接在后面）；
  ///  ② 一旦用户自己动过手（框里的字≠我上次写进去的那份），
  ///     **就不再覆盖** —— 收尾那几个字回来得比他的手慢。
  void _pushMirror() {
    final text = widget.hearing.text;
    final next = text.isEmpty ? _prefix : '$_prefix$text';
    if (next == _mirror) return;
    if (_controller.text != _mirror && !widget.hearing.busy) return;
    _mirror = next;
    _controller.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: next.length),
    );
    widget.onDraftChanged?.call(next);
  }

  /// **按了一下那个按钮**（开始 / 结束）。
  void _toggleMic() {
    final was = widget.hearing.busy;
    if (!was) {
      // 开麦：记住框里已有的字（识别结果接在它们后面）
      _prefix = _controller.text;
      _mirror = _controller.text;
    } else {
      // 结束：焦点回框里 —— 字马上要落在那儿，他要发就按发送
      _focus.requestFocus();
    }
    widget.onMicToggle?.call();
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// 从剪贴板读一段，**接在光标处**（不是替换 —— 聊天里他可能已经打了一半）。
  Future<void> _paste() async {
    String? text;
    try {
      final d = await Clipboard.getData(Clipboard.kTextPlain);
      text = d?.text;
    } catch (_) {
      text = null;
    }
    if (!mounted || text == null || text.isEmpty) return;
    // 接在**光标处**（没有光标就接在末尾）—— 顺手把光标挪到粘完的位置
    final v = _controller.value;
    final at = v.selection.isValid ? v.selection.end : v.text.length;
    final next = v.text.substring(0, at) + text + v.text.substring(at);
    _controller.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: at + text.length),
    );
    _focus.requestFocus();
  }

  /// 框里的字变了 ⇒ 交给上层存下来（**一边打一边存**，刷新回来还在）。
  void _onChanged(String text) {
    widget.onDraftChanged?.call(text);
    setState(() {}); // 草稿条要跟着"框是不是空的"变
  }

  /// **把上面那条草稿放回框里**（"接着写"）。
  void _resume() {
    final d = widget.draft;
    if (d == null) return;
    _controller.value = TextEditingValue(
      text: d,
      selection: TextSelection.collapsed(offset: d.length),
    );
    _focus.requestFocus();
    setState(() {});
  }

  void _submit() {
    final text = _controller.text.trim();
    if (text.isEmpty) return;
    _controller.clear();
    // ⚠️ 发完**焦点留在框里**：连着说两句不用再点一次
    _focus.requestFocus();
    widget.onSend(text);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // 框里有字 ⇒ 不画草稿条（同一句话不许画两遍）
    final showDraft =
        (widget.draft?.isNotEmpty ?? false) && _controller.text.isEmpty;
    return Padding(
      // ★ 主人 2026-09-22："聊天浮窗的 padding 减少一些"（里面这一圈）：12/8 → 8/6
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // ── **上面那条草稿**（主人 2026-09-22）──────────────────
          //   规则：**框是空的、而且本机存着一份草稿**时才出现。
          //   ⚠️ 一旦他开始打字（框里有字），这条就收起来 —— 不然同一句话画两遍。
          if (showDraft) _draftStrip(theme),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              // 🔴 **粘贴**（2026-09-21 主人报「我无法黏贴」之后加的）。
              //    ⚠️ 同一个病：Flutter 把字画在 canvas 上，**空输入框长按不弹菜单**
              //      （它自己的选择菜单要有可选中的文字才弹）⇒ 手机没物理键盘就粘不进来。
              //    ⇒ 一个按钮按下去就是「用户手势」，能合法读剪贴板。
              //    ⚠️ 命中区 ≥44（`IconButton` 默认 48）。
              // ★ 微信那个**话筒 / 键盘**（主人："要能切语音"）
              //
              // ⚠️ **开不了麦就不画这个话筒**（`canHear` 假 ⇒ 这一档整个不存在）——
              //    同一个道理：界面上不许出现按不动的东西（2026-09-23 真开麦那一批）。
              if (widget.canHear)
                IconButton(
                  tooltip: _voice ? voiceToKeyboard : voiceToMic,
                  onPressed: () => setState(() => _voice = !_voice),
                  icon: Icon(
                    _voice ? Icons.keyboard_alt_outlined : Icons.mic_none,
                  ),
                ),
              if (!_voice)
                IconButton(
                  tooltip: composerPaste,
                  icon: const Icon(Icons.content_paste),
                  onPressed: _paste,
                ),
              if (_voice)
                Expanded(child: _micBar(theme))
              else
                Expanded(
                  child: TextField(
                    controller: _controller,
                    focusNode: _focus,
                    enabled: true, // ★ 永远不锁（D5.14）
                    minLines: 1,
                    maxLines: 6,
                    textInputAction: TextInputAction.send,
                    // ★ **点了打字框 ⇒ 告诉上层"把窗口打开"**（主人 2026-09-22：
                    //   *"点击说点什么，聊天窗口会自动打开。"*）
                    onTap: widget.onFocused,
                    onChanged: _onChanged,
                    onSubmitted: (_) => _submit(),
                    decoration: InputDecoration(
                      hintText: widget.hint ?? '说点什么',
                      border: const OutlineInputBorder(),
                      isDense: true,
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 14,
                      ),
                    ),
                  ),
                ),
              // ★ **读出来**（主人 2026-09-23 定案：**替掉**原来那个演示用的「听筒 / 扬声器」）。
              //
              // 🔴 为什么替掉：网页上**没有"听筒"这个出口**（浏览器只有扬声器/耳机，
              //    `setSinkId` 在 iOS 上无效 —— 手册 §3.2 自己写着）⇒ 留着它就是
              //    假装有一个做不到的东西。**"从哪儿出声"那套语义明说砍掉**，
              //    留下真做得到的那半：**让它念出来**。契约 `docs/dev/68-SPEAK.md`。
              //
              // ⚠️ **只在语音档画**（与话筒/键盘同一档 —— 主人 2026-09-23 定案里就是这么定的）：
              //    键盘档那一格留给输入框。
              // ⚠️ **念不了就不画**（`canSpeak` 假）—— 界面上不许出现按不动的东西。
              if (_voice && widget.canSpeak)
                IconButton(
                  tooltip: widget.autoSpeak ? speakAutoHintOn : speakAutoHintOff,
                  onPressed: () => widget.onToggleAutoSpeak?.call(!widget.autoSpeak),
                  icon: Icon(
                    widget.autoSpeak ? Icons.volume_up : Icons.volume_off_outlined,
                  ),
                ),
              const SizedBox(width: 4),
              // ★ 只有这一块跟着输入变——输入框本身不会被重建
              //
              // 🔴 **框里有字才画那个发送钮**（2026-09-23 重设计，主人拍板）：
              //    原来它常驻、没字时是**禁用态**（`onPressed: null`）—— 一个 48px 的
              //    "按不动"的按钮一直挂在那儿，既占地又容易被当成坏了。
              //    ⚠️ **位置与宽度必须固定**：它一会儿有一会儿没有，如果让它撑开/收窄，
              //       输入框的宽度就会跳 —— 那是同 D4.8 一种病（界面自己抖）。
              //       ⇒ 用固定 48×48 的盒子占住位置，没字时**里面什么都不画**。
              SizedBox(
                width: 48,
                height: 48,
                child: ValueListenableBuilder<TextEditingValue>(
                  valueListenable: _controller,
                  builder: (context, value, _) {
                    final canSend = value.text.trim().isNotEmpty;
                    // 没话要说 ⇒ 那个位置**什么都不画**（不是禁用态；位置由外面那个
                    // 固定 48×48 的盒子占着，所以界面不跳）
                    if (!canSend) return const SizedBox.shrink();
                    return Semantics(
                      button: true,
                      label: '发送',
                      child: IconButton.filled(
                        // 触控目标 ≥44
                        constraints: const BoxConstraints(
                          minWidth: 48,
                          minHeight: 48,
                        ),
                        onPressed: _submit,
                        icon: const Icon(Icons.arrow_upward),
                        tooltip: '发送',
                        style: IconButton.styleFrom(
                          minimumSize: const Size(48, 48),
                          backgroundColor: theme.colorScheme.primary,
                        ),
                      ),
                    );
                  },
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// 草稿条：**说清这是你打了一半的字**，并给两条出路（接着写 / 不用了）。
  Widget _draftStrip(ThemeData theme) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 4),
      decoration: BoxDecoration(
        color: d.card,
        borderRadius: BorderRadius.circular(d.radiusField),
        border: Border.all(color: d.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            composeDraftTitle,
            style: theme.textTheme.labelLarge?.copyWith(color: d.accent),
          ),
          const SizedBox(height: 4),
          Text(
            widget.draft!,
            style: theme.textTheme.bodyMedium?.copyWith(color: d.ink),
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: 2),
          Row(
            children: [
              TextButton(
                // 命中区 ≥44（D3.6）：`TextButton` 默认给的是 36 —— 显式撑起来
                style: TextButton.styleFrom(minimumSize: const Size(88, 44)),
                onPressed: _resume,
                child: const Text(composeDraftBack),
              ),
              TextButton(
                style: TextButton.styleFrom(minimumSize: const Size(88, 44)),
                onPressed: widget.onDraftCleared,
                child: const Text(composeDraftDiscard),
              ),
            ],
          ),
        ],
      ),
    ),
  );

  /// **语音那一块**（2026-09-23 主人定案：按一下开始 / 再按一下结束）。
  ///
  /// 三件事按顺序摆：
  ///   ① **为什么停了 / 为什么开不了**那一句（有才画 —— 人话，直接显示）；
  ///   ② 一个**大按钮**：`按一下 说话` ⇄ `正在听…再按一下 结束`；
  ///   ③ 闲下来时那句**怎么用**（说完了按一下，字留在这儿，你自己决定发不发）。
  ///
  /// 🔴 **"正在听"这三个字只在真的在听时出现**（D5.13：不录音时禁用"听"字）；
  ///    没配钥匙那一档**连按钮都不画**（按不动的东西不许摆出来）。
  /// ⚠️ 命中区 ≥44：用 `TextButton`（它就是 `ButtonStyleButton`），
  ///    显式写 `minimumSize` —— 别用 `Container` 自己画一个"像按钮的东西"。
  Widget _micBar(ThemeData theme) {
    final h = widget.hearing;
    final live = h.listening;
    final finishing = h.phase == HearingPhase.finishing;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // 听的时候把**正在听到的**那行字摆出来（"实时转化语音成文字"那一半）
        // ⚠️ **收尾中也要摆**（那半句还在，只是还没定稿）
        if (h.busy) ...[
          Container(
            width: double.infinity,
            constraints: const BoxConstraints(minHeight: 44),
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
            decoration: BoxDecoration(
              color: d.card,
              borderRadius: BorderRadius.circular(d.radiusField),
              border: Border.all(color: d.line),
            ),
            child: Text(
              h.text.isEmpty ? hearListeningEmpty : h.text,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: h.text.isEmpty ? d.muted : d.ink,
              ),
            ),
          ),
          const SizedBox(height: 6),
        ],
        // 收尾中：说清楚这一小会儿在等什么（不然用户以为说丢了）
        if (finishing) ...[
          Text(
            hearFinishing,
            style: theme.textTheme.bodySmall?.copyWith(color: d.muted),
          ),
          const SizedBox(height: 6),
        ],
        // 为什么停了 / 为什么开不了（**原话**，不再翻译一遍）
        if (h.notice.isNotEmpty) ...[
          Text(
            h.notice,
            style: theme.textTheme.bodySmall?.copyWith(color: d.muted),
          ),
          const SizedBox(height: 6),
        ],
        // 那个按钮：没配钥匙时**不画**（做不了的按钮不许摆出来）；
        // 收尾中也不画（那会儿按它没有意义 —— 字马上就到）
        if (h.phase != HearingPhase.unavailable && !finishing)
          TextButton.icon(
            style: TextButton.styleFrom(
              minimumSize: const Size(88, 48),
              backgroundColor: live ? d.accentTint : d.card,
              foregroundColor: live ? d.accent : d.ink,
              side: BorderSide(color: live ? d.accent : d.line),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(d.radiusField),
              ),
            ),
            onPressed: widget.onMicToggle == null ? null : _toggleMic,
            icon: Icon(live ? Icons.stop_circle_outlined : Icons.mic),
            label: Text(live ? hearListening : hearStart),
          ),
        if (!h.busy && h.notice.isEmpty) ...[
          const SizedBox(height: 4),
          Text(
            hearHint,
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall?.copyWith(color: d.muted),
          ),
        ],
      ],
    );
  }
}
