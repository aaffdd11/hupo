// **"念哪一份字"**（主人 2026-10-05：*"播报只播报核心内容，也就是字体较大的那个内容。"*）。
//
// 这一条是**纯读源码**的判据（`test/unit` 那一档）：
//   自动念那一路拿的字，必须来自**那一条消息的正文**（＝气泡里那两段大的：
//   `quick` ＋ `deep`，`AssistantMessage.displayText`），
//   **不许**把这一轮别的东西拼进去 —— 工具那一行、过程、出处、每轮 token …
//   那些是**小字**（给眼睛看的交代），念出来是噪音，而且会让人以为事情说完了。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/timeline.dart';

void main() {
  test('🔴 念的是**正文那一份**：`quick` ＋ `deep`（大字那两块），一个装饰都不加', () {
    final m = AssistantMessage(messageId: 'm1', seq: 1)..quick = '明天晴';
    m.deep = '二十到二十八度。';
    expect(m.displayText, '明天晴 二十到二十八度。',
        reason: '★ 快答没以句末标点结尾 ⇒ 补一个空格（免得两句粘一起）');
    // 负向对照：**已经有句末标点** ⇒ 不许再塞一个空格
    final punct = AssistantMessage(messageId: 'm1b', seq: 1)..quick = '明天晴。';
    punct.deep = '二十到二十八度。';
    expect(punct.displayText, '明天晴。二十到二十八度。');

    final only = AssistantMessage(messageId: 'm2', seq: 2)..quick = '好。';
    expect(only.displayText, '好。', reason: '★ 只有快答 ⇒ 就念它（不许补一个空的后半段）');

    final deepOnly = AssistantMessage(messageId: 'm3', seq: 3)..deep = '只有深答。';
    expect(deepOnly.displayText, '只有深答。');
  });

  test('🔴 自动念那一路**只拿 `textOfMessage`**（不许自己拼别的字段）', () {
    // ⚠️ 源码级：VM 上没有一个真服务端，量不到"它到底念了哪一串"；
    //    能钉的是**那一行拿的是什么** —— 它一变（比如改成拼工具行/过程），这条就红。
    final src = File('lib/services/chat_controller.dart').readAsStringSync();
    final i = src.indexOf("event['type'] == 'message/end'");
    expect(i > 0, isTrue, reason: '找不到自动念那一段（判据要跟着它走）');
    final block = src.substring(i, i + 600);
    expect(block.contains('textOfMessage(id)'), isTrue,
        reason: '★ 自动念要拿"那一条的正文"（`textOfMessage`）');
    for (final forbidden in ['toolRow', 'process', 'sources', 'reasoning']) {
      expect(block.contains(forbidden), isFalse,
          reason: '★ 把「$forbidden」也拼进去念了 —— 那些是小字，不是核心内容');
    }
    // 而 `textOfMessage` 自己拿的必须是 `displayText`（不是 raw / 拼段）
    expect(src.contains('it is AssistantMessage && it.messageId == messageId) return it.displayText;'), isTrue,
        reason: '★ 正文那一份的定义变了：它该是 `displayText`（`quick` ＋ `deep`）');
  });
}
