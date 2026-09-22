// 沙箱运行时的**入口**：按平台条件导入选实现。
//
// ⚠️ 为什么要分成三份：`dart:html` / `dart:ui_web` **只在 Web 上存在**，
//    而 `flutter analyze` 与 `flutter test` 在 VM 上跑 —— 一个文件同时要两边都编得过，
//    只能靠条件导入（这也是 Flutter 官方推荐的那种写法）。
//
// ── 🔴 iOS / 原生这一侧的硬约束（`08-SPEC.md` §4.2 合规那一条）──────────
//
//   **iOS 商店版不发布小程序运行时**（Apple 4.7.4：它要"提交时冻结的清单"，
//   与"运行时生成"天生冲突）。
//
//   ⚠️ **今天这条约束"无处可关"**：原生侧**根本没有运行时** ——
//      `mini_runtime_stub.dart` 就是它的全部行为（说一句实话、不白屏）。
//   ⇒ 所以这一份守的不是"现在关掉了"，而是**将来别忘**：
//      谁是第一个做原生运行时的人，谁就必须**同时**处理 iOS 商店版那一支
//      （Android 可以有、iOS 商店版必须没有），并且**回来把这一段改掉**。
//
//   ⇒ 判据钉在 `test/unit/mini_runtime_test.dart`：
//      · `kNativeMiniRuntime` 必须是 `false`（要开它就得**显式**改这一行）；
//      · 条件导入**只许对 `dart.library.html` 选 Web 实现**。

export 'mini_runtime_stub.dart' if (dart.library.html) 'mini_runtime_web.dart';

/// 原生（Android / iOS）这一侧**有没有**小程序运行时。
///
/// 🔴 **现在是 `false`**，而且**不是**"暂时关掉了"—— 是**从来没做过**。
/// ⚠️ 要把它改成 `true` 的人：先读本文件顶上那段（iOS 商店版必须没有它），
///    并且**同时**在 `docs/dev/59-USER-APPS.md` §九 与手册里留下结论。
const bool kNativeMiniRuntime = false;
