// **排队那一帧的客户端那一半**（契约 `docs/dev/117-QUEUE-VISIBLE.md`）。
//
// ── 它解决什么 ─────────────────────────────────────────────
// 他还在等上一件事的时候又发了一句 —— 服务端**早就**把它排队了
// （`src/dispatcher.js` 的 `#delivered` 票），可屏幕上一个字都没有：
// 他既看不见自己还排着什么，也撤不掉。这一份认的就是那条把账摊开的帧
// `{"type":"queue/changed","items":[…],"count":N}`。
//
// ── 🔴 四条硬规矩 ──────────────────────────────────────────
//   ① **瞬态**：不进时间线（不占号、不落盘、重连不重放）⇒ 它不是一条"事实"，
//      是"**现在**还排着什么"。所以它住的不是 `Timeline.items`，而是
//      `Timeline.queue`（一间一份）。⚠️ **绝不喂给 `Timeline.apply` 当事件**。
//   ② **fail-closed**：认不出来的帧 / 认不出来的 item ⇒ **丢掉**，
//      **绝不抛**（同 `tool_row.dart`：坏数据的后果只许是"这一行不画"，
//      不能是"打不开聊天"）。⚠️ 身份（`messageId`）认不出 ⇒ **整条丢掉**，
//      不画——因为那一行上的按钮按下去也没人认（那是屏幕上说假话）。
//   ③ **原话就是原话**：`text` 照抄服务端给的（截断与 `truncated` 都由服务端算，
//      见 `src/queue.js`）——这一层**不补、不缩、不翻译、不摘要**。
//   ④ **`count` 不住在这份里**：界面要报"几条"时**数 `items`**就行了。
//      服务端那个 `count` 与 `items` 一旦对不上，屏幕上就会出现
//      "3 条排队消息"底下只有两行 —— 那就是页面在说假话（N10）。数得出来的东西不抄。
//
// ⚠️ **纯逻辑**：不 import `material`、不碰 I/O（楼层闸 `test/unit/import_rules_test.dart`）。
// ⚠️ **`models/` 里不许有给人看的字**：这一份一个中文文案都没有
//    （那几句在 `queue_words.dart`，才进得了禁用词那道闸）。

/// 队列里**一条**还没轮到它跑的话。
class ChatQueueItem {
  const ChatQueueItem({
    required this.messageId,
    required this.text,
    required this.at,
    required this.truncated,
  });

  /// 撤掉它时用的身份（客户端→服务端那一帧就是按它认的）。
  final String messageId;

  /// 主人自己的原话（服务端截到 200 个字符；截了 [truncated] 会说）。
  final String text;

  /// 什么时候投的（服务端钟；认不出 ⇒ `null` —— **不拿现在充一个**）。
  final int? at;

  /// 有没有被服务端截过。**原样保留**（截了不说 = 页面在说假话）。
  final bool truncated;
}

/// **这一间现在排着什么**（`queue/changed` 解出来的那个值）。
///
/// ⚠️ 它是**整份快照**（不是增量）：每收到一帧就**整份换掉** ——
///    服务端每次报的都是"现在是这样"，增量合并在两处（服务端 + 客户端）
///    各算一遍迟早会漂，而且漂出来的是一条**撤不掉的幽灵行**。
class ChatQueue {
  const ChatQueue({required this.items});

  /// 一条都没有（服务端说"没排队"，或者还没收到过那一帧）。
  static const ChatQueue empty = ChatQueue(items: <ChatQueueItem>[]);

  /// **按 FIFO 排好**的那些（服务端给的次序就是投的次序，这里不动它）。
  final List<ChatQueueItem> items;

  /// 排着几条。**数出来的**（见文件头规矩 ④）。
  int get count => items.length;

  bool get isEmpty => items.isEmpty;

  /// 认一条 `queue/changed` 帧；**认不出 ⇒ `null`**（调用方安静忽略）。
  ///
  /// 认得出来的条件只有一条：`type == 'queue/changed'`。
  /// ⚠️ `items` 不是列表 / 是坏的 ⇒ 当成**空队**（而不是 `null`）：
  ///    那也是一句"现在没有排队的"的实话，而且**后面那句更可信**——
  ///    留着上一帧的旧队列会让屏幕上停着几条**早就没了**的消息。
  static ChatQueue? of(Object? event) {
    if (_field(event, 'type') != 'queue/changed') return null;
    final raw = _field(event, 'items');
    final out = <ChatQueueItem>[];
    if (raw is List) {
      for (final e in raw) {
        final item = _itemOf(e);
        if (item != null) out.add(item);
      }
    }
    return ChatQueue(items: out);
  }

  /// 一条 item；**身份认不出 ⇒ `null`**（丢掉它，不画）。
  ///
  /// ⚠️ `text` / `at` / `truncated` 认不出**不算坏**：`text` 空着就当空字符串，
  ///    另两个各回各的缺省 —— 它们只影响那一行好不好看，
  ///    而 `messageId` 是那一行**能不能撤**的前提（规矩 ②）。
  static ChatQueueItem? _itemOf(Object? e) {
    final id = _field(e, 'messageId');
    if (id is! String || id.isEmpty) return null;
    final text = _field(e, 'text');
    final at = _field(e, 'at');
    return ChatQueueItem(
      messageId: id,
      text: text is String ? text : '',
      at: at is int ? at : null,
      truncated: _field(e, 'truncated') == true,
    );
  }

  /// 从 `Map` / 别的对象上取一格；取不到 ⇒ `null`（**绝不抛**）。
  static Object? _field(Object? o, String key) => o is Map ? o[key] : null;
}
