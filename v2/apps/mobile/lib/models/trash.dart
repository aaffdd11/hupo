// 「删掉 / 回收站」那一路的**数据形状**与**回执解析**（契约 `28-DELETE.md` §八·8.2）。
//
// ⚠️ 键是 `messageIds`，**不是轮号**（契约 **§三·补**）：
//    落盘的事件里没有轮号（`message/status` / `step/*` 上的 `turn` 是瞬态），
//    所以"一轮"由**客户端**给出——一轮 = **一条用户的话 + 它的回答** = 两个 id。
//
// ⚠️ 纯逻辑：只解 JSON、只装数据，**不起网络、不碰界面**
//    （回执由 `services/api.dart` 拿回来，解析在这儿 ⇒
//     "回执读错了"这件事进得了 `test/unit` 逐条钉住）。
//    ⇒ 不许 import flutter / http（`test/unit/import_rules_test.dart` 守着）。

/// 从回执里读一份 id 清单。读不出来 ⇒ **空**（宁可少，不可多）。
///
/// ⚠️ 少一个 id 的代价是"那条没删干净"（屏幕说假话），
///    多一个 id 的代价是"删了用户没让删的东西"——
///    ⇒ 只认**明确写在数组里的非空字符串**，别的一律不当 id。
List<String> messageIdsFrom(Object? raw) {
  if (raw is! List) return const [];
  return [
    for (final e in raw)
      if (e is String && e.isNotEmpty) e,
  ];
}

/// 清单里的一条：**会删什么 / 删不掉什么**（契约 §四「逐条对状态清单」）。
class TrashPlanItem {
  const TrashPlanItem({
    required this.what,
    required this.where,
    required this.verdict,
    required this.note,
  });

  /// 删的是哪一样（服务端按状态清单推出来的，**客户端不复制那张表**）。
  final String what;

  /// 它在哪儿（服务端给的人话）。
  final String where;

  /// `delete` = 删得掉；`cannot` = **删不掉 / 会晚一点消失**。
  ///
  /// ⚠️ 认不出来的一律**不当作 `delete`**（见 [cannot]）：把"不知道"说成
  ///    "会删掉"，就是一句我们没根据的话。
  final String verdict;

  /// 服务端写的那句解释。**照实显示，不许改写成好听的**。
  final String note;

  /// 这一条是不是"删不掉"。
  ///
  /// ⚠️ fail-closed：只有**明说 `delete`** 的才算删得掉；其余（含认不出的）
  ///    都按"删不掉"显示——宁可把能删的说成不确定，也不许反过来。
  bool get cannot => verdict != 'delete';
}

/// 删前那份清单（`POST /api/trash/plan` 的回来）。
class TrashPlan {
  const TrashPlan({
    required this.messageIds,
    required this.items,
    this.purgeAt,
    this.ttlDays,
  });

  final List<String> messageIds;
  final List<TrashPlanItem> items;

  /// 什么时候**彻底删掉**（毫秒）。读不出来 ⇒ `null`（那就只说"过一阵子"）。
  final int? purgeAt;

  /// 在回收站里留多少天。**这个数住在服务端**——客户端不复制它，只显示。
  final int? ttlDays;

  /// 清单里有没有"删不掉"的那一条 ⇒ 屏幕上**不许**说"已全部删除"。
  bool get hasCannot => items.any((i) => i.cannot);
}

/// 回收站里的一条（`GET /api/trash`）。
class TrashEntry {
  const TrashEntry({
    required this.messageIds,
    this.at,
    this.purgeAt,
    this.preview = '',
  });

  final List<String> messageIds;

  /// 什么时候删掉的。
  final int? at;

  /// 什么时候彻底删掉。
  final int? purgeAt;

  /// 服务端给的一小段预览（**用户自己的话**，照实显示）。
  final String preview;

  /// 这一条能不能操作（一个 id 都没有 ⇒ 什么都不做，别发一个空请求）。
  bool get usable => messageIds.isNotEmpty;
}

/// `POST /api/trash/plan` 的回执 → [TrashPlan]。
///
/// ⚠️ 缺字段一律给"读不出来的那个最保守的值"，不抛：
///    清单是**给人看**的，缺一行也胜过整页打不开。
TrashPlan trashPlanFrom(Map<String, dynamic> j) => TrashPlan(
      messageIds: messageIdsFrom(j['messageIds']),
      items: [
        for (final e in _listOf(j['items']))
          if (e is Map)
            TrashPlanItem(
              what: _str(e['what']),
              where: _str(e['where']),
              verdict: _str(e['verdict']),
              note: _str(e['note']),
            ),
      ],
      purgeAt: _int(j['purgeAt']),
      ttlDays: _int(j['ttlDays']),
    );

/// `GET /api/trash` 的回执 → 条目清单。
List<TrashEntry> trashEntriesFrom(Map<String, dynamic> j) => [
      for (final e in _listOf(j['items']))
        if (e is Map)
          TrashEntry(
            messageIds: messageIdsFrom(e['messageIds']),
            at: _int(e['at']),
            purgeAt: _int(e['purgeAt']),
            preview: _str(e['preview']),
          ),
    ];

/// 从"服务端事实"里去掉属于这几个 id 的那些（**删除时要清掉的就是它们**）。
///
/// ⚠️ 纯函数：本机缓存那一屏"清完之后长什么样"在这儿定，
///    于是它进得了 `test/unit`（这件事出错的代价是**屏幕上又冒出已经删掉的话**）。
List<Map<String, dynamic>> withoutMessages(
  Iterable<Map<String, dynamic>> facts,
  Set<String> ids,
) =>
    [
      for (final e in facts)
        if (!ids.contains(e['messageId'])) e,
    ];

List<Object?> _listOf(Object? raw) => raw is List ? raw : const [];

int? _int(Object? raw) => raw is num ? raw.toInt() : null;

String _str(Object? raw) => raw is String ? raw : (raw == null ? '' : '$raw');
