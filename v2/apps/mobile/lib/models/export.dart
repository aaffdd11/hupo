// 「导出」那一路的**数据形状**与**回执解析**（契约 `docs/dev/30-EXPORT.md`）。
//
// 这一件只有一个成品：**一段能直接粘走的文字**（§一：不是表、不是文件下载）。
// 它由**服务端**拼好（§六：服务端 = 只读取数口 + 纯函数渲染），客户端拿到的是
// 成品 ⇒ 这里只解 JSON、只装数据。
//
// ★ 2026-10-02（契约 `docs/dev/154-CHAT-RECORD-LOOK.md` §2.2）：回执里**多带一份
//   `items`**（服务端折好的 `{seq, at, who, text}`）。客户端用它**按天分组重排那一页**，
//   但**不许拿它重拼那段文字** —— 复制走的永远是服务端给的 `text`（§五）。
//   ⚠️ 老服务端不回这个字段 ⇒ `items` 是**空列表** ⇒ 界面**退回原来那段文字块**。
//
// ⚠️ 纯逻辑：**不起网络、不碰界面**（回执由 `services/api.dart` 拿回来）。
//    ⇒ 不许 import flutter / http（`test/unit/import_rules_test.dart` 守着）。

/// `GET /api/export` 回执里的**一条话**（§2.2：`{seq, at, who, text}`）。
///
/// ⚠️ `who` 只有两个值：`'me'`（我）与 `'it'`（它）—— 别的形状一律算**坏元素**
///    （见 [exportFrom]：坏元素 ⇒ 整份 `items` 当空，退回文字块）。
class ExportItem {
  const ExportItem({this.seq, this.at, required this.who, required this.text});

  /// 服务端事件号（只用于对照，界面不显示）。
  final int? seq;

  /// 那一刻（毫秒）。**只用来按天分组**（§五：不许拿它排序）。
  /// `null` = 服务端没给（这一条就不带小标题）。
  final int? at;

  /// `'me'` 或 `'it'`。
  final String who;

  /// 这一条说的话（服务端已经 trim 过）。
  final String text;

  /// 是不是"我"说的。
  bool get isMe => who == 'me';
}

/// `GET /api/export` 的回执。
class ExportDoc {
  const ExportDoc({
    required this.text,
    this.hiddenCount = 0,
    this.items = const <ExportItem>[],
  });

  /// 那一段可以直接粘走的文字。**空串 = 没东西可导**（客户端说那句实话，别给空框）。
  final String text;

  /// 回收站里有几条（服务端算的，§三）。**只用来对照**
  /// —— 末尾那行「有 N 条…没算进来」已经写在那段文字里，客户端**不重算、不重写**。
  final int hiddenCount;

  /// 服务端折好的条目（§2.2）。**空 = 拿不到**（老服务端 / 坏形状）
  /// ⇒ 界面退回 [text] 那段原文；**绝不许拿它重拼 [text]**。
  final List<ExportItem> items;

  /// 有没有东西可拿。**空对话 ⇒ false**（§四：不给一个空白框）。
  bool get hasText => text.trim().isNotEmpty;
}

/// 回执 → [ExportDoc]。
///
/// ⚠️ 缺字段一律给"最保守的值"，**不抛**：读不出正文就说"没东西可导"
///    （那会落到那句实话上），而不是把这一页整个打不开。
///
/// ★ `items` 是**宽容解析**（§2.2）：不是数组、或者**有任何一个元素形状不对**
///   ⇒ **整份当空列表**（界面退回原来那段文字块）——**绝不抛**。
///   为什么"一个坏元素就整份不要"而不是"跳过那一个"：`items` 只影响**排版**
///   （分组/标签），而它与 `text` 是同一份话的两面；宁可整段退回服务端原文，
///   也不许屏幕上出现"少了几条"的、与 `text` 对不上的列表。
ExportDoc exportFrom(Map<String, dynamic> j) => ExportDoc(
      text: j['text'] is String ? j['text'] as String : '',
      hiddenCount: j['hiddenCount'] is num ? (j['hiddenCount'] as num).toInt() : 0,
      items: _parseItems(j['items']),
    );

/// 把回执里的 `items` 收成一份列表（坏形状 ⇒ 空列表，见 [exportFrom] 那条说明）。
List<ExportItem> _parseItems(Object? raw) {
  if (raw is! List) return const <ExportItem>[];
  final out = <ExportItem>[];
  for (final e in raw) {
    final item = _parseItem(e);
    if (item == null) return const <ExportItem>[]; // 一个坏元素 ⇒ 整份不要
    out.add(item);
  }
  return out;
}

/// 单条：形状不对 ⇒ `null`。
ExportItem? _parseItem(Object? raw) {
  if (raw is! Map) return null;
  final who = raw['who'];
  final text = raw['text'];
  if (who != 'me' && who != 'it') return null;
  if (text is! String) return null;
  final at = raw['at'];
  if (at != null && at is! num) return null;
  final seq = raw['seq'];
  if (seq != null && seq is! num) return null;
  return ExportItem(
    seq: seq is num ? seq.toInt() : null,
    at: at is num ? at.toInt() : null,
    who: who as String,
    text: text,
  );
}
