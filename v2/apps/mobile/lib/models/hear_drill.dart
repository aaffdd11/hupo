// **"说一句试试"那一场演练的状态机**（纯的：进事件、出状态）。
//
// V2.0 第一件（主人 2026-10-04）：*"把输入框抽离出来……有一个 AI 会去理解这个文本是什么意思……
// 这个 AI 的目的是完善这个文本，完善完文本以后，他觉得 ok 了，他就会输入到文本框里面，
// 并且自动发送；如果不 ok，他就会询问用户……不要吹毛求疵……"*
//
// ⚠️ 纯逻辑 ⇒ 进 `test/unit`（`test/unit/hear_drill_test.dart`）。
//    界面那一层只负责把状态画出来、把按钮接上。
//
// 🔴 **这一份的地基**：
//   ① **最多问两轮**（`drillMaxRounds`，与服务端那个上限同一个数）——"不吹毛求疵"落在这儿；
//   ② **每一步都要有一个能说出口的状态**（听着 / 在听懂 / 在问 / 可以了 / 没听清）；
//   ③ 🔴 **它自己不发送**：这一场从头到尾**没有任何"发出去"的动作**
//      （判据 `test/widget/hear_drill_test.dart` 量的就是"一次 `/api/say` 都没有"）。

import 'hearing_session.dart';

/// 这一场走到哪儿了。
enum DrillPhase {
  /// 还没开始（或者刚按了"再来一句"）。
  idle,

  /// 麦克风开着，正在听。
  listening,

  /// 说完了，正在把这一句送进听懂那一层。
  thinking,

  /// 它有不确定的，正问他一句（等着他答）。
  asking,

  /// 差不多了 —— **最终那一份**已经拿在手里。
  ready,

  /// 没听清 / 那边没答上来 / 这台开不了麦。
  failed,
}

/// 最多问几轮。**与服务端 `MAX_HISTORY` 同一个数**（两处都写死会漂，所以这儿有判据）。
const int drillMaxRounds = 2;

/// 问过、也答过的一轮。
class DrillTurn {
  const DrillTurn({required this.ask, required this.answer});

  final String ask;
  final String answer;

  Map<String, String> toWire() => {'ask': ask, 'answer': answer};
}

/// **那一场演练的整个状态**（值类：改一步换一份）。
class HearDrill {
  const HearDrill({
    this.phase = DrillPhase.idle,
    this.hearing = const Hearing(),
    this.heard = '',
    this.first = '',
    this.question = '',
    this.turns = const <DrillTurn>[],
    this.done = false,
    this.note = '',
  });

  /// 走到哪儿了。
  final DrillPhase phase;

  /// **语音那一步**（复用聊天那颗话筒那台状态机 —— 不另造一套）。
  final Hearing hearing;

  /// 目前听懂的**理顺版原话**（还没有的话是空串）。
  final String heard;

  /// **这一场最开始那一句**（他第一次说的原话）。
  /// 🔴 一定要留着：第二轮送进听懂那一层时，`text` 仍然是**这一句** ——
  ///    他后来答的那几句走 `history`（"我问…他答…"）。
  ///    只送最后那一答、把原话丢了，那一层就只能凭一句"上周"猜他要干什么。
  final String first;

  /// 它在问的那一句（`asking` 时有）。
  final String question;

  /// 已经问过答过的（最多 [drillMaxRounds] 轮）。
  final List<DrillTurn> turns;

  /// 它说"可以了"（不用再问了）。
  final bool done;

  /// **如实说的那一句**（失败 / 到点了 / 没听懂…）。
  final String note;

  /// 现在这一句听完的字（半句也算 —— 他要看见"在长字"）。
  String get said => hearing.text;

  /// 问了几轮了。
  int get round => turns.length;

  /// 还能不能再问（到上限就不问了 —— 不吹毛求疵）。
  bool get canAskMore => round < drillMaxRounds;

  /// 最终那一份（`ready` 时就是这个）。
  String get finalText => heard;

  HearDrill _copy({
    DrillPhase? phase,
    Hearing? hearing,
    String? heard,
    String? first,
    String? question,
    List<DrillTurn>? turns,
    bool? done,
    String? note,
  }) =>
      HearDrill(
        phase: phase ?? this.phase,
        hearing: hearing ?? this.hearing,
        heard: heard ?? this.heard,
        first: first ?? this.first,
        question: question ?? this.question,
        turns: turns ?? this.turns,
        done: done ?? this.done,
        note: note ?? this.note,
      );

