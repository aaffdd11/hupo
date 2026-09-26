// 浮窗里看哪一屏（聊天 / 轨迹）存在哪（契约 `docs/dev/118-TRAJECTORY-VIEW.md` §一）。
//
// 三条纪律，照 `process_level_store.dart` / `token_store.dart` / `timeline_store.dart`：
//
//   1. **坏了一律当默认值**（`defaultChatView` = 聊天）。
//      它是本机的一个偏好，读不出来最多是"回到聊天那一屏"——
//      **绝不能因此让浮窗打不开**（那才是把一件小事变成不能用）。
//   2. **读不出来不抛**：插件不可用、字符串被改坏、旧版本写的 token——
//      统统走 `chatViewOf()` 那一层（认不出来 ⇒ 默认）。
//   3. **它按设备存、不按账号存**：看哪一屏不是隐私数据（时间线 / 草稿才是），
//      换个人登录不需要把它清掉。
//
// ⚠️ 这一层只许 import models 与包（楼层闸 `test/unit/import_rules_test.dart`）。

import 'package:shared_preferences/shared_preferences.dart';

import '../models/chat_view.dart';

class ChatViewStore {
  static const _key = 'hupo_chat_view';

  ChatView? _cached;
  bool _loaded = false;

  /// 读。**永远给得出一个视图**（默认 = 聊天），永远不抛。
  Future<ChatView> read() async {
    if (_loaded) return _cached ?? defaultChatView;
    try {
      final p = await SharedPreferences.getInstance();
      // ⚠️ 翻译在 `chatViewOf` 里：**认不出来就是默认**，
      //    所以这里不需要再判一次空 / 坏值。
      _cached = chatViewOf(p.getString(_key));
    } catch (_) {
      _cached = defaultChatView;
    }
    _loaded = true;
    return _cached!;
  }

  /// 存。**存不上也得能用**（这一次会话里内存里还有，和过程档位那条一样）。
  Future<void> write(ChatView view) async {
    _cached = view;
    _loaded = true;
    try {
      final p = await SharedPreferences.getInstance();
      await p.setString(_key, view.wire);
    } catch (_) {
      // 盘满 / 没权限 / 插件不可用：这一次会话里还是对的
    }
  }
}
