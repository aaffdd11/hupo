// **语音那一步的状态机**（纯的：进事件、出状态）。
//
// ⚠️ 纯逻辑 ⇒ 进 `test/unit`（`test/unit/hearing_session_test.dart`），
//    不靠界面断言。界面上"正在听"那三个字是不是真的，就是靠这里钉住的。
//
// 为什么要有它：识别那一头会**一小段一小段**吐字（半句 / 定稿 / 整段收尾），
// 而输入框里只该有一份字。把"半句覆盖、定稿追加、收尾留住"这条规矩
// 放进一个纯函数里，比埋在 widget 的 `setState` 里可靠得多。

import 'hearing_words.dart';

/// 语音这一步现在处在哪儿。
enum HearingPhase {
  /// 没在听（可能刚才听过，字还留着）。
  idle,

  /// 真在听（麦克风开着）。
  listening,

  /// **已经按了停、正在等对面把最后一句吐回来**。
  ///
  /// 🔴 这一档是**必须**的：主人按下"结束"之后，最后一句话是**之后**才回来的
  ///    （我们只是跟对面说"我这边说完了"）。一按停就进 `idle`，
  ///    那一句就**被丢掉**了 —— 2026-09-23 用真浏览器取证时**当场抓到的就是这个**：
  ///    屏幕上只剩半句"今天天"，最后那句没了。
  finishing,

  /// 这台部署没配钥匙 —— **不装开麦**。
  unavailable,

  /// 浏览器没给麦克风权限。
  denied,

  /// 开麦或识别出错了。
  failed,
}

/// 语音那一步的整个状态。
class Hearing {
  const Hearing({
    this.phase = HearingPhase.idle,
    this.segments = const <int, String>{},
    this.settled = '',
    this.why = '',
  });

  final HearingPhase phase;

  /// **按"段号"存下来的字** —— 这是 2026-09-23 抓腾讯**真帧**之后定下来的形状。
  ///
  /// 🔴 为什么不是"一个半句 + 一串定稿"：腾讯**同一段**会连着发好几条，
  ///    每一条的 `voice_text_str` 都是**这一段到目前为止**的字（累积）。
  ///    实测（`16k_zh`，一段 3 秒的话）：
  ///    ```
  ///    slice=0 index=0 text=""      → slice=1 index=0 text="嗯"
  ///    slice=1 index=0 text="今天"   → slice=1 index=0 text="今天天气"
  ///    slice=1 index=0 text="今天天气怎么" → slice=2 index=0 text="今天天气怎么样？"
  ///    ```
  ///    ⇒ 这几条**必须按 `index` 替换**；接起来就是"嗯今天今天天气今天天气怎么…"那种重复。
  final Map<int, String> segments;

  /// ★ 2026-09-26：**同一场录音里、前面几轮已经说定的字**。
  ///
  /// 🔴 为什么要有它：一次识别连接只担**一轮**（上游说完一段/断一次就收），
  ///    而主人那颗「试一下」要的是"按一下开始、再按一下才结束" ——
  ///    中间那些停顿不能让字没了。引擎收一轮 ⇒ 把这一轮的字搬进 `settled`，
  ///    `segments` 清零；下一轮**段号又从 0 开始**，接在 `settled` 后面。
  ///    ⚠️ 不搬的话，下一轮的 `index: 0` 会**替换**掉上一轮的 `index: 0`
  ///       —— 那正是"说了两句只剩后一句"。
  final String settled;

  /// 出错/没配好时那一句人话（空 = 没什么要说的）。**直接显示，不再翻译。**
  final String why;

  /// **麦克风开着吗**（按钮上那三个字归它管）。
  bool get listening => phase == HearingPhase.listening;

  /// **还在这一轮里吗**（在听 **或** 刚停下、正等最后一句）。
  /// 收字、改字都看它 —— 用 `listening` 会把最后一句挡在外面。
  bool get busy =>
      phase == HearingPhase.listening || phase == HearingPhase.finishing;

