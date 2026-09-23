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

import 'package:flutter/material.dart';

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
    this.leading,
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

  /// **这一行最前面那个东西**（主人 2026-09-24：*"homeicon 放在聊天窗口左边"*）。
  ///
  /// 就是原来挂在抓手行标题前面那个"在哪儿说话"的图标（桌面 = `home`，
  /// 进了某个小程序 = 它自己的图标，见 `screens/chat_screen.dart` 的 `_scopeBadge`）——
  /// 现在聊天窗口是**一行**，所以它跟着搬到这一行的最前面。
  /// ⚠️ 它**只指示、不响应点击**（所以不参与 D3.6 的 ≥44 那条）。
  final Widget? leading;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  final _controller = TextEditingController();
  final _focus = FocusNode();

  /// 开麦之前框里已经有那几个字 —— 识别出来的字**接在它们后面**
  /// （绝不把用户打了一半的字擦掉）。
  String _prefix = '';

  /// 一句要说给用户的白话（例如"这里开不了麦"）。空 = 没什么要说的。
  String _notice = '';

  /// 上一次**由语音写进框里**的那份字。
  /// ⚠️ 有了它才敢在"他自己动过手"之后**不再覆盖**（收尾那句字回来得比手慢）。
  String _mirror = '';

  @override
  void initState() {
    super.initState();
    // 🔴 **进来的时候就已经在听**（窗口刚被重建、或者上层先把状态推过来了）
    //    ⇒ 那半句必须**摆进框里**。
    //    ⚠️ 2026-09-24 之前不用管这件事：那时字活在"语音档"那块卡片上，
    //      框里那份只靠 `didUpdateWidget` 搬。现在**字就是框里的内容** ——
    //      少了这一步，屏幕上会是一句空的（而它明明听到了）。
    final t = widget.hearing.text;
    _mirror = t;
    _controller.value = TextEditingValue(
      text: t,
      selection: TextSelection.collapsed(offset: t.length),
    );
  }

  @override
  void didUpdateWidget(Composer old) {
    super.didUpdateWidget(old);
    // 语音那一边变了 ⇒ 把字搬进框里
    if (widget.hearing.text != old.hearing.text) _pushMirror();
    // **这一轮真的完了 ⇒ 焦点回框里**：字已经在框里、发送钮也在
    // —— 主人那句"然后将文字展示出来。用户可以选择发送"落在这儿。
    //
    // 🔴 2026-09-24 改：原来这里还要**切一档**（语音档 ⇄ 键盘档），
    //    现在没有那两档了（主人：*"我们做成一行"*）——
    //    按一下话筒就开始听、字**直接落进这个框**，再按一下结束。
    //    所以这里只剩"把光标放回去"这一件事。
    // ⚠️ 判据是 `busy`（在听 **或** 收尾中）：按下"结束"之后还有一句要等。
    if (old.hearing.busy && !widget.hearing.busy) {
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

  // ⛔ **聊天框那个「粘贴」按钮 2026-09-24 砍了**（主人：*"聊天窗口需要去掉粘贴按钮"*）。
  //
  //    它当初为什么会有（`2026-09-21` 主人报 *"我无法黏贴，为啥"*）：
  //    Flutter 把字画在 canvas 上，**长按弹的是它自己的选择菜单**，而空输入框里
  //    没有可选的文字 ⇒ 菜单不弹 ⇒ 手机（没物理键盘）粘不进来。
  //
  //    ⚠️ 但那条理由对**聊天框**弱得多：手机上系统键盘自己带粘贴键，
  //       而聊天框里通常已经有字。**钥匙那一屏的粘贴按钮留着**（那一屏就是要粘一长串）。
  //    ⇒ 要恢复就是**一行**：把那块 `IconButton(tooltip: composerPaste, …)` 加回来，
  //      连同下面的 `_paste()`（`git show c237517:v2/apps/mobile/lib/widgets/composer.dart`）。

  /// 框里的字变了 ⇒ 交给上层存下来（**一边打一边存**，刷新回来还在）。
  void _onChanged(String text) {
    widget.onDraftChanged?.call(text);
    setState(() {
      // 他开始打字 ⇒ 那句说明收起来（它是一次性的）
      _notice = '';
    }); // 草稿条要跟着"框是不是空的"变
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
          // 一句白话（有才画）——例如"这里开不了麦"
          if (_notice.isNotEmpty) _noticeStrip(theme),
          // ★ **正在听 / 为什么停了**（2026-09-24：只剩这一行 —— 字直接落进框里）
          if (widget.hearing.busy || widget.hearing.notice.isNotEmpty)
            _hearingStrip(theme),
          // ★ 2026-09-24：**这一条现在只有一行**（主人：*"我们做成一行"*）——
          //   `[在哪儿说话] [框（右边里头是话筒）] [发送]`
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              // ★ **最前面那个"在哪儿说话"的图标**（主人 2026-09-24："homeicon 放在聊天窗口左边"）。
              //   原来它在抓手行的标题前面；这一条收成一行之后跟到这儿来。
              if (widget.leading != null) ...[
                widget.leading!,
                const SizedBox(width: 8),
              ],
              // ★ 2026-09-24：原来这里那个**话筒/键盘切换**按钮搬走了 ——
              //   主人：*"语音按钮放在聊天框内部的右侧"* ⇒ 它现在是框里那行的
              //   `suffixIcon`（见 `_field`）。**没有"语音档"了**：按一下就开始听、
              //   字直接落进这个框、再按一下结束。
              // ★ 框（**话筒在它里面的右侧** —— 主人 2026-09-24）
              Expanded(child: _field()),
              const SizedBox(width: 4),
              // ★ **发送**（主人 2026-09-24：*"聊天框右侧应该是一个发送按钮。一开始是灰色的。"*）
              //   ⚠️ 这一条**推翻了 2026-09-23 那个"有字才画"**（那也是主人拍的板）：
              //      现在它**一直在**，没字时是灰的、按不动 —— 位置固定，界面不跳（D4.8）。
              _sendButton(theme),
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

  /// **一句白话**（例如"这里开不了麦"）：一行、淡色、不占地方。
  Widget _noticeStrip(ThemeData theme) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      decoration: BoxDecoration(
        color: d.accentTint,
        borderRadius: BorderRadius.circular(d.radiusField),
      ),
      child: Text(
        _notice,
        style: theme.textTheme.bodySmall?.copyWith(color: d.accent),
      ),
    ),
  );

  /// **框**（主人 2026-09-24：*"语音按钮放在聊天框内部的右侧"*）。
  ///
  /// 🔴 两条老规矩照旧：
  ///   ① **永远不锁**（D5.14）—— 网不好、断线、在重连，都不该让人打不了字；
  ///   ② **打字框本身不重建**（只有发送钮那一小块跟着字变，见 `_sendButton`）。
  ///
  /// ⚠️ **话筒在框里面**（`suffixIcon`）：它在，就一定点得到（命中区 ≥44）；
  ///    **开不了麦也画它**（点下去说一句白话 —— 2026-09-23 主人问过"为什么录音的
  ///    icon 没有"，藏起来的那个决定是坏的）。
  Widget _field() => TextField(
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
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
      // ⚠️ 框里那两颗按钮的**下限**：命中区 ≥44（D3.6）。
      //    不写这一条，`isDense` 的框会把它们压小 —— a11y 那道硬闸当场会抓。
      suffixIconConstraints: const BoxConstraints(minWidth: 44, minHeight: 44),
      suffixIcon: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          // ★ **读出来**（主人 2026-09-23 定案：替掉原来演示用的「听筒 / 扬声器」）。
          //   契约 `docs/dev/68-SPEAK.md`。**念不了就不画**（界面上不许有按不动的东西）。
          //   2026-09-24：它原来住在"语音档"里，那一档没了 ⇒ 跟话筒一起住在框里。
          if (widget.canSpeak) _speakerButton(),
          _micButton(),
        ],
      ),
    ),
  );

  /// **话筒**（2026-09-24：它在框里，不在左边）。
  ///
  /// 按一下**开始听**、再按一下**结束**；正在听时它是红的、图形换成"停"。
  /// ⚠️ `canHear` 假 ⇒ **照样画**，点下去说一句白话（`hearCantHere`）——
  ///    不装开麦、不进语音档、不出假字。
  Widget _micButton() {
    final busy = widget.hearing.busy;
    return IconButton(
      tooltip: busy ? hearStop : hearStart,
      onPressed: () {
        if (!widget.canHear) {
          setState(() => _notice = hearCantHere);
          return;
        }
        setState(() => _notice = '');
        _toggleMic();
      },
      icon: Icon(
        busy ? Icons.stop_circle_outlined : Icons.mic_none,
        color: busy ? d.accent : d.muted,
      ),
    );
  }

  /// **读出来**那个开关（设备级偏好，状态住上层）。
  Widget _speakerButton() => IconButton(
    tooltip: widget.autoSpeak ? speakAutoHintOn : speakAutoHintOff,
    onPressed: () => widget.onToggleAutoSpeak?.call(!widget.autoSpeak),
    icon: Icon(
      widget.autoSpeak ? Icons.volume_up : Icons.volume_off_outlined,
      color: widget.autoSpeak ? d.accent : d.muted,
    ),
  );

  /// **发送**（主人 2026-09-24：*"聊天框右侧应该是一个发送按钮。一开始是灰色的。"*）。
  ///
  /// 🔴 它**一直在**（不再"有字才画"）：没字、或还在听/收尾中 ⇒ **灰的、按不动**。
  ///    ⚠️ 位置与大小**固定 48×48**：它要是一会儿有一会儿没有，框的宽度就会跳
  ///      —— 那是 D4.8 一种病（界面自己抖）。
  /// ⚠️ 只有这一小块跟着输入变（`ValueListenableBuilder`）—— **框本身不重建**。
  Widget _sendButton(ThemeData theme) => SizedBox(
    width: 48,
    height: 48,
    child: ValueListenableBuilder<TextEditingValue>(
      valueListenable: _controller,
      builder: (context, value, _) {
        // ⚠️ **正在听/收尾中按不动**：那会儿框里的字是"还在长"的半句，
        //    发出去就是替他做了决定（主人要的是"停下之后再决定发不发"）。
        final canSend = value.text.trim().isNotEmpty && !widget.hearing.busy;
        return Semantics(
          button: true,
          label: '发送',
          enabled: canSend,
          child: IconButton.filled(
            // 触控目标 ≥44
            constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
            onPressed: canSend ? _submit : null,
            icon: const Icon(Icons.arrow_upward),
            tooltip: '发送',
            style: IconButton.styleFrom(
              minimumSize: const Size(48, 48),
              backgroundColor: canSend ? theme.colorScheme.primary : d.line,
              disabledBackgroundColor: d.line,
              foregroundColor: canSend ? theme.colorScheme.onPrimary : d.muted,
              disabledForegroundColor: d.muted,
            ),
          ),
        );
      },
    ),
  );

  /// **正在听 / 收尾中**那一行（一行、淡色）。
  ///
  /// 🔴 2026-09-24：原来它是一大块（"语音档"里那个卡片 + 大按钮），现在**只剩这一行** ——
  ///    识别出来的字**直接落进框里**（`_pushMirror`），屏幕上的字只有一份。
  /// ⚠️ **"正在听"这三个字只在真的在听时出现**（D5.13：不录音时禁用"听"字）。
  Widget _hearingStrip(ThemeData theme) {
    final h = widget.hearing;
    final live = h.listening;
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        children: [
          if (h.busy) ...[
            Text(
              '●',
              style: theme.textTheme.labelSmall?.copyWith(
                color: live ? d.accent : d.muted,
              ),
            ),
            const SizedBox(width: 6),
            Text(
              live ? hearListening : hearFinishing,
              style: theme.textTheme.labelSmall?.copyWith(
                color: live ? d.accent : d.muted,
              ),
            ),
            const SizedBox(width: 8),
          ],
          // **为什么停了**（原话，不再翻译一遍）
          Expanded(
            child: Text(
              h.notice,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(color: d.muted),
            ),
          ),
        ],
      ),
    );
  }
}
