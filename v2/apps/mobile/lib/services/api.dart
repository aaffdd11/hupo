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
/// ⚠️ **它在说话这条路上仍然有生产者**：`/api/say` 的 429 里，
///    **不带** `{"error":"busy"}` 的那些就是它（见 [sayOutcomeOf]）。
///    所以别删——删了就等于把"试得太频繁"这件事从结果集合里去掉，
///    而**那条语义是冻结的**（旧客户端还在按它说话）。
///
/// （登录那条"锁住了"走的是 [login] 的 [LoginResult]，不经过这里；两件事都有。）
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
///   429 **要按 body 分**：`{"error":"busy"}` ⇒ 忙不过来；
///   其它 429 ⇒ 原来那个意思（试得太频繁 + `retryAfterSec`）｜
///   其余 = 没细分，交给上层说"服务器没收下：HTTP xxx"。
///
/// ⚠️ **429 在 `/api/login` 上也是另一回事**（"试得太频繁、锁住了"，
///    还要读 `retryAfterSec`）。那条路走的是 [Api.login]，**不经过这里**。
///    ⇒ 同一个码在三处三种事：靠"哪个端点 + body 里那个显式 `error`"分开，
///      **不许**靠"看码就断定"。
/// 这个 body 是不是"我忙不过来"（内存准入闸拒的）。
///
/// ⚠️ 只认**显式字段** `error == "busy"`；解析不了就当"不是"（宁可落到
/// 那个更保守的旧意思上，也不要凭猜把限流说成"忙"）。
bool isBusyBody(String body) {
  try {
    final j = jsonDecode(body);
    return j is Map && j['error'] == 'busy';
  } catch (_) {
    return false;
  }
}

/// 从 body 里读"还要等多少秒"（读不到就是 0 —— 和改动前的行为一致）。
int retryAfterSecOf(String body) {
  try {
    final j = jsonDecode(body);
    if (j is Map) return (j['retryAfterSec'] as num?)?.toInt() ?? 0;
  } catch (_) {
    // 读不出来就说 0：老行为就是这样（`?? 0`）
  }
  return 0;
}

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
      // ⚠️ **429 在这条路上有两种意思，必须分开**（同一个码、两个端点、两种事，
      //    是这个项目既有的风格：`/api/login` 上 429 也是另一回事）。
      //    · `{"error":"busy"}` ⇒ 内存准入闸拒的（手册 `08-SPEC.md` §9.1）：
      //      **我满了，这一句没收下**，过一会儿再发一次。
      //    · 其它（`{"error":"locked","retryAfterSec":N}`）⇒ **原来那个意思**：
      //      你试得太频繁，等 N 秒。**这条语义不许被 busy 吃掉**
      //      （`03-DEVELOPMENT.md` §三：协议字段一旦上线就冻结）。
      //
      // ⚠️ 这不是"猜 body"：`error` 是**显式字段**（登录那条路也一直这么传
      //    `retryAfterSec`）。猜的是"看码就断定"，而那个断定今天已经不成立了。
      if (isBusyBody(body)) return const SayBusy();
      return SayLocked(retryAfterSecOf(body));
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
