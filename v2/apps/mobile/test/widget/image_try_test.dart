// **「试一张」那一块**的判据（P1-27）。
//
// 守的几条：
//   ① 🔴 **失败那句话是服务端给的，原样显示**（客户端**不许**自己编一个更具体的说法）
//   ② 空输入 ⇒ **一次都不许发出去**（省一次请求，也省一次钱）
//   ③ 成了 ⇒ **真的把图画出来**（`Image` 的地址就是服务端给的那个）
//   ④ 没填钥匙 / 没接线 ⇒ **不画那一块**（不给假按钮 —— 点了没反应的入口 = 坏了）

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/image_outcome.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/settings_screen.dart';
import 'package:hupo_app/services/api.dart';

/// 泵出配置页并切到「图片」那一屏。返回"被画了几次"的计数器。
Future<List<String>> pumpImageTab(
  WidgetTester tester, {
  SpaceCreds creds = const SpaceCreds(image: true),
  bool wired = true,
  ImageOutcome Function(String prompt)? reply,
}) async {
  final asked = <String>[];
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
          onDrawImage: wired
              ? (p) async {
                  asked.add(p);
                  return reply?.call(p) ?? const ImageOutcome(ok: true, urls: ['https://x.example/a.png']);
                }
              : null,
          onLogout: () {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.text(credTabImage));
  await tester.pumpAndSettle();
  return asked;
}

void main() {
  testWidgets('① 🔴 失败那句话**原样显示**（服务端说什么就说什么，不许自己编）', (tester) async {
    const words = '（这句是服务端给的）它说这次画不了，等会儿再试。';
    await pumpImageTab(tester, reply: (_) => const ImageOutcome(ok: false, words: words));
    await tester.enterText(find.byType(TextField).last, '一只猫');
    await tester.tap(find.text(imageTrySubmit));
    await tester.pumpAndSettle();
    expect(find.text(words), findsOneWidget, reason: '★ 客户端自己编了一句更具体的就是假话');
    expect(find.byType(Image), findsNothing, reason: '没成就不该有图');
  });

  testWidgets('② 空输入 ⇒ **一次都不发**，并说清"先写一句"', (tester) async {
    final asked = await pumpImageTab(tester);
    await tester.tap(find.text(imageTrySubmit));
    await tester.pumpAndSettle();
    expect(asked, isEmpty, reason: '★ 空话不许发出去（省一次请求，也省一次钱）');
    expect(find.text(imagePromptBlank), findsOneWidget);
  });

  testWidgets('③ 成了 ⇒ **真的画出那张图**（地址就是服务端给的那个）', (tester) async {
    final asked = await pumpImageTab(tester,
        reply: (_) => const ImageOutcome(ok: true, urls: ['https://x.example/only-this.png']));
    await tester.enterText(find.byType(TextField).last, '一只在窗台上的猫');
    await tester.tap(find.text(imageTrySubmit));
    await tester.pumpAndSettle();
    expect(asked, ['一只在窗台上的猫'], reason: '提示词要原样递上去（首尾空格去掉）');
    final img = tester.widget<Image>(find.byType(Image));
    final provider = img.image as NetworkImage;
    expect(provider.url, 'https://x.example/only-this.png');
    expect(find.text(imageTempLink), findsOneWidget, reason: '图是临时地址 —— 要说一句');
  });

  testWidgets('④ 没填钥匙 ⇒ **不画那一块**（负向对照：填了才有）', (tester) async {
    await pumpImageTab(tester, creds: const SpaceCreds(image: false));
    // ⚠️ 没填钥匙时**钥匙那个输入框本来就在**（那正是要他填的地方）——
    //    这里要断言的是**「试一张」那一块不在**（不给一个点了没用的按钮）。
    expect(find.byType(TextField), findsOneWidget, reason: '钥匙那个框还在（他正要填它）');
    expect(find.text(imageTryLabel), findsNothing, reason: '没填钥匙 ⇒ 不给「试一张」');
    expect(find.text(imageTrySubmit), findsNothing);
    // 正对照：同一个界面、只是 creds 说"有" ⇒ 那一块就该在
    await pumpImageTab(tester, creds: const SpaceCreds(image: true));
    expect(find.text(imageTryLabel), findsOneWidget);
  });

  testWidgets('④ 没接线（onDrawImage 为 null）⇒ 也不画', (tester) async {
    await pumpImageTab(tester, wired: false);
    expect(find.text(imageTryLabel), findsNothing);
  });

  testWidgets('按钮的命中区 ≥44（与那道硬闸同一条规矩）', (tester) async {
    await pumpImageTab(tester);
    final btn = tester.getSize(find.byType(FilledButton).last);
    expect(btn.height >= 44, true, reason: '按钮太小按不到：$btn');
  });
}
