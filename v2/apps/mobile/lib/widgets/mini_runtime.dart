// 沙箱运行时的**入口**：按平台条件导入选实现。
//
// ⚠️ 为什么要分成三份：`dart:html` / `dart:ui_web` **只在 Web 上存在**，
//    而 `flutter analyze` 与 `flutter test` 在 VM 上跑 —— 一个文件同时要两边都编得过，
//    只能靠条件导入（这也是 Flutter 官方推荐的那种写法）。

export 'mini_runtime_stub.dart' if (dart.library.html) 'mini_runtime_web.dart';
