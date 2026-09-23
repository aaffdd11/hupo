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

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  final _controller = TextEditingController();
  final _focus = FocusNode();

  /// **现在是语音那一档吗**（微信那个话筒/键盘切换）。
  bool _voice = false;

  /// 手指按着"按住 说话"。
  bool _holding = false;

  /// **听筒**那一档（微信那个听筒/扬声器切换）。
  bool _earpiece = false;

  /// 演示走到的字数（"实时转文字"的**形状**）。
  ///
  /// 🔴 **这一整块是假的，所以处处标着「演示」**：
  ///    没有开麦、没有识别、也不把演示的字当成他说的话（松手只是把它放回打字框，
  ///    让他自己决定发不发）。⇒ 页面上**一眼看得出这是假的**。
  int _demoChars = 0;
  static const _demoLine = '这是一句演示，还没有真的开麦。';
  static const _demoTick = Duration(milliseconds: 90);
  Timer? _demoTimer;

  @override
  void dispose() {
    _demoTimer?.cancel();
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// 按住 ⇒ "实时"往外吐字（**演示**）；松手 ⇒ 停下。
  void _startDemo() {
    _demoTimer?.cancel();
    setState(() {
      _holding = true;
      _demoChars = 0;
    });
    _demoTimer = Timer.periodic(_demoTick, (t) {
      if (!mounted) return;
      setState(() => _demoChars += 1);
      if (_demoChars >= _demoLine.length) t.cancel();
    });
  }

  /// 松手：把演示那句话**放回打字框**（⚠️ **不自动发送** —— 手册 D5.4 点名不许）。
  void _endDemo() {
    _demoTimer?.cancel();
    if (!mounted) return;
    setState(() {
      _holding = false;
      _voice = false; // 回到键盘那一档，让他能改能发
    });
    if (_demoChars > 0) {
      final text = _demoLine.substring(
        0,
        _demoChars > _demoLine.length ? _demoLine.length : _demoChars,
      );
      _controller.value = TextEditingValue(
        text: text,
        selection: TextSelection.collapsed(offset: text.length),
      );
      widget.onDraftChanged?.call(text);
      _focus.requestFocus();
    }
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
          // ── **演示提示条**（主人："先做假的"）──────────────────
          //  🔴 两个作用缺一不可：① 让主人看得到"实时转文字"的形状；
          //     ② **让任何人一眼看出这是假的** —— 这个项目栽过三次"页面在说假话"。
          if (_voice || _earpiece) _demoStrip(theme),
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
              IconButton(
                tooltip: _voice ? voiceToKeyboard : voiceToMic,
                onPressed: () {
                  _demoTimer?.cancel();
                  setState(() {
                    _voice = !_voice;
                    _holding = false;
                    // ⚠️ **回键盘档 ⇒ 听筒那一档跟着关**（2026-09-23 重设计）：
                    //    听筒只在语音档有意义（它现在也只在语音档画 —— 见下面）。
                    //    不关的话，"演示"那条会留在一个**已经没有听筒按钮**的界面上，
                    //    而用户找不到地方把它关掉。
                    if (!_voice) _earpiece = false;
                  });
                },
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
                Expanded(child: _holdToTalk(theme))
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
              // ★ 微信那个**听筒 / 扬声器**（主人："要能切听筒"）
              // ⚠️ **只在语音档画它**（2026-09-23 重设计，主人拍板）：键盘档用不着听筒，
              //    而它常驻要占掉一格 48px —— 那一格给输入框更值。
              //    配套那条：回键盘档时 `_earpiece` 跟着关（见上面话筒那个 handler）。
              if (_voice)
                IconButton(
                  tooltip: _earpiece ? voiceEarpieceOn : voiceEarpieceOff,
                  onPressed: () => setState(() => _earpiece = !_earpiece),
                  icon: Icon(
                    _earpiece ? Icons.hearing : Icons.volume_up_outlined,
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

  /// **按住 说话**那一块（微信那个大按钮）。
  /// ⚠️ 用 `Listener` 不用 `GestureDetector`（`accessibility_test.dart` 有源码级禁令）。
  Widget _holdToTalk(ThemeData theme) => Listener(
    behavior: HitTestBehavior.opaque,
    onPointerDown: (_) => _startDemo(),
    onPointerUp: (_) => _endDemo(),
    onPointerCancel: (_) => _endDemo(),
    child: Container(
      constraints: const BoxConstraints(minHeight: 44),
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: _holding ? d.accentTint : d.card,
        borderRadius: BorderRadius.circular(d.radiusField),
        border: Border.all(color: _holding ? d.accent : d.line),
      ),
      child: Text(
        _holding ? voiceReleaseToSend : voiceHoldToTalk,
        style: theme.textTheme.bodyLarge?.copyWith(
          color: _holding ? d.accent : d.ink,
        ),
      ),
    ),
  );

  /// **演示提示条**：左边一个「演示」小标，右边一句实话 + "实时"吐出来的字。
  Widget _demoStrip(ThemeData theme) {
    final shown = _demoChars <= 0
        ? ''
        : _demoLine.substring(
            0,
            _demoChars > _demoLine.length ? _demoLine.length : _demoChars,
          );
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
        decoration: BoxDecoration(
          color: d.card,
          borderRadius: BorderRadius.circular(d.radiusField),
          border: Border.all(color: d.line),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                // ⚠️ **这个「演示」小标不许去掉**：去掉它，这一条就从"演示"变成"假话"
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: d.accentTint,
                    borderRadius: BorderRadius.circular(d.radiusChip),
                  ),
                  child: Text(
                    voiceDemoChip,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: d.accent,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                // 🔴 **假的每一半都要说出来**（2026-09-23 重设计配套改）：
                //    听筒现在**只在语音档**能开 ⇒ 原来那种"二选一"会让
                //    "读出来也还没做"这句**永远看不见** —— 那等于**少说一句真话**，
                //    与 D5.13 那一族规矩（不录音时禁用"听"字 / 假的一眼看得出）同源。
                //    ⇒ 两句**各自一行**（各自一个 `Text`，读屏与判据都能逐句找到）。
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (_voice)
                        Text(
                          voiceNotWired,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: d.muted,
                          ),
                        ),
                      if (_earpiece)
                        Text(
                          voiceEarpieceNotWired,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: d.muted,
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ),
            if (shown.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                shown,
                style: theme.textTheme.bodyMedium?.copyWith(color: d.ink),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
