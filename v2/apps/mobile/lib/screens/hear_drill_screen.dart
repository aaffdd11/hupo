// **"说一句试试"那一屏**（V2.0 第一件 · 主人 2026-10-04）。
//
// 它住在**设置**里，是**演练**：整条链子走一遍 ——
//   按一下麦 → 说一句 → 听成字 → **先由那一层读懂** → 不确定就**用话说一句 + 写成字**问他 →
//   他答 → 再读懂 → 差不多了 ⇒ **最终那一份**摆出来。
//
// 🔴 **走到最后也不发**：这一屏**没有一处**会去按"发送"（判据
//    `test/widget/hear_drill_test.dart` 量的就是"整场一次 `/api/say` 都没有"）。
//    主人要的就是这个：**先把这套东西演一遍，看看顺不顺**。
//
// ⚠️ 复用现成的东西，不另造：听写走 `controller.hearOnce`（聊天那颗话筒同一条路）、
//    语音那一步的状态机是 `models/hearing_session.dart`、这一场的状态机是
//    `models/hear_drill.dart`（纯的，判据打在它身上）。

import 'dart:async';

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/hear_drill.dart';
import '../models/hear_words.dart';
import '../services/chat_controller.dart';
import '../services/speech.dart' as speech;

/// 那一屏。
class HearDrillScreen extends StatefulWidget {
  const HearDrillScreen({super.key, required this.controller});

  final ChatController controller;

  @override
  State<HearDrillScreen> createState() => _HearDrillScreenState();
}

class _HearDrillScreenState extends State<HearDrillScreen> {
  HearDrill _drill = const HearDrill();

  /// 打字兜底那一格（**开不了麦**的机器上才有；或者他要改一个字）。
  final TextEditingController _type = TextEditingController();

  /// 这一场跑到哪儿了（防重入：正在问那一层的时候不许再按）。
  bool _busy = false;

  @override
  void dispose() {
    widget.controller.stopHearingNow();
    speech.stopSpeaking();
    _type.dispose();
    super.dispose();
  }

  ChatController get _c => widget.controller;

  void _set(HearDrill next) {
    if (!mounted) return;
    setState(() => _drill = next);
  }

  /// 按一下那颗麦：没在听 ⇒ 开麦；在听 ⇒ 收手（说完这一句）。
  Future<void> _tapMic() async {
    if (_busy) return;
    if (_drill.hearing.listening) {
      _c.stopHearingNow();
      return;
    }
    _set(_drill.startListening());
    final why = await _c.hearOnce((e) {
      final before = _drill;
      final after = _drill.event(e);
      _set(after);
      // 他这一段说完了（`asr/end`）⇒ 该送进听懂那一层了（`thinking` 就是那个信号）
      if (before.phase != DrillPhase.thinking && after.phase == DrillPhase.thinking) {
        unawaited(_think());
      }
    });
    if (why != null) {
      _c.stopHearingNow();
      _set(_drill.micFailed(_micReason(why)));
    }
  }

  /// 开麦那一步失败的理由（**机器原因翻成人话**；认不出的就说"没打开"）。
  String _micReason(String why) {
    switch (why) {
      case 'denied':
        return '麦克风没给权限，先允许一下。';
      case 'not-configured':
        return '这台还没配听懂你说话的那把钥匙。';
      case 'unsupported':
        return '这台开不了麦。';
      default:
        return '麦没打开，等下再试。';
    }
  }

