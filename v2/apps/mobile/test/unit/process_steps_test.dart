// 步骤流水 + 推理原文（手册 **D7** / 契约 `docs/dev/26-PROCESS-LEVELS.md` §三）。
//
// ⚠️ 契约点名要的两条**都在这一份里**：
//   · **乱序保护**：迟到的旧轮步骤/状态不许把提示点回来（照 H4 那条既有规矩）；
//   · **超时收敛**：轮收口（`message/end` / 断了）⇒ 清掉该轮的过程，
//     不许留成"永远在查资料"。
//
// ⚠️ 还有一条属于 D7.4 / 契约 §二 的地基：**推理原文只在内存里**——
//    它不占号（`emitTransient`），所以 `TimelineStore.isPersistable` 天然不收它。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/process_words.dart';
import 'package:hupo_app/models/timeline.dart';
import 'package:hupo_app/services/timeline_store.dart';

/// 一轮开起来 + 走一步。
void _openTurn(Timeline t, int turn, {String state = 'searching'}) {
  t.apply({'type': 'message/status', 'turn': turn, 'state': 'started'});
  t.apply({'type': 'step/start', 'turn': turn, 'step': 1, 'state': state});
}

/// 全局递增的号：`message/*` 要带号（服务端事实），而每条测试各有一个 Timeline。
int _seq = 0;

/// 开一轮 **并且开出一条气泡** —— 推理原文挂在气泡上，所以要有一条。
void _openTurnWithBubble(Timeline t, int turn) {
  t.apply({'type': 'message/status', 'turn': turn, 'state': 'started'});
  t.apply({'type': 'message/start', 'messageId': 'm$turn', 'seq': ++_seq});
}

/// 屏幕上那一条回答的思考原文（它挂在气泡上）。
String _reasoning(Timeline t) {
  final msgs = t.items.whereType<AssistantMessage>().toList();
  return msgs.isEmpty ? '' : msgs.last.reasoning;
}

