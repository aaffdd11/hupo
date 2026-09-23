// **输入条那两个动作的新形态**（主人 2026-09-23 拍板的重设计 · `docs/dev/64-CHAT-REDESIGN.md` §五）。
//
// 两件：
//   ① **框里有字才画发送钮**（原来常驻 + 禁用态 ⇒ 一个 48px"按不动"的按钮一直挂着）；
//   ② **听筒只在语音档画**（键盘档那一格给输入框）—— 它那条判据在 `voice_demo_test.dart`。
//
// ⚠️ `test/widget`（**提示档**）—— 当闸的是"五档不溢出 + 命中区 ≥44"（`accessibility_test.dart`，硬闸）。
//    但**"有字才出现"这件事只有这里能钉**（a11y 闸不关心某个按钮在不在）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/widgets/composer.dart';

Future<void> _pump(WidgetTester tester) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(body: Composer(onSend: (_) {})),
    ),
  );
  await tester.pump();
}

/// 输入框左边那一端的 x（用来验"发送钮出现/消失**没把输入框挤动**"）。
double _fieldLeft(WidgetTester tester) =>
    tester.getTopLeft(find.byType(TextField)).dx;
double _fieldWidth(WidgetTester tester) =>
    tester.getSize(find.byType(TextField)).width;
double _rowWidth(WidgetTester tester) =>
    tester.getSize(find.byType(Row).first).width;

void main() {
  testWidgets('🔴 没字 ⇒ **不画**发送钮（不是禁用态）；有字 ⇒ 出现', (tester) async {
    await _pump(tester);
    expect(find.byTooltip('发送'), findsNothing, reason: '★ 没话要说时那个位置该空着');

    await tester.enterText(find.byType(TextField), '在吗');
    await tester.pump();
    expect(find.byTooltip('发送'), findsOneWidget, reason: '有字了才出现');

    // 打的全是空格 ⇒ 也**不算**有话要说（发送要 trim 过）
    await tester.enterText(find.byType(TextField), '   ');
    await tester.pump();
    expect(find.byTooltip('发送'), findsNothing, reason: '★ 只有空格不算有话要说');
  });

  testWidgets('🔴 它出现/消失时，输入框**一个像素都不许动**（同 D4.8 那种病）', (tester) async {
    // ⚠️ 为什么单钉这条：发送钮"一会儿有一会儿没有"，如果让它撑开/收窄，
    //    输入框就会跟着跳 —— 那是**界面自己抖**，用户正在打字时会很难受。
    await _pump(tester);
    final left0 = _fieldLeft(tester);
    final width0 = _fieldWidth(tester);
    final row0 = _rowWidth(tester);

    await tester.enterText(find.byType(TextField), '在吗');
    await tester.pump();
    expect(find.byTooltip('发送'), findsOneWidget);
    expect(_fieldLeft(tester), left0, reason: '★ 输入框左边不许动');
    expect(_fieldWidth(tester), width0, reason: '★ 输入框宽度不许动');
    expect(_rowWidth(tester), row0, reason: '★ 整行宽度不许动');

    // 发出去（框清空）⇒ 发送钮消失，位置照旧
    await tester.tap(find.byTooltip('发送'));
    await tester.pump();
    expect(find.byTooltip('发送'), findsNothing, reason: '发完框空了 ⇒ 它该收起来');
    expect(_fieldLeft(tester), left0, reason: '★ 收起来也不许把输入框挤动');
    expect(_fieldWidth(tester), width0);
  });
}
