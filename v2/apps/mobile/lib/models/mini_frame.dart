// **一帧小程序制品**（契约 `docs/dev/111-APP-LIVE-UPDATE.md`）。
//
// ── 这一份守什么 ──────────────────────────────────────────
//   ① 🔴 **一条 `entryUrl` = 一帧**：`viewId` 只从 URL 算（**只有这一处算法**）——
//      换了版本 ⇒ 换了一条现签的 URL ⇒ **换了一个 viewId** ⇒ 换一个 iframe。
//   ② 🔴 **"平台那边注册过哪些 viewId／壳里现在挂着哪几帧"只有这一本账**
//      （`registerViewFactory` **同一个 viewType 只许注册一次**，重复注册当场抛）。
//   ③ 🔴 **换掉的那一帧要收干净**（监听退订、账上销号）——不收的话每换一版就多挂
//      一条常驻监听，而**老那条会把新页面的"问一句"再送一次**（多花一次他的额度）。
//
// ⚠️ **纯逻辑，不许 import flutter/material**（`test/unit/import_rules_test.dart`
//    那道楼层闸）——所以 `viewId` 与这本账都住 `models/`，判据能在 VM 上直接驱动
//    （Web 那一侧才认得的 `dart:html` 住 `widgets/mini_runtime_web.dart`）。

/// ★ **壳给页面的那两条内边距**在 URL 上的名字（单位 px）。
///
/// 从 2026-10-01 起：**那一层铺满整屏**（页面自己的底色铺到边上），
/// "别被聊天条压住"改成**壳把这两条内边距写进 URL**、由 app 原点注入到页面 `body` 上
/// （`src/app-serve.js` 的 `injectShellInset`）—— 这样**老页面也一起对**。
const String kInsetTopParam = 'pt';
const String kInsetBottomParam = 'pb';

/// 把这两条内边距**追加**到那条入口 URL 上。**纯函数**。
///
/// 🔴 **只追加、不重建**：那条 URL 上带着**签名**（`u`/`e`/`s`）——
///    用 `Uri.replace(queryParameters:)` 重新编码一遍有可能把签名值改了形状
///    （编码方式一变，服务端验签就过不去）⇒ 这里只做字符串拼接。
/// ⚠️ 两个数都是 0 ⇒ **原样返回**（一个字节都不动，老行为）。
String miniEntryUrlWithInsets(
  String entryUrl, {
  required int padTop,
  required int padBottom,
}) {
  final t = padTop > 0 ? padTop : 0;
  final b = padBottom > 0 ? padBottom : 0;
  if (t == 0 && b == 0) return entryUrl;
  final sep = entryUrl.contains('?') ? '&' : '?';
  return '$entryUrl$sep$kInsetTopParam=$t&$kInsetBottomParam=$b';
}

/// 把 URL 上那两条内边距**去掉**（只用于算 `viewId`）。**纯函数**。
///
/// ⚠️ 按 `&` 切开逐段比 key（**不用正则替换**：`replaceAll` 的替换串里
///    `$1` 在 Dart 里不是分组引用，第一版就栽在这儿 —— 判据当场红）。
String stripMiniInsets(String entryUrl) {
  final q = entryUrl.indexOf('?');
  if (q < 0) return entryUrl;
  final head = entryUrl.substring(0, q);
  final parts = entryUrl.substring(q + 1).split('&');
  final kept = <String>[
    for (final kv in parts)
      if (kv.isNotEmpty && kv.split('=').first != kInsetTopParam && kv.split('=').first != kInsetBottomParam)
        kv,
  ];
  if (kept.length == parts.length) return entryUrl; // 没有那两条 ⇒ 原样
  return kept.isEmpty ? head : '$head?${kept.join('&')}';
}

