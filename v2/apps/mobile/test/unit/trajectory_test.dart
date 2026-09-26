// 轨迹那一屏的**纯逻辑**（契约 `docs/dev/118-TRAJECTORY-VIEW.md`）。
//
// ⚠️ 这一份钉的就是派活单点名的那几样，每条都带一个**反例**：
//   分组 / 排序 / 摘要 / 计数 / 空 / **坏数据 fail-closed**。
// ⚠️ 还有一条最要紧的（`118` 的灵魂）：**我们没有的东西一个都不许出现** ——
//    没有模型名、没有钱、没有时长、没有百分比。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/message_state.dart';
import 'package:hupo_app/models/timeline.dart';
import 'package:hupo_app/models/tool_row.dart';
import 'package:hupo_app/models/tool_row_words.dart';
import 'package:hupo_app/models/trajectory.dart';
import 'package:hupo_app/models/trajectory_words.dart';

// ── 造几条记录（都走真正的构造器，不是手抄的 map）────────────────

UserUtterance _user(int seq, String text, {int? at}) => UserUtterance(
  messageId: 'u_$seq',
  text: text,
  seq: seq,
  at: at,
  state: MessageState.confirmed,
);

AssistantMessage _assistant(int seq, String text, {int? at}) => AssistantMessage(
  messageId: 'm_$seq',
  seq: seq,
  at: at,
)..quick = text;

TimelineToolCall _toolCall(
  int seq,
  String name, {
  String? title,
  int turn = 1,
  int step = 1,
  int? at,
}) => TimelineToolCall(
  seq: seq,
  at: at,
  row: ToolRow(
    callId: 'c_$seq',
    name: name,
    title: title,
    args: null,
    status: ToolStatus.ok,
    excerpt: null,
    bytes: 1,
    truncated: false,
    turn: turn,
    step: step,
  ),
);

TimelineSystemPrompt _systemPrompt(int seq, String text, {int turn = 1, int step = 1, int? at}) =>
    TimelineSystemPrompt(
      seq: seq,
      at: at,
      row: SystemPromptRow(turn: turn, step: step, text: text, bytes: text.length, truncated: false),
    );

TimelineTurnUsage _usage(
  int seq,
  int turn, {
  TurnUsage? usage,
  bool complete = true,
  int? at,
}) => TimelineTurnUsage(
  seq: seq,
  at: at,
  attempt: TurnUsageAttempt(turn: turn, usage: usage, complete: complete),
);

/// 把那一窗的用量**逐轮折一遍**（和 `ChatController.turnUsage` 走同一条规矩）。
TurnUsage? Function(int) _usageOf(List<TimelineItem> items) => (turn) => foldTurnUsage([
  for (final it in items)
    if (it is TimelineTurnUsage && it.turn == turn) it.attempt,
]);

const TurnProcess _zero = TurnProcess(toolCalls: 0, messages: 0, subagents: 0);

TrajectoryTable _table(
  List<TimelineItem> items, {
  TurnProcess Function(int turn)? processOfTurn,
  TurnUsage? Function(int turn)? usageOf,
  Set<int> unfoldedTurns = const <int>{},
  int closedThrough = 0,
  bool historyComplete = false,
}) =>
    trajectoryTableOf(
      items: items,
      words: trajectoryWords,
      processOfTurn: processOfTurn ?? (_) => _zero,
      usageOf: usageOf ?? (_) => null,
      unfoldedTurns: unfoldedTurns,
      closedThrough: closedThrough,
      historyComplete: historyComplete,
    );