  /// 输入框里该显示的字（**前面几轮定下来的** ＋ 这一轮正在长的）。
  String get text {
    final live = segments.isEmpty
        ? ''
        : (segments.keys.toList()..sort()).map((k) => segments[k] ?? '').join();
    return settled + live;
  }

  /// 有没有字可以发。
  bool get hasText => text.trim().isNotEmpty;

  Hearing _copy({
    HearingPhase? phase,
    Map<int, String>? segments,
    String? settled,
    String? why,
  }) => Hearing(
    phase: phase ?? this.phase,
    segments: segments ?? this.segments,
    settled: settled ?? this.settled,
    why: why ?? this.why,
  );

  /// **写一段**（同一段号 ⇒ **替换**，新段号 ⇒ 接在后面）。
  ///
  /// 🔴 **空字不许覆盖**：腾讯收尾那条 `final:1` 里**没有** `result`，
  ///    中转出来就是一条**空字**的 `asr/end` —— 照单全收会把刚听到的那一段**擦掉**
  ///    （2026-09-23 判据当场抓到的就是这个）。
  Hearing _put(int index, String text) {
    if (text.isEmpty) return this;
    return _copy(segments: {...segments, index: text});
  }

  /// **按了一下**（那个唯一的按钮）。
  ///
  /// * 没在听 ⇒ 开始听：**上一次那些字清掉**（新的这一次是新的内容），
  ///   上一次的错也清掉（用户就是在重试）。
  /// * 在听 ⇒ **说"这边完了"**：进 [HearingPhase.finishing]，
  ///   字**先留着那半句**（对面马上会把整句送回来，那时才定稿）。
  ///   ⚠️ 这一档**不许**当场定稿：那会把"今天天"和"今天天气怎么样"接成两遍。
  /// * 正在收尾 ⇒ 按了不算（这段时间短，界面上那颗按钮本来也不画）。
  Hearing tapped() {
    if (listening) return _copy(phase: HearingPhase.finishing);
    if (phase == HearingPhase.finishing) return this;
    return const Hearing(phase: HearingPhase.listening);
  }

  /// ★ 2026-09-26：**引擎把这一段说完了，但用户还没按停** ⇒ 这一场继续。
  ///
  /// 一次识别连接只担**一轮**（上游说完一段/断了就收），而主人那颗「试一下」
  /// 要的是"按一下开始、再按一下才结束" —— 中间的停顿不许把这一场结束掉。
  /// 这里把这一轮的字**落进 `settled`**、段号清零；下一轮从 `0` 重新开始、
  /// 接在后面（不落的话下一轮的 `index: 0` 会把上一轮的字**替换**掉）。
  ///
  /// ⚠️ 只有"这一场还开着"（`listening`）时才有意义：收尾中/失败/闲的时候
  ///    调它会把一场已经结束的录音又画成"在听"。
  Hearing roundEnded() => _copy(
    phase: HearingPhase.listening,
    segments: const <int, String>{},
    settled: text,
    why: '',
  );

  /// 麦克风真的开起来了（服务端说 `asr/ready`）。
  Hearing ready() => busy ? _copy(why: '') : this;

  /// 一段的**中间结果**（还在说）。按段号**替换**，不是接上去。
  Hearing partial(String text, {int index = 0}) =>
      busy ? _put(index, text) : this;

  /// **一段的结果**（`slice_type` 1 或 2）。
  ///
  /// ⚠️ 它和 [partial] 做的是**同一件事**（按段号替换）—— 这是照着真帧定的：
  ///    腾讯**同一段**会连着发好几条 `slice_type=1`，字是累积的；
  ///    把它们当成"一句一句的新话"接起来，屏幕上就会出现一串重复。
  ///    ⇒ 段号变了才接新的（多句话的情形），段号没变就是**同一段又准了一点**。
  Hearing finalText(String text, {int index = 0}) {
    // 🔴 2026-09-24（P1-3 写判据时抓到的）：**只要这一轮真听过，迟到的定稿就要收下**。
    //    原来只在 `busy`（在听/收尾中）才收 ⇒ `asr/capped` 先把我们挪出 busy，
    //    而服务端那条 `asr/end` **1.5 秒后才到**，于是"最后一句"被丢掉。
    //    ⇒ 只有"从没听过"的那两档（没配钥匙 / 没权限）才拒收。
    if (phase == HearingPhase.unavailable || phase == HearingPhase.denied) {
      return this;
    }
    return _put(index, text);
  }

