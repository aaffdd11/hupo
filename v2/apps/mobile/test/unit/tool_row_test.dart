// 工具行 + 一轮折叠（`lib/models/tool_row.dart` · 研究 `docs/dev/115-DSH-WINDOW-PARITY.md`
// 丙-1/丙-2/丙-3 · DSH 原文 `docs/dev/115-raw/B-render.md` §2.3/§2.7）。
//
// ⚠️ 这一份的每一条**都有反例**：
//   · 认不出来的 payload ⇒ `null`（不是"猜一个"）；
//   · 工具与 subagent **互斥**（同一次调用只进一个桶）；
//   · 一次尝试没报用量 ⇒ **整块不显示**（不是"拿报了的凑个和"）；
//   · 推理 > 输出 ⇒ `null`（账本身矛盾）；
//   · `truncated` **原样保留**（截了不说 = 页面在说假话）。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/tool_row.dart';

/// 一条 `tool/call`（服务端将来的样子）。
Map<String, Object?> call({
  String type = 'tool/call',
  Object? turn = 1,
  Object? step = 1,
  Object? callId = 'c1',
  Object? name = 'bash',
  Object? title = '跑一下测试',
  Object? args = '{"cmd":"ls"}',
}) =>
    {
      'type': type,
      'turn': turn,
      'step': step,
      'callId': callId,
      'name': name,
      'title': title,
      'args': args,
      'at': 1758700000000,
    };

/// 一条 `tool/result`。
Map<String, Object?> result({
  String type = 'tool/result',
  int turn = 1,
  int step = 1,
  Object? callId = 'c1',
  Object? ok = true,
  Object? error,
  Object? excerpt = 'ok',
  Object? bytes = 12,
  Object? truncated = false,
}) =>
    {
      'type': type,
      'turn': turn,
      'step': step,
      'callId': callId,
      'ok': ok,
      'error': error,
      'excerpt': excerpt,
      'bytes': bytes,
      'truncated': truncated,
      'at': 1758700000001,
    };

/// 一行"跑着的"工具调用（少写点字）。
ToolRow row(String name, {int turn = 1}) =>
    ToolRow.parse(call(name: name, callId: 'c_$name$turn', turn: turn), null)!;

