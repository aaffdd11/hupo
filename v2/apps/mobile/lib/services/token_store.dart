// 令牌存哪。手册 `08-SPEC.md` §15.5。
//
// ⚠️ 两条纪律：
//   1. **连不上服务器不许清令牌**。旧实现 B1 就是"任何网络失败都当未登录"，
//      于是网络抖一下就把人踢回登录页——而 06 那种用户**每 30 天要打一次电话**。
//   2. 令牌只存本机，**不进 URL、不进日志**。

import 'package:shared_preferences/shared_preferences.dart';

class TokenStore {
  static const _key = 'hupo_auth_token';

  String? _cached;
  bool _loaded = false;

  Future<String?> read() async {
    if (_loaded) return _cached;
    try {
      final p = await SharedPreferences.getInstance();
      _cached = p.getString(_key);
    } catch (_) {
      _cached = null;
    }
    _loaded = true;
    return _cached;
  }

  Future<void> write(String token) async {
    _cached = token;
    _loaded = true;
    try {
      final p = await SharedPreferences.getInstance();
      await p.setString(_key, token);
    } catch (_) {
      // 存不上也得能用（这一次会话里内存里还有）
    }
  }

  /// **只在明确判定"这个令牌失效了"时调用**——
  /// 例如服务端回 401，而**不是**网络失败。
  Future<void> clear() async {
    _cached = null;
    _loaded = true;
    try {
      final p = await SharedPreferences.getInstance();
      await p.remove(_key);
    } catch (_) {}
  }
}
