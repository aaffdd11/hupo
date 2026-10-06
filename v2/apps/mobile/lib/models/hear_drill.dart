// **说一句 / 说一段那一步的状态机**（纯的：进事件、出状态）。
//
// ⚠️ 纯逻辑 ⇒ 进 `test/unit`（`test/unit/hear_drill_test.dart`）。
//    界面那一层只负责把状态画出来、把按钮接上。
//
// ── 2026-10-07：**那一层"抽离"删掉了** ─────────────────────────
//
// 主人原话：*"我们之前对语音，是抽离出来做了一层，没问题才发给聊天的。
//   现在我需要把这个抽离的部分给去掉。用户会说很多话的。不可能每个句号做断点，
//   也必须是用户说完，语音变成文字拿回来了，我们再发出去。"*
//
// ⇒ 原来那一套（"听懂那一层" `/api/hear` ＋ `heardBack` ＋ `asking` ＋ `turns`
//   ＋ `payload` ＋ 最多两轮那些东西）**从这一份里删掉了**，一个字都不留：
//   语音 → 文字 → **他按停就发**，中间没有第二个 AI 插手。
//   ⚠️ 服务端那条老接口还在（老包里有人在调），只是**这一侧不再走它**。
//
// 🔴 **这一份的地基**（三条）：
//   ① **一个字都不许丢**：一轮完了只把这一轮的字**接在** `settled` 后面
//      （`Hearing.roundDone`），不清、不发 —— 清一下就是他报的"前面那句话没了"；
//   ② **只有他按停才算说完**：到那一下才发，**只发一次**；
//   ③ 🔴 **它自己不发送**：这一场从头到尾**没有任何"发出去"的动作**
//      （判据 `test/widget/hear_drill_test.dart` 量的就是"一次 `/api/say` 都没有"）。

import 'hearing_session.dart';

/// 这一场走到哪儿了。
enum DrillPhase {
  /// 还没开始（或者刚按了"再来一次"）。
  idle,

  /// 麦克风开着，正在听。
  listening,

  /// 🔴 **他按了停，正在等对面把最后那一份字吐回来**（2026-10-05 加的）。
  ///
  /// 主人报的：*"我们录音和停止录音上，点击停止录音响应很慢。"*
  /// 根子在**这一档原来不存在**：按了停之后，麦克风当场就撒手了，可这一台状态机
  /// **还停在 `listening`**（要等 `asr/end` 那一帧回来才动）⇒ 那一秒多里屏幕上
  /// **什么都没变**（圆圈照旧亮着/闪着、字照旧），看起来就是"点了没反应"。
  /// ⇒ 现在按停**立刻**进这一档：圆圈不闪了、字说"收下了，正在整理……"，
  /// 而 `asr/end` 一到就照旧进 [thinking]（**字一个都不丢** —— [event] 在这一档照收）。
  wrapping,

  /// 说完了，手上那一份字就是最终那一份（**没有第二层了**）。
  thinking,

  /// 差不多了 —— **最终那一份**已经拿在手里。
  ready,

  /// 没听清 / 那边没答上来 / 这台开不了麦。
  failed,
}

/// **这一场的声音那一步的整个状态**（值类：改一步换一份）。
class HearDrill {
  const HearDrill({
    /// ★ **这一场要不要"连贯"**（2026-10-07 · 主人：*「我的目的是语音输入。要连贯」*）。
    ///
    /// * `true`（**聊天那颗话筒**）：服务端到点（55 秒上限）或上游自己收了一轮
    ///   ⇒ **接着开下一轮**，字一个都不清、**一次都不发** —— 只有他按停才算说完；
    /// * `false`（**设置里那颗「试一下」**，也是默认）：照老形状 —— 一轮完了就算
    ///   这一场完了（那一屏要的是"走一圈看看"，不是长听）。
    this.continuous = false,
    this.phase = DrillPhase.idle,
    this.hearing = const Hearing(),
    this.heard = '',
    this.first = '',
    this.note = '',
  });

