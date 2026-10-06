// **「正在干的活」那张清单**（主人 2026-10-06 要的那一件）。
//
// 主人原话：*「我觉得应该在左下角有一个清单按钮，点击会出来浮窗，
//   浮窗里有正在干活的聊天的列表。」*
//
// ── 这一层管什么 ─────────────────────────────────────────────
//   · **读懂服务端那一份**（`GET /api/working` 的 `{ok, working:[{scope,title,since,count}]}`）；
//   · **把每一行说成人话**：名字从哪儿来、干了多久、几件；
//   · 🔴 **认不出名字时说什么** —— 见 [workRowName]（**绝不把那串内部 id 摆上屏**）。
//
// ── 三条纪律（与 `chat_time.dart` / `desktop_words.dart` 同一族）──────────
//   · **不许编**：`since` 读不到就**不报时长**（不是报 0）；整份读不懂 ⇒ `null`
//     （"没问上"与"一件都没有"**必须分得开** —— 混成一句就是假话）；
//   · **不许在纯函数里读钟**：`now` 由调用方传进来（判据才可控）；
//   · **内部 id 一个都不许上屏**：认不出名字的房间说"另一个对话"。
//
// ⚠️ 纯逻辑：**不许 import flutter**（`models` 是纯逻辑层，进 `test/unit`）。
//    人话住在 `work_words.dart`（那样才进得了禁用词硬闸）。

import 'app_spec.dart';
import 'app_words.dart';
import 'landing_words.dart';
import 'scope.dart';
import 'space_words.dart';
import 'work_words.dart';

/// **一间正在干活的房间**（服务端那一行）。
class WorkingRow {
  const WorkingRow({
    required this.scope,
    required this.title,
    required this.since,
    required this.count,
  });

  /// 房间名（**内部 id** —— 只用来切房间、认名字，**绝不上屏**）。
  final String scope;

  /// 服务端给的名字（认不出就是 `null`）。
  final String? title;

  /// 最早那件活是什么时候开干的（毫秒；读不到就是 `null`）。
  final int? since;

  /// 这一间里有几件活开着（服务端数的，至少 1）。
  final int count;

  /// **读一行**。读不懂（缺 `scope` / 类型不对）⇒ `null` —— 调用方**跳过这一条**，
  /// 不许把整张清单弄空（与 `MiniApp.parse` 同一条纪律）。
  static WorkingRow? parse(Object? one) {
    if (one is! Map) return null;
    final rawScope = one['scope'];
    if (rawScope is! String) return null;
    final scope = rawScope.trim();
    if (scope.isEmpty) return null;
    final rawTitle = one['title'];
    final title = rawTitle is String && rawTitle.trim().isNotEmpty
        ? rawTitle.trim()
        : null;
    final rawSince = one['since'];
    final since = rawSince is num && rawSince.isFinite ? rawSince.toInt() : null;
    final rawCount = one['count'];
    final n = rawCount is num && rawCount.isFinite ? rawCount.toInt() : 1;
    return WorkingRow(
      scope: scope,
      title: title,
      since: since,
      count: n < 1 ? 1 : n,
    );
  }
}

/// **读服务端那一份回执**。
///
/// 🔴 **`null` = 这一次没问上**（网不通 / 非 200 / 读不懂）—— 与"一件活都没有"（空表）
///    **必须分得开**：混成一句"现在没有在干的活"就是**假话**，
///    而这条清单的全部价值就是"它现在到底在干什么"。
List<WorkingRow>? parseWorkingList(Object? json) {
  if (json is! Map) return null;
  final raw = json['working'];
  if (raw is! List) return null;
  final out = <WorkingRow>[];
  for (final one in raw) {
    final row = WorkingRow.parse(one);
    if (row != null) out.add(row);
  }
  return out;
}

/// **这一行叫什么**（屏幕上那几个字）。
///
/// 顺序（**一处一处往后退，最后一定有个说人话的名字**）：
///   ① 服务端给的那个名字（他自己写在那一格上的）；
///   ② 壳里那份清单里的名字（`mine`：app id ⇒ 它现在的名字）—— 服务端认不出时补位；
///   ③ 内置那两格各自的词（设置 / 发现）；
///   ④ 主对话 ⇒ 与窗口抬头同一句（[appName]）；
///   ⑤ 都认不出 ⇒ [workNamelessName]（**绝不把那串内部 id 摆出来**）。
String workRowName({
  required String scope,
  String? title,
  Map<String, String> mine = const {},
}) {
  final t = title?.trim() ?? '';
  if (t.isNotEmpty) return t;
  final byId = mine[scope]?.trim() ?? '';
  if (byId.isNotEmpty) return byId;
  if (scope == mainScope) return appName;
  if (scope == builtInSettingsId) return settingsAppLabel;
  if (scope == builtInDiscoverId) return discoverAppLabel;
  return workNamelessName;
}

/// **干了多久**（`null` = 读不到 ⇒ 这一句不画 —— **不编**）。
///
/// 不到一分钟 ⇒ [workAgeJustNow]（报"干了 0 分钟"是句笨话）。
String? workAgeLabel(int? since, {required int now}) {
  if (since == null) return null;
  final ms = now - since;
  if (ms < 0) return null; // 时钟倒着走 ⇒ 不知道，就不说
  if (ms < 60 * 1000) return workAgeJustNow;
  final minutes = ms ~/ (60 * 1000);
  if (minutes < 60) return '$workAgeDoing $minutes $workAgeMinute';
  final hours = ms ~/ (60 * 60 * 1000);
  if (hours < 24) return '$workAgeDoing $hours $workAgeHour';
  return '$workAgeDoing ${ms ~/ (24 * 60 * 60 * 1000)} $workAgeDay';
}

/// **这一行底下那一句**：`在干活 · 3 件 · 干了 2 分钟`（没有的段就少一段）。
String workRowSubtitle(WorkingRow row, {required int now}) {
  final parts = <String>[workBusyLabel];
  if (row.count > 1) parts.add('${row.count} $workCountUnit');
  final age = workAgeLabel(row.since, now: now);
  if (age != null) parts.add(age);
  return parts.join(workPartSep);
}
