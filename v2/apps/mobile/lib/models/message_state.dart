// 一条消息的四态。手册 `05-DECISIONS.md` §3.1 / `08-SPEC.md` §4.1。
//
// 为什么不能只有一个 `pending` bool（旧实现就是这样）：
// **失败与成功长得一模一样**——失败时连小转圈都消失，
// 用户看到的是"发出去了"。09 的原话："界面把'发不出去'显示成'发出去了'"。
// 那是"8/10 的放弃点"里最狠的一条。
//
// 四态：
//   queued     已交出去（本地按下发送）
//   sent       请求成功（服务端收下了）
//   confirmed  服务端回执到了（`user/echo` 带着同一个 messageId 回来）
//   failed     网络错 / 超时 / 服务端拒绝
//
// ⚠️ 纯逻辑，**不许 import flutter/material**（手册 §2.3 禁令 1）。
//    它要能进 `test/unit` 硬闸——界面一重构，纯函数不受影响。

enum MessageState {
  /// 已交出去。界面上是**一个确定的标记**，不是转圈——
  /// 转圈的意思是"不知道"，而"已交出去"是知道的。
  queued,

  /// 服务端收下了（HTTP 200）。
  sent,

  /// 服务端回执到了（WS 上看到了自己那句话）。
  confirmed,

  /// 发失败了。**必须有自己的长相 + 重发入口**，收起态也要显示。
  failed,
}

/// 允许的转移。不在表里的转移一律忽略（**不许瞎转**）。
///
/// ⚠️ 特别钉住一条：**`confirmed` 不能再退回 `failed`**。
///    回执到了就是到了；之后再收到网络错，不该把一条已经确认的话改回失败——
///    那会让用户重新发一遍，而服务端那边**已经收过了**。
const Map<MessageState, Set<MessageState>> allowedTransitions = {
  // ⚠️ `confirmed` 必须能从 `queued` 直接到——**回执会比 HTTP 响应先到**。
  //    （WS 的回声和 /api/say 的返回是两条路，谁先到都有可能。
  //      只留 queued→sent→confirmed 的话，回执先到时会被当成"不允许的转移"丢掉，
  //      而界面会永远停在"已交出去"。这是测试抓出来的。）
  MessageState.queued: {MessageState.sent, MessageState.confirmed, MessageState.failed},
  MessageState.sent: {MessageState.confirmed, MessageState.failed},
  MessageState.confirmed: {}, // 终态
  MessageState.failed: {MessageState.queued}, // 只允许"重发"把它推回排队
};

/// 能不能从 [from] 转到 [to]。
bool canTransition(MessageState from, MessageState to) =>
    allowedTransitions[from]?.contains(to) ?? false;

/// 走一步。不允许的转移**原样返回**（不抛，因为这类事件可能乱序到达）。
MessageState nextState(MessageState from, MessageState to) =>
    canTransition(from, to) ? to : from;

/// 这个状态要不要给用户一个"还没好"的提示。
bool isPending(MessageState s) =>
    s == MessageState.queued || s == MessageState.sent;

/// 这个状态是不是已经落定（不再变）。
bool isSettled(MessageState s) =>
    s == MessageState.confirmed || s == MessageState.failed;

/// 界面上那句话。**必须是人话**——不许出现内部词（手册 §2.2 用词纪律）。
String stateLabel(MessageState s) => switch (s) {
      MessageState.queued => '已交出去',
      MessageState.sent => '已送到',
      MessageState.confirmed => '已收到',
      MessageState.failed => '没发出去',
    };
