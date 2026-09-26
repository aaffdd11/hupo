// 聊天窗口的外观与字号存在哪（契约 `docs/dev/119-APPEARANCE-AND-FONT.md` §二）。
//
// 三条纪律，照 `process_level_store.dart` / `token_store.dart`：
//
//   1. **坏了一律当默认值**（`system` ＋ 14 字）。
//      它是本机的一个偏好，读不出来最多是"回到默认外观"——
//      **绝不能因此让聊天打不开**（那才是把一件小事变成不能用）。
//   2. **读不出来不抛**：插件不可用、字符串被改坏、旧版本写的 token——
//      统统走 `chatAppearanceSettingsOf()` 那一层（两个轴各自认不出来 ⇒ 各自默认）。
//   3. **它按设备存、不按账号存**：亮暗与字号是**看这块屏的人的**设置，
//      不是隐私数据（时间线 / 草稿才是），换个人登录不需要把它清掉。
//      ⚠️ 而且它**恰恰不该跟着账号走**：同一个人换一台设备，屏幕可能一个亮一个暗
//      （DSH 那把选择器也住在客户端 localStorage 里，不是会话里的东西）。
//
// ⚠️ 只用一个 key（`hupo_chat_appearance`），两样编码成一个字符串 ——
//    为什么这么摆写在 `models/appearance.dart` 的 `chatAppearanceSettingsWire` 上。
//
// ⚠️ 这一层只许 import models 与包（楼层闸 `test/unit/import_rules_test.dart`）。

import 'package:shared_preferences/shared_preferences.dart';

import '../models/appearance.dart';

class AppearanceStore {
  static const _key = 'hupo_chat_appearance';

  ChatAppearanceSettings? _cached;
  bool _loaded = false;

  /// 读。**永远给得出一个设置**（默认 = 跟随系统 ＋ 14 字），永远不抛。
  Future<ChatAppearanceSettings> read() async {
    if (_loaded) return _cached ?? const ChatAppearanceSettings();
    try {
      final p = await SharedPreferences.getInstance();
      // ⚠️ 翻译在 `chatAppearanceSettingsOf` 里：**认不出来就是默认**，
      //    所以这里不需要再判一次空 / 坏值。
      _cached = chatAppearanceSettingsOf(p.getString(_key));
    } catch (_) {
      // 盘满 / 没权限 / 插件不可用：这一次会话里还是默认档。
      _cached = const ChatAppearanceSettings();
    }
    _loaded = true;
    return _cached!;
  }

  /// 存。**存不上也得能用**（这一次会话里内存里还有，和过程档位那条一样）。
  Future<void> write(ChatAppearanceSettings s) async {
    _cached = s;
    _loaded = true;
    try {
      final p = await SharedPreferences.getInstance();
      await p.setString(_key, chatAppearanceSettingsWire(s));
    } catch (_) {
      // 这一次会话里还是对的
    }
  }
}
