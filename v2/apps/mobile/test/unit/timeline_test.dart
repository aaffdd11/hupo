// 可见时间线 —— 手册 `02-ARCHITECTURE.md` §5、`08-SPEC.md` §4。
//
// 排序键是 `(seq, tie)`，**不是时间戳**：
// 本地发言是客户端钟、服务端事件是服务端钟，混钟排序会乱，
// 而现网是刻意避免混钟的。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/message_state.dart';
import 'package:hupo_app/models/timeline.dart';

void main() {
  _busyGroup();
  _cacheGroup();
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
      t.apply({'type': 'message/status', 'turn': 1, 'state': 'started'}); // 没有 seq
      t.apply({'type': 'client/reload'}); // 控制帧
      expect(t.items.length, 1, reason: '瞬态只改状态，不新增');
    });

    test('★ 状态挂不上的时候不许凭空造一条消息', () {
      final t = Timeline();
      t.apply({'type': 'message/status', 'turn': 1, 'state': 'started'});
      expect(t.items, isEmpty, reason: '一行提示不是一条时间线条目');
    });

    test('★ 认不出来的状态 ⇒ **保持安静**（N10：沉默优于编造）', () {
      final t = Timeline();
      t.apply({'type': 'message/status', 'turn': 1, 'state': 'working'});
      expect(t.agentLine, isNull, reason: '不认识就当没收到 —— 绝不把内部词甩出去');
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

// ── S2：过程状态（「它正在做…」）─────────────────────────────
//
// 旧实现里这条链**从服务端就断了**：`message/status` 发的是 `messageId: ''`，
// 客户端按 id 找、恒 null ⇒ `message.status` 永远挂不上
// （`07-APPENDIX.md` §1.5）。根因不是"忘了填 id"，是**那个地址没有可能的值**：
// DSH 的 `session.status` 都落在消息生命周期之外。
// ⇒ 现在的地址是**轮**。

void _busyGroup() {
  group('它在做（S2）', () {
    test('★ 一轮开了、一个字都没说 ⇒ 界面上要有一行提示', () {
      final t = Timeline();
      expect(t.agentLine, isNull, reason: '还没开始，什么都不该显示');
      t.apply({'type': 'message/status', 'turn': 1, 'state': 'started'});
      expect(t.agentLine, isNotNull, reason: '★ 那段空白正是 8/10 放弃点所在');
      expect(t.items, isEmpty, reason: '它**不是**一条消息');
    });

    test('★ 说出第一句之后提示仍在（它还在做这一轮）', () {
      final t = Timeline();
      t.apply({'type': 'message/status', 'turn': 1, 'state': 'started'});
      t.apply({'type': 'message/start', 'messageId': 'm1', 'seq': 1});
      expect(t.agentLine, isNotNull);
    });

    test('★ 收口之后提示必须撤掉', () {
      final t = Timeline();
      t.apply({'type': 'message/status', 'turn': 1, 'state': 'started'});
      t.apply({'type': 'message/start', 'messageId': 'm1', 'seq': 1});
      t.apply({'type': 'message/end', 'messageId': 'm1', 'seq': 2, 'reason': 'completed'});
      expect(t.agentLine, isNull, reason: '这一轮说完了');
    });

    test('🔴 H4：它断了 ⇒ 提示必须撤掉（不许永久停在"正在做"）', () {
      // 手册 H4：过程可见性卡住时永久停在"在查资料"，**比空白更坏**。
      // 断了就一定有收尾（N19），所以这一行也一定撤得掉。
      final t = Timeline();
      t.apply({'type': 'message/status', 'turn': 1, 'state': 'started'});
      t.apply({'type': 'error', 'kind': 'agent-exit', 'text': '刚才我断了'});
      expect(t.agentLine, isNull);
    });

    test('🔴 H4 的第二条路：收尾的那条消息没到，但提示也不许留着', () {
      final t = Timeline();
      t.apply({'type': 'message/status', 'turn': 1, 'state': 'started'});
      t.apply({'type': 'message/start', 'messageId': 'm1', 'seq': 1});
      t.apply({'type': 'error', 'kind': 'agent-exit', 'text': '刚才我断了'});
      // 该气泡仍然开着（服务端会补一条收尾，落到盘上就会来）——
      // 但**这一行提示**不能自己一直亮着。
      expect(t.agentLine, isNull, reason: '断线那条 error 就是"别再显示了"');
    });

    test('★ 重连之后仍然推得出"它在做"（落盘的气泡还开着）', () {
      final t = Timeline();
      t.apply({'type': 'message/start', 'messageId': 'm1', 'seq': 1});
      t.apply({'type': 'message/text', 'messageId': 'm1', 'block': 'quick', 'text': '查着', 'seq': 2});
      // 瞬态丢了（P-g：不落盘、不补发）—— 但气泡还在 ⇒ 仍然知道它在做
      expect(t.agentLine, isNotNull, reason: '★ 不能只靠瞬态');
    });

    test('🔴 乱序保护：迟到的旧轮不许把提示点回来（手册 H4）', () {
      final t = Timeline();
      t.apply({'type': 'message/status', 'turn': 3, 'state': 'started'});
      t.apply({'type': 'message/start', 'messageId': 'm3', 'seq': 1});
      t.apply({'type': 'message/end', 'messageId': 'm3', 'seq': 2, 'reason': 'completed'});
      expect(t.agentLine, isNull);

      // 一条**迟到的**第 1 轮状态 —— 不许把「它正在做…」又点亮
      t.apply({'type': 'message/status', 'turn': 1, 'state': 'started'});
      expect(t.agentLine, isNull, reason: '★ 旧轮不许复活提示（那屏幕上就是假的）');

      // 新的一轮则要认
      t.apply({'type': 'message/status', 'turn': 4, 'state': 'started'});
      expect(t.agentLine, isNotNull);
    });

    test('重放（reset）要清掉瞬态（它不属于落盘的历史）', () {
      final t = Timeline();
      t.apply({'type': 'message/status', 'turn': 1, 'state': 'started'});
      expect(t.agentLine, isNotNull);
      t.reset();
      expect(t.agentLine, isNull, reason: '瞬态不落盘 ⇒ 重放时不该还亮着');
    });
  });
}

/// S5c：**从本机缓存先画出来的那一屏**，能说什么、不能说什么。
///
/// ⚠️ 这一组钉的是一次**差点写出来的假话**：缓存里最后一个事件可能是
///    `message/start`（那一轮还没收口）。照 `_hasOpenAssistant` 那条兜底，
///    屏幕上会立刻出现「它正在做…」——**可那一轮很可能是上次关机时断的**，
///    我们根本不知道它还活着没有。
///    ⇒ 服务端开口之前，一个字都不许说（N10：沉默优于编造）。
void _cacheGroup() {
  group('本机一屏（S5c）', () {
    Map<String, dynamic> start(int seq, String id) =>
        {'type': 'message/start', 'messageId': id, 'seq': seq};
    Map<String, dynamic> text(int seq, String id, String s) =>
        {'type': 'message/text', 'messageId': id, 'seq': seq, 'text': s};

    test('缓存先画出一屏：字在，但**不许**说"它正在做"', () {
      final t = Timeline();
      t.seedFromCache([start(1, 'm1'), text(2, 'm1', '上一条说到一半')]);
      expect(t.items, isNotEmpty, reason: 'S5c 的全部目的：冷启动不空屏');
      expect(t.agentLine, isNull, reason: '🔴 那一轮还活着没有，我们不知道');
      expect(t.isStale, true);
    });

    test('🔴 服务端一开口，"它正在做"才是真的', () {
      final t = Timeline();
      t.seedFromCache([start(1, 'm1')]);
      expect(t.agentLine, isNull);
      // 服务端来了一条真帧（补发的、或新的）
      t.markFresh();
      t.apply(text(2, 'm1', '接着'));
      expect(t.isStale, false);
      expect(t.agentLine, isNotNull);
    });

    test('服务端说"你这号不对了" ⇒ 连"缓存画的"这个身份也一起清掉', () {
      final t = Timeline();
      t.seedFromCache([start(1, 'm1')]);
      expect(t.isStale, true);
      t.reset();
      expect(t.isStale, false, reason: '服务端亲口说了话 ⇒ 不再是缓存猜的');
      expect(t.lastSeq, 0, reason: '号要重新从服务端要');
    });

    test('缓存里"已经收口"的那条：收口之后本来就不该有提示', () {
      final t = Timeline();
      t.seedFromCache([
        start(1, 'm1'),
        text(2, 'm1', '说完了'),
        {'type': 'message/end', 'messageId': 'm1', 'seq': 3},
      ]);
      expect(t.agentLine, isNull);
      t.markFresh();
      expect(t.agentLine, isNull, reason: '收口了就是收口了');
    });

    test('缓存画出来的条目和实时那条走**同一条渲染路径**（不是两套）', () {
      final cached = Timeline()..seedFromCache([start(1, 'm1'), text(2, 'm1', '一样')]);
      final live = Timeline()
        ..apply(start(1, 'm1'))
        ..apply(text(2, 'm1', '一样'));
      expect(cached.items.length, live.items.length);
      expect(cached.lastSeq, live.lastSeq);
      expect((cached.items.single as AssistantMessage).quick,
          (live.items.single as AssistantMessage).quick);
    });
  });
}
