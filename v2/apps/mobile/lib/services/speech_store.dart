// "自动念"这个开关存在哪（契约 `docs/dev/68-SPEAK.md` §三）。
//
// 三条纪律照 `process_level_store.dart` / `token_store.dart`：
//
//   1. **坏了一律当默认值**（默认 = **关**：突然出声会吓人，也让"安静"不可预期）。
//   2. **读不出来不抛**：插件不可用 / 值被改坏 ⇒ 走默认（关），
//      **绝不能因此让聊天打不开**。
//   3. **它按设备存、不按账号存**：这是这台设备"要不要出声"的偏好，
//      换个人登录不需要把它清掉（和过程档位同一条理由）。
//
// ⚠️ 这一层只许 import models 与包（楼层闸 `test/unit/import_rules_test.dart`）。

import 'package:shared_preferences/shared_preferences.dart';

class SpeechStore {
  static const _key = 'hupo_speak_aloud';

  bool? _cached;
  bool _loaded = false;

  /// 读。**永远给得出一个值**（默认关），永远不抛。
  Future<bool> read() async {
    if (_loaded) return _cached ?? false;
    try {
      final p = await SharedPreferences.getInstance();
      _cached = p.getBool(_key) ?? false;
    } catch (_) {
      _cached = false;
    }
    _loaded = true;
    return _cached!;
  }

  /// 存。**存不上也得能用**（这一次会话里内存里还有，和令牌那条一样）。
  Future<void> write(bool on) async {
    _cached = on;
    _loaded = true;
    try {
      final p = await SharedPreferences.getInstance();
      await p.setBool(_key, on);
    } catch (_) {
      // 盘满 / 没权限 / 插件不可用：这一次会话里还是对的
    }
  }
}