  /// 把这一份送进听懂那一层（**一次请求 = 问一遍**；最多两轮）。
  Future<void> _think() async {
    if (_busy) return;
    final token = _c.token;
    final payload = _drill.payload();
    final said = (payload['text'] as String?) ?? '';
    if (token == null || said.isEmpty) {
      _set(_drill.heardBack(ok: false, note: hearDrillNothing));
      return;
    }
    setState(() => _busy = true);
    final history = (payload['history'] as List?)?.cast<Map<String, String>>() ?? const <Map<String, String>>[];
    final got = await _c.api.hear(token, said, history: history);
    if (!mounted) return;
    setState(() => _busy = false);
    if (!got.ok) {
      _set(_drill.heardBack(ok: false, note: got.error ?? hearDrillNoRoad));
      return;
    }
    final next = _drill.heardBack(ok: true, heard: got.heard!, ask: got.ask);
    _set(next);
    // ★ 问回去那一下：**用话说一遍**（念得出来才念）+ 屏幕上一直有字
    if (next.phase == DrillPhase.asking) {
      final ok = speech.speakAloud(next.question);
      if (!ok) setState(() {}); // 念不出来 ⇒ 屏幕上那句"这台还念不出来"要出来
    }
  }

  /// 他答了一句 / 说了第一句（**打字那条兜底路**；麦克风那条走 `_tapMic` → `event`）。
  Future<void> _answer(String text) async {
    final a = text.trim();
    if (a.isEmpty) return;
    _set(_drill.utterance(a));
    _type.clear();
    await _think();
  }

