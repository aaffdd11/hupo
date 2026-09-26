// **试一下**（配置页「语音」那一屏里那一块 · 批 7 · 契约 `docs/dev/123-VOICE-TEST-BUTTON.md`）。
//
// ── 为什么要有它 ──────────────────────────────────────────
//   主人 2026-09-26：*"配置页，语音配置上，增加一个测试按钮，点击后会录音，
//   会转文字，并写入一个文本框。"*
//   填了那三样之后，他得**当场知道这把钥匙到底能不能听** —— 不然就是
//   "填了一个不知道有没有用的东西"（与图片那一屏的「试一张」同一条理由）。
//
// ── 六条规矩 ──────────────────────────────────────────────
//   1. 🔴 **只有一条录音路**：开麦/收手就是 `services/hearing.dart` 那两个函数
//      （由上层注入成 [VoiceTryHandlers]）—— 这里**不自己碰麦克风**，
//      也不自己拼地址（地址归 `stream_uri.dart`）。
//   2. 🔴 **实话实说、一次一个原因**：没配 / 没权限 / 连不上 / 没额度 /
//      没听到 / 读不懂 —— 每一档都有自己那句话，**绝不静默**（`voice_try.dart`）。
//   3. 🔴 **一次按下去＝一场录音**（主人 2026-09-26：*"点一下进入录音，
//      再点一下结束录音。"*）：引擎在停顿处把一段说完（`asr/end`）**不许**把这一场
//      结束掉 —— 这一块**自己开下一轮**接着听，字**接在后面长**；
//      只有**他再按一下**才收场。⇒ 见 `_openRound` 与 [VoiceTryStep.openNextRound]。
//      ⚠️ 开不起来（下一轮没接上）⇒ **说明白并收场**，绝不假装还在录。
//   4. 🔴 **字只落在一个框里**：听的时候半句实时往框里长，停下之后定稿落进去；
//      框里的字**可以选、可以复制**（他自己决定拿去干什么）。
//   5. **他不许被覆盖**：他自己动过那个框（而且已经不在听了）⇒ 迟到的定稿**不再覆盖**。
//   6. **尺寸跟字算**：按钮命中区 ≥44；字放到最大也不许溢出（那是硬闸 D3.5/D3.6）。
//
// ⚠️ 界面上**没有**内部词（`AGENTS.md` §六 第 4 条；词表硬闸会拦）。
//    "在听"那三个字只在**真的在听**时画，而且只有一个合法出处（`hearListening`，D5.13）。

import 'dart:async';

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/hearing_session.dart';
import '../models/hearing_words.dart';
import '../models/voice_try.dart';

class VoiceTry extends StatefulWidget {
  const VoiceTry({
    super.key,
    required this.handlers,
    this.hasOwn = false,
    this.canHear = true,
  });

  /// 开麦 / 收手那两个动作（真实现在 `services/hearing.dart`）。
  final VoiceTryHandlers handlers;

  /// **上面那三样填过没有**（服务端说的）。只影响"没配好"那一句怎么说
  /// —— 一个让他去填，一个让他等接好。
  final bool hasOwn;

  /// 这个页面**开得了麦吗**（`services/hearing.dart` 的 `canHear`）。
  /// ⚠️ 假 ⇒ **照样画按钮**，点下去说一句白话（`hearCantHere`）——
  ///    藏起来等于让他自己猜（2026-09-23 主人问过"为什么录音的 icon 没有"）。
  final bool canHear;

  @override
  State<VoiceTry> createState() => _VoiceTryState();
}

class _VoiceTryState extends State<VoiceTry> {
  /// 那个文本框：**认出来的字就住在这儿**。
  final _box = TextEditingController();

  /// 语音那一步的状态（**与聊天那颗话筒同一个状态机**，见 `voice_try.dart` 抬头）。
  Hearing _h = const Hearing();

  /// 上一次**由语音写进框里**的那份字。
  /// ⚠️ 有了它才敢在"他自己动过手"之后不再覆盖（收尾那句回来得比他的手慢）。
  String _mirror = '';

  /// **正在开某一轮**（第一次按下去、或者引擎说完一段之后自己接着开的那一轮）。
  /// ⚠️ 防两条同时开：真那一侧 `startHearing` 自己会 `_closeAll`，但这里先拦住更干净。
  bool _opening = false;

  /// **用户按了停**（这一场到此为止）：这之后**不许再自动开下一轮**。
  /// ⚠️ 它与 `_opening` 一起处理那个竞态：按停的那一下刚好有一轮在路上。
  bool _closing = false;

  @override
  void dispose() {
    // ⚠️ **走开的时候如果还在听 ⇒ 把麦关掉**（切到别的 tab / 关掉这一屏）。
    //    与聊天那颗话筒不同：这一块没有一个"一直在"的位置提醒他还在录 ——
    //    留着它就会一直采到服务端那个到点为止（他什么都看不见）。
    if (_h.busy) widget.handlers.stop();
    _box.dispose();
    super.dispose();
  }

