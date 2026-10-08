// **「验一下」那一块**的判据（v3.0 · 主人 2026-10-07 选的那一档：**只验钥匙和路，不花钱**）。
//
// 守的几条：
//   ① 🔴 **结果那句话由服务端给、原样显示**（客户端**不许**自己编一个更具体的说法）
//   ② 🔴 点一下**只发生一次检查**（它不生成任何东西 —— 这一块只叫一声上层）
//   ③ 没填钥匙 / 没接线 ⇒ **不画那一块**（不给假按钮 —— 点了没反应的入口 = 坏了）
//   ④ 按钮的命中区 ≥44（与 `image_try_test.dart` 同一条硬闸规矩）

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/ark_check_outcome.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/settings_screen.dart';
import 'package:hupo_app/services/api.dart';

/// 泵出配置页并切到「视频」那一屏。返回"被问了几次"的计数器（可变，点一次加一个）。
Future<List<int>> pumpVideoTab(
  WidgetTester tester, {
  // ⚠️ 视频这一屏看的是 `creds.video`；而服务端那份口径是"**这条路现在能不能用**"
  //    ⇒ 只填了图片那一栏时它也是 `true`（`creds.mjs` 的 `credStatus` ＋ `sharedKeyOf`）
  SpaceCreds creds = const SpaceCreds(video: true),
  bool wired = true,
  Future<ArkCheckOutcome> Function()? reply,
}) async {
  final asked = <int>[];
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SettingsScreen(
          hasKey: true,
          keyBad: false,
          creds: creds,
          localOnly: true,
          onSubmit: (k) async => KeySend.ok,
          onSubmitCreds: (t, v) async => KeySend.ok,
          onCheckArk: wired
              ? () async {
                  asked.add(1);
                  return reply?.call() ??
                      const ArkCheckOutcome(
                        ok: true,
                        image: true,
                        video: true,
                        words: '（这句是服务端给的）这把钥匙它认了。',
                      );
                }
              : null,
          onLogout: () {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await goTab(tester, credTabVideo);
  return asked;
}

/// **切到设置里某一页**（顶层是一列分类，子页要**先回来**才能换）。
Future<void> goTab(WidgetTester tester, String tab) async {
  final back = find.text(settingsBack);
  if (back.evaluate().isNotEmpty) {
    await tester.tap(back);
    await tester.pumpAndSettle();
  }
  final row = find.text(tab == credTabChat ? settingsRowModel : tab);
  if (row.evaluate().isEmpty) {
    // ⚠️ 顶层那一列**是懒加载的**：滚过之后就找不到上面那几行了
    await tester.scrollUntilVisible(
      row,
      200,
      scrollable: find
          .descendant(of: find.byKey(settingsListKey), matching: find.byType(Scrollable))
          .first,
    );
    await tester.pumpAndSettle();
  }
  expect(row, findsOneWidget, reason: '★ 顶层那一列里找不到「$tab」⇒ 这一条量错了地方');
  await tester.tap(row);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('① 🔴 那句话**原样显示**（服务端说什么就说什么，不许自己编）', (tester) async {
    const words = '（这句是服务端给的）这一串它说用不了。在这儿换一串就好。';
    final asked = await pumpVideoTab(
      tester,
      reply: () => Future.value(const ArkCheckOutcome(ok: false, words: words)),
    );
    await tester.tap(find.text(videoCheckSubmit));
    await tester.pumpAndSettle();
    expect(asked.length, 1, reason: '点一下就该问一次');
    expect(find.text(words), findsOneWidget, reason: '★ 客户端自己编一句更具体的就是假话');
  });

  testWidgets('② 点了 ⇒ **问一次**；忙的时候按钮换字（不许看着像没反应）', (tester) async {
    final gate = Completer<ArkCheckOutcome>();
    await pumpVideoTab(tester, reply: () => gate.future);
    await tester.tap(find.text(videoCheckSubmit));
    await tester.pump();
    expect(find.text(videoChecking), findsOneWidget, reason: '在验的时候要说一声');
    gate.complete(const ArkCheckOutcome(ok: true, image: true, video: true, words: '好了。'));
    await tester.pumpAndSettle();
    expect(find.text(videoCheckSubmit), findsOneWidget, reason: '验完要能再点一次');
    expect(find.text('好了。'), findsOneWidget);
  });

  testWidgets('③ 没填钥匙 ⇒ **不画那一块**（负向对照：填了才有）', (tester) async {
    await pumpVideoTab(tester, creds: const SpaceCreds());
    expect(find.text(videoCheckLabel), findsNothing, reason: '没填钥匙 ⇒ 不给「验一下」');
    expect(find.text(videoCheckSubmit), findsNothing);
    // 正对照：同一个界面、只是 creds 说"有"（⚠️ 服务端口径：只填了图片那一栏时它也报 `video:true`
    // —— 两栏同一把钥匙）⇒ 那一块就该在
    await pumpVideoTab(tester, creds: const SpaceCreds(video: true));
    expect(find.text(videoCheckLabel), findsOneWidget);
  });

  testWidgets('③ 没接线（onCheckArk 为 null）⇒ 也不画', (tester) async {
    await pumpVideoTab(tester, wired: false);
    expect(find.text(videoCheckLabel), findsNothing);
  });

  testWidgets('④ 按钮的命中区 ≥44（与那道硬闸同一条规矩）', (tester) async {
    await pumpVideoTab(tester);
    final btn = tester.getSize(find.byType(FilledButton).last);
    expect(btn.height >= 44, true, reason: '按钮太小按不到：$btn');
  });

  testWidgets('⑤ 🔴 那一屏**不许承诺"能出片"**（只验了钥匙，就说只验到的）', (tester) async {
    await pumpVideoTab(tester);
    expect(find.text(videoCheckHint), findsOneWidget);
    for (final w in [videoCheckHint, videoCheckLabel, videoCheckSubmit]) {
      expect(w.contains('能出'), false, reason: '越界承诺：$w');
      expect(w.contains('做好了'), false, reason: '越界承诺：$w');
    }
  });
}
