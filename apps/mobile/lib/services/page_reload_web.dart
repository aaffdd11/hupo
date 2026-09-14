// Web：真的刷新页面 + 刷新护栏。
//
// 护栏为什么必须有：如果服务端记的构建指纹和**实际部署的包**对不上
//（文件写错了、或部署到一半），客户端会「刷新 → 还是旧包 → 又发现对不上 → 再刷新」
// **无限循环**，用户看到页面自己抽风。所以同一个标签页、同一个指纹只自动刷一次。

import 'package:web/web.dart' as web;

const String _guardKey = 'hupo_reloaded_for_build';

/// 这个标签页是不是已经为这个构建指纹刷过一次了。
String? reloadGuardRead() => web.window.sessionStorage.getItem(_guardKey);

/// 记下"我为这个指纹刷过一次"，然后刷新。
void reloadClient({String? buildId}) {
  try {
    if (buildId != null && buildId.isNotEmpty) {
      web.window.sessionStorage.setItem(_guardKey, buildId);
    }
  } catch (_) {
    // 隐私模式下 sessionStorage 可能不可用 —— 那就退化成"不记"，至少这轮刷得出去
  }
  web.window.location.reload();
}
