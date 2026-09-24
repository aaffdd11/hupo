// **画好的图真的出现在聊天里**（P1-27 后半）。
//
// ⚠️ 与"配置页那个试一张"分开：这里验的是**回话里带着图片地址**时，
//    气泡会不会把它画出来（认不出就不画 —— 那一条是负向对照）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/models/timeline.dart';
import 'package:hupo_app/widgets/bubbles.dart';

AssistantMessage answerWith(String text) => AssistantMessage(messageId: 'm1', seq: 9)
  ..quick = text
  ..ended = true
  ..reason = 'completed';

Future<void> pumpAnswer(WidgetTester tester, String text) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: ListView(children: [AnswerBubble(message: answerWith(text))]),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  testWidgets('★ 回话里有图片地址 ⇒ **画出来**（地址就是那个）', (tester) async {
    await pumpAnswer(tester, '给你画好了：\n- https://x.example/only-this.png\n想要就存下来。');
    final img = tester.widget<Image>(find.byType(Image));
    expect((img.image as NetworkImage).url, 'https://x.example/only-this.png');
    // ⚠️ "想要就存下来"会出现**两次**（模型那句 ＋ 我们加的那句"图是临时给的"）——
    //    这是对的，所以分开断言（第一版写 `findsOneWidget` 当场红）。
    expect(find.textContaining('给你画好了'), findsOneWidget, reason: '人话那部分要留着');
    expect(find.text(imageTempWords), findsOneWidget, reason: '图是临时地址 —— 要说一句');
    expect(find.textContaining('only-this.png'), findsNothing, reason: '★ 整行地址不重复显示（图就在下面）');

  });

  testWidgets('★ 负向对照：话里没有图片地址 ⇒ **一个 Image 都不许有**', (tester) async {
    await pumpAnswer(tester, '看这个 https://x.example/page 里面有说明。');
    expect(find.byType(Image), findsNothing, reason: '★ 普通网址不许当成图片去取');
    expect(find.textContaining('https://x.example/page'), findsOneWidget, reason: '句子里的地址要留给他');
  });
}
