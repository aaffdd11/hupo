// **语音那一刀的"形状"**（主人：*"对话框要学习微信。要能切语音，能切听筒。
// 语音和听筒都要实时转文字。"* → 追问后他说 **"先做假的"**）。
//
// 🔴 **这一份判据的重点不是"功能对不对"，而是"假得够不够明显"**：
//    这个项目栽过三次"页面在说假话"（`07-APPENDIX.md` 事故一），
//    `D5.13` 还专门规定**不录音时禁用"听"字**。
//    所以：形状可以真、数据必须是**明标「演示」**的假。
//
// 契约：`docs/dev/55-VOICE-DEMO.md`。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/forbidden_words.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/widgets/composer.dart';

Future<void> _pump(WidgetTester tester) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(body: Composer(onSend: (_) {})),
    ),
  );
  await tester.pump();
}

/// 演示小标（"这是假的"那一眼）。
Finder get _chip => find.text(voiceDemoChip);

void main() {
  test('🔴 新加的这几句都要过禁用词闸（界面词表是硬闸）', () {
    for (final s in [
      voiceToKeyboard,
      voiceToMic,
      voiceHoldToTalk,
      voiceReleaseToSend,
      voiceDemoChip,
      voiceNotWired,
      voiceEarpieceNotWired,
      voiceEarpieceOn,
      voiceEarpieceOff,
    ]) {
      expect(hasForbidden(s), false, reason: '「$s」命中了禁用词');
    }
  });

  test('🔴 不出现"正在听"这类假动作的字（D5.13）', () {
    // 我们这一版**根本没开麦** ⇒ 任何"正在听"都是假话。
    for (final s in [voiceNotWired, voiceEarpieceNotWired, voiceHoldToTalk]) {
      expect(s.contains('正在听'), false, reason: '「$s」不许说"正在听" —— 它没在听');
    }
  });

  testWidgets('★ 默认是键盘档：有输入框，没有"按住 说话"', (tester) async {
    await _pump(tester);
    expect(find.byType(TextField), findsOneWidget);
    expect(find.text(voiceHoldToTalk), findsNothing);
    expect(_chip, findsNothing, reason: '没进演示就不该有那个小标');
  });

  testWidgets('🔴 点话筒 ⇒ 语音档：有"按住 说话"，而且**明标「演示」+ 一句实话**', (tester) async {
    await _pump(tester);
    await tester.tap(find.byTooltip(voiceToMic));
    await tester.pump();

    expect(find.text(voiceHoldToTalk), findsOneWidget, reason: '切到语音档了');
    expect(find.byType(TextField), findsNothing, reason: '语音档没有打字框');
    // 🔴 **这两条是这一批的命门**：假的必须一眼看得出来
    expect(_chip, findsOneWidget, reason: '★ 「演示」小标必须在');
    expect(
      find.text(voiceNotWired),
      findsOneWidget,
      reason: '★ 那句实话必须在（还没真的开麦）',
    );
  });

  testWidgets('🔴 按住 ⇒ 出字（"实时转文字"的形状）；松手 ⇒ **进打字框、不自动发送**', (tester) async {
    var sent = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: Composer(onSend: (_) => sent += 1)),
      ),
    );
    await tester.pump();
    await tester.tap(find.byTooltip(voiceToMic));
    await tester.pump();

    // 按住：字一个一个出来（这就是"实时"那个形状）
    final gesture = await tester.startGesture(
      tester.getCenter(find.text(voiceHoldToTalk)),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 700));
    expect(
      find.text(voiceReleaseToSend),
      findsOneWidget,
      reason: '按着的时候该说"松手 发送"',
    );
    expect(_chip, findsOneWidget, reason: '吐字的时候也得挂着「演示」小标');

    // 松手
    await gesture.up();
    await tester.pumpAndSettle();
    expect(sent, 0, reason: '★ 松手**不许**自动发送（手册 D5.4：绝不自动发送）');
    expect(find.byType(TextField), findsOneWidget, reason: '松手回到键盘档，让他能改能发');
    final text = tester
        .widget<TextField>(find.byType(TextField))
        .controller!
        .text;
    expect(text.isNotEmpty, true, reason: '演示吐出来的字该放进打字框（让他自己决定发不发）');
    expect(text.contains('演示'), true, reason: '★ 那句字里自带"演示" —— 万一被发出去也不会被当成真话');
  });

  testWidgets('🔴 点听筒 ⇒ 也有「演示」小标 + 一句实话（读出来还没做）', (tester) async {
    await _pump(tester);
    // ⚠️ **2026-09-23 改了这一步**（主人拍板的重设计）：听筒**只在语音档**画了 ——
    //    键盘档用不着它，那一格 48px 给输入框更值。⇒ 先切到语音档再点它。
    expect(find.byTooltip(voiceEarpieceOff), findsNothing, reason: '键盘档不该有听筒');
    await tester.tap(find.byTooltip(voiceToMic));
    await tester.pump();
    expect(find.byTooltip(voiceEarpieceOff), findsOneWidget, reason: '语音档才画听筒');

    await tester.tap(find.byTooltip(voiceEarpieceOff));
    await tester.pump();

    expect(find.byTooltip(voiceEarpieceOn), findsOneWidget, reason: '切到听筒那一档了');
    expect(_chip, findsOneWidget, reason: '★ 听筒这一半同样是假的，也得标出来');
    expect(find.text(voiceEarpieceNotWired), findsOneWidget);
  });

  testWidgets('🔴 回键盘档 ⇒ 听筒那一档**跟着关**（不然演示那条留在没有开关的界面上）', (tester) async {
    await _pump(tester);
    await tester.tap(find.byTooltip(voiceToMic));
    await tester.pump();
    await tester.tap(find.byTooltip(voiceEarpieceOff));
    await tester.pump();
    expect(_chip, findsOneWidget, reason: '这时演示小标在');

    // 切回键盘档
    await tester.tap(find.byTooltip(voiceToKeyboard));
    await tester.pump();
    expect(find.byTooltip(voiceEarpieceOn), findsNothing, reason: '听筒该关了');
    expect(find.byTooltip(voiceEarpieceOff), findsNothing, reason: '键盘档不画听筒');
    expect(_chip, findsNothing, reason: '★ 听筒关了 ⇒ 演示小标也该没（它已经没有任何开关在界面上）');
  });
}