  @override
  Widget build(BuildContext context) {
    final canHear = _c.canHear;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 640),
        child: ListView(
          padding: const EdgeInsets.symmetric(horizontal: d.gapL, vertical: d.gapL),
          children: [
            Text(hearDrillTitle, style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: d.gapS),
            // 🔴 **先把"不会发出去"说清**（这一屏最要紧的一句）
            Container(
              padding: const EdgeInsets.all(d.gapM),
              decoration: BoxDecoration(
                color: d.card,
                borderRadius: BorderRadius.circular(d.radiusField),
                border: Border.all(color: d.line),
              ),
              child: const Text(hearDrillBanner),
            ),
            const SizedBox(height: d.gapL),
            ..._body(canHear),
          ],
        ),
      ),
    );
  }

  List<Widget> _body(bool canHear) {
    final rows = <Widget>[];
    // ① 这一句现在听成什么了（**半句也显示** —— "在长字"是这一屏的一半）
    final said = _drill.said;
    if (said.isNotEmpty) {
      rows.add(_card(hearDrillHeardLabel, said));
      rows.add(const SizedBox(height: d.gapM));
    }
    // ② 现在的状态那一句
    rows.add(Text(_lead(), style: Theme.of(context).textTheme.bodyLarge));
    // ③ 它在问的那一句（问的话在下面，字与声音一起）
    if (_drill.phase == DrillPhase.asking && _drill.question.isNotEmpty) {
      rows.add(const SizedBox(height: d.gapS));
      rows.add(_card('', _drill.question));
      if (!speech.canSpeak) {
        rows.add(const Padding(
          padding: EdgeInsets.only(top: d.gapXs),
          child: Text(hearDrillNoVoice),
        ));
      }
    }
    // ④ 最终那一份（**演练就停在这儿**）
    if (_drill.phase == DrillPhase.ready && _drill.finalText.isNotEmpty) {
      rows.add(const SizedBox(height: d.gapS));
      rows.add(Text(hearDrillReadyLead));
      rows.add(const SizedBox(height: d.gapXs));
      rows.add(_card('', _drill.finalText));
      rows.add(const Padding(
        padding: EdgeInsets.only(top: d.gapXs),
        child: Text(hearDrillReadyFoot),
      ));
      if (!_drill.canAskMore && _drill.heard.isNotEmpty) {
        rows.add(const Padding(
          padding: EdgeInsets.only(top: d.gapXs),
          child: Text(hearDrillRoundCap),
        ));
      }
      rows.add(const SizedBox(height: d.gapM));
      rows.add(
        OutlinedButton(
          onPressed: () => _set(_drill.again()),
          child: const Text(hearDrillAgain),
        ),
      );
      return rows;
    }
    // ⑤ 如实说的那一句（没听清 / 那边没答上来）
    if (_drill.note.isNotEmpty) {
      rows.add(const SizedBox(height: d.gapS));
      rows.add(Text(_drill.note));
    }
    if (_drill.phase == DrillPhase.failed) {
      rows.add(const SizedBox(height: d.gapM));
      rows.add(
        OutlinedButton(
          onPressed: () => _set(_drill.again()),
          child: const Text(hearDrillAgain),
        ),
      );
    }
    // ⑥ 那颗麦（**开不了麦就不画** —— 屏幕上不许出现按不动的东西）
    if (canHear && _drill.phase != DrillPhase.thinking) {
      rows.add(const SizedBox(height: d.gapL));
      rows.add(
        Center(
          child: SizedBox(
            width: d.barButtonBox,
            height: d.barButtonBox,
            child: Material(
              color: d.card,
              shape: const CircleBorder(),
              child: IconButton(
                key: hearDrillMicKey,
                iconSize: 34,
                onPressed: _busy ? null : _tapMic,
                icon: Icon(
                  _drill.hearing.listening ? Icons.stop_circle_outlined : Icons.mic_none_outlined,
                ),
                tooltip: _drill.hearing.listening ? '说完了' : '按一下说',
              ),
            ),
          ),
        ),
      );
    }
    // ⑦ **打字兜底**：开不了麦的机器上有这一格（他要答一句，也得答得出来）
    if (_drill.phase == DrillPhase.asking || (!canHear && _drill.phase != DrillPhase.ready)) {
      rows.add(const SizedBox(height: d.gapM));
      if (!canHear) {
        rows.add(const Padding(
          padding: EdgeInsets.only(bottom: d.gapXs),
          child: Text(hearDrillTypeInstead),
        ));
      }
      rows.add(
        Row(
          children: [
            Expanded(
              child: TextField(
                key: hearDrillTypeKey,
                controller: _type,
                decoration: const InputDecoration(hintText: '说点什么'),
                onSubmitted: (v) => unawaited(_answer(v)),
              ),
            ),
            const SizedBox(width: d.gapS),
            FilledButton(
              key: hearDrillAnswerKey,
              // ⚠️ 按阶段分岔：**在问** ⇒ 这是"我答的那一句"；
              //    还没开始（开不了麦的机器）⇒ 这就是**他说的第一句**。
              onPressed: _busy
                  ? null
                  : () {
                      // 两条路都走 `_answer`（它就是 `utterance` ＋ 问那一层）
                      unawaited(_answer(_type.text));
                    },
              child: const Text(hearDrillAnswer),
            ),
          ],
        ),
      );
    }
    return rows;
  }

  String _lead() {
    if (_drill.phase == DrillPhase.listening) return hearDrillListeningLead;
    if (_drill.phase == DrillPhase.thinking) return hearDrillThinkingLead;
    if (_drill.phase == DrillPhase.asking) return hearDrillAskingLead;
    if (_drill.phase == DrillPhase.failed && _drill.note.isEmpty) return hearDrillFailedLead;
    return hearDrillIdleLead;
  }

  Widget _card(String label, String text) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(d.gapM),
        decoration: BoxDecoration(
          color: d.card,
          borderRadius: BorderRadius.circular(d.radiusField),
          border: Border.all(color: d.line),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (label.isNotEmpty) ...[
              Text(label, style: Theme.of(context).textTheme.bodySmall),
              const SizedBox(height: d.gapXs),
            ],
            Text(text, style: Theme.of(context).textTheme.bodyLarge),
          ],
        ),
      );
}

/// 那颗麦（判据要按它）。
const Key hearDrillMicKey = ValueKey<String>('hear-drill-mic');

/// 打字兜底那一格 / 那颗「就这句」。
const Key hearDrillTypeKey = ValueKey<String>('hear-drill-type');
const Key hearDrillAnswerKey = ValueKey<String>('hear-drill-answer');
