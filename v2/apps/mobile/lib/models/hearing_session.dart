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

  /// 出错/没配好时那一句人话（空 = 没什么要说的）。**直接显示，不再翻译。**
  final String why;

  /// **麦克风开着吗**（按钮上那三个字归它管）。
  bool get listening => phase == HearingPhase.listening;

  /// **还在这一轮里吗**（在听 **或** 刚停下、正等最后一句）。
  /// 收字、改字都看它 —— 用 `listening` 会把最后一句挡在外面。
  bool get busy =>
      phase == HearingPhase.listening || phase == HearingPhase.finishing;

  /// 输入框里该显示的字（按段号从小到大接起来）。
  String get text {
    if (segments.isEmpty) return '';
    final keys = segments.keys.toList()..sort();
    return keys.map((k) => segments[k] ?? '').join();
  }

  /// 有没有字可以发。
  bool get hasText => text.trim().isNotEmpty;

  Hearing _copy({
    HearingPhase? phase,
    Map<int, String>? segments,
    String? why,
  }) => Hearing(
    phase: phase ?? this.phase,
    segments: segments ?? this.segments,
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
  Hearing finalText(String text, {int index = 0}) =>
      busy ? _put(index, text) : this;

  /// 整段收尾（服务端说 `asr/end`）⇒ 停下，**字留着**。
  ///
  /// ⚠️ **一个字都没听到的时候要说出来**（2026-09-23：主人手机上"按一下就没声了"，
  ///    而屏幕上**什么都不说** —— 那正是"页面在说假话"那一族：
  ///    它明明听到了一次会话结束，却不告诉人"我什么都没听到"）。
  Hearing done() => text.trim().isEmpty
      ? _copy(phase: HearingPhase.idle, why: hearNothing)
      : _copy(phase: HearingPhase.idle);

  /// 到点了（服务端说 `asr/capped`）：字留着，并说一句为什么。
  Hearing capped() => _copy(phase: HearingPhase.idle, why: hearCapped);

  /// 这台部署没配钥匙。
  Hearing unavailable() => const Hearing(
    phase: HearingPhase.unavailable,
    why: hearUnavailable,
  );

  /// 没拿到麦克风权限。
  Hearing noPermission() =>
      const Hearing(phase: HearingPhase.denied, why: hearDenied);

  /// 开麦/识别出错。[reason] 是**机器原因**（`denied` / `failed` / `engine` / …）。
  /// [code] 是上游那个错误码（腾讯的 `4004` = 资源包耗尽 ⇒ 说成"没额度"）。
  Hearing broke(String reason, {int? code}) {
    if (reason == 'denied') return noPermission();
    if (reason == 'unsupported') return const Hearing(phase: HearingPhase.denied, why: hearFailed);
    if (reason == 'not-configured') return unavailable();
    if (reason == 'no-entry') {
      return const Hearing(phase: HearingPhase.failed, why: hearNoEntry);
    }
    // 🔴 腾讯的 `4004`（资源包耗尽）**不是**"识别出错"，是"这条路没额度" ——
    //    两句混成一句，用户就不知道该干什么（去开通 vs 再试一次）。
    if (reason == 'engine' && code == 4004) {
      return const Hearing(phase: HearingPhase.failed, why: hearNoQuota);
    }
    final why = reason == 'engine' ? hearEngineFailed : hearFailed;
    return Hearing(phase: HearingPhase.failed, why: why);
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
        return finalText(text, index: index).done();
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