  /// 收下一帧 ⇒ 更新状态、并把字写进框里。
  ///
  /// 🔴 引擎把这一轮说完了（`openNextRound`）⇒ **自己把下一轮开起来**：
  ///    这一场录音还没完，框里的字接在后面长（见 `voiceTry.dart` 的 [voiceTryStep]）。
  void _frame(Map<String, dynamic> e) {
    if (!mounted) return;
    final step = voiceTryStep(_h, e);
    _apply(step.heard);
    if (step.openNextRound) unawaited(_openRound());
  }

  void _apply(Hearing next) {
    setState(() {
      _h = next;
      _write(_h.text);
    });
  }

  /// 把语音那一边现在的字写进框里。
  ///
  /// 🔴 两条（与输入条那条同源）：
  ///   ① **没变就不写**（免得把光标/选择弹回末尾 —— 他要选、要复制）；
  ///   ② 他自己动过手（框里的字 ≠ 我上次写进去的那份）而且**已经不在听了**
  ///      ⇒ **不再覆盖**（收尾那句回来得比他的手指慢）。
  void _write(String text) {
    if (text == _mirror) return;
    if (!_h.busy && _box.text.isNotEmpty && _box.text != _mirror) return;
    _mirror = text;
    _box.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
  }

  /// **开一轮**（第一次按下去是它；引擎说完一段之后接着开的也是它）。
  ///
  /// 🔴 开不起来（返回一句机器原因）⇒ **说明白、收场** —— 绝不假装还在录；
  ///    已经听到的字**一个都不丢**（`Hearing.broke` 那条纪律）。
  Future<void> _openRound() async {
    if (_opening) return;
    _opening = true;
    final why = await widget.handlers.start(_frame);
    _opening = false;
    if (!mounted) return;
    if (why != null) {
      setState(() => _h = _h.broke(why));
      return;
    }
    // ⚠️ 开这一轮的过程中用户按了停 ⇒ 把刚开起来的这一轮**立刻交回去**
    //    （不然麦克风会留在手里，而他以为已经停了）。
    if (_closing) widget.handlers.stop();
  }

  /// **按了一下**（开始 / 结束都由当前状态决定）。
  Future<void> _toggle() async {
    if (_h.busy) {
      // 在听 ⇒ **这一场到此为止**：关麦、等最后一句（`Hearing.tapped` 进 finishing）。
      // ⚠️ 从这一下起**不再自动开下一轮**（`_closing`）。
      _closing = true;
      widget.handlers.stop();
      setState(() => _h = _h.tapped());
      return;
    }
    if (!widget.canHear) {
      // 这里开不了麦：**如实说**（不装开麦、不出假字）
      _apply(const Hearing(phase: HearingPhase.denied, why: hearCantHere));
      return;
    }
    // 新的一场是新的内容：上一次那些字清掉（与聊天那颗话筒同一条）
    _closing = false;
    _mirror = '';
    setState(() {
      _h = _h.tapped();
      _box.clear();
    });
    await _openRound();
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final listening = _h.phase == HearingPhase.listening;
    final finishing = _h.phase == HearingPhase.finishing;
    final notice = voiceTryNotice(_h, hasOwn: widget.hasOwn);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Divider(height: d.gapL),
        Text(
          voiceTryTitle,
          style: t.textTheme.titleSmall?.copyWith(color: d.ink, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: d.gapXs),
        Text(voiceTryHint, style: t.textTheme.bodySmall?.copyWith(color: d.muted)),
        const SizedBox(height: d.gapS),
        FilledButton(
          // ⚠️ 收尾中按不动（那会儿就是"等最后一句"，按它没有意义）——
          //    其余时候**一直在**（按不动的不许摆出来 vs 这一档是"做得到但已经到头了"，
          //    同 `_appearanceCard` 那个步进器）。
          onPressed: finishing ? null : _toggle,
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
          child: Text(voiceTryButton(_h)),
        ),
        // **在听 / 收尾中**那一条：红点 + 那几个字（**只在真的在听/收尾时画**，D5.13）。
        if (_h.busy) ...[
          const SizedBox(height: d.gapXs),
          Row(
            children: [
              Text(
                '●',
                style: t.textTheme.labelSmall?.copyWith(
                  color: listening ? t.colorScheme.error : d.muted,
                ),
              ),
              const SizedBox(width: d.gapXs),
              Expanded(
                child: Text(
                  listening ? hearListening : hearFinishing,
                  style: t.textTheme.labelSmall?.copyWith(
                    color: listening ? t.colorScheme.error : d.muted,
                  ),
                ),
              ),
            ],
          ),
        ],
        const SizedBox(height: d.gapS),
        // 🔴 **认出来的字落在这儿**：**真的文本框**（能选、能复制 —— 主人要的就是它）。
        // ⚠️ 空着的时候**标签照挂**（"空但有标签"）；一个字都不许编。
        TextField(
          controller: _box,
          minLines: 2,
          maxLines: 4,
          autocorrect: false,
          decoration: const InputDecoration(
            labelText: voiceTryBoxLabel,
            border: OutlineInputBorder(),
          ),
        ),
        if (notice.isNotEmpty) ...[
          const SizedBox(height: d.gapXs),
          Text(
            notice,
            style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.error),
            textAlign: TextAlign.center,
          ),
        ],
      ],
    );
  }
}
