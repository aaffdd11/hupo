// 可见时间线 —— 手册 `02-ARCHITECTURE.md` §5、`08-SPEC.md` §4。
//
// 排序键是 `(seq, tie)`，**不是时间戳**：
// 本地发言是客户端钟、服务端事件是服务端钟，混钟排序会乱，
// 而现网是刻意避免混钟的。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/message_state.dart';
import 'package:hupo_app/models/timeline.dart';

void main() {
  group('排序', () {
    test('服务端事件按 seq 排', () {
      final t = Timeline();
      t.apply({'type': 'user/echo', 'messageId': 'u2', 'text': '第二句', 'seq': 2});
      t.apply({'type': 'user/echo', 'messageId': 'u1', 'text': '第一句', 'seq': 1});
      expect(t.items.map((e) => e.seq).toList(), [1, 2]);
    });

    test('★ 本地发言排在"已收到之后、下一条服务端事件之前"', () {
      final t = Timeline();
      t.apply({'type': 'message/start', 'messageId': 'm1', 'seq': 1});
      // 本地按下发送（还没收到服务端任何东西）
      t.addLocalUtterance('我先说的', 'u_local');
      // 服务端下一条事件到了（换一条**新的**消息——end 是改已有条目，不是新增）
      t.apply({'type': 'message/start', 'messageId': 'm2', 'seq': 2});

      final orders = t.items.map((e) => e.order).toList();
      expect(orders, [(1, 0), (1, 1), (2, 0)],
          reason: '本地那条必须夹在中间——不然它会跳到最前面去');
    });

    test('★ 排序不用时间戳：给事件带上乱七八糟的 at，顺序不变', () {
      final t = Timeline();
      t.apply({'type': 'user/echo', 'messageId': 'a', 'text': 'A', 'seq': 1, 'at': 9999999999999});
      t.apply({'type': 'user/echo', 'messageId': 'b', 'text': 'B', 'seq': 2, 'at': 1});
      expect(t.items.map((e) => (e as UserUtterance).messageId).toList(), ['a', 'b']);
    });
  });

  group('去重与回执', () {
    test('★ 同一个 seq 只收一次（断线重连必然重复）', () {
      final t = Timeline();
      t.apply({'type': 'message/start', 'messageId': 'm1', 'seq': 1});
      t.apply({'type': 'message/text', 'messageId': 'm1', 'seq': 2, 'block': 'quick', 'text': '你好'});
      t.apply({'type': 'message/text', 'messageId': 'm1', 'seq': 2, 'block': 'quick', 'text': '你好'});
      final m = t.items.whereType<AssistantMessage>().single;
      expect(m.quick, '你好', reason: '重复的帧不该让字变两遍');
    });

    test('★ 服务端回执"认领"本地那条，而不是再插一条', () {
      final t = Timeline();
      t.addLocalUtterance('我说的话', 'u_local');
      expect(t.items.length, 1);
      t.apply({'type': 'user/echo', 'messageId': 'u_local', 'text': '我说的话', 'seq': 5});
      expect(t.items.length, 1, reason: '★ 不然用户会看到自己说的话出现两遍');
      final u = t.items.whereType<UserUtterance>().single;
      expect(u.state, MessageState.confirmed);
      expect(u.seq, 5, reason: '认领之后要用服务端的号');
      expect(t.lastSeq, 5);
    });

    test('没认领到（别的设备发的）⇒ 当成新的一条', () {
      final t = Timeline();
      t.apply({'type': 'user/echo', 'messageId': 'u_elsewhere', 'text': '别处说的', 'seq': 1});
      expect(t.items.whereType<UserUtterance>().single.text, '别处说的');
    });
  });

  group('竞态：回执可能比 HTTP 响应先到', () {
    test('★ queued 直接收到回执 ⇒ 要认', () {
      final t = Timeline();
      t.addLocalUtterance('发出去的话', 'u1');
      // HTTP 还没回来，WS 上的回声先到了
      t.apply({'type': 'user/echo', 'messageId': 'u1', 'text': '发出去的话', 'seq': 1});
      expect(t.items.whereType<UserUtterance>().single.state, MessageState.confirmed,
          reason: '★ 否则界面会永远停在"已交出去"');
    });

    test('★ 认了之后 HTTP 才回 200，也不许把状态退回 sent', () {
      final t = Timeline();
      t.addLocalUtterance('发出去的话', 'u1');
      t.apply({'type': 'user/echo', 'messageId': 'u1', 'text': '发出去的话', 'seq': 1});
      t.setLocalState('u1', MessageState.sent); // HTTP 响应晚到
      expect(t.items.whereType<UserUtterance>().single.state, MessageState.confirmed);
    });
  });

  group('一条助手消息', () {
    test('start → text* → end，快答与深答在同一个气泡里', () {
      final t = Timeline();
      t.apply({'type': 'message/start', 'messageId': 'm1', 'seq': 1});
      t.apply({'type': 'message/text', 'messageId': 'm1', 'seq': 2, 'block': 'quick', 'text': '收到了'});
      t.apply({'type': 'message/text', 'messageId': 'm1', 'seq': 3, 'block': 'deep', 'text': '下周三天有雨。'});
      t.apply({'type': 'message/end', 'messageId': 'm1', 'seq': 4, 'reason': 'completed'});

      expect(t.items.whereType<AssistantMessage>().length, 1, reason: '必须是一个气泡');
      final m = t.items.whereType<AssistantMessage>().single;
      expect(m.quick, '收到了');
      expect(m.deep, '下周三天有雨。');
      expect(m.ended, true);
    });

    test('★ 快答没以句末标点结尾时补空格，免得两句粘一起', () {
      final t = Timeline();
      t.apply({'type': 'message/start', 'messageId': 'm1', 'seq': 1});
      t.apply({'type': 'message/text', 'messageId': 'm1', 'seq': 2, 'block': 'quick', 'text': '我去查'});
      t.apply({'type': 'message/text', 'messageId': 'm1', 'seq': 3, 'block': 'deep', 'text': '查到了。'});
      expect(t.items.whereType<AssistantMessage>().single.displayText, '我去查 查到了。');
    });

    test('快答以句号结尾时不加空格', () {
      final t = Timeline();
      t.apply({'type': 'message/start', 'messageId': 'm1', 'seq': 1});
      t.apply({'type': 'message/text', 'messageId': 'm1', 'seq': 2, 'block': 'quick', 'text': '收到了。'});
      t.apply({'type': 'message/text', 'messageId': 'm1', 'seq': 3, 'block': 'deep', 'text': '结论是 42。'});
      expect(t.items.whereType<AssistantMessage>().single.displayText, '收到了。结论是 42。');
    });

    test('★ end 上的来源是权威版本（协议 R8）', () {
      final t = Timeline();
      t.apply({'type': 'message/start', 'messageId': 'm1', 'seq': 1});
      t.apply({
        'type': 'message/end', 'messageId': 'm1', 'seq': 2, 'reason': 'completed',
        'sources': [{'title': '来源甲'}],
      });
      expect(t.items.whereType<AssistantMessage>().single.sources.single['title'], '来源甲');
    });
  });

  group('不上时间线的东西', () {
    test('★ 瞬态事件不许新增条目（决策 P-g：不占号 = 不上时间线）', () {
      final t = Timeline();
      t.apply({'type': 'message/start', 'messageId': 'm1', 'seq': 1});
      t.apply({'type': 'message/status', 'messageId': 'm1', 'state': 'working'}); // 没有 seq
      t.apply({'type': 'client/reload'}); // 控制帧
      expect(t.items.length, 1, reason: '瞬态只改状态，不新增');
      expect(t.items.whereType<AssistantMessage>().single.status, 'working');
    });

    test('★ 状态挂不上时不许凭空造一条消息', () {
      final t = Timeline();
      t.apply({'type': 'message/status', 'messageId': 'm_不存在', 'state': 'working'});
      expect(t.items, isEmpty);
    });

    test('不认识的类型安静忽略（向前兼容）', () {
      final t = Timeline();
      t.apply({'type': 'future/thing', 'seq': 1});
      expect(t.items, isEmpty);
    });

    test('没有 type 的也不炸', () {
      final t = Timeline();
      t.apply({'seq': 1});
      expect(t.items, isEmpty);
    });
  });

  group('补发标记', () {
    test('catchUp 帧带着标记进来（界面据此按"历史"渲染）', () {
      final t = Timeline();
      t.apply({'type': 'message/start', 'messageId': 'm1', 'seq': 1, 'catchUp': true});
      expect(t.items.whereType<AssistantMessage>().single.catchUp, true);
    });

    test('marker 是一条条目（它**要**占位置）', () {
      final t = Timeline();
      t.apply({'type': 'timeline/marker', 'kind': 'away', 'seq': 1});
      expect(t.items.whereType<TimelineMarker>().single.kind, 'away');
    });
  });

  group('重置', () {
    test('★ 服务端说"你的号跑到我前面了"⇒ 清服务端来的，但**保住用户自己的字**', () {
      final t = Timeline();
      t.apply({'type': 'message/start', 'messageId': 'm1', 'seq': 1});
      t.apply({'type': 'message/text', 'messageId': 'm1', 'seq': 2, 'block': 'quick', 'text': '服务端的'});
      t.addLocalUtterance('我打了一半的', 'u_local');
      t.setLocalState('u_local', MessageState.failed);

      t.reset();

      expect(t.items.whereType<AssistantMessage>(), isEmpty, reason: '服务端来的要清');
      final mine = t.items.whereType<UserUtterance>().toList();
      expect(mine.length, 1, reason: '★ 用户打好的字**只在本机有一份**，清掉就是弄丢了');
      expect(mine.single.text, '我打了一半的');
      expect(t.lastSeq, 0);
    });

    test('已确认的不留（服务端会重新补回来）', () {
      final t = Timeline();
      t.addLocalUtterance('说过了', 'u1');
      t.apply({'type': 'user/echo', 'messageId': 'u1', 'text': '说过了', 'seq': 1});
      t.reset();
      expect(t.items, isEmpty);
    });
  });
}
