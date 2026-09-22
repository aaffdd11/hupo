// **`flutter test` 进每一个用例之前都会先跑这一份**（Flutter 的测试配置约定：
// `test/` 下这个文件名 + 导出 `testExecutable`）。
//
// ── 它只干一件事，但非干不可 ────────────────────────────────
// 🔴 **把桌面那层动态背景（水面涟漪）关掉。**
//
// 为什么：`pumpAndSettle()` 的循环长这样（`flutter_test/src/widget_tester.dart`）——
//
//     do { await binding.pump(duration); } while (binding.hasScheduledFrame);
//
// 一个**永不结束**的动画每帧都会重新排下一帧 ⇒ 这个循环**永远出不来**，
// 一直转到 10 分钟超时，然后 `pumpAndSettle timed out` 红掉。
// 实测过（2026-09-22）：一个 `..repeat()` 的探针在 3 秒内就 timeout 了。
//
// 而 `test/widget/` 里**一百多处**在用 `pumpAndSettle` ⇒ 不关它，
// 整套界面闸会**因为"测试卡住了"变红，而不是因为功能坏了** —— 那种红没人修得动。
//
// ── 为什么放在这儿，而不是每个用例里 ─────────────────────────
// 一个用例里写一行也能修，但要写**十几个文件**；而"同一件事写十几处"
// = 以后加一个新用例一定会漏。这里是**唯一一处**（`00-PROGRESS.md` 的老毛病：
// 同一份事实只许有一个家）。
//
// ⚠️ 关掉的**只是动画**（`debugWaterRippleAnimates`）：那一层**照旧画**
//    （`WaterRipplePainter` 还在树上、还能被量），只是不自己走时间 ——
//    所以 `test/widget/water_bg_test.dart` 照样能验"它画在了正确的地方"。
// ⚠️ 线上默认是 **true**（动的），见 `lib/widgets/water_bg.dart` 的文件头。

import 'dart:async';

import 'package:hupo_app/widgets/water_bg.dart';

Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  debugWaterRippleAnimates = false;
  await testMain();
}
