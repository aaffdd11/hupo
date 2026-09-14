// 时间线与消息模型测试。
//
// 守的是评审结论里的不变量，**特别是 v1 新增的那条**：
// 用户与调度器之间**没有配对关系** —— 任何配对假设都会在真实情形下错位。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/stream_event.dart';
import 'package:hupo_app/models/timeline.dart';

void main() {
  group('DispatcherMessage · 两块合成一条消息', () {
    test('快答与深答拼成同一个 displayText，中间不加连接词', () {
      final m = DispatcherMessage(messageId: 'm1', seq: 1, at: DateTime(2026));
      m.applyText(const MessageTextEvent(
          seq: 1, messageId: 'm1', block: TextBlock.quick, seqInBlock: 0, text: '先看连接池。', isFinal: true));
      m.applyText(const MessageTextEvent(
          seq: 2, messageId: 'm1', block: TextBlock.deep, seqInBlock: 0, text: '确认了，是连接池打满。', isFinal: true));

      expect(m.displayText, '先看连接池。确认了，是连接池打满。');
      expect(m.quickText, '先看连接池。');
      expect(m.deepText, '确认了，是连接池打满。');
    });

    test('快答未以句末标点结尾时补空格，避免粘连', () {
      final m = DispatcherMessage(messageId: 'm1', seq: 1, at: DateTime(2026));
      m.applyText(const MessageTextEvent(
          seq: 1, messageId: 'm1', block: TextBlock.quick, seqInBlock: 0, text: '我想想', isFinal: true));
      m.applyText(const MessageTextEvent(
          seq: 2, messageId: 'm1', block: TextBlock.deep, seqInBlock: 0, text: '答案是 A', isFinal: true));
      expect(m.displayText, '我想想 答案是 A');
    });

    test('只有深答时 displayText 就是深答', () {
      final m = DispatcherMessage(messageId: 'm1', seq: 1, at: DateTime(2026));
      m.applyText(const MessageTextEvent(
          seq: 1, messageId: 'm1', block: TextBlock.deep, seqInBlock: 0, text: '直接给结论。', isFinal: true));
      expect(m.displayText, '直接给结论。');
    });
  });

  group('DispatcherMessage · 去重与防乱序回退', () {
    test('seqInBlock 不大于已收到最大序号时丢弃（断线重连必然重复）', () {
      final m = DispatcherMessage(messageId: 'm1', seq: 1, at: DateTime(2026));
      const a = MessageTextEvent(
          seq: 1, messageId: 'm1', block: TextBlock.quick, seqInBlock: 0, text: '第一段', isFinal: false);
      const b = MessageTextEvent(
          seq: 2, messageId: 'm1', block: TextBlock.quick, seqInBlock: 1, text: '第二段', isFinal: true);

      expect(m.applyText(a), isTrue);
      expect(m.applyText(b), isTrue);
      expect(m.quickText, '第一段第二段');
      expect(m.applyText(a), isFalse);
      expect(m.applyText(b), isFalse);
      expect(m.quickText, '第一段第二段', reason: '重复事件不得产生重复文本');
    });

    test('快答与深答各自独立计数，互不干扰', () {
      final m = DispatcherMessage(messageId: 'm1', seq: 1, at: DateTime(2026));
      expect(
          m.applyText(const MessageTextEvent(
              seq: 1, messageId: 'm1', block: TextBlock.quick, seqInBlock: 0, text: 'Q', isFinal: true)),
          isTrue);
      expect(
          m.applyText(const MessageTextEvent(
              seq: 2, messageId: 'm1', block: TextBlock.deep, seqInBlock: 0, text: 'D', isFinal: true)),
          isTrue);
      expect(m.quickText, 'Q');
      expect(m.deepText, 'D');
    });
  });

  group('DispatcherMessage · 中止与失败', () {
    test('中止保留已收到的文本，只标记结束', () {
      final m = DispatcherMessage(messageId: 'm1', seq: 1, at: DateTime(2026));
      m.applyText(const MessageTextEvent(
          seq: 1, messageId: 'm1', block: TextBlock.quick, seqInBlock: 0, text: '我先看看这段。', isFinal: true));

      expect(m.abort(), isTrue);
      expect(m.isFinished, isTrue);
      expect(m.endReason, MessageEndReason.aborted);
      expect(m.quickText, '我先看看这段。', reason: '已显示的字撤不回来');
    });

    test('已结束的消息再中止不改变状态', () {
      final m = DispatcherMessage(messageId: 'm1', seq: 1, at: DateTime(2026));
      m.applyEnd(const MessageEndEvent(seq: 1, messageId: 'm1', reason: MessageEndReason.completed));
      expect(m.abort(), isFalse);
      expect(m.endReason, MessageEndReason.completed);
    });

    test('深答失败仍是合法收尾：有结束原因、有错误码、历史保留', () {
      final m = DispatcherMessage(messageId: 'm1', seq: 1, at: DateTime(2026));
      m.applyText(const MessageTextEvent(
          seq: 1, messageId: 'm1', block: TextBlock.quick, seqInBlock: 0, text: '这个我熟。', isFinal: true));
      m.applyError(const ErrorMessageEvent(
          seq: 2, messageId: 'm1', code: 'DEEP_FAILED', message: '深度分析没能完成'));
      m.applyText(const MessageTextEvent(
          seq: 3,
          messageId: 'm1',
          block: TextBlock.deep,
          seqInBlock: 0,
          text: '这条我没能给出结论，先按上面那条走。',
          isFinal: true));
      m.applyEnd(const MessageEndEvent(seq: 4, messageId: 'm1', reason: MessageEndReason.failed));

      expect(m.isFinished, isTrue);
      expect(m.endReason, MessageEndReason.failed);
      expect(m.errorCode, 'DEEP_FAILED');
      expect(m.displayText, contains('先按上面那条走'), reason: '失败也要有话说，不能留白');
    });
  });

  group('DispatcherMessage · 状态不是消息', () {
    test('状态提示不进入 displayText', () {
      final m = DispatcherMessage(messageId: 'm1', seq: 1, at: DateTime(2026));
      m.applyStatus(const MessageStatusEvent(seq: 1, messageId: 'm1', state: StreamStatus.thinking));
      expect(m.status, StreamStatus.thinking);
      expect(m.displayText, isEmpty);
      expect(m.hasAnyText, isFalse);
    });
  });

  group('协议解析 · 向前兼容', () {
    test('未知事件类型返回 null，不抛异常', () {
      expect(ServerEvent.tryParse({'type': 'future/thing', 'seq': 1}), isNull);
    });

    test('缺 seq 的事件被拒', () {
      expect(ServerEvent.tryParse({'type': 'message/text'}), isNull);
    });

    test('message/text 解析出块归属与块内序号', () {
      final e = ServerEvent.tryParse({
        'type': 'message/text',
        'seq': 5,
        'messageId': 'm1',
        'block': 'deep',
        'seqInBlock': 2,
        'text': 'abc',
        'final': true,
      })! as MessageTextEvent;
      expect(e.block, TextBlock.deep);
      expect(e.seqInBlock, 2);
      expect(e.isFinal, isTrue);
    });

    test('block 缺省按快答处理（保守：不误判为深答）', () {
      final e = ServerEvent.tryParse(
          {'type': 'message/text', 'seq': 1, 'messageId': 'm1', 'text': 'x'})! as MessageTextEvent;
      expect(e.block, TextBlock.quick);
    });

    test('message/start 解析 origin 与 re（主动消息 re 为空）', () {
      final proactive = ServerEvent.tryParse({
        'type': 'message/start',
        'seq': 1,
        'messageId': 'm1',
        'origin': 'proactive',
        're': <String>[],
      })! as MessageStartEvent;
      expect(proactive.origin, DispatcherOrigin.proactive);
      expect(proactive.re, isEmpty);

      final reactive = ServerEvent.tryParse({
        'type': 'message/start',
        'seq': 2,
        'messageId': 'm2',
        'origin': 'reactive',
        're': ['u_1', 'u_2'],
      })! as MessageStartEvent;
      expect(reactive.origin, DispatcherOrigin.reactive);
      expect(reactive.re, ['u_1', 'u_2']);
    });

    test('origin 缺省按 reactive 处理', () {
      final e = ServerEvent.tryParse({'type': 'message/start', 'seq': 1, 'messageId': 'm1'})!
          as MessageStartEvent;
      expect(e.origin, DispatcherOrigin.reactive);
    });

    test('message/start 解析来源；没来源就是空（旧客户端字段缺失也不崩）', () {
      final withSources = ServerEvent.tryParse({
        'type': 'message/start',
        'seq': 1,
        'messageId': 'm1',
        'sources': [
          {'title': 'DeepSeek 发布 V4.1', 'url': 'https://www.36kr.com/a'},
          {'url': 'https://example.com/b'},
          {'title': '没有链接的条目'},
          'garbage',
        ],
      })! as MessageStartEvent;
      // 无 url 的条目被丢掉；非 map 的脏数据被忽略
      expect(withSources.sources.length, 2);
      expect(withSources.sources[0].label, 'DeepSeek 发布 V4.1');
      // 没有标题就退回域名（并去掉 www.）
      expect(withSources.sources[1].label, 'example.com');
      expect(withSources.sources[0].domain, '36kr.com');

      final none = ServerEvent.tryParse({'type': 'message/start', 'seq': 2, 'messageId': 'm2'})!
          as MessageStartEvent;
      expect(none.sources, isEmpty);
    });

    test('来源挂在同一条消息上（快答与深答共用一个气泡）', () {
      final m = DispatcherMessage(messageId: 'm1', seq: 1, at: DateTime(2026));
      expect(m.sources, isEmpty);
      m.sources = const [Source(title: 't', url: 'https://a.com/x')];
      expect(m.hasAnyText, isFalse); // 还没吐字，气泡不该出现来源
      m.applyText(const MessageTextEvent(
        seq: 2,
        messageId: 'm1',
        block: TextBlock.deep,
        seqInBlock: 0,
        text: '结论。',
        isFinal: false,
      ));
      expect(m.hasAnyText, isTrue);
      expect(m.sources.single.domain, 'a.com');
    });
  });

    test('来源也可以晚到：message/end 带的来源是权威版本', () {
      // agent 会先说「收到，我先去查…」，那时 start 已经发出去了、还没有来源；
      // 工具跑完才在 end 里给出来。客户端必须以 end 为准。
      final m = DispatcherMessage(messageId: 'm1', seq: 1, at: DateTime(2026));
      expect(m.sources, isEmpty);

      m.applyText(const MessageTextEvent(
        seq: 2,
        messageId: 'm1',
        block: TextBlock.quick,
        seqInBlock: 0,
        text: '收到，我先去查。',
        isFinal: true,
      ));

      final end = ServerEvent.tryParse({
        'type': 'message/end',
        'seq': 9,
        'messageId': 'm1',
        'reason': 'completed',
        'sources': [
          {'title': '上海当前天气', 'url': 'https://pc.weathercn.com/a'},
        ],
      })! as MessageEndEvent;
      m.applyEnd(end);

      expect(m.sources.single.label, '上海当前天气');
      expect(m.sources.single.domain, 'pc.weathercn.com');
    });

    test('message/end 不带来源时不覆盖已有的（向前兼容旧服务端）', () {
      final m = DispatcherMessage(
        messageId: 'm1',
        seq: 1,
        at: DateTime(2026),
        sources: const [Source(title: 'a', url: 'https://a.com/x')],
      );
      m.applyEnd(const MessageEndEvent(seq: 2, messageId: 'm1', reason: MessageEndReason.completed));
      expect(m.sources, hasLength(1));
    });

    test('client/reload 解析：服务端说该刷新了', () {
      final e = ServerEvent.tryParse({
        'type': 'client/reload',
        'seq': 5,
        'reason': 'build-changed',
        'buildId': 'abc123',
      })! as ClientReloadEvent;
      expect(e.reason, 'build-changed');
      expect(e.buildId, 'abc123');
    });

    test('未知事件类型仍然被安全忽略（向前兼容）', () {
      expect(ServerEvent.tryParse({'type': 'brand/new/thing', 'seq': 9}), isNull);
    });

  group('时间线 · 不做配对（v1 的核心修正）', () {
    test('主动消息可以没有对应的用户输入', () {
      // 这是 v0 模型无处安放的情形
      final proactive = DispatcherMessage(
        messageId: 'm_p1',
        seq: 10,
        at: DateTime(2026),
        origin: DispatcherOrigin.proactive,
      )..applyText(const MessageTextEvent(
          seq: 11, messageId: 'm_p1', block: TextBlock.deep, seqInBlock: 0, text: '你让我盯的那件事有结果了。', isFinal: true));

      // 时间线上没有任何 UserUtterance，消息仍然成立
      final timeline = <TimelineItem>[proactive];
      expect(timeline.whereType<UserUtterance>(), isEmpty);
      expect(timeline.whereType<DispatcherMessage>().length, 1);
      expect(proactive.origin, DispatcherOrigin.proactive);
      expect(proactive.displayText, isNotEmpty);
    });

    test('一条消息可以回应多条用户输入（re 是溯源，不是配对）', () {
      final m = DispatcherMessage(
        messageId: 'm1',
        seq: 3,
        at: DateTime(2026),
        re: const ['u_1', 'u_2'],
      );
      expect(m.re.length, 2);
      // 渲染不依赖 re —— 它只是溯源信息
      expect(m.displayText, isEmpty);
    });

    test('排序键是 (seq, tie)：本地发言排在已收到事件之后、下一条服务端事件之前', () {
      final timeline = <TimelineItem>[
        UserUtterance(seq: 5, tie: 1, at: DateTime(2026), messageId: 'u1', text: '我说的'),
        DispatcherMessage(messageId: 'm1', seq: 5, at: DateTime(2026)),
        DispatcherMessage(messageId: 'm2', seq: 6, at: DateTime(2026)),
      ]..sort((a, b) => a.seq != b.seq ? a.seq.compareTo(b.seq) : a.tie.compareTo(b.tie));

      expect(timeline[0], isA<DispatcherMessage>(), reason: '同 seq 时 tie=0 的排在 tie=1 之前');
      expect((timeline[1] as UserUtterance).messageId, 'u1');
      expect((timeline[2] as DispatcherMessage).messageId, 'm2');
    });

    test('用户连续说两句：**说话顺序不能颠倒**（tie 的作用）', () {
      final timeline = <TimelineItem>[
        UserUtterance(seq: 0, tie: 1, at: DateTime(2026), messageId: 'u1', text: '第一句'),
        UserUtterance(seq: 0, tie: 2, at: DateTime(2026), messageId: 'u2', text: '第二句'),
        DispatcherMessage(messageId: 'm1', seq: 3, at: DateTime(2026)),
      ]..sort((a, b) => a.seq != b.seq ? a.seq.compareTo(b.seq) : a.tie.compareTo(b.tie));

      final utterances = timeline.whereType<UserUtterance>().toList();
      expect(utterances.length, 2);
      expect(utterances.first.text, '第一句', reason: '早说的必须排在前面');
      expect(utterances.last.text, '第二句');
      expect(timeline.last, isA<DispatcherMessage>());
    });
  });
}
