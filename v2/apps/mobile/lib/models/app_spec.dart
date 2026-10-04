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

/// 内置那三个小程序的 **id**（它们在壳里写死，**不在** `/api/apps` 的清单里）。
const String builtInSettingsId = 'settings';

/// 「发现」那一屏（乙-3）：它和设置一样是**内置的**（不在 `/api/apps` 的清单里）。
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
    this.granted,
    this.unanswered,
    this.net = const [],
    this.building = false,
    this.working = false,
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

  /// ★ **主人允许了的**（`/api/apps` 回的 `granted` · 契约 `docs/dev/147-APP-SQLITE.md`）。
  ///
  /// 🔴 **`null` 与空数组是两件事**：
  ///    · `null` = **老服务端没回这个字段** ⇒ 我们**不知道**"你给了没有"
  ///      ⇒ 设置页那张卡**不给开关**（画一个假的开/关就是让页面说假话）；
  ///    · `[]` = 回话了，一样都没给。
  /// ⚠️ 它是"允许了的那几样"；[permissions] 是"制品声明的那几样" —— **两件事**。
  final List<String>? granted;

  /// ★ **还没问过他的那几样**（`/api/apps` 回的 `unanswered` · 2026-10-01）。
  ///
  /// 🔴 **打开时那张弹窗问的就是它**：`unanswered` 非空 ⇒ 开之前先问一句。
  /// ⚠️ 同样是**`null` ≠ 空数组**：`null` = 老服务端没回 ⇒ **不知道**（那就别弹，
  ///    弹一张问不出结果的窗 = 白挡他一下）；`[]` = 都问过了。
  /// ⚠️ 他一旦表过态（允许 / 不给），这一样就从这儿挪走 —— **不再重复问**。
  final List<String>? unanswered;

  /// ★ **它声明想连的那几个站**（清单里 `net: [...]`，只在声明了上网时非空）。
  ///
  /// ⚠️ 只有**打开时那张弹窗**会摆出来（"它想连的是这几个站"）—— 那是他**要点头
  ///    才生效**的那一样里唯一会让他意外的细节。设置页那张卡上**不摆**（摆一列域名看不懂）。
  final List<String> net;

  /// ★ **它还在做**（`/api/apps` 回的 `building` · 2026-10-04 主人要的"灰色的在建图标"）。
  ///
  /// 🔴 服务端那条事实：**这一间的入口还是那个占位页**（`workspace.isPlaceholder()`）
  ///    ⇒ 桌面上那一格画**灰的、转着圈的在建图标**，点它**不打开**（只说一句"还在做"）。
  /// ⚠️ **缺字段 / 不是 `true` ⇒ `false`**（老服务端不给这个字段 ⇒ 照旧画正常图标；
  ///    把一个做好的小程序画成灰的，比"晚一秒才变灰"坏得多）。
  final bool building;

  /// ★ **这一间现在有活在做**（`/api/apps` 回的 `working` · 2026-10-04 主人：
  ///   *"如果某个小程序的聊天还在运行，我们应该给这个小程序有一个状态。"*）。
  ///
  /// 🔴 服务端那条事实 = 他这本**逐件活账**里这一间还开着（与 `work_status` 同一本）
  ///    ⇒ 桌面上那一格亮一个"在做"（右下角一个转着的小圈）。
  /// ⚠️ **缺字段 / 不是 `true` ⇒ `false`**（老服务端不给 ⇒ 照旧不亮；宁可不亮，不许猜亮）。
  final bool working;

  /// 这条 URL 什么时候过期（毫秒）。
  final int expiresAt;

  /// 复制一份、只换 [granted]（注册制那一下**成了之后**用它记账）。
  MiniApp withGranted(List<String> next) => MiniApp(
    id: id,
    title: title,
    icon: icon,
    version: version,
    entryUrl: entryUrl,
    permissions: permissions,
    granted: next,
    unanswered: unanswered,
    net: net,
    expiresAt: expiresAt,
  );

  /// 复制一份，换上**问完之后**的那两份：`granted`（给了哪几样）＋
  /// `unanswered`（还剩哪几样没问）。
  ///
  /// ⚠️ 它只用来记**服务端已经明说成了**的那几样（同 [withGranted] 那条纪律）：
  ///    答应了 / 不给的那一样就从 `unanswered` 里挪走 —— **问过就不再问**。
  MiniApp withGrantAnswer(List<String> nextGranted, List<String>? nextUnanswered) => MiniApp(
    id: id,
    title: title,
    icon: icon,
    version: version,
    entryUrl: entryUrl,
    permissions: permissions,
    granted: nextGranted,
    unanswered: nextUnanswered,
    net: net,
    expiresAt: expiresAt,
  );

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
    // ★ **`granted` 缺了就是缺了**（老服务端）：`null` 走上去，界面据此**不画开关**。
    //   ⚠️ 读到一半（字段在、但不是一串名字）也按"不知道"处理 —— fail-closed。
    List<String>? granted;
    final rawGranted = raw['granted'];
    if (rawGranted is List) {
      granted = <String>[
        for (final p in rawGranted)
          if (p is String && p.isNotEmpty) p,
      ];
    }
    // ★ **`unanswered` 缺了就是缺了**（老服务端）：`null` 走上去 ⇒ **不弹窗**
    //   （弹一张问不出结果的窗只会白挡他一下）。
    List<String>? unanswered;
    final rawUnanswered = raw['unanswered'];
    if (rawUnanswered is List) {
      unanswered = <String>[
        for (final p in rawUnanswered)
          if (p is String && p.isNotEmpty) p,
      ];
    }
    // ⚠️ 名单读不到 ⇒ 空（只影响"弹窗里摆不摆那几个站"，不影响给不给）。
    final hosts = <String>[];
    final rawNet = raw['net'];
    if (rawNet is List) {
      for (final h in rawNet) {
        if (h is String && h.isNotEmpty) hosts.add(h);
      }
    }
    return MiniApp(
      id: id,
      title: title,
      icon: icon,
      version: n,
      entryUrl: url,
      permissions: perms,
      granted: granted,
      unanswered: unanswered,
      net: hosts,
      // ⚠️ 只有**明说 `true`** 才算在建（缺字段 / 别的值 ⇒ 照旧）
      building: raw['building'] == true,
      // ⚠️ 同上：只有明说 `true` 才亮"在做"
      working: raw['working'] == true,
      expiresAt: expires,
    );
  }

  /// 内置那三个**不算"我的小程序"**：设置 / 发现 /「我自己那台」是由开发者写死在壳里的。
  ///
  /// ⚠️ 这里是 **id**（`'settings'` / `'discover'` / `'harness'`），**不是界面上那几个字**
  ///    （那是 `space_words.dart` / `app_words.dart` / `harness_words.dart`）。
  ///    两处混用的话，`_openApp` 那个开关迟早对不上（这次就是这么被自己的判据抓到的）。
  static bool isBuiltIn(String id) =>
      id == builtInSettingsId ||
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
