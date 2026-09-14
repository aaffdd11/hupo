// 令牌存哪儿。
//
// ⚠ 令牌 = 指挥这台机器上 agent 的钥匙。所以：
//   · 只存在本机（localStorage / shared_preferences），不往任何地方发
//   · **不进日志**，也不显示在界面上
//   · 被服务端拒了就立刻删掉 —— 留着一个坏令牌只会让每个请求都白跑
//
// 为什么不放 cookei：WebSocket 那条路要走子协议，cookie 在原生端又不好用；
// 令牌是一套两端都通的做法。

import 'package:shared_preferences/shared_preferences.dart';

const String _key = 'hupo_auth_token';

Future<String?> loadToken() async {
  try {
    final p = await SharedPreferences.getInstance();
    final v = p.getString(_key);
    return (v != null && v.isNotEmpty) ? v : null;
  } catch (_) {
    return null; // 隐私模式/存储不可用：退化成"这次会话要重新登录"，不影响能用
  }
}

Future<void> saveToken(String? token) async {
  try {
    final p = await SharedPreferences.getInstance();
    if (token == null || token.isEmpty) {
      await p.remove(_key);
    } else {
      await p.setString(_key, token);
    }
  } catch (_) {
    /* 存不上就算了，这次会话还能用 */
  }
}
