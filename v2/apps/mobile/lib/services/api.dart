// 跟调度器说话。手册 `08-SPEC.md` §2.1。
//
// 这里只做"把话说出去、把回执读回来"。**不做判断**——
// 客户端是哑的（手册 §2.1「只上报事实，不做判断」）。
//
// ⚠️ 令牌**只走 `Authorization` 头**，绝不进 URL。
//    服务端也会忽略 URL 里的令牌（两边都守同一条规矩）。

import 'package:hupo_app/models/image_outcome.dart';
import 'package:hupo_app/models/key_outcome.dart';

export 'package:hupo_app/models/key_outcome.dart';

import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/dev_harness.dart';
import '../models/export.dart';
import '../models/app_spec.dart';
import '../models/scope.dart';
import '../models/space.dart';
import '../models/trash.dart';

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

/// **他没把握这一句该送到哪一间 ⇒ 先反问一句**（`96-OWNER-DECISIONS.md` 第 16 条；
/// 契约 `docs/dev/84-DISPATCHER-FOCUS.md` §三·3 的焦点路由）。
///
/// 服务端那条规则（那边是唯一说了算的地方 · `src/focus.js` 的 `routeTarget`）：
/// **归处提示**（客户端给的 `scope`）和**他刚才在看的那一间**不一致 ⇒
/// 既不按提示送、也不按焦点送，而是**反问**；而且**一个字都不落盘**
/// （盘上不许留"没被回答的话"）。
///
/// ⚠️ 和另外三种"没发出去"分清楚（对用户说的话不一样）：
///   * 不是 [SayNetworkError]（网是通的）、不是 [SayBusy]（它没满）、
///     不是 [SayLocked]（不是试得太频繁）—— 是**这一句的归处不确定**；
///   * 结果上它和它们一样：本地那条落 `failed` ⇒ 有「重发」这条路（N11），
///     **一个字都不丢**（反问那次没落盘 ⇒ 同一个 `messageId` 还能再用）。
class SayAsk extends SayOutcome {
  const SayAsk({required this.question, required this.scope, this.focus});

  /// 那句问话（**服务端给的人话** —— 客户端不许自己拼一句，免得两处口径）。
  final String question;

  /// 这一句**本来要去**的那一间（客户端给的那个 `scope`）。
  final String scope;

