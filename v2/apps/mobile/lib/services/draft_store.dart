// 用户**自己打了、但还没被服务端认领**的那句话（欠账第 18 条，见
// `docs/dev/17-LOCAL-FIRST.md` §七第 1 条与 `docs/dev/21-DRAFTS.md`）。
//
// 问题长这样：`TimelineStore` 存的是**服务端说过的事实**（带 `seq` 的），
// 而用户自己打的那句（`queued` / `sent` / `failed`）**没有号** ⇒ 只住在内存里。
// 于是"打一半切出去 / 刷新一下" = **那句话没了**，而且用户不知道自己丢了什么。
//
// 定位照 `timeline_store.dart`：**只缓存，不判断**。它不解释、不挑、不合并，
// 只把**本机那几条**原样存下来，下次开机原样喂回 `Timeline`。
//
// ⚠️ 与 `timeline_store.dart` 的边界（**两边不许重叠**，各存各的）：
//
//   TimelineStore：服务端事实（带 `seq`）—— 助手说过什么、服务端认领过什么
//   DraftStore   ：本机未确认的发言（**没有号**）—— 我这边还没被认领的话
//
//   一句被服务端认领（`confirmed`）之后**就从这边消失**（它已经变成事实，
//   归 `timeline_store.dart` 了）。⇒ 刷新**不会**出现两遍。
//
// 三件"不做判断、但必须做"的事（和 `timeline_store.dart` 一模一样）：
//
//   1. **有界**：只留最后一段（[capDrafts] 条 / [capChars] 个字符）。
//      localStorage 会满，满了 `setStringList` 会抛——**抛了就当没存档**。
//      存档坏掉的后果必须小到"就是少几句话"，**绝不能因此让聊天不能用**。
//
//   2. **整条整条地丢**：从**最前面**丢，绝不把一条 JSON 截成两半。
//      （截半条 = 解不开 = 可能只画出半句话，那是编造。）
//
//   3. **命名空间**：和 `TimelineStore` 同一套理由——今天客户端只知道
//      "单用户、单作用域"，所以 [namespace] 是参数，并且**退出登录时清掉**
//      （换个人登录**不许看见上一个人打了一半的话**）。
//      ⚠️ 多人那一批要把 `userId` 那一半填上（同 `17-LOCAL-FIRST.md` §五）。
//
// ⚠️ 这一层**只许 import models 与包**（楼层闸 `test/unit/import_rules_test.dart`）。

import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../models/message_state.dart';
import '../models/timeline.dart';

/// 一条**本机未确认的发言**。存的就是它：`messageId` + 正文 + 当时那个态。
///
/// ⚠️ 为什么必须带 `messageId`：重发**必须用同一个**——
///    否则服务端会当成新的一句，于是 agent 干两遍（评审 E2，见 `chat_controller.resend`）。
class LocalDraft {
  const LocalDraft({required this.messageId, required this.text, required this.state});

  final String messageId;
  final String text;

  /// 存下来那一刻的态。**只会是** `queued` / `sent` / `failed`
  /// （读回来的时候 `sent` 会被降成 `failed`，理由见 [storableState]）。
  final MessageState state;

  @override
  bool operator ==(Object other) =>
      other is LocalDraft &&
      other.messageId == messageId &&
      other.text == text &&
      other.state == state;

  @override
  int get hashCode => Object.hash(messageId, text, state);
}

/// 从**时间线**里挑出该存档的那几条（纯函数，进 `test/unit` 硬闸）。
///
/// 判据只有一条：`UserUtterance` 且 `state != confirmed`。
///
/// ⚠️ 这条判据同时挡住两类"混进来"：
///   · 助手的气泡 / 分隔标记 —— 它们不是用户说的话；
///   · **服务端认领过的那句**（`_applyEcho` 把它推成 `confirmed`）——
///     那句已经是服务端事实，归 `timeline_store.dart`，**这边一条都不许留**。
List<LocalDraft> draftsFrom(Iterable<TimelineItem> items) => [
      for (final it in items)
        if (it is UserUtterance && it.state != MessageState.confirmed)
          LocalDraft(messageId: it.messageId, text: it.text, state: it.state),
    ];

