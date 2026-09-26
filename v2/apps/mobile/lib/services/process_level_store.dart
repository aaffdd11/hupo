// 过程两档存在哪（契约 `docs/dev/122-TWO-PROCESS-LEVELS.md` §三 / 手册 D7）。
//
// 三条纪律，照 `token_store.dart` / `timeline_store.dart`：
//
//   1. **坏了一律当默认值**（`defaultProcessLevel` = `doing`）。
//      它是本机的一个偏好，读不出来最多是"回到默认档"——
//      **绝不能因此让聊天打不开**（那才是把一件小事变成不能用）。
//   2. **读不出来不抛**：插件不可用、字符串被改坏、旧版本写的 token——
//      统统走 `processLevelOf()` 那一层（认不出来 ⇒ 默认）。
//      ⚠️ **老设备盘上的 `quiet` / `steps` 也走这一条**（那两档已砍，
//      归一到 `doing`；理由写在 `models/process_levels.dart`）。
//   3. **它按设备存、不按账号存**：档位不是隐私数据（时间线 / 草稿才是），
//      换个人登录不需要把它清掉。
//
// ⚠️ 这一层只许 import models 与包（楼层闸 `test/unit/import_rules_test.dart`）。

import 'package:shared_preferences/shared_preferences.dart';

import '../models/process_levels.dart';

class ProcessLevelStore {
  static const _key = 'hupo_process_level';

  ProcessLevel? _cached;
  bool _loaded = false;

  /// 读。**永远给得出一个档**（默认 = `doing`），永远不抛。
  Future<ProcessLevel> read() async {
    if (_loaded) return _cached ?? defaultProcessLevel;
    try {
      final p = await SharedPreferences.getInstance();
      // ⚠️ 翻译在 `processLevelOf` 里：**认不出来就是默认档**，
      //    砍掉的 `quiet` / `steps` 也在那儿一并归一 —— 所以这里不必再判一次空 / 坏值。
      _cached = processLevelOf(p.getString(_key));
    } catch (_) {
      _cached = defaultProcessLevel;
    }
    _loaded = true;
    return _cached!;
  }

  /// 存。**存不上也得能用**（这一次会话里内存里还有，和令牌那条一样）。
  Future<void> write(ProcessLevel level) async {
    _cached = level;
    _loaded = true;
    try {
      final p = await SharedPreferences.getInstance();
      await p.setString(_key, level.wire);
    } catch (_) {
      // 盘满 / 没权限 / 插件不可用：这一次会话里还是对的
    }
  }
}