  /// 他刚才**在看**的那一间（服务端记着的焦点；`null` = 服务端没被告知过）。
  final String? focus;
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
  /// **手机号 + 验证码**（契约 `docs/dev/37-MULTITENANT.md` §三/§六）。
  ///
  /// ⚠️ 现在就一种码：服务端的**临时码**（默认是关的）。所以
  ///    "码不对" 与 "还没接短信" 必须**分开说** —— 混成一句，用户会一直重输。
  Future<LoginResult> loginWithCode(String phone, String code) async {
    try {
      final r = await _c
          .post(_u('/api/login'), headers: _json, body: jsonEncode({'phone': phone, 'code': code}))
          .timeout(const Duration(seconds: 10));
      if (r.statusCode == 200) {
        final j = jsonDecode(r.body) as Map;
        return LoginResult(token: j['token'] as String?);
      }
      if (r.statusCode == 503) {
        return const LoginResult(noSms: true);
      }
      if (r.statusCode == 400) return const LoginResult(badPhone: true);
      if (r.statusCode == 401) return const LoginResult(wrongCode: true);
      if (r.statusCode == 429) {
        final j = jsonDecode(r.body) as Map;
        return LoginResult(lockedSec: (j['retryAfterSec'] as num?)?.toInt() ?? 0);
      }
      return LoginResult(other: 'HTTP ${r.statusCode}');
    } catch (e) {
      return LoginResult(networkError: '$e');
    }
  }

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
  ///
  /// [scope] = **这一句是说给哪个房间的**（契约 `83-APP-WORKSPACE.md` §五·甲）。
  /// ⚠️ 协议是**加一个可选字段**，不是新端点：不带 = `main`（老客户端照旧）。
  ///    已有那几个字段的语义**一个都不许动**（`03-DEVELOPMENT.md` §三：字段冻结）。
  /// ⚠️ 客户端**永远带上**（和流上那个 `scope` 同一份值）——
  ///    "说给哪一间"与"听哪一间"必须是同一间，不许一处带一处不带。
  Future<SayOutcome> say({
    required String messageId,
    required String text,
    required String token,
    int? clientAt,
    String scope = mainScope,
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
              'scope': scope,
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

  /// **要一个验证码**（登录那一屏那个按钮）。
  ///
  /// ⚠️ **码本身永远不回给界面**（主人 2026-09-21：验证码是掩码、不许写在屏上）——
  ///    这里只回"发出去没有、为什么没发出去"。
  Future<CodeSend> sendCode(String phone) async {
    try {
      final r = await _c
          .post(_u('/api/send-code'), headers: _json, body: jsonEncode({'phone': phone}))
          .timeout(const Duration(seconds: 10));
      if (r.statusCode == 200) return CodeSend.sent;
      if (r.statusCode == 503) return CodeSend.noSms;
      if (r.statusCode == 400) return CodeSend.badPhone;
      return CodeSend.failed;
    } catch (_) {
      return CodeSend.failed;
    }
  }

  /// **我那台到哪一步了**（契约 `38` §8.3：等待屏 / 填钥匙屏靠它）。
  ///
  /// ⚠️ **问不到就当"就绪"**（`SpaceInfo()` 的默认值）—— 网抖一下不该把人
  ///    永久挡在"正在给你开空间"那一屏上（那比"进聊天然后发现没数据"更糟）。
  Future<SpaceInfo> space(String token) async {
    try {
      final r = await _c
          .get(_u('/api/space'), headers: {'authorization': 'Bearer $token'})
          .timeout(const Duration(seconds: 8));
      if (r.statusCode != 200) return const SpaceInfo();
      return SpaceInfo.fromJson(jsonDecode(r.body));
    } catch (_) {
      return const SpaceInfo(); // 认不出来 / 问不到 ⇒ 按就绪
    }
  }

  /// **我的小程序清单**（乙-1 · 契约 `docs/dev/59-USER-APPS.md`）。
  ///
  /// ⚠️ **问不到就是空清单**（不抛）：摆不出图标，也不该把聊天弄挂。
  /// ⚠️ **认证只走令牌**（服务端按 `claim.sub` 取那一份）—— 客户端**不报身份**。
  Future<List<MiniApp>> apps(String token) async {
    try {
      final r = await _c
          .get(_u('/api/apps'), headers: {'authorization': 'Bearer $token'})
          .timeout(const Duration(seconds: 8));
      if (r.statusCode != 200) return const [];
      final j = jsonDecode(r.body);
      if (j is! Map) return const [];
      final raw = j['apps'];
      if (raw is! List) return const [];
      final now = DateTime.now().millisecondsSinceEpoch;
      final out = <MiniApp>[];
      for (final one in raw) {
        // ⚠️ 解析不过的**跳过那一条**（不许把整个桌面弄空），见 `MiniApp.parse`
        final app = MiniApp.parse(one, now: now);
        if (app != null) out.add(app);
      }
      return out;
    } catch (_) {
      return const [];
    }
  }

  /// 问一次「在浏览器里打开那一台」的短时效链接
  /// （契约 `docs/dev/82-DEV-MODE.md` §五 · `GET /api/dev-harness`，**要琥珀登录**）。
  ///
  /// ⚠️ 这不是"判断谁是开发者"：服务端说了算。客户端只把回执如实分成四种
  ///    （[devHarnessOutcomeOf]）—— 🔴 **非 200 就是"没被标"**，界面据此**不画按钮**
  ///    （画一个按不动的按钮 = 界面上出现做不到的东西）。
  /// ⚠️ 那条 `url` **原样**带回（服务端现签的入口；我们不许自己拼、不许改参数）。
  Future<DevHarnessOutcome> devHarness(String token) async {
    try {
      final r = await _c
          .get(_u('/api/dev-harness'), headers: {'authorization': 'Bearer $token'})
          .timeout(const Duration(seconds: 8));
      return devHarnessOutcomeOf(r.statusCode, r.body);
    } catch (e) {
      // 网的问题 ⇒ 值得再问一次（**不是**"这台没被标"）
      return DevHarnessUnreachable('$e');
    }
  }

  /// **替一个小程序问一句**（乙-4b）。
  ///
  /// 🔴 花的是**看的人自己的钥匙** —— 服务端那边把这个动作送进**他自己的环境**里花；
  ///    客户端这一侧**不碰钥匙**（也从来没有钥匙）。
  /// ⚠️ 四种结果分开：成了 / 没允许 / 问得太勤 / 别的（**不许混成一句**，
  ///    混了用户只会一直重试）。
  Future<AskOutcome> appAsk(String token, String appId, String prompt) async {
    try {
      final r = await _c
          .post(
            _u('/api/app-ask'),
            headers: {'authorization': 'Bearer $token', ..._json},
            body: jsonEncode({'appId': appId, 'prompt': prompt}),
          )
          .timeout(const Duration(seconds: 45));
      final j = r.statusCode == 200 ? jsonDecode(r.body) : null;
      if (r.statusCode == 200 && j is Map && j['text'] is String) {
        return AskOutcome(text: j['text'] as String);
      }
      String why = '没问成';
      try {
        final e = jsonDecode(r.body);
        if (e is Map && e['error'] is String) why = e['error'] as String;
      } catch (_) {
        /* 认不出就用人话那句 */
      }
      return AskOutcome(error: why);
    } catch (_) {
      return const AskOutcome(error: '问不出去（网络没通）');
    }
  }

  /// **「发现」清单**（乙-3）：大家发出来的小程序。**只读**。
  /// ⚠️ 问不到就是空清单（不抛）—— 那一屏会如实说"现在还没有"。
  /// **往前取一页**（批 C：老消息往上翻着加载 · `docs/dev/64-CHAT-REDESIGN.md` §三）。
  ///
  /// ⚠️ 回来的是**原始带号事件**（和流里那些一模一样，含墓碑）——去重/隐藏由
  ///    `Timeline` 那一层按同一套规则做（服务端**不替我们筛**，免得两处口径）。
  /// ⚠️ 失败 ⇒ **空的一页 + `hasMore:false`**：宁可"取不到"（界面上如实说），
  ///    也不许抛到界面那一层变成一句看不懂的错。
  ///
  /// [scope] = **哪一间的老消息**（契约 `83-APP-WORKSPACE.md` §六·4）。
  /// ⚠️ 它和"翻老消息"是**同一件事的那个门槛**：切了房间还按上一间的号去翻，
  ///    屏幕上就会把**别人房间**的老话接进来。默认 `main` = 不带的老行为。
  Future<OlderPage> older({
    required String token,
    required int before,
    int limit = 50,
    String scope = mainScope,
  }) async {
    try {
      final r = await _c
          .get(
            _u(
              '/api/timeline?before=$before&limit=$limit'
              '&scope=${Uri.encodeQueryComponent(scope)}',
            ),
            headers: {'authorization': 'Bearer $token'},
          )
          .timeout(const Duration(seconds: 12));
      if (r.statusCode != 200) return const OlderPage(frames: [], hasMore: false, ok: false);
      final j = jsonDecode(r.body);
      if (j is! Map) return const OlderPage(frames: [], hasMore: false, ok: false);
      final raw = j['frames'];
      final frames = <Map<String, dynamic>>[];
      if (raw is List) {
        for (final one in raw) {
          if (one is Map) frames.add(Map<String, dynamic>.from(one));
        }
      }
      return OlderPage(frames: frames, hasMore: j['hasMore'] == true, ok: true);
    } catch (_) {
      return const OlderPage(frames: [], hasMore: false, ok: false);
    }
  }

  Future<List<DiscoverApp>> discover(String token) async {
    try {
      final r = await _c
          .get(_u('/api/discover'), headers: {'authorization': 'Bearer $token'})
          .timeout(const Duration(seconds: 8));
      if (r.statusCode != 200) return const [];
      final j = jsonDecode(r.body);
      if (j is! Map) return const [];
      final raw = j['apps'];
      if (raw is! List) return const [];
      final out = <DiscoverApp>[];
      for (final one in raw) {
        final app = DiscoverApp.parse(one);
        if (app != null) out.add(app);
      }
      return out;
    } catch (_) {
      return const [];
    }
  }

  /// **把我自己那串钥匙送过去**（只送到他自己那一台）。
  ///
  /// ⚠️ 返回的是**四种失败分开的**结果（空白 / 字符不对 / 太长 / 没送过去）——
  ///    混成一句用户会一直重试（`space_words.dart` 里那四句就是为此）。
  /// ⚠️ **客户端不做它的裁判**：像不像钥匙由上游说了算，这里只挡"明摆着的坏输入"。
  Future<KeySend> setModelKey(String token, String key) async {
    final k = key.trim();
    if (k.isEmpty) return KeySend.blank;
    if (k.length > 4096) return KeySend.tooLong;
    if (RegExp(r'[^\x20-\x7e]').hasMatch(k)) return KeySend.badChars;
    try {
      final r = await _c
          .post(
            _u('/api/model-key'),
            headers: {'content-type': 'application/json', 'authorization': 'Bearer $token'},
            body: jsonEncode({'key': k}),
          )
          .timeout(const Duration(seconds: 15));
      if (r.statusCode == 200) return KeySend.ok;
      if (r.statusCode == 400) {
        final e = (jsonDecode(r.body) as Map)['error'];
        if (e == 'blank-key') return KeySend.blank;
        if (e == 'bad-key-chars') return KeySend.badChars;
      }
      return KeySend.failed;
    } catch (_) {
      return KeySend.failed;
    }
  }

  /// **配置页那四样**（主人 2026-09-24 定的形状 · 契约 `docs/dev/79-CREDS-TABS.md`）。
  ///
  /// ⚠️ 与 [`setModelKey`] 的分别：那一条是**老路**（只写语言那一把，协议冻结、老客户端还在跑）；
  ///    这一条**一次能写多字段**（语音那三样必须一次写完，不然会有"填了两样"的半截状态）。
  /// ⚠️ 这里**也只挡明摆着的坏输入**（空 / 非可打印 / 太长）——像不像钥匙由上游说了算。
  Future<KeySend> setCreds(String token, Map<String, String> creds) async {
    final clean = <String, String>{};
    for (final e in creds.entries) {
      final v = e.value.trim();
      if (v.isEmpty) continue; // 空的**不送**（服务端那边也拒）
      if (v.length > 4096) return KeySend.tooLong;
      if (RegExp(r'[^\x20-\x7e]').hasMatch(v)) return KeySend.badChars;
      clean[e.key] = v;
    }
    // 一样都没填 ⇒ 当成"空"（不拿一次空请求去打扰服务端）
    if (clean.isEmpty) return KeySend.blank;
    try {
      final r = await _c
          .post(
            _u('/api/creds'),
            headers: {'content-type': 'application/json', 'authorization': 'Bearer $token'},
            body: jsonEncode({'creds': clean}),
          )
          .timeout(const Duration(seconds: 15));
      if (r.statusCode == 200) return KeySend.ok;
      if (r.statusCode == 400) {
        final e = (jsonDecode(r.body) as Map)['error'];
        if (e == 'blank-key') return KeySend.blank;
        if (e == 'bad-key-chars') return KeySend.badChars;
      }
      return KeySend.failed;
    } catch (_) {
      return KeySend.failed;
    }
  }

  /// **画一张图**（P1-27 · 主人 2026-09-24：*"图片用seedream，volcengine的"*）。
  ///
  /// ⚠️ 用**他自己**那一把（配置页「图片」那一屏填的）—— 那是服务端的事；
  ///    这里只把提示词递过去、把结果（图地址 / 一句人话）拿回来。
  /// ⚠️ 不许自己编失败的原因：服务端那句 `text` 是**上游的原话翻的人话**。
  Future<ImageOutcome> drawImage(String token, String prompt) async {
    final p = prompt.trim();
    if (p.isEmpty) return const ImageOutcome(ok: false, words: '先写一句想要什么图。');
    try {
      final r = await _c
          .post(
            _u('/api/image'),
            headers: {'content-type': 'application/json', 'authorization': 'Bearer $token'},
            body: jsonEncode({'prompt': p}),
          )
          // 画图比聊天慢得多 —— 给它足够时间（服务端那边也有上限）
          .timeout(const Duration(seconds: 150));
      final j = jsonDecode(r.body);
      if (r.statusCode == 200) return ImageOutcome.fromJson(j);
      // 400 / 409 / 502：服务端都会带一句人话 ⇒ 原样显示；没带就回一个不撒谎的兜底
      final out = ImageOutcome.fromJson(j);
      return ImageOutcome(ok: false, words: out.words ?? '这次没画成，等会儿再试。');
    } catch (_) {
      return const ImageOutcome(ok: false, words: '这会儿连不上，等会儿再试。');
    }
  }

  /// 🔴 **注销：请服务端把我那一台收回去**（2026-09-22 主人："贴 apikey 的时候，
  /// 也要有个撤回的功能……就是取消注册，这样我就不用浪费资源了"）。
  ///
  /// ⚠️ **它是不可逆的** —— 调用方**必须先让他看清删掉什么**再调（见那一屏的确认框）。
  /// ⚠️ 服务端会把 **`why` 代号**回来；**界面的话由客户端自己说**（`space_words.dart`），
  ///    不直接渲染服务端给的句子 —— 那样界面文案才在**禁用词硬闸**的扫描范围里。
  Future<CancelOutcome> cancelMe(String token) async {
    try {
      final r = await _c
          .post(_u('/api/cancel'), headers: {'authorization': 'Bearer $token'})
          .timeout(const Duration(seconds: 20));
      if (r.statusCode == 200) return CancelOutcome.ok;
      final e = (jsonDecode(r.body) as Map)['error'];
      return switch (e) {
        'no-helper' => CancelOutcome.noHelper,
        'protected' => CancelOutcome.protectedOne,
        'local' => CancelOutcome.local,
        'no-tenant' => CancelOutcome.noTenant,
        // ★ **要重新登一次**（账 #39）：服务端在这一步**什么都没做**，
        //   客户端要把他送回登录那一屏（登完再来一遍）。
        'needs-relogin' => CancelOutcome.needsRelogin,
        _ => CancelOutcome.failed,
      };
    } catch (_) {
      return CancelOutcome.failed;
    }
  }

  /// **续期**：用现在这个令牌换一个新的（欠账 13 · 决策 A）。
  ///
  /// 策略（空闲窗 + 绝对上限）**住在服务端**——客户端不复制那几个天数，
  /// 它只负责"拿旧的换新的"和"把新的存好"。见 `renewOutcomeOf` 顶上的分工。
  ///
  /// ⚠️ 令牌**只走 `Authorization` 头**、**没有 body**（和 [say] 同一条规矩）。
  /// ⚠️ 结果分三种，**尤其要把"令牌真的没了"和"网不行了"分开**：
  ///    前者才允许清令牌，后者**一个字节都不许清**（B1 的根）。
  Future<RenewOutcome> renew(String token) async {
    try {
      final r = await _c
          .post(_u('/api/renew'), headers: {'authorization': 'Bearer $token'})
          .timeout(const Duration(seconds: 8));
      return renewOutcomeOf(r.statusCode, r.body);
    } catch (e) {
      // 网不通 / 超时 / 请求根本没发出去 ⇒ **不是**令牌的问题。
      return RenewNetworkError('$e');
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

/// 「删掉 / 回收站」这一路的结果（契约 `28-DELETE.md` §8.2）。
///
/// ⚠️ 三种**不许混**（和 [SayOutcome] / [RenewOutcome] 同一条纪律）：
///   * [TrashOk]：服务端明说做成了；
///   * [TrashUnauthorized]：令牌不行 ⇒ 该回登录页，**不是**"网不好"；
///   * [TrashFailed]：网的问题 / 服务端没收下 / 回执读不出来 ⇒ **什么都没发生**
///     （这一条尤其重要：删是破坏性动作，"以为删了其实没删"和
///      "以为没删其实删了"都不许出现 ⇒ 界面上只认**明说的 ok**）。
sealed class TrashAnswer<T> {
  const TrashAnswer();
}

class TrashOk<T> extends TrashAnswer<T> {
  const TrashOk(this.value);
  final T value;
}

class TrashUnauthorized<T> extends TrashAnswer<T> {
  const TrashUnauthorized();
}

class TrashFailed<T> extends TrashAnswer<T> {
  const TrashFailed(this.detail);
  final String detail;
}

/// 回执 + 解析器 → 结果。**纯函数**（不起网络、不碰界面、不看钟）⇒
/// 它能进 `test/unit` 硬闸（和 [sayOutcomeOf] / [renewOutcomeOf] 同一条理由）。
///
/// 状态码的分工：`200` ⇒ 按 [parse] 解；`401` ⇒ 令牌不行；
/// 其余（含 4xx/5xx）⇒ 失败，**一个字节都不当成功**。
TrashAnswer<T> trashAnswerOf<T>(
  int status,
  String body,
  T Function(Map<String, dynamic>) parse,
) {
  if (status == 401) return TrashUnauthorized<T>();
  if (status != 200) return TrashFailed<T>('HTTP $status');
  try {
    final j = jsonDecode(body);
    if (j is! Map<String, dynamic>) return TrashFailed<T>('回执不是对象');
    return TrashOk<T>(parse(j));
  } catch (e) {
    return TrashFailed<T>('回执解不开：$e');
  }
}

/// 五个"删掉 / 回收站"的入口（契约 §8.2）。
///
/// ⚠️ **全都带令牌头**（`Authorization: Bearer`），**一个都不许走 URL**
///    ——和 [say] / [renew] 同一条规矩。
/// ⚠️ `plan` 是**只读**的（"先看清单"不许有门槛）；`remove` / `purge` 必须显式
///    `confirm:true`（少它服务端就 400，见契约 §8.2）——这一条客户端**照实发**，
///    不替服务端判断。
extension TrashApi on Api {
  Map<String, String> _auth(String token) => {
        ...{'content-type': 'application/json'},
        'authorization': 'Bearer $token',
      };

  Future<TrashAnswer<T>> _post<T>(
    String path,
    Map<String, dynamic> body,
    String token,
    T Function(Map<String, dynamic>) parse,
  ) async {
    try {
      final r = await _c
          .post(_u(path), headers: _auth(token), body: jsonEncode(body))
          .timeout(const Duration(seconds: 20));
      return trashAnswerOf<T>(r.statusCode, r.body, parse);
    } catch (e) {
      return TrashFailed<T>('$e');
    }
  }

  /// 删前那份清单。**不给 `confirm`**（它是只读的）。
  Future<TrashAnswer<TrashPlan>> trashPlan({
    required List<String> messageIds,
    required String token,
  }) =>
      _post('/api/trash/plan', {'messageIds': messageIds}, token, trashPlanFrom);

  /// 删掉（放进回收站）。⚠️ `confirm:true` 是契约要求的。
  Future<TrashAnswer<bool>> trashRemove({
    required List<String> messageIds,
    required String token,
  }) =>
      _post('/api/trash/remove', {'messageIds': messageIds, 'confirm': true}, token, (_) => true);

  /// 回收站里现在有什么。
  Future<TrashAnswer<List<TrashEntry>>> trashList({required String token}) async {
    try {
      final r = await _c
          .get(_u('/api/trash'), headers: {'authorization': 'Bearer $token'})
          .timeout(const Duration(seconds: 20));
      return trashAnswerOf<List<TrashEntry>>(r.statusCode, r.body, trashEntriesFrom);
    } catch (e) {
      return TrashFailed<List<TrashEntry>>('$e');
    }
  }

  /// 从回收站拿回来。
  Future<TrashAnswer<bool>> trashRestore({
    required List<String> messageIds,
    required String token,
  }) =>
      _post('/api/trash/restore', {'messageIds': messageIds}, token, (_) => true);

  /// 彻底删掉。⚠️ 同样必须 `confirm:true`。
  Future<TrashAnswer<bool>> trashPurge({
    required List<String> messageIds,
    required String token,
  }) =>
      _post('/api/trash/purge', {'messageIds': messageIds, 'confirm': true}, token, (_) => true);
}

/// **导出**那一条路（契约 `docs/dev/30-EXPORT.md`）。
///
/// ⚠️ 它复用 [TrashAnswer] 那套三态（401 / 网 / 成功）——和回收站**同一把尺子**：
///    没有令牌就是 401（该回登录页），网不通就是失败（**什么都没发生**），
///    只有服务端明说 200 才算拿到。导出是只读的，所以**没有**"以为导出了其实没有"
///    那种破坏性后果，但"把 401 说成网不好"照样会把用户带去一个永远转圈的页面。
extension ExportApi on Api {
  /// 拿这一段能粘走的文字。**只读** ⇒ `GET`、**没有 `confirm`**
  /// （和 `trashPlan` 同一条规矩：能白看的东西不许有门槛）。
  ///
  /// ⚠️ 令牌**只走 `Authorization` 头**，绝不进 URL（和别的口子同一条规矩）。
  Future<TrashAnswer<ExportDoc>> exportText({required String token}) async {
    try {
      final r = await _c
          .get(_u('/api/export'), headers: {'authorization': 'Bearer $token'})
          .timeout(const Duration(seconds: 20));
      return trashAnswerOf<ExportDoc>(r.statusCode, r.body, exportFrom);
    } catch (e) {
      return TrashFailed<ExportDoc>('$e');
    }
  }
}

/// **往前取一页**的回执（批 C）。
///
/// ⚠️ `ok:false` 与"取到了空的一页"**必须分得开**：前者是"没问到"（界面要说
///    "刚才没问上"或者"再试一次"），后者是"真到头了"。混成一个就是假话。
class OlderPage {
  const OlderPage({required this.frames, required this.hasMore, this.ok = true});

  final List<Map<String, dynamic>> frames;
  final bool hasMore;
  final bool ok;
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
    case 409:
      // ★ **C 期新加的一条**（契约 84 §三·3 · 第 16 条）：焦点与目标不一致 ⇒ 反问。
      //   ⚠️ 按**显式字段** `ask:true` 认，**不按状态码猜**（同一个码以后可能有别的意思）。
      //   ⚠️ 认不出来 ⇒ 退回原来那条"没细分"的路（老行为不许动）。
      try {
        final j = jsonDecode(body);
        if (j is Map && j['ask'] == true && j['text'] is String) {
          return SayAsk(
            question: j['text'] as String,
            scope: (j['scope'] as String?) ?? mainScope,
            focus: j['focus'] as String?,
          );
        }
      } catch (_) {
        /* 读不出来就走下面那条 */
      }
      return const SayRejected('HTTP 409');
    default:
      return SayRejected('HTTP $status');
  }
}

/// `/api/renew` 的回执 → 结果。**纯函数**（不起网络、不碰界面、不看钟）——
/// ⇒ 和 [sayOutcomeOf] 同一条纪律：协议语义**只有这一处**，
///   于是它能进 `test/unit` 被逐码钉住（改错一个码 = 清错令牌 = 把人踢回登录页）。
///
/// 状态码的分工（**不许互相串**）：
///   200 + 读得出 `{token, expiresAt}` ⇒ 换到了新的；
///   200 + 读不出来 ⇒ **当失败**（回执坏了），**不许把坏东西存下去**；
///   401 ⇒ 这个令牌**没得续了**（过期 / 被撤销 / 过了绝对上限）——
///         **只有这一种**才允许清令牌（服务端明说）；
///   其余（含抛异常）⇒ **网的问题**，可重试、**什么都别清**。
RenewOutcome renewOutcomeOf(int status, String body) {
  switch (status) {
    case 200:
      try {
        final j = jsonDecode(body);
        if (j is! Map) return const RenewMalformed('回执不是对象');
        final token = j['token'];
        final exp = j['expiresAt'];
        // ⚠️ 两个字段**都要**：只要读不出任何一个就当失败。
        //    半个令牌存下去比不续期更坏——下次开机拿它连，而它可能根本不能用。
        if (token is! String || token.isEmpty) return const RenewMalformed('没有 token');
        if (exp is! num) return const RenewMalformed('没有 expiresAt');
        return RenewOk(token: token, expiresAt: exp.toInt());
      } catch (_) {
        return const RenewMalformed('回执解不开');
      }
    case 401:
      return const RenewExpired();
    default:
      // 服务端抽风（5xx…）也算这一类：**可重试**，不是"你令牌不行了"。
      return RenewNetworkError('HTTP $status');
  }
}

/// 续期的结果 → **该做什么**。纯函数 ⇒ 进 `test/unit` 硬闸。
///
/// 三件事**一个都不许混**（混错的代价是"网络抖一下就把人踢回登录页"）：
///   * [RenewAction.useNewToken]：存新的、用它连流；
///   * [RenewAction.logout]：**只有 401** 走这条——清令牌 + 回登录页；
///   * [RenewAction.keepOldToken]：网的问题 / 回执坏了 ⇒ 旧令牌照常往下走。
enum RenewAction { useNewToken, logout, keepOldToken }

RenewAction renewActionOf(RenewOutcome o) => switch (o) {
      RenewOk() => RenewAction.useNewToken,
      RenewExpired() => RenewAction.logout,
      // ⚠️ 这两种都**不是**"令牌不行了"：网的问题、以及回执读不出来。
      //    它们共有一条底线：**一个字节都不许清**。
      RenewNetworkError() || RenewMalformed() => RenewAction.keepOldToken,
    };

/// 续期的结果。
sealed class RenewOutcome {
  const RenewOutcome();
}

class RenewOk extends RenewOutcome {
  const RenewOk({required this.token, required this.expiresAt});
  final String token;
  final int expiresAt;
}

/// 401：这个令牌**没得续了**。→ 该回登录页，**不是**"网不好"。
class RenewExpired extends RenewOutcome {
  const RenewExpired();
}

/// 网的问题（连不上 / 超时 / 非 200·401 的码）⇒ 值得重试，**不许清令牌**。
class RenewNetworkError extends RenewOutcome {
  const RenewNetworkError(this.detail);
  final String detail;
}

/// 200 但回执读不出 `token`/`expiresAt` ⇒ 当失败。
/// ⚠️ **不许**把坏令牌存下去；也**不许**清令牌（这不是 401）。
class RenewMalformed extends RenewOutcome {
  const RenewMalformed(this.detail);
  final String detail;
}

/// 令牌状态探针。
enum TokenProbe { ok, unauthorized, notSetup, unknown }

/// 登录结果。四种情况**分清楚**——对用户说的话完全不同。
class LoginResult {
  const LoginResult({
    this.token,
    this.wrongPassword = false,
    this.wrongCode = false,
    this.noSms = false,
    this.badPhone = false,
    this.lockedSec,
    this.other,
    this.networkError,
  });
  final String? token;
  final bool wrongPassword;

  /// 验证码不对（**和"码过期了"是两件事** —— 现在只有临时码，所以只可能是"输错了"）
  final bool wrongCode;

  /// 服务端说"还没接短信"（临时码没开）—— ⚠️ **不许把它说成"码错了"**
  final bool noSms;

  /// 手机号看着不像手机号（11 位、1 开头）
  final bool badPhone;
  final int? lockedSec;
  final String? other;
  final String? networkError;

  bool get ok => token != null;
}

/// 要验证码的结果。**码本身不在里面**（界面上永远拿不到它）。
enum CodeSend { sent, noSms, badPhone, failed }

// 送钥匙、取消注册那两个结果 —— **搬去 `models/key_outcome.dart` 了**
// （楼层闸：`widgets` 只许看 `models`，而填钥匙那块表单要用它们）。
// 下面 re-export ⇒ 老的 import 一行都不用改。

/// 问一句的结果：成了给 `text`，没成给一句**人话**。
class AskOutcome {
  const AskOutcome({this.text, this.error});
  final String? text;
  final String? error;
  bool get ok => text != null;
}
