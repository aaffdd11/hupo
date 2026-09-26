// `116`（主人 2026-09-26：*"首先全部开放"*）**客户端这一半的接线**：
// 服务端那四条持久事件（`tool/call` · `tool/result` · `system/prompt` · `turn/usage`）
// 怎么进同一条日志、怎么被认领、控制器怎么把它们折出来。
//
// ⚠️ 这一份钉的是**接线**（`models/timeline.dart` + `services/chat_controller.dart`）：
//   · 认不出来的 payload ⇒ **什么都不加**（不是"加一条空的"，更不是抛）；
//   · `tool/result` 是**就地认领**（不是再插一行）—— 行**不许移动**；
//   · 结果先到（翻页/缓存裁剪把它和调用隔开）⇒ 先存着，调用到了再配；
//   · `reset()` 之后**一条都不剩**（含还没配上的那几条结果）。
//
// 纯逻辑逐字钉的在那两份里：`tool_row_test.dart`（`ToolRow`/`foldTurnUsage` 本身）
// 与 `tool_row_words_test.dart`（文案/分组）。

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/message_state.dart';
import 'package:hupo_app/models/timeline.dart';
import 'package:hupo_app/models/tool_row.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

Map<String, Object?> toolCall({
  int seq = 1,
  Object? turn = 1,
  Object? step = 1,
  Object? callId = 'c1',
  Object? name = 'bash',
  Object? title = '跑测试',
  Object? args = '{"command":"ls"}',
}) => {
  'type': 'tool/call',
  'seq': seq,
  'turn': turn,
  'step': step,
  'callId': callId,
  'name': name,
  'title': title,
  'args': args,
};

Map<String, Object?> toolResult({
  int seq = 2,
  Object? turn = 1,
  Object? step = 1,
  Object? callId = 'c1',
  Object? ok = true,
  Object? error,
  Object? excerpt = 'ok',
  Object? bytes = 12,
  Object? truncated = false,
}) => {
  'type': 'tool/result',
  'seq': seq,
  'turn': turn,
  'step': step,
  'callId': callId,
  'ok': ok,
  'error': error,
  'excerpt': excerpt,
  'bytes': bytes,
  'truncated': truncated,
};

Map<String, Object?> systemPrompt({
  int seq = 3,
  Object? turn = 1,
  Object? step = 1,
  Object? text = '你是琥珀。\n第二行。',
  Object? bytes = 40,
  Object? truncated = false,
}) => {
  'type': 'system/prompt',
  'seq': seq,
  'turn': turn,
  'step': step,
  'text': text,
  'bytes': bytes,
  'truncated': truncated,
};

Map<String, Object?> turnUsage({
  int seq = 4,
  Object? turn = 1,
  Object? usage = const {'input': 10, 'output': 4},
  Object? complete = true,
}) => {'type': 'turn/usage', 'seq': seq, 'turn': turn, 'usage': usage, 'complete': complete};

ChatController controller() {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  return ChatController(
    api: Api(base: 'http://127.0.0.1:1', client: MockClient((_) async => http.Response('{}', 200))),
    tokens: TokenStore(),
  );
}

