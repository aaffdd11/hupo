// 「系统通知」的**数据形状**与**纯解析**（契约 `docs/dev/29-NOTICE.md` §五）。
//
// 两种事件形状（**已冻结，客户端照抄**）：
//
//   // 持久（取号、落盘）—— 时间线里那一条（约束 2）
//   {"type":"notice", "kind":"resumed|not-resumed|expiring|crash|failed",
//    "text":"…", "at":1758400000000,
//    "undo": {"label":"拿回来", "action":"trash/restore", "messageIds":["u_x","m_y"]}}
//
//   // 瞬态（不落盘）—— **只准用于一种情形：写盘本身失败**（契约 §三①）
//   {"type":"notice/urgent", "kind":"disk-full", "text":"…"}
//
// ⚠️ **`text` 一律由服务端给、客户端照抄**（契约 §五 那两行 🔴，和
//    `28-DELETE.md` 那张清单同一条规矩）。⇒ 这里**一个字的文案模板都不许有**：
//    在客户端重写一遍那句话，两半就会漂（而漂的那一天没有任何闸会响）。
//    这一条有测试钉着（`test/unit/notice_test.dart`）。
//
// ⚠️ **瞬态通知不占号、不上时间线**（决策 P-g）⇒ 它只该出现在浮窗里。
//
// ⚠️ 纯逻辑：只解 JSON、只装数据，**不起网络、不碰界面、不翻译**
//    （`test/unit/import_rules_test.dart` 守着楼层）。

/// 通知是哪一类（契约 §5.1 那张表）。
///
/// ⚠️ 认不出来的 `kind` ⇒ [unknown]：**不猜**（N10：沉默优于编造）。
///    它照样带着服务端那句 `text` 上屏——认不出的只是分类，不是那句话。
enum NoticeKind {
  /// 续做（D10.1：自动重来了一遍）。
  resumed('resumed'),

  /// 续做（保守那一半：**没有**自己做，怕做两遍）。
  notResumed('not-resumed'),

  /// 回收站到期前一周（**有撤销**）。
  expiring('expiring'),

  /// 崩溃 / 报警（P-k · #22）。
  crash('crash'),

  /// 失败五类里"只通知"那一类。
  failed('failed'),

  /// 写盘本身失败 —— **只准 `notice/urgent` 用这一种**（契约 §三①）。
  diskFull('disk-full'),

  /// 认不出来（向前兼容：服务端加了新 `kind`，客户端照旧把那句话显示出来）。
  unknown('');

  const NoticeKind(this.wire);

  /// 线上那个字符串。**冻结**（旧客户端还在跑）。
  final String wire;

  /// 线上字符串 → 这一档；认不出来 ⇒ [unknown]（不抛）。
  static NoticeKind fromWire(Object? raw) {
    if (raw is! String || raw.isEmpty) return unknown;
    for (final k in values) {
      if (k != unknown && k.wire == raw) return k;
    }
    return unknown;
  }
}

/// `undo` 里那个 `action`。**今天只有一条**（契约 §五）。
///
/// ⚠️ fail-closed：认不出来的 action 一律 [unsupported] ⇒ **按钮不画**
///    （画了就是一个按了不会有结果的动作，那是屏幕上说假话）。
enum NoticeUndoAction {
  trashRestore('trash/restore'),
  unsupported('');

  const NoticeUndoAction(this.wire);

  final String wire;

  static NoticeUndoAction fromWire(Object? raw) {
    if (raw is! String || raw.isEmpty) return unsupported;
    for (final a in values) {
      if (a != unsupported && a.wire == raw) return a;
    }
    return unsupported;
  }
}

/// `undo`：**撤销有两份**（约束 3）——浮窗里一个、时间线里那一条也有一个。
/// 两处按的是**同一份数据**、走的是**同一条路**（`ChatController.undoNotice`）。
class NoticeUndo {
  const NoticeUndo({
    required this.label,
    required this.action,
    this.messageIds = const [],
  });

  /// 按钮上那几个字。**服务端给**（和 `text` 同一条规矩）。
  final String label;

  final NoticeUndoAction action;

  /// 交给服务端的 id 清单（撤销 = `trash/restore` 那几个）。
  final List<String> messageIds;

  /// 这个撤销现在**按得动吗**。
  ///
  /// ⚠️ 两个条件缺一不可：action 认得出来、而且清单非空。
  ///    给一个空请求 = 屏幕上按了没反应。
  bool get usable => action != NoticeUndoAction.unsupported && messageIds.isNotEmpty;

  /// 从事件里那份 `undo` 读出来。读不出来 ⇒ `null`（**不猜**）。
  ///
  /// ⚠️ `label` 读不出来 ⇒ 不要这一份 undo：按钮上总得有字，
  ///    客户端**不许自己编**一个（那就成了"客户端重写服务端那句话"）。
  static NoticeUndo? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final label = raw['label'];
    if (label is! String || label.trim().isEmpty) return null;
    return NoticeUndo(
      label: label,
      action: NoticeUndoAction.fromWire(raw['action']),
      messageIds: _idsOf(raw['messageIds']),
    );
  }
}

/// 一条通知。
class Notice {
  const Notice({
    required this.kind,
    required this.text,
    this.at,
    this.undo,
    this.urgent = false,
  });

  final NoticeKind kind;

  /// **服务端给的那句话，一个字都不改**（契约 §五 🔴）。界面上直接显示它。
  final String text;

  /// 什么时候发生的（毫秒，服务端钟）。读不出来 ⇒ `null`
  /// （**不许拿本机钟冒充**——那是两把钟混着用）。
  final int? at;

  /// 有的话，**浮窗与时间线两处都渲染它**（约束 3）。
  final NoticeUndo? undo;

  /// 这一条是不是瞬态（`notice/urgent`）。
  ///
  /// ⚠️ 它**不占号、不进时间线**，只在浮窗里；而且**必须自己说清**
  ///    （契约 §三①：写盘失败时时间线里没有它，那条话里要写明）。
  final bool urgent;

  /// 从服务端事件读一条通知。`text` 读不出来 ⇒ `null`
  /// （**一条没有话的通知不该上屏**——那是一个空的浮窗或一条空行）。
  static Notice? fromEvent(Map<String, dynamic> event) {
    final text = event['text'];
    if (text is! String || text.trim().isEmpty) return null;
    final at = event['at'];
    return Notice(
      kind: NoticeKind.fromWire(event['kind']),
      text: text,
      at: at is num ? at.toInt() : null,
      undo: NoticeUndo.fromJson(event['undo']),
      urgent: event['type'] == 'notice/urgent',
    );
  }
}

/// 事件里那份 id 清单。读不出来 ⇒ **空**（同 `Timeline.messageIdsOfEvent`：
/// 宁可少，不可多——多一个 id 的代价是撤销到用户没让动的东西）。
List<String> _idsOf(Object? raw) {
  if (raw is! List) return const [];
  return [
    for (final e in raw)
      if (e is String && e.isNotEmpty) e,
  ];
}
