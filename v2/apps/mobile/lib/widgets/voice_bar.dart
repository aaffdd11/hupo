// **聊天底下那一格：那颗圆圈 ＋ 它左边那个真输入框**（2026-10-07 推倒重来）。
//
// 主人 2026-10-07：*"我认为，原本的语音转文字全套方案都应该推倒重来，忘记我们要修正语义。
//   我们就是 stream 回来的文字输入到文本框等待发送。"*
//   ＋ 当天他定的三样：**按停就发** · 字**直接流进底下那个能改的真输入框** ·
//     设置里那屏「说一句试试」删掉。
//
// ── 这一格只画两样 ────────────────────────────────────────
//   ① **那颗圆圈**（右下角）：点一下开始录、再点一下停（`onMic`）；
//   ② **它左边那个输入框**：识别回来的字**直接长在里面**（`text`）——
//      而且它是个**真输入框**：他可以点进去改、可以混着打字（`onChanged`；
//      他一动手，控制器那边就不再让语音往框里写）。
//   ③ **开不了麦时**那条打字的退路（同名的那颗「打字」摊开这一格）。
//
// ⚠️ 空的时候**一个像素都不画**（主人 2026-10-04 定的：不摆空框、不摆提示）。
// ⚠️ 这一份**只负责画**：进来一份字、出去几个回调；状态在控制器那边。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/voice_words.dart';
import 'dsh_look.dart';
import 'listening_ripple.dart';
import 'rec_blink.dart';

/// 底下那一格。
class VoiceBar extends StatefulWidget {
  const VoiceBar({
    super.key,
    required this.text,
    required this.recording,
    required this.wrapping,
    required this.canHear,
    required this.onChanged,
    required this.onMic,
    required this.onSend,
    this.typingOpen = false,
    this.onKeyboardWanted,
    this.note = '',
    this.leading,
    this.hintAbove,
  });

  /// **框里现在该显示的字**（识别回来的 / 他打的 —— 由控制器算好送进来）。
  final String text;

  /// **正在录**（含他按了停、正等最后那一份字的那一小会儿）。
  final bool recording;

  /// **他按了停、正等最后那一份字**：那颗圆圈这一小会儿按不动、也不闪。
  final bool wrapping;

  /// 这台开得了麦吗（开不了 ⇒ 画打字的退路，**不画那颗圆圈**）。
  final bool canHear;

  /// **他一动这个框**（打字 / 改字）⇒ 控制器从此不让语音再往框里写。
  final ValueChanged<String> onChanged;

  /// 那颗圆圈：按一下开始录、再按一下停。
  final VoidCallback onMic;

  /// 打字那条兜底：按「发送」把它发出去。
  ///
  /// ⚠️ 语音那条**不走这一颗**（他定的是"按停就发"）。
  final ValueChanged<String> onSend;

  /// **如实说的那一句**（没听清 / 麦没打开…；空 = 没有）。
  final String note;

  /// 🔴 **外面那颗「键盘」（左下角）现在是不是把这一格摊开着**（主人 2026-10-09）。
  ///
  /// ⚠️ **单一出处在上层**（`chat_screen` 那颗按钮）：这一格不再自己决定"打字那条路"
  ///    开不开 —— 它只是**照着这个数**把框画出来 / 收回去（与那一颗的亮灯同一个来源）。
  final bool typingOpen;

  /// 这一格想让上层那颗「键盘」**开（`true`）/ 收（`false`）**。
  ///
  /// ⚠️ 三个地方会用到它：那颗「打字」、说话时那张卡片（"我要改"）、以及
  ///   **那一句发出去之后**（原来是"这一格自己收起来"，现在得请上层把按钮也熄掉 ——
  ///   不然屏幕上会留下"框收起来了、按钮还亮着"这种不一致）。
  final ValueChanged<bool>? onKeyboardWanted;

  /// 那一行最前面那颗（今天还是那颗 home）。
  final Widget? leading;

  /// 那颗圆圈上方偶尔飘一句（进屏提示那一类；不占排版）。
  final Widget? hintAbove;

