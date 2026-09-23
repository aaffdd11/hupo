// **出处**（「它替你查过的东西，是哪来的」）· 契约 `docs/dev/67-SOURCES.md`。
//
// 这一份钉四件：
//   ① 有出处 ⇒ 抬头 + 那几行**画得出来**（名字优先用标题）
//   ② 🔴 **能点开的时候点了真的回调那个地址**；**开不了的时候不许画按钮**
//      （界面上不许出现按不动的东西）
//   ③ 🔴 没有出处 ⇒ 抬头**一个字都不画**（负向对照：不许留一个空框）
//   ④ 画不下就**如实报数**（"还有 N 处"），不许静默少画
//
// ⚠️ 这里直接搭 `AnswerBubble`（它是"傻组件"：喂什么画什么）——
//    服务端那一侧（谁把出处填进去）由 `test/sources.test.js` 钉着。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/source_words.dart';
import 'package:hupo_app/models/timeline.dart';
import 'package:hupo_app/widgets/bubbles.dart';

AssistantMessage msg({List<Map<String, dynamic>> sources = const []}) {
  final m = AssistantMessage(messageId: 'm1', seq: 1)
    ..quick = '北京今天多云。'
    ..deep = ''
    ..ended = true
    ..reason = 'completed';
  m.sources = sources;
  return m;
}

Future<void> pump(
  WidgetTester tester,
  AssistantMessage m, {
  void Function(String url)? onOpenSource,
  double scale = 1.0,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: MediaQuery(
        data: MediaQueryData(textScaler: TextScaler.linear(scale)),
        child: Scaffold(
          body: SingleChildScrollView(
            child: AnswerBubble(message: m, onOpenSource: onOpenSource),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('★ 有出处 ⇒ 抬头与那几行都画出来（有标题用标题）', (tester) async {
    await pump(tester, msg(sources: [
      {'title': '中国天气网 · 北京', 'url': 'https://www.weather.com.cn/bj'},
      {'title': 'news.example.cn', 'url': 'https://news.example.cn/x'},
    ]));
    expect(find.text(sourcesHeadWords), findsOneWidget);
    // ⚠️ 这一档（开不了）是**纯文字**，前面带一个"· " ⇒ 用 textContaining 找
    expect(find.textContaining('中国天气网 · 北京'), findsOneWidget);
    expect(find.textContaining('news.example.cn'), findsOneWidget);
  });

  testWidgets('🔴 给得出回调 ⇒ 点一下**真的把那个地址**交出去', (tester) async {
    final opened = <String>[];
    await pump(
      tester,
      msg(sources: [{'title': '中国天气网', 'url': 'https://www.weather.com.cn/bj'}]),
      onOpenSource: opened.add,
    );
    await tester.tap(find.textContaining('中国天气网'));
    await tester.pumpAndSettle();
    expect(opened, ['https://www.weather.com.cn/bj']);
  });

  testWidgets('🔴 开不了（没有回调）⇒ **不许画一个按不动的按钮**', (tester) async {
    await pump(tester, msg(sources: [
      {'title': '中国天气网', 'url': 'https://www.weather.com.cn/bj'},
    ]));
    // 字还在（看得见）
    expect(find.textContaining('中国天气网'), findsOneWidget);
    // 但**不是**可点的东西（负向对照：画了按钮就是缺陷）
    expect(find.byWidgetPredicate((w) => w is ButtonStyleButton), findsNothing);
  });

  testWidgets('🔴 负向对照：没有出处 ⇒ 抬头一个字都不画', (tester) async {
    await pump(tester, msg());
    expect(find.text(sourcesHeadWords), findsNothing);
    expect(find.byWidgetPredicate((w) => w is ButtonStyleButton), findsNothing);
  });

  testWidgets('★ 超过三处 ⇒ 画三处 + **如实报"还有 N 处"**', (tester) async {
    await pump(
      tester,
      msg(sources: [
        for (var i = 0; i < 5; i++) {'title': '第 $i 处', 'url': 'https://s$i.example/x'},
      ]),
      onOpenSource: (_) {},
    );
    expect(find.text('第 0 处'), findsOneWidget);
    expect(find.text('第 2 处'), findsOneWidget);
    expect(find.text('第 3 处'), findsNothing, reason: '只画前三处');
    expect(find.text(sourcesMoreWords(2)), findsOneWidget, reason: '剩下两处要如实说');
  });

  testWidgets('★ 3.1 倍字号下不溢出（跟字算，不是跟容器算）', (tester) async {
    await pump(
      tester,
      msg(sources: [
        {'title': '中国天气网 · 北京今天多云的详细预报与生活指数', 'url': 'https://www.weather.com.cn/bj'},
        {'title': 'news.example.cn', 'url': 'https://news.example.cn/x'},
      ]),
      onOpenSource: (_) {},
      scale: 3.1,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('★ 服务端没给标题时用地址兜底（不许画一个空行）', (tester) async {
    await pump(
      tester,
      msg(sources: [{'url': 'https://a.example/x'}]),
      onOpenSource: (_) {},
    );
    expect(find.text('https://a.example/x'), findsOneWidget);
  });
}