void main() {
  group('ToolRow.parse', () {
    test('★ 只有 call（还在跑）⇒ running，bytes 0、truncated false', () {
      final r = ToolRow.parse(call(), null);
      expect(r, isNotNull);
      expect(r!.callId, 'c1');
      expect(r.name, 'bash');
      expect(r.title, '跑一下测试');
      expect(r.args, '{"cmd":"ls"}');
      expect(r.status, ToolStatus.running);
      expect(r.excerpt, isNull);
      expect(r.bytes, 0, reason: '还没结果 ⇒ 是"还没报"，不是"零字节"');
      expect(r.truncated, isFalse);
      expect(r.turn, 1);
      expect(r.step, 1);
    });

    test('★ 有结果且成 ⇒ ok，摘要 / 字节原样带出来', () {
      final r = ToolRow.parse(call(), result(excerpt: '3 个文件', bytes: 4096));
      expect(r!.status, ToolStatus.ok);
      expect(r.excerpt, '3 个文件');
      expect(r.bytes, 4096);
    });

    test('★ 有结果且败 ⇒ error（error 那行字保留）', () {
      final r = ToolRow.parse(call(), result(ok: false, error: 'boom', excerpt: null));
      expect(r!.status, ToolStatus.error);
      expect(r.excerpt, isNull);
    });

    test('★ 被打断与"没做成"**分开**（error 里那几个词）', () {
      for (final code in ['interrupted', 'aborted', 'cancelled', 'canceled']) {
        final r = ToolRow.parse(call(), result(ok: false, error: code));
        expect(r!.status, ToolStatus.interrupted, reason: '「$code」该算被打断');
      }
      // 大小写不敏感（服务端写出 "Interrupted" 也不该变成"坏了"）。
      expect(
        ToolRow.parse(call(), result(ok: false, error: 'Interrupted'))!.status,
        ToolStatus.interrupted,
      );
    });

    test('负向对照：认不出的错词**不许**被当成"被打断"', () {
      // 认不出 ⇒ error（fail-closed：不许把真失败说轻）。
      for (final code in ['abort', 'timeout', 'ENOENT', 'stop']) {
        final r = ToolRow.parse(call(), result(ok: false, error: code));
        expect(r!.status, ToolStatus.error, reason: '「$code」不该算被打断');
      }
      // 连 error 都没有 ⇒ error，也不是 interrupted。
      expect(ToolRow.parse(call(), result(ok: false, error: null))!.status, ToolStatus.error);
    });

    test('🔴 坏 payload ⇒ null（**绝不抛**）', () {
      final garbage = <Object?>[
        null,
        0,
        1.5,
        'tool/call',
        true,
        <Object?>[],
        <String, Object?>{},
        <String, Object?>{'type': 'tool/call'}, // 缺 callId / name / turn / step
        call(type: 'tool/result'),
        call(callId: ''), // 空身份
        call(callId: 42),
        call(name: ''),
        call(name: 7),
        call(turn: -1),
        call(turn: '1'),
        call(step: -2),
        call(step: null),
      ];
      for (final bad in garbage) {
        expect(() => ToolRow.parse(bad, null), returnsNormally, reason: '抛了：$bad');
        expect(ToolRow.parse(bad, null), isNull, reason: '该认不出来：$bad');
      }
    });

    test('🔴 结果那一半坏了也 ⇒ null（成败不许猜）', () {
      expect(ToolRow.parse(call(), result(type: 'nope')), isNull);
      expect(ToolRow.parse(call(), result(callId: 'c2')), isNull, reason: 'callId 对不上');
      expect(ToolRow.parse(call(), result(callId: null)), isNull);
      expect(ToolRow.parse(call(), result(ok: null)), isNull, reason: '没有 ok 就没有成败');
      expect(ToolRow.parse(call(), result(ok: 'yes')), isNull);
      expect(ToolRow.parse(call(), result(bytes: -1)), isNull);
      expect(ToolRow.parse(call(), result(bytes: '12')), isNull);
      expect(ToolRow.parse(call(), result(bytes: null)), isNull);
      expect(ToolRow.parse(call(), 'not a map'), isNull);
    });

    test('可选字段坏了**不算坏**（只影响那一行好不好看）', () {
      final r = ToolRow.parse(call(title: 42, args: []), result(excerpt: 9, truncated: 'yes'));
      expect(r, isNotNull);
      expect(r!.title, isNull);
      expect(r.args, isNull);
      expect(r.excerpt, isNull);
      expect(r.truncated, isFalse, reason: '不是 bool 就当没截断（但不许抛）');
    });

    test('🔴 `truncated` 原样保留（截了不说 = 页面在说假话）', () {
      expect(ToolRow.parse(call(), result(truncated: true))!.truncated, isTrue);
      expect(ToolRow.parse(call(), result(truncated: false))!.truncated, isFalse);
      // 还在跑的那一行没有"截断"这回事。
      expect(ToolRow.parse(call(), null)!.truncated, isFalse);
    });

    test('★ ok 为真时，error 有字也不改成败', () {
      final r = ToolRow.parse(call(), result(ok: true, error: 'warning'));
      expect(r!.status, ToolStatus.ok);
    });

    // ★ 批 5（契约 `docs/dev/120-FILE-PANEL.md`）：入参那两格原样收下。
    //   ⚠️ 它们是**另外两格**（服务端在 `tool/call` 与 `tool/result` 上各报一套）——
    //      原来只存了结果那一半 ⇒ 右栏展开时说不出"入参被截"这句实话。
    group('入参的 bytes / truncated（服务端在 tool/call 上报的那一对）', () {
      Map<String, Object?> callWithArgs({Object? bytes = 2000, Object? truncated = true}) => {
            'type': 'tool/call',
            'turn': 1,
            'step': 1,
            'callId': 'c1',
            'name': 'write',
            'args': '{"path":"/w/a.txt"}',
            'bytes': bytes,
            'truncated': truncated,
          };

      test('★ 正例：原样收下（与**结果**那一对互不干扰）', () {
        final r = ToolRow.parse(callWithArgs(), result(bytes: 12, truncated: false))!;
        expect(r.argsBytes, 2000);
        expect(r.argsTruncated, isTrue);
        expect(r.bytes, 12, reason: '结果那一格还是结果那个数');
        expect(r.truncated, isFalse, reason: '结果那一格还是结果那一格');
      });

      test('★ 正例：还在跑的行也有这两格（那一对本来就在 `tool/call` 上）', () {
        final r = ToolRow.parse(callWithArgs(), null)!;
        expect(r.status, ToolStatus.running);
        expect(r.argsBytes, 2000);
        expect(r.argsTruncated, isTrue);
        expect(r.bytes, 0, reason: '结果还没报 —— 那是"还没报"，不是"零字节"');
      });

      test('★ 负例：缺了 / 类型不对 ⇒ `0` / `false`（不算坏行、绝不抛）', () {
        // ⚠️ 这里面有一个**真的踩过的坑**：`truncated: 1` ——
        //    Dart 里 `1 == true` 是**真的** ⇒ 用 `== true` 写会把它当成"截了"，
        //    于是屏幕上会凭空多出一句"已截断"（正是"页面在说假话"）。
        //    ⇒ `ToolRow.parse` 那边必须是**真的 bool**。
        for (final (bytes, truncated, wantBytes, wantTruncated) in <(Object?, Object?, int, bool)>[
          (null, null, 0, false),
          ('2000', 'yes', 0, false),
          (-1, 1, 0, false),
          (1.5, true, 0, true),
          ([], {}, 0, false),
          (0, false, 0, false),
        ]) {
          final r = ToolRow.parse(callWithArgs(bytes: bytes, truncated: truncated), null);
          expect(r, isNotNull, reason: '入参那两格坏了**不算坏行**（身份与成败才是）：$bytes/$truncated');
          expect(r!.argsBytes, wantBytes, reason: 'bytes=$bytes');
          expect(r.argsTruncated, wantTruncated, reason: 'truncated=$truncated');
        }
      });

      test('★ 负例：只有结果那一半的行（配不上调用）⇒ 这两格是 0/false', () {
        final r = ToolRow.parseResultOnly(result())!;
        expect(r.args, isNull);
        expect(r.argsBytes, 0, reason: '不是"没截"，是**我们没收到那一半**');
        expect(r.argsTruncated, isFalse);
      });
    });
  });

  group('TurnProcess.fold —— 计数', () {
    test('🔴 工具与 subagent **互斥**（同一次调用只进一个桶）', () {
      final p = TurnProcess.fold(rows: [
        row('bash'),
        row('subagent'),
        row('subagent_fork'),
        row('read_file'),
      ]);
      expect(p.toolCalls, 2);
      expect(p.subagents, 2);
      expect(p.total, 4, reason: '四行调用总共只该被数四次（不重不漏）');
    });

    test('🔴 控制类工具**两个桶都不进**（send_message / list_agents）', () {
      final p = TurnProcess.fold(rows: [
        row('send_message'),
        row('list_agents'),
        row('bash'),
      ]);
      expect(p.toolCalls, 1, reason: '只有 bash 算工具调用');
      expect(p.subagents, 0);
      expect(p.total, 1);
    });

    test('负向对照：subagent 判定是**精确前缀**，不是"名字里有 subagent"', () {
      expect(TurnProcess.isSubagentDelegation('subagent'), isTrue);
      expect(TurnProcess.isSubagentDelegation('subagent_fork'), isTrue);
      expect(TurnProcess.isSubagentDelegation('subagentX'), isFalse);
      expect(TurnProcess.isSubagentDelegation('get_subagent'), isFalse);
      expect(TurnProcess.isSubagentDelegation(''), isFalse);
    });

    test('🔴 消息数只数**严格早于**最终答案那一步的', () {
      expect(TurnProcess.fold(rows: const [], replySteps: [1, 2, 3], answerStep: 3).messages, 2);
      expect(TurnProcess.fold(rows: const [], replySteps: [1, 2, 3], answerStep: 4).messages, 3);
      expect(TurnProcess.fold(rows: const [], replySteps: [1], answerStep: 1).messages, 0);
    });

    test('还没有最终答案（还在跑）⇒ 全部算上', () {
      expect(TurnProcess.fold(rows: const [], replySteps: [1, 2], answerStep: null).messages, 2);
    });

    test('★ 只数指定的那一轮', () {
      final p = TurnProcess.fold(
        rows: [row('bash', turn: 1), row('read_file', turn: 2), row('grep', turn: 1)],
        turn: 1,
      );
      expect(p.toolCalls, 2);
    });

    test('没有调用 ⇒ 三样全 0', () {
      final p = TurnProcess.fold(rows: const []);
      expect(p.isEmpty, isTrue);
      expect(p.total, 0);
      expect(p.segments, isEmpty);
    });
  });

  group('TurnProcess 的标签（零段省略 · 顺序固定）', () {
    /// 会记下自己被叫过几次的文案源。
    ({TurnProcessWords words, List<String> called}) wordsFixture() {
      final called = <String>[];
      return (
        words: TurnProcessWords(
          toolCalls: (n) {
            called.add('toolCalls:$n');
            return '$n 次工具调用';
          },
          messages: (n) {
            called.add('messages:$n');
            return '$n 条消息';
          },
          subagents: (n) {
            called.add('subagents:$n');
            return '$n 个 subagent';
          },
          fallback: '已思考',
        ),
        called: called,
      );
    }

    test('★ 顺序固定：工具 · 消息 · subagent（不按数量排）', () {
      final f = wordsFixture();
      final label = dshTurnProcessLabel(
        const TurnProcess(toolCalls: 2, messages: 3, subagents: 1),
        f.words,
      );
      expect(label, '2 次工具调用 · 3 条消息 · 1 个 subagent');
      expect(f.called, ['toolCalls:2', 'messages:3', 'subagents:1']);
    });

    test('🔴 零的段**省略**，而且它的文案函数**一次都不许被叫**', () {
      final f = wordsFixture();
      final label = dshTurnProcessLabel(
        const TurnProcess(toolCalls: 2, messages: 0, subagents: 0),
        f.words,
      );
      expect(label, '2 次工具调用');
      expect(f.called, ['toolCalls:2'], reason: '0 的那两段不该被格式化（那会多出一个"0 条"）');
    });

    test('★ 全零 ⇒ 用调用方给的兜底句（模块里**没有**写死的文案）', () {
      final f = wordsFixture();
      final label = dshTurnProcessLabel(const TurnProcess(toolCalls: 0, messages: 0, subagents: 0), f.words);
      expect(label, '已思考');
      expect(f.called, isEmpty);
    });

    test('segments 的顺序 = 枚举顺序（工具 · 消息 · subagent）', () {
      expect(
        const TurnProcess(toolCalls: 1, messages: 2, subagents: 3).segments,
        [TurnProcessSegment.toolCalls, TurnProcessSegment.messages, TurnProcessSegment.subagents],
      );
      expect(
        const TurnProcess(toolCalls: 0, messages: 2, subagents: 3).segments,
        [TurnProcessSegment.messages, TurnProcessSegment.subagents],
      );
    });

    test('分隔就是 DSH 那个 `" · "`', () {
      expect(dshTurnProcessSeparator, ' · ');
    });
  });

  group('foldTurnUsage —— 宁可不显示，也不给半个', () {
    TurnUsageAttempt attempt(
      int input,
      int output, {
      int? cacheRead,
      int? cacheWrite,
      int? reasoning,
      bool complete = true,
      int turn = 1,
    }) =>
        TurnUsageAttempt(
          turn: turn,
          complete: complete,
          usage: TurnUsage(
            input: input,
            output: output,
            cacheRead: cacheRead,
            cacheWrite: cacheWrite,
            reasoning: reasoning,
          ),
        );

    test('★ 每一次都报了、且都结清 ⇒ 求和', () {
      final u = foldTurnUsage([
        attempt(100, 50, cacheRead: 900, cacheWrite: 20, reasoning: 10),
        attempt(10, 5, cacheRead: 90, cacheWrite: 2, reasoning: 1),
      ]);
      expect(u, isNotNull);
      expect(u!.input, 110);
      expect(u.output, 55);
      expect(u.cacheRead, 990);
      expect(u.cacheWrite, 22);
      expect(u.reasoning, 11);
      expect(u.total, 110 + 55 + 990 + 22);
    });

    test('🔴 有一次尝试没报用量 ⇒ **整块 null**（不许拿报了的凑）', () {
      final u = foldTurnUsage([
        attempt(100, 50),
        const TurnUsageAttempt(turn: 1, usage: null, complete: true),
      ]);
      expect(u, isNull);
    });

    test('🔴 `complete` 不是 true ⇒ null（这一轮还没结清）', () {
      expect(foldTurnUsage([attempt(1, 1, complete: false)]), isNull);
      expect(foldTurnUsage([attempt(1, 1), attempt(2, 2, complete: false)]), isNull);
    });

    test('🔴 推理 > 输出 ⇒ null（账本身矛盾）；等于/小于都行', () {
      expect(foldTurnUsage([attempt(10, 5, reasoning: 6)]), isNull);
      expect(foldTurnUsage([attempt(10, 5, reasoning: 5)]), isNotNull);
      expect(foldTurnUsage([attempt(10, 5, reasoning: 4)])!.reasoning, 4);
    });

    test('★ 可选桶：**要么每次都有、要么整块不给**（不给半个和）', () {
      // 两次都报了 cacheRead ⇒ 求和。
      expect(foldTurnUsage([attempt(1, 2, cacheRead: 3), attempt(4, 5, cacheRead: 6)])!.cacheRead, 9);
      // 一次没报 ⇒ 那个桶**整块 null**，但 input/output 照旧（这一轮本身还是精确的）。
      final u = foldTurnUsage([attempt(1, 2, cacheRead: 3), attempt(4, 5)]);
      expect(u, isNotNull);
      expect(u!.input, 5);
      expect(u.output, 7);
      expect(u.cacheRead, isNull);
      expect(u.cacheWrite, isNull);
      expect(u.reasoning, isNull);
      // 报了的那个是 0 也算"报了"（0 与"没报"是两件事）。
      expect(foldTurnUsage([attempt(1, 2, cacheRead: 0), attempt(4, 5, cacheRead: 0)])!.cacheRead, 0);
    });

    test('🔴 空 ⇒ null（不是 0：0 会被画成"这一轮没花 token"）', () {
      expect(foldTurnUsage(const []), isNull);
    });

    test('🔴 混了不止一轮 ⇒ null', () {
      expect(foldTurnUsage([attempt(1, 1, turn: 1), attempt(2, 2, turn: 2)]), isNull);
    });

    test('🔴 负数 / 超安全整数 ⇒ null', () {
      expect(foldTurnUsage([attempt(-1, 2)]), isNull);
      expect(foldTurnUsage([attempt(1, -2)]), isNull);
      expect(foldTurnUsage([attempt(dshMaxSafeTokenCount + 1, 1)]), isNull);
      expect(foldTurnUsage([attempt(1, 1, reasoning: -1)]), isNull);
      // 和本身溢出安全整数也不行。
      final big = dshMaxSafeTokenCount ~/ 2 + 1;
      expect(foldTurnUsage([attempt(big, 1), attempt(big, 1)]), isNull);
    });
  });

  group('TurnUsageAttempt.parse', () {
    Map<String, Object?> usageEvent({
      String type = 'turn/usage',
      Object? turn = 1,
      Object? usage = const {'input': 10, 'output': 4},
      Object? complete = true,
    }) =>
        {'type': type, 'turn': turn, 'usage': usage, 'complete': complete};

    test('★ 正常一条（可选的桶可为 null / 缺席）', () {
      final a = TurnUsageAttempt.parse(usageEvent(
        usage: const {'input': 10, 'output': 4, 'cacheRead': 100, 'cacheWrite': null, 'reasoning': 2},
      ));
      expect(a, isNotNull);
      expect(a!.turn, 1);
      expect(a.complete, isTrue);
      expect(a.usage!.input, 10);
      expect(a.usage!.output, 4);
      expect(a.usage!.cacheRead, 100);
      expect(a.usage!.cacheWrite, isNull);
      expect(a.usage!.reasoning, 2);
    });

    test('★ `usage: null` **是合法的**：这是一条"这次没报"的尝试', () {
      final a = TurnUsageAttempt.parse(usageEvent(usage: null));
      expect(a, isNotNull);
      expect(a!.usage, isNull);
    });

    test('🔴 认不出来 ⇒ null（绝不抛）', () {
      final bad = <Object?>[
        null,
        'turn/usage',
        42,
        <Object?>[],
        usageEvent(type: 'turn/start'),
        usageEvent(turn: null),
        usageEvent(turn: -1),
        usageEvent(complete: null),
        usageEvent(complete: 1),
        usageEvent(usage: 'nope'),
        usageEvent(usage: const {'input': 1}), // 缺 output
        usageEvent(usage: const {'input': -1, 'output': 2}),
        usageEvent(usage: const {'input': 1.5, 'output': 2}),
        usageEvent(usage: const {'input': 1, 'output': 2, 'cacheRead': 'x'}),
        usageEvent(usage: const {'input': 1, 'output': 2, 'reasoning': -3}),
        usageEvent(usage: {'input': dshMaxSafeTokenCount + 1, 'output': 2}),
      ];
      for (final b in bad) {
        expect(() => TurnUsageAttempt.parse(b), returnsNormally, reason: '抛了：$b');
        expect(TurnUsageAttempt.parse(b), isNull, reason: '该认不出来：$b');
      }
    });
  });

  group('SystemPromptRow.parse', () {
    test('★ 正常一条：原文逐字（含换行）、bytes / truncated 原样', () {
      final r = SystemPromptRow.parse(const {
        'type': 'system/prompt',
        'turn': 2,
        'step': 3,
        'text': '你是琥珀。\n第二行。',
        'bytes': 200,
        'truncated': true,
      });
      expect(r, isNotNull);
      expect(r!.turn, 2);
      expect(r.step, 3);
      expect(r.text, '你是琥珀。\n第二行。');
      expect(r.bytes, 200);
      expect(r.truncated, isTrue);
    });

    test('🔴 认不出来 ⇒ null', () {
      for (final bad in <Object?>[
        null,
        const {},
        const {'type': 'system/prompt'},
        const {'type': 'system/prompt', 'turn': 1, 'step': 1, 'bytes': 0}, // 缺 text
        const {'type': 'system/prompt', 'turn': 1, 'step': 1, 'text': 5, 'bytes': 0},
        const {'type': 'system/prompt', 'turn': 1, 'step': 1, 'text': 'x'}, // 缺 bytes
        const {'type': 'system/prompt', 'turn': '1', 'step': 1, 'text': 'x', 'bytes': 0},
      ]) {
        expect(() => SystemPromptRow.parse(bad), returnsNormally, reason: '抛了：$bad');
        expect(SystemPromptRow.parse(bad), isNull, reason: '该认不出来：$bad');
      }
    });

    test('空串是合法的（画不画由界面层定，模型层不替它决定）', () {
      final r = SystemPromptRow.parse(const {
        'type': 'system/prompt',
        'turn': 1,
        'step': 1,
        'text': '',
        'bytes': 0,
        'truncated': false,
      });
      expect(r, isNotNull);
      expect(r!.text, isEmpty);
    });
  });
}
