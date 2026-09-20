// 「导出」那一路的**数据形状**与**回执解析**（契约 `docs/dev/30-EXPORT.md`）。
//
// 这一件只有一个成品：**一段能直接粘走的文字**（§一：不是表、不是文件下载）。
// 它由**服务端**拼好（§六：服务端 = 只读取数口 + 纯函数渲染），客户端拿到的是
// 成品 ⇒ 这里只解 JSON、只装数据。
//
// ⚠️ 纯逻辑：**不起网络、不碰界面**（回执由 `services/api.dart` 拿回来）。
//    ⇒ 不许 import flutter / http（`test/unit/import_rules_test.dart` 守着）。

/// `GET /api/export` 的回执。
class ExportDoc {
  const ExportDoc({required this.text, this.hiddenCount = 0});

  /// 那一段可以直接粘走的文字。**空串 = 没东西可导**（客户端说那句实话，别给空框）。
  final String text;

  /// 回收站里有几条（服务端算的，§三）。**只用来对照**
  /// —— 末尾那行「有 N 条…没算进来」已经写在那段文字里，客户端**不重算、不重写**。
  final int hiddenCount;

  /// 有没有东西可拿。**空对话 ⇒ false**（§四：不给一个空白框）。
  bool get hasText => text.trim().isNotEmpty;
}

/// 回执 → [ExportDoc]。
///
/// ⚠️ 缺字段一律给"最保守的值"，**不抛**：读不出正文就说"没东西可导"
///    （那会落到那句实话上），而不是把这一页整个打不开。
ExportDoc exportFrom(Map<String, dynamic> j) => ExportDoc(
      text: j['text'] is String ? j['text'] as String : '',
      hiddenCount: j['hiddenCount'] is num ? (j['hiddenCount'] as num).toInt() : 0,
    );
