// **"我现在在哪个房间"** —— 一个图标 = 一条对话（契约 `docs/dev/83-APP-WORKSPACE.md` §五·甲）。
//
// 主人 2026-09-25 亲口定的是**甲**：
//
//     *"跟着图标走：打开某个小程序时，**下面那条聊天就是它的对话**
//       （在哪个房间说话，就是跟哪个房间聊）。"*
//
// ⇒ 桌面本身那条聊天 = **主对话**（scope `main`）；
//   打开一个"我的小程序" ⇒ 房间 = **那个 app 的 id**（`/api/apps` 里那个 `id`）；
//   关掉 / 退回桌面 ⇒ 回 `main`。
//
// ── 内置那四个**也有自己的房间**（主人 2026-09-25：「要分家」）──────────
// 桌面上除了"我的小程序"还有四个**壳自己写死的磁贴**（设置 / 奥数题 / 发现 /
// 「我自己那台」）。它们**不在** `/api/apps` 的清单里，但**服务端也认得它们**：
// `services/core/src/worlds.js` 的 `BUILTIN_SCOPES` 把四个 id 登记成**合法房间**
// （它们是服务端认得的名字，不是壳里现编的）。
//
// ⚠️ 两边那四个字符串**必须逐字一致**（服务端 `BUILTIN_SCOPES` ↔ 这里
//    `app_spec.dart` 的 `builtIn*Id`）：对不上就是"客户端拿着一个服务端不认识的
//    名字去开门" ⇒ 那几屏里说的话会打不开（而界面上看起来什么都没发生）。
//
// ⚠️ 纯逻辑，不许 import flutter/material（`test/unit/import_rules_test.dart` 那道楼层闸）。

import 'app_spec.dart';

/// **主对话**的房间名。桌面上没打开任何小程序时就是它。
///
/// 🔴 这个名字是**协议里写死的**（服务端不带 `scope` 时就是这个意思）——
///    不许改成别的字，也不许拿它当"没有"（见 `services/stream_uri.dart`：
///    客户端**永远带上** `scope`，好让"在哪个房间"只有一种理解）。
const String mainScope = 'main';

/// "我的小程序"在桌面那一份 id 里的前缀（`'mine:<appId>'`）。
///
/// ⚠️ 它把"我的小程序"和内置那四个（`'settings'` / `'math'` / …）分开。
///    这一层**只认前缀**，不查清单：清单会刷新、会有拿不到的时候，
///    而"我现在开着的是哪个 app"**不能**因为一次刷新失败就变。
const String mineAppPrefix = 'mine:';

/// `'mine:<appId>'` ⇒ `appId`；不是"我的小程序"就 `null`。
String? mineAppIdOf(String? openApp) {
  if (openApp == null) return null;
  if (!openApp.startsWith(mineAppPrefix)) return null;
  final id = openApp.substring(mineAppPrefix.length);
  return id.isEmpty ? null : id;
}

/// **现在这个开着的东西是哪个房间**。纯函数（判据在 `test/unit/scope_test.dart`）。
///
/// * `null`（桌面上，没开任何小程序）⇒ [mainScope]；
/// * 内置那四个 ⇒ **它自己的 id**（设置那屏 = `'settings'`、奥数题 = `'math'`…）；
/// * `'mine:<appId>'` ⇒ **那个 app 的 id**；
/// * 别的认不出的写法 ⇒ [mainScope]（**宁回主线，也不许现编一个房间名**）。
///
/// ⚠️ 内置那四个用 `MiniApp.isBuiltIn` 判（四个 id 只有那一份清单）——
///    在这一层重抄一遍的话，将来加一个磁贴就会漂成两处。
String scopeOfOpenApp(String? openApp) {
  if (openApp == null) return mainScope;
  if (MiniApp.isBuiltIn(openApp)) return openApp;
  return mineAppIdOf(openApp) ?? mainScope;
}

/// 本机缓存该用哪个命名空间（`TimelineStore` / `DraftStore` / `ComposeStore`）。
///
/// ⚠️ **一件一件分开存**，不然切房间就等于把上一个房间那一屏写到别人头上
///    （`17-LOCAL-FIRST.md`：缓存是"服务端说过的事实"，串了就是说假话）。
///
/// ⚠️ **主对话沿用老键**（`<用户>`，不带后缀）：多租户之后全站用的就是它，
///    而"加一个后缀"会让已经在跑的那些设备**升级的那一下白屏**（本机那一屏
///    要重新从服务端补一遍）。主对话是每个人都有的那一间 —— 它的键不该动。
///    别的房间（= 他后来才建的小程序）才加 `@<scope>`。
String scopedCacheNamespace(String namespace, String scope) =>
    scope == mainScope ? namespace : '$namespace@$scope';
