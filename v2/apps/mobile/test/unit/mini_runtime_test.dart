// **沙箱运行时的选路**（乙-5 · 契约 `docs/dev/59-USER-APPS.md` §九）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   ① 🔴 **原生这一侧没有运行时**（`kNativeMiniRuntime == false`）——
//      它是"iOS 商店版不发布小程序运行时"那条合规约束的**今天**的样子
//      （`08-SPEC.md` §4.2）；**要开它就得显式改那一行**，改不动是刻意的。
//   ② 🔴 **非 Web 拿到的是那句实话**（不许白屏）：
//      VM 上跑（就是原生那条路）⇒ `buildMiniAppView` 要给出"这台设备上暂时还跑不了小程序"。
//   ③ 🔴 **条件导入只许对 `dart.library.html` 选 Web 实现**（源码级）：
//      写错一个条件，原生上就会去 import `dart:html` ⇒ 编译不过，
//      而那种错**只有真机打包时才会爆**。
//
// ⚠️ 为什么用"读源码"这种笨办法钉第 ③ 条：条件导入的**选择**在 VM 上观察不到
//    （VM 永远走 stub 那一支）⇒ 只能把那一行本身钉住。

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/app_words.dart';
import 'package:hupo_app/widgets/mini_runtime.dart';

void main() {
  test('🔴 原生这一侧**没有**小程序运行时（要开它必须显式改那一行）', () {
    expect(kNativeMiniRuntime, false,
        reason: '★ 打开它之前先读 `mini_runtime.dart` 顶上那段：iOS 商店版必须没有它');
  });

  testWidgets('🔴 非 Web 拿到的是**那句实话**（不是白屏）', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: buildMiniAppView(entryUrl: 'http://x/y', title: '随便')),
    ));
    await tester.pump();
    expect(find.text(appRuntimeNotHere), findsOneWidget,
        reason: '★ 跑不起来就说一句人话 —— "点了没反应"是这个项目最忌的形状');
  });

  test('🔴 条件导入只许对 `dart.library.html` 选 Web 实现（源码级）', () {
    final f = File('lib/widgets/mini_runtime.dart');
    expect(f.existsSync(), true, reason: '找不到那一份（cwd 不对？）');
    final src = f.readAsStringSync();
    expect(
      src.contains("if (dart.library.html) 'mini_runtime_web.dart'"),
      true,
      reason: '★ 条件只许是 `dart.library.html`；写错的话**只有真机打包时才会爆**',
    );
    expect(src.contains("export 'mini_runtime_stub.dart'"), true,
        reason: '默认（非 Web）必须是那句实话那一份');
  });

  test('两个实现的签名必须一致（不然换平台就编不过）', () {
    for (final name in ['lib/widgets/mini_runtime_stub.dart', 'lib/widgets/mini_runtime_web.dart']) {
      final src = File(name).readAsStringSync();
      for (final sig in ['required String entryUrl', 'required String title', 'onAsk']) {
        expect(src.contains(sig), true, reason: '$name 少了「$sig」—— 两份签名必须一样');
      }
    }
  });
}