void main() {
  group('步骤流水（第 ③ 档）', () {
    test('★ 一步进来就有一条，状态名要经人话表翻', () {
      final t = Timeline();
      t.apply({'type': 'step/start', 'turn': 1, 'step': 1, 'state': 'searching'});
      final s = t.steps.single;
      expect(s.turn, 1);
      expect(s.step, 1);
      expect(processWord(s.state), '在查资料');
    });

    test('★ 按 `step` 号排：先到 2 后到 1，屏幕上仍是 1 在前', () {
      final t = Timeline();
      t.apply({'type': 'step/start', 'turn': 1, 'step': 2, 'state': 'writing'});
      t.apply({'type': 'step/start', 'turn': 1, 'step': 1, 'state': 'searching'});
      expect(t.steps.map((s) => s.step).toList(), [1, 2]);
    });

    test('同一个 `(turn, step)` 重复到达 ⇒ 覆盖，不是再画一条', () {
      final t = Timeline();
      t.apply({'type': 'step/start', 'turn': 1, 'step': 1, 'state': 'searching'});
      t.apply({'type': 'step/start', 'turn': 1, 'step': 1, 'state': 'reading'});
      expect(t.steps.length, 1);
      expect(t.steps.single.state, 'reading');
    });

    test('`step/end` 只标完成（不新增、也不删）', () {
      final t = Timeline();
      _openTurn(t, 1);
      t.apply({'type': 'step/end', 'turn': 1, 'step': 1, 'reason': 'completed'});
      expect(t.steps.single.done, isTrue);
    });

    test('没见过的 `step/end` ⇒ 什么都不发生（不许凭空冒出一行）', () {
      final t = Timeline();
      t.apply({'type': 'step/end', 'turn': 1, 'step': 9});
      expect(t.steps, isEmpty);
    });

    test('🔴 认不出来的状态名 ⇒ **一行都不加**（N10：沉默优于编造）', () {
      final t = Timeline();
      t.apply({'type': 'step/start', 'turn': 1, 'step': 1, 'state': 'internal_tool_name'});
      expect(t.steps, isEmpty);
    });

    test('缺 `turn` / `step` 的畸形帧 ⇒ 忽略，不抛', () {
      final t = Timeline();
      t.apply({'type': 'step/start', 'step': 1, 'state': 'searching'});
      t.apply({'type': 'step/start', 'turn': 1, 'state': 'searching'});
      t.apply({'type': 'step/start', 'turn': '1', 'step': '1', 'state': 'searching'});
      expect(t.steps, isEmpty);
    });
  });

  group('推理原文（第 ④ 档）', () {
    test('★ 一段段拼起来，挂在**它那条气泡**上', () {
      final t = Timeline();
      _openTurnWithBubble(t, 1);
      t.apply({'type': 'reasoning/delta', 'turn': 1, 'text': '先看'});
      t.apply({'type': 'reasoning/delta', 'turn': 1, 'text': '一眼'});
      expect(_reasoning(t), '先看一眼');
    });

    test('★ 推理**先于正文**到 ⇒ 先存着，气泡一开就挂上去（服务端就是这个顺序）', () {
      // `assistant/message` 的 content 里 reasoning 段在 text 段前面 ⇒
      // 服务端先发 `reasoning/delta`、后发 `message/start`。
      final t = Timeline();
      t.apply({'type': 'reasoning/delta', 'turn': 1, 'text': '还没开口就在想'});
      t.apply({'type': 'message/start', 'messageId': 'm1', 'seq': ++_seq});
      expect(_reasoning(t), '还没开口就在想');
    });

    test('🔴 只在内存里：没有号 ⇒ 缓存那条路（只收带号的）碰不到它', () {
      // 契约 §二：它可能含我们这边的原话（产品资产），落了盘就被 replay 给所有人。
      // ⚠️ 这里用**真正那条判据**（`TimelineStore.isPersistable`），不是另写一句。
      expect(TimelineStore.isPersistable({'type': 'reasoning/delta', 'turn': 1, 'text': 'x'}), isFalse);
      expect(TimelineStore.isPersistable({'type': 'step/start', 'turn': 1, 'step': 1}), isFalse);
      expect(TimelineStore.isPersistable({'type': 'message/text', 'seq': 3}), isTrue);
    });

    test('🔴 重放拿不到它：缓存里那些帧喂回来，气泡上一个字都没有', () {
      final t = Timeline();
      // 缓存里只可能有带号的事实；就算有人硬塞一条推理进来，它没有号 ⇒ 当瞬态
      t.seedFromCache([
        {'type': 'message/start', 'messageId': 'm1', 'seq': 1},
        {'type': 'message/text', 'messageId': 'm1', 'block': 'quick', 'text': '晴天', 'seq': 2},
        {'type': 'message/end', 'messageId': 'm1', 'seq': 3, 'reason': 'completed'},
      ]);
      expect(_reasoning(t), isEmpty);
      expect(t.items.whereType<AssistantMessage>().single.reasoning, isEmpty);
    });

    test('畸形帧 ⇒ 忽略', () {
      final t = Timeline();
      _openTurnWithBubble(t, 1);
      t.apply({'type': 'reasoning/delta', 'text': '没有轮'});
      t.apply({'type': 'reasoning/delta', 'turn': 1});
      t.apply({'type': 'reasoning/delta', 'turn': 1, 'text': ''});
      expect(_reasoning(t), isEmpty);
    });
  });

  group('🔴 乱序保护（迟到的旧轮不许把提示点回来 —— H4）', () {
    test('旧轮的步骤晚到 ⇒ 丢掉，屏幕上多不出一行', () {
      final t = Timeline();
      _openTurn(t, 3);
      t.apply({'type': 'step/start', 'turn': 2, 'step': 7, 'state': 'searching'});
      expect(t.steps.map((s) => s.step).toList(), [1], reason: '第 2 轮的步骤混进来了');
    });

    test('旧轮的推理晚到 ⇒ 丢掉，不许掺进这一轮的思考里', () {
      final t = Timeline();
      _openTurnWithBubble(t, 3);
      t.apply({'type': 'reasoning/delta', 'turn': 3, 'text': '这一轮的'});
      t.apply({'type': 'reasoning/delta', 'turn': 2, 'text': '上一轮的'});
      expect(_reasoning(t), '这一轮的');
    });

    test('🔴 收口之后又飘回来的步骤 ⇒ 丢掉（这是"永久停在正在做"的根）', () {
      final t = Timeline();
      _openTurn(t, 1);
      t.apply({'type': 'message/start', 'messageId': 'm1', 'seq': ++_seq});
      t.apply({'type': 'message/end', 'messageId': 'm1', 'seq': ++_seq, 'reason': 'completed'});
      expect(t.steps, isEmpty);

      // 迟到的第 1 轮步骤
      t.apply({'type': 'step/start', 'turn': 1, 'step': 2, 'state': 'writing'});
      t.apply({'type': 'step/end', 'turn': 1, 'step': 2});
      // 迟到的第 1 轮状态
      t.apply({'type': 'message/status', 'turn': 1, 'state': 'started'});

      expect(t.steps, isEmpty, reason: '收口那一轮又回来了');
      expect(t.agentLine, isNull, reason: '迟到的旧轮不许把提示点回来');
    });

    test('收口之后**新的一轮**照常进来（别把闸关死）', () {
      final t = Timeline();
      _openTurn(t, 1);
      t.apply({'type': 'message/end', 'messageId': 'm1', 'seq': ++_seq, 'reason': 'completed'});
      _openTurn(t, 2, state: 'writing');
      expect(t.steps.single.turn, 2);
      expect(t.agentLine, isNotNull);
    });
  });

  group('🔴 超时收敛：轮收口 ⇒ **步骤**清掉（推理原文留着）', () {
    test('`message/end` ⇒ 步骤清、提示撤，但推理**还在那条气泡上**', () {
      final t = Timeline();
      _openTurnWithBubble(t, 1);
      t.apply({'type': 'step/start', 'turn': 1, 'step': 1, 'state': 'searching'});
      t.apply({'type': 'reasoning/delta', 'turn': 1, 'text': '想一想'});
      expect(t.steps, isNotEmpty);
      expect(_reasoning(t), isNotEmpty);

      t.apply({'type': 'message/end', 'messageId': 'm1', 'seq': ++_seq, 'reason': 'timeout'});
      expect(t.steps, isEmpty, reason: '步骤是过程噪音 ⇒ 收口必须清（不许留成"永远在查资料"）');
      expect(t.agentLine, isNull);
      // ★ 推理是**内容**，不是过程噪音：一出答案就删，第 ④ 档就只剩"盯着看"了
      expect(_reasoning(t), '想一想', reason: '主人回头还要看它当时怎么想的');
    });

    test('收口那条消息**根本不存在**也照样清步骤（end 先到 / 配对不上）', () {
      final t = Timeline();
      _openTurn(t, 1);
      t.apply({'type': 'message/end', 'messageId': 'm_不存在', 'seq': ++_seq, 'reason': 'completed'});
      expect(t.steps, isEmpty);
      expect(t.agentLine, isNull);
    });

    test('它断了（`error`）⇒ 步骤清、提示撤，推理留着（气泡还开着）', () {
      final t = Timeline();
      _openTurnWithBubble(t, 1);
      t.apply({'type': 'reasoning/delta', 'turn': 1, 'text': '想一想'});
      t.apply({'type': 'error', 'kind': 'agent-exit', 'text': '刚才我断了'});
      expect(t.steps, isEmpty);
      expect(t.agentLine, isNull);
      expect(_reasoning(t), '想一想');
    });

    test('新的一轮开了 ⇒ 上一轮的**步骤**不作数；**上一轮气泡上的推理留着**', () {
      final t = Timeline();
      _openTurnWithBubble(t, 1);
      t.apply({'type': 'step/start', 'turn': 1, 'step': 1, 'state': 'searching'});
      t.apply({'type': 'reasoning/delta', 'turn': 1, 'text': '第一轮的思考'});
      t.apply({'type': 'message/status', 'turn': 2, 'state': 'started'});
      expect(t.steps, isEmpty, reason: '步骤属于"现在这一轮"');
      expect(_reasoning(t), '第一轮的思考', reason: '推理挂在第 1 轮那条气泡上，跟着它走');
    });

    test('🔴 reset（重放 / 退出登录）⇒ 推理**一个字节都不剩**', () {
      final t = Timeline();
      _openTurnWithBubble(t, 5);
      t.apply({'type': 'reasoning/delta', 'turn': 5, 'text': '旧世界的思考'});
      expect(_reasoning(t), isNotEmpty);

      t.reset();
      expect(t.steps, isEmpty);
      // 挂在气泡上的那一段：气泡本身被清掉了（只留用户自己没确认的话）⇒ 没地方可留
      expect(t.items.whereType<AssistantMessage>(), isEmpty);
      expect(_reasoning(t), isEmpty);
      // 号从头来 ⇒ 新的第 1 轮认得出（不会被当成"迟到的旧轮"丢掉）
      _openTurn(t, 1);
      expect(t.steps.single.turn, 1);
    });

    test('🔴 reset 也要清掉**还没挂上去**的那一段（否则它会粘到下一轮的气泡上）', () {
      final t = Timeline();
      // 推理先到、气泡还没开 ⇒ 存在"待挂"里
      t.apply({'type': 'reasoning/delta', 'turn': 5, 'text': '不该留下的'});
      t.reset();
      // reset 之后新的一轮开气泡 —— 上一段绝不许粘上来
      _openTurnWithBubble(t, 1);
      expect(_reasoning(t), isEmpty);
    });
  });
}