  /// 走到哪儿了。
  final DrillPhase phase;

  /// 这一场要不要"连贯"（见构造参数那一段）。
  final bool continuous;

  /// **语音那一步**（复用聊天那颗话筒那台状态机 —— 不另造一套）。
  final Hearing hearing;

  /// 最终那一份字（`ready` 时就是这个）。
  final String heard;

  /// **他这一整段**（他说的原话；打字那条兜底也落这儿）。
  final String first;

  /// **如实说的那一句**（失败 / 没听清 / 这台开不了麦…）。
  final String note;

  /// 现在这一句听完的字（半句也算 —— 他要看见"在长字"）。
  String get said => hearing.text;

  /// 最终那一份（`ready` 时就是这个）。
  String get finalText => heard;

  /// 🔴 **该发出去的那一份**：说话那条落 `first`（`asr/end` 带回来的整段），
  ///    打字那条兜底也落 `first`（`Hearing` 是空的）⇒ 取字**只有这一个去处**。
  String get toSend {
    final f = first.trim();
    return f.isNotEmpty ? f : said.trim();
  }

  HearDrill _copy({
    DrillPhase? phase,
    bool? continuous,
    Hearing? hearing,
    String? heard,
    String? first,
    String? note,
  }) =>
      HearDrill(
        continuous: continuous ?? this.continuous,
        phase: phase ?? this.phase,
        hearing: hearing ?? this.hearing,
        heard: heard ?? this.heard,
        first: first ?? this.first,
        note: note ?? this.note,
      );

  /// **按了一下那颗麦**：开始听。
  HearDrill startListening() => _copy(phase: DrillPhase.listening, hearing: const Hearing().tapped(), note: '');

  /// 🔴 **他按了停**（2026-10-05）：**立刻**换档 —— 不再"装作还在听"。
  ///
  /// ⚠️ 这一下**一个字都不许丢**：`hearing` 原样留着，`asr/end` 回来时照旧进 [utterance]。
  /// ⚠️ 它**不动 `hearing`**：那台状态机由它自己那几帧推（`asr/end` 一到就收干净）。
  HearDrill stopListening() => _copy(phase: DrillPhase.wrapping);

  /// 语音那边回来的一帧（**原样喂给那台状态机**，与聊天那颗话筒同一条路）。
  ///
  /// ⚠️ 只有"正在听"与**"收尾中"**这两档才理它：别的档里来的帧（迟到的定稿）不许把这一场弄乱。
  ///    🔴 `wrapping` 那一档**必须收**：他按了停之后，最后那一份字正是这时候回来的。
  HearDrill event(Map<String, dynamic> e) {
    if (phase != DrillPhase.listening && phase != DrillPhase.wrapping) {
      // ⚠️ 迟到的定稿在 `thinking` 那一档也收（屏幕上那份直白的字当场补全），
      //    别的档一个字节都不动。
      if (phase == DrillPhase.thinking) return _copy(hearing: hearing.event(e));
      return this;
    }
    // ★ **2026-10-07（主人：*「我的目的是语音输入。要连贯」*）**：
    //   **连贯那一档**（聊天那颗话筒）—— 一轮完了只是"该接着开下一轮"，
    //   **不是"他说完了"**。服务端那条 55 秒上限（`ASR_MAX_MS`）是**为了省钱**
    //   （他：*"防止关闭浪费钱"*），绝不该把他的话切断。
    //   → 把**这一轮**的字接进 `settled`（前面的轮次一个字都不许丢）、段号清零；
    //   → 他按了停那一档（`wrapping`）接着走老路：进 `thinking` ⇒ 发出去，
    //     但发的是**攒起来的那一份**（几轮加起来）。
    //   ⚠️ 非连贯那一档（设置里那颗「试一下」）**一个字都不改**：走下面那条老路。
    final t0 = e['type'];
    if (continuous && (t0 == 'asr/end' || t0 == 'asr/capped')) {
      final summ = (e['text'] as String?)?.trim() ?? '';
      final folded = hearing.roundDone(summ, clearWhy: phase == DrillPhase.listening);
      if (phase == DrillPhase.listening) {
        return _copy(hearing: folded, phase: DrillPhase.listening, note: '');
      }
      final whole = folded.text.trim();
      if (whole.isEmpty) {
        return _copy(hearing: folded, phase: DrillPhase.failed, note: folded.why.isEmpty ? '' : folded.why);
      }
      return utterance(whole, hearing: folded);
    }
    final next = hearing.event(e);
    // 🔴 **`asr/end` ＝ "他这一段说完了"**（非连贯那一档）。
    //   ⚠️ **不看引擎给的那个 `reason`**：真机（网页那一份）在**每次停顿**处都会收一段，
    //      而且往往带 `upstream`/`engine` —— 那是"这一段结束了"，**不是"这一场断了"**。
    //   🔴 **用"这一场结束时那一份"，不是把段拼起来**（2026-10-04 主人指出来的）：
    //      服务端那条 `asr/end` **带着整段**（`asr.js` 把前面几段按段号接起来）—— 以它为准。
    //   🔴 **2026-10-07**：这一份整段**已经**被 `Hearing.roundDone` 接进 `settled` 了
    //      ⇒ 这里要用**攒起来的那一份**，不是单看这一帧
    //      （原来直接取 `e['text']` ⇒ **按停那一刻"第一句"就没了**）。
    if (e['type'] == 'asr/end') {
      final got = next.text.trim();
      if (got.isEmpty) return _copy(hearing: next, phase: DrillPhase.failed, note: next.why.isEmpty ? '' : next.why);
      return utterance(got, hearing: next);
    }
    return _copy(hearing: next, note: next.why.isEmpty ? '' : next.why);
  }

