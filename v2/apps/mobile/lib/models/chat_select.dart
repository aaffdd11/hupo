// 「长按气泡 ⇒ 复制 / 多选」这一路的**纯逻辑**（契约 `docs/dev/106-CHAT-SELECT.md` §二）。
//
// ── 为什么它住在 `models/` ──────────────────────────────────
// 这一批最容易做歪的地方**不是界面**，是"**到底复制哪一串字**"（§二 🔴 只复制正文）。
// 把它做成纯函数，才进得了 `test/unit` 那道硬闸（"纯函数进 `test/unit`，
// 不写界面断言" —— `AGENTS.md` §2.1 第 3 条）。
//
// ⚠️ **纯逻辑，不许 import flutter/material**（楼层闸：`models` 是纯逻辑层）。

import 'image_links.dart';
import 'timeline.dart';

/// 这一条**能看见的正文** —— 复制就复制它（契约 §二 的表）。
///
/// | 那一条是 | 这里返回 |
/// |---|---|
/// | **他说的** | `text` **逐字**（不带时间、不带"我说"那种标签）|
/// | **它回的** | 气泡里**画出来的**那一段 —— 和 `AnswerBubble` **同一个函数**<br>（`textWithoutImageLines(displayText)`，长文短话都在里面）|
/// | 别的（分隔线 / 通知 / 认不出的）| 空串（它们没有可复制的正文）|
///
/// ⚠️ **"看见什么就复制什么"只有一处出处**：气泡画正文用的是同一个
///    `textWithoutImageLines(message.displayText)`。在这里另写一套"拼正文"的逻辑，
///    迟早会漂成"复制出来的和屏幕上看到的不一样"。
/// ⚠️ **图片不复制、也不写"[图片]"这种我们自己造的字**（§二）：
///    整行就是一个图片地址的那些行由 `textWithoutImageLines` 去掉了
///    —— 我们**不发明**一个词去顶它的位置。
/// ⚠️ **空串是有意思的**：调用方必须**如实说"复制不了"**，
///    **不许**把空串塞进剪贴板还告诉用户"复制好了"（§二 的 ⚠️）。
String bubbleBodyOf(TimelineItem item) => switch (item) {
  UserUtterance() => item.text,
  AssistantMessage() => textWithoutImageLines(item.displayText),
  _ => '',
};

/// 多选要写进剪贴板的那几条正文，**按调用方给的顺序**（时间线顺序 = 时间顺序）。
///
/// ⚠️ 空正文的那几条**跳过** —— 不跳的话会多出空行，"一条一行"就成了假话；
///    一条都不剩 ⇒ 空清单，调用方照样要如实说"没有能复制的字"。
/// ⚠️ **一条一行靠调用方 `join('\n')`**：这里只负责"哪几条、什么顺序"，
///    拼法只有一处（`lib/screens/chat_screen.dart` 的 `_copySelected`）。
List<String> bubbleBodiesOf(
  Iterable<TimelineItem> inOrder, {
  required bool Function(TimelineItem) keep,
}) {
  final out = <String>[];
  for (final it in inOrder) {
    if (!keep(it)) continue;
    final body = bubbleBodyOf(it);
    if (body.isEmpty) continue;
    out.add(body);
  }
  return out;
}