/// 存进磁盘的那个态（纯函数）。
///
/// ⚠️ **`sent` 要降成 `failed`**——这是这一批里唯一一处"不是原样存"的判断，
///    理由是 N11（可重试），不是洁癖：
///
///      走到 `sent` 只说明 HTTP 200 到过，**回执还没来**。
///      而刷新之后，那条回执**永远不会来了**（`user/echo` 只补发带号的事实，
///      它补的是"那句已经被认领"这件事，没被认领的那次请求不会有人重放）。
///      ⇒ 留着 `sent` = 它在屏幕上写着「已送到」、**却没有「重发」这个入口**，
///        用户既不知道它到底到没到，也没有任何办法再试一次。**那就是说假话。**
///
///    降成 `failed` 之后：屏幕上还是「没发出去」+「重发」，用户就地能重来。
///    而重发**不会让 agent 干两遍**——服务端按 `messageId` 幂等
///    （重复那次返回 `duplicate`，不落盘、不重放）。
MessageState storableState(MessageState s) =>
    s == MessageState.sent ? MessageState.failed : s;

/// 读回来时能认的态。`confirmed` 不在其中：**它不该在存档里**
/// （真读到了也当"这一行坏了"跳过——宁可少一句，不可多一句假的）。
bool _isStoredState(MessageState s) =>
    s == MessageState.queued || s == MessageState.sent || s == MessageState.failed;

/// 一行存档 → 一条发言。解不开 / 缺字段 / 态不认识 ⇒ `null`（坏行，跳过）。
LocalDraft? draftFromJson(Map<String, dynamic> j) {
  final id = j['messageId'];
  final text = j['text'];
  if (id is! String || id.isEmpty || text is! String) return null;
  final raw = j['state'];
  for (final s in MessageState.values) {
    if (s.name == raw && _isStoredState(s)) {
      return LocalDraft(messageId: id, text: text, state: storableState(s));
    }
  }
  return null;
}

/// 一条发言 → 一行存档。**只写三个字段**（最少必要：id + 正文 + 态）。
Map<String, dynamic> draftToJson(LocalDraft d) => {
      'messageId': d.messageId,
      'text': d.text,
      'state': storableState(d.state).name,
    };

/// 我这边那几句"还没被认领的话"。
class DraftStore {
  DraftStore({this.namespace = 'single'});

  /// 命名空间。**换一个就是另一份存档**（互不可见）。
  ///
  /// ⚠️ 多租户之后它**按人**（`token_sub.dart` 从令牌里读出的 `sub`）——
  ///    所以它**不是 `final`**：换个人登录要能换一份。
  ///    改它的时机只有一个：拿到令牌之后、**读缓存之前**（`ChatController._bindNamespace`）。
  String namespace;

  static const _version = 1;

  /// 这一族键的**前缀**：所有命名空间共用一个前缀，靠 `.` 后面那一段区分。
  static String get keyPrefix => 'hupo_drafts_v$_version.';

  /// 留多少条。屏幕上同时"没发出去"的话一般就一两条（多了用户早看见了），
  /// 20 条是个宽裕的余量，也不至于把 localStorage 占出感觉来。
  static const capDrafts = 20;

  /// 留多少字符。一屏那几条发言加起来通常不到一千字；
  /// 这里给 64K（`String.length` = UTF-16 码元，就是 localStorage 的计量单位）
  /// ——够一整段长粘贴，又只是 localStorage 一般容量（5MB）的一个零头。
  static const capChars = 64 * 1024;

  String get key => 'hupo_drafts_v$_version.$namespace';

  /// 存/取/清**排队做**（和 `TimelineStore` 同一套）。
  ///
  /// ⚠️ 为什么要排队：`save()` 是异步的，而"退出登录"可能**正好落在**
  ///    一次写的中途 ⇒ 那次写会晚一步落地，**把上一个人打了一半的话写回去**，
  ///    下一个人登录就看见了。排队之后，`clear()` 一定排在它后面。
  Future<void> _tail = Future.value();

  /// 排队做 [op]；出任何事都返回 [onError]（**队列绝不因为一次失败就断掉**）。
  Future<T> _enqueue<T>(Future<T> Function() op, T onError) {
    final next = _tail.then((_) => op()).catchError((_) => onError);
    _tail = next.then((_) {}, onError: (_) {});
    return next;
  }

