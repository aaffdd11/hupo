// 等待那屏**会不会自己动**（主人 2026-09-21："我需要一个动态的"）。
//
// ── 这一份钉两条 ──────────────────────────────────────────
//   1. ★ **它自己问**（`onRefresh` 每 2 秒被叫一次）—— 不用用户按"再看看"；
//   2. 🔴 **动态的只是"时间"和"在做事"，不是进度**：屏上**一个百分号都没有**。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/screens/waiting_screen.dart';

void main() {
  testWidgets('★ 它自己刷新：什么都不按，2 秒后 `onRefresh` 被叫一次', (tester) async {
    var calls = 0;
    await tester.pumpWidget(MaterialApp(
      home: WaitingScreen(onRetry: () {}, onRefresh: () async => calls++),
    ));
    expect(calls, 0, reason: '刚画出来不该已经问过');
    await tester.pump(const Duration(seconds: 2));
    expect(calls, 1, reason: '★ 它要**自己**问（这就是"动态"）');
    await tester.pump(const Duration(seconds: 2));
    expect(calls, 2);
    // ⚠️ 收尾：把定时器停掉，不然测试进程会被它挂住
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('★ 秒数**真的在走**（不是画的）', (tester) async {
    await tester.pumpWidget(MaterialApp(home: WaitingScreen(onRetry: () {})));
    expect(find.text('已经等了 0 秒'), findsOneWidget);
    await tester.pump(const Duration(seconds: 3));
    expect(find.text('已经等了 3 秒'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('🔴 三步清单画得出来，而且**屏上一个百分号都没有**', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: WaitingScreen(
        onRetry: () {},
        steps: const [
          SpaceStep(step: 'assigned', done: true),
          SpaceStep(step: 'starting', done: false),
          SpaceStep(step: 'ready', done: false),
        ],
      ),
    ));
    expect(find.text('给你留好一台，只属于你'), findsOneWidget);
    expect(find.text('把它开起来'), findsOneWidget);
    // 🔴 没有百分比
    expect(find.textContaining('%'), findsNothing);
    // ★ "正在做"那一步旁边**有个圈**（在动）—— 但它不是进度
    expect(find.byType(CircularProgressIndicator), findsWidgets);
    await tester.pumpWidget(const SizedBox());
  });
}