  @override
  State<VoiceBar> createState() => _VoiceBarState();
}

class _VoiceBarState extends State<VoiceBar> {
  final _type = TextEditingController();

  /// 🔴 **那个真输入框的焦点**（2026-10-09）：那颗「键盘」按下去要**把键盘叫出来**
  ///    （不是只把框画出来）—— 而"收起"那一下要**把键盘收回去**（`unfocus`）。
  final _focus = FocusNode(debugLabel: 'voice-bar-type');

  /// 🔴 **他刚用那颗「键盘」把这一格收起了**（草稿还在，只是先不摆）。
  ///
  /// ⚠️ 为什么还要这一档：框的画不画原来只由"录着 / 摊着 / 有字"决定
  ///    ⇒ **有草稿时"收起"会收不掉**（框还赖在那儿）。这一档只由那颗按钮置位，
  ///    下一次"摊开"、开录、或来了新字就清掉。
  bool _collapsed = false;

  /// **打字那条路**要不要摊开 —— 🔴 **2026-10-09 起它就是上层那个数**（那颗「键盘」）。
  bool get _typing => widget.typingOpen;

  /// 🔴 **现在这一格是"看"还是"改"**（2026-10-07 主人：*"所谓断句就是说着说着，
  ///   转文字的早期的那部分内容在输入框里没了。"*）。
  ///
  /// 量的读数：那个框只有 **4 行高**（`maxLines: 4`），字一多、光标又在末尾
  /// ⇒ 它会**把前面那几行卷出框外**（他看见的就是"早期那部分没了"；字其实一个没丢）。
  /// ⇒ 说话的时候**固定给他看开头**（一张**不会滚**的卡片，末尾省略号）；
  ///   **点一下**它才变成真输入框（跟着光标走 —— 那是他要改字的时候）。
  bool _editing = false;

  @override
  void initState() {
    super.initState();
    if (widget.text.isNotEmpty) _put(widget.text);
    // 一上来就摊着（比如上层记着它是开的）⇒ 把键盘也叫出来。
    if (widget.typingOpen) {
      _editing = true;
      _focusNow();
    }
  }

  @override
  void didUpdateWidget(covariant VoiceBar old) {
    super.didUpdateWidget(old);
    // 每一场**从"看"那一档开始**（说的时候不用他先点一下）；开录 ⇒ 收起那一档清掉
    if (widget.recording && !old.recording) {
      _editing = false;
      _collapsed = false;
    }
    // 那一份字发出去（清空）之后 ⇒ **回到"什么都没画"**（不许留一个空框在那儿）；
    // ⚠️ 只在"原来有字"的时候收：他按「打字」摊开的那一格（本来就没字）不许被收掉。
    if (!widget.recording && widget.text.isEmpty && old.text.isNotEmpty) {
      _editing = false;
      _collapsed = false;
      // 🔴 那一句已经发出去了 ⇒ 请上层**把那颗「键盘」也熄掉**（这一格原来自己收，
      //    现在开关住上层 ⇒ 不请它熄，屏幕上就留下"框没了、按钮还亮着"）。
      //    ⚠️ **排到下一帧**：这几句跑在 `didUpdateWidget` 里（build 中间），
      //    当场喊一声会变成"build 期间 setState"。
      _wantedSoon(false);
    }
    // 🔴 外面那份字变了（语音在长字 / 那份草稿异步读回来了）⇒ 写进框里。
    //    ⚠️ **只在与框里真的不一样时才写**：他每敲一下，控制器都会把同一个字
    //       再送回来一次 —— 无脑写会把光标每一下都推到末尾（打字就没法打了）。
    if (widget.text != old.text && widget.text != _type.text) {
      _put(widget.text);
      _collapsed = false; // 来了新字 ⇒ 一律摆出来（收起那一档只压得住"刚才那一份"）
    }
    // 🔴 **那颗「键盘」被按了**（主人 2026-10-09）：摊开 ⇒ 画框 ＋ 叫出键盘；收起 ⇒ 反过来。
    if (widget.typingOpen != old.typingOpen) {
      if (widget.typingOpen) {
        _collapsed = false;
        _editing = true;
        _focusNow();
      } else {
        _collapsed = true;
        _focus.unfocus();
      }
    }
  }

