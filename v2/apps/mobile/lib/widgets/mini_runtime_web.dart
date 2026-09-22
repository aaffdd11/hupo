// **沙箱运行时（Web）**：把制品放进一个 `<iframe sandbox="allow-scripts">` 里跑。
//
// ── 这一份就是 N1 / N2 的落点 ──────────────────────────────
//   🔴 **N1**：`src` 指向**另一个原点**（本机 = 另一个端口；生产 = 另一个域名）
//      ⇒ 制品读不到这个页面的存储、也拿不到壳的令牌。
//   🔴 `sandbox="allow-scripts"` **故意不给 `allow-same-origin`**
//      ⇒ 制品活在一个**不透明原点**里：`parent.document` / `localStorage` / cookie 全都碰不到。
//   🔴 **不给它任何回话通道**（乙-1）：这个壳**不监听它的 message**。
//      将来要放开（乙-4 的「问一句」）＝**新的一批 + 新判据**，不许顺手加。

// ⚠️ 两条 ignore 都是**刻意的**：
//    · `avoid_web_libraries_in_flutter` —— 平台视图**只能**靠它（Web 上起 iframe 的正路）
//    · `deprecated_member_use` —— `dart:html` 官方推荐迁到 `package:web`；
//      迁它要动 `pubspec.yaml`（加一个直接依赖），所以**这一批先不迁**，
//      但**记在账上**（`59-USER-APPS.md` §九），别当成"没人知道"。
// ignore: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:html' as html;
import 'dart:ui_web' as ui_web;

import 'package:flutter/widgets.dart';

/// 已经注册过的 viewId（`registerViewFactory` **同一个 id 只许注册一次**，重复注册会抛）。
final Set<String> _registered = <String>{};

/// 起一个沙箱 iframe。
///
/// ⚠️ `entryUrl` 是**带签名**的（绑人 + 绑版本 + 短时效）—— 制品口只认签名，不认登录态。
Widget buildMiniAppView({required String entryUrl, required String title}) {
  final viewId = 'hupo-mini-${entryUrl.hashCode}';
  if (_registered.add(viewId)) {
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
      return f;
    });
  }
  return HtmlElementView(viewType: viewId);
}
