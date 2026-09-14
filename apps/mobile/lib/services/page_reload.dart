// 「刷新自己」这件事的平台差异。
//
// 为什么单独抽出来：Web 上"刷新"就是 reload 页面；手机上没有页面可刷，
// 对应动作是"重连 + 重新对版本"。用条件导入把差异挡在编译期，
// 调用方（chat_controller）只看到三个函数。

export 'page_reload_io.dart' if (dart.library.js_interop) 'page_reload_web.dart';
