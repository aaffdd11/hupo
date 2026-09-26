// **浮窗里那两个视图**：聊天 / 轨迹（契约 `docs/dev/118-TRAJECTORY-VIEW.md`）。
//
// 主人 2026-09-26：*"首先全部开放，聊天窗口的设计也要重做。"* —— DSH 的窗口顶上
// 就是**这个形状**：两个 tab（`view.chat` / `view.trajectory`，见
// `docs/dev/115-raw/B-render.md` L65）。这一份是那两个 tab 的**身份与字**。
//
// ⚠️ 为什么档位要单独一个文件、而不是在界面里写两个字符串（照 `process_levels.dart`）：
//   1. **协议那一半要冻结**：`wire` 是**存在本机**的那个 token（`chat` / `trajectory`）。
//      两边（写盘 / 读盘）认的是同一个字符串，写散了就一定会漂；
//   2. **文案那一半要进硬闸**：`tab` 是**用户会看到的字**，摆在 `screens/` 里的话，
//      禁用词扫描（`test/unit`）就够不着它 —— 和 `about_facts.dart` 同一条理由。
//
// ⚠️ 纯逻辑，**不许 import flutter/material**（`models/` 的规矩）。

/// 浮窗里现在看的是哪一屏。
enum ChatView {
  /// 聊天（默认）：琥珀在说话那一条。
  chat(wire: 'chat', tab: '聊天'),

  /// 轨迹：把**同一条会话**摊成一张表（DSH 的第二个 tab）。
  trajectory(wire: 'trajectory', tab: '轨迹');

  const ChatView({required this.wire, required this.tab});

  /// 存在本机的那一个字符串（**改它 = 把用户存在盘上的选择弄丢**）。
  final String wire;

  /// tab 上那两个字。
  final String tab;
}

/// 默认看哪一屏 = **聊天**（DSH 的 `DEFAULT_VIEW_ID = "chat"`，逐字如此）。
const ChatView defaultChatView = ChatView.chat;

/// 认一个 token ⇒ 视图；**认不出来一律当默认**（聊天）。
///
/// ⚠️ **绝不抛**：这个函数的输入来自本机存的那一个字符串，
///    它可能是旧版本写的、也可能被别的什么东西改坏了。
///    坏掉的后果必须只是"回到聊天"，**不能是打不开浮窗**。
ChatView chatViewOf(Object? wire) {
  for (final v in ChatView.values) {
    if (v.wire == wire) return v;
  }
  return defaultChatView;
}
