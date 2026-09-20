// 探针页的渲染冒烟。
//
// ⚠️ **这只是一道"它还能搭起来"的闸**，不是验收。
// 探针真正的验收是**在真平板上用真输入法打一遍**——那一步机器替不了。
//
// 刻意**不写**这些断言（手册 03-DEVELOPMENT §6.5「不许写的测试」）：
// 像素坐标、控件 key、"哪块贴顶"、以及任何"默认就该长这样"的行为快照。
// 界面一改它们就过期，而过期的断言只会让人不敢动界面。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:hupo_app/main.dart';

void main() {
  testWidgets('探针页能搭起来，各部分都在', (tester) async {
    await tester.pumpWidget(const ProbeApp());
    await tester.pump();

    expect(find.text('琥珀 · 输入法探针'), findsWidgets);
    expect(find.textContaining('① 链子通不通'), findsOneWidget);
    expect(find.textContaining('② 输入法'), findsOneWidget);
    // ⚠️ 不在这里断言 ③④：它们在 ListView 里、屏幕外，
    //    **ListView 只构建可见项**，没进树 —— 断言它们会假失败。
    //    （这正是手册说的"别断言布局"：这条测试一旦被当成"界面必须长这样"，
    //      下次改布局就要来哄它。）
  });

  testWidgets('输入框能收到文本，并记进计数（IME 上屏的那条路）', (tester) async {
    await tester.pumpWidget(const ProbeApp());
    await tester.pump();

    await tester.enterText(find.byType(TextField), '明天下不下雨');
    await tester.pump();

    expect(find.textContaining('明天下不下雨'), findsWidgets);
    expect(find.textContaining('已提交次数：'), findsOneWidget);
  });

  testWidgets('没输入时发送按钮不可点（空话不发）', (tester) async {
    await tester.pumpWidget(const ProbeApp());
    await tester.pump();

    final send = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, '发送'),
    );
    expect(send.onPressed, isNull, reason: '空的时候不该能发');
  });
}
