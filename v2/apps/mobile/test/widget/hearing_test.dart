// **语音那一块（真开麦）** · 主人 2026-09-23 定案 · 契约 `docs/dev/71-MIC-ASR.md`。
//
// 这一份钉七件（都是"屏幕上到底有没有说真话"）：
//   ① 🔴 **开不了麦 ⇒ 不画那个话筒**（界面上不许出现按不动的东西）
//   ② 闲的时候那行字是「按一下 说话」，点一下真的把动作交出去
//   ③ 正在听 ⇒ 变成「正在听…再按一下 结束」，**而且把听到的字显示出来**
//   ④ 🔴 **没配钥匙 ⇒ 只出现那句人话，连按钮都不画**（做不了的不许摆）
//   ⑤ 没拿到权限 ⇒ 人话 + 按钮还在（他能再按一次去放权限）
//   ⑥ ★ **说完了 ⇒ 字落进输入框、回到键盘那一档、发送钮出现**
//      （主人："然后将文字展示出来。用户可以选择发送。"）
//   ⑦ 命中区 ≥44（D3.6）
//
// ⚠️ 测试环境里 `canHear` 是假（`services/hearing_stub.dart`），所以这里把
//    `canHear`/`hearing`/`onMicToggle` **注入**进去，并且用 `ValueNotifier`
//    驱动 —— **照真实时序走**（先"在听"，再一句一句来字，最后收尾），
//    不然测的就不是那条路（"照着记忆里的老做法测"正是本项目最贵的错法）。
// ⚠️ 找按钮**用 `is TextButton` 而不是 `find.byType(TextButton)`**：
//    `TextButton.icon` 出来的是个子类，`byType` 是**精确类型**匹配 ⇒ 会找不到
//    （`accessibility_test.dart` 那条硬闸踩过同一个坑，它用的是 `is ButtonStyleButton`）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/hearing_session.dart';
import 'package:hupo_app/models/hearing_words.dart';
import 'package:hupo_app/widgets/composer.dart';

/// 把 Composer 绑在一个会变的 `Hearing` 上（＝真实那条路：状态从外面来）。
class _Harness extends StatelessWidget {
  const _Harness({
    required this.hearing,
    this.canHear = true,
    this.onMicToggle,
    this.scale = 1.0,
  });

  final ValueNotifier<Hearing> hearing;
  final bool canHear;
  final VoidCallback? onMicToggle;
  final double scale;

  @override
  Widget build(BuildContext context) => MaterialApp(
    home: MediaQuery(
      data: MediaQueryData(textScaler: TextScaler.linear(scale)),
      child: Scaffold(
        body: ValueListenableBuilder<Hearing>(
          valueListenable: hearing,
          builder: (context, h, _) => Composer(
            onSend: (_) {},
            canHear: canHear,
            hearing: h,
            onMicToggle: onMicToggle,
          ),
        ),
      ),
    ),
  );
}

Future<ValueNotifier<Hearing>> pump(
  WidgetTester tester, {
  Hearing start = const Hearing(),
  bool canHear = true,
  VoidCallback? onMicToggle,
  double scale = 1.0,
}) async {
  final n = ValueNotifier<Hearing>(start);
  await tester.pumpWidget(
    _Harness(
      hearing: n,
      canHear: canHear,
      onMicToggle: onMicToggle,
      scale: scale,
    ),
  );
  await tester.pumpAndSettle();
  return n;
}

/// 进语音那一档（点那个话筒 / 键盘的切换）。
Future<void> toVoice(WidgetTester tester) async {
  await tester.tap(find.byIcon(Icons.mic_none));
  await tester.pumpAndSettle();
}

/// 那颗大按钮（**不按精确类型找**：`.icon` 那个是子类）。
Finder micButton() => find.byWidgetPredicate((w) => w is TextButton);

