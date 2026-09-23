// **"粘贴"那两个按钮**（2026-09-21 主人报「我无法黏贴，为啥」之后加的）。
//
// ── 为什么非有不可（这一条不是"顺手加的体验优化"）──────────
// Flutter 把字画在 **canvas** 上，长按弹的是**它自己的**选择菜单 ——
// 而**空输入框里没有可选的文字** ⇒ **菜单不弹 ⇒ 没有"粘贴"**。
// 桌面浏览器按 `Ctrl+V` 没事；**手机没有物理键盘就卡在这儿**。
// 而"钥匙"那一屏要的恰好是"**粘一长串**" ⇒ 没有按钮就是**进不去**。
// ⇒ 一个按钮按下去就是"用户手势"，能合法读剪贴板（`Clipboard.getData`）。
//
// ⛔ **2026-09-24 少了聊天框那两条**：主人要求去掉聊天框的「粘贴」按钮
//    （*"聊天窗口需要去掉粘贴按钮"*）⇒ 那两条判据跟着它一起砍了。
//    ⚠️ **钥匙屏那一半留着**：那一屏是"粘一长串钥匙"，按钮在那儿是**非有不可**的。
//
// ── 现在钉两条（每条都带负向对照）────────────────────────
//   1. 钥匙屏：读到 ⇒ 填进去；
//   2. 钥匙屏：**读不到 ⇒ 说实话**，而且**不许清空他已有的内容**；
//   3. 聊天框：粘在**光标处**（**不是**替换掉他打了一半的话）；
//   4. 聊天框：剪贴板是空的 ⇒ **什么都不插**（不许插进一个空串把光标挪乱）。

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/model_key_screen.dart';
import 'package:hupo_app/services/api.dart';

/// 假装剪贴板里有 `text`（`null` = 读不到 / 空）。
void _mockClipboard(String? text) {
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(SystemChannels.platform, (call) async {
    if (call.method == 'Clipboard.getData') {
      if (text == null) return null;
      return <String, dynamic>{'text': text};
    }
    return null;
  });
}

void main() {
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });

  testWidgets('🔴 钥匙屏：**粘贴** ⇒ 那一串真的填进去了', (tester) async {
    _mockClipboard('sk-pasted-key-1234567890');
    await tester.pumpWidget(MaterialApp(
      home: ModelKeyScreen(onSubmit: (_) async => KeySend.ok),
    ));
    expect(find.text(keyPaste), findsOneWidget, reason: '必须有一个能按的"粘贴"');
    await tester.tap(find.text(keyPaste));
    await tester.pumpAndSettle();
    final f = tester.widget<TextField>(find.byType(TextField));
    expect(f.controller!.text, 'sk-pasted-key-1234567890');
  });

  testWidgets('负向对照：读不到剪贴板 ⇒ 说实话，而且**不许清空**他已经填的', (tester) async {
    _mockClipboard(null); // 读不到
    await tester.pumpWidget(MaterialApp(
      home: ModelKeyScreen(onSubmit: (_) async => KeySend.ok),
    ));
    await tester.enterText(find.byType(TextField), '他手打了一半');
    await tester.tap(find.text(keyPaste));
    await tester.pumpAndSettle();
    expect(find.text(keyPasteFailed), findsOneWidget, reason: '要说清读不到、以及还能怎么办');
    final f = tester.widget<TextField>(find.byType(TextField));
    expect(f.controller!.text, '他手打了一半', reason: '🔴 读不到**不许**把他写的清掉');
  });

  testWidgets('🔴 那两个"粘贴"里不许出现内部词', (tester) async {
    for (final w in [keyPaste, keyPasteFailed]) {
      for (final bad in ['模型', '工作区', '口令', '客户端', '云端', '服务器', '调度器', '时间线', '作用域', '会话', '搜索', '上下文', '系统提示']) {
        expect(w.contains(bad), isFalse, reason: '「$w」里有内部词「$bad」');
      }
    }
  });
}