  /// 从后往前留 [maxDrafts] 条、[maxChars] 个字符；**整条整条地丢**。
  ///
  /// 纯函数：不进磁盘、不碰插件 ⇒ `test/unit` 直接钉（这一条出错的代价是"画半句话"）。
  static List<String> trimLines(
    List<String> lines, {
    int maxDrafts = capDrafts,
    int maxChars = capChars,
  }) {
    var out = lines.length > maxDrafts
        ? lines.sublist(lines.length - maxDrafts)
        : List<String>.from(lines);
    var total = out.fold<int>(0, (a, l) => a + l.length + 1);
    // ⚠️ 丢的时候一条一条丢，**不许截断字符串**
    while (out.isNotEmpty && total > maxChars) {
      total -= out.first.length + 1;
      out.removeAt(0);
    }
    return out;
  }

  /// 读回来。读不到、坏了、插件不可用 ⇒ **空**（不抛）。
  ///
  /// ⚠️ **一行坏不许拖垮整份存档**：坏行跳过，好的照用。
  Future<List<LocalDraft>> load() => _enqueue(_load, const <LocalDraft>[]);

  Future<List<LocalDraft>> _load() async {
    try {
      final p = await SharedPreferences.getInstance();
      final lines = p.getStringList(key);
      if (lines == null) return const [];
      final out = <LocalDraft>[];
      for (final line in lines) {
        try {
          final j = jsonDecode(line);
          if (j is! Map<String, dynamic>) continue;
          final d = draftFromJson(j);
          if (d != null) out.add(d);
        } catch (_) {
          // 这一行坏了：跳过。存档是"最好有"，不是"必须有"。
        }
      }
      return out;
    } catch (_) {
      return const [];
    }
  }

  /// 存下这几句。存不上就算了（**聊天本身绝不能因此不能用**）。
  Future<void> save(Iterable<LocalDraft> drafts) => _enqueue(() => _save(drafts), null);

  Future<void> _save(Iterable<LocalDraft> drafts) async {
    try {
      final lines = <String>[];
      for (final d in drafts) {
        if (d.messageId.isEmpty) continue;
        try {
          lines.add(jsonEncode(draftToJson(d)));
        } catch (_) {
          // 编码不了的（理论上不会有）：跳过这一条
        }
      }
      final p = await SharedPreferences.getInstance();
      await p.setStringList(key, trimLines(lines));
    } catch (_) {
      // 盘满 / 没权限 / 插件不可用：当没存档
    }
  }

  /// 清掉。**退出登录时必须调**——否则换个人登录会看见上一个人打了一半的话。
  Future<void> clear() => _enqueue(_clear, null);

  Future<void> _clear() async {
    try {
      final p = await SharedPreferences.getInstance();
      await p.remove(key);
    } catch (_) {}
  }

  /// **把所有命名空间的那份存档都清掉**（不只是当前这个）。
  ///
  /// ⚠️ 为什么必须是"全部"（`38-ISOLATION-SPLIT.md` §8.2）：
  ///    **共用设备**上换个人登录时，上一个人**打了一半的话**还在盘上。
  ///    只清自己那一份 = 等于没清。
  ///
  /// ⚠️ 跟着 [clear] 一起排队：退出登录可能**正好落在**一次写的中途，
  ///    那次写会晚一步落地、把上一个人打了一半的话**写回去**。
  Future<void> clearAllNamespaces() => _enqueue(_clearAllNamespaces, null);

  Future<void> _clearAllNamespaces() async {
    try {
      final p = await SharedPreferences.getInstance();
      for (final k in p.getKeys().where((k) => k.startsWith(keyPrefix)).toList()) {
        await p.remove(k);
      }
    } catch (_) {
      // 清不掉也不许让界面挂掉（存档是"最好有"）
    }
  }

  /// 等到**已经交出去的那几次存取都做完**（排队队列追平）。
  ///
  /// ⚠️ 给 `test/unit` 用的：控制器里那几处 `_saveDrafts()` 是**不 await 的**
  ///    （存档是"最好有"，绝不能拖慢用户按下发送之后那一屏）。
  ///    于是测"最后一次写的存档长什么样"的时候要有一个确定的等法——
  ///    `await Future.delayed(0)` 只是**赌**它做完了。生产路径不调这个。
  Future<void> flush() => _enqueue(() async {}, null);
}