void main() {
  testWidgets('★ 开不了麦 ⇒ 话筒**还在**，点它只说明白话（不装开麦）', (tester) async {
    // 🔴 2026-09-23 改的：原来这一档是**把话筒藏起来**，而主人看到的就是
    //    "为什么录音的 icon 没有？" —— 藏起来等于让用户自己猜。
    await pump(tester, canHear: false);
    expect(find.byIcon(Icons.mic_none), findsOneWidget);
    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    expect(find.text(hearCantHere), findsOneWidget); // 说一句白话
    expect(find.text(hearStart), findsNothing); // 但**不进语音档**（不装开麦）
  });

  testWidgets('★ 闲的时候：写「按一下 说话」，点一下真的交出去', (tester) async {
    var tapped = 0;
    await pump(tester, onMicToggle: () => tapped += 1);
    await toVoice(tester);
    expect(find.text(hearStart), findsOneWidget);
    expect(find.text(hearHint), findsOneWidget); // 说清楚按下去会发生什么
    await tester.tap(find.text(hearStart));
    await tester.pumpAndSettle();
    expect(tapped, 1);
  });

  testWidgets('★ 正在听：写「正在听…再按一下 结束」，而且把听到的字显示出来', (tester) async {
    var tapped = 0;
    final n = await pump(
      tester,
      start: const Hearing(phase: HearingPhase.listening, segments: {0: '今天天气'}),
      onMicToggle: () => tapped += 1,
    );
    await toVoice(tester);
    expect(find.text(hearListening), findsOneWidget); // ● 正在听（录音标记）
    expect(find.text(hearStop), findsOneWidget); // 按钮上：再按一下 结束
    expect(find.text('今天天气'), findsOneWidget); // 实时那几个字必须在屏幕上
    // 🔴 **正在听的时候不许出现发送钮**（半句话不许被发出去）
    expect(find.byIcon(Icons.arrow_upward), findsNothing);
    // 来下一句 ⇒ **屏幕上跟着变**（"实时转化语音成文字"）
    n.value = const Hearing(phase: HearingPhase.listening, segments: {0: '今天天气怎么样'});
    await tester.pumpAndSettle();
    expect(find.text('今天天气怎么样'), findsOneWidget);
    await tester.tap(find.text(hearStop));
    await tester.pumpAndSettle();
    expect(tapped, 1);
  });

  testWidgets('★ 没配钥匙 ⇒ 出现那句人话，而且**不画按钮**（按不动的东西不许摆）', (tester) async {
    await pump(
      tester,
      start: const Hearing(phase: HearingPhase.unavailable, why: hearUnavailable),
    );
    await toVoice(tester);
    expect(find.text(hearUnavailable), findsOneWidget);
    expect(micButton(), findsNothing);
  });

  testWidgets('★ 没拿到权限 ⇒ 人话 + 按钮还在（他能再按一次去放权限）', (tester) async {
    await pump(
      tester,
      start: const Hearing(phase: HearingPhase.denied, why: hearDenied),
    );
    await toVoice(tester);
    expect(find.text(hearDenied), findsOneWidget);
    expect(micButton(), findsOneWidget);
  });

  testWidgets('★ 说完了 ⇒ 字落进输入框、回到键盘那一档，而且发送钮出现', (tester) async {
    final n = await pump(tester);
    await toVoice(tester);
    // ① 按下去开始听
    n.value = const Hearing().tapped();
    await tester.pumpAndSettle();
    expect(find.text(hearListening), findsOneWidget);
    expect(find.text(hearStop), findsOneWidget);
    // ② 一句一句来字（实时那一段）
    n.value = n.value.partial('今天天气', index: 0);
    await tester.pumpAndSettle();
    expect(find.text('今天天气'), findsOneWidget);
    // ③ 收尾（对面说整段完了）
    n.value = n.value.finalText('今天天气怎么样').done();
    await tester.pumpAndSettle();
    // 回到键盘那一档：字在框里看得见
    expect(find.text('今天天气怎么样'), findsWidgets);
    // 🔴 **不自动发送**（D5.4）：发送钮出现，按不按由他
    expect(find.byIcon(Icons.arrow_upward), findsOneWidget);
  });

  testWidgets('★ 一句都没听到 ⇒ **留在语音档**并把那句话说清楚（不许悄悄退回键盘）', (tester) async {
    final n = await pump(tester);
    await toVoice(tester);
    n.value = const Hearing().tapped();
    await tester.pumpAndSettle();
    expect(find.text(hearListening), findsOneWidget);
    // 对面说"整段完了"，可一个字都没有
    n.value = n.value.done();
    await tester.pumpAndSettle();
    expect(find.text(hearNothing), findsOneWidget); // 屏幕上说了实话
    expect(find.text(hearStart), findsOneWidget); // 按钮还在（他能再按一次）
    expect(find.byIcon(Icons.keyboard_alt_outlined), findsOneWidget); // **还在语音档**
  });

  testWidgets('★ 那颗按钮的命中区 ≥44（D3.6）', (tester) async {
    await pump(tester);
    await toVoice(tester);
    final button = tester.widget<TextButton>(micButton());
    final min = button.style?.minimumSize?.resolve(<WidgetState>{});
    expect(min, isNotNull);
    expect(min!.height, greaterThanOrEqualTo(44));
    expect(min.width, greaterThanOrEqualTo(44));
  });

  testWidgets('放大到 2.0 倍也不溢出（D3.5 那一族的形状）', (tester) async {
    await pump(
      tester,
      start: const Hearing(phase: HearingPhase.listening, segments: {0: '今天天气怎么样'}),
      scale: 2.0,
    );
    await toVoice(tester);
    expect(tester.takeException(), isNull);
  });
}