  /// ★ **2026-10-07（主人：*「我的目的是语音输入。要连贯」*）：这一轮完了、
  /// 可他还没按停** —— 把这一轮的字**接在 `settled` 后面**、段号清零，
  /// 下一轮从 0 开始接着长。
  ///
  /// 🔴 它与 [replaceAll] 的分工（别把这两件事混成一个）：
  ///   · [replaceAll]：**这一场到此为止**（他按了停）⇒ 整段换掉；
  ///   · [roundDone]：这一场**还在继续**（服务端到点 `asr/capped`，或上游自己收了一轮）
  ///     ⇒ 只把**这一轮**那一份接到后面 —— **前面几轮的字一个都不许丢**
  ///     （丢了就是主人报的那句"前面的话会被清除"）。
  /// ⚠️ 服务端那条 `asr/end` 带的"整段"**只覆盖它那一条连接**
  ///    （`asr.js` 的 `segs` 是按连接来的）⇒ 在这里只当"这一轮"那一份用。
  Hearing roundDone(String summary, {bool clearWhy = false}) {
    final s = summary.trim();
    final base = text.trim(); // 这一轮拼起来的那一份（服务端那条整段常常就是它）
    // 🔴 **2026-10-07：这一下只许让框里的字变长，绝不许变短。**
    //
    //   服务端那条"整段"是从**同一路上游**自己攒出来的，正常它更全（以它为准）；
    //   但它也可能把后面那一句**并进**前面那一段（上游按句给字、时间对不上时）
    //   ⇒ 那一份会**少一段** —— 这正是主人报的
    //      *"说着说着，转文字的早期的那部分内容在输入框里没了"*。
    //   我们手上这份是**同一路帧**攒出来的 ⇒ **谁长用谁**（丢字比多字坏得多）。
    // ⚠️ 不是"两份里挑长的那份"（那样会把**新的一句**丢掉：服务端那条整段只有
    //    新那一句、而我们手上是"前几句 ＋ 新的"，挑长的就只剩前面那几句了）。
    //    正确的做法：**接上去**（`_joined` 会把重叠那一段去掉、不重复），
    //    接完还是比手上短（＝服务端那份是手上这份的子集）⇒ 用手上这份。
    final joined = s.isEmpty ? base : _joined(settled, s);
    final best = joined.length >= base.length ? joined : base;
    return _copy(
      // ⚠️ 收一轮**不是出错** —— 但"要不要把刚才那句话清掉"看调用方：
      //    · 聊天那条路（**接着开下一轮**）⇒ `clearWhy: true`（那一轮完了不是失败）；
      //    · 非连贯那一档（他到点/上游收尾就收场）⇒ 照旧留着（"一分钟到了"那句要看得见）。
      phase: HearingPhase.listening,
      why: clearWhy ? '' : why,
      segments: const <int, String>{},
      settled: best.isEmpty ? settled : _joined(settled, best),
    );
  }

  /// **接上去，但不许重复** —— 引擎收尾那一包常常把**最后那一句又吐一遍**
  /// （真机判据抓到的就是这个：屏幕上会变成
  /// "帮我看看天气帮我看看上海的天气"）。
  /// 规矩：`a` 的尾巴与 `b` 的开头**最长重叠**那一段只算一次。
  static String _joined(String a, String b) {
    if (a.isEmpty) return b;
    if (b.isEmpty) return a;
    final max = a.length < b.length ? a.length : b.length;
    for (var n = max; n > 0; n -= 1) {
      if (a.substring(a.length - n) == b.substring(0, n)) {
        return a + b.substring(n);
      }
    }
    return a + b;
  }

