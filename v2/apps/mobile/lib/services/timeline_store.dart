// 冷启动那一下，屏幕不该是空的（手册 `04-ROADMAP.md` **S5c** / 缺陷 **B6**）。
//
// 定位是手册 `03-DEVELOPMENT.md` 给的：**"只缓存，不判断"**。
// ⇒ 它不解释事件、不挑事件、不合并事件，只把**服务端说过的事实**原样存下来，
//   下次开机**原样喂回 `Timeline`**。于是那一屏和断线前是**同一条渲染路径**画的
//   —— 不可能出现"缓存版和实时版长得不一样"。
//
// 存哪些：**带 `seq` 的才存**。这条规则不需要另立名单——
//   决策 P-g 里"瞬态不占号"本来就意味着**号 = 这是落盘的事实**。
//
// ⚠️ 三件"不做判断、但必须做"的事：
//
//   1. **有界**：只留最后一段（[capEvents] 条 / [capChars] 个字符）。
//      localStorage 会满，满了 `setStringList` 会抛——**抛了就当没缓存**。
//      缓存坏掉的后果必须小到"就是空屏"，**绝不能因此让聊天不能用**。
//
//   2. **整条整条地丢**：从**最前面**丢，绝不把一条 JSON 截成两半。
//      （截半条 = 解不开 = 那一屏可能只画出半句话，那是编造。）
//
//   3. **命名空间**：手册要求带 `scopeId + userId`。
//      今天客户端只知道"单用户、单作用域"（客户端里既没有 `scopeId`，
//      也不解析令牌里的用户名）⇒ [namespace] 是参数，现在只传一个值，
//      并且**退出登录时清掉**——这样两个账号先后用同一台机器也不会串。
//      ⚠️ **多人那一批必须把 `userId` 那一半填上**（见 `docs/dev/17-LOCAL-FIRST.md`）。

import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// 本机那"一屏"。
class TimelineStore {
  TimelineStore({this.namespace = 'single'});

  /// 命名空间。**换一个就是另一份缓存**（互不可见）。
  final String namespace;

  static const _version = 1;

  /// 留最后多少条。一屏大概十几条，200 条够翻好几屏，也不至于写不动。
  static const capEvents = 200;

  /// 留多少字符。localStorage 一般 5MB，这里只要一个零头就够——
  /// 用 `String.length`（UTF-16 码元）当尺子：它就是 localStorage 的计量单位。
  static const capChars = 256 * 1024;

  String get key => 'hupo_timeline_v$_version.$namespace';

  /// 存/取/清**排队做**。
  ///
  /// ⚠️ 为什么要排队：`save()` 是异步的，而"服务端说你这号不对了"可能**正好落在**
  ///    一次写的中途 ⇒ 那次写会晚一步落地，把刚判死的缓存**又写回去**，
  ///    下次开机就画出那个不存在的世界。排队之后，`clear()` 一定排在它后面。
  Future<void> _tail = Future.value();

  /// 排队做 [op]；出任何事都返回 [onError]（**队列绝不因为一次失败就断掉**）。
  Future<T> _enqueue<T>(Future<T> Function() op, T onError) {
    final next = _tail.then((_) => op()).catchError((_) => onError);
    _tail = next.then((_) {}, onError: (_) {});
    return next;
  }

  /// 这条事实该不该缓存：**有号的才是事实**（瞬态只改状态，重启后本来就该消失）。
  static bool isPersistable(Map<String, dynamic> event) => event['seq'] is int;

  /// 从后往前留 [maxEvents] 条、[maxChars] 个字符；**整条整条地丢**。
  ///
  /// 纯函数：不进磁盘、不碰插件 ⇒ `test/unit` 直接钉（这一条出错的代价是"画半句话"）。
  static List<String> trimLines(
    List<String> lines, {
    int maxEvents = capEvents,
    int maxChars = capChars,
  }) {
    var out = lines.length > maxEvents
        ? lines.sublist(lines.length - maxEvents)
        : List<String>.from(lines);
    var total = out.fold<int>(0, (a, l) => a + l.length + 1);
    // ⚠️ 丢的时候一条一条丢，**不许截断字符串**
    while (out.isNotEmpty && total > maxChars) {
      total -= out.first.length + 1;
      out.removeAt(0);
    }
    return out;
  }

  /// 把上一屏读回来。读不到、坏了、插件不可用 ⇒ **空**（不抛）。
  ///
  /// ⚠️ **一行坏不许拖垮整屏**：坏行跳过，好的照用。
  Future<List<Map<String, dynamic>>> load() =>
      _enqueue(_load, const <Map<String, dynamic>>[]);

  Future<List<Map<String, dynamic>>> _load() async {
    try {
      final p = await SharedPreferences.getInstance();
      final lines = p.getStringList(key);
      if (lines == null) return const [];
      final out = <Map<String, dynamic>>[];
      for (final line in lines) {
        try {
          final e = jsonDecode(line);
          if (e is Map<String, dynamic>) out.add(e);
        } catch (_) {
          // 这一行坏了：跳过。缓存是"最好有"，不是"必须有"。
        }
      }
      return out;
    } catch (_) {
      return const [];
    }
  }

  /// 存下这一屏。存不上就算了（**聊天本身绝不能因此不能用**）。
  Future<void> save(Iterable<Map<String, dynamic>> events) =>
      _enqueue(() => _save(events), null);

  Future<void> _save(Iterable<Map<String, dynamic>> events) async {
    try {
      final lines = <String>[];
      for (final e in events) {
        if (!isPersistable(e)) continue;
        try {
          lines.add(jsonEncode(e));
        } catch (_) {
          // 编码不了的（理论上不会有）：跳过这一条
        }
      }
      final p = await SharedPreferences.getInstance();
      await p.setStringList(key, trimLines(lines));
    } catch (_) {
      // 盘满 / 没权限 / 插件不可用：当没缓存
    }
  }

  /// 清掉。**退出登录、以及服务端说"你这号不对了"时必须调**——
  /// 否则下次开机又会把那个**已经不存在的世界**画出来。
  Future<void> clear() => _enqueue(_clear, null);

  Future<void> _clear() async {
    try {
      final p = await SharedPreferences.getInstance();
      await p.remove(key);
    } catch (_) {}
  }

  /// 等到**已经交出去的那几次存取都做完**（排队队列追平）。
  ///
  /// ⚠️ 给 `test/unit` 用的：控制器里那几处写缓存是**不 await 的**
  ///    （缓存是"最好有"，绝不能拖慢屏幕）。于是测"删完之后盘上还剩什么"的时候
  ///    要有一个确定的等法——`await Future.delayed(0)` 只是**赌**它做完了。
  ///    和 `DraftStore.flush` 同一套；生产路径不调这个。
  Future<void> flush() => _enqueue(() async {}, null);
}
