// 桌面那张壁纸存在哪（契约 `docs/dev/131-WALLPAPER.md`）。
//
// 三条纪律照 `appearance_store.dart` / `process_level_store.dart`：
//   1. **坏了一律当"不设"**（那张暖纸）—— 偏好读坏了最多是回到默认底图，
//      **绝不能因此让桌面打不开**；
//   2. **读不出来不抛**（插件不可用 / 字符串被改坏 / 老版本写的值 ⇒ `wallpaperOf()` 兜底）；
//   3. **按设备存、不按账号存**：壁纸是**看这块屏的人**的偏好（同外观与字号那一条）。
//
// ⚠️ 只用一个 key（`hupo_wallpaper`），存的就是那个 id（`wp-07` / 空串）。
// ⚠️ 这一层只许 import models 与包（楼层闸钉着）。

import 'package:shared_preferences/shared_preferences.dart';

import '../models/wallpaper.dart';

class WallpaperStore {
  static const _key = 'hupo_wallpaper';

  String? _cached;
  bool _loaded = false;

  /// 读。**永远给得出一个值**（默认 = 不设），永远不抛。
  Future<String> read() async {
    if (_loaded) return _cached ?? wallpaperNone;
    try {
      final p = await SharedPreferences.getInstance();
      _cached = wallpaperOf(p.getString(_key));
    } catch (_) {
      _cached = wallpaperNone;
    }
    _loaded = true;
    return _cached!;
  }

  /// 存。**存不上也得能用**（这一次会话里内存里还有）。
  Future<void> write(String id) async {
    _cached = wallpaperOf(id);
    _loaded = true;
    try {
      final p = await SharedPreferences.getInstance();
      await p.setString(_key, _cached!);
    } catch (_) {
      /* 存不上就算了：这一次还看得见（下次开机会回默认） */
    }
  }
}