  /// **他这一整段是什么** —— 麦克风那条与打字那条**同一个去处**。
  HearDrill utterance(String text, {Hearing? hearing}) {
    final t = onceOnly(text);
    if (t.isEmpty) return this;
    return _copy(phase: DrillPhase.thinking, hearing: hearing, first: t, note: '');
  }

  /// **打字那条兜底路**（开不了麦的机器上才有）：把这一句当成"他说的"。
  HearDrill saidByTyping(String text) => utterance(text, hearing: const Hearing());

  /// 开麦那一步就失败了（权限 / 没配钥匙 / 开不了）。
  HearDrill micFailed(String why) => _copy(phase: DrillPhase.failed, hearing: hearing.unavailable(), note: why);

  /// ★ **话已经在手上了** ⇒ `ready`（**没有任何第二层**：字就是字）。
  ///
  /// 🔴 2026-10-07（抽离层删掉之后）：这就是"语音变成文字拿回来了"的那一下。
  HearDrill recognized(String text) {
    final t = onceOnly(text);
    if (t.isEmpty) return _copy(phase: DrillPhase.failed, note: note.isEmpty ? '' : note);
    return _copy(phase: DrillPhase.ready, heard: t, first: first.isEmpty ? t : first, note: '');
  }

  /// **一个字都没听清**（如实说一句 —— 不装发过）。
  HearDrill nothing(String why) => _copy(phase: DrillPhase.failed, note: why);

  /// 这一场重来。
  HearDrill again() => const HearDrill();
}

/// **同一句被说了两遍 ⇒ 只算一遍**（2026-10-04 主人报的"识别的时候出现了两次"）。
///
/// 🔴 为什么会重：语音那边**同一句**有时会以**两个段号**各来一次
///    （`Hearing` 是按段号拼的 ⇒ 段号不同就接成两遍）。后果不只是字难看 ——
///    这句会**两遍一起发出去**，对面看到的就是他说了两遍。
/// ⚠️ 只认**正好一分为二、两半逐字相同**那种（半句相同的正常话不受影响）。
String onceOnly(String raw) {
  final s = raw.trim();
  if (s.length < 4 || s.length.isOdd) return s;
  final half = s.length ~/ 2;
  final a = s.substring(0, half);
  final b = s.substring(half);
  return a == b ? a : s;
}