  /// 把焦点（＝键盘）叫出来。⚠️ 排在**下一帧**：这一帧那颗按钮自己还在树上。
  void _focusNow() => WidgetsBinding.instance.addPostFrameCallback((_) {
    if (mounted) _focus.requestFocus();
  });

  /// 请上层把那一颗开 / 收 —— ⚠️ 也排在**下一帧**（调用点可能正在 build 中间）。
  void _wantedSoon(bool open) => WidgetsBinding.instance.addPostFrameCallback((_) {
    if (mounted) widget.onKeyboardWanted?.call(open);
  });

  /// 把 [text] 写进框里，光标放到末尾。
  void _put(String text) {
    _type.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
  }

  @override
  void dispose() {
    _focus.dispose();
    _type.dispose();
    super.dispose();
  }

  /// **那颗圆圈现在是不是在录**（`wrapping` 那一档不算 —— 那会儿按了也没用）。
  bool get _listening => widget.recording && !widget.wrapping;

  /// 这一格要不要画出来（空 ⇒ 什么都不画）。
  ///
  /// ⚠️ `_collapsed` 压的是"摊着 / 有草稿"那两档 —— **录着那一档不受它影响**
  ///   （正说着的时候不许被一个收起动作把字藏起来）。
  bool get _showField =>
      widget.recording || ((_typing || widget.text.isNotEmpty) && !_collapsed);

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final look = DshLook.of(context);
    // 没有字的时候框里那句提示：正在录 ⇒ 说清它在听（或正在收尾）；
    // 其余 ⇒ **开得了麦的那一台**说"打一句吧"（他是按了那颗「键盘」才摆出这个框的），
    //        开不了麦的那一台才说"这台开不了麦……"（⚠️ 反过来就是屏幕在说假话）。
    final hint = widget.recording
        ? (widget.wrapping ? voiceWrappingLead : voiceListeningLead)
        : (widget.canHear ? voiceTypeHereLead : voiceTypeInstead);
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
              //
              // 🔴 **2026-10-07 主人**：*"这句没听清楚，再说一遍不要放在上方。也要放在
              //   按钮左侧。同时也是有白色底的。"* ⇒ 那句如实说的话（没听清 / 麦没打开…）
              //   **跟字一个位置**：按钮左边、**白底那张小卡片**（原来它是挂在上面的一行字）。
              //   ⚠️ 它与那个框**同时在**的时候（比如说到一半对面断了）就并排：
              //      **框在左、那句在右**（都在按钮左边）。
              Expanded(
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    if (_showField)
                      Flexible(
                        child: (widget.recording && !_editing)
                            ? _liveCard(look, hint)
                            : _field(look, hint),
                      ),
                    if (widget.note.trim().isNotEmpty) ...[
                      if (_showField) const SizedBox(width: d.gapS),
                      Flexible(child: _noteCard(look)),
                    ],
                  ],
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

