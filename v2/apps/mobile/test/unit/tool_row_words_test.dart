// `116` 那几行的**文案**（`lib/models/tool_row_words.dart`）。
//
// ⚠️ 为什么单独一份：这一批新加的字里有几个是 `forbidden_words.dart` 表里的词
//    （`工具` / `subagent` / `系统提示词`）—— 主人 2026-09-26 的原话是
//    *"首先全部开放"*，聊天窗口内放开 D1.1。词表这一批**一个字没改**，
//    所以这几句**故意没有**列进 `forbidden_words_test.dart` 那份"必须干净"的清单
//    （列进去会当场红，而红的是那条还没拍的规矩）。详见 `tool_row_words.dart` 顶上那段。
//
// 这一份钉的是**形状**（数对不对、缺的桶在不在、有没有自己编一个总数/金额/百分比）。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/tool_row.dart';
import 'package:hupo_app/models/tool_row_words.dart';

void main() {
  group('状态那四个词', () {
    test('★ 四个值各有各的说法，而且"败"与"停"**分开**', () {
      final words = {for (final s in ToolStatus.values) s: toolStatusWord(s)};
      expect(words[ToolStatus.running], '在跑');
      expect(words[ToolStatus.ok], '成了');
      expect(words[ToolStatus.error], '没成');
      expect(words[ToolStatus.interrupted], '停了');
      expect(
        words.values.toSet(),
        hasLength(ToolStatus.values.length),
        reason: '四个状态不许有两个说成同一句话（那就分不出"它坏了"和"我按了停"）',
      );
    });
  });

  group('截断那句实话', () {
    test('🔴 逐字是"… 已截断，共 N 字节"（字节，不是字）', () {
      expect(toolTruncatedLine(0), '… 已截断，共 0 字节');
      expect(toolTruncatedLine(456), '… 已截断，共 456 字节');
    });
  });

  group('groupDigits（只加分隔符，不改数）', () {
    test('★ 千位分组；不四舍五入、不换算成 k/M', () {
      expect(groupDigits(0), '0');
      expect(groupDigits(5), '5');
      expect(groupDigits(999), '999');
      expect(groupDigits(1000), '1,000');
      expect(groupDigits(12345), '12,345');
      expect(groupDigits(1234567), '1,234,567');
    });

    test('负数 / 认不出的原样返回（这一层不做判断、不抛）', () {
      expect(groupDigits(-1), '-1');
      expect(groupDigits(-1234567), '-1234567');
    });
  });

  group('每轮用量那一行', () {
    TurnUsage u({int? cacheRead, int? cacheWrite, int? reasoning}) =>
        TurnUsage(input: 1000, output: 42, cacheRead: cacheRead, cacheWrite: cacheWrite, reasoning: reasoning);

    test('★ 输入/输出一定在，可选桶**有才画**', () {
      expect(turnUsageLine(u()), '本轮用量 · 未缓存输入 1,000 tok · 输出 42 tok');
      expect(
        turnUsageLine(u(cacheRead: 9000, cacheWrite: 20, reasoning: 5)),
        '本轮用量 · 未缓存输入 1,000 tok · 输出 42 tok · 缓存读取 9,000 tok · 缓存写入 20 tok · 其中推理 5 tok',
      );
    });

    test('🔴 缺的桶**一个字都不许补**（没有缓存就不写"缓存 0"）', () {
      final line = turnUsageLine(u());
      expect(line.contains(turnUsageCacheRead), isFalse);
      expect(line.contains(turnUsageCacheWrite), isFalse);
      expect(line.contains(turnUsageReasoning), isFalse);
    });

    test('🔴 没有钱、没有百分比、也没有自己算的总数', () {
      final line = turnUsageLine(u(cacheRead: 9000, cacheWrite: 20, reasoning: 5));
      for (final bad in ['元', '¥', r'$', '%', '总', '合计', '约']) {
        expect(line.contains(bad), isFalse, reason: '「$bad」是编出来的口径，DSH 全树只有 token');
      }
    });
  });

  group('过程折叠那一行（dshTurnProcessLabel 的文案源）', () {
    test('★ 非零段按"工具 · 消息 · subagent"拼，分隔是 DSH 那个中点', () {
      final label = dshTurnProcessLabel(
        const TurnProcess(toolCalls: 2, messages: 0, subagents: 1),
        turnProcessChatWords,
      );
      expect(label, '2 次工具调用${dshTurnProcessSeparator}1 个 subagent');
      expect(dshTurnProcessSeparator, ' · ');
    });

    test('★ 三样全 0 ⇒「已思考」（DSH 的兜底句）', () {
      expect(
        dshTurnProcessLabel(const TurnProcess(toolCalls: 0, messages: 0, subagents: 0), turnProcessChatWords),
        '已思考',
      );
      expect(turnProcessFallback, '已思考');
    });

    test('★ 消息那一段也有说法（虽然我们的客户端今天恒为 0）', () {
      expect(
        dshTurnProcessLabel(const TurnProcess(toolCalls: 0, messages: 3, subagents: 0), turnProcessChatWords),
        '3 条消息',
      );
    });
  });

  group('系统提示词那两行标题', () {
    test('抬头与展开/收起都有字（D3.8：不许只有图标）', () {
      expect(systemPromptTitle.trim(), isNotEmpty);
      expect(systemPromptExpandLabel.trim(), isNotEmpty);
      expect(systemPromptCollapseLabel.trim(), isNotEmpty);
      expect(toolRowExpandLabel.trim(), isNotEmpty);
      expect(toolRowCollapseLabel.trim(), isNotEmpty);
    });
  });
}
