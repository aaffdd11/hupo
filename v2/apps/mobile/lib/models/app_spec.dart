// **我的小程序清单**（乙-1 · 契约 `docs/dev/59-USER-APPS.md`）。
//
// ⚠️ **纯数据 + 一份白名单**（不 import `material` 之外的东西）。
//
// ── 这一份守什么 ──────────────────────────────────────────
//   ① 🔴 **拿不到入口 URL / 已经过期 ⇒ 不摆图标**（摆了就是"点了没反应"）
//   ② 🔴 **图标名只认白名单** —— 而且映射表里的 `IconData` **必须是常量**：
//      `flutter build web --release` 会 tree-shake 图标字体，运行时算出来的图标
//      **线上画不出来**（`52-DESKTOP.md` §6.3 记着这个坑）。认不出的名字 ⇒ 用**默认图标**
//      （**不是**把整个小程序藏掉：名字不认识不该让他的东西消失）。
//   ③ 权限现在是空的（乙-1）；非空也算得出来，到乙-4 才有意义。

/// 内置那两个小程序的 **id**（它们在壳里写死，**不在** `/api/apps` 的清单里）。
const String builtInSettingsId = 'settings';
const String builtInMathId = 'math';

/// 「发现」那一屏（乙-3）：它和设置/奥数题一样是**内置的**（不在 `/api/apps` 的清单里）。
const String builtInDiscoverId = 'discover';

/// ★ **「我自己那台」**（2026-09-24 · 契约 `docs/dev/81-HARNESS-ENTRY.md` §5.4）：
/// 桌面上那个内置磁贴，点开是**他自己那一台的原始会话流**（显示器 + 键盘，不包装）。
/// ⚠️ 它同样**不在** `/api/apps` 的清单里（不是他自己造的小程序）——
///    那一层连的是宿主那条 `/api/harness` 通道（`services/harness_client.dart`）。
/// ⚠️ 这里是 **id**（`'harness'`），**不是界面上那两个字**（那是 `harness_words.dart`）。
const String builtInHarnessId = 'harness';

/// 清单里的一条（**这是"他自己造的小程序"，与他自己的数据同一份**）。
class MiniApp {
  const MiniApp({
    required this.id,
    required this.title,
    required this.icon,
    required this.version,
    required this.entryUrl,
    this.permissions = const [],
    this.expiresAt = 0,
  });

  final String id;
  final String title;

  /// **图标名**（服务端白名单里的那个名字）。
  /// ⚠️ 这里**故意不存 `IconData`**：`Icons.*` 住在 `material` 里，而 `models` 层
  ///    **点名不许 import material**（`test/unit/import_rules_test.dart` 的楼层闸）。
  ///    名字 → 图标的映射放在 `lib/widgets/mini_app_icons.dart`（那一层可以）。
  final String icon;
  final int version;

  /// 带签名的入口 URL（服务端**现签**的：绑人、绑版本、短时效）。
  final String entryUrl;

  /// 它要什么权限（乙-1 一定是空的）。
  final List<String> permissions;

  /// 这条 URL 什么时候过期（毫秒）。
  final int expiresAt;

  /// 从 `/api/apps` 的一条记录里解析出来。**不合法就返回 `null`**（fail-closed）。
  ///
  /// ⚠️ 三种情况必须拒：没有 `entryUrl` / 有签名但它已经过期 / `id` 或 `title` 是空的。
  static MiniApp? parse(Object? raw, {int now = 0}) {
    if (raw is! Map) return null;
    final id = raw['id'];
    final title = raw['title'];
    final url = raw['entryUrl'];
    if (id is! String || id.isEmpty) return null;
    if (title is! String || title.trim().isEmpty) return null;
    if (url is! String || !url.startsWith('http')) return null;
    final n = int.tryParse('${raw['version']}') ?? 0;
    if (n < 1) return null;
    final expires = int.tryParse('${raw['expiresAt']}') ?? 0;
    if (now > 0 && expires > 0 && expires <= now) return null; // 过期了就别摆出来
    // ⚠️ 名字认不出来也**照样收下**（用默认图标）：他的东西不该因为一个名字消失。
    //    映射（含兜底）在 `lib/widgets/mini_app_icons.dart`。
    final icon = '${raw['icon']}';
    final perms = <String>[];
    final rawPerms = raw['permissions'];
    if (rawPerms is List) {
      for (final p in rawPerms) {
        if (p is String && p.isNotEmpty) perms.add(p);
      }
    }
    return MiniApp(
      id: id,
      title: title,
      icon: icon,
      version: n,
      entryUrl: url,
      permissions: perms,
      expiresAt: expires,
    );
  }

  /// 内置那两个**不算"我的小程序"**：设置与奥数题是由开发者写死在壳里的。
  ///
  /// ⚠️ 这里是 **id**（`'settings'` / `'math'`），**不是界面上那两个字**（那是 `space_words.dart`）。
  ///    两处混用的话，`_openApp` 那个开关迟早对不上（这次就是这么被自己的判据抓到的）。
  static bool isBuiltIn(String id) =>
      id == builtInSettingsId ||
      id == builtInMathId ||
      id == builtInDiscoverId ||
      id == builtInHarnessId;
}

/// 「发现」里的一条（**别人发出来的**）。⚠️ 只读：装 / 发 / 改都在对话里做。
class DiscoverApp {
  const DiscoverApp({
    required this.id,
    required this.title,
    required this.icon,
    required this.version,
    required this.author,
    this.permissions = const [],
  });

  final String id;
  final String title;

  /// 图标**名**（映射在 `widgets/mini_app_icons.dart`，与"我的小程序"同一条规矩）。
  final String icon;
  final int version;

  /// 谁发的（**昵称**，服务端那边按哈希生成；手机号那种东西不上这儿）。
  final String author;
  final List<String> permissions;

  /// 不合法就返回 `null`（fail-closed：宁可少列一条，不可列一条点不开的）。
  static DiscoverApp? parse(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['id'];
    final title = raw['title'];
    final author = raw['author'];
    if (id is! String || id.isEmpty) return null;
    if (title is! String || title.trim().isEmpty) return null;
    if (author is! String || author.trim().isEmpty) return null;
    final perms = <String>[];
    final rawPerms = raw['permissions'];
    if (rawPerms is List) {
      for (final p in rawPerms) {
        if (p is String && p.isNotEmpty) perms.add(p);
      }
    }
    return DiscoverApp(
      id: id,
      title: title,
      icon: '${raw['icon']}',
      version: int.tryParse('${raw['version']}') ?? 0,
      author: author,
      permissions: perms,
    );
  }
}