  /// **说话时那一份字**：一张**不会滚**的卡片 —— **从头显示**，长了就末尾省略。
  ///
  /// 🔴 为什么不用那个真输入框显示：它 4 行高、又跟着光标走 ⇒ 字一多就把**前面那几行
  ///    卷出框外**（主人报的"早期那部分内容在输入框里没了"就是这个）。
  ///    ⇒ 这一档**只负责看**；**点一下**才换成 [TextEditingController] 那个真输入框。
  Widget _liveCard(DshLook look, String hint) {
    final said = widget.text.trim();
    // ⚠️ **用真按钮，不用裸的 `GestureDetector`**（可访问性那道硬闸钉着这件事：
    //    自己写的点击区必须**被"命中区 ≥44"那条扫描覆盖**）⇒ `TextButton` ＋ 最小 44 高。
    return TextButton(
      // 点它 = "我要改" ⇒ 换成真输入框（光标放到末尾，好接着打）
      onPressed: () {
        setState(() {
          _editing = true;
          _collapsed = false;
          _put(widget.text);
        });
        // 🔴 这一下也是"把键盘叫出来"（那颗按钮的状态**只有上层一处**）
        if (!widget.typingOpen) widget.onKeyboardWanted?.call(true);
        _focusNow();
      },
      style: TextButton.styleFrom(
        padding: EdgeInsets.zero,
        minimumSize: const Size(0, 44),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(d.radiusField)),
      ),
      child: Container(
        key: voiceBarLiveKey,
        constraints: const BoxConstraints(maxWidth: 420),
        padding: const EdgeInsets.symmetric(horizontal: d.gapM, vertical: d.gapS),
        decoration: BoxDecoration(
          color: d.card,
          borderRadius: BorderRadius.circular(d.radiusField),
          border: Border.all(color: d.line),
        ),
        child: Text(
          said.isEmpty ? hint : said,
          textAlign: TextAlign.right,
          maxLines: 6,
          // 🔴 **末尾**省略（不是开头）：他要在这一格里看到"我说的前几句都在"
          overflow: TextOverflow.ellipsis,
          style: dshTextStyle(look.content, said.isEmpty ? d.muted : d.ink),
        ),
      ),
    );
  }

  /// **如实说的那一句**（没听清 / 麦没打开…）：按钮左边那张**白底卡片**。
  ///
  /// ⚠️ 底用**这张纸的白**（`d.card`）＋ 一圈细线 —— 与时间线上别的卡片、以及
  ///    底下那一行原来那颗气泡**同一个样子**（他要的"白色底"）。
  Widget _noteCard(DshLook look) => Container(
        key: voiceBarNoteKey,
        constraints: const BoxConstraints(maxWidth: 420),
        padding: const EdgeInsets.symmetric(horizontal: d.gapM, vertical: d.gapS),
        decoration: BoxDecoration(
          color: d.card,
          borderRadius: BorderRadius.circular(d.radiusField),
          border: Border.all(color: d.line),
        ),
        child: Text(
          widget.note,
          textAlign: TextAlign.right,
          maxLines: 4,
          overflow: TextOverflow.ellipsis,
          // ★ 这一行字**跟用户那条字号轴**（与时间线正文同一档）—— 与那个框里那份字同一个道理。
          style: dshTextStyle(look.content, d.ink),
        ),
      );

  /// **那个真输入框**：识别回来的字长在里面，他也可以动手改。
  ///
  /// ⚠️ **不 autofocus**：一按录就弹键盘会挡住半个屏幕（他要的是"看着字长出来"）。
  Widget _field(DshLook look, String hint) => Row(
        children: [
          Expanded(
            child: TextField(
              key: voiceBarTypeKey,
              controller: _type,
              // ★ 2026-10-09：那颗「键盘」要能把键盘叫出来 / 收回去 ⇒ 焦点得握在这儿。
              focusNode: _focus,
              minLines: 1,
              maxLines: 4,
              // ★ 这一格的字**跟用户那条字号轴**（与时间线正文同一档）——
              //   它属于"会话内容"，不是工具行那种小字（`docs/dev/194`）。
              style: dshTextStyle(look.content, d.ink),
              decoration: InputDecoration(hintText: hint),
              onChanged: (v) {
                // ⚠️ **他动手了**：这一格从此归他（控制器那边不再让语音往这儿写）；
                //    而且如果刚才它是"因为有草稿才画出来的"，请上层把那颗键盘点亮
                //    （不然屏幕上会出现"框开着、按钮却写着「打开键盘」"这种不一致）。
                if (!_typing) widget.onKeyboardWanted?.call(true);
                widget.onChanged(v);
              },
            ),
          ),
          // 打字那条兜底才有这颗「发送」（语音那条**按停就发**）
          if (!widget.recording && widget.text.trim().isNotEmpty) ...[
            const SizedBox(width: d.gapS),
            FilledButton(
              key: voiceBarTypedSendKey,
              onPressed: () => widget.onSend(_type.text),
              child: const Text(voiceSendWords),
            ),
          ],
        ],
      );

  /// 那颗圆圈：**全局最显眼的一颗**（它服务的是打不了字、眼神不好的人）。
  ///
  /// 🔴 **2026-10-05：在录的时候它是"一明一暗"地闪的**（主人：*"录音按钮在激活的时候，
  ///    要有一个循环的效果，就是颜色一明一暗的闪烁。"*）—— 亮的那个值由 [RecBlink] 给，
  ///    这一层只负责把它画成底色（**尺寸/位置/命中区一个像素都不动**）。
  Widget _circle(ThemeData t) => Semantics(
        button: true,
        label: _listening ? voiceStopLabel : voiceTalkLabel,
        child: SizedBox(
          key: voiceBarCircleKey,
          width: d.voiceCircleBox,
          height: d.voiceCircleBox,
          // ★ **2026-10-07**：在听的时候，圆圈外面**一圈一圈荡开**（只说"在听"；
          //   尺寸/位置/命中区一个像素都不动 —— 它是画在圈外的一层，`Clip.none`）。
          child: Stack(
            // 🔴 **`fit: expand` 不能少**（2026-10-07 主人：*"语音按钮的那个圈也变小了，
            //   这个变得非常的丑"*）：`Stack` 默认是 `loose` ⇒ 里面那层 `Material`
            //   会**缩到图标那么大**（30），那颗圈就不再是 64 —— 这是我上一刀改坏的地方。
            //   ⇒ 撑满这一格（64×64），与改之前一个像素都不差。
            fit: StackFit.expand,
            clipBehavior: Clip.none,
            alignment: Alignment.center,
            children: [
              Positioned.fill(child: ListeningRipple(on: _listening)),
              RecBlink(
                on: _listening,
                builder: (context, glow) {
                  // 收尾中：**这颗圆圈这一小会儿没有可做的事**
                  //   ⇒ 画成"淡淡的、按不动"的样子（诚实：按了也没用），
                  //     而**不是**继续闪着"我在录"（那正是他报的那个"慢"）。
                  final busy = widget.wrapping;
                  final on = _listening;
                  return Material(
                    // ★ **白底**（主人 2026-10-06 当天最后定的：*"现在把白色底加上"*）
                    color: on ? recBlinkColor(glow) : d.card,
                    shape: CircleBorder(side: BorderSide(color: d.accent, width: d.voiceCircleRing)),
                    child: InkWell(
                      customBorder: const CircleBorder(),
                      onTap: busy ? null : widget.onMic,
                      child: Icon(
                        on ? Icons.stop_rounded : Icons.mic_none_rounded,
                        size: d.voiceCircleIcon,
                        color: on
                            ? d.card
                            : (busy ? d.muted : d.ink),
                      ),
                    ),
                  );
                },
              ),
            ],
          ),
        ),
      );

  /// **开不了麦**时，圆圈那个位置那颗「打字」（按一下 ⇒ 请上层把那颗「键盘」打开）。
  Widget _typeChip(ThemeData t) => TextButton(
        key: voiceBarTypeChipKey,
        onPressed: widget.onKeyboardWanted == null ? null : () => widget.onKeyboardWanted!(true),
        child: const Text('打字'),
      );
}

/// 那个圆圈（判据要按它）。
const Key voiceBarCircleKey = ValueKey<String>('voice-bar-circle');

/// 那格输入框（打字那条退路，也是语音的字落下来的地方）。
const Key voiceBarTypeKey = ValueKey<String>('voice-bar-type');

/// **说话时那一份字**那张卡片（判据量它：从头显示、不会滚）。
const Key voiceBarLiveKey = ValueKey<String>('voice-bar-live');

/// **如实说的那一句**（没听清 / 麦没打开…）那张白底卡片（判据量它的位置与底色）。
const Key voiceBarNoteKey = ValueKey<String>('voice-bar-note');

/// 打字那条退路那颗「发送」。
const Key voiceBarTypedSendKey = ValueKey<String>('voice-bar-typed-send');

/// 开不了麦时那颗「打字」（按一下才摊开输入格）。
const Key voiceBarTypeChipKey = ValueKey<String>('voice-bar-type-chip');
