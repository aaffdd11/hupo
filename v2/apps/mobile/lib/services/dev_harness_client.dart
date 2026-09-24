// 问 `/api/dev-harness` 并把那条链接**缓存住**
// （契约 `docs/dev/82-DEV-MODE.md` §五：短时效 ⇒ 过期/点了失败就重取）。
//
// ⚠️ 形状在 `models/dev_harness.dart`（`widgets` 只许看 `models` —— 楼层闸），
//    这一份是**真实现**，由 `screens` 一层接上去。
// ⚠️ 它**不判断谁是开发者**：服务端说 200 就有、非 200 就没有。
//    客户端只负责把回执分成四种（`devHarnessOutcomeOf`），别的一概不猜。

import '../models/dev_harness.dart';
import 'api.dart';

/// `/api/dev-harness` 那一条路（带一个到期时刻的缓存）。
class DevHarnessClient implements DevHarnessSource {
  DevHarnessClient({
    required this.api,
    required this.token,
    int Function()? clock,
  }) : _now = clock ?? (() => DateTime.now().millisecondsSinceEpoch);

  final Api api;

  /// 令牌**每次现取**（登录是异步的：构造这一条的时候可能还没有）。
  /// ⚠️ 空 = 还没登录 ⇒ 不去问（问也是白问）。
  final String Function() token;

  /// 现在几点（毫秒）。判据里注入一个 ⇒ 过期那一条不用等真的过一分钟。
  final int Function() _now;

  final _cache = DevHarnessCache();

  /// 现在那条链接：缓存里还新鲜就直接给，否则问一次。
  @override
  Future<DevHarnessOutcome> link() async {
    final cached = _cache.freshAt(_now());
    if (cached != null) return DevHarnessReady(cached);
    final t = token();
    if (t.isEmpty) return const DevHarnessUnreachable('还没登录');
    final got = await api.devHarness(t);
    // ⚠️ **只有真的拿到了才存**：非 200 / 回执坏了都不许进缓存
    //    （存了的话下次会拿一条不能用的东西去开）
    if (got is DevHarnessReady) _cache.save(got.link);
    return got;
  }

  /// 忘掉缓存（点了没打开 ⇒ 下次重取）。
  @override
  void forget() => _cache.clear();
}
