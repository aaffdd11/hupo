// **「配置」页的层级**（主人 2026-09-23：*"先整理整个UI"* 的第三块）· 契约 `docs/dev/72-UI-PASS.md`。
//
// 这一份钉四件：
//   ① 🔴 **分区标题不许用强调色**（原来 `你那串钥匙` 是红的 ⇒ 读起来像警告；它是分区名）
//   ② **两个分区都有标题**（原来"关于 / 退出登录"光秃秃挂在最下面，一页读不出结构）
//   ③ 「关于」那一条**有一句说明**（光"关于"两个字读不出这一页管什么）
//   ④ **退出登录仍然是红的**（不许顺手把它也"统一"成黑的 —— 那才是真该醒目的那一条）

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/design.dart' as d;
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/settings_screen.dart';
import 'package:hupo_app/services/api.dart';

Future<void> pump(WidgetTester tester, {bool localOnly = true}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SettingsScreen(
          hasKey: false,
          keyBad: false,
          localOnly: localOnly,
          onSubmit: (k) async => KeySend.ok,
          onLogout: () {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('🔴 分区标题是"黑 + 加粗"，**不是**强调色（那看着像警告）', (tester) async {
    await pump(tester);
    final title = tester.widget<Text>(find.text(configKeySection));
    expect(title.style?.color, d.ink, reason: '分区名要稳 —— 红色的意思留给"退出登录"这类事');
    expect(title.style?.color, isNot(d.accent));
    expect(title.style?.fontWeight, FontWeight.w600);
  });

  testWidgets('★ 两个分区都有标题（一页里读得出结构）', (tester) async {
    await pump(tester);
    expect(find.text(configKeySection), findsOneWidget);
    expect(find.text(settingsAboutSection), findsOneWidget);
  });

  testWidgets('★ 「关于」那一条有一句说明', (tester) async {
    await pump(tester);
    expect(find.text('关于'), findsOneWidget);
    expect(find.text(aboutEntryHint), findsOneWidget);
  });

  testWidgets('★ 退出登录仍然是红的（不许被"统一"掉）', (tester) async {
    await pump(tester);
    final icon = tester.widget<Icon>(find.byIcon(Icons.logout));
    expect(icon.color, d.accent, reason: '这一条才是真该醒目的');
  });

  testWidgets('放大到 2.0 倍也不溢出（D3.5 那一族的形状）', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: MediaQuery(
          data: const MediaQueryData(textScaler: TextScaler.linear(2.0)),
          child: Scaffold(
            body: SettingsScreen(
              hasKey: false,
              keyBad: false,
              localOnly: true,
              onSubmit: (k) async => KeySend.ok,
              onLogout: () {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