  /// ★ 2026-10-06：**整段那一份换掉拼起来的那一份**（收尾那条 `asr/end` 带的字）。
  ///
  /// 🔴 为什么不能按段塞进去：`asr/end` 带的是**整段**（服务端把前面几段接好了），
  ///    而按段塞（`_put(index, 整段)`）会和前面那几段**重复一遍**
  ///    —— 屏幕上就变成「今天今天天气怎么样」。⇒ 它是**整段**，就整段换掉。
  Hearing replaceAll(String text) =>
      text.trim().isEmpty ? this : _copy(segments: const <int, String>{}, settled: text);

  /// 整段收尾（服务端说 `asr/end`）⇒ 停下，**字留着**。
  ///
  /// ⚠️ **一个字都没听到的时候要说出来**（2026-09-23：主人手机上"按一下就没声了"，
  ///    而屏幕上**什么都不说** —— 那正是"页面在说假话"那一族：
  ///    它明明听到了一次会话结束，却不告诉人"我什么都没听到"）。
  /// ⚠️ 但**已经有一句话的时候不许拿"什么都没听到"盖掉它**：`asr/capped`
  ///    先说了"一分钟到点"，紧接着那条迟到的 `asr/end` 会走到这里 ——
  ///    把"到点"换成"什么都没听到"就等于把原因擦掉了。
  Hearing done() => text.trim().isEmpty
      ? _copy(phase: HearingPhase.idle, why: why.isEmpty ? hearNothing : why)
      : _copy(phase: HearingPhase.idle);

  /// 到点了（服务端说 `asr/capped`）：字留着，并说一句为什么。
  Hearing capped() => _copy(phase: HearingPhase.idle, why: hearCapped);

  /// ★ 2026-09-26：收到一帧**形状都不对**的东西（不是一个表）。
  /// 字一个都不许丢，说一句实话 —— 而且**绝不抛**。
  Hearing badFrame(String why) =>
      _copy(phase: HearingPhase.failed, why: why);

  /// 这台部署没配钥匙。
  /// ⚠️ 走 `_copy`（不是 `const Hearing`）：**已经听到的字要留着**
  ///    —— 一场录音开在中间才发现没配好时，他刚说的话不能没。
  Hearing unavailable() =>
      _copy(phase: HearingPhase.unavailable, why: hearUnavailable);

  /// 没拿到麦克风权限。
  Hearing noPermission() =>
      _copy(phase: HearingPhase.denied, why: hearDenied);

  /// 开麦/识别出错。[reason] 是**机器原因**（`denied` / `failed` / `engine` / …）。
  /// [code] 是上游那个错误码（腾讯的 `4004` = 资源包耗尽 ⇒ 说成"没额度"）。
  ///
  /// 🔴 这一版**每一条分支都留住已经听到的字**（契约 §三："任意失败 ⇒
  ///    已经听到的字留着"）。开麦失败发生在**中途**（自动开下一轮的那一刻）
  ///    时尤其要紧：那会儿框里已经有他说的话了。
  Hearing broke(String reason, {int? code}) {
    if (reason == 'denied') return noPermission();
    if (reason == 'unsupported') {
      return _copy(phase: HearingPhase.denied, why: hearFailed);
    }
    if (reason == 'not-configured') return unavailable();
    if (reason == 'cut') {
      // ⚠️ **留住字**（判据当场抓到的：原来这里 new 了一个空 Hearing ⇒ 他刚说的话没了）
      return _copy(phase: HearingPhase.failed, why: hearCutOff);
    }
    if (reason == 'no-entry') {
      return _copy(phase: HearingPhase.failed, why: hearNoEntry);
    }
    // ★ 2026-10-01：🔴 **握手那一关被拒**（服务端 `asr/error{reason:'bad-key'}`，
    //    真上游回 401）⇒ 说清"**这两样它不认**"（重试永远不会好，要去重取一次）。
    if (reason == 'bad-key') {
      return _copy(phase: HearingPhase.failed, why: hearBadKey);
    }
    // ★ 2026-09-26：上游那一头出错（服务端 `asr/error{reason:'upstream'}`）
    //     **不是**"麦克风开不了" —— 说成"识别那一头出错了"，他才知道该再试一次。
    if (reason == 'upstream') {
      return _copy(phase: HearingPhase.failed, why: hearEngineFailed);
    }
    // 🔴 腾讯的 `4004`（资源包耗尽）**不是**"识别出错"，是"这条路没额度" ——
    //    两句混成一句，用户就不知道该干什么（去开通 vs 再试一次）。
    if (reason == 'engine' && code == 4004) {
      return _copy(phase: HearingPhase.failed, why: hearNoQuota);
    }
    final why = reason == 'engine' ? hearEngineFailed : hearFailed;
    return _copy(phase: HearingPhase.failed, why: why);
  }

