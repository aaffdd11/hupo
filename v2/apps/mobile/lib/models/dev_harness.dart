// **「在浏览器里打开那一台」这个次要入口的纯逻辑**（契约 `docs/dev/82-DEV-MODE.md` §五）。
//
// ── 这一份守什么 ──────────────────────────────────────────
//   ① `GET /api/dev-harness` 的回执**只有四种结果**，而且**非 200 就是"没被标"**：
//      ⇒ 界面据此决定**画不画那个按钮**（画一个按不动的按钮 = 界面上出现做不到的东西）。
//   ② 那条 `url` 是**服务端现签**的（`…/__enter?u=&e=&s=`）——
//      🔴 **原样用，不许自己拼、不许改参数**（契约 §五：光有琥珀登录、没有那条签名也进不去）。
//   ③ 回执带 `expiresAt`（毫秒）⇒ 拿回来**缓存住**，过期/点了失败 ⇒ 重取
//      （和 `_mineStale` 那套同一条规矩）。
//
// ⚠️ 纯逻辑，不 import flutter、不做 I/O（楼层闸 `test/unit/import_rules_test.dart`）
//    ⇒ 解析 / 过期判定 / "画什么"这几件都进 `test/unit` 硬闸。
// ⚠️ 一个内部词都不许有（文案在 `dev_harness_words.dart`，清单在
//    `test/unit/forbidden_words_test.dart`）。

import 'dart:convert';

import 'dev_harness_words.dart';

/// 服务端现签的那条短时效链接。
class DevHarnessLink {
  const DevHarnessLink({required this.url, required this.expiresAt});

  /// 🔴 **原样**的那条地址（服务端给的入口）。
  final String url;

  /// 到期时刻（毫秒）。`<= 0` = 服务端没给 ⇒ 没得判，照用（同 `_mineStale` 那一条）。
  final int expiresAt;
}

/// 问一次 `/api/dev-harness` 的结果。
sealed class DevHarnessOutcome {
  const DevHarnessOutcome();
}

/// 200 + 读得出 `{url, expiresAt}` ⇒ 这一台能这样打开。
class DevHarnessReady extends DevHarnessOutcome {
  const DevHarnessReady(this.link);
  final DevHarnessLink link;
}

/// **非 200**（没被标 / 是别人 / 服务端不收）⇒ 这一台打不开这条路。
///
/// 🔴 这一种**不许画按钮**（见 [devEntryHasButton]）。
class DevHarnessNotMarked extends DevHarnessOutcome {
  const DevHarnessNotMarked(this.status);
  final int status;
}

/// 网的问题（连不上 / 超时 / 抛了）⇒ 值得再问一次，**不是**"这台没被标"。
class DevHarnessUnreachable extends DevHarnessOutcome {
  const DevHarnessUnreachable(this.detail);
  final String detail;
}

/// 200 但回执读不出 `url`/`expiresAt` ⇒ 当失败（**不许**把坏东西拿去开）。
class DevHarnessMalformed extends DevHarnessOutcome {
  const DevHarnessMalformed(this.detail);
  final String detail;
}

/// `/api/dev-harness` 的回执 → 结果。**纯函数**（不起网络、不看钟）。
///
/// ⚠️ 状态码的分工**不许互相串**（同 `renewOutcomeOf` 那一条纪律）：
///   * 200 + 两个字段都在 ⇒ [DevHarnessReady]；
///   * 200 + 读不出来 ⇒ [DevHarnessMalformed]（回执坏了，别拿去打开）；
///   * 其余任何码（403 / 404 / 5xx…）⇒ [DevHarnessNotMarked]。
///     **客户端不猜原因**（谁是开发者由服务端说了算）——界面这一侧只有
///     "能这样打开"和"现在不能"两种，中间那些理由不复制过来。
DevHarnessOutcome devHarnessOutcomeOf(int status, String body) {
  if (status != 200) return DevHarnessNotMarked(status);
  try {
    final j = jsonDecode(body);
    if (j is! Map) return const DevHarnessMalformed('回执不是对象');
    final url = j['url'];
    final exp = j['expiresAt'];
    // 两个字段**都要**：半个回执拿去打开比不给更坏（一个空白标签页）。
    if (url is! String || url.trim().isEmpty) {
      return const DevHarnessMalformed('没有 url');
    }
    if (exp is! num) return const DevHarnessMalformed('没有 expiresAt');
    // ⚠️ 存的是**原样**那句（判空只看一眼，不改它一个字符）
    return DevHarnessReady(DevHarnessLink(url: url, expiresAt: exp.toInt()));
  } catch (_) {
    return const DevHarnessMalformed('回执解不开');
  }
}

/// 用之前留多少余量（同 `_mineStale` 那条：快过期就别拿它开）。
const int devHarnessSlackMs = 60 * 1000;

