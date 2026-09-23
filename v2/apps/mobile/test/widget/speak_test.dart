// **每条回答下面的"读一遍"**（主人 2026-09-23 定案）· 契约 `docs/dev/68-SPEAK.md`。
//
// 这一份钉四件：
//   ① 给了回调 ⇒ **画出来**，点一下真的把这一条交出去
//   ② 正在念这一条 ⇒ 同一个按钮变成**"别念了"**，点它走的是"停"
//   ③ 🔴 **没给回调（这个平台念不了）⇒ 不画** —— 界面上不许出现按不动的东西
//   ④ 🔴 **没说完的回答不画**（半句 /"这条没说完"念出来 = 替它把话说圆）
//
// ⚠️ 测试环境里 `canSpeak` 是假（`services/speech_stub.dart`），
//    所以这里直接搭 `AnswerBubble` 并把回调**注入**进去。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/speak_words.dart';
import 'package:hupo_app/models/timeline.dart';
import 'package:hupo_app/widgets/bubbles.dart';

AssistantMessage msg({bool ended = true, String? reason = 'completed'}) {
  return AssistantMessage(messageId: 'm1', seq: 1)
    ..quick = '北京今天多云，19 度。'
    ..ended = ended
    ..reason = reason;
}

Future<void> pump(
  WidgetTester tester,
  AssistantMessage m, {
  VoidCallback? onSpeak,
  VoidCallback? onStopSpeak,
  bool speaking = false,
  double scale = 1.0,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: MediaQuery(
        data: MediaQueryData(textScaler: TextScaler.linear(scale)),
        child: Scaffold(
          body: SingleChildScrollView(
            child: AnswerBubble(
              message: m,
              onSpeak: onSpeak,
              onStopSpeak: onStopSpeak,
              speaking: speaking,
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('★ 给了回调 ⇒ 画"读一遍"，点一下真的交出去', (tester) async {
    var tapped = 0;
    await pump(tester, msg(), onSpeak: () => tapped += 1);
    expect(find.text(speakOnceWords), findsOneWidget);
    await tester.tap(find.text(speakOnceWords));
    await tester.pumpAndSettle();
    expect(tapped, 1);
  });

  testWidgets('★ 正在念这一条 ⇒ 按钮变成"别念了"，点它走"停"', (tester) async {
    var stopped = 0;
    await pump(
      tester,
      msg(),
      onSpeak: () {},
      onStopSpeak: () => stopped += 1,
      speaking: true,
    );
    expect(find.text(speakOnceWords), findsNothing);
    expect(find.text(speakStopWords), findsOneWidget);
    await tester.tap(find.text(speakStopWords));
    await tester.pumpAndSettle();
    expect(stopped, 1, reason: '★ 点在念的那一条 ⇒ 停，而不是重新念一遍');
  });

  testWidgets('🔴 念不了（没有回调）⇒ **一个字都不画**（不许有按不动的东西）', (tester) async {
    await pump(tester, msg());
    expect(find.text(speakOnceWords), findsNothing);
    expect(find.text(speakStopWords), findsNothing);
    expect(find.byWidgetPredicate((w) => w is ButtonStyleButton), findsNothing);
  });

  testWidgets('🔴 没说完的回答**不画**（念出来等于替它把话说圆）', (tester) async {
    await pump(tester, msg(ended: false, reason: null), onSpeak: () {});
    expect(find.text(speakOnceWords), findsNothing, reason: '还在说 ⇒ 不画');

    await pump(tester, msg(reason: 'failed'), onSpeak: () {});
    expect(find.text(speakOnceWords), findsNothing, reason: '"这条没说完" ⇒ 不画');

    await pump(tester, msg(reason: 'timeout'), onSpeak: () {});
    expect(find.text(speakOnceWords), findsNothing, reason: '卡住收的口 ⇒ 不画');
  });

  testWidgets('★ 命中区 ≥44（D3.6：它是个能点的东西）', (tester) async {
    await pump(tester, msg(), onSpeak: () {});
    final rect = tester
        .getSemantics(find.byWidgetPredicate((w) => w is ButtonStyleButton))
        .rect;
    expect(rect.width >= 44 && rect.height >= 44, isTrue, reason: '命中区是 ${rect.size}');
  });

  testWidgets('★ 3.1 倍字号下不溢出（跟字算）', (tester) async {
    await pump(tester, msg(), onSpeak: () {}, scale: 3.1);
    expect(tester.takeException(), isNull);
    expect(find.text(speakOnceWords), findsOneWidget);
  });
}