  /// **按了一下那颗麦**：开始听（上一场的字与错都清掉 —— 他在重试）。
  HearDrill tapMic() => HearDrill(phase: DrillPhase.listening, hearing: const Hearing().tapped());

  /// 语音那边回来的一帧（**原样喂给那台状态机**，与聊天那颗话筒同一条路）。
  ///
  /// ⚠️ 只有"正在听"的时候才理它：别的档里来的帧（迟到的定稿）不许把这一场弄乱。
  HearDrill event(Map<String, dynamic> e) {
    if (phase != DrillPhase.listening) return this;
    final next = hearing.event(e);
    if (next.phase == HearingPhase.idle) {
      // 对面说"这一段完了" ⇒ 该送进听懂那一层了（界面看到 `thinking` 就去问）
      final got = next.text.trim();
      if (got.isEmpty) return _copy(hearing: next, phase: DrillPhase.failed, note: next.why);
      return _copy(
        hearing: next,
        phase: DrillPhase.thinking,
        note: '',
        // 第一轮那一句**留着**（后面每一轮送的都是它，见 [first]）
        first: turns.isEmpty ? got : first,
      );
    }
    return _copy(hearing: next, note: next.why.isEmpty ? '' : next.why);
  }

  /// **打字那条兜底路**（开不了麦的机器上才有）：把这一句当成"他说的"。
  ///
  /// ⚠️ 与真说话走的是**同一个去处**（进 `thinking` ⇒ 界面拿去问那一层），
  ///    只是没有经过麦克风。开不了麦就**别装作能听**：界面上给的是这一格。
  HearDrill saidByTyping(String text) {
    final t = text.trim();
    if (t.isEmpty) return this;
    return HearDrill(
      phase: DrillPhase.thinking,
      hearing: const Hearing(),
      heard: heard,
      first: turns.isEmpty ? t : first,
      turns: turns,
      done: false,
      note: '',
    );
  }

  /// 开麦那一步就失败了（权限 / 没配钥匙 / 开不了）。
  HearDrill micFailed(String why) => _copy(phase: DrillPhase.failed, hearing: hearing.unavailable(), note: why);

  /// **听懂那一层答回来了**（界面拿到 `/api/hear` 的回执之后调它）。
  ///
  /// * 成了、而且它还要问、而且还没问够 ⇒ `asking`（问题在 [question]）；
  /// * 成了、不用再问（或者问够了）⇒ `ready`（最终那一份在 [heard]）；
  /// * 没成 ⇒ `failed`（[note] 是人话）。
  HearDrill heardBack({required bool ok, String heard = '', String? ask, String note = '', bool done = false}) {
    if (!ok) return _copy(phase: DrillPhase.failed, note: note.isEmpty ? '' : note);
    final wants = (ask ?? '').trim();
    if (done || wants.isEmpty || !canAskMore) {
      return _copy(phase: DrillPhase.ready, heard: heard, question: '', done: true, note: '');
    }
    return _copy(phase: DrillPhase.asking, heard: heard, question: wants, note: '');
  }

  /// **他答了那一句**（语音转文字来的，或者是打字兜底那条路）。
  ///
  /// ⇒ 把这一轮记下来，再回到"在听懂"（界面看到 `thinking` 就拿新的这一份再问一次）。
  HearDrill answer(String text) {
    if (phase != DrillPhase.asking) return this;
    final a = text.trim();
    if (a.isEmpty) return this;
    return _copy(
      phase: DrillPhase.thinking,
      turns: [...turns, DrillTurn(ask: question, answer: a)],
      question: '',
    );
  }

  /// 这一场重来。
  HearDrill again() => const HearDrill();

  /// 送到听懂那一层的**这一份原文**：**最开始那一句** ＋ 前面几轮问答。
  ///
  /// ⚠️ `text` 永远是 `first`（他第一次说的那句）—— 他后来的回答走 `history`。
  Map<String, dynamic> payload() => {
        'text': first.isNotEmpty ? first : said,
        if (turns.isNotEmpty) 'history': turns.map((t) => t.toWire()).toList(),
      };
}
