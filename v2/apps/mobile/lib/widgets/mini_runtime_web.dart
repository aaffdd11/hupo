// **沙箱运行时（Web）**：把制品放进一个 `<iframe sandbox="allow-scripts">` 里跑。
//
// ── 这一份就是 N1 / N2 的落点 ──────────────────────────────
//   🔴 **N1**：`src` 指向**另一个原点**（本机 = 另一个端口；生产 = 另一个域名）
//      ⇒ 制品读不到这个页面的存储、也拿不到壳的令牌。
//   🔴 `sandbox="allow-scripts"` **故意不给 `allow-same-origin`**
//      ⇒ 制品活在一个**不透明原点**里：`parent.document` / `localStorage` / cookie 全都碰不到。
//   🔴 **回话通道只有一条**（乙-4b 才开）：`{kind:'ask', prompt}` ⇒ 壳替它问一句。
//      别的消息**一律不理会**；壳**永远不会**把"能指挥 agent"的东西交给它（N2）。

// ignore: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:async';
// ignore: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:html' as html;
import 'dart:ui_web' as ui_web;

import 'package:flutter/widgets.dart';

import '../models/mini_frame.dart';

/// 已经挂上监听的那些 iframe（按 viewId 记）—— **换掉那一帧时要退订**。
///
/// 🔴 为什么非退订不可（契约 `docs/dev/111-APP-LIVE-UPDATE.md` 判据 U5）：
///    `html.window.onMessage.listen` 是**整页一条**的常驻监听。换一版就多挂一条的话，
///    老那条虽然对着一个已经摘下来的 iframe，**照样会把新页面的"问一句"再送去问一次**
///    —— 那是**多花一次他的额度**，而且他看不到第二次。
/// ⚠️ 退订由 `MiniAppFrame` 在换帧/关掉时叫（`releaseMiniAppView`）。
final Map<String, StreamSubscription<html.MessageEvent>> _subs =
    <String, StreamSubscription<html.MessageEvent>>{};

/// 起一个沙箱 iframe。
///
/// ⚠️ `entryUrl` 是**带签名**的（绑人 + 绑版本 + 短时效）—— 制品口只认签名，不认登录态。
/// ⚠️ `onAsk` 是那条**唯一**的回话通道：页面说"我要问一句"，壳去替他问（**用看的人的钥匙**）。
///    拿回来的话，壳用 `postMessage` 回给**这一个** iframe。
/// 🔴 **换版本 ⇒ 换 URL ⇒ 换 `viewId` ⇒ 换一个 iframe**（`MiniAppFrame` 负责换）：
///    这一份只管"照 URL 建那一帧"，**不认识版本**。
Widget buildMiniAppView({
  required String entryUrl,
  required String title,
  Future<String> Function(String prompt)? onAsk,
}) {
  // 🔴 **viewId 的算法只有一处**（`models/mini_frame.dart`）——
  //    `MiniAppFrame` 记账用的是同一个函数。
  final viewId = miniViewIdOf(entryUrl);
  // ⚠️ **同一个 viewType 只许注册一次**（重复注册当场抛）⇒ 这本账只增不减。
  if (miniViewLedger.register(viewId)) {
    ui_web.platformViewRegistry.registerViewFactory(viewId, (int _) {
      final f = html.IFrameElement()
        ..src = entryUrl
        ..title = title
        // 🔴 **只给 allow-scripts**：给了 allow-same-origin 就等于把壳的存储和它共享
        ..setAttribute('sandbox', 'allow-scripts')
        ..setAttribute('referrerpolicy', 'no-referrer')
        // ⚠️ `allow` 一个都不给：摄像头/麦克风/定位这些它一个都用不上
        ..setAttribute('allow', '');
      f.style.border = 'none';
      f.style.width = '100%';
      f.style.height = '100%';
      f.style.background = 'transparent';

      if (onAsk != null && !_subs.containsKey(viewId)) {
        // ⚠️ **按 `source` 认人**，不是按 origin：沙箱页面是**不透明原点**（origin 是 "null"），
        //    拿 origin 判等于谁都放进来。只有"这一条 iframe 自己"发来的才算。
        final sub = html.window.onMessage.listen((e) async {
          // 🔴 **这一帧已经换掉了/关掉了 ⇒ 一个字都不理**（`MiniAppFrame` 销的号）。
          //    少了这一句，摘下来的那一帧还会替新页面把话再问一遍。
          if (!miniViewLedger.isHosted(viewId)) return;
          final win = f.contentWindow;
          if (win == null) return;
          // 🔴 **认"不透明原点"**，不是认 `source`：
          //    · 沙箱页面（`sandbox="allow-scripts"` 且**不给** allow-same-origin）
          //      的 origin 恰好是字符串 `"null"` —— 这是外面伪装不出来的；
          //    · 而 Dart 那边 `identical(e.source, f.contentWindow)` **不可靠**
          //      （跨语言包装对象不保证同一实例）—— 2026-09-22 实测：用它判，
          //      页面发过来的消息**一条都进不来**（服务端那时一次都没被调用）。
          // ⚠️ 再加两条保险：页面的 CSP 是 `default-src 'none'`（**它嵌不了自己的 iframe**
          //    来冒充），而且同一时刻壳里只开着一个页面。
          final origin = e.origin;
          if (origin != 'null' && origin != '') return;
          final data = e.data;
          if (data is! Map || data['kind'] != 'ask') return; // 🔴 只认这一种
          final prompt = data['prompt'];
          if (prompt is! String || prompt.trim().isEmpty) return;
          Map<String, Object?> reply;
          try {
            final text = await onAsk(prompt);
            reply = {'kind': 'hupo-reply', 'text': text};
          } catch (err) {
            // ⚠️ 失败也要**回一句话**（不然页面会一直等；"点了没反应"最忌）
            reply = {'kind': 'hupo-error', 'error': '$err'};
          }
          win.postMessage(reply, '*');
        });
        _subs[viewId] = sub;
        // 页面加载完 ⇒ 告诉它"壳在、这一条路开着"（页面自己决定要不要用）
        f.onLoad.listen((_) {
          if (!miniViewLedger.isHosted(viewId)) return;
          f.contentWindow?.postMessage({'kind': 'hupo-ready'}, '*');
        });
      }
      return f;
    });
  }
  return HtmlElementView(viewType: viewId);
}

/// **这一帧换掉了 / 关掉了 ⇒ 收干净**（由 `MiniAppFrame` 在换帧与 `dispose` 时叫）。
///
/// 🔴 退的是**消息监听**；平台那边注册过的那个 viewType **不退** ——
///    `registerViewFactory` 同一个 id 只许注册一次，销了号再注册会当场抛
///    （见 `models/mini_frame.dart` 的 `MiniViewLedger`）。
/// ⚠️ 非 Web 那一侧是**空操作**（`mini_runtime_stub.dart`）。
void releaseMiniAppView(String viewId) {
  final sub = _subs.remove(viewId);
  if (sub != null) sub.cancel();
}
