// **「验一下钥匙」那条路的结果**（纯逻辑 · 没有 I/O、没有 UI）。
//
// ⚠️ 与 `image_outcome.dart` 同一条理由：`widgets` 只许看 `models`；
//    而这句话**由服务端给**（他知道那边到底怎么回的）—— 客户端**不许**自己编一句更具体的。

/// 验钥匙的结果。
///
/// ⚠️ **它只承诺验到的那件事**：`ok` 的意思是"那边认了这把钥匙"，**不是**"能出片"
///    （名字与参数对不对，只有真跑一次才知道 —— `docs/dev/219` §五）。
class ArkCheckOutcome {
  const ArkCheckOutcome({required this.ok, this.image = false, this.video = false, this.words});

  /// 这把钥匙那边认了没有（两条路都通才算）。
  final bool ok;

  /// 画图那条通了没有 / 做视频那条通了没有。
  final bool image;
  final bool video;

  /// 那句人话（服务端给的，直接显示）。
  final String? words;

  /// 连不上/500 那一类（连一句话都没拿回来）。
  static const ArkCheckOutcome offline = ArkCheckOutcome(ok: false);

  factory ArkCheckOutcome.fromJson(Object? raw) {
    if (raw is! Map) return offline;
    final text = raw['text'];
    return ArkCheckOutcome(
      ok: raw['ok'] == true,
      image: raw['image'] == 'ok',
      video: raw['video'] == 'ok',
      words: text is String && text.isNotEmpty ? text : null,
    );
  }
}
