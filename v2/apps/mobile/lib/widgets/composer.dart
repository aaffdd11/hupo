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
//
// ── ★ 批次 4：这一条的**字**与**色**跟着聊天窗口那两轴走（契约 `docs/dev/119`）──
// 用户那个 12–17 只影响**聊天内容** ⇒ 框里自己打的字（以及草稿那一段预览）
// 用 `scale.at(DshTypes.s)`（= `calc(14px + Δ)`，默认档下还是 14）。
// ⚠️ 其余那几行（"正在听…"/一句白话）是**窗口的零件**，字号照旧跟系统缩放走
//    （DSH 那条"字体设置只影响会话内容"就是这条边界）；颜色则一律从色板来
//    —— 暗色下 `d.muted` / `d.ink` 压在新底上读不出来。
// ⚠️ 它在浮窗**里面**，所以 `Theme.of(context)` 已经是聊天窗口那一份
//    （`appearance_scope.dart` 的 `chatThemeOf`）；这里的显式取色只是为了
//    那几处**原来写死暖色**（`d.accent` / `d.muted`）的地方跟上去。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/dsh_design.dart';
import '../models/hearing_session.dart';
import '../models/hearing_words.dart';
import '../models/speak_words.dart';
import '../models/space_words.dart';
import 'dsh_look.dart';
import 'rec_pulse.dart';

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
    this.hintAbove,
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

  /// ★ **浮在这一行上面的一句说明**（主人 2026-09-27：*"点击 home 那个 icon 上面会有一个浮窗"*）。
  ///
  /// 🔴 为什么要挂在**这一行**上、而不是整个输入条上：锚点是**那颗 home 图标的上面**。
  ///    挂在整个输入条上的话，提示会矮掉"输入条高 − 这一行高"那么多（压在图标上）。
  /// ⚠️ 它**不参与排版**（`Positioned` ＋ `FractionalTranslation`）⇒ 出现/消失**不会**
  ///    让浮窗长高再缩回去（D4.8）；外面还包一层 `IgnorePointer`（它是"说一句话"，不挡点击）。
  final Widget? hintAbove;

  @override
  State<Composer> createState() => _ComposerState();
}

/// **消息框**那个圆角容器的 key（判据用它量"发送/读出来在不在框里、在不在输入框里"）。
const Key chatMessageBoxKey = ValueKey('chat-message-box');

/// 「发送」那颗按钮的 key（判据认它；它只在"有话要说"时出现在最右那一格）。
const Key chatSendKey = ValueKey('chat-send');

