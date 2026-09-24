// **画一张图**那条路的结果（纯逻辑 · 没有 I/O、没有 UI）。
//
// ⚠️ 为什么单立成 `models/`：填钥匙那一屏要用它，而**楼层闸**写着
//    "`widgets` 只许看 `models`"。它是**一份协议词汇表**，也让 `test/unit` 能直接钉。

/// 画图的结果。
///
/// ⚠️ 失败那一句**由服务端给**（`text`）：他知道上游到底说了什么，
///    而客户端**不许**自己编一句更具体的（编了就是"页面在说假话"）。
class ImageOutcome {
  const ImageOutcome({required this.ok, this.urls = const [], this.words});

  /// 画成了没有。
  final bool ok;

  /// 画好的图在哪（上游给的临时地址）。
  final List<String> urls;

  /// 没成时那句人话（服务端给的，直接显示）。
  final String? words;

  /// 连不上/500 那一类（连一句话都没拿回来）。
  static const ImageOutcome offline = ImageOutcome(ok: false);

  factory ImageOutcome.fromJson(Object? raw) {
    if (raw is! Map) return offline;
    final ok = raw['ok'] == true;
    final urls = <String>[];
    final u = raw['urls'];
    if (u is List) {
      for (final one in u) {
        // ⚠️ 只收 http(s) —— 别的（`javascript:` 那类）**绝不**拿去显示
        if (one is String && (one.startsWith('https://') || one.startsWith('http://'))) urls.add(one);
      }
    }
    final text = raw['text'];
    return ImageOutcome(
      ok: ok && urls.isNotEmpty,
      urls: urls,
      words: text is String && text.isNotEmpty ? text : null,
    );
  }
}
