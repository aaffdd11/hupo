// **打字框里那串还没发出去的字**（主人 2026-09-22：
// *"就是要有一个空的输入框，但如果用户输入过，没发送，则显示在上面作为草稿。草稿也是要记住的。"*）
//
// ── ⚠️ 它和 `draft_store.dart` **不是同一本账**（别混）────────────
//
// | | 存什么 | 什么时候进的这本账 |
// |---|---|---|
// | `draft_store.dart` | **按过发送**、但还没被服务端认领的那句话 | 按下发送之后（它是时间线的一部分，带四态和"重发"） |
// | **这一本** | **压根没按发送**、只住在打字框里的字 | 一边打一边存（它**不属于时间线**，一个字都没发出去） |
//
// ⇒ 所以是**两本账、两个键**：混成一个的话，"按过发送"和"还在打字"这两种状态会互相冒充
//    （最刺眼的形状：刷新之后一句话既在时间线上、又在草稿条里 —— 画两遍）。
//
// ⚠️ 按人分（`token_sub.dart` 从令牌里读 `sub`）：换个人登录**不许**看见上一个人打了一半的话
//    （和 `DraftStore` / `TimelineStore` 同一条规矩）。

import 'package:shared_preferences/shared_preferences.dart';

class ComposeStore {
  ComposeStore({this.namespace = 'single'});

  /// 命名空间（按人）。改它的时机只有一个：拿到令牌之后、读缓存之前。
  String namespace;

  static const _version = 1;

  /// 留多少字符。打字框里的草稿：够一整段长粘贴，又只是 localStorage 的一个零头。
  static const capChars = 8 * 1024;

  String get key => 'hupo_compose_v$_version.$namespace';

  /// 存/取/清**排队做**（同 `DraftStore`：退出登录可能正好落在一次写的中途）。
  Future<void> _tail = Future.value();

  Future<T> _enqueue<T>(Future<T> Function() op, T onError) {
    final next = _tail.then((_) => op()).catchError((_) => onError);
    _tail = next.then((_) {}, onError: (_) {});
    return next;
  }

  /// 读回来。读不到 / 插件不可用 ⇒ `null`（不抛）。
  Future<String?> load() => _enqueue(_load, null);

  Future<String?> _load() async {
    try {
      final p = await SharedPreferences.getInstance();
      final s = p.getString(key);
      if (s == null || s.isEmpty) return null;
      return s;
    } catch (_) {
      return null;
    }
  }

  /// 存下这串字。空串 ⇒ **清掉**（"没有草稿"和"草稿是空"是一回事）。
  /// ⚠️ 存不上就算了 —— **聊天本身绝不能因此不能用**（同 `DraftStore`）。
  Future<void> save(String text) => _enqueue(() => _save(text), null);

  Future<void> _save(String text) async {
    try {
      final p = await SharedPreferences.getInstance();
      final t = text.length > capChars ? text.substring(0, capChars) : text;
      if (t.trim().isEmpty) {
        await p.remove(key);
      } else {
        await p.setString(key, t);
      }
    } catch (_) {
      // 盘满 / 没权限 / 插件不可用：当没存
    }
  }

  /// 清掉。⚠️ **退出登录时必须调**（换个人不许看见上一个人打了一半的话）。
  Future<void> clear() => _enqueue(_clear, null);

  Future<void> _clear() async {
    try {
      final p = await SharedPreferences.getInstance();
      await p.remove(key);
    } catch (_) {}
  }
}
