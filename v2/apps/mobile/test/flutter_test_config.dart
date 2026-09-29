// 判据跑起来之前的**一处**设置（Flutter 认的文件名，自己会被 `flutter test` 加载）。
//
// 🔴 只干一件事：把**永不结束的动画**那个总开关关掉（手册 §6.1.1 的 **M2**：
//    "关它的地方只许有一处"）。
//
// 为什么非关不可：`pumpAndSettle()` 的出口是"没有下一帧了"，而 `..repeat()`
// **永远出不来** ⇒ 从"录音时那颗话筒在脉动"那一刻起的判据会**集体超时**，
// 而那种红不指向真 bug（手册原话，2026-09-22 真栽过一次）。
//
// ⚠️ **关掉 ≠ 删掉**（M3）：那一层照旧在树上、照旧画（停在第 0 刻）——
//    "不动"与"没有"是两件事。所以判据里照样找得到那几根 bar。

import 'dart:async';

import 'package:hupo_app/models/motion_switch.dart';

Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  setHupoAnimationsEnabled(on: false);
  await testMain();
}
