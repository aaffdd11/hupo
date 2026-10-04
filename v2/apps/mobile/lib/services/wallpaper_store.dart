// 桌面那张壁纸存在哪（契约 `docs/dev/131-WALLPAPER.md`）。
//
// 三条纪律照 `appearance_store.dart` / `process_level_store.dart`：
//   1. **坏了一律当"不设"**（那张暖纸）—— 偏好读坏了最多是回到默认底图，
//      **绝不能因此让桌面打不开**；
//   2. **读不出来不抛**（插件不可用 / 字符串被改坏 / 老版本写的值 ⇒ `wallpaperOf()` 兜底）；
//   3. ★ **2026-10-04 起改了口径：壁纸跟着账号走**（主人拍板：*"壁纸不要按设备存"*，
//      契约 `docs/dev/183`）。⇒ 这一层降级成**本机缓存 ＋ 离线兜底**：
//      · **账号那一份**是权威（`GET/POST /api/prefs`，见 `chat_screen.dart`）；
//      · 本机这一份让"开机第一帧就画对"和"网不通也看得见"两件事成立；
//      · 还有一个 `pending` 标记：他刚挑的那张**没写进账号**时留着，下次开机补一次
//        （不然"在这台设备上换了、别的设备看不见"这件事会静悄悄发生）。
//
// ⚠️ 两个 key：`hupo_wallpaper`（那个 id：`wp-07` / 空串）＋ `hupo_wallpaper_pending`（'1' / '0'）。
// ⚠️ 这一层只许 import models 与包（楼层闸钉着）。

import 'package:shared_preferences/shared_preferences.dart';

import '../models/wallpaper.dart';

class WallpaperStore {
  static const _key = 'hupo_wallpaper';
  static const _pendingKey = 'hupo_wallpaper_pending';

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

  /// **本机这一份还没写进账号**吗（＝要补一次 `POST /api/prefs`）。
  /// ⚠️ 读不出来一律 `false`：宁可漏补一次，也不许每次开机都白写一遍账号。
  Future<bool> readPending() async {
    try {
      final p = await SharedPreferences.getInstance();
      return p.getString(_pendingKey) == '1';
    } catch (_) {
      return false;
    }
  }

  /// 记"还没同步上"（`true`）/ 清掉它（`false`）。存不上不抛。
  Future<void> writePending(bool on) async {
    try {
      final p = await SharedPreferences.getInstance();
      await p.setString(_pendingKey, on ? '1' : '0');
    } catch (_) {
      /* 存不上就算了：这一次还看得见（下次开机会回默认） */
    }
  }
}
