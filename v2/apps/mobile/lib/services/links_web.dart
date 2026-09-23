// **网页**：开一个新标签页。
//
// ⚠️ 这一份只在 `flutter build web` 的产物里生效（`dart.library.html` 为真）。
//    `dart:html` 是被标了 deprecated 的（推荐 `package:web`），但这个仓库里
//    `mini_runtime_web.dart` 已经在用同一条路 —— **两处保持一致**比各写一套好；
//    真要换，是两个文件一起换。

// ignore: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:html' as html;

/// 网页上可以（`window.open` 是浏览器自带的，不用插件）。
const bool canOpenLinks = true;

/// 打开一个外面的地址。**只认 http(s)**（别的协议一律不开，见 `links.dart` 的 ③）。
///
/// @returns 真的去开了才 `true`（协议不对 / 地址空 ⇒ `false`）
bool openExternal(String url) {
  final u = url.trim();
  if (!(u.startsWith('http://') || u.startsWith('https://'))) return false;
  html.window.open(u, '_blank');
  return true;
}
