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

/// 一帧制品的 `viewId`。
///
/// 🔴 **只有这一处算法**：`mini_runtime_web.dart` 建 iframe 用它、
///    `MiniAppFrame` 记账用它 —— 两处各算一遍的话，"换没换"这件事就会两说。
String miniViewIdOf(String entryUrl) => 'hupo-mini-${entryUrl.hashCode}';

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
