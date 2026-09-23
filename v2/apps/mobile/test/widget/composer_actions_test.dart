// **输入条上那个发送钮的新形态**（主人 2026-09-24 拍板 · `docs/dev/75-CHAT-ROW.md`）。
//
// 主人原话：*"聊天框右侧应该是一个发送按钮。一开始是灰色的。"*
//
// 🔴 这一条**推翻了 2026-09-23 那个"有字才画"**（那也是主人拍的板，见
//    `docs/dev/64-CHAT-REDESIGN.md` §五）——
//    ⇒ 现在它**一直在**：没字（或只有空格）时是**灰的、按不动**，有字时亮起来。
//    ⇒ 但**"位置与宽度固定"这条老规矩照旧**，而且比原来更要紧：
//       它要是随字出现/消失而撑开收窄，输入框会被挤得跳（D4.8 那种"界面自己抖"）。
//
// ⚠️ `test/widget`（**提示档**）—— 当闸的是"五档不溢出 + 命中区 ≥44"（`accessibility_test.dart`，硬闸）。
//    但**"灰的按不动 / 有字就能按"这件事只有这里能钉**（a11y 闸不关心某个按钮的状态）。

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

/// 输入框左边那一端的 x / 宽度（用来验"发送钮亮没亮**没把输入框挤动**"）。
double _fieldLeft(WidgetTester tester) =>
    tester.getTopLeft(find.byType(TextField)).dx;
double _fieldWidth(WidgetTester tester) =>
    tester.getSize(find.byType(TextField)).width;

/// **发送钮此刻按不按得动**（灰 = `onPressed == null`）。
bool _sendReady(WidgetTester tester) => tester
    .widget<IconButton>(
      find.ancestor(
        of: find.byIcon(Icons.arrow_upward),
        matching: find.byType(IconButton),
      ),
    )
    .onPressed !=
    null;

void main() {
  testWidgets('🔴 发送钮**一直在**：没字 ⇒ 灰的、按不动；有字 ⇒ 亮起来', (tester) async {
    await _pump(tester);
    expect(find.byIcon(Icons.arrow_upward), findsOneWidget, reason: '★ 一开始它就在（主人 2026-09-24）');
    expect(_sendReady(tester), false, reason: '★ 一开始是灰的、按不动');

    await tester.enterText(find.byType(TextField), '在吗');
    await tester.pump();
    expect(_sendReady(tester), true, reason: '有字了 ⇒ 能按');

    // 打的全是空格 ⇒ **也不算**有话要说（发送要 trim 过）
    await tester.enterText(find.byType(TextField), '   ');
    await tester.pump();
    expect(_sendReady(tester), false, reason: '★ 只有空格不算有话要说');
  });

  testWidgets('🔴 它亮/灰的切换，输入框**一个像素都不许动**（同 D4.8 那种病）', (tester) async {
    // ⚠️ 为什么单钉这条：发送钮的状态一变就撑开/收窄的话，输入框会跟着跳 ——
    //    那是**界面自己抖**，用户正在打字时会很难受。
    //    （2026-09-24 之前它还会"一会儿有一会儿没有"，那条判据原来钉的是"出现/消失"。）
    await _pump(tester);
    final left0 = _fieldLeft(tester);
    final width0 = _fieldWidth(tester);

    await tester.enterText(find.byType(TextField), '在吗');
    await tester.pump();
    expect(_sendReady(tester), true);
    expect(_fieldLeft(tester), left0, reason: '★ 输入框左边不许动');
    expect(_fieldWidth(tester), width0, reason: '★ 输入框宽度不许动');

    // 发出去（框清空）⇒ 发送钮**变灰**，位置照旧
    await tester.tap(find.byTooltip('发送'));
    await tester.pump();
    expect(_sendReady(tester), false, reason: '发完框空了 ⇒ 它该变灰');
    expect(_fieldLeft(tester), left0, reason: '★ 变灰也不许把输入框挤动');
    expect(_fieldWidth(tester), width0);
  });
}
