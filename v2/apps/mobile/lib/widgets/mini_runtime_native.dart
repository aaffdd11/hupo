// **沙箱运行时（原生 · Android）**：把制品放进一个普通 `WebView` 里跑。
//
// ── 这一份是什么、不是什么（`08-SPEC.md` §14.1）────────────────
//   ✅ 是：Android 那边"能打开小程序"的那一层。制品照旧从
//      **另一个原点**（生产 `https://apps.stalkerai.cn` ≠ `w.stalkerai.cn`）加载，
//      带着它自己那份 CSP。
//      ⚠️ **2026-09-30 改的那一条**：CSP 从 `connect-src 'none'` 变成
//      **`connect-src 'self'`**（契约 `docs/dev/147-APP-SQLITE.md`）——
//      制品**只许对它自己那个原点**发请求，那一条就是"替我存一笔"的窄口
//      （网页那一侧的 iframe 与这一侧的 WebView **吃的是同一个响应头** ⇒
//      **两端同一条路**，所以它**不需要**一个原生桥就能存东西）。
//      🔴 **"它出不去"这句话仍然成立**：白名单里只有它自己，别人的站一个都没有。
//   🔴 **不是**：一个"原生桥"。铁律 3 写着**禁原生桥**（验收：全库 grep 命中 = 0），
//      所以这一份**没有** `JavaScriptChannel`、**不注入**任何脚本、
//      **不发** `hupo-ready` ⇒ 按契约写的制品就不会摆出 `ask` 那个入口
//      （**不假装有**：装了桥才叫有，没有就不许让它以为有）。
//   ⚠️ 也就是说：**原生上 `ask` 这一条能力不存在**。要开它，先改手册那条铁律
//      （那是安全模型上的事，得主人拍板），不是在这一份里偷偷加一个 channel。
//
// ── 与 Web 那一份的差别（如实记在 `docs/dev/129-NATIVE-ANDROID-BUILD.md`）──
//   · Web：`<iframe sandbox="allow-scripts">` ⇒ 制品活在**不透明原点**里，
//     `localStorage` 会抛、连 `event.origin` 都是 `"null"`；
//   · 原生：WebView **是顶层文档**（没有 sandbox 那一层），它自己那个原点的
//     `localStorage` 是能用的（同一台设备上的独立存储 —— 手册 §14.1 铁律 3 的
//     "原生侧用独立的数据存储"说的就是这个）；它仍然读不到壳（Flutter 这一侧）的
//     令牌（令牌在 Dart 的 `TokenStore` 里，不在这个 WebView 的存储里）。
//   · 原生：导航**只许在制品自己那个 origin 里走**（`miniNavigationAllowed`）。
//
// ⚠️ 这一份**只在 Android 上被装上**（`widgets/mini_native_boot_io.dart`）——
//    iOS 商店版不许有运行时（Apple 4.7.4），见 `mini_runtime.dart` 顶上那段。

import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../models/mini_frame.dart';

/// 现在挂着的那些 WebView（按 `viewId` 记）—— **换帧时要放掉**。
///
/// 🔴 为什么要这本账：`MiniAppFrame` 那本账（`miniViewLedger`）记的是"壳里挂着哪几帧"，
///    它管不到**插件里的控制器**。没有这一本，换一版制品就多留一个 WebView
///    （它还在后台跑着页面自己的定时器）。
final Map<String, WebViewController> _controllers = <String, WebViewController>{};

/// 起一个"看这个小程序的窗口"（Android 上的那一份）。
///
/// ⚠️ `entryUrl` 是**带签名**的（绑人 ＋ 绑版本 ＋ 短时效）—— 制品口只认签名，
///    不认登录态；这一份**不知道版本**：换版本 ⇒ 换 URL ⇒ 换 `viewId` ⇒ 换一个 WebView
///    （由 `MiniAppFrame` 换）。
/// 🔴 `onAsk` **故意不接**（这一层没有桥，见文件顶上那段）：收了却做不到，
///    比不收更坏。
Widget buildNativeMiniAppView({
  required String entryUrl,
  required String title,
  Future<String> Function(String prompt)? onAsk,
}) {
  final viewId = miniViewIdOf(entryUrl);
  final controller = _controllers.putIfAbsent(viewId, () {
    final c = WebViewController()
      // 制品的 CSP 是 `default-src 'none'; script-src 'unsafe-inline'` ⇒
      // 它自己的内联脚本要能跑，所以 JS 得开；**能跑什么由它那份 CSP 管**。
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0x00000000))
      ..setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (req) =>
              miniNavigationAllowed(entryUrl: entryUrl, target: req.url)
              ? NavigationDecision.navigate
              : NavigationDecision.prevent,
        ),
      );
    // ⚠️ 不 await：`loadRequest` 是一趟网络往返，等它就把这一帧卡住了
    //    （页面自己转圈是它的事，我们这一层不该跟着转）。
    unawaited(c.loadRequest(Uri.parse(entryUrl)));
    return c;
  });
  return WebViewWidget(controller: controller);
}

/// 让小程序那一层收 / 不收指针事件 —— **Android 这一侧是空操作**。
///
/// 🔴 2026-09-30 主人报的那个"点了聊天窗口整个界面没反应"**量在 Web 上**
///    （Web 的平台视图是 DOM 元素、盖在画布上面）。Android 的平台视图
///    走的是另一套合成 ⇒ **这次没复现**，所以这里**什么都不做** ——
///    不许在这边假装做了（真在安卓上撞到再单说，见 `docs/dev/145`）。
void setMiniAppsInteractive(bool on) {}

/// **这一帧换掉了 / 关掉了 ⇒ 把它放掉**（由 `releaseMiniAppView` 转进来）。
///
/// ⚠️ 幂等：没挂过也不算错（`MiniAppFrame` 的销号与这一本账不是一个东西）。
void releaseNativeMiniAppView(String viewId) {
  _controllers.remove(viewId);
}
