// 跟调度器说话。手册 `08-SPEC.md` §2.1。
//
// 这里只做"把话说出去、把回执读回来"。**不做判断**——
// 客户端是哑的（手册 §2.1「只上报事实，不做判断」）。
//
// ⚠️ 令牌**只走 `Authorization` 头**，绝不进 URL。
//    服务端也会忽略 URL 里的令牌（两边都守同一条规矩）。

import 'dart:convert';

import 'package:http/http.dart' as http;

/// 说话的结果。**把"为什么没成功"分清楚**——
/// 因为对用户说的话不一样，能做的事也不一样。
sealed class SayOutcome {
  const SayOutcome();
}

class SayOk extends SayOutcome {
  const SayOk({required this.duplicate, this.seq});
  final bool duplicate;

  /// 服务端给的号。**重复时是 null**（重复的那次不落盘，也就没有新号）。
  final int? seq;
}

/// 令牌不行（或没有）。→ 该回登录页，**不是**"网不好"。
class SayUnauthorized extends SayOutcome {
  const SayUnauthorized();
}

/// 这台机器还没设密码。→ 该说"还没设密码"，不是"你密码错了"。
class SayNotSetup extends SayOutcome {
  const SayNotSetup();
}

/// 试得太频繁。→ 要告诉用户**还有多久**（手册 D2：只说"太频繁"等于没说）。
class SayLocked extends SayOutcome {
  const SayLocked(this.retryAfterSec);
  final int retryAfterSec;
}

class SayRejected extends SayOutcome {
  const SayRejected(this.message);
  final String message;
}

/// 网的问题。→ 该说"没发出去，可以重发"。
class SayNetworkError extends SayOutcome {
  const SayNetworkError(this.detail);
  final String detail;
}

class Api {
  Api({this.base = '', http.Client? client}) : _c = client ?? http.Client();

  /// 空串 = 同源（我们的 web 就是同一个服务在服务）。
  final String base;
  final http.Client _c;

  static const _json = {'content-type': 'application/json'};

  Uri _u(String path) => Uri.parse('$base$path');

  /// 还没设密码吗？登录页靠它决定显示什么。
  Future<bool> needsSetup() async {
    try {
      final r = await _c.get(_u('/api/auth')).timeout(const Duration(seconds: 8));
      if (r.statusCode != 200) return false; // 问不到就别吓唬人
      return (jsonDecode(r.body) as Map)['needsSetup'] == true;
    } catch (_) {
      return false;
    }
  }

  /// 登录。**成功返回令牌，密码错返回 null**，其余抛。
  Future<LoginResult> login(String password) async {
    try {
      final r = await _c
          .post(_u('/api/login'), headers: _json, body: jsonEncode({'password': password}))
          .timeout(const Duration(seconds: 10));
      if (r.statusCode == 200) {
        final j = jsonDecode(r.body) as Map;
        return LoginResult(token: j['token'] as String?);
      }
      if (r.statusCode == 401) return const LoginResult(wrongPassword: true);
      if (r.statusCode == 429) {
        final j = jsonDecode(r.body) as Map;
        return LoginResult(lockedSec: (j['retryAfterSec'] as num?)?.toInt() ?? 0);
      }
      return LoginResult(other: 'HTTP ${r.statusCode}');
    } catch (e) {
      return LoginResult(networkError: '$e');
    }
  }

  /// 说一句。**幂等靠 messageId**——重发要用同一个 id，
  /// 否则服务端会把它当新的一句，于是 **agent 干两遍**。
  Future<SayOutcome> say({
    required String messageId,
    required String text,
    required String token,
    int? clientAt,
  }) async {
    try {
      final r = await _c
          .post(
            _u('/api/say'),
            headers: {..._json, 'authorization': 'Bearer $token'},
            body: jsonEncode({
              'messageId': messageId,
              'text': text,
              if (clientAt != null) 'clientAt': clientAt,
            }),
          )
          .timeout(const Duration(seconds: 20));
      switch (r.statusCode) {
        case 200:
          final j = jsonDecode(r.body) as Map;
          return SayOk(
            duplicate: j['duplicate'] == true,
            seq: (j['seq'] as num?)?.toInt(),
          );
        case 401:
          return const SayUnauthorized();
        case 503:
          return const SayNotSetup();
        case 429:
          final j = jsonDecode(r.body) as Map;
          return SayLocked((j['retryAfterSec'] as num?)?.toInt() ?? 0);
        default:
          return SayRejected('HTTP ${r.statusCode}');
      }
    } catch (e) {
      return SayNetworkError('$e');
    }
  }

  /// 令牌算不算数？——轻量探针。
  ///
  /// ⚠️ 为什么需要它：**WS 握手失败在客户端拿不到 HTTP 状态码**。
  ///    不分清"令牌不行"和"网不行"，坏令牌就会变成一个**永远转圈的界面**
  ///    （旧实现 B1 就是每 2 秒重连一次，什么都不说）。
  Future<TokenProbe> health(String token) async {
    try {
      final r = await _c
          .get(_u('/api/health'), headers: {'authorization': 'Bearer $token'})
          .timeout(const Duration(seconds: 8));
      return switch (r.statusCode) {
        200 => TokenProbe.ok,
        401 => TokenProbe.unauthorized,
        503 => TokenProbe.notSetup,
        _ => TokenProbe.unknown,
      };
    } catch (_) {
      return TokenProbe.unknown; // 网的问题 ⇒ 值得重试
    }
  }

  /// 服务端构建指纹 + 它的钟（协议 R10：每次连上对版本）。
  Future<Map<String, dynamic>?> version() async {
    try {
      final r = await _c.get(_u('/api/version')).timeout(const Duration(seconds: 8));
      if (r.statusCode != 200) return null;
      return jsonDecode(r.body) as Map<String, dynamic>;
    } catch (_) {
      return null;
    }
  }

  void close() => _c.close();
}

/// 令牌状态探针。
enum TokenProbe { ok, unauthorized, notSetup, unknown }

/// 登录结果。四种情况**分清楚**——对用户说的话完全不同。
class LoginResult {
  const LoginResult({this.token, this.wrongPassword = false, this.lockedSec, this.other, this.networkError});
  final String? token;
  final bool wrongPassword;
  final int? lockedSec;
  final String? other;
  final String? networkError;

  bool get ok => token != null;
}
