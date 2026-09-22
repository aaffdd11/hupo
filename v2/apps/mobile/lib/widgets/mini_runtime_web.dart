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
import 'dart:html' as html;
import 'dart:ui_web' as ui_web;

import 'package:flutter/widgets.dart';

/// 已经注册过的 viewId（`registerViewFactory` **同一个 id 只许注册一次**，重复注册会抛）。
final Set<String> _registered = <String>{};

/// 已经挂上监听的那些 iframe（按 viewId 记；避免重复挂）。
final Set<String> _listening = <String>{};

/// 起一个沙箱 iframe。
///
/// ⚠️ `entryUrl` 是**带签名**的（绑人 + 绑版本 + 短时效）—— 制品口只认签名，不认登录态。
/// ⚠️ `onAsk` 是那条**唯一**的回话通道：页面说"我要问一句"，壳去替他问（**用看的人的钥匙**）。
///    拿回来的话，壳用 `postMessage` 回给**这一个** iframe。
Widget buildMiniAppView({
  required String entryUrl,
  required String title,
  Future<String> Function(String prompt)? onAsk,
}) {
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

      if (onAsk != null && _listening.add(viewId)) {
        // ⚠️ **按 `source` 认人**，不是按 origin：沙箱页面是**不透明原点**（origin 是 "null"），
        //    拿 origin 判等于谁都放进来。只有"这一条 iframe 自己"发来的才算。
        html.window.onMessage.listen((e) async {
          final win = f.contentWindow;
          if (win == null || !identical(e.source, win)) return;
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
        // 页面加载完 ⇒ 告诉它"壳在、这一条路开着"（页面自己决定要不要用）
        f.onLoad.listen((_) {
          f.contentWindow?.postMessage({'kind': 'hupo-ready'}, '*');
        });
      }
      return f;
    });
  }
  return HtmlElementView(viewType: viewId);
}
