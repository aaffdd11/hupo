// **排队那一帧的客户端那一半**（契约 `docs/dev/117-QUEUE-VISIBLE.md`）。
//
// ⚠️ 这是**纯逻辑**那一层（`models/chat_queue.dart`），所以它进的是 `test/unit`
//    —— 硬闸。屏幕上到底画没画出来由 `test/widget/queue_strip_test.dart` 管。
//
// 这一份钉四件：
//   ① 认得出那一帧 ⇒ items 按服务端给的次序进来，原话**一个字不改**；
//   ② 认不出 ⇒ **绝不抛**（坏数据只许是"不画"，不许是"打不开聊天"）；
//   ③ 身份（`messageId`）认不出的那条**丢掉**（它上面那颗撤掉的按钮按了也没人认）；
//   ④ 🔴 **不编数**：`count` 是**数 items** 数出来的，服务端另给的那个数不参与。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/chat_queue.dart';

Map<String, dynamic> _frame(List<Object?> items) => {
  'type': 'queue/changed',
  'items': items,
  'count': items.length,
};

void main() {
  test('★ 认得出那一帧：FIFO 原样进来，原话一个字不改', () {
    final q = ChatQueue.of(
      _frame([
        {'messageId': 'm_2', 'text': '这件事也做一下', 'at': 1790, 'truncated': false},
        {'messageId': 'm_3', 'text': '还有这一件', 'at': 1791, 'truncated': false},
      ]),
    );
    expect(q, isNotNull);
    expect(q!.count, 2);
    expect(q.items.map((i) => i.messageId).toList(), ['m_2', 'm_3'], reason: '次序是服务端给的（FIFO）');
    expect(q.items.first.text, '这件事也做一下', reason: '原话照抄，不摘要/不改写/不翻译');
    expect(q.items.first.at, 1790);
    expect(q.items.first.truncated, isFalse);
  });

  test('🔴 截断那半如实保留（截了不说 = 页面在说假话）', () {
    final long = '甲' * 250;
    final q = ChatQueue.of(
      _frame([
        {'messageId': 'm_1', 'text': long, 'at': 1, 'truncated': true},
      ]),
    )!;
    expect(q.items.single.truncated, isTrue);
    // ⚠️ 客户端**不重裁也不补长**：服务端给什么就是什么（唯一那处裁剪在 `src/queue.js`）。
    expect(q.items.single.text, long);
    expect(q.items.single.text.length, 250);
  });

  test('★ 空队就是空队（服务端说"没排队"）', () {
    final q = ChatQueue.of(_frame([]))!;
    expect(q.isEmpty, isTrue);
    expect(q.count, 0);
    expect(q.items, isEmpty);
  });

  group('② fail-closed：认不出 ⇒ 绝不抛', () {
    test('不是这一帧 ⇒ null（别的帧不许被当成队列）', () {
      expect(ChatQueue.of({'type': 'message/end', 'items': []}), isNull);
      expect(ChatQueue.of({'type': 'app/installed'}), isNull);
    });

    test('压根不是 map / 是 null / 是字符串 / 是列表 ⇒ 不抛，且不是这一帧', () {
      for (final junk in <Object?>[null, '这不是一帧', 42, <int>[1, 2, 3]]) {
        expect(() => ChatQueue.of(junk), returnsNormally);
        expect(ChatQueue.of(junk), isNull);
      }
    });

    test('是这一帧但 items 坏了 ⇒ 当成**空队**（后面那句实话更可信，且绝不抛）', () {
      for (final bad in <Object?>[null, 'x', 7, {'a': 1}]) {
        ChatQueue? q;
        expect(() => q = ChatQueue.of({'type': 'queue/changed', 'items': bad}), returnsNormally);
        expect(q, isNotNull, reason: '它是这一帧 —— 认出来了');
        expect(q!.isEmpty, isTrue, reason: 'items 读不出来 ⇒ 空队（不许留着上一帧的旧行）');
      }
    });
  });

  test('③ 身份认不出的那条**丢掉**（画出来也撤不掉 = 屏幕上说假话）', () {
    final q = ChatQueue.of(
      _frame([
        {'messageId': 'm_ok', 'text': '这条算数', 'at': 1, 'truncated': false},
        {'messageId': '', 'text': '没有号的', 'at': 2},
        {'messageId': 9, 'text': '号不是字符串', 'at': 3},
        {'text': '压根没有号', 'at': 4},
        'not a map',
        null,
      ]),
    )!;
    expect(q.items.length, 1, reason: '只有带非空 messageId 的那条进得来');
    expect(q.items.single.messageId, 'm_ok');
  });

  test('★ 可选字段坏了不算坏（只影响好不好看，不影响能不能撤）', () {
    final q = ChatQueue.of(
      _frame([
        {'messageId': 'm_1'}, // 只有身份
        {'messageId': 'm_2', 'text': 42, 'at': '昨天', 'truncated': 'yes'},
      ]),
    )!;
    expect(q.count, 2);
    expect(q.items[0].text, '', reason: 'text 认不出 ⇒ 空串（不编一句）');
    expect(q.items[0].at, isNull);
    expect(q.items[0].truncated, isFalse, reason: '`truncated` 只认 `true`');
    expect(q.items[1].text, '');
    expect(q.items[1].at, isNull);
    expect(q.items[1].truncated, isFalse);
  });

  test('🔴 ④ 不编数：`count` 是数 items 数出来的，服务端另给的那个数不参与', () {
    // 服务端给 `count: 9`，可 items 只有两条 —— 屏幕上那行"9 条排队消息"
    // 底下只有两行，就是页面在说假话。⇒ 界面永远数 items。
    final q = ChatQueue.of({
      'type': 'queue/changed',
      'items': [
        {'messageId': 'm_1', 'text': '甲'},
        {'messageId': 'm_2', 'text': '乙'},
      ],
      'count': 9,
    })!;
    expect(q.count, 2, reason: '数得出来的东西不抄服务端那个数');
  });

  test('★ 空队那个常量确实是空的（界面靠它决定"一个像素都不画"）', () {
    expect(ChatQueue.empty.isEmpty, isTrue);
    expect(ChatQueue.empty.count, 0);
  });
}