void main() {
  group('排序与分组', () {
    test('★ 一行一条记录，按 `(seq, tie)` 排（进来是乱序也照样）', () {
      final t = _table([
        _usage(5, 1),
        _user(1, '第一句'),
        _systemPrompt(3, '你是琥珀'),
        _toolCall(2, 'bash', title: '跑一下测试'),
      ]);
      expect(t.rows.map((r) => r.seq).toList(), [1, 2, 3, 5]);
      // 反例：不许按 kind 排、也不许按摘要排
      expect(t.rows.first.kind, TrajectoryKind.user);
      expect(t.rows.last.kind, TrajectoryKind.usage);
    });

    test('同一号里按 `tie`（本地那条乐观发言排在服务端事件之前/之后照契约）', () {
      final a = UserUtterance(messageId: 'u_a', text: '甲', seq: 7, tie: 1);
      final b = _user(7, '乙');
      final t = _table([a, b]);
      expect(t.rows.map((r) => r.summary).toList(), ['乙', '甲']);
    });

    test('★ 分组头只落在**每一轮的第一行**上；没带轮号的那几行永远不是头', () {
      final t = _table([
        _user(1, '问题'),
        _toolCall(2, 'bash', turn: 1),
        _toolCall(3, 'read', turn: 1),
        _usage(4, 1, usage: const TurnUsage(input: 1, output: 2)),
        _user(5, '第二问'),
        _toolCall(6, 'write', turn: 2),
      ]);
      final heads = t.rows.where((r) => r.turnHead).toList();
      expect(heads.map((r) => r.turn).toList(), [1, 2]);
      // 反例：消息那两行**不许**被算成某一轮的头（它们连轮号都没有）
      expect(heads.every((r) => r.turn != null), isTrue);
      expect(t.rows.firstWhere((r) => r.seq == 1).turnHead, isFalse);
    });

    test('轮号升序，而且**只出现收到过的那几轮**（不按 1..max 补空轮）', () {
      final t = _table([_toolCall(2, 'bash', turn: 3), _toolCall(3, 'read', turn: 7)]);
      expect(t.turns.map((x) => x.turn).toList(), [3, 7]);
    });

    test('反例：分隔线与通知**不进这张表**（它们不是那五类记录）', () {
      final t = _table([
        const TimelineMarker(kind: 'away', seq: 1),
        _user(2, '只有这一条'),
      ]);
      expect(t.rows.length, 1);
      expect(t.rows.single.kind, TrajectoryKind.user);
    });
  });

  group('摘要（一行，逐字来自手上那份数据）', () {
    test('★ 用户 / 助手：正文的第一行（去两端空白）', () {
      final t = _table([
        _user(1, '\n\n  帮我把这周工时记一下  \n第二行不该出现'),
        _assistant(2, '这周 7 小时。\n下面是细节'),
      ]);
      expect(t.rows[0].summary, '帮我把这周工时记一下');
      expect(t.rows[1].summary, '这周 7 小时。');
    });

    test('★ 工具行：名字 · 人话标题（就是 `116` 那一行上的数据）', () {
      final t = _table([_toolCall(2, 'bash', title: '跑一下测试')]);
      expect(t.rows.single.summary, 'bash · 跑一下测试');
    });

    test('工具行只有一半也照样说（名字在就只给名字）', () {
      expect(_table([_toolCall(2, 'bash')]).rows.single.summary, 'bash');
      final onlyTitle = _table([
        TimelineToolCall(
          seq: 3,
          row: ToolRow(
            callId: 'c3',
            name: '',
            title: '只有标题',
            args: null,
            status: ToolStatus.ok,
            excerpt: null,
            bytes: 1,
            truncated: false,
            turn: 1,
            step: 1,
          ),
        ),
      ]);
      expect(onlyTitle.rows.single.summary, '只有标题');
    });

    test('🔴 工具行两半都没有 ⇒ **兜底那句**（绝不编一个占位名）', () {
      final t = _table([
        TimelineToolCall(
          seq: 2,
          row: ToolRow(
            callId: 'c2',
            name: '',
            title: null,
            args: null,
            status: ToolStatus.ok,
            excerpt: null,
            bytes: 1,
            truncated: false,
            turn: 1,
            step: 1,
          ),
        ),
      ]);
      expect(t.rows.single.summary, trajectoryBlankSummary);
    });

    test('🔴 空消息 ⇒ 兜底那句（不是一行空白）', () {
      final t = _table([_assistant(1, '   \n  ')]);
      expect(t.rows.single.summary, trajectoryBlankSummary);
      expect(t.rows.single.summary.trim().isNotEmpty, isTrue);
    });

    test('系统提示词行：第一行（逐字的一部分，不改写）', () {
      final t = _table([_systemPrompt(1, '你是琥珀。\n后面还有很多')]);
      expect(t.rows.single.summary, '你是琥珀。');
    });

    test('用量行：折得出 ⇒ 那一行；折不出 ⇒ **只说没结清**（一个数都不给）', () {
      final items = [_usage(1, 1, usage: const TurnUsage(input: 800, output: 434))];
      final t = _table(items, usageOf: _usageOf(items));
      expect(t.rows.single.summary, turnUsageLine(const TurnUsage(input: 800, output: 434)));

      // 反例：这一次没报用量 ⇒ 不许出现任何数字
      final bad = [_usage(1, 1, usage: null, complete: false)];
      final t2 = _table(bad, usageOf: _usageOf(bad));
      expect(t2.rows.single.summary, trajectoryUsageNotSettled);
      expect(t2.rows.single.summary.contains('tok'), isFalse);
      expect(t2.rows.single.summary.contains('0'), isFalse);
    });

    test('`firstLineOf`：坏输入 ⇒ 空串（绝不抛）', () {
      expect(firstLineOf(null), '');
      expect(firstLineOf(42), '');
      expect(firstLineOf(''), '');
      expect(firstLineOf('  \n\t\n'), '');
      expect(firstLineOf('甲\n乙'), '甲');
    });
  });

  group('每轮计数：**复用** `116` 的 `TurnProcess`（一条规矩都不重写）', () {
    test('★ 分组头上挂的正是 `processOfTurn` 给的那一份，而且只问真出现过的轮', () {
      final asked = <int>[];
      final t = _table(
        [
          _toolCall(2, 'bash', turn: 1),
          _toolCall(3, 'subagent', turn: 1),
          _toolCall(4, 'bash', turn: 5),
        ],
        processOfTurn: (turn) {
          asked.add(turn);
          return TurnProcess(toolCalls: turn, messages: 0, subagents: turn * 2);
        },
      );
      expect(asked, [1, 5]);
      expect(t.turns.map((x) => x.process.toolCalls).toList(), [1, 5]);
      expect(t.turns.map((x) => x.process.subagents).toList(), [2, 10]);
    });

    test('反例：轮号只由**记录自己带**（消息那几行不参与分组）', () {
      final t = _table([_user(1, '问题'), _assistant(2, '回答')]);
      expect(t.turns, isEmpty, reason: '消息不带 turn ⇒ 不许自己数出"第 1 轮"');
      expect(t.rows.every((r) => r.turn == null), isTrue);
    });
  });

  group('空会话与"全部"', () {
    test('★ 一条记录都没有 ⇒ 空表（不编行、也不给合计）', () {
      final t = _table([]);
      expect(t.isEmpty, isTrue);
      expect(t.rows, isEmpty);
      expect(t.turns, isEmpty);
      expect(t.totals.turns, 0);
      expect(t.totals.tokens, isNull);
      expect(t.totals.steps, isNull);
    });

    test('★ `complete` 原样带出来（视图那一层靠它决定说不说"到最早了"）', () {
      expect(_table([_user(1, 'x')]).totals.complete, isFalse);
      expect(_table([_user(1, 'x')], historyComplete: true).totals.complete, isTrue);
    });

    test('🔴 步骤合计**恒为 null**（我们收不到"这一轮一共几步"）', () {
      final t = _table([_toolCall(1, 'bash', turn: 1, step: 9)]);
      expect(t.totals.steps, isNull, reason: '工具行上的 step 号证明不了整轮几步');
    });
  });

  group('合计 token：一处不精确就整块不给', () {
    test('★ 每一轮都折得出 ⇒ 加起来；可选的桶要么每轮都有、要么整块不给', () {
      final items = [
        _usage(1, 1, usage: const TurnUsage(input: 100, output: 20, cacheRead: 5)),
        _usage(2, 2, usage: const TurnUsage(input: 300, output: 40, cacheRead: 7)),
      ];
      final t = _table(items, usageOf: _usageOf(items));
      expect(t.totals.turns, 2);
      expect(t.totals.tokens!.input, 400);
      expect(t.totals.tokens!.output, 60);
      expect(t.totals.tokens!.cacheRead, 12);

      // 反例：有一轮没报缓存读 ⇒ 那一桶整块不给（不许给半个和）
      final mixed = [
        _usage(1, 1, usage: const TurnUsage(input: 100, output: 20, cacheRead: 5)),
        _usage(2, 2, usage: const TurnUsage(input: 300, output: 40)),
      ];
      final t2 = _table(mixed, usageOf: _usageOf(mixed));
      expect(t2.totals.tokens!.input, 400);
      expect(t2.totals.tokens!.cacheRead, isNull);
    });

    test('🔴 有一轮折不出来 ⇒ **合计整块 null**（宁可一个数都不给）', () {
      final items = [
        _usage(1, 1, usage: const TurnUsage(input: 100, output: 20)),
        _usage(2, 2, usage: null, complete: false),
      ];
      final t = _table(items, usageOf: _usageOf(items));
      expect(t.totals.tokens, isNull);
    });

    test('🔴 有一轮连 `turn/usage` 都没有（只看到工具行）⇒ 合计也是 null', () {
      final items = [
        _usage(1, 1, usage: const TurnUsage(input: 100, output: 20)),
        _toolCall(2, 'bash', turn: 2),
      ];
      final t = _table(items, usageOf: _usageOf(items));
      expect(t.turns.length, 2);
      expect(t.totals.tokens, isNull, reason: '第 2 轮没有账 ⇒ 合计不许只说第 1 轮');
    });
  });

  group('能不能跳过去（inChat / needsUnfold）', () {
    test('★ 折起来那一轮的工具行：画得出，但要**先展开**', () {
      final t = _table([_toolCall(2, 'bash', turn: 1)], closedThrough: 1);
      expect(t.rows.single.inChat, isTrue);
      expect(t.rows.single.needsUnfold, isTrue);
    });

    test('还没收口 ⇒ 不用展开（它本来就摆着）', () {
      final t = _table([_toolCall(2, 'bash', turn: 1)], closedThrough: 0);
      expect(t.rows.single.needsUnfold, isFalse);
    });

    test('用户自己展开过 ⇒ 也不用展开', () {
      final t = _table([_toolCall(2, 'bash', turn: 1)], closedThrough: 1, unfoldedTurns: {1});
      expect(t.rows.single.needsUnfold, isFalse);
    });

    test('🔴 同一轮里**不是最后一条**的用量：聊天里没有那一格 ⇒ inChat = false', () {
      final items = [
        _usage(1, 1, usage: const TurnUsage(input: 1, output: 1)),
        _usage(2, 1, usage: const TurnUsage(input: 2, output: 2)),
      ];
      final t = _table(items, usageOf: _usageOf(items));
      expect(t.rows[0].inChat, isFalse, reason: '前一条在聊天里被后一条顶掉了');
      expect(t.rows[1].inChat, isTrue);
    });
  });

  group('时刻', () {
    test('★ `at` 原样带出来；没带就是 `null`（**绝不补一个设备钟**）', () {
      final t = _table([_user(1, '有钟', at: 1758400000000), _user(2, '没钟')]);
      expect(t.rows[0].at, 1758400000000);
      expect(t.rows[1].at, isNull);
    });

    test('`trajectoryClock`：HH:mm:ss，两位数', () {
      expect(trajectoryClock(DateTime(2026, 9, 26, 9, 5, 3)), '09:05:03');
      expect(trajectoryClock(DateTime(2026, 9, 26, 23, 59, 59)), '23:59:59');
      expect(trajectoryClock(DateTime(2026, 9, 26, 0, 0, 0)), '00:00:00');
    });
  });

  group('🔴 我们没有的东西，一个都不许出现在这一屏上', () {
    test('摘要与文案里：没有钱、没有百分比、没有模型名、没有时长', () {
      final items = [
        _user(1, '问题'),
        _toolCall(2, 'bash', title: '跑一下测试', turn: 1),
        _systemPrompt(3, '你是琥珀', turn: 1),
        _usage(4, 1, usage: const TurnUsage(input: 800, output: 434, cacheRead: 900)),
      ];
      final t = _table(items, usageOf: _usageOf(items));
      final all = [
        for (final r in t.rows) r.summary,
        for (final r in t.rows) trajectoryKindWord(r.kind),
        trajectoryTotalsHead,
        trajectoryTurnHead(1),
        trajectoryIncompleteLine,
        trajectoryCompleteLine,
        trajectoryEmptyLine,
        trajectoryJumpUnavailableLine,
        trajectoryJumpFailedLine,
        trajectoryUsageNotSettled,
        trajectoryBlankSummary,
        if (t.totals.tokens != null) trajectoryTotalUsageLine(t.totals.tokens!),
      ].join('\n');
      for (final bad in ['%', '美元', '￥', r'$', '模型', '元/', '秒', 'ms', 'DeepSeek']) {
        expect(all.contains(bad), isFalse, reason: '轨迹里出现了我们没有的东西：$bad');
      }
    });

    test('反例：合计那一行的抬头**不是**"本轮用量"（那是假话）', () {
      final items = [_usage(1, 1, usage: const TurnUsage(input: 1, output: 2))];
      final t = _table(items, usageOf: _usageOf(items));
      final line = trajectoryTotalUsageLine(t.totals.tokens!);
      expect(line.startsWith(trajectoryTokensHead), isTrue);
      expect(line.contains(turnUsageHead), isFalse);
      // 桶本身还是那批桶（一处出处）
      expect(line.contains(turnUsageInput), isTrue);
    });
  });

  group('坏数据 fail-closed（绝不抛）', () {
    test('🔴 认不出的一条记录只会"少一行"，不会把整张表打崩', () {
      // `Timeline.apply` 已经把坏帧挡在门外；这里再喂几种"半坏"的条目，
      // 看这张表是不是照样出得来、而且**不编**。
      final items = <TimelineItem>[
        _assistant(1, ''), // 空正文
        TimelineToolCall(
          seq: 2,
          row: ToolRow(
            callId: 'c2',
            name: '',
            title: null,
            args: null,
            status: ToolStatus.error,
            excerpt: null,
            bytes: 0,
            truncated: false,
            turn: 1,
            step: 1,
          ),
        ),
        _usage(3, 1, usage: null, complete: false),
      ];
      late TrajectoryTable t;
      expect(() => t = _table(items, usageOf: _usageOf(items)), returnsNormally);
      expect(t.rows.length, 3);
      expect(t.rows.every((r) => r.summary.trim().isNotEmpty), isTrue);
      expect(t.totals.tokens, isNull);
    });

    test('🔴 `usageOf` 认不出来（null）时，那一行**不许**出现任何数字', () {
      final items = [_usage(1, 1, usage: const TurnUsage(input: 5, output: 5))];
      // 故意给一个"折不出来"的 provider —— 界面那一层必须照 `null` 走
      final t = _table(items, usageOf: (_) => null);
      expect(t.rows.single.summary, trajectoryUsageNotSettled);
      expect(t.totals.tokens, isNull);
    });
  });
}