/// 这条链接现在还能用吗（`expiresAt <= 0` ⇒ 服务端没给到期时间，照用）。
bool devHarnessFresh(DevHarnessLink link, int nowMs) {
  if (link.expiresAt <= 0) return true;
  return link.expiresAt - nowMs > devHarnessSlackMs;
}

/// 拿回来那条链接的**缓存**（契约 §五：短时效 ⇒ 过期/点了失败就重取）。
///
/// ⚠️ 纯逻辑（时钟从外面给）⇒ 过期这一条能在 `test/unit` 里被逐毫秒钉住。
class DevHarnessCache {
  DevHarnessLink? _link;

  /// 现在还能用的那条；不能用了（或没拿过）⇒ `null`，并且**顺手把它丢掉**。
  DevHarnessLink? freshAt(int nowMs) {
    final l = _link;
    if (l == null) return null;
    if (!devHarnessFresh(l, nowMs)) {
      _link = null;
      return null;
    }
    return l;
  }

  /// 存一条（**新的盖旧的**）。
  void save(DevHarnessLink link) => _link = link;

  /// 忘掉（点了没打开 ⇒ 下次重取）。
  void clear() => _link = null;
}

/// 「那条链接从哪来」的**形状**。
///
/// ⚠️ 楼层闸：`widgets` 只许看 `models` ⇒ 界面这一层**不能** import
///    `services/dev_harness_client.dart` ⇒ 形状住在这儿，真实现由 `screens` 接上。
abstract class DevHarnessSource {
  /// 现在那条链接：缓存里还新鲜就直接给，否则问一次。
  Future<DevHarnessOutcome> link();

  /// 忘掉缓存（**点了没打开**时叫一声 ⇒ 下次重取）。
  void forget();
}

/// 那个次要入口要的三样（**形状**；真实现由 `screens` 一层接上 `services/links.dart`）。
class DevHarnessEntry {
  const DevHarnessEntry({
    required this.source,
    required this.canOpen,
    required this.openExternal,
  });

  /// 那条链接从哪来。
  final DevHarnessSource source;

  /// 这个平台上能不能打开外面的浏览器（`services/links.dart` 的 `canOpenLinks`）。
  /// **假的** ⇒ 连问都不去问（要一条打不开的链接没有意义）。
  final bool canOpen;

  /// 真去打开（`services/links.dart` 的 `openExternal`）。返回 `false` = 没打开。
  final bool Function(String url) openExternal;
}

/// 那个次要入口**该画什么**（纯函数 ⇒ 进 `test/unit`）。
enum DevEntryView {
  /// 正在问（一句普通话占着地方，**不许白屏**）。
  asking,

  /// 拿到了 ⇒ 一句普通话 + 一个按钮。
  ready,

  /// **非 200**（没被标 / 是别人）⇒ 只有一句普通话，**没有按钮**。
  notMarked,

  /// 这会儿问不到（网 / 超时 / 回执坏了）⇒ 一句普通话，**没有按钮**。
  unreachable,

  /// 这个平台上打不开浏览器 ⇒ 如实说，**没有按钮**。
  cannotHere,

  /// 刚才那一下没打开 ⇒ 一句普通话，按钮还在（再点会**重取**）。
  openFailed,
}

/// 现在该画哪一档。
///
/// 🔴 **只有 [DevEntryView.ready] / [DevEntryView.openFailed] 有按钮** ——
///    其余的档画一个按不动的按钮就是"界面上出现做不到的东西"（`AGENTS.md` §六·4）。
DevEntryView devEntryViewOf({
  required bool canOpen,
  required DevHarnessOutcome? outcome,
  required bool openFailed,
}) {
  // 这个平台打不开 ⇒ 别的都不用看（连问都没问过）
  if (!canOpen) return DevEntryView.cannotHere;
  if (openFailed) return DevEntryView.openFailed;
  return switch (outcome) {
    null => DevEntryView.asking,
    DevHarnessReady() => DevEntryView.ready,
    DevHarnessNotMarked() => DevEntryView.notMarked,
    DevHarnessUnreachable() || DevHarnessMalformed() => DevEntryView.unreachable,
  };
}

/// 这一档画哪句话（每一句都在 `dev_harness_words.dart`）。
String devEntryWords(DevEntryView view) => switch (view) {
  DevEntryView.asking => devOpenAsking,
  DevEntryView.ready => devOpenLead,
  DevEntryView.openFailed => devOpenFailed,
  DevEntryView.notMarked => devOpenNotMarked,
  DevEntryView.unreachable => devOpenUnreachable,
  DevEntryView.cannotHere => devOpenCannotHere,
};

/// 这一档有没有按钮（[DevEntryView.ready] / [DevEntryView.openFailed] 才有）。
bool devEntryHasButton(DevEntryView view) =>
    view == DevEntryView.ready || view == DevEntryView.openFailed;