/// 一帧制品的 `viewId`。
///
/// 🔴 **只有这一处算法**：`mini_runtime_web.dart` 建 iframe 用它、
///    `MiniAppFrame` 记账用它 —— 两处各算一遍的话，"换没换"这件事就会两说。
/// ⚠️ **算的时候把那两条内边距摘掉**（2026-10-01）：它们会随设备变
///    （转屏 ⇒ 状态栏那条变、聊天条量出来也可能差一两像素）——
///    带进 `viewId` 的话，"转一下屏"就等于**换了一版** ⇒ iframe 重建、页面里那一半的字白填。
String miniViewIdOf(String entryUrl) => 'hupo-mini-${stripMiniInsets(entryUrl).hashCode}';

/// **哪些 viewId 注册过／现在挂着**（判据 U5）。
///
/// ⚠️ 为什么是一本**显式**的账，而不是两个模块级 `Set`（改前就是那样）：
///    · `registered` **只增不减**（平台那边同一个 viewType 只许注册一次，
///      从这本账里删掉再注册会**当场抛**）；
///    · `hosted` **随换随销**（换掉的那一帧不再收消息）。
///    两件事分开记，才说得出"旧那一帧收干净了没有"。
class MiniViewLedger {
  final Set<String> _registered = <String>{};
  final Set<String> _hosted = <String>{};

  /// 平台那边注册一个 viewType。**第一次 ⇒ `true`**（该去注册）；
  /// 已经注册过 ⇒ `false`（**不许再注册一次** —— 会抛）。
  bool register(String viewId) => _registered.add(viewId);

  bool isRegistered(String viewId) => _registered.contains(viewId);

  /// 这一帧现在挂在壳里（它发来的消息才算数）。
  void host(String viewId) => _hosted.add(viewId);

  /// 这一帧被换掉了／关掉了 ⇒ 销号（幂等：没挂过也不算错）。
  bool unhost(String viewId) => _hosted.remove(viewId);

  bool isHosted(String viewId) => _hosted.contains(viewId);

  /// 现在挂着的那些（**换了一版之后，旧的必须不在里面**）。
  Set<String> get hosted => Set.unmodifiable(_hosted);

  /// 注册过多少个（**只增**：换一百版也只会多，不会少 —— 见类顶上那段）。
  int get registeredCount => _registered.length;
}

/// 壳里**真实的那一本**（`widgets/mini_app_frame.dart` 与 Web 运行时共用它）。
final MiniViewLedger miniViewLedger = MiniViewLedger();

/// **原生那一层（WebView）只许在制品自己那个原点里走**（纯逻辑 ⇒ VM 上直接量）。
///
/// 允许：
///   · 制品自己那个 origin（同 scheme ＋ host ＋ port）—— 它内部的路由/查询随便变；
///   · 空串 与 `about:blank`（WebView 自己的空白起点）。
/// 拦住：`javascript:` / `data:` / `file:` / 别的域名。
///
/// ── 为什么这条要住在 `models/` ─────────────────────────────
/// 原生那一层在 `flutter test` 里**起不来**（VM 上没有 WebView 插件）⇒
/// "它会放行什么、拦住什么"这件事只能做成**纯函数**才量得到。
/// ⚠️ 它是"**制品把我们带去别处**"（钓鱼页 / 假登录）那道闸的落点：
///    Web 那边靠的是 ``sandbox`` ＋ CSP，原生这边靠的就是这一条。
bool miniNavigationAllowed({required String entryUrl, required String target}) {
  final t = target.trim();
  if (t.isEmpty || t == 'about:blank') return true;
  final Uri u;
  final Uri base;
  try {
    u = Uri.parse(t);
    base = Uri.parse(entryUrl);
  } catch (_) {
    return false;
  }
  // 只认这两种协议：`javascript:`（能直接在我们这一层里执行）与
  // `data:` / `file:`（本地内容）一个都不放。
  if (u.scheme != 'http' && u.scheme != 'https') return false;
  if (!base.hasAuthority) return false;
  // ⚠️ 比的是 **origin**（scheme ＋ host ＋ port），不是"域名后缀像不像"——
  //    `apps.stalkerai.cn.evil.com` 那种后缀像的东西必须拦住。
  return u.scheme == base.scheme && u.host == base.host && u.port == base.port;
}