void main() {
  group('tool/call + tool/result 进同一条日志', () {
    test('★ 只有调用 ⇒ 一行 running；号进了游标', () {
      final t = Timeline();
      t.apply(toolCall(seq: 7));
      final rows = t.items.whereType<TimelineToolCall>().toList();
      expect(rows, hasLength(1));
      expect(rows.single.row.status, ToolStatus.running);
      expect(rows.single.row.name, 'bash');
      expect(rows.single.turn, 1);
      expect(t.lastSeq, 7);
      expect(t.oldestSeq, 7);
    });

    test('🔴 结果回来是**就地认领**：不多一行、位置还是调用那一个号', () {
      final t = Timeline();
      t.apply({'type': 'user/echo', 'seq': 1, 'messageId': 'u1', 'text': '你好'});
      t.apply(toolCall(seq: 2));
      t.apply(toolResult(seq: 3, excerpt: '三个文件', bytes: 4096, truncated: true));
      final rows = t.items.whereType<TimelineToolCall>().toList();
      expect(rows, hasLength(1), reason: '结果那一半**不许**再插一行');
      expect(rows.single.seq, 2, reason: '行的位置还是调用那一个号（一条日志的排序不许被结果改动）');
      expect(rows.single.row.status, ToolStatus.ok);
      expect(rows.single.row.excerpt, '三个文件');
      expect(rows.single.row.bytes, 4096);
      expect(rows.single.row.truncated, isTrue);
    });

    test('★ 认不出的结果（`ok` 坏了）⇒ 行**待在"在跑"**（不猜成败）', () {
      final t = Timeline();
      t.apply(toolCall(seq: 2));
      t.apply(toolResult(seq: 3, ok: 'yes'));
      final rows = t.items.whereType<TimelineToolCall>().toList();
      expect(rows, hasLength(1));
      expect(rows.single.row.status, ToolStatus.running);
    });

    test('🔴 结果先到、调用后到（翻页 / 缓存裁剪把它俩隔开）⇒ 先画结果那一行，配上了再合成一行', () {
      final t = Timeline();
      t.apply(toolResult(seq: 3, excerpt: '先到的结果', bytes: 9));
      // 合同 `116` §一 规矩 4：**配不上就只画结果那一行**（名字那一格空着 —— 不猜）
      var rows = t.items.whereType<TimelineToolCall>().toList();
      expect(rows, hasLength(1), reason: '结果是真的发生过的 ⇒ 不许看不见');
      expect(rows.single.row.name, isEmpty, reason: '不知道是哪个工具 ⇒ 名字空着，不编一个');
      expect(rows.single.row.excerpt, '先到的结果');
      expect(rows.single.turn, 1, reason: '结果那一半自带 turn ⇒ 折叠还数得到它');
      t.apply(toolCall(seq: 2));
      rows = t.items.whereType<TimelineToolCall>().toList();
      expect(rows, hasLength(1), reason: '配上之后那两半是**一行**（不是两行）');
      expect(rows.single.row.name, 'bash');
      expect(rows.single.row.status, ToolStatus.ok, reason: '配不上就会**永远停在"在跑"** —— 那是假话');
      expect(rows.single.row.excerpt, '先到的结果');
      expect(rows.single.seq, 2, reason: '位置按**调用**那一个号（结果那一行的位置排晚了）');
    });

    test('负向对照：结果那一行**认不出来**时不许凭空画出来', () {
      final t = Timeline();
      // `ok` 坏了 ⇒ `parseResultOnly` 返回 null ⇒ 一条都不加
      t.apply(toolResult(seq: 3, callId: '孤儿', ok: 'yes'));
      expect(t.items, isEmpty);
    });

    test('同一个号重放两遍 ⇒ 只认一遍（协议 R5）', () {
      final t = Timeline();
      t.apply(toolCall(seq: 2));
      t.apply(toolCall(seq: 2));
      t.apply(toolResult(seq: 3));
      t.apply(toolResult(seq: 3));
      expect(t.items.whereType<TimelineToolCall>(), hasLength(1));
    });

    test('🔴 坏 payload / 未知类型：**一条都不加、也绝不抛**', () {
      final t = Timeline();
      final garbage = <Map<String, dynamic>>[
        {'type': 'tool/call', 'seq': 1},
        {'type': 'tool/call', 'seq': 2, 'turn': 1, 'step': 1, 'callId': '', 'name': 'bash'},
        {'type': 'tool/call', 'seq': 3, 'turn': -1, 'step': 1, 'callId': 'c', 'name': 'bash'},
        {'type': 'tool/result', 'seq': 4},
        {'type': 'system/prompt', 'seq': 5, 'turn': 1, 'step': 1, 'bytes': 0},
        {'type': 'turn/usage', 'seq': 6, 'turn': 1, 'complete': 'yes'},
        {'type': 'who/knows', 'seq': 7, 'payload': 1},
      ];
      for (final e in garbage) {
        expect(() => t.apply(e), returnsNormally, reason: '抛了：$e');
      }
      expect(t.items, isEmpty, reason: '坏数据 / 未知类型只许"这一行不画"');
    });

    test('🔴 瞬态（**没有号**）不许新增条目 —— 哪怕类型认得出来', () {
      // 决策 P-g：不占号 = 不上时间线。今天服务端这四条都带号；将来谁把它们
      // 改成瞬态（或者坏帧漏了 seq），这一层也得**只改状态、绝不新增**。
      final t = Timeline();
      for (final e in [
        {'type': 'tool/call', 'turn': 1, 'step': 1, 'callId': 'c', 'name': 'bash'},
        {'type': 'tool/result', 'turn': 1, 'step': 1, 'callId': 'c', 'ok': true, 'bytes': 1},
        {'type': 'system/prompt', 'turn': 1, 'step': 1, 'text': 'x', 'bytes': 1},
        {'type': 'turn/usage', 'turn': 1, 'usage': const {'input': 1, 'output': 1}, 'complete': true},
      ]) {
        expect(() => t.apply(e), returnsNormally, reason: '抛了：$e');
      }
      expect(t.items, isEmpty);
      expect(t.lastSeq, 0, reason: '没有号 ⇒ 游标一个都不许动');
    });
  });

  group('system/prompt', () {
    test('★ 非空 ⇒ 一行，原文逐字（含换行）、截断标志原样', () {
      final t = Timeline();
      t.apply(systemPrompt(seq: 5, truncated: true, bytes: 4000));
      final rows = t.items.whereType<TimelineSystemPrompt>().toList();
      expect(rows, hasLength(1));
      expect(rows.single.row.text, '你是琥珀。\n第二行。');
      expect(rows.single.row.truncated, isTrue);
      expect(rows.single.row.bytes, 4000);
      expect(rows.single.turn, 1);
    });

    test('★ 空串**不占一行**（DSH：非空才有一行）', () {
      final t = Timeline();
      t.apply(systemPrompt(seq: 5, text: ''));
      expect(t.items, isEmpty);
    });
  });

  group('turn/usage', () {
    test('★ 一条 ⇒ 进日志（取号、落盘），折出来就是那个数', () {
      final t = Timeline();
      t.apply(turnUsage(seq: 5, usage: const {'input': 10, 'output': 4}));
      final rows = t.items.whereType<TimelineTurnUsage>().toList();
      expect(rows, hasLength(1));
      expect(rows.single.turn, 1);
    });

    test('★ `usage:null, complete:false`（"这一轮没报用量"）也进日志，但折出来是 null', () {
      final t = Timeline();
      t.apply(turnUsage(seq: 5, usage: null, complete: false));
      final rows = t.items.whereType<TimelineTurnUsage>().toList();
      expect(rows, hasLength(1), reason: '它是合法的一条"没报" ⇒ 要取号（不然游标停在这儿）');
      expect(foldTurnUsage(rows.map((e) => e.attempt)), isNull, reason: '折不出来 ⇒ 一行都不画');
    });
  });

  group('ToolRow.parseResultOnly（配不上的结果那一行）', () {
    test('★ 认得出 ⇒ 名字空着（不猜）、状态/摘要/截断原样', () {
      final r = ToolRow.parseResultOnly(toolResult(excerpt: 'a\nb', bytes: 7, truncated: true));
      expect(r, isNotNull);
      expect(r!.name, isEmpty, reason: '不知道是哪个工具 ⇒ 名字那一格空着');
      expect(r.callId, 'c1');
      expect(r.status, ToolStatus.ok);
      expect(r.excerpt, 'a\nb');
      expect(r.bytes, 7);
      expect(r.truncated, isTrue);
      expect(r.turn, 1);
    });

    test('★ `ok:false` 也认（打断与"没成"照旧分开）', () {
      expect(ToolRow.parseResultOnly(toolResult(ok: false, error: 'boom'))!.status, ToolStatus.error);
      expect(
        ToolRow.parseResultOnly(toolResult(ok: false, error: 'interrupted'))!.status,
        ToolStatus.interrupted,
      );
    });

    test('🔴 认不出来 ⇒ null（**绝不抛**；与 `ToolRow.parse` 的结果那一半同一条规矩）', () {
      final bad = <Object?>[
        null,
        'tool/result',
        <String, Object?>{},
        toolResult(callId: ''),
        toolResult(turn: -1),
        toolResult(step: null),
        toolResult(ok: null),
        toolResult(ok: 1),
        toolResult(bytes: -1),
        toolResult(bytes: '12'),
      ];
      for (final b in bad) {
        expect(() => ToolRow.parseResultOnly(b), returnsNormally, reason: '抛了：$b');
        expect(ToolRow.parseResultOnly(b), isNull, reason: '该认不出来：$b');
      }
    });
  });

  group('reset()：三条新条目 + 还没配上的结果，一条都不剩', () {
    test('🔴 清得干净，而且本地没发出去的那句还在（老规矩）', () {
      final t = Timeline();
      t.apply({'type': 'user/echo', 'seq': 1, 'messageId': 'u1', 'text': '你好'});
      t.apply(toolCall(seq: 2));
      t.apply(systemPrompt(seq: 3));
      t.apply(turnUsage(seq: 4));
      t.apply(toolResult(seq: 5, callId: '孤儿')); // 进"还没配上"那一份
      t.addLocalUtterance('还没发出去', 'u_local');
      t.reset();
      expect(t.items.whereType<TimelineToolCall>(), isEmpty);
      expect(t.items.whereType<TimelineSystemPrompt>(), isEmpty);
      expect(t.items.whereType<TimelineTurnUsage>(), isEmpty);
      expect(t.lastSeq, 0);
      // ⚠️ 老规矩不许被这一批破坏：本地未确认的那句**必须留下**（清掉 = 丢用户打的字）。
      expect(t.items.whereType<UserUtterance>().single.text, '还没发出去');
      // 复位之后再配一次：那一份"还没配上的"已经清了 ⇒ 孤儿结果不再冒出来
      t.apply(toolCall(seq: 6, callId: '孤儿2'));
      expect(t.items.whereType<TimelineToolCall>().single.row.status, ToolStatus.running);
    });
  });

  group('控制器那三个查询', () {
    test('★ `closedThrough`：轮收口之后才认（工具行折起来看它）', () {
      final c = controller();
      c.ingest({'type': 'message/status', 'turn': 1, 'state': 'started'});
      c.ingest(toolCall(seq: 1));
      expect(c.closedThrough, 0, reason: '还在跑 ⇒ 不折');
      c.ingest({'type': 'message/start', 'seq': 2, 'messageId': 'm1'});
      c.ingest({'type': 'message/end', 'seq': 3, 'messageId': 'm1', 'reason': 'completed'});
      expect(c.closedThrough, 1);
    });

    test('★ `processOfTurn`：工具 / subagent 互斥，控制类两个桶都不进', () {
      final c = controller();
      c.ingest(toolCall(seq: 1, callId: 'a', name: 'bash'));
      c.ingest(toolCall(seq: 2, callId: 'b', name: 'subagent_fork'));
      c.ingest(toolCall(seq: 3, callId: 'c', name: 'send_message'));
      final p = c.processOfTurn(1);
      expect(p.toolCalls, 1);
      expect(p.subagents, 1);
      expect(p.messages, 0, reason: '客户端算不出消息数（message/* 不带 turn/step）⇒ 宁可为 0');
      // 别的轮不算进来
      c.ingest(toolCall(seq: 4, callId: 'd', name: 'read', turn: 2));
      expect(c.processOfTurn(1).toolCalls, 1);
      expect(c.processOfTurn(2).toolCalls, 1);
    });

    test('★ `turnUsage`：结清了才有数；后一条没报准 ⇒ 整块 null', () {
      final c = controller();
      c.ingest(turnUsage(seq: 1, usage: const {'input': 10, 'output': 4}, complete: true));
      final u = c.turnUsage(1);
      expect(u, isNotNull);
      expect(u!.input, 10);
      expect(u.output, 4);
      c.ingest(turnUsage(seq: 2, usage: null, complete: false));
      expect(c.turnUsage(1), isNull, reason: '有一次没报准 ⇒ 整块不画（不许拿报了的凑）');
    });

    test('别的轮的用量不会串进来', () {
      final c = controller();
      c.ingest(turnUsage(seq: 1, turn: 1, usage: const {'input': 1, 'output': 1}));
      expect(c.turnUsage(2), isNull);
    });
  });

  group('折叠不影响"哪几条能删"', () {
    test('★ 三条新条目不属于任何一轮（删除那条路碰不到它们）', () {
      final items = <TimelineItem>[
        UserUtterance(messageId: 'u1', text: '你好', seq: 1, state: MessageState.confirmed),
        AssistantMessage(messageId: 'm1', seq: 2),
        TimelineToolCall(row: ToolRow.parse(toolCall(), null)!, seq: 3),
        TimelineSystemPrompt(
          row: SystemPromptRow.parse(systemPrompt())!,
          seq: 4,
        ),
        TimelineTurnUsage(
          attempt: TurnUsageAttempt.parse(turnUsage())!,
          seq: 5,
        ),
      ];
      final groups = turnGroupsOf(items);
      expect(groups, hasLength(1), reason: '只有那一问一答算一轮');
      expect(groups.single.messageIds, ['u1', 'm1']);
    });
  });
}