  /// **服务端/引擎来的一个事件**（线上协议见契约 §二）。
  ///
  /// 认不出来的事件**什么都不做**（不猜、不假装）—— 这样对面加字段时
  /// 旧客户端不会因为一个不认识的类型就崩或者写错字。
  Hearing event(Map<String, dynamic> e) {
    final type = e['type'];
    final text = (e['text'] as String?) ?? '';
    final rawIndex = e['index'];
    final index = rawIndex is int ? rawIndex : 0;
    switch (type) {
      case 'asr/ready':
        return ready();
      case 'asr/partial':
        return partial(text, index: index);
      case 'asr/final':
        return finalText(text, index: index);
      case 'asr/end':
        // ★ P1-3（2026-09-24）：**收尾带原因**时，分两种走法 ——
        //   · 用户自己按停（`user-stop` / 没给原因）⇒ 正常收尾（切回键盘档，字落进框里）；
        //   · 半路**断了**（上游断了 / 引擎出错）⇒ **字留着、说明白、别切走**
        //     （停留在语音档 ⇒ 他再按一下就是"接着刚才那句说"）。
        //   ⚠️ `capped` 有它自己那句（"一次最多说一分钟"），不跟这条抢。
        final why = e['reason'];
        final cut = why == 'upstream' || why == 'engine';
        // ★ 2026-10-06：收尾那条带的是**整段**（服务端 `asr.js` 把前面几段接好了）
        //   ⇒ **整段换掉**拼起来的那一份（按段塞会和前面的段重复一遍）。
        //   ⚠️ 它没带字（老引擎 / 空收尾）⇒ 一个字都不动，拼起来那份留着。
        // 🔴 **2026-10-07 改口径**（主人：*"要连贯"*）：这一条"整段"覆盖的是
        //   **它那一条连接**（= 这一轮）⇒ 接在 `settled` 后面，**不是**把
        //   前面几轮的字一起换掉（那样一来"第一句"就在按停那一刻没了 ——
        //   判据 `voice_continue_test` 当场抓到过）。
        final h = replaceAll(text);
        if (!cut) return h.done();
        // ⚠️ 判"有没有字"要看**整份**（`hasText`），不是只看 `segments`：
        //    `replaceAll` 之后字落在 `settled` 里，只看 segments 会把"断了但有字"
        //    误判成"什么都没听到"（那就把原因擦掉了）。
        return h.hasText ? h.broke('cut') : h.done();
      case 'asr/capped':
        return capped();
      case 'asr/unavailable':
        return unavailable();
      case 'asr/error':
        final c = e['code'];
        return broke((e['reason'] as String?) ?? 'failed', code: c is int ? c : null);
      default:
        return this;
    }
  }

  /// 停住之后**这条提示该不该留着**（只有"为什么停的"那一句有用）。
  String get notice => phase == HearingPhase.listening ? '' : why;
}