/// 录音那颗按钮的 key（判据认它）。
/// ⚠️ 它**一直在**这一行的最右（主人 2026-09-29 更正）；「发送」在**消息框里面**。
const Key chatMicButtonKey = ValueKey('chat-mic');

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
    // ★ 批次 4：用户选的外观与字号（没有 scope 时退回默认档 —— 单看这一条的判据不受影响）。
    final look = DshLook.of(context);
    final p = look.palette;
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
          if (showDraft) _draftStrip(theme, look),
          // 一句白话（有才画）——例如"这里开不了麦"
          if (_notice.isNotEmpty) _noticeStrip(theme, look),
          // ★ **"为什么停了"**（2026-09-29：**只在真有那句话时才画**）。
          //   🔴 原来这里是 `busy || notice.isNotEmpty` —— 而"正在听"那三个字
          //      已经搬到**话筒那颗按钮上**（框里那几根脉动的 bar）⇒ busy 为真、
          //      notice 为空时，这里会画出一块**什么都没有的白板子**
          //      （真浏览器截图当场看到的）。判据 R5 钉着这一条。
          if (widget.hearing.notice.isNotEmpty) _hearingStrip(theme, look),
          // ★ 2026-09-24：**这一条现在只有一行**（主人：*"我们做成一行"*）——
          //   `[在哪儿说话] [框（右边里头是话筒）] [发送]`
          // ★ 2026-09-27：外面包一层 `Stack` —— 只为让 `hintAbove`（那条说明）
          //   浮在**这一行**上面（锚点是那颗 home 的上面），一个像素都不占排版。
          Stack(
            children: [
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
              //   主人：*"语音按钮放在聊天框内部的右侧"* ⇒ 它当时成了框里那行的
              //   `suffixIcon`。**没有"语音档"了**：按一下就开始听、
              //   字直接落进这个框、再按一下结束。
              // ★ 2026-09-29 **又搬了一次**（主人：*"上面的左侧是home按钮，中间是文字输入，
              //   右侧是语音按钮。这些按钮就不是透明的了。"*）：
              //   ⇒ 这一行现在是**三段**：`[home] [框（发送在框里）] [话筒]`，
              //     话筒在**这一行的最右**（不在框里面了），而且三样都是**不透明**的。
              Expanded(child: _messageBox(theme, look)),
              const SizedBox(width: d.gapS),
              // 🔴 2026-09-29 **主人当场更正**：*"录音按钮一直在右侧，点击结束指示便会继续录音。
              //   发送按钮在消息框里面。"*
              //   ⇒ 最右这一格**永远是录音那颗**（不再跟发送换位置）；
              //     「发送」回到**消息框里面**（`_field` 的 suffix，见下）。
              //   ⚠️ 上一版我把它做成了"录音 ⇄ 发送 一格两态" —— 那是**读错了他的意思**。
              _micButton(p),
            ],
          ),
              if (widget.hintAbove != null)
                Positioned(
                  // 🔴 `top: 0` 配 `FractionalTranslation(0,-1)`：提示的**下沿**正好
                  //    贴在这一行的**上沿**（不用知道这一行多高 —— 写死一个数就错了）。
                  //    ⚠️ 用 `Positioned` 而不是 `Align`：后者会参与 `Stack` 的尺寸计算，
                  //       提示一出现就把这一行撑高（那就不是"浮着"了）。
                  left: 0,
                  top: 0,
                  child: FractionalTranslation(
                    translation: const Offset(0, -1),
                    child: IgnorePointer(child: widget.hintAbove!),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }

  /// 草稿条：**说清这是你打了一半的字**，并给两条出路（接着写 / 不用了）。
  Widget _draftStrip(ThemeData theme, DshLook look) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 4),
      decoration: BoxDecoration(
        color: look.palette.bgLayer2,
        borderRadius: BorderRadius.circular(d.radiusField),
        border: Border.all(color: look.palette.borderL2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            composeDraftTitle,
            style: dshTextStyle(look.scale.at(DshTypes.sStrong), look.palette.stateBusiness),
          ),
          const SizedBox(height: 4),
          Text(
            widget.draft!,
            // 这一段是他自己打了一半的字 ⇒ 它属于"内容"，跟着用户字号走。
            style: dshTextStyle(look.scale.at(DshTypes.s), look.palette.labelPrimary),
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
  Widget _noticeStrip(ThemeData theme, DshLook look) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      decoration: BoxDecoration(
        // ⚠️ 原来这里用暖色那套的 `accentTint`：暗色下它是一块亮橙，
        //    压在新底上比正文还抢眼 ⇒ 换成"这一档的淡底 + 描边"。
        color: look.palette.bgLayer2,
        borderRadius: BorderRadius.circular(d.radiusField),
        border: Border.all(color: look.palette.borderL2),
      ),
      child: Text(
        _notice,
        style: theme.textTheme.bodySmall?.copyWith(color: look.palette.labelSecondary),
      ),
    ),
  );

  /// 🔴 **"消息框"是一层圆角容器，输入框只是它里面的一段**（2026-09-29 修一个真缺陷）。
  ///
  /// ── 为什么非要这么分（**别改回去**）──────────────────────────
  /// 上一版把「发送」放进 `TextField` 的 `suffixIcon`（那是最省事的写法），
  /// **在网页上那颗按钮点不到** —— 真机读数（线上 1280 宽）：
  /// ```
  ///   发送钮的矩形      [900, 554, 52×36]
  ///   Flutter web 盖的那个 <textarea>  [328, 550, 630×50]   ← 把按钮整个盖住
  ///   document.elementFromPoint(按钮中心) ⇒ TEXTAREA（pointer-events: all）
  /// ```
  /// ⇒ **浏览器**的输入法那一层是**真的 DOM 元素**，位置正好是**整个 `TextField` 的矩形**
  ///   （含 suffix ⇒ 含里面那两颗按钮）⇒ 手指落在上面的那一下**根本到不了 Flutter**。
  ///   ⚠️ 手机上没有这层 DOM ⇒ 同一份代码在安卓上是好的（这就是它一直没被发现的原因）。
  ///   ⚠️ **判据也测不出来**（widget 测试里没有那层 DOM）⇒ 这一条只能靠**结构**钉住：
  ///      界面里的判据写着"发送/读出来**不许**是 `TextField` 的后代"。
  ///
  /// ⇒ 现在：**外面一圈圆角容器**（看起来就是那个"消息框"）＋ 里面 `Row[输入框, 读出来, 发送]`。
  ///   视觉上发送**还在消息框里面**（主人 2026-09-29：*"发送按钮在消息框里面。"*），
  ///   而它在 DOM 那一层**不在输入框的矩形里** ⇒ 点得到。
  Widget _messageBox(ThemeData theme, DshLook look) {
    final p = look.palette;
    return Container(
      key: chatMessageBoxKey,
      decoration: BoxDecoration(
        // ★ 实底（bar 是半透明的；框要是也透，字就压在桌面/壁纸上）
        color: p.bgLayer2,
        borderRadius: BorderRadius.circular(d.radiusField),
        border: Border.all(color: p.borderL2),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(child: _field(look)),
          // ★ **读出来**（主人 2026-09-23 定案：替掉原来演示用的「听筒 / 扬声器」）。
          //   契约 `docs/dev/68-SPEAK.md`。**念不了就不画**（界面上不许有按不动的东西）。
          //   ⚠️ 它原来也住在 `TextField` 的 suffix 里 —— **同一个病**（网页上点不到）⇒ 一起搬出来。
          if (widget.canSpeak) _speakerButton(p),
          // 🔴 「发送」（主人 2026-09-29：*"发送按钮缩小一点，用琥珀色。文字写发送。"* ＋
          //   *"发送按钮在消息框里面。"*）：**一直在**（没话要说 ⇒ 灰的、按不动），
          //   有话要说 ⇒ 琥珀 ＋ 两个字。位置固定 ⇒ 界面不跳（D4.8）。
          Padding(
            padding: const EdgeInsets.only(right: 4, bottom: 4),
            child: _sendButton(theme, p),
          ),
        ],
      ),
    );
  }

  /// **输入框那一格**（主人 2026-09-24：*"语音按钮放在聊天框内部的右侧"* ——
  ///   2026-09-29 起那两颗按钮**搬到了外面那层容器里**，见 [_messageBox]）。
  ///
  /// 🔴 两条老规矩照旧：
  ///   ① **永远不锁**（D5.14）—— 网不好、断线、在重连，都不该让人打不了字；
  ///   ② **打字框本身不重建**（只有发送钮那一小块跟着字变，见 `_sendButton`）。
  ///
  /// ⚠️ **话筒在框里面**（`suffixIcon`）：它在，就一定点得到（命中区 ≥44）；
  ///    **开不了麦也画它**（点下去说一句白话 —— 2026-09-23 主人问过"为什么录音的
  ///    icon 没有"，藏起来的那个决定是坏的）。
  Widget _field(DshLook look) => TextField(
    controller: _controller,
    focusNode: _focus,
    enabled: true, // ★ 永远不锁（D5.14）
    minLines: 1,
    maxLines: 6,
    textInputAction: TextInputAction.send,
    // ★ 批次 4：**框里那几个字**是聊天内容 ⇒ 字号从用户那条轴来
    //   （`DshTypes.base` = 16/24，**默认档下与改前逐像素相同** —— 只有用户
    //    真去调字号时才动。⚠️ 别改成 14：那会让输入条矮 6 像素，而时间线的
    //    `followSlack`（160）正好卡在它的 `maxScrollExtent` 上 —— 6 像素就够
    //    让 a11y 那条"先把时间线拉回最上面"的判据失效，见 `docs/dev/119` §六）。
    style: dshTextStyle(look.scale.at(DshTypes.base), look.palette.labelPrimary),
    cursorColor: look.palette.stateBusiness,
    // ★ **点了打字框 ⇒ 告诉上层"把窗口打开"**（主人 2026-09-22：
    //   *"点击说点什么，聊天窗口会自动打开。"*）
    onTap: widget.onFocused,
    onChanged: _onChanged,
    onSubmitted: (_) => _submit(),
    decoration: InputDecoration(
      hintText: widget.hint ?? '说点什么',
      hintStyle: dshTextStyle(look.scale.at(DshTypes.base), look.palette.labelTertiary),
      // ⚠️ **没有边框、没有底**：那一圈与实底归外面那层 `_messageBox` 的容器
      //    （这样"消息框"是一整块，而输入框自己的矩形里**没有按钮** —— 见那边那段批注）。
      border: InputBorder.none,
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
    ),
  );

  /// **话筒**（正方形圆角框；**一直在这一行的最右** —— 主人 2026-09-29 当场更正的那句；
  ///   正在录时框里是那几根**脉动的 bar**）。
  ///
  /// 按一下**开始听**、再按一下**结束**。
  /// 🔴 **"正在录"这个状态画在按钮自己身上**（原来是上面那行小字 `● 正在听`）：
  ///    那行小字因此撤掉（`_hearingStrip` 只剩"为什么停了"）；"正在听"那句话
  ///    仍挂在 tooltip / 无障碍名上（读屏照样听得到，D5.13 那条纪律不变）。
  /// ⚠️ `canHear` 假 ⇒ **照样画**，点下去说一句白话（`hearCantHere`）——
  ///    不装开麦、不进语音档、不出假字。
  Widget _micButton(DshPalette p) {
    final busy = widget.hearing.busy;
    return Tooltip(
      message: busy ? hearStop : hearStart,
      child: Material(
        // ★ 2026-09-29：**实底**（bar 是半透明的，它不许跟着透）＋ **正方形圆角框**
        color: p.bgLayer2,
        borderRadius: BorderRadius.circular(d.barButtonRadius),
        child: InkWell(
          onTap: () {
            if (!widget.canHear) {
              setState(() => _notice = hearCantHere);
              return;
            }
            setState(() => _notice = '');
            _toggleMic();
          },
          borderRadius: BorderRadius.circular(d.barButtonRadius),
          child: SizedBox(
            key: chatMicButtonKey,
            // 命中区 ≥44（D3.6）：方块本身就是 `barButtonBox`（比 44 大）
            width: d.barButtonBox,
            height: d.barButtonBox,
            child: Center(
              // 正在录 ⇒ **脉动的 bar**（不画话筒那个图形了）；否则画话筒
              child: busy
                  ? const RecPulse()
                  : Icon(Icons.mic_none, color: p.labelTertiary),
            ),
          ),
        ),
      ),
    );
  }

  /// **读出来**那个开关（设备级偏好，状态住上层）。
  Widget _speakerButton(DshPalette p) => IconButton(
    tooltip: widget.autoSpeak ? speakAutoHintOn : speakAutoHintOff,
    onPressed: () => widget.onToggleAutoSpeak?.call(!widget.autoSpeak),
    icon: Icon(
      widget.autoSpeak ? Icons.volume_up : Icons.volume_off_outlined,
      color: widget.autoSpeak ? p.stateBusiness : p.labelTertiary,
    ),
  );

  /// **发送**（主人 2026-09-24：*"聊天框右侧应该是一个发送按钮。一开始是灰色的。"*）。
  ///
  /// 🔴 它**一直在**（不再"有字才画"）：没字、或还在听/收尾中 ⇒ **灰的、按不动**。
  ///    ⚠️ 位置与大小**固定 48×48**：它要是一会儿有一会儿没有，框的宽度就会跳
  ///      —— 那是 D4.8 一种病（界面自己抖）。
  /// ⚠️ 只有这一小块跟着输入变（`ValueListenableBuilder`）—— **框本身不重建**。
  /// **「发送」**（主人 2026-09-29：*"发送按钮缩小一点，用琥珀色。文字写发送。"*
  ///   ＋ 同日更正 *"发送按钮在消息框里面。"*）。
  ///
  /// 🔴 四条：
  ///   · 它住**消息框里面**的最右（`_field` 的 suffix）；
  ///   · **一直在**（2026-09-24 那条原话："一开始是灰色的"）：没话要说 ⇒ 灰的、按不动
  ///     ⇒ 位置固定，界面不跳（D4.8）；
  ///   · 有话要说 ⇒ **琥珀色**（`d.amber` —— 从 app 那个图标里取的那一支）＋ **墨色**的字
  ///     （白字在琥珀上只有 ≈2:1，过不了手册 §8.3 那条 4.5:1）；
  ///   · **小一点**（`barSendWidth × barSendHeight`）—— ⚠️ 但**命中区仍 ≥44**（D3.6 硬闸）。
  ///
  /// ⚠️ 只有这一小块跟着输入变（`ValueListenableBuilder`）—— **框本身不重建**。
  Widget _sendButton(ThemeData theme, DshPalette p) => ValueListenableBuilder<TextEditingValue>(
    valueListenable: _controller,
    builder: (context, value, _) {
      // ⚠️ **正在听/收尾中按不动**：那会儿框里的字是"还在长"的半句，
      //    发出去就是替他做了决定（主人要的是"停下之后再决定发不发"）。
      final canSend = value.text.trim().isNotEmpty && !widget.hearing.busy;
      return Semantics(
        button: true,
        label: sendWords,
        enabled: canSend,
        child: FilledButton(
          key: chatSendKey,
          onPressed: canSend ? _submit : null,
          style: FilledButton.styleFrom(
            // 触控目标 ≥44（D3.6）：**高度不许低于 44**，"小一点"由宽度体现
            minimumSize: const Size(d.barSendWidth, d.barSendHeight),
            padding: const EdgeInsets.symmetric(horizontal: d.gapS),
            backgroundColor: d.amber,
            disabledBackgroundColor: p.borderL1,
            // ⚠️ 墨色的字（不是白字 —— 对比度，见上）
            foregroundColor: d.ink,
            disabledForegroundColor: p.labelCaption,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(d.barButtonRadius),
            ),
          ),
          child: const Text(sendWords),
        ),
      );
    },
  );

  /// **"为什么停了"那一行**（2026-09-29 起只剩这一件事）。
  ///
  /// 🔴 2026-09-24：原来它是一大块（"语音档"里那个卡片 + 大按钮），后来只剩一行；
  ///    **2026-09-29 起连"● 正在听"也没有了** —— 那个状态搬到**话筒那颗按钮上**
  ///    （框里那几根脉动的 bar，见 `_micButton` / `widgets/rec_pulse.dart`）。
  /// ⚠️ D5.13（"不录音时禁用『听』字"）一个字都没放宽：`hearListening`/`hearFinishing`
  ///    仍然只有那一个出处，而且只在 `hearing.listening` 为真时才挂到按钮上。
  Widget _hearingStrip(ThemeData theme, DshLook look) {
    final h = widget.hearing;
    final p = look.palette;
    // ★ 2026-09-29：**这一行自己也带一块实底** —— bar 现在是半透明的，
    //   而这行字是直接画在 bar 上的（红点 + "正在听" + 为什么停了）。
    //   不给它实底的话，它的对比度会**随着底下那张壁纸变**（手册 §8.3 那条
    //   "正文与底色 ≥ 4.5:1"就成了看运气）⇒ 与上面那条 `_noticeStrip` 同一种形状。
    // ★ 2026-09-29：**"正在听"那三个字撤掉了** —— 主人：*"正在录音，就放到录音按钮上"*
    //   ⇒ 那个状态现在画在**话筒那颗按钮自己身上**（框里那几根脉动的 bar）。
    //   ⚠️ 这一行剩下的只有**"为什么停了"**那句话（它是一句白话，不是状态指示）。
    //   ⚠️ `hearListening` / `hearFinishing` 这两个常量仍然有用（tooltip / 无障碍名），
    //      D5.13 那条"只在真的在听时才可以说在听"一个字都没放宽。
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Container(
        width: double.infinity,
        // ⚠️ 用 token（`P1-8` 那道棘轮不认数字字面量；这一条就是它教的）
        padding: const EdgeInsets.symmetric(horizontal: d.gapM, vertical: d.gapS),
        decoration: BoxDecoration(
          color: p.bgLayer2,
          borderRadius: BorderRadius.circular(d.radiusField),
          border: Border.all(color: p.borderL2),
        ),
        child: Row(
        children: [
          // **为什么停了**（原话，不再翻译一遍）
          Expanded(
            child: Text(
              h.notice,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(color: p.labelSecondary),
            ),
          ),
        ],
        ),
      ),
    );
  }
}
