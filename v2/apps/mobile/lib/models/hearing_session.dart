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
    this.said = '',
    this.live = '',
    this.why = '',
  });

  final HearingPhase phase;

  /// **已经定稿**的字（好几句接起来）。
  final String said;

  /// 还在说的**半句**（下一句定稿时会并进 [said]）。
  final String live;

  /// 出错/没配好时那一句人话（空 = 没什么要说的）。**直接显示，不再翻译。**
  final String why;

  /// **麦克风开着吗**（按钮上那三个字归它管）。
  bool get listening => phase == HearingPhase.listening;

  /// **还在这一轮里吗**（在听 **或** 刚停下、正等最后一句）。
  /// 收字、改字都看它 —— 用 `listening` 会把最后一句挡在外面。
  bool get busy =>
      phase == HearingPhase.listening || phase == HearingPhase.finishing;

  /// 输入框里该显示的字。
  String get text => '$said$live';

  /// 有没有字可以发。
  bool get hasText => text.trim().isNotEmpty;

  Hearing _copy({
    HearingPhase? phase,
    String? said,
    String? live,
    String? why,
  }) => Hearing(
    phase: phase ?? this.phase,
    said: said ?? this.said,
    live: live ?? this.live,
    why: why ?? this.why,
  );

  /// **把那半句并进定稿**（停下的时候必须做，否则最后半句会凭空消失）。
  Hearing _settle() =>
      live.isEmpty ? _copy(live: '') : _copy(said: '$said$live', live: '');

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

  /// 半句（还在说）。
  Hearing partial(String text) => busy ? _copy(live: text) : this;

  /// 一句话定稿了。
  Hearing finalText(String text) {
    if (!busy) return this;
    final t = text.trim();
    if (t.isEmpty) return _copy(live: '');
    // ⚠️ **别把同一句记两遍**：对面在"一句话结束"和"整段结束"时
    //    可能把同一句原样再报一次（`slice_type` 1 与 2）。
    if (said.endsWith(t)) return _copy(live: '');
    return _copy(said: '$said$t', live: '');
  }

  /// 整段收尾（服务端说 `asr/end`）⇒ 停下，**字留着**。
  Hearing done() => _settle()._copy(phase: HearingPhase.idle);

  /// 到点了（服务端说 `asr/capped`）：字留着，并说一句为什么。
  Hearing capped() =>
      _settle()._copy(phase: HearingPhase.idle, why: hearCapped);

  /// 这台部署没配钥匙。
  Hearing unavailable() => const Hearing(
    phase: HearingPhase.unavailable,
    why: hearUnavailable,
  );

  /// 没拿到麦克风权限。
  Hearing noPermission() =>
      const Hearing(phase: HearingPhase.denied, why: hearDenied);

  /// 开麦/识别出错。[reason] 是**机器原因**（`denied` / `failed` / `engine` / …）。
  Hearing broke(String reason) {
    if (reason == 'denied') return noPermission();
    if (reason == 'unsupported') return const Hearing(phase: HearingPhase.denied, why: hearFailed);
    if (reason == 'not-configured') return unavailable();
    if (reason == 'no-entry') {
      return const Hearing(phase: HearingPhase.failed, why: hearNoEntry);
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
    switch (type) {
      case 'asr/ready':
        return ready();
      case 'asr/partial':
        return partial(text);
      case 'asr/final':
        return finalText(text);
      case 'asr/end':
        return finalText(text).done();
      case 'asr/capped':
        return capped();
      case 'asr/unavailable':
        return unavailable();
      case 'asr/error':
        return broke((e['reason'] as String?) ?? 'failed');
      default:
        return this;
    }
  }

  /// 停住之后**这条提示该不该留着**（只有"为什么停的"那一句有用）。
  String get notice => phase == HearingPhase.listening ? '' : why;
}
