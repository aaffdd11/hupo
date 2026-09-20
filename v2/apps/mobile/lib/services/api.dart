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
///
/// ⚠️ **今天没有生产者**：`/api/say` 上的 429 归 [SayBusy]（忙不过来），
///    登录那条路（"试得太频繁、锁住了"）走的是 [login] 的 [LoginResult]，
///    根本不经过 [SayOutcome]。
///    留着它是因为**这件事本身还在**（登录就在限流）：哪天说话这条路也要限流，
///    那句话已经在这儿了，不用重新发明；而且它是 sealed 家族的一员，
///    删掉等于顺手改了"结果有哪几种"。
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

/// 它现在**忙不过来**：这一句**没收下**（按内存准入闸拒的，手册 `08-SPEC.md` §9.1）。
///
/// ⚠️ 和另外两种"没发出去"分清楚，对用户说的话完全不一样：
///   * **不是** [SayNetworkError]：网是通的，不许说"网断了"（那是假话）；
///   * **不是** [SayLocked]：那不是"你试得太频繁"，是它自己满了。
///
/// 对用户的意思就一句：**过一会儿再发一次**——所以本地那条要落 `failed`，
/// 屏幕上才有「重发」这个入口（不变量 N11：拒绝必须给人话 + 可重试）。
///
/// 真正的理由（内存占用比、阈值）**只住在服务端与手册里**——
/// 客户端不复制那个判断，也不知道那个数（客户端是哑的）。
class SayBusy extends SayOutcome {
  const SayBusy();
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
      // 分情况那一段提成了纯函数 [sayOutcomeOf]：协议语义**只有那一处**，
      // 于是它能进 `test/unit` 被逐码钉住（改错一个码 = 屏幕上换一句话）。
      return sayOutcomeOf(r.statusCode, r.body);
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

/// `/api/say` 的回执 → 结果。**纯函数**（不起网络、不碰界面、不看钟）——
/// ⇒ 它能进 `test/unit` 硬闸，逐条对表。
///
/// ⚠️ 为什么要提出来：这几个码的语义**一旦上线就冻结**（`03-DEVELOPMENT.md` §三，
///    旧客户端还在跑）。以前它们散在 `say()` 的 `switch` 里，只有"起个假 HTTP
///    对一遍"才测得到 ⇒ 最容易在某次顺手改里被改坏而闸不响。
///
/// 状态码的分工（**不许互相串**；同一个码在两个端点上可以是两件事）：
///   200 收下了 ｜ 401 令牌不行 ｜ 503 这台机器还没设密码 ｜
///   429 **这条路（`/api/say`）上只有一个意思：它忙不过来** ｜
///   其余 = 没细分，交给上层说"服务器没收下：HTTP xxx"。
///
/// ⚠️ **429 在 `/api/login` 上不是这个意思**（那边是"试得太频繁、锁住了"，
///    还要读 `retryAfterSec` 告诉用户等多久）。那条路走的是 [Api.login]，
///    **不经过这里**——两件事共用一个状态码，靠"是哪个端点"分开，
///    不靠猜 body（猜 body 等于把协议变成模糊的）。
SayOutcome sayOutcomeOf(int status, String body) {
  switch (status) {
    case 200:
      final j = jsonDecode(body) as Map;
      return SayOk(
        duplicate: j['duplicate'] == true,
        seq: (j['seq'] as num?)?.toInt(),
      );
    case 401:
      return const SayUnauthorized();
    case 503:
      return const SayNotSetup();
    case 429:
      // 内存准入闸拒的："我满了，这一句没收下"（手册 `08-SPEC.md` §9.1）。
      // ⚠️ 那边的阈值/占用比**不住在客户端**——这里只认"没收下"这个事实，
      //    以及"可以再发一次"这个结论（N11）。
      return const SayBusy();
    default:
      return SayRejected('HTTP $status');
  }
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
