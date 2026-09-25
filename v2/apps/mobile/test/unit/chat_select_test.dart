// 「长按气泡 ⇒ 复制」到底复制哪一串字（契约 `docs/dev/106-CHAT-SELECT.md` §二）。
//
// ⚠️ 为什么单独一条硬闸：这一批最容易做歪的地方**不是界面**，是"复制什么"——
//    "带上出处 / 带上状态字 / 自己造个'[图片]'"都能做出一个**看着像对的**界面。
//    它是纯函数（`models/chat_select.dart`），所以进得了 `test/unit`。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/chat_select.dart';
import 'package:hupo_app/models/timeline.dart';

AssistantMessage _answer({
  String quick = '',
  String deep = '',
  List<Map<String, dynamic>> sources = const [],
}) {
  final m = AssistantMessage(messageId: 'm_1', seq: 2)
    ..quick = quick
    ..deep = deep
    ..ended = true
    ..reason = 'completed';
  m.sources = sources;
  return m;
}

void main() {
  test('他说的 ⇒ 逐字，一个装饰都不加', () {
    final u = UserUtterance(messageId: 'u_1', text: '帮我把这周工时记一下', seq: 1);
    expect(bubbleBodyOf(u), '帮我把这周工时记一下');
  });

  test('它回的 ⇒ 气泡里能看见的那段正文（快答 + 深答都在）', () {
    expect(bubbleBodyOf(_answer(quick: '北京今天多云。')), '北京今天多云。');
    expect(bubbleBodyOf(_answer(deep: '明天晴，最高 26 度。')), '明天晴，最高 26 度。');
    // ⚠️ 两个 block 拼起来的样子由 `displayText` 一处定（这里不另写拼法）
    expect(
      bubbleBodyOf(_answer(quick: '北京今天多云。', deep: '19 度，出门带件外套。')),
      '北京今天多云。19 度，出门带件外套。',
    );
  });

  test('🔴 出处**不许**混进正文（名字和地址都不许）', () {
    final m = _answer(
      quick: '北京今天多云。',
      sources: [
        {'title': '中国天气网 · 北京今天多云', 'url': 'https://www.weather.com.cn/bj'},
      ],
    );
    final body = bubbleBodyOf(m);
    expect(body, '北京今天多云。');
    expect(body.contains('中国天气网'), isFalse, reason: '★ 出处那个名字混进来了');
    expect(body.contains('http'), isFalse, reason: '★ 出处地址混进来了');
  });

  test('🔴 图片那一行地址不进正文，而且**不许自己造"[图片]"**', () {
    final m = _answer(quick: '画好了。\nhttps://img.example/dog.png');
    final body = bubbleBodyOf(m);
    expect(body, '画好了。');
    expect(body.contains('http'), isFalse);
    expect(body.contains('图片'), isFalse, reason: '★ 我们自己造的字不许上剪贴板');
    expect(body.contains('['), isFalse);
  });

  test('句子**中间**的地址留着（那是他话里的一部分，抹掉就改了他说的）', () {
    expect(
      bubbleBodyOf(_answer(quick: '就是 https://example.cn/a 这个')),
      '就是 https://example.cn/a 这个',
    );
  });

  test('🔴 空正文 ⇒ 空串（调用方据此说"复制不了"，不许塞空串还说"好了"）', () {
    expect(bubbleBodyOf(_answer()), isEmpty);
    expect(bubbleBodyOf(UserUtterance(messageId: 'u_1', text: '', seq: 1)), isEmpty);
    // 没有正文的那种条目（分隔线 / 通知）
    expect(bubbleBodyOf(TimelineMarker(kind: 'away', seq: 3)), isEmpty);
  });

  test('多选：按给的顺序取、一条一条分开；空正文那几条跳过', () {
    final items = <TimelineItem>[
      UserUtterance(messageId: 'u_1', text: '第一句', seq: 1),
      _answer(quick: '第二句'),
      _answer(quick: ''), // 没正文 ⇒ 不许留一个空行
      UserUtterance(messageId: 'u_3', text: '第四句', seq: 4),
    ];
    final bodies = bubbleBodiesOf(items, keep: (_) => true);
    expect(bodies, ['第一句', '第二句', '第四句']);
    expect(bodies.join('\n'), '第一句\n第二句\n第四句', reason: '★ 一条一行');
  });

  test('多选：`keep` 说了算（没选中的不许进）', () {
    final items = <TimelineItem>[
      UserUtterance(messageId: 'u_1', text: '选中的', seq: 1),
      UserUtterance(messageId: 'u_2', text: '没选中的', seq: 2),
    ];
    final bodies = bubbleBodiesOf(items, keep: (it) => it.messageId == 'u_1');
    expect(bodies, ['选中的']);
  });

  test('多选：一条正文都没有 ⇒ 空清单（调用方据此如实说）', () {
    final items = <TimelineItem>[
      _answer(),
      UserUtterance(messageId: 'u_1', text: '', seq: 1),
    ];
    expect(bubbleBodiesOf(items, keep: (_) => true), isEmpty);
  });
}
